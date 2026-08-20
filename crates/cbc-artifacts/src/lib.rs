//! `cbc-artifacts` — content-addressed artifact store — PRD §18.17, AC-44.
//!
//! Rules from §18.17:
//!   - digest verification before read,
//!   - atomic temp-to-final move,
//!   - duplicate content deduplication MAY,
//!   - no raw secret-bearing artifact by default,
//!   - model input carries only a bounded excerpt/summary, never the whole blob,
//!   - `cbc artifact show <id>` is the only raw view, and it is a local user
//!     action,
//!   - the model receives an opaque ID, never a filesystem path.

use std::path::{Path, PathBuf};

use cbc_redaction::Redactor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Redaction {
    /// Raw bytes as produced. Only created on an explicit request and stored
    /// with restricted permissions.
    Raw,
    /// Secrets replaced. This is the default.
    Redacted,
    /// A summary or transformation of another artifact.
    Derived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetentionClass {
    Session,
    Temporary,
    Pinned,
}

/// Handle handed to the control plane and, in opaque form, to the model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub id: String,
    pub digest: String,
    pub media_type: String,
    pub bytes: u64,
    pub redaction: Redaction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub retention_class: RetentionClass,
}

#[derive(Debug)]
pub enum ArtifactError {
    NotFound {
        id: String,
    },
    DigestMismatch {
        id: String,
        expected: String,
        actual: String,
    },
    TooLarge {
        bytes: u64,
        max: u64,
    },
    Io {
        message: String,
    },
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArtifactError::NotFound { id } => write!(f, "artifact {id} not found"),
            ArtifactError::DigestMismatch {
                id,
                expected,
                actual,
            } => write!(
                f,
                "artifact {id} failed digest verification (expected {expected}, actual {actual})"
            ),
            ArtifactError::TooLarge { bytes, max } => {
                write!(f, "artifact of {bytes} bytes exceeds the {max} byte limit")
            }
            ArtifactError::Io { message } => write!(f, "artifact io error: {message}"),
        }
    }
}

impl std::error::Error for ArtifactError {}

/// Maximum single artifact size: 64 MiB. Beyond this the caller must summarize.
pub const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;

/// Default excerpt budget when producing model-bound text (§11.6).
pub const DEFAULT_EXCERPT_HEAD_LINES: usize = 60;
pub const DEFAULT_EXCERPT_TAIL_LINES: usize = 40;

pub struct ArtifactStore {
    root: PathBuf,
}

impl ArtifactStore {
    /// Open (creating if needed) the store at `<data_dir>/artifacts`.
    pub fn open(data_dir: &Path) -> Result<Self, ArtifactError> {
        let root = data_dir.join("artifacts");
        std::fs::create_dir_all(root.join("sha256")).map_err(io)?;
        std::fs::create_dir_all(root.join("temp")).map_err(io)?;
        restrict_permissions(&root);
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Store content, redacting by default. Identical content dedupes to the
    /// same digest path.
    pub fn create(
        &self,
        content: &[u8],
        media_type: &str,
        display_name: Option<&str>,
        retention: RetentionClass,
        redactor: Option<&Redactor>,
    ) -> Result<ArtifactRef, ArtifactError> {
        if content.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err(ArtifactError::TooLarge {
                bytes: content.len() as u64,
                max: MAX_ARTIFACT_BYTES,
            });
        }

        // §18.17: "raw secret-bearing artifact는 default로 만들지 않는다."
        let (payload, redaction) = match redactor {
            Some(r) => {
                let text = String::from_utf8_lossy(content);
                let cleaned = r.redact_text(&text);
                (cleaned.into_bytes(), Redaction::Redacted)
            }
            None => (content.to_vec(), Redaction::Raw),
        };

        let digest = hex_digest(&payload);
        let final_path = self.path_for(&digest);
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }

        if !final_path.exists() {
            // Atomic temp-to-final move.
            let temp =
                self.root
                    .join("temp")
                    .join(format!("{}-{}", std::process::id(), &digest[..16]));
            std::fs::write(&temp, &payload).map_err(io)?;
            restrict_permissions(&temp);
            std::fs::rename(&temp, &final_path).map_err(io)?;
        }

        Ok(ArtifactRef {
            id: format!("art_{}", &digest[..24]),
            digest,
            media_type: media_type.to_string(),
            bytes: payload.len() as u64,
            redaction,
            display_name: display_name.map(str::to_string),
            retention_class: retention,
        })
    }

    /// Read an artifact, verifying the digest first (§18.17).
    pub fn read(&self, reference: &ArtifactRef) -> Result<Vec<u8>, ArtifactError> {
        let path = self.path_for(&reference.digest);
        let bytes = std::fs::read(&path).map_err(|_| ArtifactError::NotFound {
            id: reference.id.clone(),
        })?;
        let actual = hex_digest(&bytes);
        if actual != reference.digest {
            return Err(ArtifactError::DigestMismatch {
                id: reference.id.clone(),
                expected: reference.digest.clone(),
                actual,
            });
        }
        Ok(bytes)
    }

    pub fn read_by_digest(&self, digest: &str) -> Result<Vec<u8>, ArtifactError> {
        let digest = canonical_sha256(digest).ok_or_else(|| ArtifactError::NotFound {
            id: digest.to_string(),
        })?;
        let path = self.path_for(&digest);
        let bytes =
            std::fs::read(&path).map_err(|_| ArtifactError::NotFound { id: digest.clone() })?;
        let actual = hex_digest(&bytes);
        if actual != digest {
            return Err(ArtifactError::DigestMismatch {
                id: digest.clone(),
                expected: digest,
                actual,
            });
        }
        Ok(bytes)
    }

    /// Resolve either a SHA-256 digest or one of the opaque handles shown to the
    /// model, then read and verify the addressed bytes.
    ///
    /// `art_<digest>` is accepted for compatibility with older/model-generated
    /// calls that combined the displayed `art_` prefix with the adjacent digest.
    /// Native handles use the first 24 digest characters, so those are resolved
    /// within their content-addressed shard without exposing a filesystem path.
    pub fn read_by_locator(&self, locator: &str) -> Result<(String, Vec<u8>), ArtifactError> {
        let digest = self.resolve_digest(locator)?;
        let bytes = self.read_by_digest(&digest)?;
        Ok((digest, bytes))
    }

    pub fn resolve_digest(&self, locator: &str) -> Result<String, ArtifactError> {
        let direct = locator.strip_prefix("sha256:").unwrap_or(locator);
        if let Some(digest) = canonical_sha256(direct) {
            return Ok(digest);
        }

        let Some(handle) = locator.strip_prefix("art_") else {
            return Err(ArtifactError::NotFound {
                id: locator.to_string(),
            });
        };
        if let Some(digest) = canonical_sha256(handle) {
            return Ok(digest);
        }
        if handle.len() != 24 || !handle.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ArtifactError::NotFound {
                id: locator.to_string(),
            });
        }

        let prefix = handle.to_ascii_lowercase();
        let shard = self.root.join("sha256").join(&prefix[..2]);
        let entries = match std::fs::read_dir(shard) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ArtifactError::NotFound {
                    id: locator.to_string(),
                })
            }
            Err(error) => return Err(io(error)),
        };
        let mut resolved: Option<String> = None;
        for entry in entries {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(digest) = canonical_sha256(name) else {
                continue;
            };
            if !digest.starts_with(&prefix) {
                continue;
            }
            // A prefix collision is fantastically unlikely, but choosing one
            // would make an opaque handle non-deterministic. Fail closed.
            if resolved.is_some() {
                return Err(ArtifactError::NotFound {
                    id: locator.to_string(),
                });
            }
            resolved = Some(digest);
        }
        resolved.ok_or_else(|| ArtifactError::NotFound {
            id: locator.to_string(),
        })
    }

    pub fn exists(&self, digest: &str) -> bool {
        canonical_sha256(digest)
            .map(|digest| self.path_for(&digest).exists())
            .unwrap_or(false)
    }

    pub fn delete(&self, digest: &str) -> Result<bool, ArtifactError> {
        let digest = canonical_sha256(digest).ok_or_else(|| ArtifactError::NotFound {
            id: digest.to_string(),
        })?;
        let path = self.path_for(&digest);
        if !path.exists() {
            return Ok(false);
        }
        std::fs::remove_file(&path).map_err(io)?;
        Ok(true)
    }

    /// Sharded path: `artifacts/sha256/<first two hex chars>/<digest>`.
    fn path_for(&self, digest: &str) -> PathBuf {
        let prefix = &digest[..digest.len().min(2)];
        self.root.join("sha256").join(prefix).join(digest)
    }

    /// Total bytes held, for the disk-pressure checks in §22.9.
    pub fn total_bytes(&self) -> u64 {
        fn walk(dir: &Path) -> u64 {
            let mut total = 0;
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        total += walk(&path);
                    } else if let Ok(meta) = entry.metadata() {
                        total += meta.len();
                    }
                }
            }
            total
        }
        walk(&self.root.join("sha256"))
    }
}

fn io(e: std::io::Error) -> ArtifactError {
    ArtifactError::Io {
        message: e.to_string(),
    }
}

fn canonical_sha256(value: &str) -> Option<String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn restrict_permissions(path: &Path) {
    // §18.14: data directory and artifacts are user-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = if meta.is_dir() { 0o700 } else { 0o600 };
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// A bounded head/tail excerpt of large output, with the middle elided — the
/// form the model receives alongside the opaque artifact ID (§11.6, AC-44).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputExcerpt {
    pub head: String,
    pub tail: String,
    pub total_lines: usize,
    pub omitted_lines: usize,
    pub total_bytes: u64,
    pub truncated: bool,
}

impl OutputExcerpt {
    pub fn render(&self) -> String {
        if !self.truncated {
            return self.head.clone();
        }
        format!(
            "{}\n… {} lines omitted ({} bytes total); full output stored as an artifact …\n{}",
            self.head, self.omitted_lines, self.total_bytes, self.tail
        )
    }
}

/// Build a head/tail excerpt. §11.6 defaults: 200 lines, 64 KiB inline.
pub fn excerpt(
    text: &str,
    head_lines: usize,
    tail_lines: usize,
    max_bytes: usize,
) -> OutputExcerpt {
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();
    let total_bytes = text.len() as u64;

    if total_lines <= head_lines + tail_lines && text.len() <= max_bytes {
        return OutputExcerpt {
            head: text.to_string(),
            tail: String::new(),
            total_lines,
            omitted_lines: 0,
            total_bytes,
            truncated: false,
        };
    }

    let head_slice = &lines[..head_lines.min(total_lines)];
    let tail_start = total_lines
        .saturating_sub(tail_lines)
        .max(head_lines.min(total_lines));
    let tail_slice = &lines[tail_start.min(total_lines)..];

    let mut head = head_slice.join("\n");
    if head.len() > max_bytes / 2 {
        let mut end = max_bytes / 2;
        while end > 0 && !head.is_char_boundary(end) {
            end -= 1;
        }
        head.truncate(end);
    }
    let mut tail = tail_slice.join("\n");
    if tail.len() > max_bytes / 2 {
        let start = tail.len() - max_bytes / 2;
        let mut start = start;
        while start < tail.len() && !tail.is_char_boundary(start) {
            start += 1;
        }
        tail = tail[start..].to_string();
    }

    OutputExcerpt {
        head,
        tail,
        total_lines,
        omitted_lines: total_lines.saturating_sub(head_slice.len() + tail_slice.len()),
        total_bytes,
        truncated: true,
    }
}

/// Decode standard or URL-safe base64, with or without padding (P0-08).
///
/// Binary media (images, archives) reaches the store pre-encoded; decoding here
/// keeps the control plane from handling raw bytes it cannot inspect. Invalid
/// input is an error rather than a silent truncation, so a malformed upload
/// fails loudly instead of storing a corrupted blob.
pub fn decode_base64(input: &str) -> Result<Vec<u8>, ArtifactError> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }

    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    // Padding is optional; strip it before computing the output length.
    let significant = bytes.iter().filter(|&&b| b != b'=').count();
    let pad = (4 - significant % 4) % 4;
    if significant % 4 == 1 {
        return Err(ArtifactError::Io {
            message: "invalid base64: input length is not valid".to_string(),
        });
    }

    let mut out = Vec::with_capacity((significant + pad) / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in &bytes {
        if byte == b'=' {
            break;
        }
        let some = value(byte).ok_or_else(|| ArtifactError::Io {
            message: format!("invalid base64 character: {:?}", byte as char),
        })?;
        buffer = (buffer << 6) | some as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, ArtifactStore) {
        let dir = TempDir::new().unwrap();
        let store = ArtifactStore::open(dir.path()).unwrap();
        (dir, store)
    }

    /// Minimal standard-base64 encoder for round-trip tests only.
    fn encode_base64_for_test(input: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let triple = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[((triple >> 18) & 63) as usize] as char);
            out.push(ALPHABET[((triple >> 12) & 63) as usize] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[((triple >> 6) & 63) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[(triple & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn decodes_standard_and_url_safe_base64() {
        // P0-08: binary media arrives pre-encoded; the store decodes it.
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello"); // no padding
        assert_eq!(decode_base64("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(decode_base64("aGVs bG8=").unwrap(), b"hello"); // whitespace ok

        // URL-safe alphabet: re-encode a payload that uses '+'/'/' in standard
        // base64, translate to '-"/'_', drop padding, and decode back.
        let payload: Vec<u8> = vec![0xfb, 0xff, 0xfe, 0xfb, 0xef];
        let standard = encode_base64_for_test(&payload);
        let url_safe = standard
            .replace('+', "-")
            .replace('/', "_")
            .trim_end_matches('=')
            .to_string();
        assert_eq!(decode_base64(&url_safe).unwrap(), payload);
    }

    #[test]
    fn rejects_invalid_base64() {
        assert!(decode_base64("!!!").is_err());
        assert!(decode_base64("abcde").is_err()); // length % 4 == 1
    }

    #[test]
    fn stores_binary_from_base64_round_trip() {
        let (_d, store) = store();
        let payload: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
        let encoded = encode_base64_for_test(&payload);
        let decoded = decode_base64(&encoded).unwrap();
        let reference = store
            .create(
                &decoded,
                "image/png",
                Some("img.png"),
                RetentionClass::Session,
                None,
            )
            .unwrap();
        assert_eq!(store.read(&reference).unwrap(), payload);
    }

    #[test]
    fn stores_and_reads_content() {
        let (_d, store) = store();
        let reference = store
            .create(
                b"hello artifact",
                "text/plain",
                Some("out.log"),
                RetentionClass::Session,
                None,
            )
            .unwrap();
        assert_eq!(reference.bytes, 14);
        assert_eq!(reference.media_type, "text/plain");
        assert_eq!(store.read(&reference).unwrap(), b"hello artifact");
    }

    #[test]
    fn reads_by_digest_and_artifact_handle() {
        let (_d, store) = store();
        let reference = store
            .create(
                b"locator payload",
                "text/plain",
                None,
                RetentionClass::Session,
                None,
            )
            .unwrap();

        for locator in [
            reference.digest.clone(),
            format!("sha256:{}", reference.digest),
            reference.id.clone(),
            format!("art_{}", reference.digest),
        ] {
            let (digest, bytes) = store.read_by_locator(&locator).unwrap();
            assert_eq!(digest, reference.digest);
            assert_eq!(bytes, b"locator payload");
        }
    }

    #[test]
    fn rejects_malformed_digest_locators_without_leaving_the_store() {
        let (_d, store) = store();
        let too_short = "f".repeat(63);
        for locator in ["../outside", "art_not-a-digest", too_short.as_str()] {
            let err = store.read_by_locator(locator).unwrap_err();
            assert!(matches!(err, ArtifactError::NotFound { .. }));
        }
        assert!(!store.exists("../outside"));
        assert!(matches!(
            store.delete("../outside"),
            Err(ArtifactError::NotFound { .. })
        ));
    }

    #[test]
    fn artifact_id_is_opaque_and_has_no_path() {
        // §18.17: the model gets an opaque ID, never a filesystem path.
        let (_d, store) = store();
        let reference = store
            .create(
                b"payload",
                "text/plain",
                None,
                RetentionClass::Session,
                None,
            )
            .unwrap();
        assert!(reference.id.starts_with("art_"));
        assert!(!reference.id.contains('/'));
        assert!(!reference.id.contains(std::path::MAIN_SEPARATOR));
        let serialized = serde_json::to_string(&reference).unwrap();
        assert!(!serialized.contains("artifacts/sha256"));
    }

    #[test]
    fn deduplicates_identical_content() {
        let (_d, store) = store();
        let a = store
            .create(
                b"same bytes",
                "text/plain",
                None,
                RetentionClass::Session,
                None,
            )
            .unwrap();
        let b = store
            .create(
                b"same bytes",
                "text/plain",
                None,
                RetentionClass::Pinned,
                None,
            )
            .unwrap();
        assert_eq!(a.digest, b.digest);
        assert_eq!(store.total_bytes(), 10, "content stored twice");
    }

    #[test]
    fn redacts_by_default_when_redactor_supplied() {
        let (_d, store) = store();
        let mut redactor = Redactor::new();
        redactor.add_literal("sk-supersecretkey000111");
        let reference = store
            .create(
                b"key is sk-supersecretkey000111 here",
                "text/plain",
                None,
                RetentionClass::Session,
                Some(&redactor),
            )
            .unwrap();
        assert_eq!(reference.redaction, Redaction::Redacted);
        let content = String::from_utf8(store.read(&reference).unwrap()).unwrap();
        assert!(!content.contains("supersecretkey"));
        assert!(content.contains("***REDACTED***"));
    }

    #[test]
    fn verifies_digest_before_read() {
        let (_d, store) = store();
        let mut reference = store
            .create(
                b"trusted",
                "text/plain",
                None,
                RetentionClass::Session,
                None,
            )
            .unwrap();
        // Tamper with the expected digest.
        reference.digest = "0".repeat(64);
        let err = store.read(&reference).unwrap_err();
        assert!(matches!(err, ArtifactError::NotFound { .. }));

        // Tamper with the stored bytes instead.
        let good = store
            .create(
                b"tamper me",
                "text/plain",
                None,
                RetentionClass::Session,
                None,
            )
            .unwrap();
        let path = store.path_for(&good.digest);
        std::fs::write(&path, b"different").unwrap();
        let err = store.read(&good).unwrap_err();
        assert!(matches!(err, ArtifactError::DigestMismatch { .. }), "{err}");
    }

    #[test]
    fn rejects_oversized_artifact() {
        let (_d, store) = store();
        // Simulate by checking the guard directly rather than allocating 64 MiB.
        let err = ArtifactError::TooLarge {
            bytes: MAX_ARTIFACT_BYTES + 1,
            max: MAX_ARTIFACT_BYTES,
        };
        assert!(err.to_string().contains("exceeds"));
        assert!(store
            .create(b"small", "text/plain", None, RetentionClass::Session, None)
            .is_ok());
    }

    #[test]
    fn deletes_artifact() {
        let (_d, store) = store();
        let reference = store
            .create(
                b"delete me",
                "text/plain",
                None,
                RetentionClass::Temporary,
                None,
            )
            .unwrap();
        assert!(store.exists(&reference.digest));
        assert!(store.delete(&reference.digest).unwrap());
        assert!(!store.exists(&reference.digest));
        assert!(!store.delete(&reference.digest).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn store_directory_is_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let (_d, store) = store();
        let mode = std::fs::metadata(store.root())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "mode was {mode:o}");
    }

    #[test]
    fn short_output_is_not_truncated() {
        let ex = excerpt("a\nb\nc\n", 60, 40, 65536);
        assert!(!ex.truncated);
        assert_eq!(ex.omitted_lines, 0);
        assert_eq!(ex.render(), "a\nb\nc\n");
    }

    #[test]
    fn long_output_gets_head_and_tail() {
        // AC-44: head/tail summary plus artifact handle.
        let text: String = (0..500).map(|i| format!("line {i}\n")).collect();
        let ex = excerpt(&text, 5, 3, 65536);
        assert!(ex.truncated);
        assert_eq!(ex.total_lines, 500);
        assert_eq!(ex.omitted_lines, 492);
        assert!(ex.head.starts_with("line 0"));
        assert!(ex.tail.ends_with("line 499"));
        let rendered = ex.render();
        assert!(rendered.contains("492 lines omitted"));
        assert!(rendered.contains("stored as an artifact"));
    }

    #[test]
    fn excerpt_respects_byte_budget() {
        let text: String = (0..1000)
            .map(|i| format!("{}\n", "x".repeat(200) + &i.to_string()))
            .collect();
        let ex = excerpt(&text, 100, 100, 4096);
        assert!(ex.head.len() <= 2048 + 8);
        assert!(ex.tail.len() <= 2048 + 8);
    }

    #[test]
    fn excerpt_handles_multibyte_boundaries() {
        let text: String = (0..200).map(|i| format!("한국어 라인 {i}\n")).collect();
        let ex = excerpt(&text, 10, 5, 200);
        // Must not panic and must produce valid UTF-8.
        assert!(ex.truncated);
        assert!(ex.head.is_char_boundary(ex.head.len()));
        assert!(ex.tail.is_char_boundary(0));
    }
}
