//! `cbc-session-store` — durable, event-sourced session state — PRD §18.6,
//! §18.14–§18.18, §20.9, AC-35, AC-46.
//!
//! Storage is SQLite in WAL mode. §18.15 requires foreign keys, a unique
//! `(session_id, sequence)`, event append and state transition in one DB
//! transaction, UTC timestamps, schema-versioned JSON payloads,
//! workspace-relative paths, and *no* credential values in any table.
//!
//! §18.16 defines the integrity chain:
//! ```text
//! event_hash = SHA-256(schema_version || sequence || kind || payload || prev_hash)
//! ```
//! This detects partial writes, truncation, and out-of-order corruption. It is
//! explicitly *not* a claim of cryptographic authenticity against a local
//! administrator.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod migrations;

pub use migrations::{apply_migrations, CURRENT_SCHEMA_VERSION, MIGRATIONS};

/// Snapshot cadence defaults from §18.16.
pub const SNAPSHOT_EVERY_EVENTS: u64 = 100;
pub const SNAPSHOT_STATE_DELTA_BYTES: usize = 2 * 1024 * 1024;

/// P2 snapshot envelope contract. Version zero is reserved for rows written by
/// pre-envelope builds; new writes always use version one.
pub const SNAPSHOT_ENVELOPE_VERSION: u32 = 1;

/// Runtime-friendly journal page defaults. The maximum stays below the 8 MiB RPC
/// frame ceiling after response metadata and JSON escaping are added.
pub const DEFAULT_EVENT_PAGE_BYTES: usize = 1 * 1024 * 1024;
pub const MAX_EVENT_PAGE_BYTES: usize = 6 * 1024 * 1024;
pub const DEFAULT_EVENT_PAGE_ITEMS: usize = 64;
pub const MAX_EVENT_PAGE_ITEMS: usize = 10_000;

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    /// The event chain broke at this sequence (§18.16).
    IntegrityBreak {
        session_id: String,
        sequence: i64,
        expected_prev: String,
        actual_prev: String,
    },
    SequenceGap {
        session_id: String,
        expected: i64,
        actual: i64,
    },
    NotFound {
        what: String,
    },
    /// A newer on-disk schema cannot be opened by this binary (§18.18).
    SchemaTooNew {
        found: i64,
        supported: i64,
    },
    CredentialRejected {
        field: String,
    },
    /// P0-06: the payload exceeds the protocol's event size ceiling. Enforced at
    /// append time, not later, so an oversized event never partially lands.
    PayloadTooLarge {
        bytes: usize,
        max: usize,
    },
    InvalidPageRequest {
        detail: String,
    },
    BoundaryMismatch {
        sequence: i64,
        expected: String,
        actual: String,
    },
    UnsupportedSnapshotVersion {
        found: u32,
        supported: u32,
    },
    InvalidSnapshot {
        detail: String,
    },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "sqlite error: {e}"),
            StoreError::Json(e) => write!(f, "json error: {e}"),
            StoreError::IntegrityBreak {
                session_id,
                sequence,
                expected_prev,
                actual_prev,
            } => write!(
                f,
                "event chain broken in {session_id} at sequence {sequence}: expected prev {expected_prev}, found {actual_prev}"
            ),
            StoreError::SequenceGap {
                session_id,
                expected,
                actual,
            } => write!(
                f,
                "sequence gap in {session_id}: expected {expected}, found {actual}"
            ),
            StoreError::NotFound { what } => write!(f, "not found: {what}"),
            StoreError::SchemaTooNew { found, supported } => write!(
                f,
                "database schema version {found} is newer than the supported version {supported}; upgrade cbc or open read-only"
            ),
            StoreError::CredentialRejected { field } => write!(
                f,
                "refusing to persist credential-like field '{field}' in the session store"
            ),
            StoreError::PayloadTooLarge { bytes, max } => write!(
                f,
                "event payload of {bytes} bytes exceeds the {max} byte journal limit"
            ),
            StoreError::InvalidPageRequest { detail } => {
                write!(f, "invalid journal page request: {detail}")
            }
            StoreError::BoundaryMismatch {
                sequence,
                expected,
                actual,
            } => write!(
                f,
                "journal boundary mismatch at sequence {sequence}: expected {expected}, found {actual}"
            ),
            StoreError::UnsupportedSnapshotVersion { found, supported } => write!(
                f,
                "snapshot envelope version {found} is unsupported; this binary supports version {supported}"
            ),
            StoreError::InvalidSnapshot { detail } => {
                write!(f, "invalid snapshot envelope: {detail}")
            }
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

/// Genesis value for the hash chain.
pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// P0-06: the §20.4 event payload ceiling, enforced at append time.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 1024 * 1024;

/// §18.16 event hash.
pub fn compute_event_hash(
    schema_version: &str,
    sequence: i64,
    kind: &str,
    payload: &str,
    prev_hash: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(schema_version.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(sequence.to_string().as_bytes());
    hasher.update(b"\x1f");
    hasher.update(kind.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(payload.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(prev_hash.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub session_id: String,
    pub sequence: i64,
    pub id: String,
    pub kind: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub level: String,
    pub visibility: String,
    pub schema_version: String,
    /// JSON payload as stored.
    pub payload: serde_json::Value,
    pub prev_hash: String,
    pub event_hash: String,
    /// P0-06: the client's envelope sequence, preserved alongside the store's own
    /// journal sequence so resume can reconcile the two.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_sequence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_epoch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_identity_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

/// A stable hash-chain position. Sequence zero is the genesis boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JournalBoundary {
    pub sequence: i64,
    pub event_hash: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EventPageDirection {
    Forward,
    Backward,
}

/// P2 page request. `after_sequence` and `before_sequence` are exclusive
/// anchors and therefore mutually exclusive. `through_sequence` freezes a
/// forward walk at the head observed by its first page.
#[derive(Debug, Clone)]
pub struct EventPageRequest {
    pub after_sequence: Option<i64>,
    pub before_sequence: Option<i64>,
    pub anchor_hash: Option<String>,
    pub through_sequence: Option<i64>,
    pub through_hash: Option<String>,
    pub limit: usize,
    pub max_bytes: usize,
}

impl Default for EventPageRequest {
    fn default() -> Self {
        Self {
            after_sequence: Some(0),
            before_sequence: None,
            anchor_hash: None,
            through_sequence: None,
            through_hash: None,
            limit: DEFAULT_EVENT_PAGE_ITEMS,
            max_bytes: DEFAULT_EVENT_PAGE_BYTES,
        }
    }
}

/// Page metadata is deliberately redundant: a caller can verify both the
/// returned chain segment and the frozen journal head before merging it into a
/// resident window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventPageInfo {
    pub direction: EventPageDirection,
    pub anchor_sequence: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_sequence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_prev_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sequence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_hash: Option<String>,
    pub through: JournalBoundary,
    pub journal_head: JournalBoundary,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub encoded_bytes: usize,
    pub max_bytes: usize,
    pub item_limit: usize,
    pub truncated_by_bytes: bool,
    pub oversized_single_event: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<StoredEvent>,
    pub page: EventPageInfo,
}

/// Versioned snapshot RPC/storage envelope. The two sequence domains are never
/// aliases: journal_sequence is the dense durable DB position, whereas
/// stream_sequence is the highest protocol event sequence and may contain gaps
/// for ephemeral events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEnvelope {
    pub snapshot_version: u32,
    pub session_id: String,
    pub journal_sequence: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journal_hash: Option<String>,
    pub reducer_state: serde_json::Value,
}

impl SnapshotEnvelope {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.snapshot_version != SNAPSHOT_ENVELOPE_VERSION {
            return Err(StoreError::UnsupportedSnapshotVersion {
                found: self.snapshot_version,
                supported: SNAPSHOT_ENVELOPE_VERSION,
            });
        }
        if self.session_id.trim().is_empty() {
            return Err(StoreError::InvalidSnapshot {
                detail: "sessionId must not be empty".into(),
            });
        }
        if self.journal_sequence < 0 {
            return Err(StoreError::InvalidSnapshot {
                detail: "journalSequence must be non-negative".into(),
            });
        }
        if self.stream_sequence.is_some_and(|sequence| sequence < 0) {
            return Err(StoreError::InvalidSnapshot {
                detail: "streamSequence must be non-negative".into(),
            });
        }
        if self
            .stream_sequence
            .is_some_and(|sequence| sequence < self.journal_sequence)
        {
            return Err(StoreError::InvalidSnapshot {
                detail: "streamSequence cannot precede journalSequence".into(),
            });
        }
        if !self.reducer_state.is_object() {
            return Err(StoreError::InvalidSnapshot {
                detail: "reducerState must be a JSON object".into(),
            });
        }
        if let Some(state_session_id) = self
            .reducer_state
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
        {
            if state_session_id != self.session_id {
                return Err(StoreError::InvalidSnapshot {
                    detail: "reducerState.sessionId does not match envelope sessionId".into(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSnapshot {
    #[serde(flatten)]
    pub envelope: SnapshotEnvelope,
    pub checksum: String,
    pub created_at: String,
    /// True only for a pre-envelope row whose reducer-state checksum was
    /// validated and upgraded in memory.
    pub legacy: bool,
}

/// Event to append. `sequence`, `prev_hash`, and `event_hash` are assigned by
/// the store so the caller cannot fabricate a chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEvent {
    pub id: String,
    pub kind: String,
    pub timestamp: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default = "default_level")]
    pub level: String,
    #[serde(default = "default_visibility")]
    pub visibility: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: String,
    pub payload: serde_json::Value,
    /// P0-06 lineage: the envelope fields the v1.3 contract requires to survive
    /// a resume.
    #[serde(default)]
    pub stream_sequence: Option<i64>,
    #[serde(default)]
    pub caller_id: Option<String>,
    #[serde(default)]
    pub task_epoch_id: Option<String>,
    #[serde(default)]
    pub workspace_identity_digest: Option<String>,
    #[serde(default)]
    pub parent_event_id: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
}

fn default_level() -> String {
    "info".into()
}
fn default_visibility() -> String {
    "timeline".into()
}
fn default_schema_version() -> String {
    "1.0".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Completed,
    Interrupted,
    Archived,
}

impl SessionStatus {
    pub fn label(&self) -> &'static str {
        match self {
            SessionStatus::Active => "active",
            SessionStatus::Completed => "completed",
            SessionStatus::Interrupted => "interrupted",
            SessionStatus::Archived => "archived",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "completed" => SessionStatus::Completed,
            "interrupted" => SessionStatus::Interrupted,
            "archived" => SessionStatus::Archived,
            _ => SessionStatus::Active,
        }
    }
}

/// Session manifest — §18.7.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub schema_version: String,
    pub id: String,
    pub workspace_path: String,
    pub workspace_fingerprint: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub model_profile: String,
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub last_event_sequence: i64,
    pub state: SessionStatus,
    /// Number of completed turns, maintained by the store itself (P0-05) so the
    /// session list never depends on a host-side index.
    #[serde(default)]
    pub turn_count: i64,
}

/// Integrity verification outcome for `cbc doctor --storage` and startup replay.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub session_id: String,
    pub events_verified: i64,
    pub last_valid_sequence: i64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub break_detail: Option<String>,
}

pub struct SessionStore {
    conn: Connection,
    path: PathBuf,
    read_only: bool,
}

impl SessionStore {
    /// Open (creating if needed) the store at `<data_dir>/state.sqlite3`.
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(data_dir).map_err(|e| {
            StoreError::Sqlite(rusqlite::Error::InvalidPath(PathBuf::from(e.to_string())))
        })?;
        restrict_dir(data_dir);
        let path = data_dir.join("state.sqlite3");
        let conn = Connection::open(&path)?;
        Self::configure(&conn)?;
        let mut store = Self {
            conn,
            path,
            read_only: false,
        };
        store.migrate()?;
        restrict_file(&store.path);
        Ok(store)
    }

    /// In-memory store for tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn)?;
        let mut store = Self {
            conn,
            path: PathBuf::from(":memory:"),
            read_only: false,
        };
        store.migrate()?;
        Ok(store)
    }

    fn configure(conn: &Connection) -> Result<(), StoreError> {
        // §18.15: foreign keys enabled; WAL mode for durability + concurrency.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        Ok(())
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        let found = current_version(&self.conn)?;
        if found > CURRENT_SCHEMA_VERSION {
            // §18.18: opening a newer schema with an older binary must be
            // read-only or an explicit incompatibility error.
            self.read_only = true;
            return Err(StoreError::SchemaTooNew {
                found,
                supported: CURRENT_SCHEMA_VERSION,
            });
        }
        apply_migrations(&mut self.conn)?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        current_version(&self.conn)
    }

    /// Register (or refresh) a workspace row and return its id.
    pub fn upsert_workspace(
        &self,
        canonical_path_hash: &str,
        trust_state: &str,
        now: &str,
    ) -> Result<i64, StoreError> {
        self.conn.execute(
            "INSERT INTO workspaces (canonical_path_hash, trust_state, last_seen)
              VALUES (?1, ?2, ?3)
              ON CONFLICT(canonical_path_hash) DO UPDATE SET
                trust_state = excluded.trust_state,
                last_seen = excluded.last_seen",
            params![canonical_path_hash, trust_state, now],
        )?;
        let id: i64 = self.conn.query_row(
            "SELECT id FROM workspaces WHERE canonical_path_hash = ?1",
            params![canonical_path_hash],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn update_session_title(
        &self,
        session_id: &str,
        title: &str,
        now: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![session_id, title, now],
        )?;
        Ok(())
    }

    /// Create a session row.
    pub fn create_session(&self, manifest: &SessionManifest) -> Result<(), StoreError> {
        let workspace_id = self.upsert_workspace(
            &manifest.workspace_fingerprint,
            "unknown",
            &manifest.created_at,
        )?;
        self.conn.execute(
            "INSERT INTO sessions (
                id, workspace_id, title, status, model_profile, permission_mode,
                workspace_path, parent_session_id, schema_version,
                created_at, updated_at, last_event_sequence, turn_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0)",
            params![
                manifest.id,
                workspace_id,
                manifest.title,
                manifest.state.label(),
                manifest.model_profile,
                manifest.permission_mode,
                manifest.workspace_path,
                manifest.parent_session_id,
                manifest.schema_version,
                manifest.created_at,
                manifest.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn load_manifest(&self, session_id: &str) -> Result<SessionManifest, StoreError> {
        let manifest = self
            .conn
            .query_row(
                "SELECT s.id, s.workspace_path, w.canonical_path_hash, s.created_at,
                        s.updated_at, s.title, s.model_profile, s.permission_mode,
                        s.parent_session_id, s.last_event_sequence, s.status, s.schema_version,
                        s.turn_count
                 FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
                 WHERE s.id = ?1",
                params![session_id],
                |row| {
                    Ok(SessionManifest {
                        id: row.get(0)?,
                        workspace_path: row.get(1)?,
                        workspace_fingerprint: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        title: row.get(5)?,
                        model_profile: row.get(6)?,
                        permission_mode: row.get(7)?,
                        interaction_mode: None,
                        permission_preset: None,
                        plan_revision: None,
                        parent_session_id: row.get(8)?,
                        last_event_sequence: row.get(9)?,
                        state: SessionStatus::parse(&row.get::<_, String>(10)?),
                        schema_version: row.get(11)?,
                        turn_count: row.get(12)?,
                    })
                },
            )
            .optional()?;
        manifest.ok_or(StoreError::NotFound {
            what: format!("session {session_id}"),
        })
    }

    fn manifest_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionManifest> {
        Ok(SessionManifest {
            id: row.get(0)?,
            workspace_path: row.get(1)?,
            workspace_fingerprint: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            title: row.get(5)?,
            model_profile: row.get(6)?,
            permission_mode: row.get(7)?,
            interaction_mode: None,
            permission_preset: None,
            plan_revision: None,
            parent_session_id: row.get(8)?,
            last_event_sequence: row.get(9)?,
            state: SessionStatus::parse(&row.get::<_, String>(10)?),
            schema_version: row.get(11)?,
            turn_count: row.get(12)?,
        })
    }

    const MANIFEST_COLUMNS: &'static str =
        "SELECT s.id, s.workspace_path, w.canonical_path_hash, s.created_at,
                    s.updated_at, s.title, s.model_profile, s.permission_mode,
                    s.parent_session_id, s.last_event_sequence, s.status, s.schema_version,
                    s.turn_count
             FROM sessions s JOIN workspaces w ON w.id = s.workspace_id";

    /// List sessions, newest first.
    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SessionManifest>, StoreError> {
        let sql = format!(
            "{} ORDER BY s.updated_at DESC LIMIT ?1",
            Self::MANIFEST_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit as i64], Self::manifest_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Non-archived sessions, newest first. Logical deletion uses this query so
    /// archived rows do not consume the caller's limit.
    pub fn list_visible_sessions(&self, limit: usize) -> Result<Vec<SessionManifest>, StoreError> {
        let sql = format!(
            "{} WHERE s.status <> 'archived' ORDER BY s.updated_at DESC LIMIT ?1",
            Self::MANIFEST_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit as i64], Self::manifest_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Sessions for one workspace (by its fingerprint), newest first. P0-05: the
    /// CLI lists only the workspace it runs in, so a session from another
    /// repository can never be resumed or deleted by mistake.
    pub fn list_sessions_for_workspace(
        &self,
        workspace_fingerprint: &str,
        limit: usize,
    ) -> Result<Vec<SessionManifest>, StoreError> {
        let sql = format!(
            "{} WHERE w.canonical_path_hash = ?1 ORDER BY s.updated_at DESC LIMIT ?2",
            Self::MANIFEST_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![workspace_fingerprint, limit as i64],
            Self::manifest_from_row,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn list_visible_sessions_for_workspace(
        &self,
        workspace_fingerprint: &str,
        limit: usize,
    ) -> Result<Vec<SessionManifest>, StoreError> {
        let sql = format!(
            "{} WHERE w.canonical_path_hash = ?1 AND s.status <> 'archived'
             ORDER BY s.updated_at DESC LIMIT ?2",
            Self::MANIFEST_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![workspace_fingerprint, limit as i64],
            Self::manifest_from_row,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Resolve a session selector inside one workspace: exact id, then title, then a
    /// unique prefix. `None` when nothing (or more than one session) matches.
    pub fn resolve_session_id(
        &self,
        workspace_fingerprint: &str,
        selector: &str,
    ) -> Result<Option<String>, StoreError> {
        let sessions = self.list_visible_sessions_for_workspace(workspace_fingerprint, 10_000)?;
        if selector == "last" {
            return Ok(sessions.first().map(|s| s.id.clone()));
        }
        if let Some(exact) = sessions.iter().find(|s| s.id == selector) {
            return Ok(Some(exact.id.clone()));
        }
        if let Some(by_title) = sessions.iter().find(|s| s.title == selector) {
            return Ok(Some(by_title.id.clone()));
        }
        let mut matches = sessions
            .iter()
            .filter(|s| s.id.starts_with(selector) || s.title.starts_with(selector))
            .map(|s| s.id.clone());
        let first = matches.next();
        match (first, matches.next()) {
            (Some(id), None) => Ok(Some(id)),
            _ => Ok(None),
        }
    }

    /// §18.12 fork: copy the whole journal into a brand-new session that records
    /// its parent (§18.7 lineage). The copy re-chains event hashes through the
    /// normal append path, so the fork has its own valid integrity chain.
    pub fn fork_session(
        &mut self,
        source_id: &str,
        new_id: &str,
        title: &str,
        now: &str,
    ) -> Result<SessionManifest, StoreError> {
        let source = self.load_manifest(source_id)?;
        let forked = SessionManifest {
            schema_version: source.schema_version.clone(),
            id: new_id.to_string(),
            workspace_path: source.workspace_path.clone(),
            workspace_fingerprint: source.workspace_fingerprint.clone(),
            created_at: now.to_string(),
            updated_at: now.to_string(),
            title: title.to_string(),
            model_profile: source.model_profile.clone(),
            permission_mode: source.permission_mode.clone(),
            interaction_mode: source.interaction_mode.clone(),
            permission_preset: source.permission_preset.clone(),
            plan_revision: source.plan_revision,
            parent_session_id: Some(source_id.to_string()),
            last_event_sequence: 0,
            state: SessionStatus::Active,
            turn_count: source.turn_count,
        };
        self.create_session_with_parent(&forked)?;

        let events = self.read_events(source_id, 0, usize::MAX)?;
        for event in &events {
            self.append_event(
                new_id,
                &AppendEvent {
                    id: event.id.clone(),
                    kind: event.kind.clone(),
                    timestamp: event.timestamp.clone(),
                    turn_id: event.turn_id.clone(),
                    agent_id: event.agent_id.clone(),
                    level: event.level.clone(),
                    visibility: event.visibility.clone(),
                    schema_version: event.schema_version.clone(),
                    payload: event.payload.clone(),
                    stream_sequence: event.stream_sequence,
                    caller_id: event.caller_id.clone(),
                    task_epoch_id: event.task_epoch_id.clone(),
                    workspace_identity_digest: event.workspace_identity_digest.clone(),
                    parent_event_id: event.parent_event_id.clone(),
                    correlation_id: event.correlation_id.clone(),
                },
            )?;
        }

        self.load_manifest(new_id)
    }

    /// Create the session row for a fork, inheriting the parent's workspace row.
    /// `turn_count` starts at zero: copying the journal replays every
    /// `turn.completed` through `append_event`, which tallies it again.
    fn create_session_with_parent(&self, manifest: &SessionManifest) -> Result<(), StoreError> {
        let workspace_id = self.upsert_workspace(
            &manifest.workspace_fingerprint,
            "unknown",
            &manifest.created_at,
        )?;
        self.conn.execute(
            "INSERT INTO sessions (
                id, workspace_id, title, status, model_profile, permission_mode,
                workspace_path, parent_session_id, schema_version,
                created_at, updated_at, last_event_sequence, turn_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0)",
            params![
                manifest.id,
                workspace_id,
                manifest.title,
                manifest.state.label(),
                manifest.model_profile,
                manifest.permission_mode,
                manifest.workspace_path,
                manifest.parent_session_id,
                manifest.schema_version,
                manifest.created_at,
                manifest.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn set_session_status(
        &self,
        session_id: &str,
        status: SessionStatus,
        now: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE sessions SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![session_id, status.label(), now],
        )?;
        Ok(())
    }

    /// Append a batch atomically. §20.9: every returned event is durable once
    /// this returns, and §18.15 requires the journal rows plus session transitions
    /// to share one DB transaction.
    ///
    /// Payload validation happens before opening the transaction. Within the batch,
    /// hashes and store-assigned sequences are calculated in input order. Existing
    /// ids remain idempotent, including a retry of a formerly partial RPC.
    pub fn append_events(
        &mut self,
        session_id: &str,
        events: &[AppendEvent],
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let mut prepared = Vec::with_capacity(events.len());
        for event in events {
            reject_credential_payload(&event.payload)?;
            let payload_json = serde_json::to_string(&event.payload)?;
            if payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
                return Err(StoreError::PayloadTooLarge {
                    bytes: payload_json.len(),
                    max: MAX_EVENT_PAYLOAD_BYTES,
                });
            }
            prepared.push((event, payload_json));
        }
        if prepared.is_empty() {
            return Ok(Vec::new());
        }

        let tx = self.conn.transaction()?;
        let mut stored_events = Vec::with_capacity(prepared.len());
        let (mut last_sequence, mut chain_hash): (i64, String) = tx
            .query_row(
                "SELECT sequence, event_hash FROM events
                 WHERE session_id = ?1 ORDER BY sequence DESC LIMIT 1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, GENESIS_HASH.to_string()));

        for (event, payload_json) in prepared {
            // Idempotent append: an event id that already landed is returned as-is.
            if let Some(existing) = tx
                .query_row(
                    &format!(
                        "SELECT {EVENT_COLUMNS} FROM events WHERE session_id = ?1 AND id = ?2"
                    ),
                    params![session_id, event.id],
                    |row| read_stored_event_row(row, session_id),
                )
                .optional()?
            {
                stored_events.push(existing);
                continue;
            }

            let sequence = last_sequence + 1;
            let event_prev_hash = chain_hash.clone();
            let event_hash = compute_event_hash(
                &event.schema_version,
                sequence,
                &event.kind,
                &payload_json,
                &event_prev_hash,
            );

            tx.execute(
                "INSERT INTO events (
                    session_id, sequence, id, kind, timestamp, turn_id, agent_id,
                    level, visibility, schema_version, payload, prev_hash, event_hash,
                    stream_sequence, caller_id, task_epoch_id, workspace_identity_digest,
                    parent_event_id, correlation_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                           ?14, ?15, ?16, ?17, ?18, ?19)",
                params![
                    session_id,
                    sequence,
                    event.id,
                    event.kind,
                    event.timestamp,
                    event.turn_id,
                    event.agent_id,
                    event.level,
                    event.visibility,
                    event.schema_version,
                    payload_json,
                    event_prev_hash,
                    event_hash,
                    event.stream_sequence,
                    event.caller_id,
                    event.task_epoch_id,
                    event.workspace_identity_digest,
                    event.parent_event_id,
                    event.correlation_id,
                ],
            )?;
            tx.execute(
                "UPDATE sessions SET last_event_sequence = ?2, updated_at = ?3,
                    turn_count = turn_count + CASE ?4 WHEN 'turn.completed' THEN 1 ELSE 0 END
                  WHERE id = ?1",
                params![session_id, sequence, event.timestamp, event.kind],
            )?;
            if event.kind == "user.message" {
                let title = derive_session_title(&event.payload);
                if let Some(t) = title {
                    let current: String = tx.query_row(
                        "SELECT title FROM sessions WHERE id = ?1",
                        params![session_id],
                        |row| row.get(0),
                    )?;
                    if current == "Untitled session" || current.trim().is_empty() {
                        tx.execute(
                            "UPDATE sessions SET title = ?2 WHERE id = ?1",
                            params![session_id, t],
                        )?;
                    }
                }
            }

            last_sequence = sequence;
            chain_hash = event_hash.clone();
            stored_events.push(StoredEvent {
                session_id: session_id.to_string(),
                sequence,
                id: event.id.clone(),
                kind: event.kind.clone(),
                timestamp: event.timestamp.clone(),
                turn_id: event.turn_id.clone(),
                agent_id: event.agent_id.clone(),
                level: event.level.clone(),
                visibility: event.visibility.clone(),
                schema_version: event.schema_version.clone(),
                payload: event.payload.clone(),
                prev_hash: event_prev_hash,
                event_hash,
                stream_sequence: event.stream_sequence,
                caller_id: event.caller_id.clone(),
                task_epoch_id: event.task_epoch_id.clone(),
                workspace_identity_digest: event.workspace_identity_digest.clone(),
                parent_event_id: event.parent_event_id.clone(),
                correlation_id: event.correlation_id.clone(),
            });
        }

        tx.commit()?;
        Ok(stored_events)
    }

    /// Append one event through the same atomic batch implementation.
    pub fn append_event(
        &mut self,
        session_id: &str,
        event: &AppendEvent,
    ) -> Result<StoredEvent, StoreError> {
        let mut stored = self.append_events(session_id, std::slice::from_ref(event))?;
        Ok(stored
            .pop()
            .expect("a one-event append always returns one stored event"))
    }

    /// Read events from `after_sequence` (exclusive).
    pub fn read_events(
        &self,
        session_id: &str,
        after_sequence: i64,
        limit: usize,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM events
             WHERE session_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC LIMIT ?3"
        ))?;
        let rows = stmt.query_map(params![session_id, after_sequence, limit as i64], |row| {
            read_stored_event_row(row, session_id)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn event_count(&self, session_id: &str) -> Result<i64, StoreError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?)
    }

    /// Resolve one immutable journal boundary. Sequence zero is always the
    /// genesis hash; positive sequences must exist exactly.
    pub fn journal_boundary(
        &self,
        session_id: &str,
        sequence: i64,
    ) -> Result<JournalBoundary, StoreError> {
        // Keep NotFound behaviour session-specific rather than reporting a
        // mysterious missing boundary for an unknown session.
        self.load_manifest(session_id)?;
        journal_boundary_on(&self.conn, session_id, sequence)
    }

    /// Read a bounded journal page in chronological return order. Backward
    /// requests query newest-first for efficiency, then reverse the selected
    /// rows before returning them. No row is ever removed by paging.
    pub fn read_event_page(
        &self,
        session_id: &str,
        request: &EventPageRequest,
    ) -> Result<EventPage, StoreError> {
        if request.after_sequence.is_some() && request.before_sequence.is_some() {
            return Err(StoreError::InvalidPageRequest {
                detail: "afterSequence and beforeSequence are mutually exclusive".into(),
            });
        }
        if request.limit == 0 {
            return Err(StoreError::InvalidPageRequest {
                detail: "limit must be greater than zero".into(),
            });
        }

        let direction = if request.before_sequence.is_some() {
            EventPageDirection::Backward
        } else {
            EventPageDirection::Forward
        };
        let anchor_sequence = match direction {
            EventPageDirection::Forward => request.after_sequence.unwrap_or(0),
            EventPageDirection::Backward => request.before_sequence.unwrap_or(i64::MAX),
        };
        if anchor_sequence < 0 {
            return Err(StoreError::InvalidPageRequest {
                detail: "page anchors must be non-negative".into(),
            });
        }

        // A read transaction freezes head/boundary metadata and selected rows at
        // one SQLite snapshot even if an append commits concurrently.
        let tx = self.conn.unchecked_transaction()?;
        let head = last_journal_boundary_on(&tx, session_id)?;
        let through_sequence = request.through_sequence.unwrap_or(head.sequence);
        if through_sequence < 0 {
            return Err(StoreError::InvalidPageRequest {
                detail: "throughSequence must be non-negative".into(),
            });
        }
        if through_sequence > head.sequence {
            return Err(StoreError::InvalidPageRequest {
                detail: format!(
                    "throughSequence {through_sequence} is beyond journal head {}",
                    head.sequence
                ),
            });
        }
        let through = journal_boundary_on(&tx, session_id, through_sequence)?;
        if let Some(expected) = &request.through_hash {
            verify_boundary_hash(&through, expected)?;
        }
        let maximum_anchor = match direction {
            EventPageDirection::Forward => head.sequence,
            EventPageDirection::Backward => head.sequence.saturating_add(1),
        };
        if anchor_sequence > maximum_anchor {
            return Err(StoreError::InvalidPageRequest {
                detail: format!(
                    "page anchor {anchor_sequence} is beyond the maximum stable anchor {maximum_anchor}"
                ),
            });
        }

        let anchor = if anchor_sequence == 0 {
            Some(JournalBoundary {
                sequence: 0,
                event_hash: GENESIS_HASH.to_string(),
            })
        } else if anchor_sequence <= head.sequence {
            Some(journal_boundary_on(&tx, session_id, anchor_sequence)?)
        } else {
            // `beforeSequence = head + 1` is a useful tail anchor and has no
            // event of its own. Any supplied hash still fails closed below.
            None
        };
        if let Some(expected) = &request.anchor_hash {
            match &anchor {
                Some(actual) => verify_boundary_hash(actual, expected)?,
                None => {
                    return Err(StoreError::BoundaryMismatch {
                        sequence: anchor_sequence,
                        expected: expected.clone(),
                        actual: "<missing>".into(),
                    });
                }
            }
        }

        let item_limit = request.limit.min(MAX_EVENT_PAGE_ITEMS);
        let max_bytes = request.max_bytes.min(MAX_EVENT_PAGE_BYTES);
        let (comparison, order) = match direction {
            EventPageDirection::Forward => (">", "ASC"),
            EventPageDirection::Backward => ("<", "DESC"),
        };
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events
             WHERE session_id = ?1 AND sequence {comparison} ?2 AND sequence <= ?3
             ORDER BY sequence {order}"
        );
        let mut stmt = tx.prepare(&sql)?;
        let mut rows = stmt.query(params![session_id, anchor_sequence, through.sequence])?;
        let mut events = Vec::with_capacity(item_limit.min(256));
        // Exact byte count of the serialized `events` JSON array, including its
        // brackets and commas. Metadata has a small fixed allowance at runtime.
        let mut encoded_bytes = 2usize;
        let mut truncated_by_bytes = false;
        let mut oversized_single_event = false;

        while events.len() < item_limit {
            let Some(row) = rows.next()? else {
                break;
            };
            let event = read_stored_event_row(row, session_id)?;
            let event_bytes = serde_json::to_vec(&event)?.len();
            let candidate_bytes = encoded_bytes
                .saturating_add(event_bytes)
                .saturating_add(usize::from(!events.is_empty()));
            if candidate_bytes > max_bytes && !events.is_empty() {
                truncated_by_bytes = true;
                break;
            }
            if candidate_bytes > max_bytes {
                // Always make progress. Journal events have their own 1 MiB cap,
                // and the response advertises this exceptional overflow.
                oversized_single_event = true;
                truncated_by_bytes = true;
            }
            encoded_bytes = candidate_bytes;
            events.push(event);
            if oversized_single_event {
                break;
            }
        }
        drop(rows);
        drop(stmt);

        if direction == EventPageDirection::Backward {
            events.reverse();
        }
        // Recompute after reversal so the reported value is exactly what a
        // caller serializing the returned vector observes.
        encoded_bytes = serde_json::to_vec(&events)?.len();

        let first_sequence = events.first().map(|event| event.sequence);
        let first_prev_hash = events.first().map(|event| event.prev_hash.clone());
        let last_sequence = events.last().map(|event| event.sequence);
        let last_event_hash = events.last().map(|event| event.event_hash.clone());

        let (has_more_before, has_more_after) =
            if let (Some(first), Some(last)) = (first_sequence, last_sequence) {
                (
                    journal_event_exists(
                        &tx,
                        session_id,
                        "sequence < ?2 AND sequence <= ?3",
                        first,
                        through.sequence,
                    )?,
                    journal_event_exists(
                        &tx,
                        session_id,
                        "sequence > ?2 AND sequence <= ?3",
                        last,
                        through.sequence,
                    )?,
                )
            } else {
                match direction {
                    EventPageDirection::Forward => (
                        journal_event_exists(
                            &tx,
                            session_id,
                            "sequence <= ?2 AND sequence <= ?3",
                            anchor_sequence.min(through.sequence),
                            through.sequence,
                        )?,
                        journal_event_exists(
                            &tx,
                            session_id,
                            "sequence > ?2 AND sequence <= ?3",
                            anchor_sequence,
                            through.sequence,
                        )?,
                    ),
                    EventPageDirection::Backward => (
                        journal_event_exists(
                            &tx,
                            session_id,
                            "sequence < ?2 AND sequence <= ?3",
                            anchor_sequence,
                            through.sequence,
                        )?,
                        journal_event_exists(
                            &tx,
                            session_id,
                            "sequence >= ?2 AND sequence <= ?3",
                            anchor_sequence,
                            through.sequence,
                        )?,
                    ),
                }
            };

        tx.commit()?;
        Ok(EventPage {
            events,
            page: EventPageInfo {
                direction,
                anchor_sequence,
                anchor_hash: anchor.map(|boundary| boundary.event_hash),
                first_sequence,
                first_prev_hash,
                last_sequence,
                last_event_hash,
                through,
                journal_head: head,
                has_more_before,
                has_more_after,
                encoded_bytes,
                max_bytes,
                item_limit,
                truncated_by_bytes,
                oversized_single_event,
            },
        })
    }

    /// Verify the hash chain (§18.16). On corruption, report the last valid
    /// sequence so startup can open the session up to that point (AC-46).
    pub fn verify_integrity(&self, session_id: &str) -> Result<IntegrityReport, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT sequence, kind, schema_version, payload, prev_hash, event_hash
             FROM events WHERE session_id = ?1 ORDER BY sequence ASC",
        )?;
        let mut rows = stmt.query(params![session_id])?;

        let mut expected_prev = GENESIS_HASH.to_string();
        let mut expected_sequence = 1i64;
        let mut verified = 0i64;
        let mut last_valid = 0i64;

        while let Some(row) = rows.next()? {
            let sequence: i64 = row.get(0)?;
            let kind: String = row.get(1)?;
            let schema_version: String = row.get(2)?;
            let payload: String = row.get(3)?;
            let prev_hash: String = row.get(4)?;
            let event_hash: String = row.get(5)?;

            if sequence != expected_sequence {
                return Ok(IntegrityReport {
                    session_id: session_id.to_string(),
                    events_verified: verified,
                    last_valid_sequence: last_valid,
                    ok: false,
                    break_detail: Some(format!(
                        "sequence gap: expected {expected_sequence}, found {sequence}"
                    )),
                });
            }
            if prev_hash != expected_prev {
                return Ok(IntegrityReport {
                    session_id: session_id.to_string(),
                    events_verified: verified,
                    last_valid_sequence: last_valid,
                    ok: false,
                    break_detail: Some(format!(
                        "prev_hash mismatch at {sequence}: expected {expected_prev}, found {prev_hash}"
                    )),
                });
            }
            let recomputed =
                compute_event_hash(&schema_version, sequence, &kind, &payload, &prev_hash);
            if recomputed != event_hash {
                return Ok(IntegrityReport {
                    session_id: session_id.to_string(),
                    events_verified: verified,
                    last_valid_sequence: last_valid,
                    ok: false,
                    break_detail: Some(format!(
                        "event_hash mismatch at {sequence}: payload was altered"
                    )),
                });
            }

            verified += 1;
            last_valid = sequence;
            expected_prev = event_hash;
            expected_sequence = sequence + 1;
        }

        Ok(IntegrityReport {
            session_id: session_id.to_string(),
            events_verified: verified,
            last_valid_sequence: last_valid,
            ok: true,
            break_detail: None,
        })
    }

    /// Backward-compatible snapshot writer. New code should prefer
    /// `write_snapshot_envelope`; both paths persist a version-one envelope.
    pub fn write_snapshot(
        &self,
        session_id: &str,
        sequence: i64,
        state: &serde_json::Value,
        stream_sequence: Option<i64>,
    ) -> Result<String, StoreError> {
        self.write_snapshot_envelope(&SnapshotEnvelope {
            snapshot_version: SNAPSHOT_ENVELOPE_VERSION,
            session_id: session_id.to_string(),
            journal_sequence: sequence,
            stream_sequence,
            journal_hash: None,
            reducer_state: state.clone(),
        })
    }

    /// Persist a reducer snapshot atomically with a validated immutable journal
    /// boundary. The checksum covers the complete resolved envelope, not merely
    /// reducerState, so sequence/hash metadata cannot be altered independently.
    pub fn write_snapshot_envelope(
        &self,
        envelope: &SnapshotEnvelope,
    ) -> Result<String, StoreError> {
        envelope.validate()?;
        let tx = self.conn.unchecked_transaction()?;
        let head = last_journal_boundary_on(&tx, &envelope.session_id)?;
        if envelope.journal_sequence > head.sequence {
            return Err(StoreError::InvalidSnapshot {
                detail: format!(
                    "journalSequence {} is beyond journal head {}",
                    envelope.journal_sequence, head.sequence
                ),
            });
        }
        let boundary = journal_boundary_on(&tx, &envelope.session_id, envelope.journal_sequence)?;
        if let Some(expected) = &envelope.journal_hash {
            verify_boundary_hash(&boundary, expected)?;
        }

        let mut resolved = envelope.clone();
        resolved.journal_hash = Some(boundary.event_hash.clone());
        resolved.validate()?;
        let envelope_json = serde_json::to_string(&resolved)?;
        let checksum = format!("{:x}", Sha256::digest(envelope_json.as_bytes()));
        let state_json = serde_json::to_string(&resolved.reducer_state)?;
        let created_at = cbc_patch::now_iso8601();
        tx.execute(
            "INSERT INTO snapshots (
                session_id, sequence, reducer_state, checksum, created_at,
                stream_sequence, envelope_version, journal_hash
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id, sequence) DO UPDATE SET
               reducer_state = excluded.reducer_state,
               checksum = excluded.checksum,
               created_at = excluded.created_at,
               stream_sequence = excluded.stream_sequence,
               envelope_version = excluded.envelope_version,
               journal_hash = excluded.journal_hash",
            params![
                resolved.session_id,
                resolved.journal_sequence,
                state_json,
                checksum,
                created_at,
                resolved.stream_sequence,
                SNAPSHOT_ENVELOPE_VERSION as i64,
                boundary.event_hash,
            ],
        )?;
        tx.commit()?;
        Ok(checksum)
    }

    /// Load the newest valid envelope at or before `max_sequence`. Corrupt or
    /// unsupported rows are skipped so an older valid snapshot remains usable.
    pub fn latest_snapshot_envelope(
        &self,
        session_id: &str,
        max_sequence: Option<i64>,
    ) -> Result<Option<StoredSnapshot>, StoreError> {
        self.load_manifest(session_id)?;
        let ceiling = max_sequence.unwrap_or(i64::MAX);
        if ceiling < 0 {
            return Err(StoreError::InvalidSnapshot {
                detail: "snapshot ceiling must be non-negative".into(),
            });
        }
        let mut stmt = self.conn.prepare(
            "SELECT sequence, reducer_state, checksum, created_at,
                    stream_sequence, envelope_version, journal_hash
             FROM snapshots
             WHERE session_id = ?1 AND sequence <= ?2
             ORDER BY sequence DESC",
        )?;
        let rows = stmt.query_map(params![session_id, ceiling], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?;
        let mut candidates = Vec::new();
        for row in rows {
            candidates.push(row?);
        }
        drop(stmt);

        for (sequence, state_json, checksum, created_at, stream_sequence, version, stored_hash) in
            candidates
        {
            let Ok(reducer_state) = serde_json::from_str::<serde_json::Value>(&state_json) else {
                continue;
            };
            let Ok(boundary) = journal_boundary_on(&self.conn, session_id, sequence) else {
                continue;
            };

            let legacy = version == 0;
            if legacy {
                let recomputed = format!("{:x}", Sha256::digest(state_json.as_bytes()));
                if recomputed != checksum {
                    continue;
                }
            } else if version == SNAPSHOT_ENVELOPE_VERSION as i64 {
                if stored_hash.as_deref() != Some(boundary.event_hash.as_str()) {
                    continue;
                }
            } else {
                // A newer envelope may coexist with an older one. This binary
                // must not deserialize it as a version it understands.
                continue;
            }

            let envelope = SnapshotEnvelope {
                snapshot_version: SNAPSHOT_ENVELOPE_VERSION,
                session_id: session_id.to_string(),
                journal_sequence: sequence,
                stream_sequence,
                journal_hash: Some(boundary.event_hash),
                reducer_state,
            };
            if envelope.validate().is_err() {
                continue;
            }
            if !legacy {
                let canonical = serde_json::to_string(&envelope)?;
                let recomputed = format!("{:x}", Sha256::digest(canonical.as_bytes()));
                if recomputed != checksum {
                    continue;
                }
            }
            return Ok(Some(StoredSnapshot {
                envelope,
                checksum,
                created_at,
                legacy,
            }));
        }
        Ok(None)
    }

    /// Legacy tuple shape retained for embedders compiled against the original
    /// store API. Runtime responses use `latest_snapshot_envelope` so both
    /// sequence domains are visible.
    pub fn latest_snapshot(
        &self,
        session_id: &str,
        max_sequence: Option<i64>,
    ) -> Result<Option<(i64, serde_json::Value)>, StoreError> {
        Ok(self
            .latest_snapshot_envelope(session_id, max_sequence)?
            .map(|snapshot| {
                (
                    snapshot.envelope.journal_sequence,
                    snapshot.envelope.reducer_state,
                )
            }))
    }

    /// Record a file mutation transaction and its operations (§18.15).
    ///
    /// Idempotent per transaction id: the operation rows are replaced on every
    /// call, so the same row can carry the durable intent (`open`/`applying`)
    /// first and the final `committed` state later (P0-07).
    pub fn record_transaction(
        &mut self,
        id: &str,
        turn_id: Option<&str>,
        agent_id: Option<&str>,
        status: &str,
        started_at: &str,
        committed_at: Option<&str>,
        operations: &[TransactionOperation],
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO transactions (id, turn_id, agent_id, status, started_at, committed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               status = excluded.status, committed_at = excluded.committed_at",
            params![id, turn_id, agent_id, status, started_at, committed_at],
        )?;
        tx.execute(
            "DELETE FROM file_operations WHERE transaction_id = ?1",
            params![id],
        )?;
        for op in operations {
            tx.execute(
                "INSERT INTO file_operations (
                    transaction_id, path, kind, pre_hash, post_hash,
                    pre_image_artifact, additions, deletions, new_path
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    id,
                    op.path,
                    op.kind,
                    op.pre_hash,
                    op.post_hash,
                    op.pre_image_artifact,
                    op.additions as i64,
                    op.deletions as i64,
                    op.new_path,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Transaction ids currently in one status, in id order. Startup recovery
    /// uses this to find intents a crash left behind (P0-07).
    pub fn transaction_ids_with_status(&self, status: &str) -> Result<Vec<String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM transactions WHERE status = ?1 ORDER BY id ASC")?;
        let rows = stmt.query_map(params![status], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Transactions for a turn, newest first — the input to `/undo`.
    pub fn transactions_for_turn(
        &self,
        turn_id: &str,
    ) -> Result<Vec<(String, Vec<TransactionOperation>)>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM transactions WHERE turn_id = ?1 AND status = 'committed'
             ORDER BY committed_at DESC",
        )?;
        let ids: Vec<String> = stmt
            .query_map(params![turn_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;

        let mut out = Vec::new();
        for id in ids {
            out.push((id.clone(), self.operations_for_transaction(&id)?));
        }
        Ok(out)
    }

    pub fn operations_for_transaction(
        &self,
        transaction_id: &str,
    ) -> Result<Vec<TransactionOperation>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT path, kind, pre_hash, post_hash, pre_image_artifact,
                    additions, deletions, new_path
             FROM file_operations WHERE transaction_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![transaction_id], |row| {
            Ok(TransactionOperation {
                path: row.get(0)?,
                kind: row.get(1)?,
                pre_hash: row.get(2)?,
                post_hash: row.get(3)?,
                pre_image_artifact: row.get(4)?,
                additions: row.get::<_, i64>(5)? as usize,
                deletions: row.get::<_, i64>(6)? as usize,
                new_path: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Record an approval decision for the audit trail (§18.15, PERM-006).
    pub fn record_approval(
        &self,
        id: &str,
        turn_id: Option<&str>,
        action_hash: &str,
        decision: &str,
        scope: &str,
        normalized_operation: &serde_json::Value,
        resolved_at: &str,
    ) -> Result<(), StoreError> {
        reject_credential_payload(normalized_operation)?;
        self.conn.execute(
            "INSERT INTO approvals (
                id, turn_id, action_hash, decision, scope, normalized_operation, resolved_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                turn_id,
                action_hash,
                decision,
                scope,
                serde_json::to_string(normalized_operation)?,
                resolved_at,
            ],
        )?;
        Ok(())
    }

    pub fn approvals_for_turn(&self, turn_id: &str) -> Result<Vec<serde_json::Value>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, action_hash, decision, scope, normalized_operation, resolved_at
             FROM approvals WHERE turn_id = ?1 ORDER BY resolved_at ASC",
        )?;
        let rows = stmt.query_map(params![turn_id], |row| {
            let op: String = row.get(4)?;
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "actionHash": row.get::<_, String>(1)?,
                "decision": row.get::<_, String>(2)?,
                "scope": row.get::<_, String>(3)?,
                "operation": serde_json::from_str::<serde_json::Value>(&op)
                    .unwrap_or(serde_json::Value::Null),
                "resolvedAt": row.get::<_, String>(5)?,
            }))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Record usage for `/status` and cost display (§23.7).
    pub fn record_usage(
        &self,
        turn_id: &str,
        model: &str,
        input_tokens: i64,
        cached_input_tokens: i64,
        cache_write_tokens: i64,
        output_tokens: i64,
        reasoning_tokens: i64,
        estimated_cost: f64,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO usage (
                turn_id, model, input_tokens, cached_input_tokens, cache_write_tokens,
                output_tokens, reasoning_tokens, estimated_cost, recorded_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                turn_id,
                model,
                input_tokens,
                cached_input_tokens,
                cache_write_tokens,
                output_tokens,
                reasoning_tokens,
                estimated_cost,
                cbc_patch::now_iso8601(),
            ],
        )?;
        Ok(())
    }

    /// Logically remove a session without mutating its immutable journal. Archived
    /// sessions remain loadable/exportable for recovery and audit.
    pub fn archive_session(&self, session_id: &str) -> Result<i64, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let event_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )?;
        let changed = tx.execute(
            "UPDATE sessions SET status = 'archived', updated_at = ?2 WHERE id = ?1",
            params![session_id, cbc_patch::now_iso8601()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                what: format!("session {session_id}"),
            });
        }
        tx.commit()?;
        Ok(event_count)
    }

    /// Backward-compatible method name. "Delete" is now a logical archive and
    /// deliberately removes zero journal rows.
    pub fn delete_session(&mut self, session_id: &str) -> Result<usize, StoreError> {
        self.archive_session(session_id)?;
        Ok(0)
    }

    /// Reconcile unfinished transactions and jobs at startup (§22.6, AC-46).
    pub fn reconcile_startup(&mut self, now: &str) -> Result<ReconcileReport, StoreError> {
        let tx = self.conn.transaction()?;
        let open_transactions =
            collect_ids(&tx, "SELECT id FROM transactions WHERE status = 'open'")?;
        let stale_jobs = collect_ids(
            &tx,
            "SELECT id FROM jobs WHERE state IN ('running','starting')",
        )?;
        let interrupted_sessions =
            collect_ids(&tx, "SELECT id FROM sessions WHERE status = 'active'")?;

        for id in &open_transactions {
            tx.execute(
                "UPDATE transactions SET status = 'interrupted' WHERE id = ?1",
                params![id],
            )?;
        }
        for id in &stale_jobs {
            tx.execute(
                "UPDATE jobs SET state = 'interrupted', finished_at = ?2 WHERE id = ?1",
                params![id, now],
            )?;
        }
        for id in &interrupted_sessions {
            tx.execute(
                "UPDATE sessions SET status = 'interrupted', updated_at = ?2 WHERE id = ?1",
                params![id, now],
            )?;
        }
        tx.commit()?;

        Ok(ReconcileReport {
            interrupted_transactions: open_transactions,
            stale_jobs,
            interrupted_sessions,
        })
    }

    /// Record a background job (§18.15 `jobs`).
    pub fn record_job(
        &self,
        id: &str,
        task_id: Option<&str>,
        display: &str,
        state: &str,
        exit_code: Option<i32>,
        started_at: &str,
        finished_at: Option<&str>,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO jobs (id, task_id, display, state, exit_code, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               state = excluded.state,
               exit_code = excluded.exit_code,
               finished_at = excluded.finished_at",
            params![
                id,
                task_id,
                display,
                state,
                exit_code,
                started_at,
                finished_at
            ],
        )?;
        Ok(())
    }

    /// Record a subagent task node (§18.15 `tasks`).
    pub fn record_task(
        &self,
        id: &str,
        parent_id: Option<&str>,
        role: &str,
        state: &str,
        title: &str,
        result_summary: Option<&str>,
        created_at: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO tasks (id, parent_id, role, state, title, result_summary, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               state = excluded.state, result_summary = excluded.result_summary",
            params![
                id,
                parent_id,
                role,
                state,
                title,
                result_summary,
                created_at
            ],
        )?;
        Ok(())
    }

    /// Register artifact metadata (§18.15 `artifacts`).
    pub fn record_artifact(
        &self,
        id: &str,
        digest: &str,
        media_type: &str,
        size: i64,
        redaction_state: &str,
        retention: &str,
        created_at: &str,
        session_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO artifacts (id, digest, media_type, size, redaction_state, retention, created_at, session_id, turn_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO NOTHING",
            params![id, digest, media_type, size, redaction_state, retention, created_at, session_id, turn_id],
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub interrupted_transactions: Vec<String>,
    pub stale_jobs: Vec<String>,
    pub interrupted_sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransactionOperation {
    pub path: String,
    pub kind: String,
    pub pre_hash: Option<String>,
    pub post_hash: Option<String>,
    /// Artifact digest holding the pre-image, when one was spilled.
    pub pre_image_artifact: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub new_path: Option<String>,
}

/// Collect a single-column list of ids. Kept as a free function so the prepared
/// statement is dropped before the surrounding transaction is committed.
fn collect_ids(conn: &Connection, sql: &str) -> Result<Vec<String>, StoreError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn journal_boundary_on(
    conn: &Connection,
    session_id: &str,
    sequence: i64,
) -> Result<JournalBoundary, StoreError> {
    if sequence < 0 {
        return Err(StoreError::InvalidPageRequest {
            detail: "journal boundary sequence must be non-negative".into(),
        });
    }
    if sequence == 0 {
        return Ok(JournalBoundary {
            sequence,
            event_hash: GENESIS_HASH.to_string(),
        });
    }
    let event_hash = conn
        .query_row(
            "SELECT event_hash FROM events WHERE session_id = ?1 AND sequence = ?2",
            params![session_id, sequence],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            what: format!("journal boundary {session_id}@{sequence}"),
        })?;
    Ok(JournalBoundary {
        sequence,
        event_hash,
    })
}

fn last_journal_boundary_on(
    conn: &Connection,
    session_id: &str,
) -> Result<JournalBoundary, StoreError> {
    let session_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        params![session_id],
        |row| row.get(0),
    )?;
    if !session_exists {
        return Err(StoreError::NotFound {
            what: format!("session {session_id}"),
        });
    }
    Ok(conn
        .query_row(
            "SELECT sequence, event_hash FROM events
             WHERE session_id = ?1 ORDER BY sequence DESC LIMIT 1",
            params![session_id],
            |row| {
                Ok(JournalBoundary {
                    sequence: row.get(0)?,
                    event_hash: row.get(1)?,
                })
            },
        )
        .optional()?
        .unwrap_or_else(|| JournalBoundary {
            sequence: 0,
            event_hash: GENESIS_HASH.to_string(),
        }))
}

fn verify_boundary_hash(boundary: &JournalBoundary, expected: &str) -> Result<(), StoreError> {
    if boundary.event_hash == expected {
        return Ok(());
    }
    Err(StoreError::BoundaryMismatch {
        sequence: boundary.sequence,
        expected: expected.to_string(),
        actual: boundary.event_hash.clone(),
    })
}

fn journal_event_exists(
    conn: &Connection,
    session_id: &str,
    predicate: &str,
    pivot: i64,
    through: i64,
) -> Result<bool, StoreError> {
    let sql = format!("SELECT EXISTS(SELECT 1 FROM events WHERE session_id = ?1 AND {predicate})");
    Ok(conn.query_row(&sql, params![session_id, pivot, through], |row| row.get(0))?)
}

/// The event column list shared by every event query (P0-06 journal v2). The
/// session id is always a bind parameter, never a selected column.
const EVENT_COLUMNS: &str = "sequence, id, kind, timestamp, turn_id, agent_id,
        level, visibility, schema_version, payload, prev_hash, event_hash,
        stream_sequence, caller_id, task_epoch_id, workspace_identity_digest,
        parent_event_id, correlation_id";

/// Decode one event row selected via `EVENT_COLUMNS`.
fn read_stored_event_row(
    row: &rusqlite::Row<'_>,
    session_id: &str,
) -> rusqlite::Result<StoredEvent> {
    let payload_raw: String = row.get(9)?;
    Ok(StoredEvent {
        session_id: session_id.to_string(),
        sequence: row.get(0)?,
        id: row.get(1)?,
        kind: row.get(2)?,
        timestamp: row.get(3)?,
        turn_id: row.get(4)?,
        agent_id: row.get(5)?,
        level: row.get(6)?,
        visibility: row.get(7)?,
        schema_version: row.get(8)?,
        payload: serde_json::from_str(&payload_raw).unwrap_or(serde_json::Value::Null),
        prev_hash: row.get(10)?,
        event_hash: row.get(11)?,
        stream_sequence: row.get(12)?,
        caller_id: row.get(13)?,
        task_epoch_id: row.get(14)?,
        workspace_identity_digest: row.get(15)?,
        parent_event_id: row.get(16)?,
        correlation_id: row.get(17)?,
    })
}

fn current_version(conn: &Connection) -> Result<i64, StoreError> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(0);
    }
    Ok(conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0))
}

/// §18.15: "credential/token value는 어떤 table에도 저장 금지". Reject payloads
/// that carry a plausible credential field before they reach the database.
fn reject_credential_payload(value: &serde_json::Value) -> Result<(), StoreError> {
    fn walk(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    if cbc_redaction::is_secret_env_name(key) && child.is_string() {
                        let text = child.as_str().unwrap_or("");
                        // A redacted marker is fine; a real value is not.
                        if !text.is_empty() && !text.contains(cbc_redaction::REDACTED) {
                            return Some(key.clone());
                        }
                    }
                    if let Some(found) = walk(child) {
                        return Some(found);
                    }
                }
                None
            }
            serde_json::Value::Array(items) => items.iter().find_map(walk),
            _ => None,
        }
    }
    match walk(value) {
        Some(field) => Err(StoreError::CredentialRejected { field }),
        None => Ok(()),
    }
}

fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn derive_session_title(payload: &serde_json::Value) -> Option<String> {
    let text = payload.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let first_line = text.lines().next().unwrap_or(text).trim();
    if first_line.is_empty() {
        return None;
    }
    let truncated: String = first_line.chars().take(80).collect();
    let title = if first_line.chars().count() > 80 {
        format!("{truncated}…")
    } else {
        truncated
    };
    Some(title)
}

/// Convenience constructor for a manifest with sensible defaults.
pub fn new_manifest(
    id: &str,
    workspace_path: &str,
    workspace_fingerprint: &str,
    title: &str,
    model_profile: &str,
    permission_mode: &str,
) -> SessionManifest {
    let now = cbc_patch::now_iso8601();
    SessionManifest {
        schema_version: "1.0".into(),
        id: id.into(),
        workspace_path: workspace_path.into(),
        workspace_fingerprint: workspace_fingerprint.into(),
        created_at: now.clone(),
        updated_at: now,
        title: title.into(),
        model_profile: model_profile.into(),
        permission_mode: permission_mode.into(),
        interaction_mode: None,
        permission_preset: None,
        plan_revision: None,
        parent_session_id: None,
        last_event_sequence: 0,
        state: SessionStatus::Active,
        turn_count: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_store() -> SessionStore {
        let store = SessionStore::open_in_memory().expect("open store");
        store
            .create_session(&new_manifest(
                "ses_1",
                "/work",
                "fp",
                "test",
                "auto",
                "auto-review",
            ))
            .expect("create session");
        store
    }

    fn event(id: &str, kind: &str) -> AppendEvent {
        AppendEvent {
            id: id.to_string(),
            kind: kind.to_string(),
            timestamp: "2026-08-05T00:00:00Z".to_string(),
            turn_id: None,
            agent_id: None,
            level: "info".to_string(),
            visibility: "timeline".to_string(),
            schema_version: "1.0".to_string(),
            payload: serde_json::json!({}),
            stream_sequence: None,
            caller_id: None,
            task_epoch_id: None,
            workspace_identity_digest: None,
            parent_event_id: None,
            correlation_id: None,
        }
    }

    #[test]
    fn append_is_idempotent_on_event_id() {
        // P0-06: a transport retry re-sends an event that already landed; the store
        // returns the stored row instead of appending a duplicate.
        let mut store = seeded_store();
        let first = store
            .append_event("ses_1", &event("evt_1", "user.message"))
            .unwrap();
        let again = store
            .append_event("ses_1", &event("evt_1", "user.message"))
            .unwrap();
        assert_eq!(first.sequence, again.sequence);
        assert_eq!(first.event_hash, again.event_hash);
        assert_eq!(store.event_count("ses_1").unwrap(), 1);
    }

    #[test]
    fn batch_append_is_atomic_and_hashes_in_input_order() {
        let mut store = seeded_store();
        let events = vec![
            event("evt_a", "user.message"),
            event("evt_b", "turn.completed"),
            event("evt_c", "assistant.final"),
        ];
        let stored = store.append_events("ses_1", &events).unwrap();

        assert_eq!(
            stored
                .iter()
                .map(|entry| entry.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(stored[0].prev_hash, GENESIS_HASH);
        assert_eq!(stored[1].prev_hash, stored[0].event_hash);
        assert_eq!(stored[2].prev_hash, stored[1].event_hash);
        assert_eq!(store.event_count("ses_1").unwrap(), 3);
        assert_eq!(store.load_manifest("ses_1").unwrap().turn_count, 1);

        let retried = store.append_events("ses_1", &events).unwrap();
        assert_eq!(retried, stored);
        assert_eq!(store.event_count("ses_1").unwrap(), 3);
    }

    #[test]
    fn invalid_event_rolls_back_the_whole_batch() {
        let mut store = seeded_store();
        let good = event("evt_good", "user.message");
        let mut oversized = event("evt_big", "assistant.final");
        oversized.payload = serde_json::json!({ "blob": "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1) });

        let err = store
            .append_events("ses_1", &[good, oversized])
            .unwrap_err();
        assert!(matches!(err, StoreError::PayloadTooLarge { .. }), "{err}");
        assert_eq!(store.event_count("ses_1").unwrap(), 0);
    }

    #[test]
    fn lineage_fields_round_trip() {
        let mut store = seeded_store();
        let mut e = event("evt_lineage", "tool.completed");
        e.stream_sequence = Some(42);
        e.caller_id = Some("caller_root".into());
        e.task_epoch_id = Some("epoch_1".into());
        e.workspace_identity_digest = Some("digest_abc".into());
        e.parent_event_id = Some("evt_parent".into());
        e.correlation_id = Some("corr_1".into());
        store.append_event("ses_1", &e).unwrap();

        let read = store.read_events("ses_1", 0, 10).unwrap();
        assert_eq!(read.len(), 1);
        let stored = &read[0];
        assert_eq!(stored.stream_sequence, Some(42));
        assert_eq!(stored.caller_id.as_deref(), Some("caller_root"));
        assert_eq!(stored.task_epoch_id.as_deref(), Some("epoch_1"));
        assert_eq!(
            stored.workspace_identity_digest.as_deref(),
            Some("digest_abc")
        );
        assert_eq!(stored.parent_event_id.as_deref(), Some("evt_parent"));
        assert_eq!(stored.correlation_id.as_deref(), Some("corr_1"));
    }

    #[test]
    fn oversized_payload_is_refused() {
        let mut store = seeded_store();
        let mut e = event("evt_big", "user.message");
        e.payload = serde_json::json!({ "blob": "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1) });
        let err = store.append_event("ses_1", &e).unwrap_err();
        assert!(matches!(err, StoreError::PayloadTooLarge { .. }), "{err}");
        assert_eq!(store.event_count("ses_1").unwrap(), 0);
    }

    #[test]
    fn turn_completed_tallies_turn_count() {
        let mut store = seeded_store();
        store
            .append_event("ses_1", &event("evt_a", "user.message"))
            .unwrap();
        store
            .append_event("ses_1", &event("evt_b", "turn.completed"))
            .unwrap();
        store
            .append_event("ses_1", &event("evt_c", "turn.completed"))
            .unwrap();
        let manifest = store.load_manifest("ses_1").unwrap();
        assert_eq!(manifest.turn_count, 2);
    }
}
