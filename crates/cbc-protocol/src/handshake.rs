//! Handshake contract — PRD §20.2.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    pub client_version: String,
    pub workspace: String,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
    /// Optional override for the durable data directory. Used by tests and by
    /// `CAPYBARA_DATA_DIR` (§21.1).
    #[serde(default)]
    pub data_dir: Option<String>,
    /// Requested sandbox level from configuration (`sandbox.level`). The
    /// runtime clamps it to what the host can actually enforce (RT-006) and
    /// reports the effective level in its capabilities — P0-04: enforcement
    /// lives in the runtime, never in the control plane.
    /// `none` | `workspace` | `standard` | `strict`; absent means `standard`.
    #[serde(default)]
    pub sandbox_level: Option<String>,
    /// `sandbox.networkForShell`: what a raw shell (`shell.run`) may do with
    /// the network. `deny` | `ask` | `allow`; absent means `ask`, which leaves
    /// the per-call network decision to the approval flow.
    #[serde(default)]
    pub network_for_shell: Option<String>,
    /// Interaction ceiling: `plan` is read-only even when the TypeScript policy
    /// or saved approval rules are permissive.
    /// Initial runtime enforcement mode. The runtime validates the value and
    /// revalidates every later transition through `workspace.mode.write`.
    #[serde(default)]
    pub interaction_mode: Option<String>,
    /// Secret carried only by the verified TypeScript control plane. The runtime
    /// requires it before issuing an action-bound capability receipt.
    #[serde(default)]
    pub capability_issuer_token: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    pub pty: bool,
    #[serde(default)]
    pub event_journal: bool,
    #[serde(default)]
    pub credential_lease: bool,
    #[serde(default)]
    pub artifact_handles: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub runtime_version: String,
    pub workspace_id: String,
    pub capabilities: RuntimeCapabilities,
}

/// Reported capabilities. §24.5 requires the UI to state the real guard level
/// rather than overclaiming a sandbox, so these fields are literal facts about
/// the host, never aspirational defaults.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub enhanced_sandbox: bool,
    /// `os-native` | `encrypted-file` | `session-only` | `unavailable`
    pub keychain: String,
    pub pty: bool,
    pub git: bool,
    /// `none` | `standard` | `strict` (§14.4)
    pub sandbox_level: String,
    pub sandbox_backends: Vec<String>,
    pub platform: String,
    pub arch: String,
    pub max_frame_bytes: usize,
    pub artifact_store: bool,
    pub event_journal: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_prd_example_handshake() {
        let raw = r#"{
            "protocolVersion": "1.0",
            "clientVersion": "0.1.0",
            "workspace": "/abs/project",
            "capabilities": {
                "pty": true,
                "eventJournal": true,
                "credentialLease": true,
                "artifactHandles": true
            }
        }"#;
        let params: InitializeParams = serde_json::from_str(raw).expect("parse");
        assert_eq!(params.protocol_version, "1.0");
        assert_eq!(params.workspace, "/abs/project");
        assert!(params.capabilities.pty);
        assert!(params.capabilities.artifact_handles);
    }

    #[test]
    fn missing_capabilities_default_to_false() {
        let params: InitializeParams = serde_json::from_str(
            r#"{"protocolVersion":"1.0","clientVersion":"0.1.0","workspace":"/w"}"#,
        )
        .expect("parse");
        assert!(!params.capabilities.pty);
        assert!(!params.capabilities.event_journal);
    }

    #[test]
    fn interaction_mode_round_trips_from_initialize_params() {
        let params: InitializeParams = serde_json::from_str(
            r#"{"protocolVersion":"1.0","clientVersion":"test","workspace":"/w","interactionMode":"plan"}"#,
        )
        .expect("parse");
        assert_eq!(params.interaction_mode.as_deref(), Some("plan"));
    }

    #[test]
    fn result_serializes_camel_case() {
        let result = InitializeResult {
            protocol_version: "1.0".into(),
            runtime_version: "0.1.0".into(),
            workspace_id: "ws_01".into(),
            capabilities: RuntimeCapabilities {
                enhanced_sandbox: false,
                keychain: "os-native".into(),
                pty: true,
                git: true,
                sandbox_level: "standard".into(),
                sandbox_backends: vec![],
                platform: "linux".into(),
                arch: "x86_64".into(),
                max_frame_bytes: 8 * 1024 * 1024,
                artifact_store: true,
                event_journal: true,
            },
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["protocolVersion"], "1.0");
        assert_eq!(json["workspaceId"], "ws_01");
        assert_eq!(json["capabilities"]["enhancedSandbox"], false);
        assert_eq!(json["capabilities"]["sandboxLevel"], "standard");
    }
}
