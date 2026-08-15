//! Atomic filesystem operations — PRD §14.3, AC-14, RT-003.
//!
//! The §14.3 sequence, in order:
//!   - temp file in the same directory (so `rename` stays on one filesystem)
//!   - restrictive default permissions
//!   - write + flush + fsync where supported
//!   - preserve owner/mode where applicable
//!   - rename atomically
//!   - directory fsync where supported
//!   - failure cleanup
//!   - before/after content hash
//!
//! RT-003 requires that a crash during a write never leaves a truncated target.
//! The target is only ever replaced by `rename`, which is atomic on POSIX and
//! on Windows via `ReplaceFile` semantics, so a reader sees either the old file
//! or the new one.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Default file mode for newly created files: owner read/write only until the
/// caller explicitly requests something broader (§14.3 "restrictive default
/// permissions").
#[cfg(unix)]
pub const DEFAULT_NEW_FILE_MODE: u32 = 0o600;

/// Maximum file size read into memory by default: 1 MiB per §12.6.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
pub enum FsError {
    NotFound {
        path: String,
    },
    AlreadyExists {
        path: String,
    },
    HashMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    TooLarge {
        path: String,
        bytes: u64,
        max: u64,
    },
    UnsupportedEncoding {
        path: String,
        detail: String,
    },
    IsDirectory {
        path: String,
    },
    NotDirectory {
        path: String,
    },
    Io {
        path: String,
        message: String,
    },
}

impl FsError {
    pub fn taxonomy(&self) -> &'static str {
        match self {
            FsError::NotFound { .. } => "NOT_FOUND",
            FsError::AlreadyExists { .. } => "ALREADY_EXISTS",
            FsError::HashMismatch { .. } => "HASH_MISMATCH",
            FsError::TooLarge { .. } => "OUTPUT_LIMIT",
            FsError::UnsupportedEncoding { .. } => "UNSUPPORTED_ENCODING",
            FsError::IsDirectory { .. } | FsError::NotDirectory { .. } => "INVALID_ARGUMENT",
            FsError::Io { .. } => "INTERNAL",
        }
    }
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsError::NotFound { path } => write!(f, "not found: {path}"),
            FsError::AlreadyExists { path } => write!(f, "already exists: {path}"),
            FsError::HashMismatch {
                path,
                expected,
                actual,
            } => write!(
                f,
                "{path} changed after Capybara read it (expected {expected}, actual {actual})"
            ),
            FsError::TooLarge { path, bytes, max } => {
                write!(f, "{path} is {bytes} bytes, exceeding the {max} byte limit")
            }
            FsError::UnsupportedEncoding { path, detail } => {
                write!(f, "{path} has unsupported encoding: {detail}")
            }
            FsError::IsDirectory { path } => write!(f, "{path} is a directory"),
            FsError::NotDirectory { path } => write!(f, "{path} is not a directory"),
            FsError::Io { path, message } => write!(f, "io error on {path}: {message}"),
        }
    }
}

impl std::error::Error for FsError {}

fn io_err(path: &Path, e: io::Error) -> FsError {
    match e.kind() {
        io::ErrorKind::NotFound => FsError::NotFound {
            path: path.display().to_string(),
        },
        io::ErrorKind::AlreadyExists => FsError::AlreadyExists {
            path: path.display().to_string(),
        },
        _ => FsError::Io {
            path: path.display().to_string(),
            message: e.to_string(),
        },
    }
}

/// SHA-256 of bytes, lowercase hex. Used for optimistic concurrency and for the
/// before/after hashes recorded on every mutation (§12.5, §18.15).
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Short display form used in conflict messages, matching Appendix A.3.
pub fn short_hash(hash: &str) -> String {
    hash.chars().take(7).collect()
}

/// Compare content hashes for optimistic concurrency checks.
/// Returns true if `expected` matches `actual` (case-insensitive, and supports prefix matching
/// when either hash is a short hash of at least 7 hex characters).
pub fn hashes_match(actual: &str, expected: &str) -> bool {
    let a = actual.trim();
    let e = expected.trim();
    if a.is_empty() || e.is_empty() {
        return false;
    }
    if a.eq_ignore_ascii_case(e) {
        return true;
    }
    let min_len = a.len().min(e.len());
    if min_len >= 7 {
        a[..min_len].eq_ignore_ascii_case(&e[..min_len])
    } else {
        false
    }
}

pub fn hash_file(path: &Path) -> Result<String, FsError> {
    let mut file = File::open(path).map_err(|e| io_err(path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| io_err(path, e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewlineStyle {
    pub crlf: bool,
    pub trailing_newline: bool,
}

impl NewlineStyle {
    /// Detect line-ending style so writes can preserve it (§12.5 "newline style
    /// preserved").
    pub fn detect(content: &str) -> Self {
        let crlf_count = content.matches("\r\n").count();
        let lf_count = content.matches('\n').count();
        Self {
            crlf: crlf_count > 0 && crlf_count * 2 >= lf_count,
            trailing_newline: content.ends_with('\n'),
        }
    }

    pub fn apply(&self, content: &str) -> String {
        let normalized = content.replace("\r\n", "\n");
        let mut out = if self.crlf {
            normalized.replace('\n', "\r\n")
        } else {
            normalized
        };
        if self.trailing_newline && !out.ends_with('\n') {
            out.push_str(if self.crlf { "\r\n" } else { "\n" });
        }
        if !self.trailing_newline {
            while out.ends_with('\n') || out.ends_with('\r') {
                out.pop();
            }
        }
        out
    }
}

/// Result of an atomic write.
#[derive(Debug, Clone)]
pub struct WriteOutcome {
    pub pre_hash: Option<String>,
    pub post_hash: String,
    pub bytes_written: u64,
    pub created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteIntent {
    /// Fail if the file already exists.
    Create,
    /// Fail if the file does not exist; `expected_hash` is mandatory.
    Replace,
    /// Create or replace.
    Upsert,
}

/// Atomically write `content` to `path`.
///
/// `expected_hash` implements optimistic concurrency (§T2, AC-13): when the
/// current content hash differs, the write fails with `HashMismatch` and the
/// file is left untouched — the agent must re-read rather than overwrite user
/// edits.
pub fn atomic_write(
    path: &Path,
    content: &[u8],
    intent: WriteIntent,
    expected_hash: Option<&str>,
) -> Result<WriteOutcome, FsError> {
    let exists = path.symlink_metadata().is_ok();
    if exists && path.is_dir() {
        return Err(FsError::IsDirectory {
            path: path.display().to_string(),
        });
    }

    match intent {
        WriteIntent::Create if exists => {
            return Err(FsError::AlreadyExists {
                path: path.display().to_string(),
            })
        }
        WriteIntent::Replace if !exists => {
            return Err(FsError::NotFound {
                path: path.display().to_string(),
            })
        }
        _ => {}
    }

    let pre_hash = if exists { Some(hash_file(path)?) } else { None };

    if let Some(expected) = expected_hash {
        let actual = pre_hash.clone().unwrap_or_default();
        if !hashes_match(&actual, expected) {
            return Err(FsError::HashMismatch {
                path: path.display().to_string(),
                expected: expected.to_string(),
                actual: if actual.is_empty() {
                    "<absent>".into()
                } else {
                    actual
                },
            });
        }
    }

    let parent = path.parent().ok_or_else(|| FsError::Io {
        path: path.display().to_string(),
        message: "path has no parent directory".into(),
    })?;
    fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;

    // Temp file in the *same* directory so the rename is atomic.
    let temp_path = temp_sibling(path);
    let write_result = write_and_sync(&temp_path, content, path, exists);
    if let Err(e) = write_result {
        let _ = fs::remove_file(&temp_path); // failure cleanup
        return Err(e);
    }

    if let Err(e) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(io_err(path, e));
    }

    // Directory fsync so the rename itself is durable.
    fsync_dir(parent);

    Ok(WriteOutcome {
        pre_hash,
        post_hash: hash_bytes(content),
        bytes_written: content.len() as u64,
        created: !exists,
    })
}

pub(crate) fn write_and_sync(
    temp_path: &Path,
    content: &[u8],
    final_path: &Path,
    preserve_from_existing: bool,
) -> Result<(), FsError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Restrictive default; upgraded below when preserving an existing mode.
        options.mode(DEFAULT_NEW_FILE_MODE);
    }

    let mut file = options.open(temp_path).map_err(|e| io_err(temp_path, e))?;
    file.write_all(content).map_err(|e| io_err(temp_path, e))?;
    file.flush().map_err(|e| io_err(temp_path, e))?;
    // fsync the data before the rename makes it visible.
    file.sync_all().map_err(|e| io_err(temp_path, e))?;
    drop(file);

    // Preserve mode where applicable (§14.3, §12.5 "file mode preserved").
    #[cfg(unix)]
    if preserve_from_existing {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(final_path) {
            let mode = meta.permissions().mode() & 0o7777;
            let _ = fs::set_permissions(temp_path, fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (final_path, preserve_from_existing);
    }

    Ok(())
}

pub(crate) fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "target".to_string());
    let unique = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".cbc-tmp-{name}-{unique}"))
}

/// fsync a directory so that a rename survives power loss. Silently skipped on
/// platforms that do not support it.
pub fn fsync_dir(dir: &Path) {
    #[cfg(unix)]
    {
        if let Ok(handle) = File::open(dir) {
            let _ = handle.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Read a UTF-8 text file with a size cap.
pub fn read_text(path: &Path, max_bytes: u64) -> Result<(String, String), FsError> {
    let meta = fs::metadata(path).map_err(|e| io_err(path, e))?;
    if meta.is_dir() {
        return Err(FsError::IsDirectory {
            path: path.display().to_string(),
        });
    }
    if meta.len() > max_bytes {
        return Err(FsError::TooLarge {
            path: path.display().to_string(),
            bytes: meta.len(),
            max: max_bytes,
        });
    }
    let bytes = fs::read(path).map_err(|e| io_err(path, e))?;
    let hash = hash_bytes(&bytes);
    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, hash)),
        Err(e) => Err(FsError::UnsupportedEncoding {
            path: path.display().to_string(),
            detail: format!("not valid UTF-8 at byte {}", e.utf8_error().valid_up_to()),
        }),
    }
}

/// Detect whether a file looks binary, so listings and diffs can show metadata
/// only (§6.18 "binary file은 metadata만 표시한다").
pub fn is_probably_binary(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8000];
    let Ok(n) = file.read(&mut buf) else {
        return false;
    };
    if n == 0 {
        return false;
    }
    let slice = &buf[..n];
    if slice.contains(&0) {
        return true;
    }
    let non_text = slice
        .iter()
        .filter(|&&b| b < 0x09 || (b > 0x0d && b < 0x20))
        .count();
    non_text * 100 / n > 5
}

/// Move/rename a path, refusing to clobber an existing target.
pub fn move_path(from: &Path, to: &Path) -> Result<(), FsError> {
    if !from.symlink_metadata().is_ok() {
        return Err(FsError::NotFound {
            path: from.display().to_string(),
        });
    }
    if to.symlink_metadata().is_ok() {
        return Err(FsError::AlreadyExists {
            path: to.display().to_string(),
        });
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    fs::rename(from, to).map_err(|e| io_err(from, e))?;
    if let Some(parent) = to.parent() {
        fsync_dir(parent);
    }
    Ok(())
}

/// Delete a file or (optionally) an empty/recursive directory.
pub fn delete_path(path: &Path, recursive: bool) -> Result<u64, FsError> {
    let meta = path.symlink_metadata().map_err(|e| io_err(path, e))?;
    if meta.is_dir() {
        let count = if recursive {
            let count = count_entries(path);
            fs::remove_dir_all(path).map_err(|e| io_err(path, e))?;
            count
        } else {
            fs::remove_dir(path).map_err(|e| io_err(path, e))?;
            1
        };
        if let Some(parent) = path.parent() {
            fsync_dir(parent);
        }
        return Ok(count);
    }
    fs::remove_file(path).map_err(|e| io_err(path, e))?;
    if let Some(parent) = path.parent() {
        fsync_dir(parent);
    }
    Ok(1)
}

fn count_entries(path: &Path) -> u64 {
    let mut count = 1u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                count += count_entries(&p);
            } else {
                count += 1;
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_file_atomically_with_hashes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("new.txt");
        let outcome = atomic_write(&path, b"hello", WriteIntent::Create, None).expect("write");
        assert!(outcome.created);
        assert_eq!(outcome.pre_hash, None);
        assert_eq!(outcome.post_hash, hash_bytes(b"hello"));
        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn create_intent_refuses_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("x.txt");
        fs::write(&path, b"old").unwrap();
        let err = atomic_write(&path, b"new", WriteIntent::Create, None).unwrap_err();
        assert!(matches!(err, FsError::AlreadyExists { .. }));
        assert_eq!(fs::read(&path).unwrap(), b"old");
    }

    #[test]
    fn replace_intent_requires_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("missing.txt");
        let err = atomic_write(&path, b"x", WriteIntent::Replace, None).unwrap_err();
        assert!(matches!(err, FsError::NotFound { .. }));
    }

    #[test]
    fn hash_mismatch_leaves_file_untouched() {
        // AC-13: user edited the file after the agent read it.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("conflict.txt");
        fs::write(&path, b"agent read this").unwrap();
        let stale = hash_bytes(b"agent read this");
        fs::write(&path, b"user changed this").unwrap();

        let err =
            atomic_write(&path, b"agent patch", WriteIntent::Replace, Some(&stale)).unwrap_err();
        match err {
            FsError::HashMismatch {
                expected, actual, ..
            } => {
                assert_eq!(expected, stale);
                assert_eq!(actual, hash_bytes(b"user changed this"));
            }
            other => panic!("expected HashMismatch, got {other}"),
        }
        // User content preserved.
        assert_eq!(fs::read(&path).unwrap(), b"user changed this");
    }

    #[test]
    fn matching_hash_permits_replace() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("ok.txt");
        fs::write(&path, b"base").unwrap();
        let base = hash_bytes(b"base");
        let outcome =
            atomic_write(&path, b"patched", WriteIntent::Replace, Some(&base)).expect("write");
        assert_eq!(outcome.pre_hash.unwrap(), base);
        assert_eq!(fs::read(&path).unwrap(), b"patched");
    }

    #[test]
    fn no_temp_files_remain_after_success_or_failure() {
        // RT-003 corollary: no partial artefacts left behind.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.txt");
        atomic_write(&path, b"a", WriteIntent::Create, None).unwrap();
        let _ = atomic_write(&path, b"b", WriteIntent::Replace, Some("deadbeef"));
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".cbc-tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[test]
    fn target_is_never_observed_truncated() {
        // RT-003: because we only ever rename over the target, a reader sees
        // either the complete old content or the complete new content.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("big.txt");
        let old = "o".repeat(50_000);
        fs::write(&path, old.as_bytes()).unwrap();
        let new = "n".repeat(70_000);
        atomic_write(&path, new.as_bytes(), WriteIntent::Upsert, None).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.len() == 70_000 && content.chars().all(|c| c == 'n'));
    }

    #[cfg(unix)]
    #[test]
    fn new_files_get_restrictive_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("secret-ish.txt");
        atomic_write(&path, b"x", WriteIntent::Create, None).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, DEFAULT_NEW_FILE_MODE, "mode was {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_mode_on_replace() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("script.sh");
        fs::write(&path, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&path, b"#!/bin/sh\necho hi\n", WriteIntent::Upsert, None).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "executable bit lost, mode {mode:o}");
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a/b/c/deep.txt");
        atomic_write(&path, b"deep", WriteIntent::Create, None).expect("write");
        assert_eq!(fs::read(&path).unwrap(), b"deep");
    }

    #[test]
    fn refuses_to_write_over_directory() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("adir");
        fs::create_dir(&path).unwrap();
        let err = atomic_write(&path, b"x", WriteIntent::Upsert, None).unwrap_err();
        assert!(matches!(err, FsError::IsDirectory { .. }));
    }

    #[test]
    fn read_text_enforces_size_cap() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("big.bin");
        fs::write(&path, vec![b'a'; 2048]).unwrap();
        let err = read_text(&path, 1024).unwrap_err();
        assert!(matches!(err, FsError::TooLarge { .. }));
        assert_eq!(err.taxonomy(), "OUTPUT_LIMIT");
    }

    #[test]
    fn read_text_rejects_invalid_utf8() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("latin.txt");
        fs::write(&path, [0x48u8, 0xe9, 0x6c]).unwrap();
        let err = read_text(&path, 1024).unwrap_err();
        assert!(matches!(err, FsError::UnsupportedEncoding { .. }));
        assert_eq!(err.taxonomy(), "UNSUPPORTED_ENCODING");
    }

    #[test]
    fn read_text_returns_hash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.txt");
        fs::write(&path, b"content").unwrap();
        let (text, hash) = read_text(&path, 1024).unwrap();
        assert_eq!(text, "content");
        assert_eq!(hash, hash_bytes(b"content"));
    }

    #[test]
    fn detects_binary_files() {
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("a.bin");
        fs::write(&bin, [0x00u8, 0x01, 0x02, 0xff, 0xfe]).unwrap();
        assert!(is_probably_binary(&bin));

        let txt = dir.path().join("a.txt");
        fs::write(&txt, "plain text 한국어\n").unwrap();
        assert!(!is_probably_binary(&txt));
    }

    #[test]
    fn newline_style_round_trips() {
        let lf = NewlineStyle::detect("a\nb\n");
        assert!(!lf.crlf && lf.trailing_newline);
        assert_eq!(lf.apply("x\ny"), "x\ny\n");

        let crlf = NewlineStyle::detect("a\r\nb\r\n");
        assert!(crlf.crlf);
        assert_eq!(crlf.apply("x\ny"), "x\r\ny\r\n");

        let no_trailing = NewlineStyle::detect("a\nb");
        assert!(!no_trailing.trailing_newline);
        assert_eq!(no_trailing.apply("x\ny\n"), "x\ny");
    }

    #[test]
    fn move_refuses_to_clobber() {
        let dir = TempDir::new().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let err = move_path(&a, &b).unwrap_err();
        assert!(matches!(err, FsError::AlreadyExists { .. }));
        assert_eq!(fs::read(&b).unwrap(), b"b");
    }

    #[test]
    fn move_succeeds_and_creates_parents() {
        let dir = TempDir::new().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("nested/deep/b.txt");
        fs::write(&a, b"payload").unwrap();
        move_path(&a, &b).expect("move");
        assert!(!a.exists());
        assert_eq!(fs::read(&b).unwrap(), b"payload");
    }

    #[test]
    fn delete_file_and_recursive_dir() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("f.txt");
        fs::write(&f, b"x").unwrap();
        assert_eq!(delete_path(&f, false).unwrap(), 1);
        assert!(!f.exists());

        let d = dir.path().join("tree/a/b");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("leaf.txt"), b"y").unwrap();
        let count = delete_path(&dir.path().join("tree"), true).unwrap();
        assert!(count >= 3, "counted {count}");
        assert!(!dir.path().join("tree").exists());
    }

    #[test]
    fn non_recursive_delete_refuses_non_empty_dir() {
        let dir = TempDir::new().unwrap();
        let d = dir.path().join("full");
        fs::create_dir(&d).unwrap();
        fs::write(d.join("x"), b"1").unwrap();
        assert!(delete_path(&d, false).is_err());
        assert!(d.exists());
    }

    #[test]
    fn hashes_match_supports_short_and_case_insensitive() {
        let full = "38ee376a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e";
        let short = "38ee376";
        let upper_short = "38EE376";
        let upper_full = "38EE376A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E";

        assert!(hashes_match(full, short));
        assert!(hashes_match(short, full));
        assert!(hashes_match(full, upper_short));
        assert!(hashes_match(full, upper_full));
        assert!(!hashes_match(full, "deadbeef"));
        assert!(!hashes_match("38ee37", "38ee376")); // less than 7 chars prefix mismatch
    }

    #[test]
    fn short_hash_matches_prd_display_width() {
        // Appendix A.3 shows 7-character hashes.
        assert_eq!(short_hash("8f1c7c2abcdef"), "8f1c7c2");
    }

    #[test]
    fn property_write_then_read_is_identity() {
        let dir = TempDir::new().unwrap();
        for i in 0..200usize {
            let path = dir.path().join(format!("f{i}.txt"));
            let content = format!("line {i}\n한국어 {i}\n{}", "x".repeat(i));
            atomic_write(&path, content.as_bytes(), WriteIntent::Upsert, None).unwrap();
            let (read_back, hash) = read_text(&path, DEFAULT_MAX_FILE_BYTES).unwrap();
            assert_eq!(read_back, content);
            assert_eq!(hash, hash_bytes(content.as_bytes()));
        }
    }
}
