//! `cbc-update` — release artifact verification — PRD §6.19, §19.9, §19.10,
//! AC-41.
//!
//! §19.9: "release binary와 manifest는 signing한다" and "package
//! signature/checksum verification을 우회하지 않는다". This crate owns the
//! verification half of `update.verify`; it deliberately does *not* download
//! anything, because §19.9 forbids postinstall arbitrary network download as the
//! default distribution path. The TypeScript side fetches, the runtime verifies.

use std::path::Path;

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// The release manifest shipped alongside every archive (§19.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub version: String,
    pub channel: String,
    pub target: String,
    pub built_at: String,
    pub files: Vec<ChecksumEntry>,
    /// Hex-encoded Ed25519 signature over the canonical manifest bytes, when
    /// present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_key_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerifyStatus {
    Verified,
    ChecksumMismatch,
    MissingFile,
    MissingSignature,
    InvalidSignature,
    ChannelMismatch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub status: VerifyStatus,
    pub version: String,
    pub files_checked: usize,
    pub problems: Vec<String>,
    /// True only when every file matched *and* the signature policy was
    /// satisfied.
    pub safe_to_install: bool,
}

/// Pinned production release verification key (hex-encoded Ed25519 public key,
/// §19.9).
///
/// TODO(release): the real release key must replace this placeholder before
/// the first signed release ships.
pub const PINNED_RELEASE_PUBLIC_KEY: &str =
    "fb163a2595bc290fca6ef152e0db6c6cfc0f400aecf4d467c44978780bd71a5b";

/// Parse [`PINNED_RELEASE_PUBLIC_KEY`] into a usable verifying key.
///
/// Returns `None` when the pinned constant is malformed; callers must treat a
/// missing key as "cannot verify", never as "verified".
pub fn pinned_release_verifying_key() -> Option<VerifyingKey> {
    let bytes = decode_hex::<32>(PINNED_RELEASE_PUBLIC_KEY)?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// Verify a staged release directory against its manifest.
///
/// `require_signature` reflects the release-gate policy: production installs
/// must refuse an unsigned manifest. `verifying_key` is the pinned release key
/// (see [`pinned_release_verifying_key`]); a manifest carrying a signature
/// that cannot be checked against a pinned key is reported as
/// [`VerifyStatus::InvalidSignature`], because §19.9 forbids trusting
/// signature *presence* alone. A failing signature check overrides every other
/// status, since an unverifiable manifest cannot be trusted at all.
pub fn verify_release(
    staged_dir: &Path,
    manifest: &ReleaseManifest,
    expected_channel: &str,
    require_signature: bool,
    verifying_key: Option<&VerifyingKey>,
) -> VerifyReport {
    let mut problems = Vec::new();
    let mut status = VerifyStatus::Verified;

    if manifest.channel != expected_channel {
        problems.push(format!(
            "manifest channel '{}' does not match the configured channel '{expected_channel}'",
            manifest.channel
        ));
        status = VerifyStatus::ChannelMismatch;
    }

    let mut checked = 0usize;
    for entry in &manifest.files {
        let path = staged_dir.join(&entry.path);
        let Ok(bytes) = std::fs::read(&path) else {
            problems.push(format!("missing file: {}", entry.path));
            if status == VerifyStatus::Verified {
                status = VerifyStatus::MissingFile;
            }
            continue;
        };
        checked += 1;
        if bytes.len() as u64 != entry.bytes {
            problems.push(format!(
                "{}: size {} does not match manifest size {}",
                entry.path,
                bytes.len(),
                entry.bytes
            ));
            status = VerifyStatus::ChecksumMismatch;
            continue;
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if digest != entry.sha256 {
            problems.push(format!(
                "{}: sha256 {digest} does not match manifest {}",
                entry.path, entry.sha256
            ));
            status = VerifyStatus::ChecksumMismatch;
        }
    }

    match (&manifest.signature, verifying_key) {
        (None, _) => {
            problems.push("release manifest is not signed".to_string());
            if require_signature && status == VerifyStatus::Verified {
                status = VerifyStatus::MissingSignature;
            }
        }
        (Some(_), None) => {
            problems.push(
                "release manifest carries a signature but no release key is \
                 pinned to verify it against"
                    .to_string(),
            );
            status = VerifyStatus::InvalidSignature;
        }
        (Some(signature), Some(key)) => {
            if let Some(problem) = verify_signature(signature, key, manifest) {
                problems.push(problem);
                status = VerifyStatus::InvalidSignature;
            }
        }
    }

    let safe_to_install = status == VerifyStatus::Verified;

    VerifyReport {
        status,
        version: manifest.version.clone(),
        files_checked: checked,
        problems,
        safe_to_install,
    }
}

/// Verify a hex-encoded Ed25519 signature over the canonical manifest bytes.
/// Returns the problem to report, or `None` when the signature verifies.
fn verify_signature(
    signature_hex: &str,
    key: &VerifyingKey,
    manifest: &ReleaseManifest,
) -> Option<String> {
    let Some(bytes) = decode_hex::<64>(signature_hex) else {
        return Some("release manifest signature is not a 128-character hex string".to_string());
    };
    let signature = ed25519_dalek::Signature::from_bytes(&bytes);
    match key.verify_strict(&canonical_manifest_bytes(manifest), &signature) {
        Ok(()) => None,
        Err(_) => Some(
            "release manifest signature does not verify against the pinned release key".to_string(),
        ),
    }
}

/// Canonical signing bytes for a release manifest.
///
/// The manifest is serialized as compact JSON of a helper struct whose field
/// order is fixed by declaration order (`version`, `channel`, `target`,
/// `builtAt`, `files`) and which deliberately omits the mutable `signature`
/// and `signingKeyId` fields, so signing and verification agree byte-for-byte
/// regardless of how the manifest was transported. [`sign_manifest`] and
/// [`verify_release`] both go through this function.
fn canonical_manifest_bytes(manifest: &ReleaseManifest) -> Vec<u8> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Canonical<'a> {
        version: &'a str,
        channel: &'a str,
        target: &'a str,
        built_at: &'a str,
        files: &'a [ChecksumEntry],
    }

    serde_json::to_vec(&Canonical {
        version: &manifest.version,
        channel: &manifest.channel,
        target: &manifest.target,
        built_at: &manifest.built_at,
        files: &manifest.files,
    })
    .expect("canonical manifest serialization is infallible")
}

/// Sign the canonical manifest bytes with the release signing key (§19.9).
///
/// Returns the hex-encoded 64-byte Ed25519 signature to store in
/// [`ReleaseManifest::signature`]. Used by the release scripts and tests.
pub fn sign_manifest(manifest: &ReleaseManifest, signing_key: &SigningKey) -> String {
    let signature = signing_key.sign(&canonical_manifest_bytes(manifest));
    encode_hex(&signature.to_bytes())
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn decode_hex<const N: usize>(hex: &str) -> Option<[u8; N]> {
    let hex = hex.trim();
    if !hex.is_ascii() || hex.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Compute a manifest for a staged directory. Used by the release scripts.
pub fn build_manifest(
    staged_dir: &Path,
    version: &str,
    channel: &str,
    target: &str,
    relative_paths: &[String],
) -> std::io::Result<ReleaseManifest> {
    let mut files = Vec::new();
    for relative in relative_paths {
        let bytes = std::fs::read(staged_dir.join(relative))?;
        files.push(ChecksumEntry {
            path: relative.clone(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.len() as u64,
        });
    }
    Ok(ReleaseManifest {
        version: version.to_string(),
        channel: channel.to_string(),
        target: target.to_string(),
        built_at: cbc_patch::now_iso8601(),
        files,
        signature: None,
        signing_key_id: None,
    })
}

/// Semantic-version comparison for the update banner (§6.19). Returns true when
/// `candidate` is newer than `current`. Pre-release versions are only offered
/// when the current version is itself a pre-release, so a stable channel shows
/// stable updates only.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    let Some(current) = parse_semver(current) else {
        return false;
    };
    let Some(candidate) = parse_semver(candidate) else {
        return false;
    };

    if !candidate.pre.is_empty() && current.pre.is_empty() {
        return false;
    }

    candidate.cmp_precedence(&current).is_gt()
}

fn parse_semver(raw: &str) -> Option<Version> {
    let raw = raw.trim();
    Version::parse(raw.strip_prefix('v').unwrap_or(raw)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn staged() -> (TempDir, ReleaseManifest) {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        std::fs::create_dir_all(dir.path().join("libexec")).unwrap();
        std::fs::write(dir.path().join("bin/cbc"), b"fake cbc binary").unwrap();
        std::fs::write(dir.path().join("libexec/cbc-runtime"), b"fake runtime").unwrap();
        let manifest = build_manifest(
            dir.path(),
            "0.1.0",
            "stable",
            "linux-x64",
            &["bin/cbc".to_string(), "libexec/cbc-runtime".to_string()],
        )
        .unwrap();
        (dir, manifest)
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn signed(manifest: &mut ReleaseManifest) -> SigningKey {
        let key = signing_key();
        manifest.signature = Some(sign_manifest(manifest, &key));
        key
    }

    #[test]
    fn verifies_matching_release() {
        let (dir, mut manifest) = staged();
        let key = signed(&mut manifest);
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(
            report.status,
            VerifyStatus::Verified,
            "{:?}",
            report.problems
        );
        assert_eq!(report.files_checked, 2);
        assert!(report.safe_to_install);
    }

    #[test]
    fn detects_tampered_manifest_field() {
        // §19.9: a manifest edited after signing must not verify.
        let (dir, mut manifest) = staged();
        let key = signed(&mut manifest);
        manifest.version = "9.9.9".into();
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::InvalidSignature);
        assert!(!report.safe_to_install);
        assert!(report
            .problems
            .iter()
            .any(|p| p.contains("does not verify")));
    }

    #[test]
    fn rejects_signature_from_a_different_key() {
        let (dir, mut manifest) = staged();
        signed(&mut manifest);
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&attacker.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::InvalidSignature);
        assert!(!report.safe_to_install);
    }

    #[test]
    fn rejects_garbage_signature() {
        let (dir, mut manifest) = staged();
        let key = signed(&mut manifest);
        manifest.signature = Some("sig".into());
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::InvalidSignature);
        assert!(!report.safe_to_install);
        assert!(report.problems.iter().any(|p| p.contains("hex")));
    }

    #[test]
    fn rejects_signature_without_a_pinned_key() {
        let (dir, mut manifest) = staged();
        signed(&mut manifest);
        let report = verify_release(dir.path(), &manifest, "stable", true, None);
        assert_eq!(report.status, VerifyStatus::InvalidSignature);
        assert!(!report.safe_to_install);
        assert!(report.problems.iter().any(|p| p.contains("no release key")));
    }

    #[test]
    fn detects_tampered_file() {
        // §19.9: verification must not be bypassed.
        let (dir, mut manifest) = staged();
        let key = signed(&mut manifest);
        std::fs::write(dir.path().join("bin/cbc"), b"tampered binary!").unwrap();
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::ChecksumMismatch);
        assert!(!report.safe_to_install);
        assert!(report.problems.iter().any(|p| p.contains("bin/cbc")));
    }

    #[test]
    fn detects_missing_file() {
        let (dir, mut manifest) = staged();
        let key = signed(&mut manifest);
        std::fs::remove_file(dir.path().join("libexec/cbc-runtime")).unwrap();
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::MissingFile);
        assert!(!report.safe_to_install);
    }

    #[test]
    fn refuses_unsigned_manifest_when_signature_required() {
        let (dir, manifest) = staged();
        assert!(manifest.signature.is_none());
        let key = signing_key();
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::MissingSignature);
        assert!(!report.safe_to_install);
    }

    #[test]
    fn allows_unsigned_manifest_only_when_not_required() {
        let (dir, manifest) = staged();
        let report = verify_release(dir.path(), &manifest, "stable", false, None);
        assert_eq!(report.status, VerifyStatus::Verified);
        assert!(report.safe_to_install);
        // The problem is still reported so the UI can surface it.
        assert!(report.problems.iter().any(|p| p.contains("not signed")));
    }

    #[test]
    fn rejects_channel_mismatch() {
        let (dir, mut manifest) = staged();
        manifest.channel = "nightly".into();
        let key = signed(&mut manifest);
        let report = verify_release(
            dir.path(),
            &manifest,
            "stable",
            true,
            Some(&key.verifying_key()),
        );
        assert_eq!(report.status, VerifyStatus::ChannelMismatch);
        assert!(!report.safe_to_install);
    }

    #[test]
    fn pinned_release_key_parses() {
        assert!(pinned_release_verifying_key().is_some());
    }

    #[test]
    fn compares_semver_correctly() {
        assert!(is_newer("0.12.4", "0.12.5"));
        assert!(is_newer("0.12.5", "0.13.0"));
        assert!(is_newer("0.12.5", "1.0.0"));
        assert!(!is_newer("0.12.5", "0.12.5"));
        assert!(!is_newer("0.12.5", "0.12.4"));
        assert!(is_newer("v0.1.0", "v0.2.0"));
    }

    #[test]
    fn compares_numeric_prerelease_identifiers_numerically() {
        assert!(is_newer("0.1.1-alpha.9", "0.1.1-alpha.10"));
        assert!(is_newer("0.1.1-alpha.10", "0.1.1-alpha.12"));
        assert!(!is_newer("0.1.1-alpha.12", "0.1.1-alpha.9"));
    }

    #[test]
    fn follows_semver_prerelease_precedence() {
        assert!(is_newer("1.0.0-alpha", "1.0.0-alpha.1"));
        assert!(is_newer("1.0.0-alpha.1", "1.0.0-alpha.beta"));
        assert!(is_newer("1.0.0-beta.11", "1.0.0-rc.1"));
        assert!(!is_newer("1.0.0+build.1", "1.0.0+build.2"));
    }

    #[test]
    fn stable_channel_does_not_offer_prereleases() {
        // §6.19: "stable channel에서 stable update만 표시한다".
        assert!(!is_newer("0.12.5", "0.13.0-beta.1"));
        assert!(is_newer("0.13.0-beta.1", "0.13.0"));
        assert!(is_newer("0.13.0-beta.1", "0.13.0-beta.2"));
    }

    #[test]
    fn malformed_versions_never_trigger_an_update() {
        assert!(!is_newer("not-a-version", "1.0.0"));
        assert!(!is_newer("1.0.0", "not-a-version"));
    }
}
