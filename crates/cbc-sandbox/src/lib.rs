//! `cbc-sandbox` — sandbox capability detection — PRD §14.4, §24.5, RT-006.
//!
//! ```text
//! none      path guard and approval only
//! standard  process env filtering + workspace write boundary + resource limits
//! strict    OS isolation backend + network deny + explicit filesystem allowlist
//! ```
//!
//! §24.5 forbids overclaiming: the `workspace` guard must not be presented as a
//! "secure sandbox", and RT-006 requires an explicit downgrade notice when a
//! requested strict sandbox is unavailable. This module therefore reports only
//! capabilities it has actually probed.

use serde::{Deserialize, Serialize};

pub mod enforce;

pub use enforce::{
    filesystem_isolation_available, network_deny_available, probe as probe_enforcement, FsRule,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxLevel {
    None,
    Standard,
    Strict,
}

impl SandboxLevel {
    pub fn label(&self) -> &'static str {
        match self {
            SandboxLevel::None => "none",
            SandboxLevel::Standard => "standard",
            SandboxLevel::Strict => "strict",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "none" => Some(SandboxLevel::None),
            // `workspace` is the config spelling in §21.4 for the default level.
            "standard" | "workspace" => Some(SandboxLevel::Standard),
            "strict" => Some(SandboxLevel::Strict),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxBackend {
    Landlock,
    Seccomp,
    NetworkNamespace,
    CgroupV2,
    Rlimit,
    Seatbelt,
    JobObject,
    RestrictedToken,
}

impl SandboxBackend {
    pub fn label(&self) -> &'static str {
        match self {
            SandboxBackend::Landlock => "landlock",
            SandboxBackend::Seccomp => "seccomp",
            SandboxBackend::NetworkNamespace => "network-namespace",
            SandboxBackend::CgroupV2 => "cgroup-v2",
            SandboxBackend::Rlimit => "rlimit",
            SandboxBackend::Seatbelt => "seatbelt",
            SandboxBackend::JobObject => "job-object",
            SandboxBackend::RestrictedToken => "restricted-token",
        }
    }
}

/// The honest, probed capability report shown by `cbc doctor` and the status bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCapabilities {
    /// The highest level this host can actually enforce.
    pub available_level: SandboxLevel,
    pub backends: Vec<String>,
    /// Whether `strict` was requested but cannot be honoured.
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degrade_reason: Option<String>,
    pub platform: String,
    /// Human-readable guard description for §24.5's status block.
    pub guard: String,
}

impl SandboxCapabilities {
    /// §24.5 status block:
    /// ```text
    /// Guard: workspace
    /// Sandbox: enhanced available / unavailable
    /// Network: ask
    /// Project: trusted / read-only / untrusted
    /// ```
    pub fn status_lines(&self, network_policy: &str, project_trust: &str) -> Vec<String> {
        vec![
            format!("Guard: {}", self.guard),
            format!(
                "Sandbox: {}",
                if self.available_level >= SandboxLevel::Strict {
                    "enhanced available"
                } else {
                    "unavailable"
                }
            ),
            format!("Network: {network_policy}"),
            format!("Project: {project_trust}"),
        ]
    }

    pub fn enhanced_available(&self) -> bool {
        self.available_level >= SandboxLevel::Strict
    }
}

/// Probe the host for real sandbox capabilities.
///
/// §24.5: every backend listed here is verified by actually exercising the
/// mechanism (`enforce::probe`), never by reading a file that claims it exists.
/// A backend that is merely present in the kernel but cannot be applied by this
/// process is not reported, so diagnostics and the status bar never overclaim.
pub fn detect(requested: SandboxLevel) -> SandboxCapabilities {
    #[allow(unused_mut)]
    let mut backends: Vec<SandboxBackend> = Vec::new();
    let platform = std::env::consts::OS.to_string();

    #[cfg(target_os = "linux")]
    {
        // Landlock: verified by calling the ruleset-version syscall, which is
        // the same entry point enforcement uses (`apply_landlock`).
        if enforce::filesystem_isolation_available() {
            backends.push(SandboxBackend::Landlock);
        }
        // Network deny: verified by exercising the real mechanism — a forked
        // child runs `unshare(CLONE_NEWNET)` or installs the seccomp filter,
        // exactly what a denied spawn will do.
        match enforce::network_deny_backend() {
            enforce::NetworkDenyBackend::Netns => {
                backends.push(SandboxBackend::NetworkNamespace);
            }
            enforce::NetworkDenyBackend::Seccomp => {
                backends.push(SandboxBackend::Seccomp);
            }
            enforce::NetworkDenyBackend::Unavailable => {}
        }
        backends.push(SandboxBackend::Rlimit);
    }

    #[cfg(target_os = "macos")]
    {
        // Seatbelt detection is presence-only for now; until the backend is
        // applied at launch (§14.4), §24.5 forbids reporting it as available.
        backends.push(SandboxBackend::Rlimit);
    }

    #[cfg(target_os = "windows")]
    {
        // Job Object enforcement is not yet applied at launch, so §24.5 keeps
        // the report at the honest floor instead of listing it.
    }

    // Strict requires a real filesystem-restriction backend plus a way to deny
    // network access. Anything less is `standard`.
    let has_fs_isolation = backends
        .iter()
        .any(|b| matches!(b, SandboxBackend::Landlock | SandboxBackend::Seatbelt));
    let has_network_deny = backends.iter().any(|b| {
        matches!(
            b,
            SandboxBackend::NetworkNamespace | SandboxBackend::Seatbelt | SandboxBackend::Seccomp
        )
    });

    let available_level = if has_fs_isolation && has_network_deny {
        SandboxLevel::Strict
    } else {
        SandboxLevel::Standard
    };

    let degraded = requested > available_level;
    let degrade_reason = if degraded {
        Some(match (has_fs_isolation, has_network_deny) {
            (false, false) => {
                "no OS filesystem-isolation or network-deny backend is available on this host"
                    .to_string()
            }
            (true, false) => "no network-deny backend is available on this host".to_string(),
            (false, true) => {
                "no OS filesystem-isolation backend is available on this host".to_string()
            }
            (true, true) => "requested level exceeds the detected capability".to_string(),
        })
    } else {
        None
    };

    // §24.5: never call the workspace guard a secure sandbox.
    let guard = match available_level {
        SandboxLevel::None => "path guard only".to_string(),
        SandboxLevel::Standard => "workspace".to_string(),
        SandboxLevel::Strict => "workspace + OS isolation".to_string(),
    };

    SandboxCapabilities {
        available_level,
        backends: backends.iter().map(|b| b.label().to_string()).collect(),
        degraded,
        degrade_reason,
        platform,
        guard,
    }
}

/// Effective level after clamping a request to what the host can do (RT-006).
pub fn effective_level(requested: SandboxLevel, caps: &SandboxCapabilities) -> SandboxLevel {
    requested.min(caps.available_level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config_level_spellings() {
        assert_eq!(SandboxLevel::parse("none"), Some(SandboxLevel::None));
        assert_eq!(
            SandboxLevel::parse("standard"),
            Some(SandboxLevel::Standard)
        );
        // §21.4 uses `level = "workspace"` for the default.
        assert_eq!(
            SandboxLevel::parse("workspace"),
            Some(SandboxLevel::Standard)
        );
        assert_eq!(SandboxLevel::parse("STRICT"), Some(SandboxLevel::Strict));
        assert_eq!(SandboxLevel::parse("bogus"), None);
    }

    #[test]
    fn levels_are_ordered() {
        assert!(SandboxLevel::None < SandboxLevel::Standard);
        assert!(SandboxLevel::Standard < SandboxLevel::Strict);
    }

    #[test]
    fn detection_reports_at_least_standard() {
        // §14.4: "Default is `standard`".
        let caps = detect(SandboxLevel::Standard);
        assert!(caps.available_level >= SandboxLevel::Standard);
        assert!(
            !caps.degraded,
            "standard should not be reported as degraded"
        );
        assert_eq!(caps.platform, std::env::consts::OS);
    }

    #[test]
    fn rt006_strict_request_reports_downgrade_when_unavailable() {
        let caps = detect(SandboxLevel::Strict);
        if caps.available_level < SandboxLevel::Strict {
            assert!(caps.degraded, "downgrade must be flagged");
            assert!(
                caps.degrade_reason.is_some(),
                "a downgrade must carry an explicit reason"
            );
            assert_eq!(
                effective_level(SandboxLevel::Strict, &caps),
                caps.available_level
            );
        } else {
            assert!(!caps.degraded);
        }
    }

    #[test]
    fn guard_label_never_overclaims() {
        // §24.5: the workspace guard must not be described as a secure sandbox.
        for requested in [
            SandboxLevel::None,
            SandboxLevel::Standard,
            SandboxLevel::Strict,
        ] {
            let caps = detect(requested);
            let guard = caps.guard.to_lowercase();
            assert!(
                !guard.contains("secure sandbox"),
                "guard overclaims: {}",
                caps.guard
            );
        }
    }

    #[test]
    fn status_lines_match_prd_block() {
        let caps = detect(SandboxLevel::Standard);
        let lines = caps.status_lines("ask", "trusted");
        assert_eq!(lines.len(), 4);
        assert!(lines[0].starts_with("Guard: "));
        assert!(lines[1].starts_with("Sandbox: "));
        assert_eq!(lines[2], "Network: ask");
        assert_eq!(lines[3], "Project: trusted");
        // The sandbox line must be exactly one of the two documented phrases.
        assert!(
            lines[1] == "Sandbox: enhanced available" || lines[1] == "Sandbox: unavailable",
            "unexpected sandbox line: {}",
            lines[1]
        );
    }

    #[test]
    fn effective_level_clamps_down_never_up() {
        let caps = SandboxCapabilities {
            available_level: SandboxLevel::Standard,
            backends: vec![],
            degraded: false,
            degrade_reason: None,
            platform: "linux".into(),
            guard: "workspace".into(),
        };
        assert_eq!(
            effective_level(SandboxLevel::Strict, &caps),
            SandboxLevel::Standard
        );
        assert_eq!(
            effective_level(SandboxLevel::None, &caps),
            SandboxLevel::None
        );
    }

    #[test]
    fn backends_are_reported_as_stable_labels() {
        let caps = detect(SandboxLevel::Standard);
        for backend in &caps.backends {
            assert!(
                backend.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "backend label not stable: {backend}"
            );
        }
    }

    #[test]
    fn capabilities_serialize_camel_case() {
        let caps = detect(SandboxLevel::Strict);
        let json = serde_json::to_value(&caps).unwrap();
        assert!(json.get("availableLevel").is_some());
        assert!(json.get("degraded").is_some());
    }
}
