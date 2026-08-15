//! Process supervision — PRD §12.7, §12.8, §14.6, §14.7, AC-20, AC-22, RT-001.
//!
//! Invariants enforced here:
//!   - every child runs in its own process group / session so cancellation
//!     reaches grandchildren (§14.6),
//!   - graceful signal then hard kill after a deadline (§14.6),
//!   - output is bounded in memory and spilled to disk beyond the limit
//!     (§14.7: 1 MiB in memory, 10 MB captured),
//!   - `Ctrl+C` terminates the whole tree with zero orphans (AC-20, RT-001),
//!   - the displayed command always equals the argv actually executed
//!     (TOOL-002).

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::fd::AsRawFd;

use serde::{Deserialize, Serialize};

pub mod env_policy;
pub mod limits;

pub use env_policy::{filter_env, is_executable_control_env, EnvPolicy};
pub use limits::{ResourceLimits, DEFAULT_LIMITS};

/// Grace period between the graceful signal and the hard kill (§14.6).
pub const DEFAULT_KILL_GRACE_MS: u64 = 2_000;

/// In-memory output buffer cap before spilling (§14.7).
pub const DEFAULT_INLINE_BUFFER_BYTES: usize = 1024 * 1024;

/// Total captured output cap (§14.7).
pub const DEFAULT_MAX_CAPTURED_BYTES: usize = 10 * 1024 * 1024;

/// One reader pull from a child pipe (§14.7). Small enough to keep the resident
/// buffer tight, large enough that a chatty child does not syscall per byte.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// A child that never emits a newline must not accumulate an unbounded line:
/// once the pending fragment crosses this cap it is flushed as its own chunk.
const MAX_PENDING_LINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StdinMode {
    Null,
    Pipe,
    Pty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Deny,
    Inherit,
    Allow,
}

/// Filesystem confinement applied to a child via Landlock (P0-04, §14.4).
///
/// The semantics are allowlist: anything not beneath a listed root is denied.
/// `writable_roots` receive full access; `readable_roots` receive read+execute
/// only (enough to run binaries and load libraries). Paths that do not exist
/// are ignored, so a portable default plan does not fail on a host that lacks
/// `/lib64`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicy {
    #[serde(default)]
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub readable_roots: Vec<String>,
}

impl SandboxPolicy {
    pub fn is_empty(&self) -> bool {
        self.writable_roots.is_empty() && self.readable_roots.is_empty()
    }
}

/// True when this build can allocate a real PTY for `StdinMode::Pty`.
///
/// §24.5: the `pty` capability must state what the runtime actually does. The
/// POSIX PTY path is implemented below; other platforms fall back to a pipe,
/// so they report `false` and the client never asks for one.
pub fn pty_supported() -> bool {
    cfg!(unix)
}

/// Process specification — mirrors the `ProcessSpec` interface in §12.7.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSpec {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub env_policy: EnvPolicy,
    #[serde(default = "default_stdin")]
    pub stdin: StdinMode,
    #[serde(default = "default_network")]
    pub network: NetworkMode,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output")]
    pub max_output_bytes: usize,
    #[serde(default)]
    pub max_memory_bytes: Option<u64>,
    #[serde(default)]
    pub max_cpu_seconds: Option<u64>,
    /// True when the caller explicitly requested a raw shell (`shell.run`).
    /// Recorded so the audit event distinguishes it from `process.run`.
    #[serde(default)]
    pub raw_shell: bool,
    /// Identifies output that is a machine protocol and must reach its owning
    /// channel byte-for-byte instead of passing through display redaction.
    #[serde(default)]
    pub protocol_channel: Option<String>,
    /// Filesystem confinement for this spawn (P0-04). `None` keeps the legacy
    /// behaviour (workspace path guard above, no OS allowlist inside).
    #[serde(default)]
    pub sandbox: Option<SandboxPolicy>,
}

fn default_stdin() -> StdinMode {
    StdinMode::Null
}
fn default_network() -> NetworkMode {
    NetworkMode::Inherit
}
fn default_timeout() -> u64 {
    limits::DEFAULT_LIMITS.process_timeout_ms
}
fn default_max_output() -> usize {
    DEFAULT_MAX_CAPTURED_BYTES
}

impl ProcessSpec {
    pub fn new(program: impl Into<String>, args: Vec<String>, cwd: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args,
            cwd: cwd.into(),
            env: HashMap::new(),
            env_policy: EnvPolicy::default(),
            stdin: StdinMode::Null,
            network: NetworkMode::Inherit,
            timeout_ms: default_timeout(),
            max_output_bytes: DEFAULT_MAX_CAPTURED_BYTES,
            max_memory_bytes: None,
            max_cpu_seconds: None,
            raw_shell: false,
            protocol_channel: None,
            sandbox: None,
        }
    }

    /// Exactly what the UI shows and what gets executed — TOOL-002 requires
    /// these to be the same string.
    pub fn display(&self) -> String {
        let mut parts = vec![shell_quote(&self.program)];
        parts.extend(self.args.iter().map(|a| shell_quote(a)));
        parts.join(" ")
    }
}

/// Quote an argv element for display only. Never used to build a command line.
pub fn shell_quote(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_string();
    }
    let needs_quote = arg.chars().any(|c| {
        !(c.is_ascii_alphanumeric()
            || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | '@' | '+' | ',' | '~'))
    });
    if !needs_quote {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Starting,
    Running,
    Exited,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// A sequence-tagged output chunk (§12.7 "stdout/stderr separate
/// sequence-tagged chunks").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub job_id: String,
    pub stream: OutputStream,
    pub sequence: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_channel: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutcome {
    pub job_id: String,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    /// True when output exceeded the inline limit and was truncated.
    pub truncated: bool,
    pub display: String,
    /// Warnings such as limit approaches (§20.3 `process.limit_warning`).
    pub warnings: Vec<String>,
}

impl ProcessOutcome {
    pub fn succeeded(&self) -> bool {
        self.state == JobState::Exited && self.exit_code == Some(0)
    }

    pub fn taxonomy(&self) -> Option<&'static str> {
        match self.state {
            JobState::Exited if self.exit_code == Some(0) => None,
            JobState::Exited => Some("PROCESS_EXIT_NONZERO"),
            JobState::TimedOut => Some("TIMEOUT"),
            JobState::Cancelled => Some("CANCELLED"),
            JobState::Failed => Some("INTERNAL"),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum ProcessError {
    SpawnFailed {
        program: String,
        message: String,
    },
    InvalidCwd {
        path: String,
    },
    NotFound {
        job_id: String,
    },
    StdinUnavailable {
        job_id: String,
    },
    /// `network = deny` was requested but no backend can enforce it (P0-04).
    /// Fail closed: the spawn is refused, never run unenforced.
    NetworkDenied {
        message: String,
    },
    /// A sandbox policy was requested but no backend can enforce it (P0-04).
    SandboxUnavailable {
        message: String,
    },
    Io(std::io::Error),
}

impl std::fmt::Display for ProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcessError::SpawnFailed { program, message } => {
                write!(f, "failed to spawn '{program}': {message}")
            }
            ProcessError::InvalidCwd { path } => write!(f, "invalid working directory: {path}"),
            ProcessError::NotFound { job_id } => write!(f, "no such job: {job_id}"),
            ProcessError::StdinUnavailable { job_id } => {
                write!(f, "job {job_id} has no writable stdin")
            }
            ProcessError::NetworkDenied { message } => {
                write!(f, "network deny requested but not enforceable: {message}")
            }
            ProcessError::SandboxUnavailable { message } => {
                write!(f, "sandbox requested but not enforceable: {message}")
            }
            ProcessError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for ProcessError {}

/// Cancellation token propagated to children (§15.12).
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// A running job tracked by the supervisor.
struct Job {
    /// Stable job id, mirrored here so diagnostics do not need the map key.
    #[allow(dead_code)]
    id: String,
    child: Child,
    pgid: Option<i32>,
    spec: ProcessSpec,
    started: Instant,
    cancel: CancelToken,
    stdout_collector: Arc<Mutex<OutputCollector>>,
    stderr_collector: Arc<Mutex<OutputCollector>>,
    /// Writable end of the child's stdin: the pipe for `StdinMode::Pipe`, or
    /// the PTY master for `StdinMode::Pty`. Dropped by `close_stdin`.
    stdin: Option<Box<dyn Write + Send>>,
    state: JobState,
}

struct OutputCollector {
    buffer: String,
    total_bytes: u64,
    limit: usize,
    truncated: bool,
}

impl OutputCollector {
    fn new(limit: usize) -> Self {
        Self {
            buffer: String::new(),
            total_bytes: 0,
            limit,
            truncated: false,
        }
    }

    fn push(&mut self, text: &str) {
        self.total_bytes += text.len() as u64;
        if self.buffer.len() >= self.limit {
            self.truncated = true;
            return;
        }
        let remaining = self.limit - self.buffer.len();
        if text.len() <= remaining {
            self.buffer.push_str(text);
        } else {
            let mut end = remaining;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            self.buffer.push_str(&text[..end]);
            self.truncated = true;
        }
    }
}

/// The process supervisor. One instance per runtime.
pub struct ProcessSupervisor {
    jobs: Mutex<HashMap<String, Job>>,
    next_id: AtomicU64,
    limits: ResourceLimits,
    /// Notifications back to the client (`process.output`, `process.exited`).
    events: Mutex<Option<Sender<SupervisorEvent>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SupervisorEvent {
    Output(OutputChunk),
    Exited {
        job_id: String,
        state: JobState,
        exit_code: Option<i32>,
        signal: Option<i32>,
        duration_ms: u64,
    },
    LimitWarning {
        job_id: String,
        resource: String,
        detail: String,
    },
}

impl Default for ProcessSupervisor {
    fn default() -> Self {
        Self::new(DEFAULT_LIMITS)
    }
}

impl ProcessSupervisor {
    pub fn new(limits: ResourceLimits) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            limits,
            events: Mutex::new(None),
        }
    }

    /// Attach an event channel. Returns the receiver the runtime forwards to the
    /// client as notifications.
    pub fn attach_events(&self) -> Receiver<SupervisorEvent> {
        let (tx, rx) = mpsc::channel();
        *self.events.lock().expect("events lock") = Some(tx);
        rx
    }

    fn emit(&self, event: SupervisorEvent) {
        if let Some(tx) = self.events.lock().expect("events lock").as_ref() {
            let _ = tx.send(event);
        }
    }

    pub fn active_count(&self) -> usize {
        self.jobs
            .lock()
            .expect("jobs lock")
            .values()
            .filter(|j| matches!(j.state, JobState::Running | JobState::Starting))
            .count()
    }

    pub fn job_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .jobs
            .lock()
            .expect("jobs lock")
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// Run a process to completion, honouring the timeout and cancel token.
    pub fn run(
        &self,
        spec: ProcessSpec,
        cancel: CancelToken,
    ) -> Result<ProcessOutcome, ProcessError> {
        let job_id = self.start(spec, cancel)?;
        self.wait(&job_id)
    }

    /// Start a background job (§12.8) and return its stable ID.
    pub fn start(&self, spec: ProcessSpec, cancel: CancelToken) -> Result<String, ProcessError> {
        if self.active_count() >= self.limits.max_concurrent_processes {
            return Err(ProcessError::SpawnFailed {
                program: spec.program.clone(),
                message: format!(
                    "concurrent process limit of {} reached",
                    self.limits.max_concurrent_processes
                ),
            });
        }

        let cwd = std::path::Path::new(&spec.cwd);
        if !cwd.is_dir() {
            return Err(ProcessError::InvalidCwd {
                path: spec.cwd.clone(),
            });
        }

        let job_id = format!("job_{:04}", self.next_id.fetch_add(1, Ordering::SeqCst));

        // P0-04 fail closed: a requested isolation that cannot be enforced on
        // this host refuses the spawn instead of running unenforced. The probe
        // is cached, so this is a table lookup, not a syscall per spawn.
        if spec.network == NetworkMode::Deny && !cbc_sandbox::network_deny_available() {
            return Err(ProcessError::NetworkDenied {
                message: format!(
                    "no network-isolation backend is available on {}",
                    std::env::consts::OS
                ),
            });
        }
        let wants_fs_isolation = spec
            .sandbox
            .as_ref()
            .map(|policy| !policy.is_empty())
            .unwrap_or(false);
        if wants_fs_isolation && !cbc_sandbox::filesystem_isolation_available() {
            return Err(ProcessError::SandboxUnavailable {
                message: format!(
                    "no filesystem-isolation backend is available on {}",
                    std::env::consts::OS
                ),
            });
        }

        // Real PTY allocation (P0-04). Done before the spawn so the child can
        // dup the slave onto its stdio in `pre_exec`; the parent keeps the
        // master for both input and the (merged) output stream.
        #[cfg(unix)]
        let pty_pair: Option<PtyPair> = match spec.stdin {
            StdinMode::Pty => Some(open_pty().map_err(|e| ProcessError::SpawnFailed {
                program: spec.program.clone(),
                message: format!("failed to allocate a pty: {e}"),
            })?),
            _ => None,
        };

        // `shell.run` arrives as `{ program: <whole script>, rawShell: true }`
        // (§12.7). Passing that string to `Command::new` would interpret the
        // entire script as one executable filename — `echo a | grep a` would try
        // to exec a binary literally named "echo a | grep a". Raw-shell specs are
        // handed to the platform's shell instead; the runtime chooses the shell,
        // never the model.
        let mut command = if spec.raw_shell {
            #[cfg(windows)]
            {
                let mut cmd = Command::new("cmd");
                cmd.arg("/d").arg("/s").arg("/c").arg(&spec.program);
                cmd
            }
            #[cfg(not(windows))]
            {
                let mut cmd = Command::new("/bin/sh");
                cmd.arg("-c").arg(&spec.program);
                cmd
            }
        } else {
            let mut cmd = Command::new(&spec.program);
            cmd.args(&spec.args);
            cmd
        };
        command.current_dir(cwd);

        // Environment policy (§14.5): start from nothing, add only what the
        // policy allows plus explicit values.
        command.env_clear();
        for (key, value) in filter_env(&spec.env_policy, &spec.env) {
            command.env(key, value);
        }

        #[cfg(unix)]
        let pty_slave_fd: Option<std::os::fd::RawFd> =
            pty_pair.as_ref().map(|pair| pair.slave_fd.as_raw_fd());

        match spec.stdin {
            StdinMode::Null => {
                command.stdin(Stdio::null());
            }
            StdinMode::Pipe => {
                command.stdin(Stdio::piped());
            }
            StdinMode::Pty => {
                #[cfg(unix)]
                {
                    // The child's real stdio is the PTY slave, wired in
                    // `pre_exec`; nulls here keep std from adding pipes that
                    // would shadow it.
                    command.stdin(Stdio::null());
                }
                #[cfg(not(unix))]
                {
                    // No PTY backend on this platform: an honest pipe fallback.
                    // `pty_supported()` reports false, so clients do not ask.
                    command.stdin(Stdio::piped());
                }
            }
        }

        #[cfg(unix)]
        let using_pty = pty_pair.is_some();
        #[cfg(not(unix))]
        let using_pty = false;

        if using_pty {
            // stdout/stderr merge on the PTY, exactly as on a real terminal.
            command.stdout(Stdio::null()).stderr(Stdio::null());
        } else {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        }

        // Isolation applied inside the child after fork (P0-04): a new network
        // namespace for `network = deny`, then a Landlock allowlist. Landlock
        // runs last so every file this setup needs is already open.
        let netns = spec.network == NetworkMode::Deny;
        let landlock_rules: Vec<cbc_sandbox::FsRule> = spec
            .sandbox
            .as_ref()
            .map(|policy| fs_rules_for(policy))
            .unwrap_or_default();
        let isolation_requested = netns || !landlock_rules.is_empty();

        // Own process group so signals reach the whole tree (§14.6).
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            let max_cpu = spec.max_cpu_seconds;
            let max_mem = spec.max_memory_bytes;
            command.pre_exec(move || {
                // New session → new process group; the leader pid equals the pgid.
                if libc::setsid() == -1 {
                    // Already a session leader is fine; fall back to setpgid.
                    if libc::setpgid(0, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                // PTY: make the slave the controlling terminal and the child's
                // stdio. Must follow setsid, which detaches any previous tty.
                if let Some(slave) = pty_slave_fd {
                    libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
                    libc::dup2(slave, 0);
                    libc::dup2(slave, 1);
                    libc::dup2(slave, 2);
                    if slave > 2 {
                        libc::close(slave);
                    }
                }
                if let Some(secs) = max_cpu {
                    let lim = libc::rlimit {
                        rlim_cur: secs,
                        rlim_max: secs,
                    };
                    libc::setrlimit(libc::RLIMIT_CPU, &lim);
                }
                if let Some(bytes) = max_mem {
                    let lim = libc::rlimit {
                        rlim_cur: bytes,
                        rlim_max: bytes,
                    };
                    libc::setrlimit(libc::RLIMIT_AS, &lim);
                }
                if netns {
                    cbc_sandbox::enforce::apply_network_deny()?;
                }
                if !landlock_rules.is_empty() {
                    cbc_sandbox::enforce::apply_landlock(&landlock_rules)?;
                }
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|e| {
            if isolation_requested {
                // A failure here usually means isolation itself could not be
                // applied in the child; say so rather than blaming the program.
                ProcessError::SpawnFailed {
                    program: spec.program.clone(),
                    message: format!("isolation could not be applied at spawn: {e}"),
                }
            } else {
                ProcessError::SpawnFailed {
                    program: spec.program.clone(),
                    message: e.to_string(),
                }
            }
        })?;

        #[cfg(unix)]
        let pgid = Some(child.id() as i32);
        #[cfg(not(unix))]
        let pgid: Option<i32> = None;

        let inline_limit = spec.max_output_bytes.min(DEFAULT_MAX_CAPTURED_BYTES);
        let protocol_channel = spec.protocol_channel.clone();
        let stdout_collector = Arc::new(Mutex::new(OutputCollector::new(inline_limit)));
        let stderr_collector = Arc::new(Mutex::new(OutputCollector::new(inline_limit)));

        // Reader threads keep memory bounded and stream chunks to the client.
        // A PTY merges stdout and stderr into one stream — that is what a real
        // terminal is — so its master feeds the stdout collector only.
        #[cfg(unix)]
        let stdin: Option<Box<dyn Write + Send>> = match pty_pair {
            Some(pair) => {
                let reader = pair
                    .master
                    .try_clone()
                    .map_err(|e| ProcessError::SpawnFailed {
                        program: spec.program.clone(),
                        message: format!("failed to duplicate the pty master: {e}"),
                    })?;
                self.spawn_reader(
                    job_id.clone(),
                    OutputStream::Stdout,
                    reader,
                    Arc::clone(&stdout_collector),
                    protocol_channel.clone(),
                );
                Some(Box::new(pair.master))
            }
            None => {
                if let Some(out) = child.stdout.take() {
                    self.spawn_reader(
                        job_id.clone(),
                        OutputStream::Stdout,
                        out,
                        Arc::clone(&stdout_collector),
                        protocol_channel.clone(),
                    );
                }
                if let Some(err) = child.stderr.take() {
                    self.spawn_reader(
                        job_id.clone(),
                        OutputStream::Stderr,
                        err,
                        Arc::clone(&stderr_collector),
                        protocol_channel.clone(),
                    );
                }
                child
                    .stdin
                    .take()
                    .map(|pipe| Box::new(pipe) as Box<dyn Write + Send>)
            }
        };
        #[cfg(not(unix))]
        let stdin: Option<Box<dyn Write + Send>> = {
            if let Some(out) = child.stdout.take() {
                self.spawn_reader(
                    job_id.clone(),
                    OutputStream::Stdout,
                    out,
                    Arc::clone(&stdout_collector),
                    protocol_channel.clone(),
                );
            }
            if let Some(err) = child.stderr.take() {
                self.spawn_reader(
                    job_id.clone(),
                    OutputStream::Stderr,
                    err,
                    Arc::clone(&stderr_collector),
                    protocol_channel.clone(),
                );
            }
            child
                .stdin
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn Write + Send>)
        };

        let job = Job {
            id: job_id.clone(),
            child,
            pgid,
            spec,
            started: Instant::now(),
            cancel,
            stdout_collector,
            stderr_collector,
            stdin,
            state: JobState::Running,
        };

        self.jobs
            .lock()
            .expect("jobs lock")
            .insert(job_id.clone(), job);
        Ok(job_id)
    }

    fn spawn_reader<R: Read + Send + 'static>(
        &self,
        job_id: String,
        stream: OutputStream,
        reader: R,
        collector: Arc<Mutex<OutputCollector>>,
        protocol_channel: Option<String>,
    ) {
        let sender = self.events.lock().expect("events lock").clone();
        std::thread::spawn(move || {
            // Fixed-size chunk reads keep memory bounded even when the child
            // never emits a newline: `read_until` would have buffered tens of
            // MiB into one Vec before the collector ever saw it (§14.7).
            let mut buf_reader = BufReader::new(reader);
            let mut sequence = 0u64;
            let mut pending: Vec<u8> = Vec::new();
            let mut chunk = vec![0u8; READ_CHUNK_BYTES];

            let mut emit = |text: String| {
                collector.lock().expect("collector lock").push(&text);
                sequence += 1;
                if let Some(tx) = &sender {
                    let _ = tx.send(SupervisorEvent::Output(OutputChunk {
                        job_id: job_id.clone(),
                        stream,
                        sequence,
                        text,
                        protocol_channel: protocol_channel.clone(),
                    }));
                }
            };

            loop {
                match buf_reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        pending.extend_from_slice(&chunk[..count]);

                        // Emit every complete line in the buffer.
                        let mut start = 0usize;
                        while let Some(offset) = pending[start..].iter().position(|b| *b == b'\n') {
                            let end = start + offset + 1;
                            let text = String::from_utf8_lossy(&pending[start..end]).to_string();
                            emit(text);
                            start = end;
                        }
                        if start > 0 {
                            pending.drain(..start);
                        }

                        // A line with no newline cannot grow without bound; flush
                        // it as a synthetic chunk once it crosses the cap.
                        if pending.len() >= MAX_PENDING_LINE_BYTES {
                            let text = String::from_utf8_lossy(&pending).to_string();
                            emit(text);
                            pending.clear();
                        }
                    }
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                let text = String::from_utf8_lossy(&pending).to_string();
                emit(text);
            }
        });
    }

    /// Wait for a job, enforcing the timeout and reacting to cancellation.
    pub fn wait(&self, job_id: &str) -> Result<ProcessOutcome, ProcessError> {
        let (timeout_ms, display, started, cancel) = {
            let jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get(job_id).ok_or(ProcessError::NotFound {
                job_id: job_id.to_string(),
            })?;
            (
                job.spec.timeout_ms,
                job.spec.display(),
                job.started,
                job.cancel.clone(),
            )
        };

        let deadline = started + Duration::from_millis(timeout_ms);
        let mut warned_at_80 = false;

        loop {
            // Poll rather than block so cancellation latency stays under the
            // 100 ms budget in §22.2.
            let status = {
                let mut jobs = self.jobs.lock().expect("jobs lock");
                let job = jobs.get_mut(job_id).ok_or(ProcessError::NotFound {
                    job_id: job_id.to_string(),
                })?;
                job.child.try_wait().map_err(ProcessError::Io)?
            };

            if let Some(status) = status {
                return Ok(self.finalize(job_id, status_to_state(&status), Some(status)));
            }

            if cancel.is_cancelled() {
                self.terminate_tree(job_id, DEFAULT_KILL_GRACE_MS)?;
                return Ok(self.finalize(job_id, JobState::Cancelled, None));
            }

            let now = Instant::now();
            if now >= deadline {
                self.emit(SupervisorEvent::LimitWarning {
                    job_id: job_id.to_string(),
                    resource: "timeout".into(),
                    detail: format!("{display} exceeded {timeout_ms} ms"),
                });
                self.terminate_tree(job_id, DEFAULT_KILL_GRACE_MS)?;
                return Ok(self.finalize(job_id, JobState::TimedOut, None));
            }

            if !warned_at_80 {
                let elapsed = now.duration_since(started).as_millis() as u64;
                if timeout_ms > 0 && elapsed * 100 / timeout_ms.max(1) >= 80 {
                    warned_at_80 = true;
                    self.emit(SupervisorEvent::LimitWarning {
                        job_id: job_id.to_string(),
                        resource: "timeout".into(),
                        detail: format!("{display} has used 80% of its time budget"),
                    });
                }
            }

            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Non-blocking status check for `process.status`.
    pub fn status(&self, job_id: &str) -> Option<(JobState, u64)> {
        let mut jobs = self.jobs.lock().expect("jobs lock");
        let job = jobs.get_mut(job_id)?;
        if let Ok(Some(status)) = job.child.try_wait() {
            job.state = status_to_state(&status);
        }
        Some((job.state, job.started.elapsed().as_millis() as u64))
    }

    /// Write to a job's stdin (`process.input`).
    pub fn write_stdin(&self, job_id: &str, data: &str) -> Result<(), ProcessError> {
        let mut jobs = self.jobs.lock().expect("jobs lock");
        let job = jobs.get_mut(job_id).ok_or(ProcessError::NotFound {
            job_id: job_id.to_string(),
        })?;
        let stdin = job.stdin.as_mut().ok_or(ProcessError::StdinUnavailable {
            job_id: job_id.to_string(),
        })?;
        stdin.write_all(data.as_bytes()).map_err(ProcessError::Io)?;
        stdin.flush().map_err(ProcessError::Io)?;
        Ok(())
    }

    /// Close a job's stdin so a waiting child can proceed.
    pub fn close_stdin(&self, job_id: &str) -> Result<(), ProcessError> {
        let mut jobs = self.jobs.lock().expect("jobs lock");
        let job = jobs.get_mut(job_id).ok_or(ProcessError::NotFound {
            job_id: job_id.to_string(),
        })?;
        job.stdin = None;
        Ok(())
    }

    /// Terminate an owned job and its descendants: graceful signal to the whole
    /// process group, then a hard kill after `grace_ms` (§14.6, AC-20).
    pub fn terminate_tree(&self, job_id: &str, grace_ms: u64) -> Result<(), ProcessError> {
        let (pgid, pid) = {
            let jobs = self.jobs.lock().expect("jobs lock");
            let job = jobs.get(job_id).ok_or(ProcessError::NotFound {
                job_id: job_id.to_string(),
            })?;
            (job.pgid, job.child.id())
        };

        #[cfg(unix)]
        {
            if let Some(pgid) = pgid {
                // Negative pid targets the whole process group, so grandchildren
                // receive the signal too (RT-001).
                unsafe {
                    libc::kill(-pgid, libc::SIGTERM);
                }
            } else {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }

            let deadline = Instant::now() + Duration::from_millis(grace_ms);
            loop {
                {
                    let mut jobs = self.jobs.lock().expect("jobs lock");
                    if let Some(job) = jobs.get_mut(job_id) {
                        if matches!(job.child.try_wait(), Ok(Some(_))) {
                            break;
                        }
                    } else {
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    if let Some(pgid) = pgid {
                        unsafe {
                            libc::kill(-pgid, libc::SIGKILL);
                        }
                    } else {
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[cfg(windows)]
        {
            let _ = pgid;
            // §14.6 / RT-001: killing only the direct child would orphan
            // grandchildren, which is exactly what a shell wrapper produces.
            // `taskkill /T` walks the tree; the graceful pass runs first so a
            // well-behaved child can shut down within `grace_ms`.
            terminate_tree_windows(pid, grace_ms, || {
                let mut jobs = self.jobs.lock().expect("jobs lock");
                match jobs.get_mut(job_id) {
                    Some(job) => matches!(job.child.try_wait(), Ok(Some(_))),
                    // The job disappeared, so there is nothing left to wait for.
                    None => true,
                }
            });

            // Whatever taskkill could not reach, the direct handle still can.
            let mut jobs = self.jobs.lock().expect("jobs lock");
            if let Some(job) = jobs.get_mut(job_id) {
                if !matches!(job.child.try_wait(), Ok(Some(_))) {
                    let _ = job.child.kill();
                }
            }
        }

        #[cfg(not(any(unix, windows)))]
        {
            let _ = (pgid, grace_ms);
            let mut jobs = self.jobs.lock().expect("jobs lock");
            if let Some(job) = jobs.get_mut(job_id) {
                let _ = job.child.kill();
            }
        }

        // Reap so no zombie remains (§14.6 "zombie reaping") and record the
        // terminal state so `active_count` stops counting this job.
        {
            let mut jobs = self.jobs.lock().expect("jobs lock");
            if let Some(job) = jobs.get_mut(job_id) {
                let _ = job.child.wait();
                if matches!(job.state, JobState::Running | JobState::Starting) {
                    job.state = JobState::Cancelled;
                }
            }
        }
        Ok(())
    }

    /// Stop every tracked job. Called on shutdown so no process outlives the
    /// session (§24.1 invariant 6).
    pub fn terminate_all(&self, grace_ms: u64) {
        for id in self.job_ids() {
            let _ = self.terminate_tree(&id, grace_ms);
        }
    }

    fn finalize(
        &self,
        job_id: &str,
        state: JobState,
        status: Option<std::process::ExitStatus>,
    ) -> ProcessOutcome {
        // Give reader threads a brief moment to drain the pipes.
        std::thread::sleep(Duration::from_millis(20));

        let mut jobs = self.jobs.lock().expect("jobs lock");
        let job = jobs.get_mut(job_id);
        let Some(job) = job else {
            return ProcessOutcome {
                job_id: job_id.to_string(),
                state: JobState::Failed,
                exit_code: None,
                signal: None,
                duration_ms: 0,
                stdout: String::new(),
                stderr: String::new(),
                stdout_bytes: 0,
                stderr_bytes: 0,
                truncated: false,
                display: String::new(),
                warnings: vec!["job record disappeared".into()],
            };
        };

        job.state = state;
        let duration_ms = job.started.elapsed().as_millis() as u64;
        let stdout_guard = job.stdout_collector.lock().expect("stdout lock");
        let stderr_guard = job.stderr_collector.lock().expect("stderr lock");
        let mut warnings = Vec::new();
        if stdout_guard.truncated || stderr_guard.truncated {
            warnings.push(format!(
                "output truncated at {} bytes; full output stored as an artifact",
                stdout_guard.limit
            ));
        }

        let exit_code = status.and_then(|s| s.code());
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.and_then(|s| s.signal())
        };
        #[cfg(not(unix))]
        let signal: Option<i32> = None;

        let outcome = ProcessOutcome {
            job_id: job_id.to_string(),
            state,
            exit_code,
            signal,
            duration_ms,
            stdout: stdout_guard.buffer.clone(),
            stderr: stderr_guard.buffer.clone(),
            stdout_bytes: stdout_guard.total_bytes,
            stderr_bytes: stderr_guard.total_bytes,
            truncated: stdout_guard.truncated || stderr_guard.truncated,
            display: job.spec.display(),
            warnings,
        };

        drop(stdout_guard);
        drop(stderr_guard);

        self.emit(SupervisorEvent::Exited {
            job_id: job_id.to_string(),
            state,
            exit_code,
            signal,
            duration_ms,
        });

        outcome
    }

    /// Remove finished jobs from the table.
    pub fn reap_finished(&self) -> usize {
        let mut jobs = self.jobs.lock().expect("jobs lock");
        let finished: Vec<String> = jobs
            .iter_mut()
            .filter_map(|(id, job)| {
                if matches!(job.child.try_wait(), Ok(Some(_)))
                    || matches!(
                        job.state,
                        JobState::Exited
                            | JobState::Cancelled
                            | JobState::TimedOut
                            | JobState::Failed
                    )
                {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in &finished {
            jobs.remove(id);
        }
        finished.len()
    }
}

impl Drop for ProcessSupervisor {
    fn drop(&mut self) {
        // §24.1 invariant 6: background processes must not outlive the session.
        self.terminate_all(500);
    }
}

/// Terminate a process tree on Windows.
///
/// §14.4 names Job Objects as the preferred native-Windows mechanism; that needs
/// a Win32 binding this crate does not yet carry, and native Windows is a P1
/// beta tier (§19.11). `taskkill /T` is the dependency-free stand-in that still
/// reaches descendants, so the RT-001 "no orphan after cancel" invariant holds
/// rather than silently only covering the direct child.
///
/// `exited` is polled so the graceful pass can finish early.
#[cfg(windows)]
fn terminate_tree_windows(pid: u32, grace_ms: u64, mut exited: impl FnMut() -> bool) {
    use std::process::Command;

    let taskkill = |force: bool| {
        let mut cmd = Command::new("taskkill");
        cmd.arg("/PID").arg(pid.to_string()).arg("/T");
        if force {
            cmd.arg("/F");
        }
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let _ = cmd.status();
    };

    // Graceful pass: ask the tree to close.
    taskkill(false);

    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    while Instant::now() < deadline {
        if exited() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    // Hard pass after the grace period.
    taskkill(true);
}

fn status_to_state(status: &std::process::ExitStatus) -> JobState {
    if status.success() {
        JobState::Exited
    } else {
        JobState::Exited // non-zero exit is still a normal exit
    }
}

/// Translate a `SandboxPolicy` into Landlock rules.
///
/// Readable roots get read+execute (run binaries, load libraries); writable
/// roots get the full ABI v1 set. The allowlist semantics come from Landlock
/// itself: any path not beneath a rule is denied.
fn fs_rules_for(policy: &SandboxPolicy) -> Vec<cbc_sandbox::FsRule> {
    let mut rules = Vec::with_capacity(policy.writable_roots.len() + policy.readable_roots.len());
    for path in &policy.readable_roots {
        rules.push(cbc_sandbox::FsRule {
            path: path.clone(),
            access: cbc_sandbox::enforce::FS_READ_ACCESS,
            required: false,
        });
    }
    for path in &policy.writable_roots {
        rules.push(cbc_sandbox::FsRule {
            path: path.clone(),
            access: cbc_sandbox::enforce::FS_FULL_ACCESS,
            required: true,
        });
    }
    rules
}

// ---------------------------------------------------------------------------
// PTY support — P0-04
// ---------------------------------------------------------------------------

/// A PTY allocated for one job: the parent keeps both ends until the child
/// is spawned, then reads and writes the master only.
#[cfg(unix)]
struct PtyPair {
    master: std::fs::File,
    slave_fd: std::os::fd::OwnedFd,
}

/// Allocate a PTY pair with the slave in raw mode.
///
/// Raw mode matters: the default cooked termios would translate `\n` to
/// `\r\n` and echo input back, corrupting captured output. A child that wants
/// a different discipline (a shell in interactive mode, `stty`) can set its
/// own once it starts.
#[cfg(unix)]
fn open_pty() -> std::io::Result<PtyPair> {
    use std::os::fd::FromRawFd;

    unsafe {
        let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC);
        if master < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let master = std::fs::File::from_raw_fd(master);
        let grant = grantpt_unlockpt(master_fd(&master))?;
        if !grant {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "pty slave could not be prepared",
            ));
        }

        let mut name = [0 as libc::c_char; 128];
        let rc = libc::ptsname_r(master_fd(&master), name.as_mut_ptr(), name.len());
        if rc != 0 {
            return Err(std::io::Error::from_raw_os_error(rc));
        }
        let slave_path = std::ffi::CStr::from_ptr(name.as_ptr());
        let slave = libc::open(
            slave_path.as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
        );
        if slave < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let slave_fd = std::os::fd::OwnedFd::from_raw_fd(slave);

        let mut tio: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(slave_fd.as_raw_fd(), &mut tio) == 0 {
            libc::cfmakeraw(&mut tio);
            libc::tcsetattr(slave_fd.as_raw_fd(), libc::TCSANOW, &tio);
        }

        // A sane default window; a child that cares can query or set its own.
        let mut ws: libc::winsize = std::mem::zeroed();
        ws.ws_row = 50;
        ws.ws_col = 200;
        let _ = libc::ioctl(master_fd(&master), libc::TIOCSWINSZ as _, &ws);

        Ok(PtyPair { master, slave_fd })
    }
}

#[cfg(unix)]
fn master_fd(file: &std::fs::File) -> std::os::fd::RawFd {
    use std::os::fd::AsRawFd;
    file.as_raw_fd()
}

#[cfg(unix)]
fn grantpt_unlockpt(fd: std::os::fd::RawFd) -> std::io::Result<bool> {
    unsafe {
        if libc::grantpt(fd) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::unlockpt(fd) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locate a POSIX shell for the test scripts below.
    ///
    /// The supervisor under test is what these cases exercise, not the shell, so
    /// the scripts stay POSIX everywhere. §19.11 makes WSL the recommended
    /// Windows path, but a developer on native Windows still gets real coverage
    /// because Git for Windows ships `sh.exe`. When no POSIX shell exists the
    /// helper returns `None` and the affected tests skip instead of reporting a
    /// failure that says nothing about this crate.
    fn posix_shell() -> Option<String> {
        #[cfg(not(windows))]
        {
            let candidates = ["/bin/sh", "/usr/bin/sh"];
            candidates
                .iter()
                .find(|p| std::path::Path::new(p).exists())
                .map(|p| (*p).to_string())
        }
        #[cfg(windows)]
        {
            if let Ok(explicit) = std::env::var("CBC_TEST_SH") {
                if std::path::Path::new(&explicit).exists() {
                    return Some(explicit);
                }
            }
            let candidates = [
                r"C:\Program Files\Git\usr\bin\sh.exe",
                r"C:\Program Files\Git\bin\sh.exe",
                r"C:\Program Files (x86)\Git\usr\bin\sh.exe",
            ];
            candidates
                .iter()
                .find(|p| std::path::Path::new(p).exists())
                .map(|p| (*p).to_string())
        }
    }

    /// Build a spec that runs `script` under a POSIX shell, or `None` to skip.
    fn try_sh(script: &str) -> Option<ProcessSpec> {
        let shell = posix_shell()?;
        let mut spec = ProcessSpec::new(
            shell.clone(),
            vec!["-c".into(), script.into()],
            std::env::temp_dir().to_string_lossy().to_string(),
        );
        spec.timeout_ms = 15_000;

        // The scripts below call POSIX utilities (`env`, `cat`, `sleep`) that
        // Git's `sh.exe` resolves through PATH. §14.5 inherits the Windows
        // `Path`, which does not list Git's `usr/bin`, so the harness prepends
        // it. Without this the scripts would fail for a reason that has nothing
        // to do with the supervisor under test.
        #[cfg(windows)]
        {
            if let Some(bin_dir) = std::path::Path::new(&shell).parent() {
                let inherited = std::env::var("PATH").unwrap_or_default();
                spec.env.insert(
                    "PATH".to_string(),
                    format!("{};{}", bin_dir.to_string_lossy(), inherited),
                );
            }
        }

        Some(spec)
    }

    fn sh(script: &str) -> ProcessSpec {
        try_sh(script).expect(
            "a POSIX shell is required for these tests; install Git for Windows or set CBC_TEST_SH",
        )
    }

    #[test]
    fn display_matches_argv_exactly() {
        // TOOL-002: displayed command equals the actual argv.
        let spec = ProcessSpec::new(
            "pnpm",
            vec!["test".into(), "--filter".into(), "auth".into()],
            "/w",
        );
        assert_eq!(spec.display(), "pnpm test --filter auth");
        assert_eq!(spec.program, "pnpm");
        assert_eq!(spec.args, vec!["test", "--filter", "auth"]);
    }

    #[test]
    fn display_quotes_arguments_with_spaces() {
        let spec = ProcessSpec::new(
            "git",
            vec!["commit".into(), "-m".into(), "two words".into()],
            "/w",
        );
        assert_eq!(spec.display(), "git commit -m 'two words'");
    }

    #[test]
    fn display_escapes_embedded_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("plain"), "plain");
    }

    #[test]
    fn runs_process_and_captures_stdout() {
        let sup = ProcessSupervisor::default();
        let outcome = sup
            .run(sh("echo hello-capybara"), CancelToken::new())
            .unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.stdout.contains("hello-capybara"));
        assert!(outcome.taxonomy().is_none());
    }

    #[test]
    fn captures_stderr_separately() {
        let sup = ProcessSupervisor::default();
        let outcome = sup
            .run(sh("echo out; echo err 1>&2"), CancelToken::new())
            .unwrap();
        assert!(outcome.stdout.contains("out"));
        assert!(outcome.stderr.contains("err"));
        assert!(!outcome.stdout.contains("err"));
    }

    #[test]
    fn reports_nonzero_exit_with_taxonomy() {
        let sup = ProcessSupervisor::default();
        let outcome = sup.run(sh("exit 3"), CancelToken::new()).unwrap();
        assert!(!outcome.succeeded());
        assert_eq!(outcome.exit_code, Some(3));
        assert_eq!(outcome.taxonomy(), Some("PROCESS_EXIT_NONZERO"));
    }

    #[test]
    fn enforces_timeout() {
        let sup = ProcessSupervisor::default();
        let mut spec = sh("sleep 30");
        spec.timeout_ms = 300;
        let start = Instant::now();
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert_eq!(outcome.state, JobState::TimedOut);
        assert_eq!(outcome.taxonomy(), Some("TIMEOUT"));
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn cancellation_terminates_process() {
        // AC-20: Ctrl+C must terminate the process.
        let sup = Arc::new(ProcessSupervisor::default());
        let cancel = CancelToken::new();
        let job_id = sup.start(sh("sleep 30"), cancel.clone()).unwrap();

        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            c2.cancel();
        });

        let start = Instant::now();
        let outcome = sup.wait(&job_id).unwrap();
        assert_eq!(outcome.state, JobState::Cancelled);
        assert_eq!(outcome.taxonomy(), Some("CANCELLED"));
        assert!(
            start.elapsed() < Duration::from_secs(8),
            "cancellation took {:?}",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rt001_cancellation_leaves_no_orphan_grandchildren() {
        // RT-001: the whole process tree must be gone after a force cancel.
        let sup = ProcessSupervisor::default();
        let marker = std::env::temp_dir().join(format!("cbc-orphan-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);

        // Parent sh spawns a background grandchild that would keep touching a
        // marker file if it survived.
        let script = format!(
            "( while true; do echo x >> {m}; sleep 0.05; done ) & sleep 30",
            m = marker.display()
        );
        let cancel = CancelToken::new();
        let job_id = sup.start(sh(&script), cancel.clone()).unwrap();

        std::thread::sleep(Duration::from_millis(400));
        cancel.cancel();
        let outcome = sup.wait(&job_id).unwrap();
        assert_eq!(outcome.state, JobState::Cancelled);

        // Let any survivor write, then confirm the file stops growing.
        std::thread::sleep(Duration::from_millis(300));
        let size_a = std::fs::metadata(&marker).map(|m| m.len()).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(400));
        let size_b = std::fs::metadata(&marker).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&marker);
        assert_eq!(
            size_a, size_b,
            "grandchild survived cancellation and kept writing ({size_a} -> {size_b})"
        );
    }

    #[test]
    fn tool004_large_output_does_not_explode_memory() {
        // TOOL-004: 10 MB stdout must not blow up memory; it is capped.
        let sup = ProcessSupervisor::default();
        let mut spec = sh("i=0; while [ $i -lt 20000 ]; do echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; i=$((i+1)); done");
        spec.max_output_bytes = 64 * 1024;
        spec.timeout_ms = 30_000;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.truncated, "expected truncation");
        assert!(
            outcome.stdout.len() <= 64 * 1024 + 128,
            "buffer grew to {}",
            outcome.stdout.len()
        );
        // The full byte count is still reported so the caller can spill it.
        assert!(outcome.stdout_bytes > 200_000, "{}", outcome.stdout_bytes);
        assert!(!outcome.warnings.is_empty());
    }

    #[test]
    fn rejects_invalid_cwd() {
        let sup = ProcessSupervisor::default();
        let spec = ProcessSpec::new(
            "/bin/sh",
            vec!["-c".into(), "true".into()],
            "/definitely/not/here",
        );
        let err = sup.start(spec, CancelToken::new()).unwrap_err();
        assert!(matches!(err, ProcessError::InvalidCwd { .. }));
    }

    #[test]
    fn reports_spawn_failure_for_missing_program() {
        let sup = ProcessSupervisor::default();
        let spec = ProcessSpec::new(
            "cbc-definitely-not-a-real-binary",
            vec![],
            std::env::temp_dir().to_string_lossy().to_string(),
        );
        let err = sup.start(spec, CancelToken::new()).unwrap_err();
        assert!(matches!(err, ProcessError::SpawnFailed { .. }));
    }

    #[test]
    fn writes_to_stdin() {
        let sup = ProcessSupervisor::default();
        let mut spec = sh("cat");
        spec.stdin = StdinMode::Pipe;
        let job_id = sup.start(spec, CancelToken::new()).unwrap();
        sup.write_stdin(&job_id, "from-stdin\n").unwrap();
        sup.close_stdin(&job_id).unwrap();
        let outcome = sup.wait(&job_id).unwrap();
        assert!(
            outcome.stdout.contains("from-stdin"),
            "{:?}",
            outcome.stdout
        );
    }

    #[test]
    fn enforces_concurrent_process_limit() {
        let sup = ProcessSupervisor::new(ResourceLimits {
            max_concurrent_processes: 2,
            ..DEFAULT_LIMITS
        });
        let a = sup.start(sh("sleep 5"), CancelToken::new()).unwrap();
        let b = sup.start(sh("sleep 5"), CancelToken::new()).unwrap();
        let third = sup.start(sh("sleep 5"), CancelToken::new());
        assert!(third.is_err(), "third job should be rejected");
        sup.terminate_tree(&a, 200).unwrap();
        sup.terminate_tree(&b, 200).unwrap();
    }

    #[test]
    fn status_reports_running_then_exited() {
        let sup = ProcessSupervisor::default();
        let job_id = sup.start(sh("sleep 0.3"), CancelToken::new()).unwrap();
        let (state, _) = sup.status(&job_id).unwrap();
        assert_eq!(state, JobState::Running);
        let _ = sup.wait(&job_id).unwrap();
        let (state, _) = sup.status(&job_id).unwrap();
        assert_eq!(state, JobState::Exited);
    }

    #[test]
    fn emits_output_and_exit_events() {
        let sup = ProcessSupervisor::default();
        let rx = sup.attach_events();
        let outcome = sup
            .run(sh("echo one; echo two"), CancelToken::new())
            .unwrap();
        assert!(outcome.succeeded());

        let mut outputs = 0;
        let mut exits = 0;
        while let Ok(event) = rx.try_recv() {
            match event {
                SupervisorEvent::Output(chunk) => {
                    assert_eq!(chunk.stream, OutputStream::Stdout);
                    assert!(chunk.sequence >= 1);
                    outputs += 1;
                }
                SupervisorEvent::Exited { state, .. } => {
                    assert_eq!(state, JobState::Exited);
                    exits += 1;
                }
                SupervisorEvent::LimitWarning { .. } => {}
            }
        }
        assert!(outputs >= 2, "got {outputs} output events");
        assert_eq!(exits, 1);
    }

    #[test]
    fn environment_is_filtered_by_default() {
        // §14.5: secret-looking variables must not reach the child.
        std::env::set_var("CBC_TEST_FAKE_TOKEN", "should-not-leak");
        std::env::set_var("CBC_TEST_PLAIN", "fine");
        let sup = ProcessSupervisor::default();
        let outcome = sup.run(sh("env"), CancelToken::new()).unwrap();
        assert!(
            !outcome.stdout.contains("should-not-leak"),
            "secret env leaked: {}",
            outcome.stdout
        );
        // The child really did receive an environment rather than an empty block.
        assert!(
            outcome.stdout.contains('='),
            "the child received no environment at all: {:?}",
            outcome.stdout
        );
        // §14.5 keeps the search path inheritable. Asserted against the policy
        // itself because the harness sets PATH explicitly on Windows (see
        // `try_sh`), which would make a subprocess check tautological. The name
        // used here is the one the host OS actually uses.
        let path_var = if cfg!(windows) { "Path" } else { "PATH" };
        assert!(
            env_policy::is_inheritable(&EnvPolicy::InheritSafe, path_var),
            "{path_var} should be inheritable under the safe policy"
        );
        std::env::remove_var("CBC_TEST_FAKE_TOKEN");
        std::env::remove_var("CBC_TEST_PLAIN");
    }

    #[test]
    fn explicit_env_values_are_passed_through() {
        let sup = ProcessSupervisor::default();
        let mut spec = sh("echo $CBC_EXPLICIT");
        spec.env
            .insert("CBC_EXPLICIT".into(), "explicit-value".into());
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.stdout.contains("explicit-value"));
    }

    #[test]
    fn terminate_all_clears_every_job() {
        let sup = ProcessSupervisor::default();
        sup.start(sh("sleep 10"), CancelToken::new()).unwrap();
        sup.start(sh("sleep 10"), CancelToken::new()).unwrap();
        assert_eq!(sup.active_count(), 2);
        sup.terminate_all(300);
        assert_eq!(sup.active_count(), 0);
    }

    #[test]
    fn reap_finished_removes_completed_jobs() {
        let sup = ProcessSupervisor::default();
        let job_id = sup.start(sh("true"), CancelToken::new()).unwrap();
        let _ = sup.wait(&job_id).unwrap();
        assert_eq!(sup.reap_finished(), 1);
        assert!(sup.job_ids().is_empty());
    }

    #[test]
    fn raw_shell_runs_the_script_through_the_platform_shell() {
        // P0-04: `shell.run` sends the whole script as `program`. The supervisor
        // must hand it to a real shell — the pipe below only works if something
        // interprets it, and `Command::new(script)` would instead try to exec a
        // binary literally named after the script.
        let sup = ProcessSupervisor::default();
        #[cfg(not(windows))]
        let script = "echo piped-output | tr a-z A-Z";
        #[cfg(windows)]
        let script = "echo piped-output";
        let mut spec = ProcessSpec::new(
            script,
            Vec::new(),
            std::env::temp_dir().to_string_lossy().to_string(),
        );
        spec.raw_shell = true;
        spec.timeout_ms = 15_000;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        #[cfg(not(windows))]
        assert!(
            outcome.stdout.contains("PIPED-OUTPUT"),
            "{}",
            outcome.stdout
        );
        #[cfg(windows)]
        assert!(
            outcome.stdout.contains("piped-output"),
            "{}",
            outcome.stdout
        );
    }

    #[cfg(unix)]
    #[test]
    fn newline_free_output_stays_bounded() {
        // P0-04: 20 MiB with no newline must not accumulate in one Vec; the
        // capture stays under the collector cap plus one synthetic chunk.
        let sup = ProcessSupervisor::default();
        let mut spec = sh("head -c 20971520 /dev/zero | tr '\\0' 'x'");
        spec.timeout_ms = 60_000;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        let cap = DEFAULT_MAX_CAPTURED_BYTES + MAX_PENDING_LINE_BYTES;
        assert!(
            outcome.stdout.len() <= cap,
            "captured {} bytes, expected at most {cap}",
            outcome.stdout.len()
        );
        assert!(outcome.stdout.len() >= DEFAULT_MAX_CAPTURED_BYTES / 2);
    }

    // ------------------------------------------------------------------
    // P0-04: real enforcement regression tests
    // ------------------------------------------------------------------

    /// Network deny must leave the child with nothing but a down loopback.
    /// This is a fact about the namespace itself, independent of whether the
    /// host has outbound connectivity. Only meaningful when the namespace
    /// backend (not the seccomp fallback) enforces the deny.
    #[cfg(target_os = "linux")]
    #[test]
    fn network_deny_isolates_the_child() {
        if cbc_sandbox::enforce::network_deny_backend()
            != cbc_sandbox::enforce::NetworkDenyBackend::Netns
        {
            eprintln!("skipping: this host denies network via seccomp, not a namespace");
            return;
        }
        let sup = ProcessSupervisor::default();
        let mut spec = sh("cat /proc/net/dev; cat /sys/class/net/lo/operstate");
        spec.network = NetworkMode::Deny;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        // The only interface listed is loopback...
        let interfaces: Vec<&str> = outcome
            .stdout
            .lines()
            .filter_map(|line| line.split(':').next())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        assert_eq!(
            interfaces,
            vec!["lo"],
            "the denied child must see no real interface: {}",
            outcome.stdout
        );
        // ...and it is not even up.
        assert!(
            outcome.stdout.contains("down"),
            "loopback must stay down in a fresh netns: {}",
            outcome.stdout
        );
    }

    /// A denied child must not be able to open an outbound socket.
    #[cfg(target_os = "linux")]
    #[test]
    fn network_deny_blocks_outbound_connect() {
        if !cbc_sandbox::network_deny_available() {
            eprintln!("skipping: no network-isolation backend on this host");
            return;
        }
        if std::path::Path::new("/usr/bin/python3").exists() {
            let sup = ProcessSupervisor::default();
            let mut spec = ProcessSpec::new(
                "/usr/bin/python3",
                vec![
                    "-c".into(),
                    "import socket; s=socket.socket(); s.settimeout(3); \
                     s.connect(('93.184.216.34', 80)); print('connected')"
                        .into(),
                ],
                std::env::temp_dir().to_string_lossy().to_string(),
            );
            spec.network = NetworkMode::Deny;
            let outcome = sup.run(spec, CancelToken::new()).unwrap();
            assert!(
                !outcome.succeeded(),
                "connect must fail inside the denied namespace: {outcome:?}"
            );
            assert!(!outcome.stdout.contains("connected"));
        } else {
            // Shell fallback: bash's /dev/tcp probe.
            let sup = ProcessSupervisor::default();
            let mut spec = ProcessSpec::new(
                "/usr/bin/bash",
                vec![
                    "-c".into(),
                    "timeout 5 bash -c 'echo > /dev/tcp/93.184.216.34/80' && echo connected".into(),
                ],
                std::env::temp_dir().to_string_lossy().to_string(),
            );
            spec.network = NetworkMode::Deny;
            let outcome = sup.run(spec, CancelToken::new()).unwrap();
            assert!(
                !outcome.stdout.contains("connected"),
                "network was reachable inside a denied namespace: {outcome:?}"
            );
        }
    }

    /// The default network mode keeps the host's namespace.
    #[cfg(target_os = "linux")]
    #[test]
    fn network_inherit_keeps_the_host_namespace() {
        let sup = ProcessSupervisor::default();
        let mut spec = sh("cat /proc/net/dev | grep -c ':'");
        spec.network = NetworkMode::Inherit;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        // Same count as the parent sees.
        let parent = std::fs::read_to_string("/proc/net/dev").unwrap_or_default();
        let parent_ifaces = parent.lines().filter(|l| l.contains(':')).count();
        let child_ifaces: usize = outcome.stdout.trim().parse().unwrap_or(0);
        assert_eq!(child_ifaces, parent_ifaces, "{outcome:?}");
    }

    /// A Landlock-confined child can write inside its allowlisted root and
    /// nowhere else.
    #[cfg(target_os = "linux")]
    #[test]
    fn landlock_confines_writes_to_the_allowlist() {
        if !cbc_sandbox::filesystem_isolation_available() {
            eprintln!("skipping: no filesystem-isolation backend on this host");
            return;
        }

        let inside = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let outside_file = outside.path().join("probe.txt");

        let sup = ProcessSupervisor::default();
        let script = format!(
            "echo in > {inside}/ok.txt && echo inside-ok; \
             echo out > {outside}/probe.txt && echo outside-wrote || echo outside-blocked",
            inside = inside.path().display(),
            outside = outside.path().display(),
        );
        let mut spec = try_sh(&script).expect("posix shell");
        spec.cwd = inside.path().to_string_lossy().to_string();
        spec.sandbox = Some(SandboxPolicy {
            writable_roots: vec![inside.path().to_string_lossy().to_string()],
            readable_roots: default_test_readable_roots(),
        });
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        assert!(
            outcome.stdout.contains("inside-ok"),
            "allowlisted write must succeed: {outcome:?}"
        );
        assert!(
            outcome.stdout.contains("outside-blocked"),
            "writes outside the allowlist must fail: {outcome:?}"
        );
        assert!(inside.path().join("ok.txt").exists());
        assert!(!outside_file.exists());
    }

    /// Reads outside the allowlist are denied as well.
    #[cfg(target_os = "linux")]
    #[test]
    fn landlock_denies_reads_outside_the_allowlist() {
        if !cbc_sandbox::filesystem_isolation_available() {
            eprintln!("skipping: no filesystem-isolation backend on this host");
            return;
        }

        let inside = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "top-secret\n").unwrap();

        let sup = ProcessSupervisor::default();
        let script = format!(
            "cat {secret} >/dev/null 2>&1 && echo readable || echo unreadable",
            secret = secret.display(),
        );
        let mut spec = try_sh(&script).expect("posix shell");
        spec.cwd = inside.path().to_string_lossy().to_string();
        spec.sandbox = Some(SandboxPolicy {
            writable_roots: vec![inside.path().to_string_lossy().to_string()],
            readable_roots: default_test_readable_roots(),
        });
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        assert!(
            outcome.stdout.contains("unreadable"),
            "the confined child must not read outside its roots: {outcome:?}"
        );
    }

    /// System roots a confined shell needs to function at all.
    #[cfg(target_os = "linux")]
    fn default_test_readable_roots() -> Vec<String> {
        [
            "/usr",
            "/bin",
            "/sbin",
            "/lib",
            "/lib64",
            "/etc",
            "/proc",
            "/dev/null",
            "/dev/urandom",
            "/dev/random",
            "/dev/tty",
        ]
        .iter()
        .map(|p| p.to_string())
        .collect()
    }

    /// `StdinMode::Pty` must allocate a real PTY: the child sees a terminal
    /// device as its stdio.
    #[cfg(unix)]
    #[test]
    fn pty_allocates_a_real_terminal() {
        if !pty_supported() {
            return;
        }
        let sup = ProcessSupervisor::default();
        let mut spec = sh("tty; test -t 0 && echo stdin-is-tty; test -t 1 && echo stdout-is-tty");
        spec.stdin = StdinMode::Pty;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        assert!(
            outcome.stdout.contains("/dev/pts/"),
            "expected a real pty device: {outcome:?}"
        );
        assert!(outcome.stdout.contains("stdin-is-tty"));
        assert!(outcome.stdout.contains("stdout-is-tty"));
    }

    /// PTY input and output travel through the master.
    #[cfg(unix)]
    #[test]
    fn pty_round_trips_stdin_to_stdout() {
        if !pty_supported() {
            return;
        }
        let sup = ProcessSupervisor::default();
        let mut spec = sh("cat");
        spec.stdin = StdinMode::Pty;
        let job_id = sup.start(spec, CancelToken::new()).unwrap();
        sup.write_stdin(&job_id, "hello-pty\n").unwrap();
        sup.close_stdin(&job_id).unwrap();
        let outcome = sup.wait(&job_id).unwrap();
        assert!(outcome.stdout.contains("hello-pty"), "{outcome:?}");
        // stderr merges into the terminal stream; it must not carry anything.
        assert!(outcome.stderr.is_empty());
    }

    /// The window size set at allocation is visible to the child.
    #[cfg(unix)]
    #[test]
    fn pty_reports_the_allocated_window_size() {
        if !pty_supported() {
            return;
        }
        let sup = ProcessSupervisor::default();
        let mut spec = sh("stty size");
        spec.stdin = StdinMode::Pty;
        let outcome = sup.run(spec, CancelToken::new()).unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        assert_eq!(outcome.stdout.trim(), "50 200", "{outcome:?}");
    }

    // ------------------------------------------------------------------
    // fixtures/process-trees — §25.9 shared regression scripts
    // ------------------------------------------------------------------

    #[cfg(unix)]
    fn fixture_script(name: &str) -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/process-trees")
            .join(name);
        if path.exists() {
            Some(path.to_string_lossy().to_string())
        } else {
            None
        }
    }

    /// PID liveness: `kill(pid, 0)` succeeds only while the process exists.
    #[cfg(unix)]
    fn pid_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 || *libc::__errno_location() != libc::ESRCH }
    }

    #[cfg(unix)]
    fn parse_fixture_pids(stdout: &str) -> Vec<i32> {
        stdout
            .lines()
            .filter_map(|line| {
                let (_, value) = line.split_once('=')?;
                value.trim().parse::<i32>().ok()
            })
            .collect()
    }

    /// RT-001 via the shared fixture: after cancellation, every printed PID
    /// in the tree must be gone — orphan count zero.
    #[cfg(unix)]
    #[test]
    fn fixture_spawn_grandchild_leaves_no_orphans() {
        let Some(script) = fixture_script("spawn-grandchild.sh") else {
            eprintln!("skipping: fixture not found");
            return;
        };
        let sup = ProcessSupervisor::default();
        let mut spec = ProcessSpec::new(
            "/bin/sh",
            vec![script],
            std::env::temp_dir().to_string_lossy().to_string(),
        );
        spec.timeout_ms = 30_000;
        let cancel = CancelToken::new();
        let job_id = sup.start(spec, cancel.clone()).unwrap();

        // Give the tree time to grow before cancelling it.
        std::thread::sleep(Duration::from_millis(800));
        let pids = {
            let jobs = sup.jobs.lock().expect("jobs lock");
            let job = jobs.get(&job_id).expect("job");
            let stdout = job.stdout_collector.lock().expect("stdout").buffer.clone();
            parse_fixture_pids(&stdout)
        };
        assert!(
            pids.len() >= 3,
            "expected parent/child/grandchild pids from the fixture, got {pids:?}"
        );

        cancel.cancel();
        let outcome = sup.wait(&job_id).unwrap();
        assert_eq!(outcome.state, JobState::Cancelled);

        std::thread::sleep(Duration::from_millis(200));
        for pid in &pids {
            assert!(!pid_alive(*pid), "pid {pid} survived cancellation");
        }
    }

    /// §7.7 via the shared fixture: a SIGTERM-ignoring process must still die
    /// once the grace period expires (the hard kill must follow the soft one).
    #[cfg(unix)]
    #[test]
    fn fixture_ignores_sigterm_is_killed_after_grace() {
        let Some(script) = fixture_script("ignores-sigterm.sh") else {
            eprintln!("skipping: fixture not found");
            return;
        };
        let sup = ProcessSupervisor::default();
        let mut spec = ProcessSpec::new(
            "/bin/sh",
            vec![script],
            std::env::temp_dir().to_string_lossy().to_string(),
        );
        spec.timeout_ms = 30_000;
        let job_id = sup.start(spec, CancelToken::new()).unwrap();
        std::thread::sleep(Duration::from_millis(500));

        let start = Instant::now();
        sup.terminate_tree(&job_id, 500).unwrap();
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "grace kill took {:?}",
            start.elapsed()
        );

        let (_state, _) = sup.status(&job_id).unwrap();
        let mut outcome_jobs = sup.jobs.lock().expect("jobs lock");
        let job = outcome_jobs.get_mut(&job_id).expect("job");
        assert!(
            matches!(job.child.try_wait(), Ok(Some(_))),
            "the TERM-ignoring process must be reaped after SIGKILL"
        );
    }
}
