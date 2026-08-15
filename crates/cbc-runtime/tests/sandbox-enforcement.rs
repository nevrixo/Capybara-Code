//! P0-04 fail-closed enforcement at the RPC layer.
//!
//! These tests disable enforcement backends through process-wide environment
//! overrides, so they run as one sequential test in their own binary: lib
//! tests in the same process would race over the overrides, and a separate
//! binary keeps the override from leaking into any other suite.

use cbc_protocol::{error_codes, RequestId, RpcRequest};
use cbc_runtime::server::{dispatch, RuntimeState};
use serde_json::{json, Value};

const TEST_ISSUER: &str = "tttttttttttttttttttttttttttttttt";

fn successful_command() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let program =
            std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
        (
            program,
            vec!["/D".into(), "/S".into(), "/C".into(), "echo fine".into()],
        )
    }
    #[cfg(unix)]
    {
        ("/bin/sh".to_string(), vec!["-c".into(), "echo fine".into()])
    }
    #[cfg(not(any(windows, unix)))]
    {
        ("true".to_string(), Vec::new())
    }
}

fn request(method: &str, params: Value) -> RpcRequest {
    RpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(RequestId::Number(1)),
        method: method.to_string(),
        params: Some(params),
    }
}

fn issue_capability(
    state: &RuntimeState,
    operation: &str,
    program: &str,
    args: &[String],
    network: &str,
) -> String {
    let value = dispatch(
        state,
        &request(
            "runtime.capability.issue",
            json!({
                "issuerToken": TEST_ISSUER,
                "sessionId": "sandbox-test-session",
                "callId": "sandbox-test-call",
                "actionHash": "sandbox-test-action",
                "operation": operation,
                "program": program,
                "args": args,
                "cwd": ".",
                "resources": ["env:sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
                "network": network,
            }),
        ),
    )
    .expect("capability dispatched")
    .expect("capability issued");
    value["id"].as_str().expect("capability id").to_string()
}

fn initialize(
    state: &RuntimeState,
    workspace: &std::path::Path,
    data: &std::path::Path,
    sandbox_level: &str,
) -> Value {
    dispatch(
        state,
        &request(
            "runtime.initialize",
            json!({
                "protocolVersion": "1.0",
                "clientVersion": "test",
                "workspace": workspace.to_string_lossy(),
                "dataDir": data.to_string_lossy(),
                "sandboxLevel": sandbox_level,
                "capabilityIssuerToken": TEST_ISSUER,
            }),
        ),
    )
    .expect("initialize dispatched")
    .expect("initialize succeeds")
}

#[test]
fn enforcement_failures_report_dedicated_error_codes() {
    let dir = tempfile::TempDir::new().unwrap();
    let workspace = dir.path().join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let data = dir.path().join("data");

    // 1. Strict requested, landlock disabled: capabilities clamp honestly
    //    (RT-006 downgrade), and the spawn then runs at the effective level
    //    rather than under a sandbox that cannot exist.
    //    Network is explicitly allowed here so this assertion isolates the
    //    sandbox-level clamp from the separate fail-closed network check below.
    std::env::set_var("CBC_TEST_DISABLE_LANDLOCK", "1");
    let state = RuntimeState::new();
    let result = initialize(&state, &workspace, &data, "strict");
    let caps = &result["capabilities"];
    assert_eq!(caps["sandboxLevel"], "standard", "{caps}");
    assert_eq!(caps["enhancedSandbox"], false, "{caps}");
    let backends = caps["sandboxBackends"].as_array().expect("array");
    assert!(
        backends.iter().all(|b| b.as_str() != Some("landlock")),
        "disabled backends must not be reported: {caps}"
    );

    dispatch(
        &state,
        &request(
            "workspace.trust.write",
            json!({ "state": "trusted-always" }),
        ),
    )
    .expect("trust.write dispatched")
    .expect("trust.write succeeds");

    let (program, args) = successful_command();
    let receipt = issue_capability(&state, "process.run", &program, &args, "allow");
    let outcome = dispatch(
        &state,
        &request(
            "process.run",
            json!({ "program": program, "args": args, "cwd": ".", "timeoutMs": 5000, "capabilitySessionId": "sandbox-test-session", "capabilityActionHash": "sandbox-test-action", "capabilityReceipt": receipt }),
        ),
    )
    .expect("process.run dispatched");
    let value = outcome.expect("a spawn at the clamped level succeeds");
    assert_eq!(value["exitCode"], 0, "{value}");
    drop(state);

    // 2. Network deny with every network backend disabled: NETWORK_DENIED.
    std::env::set_var("CBC_TEST_DISABLE_NETNS", "1");
    std::env::set_var("CBC_TEST_DISABLE_SECCOMP", "1");
    let state = RuntimeState::new();
    initialize(&state, &workspace, &data, "standard");
    dispatch(
        &state,
        &request(
            "workspace.trust.write",
            json!({ "state": "trusted-always" }),
        ),
    )
    .expect("trust.write dispatched")
    .expect("trust.write succeeds");
    let (program, args) = successful_command();
    let receipt = issue_capability(&state, "process.run", &program, &args, "deny");
    let outcome = dispatch(
        &state,
        &request(
            "process.run",
            json!({ "program": program, "args": args, "cwd": ".", "network": "deny", "timeoutMs": 5000, "capabilitySessionId": "sandbox-test-session", "capabilityActionHash": "sandbox-test-action", "capabilityReceipt": receipt }),
        ),
    )
    .expect("process.run dispatched");
    let err = outcome.expect_err("network deny without a backend must refuse");
    assert_eq!(err.code, error_codes::NETWORK_DENIED, "{err:?}");
    drop(state);

    std::env::remove_var("CBC_TEST_DISABLE_LANDLOCK");
    std::env::remove_var("CBC_TEST_DISABLE_NETNS");
    std::env::remove_var("CBC_TEST_DISABLE_SECCOMP");
}
