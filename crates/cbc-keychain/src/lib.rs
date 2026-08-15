//! Credential storage for the runtime.
//!
//! This build ships two backends and no OS-native keychain integration: an
//! authenticated encrypted file under the Capybara data directory
//! (XChaCha20-Poly1305 over the whole credential map, key and vault restricted to
//! the current user where the platform exposes Unix permissions), and a
//! session-only in-memory fallback when the data directory is not writable. It is
//! intentionally reported as `encrypted-file` / `session-only` — never "os-native" —
//! so callers present the real promise rather than a stronger one (§24.5).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

/// Default credential lease lifetime.
pub const DEFAULT_LEASE_TTL_MS: u64 = 5 * 60 * 1000;

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const MAX_VAULT_BYTES: usize = 1024 * 1024;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 256;
const KEY_FILE_NAME: &str = "keychain.key";
const VAULT_FILE_NAME: &str = "credentials.enc";
const MAGIC: &[u8] = b"CBC-KEYCHAIN-V1";
const ASSOCIATED_DATA: &[u8] = b"capybara-keychain-v1";
const ENV_KEY_NAME: &str = "CAPYBARA_KEYCHAIN_KEY";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Secrets held for the lifetime of the runtime process only.
    Memory,
    /// An authenticated encrypted file under the Capybara data directory.
    EncryptedFile,
}

impl Backend {
    pub fn label(&self) -> &'static str {
        match self {
            Backend::Memory => "session-only",
            Backend::EncryptedFile => "encrypted-file",
        }
    }

    pub fn is_persistent(&self) -> bool {
        matches!(self, Backend::EncryptedFile)
    }
}

#[derive(Debug)]
pub enum KeychainError {
    NotFound {
        account: String,
    },
    /// Persistent storage was requested with no unlocked master key.
    MissingMasterKey,
    Io {
        message: String,
    },
}

impl std::fmt::Display for KeychainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeychainError::NotFound { account } => {
                write!(f, "no credential stored for '{account}'")
            }
            KeychainError::MissingMasterKey => write!(
                f,
                "persistent credential storage is unavailable; credentials are kept in memory for this session only"
            ),
            KeychainError::Io { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for KeychainError {}

/// Credential lease handed to the control plane. The secret travels beside it once
/// and is never journaled.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialLease {
    pub account: String,
    pub source: String,
    pub fingerprint: String,
    pub issued_at: String,
    pub expires_at: String,
    pub ttl_ms: u64,
}

/// A non-reversible identifier for a secret, safe to log and display.
pub fn fingerprint(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    format!("sha256:{:x}", digest)[..19].to_string()
}

/// Credential storage for the runtime.
pub struct Keychain {
    data_dir: PathBuf,
    backend: Backend,
    secrets: Mutex<HashMap<String, String>>,
    key: Option<[u8; KEY_BYTES]>,
    vault_path: PathBuf,
}

impl Keychain {
    /// Open the encrypted-file fallback when its key and vault can be prepared.
    ///
    /// A failed initialization falls back to memory instead of preventing the
    /// runtime from starting. The RPC result reports session-only in that case.
    pub fn detect(data_dir: &Path) -> Self {
        let auth_dir = data_dir.join("auth");
        let vault_path = auth_dir.join(VAULT_FILE_NAME);
        let persistent = (|| {
            fs::create_dir_all(&auth_dir).map_err(io_message)?;
            restrict_permissions(&auth_dir).map_err(io_message)?;
            let key = load_or_create_key(&auth_dir.join(KEY_FILE_NAME))?;
            let secrets = read_vault(&vault_path, &key)?;
            Ok::<_, String>((key, secrets))
        })();

        match persistent {
            Ok((key, secrets)) => Self {
                data_dir: data_dir.to_path_buf(),
                backend: Backend::EncryptedFile,
                secrets: Mutex::new(secrets),
                key: Some(key),
                vault_path,
            },
            Err(_) => Self {
                data_dir: data_dir.to_path_buf(),
                backend: Backend::Memory,
                secrets: Mutex::new(HashMap::new()),
                key: None,
                vault_path,
            },
        }
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Retained for the RPC contract. The portable fallback uses a per-install
    /// random key file, so a passphrase is not required for normal operation.
    pub fn unlock(&self, _passphrase: &str) {}

    pub fn store(&self, account: &str, secret: &str) -> Result<(), KeychainError> {
        validate_entry(account, secret)?;
        let mut secrets = self.secrets.lock().expect("secrets lock");
        if secrets.len() >= MAX_ENTRIES && !secrets.contains_key(account) {
            return Err(io_error("credential store has reached its entry limit"));
        }

        let previous = secrets.insert(account.to_string(), secret.to_string());
        if let Err(error) = self.persist(&secrets) {
            match previous {
                Some(old) => {
                    secrets.insert(account.to_string(), old);
                }
                None => {
                    secrets.remove(account);
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn lease(
        &self,
        account: &str,
        source: &str,
        ttl_ms: u64,
    ) -> Result<(CredentialLease, String), KeychainError> {
        let secret = self
            .secrets
            .lock()
            .expect("secrets lock")
            .get(account)
            .cloned()
            .ok_or_else(|| KeychainError::NotFound {
                account: account.to_string(),
            })?;

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let lease = CredentialLease {
            account: account.to_string(),
            source: source.to_string(),
            fingerprint: fingerprint(&secret),
            issued_at: cbc_iso8601(now_ms),
            expires_at: cbc_iso8601(now_ms + ttl_ms as i64),
            ttl_ms,
        };
        Ok((lease, secret))
    }

    pub fn delete(&self, account: &str) -> Result<bool, KeychainError> {
        let mut secrets = self.secrets.lock().expect("secrets lock");
        let previous = secrets.remove(account);
        if previous.is_none() {
            return Ok(false);
        }

        if let Err(error) = self.persist(&secrets) {
            if let Some(old) = previous {
                secrets.insert(account.to_string(), old);
            }
            return Err(error);
        }
        Ok(true)
    }

    fn persist(&self, secrets: &HashMap<String, String>) -> Result<(), KeychainError> {
        if self.backend != Backend::EncryptedFile {
            return Ok(());
        }
        let key = self.key.as_ref().ok_or(KeychainError::MissingMasterKey)?;
        write_vault(&self.vault_path, key, secrets).map_err(io_error)
    }
}

impl Drop for Keychain {
    fn drop(&mut self) {
        if let Some(key) = self.key.as_mut() {
            key.zeroize();
        }
        if let Ok(mut secrets) = self.secrets.lock() {
            for secret in secrets.values_mut() {
                secret.zeroize();
            }
        }
    }
}

fn validate_entry(account: &str, secret: &str) -> Result<(), KeychainError> {
    if account.is_empty() || account.len() > 1024 {
        return Err(io_error("credential account name is invalid"));
    }
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err(io_error("credential secret is empty or too large"));
    }
    Ok(())
}

fn load_or_create_key(path: &Path) -> Result<[u8; KEY_BYTES], String> {
    if let Some(raw) = std::env::var_os(ENV_KEY_NAME) {
        let value = raw.to_string_lossy();
        if value.is_empty() {
            return Err(format!("{ENV_KEY_NAME} is empty"));
        }
        return Ok(derive_key(value.as_bytes()));
    }

    match fs::read(path) {
        Ok(bytes) => return parse_key(&bytes),
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.to_string()),
        Err(_) => {}
    }

    let mut key = [0u8; KEY_BYTES];
    getrandom::fill(&mut key)
        .map_err(|error| format!("could not generate keychain key: {error}"))?;

    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            restrict_file(&file).map_err(io_message)?;
            if let Err(error) = file.write_all(&key).and_then(|_| file.sync_all()) {
                let _ = fs::remove_file(path);
                return Err(error.to_string());
            }
            Ok(key)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let bytes = fs::read(path).map_err(io_message)?;
            parse_key(&bytes)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn parse_key(bytes: &[u8]) -> Result<[u8; KEY_BYTES], String> {
    if bytes.len() != KEY_BYTES {
        return Err("credential key file has an invalid length".to_string());
    }
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(bytes);
    Ok(key)
}

fn derive_key(value: &[u8]) -> [u8; KEY_BYTES] {
    let mut hasher = Sha256::new();
    hasher.update(b"capybara-keychain-env-v1");
    hasher.update(value);
    hasher.finalize().into()
}

fn read_vault(path: &Path, key: &[u8; KEY_BYTES]) -> Result<HashMap<String, String>, String> {
    let encoded = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            #[cfg(windows)]
            {
                // P1-06: a crash mid-replacement can leave the vault parked as
                // `.bak`. Restore it instead of behaving as if no credentials
                // ever existed.
                let backup = backup_path(path);
                if backup.exists() {
                    let _ = fs::rename(&backup, path);
                }
                match fs::read(path) {
                    Ok(bytes) => bytes,
                    Err(retry) if retry.kind() == io::ErrorKind::NotFound => {
                        return Ok(HashMap::new());
                    }
                    Err(retry) => return Err(retry.to_string()),
                }
            }
            #[cfg(not(windows))]
            return Ok(HashMap::new());
        }
        Err(error) => return Err(error.to_string()),
    };
    if encoded.len() > MAX_VAULT_BYTES {
        return Err("credential vault is too large".to_string());
    }

    let payload_start = MAGIC.len() + NONCE_BYTES;
    if encoded.len() <= payload_start || &encoded[..MAGIC.len()] != MAGIC {
        return Err("credential vault header is invalid".to_string());
    }

    let nonce_start = MAGIC.len();
    let nonce_end = nonce_start + NONCE_BYTES;
    let key_array: Key = (*key).into();
    let cipher = XChaCha20Poly1305::new(&key_array);
    let mut nonce = [0u8; NONCE_BYTES];
    nonce.copy_from_slice(&encoded[nonce_start..nonce_end]);
    let nonce = XNonce::from(nonce);
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &encoded[payload_start..],
                aad: ASSOCIATED_DATA,
            },
        )
        .map_err(|_| "credential vault authentication failed".to_string())?;

    let secrets: HashMap<String, String> =
        serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
    validate_entries(&secrets)?;
    Ok(secrets)
}

fn write_vault(
    path: &Path,
    key: &[u8; KEY_BYTES],
    secrets: &HashMap<String, String>,
) -> Result<(), String> {
    validate_entries(secrets)?;
    let mut plaintext = serde_json::to_vec(secrets).map_err(|error| error.to_string())?;

    let mut nonce = [0u8; NONCE_BYTES];
    getrandom::fill(&mut nonce)
        .map_err(|error| format!("could not generate vault nonce: {error}"))?;

    let key_array: Key = (*key).into();
    let cipher = XChaCha20Poly1305::new(&key_array);
    let nonce_array = XNonce::from(nonce);
    let mut ciphertext = cipher
        .encrypt(
            &nonce_array,
            Payload {
                msg: &plaintext,
                aad: ASSOCIATED_DATA,
            },
        )
        .map_err(|_| "could not encrypt credential vault".to_string())?;
    plaintext.zeroize();

    let mut encoded = Vec::with_capacity(MAGIC.len() + nonce.len() + ciphertext.len());
    encoded.extend_from_slice(MAGIC);
    encoded.extend_from_slice(&nonce);
    encoded.append(&mut ciphertext);
    atomic_write(path, &encoded).map_err(io_message)?;
    encoded.zeroize();
    Ok(())
}

fn validate_entries(secrets: &HashMap<String, String>) -> Result<(), String> {
    if secrets.len() > MAX_ENTRIES {
        return Err("credential vault has too many entries".to_string());
    }
    for (account, secret) in secrets {
        if account.is_empty() || account.len() > 1024 {
            return Err("credential vault contains an invalid account name".to_string());
        }
        if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
            return Err("credential vault contains an invalid secret".to_string());
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(|error| io::Error::other(error.to_string()))?;
    let temp_name = format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("vault"),
        std::process::id(),
        hex(&suffix)
    );
    let temp_path = parent.join(temp_name);

    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        restrict_file(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        #[cfg(windows)]
        {
            // P1-06: `fs::rename` on Windows will not replace an existing file,
            // and deleting the destination first opens a window where the vault
            // does not exist at all. Renaming the live vault aside to `.bak`
            // first means a crash at any step still leaves one complete copy;
            // `read_vault` restores the backup on the next open.
            if path.exists() {
                let backup = backup_path(path);
                let _ = fs::remove_file(&backup);
                fs::rename(path, &backup)?;
            }
            if let Err(error) = fs::rename(&temp_path, path) {
                // Put the live vault back before surfacing the failure.
                let backup = backup_path(path);
                if !path.exists() && backup.exists() {
                    let _ = fs::rename(&backup, path);
                }
                return Err(error);
            }
            let _ = fs::remove_file(backup_path(path));
        }
        #[cfg(not(windows))]
        fs::rename(&temp_path, path)?;
        restrict_permissions(path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("vault");
    path.with_file_name(format!(".{name}.bak"))
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn io_error(message: impl Into<String>) -> KeychainError {
    KeychainError::Io {
        message: message.into(),
    }
}

fn io_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = file.metadata()?.permissions();
    permissions.set_mode(0o600);
    file.set_permissions(permissions)
}

#[cfg(not(unix))]
fn restrict_file(_file: &File) -> io::Result<()> {
    Ok(())
}

/// RFC 3339 UTC timestamp.
fn cbc_iso8601(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let ms = millis.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn encrypted_store_survives_runtime_restart() {
        let directory = tempdir().expect("tempdir");
        let first = Keychain::detect(directory.path());
        assert_eq!(first.backend(), Backend::EncryptedFile);
        first
            .store("openai:account", "access-token-value")
            .expect("store");
        drop(first);

        let second = Keychain::detect(directory.path());
        assert_eq!(second.backend(), Backend::EncryptedFile);
        let (_, secret) = second
            .lease("openai:account", "account", DEFAULT_LEASE_TTL_MS)
            .expect("lease");
        assert_eq!(secret, "access-token-value");

        let vault = fs::read(directory.path().join("auth").join(VAULT_FILE_NAME)).expect("vault");
        assert!(!vault
            .windows("access-token-value".len())
            .any(|window| window == b"access-token-value"));
    }

    #[test]
    fn delete_is_persisted() {
        let directory = tempdir().expect("tempdir");
        let first = Keychain::detect(directory.path());
        first.store("one", "secret-one").expect("store");
        assert!(first.delete("one").expect("delete"));
        drop(first);

        let second = Keychain::detect(directory.path());
        assert!(matches!(
            second.lease("one", "test", DEFAULT_LEASE_TTL_MS),
            Err(KeychainError::NotFound { .. })
        ));
    }

    #[test]
    fn tampered_vault_falls_back_to_session_only() {
        let directory = tempdir().expect("tempdir");
        let first = Keychain::detect(directory.path());
        first.store("one", "secret-one").expect("store");
        drop(first);

        let path = directory.path().join("auth").join(VAULT_FILE_NAME);
        let mut bytes = fs::read(&path).expect("vault");
        *bytes.last_mut().expect("ciphertext") ^= 1;
        fs::write(path, bytes).expect("tamper");

        let second = Keychain::detect(directory.path());
        assert_eq!(second.backend(), Backend::Memory);
    }

    #[test]
    fn oversized_secret_is_rejected() {
        let directory = tempdir().expect("tempdir");
        let keychain = Keychain::detect(directory.path());
        let secret = "x".repeat(MAX_SECRET_BYTES + 1);
        assert!(matches!(
            keychain.store("one", &secret),
            Err(KeychainError::Io { .. })
        ));
    }
}
