use cbc_session_store::{
    new_manifest, PluginCircuitState, PluginCircuitTransition, PluginGrantInput,
    PluginInstallScope, PluginInstallationInput, PluginInstanceStart, PluginInstanceState,
    PluginInstanceTransition, PluginInvocationFinish, PluginInvocationStart, PluginInvocationState,
    PluginPermissionSet, PluginRuntimeKind, PluginStateScope, PluginStateWrite, SessionStore,
    StoreError, MAX_PLUGIN_STATE_BYTES,
};
use serde_json::json;

const T0: &str = "2026-08-25T00:00:00.000Z";
const T1: &str = "2026-08-25T00:00:01.000Z";
const T2: &str = "2026-08-25T00:00:02.000Z";

fn seeded_store() -> SessionStore {
    let store = SessionStore::open_in_memory().expect("open store");
    store
        .create_session(&new_manifest(
            "ses_plugin",
            "/work",
            "workspace-fingerprint",
            "plugin test",
            "auto",
            "auto-review",
        ))
        .expect("create session");
    store
}

fn requested_permissions() -> PluginPermissionSet {
    PluginPermissionSet {
        events: vec!["after.tool".into()],
        workspace_read: vec!["src".into()],
        session_state: vec!["read".into()],
        ..PluginPermissionSet::default()
    }
}

fn installation(
    id: &str,
    runtime_kind: PluginRuntimeKind,
    scope: PluginInstallScope,
    requested_permissions: PluginPermissionSet,
) -> PluginInstallationInput {
    PluginInstallationInput {
        id: id.into(),
        plugin_id: "acme/example".into(),
        version: "1.0.0".into(),
        source: "registry".into(),
        package_digest: format!("sha256:{}", "a".repeat(64)),
        manifest_digest: format!("sha256:{}", "b".repeat(64)),
        signature: None,
        runtime_kind,
        scope,
        requested_permissions,
        manifest: json!({ "schemaVersion": "1.0", "runtime": "wasi" }),
        installed_at: T0.into(),
    }
}

#[test]
fn installations_start_disabled_and_project_stdio_is_rejected() {
    let mut store = seeded_store();
    let input = installation(
        "plg_example",
        PluginRuntimeKind::Wasi,
        PluginInstallScope::Project,
        requested_permissions(),
    );

    let installed = store.install_plugin(&input).expect("install declaration");
    assert!(!installed.enabled, "a declaration cannot start a plugin");
    assert_eq!(
        store
            .plugin_installation("plg_example")
            .expect("read installation"),
        Some(installed.clone())
    );
    assert_eq!(
        store.install_plugin(&input).expect("idempotent install"),
        installed
    );

    let rejected = store
        .install_plugin(&installation(
            "plg_stdio",
            PluginRuntimeKind::Stdio,
            PluginInstallScope::Project,
            PluginPermissionSet::default(),
        ))
        .expect_err("project configuration cannot choose an executable runtime");
    assert!(matches!(rejected, StoreError::InvalidPlugin { .. }));
}

#[test]
fn grants_are_workspace_bound_and_cannot_widen_requested_authority() {
    let mut store = seeded_store();
    store
        .install_plugin(&installation(
            "plg_grants",
            PluginRuntimeKind::Wasi,
            PluginInstallScope::Project,
            requested_permissions(),
        ))
        .expect("install declaration");

    let widened = PluginGrantInput {
        id: "pgr_widened".into(),
        installation_id: "plg_grants".into(),
        workspace_identity_digest: Some("workspace-fingerprint".into()),
        permissions: PluginPermissionSet {
            workspace_write: vec!["src".into()],
            ..PluginPermissionSet::default()
        },
        granted_by: "user".into(),
        granted_at: T1.into(),
    };
    let rejected = store
        .grant_plugin(&widened)
        .expect_err("grant must be a subset of the verified request");
    assert!(matches!(rejected, StoreError::InvalidPlugin { .. }));

    let narrowed = PluginGrantInput {
        id: "pgr_narrowed".into(),
        installation_id: "plg_grants".into(),
        workspace_identity_digest: Some("workspace-fingerprint".into()),
        permissions: PluginPermissionSet {
            workspace_read: vec!["src".into()],
            ..PluginPermissionSet::default()
        },
        granted_by: "user".into(),
        granted_at: T1.into(),
    };
    let grant = store.grant_plugin(&narrowed).expect("narrowing grant");
    assert_eq!(
        store
            .grant_plugin(&narrowed)
            .expect("idempotent grant replay"),
        grant
    );

    let revoked = store
        .revoke_plugin_grant("pgr_narrowed", T2)
        .expect("revoke grant");
    assert_eq!(revoked.revoked_at.as_deref(), Some(T2));
    assert_eq!(
        store
            .revoke_plugin_grant("pgr_narrowed", T1)
            .expect("revoke replay"),
        revoked
    );
}

#[test]
fn plugin_state_is_scoped_bounded_and_compare_and_swap_fenced() {
    let mut store = seeded_store();
    store
        .install_plugin(&installation(
            "plg_state",
            PluginRuntimeKind::Wasi,
            PluginInstallScope::User,
            PluginPermissionSet::default(),
        ))
        .expect("install declaration");

    let first_write = PluginStateWrite {
        installation_id: "plg_state".into(),
        scope: PluginStateScope::Global,
        workspace_identity_digest: None,
        session_id: None,
        key: "settings".into(),
        value: json!({ "level": 1 }),
        expected_revision: None,
        at: T0.into(),
    };
    let first = store
        .put_plugin_state(&first_write)
        .expect("create global state");
    assert_eq!(first.revision, 1);

    let mut stale = first_write.clone();
    stale.value = json!({ "level": 2 });
    stale.expected_revision = Some(2);
    stale.at = T1.into();
    let conflict = store
        .put_plugin_state(&stale)
        .expect_err("wrong revision must not overwrite state");
    assert!(matches!(
        conflict,
        StoreError::PluginStateRevisionConflict {
            expected: 2,
            actual: Some(1),
            ..
        }
    ));

    let mut update = stale;
    update.expected_revision = Some(1);
    let updated = store
        .put_plugin_state(&update)
        .expect("compare-and-swap update");
    assert_eq!(updated.revision, 2);
    assert_eq!(
        store
            .plugin_state(
                "plg_state",
                PluginStateScope::Global,
                None,
                None,
                "settings",
            )
            .expect("read state")
            .expect("stored state")
            .value,
        json!({ "level": 2 })
    );

    let workspace = PluginStateWrite {
        installation_id: "plg_state".into(),
        scope: PluginStateScope::Workspace,
        workspace_identity_digest: Some("workspace-fingerprint".into()),
        session_id: None,
        key: "workspace-settings".into(),
        value: json!({ "enabled": true }),
        expected_revision: None,
        at: T1.into(),
    };
    assert_eq!(
        store
            .put_plugin_state(&workspace)
            .expect("workspace state")
            .revision,
        1
    );

    let oversized = PluginStateWrite {
        installation_id: "plg_state".into(),
        scope: PluginStateScope::Global,
        workspace_identity_digest: None,
        session_id: None,
        key: "oversized".into(),
        value: json!("x".repeat(MAX_PLUGIN_STATE_BYTES)),
        expected_revision: None,
        at: T2.into(),
    };
    let rejected = store
        .put_plugin_state(&oversized)
        .expect_err("state size is bounded before persistence");
    assert!(matches!(rejected, StoreError::InvalidPlugin { .. }));
}

fn instance(id: &str) -> PluginInstanceStart {
    PluginInstanceStart {
        id: id.into(),
        installation_id: "plg_instance".into(),
        workspace_identity_digest: "workspace-fingerprint".into(),
        worktree_id: None,
        session_id: Some("ses_plugin".into()),
        pid: Some(42),
        started_at: T0.into(),
    }
}

#[test]
fn plugin_instances_are_workspace_bound_and_lifecycle_fenced() {
    let mut store = seeded_store();
    store
        .install_plugin(&installation(
            "plg_instance",
            PluginRuntimeKind::Wasi,
            PluginInstallScope::Project,
            PluginPermissionSet::default(),
        ))
        .expect("install declaration");

    let input = instance("pni_example");
    assert!(matches!(
        store.start_plugin_instance(&input),
        Err(StoreError::InvalidPlugin { .. })
    ));
    store
        .grant_plugin(&PluginGrantInput {
            id: "pgr_instance".into(),
            installation_id: "plg_instance".into(),
            workspace_identity_digest: Some("workspace-fingerprint".into()),
            permissions: PluginPermissionSet::default(),
            granted_by: "user".into(),
            granted_at: T0.into(),
        })
        .expect("grant workspace authority");
    store
        .set_plugin_enabled("plg_instance", true, T0)
        .expect("enable declaration");

    let starting = store
        .start_plugin_instance(&input)
        .expect("persist starting instance");
    assert_eq!(starting.state, PluginInstanceState::Starting);
    assert_eq!(starting.heartbeat_at.as_deref(), Some(T0));
    assert_eq!(
        store
            .start_plugin_instance(&input)
            .expect("idempotent start replay"),
        starting
    );

    let ready = store
        .transition_plugin_instance(
            "pni_example",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Starting,
                state: PluginInstanceState::Ready,
                at: T1.into(),
            },
        )
        .expect("mark ready");
    assert_eq!(ready.state, PluginInstanceState::Ready);

    let degraded = store
        .transition_plugin_instance(
            "pni_example",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Ready,
                state: PluginInstanceState::Degraded,
                at: T2.into(),
            },
        )
        .expect("mark degraded");
    assert_eq!(degraded.heartbeat_at.as_deref(), Some(T2));

    let stopped = store
        .transition_plugin_instance(
            "pni_example",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Degraded,
                state: PluginInstanceState::Stopped,
                at: T2.into(),
            },
        )
        .expect("mark stopped");
    assert_eq!(stopped.stopped_at.as_deref(), Some(T2));
    assert!(matches!(
        store.heartbeat_plugin_instance("pni_example", T2),
        Err(StoreError::InvalidPlugin { .. })
    ));
    assert!(matches!(
        store.transition_plugin_instance(
            "pni_example",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Ready,
                state: PluginInstanceState::Degraded,
                at: T2.into(),
            },
        ),
        Err(StoreError::InvalidPlugin { .. })
    ));
}

#[test]
fn plugin_circuit_is_generation_fenced_and_recovers_durably() {
    let mut store = seeded_store();
    store
        .install_plugin(&installation(
            "plg_instance",
            PluginRuntimeKind::Wasi,
            PluginInstallScope::Project,
            PluginPermissionSet::default(),
        ))
        .expect("install declaration");
    store
        .grant_plugin(&PluginGrantInput {
            id: "pgr_circuit".into(),
            installation_id: "plg_instance".into(),
            workspace_identity_digest: Some("workspace-fingerprint".into()),
            permissions: PluginPermissionSet::default(),
            granted_by: "user".into(),
            granted_at: T0.into(),
        })
        .expect("grant workspace authority");
    store
        .set_plugin_enabled("plg_instance", true, T0)
        .expect("enable declaration");
    store
        .start_plugin_instance(&instance("pni_circuit"))
        .expect("persist starting instance");
    store
        .transition_plugin_instance(
            "pni_circuit",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Starting,
                state: PluginInstanceState::Ready,
                at: T1.into(),
            },
        )
        .expect("mark instance ready");

    let opened = store
        .transition_plugin_circuit(
            "pni_circuit",
            &PluginCircuitTransition {
                expected_generation: 0,
                state: PluginCircuitState::Open,
                failure_count: 1,
                last_failure_at: Some(T1.into()),
                opened_at: Some(T1.into()),
                retry_at: Some(T2.into()),
                at: T1.into(),
            },
        )
        .expect("open circuit after a failure");
    assert_eq!(opened.state, PluginInstanceState::Degraded);
    assert_eq!(opened.circuit_state, PluginCircuitState::Open);
    assert_eq!(opened.circuit_generation, 1);
    assert_eq!(opened.circuit_retry_at.as_deref(), Some(T2));
    assert!(matches!(
        store.transition_plugin_instance(
            "pni_circuit",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Degraded,
                state: PluginInstanceState::Ready,
                at: T1.into(),
            },
        ),
        Err(StoreError::InvalidPlugin { .. })
    ));
    assert!(matches!(
        store.transition_plugin_circuit(
            "pni_circuit",
            &PluginCircuitTransition {
                expected_generation: 0,
                state: PluginCircuitState::HalfOpen,
                failure_count: 1,
                last_failure_at: Some(T1.into()),
                opened_at: Some(T1.into()),
                retry_at: Some(T2.into()),
                at: T2.into(),
            },
        ),
        Err(StoreError::InvalidPlugin { .. })
    ));

    let half_open = store
        .transition_plugin_circuit(
            "pni_circuit",
            &PluginCircuitTransition {
                expected_generation: 1,
                state: PluginCircuitState::HalfOpen,
                failure_count: 1,
                last_failure_at: Some(T1.into()),
                opened_at: Some(T1.into()),
                retry_at: Some(T2.into()),
                at: T2.into(),
            },
        )
        .expect("admit one recovery probe");
    assert_eq!(half_open.circuit_state, PluginCircuitState::HalfOpen);
    assert_eq!(half_open.circuit_generation, 1);

    let recovered = store
        .transition_plugin_circuit(
            "pni_circuit",
            &PluginCircuitTransition {
                expected_generation: 1,
                state: PluginCircuitState::Closed,
                failure_count: 0,
                last_failure_at: None,
                opened_at: None,
                retry_at: None,
                at: T2.into(),
            },
        )
        .expect("close circuit after a successful probe");
    assert_eq!(recovered.state, PluginInstanceState::Ready);
    assert_eq!(recovered.circuit_state, PluginCircuitState::Closed);
    assert_eq!(recovered.circuit_generation, 1);
    assert_eq!(recovered.failure_count, 0);
    assert_eq!(recovered.last_failure_at, None);
    assert_eq!(
        store
            .plugin_instance("pni_circuit")
            .expect("reload circuit record"),
        Some(recovered)
    );
}

#[test]
fn plugin_invocations_are_durable_and_terminally_fenced() {
    let mut store = seeded_store();
    store
        .install_plugin(&installation(
            "plg_instance",
            PluginRuntimeKind::Wasi,
            PluginInstallScope::Project,
            PluginPermissionSet::default(),
        ))
        .expect("install declaration");
    store
        .grant_plugin(&PluginGrantInput {
            id: "pgr_invocation".into(),
            installation_id: "plg_instance".into(),
            workspace_identity_digest: Some("workspace-fingerprint".into()),
            permissions: PluginPermissionSet::default(),
            granted_by: "user".into(),
            granted_at: T0.into(),
        })
        .expect("grant workspace authority");
    store
        .set_plugin_enabled("plg_instance", true, T0)
        .expect("enable declaration");
    store
        .start_plugin_instance(&instance("pni_invocation"))
        .expect("persist starting instance");
    store
        .transition_plugin_instance(
            "pni_invocation",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Starting,
                state: PluginInstanceState::Ready,
                at: T1.into(),
            },
        )
        .expect("mark instance ready");

    let start = PluginInvocationStart {
        id: "inv_before_tool".into(),
        instance_id: "pni_invocation".into(),
        hook_or_method: "before.tool".into(),
        correlation_id: "corr_plugin".into(),
        started_at: T1.into(),
    };
    let running = store
        .start_plugin_invocation(&start)
        .expect("persist invocation start");
    assert_eq!(running.state, PluginInvocationState::Running);
    assert_eq!(
        store
            .start_plugin_invocation(&start)
            .expect("idempotent invocation start"),
        running
    );

    let finish = PluginInvocationFinish {
        state: PluginInvocationState::Succeeded,
        decision: Some(json!({ "action": "continue" })),
        error: None,
        finished_at: T2.into(),
    };
    let completed = store
        .finish_plugin_invocation("inv_before_tool", &finish)
        .expect("persist invocation completion");
    assert_eq!(completed.state, PluginInvocationState::Succeeded);
    assert_eq!(completed.finished_at.as_deref(), Some(T2));
    assert_eq!(completed.decision, finish.decision);
    assert_eq!(
        store
            .finish_plugin_invocation("inv_before_tool", &finish)
            .expect("idempotent completion replay"),
        completed
    );
    assert!(matches!(
        store.finish_plugin_invocation(
            "inv_before_tool",
            &PluginInvocationFinish {
                state: PluginInvocationState::Failed,
                decision: None,
                error: Some(json!({ "code": "PLUGIN_TIMEOUT" })),
                finished_at: T2.into(),
            },
        ),
        Err(StoreError::InvalidPlugin { .. })
    ));
    assert_eq!(
        store
            .plugin_invocation("inv_before_tool")
            .expect("reload invocation record"),
        Some(completed)
    );

    store
        .transition_plugin_instance(
            "pni_invocation",
            &PluginInstanceTransition {
                expected_state: PluginInstanceState::Ready,
                state: PluginInstanceState::Stopped,
                at: T2.into(),
            },
        )
        .expect("stop instance");
    assert!(matches!(
        store.start_plugin_invocation(&PluginInvocationStart {
            id: "inv_after_stop".into(),
            instance_id: "pni_invocation".into(),
            hook_or_method: "after.tool".into(),
            correlation_id: "corr_plugin".into(),
            started_at: T2.into(),
        }),
        Err(StoreError::InvalidPlugin { .. })
    ));
}

#[test]
fn installation_rejects_invalid_calendar_timestamp() {
    let mut store = seeded_store();
    let mut input = installation(
        "plg_calendar",
        PluginRuntimeKind::Wasi,
        PluginInstallScope::User,
        PluginPermissionSet::default(),
    );
    input.installed_at = "2026-02-30T00:00:00.000Z".into();
    assert!(matches!(
        store.install_plugin(&input),
        Err(StoreError::InvalidPlugin { .. })
    ));
}
