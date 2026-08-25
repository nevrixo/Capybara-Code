//! Workspace trust records — PRD §13.6, PERM-001.
//!
//! Trust is keyed on the canonical path *and* the filesystem identity, so
//! replacing a trusted directory with a symlink to a hostile tree does not
//! inherit trust ("trust record는 canonical path와 filesystem identity를
//! 저장한다. symlink path만 저장하지 않는다").

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrustState {
    /// Never seen, or explicitly revoked. Project config, project MCP stdio
    /// servers, project agents, and project approval policy are all ignored.
    Untrusted,
    /// Trusted for this invocation only.
    TrustedOnce,
    /// Persistently trusted.
    TrustedAlways,
    /// Explicitly opened read-only: reads allowed, no mutation.
    ReadOnly,
}

impl TrustState {
    /// §13.6: only trusted workspaces may contribute executable config.
    pub fn allows_project_config(&self) -> bool {
        matches!(self, TrustState::TrustedOnce | TrustState::TrustedAlways)
    }

    pub fn allows_project_mcp_stdio(&self) -> bool {
        self.allows_project_config()
    }

    pub fn allows_project_agents(&self) -> bool {
        self.allows_project_config()
    }

    pub fn allows_project_skill_body(&self) -> bool {
        self.allows_project_config()
    }

    pub fn allows_mutation(&self) -> bool {
        matches!(self, TrustState::TrustedOnce | TrustState::TrustedAlways)
    }

    pub fn label(&self) -> &'static str {
        match self {
            TrustState::Untrusted => "untrusted",
            TrustState::TrustedOnce => "trusted (session)",
            TrustState::TrustedAlways => "trusted",
            TrustState::ReadOnly => "read-only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    /// Canonical absolute path at the time of the trust decision.
    pub canonical_path: String,
    /// Filesystem identity: `device:inode` on Unix, volume+file id elsewhere.
    /// Empty when the platform cannot supply it.
    pub filesystem_id: String,
    pub state: TrustState,
    pub decided_at: String,
    /// Git root if the workspace is a repository, for diagnostics.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_root: Option<String>,
}

impl TrustRecord {
    pub fn matches(&self, canonical_path: &str, filesystem_id: &str) -> bool {
        if self.canonical_path != canonical_path {
            return false;
        }
        if self.filesystem_id.is_empty() || filesystem_id.is_empty() {
            return false;
        }
        self.filesystem_id == filesystem_id
    }
}

/// Persistent trust store. Lives in user-local config, never in the project
/// (§13.4: `allow_project` rules go to a user-local policy store).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrustStore {
    #[serde(default)]
    pub records: BTreeMap<String, TrustRecord>,
}

/// The historical TypeScript trust record (`{version: 1, records: {key: {path,
/// state, decidedAt, fingerprint?}}}`). The runtime's store is authoritative now
/// (§13.6), but a one-shot import keeps existing decisions alive (P0-01).
#[derive(Debug, Deserialize)]
struct LegacyTsStore {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    records: BTreeMap<String, LegacyTsRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTsRecord {
    path: String,
    state: TrustState,
    decided_at: String,
}

/// Result of loading the trust file, including whether a legacy TypeScript store
/// was imported and should be re-persisted in the runtime format.
#[derive(Debug)]
pub struct LoadedTrust {
    pub store: TrustStore,
    pub migrated_from_legacy: bool,
}

impl TrustStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(path: &Path) -> Self {
        Self::load_with_migration(path).store
    }

    /// Read the trust file, importing the legacy TypeScript shape when the file
    /// predates the runtime store. Both formats describe the same decisions; the
    /// runtime format wins once present.
    pub fn load_with_migration(path: &Path) -> LoadedTrust {
        let Ok(raw) = std::fs::read_to_string(path) else {
            return LoadedTrust {
                store: Self::new(),
                migrated_from_legacy: false,
            };
        };
        if let Ok(store) = serde_json::from_str::<TrustStore>(&raw) {
            return LoadedTrust {
                store,
                migrated_from_legacy: false,
            };
        }
        if let Ok(legacy) = serde_json::from_str::<LegacyTsStore>(&raw) {
            if legacy.version.is_some() && legacy.version != Some(1) {
                // An unknown future version fails closed, like a corrupt file.
                return LoadedTrust {
                    store: Self::new(),
                    migrated_from_legacy: false,
                };
            }
            let mut store = TrustStore::new();
            for record in legacy.records.into_values() {
                let canonical_path = record.path.clone();
                let filesystem_id = filesystem_id(Path::new(&canonical_path));
                store.set(TrustRecord {
                    canonical_path,
                    filesystem_id,
                    state: record.state,
                    decided_at: record.decided_at,
                    git_root: None,
                });
            }
            return LoadedTrust {
                store,
                migrated_from_legacy: true,
            };
        }
        LoadedTrust {
            store: Self::new(),
            migrated_from_legacy: false,
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        // Trust decisions are security state; write atomically.
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, json.as_bytes())?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Look up trust for a canonical path plus identity. A stored record whose
    /// filesystem identity no longer matches is treated as untrusted.
    pub fn state_for(&self, canonical_path: &str, filesystem_id: &str) -> TrustState {
        match self.records.get(canonical_path) {
            Some(record) if record.matches(canonical_path, filesystem_id) => record.state,
            Some(_) => TrustState::Untrusted,
            None => {
                // Mirrored records from the host may be keyed differently (for
                // example a lowercased key around a case-preserving path). Fall
                // back to matching the record's own canonical path; identity
                // mismatches still downgrade to untrusted.
                match self
                    .records
                    .values()
                    .find(|record| record.canonical_path == canonical_path)
                {
                    Some(record) if record.matches(canonical_path, filesystem_id) => record.state,
                    _ => TrustState::Untrusted,
                }
            }
        }
    }

    pub fn set(&mut self, record: TrustRecord) {
        self.records.insert(record.canonical_path.clone(), record);
    }

    pub fn remove(&mut self, canonical_path: &str) -> bool {
        self.records.remove(canonical_path).is_some()
    }
}

/// Filesystem identity for a path (§13.6 "Trust identity").
pub fn filesystem_id(path: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(path) {
            Ok(meta) => format!("{}:{}", meta.dev(), meta.ino()),
            Err(_) => String::new(),
        }
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;

        #[repr(C)]
        struct FileTime {
            low: u32,
            high: u32,
        }
        #[repr(C)]
        struct ByHandleFileInformation {
            attributes: u32,
            creation: FileTime,
            access: FileTime,
            write: FileTime,
            volume_serial: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(
                file: *mut c_void,
                information: *mut ByHandleFileInformation,
            ) -> i32;
        }

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

        let file = match OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
        {
            Ok(file) => file,
            Err(_) => return String::new(),
        };
        let mut information: ByHandleFileInformation = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
        if ok == 0 {
            return String::new();
        }
        let index = ((information.index_high as u64) << 32) | information.index_low as u64;
        if information.volume_serial == 0 && index == 0 {
            String::new()
        } else {
            format!("{}:{index}", information.volume_serial)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn record(path: &str, fsid: &str, state: TrustState) -> TrustRecord {
        TrustRecord {
            canonical_path: path.into(),
            filesystem_id: fsid.into(),
            state,
            decided_at: "2026-07-31T10:00:00Z".into(),
            git_root: None,
        }
    }

    #[test]
    fn unknown_path_is_untrusted() {
        let store = TrustStore::new();
        assert_eq!(store.state_for("/a", "1:2"), TrustState::Untrusted);
    }

    #[test]
    fn trusted_path_returns_state() {
        let mut store = TrustStore::new();
        store.set(record("/a", "1:2", TrustState::TrustedAlways));
        assert_eq!(store.state_for("/a", "1:2"), TrustState::TrustedAlways);
    }

    #[test]
    fn identity_mismatch_downgrades_to_untrusted() {
        // A trusted directory replaced by a different inode must not inherit
        // trust (§13.6).
        let mut store = TrustStore::new();
        store.set(record("/a", "1:2", TrustState::TrustedAlways));
        assert_eq!(store.state_for("/a", "9:9"), TrustState::Untrusted);
    }

    #[test]
    fn missing_identity_never_grants_persistent_trust() {
        let mut store = TrustStore::new();
        store.set(record("/a", "", TrustState::TrustedAlways));
        assert_eq!(store.state_for("/a", ""), TrustState::Untrusted);
        assert_eq!(store.state_for("/a", "1:2"), TrustState::Untrusted);
    }
    #[test]
    fn untrusted_blocks_project_capabilities() {
        // PERM-001: untrusted project must not auto-launch MCP stdio commands.
        let s = TrustState::Untrusted;
        assert!(!s.allows_project_config());
        assert!(!s.allows_project_mcp_stdio());
        assert!(!s.allows_project_agents());
        assert!(!s.allows_project_skill_body());
        assert!(!s.allows_mutation());
    }

    #[test]
    fn read_only_allows_reads_but_no_mutation() {
        let s = TrustState::ReadOnly;
        assert!(!s.allows_mutation());
        assert!(!s.allows_project_config());
    }

    #[test]
    fn trusted_once_and_always_allow_mutation() {
        assert!(TrustState::TrustedOnce.allows_mutation());
        assert!(TrustState::TrustedAlways.allows_mutation());
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trust.json");
        let mut store = TrustStore::new();
        store.set(record("/proj", "3:4", TrustState::TrustedAlways));
        store.save(&path).expect("save");

        let loaded = TrustStore::load(&path);
        assert_eq!(loaded.state_for("/proj", "3:4"), TrustState::TrustedAlways);
    }

    #[test]
    fn corrupt_store_falls_back_to_empty_not_panic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trust.json");
        std::fs::write(&path, b"{not json").unwrap();
        let loaded = TrustStore::load(&path);
        assert!(loaded.records.is_empty());
    }

    #[test]
    fn remove_revokes_trust() {
        let mut store = TrustStore::new();
        store.set(record("/a", "1:2", TrustState::TrustedAlways));
        assert!(store.remove("/a"));
        assert_eq!(store.state_for("/a", "1:2"), TrustState::Untrusted);
        assert!(!store.remove("/a"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn filesystem_id_is_stable_for_same_dir() {
        let dir = TempDir::new().unwrap();
        let a = filesystem_id(dir.path());
        let b = filesystem_id(dir.path());
        assert!(!a.is_empty());
        assert_eq!(a, b);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn filesystem_id_differs_between_dirs() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        assert_ne!(filesystem_id(a.path()), filesystem_id(b.path()));
    }

    #[test]
    fn imports_the_legacy_typescript_store_shape() {
        // P0-01: the host used to persist `{version: 1, records: {key: {path,
        // state, decidedAt}}}`. The runtime must import those decisions instead
        // of discarding them.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trust.json");
        std::fs::write(
            &path,
            r#"{
                "version": 1,
                "records": {
                    "/work/x": {
                        "path": "/work/x",
                        "state": "trusted-always",
                        "decidedAt": "2026-07-31T00:00:00Z"
                    },
                    "/work/locked": {
                        "path": "/work/locked",
                        "state": "read-only",
                        "decidedAt": "2026-07-31T00:00:00Z"
                    }
                }
            }"#,
        )
        .unwrap();

        let loaded = TrustStore::load_with_migration(&path);
        assert!(loaded.migrated_from_legacy);
        assert_eq!(loaded.store.state_for("/work/x", ""), TrustState::Untrusted);
        assert_eq!(
            loaded.store.state_for("/work/locked", ""),
            TrustState::Untrusted
        );
    }

    #[test]
    fn a_missing_file_is_not_a_migration() {
        let dir = TempDir::new().unwrap();
        let loaded = TrustStore::load_with_migration(&dir.path().join("trust.json"));
        assert!(!loaded.migrated_from_legacy);
        assert!(loaded.store.records.is_empty());
    }

    #[test]
    fn an_unknown_future_version_fails_closed() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trust.json");
        std::fs::write(
            &path,
            r#"{"version": 99, "records": {"/x": {"path": "/x", "state": "trusted-always", "decidedAt": "now"}}}"#,
        )
        .unwrap();
        let loaded = TrustStore::load_with_migration(&path);
        assert!(!loaded.migrated_from_legacy);
        assert!(loaded.store.records.is_empty());
    }

    #[test]
    fn a_differently_keyed_mirror_record_still_matches() {
        // Host mirrors may key records by a lowercased path while lookup uses the
        // case-preserving canonical path.
        let mut store = TrustStore::new();
        store.set(record("/work/Repo", "1:2", TrustState::TrustedAlways));
        // Keyed under a different shape than the lookup path.
        store.records.clear();
        store.records.insert(
            "/work/repo".to_string(),
            record("/work/Repo", "1:2", TrustState::TrustedAlways),
        );
        assert_eq!(
            store.state_for("/work/Repo", "1:2"),
            TrustState::TrustedAlways
        );
    }
}
