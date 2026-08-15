//! Environment policy — PRD §14.5.
//!
//! Default inherited safe variables: PATH, HOME/USERPROFILE, TMP/TEMP with a
//! validated path, locale, terminal variables for PTY, and safe package-manager
//! cache variables. Default excluded: tokens/keys, cloud credentials, CI
//! secrets, SSH agent socket, browser session variables, and any `*_TOKEN`,
//! `*_SECRET`, `*_KEY`.

use std::collections::{BTreeMap, HashMap};

use cbc_redaction::is_secret_env_name;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EnvPolicy {
    /// Only the bare minimum: PATH, HOME, TMPDIR, locale.
    Minimal,
    /// The §14.5 safe allowlist. This is the default.
    #[default]
    InheritSafe,
    /// Nothing inherited; only values supplied explicitly by the caller.
    Explicit,
}

/// Always-inherited variables (when present) for the `Minimal` policy.
pub const MINIMAL_ALLOWLIST: &[&str] = &["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP"];

/// Additional variables inherited under `InheritSafe`.
pub const SAFE_ALLOWLIST: &[&str] = &[
    // Locale
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LANGUAGE",
    // Terminal (needed for PTY and for tools that colourise output)
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "COLUMNS",
    "LINES",
    "NO_COLOR",
    "FORCE_COLOR",
    // Shell/user identity that tools commonly read
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "OLDPWD",
    // Platform
    "SystemRoot",
    "windir",
    "PATHEXT",
    "COMSPEC",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    // Toolchain discovery
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    // Package-manager caches that are safe and materially speed up builds
    "npm_config_cache",
    "YARN_CACHE_FOLDER",
    "PNPM_HOME",
    "BUN_INSTALL",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "CARGO_TARGET_DIR",
    "GOPATH",
    "GOMODCACHE",
    "GOCACHE",
    "PIP_CACHE_DIR",
    "UV_CACHE_DIR",
    "MAVEN_OPTS",
    "GRADLE_USER_HOME",
    "JAVA_HOME",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "NVM_DIR",
    "ASDF_DIR",
    "VOLTA_HOME",
];

/// Variables that are always excluded even if they appear in an allowlist.
pub const ALWAYS_EXCLUDED: &[&str] = &[
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GPG_AGENT_INFO",
    "AWS_PROFILE",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CLIENT_SECRET",
    "KUBECONFIG",
    "DOCKER_AUTH_CONFIG",
    "NPM_TOKEN",
    "CI_JOB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITLAB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CHROME_SESSION",
    "MOZ_SESSION",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
];

/// Environment names that can inject code or replace executable resolution.
/// These are refused even when explicitly supplied by an approved operation.
pub fn is_executable_control_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("LD_")
        || upper.starts_with("DYLD_")
        || matches!(
            upper.as_str(),
            "BASH_ENV"
                | "ENV"
                | "NODE_OPTIONS"
                | "PYTHONPATH"
                | "PYTHONHOME"
                | "PYTHONSTARTUP"
                | "PYTHONINSPECT"
                | "RUBYOPT"
                | "RUBYLIB"
                | "PERL5OPT"
                | "PERL5LIB"
                | "GIT_CONFIG"
                | "GIT_CONFIG_GLOBAL"
                | "GIT_CONFIG_SYSTEM"
                | "GIT_EXEC_PATH"
                | "GIT_TEMPLATE_DIR"
                | "GIT_SSH_COMMAND"
        )
}

/// Decide whether a variable may be inherited.
pub fn is_inheritable(policy: &EnvPolicy, name: &str) -> bool {
    if is_executable_control_env(name) {
        return false;
    }
    if ALWAYS_EXCLUDED.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        return false;
    }
    // Any secret-shaped name is excluded regardless of policy (§14.5).
    if is_secret_env_name(name) {
        return false;
    }
    match policy {
        EnvPolicy::Explicit => false,
        EnvPolicy::Minimal => allowlisted(MINIMAL_ALLOWLIST, name),
        EnvPolicy::InheritSafe => {
            allowlisted(MINIMAL_ALLOWLIST, name) || allowlisted(SAFE_ALLOWLIST, name)
        }
    }
}

/// Match a name against an allowlist using the platform's own comparison rules.
///
/// Windows environment names are case-insensitive, and the real variable there is
/// spelled `Path`. An exact match would drop it, leaving the child with no way to
/// resolve a program even though §14.5 lists PATH as inherited by default. Unix
/// names are case-sensitive, so exact matching is required there — a lookalike
/// such as `Path` must not satisfy an allowlist entry for `PATH`.
fn allowlisted(list: &[&str], name: &str) -> bool {
    #[cfg(windows)]
    {
        list.iter().any(|n| n.eq_ignore_ascii_case(name))
    }
    #[cfg(not(windows))]
    {
        list.iter().any(|n| *n == name)
    }
}

/// Build the child environment: allowed inherited variables plus explicit
/// overrides. Explicit values always win, because they were requested by an
/// approved operation rather than merely inherited.
pub fn filter_env(
    policy: &EnvPolicy,
    explicit: &HashMap<String, String>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (name, value) in std::env::vars() {
        if is_inheritable(policy, &name) && is_safe_value(&name, &value) {
            out.insert(name, value);
        }
    }
    for (name, value) in explicit {
        // Runtime validation returns a useful error before this point. Keep a
        // second fail-closed guard here for direct library callers.
        if is_executable_control_env(name) {
            continue;
        }
        // A Windows environment block must not carry two spellings of the same
        // name: which one the child sees would be undefined. Since the explicit
        // value was requested by an approved operation, any inherited
        // case-variant is dropped so the override is unambiguous.
        #[cfg(windows)]
        {
            let shadowed: Vec<String> = out
                .keys()
                .filter(|key| key.as_str() != name.as_str() && key.eq_ignore_ascii_case(name))
                .cloned()
                .collect();
            for key in shadowed {
                out.remove(&key);
            }
        }
        out.insert(name.clone(), value.clone());
    }
    out
}

/// Reject inherited values that are structurally unsafe, such as a TMPDIR that
/// does not exist (§14.5 "TMP/TEMP with validated path").
fn is_safe_value(name: &str, value: &str) -> bool {
    if value.contains('\0') {
        return false;
    }
    if matches!(name, "TMPDIR" | "TMP" | "TEMP") {
        return std::path::Path::new(value).is_dir();
    }
    true
}

/// Render a redacted preview of the environment for the approval card and the
/// audit log (§9.8 "shell environment preview").
pub fn preview(env: &BTreeMap<String, String>, redactor: &cbc_redaction::Redactor) -> Vec<String> {
    env.iter()
        .map(|(k, v)| {
            let shown = redactor.redact_text(v);
            let shown = if shown.len() > 64 {
                format!("{}…", &shown[..shown.floor_char_boundary(64)])
            } else {
                shown
            };
            format!("{k}={shown}")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_shaped_names_are_never_inheritable() {
        for name in [
            "MY_TOKEN",
            "SERVICE_SECRET",
            "DB_PASSWORD",
            "OPENAI_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "SOME_PRIVATE_KEY",
        ] {
            assert!(
                !is_inheritable(&EnvPolicy::InheritSafe, name),
                "{name} should be excluded"
            );
            assert!(!is_inheritable(&EnvPolicy::Minimal, name));
        }
    }

    #[test]
    fn ssh_agent_socket_is_excluded() {
        // §14.5: SSH agent socket unless requested.
        assert!(!is_inheritable(&EnvPolicy::InheritSafe, "SSH_AUTH_SOCK"));
    }

    #[test]
    fn preload_variables_are_excluded() {
        // Injecting a shared library would defeat the process boundary.
        assert!(!is_inheritable(&EnvPolicy::InheritSafe, "LD_PRELOAD"));
        assert!(!is_inheritable(
            &EnvPolicy::InheritSafe,
            "DYLD_INSERT_LIBRARIES"
        ));
        assert!(!is_inheritable(&EnvPolicy::InheritSafe, "NODE_OPTIONS"));
        assert!(is_executable_control_env("LD_LIBRARY_PATH"));
        assert!(is_executable_control_env("PYTHONPATH"));
    }

    #[test]
    fn safe_variables_are_inheritable() {
        for name in ["PATH", "HOME", "TERM", "LANG", "CARGO_HOME", "NO_COLOR"] {
            assert!(
                is_inheritable(&EnvPolicy::InheritSafe, name),
                "{name} should be inheritable"
            );
        }
    }

    #[test]
    fn minimal_policy_is_narrower_than_safe() {
        assert!(is_inheritable(&EnvPolicy::Minimal, "PATH"));
        assert!(!is_inheritable(&EnvPolicy::Minimal, "TERM"));
        assert!(is_inheritable(&EnvPolicy::InheritSafe, "TERM"));
    }

    #[test]
    fn explicit_policy_inherits_nothing() {
        for name in ["PATH", "HOME", "TERM"] {
            assert!(!is_inheritable(&EnvPolicy::Explicit, name));
        }
    }

    #[test]
    fn explicit_values_override_inherited() {
        std::env::set_var("CBC_ENV_TEST_PATHLIKE", "inherited");
        let mut explicit = HashMap::new();
        explicit.insert("PATH".to_string(), "/only/this".to_string());
        let env = filter_env(&EnvPolicy::InheritSafe, &explicit);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/only/this"));
        std::env::remove_var("CBC_ENV_TEST_PATHLIKE");
    }

    #[test]
    fn filtered_env_excludes_secret_values() {
        std::env::set_var("CBC_FILTER_TEST_TOKEN", "leaky-value");
        let env = filter_env(&EnvPolicy::InheritSafe, &HashMap::new());
        assert!(!env.values().any(|v| v == "leaky-value"));
        std::env::remove_var("CBC_FILTER_TEST_TOKEN");
    }

    #[test]
    fn invalid_tmpdir_is_dropped() {
        assert!(!is_safe_value("TMPDIR", "/definitely/not/a/real/dir"));
        assert!(is_safe_value(
            "TMPDIR",
            &std::env::temp_dir().to_string_lossy()
        ));
    }

    #[test]
    fn values_with_nul_are_dropped() {
        assert!(!is_safe_value("ANYTHING", "bad\0value"));
    }

    #[test]
    fn preview_redacts_and_truncates() {
        let mut redactor = cbc_redaction::Redactor::new();
        redactor.add_literal("supersecretvalue123");
        let mut env = BTreeMap::new();
        env.insert("TOKENISH".to_string(), "supersecretvalue123".to_string());
        env.insert("LONG".to_string(), "x".repeat(200));
        let lines = preview(&env, &redactor);
        assert!(lines.iter().any(|l| l.contains("***REDACTED***")));
        assert!(lines.iter().all(|l| l.len() < 120));
    }
}
