//! Schema migrations — PRD §18.15 (tables) and §18.18 (forward-only, numbered,
//! checksummed migrations; a destructive migration backs up the database first).

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::StoreError;

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
    /// True when the migration can lose data; §18.18 requires a backup first.
    pub destructive: bool,
}

/// All migrations, forward-only and numbered.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial-schema",
        destructive: false,
        sql: r#"
CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE workspaces (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_path_hash  TEXT NOT NULL UNIQUE,
    trust_state          TEXT NOT NULL,
    last_seen            TEXT NOT NULL
);

CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    workspace_id        INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    status              TEXT NOT NULL,
    model_profile       TEXT NOT NULL,
    permission_mode     TEXT NOT NULL,
    workspace_path      TEXT NOT NULL,
    parent_session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    schema_version      TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);

CREATE TABLE turns (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
    status         TEXT NOT NULL,
    model_profile  TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    finished_at    TEXT
);
CREATE INDEX idx_turns_session ON turns(session_id);

CREATE TABLE events (
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence       INTEGER NOT NULL,
    id             TEXT NOT NULL,
    kind           TEXT NOT NULL,
    timestamp      TEXT NOT NULL,
    turn_id        TEXT,
    agent_id       TEXT,
    level          TEXT NOT NULL,
    visibility     TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    payload        TEXT NOT NULL,
    prev_hash      TEXT NOT NULL,
    event_hash     TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
);
CREATE INDEX idx_events_kind ON events(session_id, kind);
CREATE INDEX idx_events_turn ON events(session_id, turn_id);

CREATE TABLE snapshots (
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence      INTEGER NOT NULL,
    reducer_state TEXT NOT NULL,
    checksum      TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
);

CREATE TABLE transactions (
    id           TEXT PRIMARY KEY,
    turn_id      TEXT,
    agent_id     TEXT,
    status       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    committed_at TEXT
);
CREATE INDEX idx_transactions_turn ON transactions(turn_id);

CREATE TABLE file_operations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id     TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    path               TEXT NOT NULL,
    kind               TEXT NOT NULL,
    pre_hash           TEXT,
    post_hash          TEXT,
    pre_image_artifact TEXT,
    additions          INTEGER NOT NULL DEFAULT 0,
    deletions          INTEGER NOT NULL DEFAULT 0,
    new_path           TEXT
);
CREATE INDEX idx_file_ops_tx ON file_operations(transaction_id);
CREATE INDEX idx_file_ops_path ON file_operations(path);

CREATE TABLE approvals (
    id                   TEXT PRIMARY KEY,
    turn_id              TEXT,
    action_hash          TEXT NOT NULL,
    decision             TEXT NOT NULL,
    scope                TEXT NOT NULL,
    normalized_operation TEXT NOT NULL,
    resolved_at          TEXT NOT NULL
);
CREATE INDEX idx_approvals_turn ON approvals(turn_id);
CREATE INDEX idx_approvals_action ON approvals(action_hash);

CREATE TABLE tasks (
    id             TEXT PRIMARY KEY,
    parent_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    role           TEXT NOT NULL,
    state          TEXT NOT NULL,
    title          TEXT NOT NULL,
    result_summary TEXT,
    created_at     TEXT NOT NULL
);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    display     TEXT NOT NULL,
    state       TEXT NOT NULL,
    exit_code   INTEGER,
    started_at  TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state);

CREATE TABLE artifacts (
    id              TEXT PRIMARY KEY,
    digest          TEXT NOT NULL,
    media_type      TEXT NOT NULL,
    size            INTEGER NOT NULL,
    redaction_state TEXT NOT NULL,
    retention       TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_artifacts_digest ON artifacts(digest);

CREATE TABLE usage (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id             TEXT NOT NULL,
    model               TEXT NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
    estimated_cost      REAL NOT NULL DEFAULT 0,
    recorded_at         TEXT NOT NULL
);
CREATE INDEX idx_usage_turn ON usage(turn_id);
"#,
    },
    Migration {
        // P0-05: the session list reports turn counts straight from the durable
        // store; there is no host-side index to keep in sync any more.
        version: 2,
        name: "session-turn-count",
        destructive: false,
        sql: r#"
ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
"#,
    },
    Migration {
        // P0-06 journal v2: the client's stream sequence is preserved next to the
        // store's own journal sequence, the v1.3 lineage fields are persisted, and
        // a unique event id makes append idempotent under retry.
        version: 3,
        name: "journal-v2-lineage",
        destructive: false,
        sql: r#"
ALTER TABLE events ADD COLUMN stream_sequence INTEGER;
ALTER TABLE events ADD COLUMN caller_id TEXT;
ALTER TABLE events ADD COLUMN task_epoch_id TEXT;
ALTER TABLE events ADD COLUMN workspace_identity_digest TEXT;
ALTER TABLE events ADD COLUMN parent_event_id TEXT;
ALTER TABLE events ADD COLUMN correlation_id TEXT;
CREATE UNIQUE INDEX idx_events_event_id ON events(session_id, id);
"#,
    },
    Migration {
        // P0-06 journal v2: snapshots carry both sequences. `sequence` stays the
        // journal sequence (what resume reconciles against); the client's stream
        // sequence is recorded for diagnostics.
        version: 4,
        name: "snapshot-stream-sequence",
        destructive: false,
        sql: r#"
ALTER TABLE snapshots ADD COLUMN stream_sequence INTEGER;
"#,
    },
    Migration {
        // P0-08: artifacts record the session/turn that owns them, so retention
        // and GC can tell whose output a blob is and when it was produced. Both
        // are nullable: spills created outside a session own nothing.
        version: 5,
        name: "artifact-ownership",
        destructive: false,
        sql: r#"
ALTER TABLE artifacts ADD COLUMN session_id TEXT;
ALTER TABLE artifacts ADD COLUMN turn_id TEXT;
"#,
    },
    Migration {
        // P2 resume foundation: legacy rows used a checksum over reducer_state
        // alone. New rows bind the versioned envelope and its journal boundary
        // hash, while the version marker lets readers keep accepting legacy rows.
        version: 6,
        name: "versioned-snapshot-envelope",
        destructive: false,
        sql: r#"
ALTER TABLE snapshots ADD COLUMN envelope_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshots ADD COLUMN journal_hash TEXT;
"#,
    },
    Migration {
        // W0 / EDT-018: retain canonical edit intent and the committed receipt so
        // preview, retry, undo, and session replay use one durable source of truth.
        version: 7,
        name: "edit-receipts",
        destructive: false,
        sql: r#"
CREATE TABLE edit_plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT,
    agent_id TEXT,
    source TEXT NOT NULL,
    workspace_identity_digest TEXT NOT NULL,
    worktree_id TEXT,
    base_workspace_revision TEXT,
    plan_digest TEXT NOT NULL,
    conflict_policy TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_edit_plans_session_created
    ON edit_plans(session_id, created_at DESC);

CREATE TABLE edit_operations (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES edit_plans(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    base_revision TEXT,
    operation_json TEXT NOT NULL,
    resolved_range_json TEXT,
    resolution_evidence_json TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    UNIQUE(plan_id, ordinal)
);
CREATE INDEX idx_edit_operations_plan
    ON edit_operations(plan_id, ordinal);

CREATE TABLE edit_receipts (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES edit_plans(id) ON DELETE CASCADE,
    transaction_id TEXT,
    receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_edit_receipts_plan
    ON edit_receipts(plan_id, created_at DESC);
"#,
    },
    Migration {
        // W0 / DAE-013: durable local-daemon ownership, attachment recovery, and
        // idempotent command state. No network transport authority is stored here.
        version: 8,
        name: "daemon-ownership",
        destructive: false,
        sql: r#"
CREATE TABLE daemon_instances (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    executable_digest TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    stopped_at TEXT,
    state TEXT NOT NULL
);

CREATE TABLE session_owners (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    daemon_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,
    lease_expires_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
);
CREATE INDEX idx_session_owners_expiry
    ON session_owners(lease_expires_at);

CREATE TABLE client_attachments (
    connection_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    attached_at TEXT NOT NULL,
    detached_at TEXT,
    last_event_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_client_attachments_session
    ON client_attachments(session_id, detached_at);

CREATE TABLE command_receipts (
    idempotency_key TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    canonical_payload_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_command_receipts_created
    ON command_receipts(created_at DESC);

CREATE TABLE session_commands (
    idempotency_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    command_id TEXT NOT NULL,
    command_kind TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    receipt_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_session_commands_session
    ON session_commands(session_id, created_at DESC);
"#,
    },
    Migration {
        // W0 / MEM-005: evidence and memory are workspace-bound facts/claims.
        // Raw transcripts are intentionally absent; callers store only bounded,
        // redacted summaries and artifact references.
        version: 9,
        name: "durable-memory",
        destructive: false,
        sql: r#"
CREATE TABLE evidence_records (
    id TEXT PRIMARY KEY,
    workspace_identity_digest TEXT NOT NULL,
    session_id TEXT,
    turn_id TEXT,
    agent_id TEXT,
    task_id TEXT,
    worktree_id TEXT,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    digest TEXT NOT NULL,
    exact INTEGER NOT NULL,
    freshness TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    expires_at TEXT,
    summary TEXT NOT NULL,
    invalidated_at TEXT,
    invalidation_reason TEXT
);
CREATE INDEX idx_evidence_workspace_freshness
    ON evidence_records(workspace_identity_digest, freshness, observed_at DESC);

CREATE TABLE evidence_path_bindings (
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    revision_token TEXT,
    PRIMARY KEY (evidence_id, path)
);
CREATE INDEX idx_evidence_path
    ON evidence_path_bindings(path, revision_token);

CREATE TABLE evidence_artifacts (
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    PRIMARY KEY (evidence_id, artifact_id)
);

CREATE TABLE memory_records (
    id TEXT PRIMARY KEY,
    workspace_identity_digest TEXT NOT NULL,
    scope TEXT NOT NULL,
    session_id TEXT,
    task_id TEXT,
    worktree_id TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    valid_for_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_validated_at TEXT NOT NULL,
    evidence_observed_at TEXT NOT NULL,
    exact_evidence_observed_at TEXT,
    expires_at TEXT,
    revision INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_by_agent_id TEXT,
    last_accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_memory_workspace_key
    ON memory_records(workspace_identity_digest, key, status);
CREATE INDEX idx_memory_scope_owner
    ON memory_records(scope, session_id, task_id);

CREATE TABLE memory_evidence_links (
    memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
    PRIMARY KEY (memory_id, evidence_id)
);

CREATE TABLE memory_relations (
    memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    related_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    PRIMARY KEY (memory_id, related_memory_id, relation)
);

CREATE TABLE memory_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX idx_memory_transitions_record
    ON memory_transitions(memory_id, sequence);
"#,
    },
    Migration {
        // W0 / AGG-013: graph scheduling state is event-replayable and survives
        // daemon restarts. Attempt results remain claims until separately verified.
        version: 10,
        name: "persistent-agent-graph",
        destructive: false,
        sql: r#"
CREATE TABLE agent_graphs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    workspace_identity_digest TEXT NOT NULL,
    root_node_id TEXT NOT NULL,
    state TEXT NOT NULL,
    revision INTEGER NOT NULL,
    max_depth INTEGER NOT NULL,
    budget_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_graphs_session
    ON agent_graphs(session_id, updated_at DESC);

CREATE TABLE agent_nodes (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
    parent_node_id TEXT REFERENCES agent_nodes(id) ON DELETE SET NULL,
    depth INTEGER NOT NULL,
    role TEXT NOT NULL,
    name TEXT,
    title TEXT NOT NULL,
    task_json TEXT NOT NULL,
    state TEXT NOT NULL,
    model_profile TEXT NOT NULL,
    permission_scope_json TEXT NOT NULL,
    worktree_id TEXT,
    active_attempt_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    blocked_reason_json TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT
);
CREATE INDEX idx_agent_nodes_graph_state
    ON agent_nodes(graph_id, state, priority DESC, created_at);

CREATE TABLE agent_edges (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    to_node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    required INTEGER NOT NULL,
    condition_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(graph_id, from_node_id, to_node_id, kind)
);
CREATE INDEX idx_agent_edges_to
    ON agent_edges(graph_id, to_node_id, kind);

CREATE TABLE agent_attempts (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    state TEXT NOT NULL,
    daemon_id TEXT,
    owner_epoch INTEGER,
    worker_lease_id TEXT,
    model_profile TEXT NOT NULL,
    provider_route TEXT,
    worktree_id TEXT,
    turn_id TEXT,
    context_pack_id TEXT,
    result_claim_json TEXT,
    verified_result_json TEXT,
    error_json TEXT,
    usage_json TEXT,
    started_at TEXT,
    heartbeat_at TEXT,
    finished_at TEXT,
    UNIQUE(node_id, ordinal)
);
CREATE INDEX idx_agent_attempts_state
    ON agent_attempts(state, heartbeat_at);

CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
    from_node_id TEXT,
    to_node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body_json TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    acknowledged_at TEXT
);
CREATE INDEX idx_agent_messages_pending
    ON agent_messages(to_node_id, delivered_at, created_at);

CREATE TABLE agent_checkpoints (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES agent_attempts(id) ON DELETE SET NULL,
    graph_revision INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    context_pack_id TEXT,
    worktree_revision TEXT,
    evidence_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_checkpoints_node
    ON agent_checkpoints(node_id, created_at DESC);

CREATE TABLE agent_budget_reservations (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES agent_attempts(id) ON DELETE SET NULL,
    resource TEXT NOT NULL,
    reserved REAL NOT NULL,
    consumed REAL NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settled_at TEXT
);
CREATE INDEX idx_agent_budget_reservations_graph
    ON agent_budget_reservations(graph_id, state);
"#,
    },
    Migration {
        // W0 / WT-022: one mutable tree has one lease; proposals and merge
        // conflicts stay durable so a restart never silently changes the base tree.
        version: 11,
        name: "worktree-multi-agent",
        destructive: false,
        sql: r#"
CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    workspace_identity_digest TEXT NOT NULL,
    graph_id TEXT REFERENCES agent_graphs(id) ON DELETE SET NULL,
    node_id TEXT REFERENCES agent_nodes(id) ON DELETE SET NULL,
    path TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    base_workspace_revision TEXT NOT NULL,
    head_commit TEXT,
    dirty_digest TEXT,
    owner_node_id TEXT,
    writer_lease_id TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
);
CREATE INDEX idx_worktrees_workspace_state
    ON worktrees(workspace_identity_digest, state);

CREATE TABLE worktree_leases (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
    owner_epoch INTEGER NOT NULL,
    allowed_paths_json TEXT NOT NULL,
    baseline_revisions_json TEXT NOT NULL,
    state TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_worktree_active_writer
    ON worktree_leases(worktree_id) WHERE state = 'active';

CREATE TABLE worktree_proposals (
    id TEXT PRIMARY KEY,
    worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
    graph_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    base_workspace_revision TEXT NOT NULL,
    worktree_revision TEXT NOT NULL,
    proposal_digest TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_worktree_proposals_worktree
    ON worktree_proposals(worktree_id, created_at DESC);

CREATE TABLE merge_attempts (
    id TEXT PRIMARY KEY,
    workspace_identity_digest TEXT NOT NULL,
    graph_id TEXT,
    proposal_ids_json TEXT NOT NULL,
    base_revision_before TEXT NOT NULL,
    base_revision_after TEXT,
    transaction_id TEXT,
    state TEXT NOT NULL,
    conflict_policy TEXT NOT NULL,
    error_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_merge_attempts_workspace
    ON merge_attempts(workspace_identity_digest, created_at DESC);

CREATE TABLE merge_conflicts (
    id TEXT PRIMARY KEY,
    merge_attempt_id TEXT NOT NULL REFERENCES merge_attempts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    conflict_json TEXT NOT NULL,
    state TEXT NOT NULL,
    resolution_plan_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
CREATE INDEX idx_merge_conflicts_attempt
    ON merge_conflicts(merge_attempt_id, state);
"#,
    },
];

pub const CURRENT_SCHEMA_VERSION: i64 = 11;

pub fn checksum(sql: &str) -> String {
    format!("{:x}", Sha256::digest(sql.as_bytes()))
}

/// Apply all pending migrations in order, verifying checksums of already-applied
/// ones (§18.18 "migration file checksum 검증").
pub fn apply_migrations(conn: &mut Connection) -> Result<Vec<i64>, StoreError> {
    let mut applied = Vec::new();

    for migration in MIGRATIONS {
        let already: Option<String> = table_exists(conn, "schema_migrations")?
            .then(|| {
                conn.query_row(
                    "SELECT checksum FROM schema_migrations WHERE version = ?1",
                    params![migration.version],
                    |row| row.get::<_, String>(0),
                )
                .ok()
            })
            .flatten();

        let expected = checksum(migration.sql);
        if let Some(recorded) = already {
            if recorded != expected {
                return Err(StoreError::Sqlite(rusqlite::Error::InvalidQuery));
            }
            continue;
        }

        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                migration.version,
                migration.name,
                expected,
                cbc_patch::now_iso8601()
            ],
        )?;
        tx.commit()?;
        applied.push(migration.version);
    }

    Ok(applied)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, StoreError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_numbered_forward_only() {
        let mut previous = 0i64;
        for migration in MIGRATIONS {
            assert!(
                migration.version > previous,
                "migration versions must strictly increase"
            );
            previous = migration.version;
        }
        assert_eq!(previous, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn applies_and_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        let first = apply_migrations(&mut conn).unwrap();
        assert_eq!(first, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        let second = apply_migrations(&mut conn).unwrap();
        assert!(second.is_empty(), "re-running must be a no-op");
    }

    #[test]
    fn creates_every_prd_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply_migrations(&mut conn).unwrap();
        // §18.15 P0 logical tables.
        for table in [
            "schema_migrations",
            "workspaces",
            "sessions",
            "turns",
            "events",
            "snapshots",
            "transactions",
            "file_operations",
            "approvals",
            "tasks",
            "jobs",
            "artifacts",
            "usage",
            "edit_plans",
            "edit_operations",
            "edit_receipts",
            "daemon_instances",
            "session_owners",
            "client_attachments",
            "command_receipts",
            "session_commands",
            "evidence_records",
            "evidence_path_bindings",
            "evidence_artifacts",
            "memory_records",
            "memory_evidence_links",
            "memory_relations",
            "memory_transitions",
            "agent_graphs",
            "agent_nodes",
            "agent_edges",
            "agent_attempts",
            "agent_messages",
            "agent_checkpoints",
            "agent_budget_reservations",
            "worktrees",
            "worktree_leases",
            "worktree_proposals",
            "merge_attempts",
            "merge_conflicts",
        ] {
            assert!(table_exists(&conn, table).unwrap(), "missing table {table}");
        }
    }

    #[test]
    fn events_have_unique_session_sequence() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply_migrations(&mut conn).unwrap();
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            sql.contains("PRIMARY KEY (session_id, sequence)"),
            "events must key on (session_id, sequence)"
        );
    }

    #[test]
    fn checksum_detects_tampering() {
        let a = checksum("CREATE TABLE t (a INT);");
        let b = checksum("CREATE TABLE t (a TEXT);");
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn tampered_checksum_is_rejected() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply_migrations(&mut conn).unwrap();
        conn.execute(
            "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1",
            [],
        )
        .unwrap();
        assert!(apply_migrations(&mut conn).is_err());
    }
}
