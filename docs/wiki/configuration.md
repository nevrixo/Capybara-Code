# 설정

## 설정 파일 위치

CLI가 실제로 사용하는 해석기는 `apps/cbc/src/host.ts:124-193`의 `resolvePaths`입니다.

| 조건 | 설정 파일 |
| --- | --- |
| `CAPYBARA_CONFIG` 설정 (공백 아님) | 그 값 그대로 |
| `CAPYBARA_HOME` 설정 | `$CAPYBARA_HOME/config/config.toml` |
| Windows | `%APPDATA%\capybara\config.toml` (대체: `$HOME/AppData/Roaming/capybara`) |
| Linux / macOS | `$XDG_CONFIG_HOME/capybara/config.toml` (대체: `$HOME/.config/capybara`) |

같은 함수가 계산하는 형제 경로들 (`host.ts:143-192`):

| 역할 | 경로 |
| --- | --- |
| data | `CAPYBARA_DATA_DIR` → `$CAPYBARA_HOME/data` → win32 `%LOCALAPPDATA%\capybara\data` → `$XDG_DATA_HOME/capybara` |
| cache | `CAPYBARA_CACHE_DIR` → `$CAPYBARA_HOME/cache` → win32 `%LOCALAPPDATA%\capybara\cache` → `$XDG_CACHE_HOME/capybara` |
| logs | `CAPYBARA_LOG_DIR` → `$CAPYBARA_HOME/logs` → win32 `<cache>/logs` → `$XDG_STATE_HOME/capybara/logs` |
| sessions | `<data>/sessions` |
| artifacts | `<data>/artifacts` |
| agents | `<configRoot>/agents` |
| skills | `<configRoot>/skills` |
| trustStore | `<data>/trust.json` |
| projectTrustStore | `<data>/project-trust.json` |
| approvalStore | `<data>/approvals.json` |

> **알려진 불일치.** `packages/config-schema/src/schema.ts:1833-1869`에 두 번째 `resolvePaths`가 있고, 값이 다릅니다 — Windows에서 하이픈이 붙은 `capybara-code`, `$CAPYBARA_HOME/config.toml`(`config/` 세그먼트 없음), `XDG_STATE_HOME`을 무시하는 로그 경로. `apps/cbc`의 어떤 호출자도 이것을 쓰지 않습니다. **`host.ts`가 정답입니다.**

전역 파일은 첫 사용 시 템플릿에서 생성되며 절대 덮어쓰지 않습니다 (`state.ts:291-301`, 템플릿은 `config-template.ts:10-91`).

### 프로젝트 설정

`loadEffectiveConfig` (`state.ts:317-318`):

- `<workspace>/.capybara/config.toml` — 공유, 커밋 대상
- `<workspace>/.capybara/config.local.toml` — 로컬, 커밋 제외

신뢰 스냅샷은 추가로 `<workspace>/.capybara/packages.json`과 `packages.lock.json`을 프로젝트 제어 파일로 읽습니다 (`project-trust.ts:30-34`).

**프로젝트별 쓰기 경로는 없습니다.** 모든 영속 편집은 전역 사용자 파일을 대상으로 합니다 (`state.ts:365-370`).

디스크의 TOML은 snake_case, 코드는 camelCase입니다 (변환은 `toml.ts:341-358`, `state.ts:550-552`). `model.reasoning_effort`와 `model.reasoningEffort`는 같은 키를 가리킵니다 (`schema.ts:1884-1896`).

## 우선순위

`packages/config-schema/src/index.ts:38-94`의 레이어 push 순서, 마지막 승자 병합 (`schema.ts:1051-1052`, `1291`).

1. 내장 기본값 — `defaultConfig()`
2. `user` — 전역 TOML
3. `project` — `.capybara/config.toml`
4. `project-local` — `.capybara/config.local.toml`
5. `environment` — `environmentLayer(env)`
6. `cli`
7. `session` — 대화형 `/model`, `/effort`, `/mode`

두 가지 중요한 단서가 있습니다.

- **프로젝트 레이어는 신뢰 게이트를 통과해야 합니다.** `projectTrusted !== true`면 두 프로젝트 레이어가 완전히 건너뛰어지고 경고가 기록됩니다 (`index.ts:55-63`). `projectTrusted`는 `trust === "trusted-once" || "trusted-always"`입니다 (`commands/context.ts:181-184`). `read-only`는 프로젝트 설정을 허용하지 **않습니다.**
- **신뢰되어도 상한 제약을 받습니다** (아래 §"프로젝트가 설정할 수 없는 키").

병합 후 하나의 clamp가 모든 레이어를 덮어씁니다: `model.cache.ttlMinutes`는 소스와 무관하게 30으로 고정됩니다 (`index.ts:79-87`).

> `cliOverrides`(`state.ts:307,328`)와 `sessionOverrides`(`state.ts:308,329-331`)는 배선되어 있지만 **현재 CLI에서 값을 전달하는 호출 지점이 없습니다.** 레이어 6·7은 스키마에는 있으나 아직 공급되지 않습니다.

## `capy config set`

```
capy config set <path> <value>
```

값 파싱 순서 (`coerceConfigValue`, `state.ts:445-451`):

1. 정확히 `"true"` → boolean `true`
2. 정확히 `"false"` → boolean `false`
3. `/^-?\d+$/` → 정수
4. `/^-?\d*\.\d+$/` → 실수
5. 그 외 → 문자열 그대로

결과적으로 **배열과 테이블은 CLI로 설정할 수 없습니다.** `skills.paths`, `lsp.commands.allow`, `permissions.rules`, `model.context.bands`는 파일을 직접 편집해야 합니다. 문자열 `"true"`도 쓸 수 없고, `1e5`는 숫자로 인식되지 않아 문자열이 됩니다.

쓰기 동작 (`updateUserConfigTransaction`, `state.ts:388-432`):

- 항상 전역 사용자 설정 파일 대상. 프로젝트 파일은 건드리지 않습니다.
- 텍스트를 줄 단위로 in-place 편집하므로 사용자 주석이 보존됩니다 (`upsertTomlValue`, `state.ts:460-511`). 평평한 `[section]\nkey = value` 형태만 처리하고, 섹션이 없으면 파일 끝에 추가합니다.
- 후보 문서를 `loadConfig`로 재검증하고 편집 전 기준선과 오류를 비교합니다. **새로 생긴 오류만** 차단하므로 이미 깨진 파일도 계속 쓸 수 있습니다 (`state.ts:407-417`).
- 원자적 쓰기 (`state.ts:421`). 바이트가 동일하면 `written: false`이며 아무것도 쓰지 않습니다.

### 파서가 받아들이는 TOML 부분집합

`packages/config-schema/src/toml.ts:22-83`: 테이블 `[a.b]`, 테이블 배열 `[[a]]`, 점 표기 키, 인용 키, 문자열(basic + literal), `_` 구분자가 있는 정수, 실수, boolean, 한 줄 평평한 배열.

**조용히 무시하지 않고 명시적으로 거부하는 것들** (`toml.ts:8`): 멀티라인 문자열 (`:165-167`), 인라인 테이블 `{…}` (`:194-196`), 멀티라인 배열 (`:181`). 정수는 안전 정수여야 합니다 (`:202`).

## 전체 설정 키

기본값은 모두 `packages/config-schema/src/schema.ts:483-800`의 `defaultConfig()`에 정의됩니다. enum 표는 `:923-983`, 정수 범위는 `:1495-1585`. JSON 스키마 미러는 `schemas/config/config.schema.json` (`additionalProperties: false`, 26개 최상위 섹션 모두 `required`).

표기: TOML 경로는 디스크상의 snake_case입니다.

### `[ui]` — `schema.ts:485-504`

| 키 | 타입 | 값 | 기본 |
| --- | --- | --- | --- |
| `theme` | string | 자유 | `"capybara-dark"` |
| `color` | enum | `auto\|always\|never` | `"auto"` |
| `mouse` | bool | | `true` |
| `animations` | bool | | `true` |
| `show_cost` | bool | | `true` |
| `status_density` | enum | `auto\|compact\|full` | `"auto"` |
| `thinking_mode` | enum | `expanded\|collapsed\|off` | `"collapsed"` |
| `thinking_visibility` | enum | `full\|summary\|hidden` | `"summary"` — **deprecated** → `thinking_mode` |
| `tool_detail` | enum | `compact\|full` | `"compact"` |
| `subagent_detail` | enum | `drawer\|inline` | `"drawer"` |
| `sidebar` | enum | `auto\|show\|hide` | `"auto"` |
| `final_answer.style` | enum | `chat\|report` | `"chat"` |
| `final_answer.evidence` | enum | `hidden\|collapsed\|expanded` | `"hidden"` |
| `final_answer.attention_details` | bool | | `false` |

### `[model]` — `schema.ts:505-565`

| 키 | 값 / 범위 | 기본 |
| --- | --- | --- |
| `profile` | `model.profiles`의 키 또는 예약어 `"manual"` | `"auto"` |
| `default` | | `"gpt-5.6-sol"` |
| `reasoning_mode` | `standard\|pro` | `"standard"` |
| `reasoning_effort` | `none\|low\|medium\|high\|xhigh\|max` | `"medium"` |
| `soft_context_tokens` | ≥8000 (4000 미만은 hard error) | `96000` |
| `max_output_tokens` | ≥256 | `32000` |

`[model.router]` (`:513-522`): `strategy` `utility\|latency\|cost` = `"utility"`, `phase_policy` = `true`, `cheap_tier` = `"gpt-5.6-luna"`, `default_tier` = `"gpt-5.6-terra"`, `escalation_tier` = `"gpt-5.6-sol"`, `max_cost_usd_per_turn` = `2`, `target_latency_ms` = `90000`, `record_decisions` = `true`.

`[model.reasoning]` (`:523-532`): `provider_summary` `auto\|off` = `"auto"`, `summary` `auto\|none` = `"auto"` (**deprecated**), `continuity` = const `"task-epoch"`, `pro_policy`/`max_policy` = const `"eval-gated"`, `reset_on_workspace_change` = `true`, `preserve_opaque_items` = `true`.

`[model.context]` (`:533-548`):

| 키 | 값 | 기본 |
| --- | --- | --- |
| `bands` | int[] | `[64000, 192000, 272000, 512000, 1000000]` |
| `default_band` | ≥1 | `192000` |
| `premium_threshold_tokens` | ≥1 | `272000` |
| `premium_band_policy` | `deny\|allow\|utility-gated` | `"utility-gated"` |
| `compaction` | const | `"evidence-ledger"` |
| `reserve_output_tokens` | ≥1 | `32000` |
| `orientation_mode` | `strict\|progressive` | `"progressive"` |
| `provider_compaction` | bool (문자열 `off\|auto\|on`도 수용) | `true` |
| `provider_compaction_mode` | `off\|auto\|on` | `"auto"` |
| `compaction_threshold_tokens` | ≥1024 | `80000` |
| `compaction_policy` | `off\|legacy\|adaptive` | `"adaptive"` |
| `min_free_tokens` | `"auto"` 또는 ≥0 | `"auto"` |
| `target_free_tokens` | `"auto"` 또는 ≥0 | `"auto"` |
| `emergency_ratio` | (0,1] | `0.9` |

`[model.cache]` (`:549-555`): `mode` `roi\|always\|off` = `"roi"`, `max_writes_per_turn` = `2`, `ttl_minutes` = `30` (다른 값은 경고 후 30으로 clamp), `minimum_reuse_probability` = `0.55`, `record_read_write_tokens` = `true`.

`[model.profiles.<name>]` (`:557-564`): `model`, `reasoning_mode`, `reasoning_effort`. 기본 6개 — `auto`/`balanced` = sol/standard/medium, `fast` = terra/standard/low, `deep` = sol/standard/high, `review` = sol/**pro**/high, `economy` = luna/standard/low.

### `[agent]` — `schema.ts:566-594`

| 키 | 값 | 기본 |
| --- | --- | --- |
| `permission_mode` | `plan\|ask\|auto\|auto-review` | `"ask"` |
| `interaction_mode` | `build\|plan` | `"build"` |
| `review_mode` | `off\|auto` | `"auto"` |
| `visible_commentary` | bool | `true` |
| `token_saving` | `off\|light\|balanced\|strong` | `"off"` |
| `deep_plan` | `off\|on` | `"off"` |
| `prompt_compiler` | `v1\|v2` | `"v2"` |
| `compound_tools` | bool | `true` |
| `tool_recovery.mode` | `off\|safe\|full` | `"safe"` |
| `tool_recovery.max_attempts` | 1–5 | `3` |
| `todo.auto_progress` | bool | `true` |
| `todo.safe_rebase` | bool | `true` |
| `tool_graph.max_parallel_reads` | ≥1 | `8` |
| `tool_graph.max_parallel_tests` | ≥1 | `2` |
| `tool_graph.serialize_mutations` | bool | `true` |
| `tool_graph.stable_result_order` | bool | `true` |
| `tool_graph.command_classification` | bool | `true` |
| `tool_graph.provider_parallel_tools` | bool | `true` |
| `verification.completion_requires_fresh_evidence` | bool | `true` |
| `verification.independent_review_risk_threshold` | `R0`…`R6` | `"R3"` |
| `verification.false_complete_policy` | `block\|warn` | `"block"` |
| `verification.review_policy` | `always\|risk` | `"risk"` |

제거/폐기: `agent.mode` → `agent.permission_mode`, `agent.max_steps`/`max_tool_calls`/`max_wall_time_minutes`는 **제거됨** (`:999-1001`).

### `[subagents]` — `schema.ts:595-599`

`max_concurrent` 1–8 = `3`, `max_depth` 0–3 = `2`, `writer_policy` `single-lease\|worktree-lease` = `"worktree-lease"`.

### `[tools]` — `schema.ts:600-604`

`activation_limit` ≥1 = `10`, `inline_output_bytes` ≥1024 = `65536`, `inline_output_lines` ≥10 = `200`. 섹션 전체 상태는 **experimental**.

### `[permissions]` — `schema.ts:605-613`

| 키 | 값 | 기본 |
| --- | --- | --- |
| `preset` | `read\|edit\|auto\|yolo` | *미설정* |
| `project_write` | `plan\|ask\|auto` | `"auto"` |
| `shell` | `deny\|ask\|safe-auto` | `"safe-auto"` |
| `network` | `deny\|ask\|allow` | `"ask"` |
| `destructive` | `deny\|ask` | `"ask"` |
| `credentials` | `deny\|ask` | `"deny"` |
| `external_side_effect` | `deny\|ask` | `"ask"` |
| `rules` | 규칙 테이블 배열 | `[]` |

`[[permissions.rules]]` 항목 (`:239-250`, 검증 `:1397-1415`): 필수 `tool`, `decision`(`allow\|deny`), `risk`(`R0`–`R6`); 선택 `program`, `cwd`, `server`, `args_exact`, `args_prefix`, `paths`. 알 수 없는 필드는 오류.

### `[sandbox]` — `schema.ts:614-617`

`level` `none\|workspace\|standard\|strict` = `"workspace"`, `network_for_shell` `deny\|ask\|allow` = `"ask"`.

### `[sessions]` — `schema.ts:618-622`

`retain` = `true`, `artifact_retention_days` = `30`, `auto_snapshot_events` = `100`.

### `[privacy]` — `schema.ts:623-627`

`telemetry` = `false`, `crash_reports` `off\|ask\|on` = `"ask"`, `provider_store` = `false`. 섹션 전체 **experimental** — 구현되지 않았고 기본값이 가장 엄격한 쪽입니다.

### `[updates]` — `schema.ts:628-632`

`channel` `stable\|beta\|nightly` = `"stable"`, `check` = `true`, `interval_hours` ≥1 = `24` (**deprecated** — 시작 시 매 실행 확인).

### `[provider.openai]` — `schema.ts:633-649`

`transport` `http_full\|http_previous\|websocket` = `"websocket"`, `service_tier` `standard\|fast` = `"standard"`, `tool_search` = `false`.

`[provider.openai.native]`: `programmatic_tool_calling` `read-only\|disabled` = `"read-only"`, `hosted_multi_agent` 동일 = `"read-only"`, `max_hosted_agents` = `3`, `max_program_tool_calls` = `24`, `max_program_parallel_calls` = `6`, `allow_hosted_shell`/`allow_hosted_apply_patch`/`allow_computer_use` = 모두 `false`이며 **JSON 스키마에서 const false**. native 서브트리 전체 **experimental**.

### `[perf]` — `schema.ts:650-661`

`telemetry` = `true`, `sample_rate` 0–1 = `1`, `context_pack_projection` = `true`, `subagent_profile_resolution_v2` = `true`, `subagent_context_reservations` = `true`, `phase_routing` = `true`, `budget_enforcement` `shadow\|advisory\|hard` = `"advisory"`, `retrieval_controller_v2` = `true`, `verification_planner_v2` = `true`, `commentary_policy_v2` = `true`.

`long_session_fast_path` = `true`는 **열거 불가능(non-enumerable)** 속성으로 정의됩니다 (`:793-798`). 존재하고 읽히지만 `config.perf`를 열거하는 코드에는 나타나지 않습니다.

### `[experimental]` — `schema.ts:664-673`

8개 모두 기본 `true`: `edit_engine_v2`, `full_lsp`, `session_daemon`, `durable_memory`, `persistent_agent_graph`, `worktree_multi_agent`, `plugin_runtime`, `app_server`.

사용자는 어떤 게이트든 끌 수 있지만, **프로젝트는 사용자가 끈 게이트를 다시 켤 수 없습니다** (`:662-663`).

### `[edit]` — `schema.ts:674-684`

`engine` const `"anchor-range-v2"`, `max_operations_per_plan` 1–100 = `100`, `max_file_bytes` = `8388608`, `max_anchor_text_bytes` = `65536`, `max_anchor_candidates` = `32`, `safe_rebase` = `true`, `preview_before_lsp_mutation` = `true`, `record_resolution_evidence` = `true`, `limits.max_total_changed_bytes` = `16777216`, `limits.max_total_files` = `100`, `limits.max_diff_preview_lines` = `300`.

### `[lsp]` — `schema.ts:685-697`

`enabled` = `true`, `plan_mode` `disabled\|read-only-certified` = `"disabled"`, `max_open_documents_per_server` = `128`, `max_pending_requests_per_server` = `64`, `max_diagnostics_per_file` = `1000`, `max_workspace_symbols` = `5000`, `restart_limit` = `3`, `restart_window_seconds` = `300`, `record_query_evidence` = `true`, `mutations.rename`/`code_actions`/`formatting`/`preview_required` = 모두 `true`, `mutations.max_files` = `100`, `mutations.max_changed_bytes` = `16777216`, `commands.allow` = `[]`.

> **알려진 불일치.** 실제로 소비되는 LSP 키는 7개뿐입니다 (`bootstrap.ts:443,446,448,450,452,453,454,572`): `lsp.enabled`, `lsp.mutations.{rename,formatting,code_actions,max_files,max_changed_bytes}`, `lsp.max_pending_requests_per_server`. `restart_limit`, `restart_window_seconds`, `max_open_documents_per_server`, `max_diagnostics_per_file`, `max_workspace_symbols`, `plan_mode`, `record_query_evidence`, `mutations.preview_required`는 `key-status.ts`가 일부를 `"wired"`로 표기하지만 config-schema 외부에 소비자가 없습니다. 호스트는 자체 하드코딩 상수를 씁니다.

### `[memory]` — `schema.ts:698-713`

`enabled`, `workspace_enabled`, `session_enabled`, `task_enabled`, `auto_candidates`, `require_exact_evidence_for_workspace`, `allow_session_fallback` = 모두 `true`; `max_records_per_workspace` = `1000`, `max_value_bytes` = `16384`, `recall_limit` = `32`, `recall_token_budget` = `4096`, `retention_days` = `180`; `confidence.workspace` = `0.8`, `confidence.session`/`task` = `0.5`; `privacy.store_raw_transcript` **const false**, `privacy.store_sensitive_paths` = `false`, `privacy.allow_plugin_proposals` = `true`.

### `[daemon]` — `schema.ts:714-725`

`enabled`/`autostart` = `true`, `idle_shutdown_minutes` = `30`, `workspace_idle_minutes` = `10`, `heartbeat_seconds` = `5`, `owner_lease_seconds` = `20`, `graceful_shutdown_seconds` = `10`, `log_level` = `"info"`, `transport.mode` const `"local"`, `transport.allow_tcp` **const false**, `transport.socket_path` const `"auto"`, `transport.max_connections` = `32`, `transport.max_frame_bytes` = `8388608`, `clients.control_lease_seconds` = `30`, `clients.detach_grace_seconds` = `5`, `clients.max_event_queue_items` = `1000`, `clients.max_event_queue_bytes` = `8388608`.

### `[agent_graph]` — `schema.ts:726-738`

`enabled` = `true`, `max_depth` = `3`, `max_nodes` = `16`, `max_concurrent_nodes` = `6`, `max_concurrent_readers` = `6`, `max_concurrent_writers` = `1`, `max_attempts_per_node` = `2`, `checkpoint_events` = `25`, `message_bytes` = `65536`, `recovery_policy` `safe-retry\|manual` = `"safe-retry"`, `budget.mode` `hard\|advisory` = `"hard"`, `budget.max_cost_usd` = `4`, `budget.max_tool_calls` = `240`, `budget.max_wall_clock_minutes` = `30`.

### `[worktrees]` — `schema.ts:739-749`

`enabled` = `true`, `root` const `"auto"`, `max_active` = `8`, `max_active_writers` = `4`, `require_clean_base` = `true`, `retention_hours` = `24`, `runtime_per_worktree` = `true`, `lsp_per_worktree` = `true`, `merge.preview_required`/`independent_review`/`verify_on_base`/`auto_merge_disjoint` = 모두 `true`, `merge.conflict_policy` const `"block"`.

### `[plugins]` — `schema.ts:750-759`

`enabled` = `true`, `allow_project_wasi` = `true`, `allow_project_stdio` **const false**, `allow_unsafe_local` **const false**, `require_signature_for_registry` = `true`, `max_active_per_workspace` = `16`; `limits.before_hook_ms` = `2000`, `limits.after_hook_ms` = `5000`, `limits.aggregate_before_hook_ms` = `5000`, `limits.max_output_bytes` = `1048576`, `limits.max_state_bytes` = `1048576`, `limits.max_reentrancy_depth` = `2`, `limits.max_nested_tool_calls` = `8`; `failure.critical_before` const `"closed"`, `failure.ordinary_before` = `"open-with-warning"`, `failure.after` const `"open"`, `failure.circuit_failures` = `3`.

### `[app_server]` — `schema.ts:760-770`

`enabled` = `true`, `transport` const `"local"`, `allow_loopback_websocket` **const false**, `max_connections` = `32`, `max_request_bytes` = `8388608`, `max_response_bytes` = `8388608`, `max_subscriptions_per_client` = `16`, `max_sessions_per_subscription` = `32`, `events.max_batch_events` = `100`, `events.max_batch_bytes` = `1048576`, `events.ack_timeout_seconds` = `30`, `events.slow_client_policy` `replay\|disconnect` = `"replay"`.

### `[sdk]` — `schema.ts:771`

`reconnect` = `true`, `reconnect_max_attempts` = `8`. 섹션 **experimental**.

### `[skills]` — `schema.ts:772-785`

`enabled` = `true`, `paths` = `[]`, `compat_opencode`/`compat_agents`/`compat_claude` = `true`, `legacy_paths` = `true`, `auto_reload` = `false` (**experimental** — 워처 미구현), `max_roots` 1–256 = `64`, `max_candidates` 1–1000 = `512`, `max_depth` 0–32 = `8`, `scan_timeout_ms` 1–60000 = `1500`, `builtin.enabled` = `true`, `builtin.disabled` = `[]`.

### `[mcp.servers.<name>]` — `schema.ts:287-298`

기본 맵은 `{}`입니다. 필드: `transport` (`stdio\|streamable_http`), `command`, `args`, `url`, `env`(변수 **이름** 배열), `auth` (`none\|oauth\|bearer`), `enabled`, `connect_on_startup`, `timeout_ms`. 알 수 없는 필드는 오류.

### `[lsp.servers.<name>]` — `schema.ts:300-308`

기본 `{}`. `command` 필수, `language_id` 필수, `extensions` 필수(비어 있지 않고 모든 항목이 점으로 시작하며 2자 이상), `args`, `enabled`, `install_hint`, `timeout_ms` ≥100.

### `[keymap]` — `schema.ts:791`

`keymap.<action> = "<descriptor>"`. 기본 `{}`. 상태 **experimental** — 현재 바인딩은 `tui-components`에 고정되어 있습니다.

### 템플릿이 쓰는 값 ≠ 코드 기본값

`config-template.ts`는 `defaultConfig()`가 비워 두는 MCP/LSP 정의를 의도적으로 씁니다 (`schema.ts:787-788`):

- `mcp.servers.context7` — streamable_http, `https://mcp.context7.com/mcp`, auth none, enabled, `connect_on_startup = false`, `timeout_ms = 10000`
- `lsp.servers.typescript` — `typescript-language-server --stdio`, `.ts/.tsx/.mts/.cts`
- `lsp.servers.python` — `pyright-langserver --stdio`, `.py/.pyi`

둘 다 `timeout_ms = 15000`.

## 키 상태 레지스트리

`packages/config-schema/src/key-status.ts:32-191`가 모든 키를 `wired` / `experimental` / `deprecated`로 표기합니다 (최장 접두사 우선, `:194-203`). `experimental` 키를 설정하면 병합 시 "…is experimental and not applied yet" 경고가 나옵니다 (`schema.ts:1297-1305`).

주목할 experimental-but-accepted 키: `ui.color`(실제 색상은 `NO_COLOR`를 따름), `tools.*` 전체, `privacy.*` 전체, `model.context.bands`, `model.context.default_band`, `model.context.premium_threshold_tokens`, `model.cache.ttl_minutes`, `sessions.retain`, `sessions.artifact_retention_days`, `sdk.*`, `keymap.*`, `provider.openai.native.*`.

## 프로젝트가 설정할 수 없는 키

모두 `mergeConfig` 안에서 `layer.source === "project" || "project-local"`일 때만 적용됩니다.

**(a) 자격 증명 형태 경로 — hard error, 모든 세그먼트, 대소문자 무시** (`schema.ts:830-840`): `auth`, `credentials`, `apiKey`, `api_key`, `openaiApiKey`, `openai_api_key`, `token`, `secret`, `password`. 추가로 3세그먼트 `mcpServers.<name>.env`도 금지 — 프로젝트가 서버 프로세스에 상속될 호스트 환경 변수 이름을 지정할 수 없습니다.

**(b) 사용자 전용 접두사 — hard error** (`schema.ts:850-863`): `agent.tokenSaving`, `updates.`, `provider.openai.`, `perf.`, `daemon.`, `appServer.`, `sdk.`, `plugins.allowProjectStdio`, `plugins.allowUnsafeLocal`, `plugins.requireSignatureForRegistry`, `worktrees.root`, `memory.privacy.`

**(c) 사용자 전용 정확 경로** (`schema.ts:865-870`): `model.default`, `model.reasoningMode`, `model.reasoningEffort`, `agent.deepPlan`.

**(d) 단조 문자열 스케일 — 더 엄격하게만 이동 가능** (`schema.ts:877-897`). 배열은 엄격→관대 순이며 인덱스 증가는 거부됩니다.

| 키 | 스케일 |
| --- | --- |
| `permissions.preset` | `[read, edit, auto, yolo]` |
| `permissions.project_write` | `[plan, ask, auto]` |
| `permissions.network`, `sandbox.network_for_shell` | `[deny, ask, allow]` |
| `permissions.shell` | `[deny, ask, safe-auto]` |
| `permissions.destructive`, `.credentials`, `.external_side_effect` | `[deny, ask]` |
| `sandbox.level` | `[strict, standard, workspace, none]` |
| `agent.permission_mode` | `[plan, ask, auto-review, auto]` |
| `agent.interaction_mode` | `[build, plan]` |
| `agent.review_mode` | `[auto, off]` |
| `agent.verification.review_policy` | `[always, risk]` |
| `agent.verification.independent_review_risk_threshold` | `[R0…R6]` |
| `agent.verification.false_complete_policy` | `[block, warn]` |
| `privacy.crash_reports` | `[off, ask, on]` |

**(e) 단조 boolean — 실효 엄격값을 뒤집을 수 없음** (`schema.ts:903-921`). 엄격값: `privacy.telemetry`=false, `privacy.provider_store`=false, `agent.verification.completion_requires_fresh_evidence`=**true**, `experimental.*` 8개 모두=false, `edit.safe_rebase`=false, `lsp.mutations.rename/code_actions/formatting`=false, `memory.workspace_enabled`=false, `worktrees.enabled`=false.

**(f) 프로젝트의 `permissions.preset = "yolo"` — hard error** (`schema.ts:1124-1132`).

**(g) 프로젝트의 `permissions.rules`는 deny만** (`schema.ts:1134-1152`). `decision !== "deny"` 항목이 있으면 오류가 발생하고 배열은 제한적 규칙만 남깁니다.

**(h) 사용자 정의 서버 재정의 금지** (`schema.ts:1037-1049`, `1165-1188`). `user` 레이어에 있는 `mcpServers.`/`lspServers.` 이름은 프로젝트가 어떤 필드도 설정할 수 없습니다. 새 서버 **추가**는 가능합니다.

**(i) 고정 false 안전 경계 — 레이어 무관** (`schema.ts:1365-1371`): `memory.privacy.store_raw_transcript`, `daemon.transport.allow_tcp`, `plugins.allow_project_stdio`, `plugins.allow_unsafe_local`, `app_server.allow_loopback_websocket`. `false` 외의 값은 "is a fixed false safety boundary" 오류.

**(j) 프로토타입 오염 가드 — 레이어 무관** (`schema.ts:1358-1363`): 빈 세그먼트 또는 `__proto__`, `prototype`, `constructor`는 거부.

`severity: "error"` 이슈가 하나라도 있으면 `requireConfig()`가 각 `path: message`를 나열하며 종료 코드 9를 던집니다 (`commands/context.ts:189-200`). 적대적 프로젝트 설정은 조용히 격하되지 않고 세션을 실패시킵니다.

> **알려진 불일치.** 단조·사용자 전용 검사는 프로젝트 소스에서만 동작합니다 (`schema.ts:1123`, `1133`). 환경 레이어는 5번이며 프로젝트 레이어 뒤에 적용되므로 `CBC_PERMISSION_MODE=auto`는 사용자가 설정한 하한을 **무조건 넓힙니다.**

## 성능 킬 스위치

`packages/config-schema/src/performance-rollbacks.ts:39-166`가 21개 기능 이름을 설정 경로 + 안전값에 매핑합니다. 예: `agent.promptCompiler`→`"v1"`, `provider.openai.transport`→`"http_full"`, `perf.budgetEnforcement`→`"shadow"`, `model.context.orientationMode`→`"strict"`.

`evaluatePerformanceRollback` (`:220-288`)은 안전성/품질/다이제스트 트리거에서 전체 세트를 적용하고, 전송 전용 또는 지연 전용 회귀에는 더 좁은 세트를 적용합니다.

## 설정 예시

```toml
[ui.final_answer]
style = "chat"             # chat | report
evidence = "collapsed"     # hidden | collapsed | expanded
attention_details = true

[model]
default = "gpt-5.6-sol"
reasoning_effort = "medium"

[model.context]
compaction_policy = "adaptive"     # off | legacy | adaptive
provider_compaction_mode = "auto"  # off | auto | on
emergency_ratio = 0.90

[agent]
deep_plan = "off"          # off | on
permission_mode = "ask"

[permissions]
preset = "edit"
shell = "ask"

[mcp.servers.context7]
transport = "streamable_http"
url = "https://mcp.context7.com/mcp"
auth = "none"
enabled = true
connect_on_startup = false
timeout_ms = 10000

[lsp.servers.typescript]
command = "typescript-language-server"
args = ["--stdio"]
extensions = [".ts", ".tsx", ".mts", ".cts"]
language_id = "typescript"
timeout_ms = 15000
```

## 기타 알려진 불일치

- `key-status.ts:15`가 "`config validate --explain`이 이를 렌더링한다"고 언급하지만 그 CLI는 존재하지 않습니다.
- `config set`은 no-op일 때도 `Set <path> = <value>`를 출력합니다 (`state.ts:418`이 `written: false`를 반환해도 `commands/config.ts:23`이 무조건 출력).
- 프로젝트 `permissions.rules`에 allow 항목이 있으면 오류가 나지만 deny 항목은 적용됩니다. 동작은 안전(deny만)하지만 오류/적용 상호작용은 알아둘 만합니다.
