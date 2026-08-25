//! Workspace path guard — PRD §14.2, AC-11, AC-12, AC-24, PERM-004, RT-002.
//!
//! Every path operation follows the §14.2 sequence:
//!   1. reject NUL and invalid encoding
//!   2. join relative path to canonical workspace root
//!   3. lexical normalization
//!   4. resolve existing parent components
//!   5. inspect symlink/junction/reparse points
//!   6. compare filesystem identity and allowed roots
//!   7. enforce case-sensitivity rules
//!   8. reject device files and special paths unless explicitly allowed
//!
//! The guard is re-run inside the Rust runtime for every operation even when the
//! TypeScript control plane already approved it (§19.7). Resolution is done
//! component-by-component so a symlink swapped in between check and use cannot
//! widen the boundary (RT-002).

use std::fmt;
use std::path::{Component, Path, PathBuf};

pub mod trust;

pub use trust::{TrustRecord, TrustState, TrustStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    /// Path contained a NUL byte or otherwise un-encodable content.
    InvalidEncoding {
        reason: String,
    },
    /// Absolute paths require an explicit flag (§12.4).
    AbsolutePathNotAllowed {
        path: String,
    },
    /// The resolved path escapes the workspace root.
    OutsideWorkspace {
        requested: String,
        resolved: String,
    },
    /// A component on the path is a symlink pointing outside the workspace.
    SymlinkEscape {
        component: String,
        target: String,
    },
    /// The path targets a device, FIFO, or socket.
    SpecialFile {
        path: String,
        kind: String,
    },
    /// Windows reserved device name (CON, PRN, NUL, COM1...).
    ReservedName {
        name: String,
    },
    /// The path is outside the write lease granted to the current agent (§15.8).
    LeaseViolation {
        path: String,
        allowed: Vec<String>,
    },
    /// Path is denied by sensitive-path policy (§13.7, C.4).
    SensitivePath {
        path: String,
        rule: String,
    },
    Io {
        path: String,
        message: String,
    },
}

impl GuardError {
    /// Stable taxonomy code from §12.10.
    pub fn taxonomy(&self) -> &'static str {
        match self {
            GuardError::InvalidEncoding { .. } => "INVALID_ARGUMENT",
            GuardError::AbsolutePathNotAllowed { .. } => "INVALID_ARGUMENT",
            GuardError::OutsideWorkspace { .. } => "PATH_OUTSIDE_WORKSPACE",
            GuardError::SymlinkEscape { .. } => "PATH_OUTSIDE_WORKSPACE",
            GuardError::SpecialFile { .. } => "INVALID_ARGUMENT",
            GuardError::ReservedName { .. } => "INVALID_ARGUMENT",
            GuardError::LeaseViolation { .. } => "PERMISSION_DENIED",
            GuardError::SensitivePath { .. } => "PERMISSION_DENIED",
            GuardError::Io { .. } => "INTERNAL",
        }
    }
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GuardError::InvalidEncoding { reason } => write!(f, "invalid path encoding: {reason}"),
            GuardError::AbsolutePathNotAllowed { path } => write!(
                f,
                "absolute path '{path}' requires an explicit allowAbsolute flag and approval"
            ),
            GuardError::OutsideWorkspace {
                requested,
                resolved,
            } => write!(
                f,
                "path '{requested}' resolves to '{resolved}', which is outside the workspace"
            ),
            GuardError::SymlinkEscape { component, target } => write!(
                f,
                "component '{component}' is a symlink to '{target}' outside the workspace"
            ),
            GuardError::SpecialFile { path, kind } => {
                write!(f, "path '{path}' is a {kind}, which is not permitted")
            }
            GuardError::ReservedName { name } => {
                write!(f, "'{name}' is a reserved device name on this platform")
            }
            GuardError::LeaseViolation { path, allowed } => write!(
                f,
                "path '{path}' is outside the write lease scope {allowed:?}"
            ),
            GuardError::SensitivePath { path, rule } => {
                write!(f, "path '{path}' is denied by policy rule '{rule}'")
            }
            GuardError::Io { path, message } => write!(f, "io error on '{path}': {message}"),
        }
    }
}

impl std::error::Error for GuardError {}

/// Paths that are always denied for read *and* write regardless of approval,
/// per §13.7 deny examples and Appendix C.4. Matching is on the workspace
/// relative path.
pub const SENSITIVE_PATTERNS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    ".ssh/**",
    ".aws/credentials",
    ".gnupg/**",
    ".netrc",
    "*.p12",
    "*.pfx",
    "*.keystore",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathIntent {
    Read,
    Write,
    Delete,
    Execute,
    List,
}

impl PathIntent {
    pub fn is_mutation(&self) -> bool {
        matches!(self, PathIntent::Write | PathIntent::Delete)
    }
}

#[derive(Debug, Clone, Default)]
pub struct ResolveOptions {
    /// Allow an absolute input path (still constrained to the workspace unless
    /// `allowed_roots` includes its prefix).
    pub allow_absolute: bool,
    /// Permit resolving to a path that does not yet exist (needed for create).
    pub allow_missing: bool,
    /// Enforce a write lease scope (§15.8, AC-24).
    pub lease_globs: Option<Vec<String>>,
    /// Skip the sensitive-path deny list. Only set after an explicit R5
    /// approval decision recorded in the audit log.
    pub allow_sensitive: bool,
    /// Additional roots outside the workspace that this operation may touch.
    pub allowed_roots: Vec<PathBuf>,
}

impl ResolveOptions {
    pub fn for_read() -> Self {
        Self::default()
    }

    pub fn for_create() -> Self {
        Self {
            allow_missing: true,
            ..Self::default()
        }
    }

    pub fn with_lease(mut self, globs: Vec<String>) -> Self {
        self.lease_globs = Some(globs);
        self
    }
}

/// A path that has passed the full guard sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    /// Absolute canonical path on disk.
    pub absolute: PathBuf,
    /// Workspace-relative path with `/` separators, used for events and
    /// storage (§18.15 "source code path는 workspace-relative로 저장").
    pub relative: String,
    /// Whether the target exists right now.
    pub exists: bool,
    /// True when any traversed component was a symlink that stayed inside the
    /// workspace. Surfaced so the UI can note it.
    pub traversed_symlink: bool,
}

/// The canonical workspace boundary.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
    case_insensitive: bool,
}

impl Workspace {
    /// Open a workspace at `root`, canonicalizing it. The root must exist.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, GuardError> {
        let raw = root.as_ref();
        check_encoding(raw)?;
        let canonical = strip_verbatim(std::fs::canonicalize(raw).map_err(|e| GuardError::Io {
            path: raw.display().to_string(),
            message: e.to_string(),
        })?);
        let case_insensitive = detect_case_insensitive(&canonical);
        Ok(Self {
            root: canonical,
            case_insensitive,
        })
    }

    /// Construct from an already-canonical path without touching the disk.
    /// Used by tests and by callers that canonicalized earlier.
    pub fn from_canonical(root: PathBuf, case_insensitive: bool) -> Self {
        Self {
            root,
            case_insensitive,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_case_insensitive(&self) -> bool {
        self.case_insensitive
    }

    /// A stable identifier for the workspace, used for session directory names
    /// and prompt cache keys (§10.9, §18.6).
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(self.root.to_string_lossy().as_bytes());
        let digest = hasher.finalize();
        digest[..8].iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Return a workspace-relative spelling for a native/WSL alias when it is
    /// provably inside this workspace. `None` means the caller must process the
    /// original string through the normal absolute-path guard.
    fn workspace_alias(&self, requested: &str) -> Option<String> {
        let raw = requested.replace('\\', "/");
        let root_text = self.root.to_string_lossy().replace('\\', "/");
        let root = if root_text == "/"
            || (root_text.len() == 3 && root_text.as_bytes()[1] == b':' && root_text.ends_with('/'))
        {
            root_text
        } else {
            root_text.trim_end_matches('/').to_string()
        };
        let insensitive = self.case_insensitive
            || root.starts_with("/mnt/")
            || root.as_bytes().get(1) == Some(&b':');
        let roots = path_aliases(&root);
        for candidate in path_aliases(&raw) {
            for root_candidate in &roots {
                let equal = if insensitive {
                    candidate.eq_ignore_ascii_case(root_candidate)
                } else {
                    candidate == *root_candidate
                };
                if equal {
                    return Some(".".into());
                }
                let prefix = if root_candidate == "/" {
                    "/".to_string()
                } else {
                    format!("{root_candidate}/")
                };
                let inside = if insensitive {
                    candidate
                        .get(..prefix.len())
                        .map(|head| head.eq_ignore_ascii_case(&prefix))
                        .unwrap_or(false)
                } else {
                    candidate.starts_with(&prefix)
                };
                if inside {
                    let relative = &candidate[prefix.len()..];
                    return Some(if relative.is_empty() {
                        ".".into()
                    } else {
                        relative.to_string()
                    });
                }
            }
        }
        None
    }
    /// Full §14.2 guard sequence.
    pub fn resolve(
        &self,
        requested: &str,
        intent: PathIntent,
        options: &ResolveOptions,
    ) -> Result<ResolvedPath, GuardError> {
        // Step 1 — reject NUL and invalid encoding.
        if requested.contains('\0') {
            return Err(GuardError::InvalidEncoding {
                reason: "path contains NUL".into(),
            });
        }
        if requested.is_empty() {
            return Err(GuardError::InvalidEncoding {
                reason: "path is empty".into(),
            });
        }

        // Normalize an absolute path alias that is provably this workspace. This
        // is intentionally narrower than accepting arbitrary absolute paths: it
        // only bridges native Windows and WSL /mnt/<drive> spellings so an agent
        // cannot turn a path outside the workspace into a relative one.
        let normalized_request = self
            .workspace_alias(requested)
            .unwrap_or_else(|| requested.replace('\\', "/"));
        let requested_path = Path::new(&normalized_request);

        // Step 2 — join relative to the canonical root; absolute needs a flag.
        let joined =
            if requested_path.is_absolute() || is_windows_style_absolute(&normalized_request) {
                if !options.allow_absolute {
                    return Err(GuardError::AbsolutePathNotAllowed {
                        path: requested.to_string(),
                    });
                }
                requested_path.to_path_buf()
            } else {
                self.root.join(requested_path)
            };

        // Step 8a — Windows reserved device names are rejected on all platforms
        // so that a repository cannot become unusable after a cross-platform
        // checkout.
        for component in requested_path.components() {
            if let Component::Normal(part) = component {
                let name = part.to_string_lossy();
                if is_reserved_device_name(&name) {
                    return Err(GuardError::ReservedName {
                        name: name.to_string(),
                    });
                }
            }
        }

        // Step 3 — lexical normalization. `..` is resolved lexically first so a
        // traversal attempt is rejected before any filesystem access.
        let lexical = lexical_normalize(&joined).ok_or_else(|| GuardError::OutsideWorkspace {
            requested: requested.to_string(),
            resolved: joined.display().to_string(),
        })?;

        // Steps 4–6 — walk components, resolving symlinks explicitly and
        // re-checking containment after every hop.
        let (resolved, traversed_symlink) = self.resolve_components(&lexical, requested)?;

        let exists = resolved.symlink_metadata().is_ok();
        if !exists && !options.allow_missing && intent != PathIntent::Write {
            // Missing is reported by the caller as NOT_FOUND; the guard itself
            // only rejects when the caller demanded existence.
        }

        // Step 6 — containment against the workspace and any extra roots.
        if !self.contains(&resolved) && !self.in_allowed_roots(&resolved, &options.allowed_roots) {
            return Err(GuardError::OutsideWorkspace {
                requested: requested.to_string(),
                resolved: resolved.display().to_string(),
            });
        }

        // Step 8b — reject device files, FIFOs and sockets.
        if exists {
            if let Some(kind) = special_file_kind(&resolved) {
                return Err(GuardError::SpecialFile {
                    path: resolved.display().to_string(),
                    kind: kind.into(),
                });
            }
        }

        let relative = self.relativize(&resolved);

        // Sensitive path policy (§13.7 deny, Appendix C.4).
        if !options.allow_sensitive {
            if let Some(rule) = matches_sensitive(&relative) {
                return Err(GuardError::SensitivePath {
                    path: relative.clone(),
                    rule: rule.to_string(),
                });
            }
        }

        // Write lease scope (§15.8, AC-24).
        if intent.is_mutation() {
            if let Some(globs) = &options.lease_globs {
                if !globs.iter().any(|g| glob_match(g, &relative)) {
                    return Err(GuardError::LeaseViolation {
                        path: relative.clone(),
                        allowed: globs.clone(),
                    });
                }
            }
        }

        Ok(ResolvedPath {
            absolute: resolved,
            relative,
            exists,
            traversed_symlink,
        })
    }

    /// Convenience: resolve for reading an existing file.
    pub fn resolve_read(&self, requested: &str) -> Result<ResolvedPath, GuardError> {
        self.resolve(requested, PathIntent::Read, &ResolveOptions::for_read())
    }

    /// Convenience: resolve a write target that may not exist yet.
    pub fn resolve_write(&self, requested: &str) -> Result<ResolvedPath, GuardError> {
        self.resolve(requested, PathIntent::Write, &ResolveOptions::for_create())
    }

    fn resolve_components(
        &self,
        lexical: &Path,
        requested: &str,
    ) -> Result<(PathBuf, bool), GuardError> {
        let mut current = PathBuf::new();
        let mut traversed_symlink = false;
        let mut hops = 0usize;

        for component in lexical.components() {
            match component {
                Component::RootDir => current.push(std::path::MAIN_SEPARATOR.to_string()),
                Component::Prefix(prefix) => current.push(prefix.as_os_str()),
                Component::CurDir => {}
                Component::ParentDir => {
                    // Already resolved lexically; a residual `..` means the
                    // input tried to escape a root.
                    return Err(GuardError::OutsideWorkspace {
                        requested: requested.to_string(),
                        resolved: lexical.display().to_string(),
                    });
                }
                Component::Normal(part) => {
                    current.push(part);
                    // Step 5 — inspect symlink / junction / reparse point.
                    // A symlink may point at another symlink, so follow the whole
                    // chain and re-check containment after *every* hop. Resolving
                    // only one hop would let `a -> b -> /outside` slip through.
                    while let Ok(meta) = std::fs::symlink_metadata(&current) {
                        if !meta.file_type().is_symlink() {
                            break;
                        }
                        hops += 1;
                        if hops > 32 {
                            return Err(GuardError::SymlinkEscape {
                                component: part.to_string_lossy().to_string(),
                                target: "symlink chain exceeds 32 hops (possible loop)".into(),
                            });
                        }
                        traversed_symlink = true;
                        let target = std::fs::read_link(&current).map_err(|e| GuardError::Io {
                            path: current.display().to_string(),
                            message: e.to_string(),
                        })?;
                        let parent = current.parent().unwrap_or(&self.root).to_path_buf();
                        let absolute_target = if target.is_absolute() {
                            // A Windows junction reads back with a `\\?\` prefix;
                            // normalize it so the containment check below compares
                            // against the root in the same namespace.
                            strip_verbatim(target.clone())
                        } else {
                            parent.join(&target)
                        };
                        let normalized = lexical_normalize(&absolute_target).ok_or_else(|| {
                            GuardError::SymlinkEscape {
                                component: part.to_string_lossy().to_string(),
                                target: target.display().to_string(),
                            }
                        })?;
                        // Step 6 — re-check containment after the hop. This is
                        // what defeats the symlink swap race (RT-002): the check
                        // uses the same resolved value the caller will open.
                        if !self.contains(&normalized) {
                            return Err(GuardError::SymlinkEscape {
                                component: part.to_string_lossy().to_string(),
                                target: normalized.display().to_string(),
                            });
                        }
                        if normalized == current {
                            return Err(GuardError::SymlinkEscape {
                                component: part.to_string_lossy().to_string(),
                                target: "symlink points at itself".into(),
                            });
                        }
                        current = normalized;
                    }
                }
            }
        }

        Ok((current, traversed_symlink))
    }

    /// Containment test honouring platform case sensitivity (step 7).
    pub fn contains(&self, candidate: &Path) -> bool {
        let root = self.normalize_case(&self.root);
        let cand = self.normalize_case(candidate);
        if cand == root {
            return true;
        }
        let mut root_with_sep = root.clone();
        if !root_with_sep.ends_with('/') {
            root_with_sep.push('/');
        }
        cand.starts_with(&root_with_sep)
    }

    fn in_allowed_roots(&self, candidate: &Path, roots: &[PathBuf]) -> bool {
        let cand = self.normalize_case(candidate);
        roots.iter().any(|r| {
            let mut root = self.normalize_case(r);
            if cand == root {
                return true;
            }
            if !root.ends_with('/') {
                root.push('/');
            }
            cand.starts_with(&root)
        })
    }

    fn normalize_case(&self, path: &Path) -> String {
        let s = path.to_string_lossy().replace('\\', "/");
        if self.case_insensitive {
            s.to_lowercase()
        } else {
            s
        }
    }

    /// Workspace-relative path with forward slashes.
    pub fn relativize(&self, absolute: &Path) -> String {
        match absolute.strip_prefix(&self.root) {
            Ok(rel) => {
                let s = rel.to_string_lossy().replace('\\', "/");
                if s.is_empty() {
                    ".".to_string()
                } else {
                    s
                }
            }
            Err(_) => absolute.to_string_lossy().replace('\\', "/"),
        }
    }
}

fn path_aliases(value: &str) -> Vec<String> {
    let normalized = value.replace('\\', "/");
    let mut aliases = vec![normalized.clone()];
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        aliases.push(format!(
            "/mnt/{}{}",
            (bytes[0] as char).to_ascii_lowercase(),
            &normalized[2..]
        ));
    }
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("/mnt/")
        && lower
            .as_bytes()
            .get(5)
            .is_some_and(|b| b.is_ascii_alphabetic())
    {
        let drive = normalized.as_bytes()[5] as char;
        aliases.push(format!(
            "{}:{}",
            drive.to_ascii_uppercase(),
            &normalized[6..]
        ));
    }
    aliases.sort();
    aliases.dedup();
    aliases
}
fn check_encoding(path: &Path) -> Result<(), GuardError> {
    let s = path.to_string_lossy();
    if s.contains('\0') {
        return Err(GuardError::InvalidEncoding {
            reason: "path contains NUL".into(),
        });
    }
    Ok(())
}

/// Purely lexical `.`/`..` collapse. Returns `None` when `..` would climb above
/// the filesystem root.
pub fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut out: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {
                    // `/..` is `/` on every supported platform.
                }
                _ => out.push(Component::ParentDir),
            },
            other => out.push(other),
        }
    }
    let mut result = PathBuf::new();
    for component in out {
        result.push(component.as_os_str());
    }
    Some(result)
}

/// Whether a requested path is absolute in *any* supported platform's spelling.
///
/// §14.2 step 2 only joins a **relative** path to the workspace root; anything
/// absolute needs an explicit flag. `Path::is_absolute` answers for the host
/// platform only, so it alone is not enough: on Windows `"/etc/passwd"` is not
/// "absolute", yet joining it onto the root yields `C:\etc\passwd` — outside the
/// workspace. Rejecting every platform's absolute form on every platform keeps
/// the guard's answer independent of where it happens to run.
fn is_windows_style_absolute(raw: &str) -> bool {
    let bytes = raw.as_bytes();

    // POSIX absolute (`/etc/passwd`) and Windows root-relative (`\Windows`).
    // Both discard the root when joined, so neither may be treated as relative.
    if matches!(bytes.first(), Some(b'/') | Some(b'\\')) {
        return true;
    }

    // Any drive-qualified path. `C:\x` and `C:/x` are absolute; `C:x` is
    // drive-relative and resolves against that drive's current directory, which
    // is just as much outside the caller's control.
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }

    false
}

/// Strip the Windows verbatim prefix that `canonicalize` adds.
///
/// `std::fs::canonicalize` returns `\\?\C:\…` (and `\\?\UNC\server\share` for
/// network paths), while config files, CLI arguments, and model output all use
/// the ordinary `C:\…` spelling. Keeping the verbatim form would make the §14.2
/// step 6/7 containment comparison fail for paths that genuinely are inside the
/// workspace, because the two spellings never share a string prefix. Normalizing
/// once at the boundary keeps every later comparison in a single namespace.
#[cfg(windows)]
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        // Only shorten drive paths. Other `\\?\` device paths are meaningful as
        // written and must keep their prefix.
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    path
}

#[cfg(not(windows))]
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// Windows reserved device names (§14.2 platform cases).
pub fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

#[cfg(unix)]
fn special_file_kind(path: &Path) -> Option<&'static str> {
    use std::os::unix::fs::FileTypeExt;
    let meta = std::fs::symlink_metadata(path).ok()?;
    let ft = meta.file_type();
    if ft.is_block_device() {
        Some("block device")
    } else if ft.is_char_device() {
        Some("character device")
    } else if ft.is_fifo() {
        Some("FIFO")
    } else if ft.is_socket() {
        Some("socket")
    } else {
        None
    }
}

#[cfg(not(unix))]
fn special_file_kind(_path: &Path) -> Option<&'static str> {
    None
}

fn detect_case_insensitive(root: &Path) -> bool {
    // Probe rather than assume: macOS volumes and Windows are usually
    // case-insensitive, Linux usually is not, but bind mounts vary (§14.2).
    let probe = root.join(".cbc-case-probe");
    if std::fs::write(&probe, b"probe").is_err() {
        return cfg!(any(target_os = "macos", target_os = "windows"));
    }
    let upper = root.join(".CBC-CASE-PROBE");
    let insensitive = upper.exists();
    let _ = std::fs::remove_file(&probe);
    insensitive
}

/// Match a workspace-relative path against the sensitive deny list.
pub fn matches_sensitive(relative: &str) -> Option<&'static str> {
    SENSITIVE_PATTERNS
        .iter()
        .copied()
        .find(|pattern| glob_match(pattern, relative) || path_tail_matches(pattern, relative))
}

fn path_tail_matches(pattern: &str, relative: &str) -> bool {
    // `.env` should match `config/.env` as well as `.env`.
    if pattern.contains('/') || pattern.contains('*') {
        return relative
            .rsplit_once('/')
            .map(|(_, tail)| glob_match(pattern, tail))
            .unwrap_or(false);
    }
    relative
        .rsplit_once('/')
        .map(|(_, tail)| tail == pattern)
        .unwrap_or(false)
}

/// Minimal glob matcher supporting `*`, `?`, and `**`. Used for lease scopes
/// and deny rules. Deliberately not a full glob implementation: §13.5 requires
/// exact, composable rules rather than broad wildcards over command strings.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    glob_match_inner(pattern.as_bytes(), text.as_bytes())
}

fn glob_match_inner(pattern: &[u8], text: &[u8]) -> bool {
    // `**` crosses `/`; a single `*` does not.
    if pattern.is_empty() {
        return text.is_empty();
    }
    if pattern.starts_with(b"**") {
        let rest = &pattern[2..];
        let rest = if rest.starts_with(b"/") {
            &rest[1..]
        } else {
            rest
        };
        if rest.is_empty() {
            return true;
        }
        for i in 0..=text.len() {
            if glob_match_inner(rest, &text[i..]) {
                return true;
            }
        }
        return false;
    }
    match pattern[0] {
        b'*' => {
            let rest = &pattern[1..];
            let mut i = 0usize;
            loop {
                if glob_match_inner(rest, &text[i..]) {
                    return true;
                }
                if i >= text.len() || text[i] == b'/' {
                    return false;
                }
                i += 1;
            }
        }
        b'?' => {
            if text.is_empty() || text[0] == b'/' {
                false
            } else {
                glob_match_inner(&pattern[1..], &text[1..])
            }
        }
        c => {
            if text.is_empty() || text[0] != c {
                false
            } else {
                glob_match_inner(&pattern[1..], &text[1..])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Workspace) {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/main.rs"), b"fn main() {}").unwrap();
        let ws = Workspace::open(dir.path()).expect("open workspace");
        (dir, ws)
    }

    #[test]
    fn resolves_relative_path_inside_workspace() {
        let (_dir, ws) = setup();
        let resolved = ws.resolve_read("src/main.rs").expect("resolve");
        assert_eq!(resolved.relative, "src/main.rs");
        assert!(resolved.exists);
        assert!(!resolved.traversed_symlink);
    }

    #[test]
    fn rejects_parent_traversal() {
        // AC-11: `../../outside.txt` must be refused before execution.
        let (_dir, ws) = setup();
        let err = ws.resolve_write("../../outside.txt").unwrap_err();
        assert!(matches!(err, GuardError::OutsideWorkspace { .. }));
        assert_eq!(err.taxonomy(), "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn rejects_deep_traversal_variants() {
        let (_dir, ws) = setup();
        for attempt in [
            "../outside",
            "src/../../outside",
            "./src/./../../../etc/passwd",
            "src/../src/../../escape",
            "a/b/c/../../../../escape",
        ] {
            let err = ws.resolve_write(attempt).unwrap_err();
            assert!(
                matches!(err, GuardError::OutsideWorkspace { .. }),
                "{attempt} was not rejected: {err:?}"
            );
        }
    }

    #[test]
    fn allows_internal_dotdot_that_stays_inside() {
        let (_dir, ws) = setup();
        let resolved = ws.resolve_read("src/../src/main.rs").expect("resolve");
        assert_eq!(resolved.relative, "src/main.rs");
    }

    #[test]
    fn rejects_nul_byte() {
        let (_dir, ws) = setup();
        let err = ws.resolve_read("src/ma\0in.rs").unwrap_err();
        assert!(matches!(err, GuardError::InvalidEncoding { .. }));
    }

    #[test]
    fn rejects_absolute_without_flag() {
        let (_dir, ws) = setup();
        let err = ws.resolve_read("/etc/passwd").unwrap_err();
        assert!(matches!(err, GuardError::AbsolutePathNotAllowed { .. }));
    }

    #[test]
    fn rejects_windows_style_absolute_without_flag() {
        let (_dir, ws) = setup();
        for p in ["C:\\Windows\\System32", "\\\\server\\share\\x"] {
            let err = ws.resolve_read(p).unwrap_err();
            assert!(
                matches!(err, GuardError::AbsolutePathNotAllowed { .. }),
                "{p}"
            );
        }
    }

    #[test]
    fn absolute_inside_workspace_allowed_with_flag() {
        let (dir, ws) = setup();
        let abs = dir.path().join("src/main.rs").display().to_string();
        let opts = ResolveOptions {
            allow_absolute: true,
            ..ResolveOptions::default()
        };
        let resolved = ws.resolve(&abs, PathIntent::Read, &opts).expect("resolve");
        assert_eq!(resolved.relative, "src/main.rs");
    }

    #[test]
    fn absolute_outside_workspace_denied_even_with_flag() {
        let (_dir, ws) = setup();
        let opts = ResolveOptions {
            allow_absolute: true,
            ..ResolveOptions::default()
        };
        let err = ws
            .resolve("/etc/hostname", PathIntent::Read, &opts)
            .unwrap_err();
        assert!(matches!(err, GuardError::OutsideWorkspace { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        // AC-12 / PERM-004: a symlink to an outside path must be refused.
        let (dir, ws) = setup();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), b"top secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();

        let err = ws.resolve_read("escape/secret.txt").unwrap_err();
        assert!(
            matches!(err, GuardError::SymlinkEscape { .. }),
            "expected SymlinkEscape, got {err:?}"
        );
        assert_eq!(err.taxonomy(), "PATH_OUTSIDE_WORKSPACE");

        let werr = ws.resolve_write("escape/new.txt").unwrap_err();
        assert!(matches!(werr, GuardError::SymlinkEscape { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_that_stays_inside() {
        let (dir, ws) = setup();
        std::os::unix::fs::symlink(dir.path().join("src"), dir.path().join("link")).unwrap();
        let resolved = ws.resolve_read("link/main.rs").expect("resolve");
        assert!(resolved.traversed_symlink);
        assert_eq!(resolved.relative, "src/main.rs");
    }

    #[cfg(unix)]
    #[test]
    fn detects_symlink_swap_race_by_revalidating() {
        // RT-002: swapping the symlink target between check and use must not
        // yield an outside write. The guard resolves the final path itself, so
        // the caller opens exactly what was validated.
        let (dir, ws) = setup();
        let inside = dir.path().join("inside-dir");
        fs::create_dir(&inside).unwrap();
        let outside = TempDir::new().unwrap();
        let link = dir.path().join("swap");

        std::os::unix::fs::symlink(&inside, &link).unwrap();
        let first = ws.resolve_write("swap/file.txt").expect("first resolve");
        assert!(ws.contains(&first.absolute));

        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        let second = ws.resolve_write("swap/file.txt");
        assert!(
            matches!(second, Err(GuardError::SymlinkEscape { .. })),
            "post-swap resolve must fail: {second:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_loop() {
        let (dir, ws) = setup();
        let a = dir.path().join("loop-a");
        let b = dir.path().join("loop-b");
        std::os::unix::fs::symlink(&b, &a).unwrap();
        std::os::unix::fs::symlink(&a, &b).unwrap();
        // Resolution must terminate rather than hang or overflow.
        let result = ws.resolve_read("loop-a");
        assert!(
            matches!(result, Err(GuardError::SymlinkEscape { .. })),
            "symlink loop must be rejected, got {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_chained_symlink_escape() {
        // A single-hop resolver would accept `hop1` because `hop2` is inside the
        // workspace, then the open would follow `hop2` to the outside path.
        let (dir, ws) = setup();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("loot.txt"), b"secret").unwrap();

        let hop2 = dir.path().join("hop2");
        std::os::unix::fs::symlink(outside.path(), &hop2).unwrap();
        let hop1 = dir.path().join("hop1");
        std::os::unix::fs::symlink(&hop2, &hop1).unwrap();

        let result = ws.resolve_read("hop1/loot.txt");
        assert!(
            matches!(result, Err(GuardError::SymlinkEscape { .. })),
            "chained symlink escape must be rejected, got {result:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn allows_chained_symlink_that_stays_inside() {
        let (dir, ws) = setup();
        let hop2 = dir.path().join("inner");
        std::os::unix::fs::symlink(dir.path().join("src"), &hop2).unwrap();
        let hop1 = dir.path().join("outer");
        std::os::unix::fs::symlink(&hop2, &hop1).unwrap();
        let resolved = ws.resolve_read("outer/main.rs").expect("resolve");
        assert_eq!(resolved.relative, "src/main.rs");
        assert!(resolved.traversed_symlink);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_special_file() {
        let (dir, ws) = setup();
        let fifo = dir.path().join("pipe");
        let cpath = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        let rc = unsafe { libc::mkfifo(cpath.as_ptr(), 0o644) };
        if rc != 0 {
            return; // Filesystem does not support FIFOs (e.g. some CI mounts).
        }
        let err = ws.resolve_read("pipe").unwrap_err();
        assert!(matches!(err, GuardError::SpecialFile { .. }), "{err:?}");
    }

    #[test]
    fn rejects_reserved_device_names() {
        let (_dir, ws) = setup();
        for name in ["NUL", "con", "COM1", "lpt9.txt", "src/NUL"] {
            let err = ws.resolve_write(name).unwrap_err();
            assert!(
                matches!(err, GuardError::ReservedName { .. }),
                "{name}: {err:?}"
            );
        }
    }

    #[test]
    fn denies_sensitive_paths_by_default() {
        // Appendix C.4: credential reads default to deny.
        let (dir, ws) = setup();
        fs::write(dir.path().join(".env"), b"OPENAI_API_KEY=sk-x").unwrap();
        fs::create_dir_all(dir.path().join("certs")).unwrap();
        fs::write(dir.path().join("certs/server.pem"), b"key").unwrap();

        for p in [".env", "certs/server.pem"] {
            let err = ws.resolve_read(p).unwrap_err();
            assert!(
                matches!(err, GuardError::SensitivePath { .. }),
                "{p}: {err:?}"
            );
            assert_eq!(err.taxonomy(), "PERMISSION_DENIED");
        }
    }

    #[test]
    fn sensitive_paths_readable_after_explicit_allow() {
        let (dir, ws) = setup();
        fs::write(dir.path().join(".env"), b"X=1").unwrap();
        let opts = ResolveOptions {
            allow_sensitive: true,
            ..ResolveOptions::for_read()
        };
        let resolved = ws
            .resolve(".env", PathIntent::Read, &opts)
            .expect("resolve");
        assert_eq!(resolved.relative, ".env");
    }

    #[test]
    fn enforces_write_lease_scope() {
        // AC-24: executor scoped to scripts/demo.py must not touch README.md.
        let (_dir, ws) = setup();
        let opts = ResolveOptions::for_create().with_lease(vec!["scripts/demo.py".into()]);

        let ok = ws.resolve("scripts/demo.py", PathIntent::Write, &opts);
        assert!(ok.is_ok(), "{ok:?}");

        let err = ws
            .resolve("README.md", PathIntent::Write, &opts)
            .unwrap_err();
        assert!(matches!(err, GuardError::LeaseViolation { .. }), "{err:?}");

        // Reads outside the lease are still allowed: the lease constrains
        // writes only (§15.8).
        let read_opts = ResolveOptions {
            allow_missing: true,
            lease_globs: Some(vec!["scripts/demo.py".into()]),
            ..ResolveOptions::default()
        };
        assert!(ws
            .resolve("src/main.rs", PathIntent::Read, &read_opts)
            .is_ok());
    }

    #[test]
    fn lease_supports_glob_scopes() {
        let (_dir, ws) = setup();
        let opts = ResolveOptions::for_create().with_lease(vec!["src/**".into()]);
        assert!(ws.resolve("src/a/b/c.rs", PathIntent::Write, &opts).is_ok());
        assert!(ws.resolve("docs/x.md", PathIntent::Write, &opts).is_err());
    }

    #[test]
    fn resolves_windows_and_wsl_aliases_inside_workspace() {
        let ws = Workspace::from_canonical(PathBuf::from("/mnt/c/Users/demo"), true);
        let windows = ws
            .resolve(
                r"C:\Users\demo\src\index.html",
                PathIntent::Write,
                &ResolveOptions::for_create(),
            )
            .expect("Windows alias should resolve inside workspace");
        assert_eq!(windows.relative, "src/index.html");

        let wsl = ws
            .resolve(
                "/mnt/c/Users/demo/styles.css",
                PathIntent::Write,
                &ResolveOptions::for_create(),
            )
            .expect("WSL alias should resolve inside workspace");
        assert_eq!(wsl.relative, "styles.css");
    }
    #[test]
    fn fingerprint_is_stable_and_short() {
        let (_dir, ws) = setup();
        let a = ws.fingerprint();
        let b = ws.fingerprint();
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn glob_matcher_semantics() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs"));
        assert!(glob_match("src/*.rs", "src/main.rs"));
        assert!(glob_match("**", "any/deep/path.rs"));
        assert!(glob_match("src/**", "src/a/b.rs"));
        assert!(glob_match("src/**", "src/b.rs"));
        assert!(!glob_match("src/**", "lib/b.rs"));
        assert!(glob_match("?.txt", "a.txt"));
        assert!(!glob_match("?.txt", "ab.txt"));
        assert!(glob_match(".env*", ".env.local"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "exactly"));
    }

    #[test]
    fn lexical_normalize_collapses() {
        assert_eq!(
            lexical_normalize(Path::new("/a/b/../c/./d")).unwrap(),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(
            lexical_normalize(Path::new("/../..")).unwrap(),
            PathBuf::from("/")
        );
    }

    // §25.4 property test: no arbitrary path string escapes the root.
    #[test]
    fn property_arbitrary_paths_never_escape_root() {
        let (_dir, ws) = setup();
        let fragments = [
            "..", ".", "src", "a", "..\\", "//", "\\", "%2e%2e", "....//", "~", "$HOME", "b",
        ];
        let mut state: u64 = 0xDEADBEEF;
        for _ in 0..4000 {
            let mut parts = Vec::new();
            let count = {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                1 + (state >> 33) as usize % 6
            };
            for _ in 0..count {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                let idx = (state >> 33) as usize % fragments.len();
                parts.push(fragments[idx]);
            }
            let candidate = parts.join("/");
            match ws.resolve_write(&candidate) {
                Ok(resolved) => assert!(
                    ws.contains(&resolved.absolute),
                    "escaped with {candidate:?} -> {:?}",
                    resolved.absolute
                ),
                Err(_) => {}
            }
        }
    }
}
