//! The `cbc-runtime` RPC server — PRD §20.2–§20.5, §19.5, §19.7.
//!
//! Every request is revalidated here. A TypeScript `allow` decision never
//! bypasses a Rust invariant (§19.7), so each handler re-runs the path guard,
//! the lease check, and the resource limits.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cbc_artifacts::{ArtifactStore, RetentionClass};
use cbc_git::GitService;
use cbc_keychain::Keychain;
use cbc_patch::{FileTransaction, TransactionError, TransactionState};
use cbc_process::{CancelToken, ProcessSupervisor};
use cbc_protocol::{
    error_codes, methods, InitializeParams, InitializeResult, ProtocolVersion, RequestId, RpcError,
    RpcNotification, RpcRequest, RpcResponse, RuntimeCapabilities, PROTOCOL_VERSION,
};
use cbc_redaction::Redactor;
use cbc_sandbox::{SandboxCapabilities, SandboxLevel};
use cbc_session_store::SessionStore;
use cbc_workspace::{TrustStore, Workspace};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct CapabilityReceipt {
    pub id: String,
    pub session_id: String,
    pub call_id: String,
    pub action_hash: String,
    pub workspace_id: String,
    pub operation: String,
    pub resources: Vec<String>,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub network: String,
    pub expires_at_ms: u64,
    pub single_use: bool,
    pub consumed: bool,
}

use crate::handlers;

pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A short-lived admission for an operation that can mutate the workspace or
/// start executable work.  The guard is deliberately acquired while holding
/// `interaction_mode`; `workspace.mode.write` uses that same lock before it
/// checks this counter.  Consequently a mode transition cannot slip between
/// an operation's mode check and its first side effect.
#[must_use = "a write admission must be held for the complete operation"]
pub struct WriteAdmissionGuard<'a> {
    counter: &'a AtomicU64,
}

impl Drop for WriteAdmissionGuard<'_> {
    fn drop(&mut self) {
        let previous = self.counter.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0, "write admission counter underflow");
    }
}

/// Everything the handlers need. Interior mutability keeps the dispatcher
/// single-threaded while reader threads push notifications.
pub struct RuntimeState {
    pub initialized: AtomicBool,
    pub workspace: Mutex<Option<Workspace>>,
    pub workspace_id: Mutex<String>,
    pub data_dir: Mutex<PathBuf>,
    pub trust_store: Mutex<TrustStore>,
    pub trust_path: Mutex<PathBuf>,
    pub redactor: Mutex<Redactor>,
    pub sandbox: Mutex<SandboxCapabilities>,
    /// Effective sandbox level after clamping the configured request to what
    /// this host can enforce (P0-04, RT-006). `Strict` attaches a Landlock
    /// allowlist to every spawn; the network namespace / seccomp deny follows
    /// each spec's own network mode.
    pub sandbox_level: Mutex<SandboxLevel>,
    /// `sandbox.networkForShell` from configuration: `deny` forces
    /// `network = deny` on raw shells, `ask`/`allow` leave the decision to
    /// the approval flow.
    pub network_for_shell: Mutex<Option<String>>,
    pub interaction_mode: Mutex<String>,
    /// Number of in-flight mutation/process admissions.  Mode transitions and
    /// admissions serialize on `interaction_mode` so a plan entry cannot race
    /// an operation between its final mode check and registration.
    pub write_admissions: AtomicU64,
    /// Runtime-side ownership for live process controls. Job ids are not a
    /// capability: only the issuing session may inspect/input/stop its jobs.
    pub job_owners: Mutex<HashMap<String, String>>,
    pub capability_issuer_token: Mutex<Option<String>>,
    pub supervisor: Arc<ProcessSupervisor>,
    pub git: Mutex<Option<GitService>>,
    pub keychain: Mutex<Option<Keychain>>,
    pub store: Mutex<Option<SessionStore>>,
    pub artifacts: Mutex<Option<ArtifactStore>>,
    pub transactions: Mutex<HashMap<String, FileTransaction>>,
    /// Committed transaction ids in commit order.
    ///
    /// A checkpoint rollback has to unwind newest-first, because a later
    /// transaction may have renamed or replaced what an earlier one created. A
    /// `HashMap` cannot answer "in what order did these land", so the order is
    /// recorded separately at commit time.
    pub commit_order: Mutex<Vec<String>>,
    /// Write leases keyed by transaction id (§15.8).
    pub leases: Mutex<HashMap<String, Vec<String>>>,
    pub cancel_tokens: Mutex<HashMap<String, CancelToken>>,
    pub capabilities: Mutex<HashMap<String, CapabilityReceipt>>,
    pub transaction_capabilities: Mutex<HashMap<String, String>>,
    pub next_transaction: AtomicU64,
    pub next_capability: AtomicU64,
    pub started_at: std::time::Instant,
    pub outstanding: AtomicU64,
}

impl RuntimeState {
    pub fn new() -> Self {
        let mut redactor = Redactor::new();
        // Any secret-shaped environment value is registered up front so it can
        // never appear in output we produce (§14.8).
        redactor.add_process_secret_env();
        Self {
            initialized: AtomicBool::new(false),
            workspace: Mutex::new(None),
            workspace_id: Mutex::new(String::new()),
            data_dir: Mutex::new(default_data_dir()),
            trust_store: Mutex::new(TrustStore::new()),
            trust_path: Mutex::new(default_data_dir().join("trust.json")),
            redactor: Mutex::new(redactor),
            sandbox: Mutex::new(cbc_sandbox::detect(SandboxLevel::Standard)),
            sandbox_level: Mutex::new(SandboxLevel::Standard),
            network_for_shell: Mutex::new(None),
            interaction_mode: Mutex::new("build".to_string()),
            write_admissions: AtomicU64::new(0),
            job_owners: Mutex::new(HashMap::new()),
            capability_issuer_token: Mutex::new(None),
            supervisor: Arc::new(ProcessSupervisor::default()),
            git: Mutex::new(None),
            keychain: Mutex::new(None),
            store: Mutex::new(None),
            artifacts: Mutex::new(None),
            transactions: Mutex::new(HashMap::new()),
            commit_order: Mutex::new(Vec::new()),
            leases: Mutex::new(HashMap::new()),
            cancel_tokens: Mutex::new(HashMap::new()),
            capabilities: Mutex::new(HashMap::new()),
            transaction_capabilities: Mutex::new(HashMap::new()),
            next_transaction: AtomicU64::new(1),
            next_capability: AtomicU64::new(1),
            started_at: std::time::Instant::now(),
            outstanding: AtomicU64::new(0),
        }
    }

    pub fn require_workspace(&self) -> Result<Workspace, RpcError> {
        self.workspace
            .lock()
            .expect("workspace lock")
            .clone()
            .ok_or_else(|| {
                RpcError::new(
                    error_codes::NOT_INITIALIZED,
                    "runtime.initialize must succeed before workspace operations",
                )
            })
    }

    /// The live trust state of the initialized workspace (§13.6). Read on every
    /// check rather than cached so a mid-session revocation takes effect
    /// immediately.
    pub fn current_trust_state(&self) -> Result<cbc_workspace::TrustState, RpcError> {
        let ws = self.require_workspace()?;
        let canonical = ws.root().to_string_lossy().to_string();
        let fs_id = cbc_workspace::trust::filesystem_id(ws.root());
        Ok(self
            .trust_store
            .lock()
            .expect("trust lock")
            .state_for(&canonical, &fs_id))
    }

    /// §19.5 / §24.1: the runtime is the final boundary for workspace mutation.
    /// A control-plane bug or a forged RPC must not be able to write an
    /// untrusted or read-only workspace, so every mutating handler proves trust
    /// here instead of assuming the host already checked.
    pub fn require_mutation_allowed(&self) -> Result<(), RpcError> {
        if self.interaction_mode.lock().expect("mode lock").as_str() == "plan" {
            return Err(permission_error("Plan mode forbids workspace mutation"));
        }
        let trust = self.current_trust_state()?;
        if trust.allows_mutation() {
            return Ok(());
        }
        Err(RpcError::taxonomy(
            error_codes::PERMISSION_DENIED,
            "PERMISSION_DENIED",
            format!(
                "workspace trust is '{}'; mutation requires a trusted workspace",
                trust.label()
            ),
        ))
    }

    /// Running a process executes arbitrary code on the workspace's behalf, which
    /// an untrusted workspace has not earned (§13.6). A read-only workspace no
    /// longer keeps it either (P0-02): a process can write anywhere the user
    /// can, so "read-only" that still runs code is read-only in name only. The
    /// policy engine applies the same gate; this check is the runtime's own
    /// proof, so a forged or buggy RPC cannot bypass it (§19.7).
    pub fn require_process_allowed(&self) -> Result<(), RpcError> {
        if self.interaction_mode.lock().expect("mode lock").as_str() == "plan" {
            return Err(permission_error("Plan mode forbids process execution"));
        }
        let trust = self.current_trust_state()?;
        match trust {
            cbc_workspace::TrustState::Untrusted => Err(RpcError::taxonomy(
                error_codes::PERMISSION_DENIED,
                "PERMISSION_DENIED",
                "workspace is untrusted; running processes requires a trust decision",
            )),
            cbc_workspace::TrustState::ReadOnly => Err(RpcError::taxonomy(
                error_codes::PERMISSION_DENIED,
                "PERMISSION_DENIED",
                "workspace is read-only; process execution can mutate it and is denied",
            )),
            _ => Ok(()),
        }
    }

    /// Acquire the final runtime admission for a write/process operation.
    ///
    /// Holding the mode mutex across the check and increment is the important
    /// part: `workspace.mode.write` takes the same mutex while checking
    /// `write_admissions`, so either the operation wins the race and plan entry
    /// is rejected, or plan mode wins and this method rejects the operation.
    pub fn acquire_write_admission(&self) -> Result<WriteAdmissionGuard<'_>, RpcError> {
        let mode = self.interaction_mode.lock().expect("mode lock");
        if mode.as_str() == "plan" {
            return Err(permission_error(
                "Plan mode forbids workspace mutation or process execution",
            ));
        }
        self.write_admissions.fetch_add(1, Ordering::SeqCst);
        drop(mode);
        Ok(WriteAdmissionGuard {
            counter: &self.write_admissions,
        })
    }

    /// Return the live blockers that prevent entering Plan mode.  This is kept
    /// as a structured value so callers can explain a rejected transition
    /// without exposing internal locks or requiring a second probe.
    pub fn plan_mode_blockers(&self) -> Value {
        let active_processes = self.supervisor.active_count();
        let mut transactions = Vec::new();
        {
            let guard = self.transactions.lock().expect("tx lock");
            for (id, transaction) in guard.iter() {
                if matches!(
                    transaction.state(),
                    TransactionState::Open
                        | TransactionState::Conflicted
                        | TransactionState::RecoveryRequired
                ) {
                    transactions.push(id.clone());
                }
            }
        }

        // A previous runtime can leave durable `open`/`conflicted` rows even
        // though there is no in-memory FileTransaction after restart.  Recovery
        // required is intentionally a blocker too: Plan mode must never hide a
        // workspace that still needs operator intervention.
        let mut transaction_store_error = false;
        {
            let store_guard = self.store.lock().expect("store lock");
            if let Some(store) = store_guard.as_ref() {
                for status in ["open", "conflicted", "recovery_required", "applying"] {
                    match store.transaction_ids_with_status(status) {
                        Ok(ids) => {
                            for id in ids {
                                if !transactions.iter().any(|known| known == &id) {
                                    transactions.push(id);
                                }
                            }
                        }
                        Err(_) => transaction_store_error = true,
                    }
                }
            } else {
                // A mode transition is only meaningful after initialization has
                // installed the durable store. Fail closed for direct callers.
                transaction_store_error = true;
            }
        }
        transactions.sort();

        json!({
            "activeProcesses": active_processes,
            "transactions": transactions,
            "transactionStoreError": transaction_store_error,
            "writeAdmissions": self.write_admissions.load(Ordering::SeqCst),
        })
    }

    /// Install an interaction mode atomically with the quiescence check.
    /// `workspace.mode.write` and initialize both use this path, ensuring the
    /// initial handshake and live transitions have identical enforcement.
    pub fn write_interaction_mode(&self, requested: &str) -> Result<Value, RpcError> {
        if !matches!(requested, "build" | "plan") {
            return Err(RpcError::invalid_params("mode must be build or plan"));
        }

        let mut mode = self.interaction_mode.lock().expect("mode lock");
        let previous = mode.clone();
        if requested == "plan" && previous != "plan" {
            let blockers = self.plan_mode_blockers();
            let active_processes = blockers
                .get("activeProcesses")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let transaction_count = blockers
                .get("transactions")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let admissions = blockers
                .get("writeAdmissions")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let transaction_store_error = blockers
                .get("transactionStoreError")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if active_processes > 0
                || transaction_count > 0
                || admissions > 0
                || transaction_store_error
            {
                return Err(RpcError::with_data(
                    error_codes::PERMISSION_DENIED,
                    "cannot enter Plan mode until the runtime is quiescent",
                    json!({
                        "taxonomy": "PERMISSION_DENIED",
                        "reason": "NOT_QUIESCENT",
                        "blockers": blockers,
                    }),
                ));
            }
        }

        *mode = requested.to_string();
        let blockers = self.plan_mode_blockers();
        let quiescent = blockers
            .get("activeProcesses")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
            && blockers
                .get("transactions")
                .and_then(Value::as_array)
                .map(|items| items.is_empty())
                .unwrap_or(false)
            && blockers
                .get("writeAdmissions")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == 0
            && blockers
                .get("transactionStoreError")
                .and_then(Value::as_bool)
                .map(|failed| !failed)
                .unwrap_or(false);
        Ok(json!({
            "mode": requested,
            "previousMode": previous,
            "changed": previous != requested,
            "quiescent": requested == "build" || quiescent,
        }))
    }

    pub fn redact(&self, text: &str) -> String {
        self.redactor
            .lock()
            .expect("redactor lock")
            .redact_text(text)
    }

    /// Sanitize then redact — the order §11.6 requires.
    pub fn safe_text(&self, text: &str) -> String {
        let redactor = self.redactor.lock().expect("redactor lock");
        cbc_redaction::safe_for_display(text, &redactor)
    }

    pub fn next_transaction_id(&self) -> String {
        format!(
            "tx_{:06}",
            self.next_transaction.fetch_add(1, Ordering::SeqCst)
        )
    }

    pub fn issue_capability(&self, params: &Value) -> Result<Value, RpcError> {
        let issuer_token = required_str(params, "issuerToken")?;
        if self
            .capability_issuer_token
            .lock()
            .expect("issuer token lock")
            .as_deref()
            != Some(issuer_token.as_str())
        {
            return Err(permission_error(
                "capability receipt issuance is not authorized",
            ));
        }
        let session_id = required_str(params, "sessionId")?;
        let call_id = required_str(params, "callId")?;
        let action_hash = required_str(params, "actionHash")?;
        let operation = required_str(params, "operation")?;
        let resources = string_array(params, "resources");
        let program = optional_str(params, "program");
        let args = string_array(params, "args");
        let cwd = optional_str(params, "cwd");
        let network = optional_str(params, "network").unwrap_or_else(|| "deny".to_string());
        if !matches!(network.as_str(), "deny" | "ask" | "allow") {
            return Err(RpcError::invalid_params("invalid capability network mode"));
        }
        let ttl_ms = optional_u64(params, "ttlMs")
            .unwrap_or(60_000)
            .clamp(1, 300_000);
        let id = format!(
            "cap_{:016x}",
            self.next_capability.fetch_add(1, Ordering::SeqCst)
        );
        let now = now_ms();
        let receipt = CapabilityReceipt {
            id: id.clone(),
            session_id,
            call_id,
            action_hash,
            workspace_id: self.workspace_id.lock().expect("workspace id lock").clone(),
            operation,
            resources,
            program,
            args,
            cwd,
            network,
            expires_at_ms: now.saturating_add(ttl_ms),
            single_use: true,
            consumed: false,
        };
        let value = capability_value(&receipt);
        self.capabilities
            .lock()
            .expect("capability lock")
            .insert(id, receipt);
        Ok(value)
    }

    pub fn consume_capability(
        &self,
        params: &Value,
        operation: &str,
        program: Option<&str>,
        args: &[String],
        cwd: Option<&str>,
        resources: &[String],
        network: Option<&str>,
    ) -> Result<CapabilityReceipt, RpcError> {
        let id = required_str(params, "capabilityReceipt")?;
        let mut guard = self.capabilities.lock().expect("capability lock");
        let receipt = guard
            .get_mut(&id)
            .ok_or_else(|| permission_error("unknown capability receipt"))?;
        if receipt.consumed || receipt.expires_at_ms <= now_ms() {
            return Err(permission_error(
                "capability receipt is expired or already consumed",
            ));
        }
        if receipt.workspace_id != *self.workspace_id.lock().expect("workspace id lock") {
            return Err(permission_error(
                "capability receipt belongs to another workspace",
            ));
        }
        let session_id = required_str(params, "capabilitySessionId")?;
        let action_hash = required_str(params, "capabilityActionHash")?;
        if session_id != receipt.session_id || action_hash != receipt.action_hash {
            return Err(permission_error(
                "capability receipt identity does not match the requested action",
            ));
        }
        if receipt.operation != operation
            || receipt.program.as_deref() != program
            || receipt.args != args
            || receipt.cwd.as_deref() != cwd
            || receipt.resources != resources
            || network.is_some_and(|value| value != receipt.network)
        {
            return Err(permission_error(
                "capability receipt does not match the requested action",
            ));
        }
        receipt.consumed = true;
        Ok(receipt.clone())
    }

    pub fn bind_transaction_capability(
        &self,
        transaction_id: &str,
        params: &Value,
    ) -> Result<(), RpcError> {
        let receipt_id = required_str(params, "capabilityReceipt")?;
        let guard = self.capabilities.lock().expect("capability lock");
        let receipt = guard
            .get(&receipt_id)
            .ok_or_else(|| permission_error("unknown capability receipt"))?;
        if receipt.consumed
            || receipt.expires_at_ms <= now_ms()
            || receipt.operation != "fs.transaction"
        {
            return Err(permission_error("invalid transaction capability receipt"));
        }
        let session_id = required_str(params, "capabilitySessionId")?;
        let action_hash = required_str(params, "capabilityActionHash")?;
        if session_id != receipt.session_id || action_hash != receipt.action_hash {
            return Err(permission_error("transaction capability identity mismatch"));
        }
        drop(guard);
        self.transaction_capabilities
            .lock()
            .expect("transaction capability lock")
            .insert(transaction_id.to_string(), receipt_id);
        Ok(())
    }

    pub fn require_transaction_capability(
        &self,
        transaction_id: &str,
        params: &Value,
    ) -> Result<(), RpcError> {
        let receipt_id = required_str(params, "capabilityReceipt")?;
        let expected = self
            .transaction_capabilities
            .lock()
            .expect("transaction capability lock")
            .get(transaction_id)
            .cloned()
            .ok_or_else(|| permission_error("transaction has no capability receipt"))?;
        if expected != receipt_id {
            return Err(permission_error("transaction capability receipt mismatch"));
        }
        let guard = self.capabilities.lock().expect("capability lock");
        let receipt = guard
            .get(&receipt_id)
            .ok_or_else(|| permission_error("unknown capability receipt"))?;
        if receipt.consumed || receipt.expires_at_ms <= now_ms() {
            return Err(permission_error(
                "transaction capability receipt is expired or consumed",
            ));
        }
        let session_id = required_str(params, "capabilitySessionId")?;
        let action_hash = required_str(params, "capabilityActionHash")?;
        if session_id != receipt.session_id || action_hash != receipt.action_hash {
            return Err(permission_error("transaction capability identity mismatch"));
        }
        Ok(())
    }

    pub fn consume_transaction_capability(&self, transaction_id: &str) -> Result<(), RpcError> {
        let receipt_id = self
            .transaction_capabilities
            .lock()
            .expect("transaction capability lock")
            .remove(transaction_id)
            .ok_or_else(|| permission_error("transaction has no capability receipt"))?;
        let mut guard = self.capabilities.lock().expect("capability lock");
        let receipt = guard
            .get_mut(&receipt_id)
            .ok_or_else(|| permission_error("unknown capability receipt"))?;
        if receipt.consumed || receipt.expires_at_ms <= now_ms() {
            return Err(permission_error(
                "transaction capability receipt is expired or consumed",
            ));
        }
        receipt.consumed = true;
        Ok(())
    }
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

/// §21.1: data dir defaults to `~/.local/share/capybara`, overridable.
pub fn default_data_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("CAPYBARA_DATA_DIR") {
        return PathBuf::from(explicit);
    }
    if let Some(home) = std::env::var_os("CAPYBARA_HOME") {
        return PathBuf::from(home).join("data");
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join("capybara-code");
        }
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(xdg).join("capybara");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local/share/capybara");
    }
    std::env::temp_dir().join("capybara")
}

/// Outbound message sink. Notifications and responses both go through here so
/// framing stays in one place.
pub struct Outbound<W: Write> {
    writer: W,
}

impl<W: Write> Outbound<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn response(&mut self, response: &RpcResponse) -> std::io::Result<()> {
        let payload = serde_json::to_string(response)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        cbc_protocol::write_frame(&mut self.writer, &payload)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    pub fn notify(&mut self, method: &str, params: Value) -> std::io::Result<()> {
        debug_assert!(
            methods::is_known_notification(method),
            "undeclared notification method: {method}"
        );
        let note = RpcNotification::new(method, params);
        let payload = serde_json::to_string(&note)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        cbc_protocol::write_frame(&mut self.writer, &payload)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}

/// Dispatch one request. Returns `Ok(None)` for notifications that need no
/// response, and `Err` only for unrecoverable transport failures.
pub fn dispatch(state: &RuntimeState, request: &RpcRequest) -> Option<Result<Value, RpcError>> {
    let method = request.method.as_str();

    if request.is_notification() {
        // The client sends no notifications in protocol 1.0; accept and ignore
        // unknown ones for forward compatibility (§20.4).
        return None;
    }

    if !methods::is_known_request(method) {
        return Some(Err(RpcError::method_not_found(method)));
    }

    if methods::requires_initialization(method) && !state.initialized.load(Ordering::SeqCst) {
        return Some(Err(RpcError::taxonomy(
            error_codes::NOT_INITIALIZED,
            "NOT_INITIALIZED",
            format!("{method} requires a successful runtime.initialize"),
        )));
    }

    let params = request.params_or_null();

    // P0-04: every request runs with a cancel token keyed by its request id, so
    // `runtime.cancel` can abort it — including a foreground `process.run` that is
    // blocking its own response.
    let request_token = request.id.as_ref().and_then(|id| {
        state
            .cancel_tokens
            .lock()
            .expect("cancel lock")
            .get(&format!("req:{id}"))
            .cloned()
    });

    let result = match method {
        "runtime.initialize" => initialize(state, params),
        "runtime.capabilities" => Ok(capabilities_value(state)),
        "runtime.shutdown" => {
            state.supervisor.terminate_all(1_000);
            Ok(json!({ "ok": true }))
        }
        "runtime.cancel" => cancel_request(state, params),
        "runtime.capability.issue" => state.issue_capability(&params),

        "app.client.upsert" => handlers::app::client_upsert(state, params),
        "app.subscription.create" => handlers::app::subscription_create(state, params),
        "app.subscription.ack" => handlers::app::subscription_ack(state, params),
        "app.subscription.state" => handlers::app::subscription_state(state, params),
        "app.subscription.replay" => handlers::app::subscription_replay(state, params),

        "workspace.inspect" => handlers::workspace::inspect(state),
        "workspace.mode.write" => handlers::workspace::mode_write(state, params),
        "workspace.trust.read" => handlers::workspace::trust_read(state),
        "workspace.trust.write" => handlers::workspace::trust_write(state, params),
        "workspace.trust.list" => handlers::workspace::trust_list(state),
        "workspace.trust.set" => handlers::workspace::trust_set(state, params),
        "workspace.trust.remove" => handlers::workspace::trust_remove(state, params),

        "fs.list" => handlers::fs::list(state, params),
        "fs.glob" => handlers::fs::glob(state, params),
        "fs.search" => handlers::fs::search(state, params),
        "fs.read" => handlers::fs::read(state, params),
        "fs.read_many" => handlers::fs::read_many(state, params),
        "fs.fingerprint" => handlers::fs::fingerprint(state, params),
        "fs.edit.preview" => handlers::edit::preview(state, params),
        "fs.edit" => handlers::edit::apply(state, params),
        "fs.transaction.begin" => handlers::transaction::begin(state, params),
        "fs.patch" => handlers::transaction::patch(state, params),
        "fs.write" => handlers::transaction::write(state, params),
        "fs.move" => handlers::transaction::move_path(state, params),
        "fs.delete" => handlers::transaction::delete(state, params),
        "fs.transaction.commit" => handlers::transaction::commit(state, params),
        "fs.transaction.rollback" => handlers::transaction::rollback(state, params),
        "fs.transaction.rollback_to_checkpoint" => {
            handlers::transaction::rollback_to_checkpoint(state, params)
        }

        "process.run" => handlers::process::run(state, params, request_token),
        "process.start" => handlers::process::start(state, params),
        "process.input" => handlers::process::input(state, params),
        "process.stop" => handlers::process::stop(state, params),
        "process.status" => handlers::process::status(state, params),

        "git.status" => handlers::git::status(state),
        "git.diff" => handlers::git::diff(state, params),
        "git.log" => handlers::git::log(state, params),
        "git.show" => handlers::git::show(state, params),
        "git.checkpoint" => handlers::git::checkpoint(state, params),

        "worktree.create" => handlers::worktree::create(state, params),
        "worktree.list" => handlers::worktree::list(state),
        "worktree.inspect" => handlers::worktree::inspect(state, params),
        "worktree.status" => handlers::worktree::status(state, params),
        "worktree.diff" => handlers::worktree::diff(state, params),
        "worktree.remove" => handlers::worktree::remove(state, params),
        "worktree.reconcile" => handlers::worktree::reconcile(state, params),
        "merge.preview" => handlers::worktree::merge_preview(state, params),

        "credential.store" => handlers::credential::store(state, params),
        "credential.lease" => handlers::credential::lease(state, params),
        "credential.delete" => handlers::credential::delete(state, params),

        "session.open" => handlers::session::open(state, params),
        "session.append" => handlers::session::append(state, params),
        "session.snapshot" => handlers::session::snapshot(state, params),
        "session.load" => handlers::session::load(state, params),
        "session.list" => handlers::session::list(state, params),
        "session.resolve" => handlers::session::resolve(state, params),
        "session.set_status" => handlers::session::set_status(state, params),
        "session.export" => handlers::session::export(state, params),
        "session.fork" => handlers::session::fork(state, params),
        "session.delete" => handlers::session::delete(state, params),

        "memory.search" => handlers::memory::search(state, params),
        "memory.remember" => handlers::memory::remember(state, params),
        "memory.list" => handlers::memory::list(state, params),
        "memory.get" => handlers::memory::get(state, params),
        "memory.forget" => handlers::memory::forget(state, params),
        "memory.resolve_contest" => handlers::memory::resolve_contest(state, params),
        "memory.verify" => handlers::memory::verify(state, params),

        "artifact.create" => handlers::artifact::create(state, params),
        "artifact.read" => handlers::artifact::read(state, params),
        "artifact.delete" => handlers::artifact::delete(state, params),

        "update.verify" => handlers::update::verify(state, params),

        // Unreachable: `is_known_request` gates the set above.
        other => Err(RpcError::method_not_found(other)),
    };

    Some(result)
}

/// `runtime.cancel` (P0-04): abort an in-flight request by its id.
///
/// The dispatcher registers every request's cancel token under `req:<id>`, so this
/// is a lookup plus a signal. Unknown ids report `cancelled: false` rather than an
/// error: a cancel that arrives after its request finished is a normal race, not a
/// fault.
fn cancel_request(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let request_id = required_str(&params, "requestId")?;
    let key = format!("req:{request_id}");
    let cancelled = state
        .cancel_tokens
        .lock()
        .expect("cancel lock")
        .get(&key)
        .map(|token| {
            token.cancel();
            true
        })
        .unwrap_or(false);
    Ok(json!({ "requestId": request_id, "cancelled": cancelled }))
}

fn initialize(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let params: InitializeParams = serde_json::from_value(params)
        .map_err(|e| RpcError::invalid_params(format!("invalid initialize params: {e}")))?;

    // §19.12: a differing major protocol version must refuse to run.
    let client = ProtocolVersion::parse(&params.protocol_version).ok_or_else(|| {
        RpcError::invalid_params(format!(
            "unparseable protocolVersion '{}'",
            params.protocol_version
        ))
    })?;
    let ours = ProtocolVersion::current();
    if !ours.is_compatible_with(&client) {
        return Err(RpcError::with_data(
            error_codes::PROTOCOL_INCOMPATIBLE,
            format!(
                "protocol major version mismatch: client {} vs runtime {}",
                client.to_string_lossy(),
                ours.to_string_lossy()
            ),
            json!({
                "clientProtocolVersion": client.to_string_lossy(),
                "runtimeProtocolVersion": ours.to_string_lossy(),
            }),
        ));
    }

    let workspace = Workspace::open(&params.workspace).map_err(|e| {
        RpcError::with_data(
            error_codes::INVALID_PARAMS,
            format!("cannot open workspace: {e}"),
            json!({ "taxonomy": e.taxonomy() }),
        )
    })?;

    let data_dir = params
        .data_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| RpcError::internal(format!("cannot create data directory: {e}")))?;

    let trust_path = data_dir.join("trust.json");
    let loaded = TrustStore::load_with_migration(&trust_path);
    if loaded.migrated_from_legacy {
        // One-shot migration (P0-01): keep the legacy file as a backup, then
        // re-persist the imported decisions in the runtime format so the host
        // and the runtime read one store from now on.
        let backup = trust_path.with_extension("json.bak");
        let _ = std::fs::copy(&trust_path, &backup);
        if let Err(e) = loaded.store.save(&trust_path) {
            // A failed re-persist must not stop initialization; the imported
            // decisions stay live in memory for this process.
            eprintln!("warning: could not persist migrated trust store: {e}");
        }
    }
    let trust_store = loaded.store;

    let git = GitService::open(workspace.root());
    let keychain = Keychain::detect(&data_dir);
    let store = SessionStore::open(&data_dir)
        .map_err(|e| RpcError::internal(format!("cannot open session store: {e}")))?;
    let artifacts = ArtifactStore::open(&data_dir)
        .map_err(|e| RpcError::internal(format!("cannot open artifact store: {e}")))?;

    // P0-04: the sandbox level is enforced here, not in the control plane.
    // The configured request is clamped to what this host can actually apply;
    // the clamp — never the request — is what capabilities report (§24.5).
    let requested_level = params
        .sandbox_level
        .as_deref()
        .and_then(SandboxLevel::parse)
        .unwrap_or(SandboxLevel::Standard);
    let sandbox = cbc_sandbox::detect(requested_level);
    let effective_level = cbc_sandbox::effective_level(requested_level, &sandbox);
    let network_for_shell = params
        .network_for_shell
        .as_deref()
        .and_then(|raw| match raw {
            "deny" | "ask" | "allow" => Some(raw.to_string()),
            _ => None,
        });
    let interaction_mode = params.interaction_mode.as_deref().unwrap_or("build");
    if !matches!(interaction_mode, "build" | "plan") {
        return Err(RpcError::invalid_params(
            "interactionMode must be build or plan",
        ));
    }

    let workspace_id = format!("ws_{}", workspace.fingerprint());
    let capabilities = RuntimeCapabilities {
        // R-06: true only when OS-level confinement is actually in effect.
        enhanced_sandbox: effective_level >= SandboxLevel::Strict,
        keychain: keychain.backend().label().to_string(),
        // §24.5: report what this runtime really implements, not what the
        // client claims it can handle.
        pty: cbc_process::pty_supported(),
        git: git.is_repository(),
        sandbox_level: effective_level.label().to_string(),
        sandbox_backends: cbc_sandbox::enforce::applied_backend_labels(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        max_frame_bytes: cbc_protocol::MAX_FRAME_BYTES,
        artifact_store: true,
        event_journal: true,
    };

    *state.workspace.lock().expect("lock") = Some(workspace);
    *state.workspace_id.lock().expect("lock") = workspace_id.clone();
    *state.data_dir.lock().expect("lock") = data_dir;
    *state.trust_path.lock().expect("lock") = trust_path;
    *state.trust_store.lock().expect("lock") = trust_store;
    *state.git.lock().expect("lock") = Some(git);
    *state.keychain.lock().expect("lock") = Some(keychain);
    *state.store.lock().expect("lock") = Some(store);
    *state.artifacts.lock().expect("lock") = Some(artifacts);
    *state.sandbox.lock().expect("lock") = sandbox;
    *state.sandbox_level.lock().expect("lock") = effective_level;
    *state.network_for_shell.lock().expect("lock") = network_for_shell;
    // Recovery always runs under the conservative Build-side runtime state.  Do
    // not mark the runtime initialized or install an initial Plan mode until the
    // durable transaction journal has been inspected and repaired.
    *state.interaction_mode.lock().expect("mode lock") = "build".to_string();
    *state
        .capability_issuer_token
        .lock()
        .expect("issuer token lock") = params.capability_issuer_token;

    // P0-07: a previous process may have crashed mid-commit. Finish rolling those
    // transactions back before this session can mutate anything or enter Plan.
    match handlers::transaction::recover_interrupted_transactions(state) {
        Ok(report) => {
            let recovered = report
                .get("recovered")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            if recovered > 0 {
                eprintln!(
                    "cbc-runtime: recovered {recovered} interrupted transaction(s) from a previous crash: {}",
                    report
                );
            }
        }
        Err(e) => {
            // Recovery failing must not wedge a normal Build session, but Plan
            // mode must fail closed rather than claim a quiescent workspace.
            eprintln!("cbc-runtime: transaction recovery failed: {e}");
            if interaction_mode == "plan" {
                return Err(RpcError::internal(format!(
                    "cannot enter Plan mode while transaction recovery failed: {e}"
                )));
            }
        }
    }

    // The same atomic transition path is used by live `workspace.mode.write`
    // and by the initial handshake.  In particular, unresolved durable rows
    // returned by recovery keep an initial Plan request from being admitted.
    state.write_interaction_mode(interaction_mode)?;
    state.initialized.store(true, Ordering::SeqCst);

    let result = InitializeResult {
        protocol_version: PROTOCOL_VERSION.to_string(),
        runtime_version: RUNTIME_VERSION.to_string(),
        workspace_id,
        capabilities,
    };
    serde_json::to_value(result).map_err(|e| RpcError::internal(e.to_string()))
}

pub(crate) fn now_ms_for_handler() -> u64 {
    now_ms()
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn permission_error(message: impl Into<String>) -> RpcError {
    RpcError::taxonomy(error_codes::PERMISSION_DENIED, "PERMISSION_DENIED", message)
}

fn capability_value(receipt: &CapabilityReceipt) -> Value {
    let mut value = json!({
        "id": receipt.id,
        "sessionId": receipt.session_id,
        "callId": receipt.call_id,
        "actionHash": receipt.action_hash,
        "workspaceId": receipt.workspace_id,
        "operation": receipt.operation,
        "resources": receipt.resources,
        "network": receipt.network,
        "expiresAtMs": receipt.expires_at_ms,
        "singleUse": receipt.single_use,
    });
    if let Some(object) = value.as_object_mut() {
        if let Some(program) = &receipt.program {
            object.insert("program".into(), json!(program));
        }
        if !receipt.args.is_empty() {
            object.insert("args".into(), json!(receipt.args));
        }
        if let Some(cwd) = &receipt.cwd {
            object.insert("cwd".into(), json!(cwd));
        }
    }
    value
}

fn capabilities_value(state: &RuntimeState) -> Value {
    let sandbox = state.sandbox.lock().expect("lock").clone();
    let keychain_label = state
        .keychain
        .lock()
        .expect("lock")
        .as_ref()
        .map(|k| k.backend().label().to_string())
        .unwrap_or_else(|| "unavailable".to_string());
    let git = state
        .git
        .lock()
        .expect("lock")
        .as_ref()
        .map(|g| g.is_repository())
        .unwrap_or(false);

    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "sandbox": sandbox,
        "keychain": keychain_label,
        "git": git,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "limits": {
            "maxFrameBytes": cbc_protocol::MAX_FRAME_BYTES,
            "maxJsonDepth": cbc_protocol::MAX_JSON_DEPTH,
            "maxStringBytes": cbc_protocol::MAX_STRING_BYTES,
            "maxOutstandingRequests": cbc_protocol::MAX_OUTSTANDING_REQUESTS,
        },
        "uptimeMs": state.started_at.elapsed().as_millis() as u64,
        "executables": handlers::process::executable_capabilities(),
    })
}

/// Map a transaction error onto the protocol error taxonomy.
pub fn transaction_error(e: TransactionError) -> RpcError {
    let taxonomy = e.taxonomy();
    let code = match taxonomy {
        "HASH_MISMATCH" => error_codes::HASH_MISMATCH,
        "PATH_CHANGED" => error_codes::PATH_CHANGED,
        "NOT_FOUND" => error_codes::NOT_FOUND,
        "ALREADY_EXISTS" => error_codes::ALREADY_EXISTS,
        "OUTPUT_LIMIT" => error_codes::OUTPUT_LIMIT,
        "UNSUPPORTED_ENCODING" => error_codes::UNSUPPORTED_ENCODING,
        "INVALID_ARGUMENT" => error_codes::INVALID_ARGUMENT,
        "RECOVERY_REQUIRED" => error_codes::TRANSACTION_CONFLICT,
        _ => error_codes::INTERNAL_ERROR,
    };
    let message = e.to_string();
    let details = match &e {
        TransactionError::Conflict {
            path,
            expected,
            actual,
        } => json!({
            "path": path,
            "expectedHash": expected,
            "actualHash": actual,
            "action": "re-read the file and retry with the new checksum",
        }),
        TransactionError::HunkMismatch {
            path,
            hunk_index,
            at_line,
            expected,
            actual,
        } => json!({
            "path": path,
            "hunkIndex": hunk_index,
            "atLine": at_line,
            "expected": expected,
            "actual": actual,
            "action": "re-read the current file and regenerate a complete unified diff",
        }),
        TransactionError::NotFound { path } => json!({
            "path": path,
            "action": "confirm the path with fs.list or use fs.write intent=create",
        }),
        TransactionError::AlreadyExists { path } => json!({
            "path": path,
            "action": "re-read the path and choose replace/upsert only when intended",
        }),
        TransactionError::NonRestorable { path, reason } => json!({
            "path": path,
            "reason": reason,
            "action": "use a non-transactional operation or split the change into restorable files",
        }),
        TransactionError::RollbackFailed { original, failures } => json!({
            "recoveryRequired": true,
            "originalError": original,
            "rollbackFailures": failures,
            "action": "inspect the listed paths before retrying or making further mutations",
        }),
        TransactionError::Fs(_) | TransactionError::InvalidState { .. } => json!({}),
    };
    let mut data = json!({ "taxonomy": taxonomy });
    if let Some(object) = data.as_object_mut() {
        if let Some(extra) = details.as_object() {
            object.extend(
                extra
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
    }
    RpcError::with_data(code, message, data)
}
/// Map a workspace guard error onto the protocol error taxonomy.
pub fn guard_error(e: cbc_workspace::GuardError) -> RpcError {
    let taxonomy = e.taxonomy();
    let code = match taxonomy {
        "PATH_OUTSIDE_WORKSPACE" => error_codes::PATH_OUTSIDE_WORKSPACE,
        "PERMISSION_DENIED" => error_codes::PERMISSION_DENIED,
        "INVALID_ARGUMENT" => error_codes::INVALID_ARGUMENT,
        _ => error_codes::INTERNAL_ERROR,
    };
    let message = e.to_string();
    let details = match &e {
        cbc_workspace::GuardError::OutsideWorkspace {
            requested,
            resolved,
        } => json!({
            "path": requested,
            "resolved": resolved,
            "action": "use a workspace-relative path",
        }),
        cbc_workspace::GuardError::SymlinkEscape { component, target } => json!({
            "path": component,
            "resolved": target,
        }),
        cbc_workspace::GuardError::LeaseViolation { path, allowed } => json!({
            "path": path,
            "allowed": allowed,
        }),
        cbc_workspace::GuardError::SensitivePath { path, rule } => json!({
            "path": path,
            "rule": rule,
        }),
        cbc_workspace::GuardError::AbsolutePathNotAllowed { path }
        | cbc_workspace::GuardError::InvalidEncoding { reason: path } => json!({ "path": path }),
        cbc_workspace::GuardError::SpecialFile { path, kind } => json!({
            "path": path,
            "kind": kind,
        }),
        cbc_workspace::GuardError::ReservedName { name } => json!({ "path": name }),
        cbc_workspace::GuardError::Io { path, .. } => json!({ "path": path }),
    };
    let mut data = json!({ "taxonomy": taxonomy });
    if let Some(object) = data.as_object_mut() {
        if let Some(extra) = details.as_object() {
            object.extend(
                extra
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
    }
    RpcError::with_data(code, message, data)
}

/// Map a filesystem error onto the protocol error taxonomy.
pub fn fs_error(e: cbc_fs::FsError) -> RpcError {
    let taxonomy = match &e {
        cbc_fs::FsError::Io { message, .. }
            if message.to_ascii_lowercase().contains("permission denied")
                || message.to_ascii_lowercase().contains("access is denied") =>
        {
            "PERMISSION_DENIED"
        }
        _ => e.taxonomy(),
    };
    let code = match taxonomy {
        "NOT_FOUND" => error_codes::NOT_FOUND,
        "ALREADY_EXISTS" => error_codes::ALREADY_EXISTS,
        "HASH_MISMATCH" => error_codes::HASH_MISMATCH,
        "OUTPUT_LIMIT" => error_codes::OUTPUT_LIMIT,
        "UNSUPPORTED_ENCODING" => error_codes::UNSUPPORTED_ENCODING,
        "INVALID_ARGUMENT" => error_codes::INVALID_ARGUMENT,
        "PERMISSION_DENIED" => error_codes::PERMISSION_DENIED,
        _ => error_codes::INTERNAL_ERROR,
    };
    let message = e.to_string();
    let details = match &e {
        cbc_fs::FsError::NotFound { path }
        | cbc_fs::FsError::AlreadyExists { path }
        | cbc_fs::FsError::IsDirectory { path }
        | cbc_fs::FsError::NotDirectory { path }
        | cbc_fs::FsError::TooLarge { path, .. }
        | cbc_fs::FsError::UnsupportedEncoding { path, .. }
        | cbc_fs::FsError::Io { path, .. } => json!({ "path": path }),
        cbc_fs::FsError::HashMismatch {
            path,
            expected,
            actual,
        } => json!({
            "path": path,
            "expectedHash": expected,
            "actualHash": actual,
            "action": "re-read the file before retrying",
        }),
    };
    let mut data = json!({ "taxonomy": taxonomy });
    if let Some(object) = data.as_object_mut() {
        if let Some(extra) = details.as_object() {
            object.extend(
                extra
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
    }
    RpcError::with_data(code, message, data)
}
/// Helper for required string params.
pub fn required_str(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::invalid_params(format!("missing required string param '{key}'")))
}

pub fn optional_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn optional_u64(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

pub fn optional_bool(params: &Value, key: &str, default: bool) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(default)
}

pub fn optional_usize(params: &Value, key: &str, default: usize) -> usize {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(default)
}

pub fn string_array(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Response helper preserving the request id.
pub fn respond(id: RequestId, outcome: Result<Value, RpcError>) -> RpcResponse {
    match outcome {
        Ok(value) => RpcResponse::ok(id, value),
        Err(error) => RpcResponse::err(id, error),
    }
}

/// Artifact retention parsing shared by handlers.
pub fn parse_retention(raw: Option<&str>) -> RetentionClass {
    match raw {
        Some("pinned") => RetentionClass::Pinned,
        Some("temporary") => RetentionClass::Temporary,
        _ => RetentionClass::Session,
    }
}

#[cfg(test)]
mod tests {
    //! Runtime trust enforcement — P0-03: the runtime is the final boundary.
    //! These exercise the dispatch surface end to end so the gate is proven at
    //! the RPC layer, not just inside a helper.

    use super::*;

    fn request(method: &str, params: Value) -> RpcRequest {
        RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(RequestId::Number(1)),
            method: method.to_string(),
            params: Some(params),
        }
    }

    /// Initialize a fresh runtime against a throwaway workspace + data dir.
    const TEST_ISSUER: &str = "tttttttttttttttttttttttttttttttt";

    fn initialized() -> (tempfile::TempDir, RuntimeState) {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let data = dir.path().join("data");
        let state = RuntimeState::new();
        let outcome = dispatch(
            &state,
            &request(
                "runtime.initialize",
                json!({
                    "protocolVersion": "1.0",
                    "clientVersion": "test",
                    "workspace": workspace.to_string_lossy(),
                    "dataDir": data.to_string_lossy(),
                    "capabilityIssuerToken": TEST_ISSUER,
                }),
            ),
        )
        .expect("initialize dispatched");
        outcome.expect("initialize succeeds");
        (dir, state)
    }

    fn set_trust(state: &RuntimeState, trust_state: &str) {
        let outcome = dispatch(
            state,
            &request("workspace.trust.write", json!({ "state": trust_state })),
        )
        .expect("trust.write dispatched");
        outcome.expect("trust.write succeeds");
    }

    fn issue_capability(
        state: &RuntimeState,
        operation: &str,
        program: Option<&str>,
        args: &[&str],
        cwd: Option<&str>,
        resources: &[&str],
        network: &str,
    ) -> String {
        let mut capability_resources: Vec<&str> = resources.to_vec();
        if matches!(operation, "process.run" | "process.start") && capability_resources.is_empty() {
            capability_resources.push(
                "env:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            );
        }
        let mut params = json!({
            "issuerToken": TEST_ISSUER,
            "sessionId": "test-session",
            "callId": "test-call",
            "actionHash": "test-action",
            "operation": operation,
            "args": args,
            "resources": capability_resources,
            "network": network,
        });
        if let Some(program) = program {
            params["program"] = json!(program);
        }
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd);
        }
        let value = dispatch(state, &request("runtime.capability.issue", params))
            .expect("capability dispatched")
            .expect("capability issued");
        value["id"].as_str().expect("capability id").to_string()
    }

    fn begin_transaction(state: &RuntimeState) -> Result<Value, RpcError> {
        let receipt = issue_capability(state, "fs.transaction", None, &[], None, &[], "deny");
        dispatch(
            state,
            &request(
                "fs.transaction.begin",
                json!({ "capabilityReceipt": receipt, "capabilitySessionId": "test-session", "capabilityActionHash": "test-action" }),
            ),
        )
        .expect("begin dispatched")
    }

    #[test]
    fn workspace_operations_before_initialization_report_not_initialized() {
        let state = RuntimeState::new();
        let outcome = dispatch(&state, &request("fs.list", json!({ "path": "." })))
            .expect("fs.list dispatched");
        let error = outcome.expect_err("fs.list must require initialization");
        assert_eq!(error.code, error_codes::NOT_INITIALIZED);
        assert_eq!(
            error.data.as_ref().and_then(|data| data.get("taxonomy")),
            Some(&json!("NOT_INITIALIZED"))
        );
    }

    #[test]
    fn untrusted_workspace_refuses_transaction_begin() {
        let (_dir, state) = initialized();
        // No trust decision yet → untrusted.
        let err = begin_transaction(&state).expect_err("begin must be refused");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn untrusted_workspace_refuses_direct_write() {
        let (_dir, state) = initialized();
        let outcome = dispatch(
            &state,
            &request(
                "fs.write",
                json!({ "transactionId": "tx_1", "path": "a.txt", "content": "x", "intent": "create" }),
            ),
        )
        .expect("write dispatched");
        let err = outcome.expect_err("write must be refused");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn read_only_workspace_refuses_mutation() {
        let (_dir, state) = initialized();
        set_trust(&state, "read-only");
        let err = begin_transaction(&state).expect_err("begin must be refused");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn untrusted_workspace_refuses_process_run() {
        let (_dir, state) = initialized();
        let outcome = dispatch(
            &state,
            &request(
                "process.run",
                json!({ "program": "true", "args": [], "cwd": ".", "timeoutMs": 5000 }),
            ),
        )
        .expect("process.run dispatched");
        let err = outcome.expect_err("process.run must be refused");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn read_only_workspace_refuses_process_run() {
        // P0-02: a process can write anywhere the user can, so read-only must
        // refuse execution outright, not merely the native mutation RPCs.
        let (_dir, state) = initialized();
        set_trust(&state, "read-only");
        let outcome = dispatch(
            &state,
            &request(
                "process.run",
                json!({ "program": "true", "args": [], "cwd": ".", "timeoutMs": 5000 }),
            ),
        )
        .expect("process.run dispatched");
        let err = outcome.expect_err("process.run must be refused under read-only");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn process_run_rejects_network_allow_without_policy_grant() {
        // P0-03: the model used to pick `network: "allow"` itself; the runtime
        // now only honours it alongside an explicit policy grant.
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");
        let receipt = issue_capability(
            &state,
            "process.run",
            Some("true"),
            &[],
            Some("."),
            &[],
            "deny",
        );
        let outcome = dispatch(
            &state,
            &request(
                "process.run",
                json!({ "program": "true", "args": [], "cwd": ".", "timeoutMs": 5000, "network": "allow", "capabilitySessionId": "test-session", "capabilityActionHash": "test-action", "capabilityReceipt": receipt }),
            ),
        )
        .expect("process.run dispatched");
        let err = outcome.expect_err("network allow without a grant must be refused");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn initialize_recovers_before_admitting_initial_plan_mode() {
        let (dir, state) = initialized();
        let workspace = dir.path().join("ws");
        {
            let mut store_guard = state.store.lock().expect("store lock");
            store_guard
                .as_mut()
                .expect("session store")
                .record_transaction(
                    "tx_open_before_plan",
                    None,
                    None,
                    "open",
                    "2026-08-05T00:00:00Z",
                    None,
                    &[],
                )
                .expect("record open intent");
        }
        drop(state);

        let state2 = RuntimeState::new();
        let error = dispatch(
            &state2,
            &request(
                "runtime.initialize",
                json!({
                    "protocolVersion": "1.0",
                    "clientVersion": "test",
                    "workspace": workspace.to_string_lossy(),
                    "dataDir": dir.path().join("data").to_string_lossy(),
                    "interactionMode": "plan",
                }),
            ),
        )
        .expect("initialize dispatched")
        .expect_err("initial Plan mode must not hide an open durable transaction");
        assert_eq!(error.code, error_codes::PERMISSION_DENIED);
        assert!(!state2.initialized.load(Ordering::SeqCst));
        assert_eq!(
            state2.interaction_mode.lock().expect("mode lock").as_str(),
            "build"
        );
    }

    #[test]
    fn live_plan_mode_is_enforced_by_the_runtime() {
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");

        let entered = dispatch(
            &state,
            &request("workspace.mode.write", json!({ "mode": "plan" })),
        )
        .expect("mode.write dispatched")
        .expect("quiescent runtime enters Plan mode");
        assert_eq!(entered["mode"], "plan");
        assert_eq!(
            state.interaction_mode.lock().expect("mode lock").as_str(),
            "plan"
        );

        // The runtime gate runs before capability/path validation, so forged
        // mutation and process requests are denied by the live mode itself.
        for (method, params) in [
            (
                "fs.write",
                json!({
                    "transactionId": "tx_plan",
                    "path": "blocked.txt",
                    "content": "blocked",
                    "intent": "create",
                }),
            ),
            (
                "process.run",
                json!({ "program": "true", "args": [], "cwd": "." }),
            ),
        ] {
            let error = dispatch(&state, &request(method, params))
                .expect("request dispatched")
                .expect_err("Plan mode must reject the operation");
            assert_eq!(
                error.code,
                error_codes::PERMISSION_DENIED,
                "{method}: {error:?}"
            );
        }

        // Stopping an owned job is the one process operation intentionally kept
        // safe in Plan mode; an unknown id proves it reached the handler instead
        // of being rejected by the process execution gate.
        let error = dispatch(
            &state,
            &request("process.stop", json!({ "jobId": "missing" })),
        )
        .expect("process.stop dispatched")
        .expect_err("missing job is a handler-level NOT_FOUND");
        assert_eq!(error.code, error_codes::NOT_FOUND);

        let exited = dispatch(
            &state,
            &request("workspace.mode.write", json!({ "mode": "build" })),
        )
        .expect("mode.write dispatched")
        .expect("Plan can always return to Build");
        assert_eq!(exited["mode"], "build");
    }

    #[test]
    fn plan_entry_fails_while_a_write_admission_is_between_check_and_registration() {
        let (_dir, state) = initialized();

        // Simulate an operation that won the admission race but has not yet
        // registered its transaction/process. The mode transition must fail
        // closed rather than install Plan mode in that gap.
        state.write_admissions.fetch_add(1, Ordering::SeqCst);
        let error = dispatch(
            &state,
            &request("workspace.mode.write", json!({ "mode": "plan" })),
        )
        .expect("mode.write dispatched")
        .expect_err("an outstanding write admission blocks Plan entry");
        assert_eq!(error.code, error_codes::PERMISSION_DENIED);
        assert_eq!(
            state.interaction_mode.lock().expect("mode lock").as_str(),
            "build"
        );
        state.write_admissions.fetch_sub(1, Ordering::SeqCst);

        dispatch(
            &state,
            &request("workspace.mode.write", json!({ "mode": "plan" })),
        )
        .expect("mode.write dispatched")
        .expect("Plan entry succeeds once the admission drains");
    }

    #[test]
    fn live_plan_mode_rejects_process_input_before_job_lookup() {
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");
        dispatch(
            &state,
            &request("workspace.mode.write", json!({ "mode": "plan" })),
        )
        .expect("mode.write dispatched")
        .expect("Plan mode entered");
        let err = dispatch(
            &state,
            &request("process.input", json!({ "jobId": "missing", "data": "x" })),
        )
        .expect("process.input dispatched")
        .expect_err("Plan mode must refuse stdin mutation");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn trusted_workspace_allows_mutation() {
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");
        let value = begin_transaction(&state).expect("begin succeeds once trusted");
        assert!(value.get("transactionId").is_some());
    }

    #[test]
    fn sensitive_write_accepts_absolute_capability_resource_when_path_is_same() {
        let (dir, state) = initialized();
        set_trust(&state, "trusted-always");
        let workspace = dir.path().join("ws");
        let absolute = workspace.join("secret.txt");
        let receipt = issue_capability(
            &state,
            "fs.transaction",
            None,
            &[],
            None,
            &[absolute.to_string_lossy().as_ref()],
            "deny",
        );
        let begin = dispatch(
            &state,
            &request(
                "fs.transaction.begin",
                json!({
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("begin dispatched")
        .expect("begin succeeds");
        let transaction_id = begin["transactionId"].as_str().expect("transaction id");
        dispatch(
            &state,
            &request(
                "fs.write",
                json!({
                    "transactionId": transaction_id,
                    "path": "secret.txt",
                    "content": "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
                    "intent": "create",
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("write dispatched")
        .expect("sensitive write stages with its canonical capability resource");
        dispatch(
            &state,
            &request(
                "fs.transaction.commit",
                json!({
                    "transactionId": transaction_id,
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("commit dispatched")
        .expect("commit succeeds");
        assert_eq!(
            std::fs::read_to_string(workspace.join("secret.txt")).unwrap(),
            "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345"
        );
    }

    #[test]
    fn revoking_trust_mid_session_blocks_the_next_mutation() {
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");
        begin_transaction(&state).expect("begin succeeds while trusted");
        set_trust(&state, "read-only");
        let err = begin_transaction(&state).expect_err("begin refused after revocation");
        assert_eq!(err.code, error_codes::PERMISSION_DENIED);
    }

    #[test]
    fn trusted_workspace_still_allows_reads_and_status() {
        let (_dir, state) = initialized();
        set_trust(&state, "read-only");
        let value = dispatch(&state, &request("git.status", json!({})))
            .expect("git.status dispatched")
            .expect("read-shaped operations still work under read-only");
        assert!(value.is_object());
    }

    // P0-01: the CLI manages trust through the runtime instead of writing the
    // store file itself, so add/remove/list are proven at the dispatch surface.

    #[test]
    fn trust_set_canonicalizes_and_persists_for_any_path() {
        let (dir, state) = initialized();
        let target = dir.path().join("other-project");
        std::fs::create_dir_all(&target).unwrap();

        let value = dispatch(
            &state,
            &request(
                "workspace.trust.set",
                json!({ "path": target.to_string_lossy(), "state": "trusted-always" }),
            ),
        )
        .expect("trust.set dispatched")
        .expect("trust.set succeeds");
        assert_eq!(value["state"], "trusted-always");
        assert_eq!(value["persisted"], true);
        let canonical = value["canonicalPath"]
            .as_str()
            .expect("canonical path")
            .to_string();

        // The durable store — not a host-side file — carries the decision.
        let trust_path = dir.path().join("data").join("trust.json");
        let raw = std::fs::read_to_string(&trust_path).expect("trust file written");
        let persisted: TrustStore = serde_json::from_str(&raw).expect("valid trust store");
        assert!(persisted
            .records
            .values()
            .any(|record| record.canonical_path == canonical));

        let list = dispatch(&state, &request("workspace.trust.list", json!({})))
            .expect("trust.list dispatched")
            .expect("trust.list succeeds");
        let records = list["records"].as_array().expect("records array");
        assert!(records
            .iter()
            .any(|record| record["canonicalPath"] == canonical));
    }

    #[test]
    fn trust_set_refuses_a_missing_path() {
        let (dir, state) = initialized();
        let missing = dir.path().join("does-not-exist");
        let err = dispatch(
            &state,
            &request(
                "workspace.trust.set",
                json!({ "path": missing.to_string_lossy(), "state": "trusted-always" }),
            ),
        )
        .expect("trust.set dispatched")
        .expect_err("a missing trust target is refused");
        assert_eq!(err.code, error_codes::NOT_FOUND);
    }

    #[test]
    fn trust_remove_revokes_and_persists() {
        let (dir, state) = initialized();
        let target = dir.path().join("other-project");
        std::fs::create_dir_all(&target).unwrap();
        dispatch(
            &state,
            &request(
                "workspace.trust.set",
                json!({ "path": target.to_string_lossy(), "state": "trusted-always" }),
            ),
        )
        .expect("set dispatched")
        .expect("set succeeds");

        let value = dispatch(
            &state,
            &request(
                "workspace.trust.remove",
                json!({ "path": target.to_string_lossy() }),
            ),
        )
        .expect("trust.remove dispatched")
        .expect("trust.remove succeeds");
        assert_eq!(value["removed"], true);

        let list = dispatch(&state, &request("workspace.trust.list", json!({})))
            .expect("trust.list dispatched")
            .expect("trust.list succeeds");
        let records = list["records"].as_array().expect("records array");
        assert!(records
            .iter()
            .all(|record| record["canonicalPath"] != target.to_string_lossy().to_string()));
    }

    #[test]
    fn trust_remove_of_a_deleted_directory_cleans_the_stale_record() {
        let (dir, state) = initialized();
        let target = dir.path().join("gone-soon");
        std::fs::create_dir_all(&target).unwrap();
        dispatch(
            &state,
            &request(
                "workspace.trust.set",
                json!({ "path": target.to_string_lossy(), "state": "trusted-always" }),
            ),
        )
        .expect("set dispatched")
        .expect("set succeeds");

        std::fs::remove_dir_all(&target).unwrap();
        let value = dispatch(
            &state,
            &request(
                "workspace.trust.remove",
                json!({ "path": target.to_string_lossy() }),
            ),
        )
        .expect("trust.remove dispatched")
        .expect("removal succeeds even though the directory is gone");
        assert_eq!(value["removed"], true);
    }

    #[test]
    fn trusted_once_via_set_is_not_persisted() {
        let (dir, state) = initialized();
        let target = dir.path().join("once-project");
        std::fs::create_dir_all(&target).unwrap();
        let value = dispatch(
            &state,
            &request(
                "workspace.trust.set",
                json!({ "path": target.to_string_lossy(), "state": "trusted-once" }),
            ),
        )
        .expect("trust.set dispatched")
        .expect("trust.set succeeds");
        assert_eq!(value["persisted"], false);
        let trust_path = dir.path().join("data").join("trust.json");
        let raw = std::fs::read_to_string(&trust_path).unwrap_or_default();
        assert!(!raw.contains("once-project"));
    }

    // P0-07: a transaction that crashes mid-commit is rolled back at the next
    // startup, restoring pre-images without touching user-modified paths.

    #[test]
    fn crash_mid_commit_is_recovered_on_next_startup() {
        let (dir, state) = initialized();
        set_trust(&state, "trusted-always");

        let workspace = dir.path().join("ws");
        let victim = workspace.join("victim.txt");
        std::fs::write(&victim, "original\n").unwrap();

        // Stage and apply a replace normally first, so the flow is exercised end
        // to end...
        let receipt = issue_capability(
            &state,
            "fs.transaction",
            None,
            &[],
            None,
            &["victim.txt"],
            "deny",
        );
        dispatch(
            &state,
            &request(
                "fs.transaction.begin",
                json!({ "transactionId": "tx_crash", "capabilityReceipt": receipt.clone(), "capabilitySessionId": "test-session", "capabilityActionHash": "test-action" }),
            ),
        )
        .expect("begin dispatched")
        .expect("begin succeeds");
        let pre_hash = cbc_fs::hash_bytes(b"original\n");
        dispatch(
            &state,
            &request(
                "fs.write",
                json!({
                    "transactionId": "tx_crash",
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                    "path": "victim.txt",
                    "content": "modified\n",
                    "intent": "replace",
                    "expectedHash": pre_hash,
                }),
            ),
        )
        .expect("write dispatched")
        .expect("write stages");

        // ...then simulate the crash: mark the durable row `applying` with the
        // pre-image spilled, drop the process, and rewrite the file as the
        // partially-applied commit would have left it.
        let post_hash = cbc_fs::hash_bytes(b"modified\n");
        let digest = {
            let artifacts = state.artifacts.lock().expect("artifacts lock");
            let store = artifacts.as_ref().expect("artifact store");
            store
                .create(
                    b"original\n",
                    "text/plain",
                    Some("pre-image: victim.txt"),
                    cbc_artifacts::RetentionClass::Pinned,
                    None,
                )
                .expect("spill pre-image")
                .digest
        };
        {
            let mut store_guard = state.store.lock().expect("store lock");
            let store = store_guard.as_mut().expect("session store");
            store
                .record_transaction(
                    "tx_crash",
                    None,
                    None,
                    "applying",
                    "2026-08-05T00:00:00Z",
                    None,
                    &[cbc_session_store::TransactionOperation {
                        path: "victim.txt".into(),
                        kind: "modify".into(),
                        pre_hash: Some(pre_hash.clone()),
                        post_hash: Some(post_hash),
                        pre_image_artifact: Some(digest),
                        additions: 1,
                        deletions: 1,
                        new_path: None,
                    }],
                )
                .expect("record applying");
        }
        std::fs::write(&victim, "modified\n").unwrap();
        drop(state);

        // Next startup: a fresh runtime over the same data dir runs recovery
        // during initialize.
        let state2 = RuntimeState::new();
        dispatch(
            &state2,
            &request(
                "runtime.initialize",
                json!({
                    "protocolVersion": "1.0",
                    "clientVersion": "test",
                    "workspace": workspace.to_string_lossy(),
                    "dataDir": dir.path().join("data").to_string_lossy(),
                }),
            ),
        )
        .expect("re-init dispatched")
        .expect("re-init succeeds");

        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "original\n",
            "crash recovery must restore the pre-image"
        );
    }

    #[test]
    fn crash_recovery_skips_paths_the_user_touched_afterwards() {
        let (dir, state) = initialized();
        set_trust(&state, "trusted-always");

        let workspace = dir.path().join("ws");
        let victim = workspace.join("victim.txt");
        std::fs::write(&victim, "modified\n").unwrap();

        let pre_hash = cbc_fs::hash_bytes(b"original\n");
        let digest = {
            let artifacts = state.artifacts.lock().expect("artifacts lock");
            let store = artifacts.as_ref().expect("artifact store");
            store
                .create(
                    b"original\n",
                    "text/plain",
                    None,
                    cbc_artifacts::RetentionClass::Pinned,
                    None,
                )
                .expect("spill")
                .digest
        };
        {
            let mut store_guard = state.store.lock().expect("store lock");
            let store = store_guard.as_mut().expect("session store");
            store
                .record_transaction(
                    "tx_user",
                    None,
                    None,
                    "applying",
                    "2026-08-05T00:00:00Z",
                    None,
                    &[cbc_session_store::TransactionOperation {
                        path: "victim.txt".into(),
                        kind: "modify".into(),
                        pre_hash: Some(pre_hash),
                        // The recorded post-state no longer matches disk: the user
                        // edited the file after the crash.
                        post_hash: Some(cbc_fs::hash_bytes(b"stale-post\n")),
                        pre_image_artifact: Some(digest),
                        additions: 1,
                        deletions: 1,
                        new_path: None,
                    }],
                )
                .expect("record applying");
        }
        drop(state);

        let state2 = RuntimeState::new();
        dispatch(
            &state2,
            &request(
                "runtime.initialize",
                json!({
                    "protocolVersion": "1.0",
                    "clientVersion": "test",
                    "workspace": workspace.to_string_lossy(),
                    "dataDir": dir.path().join("data").to_string_lossy(),
                }),
            ),
        )
        .expect("re-init dispatched")
        .expect("re-init succeeds");

        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "modified\n",
            "user-modified paths must never be overwritten by recovery"
        );
    }

    // P0-05: the SQLite store is the single session authority. list/export/
    // fork/logical-delete/set_status are proven at the dispatch surface.

    fn open_session(state: &RuntimeState, session_id: &str) {
        dispatch(
            state,
            &request(
                "session.open",
                json!({ "sessionId": session_id, "title": "test session" }),
            ),
        )
        .expect("session.open dispatched")
        .expect("session.open succeeds");
    }

    fn append_turn_completed(state: &RuntimeState, session_id: &str, sequence_seed: i64) {
        dispatch(
            state,
            &request(
                "session.append",
                json!({
                    "sessionId": session_id,
                    "event": {
                        "id": format!("ev_{sequence_seed}"),
                        "kind": "turn.completed",
                        "timestamp": "2026-08-05T00:00:00Z",
                        "payload": {},
                    },
                }),
            ),
        )
        .expect("session.append dispatched")
        .expect("session.append succeeds");
    }

    #[test]
    fn session_append_accepts_an_ordered_event_batch() {
        let (_dir, state) = initialized();
        open_session(&state, "ses_batch");
        let appended = dispatch(
            &state,
            &request(
                "session.append",
                json!({
                    "sessionId": "ses_batch",
                    "events": [
                        {
                            "id": "evt_batch_1",
                            "kind": "user.message",
                            "timestamp": "2026-08-05T00:00:00Z",
                            "payload": { "text": "first" },
                        },
                        {
                            "id": "evt_batch_2",
                            "kind": "assistant.final",
                            "timestamp": "2026-08-05T00:00:01Z",
                            "payload": { "text": "second" },
                        },
                    ],
                }),
            ),
        )
        .expect("session.append batch dispatched")
        .expect("session.append batch succeeds");

        assert_eq!(appended["appended"], 2);
        assert_eq!(appended["lastSequence"], 2);
        let events = appended["events"].as_array().expect("ack events");
        assert_eq!(events[0]["id"], "evt_batch_1");
        assert_eq!(events[0]["sequence"], 1);
        assert_eq!(events[1]["id"], "evt_batch_2");
        assert_eq!(events[1]["sequence"], 2);

        let loaded = dispatch(
            &state,
            &request(
                "session.load",
                json!({ "sessionId": "ses_batch", "afterSequence": 0, "limit": 10 }),
            ),
        )
        .expect("session.load dispatched")
        .expect("session.load succeeds");
        let stored = loaded["events"].as_array().expect("stored events");
        assert_eq!(
            stored
                .iter()
                .map(|event| event["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["evt_batch_1", "evt_batch_2"]
        );
    }

    #[test]
    fn session_list_is_workspace_scoped_and_counts_turns() {
        let (_dir, state) = initialized();
        open_session(&state, "ses_1");
        append_turn_completed(&state, "ses_1", 1);
        append_turn_completed(&state, "ses_1", 2);

        let list = dispatch(&state, &request("session.list", json!({})))
            .expect("session.list dispatched")
            .expect("session.list succeeds");
        let sessions = list["sessions"].as_array().expect("sessions array");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["id"], "ses_1");
        assert_eq!(
            sessions[0]["turnCount"], 2,
            "turn.completed events tally turns"
        );
    }

    #[test]
    fn session_set_status_updates_the_durable_row() {
        let (_dir, state) = initialized();
        open_session(&state, "ses_2");
        dispatch(
            &state,
            &request(
                "session.set_status",
                json!({ "sessionId": "ses_2", "status": "completed" }),
            ),
        )
        .expect("set_status dispatched")
        .expect("set_status succeeds");

        let list = dispatch(&state, &request("session.list", json!({})))
            .expect("list dispatched")
            .expect("list succeeds");
        assert_eq!(list["sessions"][0]["state"], "completed");
    }

    #[test]
    fn session_export_renders_the_journal_as_jsonl() {
        let (_dir, state) = initialized();
        open_session(&state, "ses_3");
        append_turn_completed(&state, "ses_3", 1);

        let export = dispatch(
            &state,
            &request("session.export", json!({ "sessionId": "ses_3" })),
        )
        .expect("export dispatched")
        .expect("export succeeds");
        assert_eq!(export["eventCount"], 1);
        let jsonl = export["jsonl"].as_str().expect("jsonl string");
        let line = jsonl.lines().next().expect("one line");
        let parsed: serde_json::Value = serde_json::from_str(line).expect("valid json");
        assert_eq!(parsed["kind"], "turn.completed");
        assert_eq!(parsed["sessionId"], "ses_3");
        assert_eq!(parsed["durability"], "journaled");
    }

    #[test]
    fn session_fork_copies_the_journal_and_records_lineage() {
        let (_dir, state) = initialized();
        open_session(&state, "ses_4");
        append_turn_completed(&state, "ses_4", 1);

        let fork = dispatch(
            &state,
            &request(
                "session.fork",
                json!({ "sessionId": "ses_4", "newSessionId": "ses_4_fork", "title": "forked" }),
            ),
        )
        .expect("fork dispatched")
        .expect("fork succeeds");
        assert_eq!(fork["sessionId"], "ses_4_fork");
        assert_eq!(fork["forkedFrom"], "ses_4");

        // The fork carries the parent's journal and lineage.
        let export = dispatch(
            &state,
            &request("session.export", json!({ "sessionId": "ses_4_fork" })),
        )
        .expect("export dispatched")
        .expect("export succeeds");
        assert_eq!(export["eventCount"], 1);
        assert_eq!(export["manifest"]["parentSessionId"], "ses_4");

        // The source is untouched.
        let list = dispatch(&state, &request("session.list", json!({})))
            .expect("list dispatched")
            .expect("list succeeds");
        assert_eq!(list["sessions"].as_array().expect("array").len(), 2);
    }

    #[test]
    fn session_delete_hides_the_archived_session_from_default_lists() {
        let (_dir, state) = initialized();
        open_session(&state, "ses_5");
        append_turn_completed(&state, "ses_5", 1);

        dispatch(
            &state,
            &request("session.delete", json!({ "sessionId": "ses_5" })),
        )
        .expect("delete dispatched")
        .expect("delete succeeds");

        let list = dispatch(&state, &request("session.list", json!({})))
            .expect("list dispatched")
            .expect("list succeeds");
        assert!(list["sessions"].as_array().expect("array").is_empty());
    }

    // P0-04: real sandbox enforcement surfaces at the RPC layer.

    /// Initialize with an explicit sandbox level and return the capabilities.
    fn initialized_with_sandbox(sandbox_level: &str) -> (tempfile::TempDir, RuntimeState, Value) {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let data = dir.path().join("data");
        let state = RuntimeState::new();
        let outcome = dispatch(
            &state,
            &request(
                "runtime.initialize",
                json!({
                    "protocolVersion": "1.0",
                    "clientVersion": "test",
                    "workspace": workspace.to_string_lossy(),
                    "dataDir": data.to_string_lossy(),
                    "sandboxLevel": sandbox_level,
                    "capabilityIssuerToken": TEST_ISSUER,
                }),
            ),
        )
        .expect("initialize dispatched");
        let result = outcome.expect("initialize succeeds");
        (dir, state, result)
    }

    #[test]
    fn strict_sandbox_confines_child_processes() {
        if !cbc_sandbox::filesystem_isolation_available() {
            eprintln!("skipping: no filesystem-isolation backend on this host");
            return;
        }
        let home = match std::env::var("HOME") {
            Ok(home) => home,
            Err(_) => return,
        };
        // If the home directory happens to sit inside an allowlisted system
        // root, the assertion below cannot distinguish confinement.
        let allowlisted = [
            "/tmp", "/etc", "/usr", "/bin", "/sbin", "/lib", "/opt", "/proc", "/dev",
        ];
        if allowlisted.iter().any(|root| home.starts_with(root)) {
            eprintln!("skipping: HOME {home} is inside the allowlist");
            return;
        }

        let (_dir, state, result) = initialized_with_sandbox("strict");
        set_trust(&state, "trusted-always");
        let caps = &result["capabilities"];
        assert_eq!(caps["sandboxLevel"], "strict", "{caps}");
        assert_eq!(caps["enhancedSandbox"], true, "{caps}");

        // Inside the workspace: allowed.
        let inside_receipt = issue_capability(
            &state,
            "process.run",
            Some("/bin/sh"),
            &["-c", "echo ok > strict-probe.txt && echo wrote"],
            Some("."),
            &[],
            "deny",
        );
        let inside = dispatch(
            &state,
            &request(
                "process.run",
                json!({ "program": "/bin/sh", "args": ["-c", "echo ok > strict-probe.txt && echo wrote"], "cwd": ".", "timeoutMs": 10000, "capabilitySessionId": "test-session", "capabilityActionHash": "test-action", "capabilityReceipt": inside_receipt }),
            ),
        )
        .expect("dispatched")
        .expect("in-workspace spawn succeeds under strict");
        assert!(
            inside["stdout"].as_str().unwrap_or("").contains("wrote"),
            "{inside}"
        );

        // Outside every allowlisted root: denied by Landlock.
        let script =
            format!("cat {home}/.profile >/dev/null 2>&1 && echo readable || echo blocked");
        let outside_receipt = issue_capability(
            &state,
            "process.run",
            Some("/bin/sh"),
            &["-c", &script],
            Some("."),
            &[],
            "deny",
        );
        let outside = dispatch(
            &state,
            &request(
                "process.run",
                json!({ "program": "/bin/sh", "args": ["-c", script], "cwd": ".", "timeoutMs": 10000, "capabilitySessionId": "test-session", "capabilityActionHash": "test-action", "capabilityReceipt": outside_receipt }),
            ),
        )
        .expect("dispatched")
        .expect("the spawn itself succeeds; the read inside it fails");
        assert!(
            outside["stdout"].as_str().unwrap_or("").contains("blocked"),
            "the confined child could read outside its allowlist: {outside}"
        );
    }

    #[test]
    fn fs_read_exact_and_preview_expose_revision_metadata() {
        let (dir, state) = initialized();
        let path = dir.path().join("ws").join("range.txt");
        let content = "one\ntwo\nthree\nfour\n";
        std::fs::write(&path, content).unwrap();

        let exact = dispatch(
            &state,
            &request(
                "fs.read",
                json!({ "path": "range.txt", "startLine": 2, "maxLines": 2 }),
            ),
        )
        .expect("read dispatched")
        .expect("exact read succeeds");
        assert_eq!(exact["mode"], "exact");
        assert_eq!(exact["authoritativeForWrite"], true);
        assert_eq!(exact["excerpt"]["text"], "two\nthree");
        assert_eq!(exact["excerpt"]["startLine"], 2);
        assert_eq!(exact["excerpt"]["endLine"], 3);
        assert_eq!(exact["excerpt"]["totalLines"], 4);
        assert_eq!(exact["excerpt"]["endOfFile"], false);
        assert_eq!(exact["excerpt"]["truncatedByBytes"], false);
        assert_eq!(exact["checksum"], cbc_fs::hash_bytes(content.as_bytes()));
        assert_eq!(exact["revisionToken"], exact["checksum"]);

        let preview = dispatch(
            &state,
            &request(
                "fs.read",
                json!({ "path": "range.txt", "startLine": 2, "maxLines": 1, "mode": "preview" }),
            ),
        )
        .expect("preview dispatched")
        .expect("preview succeeds");
        assert_eq!(preview["mode"], "preview");
        assert_eq!(preview["authoritativeForWrite"], false);
        assert_eq!(preview["excerpt"]["text"], "two");
        assert!(preview["revisionToken"]
            .as_str()
            .unwrap()
            .starts_with("revision:"));
        assert!(preview.get("checksum").is_none());
        assert!(preview["excerpt"].get("totalLines").is_none());

        let default_content = (1..=401)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("ws").join("default.txt"), &default_content).unwrap();
        let default_read = dispatch(
            &state,
            &request("fs.read", json!({ "path": "default.txt" })),
        )
        .expect("default read dispatched")
        .expect("default read succeeds");
        assert_eq!(default_read["selectedLines"], 400);
        assert_eq!(default_read["excerpt"]["totalLines"], 401);
    }

    #[test]
    fn memory_remember_reuses_only_runtime_exact_evidence() {
        let (dir, state) = initialized();
        let workspace = dir.path().join("ws");
        std::fs::write(workspace.join("memory.txt"), "evidence-backed fact\n").unwrap();

        let incomplete = dispatch(
            &state,
            &request(
                "fs.read",
                json!({
                    "path": "memory.txt",
                    "startLine": 2,
                    "maxLines": 1,
                    "recordEvidence": true,
                }),
            ),
        )
        .expect("incomplete read dispatched")
        .expect_err("partial exact reads cannot become durable evidence");
        assert_eq!(incomplete.code, error_codes::INVALID_ARGUMENT);

        let observed = dispatch(
            &state,
            &request(
                "fs.read",
                json!({ "path": "memory.txt", "recordEvidence": true }),
            ),
        )
        .expect("exact read dispatched")
        .expect("complete exact read succeeds");
        let evidence_id = observed["evidenceId"]
            .as_str()
            .expect("exact read returns evidence id")
            .to_string();
        let workspace_identity = state.require_workspace().unwrap().fingerprint();

        let proposal = json!({
            "scope": "workspace",
            "key": "memory.runtime",
            "value": "memory.txt was observed by an exact runtime read",
            "confidence": 0.9,
            "paths": ["memory.txt"],
            "evidenceIds": [evidence_id.clone()],
            "reason": "runtime exact observation",
        });
        let remembered = dispatch(&state, &request("memory.remember", proposal.clone()))
            .expect("remember dispatched")
            .expect("fresh exact evidence permits workspace memory");
        let memory_id = remembered["memory"]["id"]
            .as_str()
            .expect("runtime derives memory id")
            .to_string();
        assert!(memory_id.starts_with("memory-"));
        assert_eq!(
            remembered["memory"]["workspaceIdentityDigest"],
            workspace_identity
        );
        assert_eq!(
            remembered["memory"]["validFor"]["paths"],
            json!(["memory.txt"])
        );
        assert_eq!(remembered["idempotent"], false);

        let replay = dispatch(&state, &request("memory.remember", proposal))
            .expect("repeat remember dispatched")
            .expect("repeat proposal returns the original record");
        assert_eq!(replay["memory"]["id"], memory_id);
        assert_eq!(replay["idempotent"], true);

        let injected = dispatch(
            &state,
            &request(
                "memory.remember",
                json!({
                    "key": "memory.injected",
                    "value": "client-controlled workspace identity is refused",
                    "evidenceIds": [evidence_id],
                    "workspaceIdentityDigest": workspace_identity,
                }),
            ),
        )
        .expect("injected proposal dispatched")
        .expect_err("authority fields are not accepted from callers");
        assert_eq!(injected.code, error_codes::INVALID_PARAMS);

        let search = dispatch(
            &state,
            &request("memory.search", json!({ "query": "runtime" })),
        )
        .expect("search dispatched")
        .expect("search succeeds");
        assert_eq!(search["freshEvidenceRequired"], true);
        assert_eq!(search["memories"].as_array().unwrap().len(), 1);

        // The same runtime store is the source of truth for invalidation. Once
        // evidence becomes invalid, model-facing search must no longer return the
        // claim even though its audit row remains available to diagnostics.
        state
            .store
            .lock()
            .expect("store lock")
            .as_mut()
            .expect("store")
            .invalidate_evidence_for_path(
                &workspace_identity,
                "memory.txt",
                "test mutation",
                "2026-08-25T00:01:00Z",
            )
            .expect("invalidate evidence");
        let hidden = dispatch(&state, &request("memory.search", json!({})))
            .expect("search dispatched")
            .expect("search succeeds");
        assert!(hidden["memories"].as_array().unwrap().is_empty());
    }

    #[test]
    fn memory_list_get_forget_resolve_and_verify() {
        let (dir, state) = initialized();
        let workspace = dir.path().join("ws");
        std::fs::write(workspace.join("left.txt"), "prettier\n").unwrap();
        std::fs::write(workspace.join("right.txt"), "biome\n").unwrap();

        let left_evidence = dispatch(
            &state,
            &request(
                "fs.read",
                json!({ "path": "left.txt", "recordEvidence": true }),
            ),
        )
        .expect("left read dispatched")
        .expect("left exact read succeeds")["evidenceId"]
            .as_str()
            .expect("left evidence id")
            .to_string();
        let right_evidence = dispatch(
            &state,
            &request(
                "fs.read",
                json!({ "path": "right.txt", "recordEvidence": true }),
            ),
        )
        .expect("right read dispatched")
        .expect("right exact read succeeds")["evidenceId"]
            .as_str()
            .expect("right evidence id")
            .to_string();
        let workspace_identity = state.require_workspace().unwrap().fingerprint();

        let left = dispatch(
            &state,
            &request(
                "memory.remember",
                json!({
                    "key": "formatter",
                    "value": "prettier",
                    "paths": ["left.txt"],
                    "evidenceIds": [left_evidence],
                }),
            ),
        )
        .expect("left remember dispatched")
        .expect("left remember succeeds");
        let left_id = left["memory"]["id"].as_str().unwrap().to_string();
        let right = dispatch(
            &state,
            &request(
                "memory.remember",
                json!({
                    "key": "formatter.alt",
                    "value": "biome",
                    "paths": ["right.txt"],
                    "evidenceIds": [right_evidence],
                }),
            ),
        )
        .expect("right remember dispatched")
        .expect("right remember succeeds");
        let right_id = right["memory"]["id"].as_str().unwrap().to_string();

        let listed = dispatch(&state, &request("memory.list", json!({})))
            .expect("list dispatched")
            .expect("list succeeds");
        assert_eq!(listed["memories"].as_array().unwrap().len(), 2);
        assert_eq!(listed["workspaceIdentityDigest"], workspace_identity);

        let fetched = dispatch(&state, &request("memory.get", json!({ "id": left_id })))
            .expect("get dispatched")
            .expect("get succeeds");
        assert_eq!(fetched["memory"]["id"], left_id);
        assert_eq!(fetched["memory"]["status"], "active");

        let verified = dispatch(&state, &request("memory.verify", json!({ "id": left_id })))
            .expect("verify dispatched")
            .expect("verify succeeds");
        assert_eq!(verified["fresh"], true);
        assert_eq!(verified["memory"]["id"], left_id);

        let resolved = dispatch(
            &state,
            &request(
                "memory.resolve_contest",
                json!({
                    "winnerId": left_id,
                    "loserIds": [right_id],
                    "reason": "checked-in config wins",
                }),
            ),
        )
        .expect("resolve dispatched")
        .expect("resolve succeeds");
        assert_eq!(resolved["memory"]["status"], "active");
        let superseded = dispatch(&state, &request("memory.get", json!({ "id": right_id })))
            .expect("loser get dispatched")
            .expect("loser get succeeds");
        assert_eq!(superseded["memory"]["status"], "superseded");
        let active_only = dispatch(&state, &request("memory.search", json!({})))
            .expect("search dispatched")
            .expect("search succeeds");
        assert_eq!(active_only["memories"].as_array().unwrap().len(), 1);
        assert_eq!(active_only["memories"][0]["id"], left_id);

        let forgotten = dispatch(
            &state,
            &request(
                "memory.forget",
                json!({ "id": left_id, "reason": "no longer relevant" }),
            ),
        )
        .expect("forget dispatched")
        .expect("forget succeeds");
        assert_eq!(forgotten["memory"]["status"], "forgotten");
        let hidden = dispatch(&state, &request("memory.search", json!({})))
            .expect("search dispatched")
            .expect("search succeeds");
        assert!(hidden["memories"].as_array().unwrap().is_empty());
        let inspect = dispatch(
            &state,
            &request("memory.list", json!({ "statuses": ["forgotten"] })),
        )
        .expect("forgotten list dispatched")
        .expect("forgotten list succeeds");
        assert_eq!(inspect["memories"].as_array().unwrap().len(), 1);
        assert_eq!(inspect["memories"][0]["id"], left_id);
        let still_there = dispatch(&state, &request("memory.get", json!({ "id": left_id })))
            .expect("forgotten get dispatched")
            .expect("forgotten get succeeds");
        assert_eq!(still_there["memory"]["status"], "forgotten");

        let injected = dispatch(
            &state,
            &request(
                "memory.forget",
                json!({
                    "id": right_id,
                    "workspaceIdentityDigest": workspace_identity,
                }),
            ),
        )
        .expect("injected forget dispatched")
        .expect_err("injected workspace identity is refused");
        assert_eq!(injected.code, error_codes::INVALID_PARAMS);
    }

    #[test]
    fn fs_read_many_supports_v2_ranges_and_aggregate_budgets() {
        let (dir, state) = initialized();
        let workspace = dir.path().join("ws");
        std::fs::write(workspace.join("a.txt"), "a1\na2\na3\n").unwrap();
        std::fs::write(workspace.join("b.txt"), "b1\nb2\nb3\n").unwrap();

        let batch = dispatch(
            &state,
            &request(
                "fs.read_many",
                json!({
                    "items": [
                        { "path": "a.txt", "startLine": 1, "maxLines": 2, "mode": "preview" },
                        { "path": "b.txt", "startLine": 2, "maxLines": 2, "mode": "exact" }
                    ],
                    "maxTotalLines": 3,
                    "maxTotalBytes": 100,
                    "concurrency": 2
                }),
            ),
        )
        .expect("read_many dispatched")
        .expect("read_many succeeds");
        assert_eq!(batch["requested"], 2);
        assert_eq!(batch["files"].as_array().unwrap().len(), 2);
        assert_eq!(batch["totalLines"], 3);
        assert_eq!(batch["concurrency"], 2);
        assert_eq!(batch["truncated"], true);
        assert_eq!(batch["files"][0]["mode"], "preview");
        assert_eq!(batch["files"][0]["authoritativeForWrite"], false);
        assert_eq!(batch["files"][1]["mode"], "exact");
        assert_eq!(batch["files"][1]["excerpt"]["text"], "b2");

        let legacy = dispatch(
            &state,
            &request(
                "fs.read_many",
                json!({ "paths": ["a.txt", "b.txt"], "maxLines": 1 }),
            ),
        )
        .expect("legacy read_many dispatched")
        .expect("legacy read_many succeeds");
        assert_eq!(legacy["files"].as_array().unwrap().len(), 2);
        assert_eq!(legacy["files"][0]["excerpt"]["text"], "a1");
    }

    #[test]
    fn fs_fingerprint_returns_metadata_token_and_optional_checksum() {
        let (dir, state) = initialized();
        let path = dir.path().join("ws").join("fingerprint.txt");
        std::fs::write(&path, "fingerprint\n").unwrap();

        let value = dispatch(
            &state,
            &request("fs.fingerprint", json!({ "path": "fingerprint.txt" })),
        )
        .expect("fingerprint dispatched")
        .expect("fingerprint succeeds");
        assert_eq!(value["authoritativeForWrite"], false);
        assert_eq!(value["fingerprint"], value["revisionToken"]);
        assert!(value["checksum"].is_null());

        let with_checksum = dispatch(
            &state,
            &request(
                "fs.fingerprint",
                json!({ "path": "fingerprint.txt", "includeChecksum": true }),
            ),
        )
        .expect("fingerprint dispatched")
        .expect("fingerprint with checksum succeeds");
        assert_eq!(with_checksum["authoritativeForWrite"], true);
        assert_eq!(
            with_checksum["checksum"],
            cbc_fs::hash_bytes(b"fingerprint\n")
        );
    }

    #[test]
    fn fs_edit_repreflights_then_stages_and_commits_through_transaction() {
        let (dir, state) = initialized();
        set_trust(&state, "trusted-always");
        let workspace = dir.path().join("ws");
        let path = workspace.join("edit.txt");
        std::fs::write(&path, "old\n").unwrap();
        let revision = cbc_fs::hash_bytes(b"old\n");
        let workspace_identity = state.workspace_id.lock().expect("workspace id").clone();
        let plan = json!({
            "schemaVersion": "1.0",
            "id": "edp_runtime",
            "source": "user",
            "workspaceIdentityDigest": workspace_identity,
            "sessionId": "test-session",
            "operations": [{
                "kind": "replace_range",
                "operationId": "edo_runtime",
                "path": "edit.txt",
                "baseRevision": revision,
                "range": {
                    "start": { "line": 1, "column": 1 },
                    "end": { "line": 1, "column": 4 },
                    "encoding": "utf16"
                },
                "replacement": "new"
            }],
            "conflictPolicy": "fail",
            "createdAt": "2026-08-24T00:00:00Z"
        });

        let preview = dispatch(&state, &request("fs.edit.preview", json!({ "plan": plan })))
            .expect("edit preview dispatched")
            .expect("edit preview succeeds");
        assert_eq!(preview["status"], "previewed");
        assert_eq!(preview["files"][0]["path"], "edit.txt");
        assert!(preview["files"][0].get("text").is_none());

        let begin = begin_transaction(&state).expect("transaction begins");
        let transaction_id = begin["transactionId"].as_str().expect("transaction id");
        let receipt = begin["capabilityReceipt"]
            .as_str()
            .expect("capability receipt");
        let staged = dispatch(
            &state,
            &request(
                "fs.edit",
                json!({
                    "transactionId": transaction_id,
                    "plan": plan,
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("edit dispatched")
        .expect("edit stages");
        assert_eq!(staged["status"], "previewed");
        assert_eq!(staged["stagedPaths"], json!(["edit.txt"]));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old\n");

        dispatch(
            &state,
            &request(
                "fs.transaction.commit",
                json!({
                    "transactionId": transaction_id,
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("commit dispatched")
        .expect("commit succeeds");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "new\n");
    }

    #[test]
    fn edit_apply_rejects_stale_expected_plan_digest() {
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");
        let path = state
            .require_workspace()
            .unwrap()
            .root()
            .join("edit-stale.txt");
        std::fs::write(&path, "old\n").unwrap();
        let revision = cbc_fs::hash_bytes(b"old\n");
        let workspace_identity = state.workspace_id.lock().expect("workspace id").clone();
        let plan = json!({
            "schemaVersion": "1.0",
            "id": "edp_stale",
            "source": "user",
            "workspaceIdentityDigest": workspace_identity,
            "sessionId": "test-session",
            "operations": [{
                "kind": "replace_range",
                "operationId": "edo_stale",
                "path": "edit-stale.txt",
                "baseRevision": revision,
                "range": {
                    "start": { "line": 1, "column": 1 },
                    "end": { "line": 1, "column": 4 },
                    "encoding": "utf16"
                },
                "replacement": "new"
            }],
            "conflictPolicy": "fail",
            "createdAt": "2026-08-24T00:00:00Z"
        });

        let begin = begin_transaction(&state).expect("transaction begins");
        let transaction_id = begin["transactionId"].as_str().expect("transaction id");
        let receipt = begin["capabilityReceipt"]
            .as_str()
            .expect("capability receipt");
        let error = dispatch(
            &state,
            &request(
                "fs.edit",
                json!({
                    "transactionId": transaction_id,
                    "plan": plan,
                    "expectedPlanDigest": "sha256:not-the-real-digest",
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("edit dispatched")
        .expect_err("stale digest must fail");
        assert_eq!(error.code, error_codes::INVALID_ARGUMENT);
        assert_eq!(
            error.data.as_ref().and_then(|data| data.get("taxonomy")),
            Some(&json!("HASH_MISMATCH"))
        );
        assert_eq!(
            error.data.as_ref().and_then(|data| data.get("editCode")),
            Some(&json!("EDIT_PREVIEW_STALE"))
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "old\n");
    }

    #[test]
    fn worktree_create_refuses_non_git_workspace() {
        let (_dir, state) = initialized();
        set_trust(&state, "trusted-always");
        let data = state.data_dir.lock().expect("data").clone();
        let target = data.join("worktrees/demo/repo");
        let receipt = issue_capability(
            &state,
            "worktree.create",
            None,
            &[],
            None,
            &[&target.to_string_lossy()],
            "deny",
        );
        let error = dispatch(
            &state,
            &request(
                "worktree.create",
                json!({
                    "path": "worktrees/demo/repo",
                    "commit": "HEAD",
                    "requireClean": true,
                    "allowLongPath": true,
                    "capabilityReceipt": receipt,
                    "capabilitySessionId": "test-session",
                    "capabilityActionHash": "test-action",
                }),
            ),
        )
        .expect("worktree.create dispatched")
        .expect_err("non-git must refuse");
        assert_eq!(error.code, error_codes::NOT_FOUND);
    }
}
