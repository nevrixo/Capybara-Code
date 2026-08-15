//! Secret detection and redaction — PRD §9.8, §14.8, AC-39.
//!
//! Redaction combines three signals, per §14.8:
//!   1. exact known secret literals (registered credentials, env values),
//!   2. high-confidence credential formats,
//!   3. high-entropy candidates *with* contextual assignment keywords.
//!
//! Signal 1 and 2 are unconditional. Signal 3 requires context to keep the
//! false-positive rate low, as §9.8 requires.

use std::collections::BTreeSet;

pub const REDACTED: &str = "***REDACTED***";

/// Minimum length for a literal to be worth exact-matching. Shorter strings
/// would cause pathological false positives across normal source text.
const MIN_LITERAL_LEN: usize = 8;

/// Environment variable name fragments whose values are always treated as
/// secret material (§14.5 "Default excluded/redacted").
const SECRET_NAME_FRAGMENTS: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "APIKEY",
    "API_KEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "CLIENT_SECRET",
    "REFRESH_TOKEN",
    "SESSION_KEY",
    "CREDENTIAL",
    "AUTH",
    "BEARER",
    "PASSPHRASE",
    "SIGNING_KEY",
    "ENCRYPTION_KEY",
];

/// Contextual keys that make a high-entropy value likely to be a secret.
const CONTEXT_KEYS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "access_key",
    "accesskey",
    "private_key",
    "privatekey",
    "client_secret",
    "clientsecret",
    "refresh_token",
    "authorization",
    "bearer",
    "credential",
    "passphrase",
    "session_key",
    "signature",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SecretKind {
    KnownLiteral,
    OpenAiKey,
    GenericProviderKey,
    GitHubToken,
    SlackToken,
    GoogleApiKey,
    AwsAccessKeyId,
    JsonWebToken,
    PrivateKeyBlock,
    BasicAuthUrl,
    ContextualHighEntropy,
}

impl SecretKind {
    pub fn label(&self) -> &'static str {
        match self {
            SecretKind::KnownLiteral => "known-literal",
            SecretKind::OpenAiKey => "openai-key",
            SecretKind::GenericProviderKey => "provider-key",
            SecretKind::GitHubToken => "github-token",
            SecretKind::SlackToken => "slack-token",
            SecretKind::GoogleApiKey => "google-api-key",
            SecretKind::AwsAccessKeyId => "aws-access-key-id",
            SecretKind::JsonWebToken => "jwt",
            SecretKind::PrivateKeyBlock => "private-key-block",
            SecretKind::BasicAuthUrl => "basic-auth-url",
            SecretKind::ContextualHighEntropy => "contextual-high-entropy",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RedactionReport {
    pub replacements: usize,
    pub kinds: BTreeSet<&'static str>,
}

impl RedactionReport {
    pub fn redacted(&self) -> bool {
        self.replacements > 0
    }
}

#[derive(Debug, Clone)]
pub struct Redacted {
    pub text: String,
    pub report: RedactionReport,
}

/// Registry of exact secrets known to this process. Populated from stored
/// credentials and from environment values whose names look sensitive.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    literals: Vec<String>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an exact secret literal. Values shorter than `MIN_LITERAL_LEN`
    /// are ignored to avoid corrupting ordinary output.
    pub fn add_literal(&mut self, literal: &str) -> bool {
        let trimmed = literal.trim();
        if trimmed.len() < MIN_LITERAL_LEN {
            return false;
        }
        if self.literals.iter().any(|l| l == trimmed) {
            return true;
        }
        self.literals.push(trimmed.to_string());
        // Longest first so overlapping literals redact maximally.
        self.literals.sort_by_key(|l| std::cmp::Reverse(l.len()));
        true
    }

    pub fn literal_count(&self) -> usize {
        self.literals.len()
    }

    /// Register every environment value whose name looks like a credential
    /// (§14.5). Values are never logged, only registered.
    pub fn add_secret_env(&mut self, env: impl Iterator<Item = (String, String)>) {
        for (name, value) in env {
            if is_secret_env_name(&name) {
                self.add_literal(&value);
            }
        }
    }

    pub fn add_process_secret_env(&mut self) {
        self.add_secret_env(std::env::vars());
    }

    /// Redact a string. Applied to TUI output, journals, logs, JSONL events,
    /// debug bundles, exception messages, env previews, and MCP stderr (§9.8).
    pub fn redact(&self, input: &str) -> Redacted {
        let mut report = RedactionReport::default();
        let mut text = input.to_string();

        // 1. Exact known literals.
        for literal in &self.literals {
            if text.contains(literal.as_str()) {
                let occurrences = text.matches(literal.as_str()).count();
                text = text.replace(literal.as_str(), REDACTED);
                report.replacements += occurrences;
                report.kinds.insert(SecretKind::KnownLiteral.label());
            }
        }

        // 2. High-confidence formats + 3. contextual high entropy.
        text = redact_patterns(&text, &mut report);

        Redacted { text, report }
    }

    pub fn redact_text(&self, input: &str) -> String {
        self.redact(input).text
    }

    /// Assert no registered literal survives. Used by AC-39 regression tests.
    pub fn contains_known_secret(&self, haystack: &str) -> bool {
        self.literals.iter().any(|l| haystack.contains(l.as_str()))
    }
}

pub fn is_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if upper == "PATH" || upper == "HOME" || upper == "TERM" || upper == "LANG" {
        return false;
    }
    SECRET_NAME_FRAGMENTS
        .iter()
        .any(|frag| upper.contains(frag))
        || upper.starts_with("AWS_") && (upper.contains("KEY") || upper.contains("SESSION"))
}

/// Stateless pattern redaction, usable without a registry.
pub fn redact_patterns_only(input: &str) -> Redacted {
    let mut report = RedactionReport::default();
    let text = redact_patterns(input, &mut report);
    Redacted { text, report }
}

fn redact_patterns(input: &str, report: &mut RedactionReport) -> String {
    let mut text = redact_private_key_blocks(input, report);
    text = redact_tokenwise(&text, report);
    text = redact_basic_auth_urls(&text, report);
    text
}

fn redact_private_key_blocks(input: &str, report: &mut RedactionReport) -> String {
    const BEGIN: &str = "-----BEGIN";
    const PRIVATE: &str = "PRIVATE KEY-----";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    loop {
        let Some(start) = rest.find(BEGIN) else {
            out.push_str(rest);
            break;
        };
        let header_end = match rest[start..]
            .find("-----\n")
            .or_else(|| rest[start..].find("-----"))
        {
            Some(off) => start + off + 5,
            None => {
                out.push_str(rest);
                break;
            }
        };
        let header = &rest[start..header_end];
        if !header.contains(PRIVATE) && !header.contains("PRIVATE KEY") {
            out.push_str(&rest[..header_end]);
            rest = &rest[header_end..];
            continue;
        }
        let end_marker = "-----END";
        let block_end = match rest[header_end..].find(end_marker) {
            Some(off) => {
                let after = header_end + off;
                match rest[after..].find("-----\n") {
                    Some(o2) => after + o2 + 6,
                    None => match rest[after..].find("KEY-----") {
                        Some(o2) => after + o2 + 8,
                        None => rest.len(),
                    },
                }
            }
            None => rest.len(),
        };
        out.push_str(&rest[..start]);
        out.push_str(REDACTED);
        report.replacements += 1;
        report.kinds.insert(SecretKind::PrivateKeyBlock.label());
        rest = &rest[block_end..];
    }
    out
}

/// Split on non-secret delimiters and evaluate each token independently. This
/// avoids regex while keeping detection precise about token boundaries.
fn redact_tokenwise(input: &str, report: &mut RedactionReport) -> String {
    let mut out = String::with_capacity(input.len());
    let mut token = String::new();
    // Rolling window of everything already emitted, so `api_key = <value>` and
    // `Authorization: Bearer <value>` supply context for the entropy heuristic.
    let mut context = String::new();

    fn remember(context: &mut String, text: &str) {
        context.push_str(text);
        if context.len() > 96 {
            let start = context.len() - 96;
            let boundary = (start..context.len())
                .find(|i| context.is_char_boundary(*i))
                .unwrap_or(context.len());
            *context = context[boundary..].to_string();
        }
    }

    let flush = |token: &mut String,
                 out: &mut String,
                 context: &mut String,
                 report: &mut RedactionReport| {
        if token.is_empty() {
            return;
        }
        match classify_token(token, context) {
            Some(kind) => {
                out.push_str(REDACTED);
                report.replacements += 1;
                report.kinds.insert(kind.label());
            }
            None => out.push_str(token),
        }
        remember(context, token);
        token.clear();
    };

    for c in input.chars() {
        if is_token_char(c) {
            token.push(c);
        } else {
            flush(&mut token, &mut out, &mut context, report);
            out.push(c);
            remember(&mut context, &c.to_string());
        }
    }
    flush(&mut token, &mut out, &mut context, report);
    out
}

fn is_token_char(c: char) -> bool {
    // `=` is deliberately excluded so `NAME=value` splits into two tokens; that
    // both classifies `value` correctly and lets `NAME` supply context.
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '+' | '~')
}

fn classify_token(token: &str, context: &str) -> Option<SecretKind> {
    // OpenAI-style keys: sk-..., sk-proj-..., and organisation/project keys.
    if (token.starts_with("sk-") || token.starts_with("rk-"))
        && token.len() >= 20
        && token[3..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Some(SecretKind::OpenAiKey);
    }
    // GitHub tokens.
    if token.len() >= 30
        && ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]
            .iter()
            .any(|p| token.starts_with(p))
    {
        return Some(SecretKind::GitHubToken);
    }
    // Slack tokens.
    if token.starts_with("xox") && token.len() >= 20 {
        return Some(SecretKind::SlackToken);
    }
    // Google API keys.
    if token.starts_with("AIza") && token.len() >= 35 {
        return Some(SecretKind::GoogleApiKey);
    }
    // AWS access key IDs.
    if token.len() == 20
        && (token.starts_with("AKIA") || token.starts_with("ASIA"))
        && token[4..]
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Some(SecretKind::AwsAccessKeyId);
    }
    // Anthropic / generic provider prefixed keys.
    if token.len() >= 25
        && [
            "anthropic-",
            "sk_live_",
            "sk_test_",
            "pk_live_",
            "hf_",
            "gsk_",
            "cbc_pat_",
        ]
        .iter()
        .any(|p| token.starts_with(p))
    {
        return Some(SecretKind::GenericProviderKey);
    }
    // JWTs: three base64url segments.
    if token.starts_with("eyJ") {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() == 3 && parts.iter().all(|p| p.len() >= 8) {
            return Some(SecretKind::JsonWebToken);
        }
    }
    // Contextual high entropy: only when an assignment keyword precedes it.
    if token.len() >= 20 && context_suggests_secret(context) && shannon_entropy(token) >= 3.4 {
        return Some(SecretKind::ContextualHighEntropy);
    }
    None
}

fn context_suggests_secret(context: &str) -> bool {
    let lower = context.to_ascii_lowercase();
    // Only the tail matters: `token=`, `"secret": `, `Authorization: Bearer `.
    let start = lower.len().saturating_sub(48);
    let boundary = (start..lower.len())
        .find(|i| lower.is_char_boundary(*i))
        .unwrap_or(0);
    let tail = &lower[boundary..];
    CONTEXT_KEYS.iter().any(|k| tail.contains(k))
}

fn redact_basic_auth_urls(input: &str, report: &mut RedactionReport) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let Some(idx) = rest.find("://") else {
            out.push_str(rest);
            break;
        };
        let after = idx + 3;
        // Authority ends at '/', '?', '#', whitespace, or quote.
        let auth_end = rest[after..]
            .find(|c: char| {
                c == '/' || c == '?' || c == '#' || c.is_whitespace() || c == '"' || c == '\''
            })
            .map(|o| after + o)
            .unwrap_or(rest.len());
        let authority = &rest[after..auth_end];
        if let Some(at) = authority.rfind('@') {
            let userinfo = &authority[..at];
            if userinfo.contains(':') && !userinfo.is_empty() {
                let user = userinfo.split(':').next().unwrap_or("");
                out.push_str(&rest[..after]);
                out.push_str(user);
                out.push(':');
                out.push_str(REDACTED);
                out.push_str(&authority[at..]);
                report.replacements += 1;
                report.kinds.insert(SecretKind::BasicAuthUrl.label());
                rest = &rest[auth_end..];
                continue;
            }
        }
        out.push_str(&rest[..auth_end]);
        rest = &rest[auth_end..];
        if rest.is_empty() {
            break;
        }
    }
    out
}

/// Shannon entropy in bits per character.
pub fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut counts = [0usize; 256];
    let mut total = 0usize;
    for b in s.bytes() {
        counts[b as usize] += 1;
        total += 1;
    }
    let total_f = total as f64;
    -counts
        .iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / total_f;
            p * p.log2()
        })
        .sum::<f64>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_exact_known_literal_everywhere() {
        // AC-39: a known API key must not appear in TUI, journal, logs, bundle.
        let mut r = Redactor::new();
        assert!(r.add_literal("sk-proj-abc123def456ghi789jkl"));
        let out = r
            .redact("using sk-proj-abc123def456ghi789jkl for auth (sk-proj-abc123def456ghi789jkl)");
        assert!(!out.text.contains("abc123def456"));
        assert_eq!(out.report.replacements, 2);
        assert!(out.report.redacted());
        assert!(!r.contains_known_secret(&out.text));
    }

    #[test]
    fn ignores_too_short_literals() {
        let mut r = Redactor::new();
        assert!(!r.add_literal("abc"));
        assert_eq!(r.literal_count(), 0);
        assert_eq!(r.redact("abc def").text, "abc def");
    }

    #[test]
    fn detects_openai_key_without_registration() {
        let out = redact_patterns_only("export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345");
        assert!(out.text.contains(REDACTED));
        assert!(!out.text.contains("abcdefghijklmnop"));
        assert!(out.report.kinds.contains("openai-key"));
    }

    #[test]
    fn detects_provider_token_formats() {
        let cases = [
            ("ghp_0123456789abcdefghijklmnopqrstuvwx", "github-token"),
            ("xoxp-EXAMPLE-NOT-REAL-SLACK-TOKEN-0000", "slack-token"),
            ("AIzaSyA0123456789abcdefghijklmnopqrstuv", "google-api-key"),
            ("AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"),
        ];
        for (token, kind) in cases {
            let out = redact_patterns_only(&format!("value: {token} end"));
            assert!(out.text.contains(REDACTED), "not redacted: {token}");
            assert!(
                out.report.kinds.contains(kind),
                "wrong kind for {token}: {:?}",
                out.report.kinds
            );
        }
    }

    #[test]
    fn detects_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let out = redact_patterns_only(&format!("Authorization: Bearer {jwt}"));
        assert!(out.text.contains(REDACTED));
        assert!(!out.text.contains("dBjftJeZ4CVPmB92"));
    }

    #[test]
    fn redacts_private_key_block() {
        let input = "prefix\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----\nsuffix";
        let out = redact_patterns_only(input);
        assert!(!out.text.contains("MIIEpAIBAAKCAQEA"));
        assert!(out.text.contains("prefix"));
        assert!(out.text.contains("suffix"));
        assert!(out.report.kinds.contains("private-key-block"));
    }

    #[test]
    fn redacts_basic_auth_in_url() {
        let out = redact_patterns_only("git clone https://user:s3cr3tpassword@github.com/o/r.git");
        assert!(!out.text.contains("s3cr3tpassword"));
        assert!(out.text.contains("user:"));
        assert!(out.text.contains("@github.com/o/r.git"));
    }

    #[test]
    fn contextual_high_entropy_requires_context() {
        // With context → redacted.
        let with_ctx = redact_patterns_only("api_key = 8fj29dKq0zXvB7nR4tLpWs3H");
        assert!(with_ctx.text.contains(REDACTED), "{}", with_ctx.text);

        // Without context → preserved, so ordinary hashes and IDs survive.
        let without = redact_patterns_only("commit 8fj29dKq0zXvB7nR4tLpWs3H");
        assert!(!without.text.contains(REDACTED), "{}", without.text);
    }

    #[test]
    fn low_false_positive_on_normal_source_and_paths() {
        let samples = [
            "import { AgentKernel } from '@cbc/agent-kernel';",
            "src/very/long/path/to/some/module/implementation.test.ts",
            "fn shannon_entropy(s: &str) -> f64 { unimplemented!() }",
            "https://developers.openai.com/api/docs/guides/streaming-responses",
            "8f1c7c2 a12b880 abcdef1234567890abcdef1234567890abcdef12",
            "2026-07-31T10:00:00Z sequence=12 turnId=turn_1",
        ];
        for s in samples {
            let out = redact_patterns_only(s);
            assert!(
                !out.report.redacted(),
                "false positive on {s:?} -> {:?}",
                out.report.kinds
            );
        }
    }

    #[test]
    fn secret_env_names_are_classified() {
        assert!(is_secret_env_name("OPENAI_API_KEY"));
        assert!(is_secret_env_name("GITHUB_TOKEN"));
        assert!(is_secret_env_name("MY_CLIENT_SECRET"));
        assert!(is_secret_env_name("AWS_SECRET_ACCESS_KEY"));
        assert!(!is_secret_env_name("PATH"));
        assert!(!is_secret_env_name("HOME"));
        assert!(!is_secret_env_name("TERM"));
    }

    #[test]
    fn registers_secret_env_values() {
        // RT-005: secret env values must be redacted in displayed output.
        let mut r = Redactor::new();
        r.add_secret_env(
            vec![
                (
                    "MY_SERVICE_TOKEN".to_string(),
                    "tok_live_supersecretvalue".to_string(),
                ),
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ]
            .into_iter(),
        );
        assert_eq!(r.literal_count(), 1);
        let out =
            r.redact("env dump: MY_SERVICE_TOKEN=tok_live_supersecretvalue PATH=/usr/bin:/bin");
        assert!(!out.text.contains("supersecretvalue"));
        assert!(out.text.contains("/usr/bin:/bin"));
    }

    #[test]
    fn overlapping_literals_redact_longest_first() {
        let mut r = Redactor::new();
        r.add_literal("secretvalue");
        r.add_literal("secretvalue-extended-form");
        let out = r.redact("x secretvalue-extended-form y");
        assert_eq!(out.text, format!("x {REDACTED} y"));
    }

    #[test]
    fn entropy_math_is_sane() {
        assert_eq!(shannon_entropy(""), 0.0);
        assert_eq!(shannon_entropy("aaaa"), 0.0);
        assert!(shannon_entropy("abcd") > 1.9);
        assert!(shannon_entropy("8fj29dKq0zXvB7nR4tLpWs3H") > 3.4);
    }

    #[test]
    fn fuzz_redactor_never_panics() {
        let mut r = Redactor::new();
        r.add_literal("known-secret-literal");
        let mut state: u64 = 777;
        for _ in 0..2000 {
            let mut s = String::new();
            for _ in 0..48 {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                let pick = (state >> 28) % 10;
                match pick {
                    0 => s.push_str("://"),
                    1 => s.push_str("-----BEGIN"),
                    2 => s.push_str("PRIVATE KEY-----"),
                    3 => s.push_str("token="),
                    4 => s.push('@'),
                    5 => s.push(':'),
                    6 => s.push_str("sk-"),
                    7 => s.push('한'),
                    8 => s.push_str("eyJ"),
                    _ => s.push('x'),
                }
            }
            let _ = r.redact(&s);
        }
    }
}
