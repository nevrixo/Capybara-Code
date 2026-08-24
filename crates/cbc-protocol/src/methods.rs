//! RPC namespaces — PRD §20.3.
//!
//! Every method the runtime accepts is enumerated here so that the dispatcher
//! and the drift check in `scripts/check-protocol-drift.ts` share one source of
//! truth. Unknown methods must return JSON-RPC `method not found` (§20.4).

/// TypeScript → Rust requests, in PRD declaration order.
pub const REQUEST_METHODS: &[&str] = &[
    "runtime.initialize",
    "runtime.capabilities",
    "runtime.shutdown",
    "runtime.cancel",
    "runtime.capability.issue",
    "workspace.inspect",
    "workspace.mode.write",
    "workspace.trust.read",
    "workspace.trust.write",
    "workspace.trust.list",
    "workspace.trust.set",
    "workspace.trust.remove",
    "fs.list",
    "fs.glob",
    "fs.search",
    "fs.read",
    "fs.read_many",
    "fs.fingerprint",
    "fs.edit.preview",
    "fs.edit",
    "fs.transaction.begin",
    "fs.patch",
    "fs.write",
    "fs.move",
    "fs.delete",
    "fs.transaction.commit",
    "fs.transaction.rollback",
    "fs.transaction.rollback_to_checkpoint",
    "process.run",
    "process.start",
    "process.input",
    "process.stop",
    "process.status",
    "git.status",
    "git.diff",
    "git.log",
    "git.show",
    "git.checkpoint",
    "credential.store",
    "credential.lease",
    "credential.delete",
    "session.open",
    "session.append",
    "session.snapshot",
    "session.load",
    "session.list",
    "session.resolve",
    "session.set_status",
    "session.export",
    "session.fork",
    "session.delete",
    "memory.search",
    "memory.remember",
    "app.client.upsert",
    "app.subscription.create",
    "app.subscription.ack",
    "app.subscription.state",
    "app.subscription.replay",
    "artifact.create",
    "artifact.read",
    "artifact.delete",
    "update.verify",
];

/// Rust → TypeScript notifications, in PRD declaration order.
pub const NOTIFICATION_METHODS: &[&str] = &[
    "runtime.heartbeat",
    "process.output",
    "process.exited",
    "process.limit_warning",
    "workspace.changed",
    "transaction.conflict",
    "journal.committed",
    "artifact.spilled",
    "sandbox.degraded",
    "runtime.warning",
    "runtime.fatal",
];

/// Methods callable before `runtime.initialize` succeeds.
pub const PRE_INITIALIZE_METHODS: &[&str] = &["runtime.initialize", "runtime.shutdown"];

pub fn is_known_request(method: &str) -> bool {
    REQUEST_METHODS.contains(&method)
}

pub fn is_known_notification(method: &str) -> bool {
    NOTIFICATION_METHODS.contains(&method)
}

pub fn requires_initialization(method: &str) -> bool {
    !PRE_INITIALIZE_METHODS.contains(&method)
}

/// Methods that mutate the workspace. The runtime revalidates the write lease
/// and path guard for each of these regardless of client-side approval (§19.7).
pub const MUTATING_METHODS: &[&str] = &[
    "fs.patch",
    "fs.write",
    "fs.move",
    "fs.delete",
    "fs.edit",
    // A checkpoint rollback rewrites files, so it is revalidated like any other
    // write. It restores content rather than authoring it, but the path guard has
    // the same reason to care either way.
    "fs.transaction.rollback_to_checkpoint",
    "git.checkpoint",
];

pub fn is_mutating(method: &str) -> bool {
    MUTATING_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_every_prd_request_namespace() {
        // PRD §20.3 lists 39 request methods; `fs.transaction.rollback_to_checkpoint`
        // is the 40th, added for the self-correction loop in §11.2. The
        // `workspace.trust.{list,set,remove}` trio (P0-01) makes the CLI manage
        // trust through the runtime instead of writing the store file directly,
        // the five `session.{list,set_status,export,fork,delete}` methods (P0-05)
        // make the SQLite store the single session authority, and `runtime.cancel`
        // (P0-04) lets a client cancel an in-flight request. `fs.fingerprint`
        // validates a preview revision without promoting it to write authority;
        // fs.edit.preview and fs.edit add the Rust-authoritative structured edit path.
        assert_eq!(REQUEST_METHODS.len(), 62);
        for m in [
            "runtime.initialize",
            "workspace.mode.write",
            "fs.transaction.begin",
            "fs.transaction.commit",
            "fs.transaction.rollback",
            "fs.transaction.rollback_to_checkpoint",
            "fs.fingerprint",
            "fs.edit.preview",
            "fs.edit",
            "process.run",
            "git.checkpoint",
            "credential.lease",
            "session.append",
            "artifact.create",
            "memory.search",
            "memory.remember",
            "app.subscription.ack",
            "app.subscription.replay",
            "update.verify",
        ] {
            assert!(is_known_request(m), "missing request method {m}");
        }
    }

    #[test]
    fn covers_every_prd_notification() {
        assert_eq!(NOTIFICATION_METHODS.len(), 11);
        assert!(is_known_notification("sandbox.degraded"));
        assert!(is_known_notification("transaction.conflict"));
    }

    #[test]
    fn no_duplicate_methods() {
        let mut sorted = REQUEST_METHODS.to_vec();
        sorted.sort_unstable();
        let len_before = sorted.len();
        sorted.dedup();
        assert_eq!(len_before, sorted.len(), "duplicate request method");
    }

    #[test]
    fn unknown_methods_are_rejected() {
        assert!(!is_known_request("codex.app_server"));
        assert!(!is_known_request("fs.rmrf"));
    }

    #[test]
    fn initialize_is_allowed_before_handshake() {
        assert!(!requires_initialization("runtime.initialize"));
        assert!(requires_initialization("fs.read"));
    }

    #[test]
    fn mutating_set_matches_write_surface() {
        assert!(is_mutating("fs.write"));
        assert!(is_mutating("fs.delete"));
        assert!(is_mutating("fs.edit"));
        assert!(is_mutating("fs.transaction.rollback_to_checkpoint"));
        assert!(!is_mutating("fs.read"));
        assert!(!is_mutating("fs.transaction.rollback"));
        assert!(!is_mutating("git.status"));
    }
}
