//! P0-04 fail-closed refusal: when an isolation backend is unavailable, a
//! spawn that demands it must be refused with the dedicated error, never run
//! unenforced.
//!
//! This lives in its own test binary and runs as one sequential test because
//! the disable overrides are process-wide environment variables; parallel
//! tests in one process would race over them.

use cbc_process::{
    CancelToken, NetworkMode, ProcessError, ProcessSpec, ProcessSupervisor, SandboxPolicy,
};

fn tempdir_cwd() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

#[cfg(unix)]
fn shell_spec(script: &str) -> ProcessSpec {
    ProcessSpec::new("/bin/sh", vec!["-c".into(), script.into()], tempdir_cwd())
}

#[cfg(windows)]
fn shell_spec(script: &str) -> ProcessSpec {
    let program =
        std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
    ProcessSpec::new(
        program,
        vec!["/D".into(), "/S".into(), "/C".into(), script.into()],
        tempdir_cwd(),
    )
}

#[test]
fn isolation_is_refused_when_no_backend_exists() {
    // Network deny: refused with the dedicated error. Both backends must be
    // disabled for the host to count as having none.
    std::env::set_var("CBC_TEST_DISABLE_NETNS", "1");
    std::env::set_var("CBC_TEST_DISABLE_SECCOMP", "1");
    let sup = ProcessSupervisor::default();
    let mut spec = shell_spec("echo fine");
    spec.network = NetworkMode::Deny;
    let err = sup.start(spec, CancelToken::new()).unwrap_err();
    match err {
        ProcessError::NetworkDenied { message } => {
            assert!(message.contains("network"), "{message}");
        }
        other => panic!("expected NetworkDenied, got: {other:?}"),
    }

    // Filesystem allowlist: refused with the dedicated error.
    std::env::set_var("CBC_TEST_DISABLE_LANDLOCK", "1");
    let mut spec = shell_spec("echo fine");
    spec.sandbox = Some(SandboxPolicy {
        writable_roots: vec![tempdir_cwd()],
        readable_roots: vec!["/usr".to_string()],
    });
    let err = sup.start(spec, CancelToken::new()).unwrap_err();
    match err {
        ProcessError::SandboxUnavailable { message } => {
            assert!(message.contains("filesystem"), "{message}");
        }
        other => panic!("expected SandboxUnavailable, got: {other:?}"),
    }

    // The overrides only gate enforcement; a spec that asks for nothing must
    // still run, so a degraded host keeps its ordinary process support.
    let spec = shell_spec("echo fine");
    let outcome = sup.run(spec, CancelToken::new()).unwrap();
    assert!(outcome.succeeded(), "{outcome:?}");
    assert!(outcome.stdout.contains("fine"));

    std::env::remove_var("CBC_TEST_DISABLE_NETNS");
    std::env::remove_var("CBC_TEST_DISABLE_SECCOMP");
    std::env::remove_var("CBC_TEST_DISABLE_LANDLOCK");
}
