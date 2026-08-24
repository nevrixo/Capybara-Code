//! Durable plugin installation, narrowing grant, and scoped state contracts.
//!
//! This module deliberately persists authority declarations only. An executable
//! plugin still needs a sandboxed supervisor and runtime capability checks; no
//! stored grant is itself permission to access the filesystem or a process.

use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::{SessionStore, StoreError};

pub const MAX_PLUGIN_PERMISSION_ENTRIES: usize = 128;
pub const MAX_PLUGIN_STATE_BYTES: usize = 64 * 1024;
pub const MAX_PLUGIN_CIRCUIT_FAILURES: i64 = 100;
pub const MAX_PLUGIN_INVOCATION_EVIDENCE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntimeKind {
    Wasi,
    Stdio,
}

impl PluginRuntimeKind {
    fn label(self) -> &'static str {
        match self {
            Self::Wasi => "wasi",
            Self::Stdio => "stdio",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "wasi" => Ok(Self::Wasi),
            "stdio" => Ok(Self::Stdio),
            _ => Err(invalid(format!("unsupported plugin runtime kind: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallScope {
    Builtin,
    User,
    Project,
}

impl PluginInstallScope {
    fn label(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::User => "user",
            Self::Project => "project",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "builtin" => Ok(Self::Builtin),
            "user" => Ok(Self::User),
            "project" => Ok(Self::Project),
            _ => Err(invalid(format!(
                "unsupported plugin installation scope: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstanceState {
    Starting,
    Ready,
    Degraded,
    Stopped,
}

impl PluginInstanceState {
    fn label(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Stopped => "stopped",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "starting" => Ok(Self::Starting),
            "ready" => Ok(Self::Ready),
            "degraded" => Ok(Self::Degraded),
            "stopped" => Ok(Self::Stopped),
            _ => Err(invalid(format!("unsupported plugin instance state: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginCircuitState {
    Closed,
    Open,
    HalfOpen,
}

impl PluginCircuitState {
    fn label(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
            Self::HalfOpen => "half_open",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "closed" => Ok(Self::Closed),
            "open" => Ok(Self::Open),
            "half_open" => Ok(Self::HalfOpen),
            _ => Err(invalid(format!("unsupported plugin circuit state: {raw}"))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPermissionSet {
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub workspace_read: Vec<String>,
    #[serde(default)]
    pub workspace_write: Vec<String>,
    #[serde(default)]
    pub network_domains: Vec<String>,
    #[serde(default)]
    pub credentials: Vec<String>,
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub session_state: Vec<String>,
    #[serde(default)]
    pub memory: Vec<String>,
    #[serde(default)]
    pub graph: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInstallationInput {
    pub id: String,
    pub plugin_id: String,
    pub version: String,
    pub source: String,
    pub package_digest: String,
    pub manifest_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<serde_json::Value>,
    pub runtime_kind: PluginRuntimeKind,
    pub scope: PluginInstallScope,
    pub requested_permissions: PluginPermissionSet,
    pub manifest: serde_json::Value,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallationRecord {
    pub id: String,
    pub plugin_id: String,
    pub version: String,
    pub source: String,
    pub package_digest: String,
    pub manifest_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<serde_json::Value>,
    pub runtime_kind: PluginRuntimeKind,
    pub scope: PluginInstallScope,
    pub requested_permissions: PluginPermissionSet,
    pub manifest: serde_json::Value,
    pub enabled: bool,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginGrantInput {
    pub id: String,
    pub installation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity_digest: Option<String>,
    pub permissions: PluginPermissionSet,
    pub granted_by: String,
    pub granted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginGrantRecord {
    pub id: String,
    pub installation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity_digest: Option<String>,
    pub permissions: PluginPermissionSet,
    pub granted_at: String,
    pub granted_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInstanceStart {
    pub id: String,
    pub installation_id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInstanceTransition {
    pub expected_state: PluginInstanceState,
    pub state: PluginInstanceState,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCircuitTransition {
    pub expected_generation: i64,
    pub state: PluginCircuitState,
    pub failure_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstanceRecord {
    pub id: String,
    pub installation_id: String,
    pub workspace_identity_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub state: PluginInstanceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
    pub failure_count: i64,
    pub circuit_state: PluginCircuitState,
    pub circuit_generation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_opened_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_retry_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginInvocationState {
    Running,
    Succeeded,
    Denied,
    Failed,
    TimedOut,
    Cancelled,
}

impl PluginInvocationState {
    fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Denied => "denied",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        match raw {
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "denied" => Ok(Self::Denied),
            "failed" => Ok(Self::Failed),
            "timed_out" => Ok(Self::TimedOut),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(invalid(format!(
                "unsupported plugin invocation state: {raw}"
            ))),
        }
    }

    fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInvocationStart {
    pub id: String,
    pub instance_id: String,
    pub hook_or_method: String,
    pub correlation_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInvocationFinish {
    pub state: PluginInvocationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInvocationRecord {
    pub id: String,
    pub instance_id: String,
    pub hook_or_method: String,
    pub correlation_id: String,
    pub state: PluginInvocationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginStateScope {
    Global,
    Workspace,
    Session,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginStateWrite {
    pub installation_id: String,
    pub scope: PluginStateScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub key: String,
    pub value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateRecord {
    pub installation_id: String,
    pub scope: PluginStateScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub key: String,
    pub value: serde_json::Value,
    pub revision: i64,
    pub updated_at: String,
}

impl SessionStore {
    /// Install a verified declaration in disabled state. A grant and a sandbox
    /// supervisor are still needed before any plugin can execute.
    pub fn install_plugin(
        &mut self,
        input: &PluginInstallationInput,
    ) -> Result<PluginInstallationRecord, StoreError> {
        validate_installation(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = plugin_installation_in_tx(&tx, &input.id)? {
            ensure_install_replay(&existing, input)?;
            tx.commit()?;
            return Ok(existing);
        }
        tx.execute(
            "INSERT INTO plugin_installations (
                id, plugin_id, version, source, package_digest, manifest_digest,
                signature_json, runtime_kind, enabled, installed_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
            params![
                &input.id,
                &input.plugin_id,
                &input.version,
                &input.source,
                &input.package_digest,
                &input.manifest_digest,
                input
                    .signature
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                input.runtime_kind.label(),
                &input.installed_at,
            ],
        )?;
        tx.execute(
            "INSERT INTO plugin_installation_metadata (
                installation_id, scope, requested_permissions_json, manifest_json
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                &input.id,
                input.scope.label(),
                serde_json::to_string(&input.requested_permissions)?,
                serde_json::to_string(&input.manifest)?,
            ],
        )?;
        let record = installation_record_from_input(input);
        tx.commit()?;
        Ok(record)
    }

    pub fn plugin_installation(
        &self,
        installation_id: &str,
    ) -> Result<Option<PluginInstallationRecord>, StoreError> {
        validate_prefixed_id("installationId", installation_id, "plg_")?;
        self.conn
            .query_row(
                installation_select_sql(),
                params![installation_id],
                read_installation,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Enabling a declaration does not grant it workspace authority. Starting an
    /// instance still requires an active, narrowed grant for that workspace.
    pub fn set_plugin_enabled(
        &mut self,
        installation_id: &str,
        enabled: bool,
        at: &str,
    ) -> Result<PluginInstallationRecord, StoreError> {
        validate_prefixed_id("installationId", installation_id, "plg_")?;
        validate_timestamp("at", at)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut installation = require_plugin_installation(&tx, installation_id)?;
        if installation.enabled != enabled {
            tx.execute(
                "UPDATE plugin_installations
                 SET enabled = ?2, updated_at = ?3
                 WHERE id = ?1",
                params![installation_id, i64::from(enabled), at],
            )?;
            installation.enabled = enabled;
            installation.updated_at = at.into();
        }
        tx.commit()?;
        Ok(installation)
    }

    /// Persist only a grant which is a component-wise subset of the installation's
    /// declared request. No caller can widen declared plugin authority here.
    pub fn grant_plugin(
        &mut self,
        input: &PluginGrantInput,
    ) -> Result<PluginGrantRecord, StoreError> {
        validate_grant(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let installation = require_plugin_installation(&tx, &input.installation_id)?;
        if installation.scope == PluginInstallScope::Project
            && input.workspace_identity_digest.is_none()
        {
            return Err(invalid(
                "project plugin grants require a workspace identity",
            ));
        }
        if let Some(workspace) = &input.workspace_identity_digest {
            ensure_workspace_exists(&tx, workspace)?;
        }
        if !permissions_are_subset(&input.permissions, &installation.requested_permissions) {
            return Err(invalid(
                "plugin grant would widen the verified manifest permission request",
            ));
        }
        if let Some(existing) = plugin_grant_in_tx(&tx, &input.id)? {
            ensure_grant_replay(&existing, input)?;
            tx.commit()?;
            return Ok(existing);
        }
        tx.execute(
            "INSERT INTO plugin_grants (
                id, installation_id, workspace_identity_digest, grant_json,
                granted_at, granted_by, revoked_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            params![
                &input.id,
                &input.installation_id,
                &input.workspace_identity_digest,
                serde_json::to_string(&input.permissions)?,
                &input.granted_at,
                &input.granted_by,
            ],
        )?;
        let record = PluginGrantRecord {
            id: input.id.clone(),
            installation_id: input.installation_id.clone(),
            workspace_identity_digest: input.workspace_identity_digest.clone(),
            permissions: input.permissions.clone(),
            granted_at: input.granted_at.clone(),
            granted_by: input.granted_by.clone(),
            revoked_at: None,
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn revoke_plugin_grant(
        &mut self,
        grant_id: &str,
        at: &str,
    ) -> Result<PluginGrantRecord, StoreError> {
        validate_prefixed_id("grantId", grant_id, "pgr_")?;
        validate_timestamp("at", at)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut grant = require_plugin_grant(&tx, grant_id)?;
        if grant.revoked_at.is_none() {
            tx.execute(
                "UPDATE plugin_grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                params![grant_id, at],
            )?;
            grant.revoked_at = Some(at.into());
        }
        tx.commit()?;
        Ok(grant)
    }

    /// Register a workspace-bound plugin process before a supervisor invokes it.
    /// The record is only lifecycle evidence; it grants no runtime authority.
    pub fn start_plugin_instance(
        &mut self,
        input: &PluginInstanceStart,
    ) -> Result<PluginInstanceRecord, StoreError> {
        validate_instance_start(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let installation = require_plugin_installation(&tx, &input.installation_id)?;
        if !installation.enabled {
            return Err(invalid(
                "plugin installation must be enabled before an instance starts",
            ));
        }
        ensure_workspace_exists(&tx, &input.workspace_identity_digest)?;
        ensure_active_plugin_grant(
            &tx,
            &input.installation_id,
            &input.workspace_identity_digest,
        )?;
        ensure_instance_scope_binding(&tx, input)?;
        if let Some(existing) = plugin_instance_in_tx(&tx, &input.id)? {
            ensure_instance_start_replay(&existing, input)?;
            tx.commit()?;
            return Ok(existing);
        }
        tx.execute(
            "INSERT INTO plugin_instances (
                id, installation_id, workspace_identity_digest, worktree_id,
                session_id, state, pid, started_at, heartbeat_at, stopped_at,
                failure_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL, 0)",
            params![
                &input.id,
                &input.installation_id,
                &input.workspace_identity_digest,
                &input.worktree_id,
                &input.session_id,
                PluginInstanceState::Starting.label(),
                input.pid,
                &input.started_at,
            ],
        )?;
        let record = PluginInstanceRecord {
            id: input.id.clone(),
            installation_id: input.installation_id.clone(),
            workspace_identity_digest: input.workspace_identity_digest.clone(),
            worktree_id: input.worktree_id.clone(),
            session_id: input.session_id.clone(),
            state: PluginInstanceState::Starting,
            pid: input.pid,
            started_at: Some(input.started_at.clone()),
            heartbeat_at: Some(input.started_at.clone()),
            stopped_at: None,
            failure_count: 0,
            circuit_state: PluginCircuitState::Closed,
            circuit_generation: 0,
            last_failure_at: None,
            circuit_opened_at: None,
            circuit_retry_at: None,
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn plugin_instance(
        &self,
        instance_id: &str,
    ) -> Result<Option<PluginInstanceRecord>, StoreError> {
        validate_prefixed_id("instanceId", instance_id, "pni_")?;
        self.conn
            .query_row(
                plugin_instance_select_sql(),
                params![instance_id],
                read_plugin_instance,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Append a durable invocation start before sending work to a plugin host.
    /// Replays with the same invocation identity are safe and return the record.
    pub fn start_plugin_invocation(
        &mut self,
        input: &PluginInvocationStart,
    ) -> Result<PluginInvocationRecord, StoreError> {
        validate_invocation_start(input)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let instance = require_plugin_instance(&tx, &input.instance_id)?;
        if instance.state == PluginInstanceState::Stopped {
            return Err(invalid(
                "stopped plugin instances cannot start new invocations",
            ));
        }
        if let Some(existing) = plugin_invocation_in_tx(&tx, &input.id)? {
            ensure_invocation_start_replay(&existing, input)?;
            tx.commit()?;
            return Ok(existing);
        }
        tx.execute(
            "INSERT INTO plugin_invocations (
                id, instance_id, hook_or_method, correlation_id, state,
                decision_json, error_json, started_at, finished_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, NULL)",
            params![
                &input.id,
                &input.instance_id,
                &input.hook_or_method,
                &input.correlation_id,
                PluginInvocationState::Running.label(),
                &input.started_at,
            ],
        )?;
        let record = PluginInvocationRecord {
            id: input.id.clone(),
            instance_id: input.instance_id.clone(),
            hook_or_method: input.hook_or_method.clone(),
            correlation_id: input.correlation_id.clone(),
            state: PluginInvocationState::Running,
            decision: None,
            error: None,
            started_at: input.started_at.clone(),
            finished_at: None,
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn plugin_invocation(
        &self,
        invocation_id: &str,
    ) -> Result<Option<PluginInvocationRecord>, StoreError> {
        validate_prefixed_id("invocationId", invocation_id, "inv_")?;
        self.conn
            .query_row(
                plugin_invocation_select_sql(),
                params![invocation_id],
                read_plugin_invocation,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Finish a running invocation once. A later, non-identical completion is
    /// rejected so stale plugin host responses cannot overwrite evidence.
    pub fn finish_plugin_invocation(
        &mut self,
        invocation_id: &str,
        finish: &PluginInvocationFinish,
    ) -> Result<PluginInvocationRecord, StoreError> {
        validate_prefixed_id("invocationId", invocation_id, "inv_")?;
        validate_invocation_finish(finish)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut invocation = require_plugin_invocation(&tx, invocation_id)?;
        if finish.finished_at < invocation.started_at {
            return Err(invalid(
                "plugin invocation finishedAt cannot precede startedAt",
            ));
        }
        if invocation.state.is_terminal() {
            ensure_invocation_finish_replay(&invocation, finish)?;
            tx.commit()?;
            return Ok(invocation);
        }

        let decision_json = finish
            .decision
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let error_json = finish
            .error
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let updated = tx.execute(
            "UPDATE plugin_invocations
             SET state = ?2,
                 decision_json = ?3,
                 error_json = ?4,
                 finished_at = ?5
             WHERE id = ?1
               AND state = 'running'",
            params![
                invocation_id,
                finish.state.label(),
                decision_json,
                error_json,
                &finish.finished_at,
            ],
        )?;
        if updated != 1 {
            return Err(invalid(
                "plugin invocation changed before its completion was persisted",
            ));
        }
        invocation.state = finish.state;
        invocation.decision = finish.decision.clone();
        invocation.error = finish.error.clone();
        invocation.finished_at = Some(finish.finished_at.clone());
        tx.commit()?;
        Ok(invocation)
    }

    pub fn heartbeat_plugin_instance(
        &mut self,
        instance_id: &str,
        at: &str,
    ) -> Result<PluginInstanceRecord, StoreError> {
        validate_prefixed_id("instanceId", instance_id, "pni_")?;
        validate_timestamp("at", at)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut instance = require_plugin_instance(&tx, instance_id)?;
        if instance.state == PluginInstanceState::Stopped {
            return Err(invalid(
                "stopped plugin instances cannot receive heartbeats",
            ));
        }
        tx.execute(
            "UPDATE plugin_instances SET heartbeat_at = ?2 WHERE id = ?1",
            params![instance_id, at],
        )?;
        instance.heartbeat_at = Some(at.into());
        tx.commit()?;
        Ok(instance)
    }

    pub fn transition_plugin_instance(
        &mut self,
        instance_id: &str,
        transition: &PluginInstanceTransition,
    ) -> Result<PluginInstanceRecord, StoreError> {
        validate_prefixed_id("instanceId", instance_id, "pni_")?;
        validate_instance_transition(transition)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut instance = require_plugin_instance(&tx, instance_id)?;
        if instance.state != transition.expected_state {
            return Err(invalid(
                "plugin instance state does not match expected state",
            ));
        }
        if transition.state == PluginInstanceState::Ready
            && instance.circuit_state != PluginCircuitState::Closed
        {
            return Err(invalid(
                "a plugin instance with an open circuit cannot become ready",
            ));
        }
        if instance.state == transition.state {
            tx.commit()?;
            return Ok(instance);
        }
        if !instance_transition_allowed(instance.state, transition.state) {
            return Err(invalid("plugin instance transition is not allowed"));
        }
        tx.execute(
            "UPDATE plugin_instances
             SET state = ?2,
                 heartbeat_at = ?3,
                 stopped_at = CASE WHEN ?2 = 'stopped' THEN ?3 ELSE stopped_at END
             WHERE id = ?1",
            params![instance_id, transition.state.label(), &transition.at],
        )?;
        instance.state = transition.state;
        instance.heartbeat_at = Some(transition.at.clone());
        if transition.state == PluginInstanceState::Stopped {
            instance.stopped_at = Some(transition.at.clone());
        }
        tx.commit()?;
        Ok(instance)
    }

    /// Persist a supervisor-owned circuit transition. The expected generation
    /// fences completions from invocations admitted before a later circuit open.
    pub fn transition_plugin_circuit(
        &mut self,
        instance_id: &str,
        transition: &PluginCircuitTransition,
    ) -> Result<PluginInstanceRecord, StoreError> {
        validate_prefixed_id("instanceId", instance_id, "pni_")?;
        validate_circuit_transition(transition)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut instance = require_plugin_instance(&tx, instance_id)?;
        if instance.state == PluginInstanceState::Stopped {
            return Err(invalid(
                "stopped plugin instances cannot receive circuit transitions",
            ));
        }
        if instance.circuit_generation != transition.expected_generation {
            return Err(invalid(
                "plugin circuit generation does not match expected generation",
            ));
        }
        if !circuit_transition_allowed(instance.circuit_state, transition.state) {
            return Err(invalid("plugin circuit transition is not allowed"));
        }
        validate_circuit_transition_against_instance(&instance, transition)?;

        let circuit_generation = if transition.state == PluginCircuitState::Open {
            instance
                .circuit_generation
                .checked_add(1)
                .ok_or_else(|| invalid("plugin circuit generation overflow"))?
        } else {
            instance.circuit_generation
        };
        let state = match transition.state {
            PluginCircuitState::Open | PluginCircuitState::HalfOpen => {
                PluginInstanceState::Degraded
            }
            PluginCircuitState::Closed
                if instance.circuit_state == PluginCircuitState::HalfOpen =>
            {
                PluginInstanceState::Ready
            }
            PluginCircuitState::Closed => instance.state,
        };
        let updated = tx.execute(
            "UPDATE plugin_instances
             SET state = ?2,
                 circuit_state = ?3,
                 circuit_generation = ?4,
                 failure_count = ?5,
                 last_failure_at = ?6,
                 circuit_opened_at = ?7,
                 circuit_retry_at = ?8,
                 heartbeat_at = ?9
             WHERE id = ?1
               AND circuit_generation = ?10",
            params![
                instance_id,
                state.label(),
                transition.state.label(),
                circuit_generation,
                transition.failure_count,
                &transition.last_failure_at,
                &transition.opened_at,
                &transition.retry_at,
                &transition.at,
                transition.expected_generation,
            ],
        )?;
        if updated != 1 {
            return Err(invalid(
                "plugin circuit generation changed before the transition was persisted",
            ));
        }
        instance.state = state;
        instance.circuit_state = transition.state;
        instance.circuit_generation = circuit_generation;
        instance.failure_count = transition.failure_count;
        instance.last_failure_at = transition.last_failure_at.clone();
        instance.circuit_opened_at = transition.opened_at.clone();
        instance.circuit_retry_at = transition.retry_at.clone();
        instance.heartbeat_at = Some(transition.at.clone());
        tx.commit()?;
        Ok(instance)
    }

    pub fn put_plugin_state(
        &mut self,
        write: &PluginStateWrite,
    ) -> Result<PluginStateRecord, StoreError> {
        validate_state_write(write)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_plugin_installation(&tx, &write.installation_id)?;
        ensure_state_scope_binding(&tx, write)?;
        let existing = plugin_state_in_tx(&tx, write)?;
        let revision = match (existing.as_ref(), write.expected_revision) {
            (None, None) => 1,
            (None, Some(expected)) => {
                return Err(StoreError::PluginStateRevisionConflict {
                    installation_id: write.installation_id.clone(),
                    key: write.key.clone(),
                    expected,
                    actual: None,
                })
            }
            (Some(record), Some(expected)) if record.revision == expected => record
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("plugin state revision overflow"))?,
            (Some(record), expected) => {
                return Err(StoreError::PluginStateRevisionConflict {
                    installation_id: write.installation_id.clone(),
                    key: write.key.clone(),
                    expected: expected.unwrap_or(0),
                    actual: Some(record.revision),
                })
            }
        };
        if existing.is_some() {
            tx.execute(
                "UPDATE plugin_state SET value_json = ?5, revision = ?6, updated_at = ?7
                 WHERE installation_id = ?1
                   AND workspace_identity_digest IS ?2
                   AND session_id IS ?3
                   AND key = ?4",
                params![
                    &write.installation_id,
                    &write.workspace_identity_digest,
                    &write.session_id,
                    &write.key,
                    serde_json::to_string(&write.value)?,
                    revision,
                    &write.at,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO plugin_state (
                    installation_id, workspace_identity_digest, session_id,
                    key, value_json, revision, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &write.installation_id,
                    &write.workspace_identity_digest,
                    &write.session_id,
                    &write.key,
                    serde_json::to_string(&write.value)?,
                    revision,
                    &write.at,
                ],
            )?;
        }
        let record = PluginStateRecord {
            installation_id: write.installation_id.clone(),
            scope: write.scope,
            workspace_identity_digest: write.workspace_identity_digest.clone(),
            session_id: write.session_id.clone(),
            key: write.key.clone(),
            value: write.value.clone(),
            revision,
            updated_at: write.at.clone(),
        };
        tx.commit()?;
        Ok(record)
    }

    pub fn plugin_state(
        &self,
        installation_id: &str,
        scope: PluginStateScope,
        workspace_identity_digest: Option<&str>,
        session_id: Option<&str>,
        key: &str,
    ) -> Result<Option<PluginStateRecord>, StoreError> {
        validate_state_locator(
            installation_id,
            scope,
            workspace_identity_digest,
            session_id,
            key,
        )?;
        self.conn
            .query_row(
                "SELECT installation_id, workspace_identity_digest, session_id, key,
                        value_json, revision, updated_at
                 FROM plugin_state
                 WHERE installation_id = ?1
                   AND workspace_identity_digest IS ?2
                   AND session_id IS ?3
                   AND key = ?4",
                params![installation_id, workspace_identity_digest, session_id, key],
                |row| read_state_row(row, scope),
            )
            .optional()
            .map_err(StoreError::from)
    }
}

fn invalid(detail: impl Into<String>) -> StoreError {
    StoreError::InvalidPlugin {
        detail: detail.into(),
    }
}

fn validate_installation(input: &PluginInstallationInput) -> Result<(), StoreError> {
    validate_prefixed_id("installationId", &input.id, "plg_")?;
    validate_plugin_id(&input.plugin_id)?;
    validate_text("version", &input.version, 128)?;
    validate_text("source", &input.source, 512)?;
    validate_digest("packageDigest", &input.package_digest)?;
    validate_digest("manifestDigest", &input.manifest_digest)?;
    validate_timestamp("installedAt", &input.installed_at)?;
    if input.scope == PluginInstallScope::Project && input.runtime_kind == PluginRuntimeKind::Stdio
    {
        return Err(invalid(
            "project plugins cannot select stdio runtime; only isolated WASI is allowed",
        ));
    }
    validate_permissions(&input.requested_permissions)?;
    validate_json("manifest", &input.manifest, MAX_PLUGIN_STATE_BYTES)?;
    if let Some(signature) = &input.signature {
        validate_json("signature", signature, 16 * 1024)?;
    }
    Ok(())
}

fn validate_grant(input: &PluginGrantInput) -> Result<(), StoreError> {
    validate_prefixed_id("grantId", &input.id, "pgr_")?;
    validate_prefixed_id("installationId", &input.installation_id, "plg_")?;
    if let Some(workspace) = &input.workspace_identity_digest {
        validate_text("workspaceIdentityDigest", workspace, 256)?;
        if workspace.contains('/') || workspace.contains('\\') || workspace.contains(':') {
            return Err(invalid(
                "workspaceIdentityDigest cannot contain path separators",
            ));
        }
    }
    validate_permissions(&input.permissions)?;
    validate_text("grantedBy", &input.granted_by, 256)?;
    validate_timestamp("grantedAt", &input.granted_at)
}

fn validate_permissions(permissions: &PluginPermissionSet) -> Result<(), StoreError> {
    for (field, values) in permission_fields(permissions) {
        if values.len() > MAX_PLUGIN_PERMISSION_ENTRIES {
            return Err(invalid(format!(
                "{field} exceeds {MAX_PLUGIN_PERMISSION_ENTRIES} permission entries"
            )));
        }
        let mut unique = BTreeSet::new();
        for value in values {
            validate_text(field, value, 512)?;
            if !unique.insert(value.as_str()) {
                return Err(invalid(format!(
                    "{field} contains duplicate permission entries"
                )));
            }
        }
    }
    Ok(())
}

fn permission_fields(permissions: &PluginPermissionSet) -> [(&'static str, &Vec<String>); 10] {
    [
        ("events", &permissions.events),
        ("tools", &permissions.tools),
        ("workspaceRead", &permissions.workspace_read),
        ("workspaceWrite", &permissions.workspace_write),
        ("networkDomains", &permissions.network_domains),
        ("credentials", &permissions.credentials),
        ("artifacts", &permissions.artifacts),
        ("sessionState", &permissions.session_state),
        ("memory", &permissions.memory),
        ("graph", &permissions.graph),
    ]
}

fn permissions_are_subset(grant: &PluginPermissionSet, request: &PluginPermissionSet) -> bool {
    permission_fields(grant)
        .iter()
        .zip(permission_fields(request))
        .all(|((_, granted), (_, requested))| {
            granted
                .iter()
                .all(|value| requested.iter().any(|candidate| candidate == value))
        })
}

fn validate_instance_start(input: &PluginInstanceStart) -> Result<(), StoreError> {
    validate_prefixed_id("instanceId", &input.id, "pni_")?;
    validate_prefixed_id("installationId", &input.installation_id, "plg_")?;
    validate_workspace_identity_digest(&input.workspace_identity_digest)?;
    if let Some(worktree_id) = &input.worktree_id {
        validate_prefixed_id("worktreeId", worktree_id, "wt_")?;
    }
    if let Some(session_id) = &input.session_id {
        validate_text("sessionId", session_id, 256)?;
    }
    if let Some(pid) = input.pid {
        if !(1..=i64::from(i32::MAX)).contains(&pid) {
            return Err(invalid(
                "plugin process ID must be a positive 32-bit integer",
            ));
        }
    }
    validate_timestamp("startedAt", &input.started_at)
}

fn validate_invocation_start(input: &PluginInvocationStart) -> Result<(), StoreError> {
    validate_prefixed_id("invocationId", &input.id, "inv_")?;
    validate_prefixed_id("instanceId", &input.instance_id, "pni_")?;
    validate_hook_or_method(&input.hook_or_method)?;
    validate_text("correlationId", &input.correlation_id, 256)?;
    validate_timestamp("startedAt", &input.started_at)
}

fn validate_invocation_finish(finish: &PluginInvocationFinish) -> Result<(), StoreError> {
    if !finish.state.is_terminal() {
        return Err(invalid(
            "a plugin invocation completion must use a terminal state",
        ));
    }
    validate_timestamp("finishedAt", &finish.finished_at)?;
    validate_invocation_evidence("decision", finish.decision.as_ref())?;
    validate_invocation_evidence("error", finish.error.as_ref())?;

    match finish.state {
        PluginInvocationState::Succeeded => {
            if finish.error.is_some() {
                return Err(invalid(
                    "a successful plugin invocation cannot retain an error",
                ));
            }
        }
        PluginInvocationState::Denied => {
            if finish.decision.is_none() || finish.error.is_some() {
                return Err(invalid(
                    "a denied plugin invocation requires a decision and no error",
                ));
            }
        }
        PluginInvocationState::Failed
        | PluginInvocationState::TimedOut
        | PluginInvocationState::Cancelled => {
            if finish.decision.is_some() || finish.error.is_none() {
                return Err(invalid(
                    "a failed plugin invocation requires an error and no decision",
                ));
            }
        }
        PluginInvocationState::Running => unreachable!("terminal state was validated"),
    }

    Ok(())
}

fn validate_invocation_evidence(
    field: &str,
    value: Option<&serde_json::Value>,
) -> Result<(), StoreError> {
    let Some(value) = value else {
        return Ok(());
    };
    if !value.is_object() {
        return Err(invalid(format!(
            "plugin invocation {field} must be a structured object"
        )));
    }
    validate_json(field, value, MAX_PLUGIN_INVOCATION_EVIDENCE_BYTES)
}

fn validate_hook_or_method(value: &str) -> Result<(), StoreError> {
    validate_text("hookOrMethod", value, 256)?;
    if !value.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    }) {
        return Err(invalid(
            "hookOrMethod must use lowercase dotted protocol identifier characters",
        ));
    }
    Ok(())
}

fn validate_instance_transition(transition: &PluginInstanceTransition) -> Result<(), StoreError> {
    validate_timestamp("at", &transition.at)
}

fn validate_circuit_transition(transition: &PluginCircuitTransition) -> Result<(), StoreError> {
    if transition.expected_generation < 0 {
        return Err(invalid(
            "plugin circuit expectedGeneration must be non-negative",
        ));
    }
    if !(0..=MAX_PLUGIN_CIRCUIT_FAILURES).contains(&transition.failure_count) {
        return Err(invalid(format!(
            "plugin circuit failureCount must be between zero and {MAX_PLUGIN_CIRCUIT_FAILURES}"
        )));
    }
    validate_timestamp("at", &transition.at)?;

    match transition.state {
        PluginCircuitState::Closed => {
            if transition.last_failure_at.is_some()
                || transition.opened_at.is_some()
                || transition.retry_at.is_some()
            {
                return Err(invalid(
                    "a closed plugin circuit cannot retain failure timestamps",
                ));
            }
        }
        PluginCircuitState::Open | PluginCircuitState::HalfOpen => {
            if transition.failure_count == 0 {
                return Err(invalid(
                    "an open plugin circuit must retain at least one failure",
                ));
            }
            let (Some(last_failure_at), Some(opened_at), Some(retry_at)) = (
                transition.last_failure_at.as_deref(),
                transition.opened_at.as_deref(),
                transition.retry_at.as_deref(),
            ) else {
                return Err(invalid(
                    "an open plugin circuit requires failure, opened, and retry timestamps",
                ));
            };
            validate_timestamp("lastFailureAt", last_failure_at)?;
            validate_timestamp("openedAt", opened_at)?;
            validate_timestamp("retryAt", retry_at)?;
            if last_failure_at > opened_at
                || opened_at > retry_at
                || last_failure_at > transition.at.as_str()
                || opened_at > transition.at.as_str()
                || (transition.state == PluginCircuitState::HalfOpen
                    && retry_at > transition.at.as_str())
            {
                return Err(invalid(
                    "plugin circuit timestamps are not in canonical transition order",
                ));
            }
        }
    }

    Ok(())
}

fn validate_circuit_transition_against_instance(
    instance: &PluginInstanceRecord,
    transition: &PluginCircuitTransition,
) -> Result<(), StoreError> {
    match (instance.circuit_state, transition.state) {
        (PluginCircuitState::Closed, PluginCircuitState::Closed) => {}
        (PluginCircuitState::Closed, PluginCircuitState::Open) => {
            if transition.failure_count <= instance.failure_count {
                return Err(invalid(
                    "opening a plugin circuit must increase its failure count",
                ));
            }
        }
        (PluginCircuitState::Open, PluginCircuitState::HalfOpen) => {
            if transition.failure_count != instance.failure_count
                || transition.last_failure_at != instance.last_failure_at
                || transition.opened_at != instance.circuit_opened_at
                || transition.retry_at != instance.circuit_retry_at
            {
                return Err(invalid(
                    "a half-open plugin circuit must preserve its open circuit evidence",
                ));
            }
        }
        (PluginCircuitState::HalfOpen, PluginCircuitState::Closed) => {
            if transition.failure_count != 0 {
                return Err(invalid(
                    "closing a recovered plugin circuit must reset its failure count",
                ));
            }
        }
        (PluginCircuitState::HalfOpen, PluginCircuitState::Open) => {
            if transition.failure_count <= instance.failure_count {
                return Err(invalid(
                    "re-opening a plugin circuit must increase its failure count",
                ));
            }
            let previous_last_failure_at =
                instance.last_failure_at.as_deref().ok_or_else(|| {
                    invalid("a half-open plugin circuit is missing its last failure timestamp")
                })?;
            let previous_opened_at = instance.circuit_opened_at.as_deref().ok_or_else(|| {
                invalid("a half-open plugin circuit is missing its opened timestamp")
            })?;
            let next_last_failure_at = transition.last_failure_at.as_deref().ok_or_else(|| {
                invalid("an open plugin circuit requires a last failure timestamp")
            })?;
            let next_opened_at = transition
                .opened_at
                .as_deref()
                .ok_or_else(|| invalid("an open plugin circuit requires an opened timestamp"))?;
            if next_last_failure_at < previous_last_failure_at
                || next_opened_at < previous_opened_at
            {
                return Err(invalid(
                    "a re-opened plugin circuit cannot move its evidence backwards",
                ));
            }
        }
        _ => return Err(invalid("plugin circuit transition is not allowed")),
    }
    Ok(())
}

fn circuit_transition_allowed(from: PluginCircuitState, to: PluginCircuitState) -> bool {
    matches!(
        (from, to),
        (PluginCircuitState::Closed, PluginCircuitState::Closed)
            | (PluginCircuitState::Closed, PluginCircuitState::Open)
            | (PluginCircuitState::Open, PluginCircuitState::HalfOpen)
            | (PluginCircuitState::HalfOpen, PluginCircuitState::Closed)
            | (PluginCircuitState::HalfOpen, PluginCircuitState::Open)
    )
}

fn instance_transition_allowed(from: PluginInstanceState, to: PluginInstanceState) -> bool {
    matches!(
        (from, to),
        (PluginInstanceState::Starting, PluginInstanceState::Ready)
            | (PluginInstanceState::Starting, PluginInstanceState::Degraded)
            | (PluginInstanceState::Starting, PluginInstanceState::Stopped)
            | (PluginInstanceState::Ready, PluginInstanceState::Degraded)
            | (PluginInstanceState::Ready, PluginInstanceState::Stopped)
            | (PluginInstanceState::Degraded, PluginInstanceState::Ready)
            | (PluginInstanceState::Degraded, PluginInstanceState::Stopped)
    )
}

fn validate_state_write(write: &PluginStateWrite) -> Result<(), StoreError> {
    validate_state_locator(
        &write.installation_id,
        write.scope,
        write.workspace_identity_digest.as_deref(),
        write.session_id.as_deref(),
        &write.key,
    )?;
    if let Some(expected) = write.expected_revision {
        if expected < 1 {
            return Err(invalid("expectedRevision must be positive when provided"));
        }
    }
    validate_timestamp("at", &write.at)?;
    validate_json("pluginStateValue", &write.value, MAX_PLUGIN_STATE_BYTES)
}

fn validate_state_locator(
    installation_id: &str,
    scope: PluginStateScope,
    workspace_identity_digest: Option<&str>,
    session_id: Option<&str>,
    key: &str,
) -> Result<(), StoreError> {
    validate_prefixed_id("installationId", installation_id, "plg_")?;
    validate_text("key", key, 256)?;
    if let Some(workspace_identity_digest) = workspace_identity_digest {
        validate_workspace_identity_digest(workspace_identity_digest)?;
    }
    if let Some(session_id) = session_id {
        validate_text("sessionId", session_id, 256)?;
    }
    match scope {
        PluginStateScope::Global if workspace_identity_digest.is_none() && session_id.is_none() => {
            Ok(())
        }
        PluginStateScope::Workspace
            if workspace_identity_digest.is_some() && session_id.is_none() =>
        {
            Ok(())
        }
        PluginStateScope::Session
            if workspace_identity_digest.is_some() && session_id.is_some() =>
        {
            Ok(())
        }
        _ => Err(invalid(
            "plugin state scope does not match workspace/session binding",
        )),
    }
}

fn validate_prefixed_id(field: &str, value: &str, prefix: &str) -> Result<(), StoreError> {
    let suffix = value.strip_prefix(prefix);
    if suffix.is_none()
        || value.len() <= prefix.len()
        || value.len() > 256
        || value.trim() != value
        || !suffix.is_some_and(|suffix| {
            suffix.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            })
        })
    {
        return Err(invalid(format!(
            "{field} must be a bounded identifier beginning with {prefix}"
        )));
    }
    Ok(())
}

fn validate_plugin_id(value: &str) -> Result<(), StoreError> {
    if value.len() < 3
        || value.len() > 256
        || value.trim() != value
        || value.chars().any(|character| {
            !(character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '/' | '-' | '_' | '.'))
        })
        || !value.contains('/')
        || value.contains("//")
        || value.starts_with('/')
        || value.ends_with('/')
    {
        return Err(invalid(
            "pluginId must be a canonical publisher/name identifier",
        ));
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<(), StoreError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("{field} must be bounded non-secret text")));
    }
    if cbc_redaction::redact_patterns_only(value).report.redacted() {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

fn validate_workspace_identity_digest(value: &str) -> Result<(), StoreError> {
    validate_text("workspaceIdentityDigest", value, 256)?;
    if value.contains('/') || value.contains('\\') || value.contains(':') {
        return Err(invalid(
            "workspaceIdentityDigest cannot contain path separators",
        ));
    }
    Ok(())
}

fn validate_digest(field: &str, value: &str) -> Result<(), StoreError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(invalid(format!("{field} must use sha256:<hex> format")));
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(format!("{field} must use sha256:<hex> format")));
    }
    Ok(())
}

fn validate_json(field: &str, value: &serde_json::Value, limit: usize) -> Result<(), StoreError> {
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > limit {
        return Err(invalid(format!("{field} exceeds its durable size limit")));
    }
    if cbc_redaction::redact_patterns_only(&encoded)
        .report
        .redacted()
    {
        return Err(StoreError::CredentialRejected {
            field: field.into(),
        });
    }
    Ok(())
}

/// SQLite compares these timestamps lexically, so accept exactly one UTC form.
fn validate_timestamp(field: &str, value: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds"
        )));
    }
    let separators = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ];
    if separators
        .iter()
        .any(|(index, expected)| bytes[*index] != *expected)
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return Err(invalid(format!(
            "{field} must be a canonical RFC 3339 UTC timestamp with milliseconds"
        )));
    }

    let year = decimal_component(bytes, 0, 4);
    let month = decimal_component(bytes, 5, 7);
    let day = decimal_component(bytes, 8, 10);
    let hour = decimal_component(bytes, 11, 13);
    let minute = decimal_component(bytes, 14, 16);
    let second = decimal_component(bytes, 17, 19);
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(invalid(format!(
            "{field} must be a valid canonical RFC 3339 UTC timestamp"
        )));
    }
    Ok(())
}

fn decimal_component(bytes: &[u8], start: usize, end: usize) -> u32 {
    bytes[start..end]
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn installation_select_sql() -> &'static str {
    "SELECT i.id, i.plugin_id, i.version, i.source, i.package_digest,
            i.manifest_digest, i.signature_json, i.runtime_kind, i.enabled,
            i.installed_at, i.updated_at, m.scope, m.requested_permissions_json,
            m.manifest_json
     FROM plugin_installations AS i
     JOIN plugin_installation_metadata AS m ON m.installation_id = i.id
     WHERE i.id = ?1"
}

fn installation_record_from_input(input: &PluginInstallationInput) -> PluginInstallationRecord {
    PluginInstallationRecord {
        id: input.id.clone(),
        plugin_id: input.plugin_id.clone(),
        version: input.version.clone(),
        source: input.source.clone(),
        package_digest: input.package_digest.clone(),
        manifest_digest: input.manifest_digest.clone(),
        signature: input.signature.clone(),
        runtime_kind: input.runtime_kind,
        scope: input.scope,
        requested_permissions: input.requested_permissions.clone(),
        manifest: input.manifest.clone(),
        enabled: false,
        installed_at: input.installed_at.clone(),
        updated_at: input.installed_at.clone(),
    }
}

fn plugin_installation_in_tx(
    tx: &rusqlite::Transaction<'_>,
    installation_id: &str,
) -> Result<Option<PluginInstallationRecord>, StoreError> {
    tx.query_row(
        installation_select_sql(),
        params![installation_id],
        read_installation,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_plugin_installation(
    tx: &rusqlite::Transaction<'_>,
    installation_id: &str,
) -> Result<PluginInstallationRecord, StoreError> {
    plugin_installation_in_tx(tx, installation_id)?.ok_or_else(|| StoreError::NotFound {
        what: format!("plugin installation {installation_id}"),
    })
}

fn ensure_install_replay(
    existing: &PluginInstallationRecord,
    input: &PluginInstallationInput,
) -> Result<(), StoreError> {
    if existing.plugin_id != input.plugin_id
        || existing.version != input.version
        || existing.source != input.source
        || existing.package_digest != input.package_digest
        || existing.manifest_digest != input.manifest_digest
        || existing.signature != input.signature
        || existing.runtime_kind != input.runtime_kind
        || existing.scope != input.scope
        || existing.requested_permissions != input.requested_permissions
        || existing.manifest != input.manifest
        || existing.installed_at != input.installed_at
    {
        return Err(invalid(
            "plugin installation ID is already bound to different verified metadata",
        ));
    }
    Ok(())
}

fn plugin_grant_in_tx(
    tx: &rusqlite::Transaction<'_>,
    grant_id: &str,
) -> Result<Option<PluginGrantRecord>, StoreError> {
    tx.query_row(
        "SELECT id, installation_id, workspace_identity_digest, grant_json,
                granted_at, granted_by, revoked_at
         FROM plugin_grants WHERE id = ?1",
        params![grant_id],
        read_grant,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_plugin_grant(
    tx: &rusqlite::Transaction<'_>,
    grant_id: &str,
) -> Result<PluginGrantRecord, StoreError> {
    plugin_grant_in_tx(tx, grant_id)?.ok_or_else(|| StoreError::NotFound {
        what: format!("plugin grant {grant_id}"),
    })
}

fn ensure_active_plugin_grant(
    tx: &rusqlite::Transaction<'_>,
    installation_id: &str,
    workspace_identity_digest: &str,
) -> Result<(), StoreError> {
    let granted: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM plugin_grants
            WHERE installation_id = ?1
              AND revoked_at IS NULL
              AND (
                  workspace_identity_digest IS NULL
                  OR workspace_identity_digest = ?2
              )
         )",
        params![installation_id, workspace_identity_digest],
        |row| row.get(0),
    )?;
    if !granted {
        return Err(invalid(
            "plugin instance requires an active grant for its workspace identity",
        ));
    }
    Ok(())
}

fn ensure_grant_replay(
    existing: &PluginGrantRecord,
    input: &PluginGrantInput,
) -> Result<(), StoreError> {
    if existing.installation_id != input.installation_id
        || existing.workspace_identity_digest != input.workspace_identity_digest
        || existing.permissions != input.permissions
        || existing.granted_at != input.granted_at
        || existing.granted_by != input.granted_by
    {
        return Err(invalid(
            "plugin grant ID is already bound to different metadata",
        ));
    }
    Ok(())
}

fn ensure_workspace_exists(
    tx: &rusqlite::Transaction<'_>,
    workspace_identity_digest: &str,
) -> Result<(), StoreError> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE canonical_path_hash = ?1)",
        params![workspace_identity_digest],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StoreError::NotFound {
            what: format!("workspace {workspace_identity_digest}"),
        });
    }
    Ok(())
}

fn ensure_state_scope_binding(
    tx: &rusqlite::Transaction<'_>,
    write: &PluginStateWrite,
) -> Result<(), StoreError> {
    if let Some(workspace) = &write.workspace_identity_digest {
        ensure_workspace_exists(tx, workspace)?;
    }
    if let Some(session_id) = &write.session_id {
        let workspace: String = tx
            .query_row(
                "SELECT workspaces.canonical_path_hash
                 FROM sessions JOIN workspaces ON workspaces.id = sessions.workspace_id
                 WHERE sessions.id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("session {session_id}"),
            })?;
        if write.workspace_identity_digest.as_deref() != Some(workspace.as_str()) {
            return Err(invalid(
                "session plugin state must use its session workspace identity",
            ));
        }
    }
    Ok(())
}

fn ensure_instance_scope_binding(
    tx: &rusqlite::Transaction<'_>,
    input: &PluginInstanceStart,
) -> Result<(), StoreError> {
    if let Some(session_id) = &input.session_id {
        let workspace: String = tx
            .query_row(
                "SELECT workspaces.canonical_path_hash
                 FROM sessions JOIN workspaces ON workspaces.id = sessions.workspace_id
                 WHERE sessions.id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("session {session_id}"),
            })?;
        if workspace != input.workspace_identity_digest {
            return Err(invalid(
                "plugin instance session must use its session workspace identity",
            ));
        }
    }
    if let Some(worktree_id) = &input.worktree_id {
        let workspace: String = tx
            .query_row(
                "SELECT workspace_identity_digest FROM worktrees WHERE id = ?1",
                params![worktree_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound {
                what: format!("worktree {worktree_id}"),
            })?;
        if workspace != input.workspace_identity_digest {
            return Err(invalid(
                "plugin instance worktree must use its worktree workspace identity",
            ));
        }
    }
    Ok(())
}

fn plugin_instance_select_sql() -> &'static str {
    "SELECT id, installation_id, workspace_identity_digest, worktree_id,
            session_id, state, pid, started_at, heartbeat_at, stopped_at,
            failure_count, circuit_state, circuit_generation,
            last_failure_at, circuit_opened_at, circuit_retry_at
     FROM plugin_instances
     WHERE id = ?1"
}

fn plugin_instance_in_tx(
    tx: &rusqlite::Transaction<'_>,
    instance_id: &str,
) -> Result<Option<PluginInstanceRecord>, StoreError> {
    tx.query_row(
        plugin_instance_select_sql(),
        params![instance_id],
        read_plugin_instance,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_plugin_instance(
    tx: &rusqlite::Transaction<'_>,
    instance_id: &str,
) -> Result<PluginInstanceRecord, StoreError> {
    plugin_instance_in_tx(tx, instance_id)?.ok_or_else(|| StoreError::NotFound {
        what: format!("plugin instance {instance_id}"),
    })
}

fn ensure_instance_start_replay(
    existing: &PluginInstanceRecord,
    input: &PluginInstanceStart,
) -> Result<(), StoreError> {
    if existing.installation_id != input.installation_id
        || existing.workspace_identity_digest != input.workspace_identity_digest
        || existing.worktree_id != input.worktree_id
        || existing.session_id != input.session_id
        || existing.pid != input.pid
        || existing.started_at.as_deref() != Some(input.started_at.as_str())
    {
        return Err(invalid(
            "plugin instance ID is already bound to different startup metadata",
        ));
    }
    Ok(())
}

fn plugin_invocation_select_sql() -> &'static str {
    "SELECT id, instance_id, hook_or_method, correlation_id, state,
            decision_json, error_json, started_at, finished_at
     FROM plugin_invocations
     WHERE id = ?1"
}

fn plugin_invocation_in_tx(
    tx: &rusqlite::Transaction<'_>,
    invocation_id: &str,
) -> Result<Option<PluginInvocationRecord>, StoreError> {
    tx.query_row(
        plugin_invocation_select_sql(),
        params![invocation_id],
        read_plugin_invocation,
    )
    .optional()
    .map_err(StoreError::from)
}

fn require_plugin_invocation(
    tx: &rusqlite::Transaction<'_>,
    invocation_id: &str,
) -> Result<PluginInvocationRecord, StoreError> {
    plugin_invocation_in_tx(tx, invocation_id)?.ok_or_else(|| StoreError::NotFound {
        what: format!("plugin invocation {invocation_id}"),
    })
}

fn ensure_invocation_start_replay(
    existing: &PluginInvocationRecord,
    input: &PluginInvocationStart,
) -> Result<(), StoreError> {
    if existing.instance_id != input.instance_id
        || existing.hook_or_method != input.hook_or_method
        || existing.correlation_id != input.correlation_id
        || existing.started_at != input.started_at
    {
        return Err(invalid(
            "plugin invocation ID is already bound to different startup metadata",
        ));
    }
    Ok(())
}

fn ensure_invocation_finish_replay(
    existing: &PluginInvocationRecord,
    finish: &PluginInvocationFinish,
) -> Result<(), StoreError> {
    if existing.state != finish.state
        || existing.decision != finish.decision
        || existing.error != finish.error
        || existing.finished_at.as_deref() != Some(finish.finished_at.as_str())
    {
        return Err(invalid(
            "plugin invocation already has a different terminal result",
        ));
    }
    Ok(())
}

fn plugin_state_in_tx(
    tx: &rusqlite::Transaction<'_>,
    write: &PluginStateWrite,
) -> Result<Option<PluginStateRecord>, StoreError> {
    tx.query_row(
        "SELECT installation_id, workspace_identity_digest, session_id, key,
                value_json, revision, updated_at
         FROM plugin_state
         WHERE installation_id = ?1
           AND workspace_identity_digest IS ?2
           AND session_id IS ?3
           AND key = ?4",
        params![
            &write.installation_id,
            &write.workspace_identity_digest,
            &write.session_id,
            &write.key,
        ],
        |row| read_state_row(row, write.scope),
    )
    .optional()
    .map_err(StoreError::from)
}

fn read_plugin_instance(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginInstanceRecord> {
    let state = PluginInstanceState::parse(&row.get::<_, String>(5)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let circuit_state = PluginCircuitState::parse(&row.get::<_, String>(11)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PluginInstanceRecord {
        id: row.get(0)?,
        installation_id: row.get(1)?,
        workspace_identity_digest: row.get(2)?,
        worktree_id: row.get(3)?,
        session_id: row.get(4)?,
        state,
        pid: row.get(6)?,
        started_at: row.get(7)?,
        heartbeat_at: row.get(8)?,
        stopped_at: row.get(9)?,
        failure_count: row.get(10)?,
        circuit_state,
        circuit_generation: row.get(12)?,
        last_failure_at: row.get(13)?,
        circuit_opened_at: row.get(14)?,
        circuit_retry_at: row.get(15)?,
    })
}

fn read_plugin_invocation(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginInvocationRecord> {
    let state = PluginInvocationState::parse(&row.get::<_, String>(4)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PluginInvocationRecord {
        id: row.get(0)?,
        instance_id: row.get(1)?,
        hook_or_method: row.get(2)?,
        correlation_id: row.get(3)?,
        state,
        decision: optional_json(row.get(5)?, 5)?,
        error: optional_json(row.get(6)?, 6)?,
        started_at: row.get(7)?,
        finished_at: row.get(8)?,
    })
}

fn read_installation(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginInstallationRecord> {
    let signature = optional_json(row.get(6)?, 6)?;
    let runtime_kind = PluginRuntimeKind::parse(&row.get::<_, String>(7)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let scope = PluginInstallScope::parse(&row.get::<_, String>(11)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let requested_permissions = json_as(row.get(12)?, 12)?;
    let manifest = json_value(row.get(13)?, 13)?;
    Ok(PluginInstallationRecord {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        version: row.get(2)?,
        source: row.get(3)?,
        package_digest: row.get(4)?,
        manifest_digest: row.get(5)?,
        signature,
        runtime_kind,
        enabled: row.get::<_, i64>(8)? != 0,
        installed_at: row.get(9)?,
        updated_at: row.get(10)?,
        scope,
        requested_permissions,
        manifest,
    })
}

fn read_grant(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginGrantRecord> {
    Ok(PluginGrantRecord {
        id: row.get(0)?,
        installation_id: row.get(1)?,
        workspace_identity_digest: row.get(2)?,
        permissions: json_as(row.get(3)?, 3)?,
        granted_at: row.get(4)?,
        granted_by: row.get(5)?,
        revoked_at: row.get(6)?,
    })
}

fn read_state_row(
    row: &rusqlite::Row<'_>,
    scope: PluginStateScope,
) -> rusqlite::Result<PluginStateRecord> {
    Ok(PluginStateRecord {
        installation_id: row.get(0)?,
        scope,
        workspace_identity_digest: row.get(1)?,
        session_id: row.get(2)?,
        key: row.get(3)?,
        value: json_value(row.get(4)?, 4)?,
        revision: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn json_value(raw: String, index: usize) -> rusqlite::Result<serde_json::Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn json_as<T: serde::de::DeserializeOwned>(raw: String, index: usize) -> rusqlite::Result<T> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn optional_json(raw: Option<String>, index: usize) -> rusqlite::Result<Option<serde_json::Value>> {
    raw.map(|value| json_value(value, index)).transpose()
}
