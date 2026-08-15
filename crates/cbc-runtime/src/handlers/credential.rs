//! `credential.*` handlers — PRD §9.1–§9.3, §9.7, §20.3, AC-02.
//!
//! The runtime owns persistent credential storage; the control plane only ever
//! receives a short-lived lease (§9.1). Every stored secret is also registered
//! with the redactor so it can never appear in output the runtime produces
//! (§9.8, AC-39).

use cbc_keychain::{Keychain, DEFAULT_LEASE_TTL_MS};
use cbc_protocol::{error_codes, RpcError};
use serde_json::{json, Value};

use crate::server::{optional_str, optional_u64, required_str, RuntimeState};

fn keychain_error(e: cbc_keychain::KeychainError) -> RpcError {
    let code = match e {
        cbc_keychain::KeychainError::NotFound { .. } => error_codes::NOT_FOUND,
        cbc_keychain::KeychainError::MissingMasterKey => error_codes::INVALID_ARGUMENT,
        _ => error_codes::INTERNAL_ERROR,
    };
    RpcError::taxonomy(code, "INTERNAL", e.to_string())
}

fn with_keychain<T>(
    state: &RuntimeState,
    f: impl FnOnce(&Keychain) -> Result<T, RpcError>,
) -> Result<T, RpcError> {
    let guard = state.keychain.lock().expect("keychain lock");
    let keychain = guard
        .as_ref()
        .ok_or_else(|| RpcError::new(error_codes::NOT_INITIALIZED, "keychain not initialized"))?;
    f(keychain)
}

pub fn store(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let account = required_str(&params, "account")?;
    let secret = required_str(&params, "secret")?;
    if secret.trim().is_empty() {
        return Err(RpcError::invalid_params("secret must not be empty"));
    }
    if let Some(passphrase) = optional_str(&params, "passphrase") {
        with_keychain(state, |kc| {
            kc.unlock(&passphrase);
            Ok(())
        })?;
    }

    let backend = with_keychain(state, |kc| {
        kc.store(&account, &secret).map_err(keychain_error)?;
        Ok(kc.backend())
    })?;

    // Register the exact literal so it is redacted everywhere from now on.
    state
        .redactor
        .lock()
        .expect("redactor lock")
        .add_literal(&secret);

    Ok(json!({
        "account": account,
        "backend": backend.label(),
        "persistent": backend.is_persistent(),
        "fingerprint": cbc_keychain::fingerprint(&secret),
        "storedAt": cbc_patch::now_iso8601(),
    }))
}

pub fn lease(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let account = required_str(&params, "account")?;
    let source = optional_str(&params, "source").unwrap_or_else(|| "keychain".to_string());
    let ttl_ms = optional_u64(&params, "ttlMs").unwrap_or(DEFAULT_LEASE_TTL_MS);
    if let Some(passphrase) = optional_str(&params, "passphrase") {
        with_keychain(state, |kc| {
            kc.unlock(&passphrase);
            Ok(())
        })?;
    }

    let (lease, secret) = with_keychain(state, |kc| {
        kc.lease(&account, &source, ttl_ms).map_err(keychain_error)
    })?;

    state
        .redactor
        .lock()
        .expect("redactor lock")
        .add_literal(&secret);

    // The secret travels once, in this response only, and is never journaled.
    Ok(json!({
        "lease": lease,
        "secret": secret,
    }))
}

pub fn delete(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let account = required_str(&params, "account")?;
    if let Some(passphrase) = optional_str(&params, "passphrase") {
        with_keychain(state, |kc| {
            kc.unlock(&passphrase);
            Ok(())
        })?;
    }
    let removed = with_keychain(state, |kc| kc.delete(&account).map_err(keychain_error))?;
    Ok(json!({ "account": account, "removed": removed }))
}
