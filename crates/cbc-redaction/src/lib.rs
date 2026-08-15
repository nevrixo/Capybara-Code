//! `cbc-redaction` — secret detection/redaction and terminal control sequence
//! sanitization primitives owned by the Rust trusted execution plane (§19.5).
//!
//! PRD references: §9.8 (secret redaction surfaces), §14.8 (detection inputs),
//! §6.20 and §24.4 T6 (terminal escape safety), AC-33, AC-39, RT-004, RT-005.

pub mod sanitize;
pub mod secrets;

pub use sanitize::{
    sanitize, sanitize_for_model, SanitizeOptions, SanitizeReport, Sanitized, SgrPolicy,
    DEFAULT_MAX_LINE_BYTES,
};
pub use secrets::{
    is_secret_env_name, redact_patterns_only, shannon_entropy, Redacted, RedactionReport, Redactor,
    SecretKind, REDACTED,
};

/// Apply the full display pipeline: sanitize terminal controls, then redact
/// secrets. §11.6 mandates this order — sanitize first so escape sequences
/// cannot hide a secret from the detector.
pub fn safe_for_display(input: &str, redactor: &Redactor) -> String {
    let sanitized = sanitize(input, &SanitizeOptions::for_model_and_journal());
    redactor.redact_text(&sanitized.text)
}

/// Same pipeline but preserving safe colour for the dedicated PTY view.
pub fn safe_for_pty_view(input: &str, redactor: &Redactor) -> String {
    let sanitized = sanitize(input, &SanitizeOptions::for_pty_view());
    redactor.redact_text(&sanitized.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_sequences_cannot_hide_secrets() {
        // A hostile process could try to split a secret with cursor moves.
        let mut redactor = Redactor::new();
        redactor.add_literal("sk-supersecretkey12345");
        let hostile = "\u{1b}]0;title\u{7}key=sk-supersecretkey12345\u{1b}[2J";
        let out = safe_for_display(hostile, &redactor);
        assert!(!out.contains("supersecretkey"));
        assert!(!out.contains('\u{1b}'));
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn pty_view_keeps_color_but_still_redacts() {
        let mut redactor = Redactor::new();
        redactor.add_literal("tok_live_abcdefghijkl");
        let out = safe_for_pty_view("\u{1b}[32mtoken tok_live_abcdefghijkl\u{1b}[0m", &redactor);
        assert!(out.contains("\u{1b}[32m"));
        assert!(!out.contains("abcdefghijkl"));
    }
}
