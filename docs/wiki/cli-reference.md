# CLI 레퍼런스

진입점은 `apps/cbc/src/main.ts:34`입니다. 인자 파싱은 `args.ts`, 라우팅은 `router.ts`, 명령 정의는 `command-spec.ts:38-303`의 `COMMAND_REGISTRY`에 있습니다.

## 전역 플래그

전역 플래그는 **하나뿐**입니다 (`command-spec.ts:34-36`).

| 플래그 | 설명 |
| --- | --- |
| `--no-daemon` | 데몬 없이 임베디드 모드로 실행 |

`--help`, `--version`, `-h`, `-v`는 **전역 플래그가 아닙니다.** 실행하면 `error: unknown flag <x> for capy`와 종료 코드 2가 나옵니다. 도움말과 버전은 서브커맨드로만 제공됩니다.

별칭(alias)은 어디에도 없습니다. 짧은 플래그도 없고, 명령 별칭도 없습니다. 플래그 매칭은 정확한 문자열 비교입니다 (`args.ts:182`).

등록되지 않은 첫 위치 인자는 오류가 아니라 **프롬프트로 취급됩니다** (`args.ts:226-236`). 즉 `capy badcmd`는 "badcmd"를 프롬프트로 TUI를 엽니다.

## 명령 목록

### 대화형 / 실행

| 명령 | 플래그 | 정의 |
| --- | --- | --- |
| `capy [prompt...]` | `--no-daemon` | `args.ts:226` |
| `capy run [prompt...]` | `--result-file <v>`, `--event-file <v>`, `--permission-policy <v>`, `--no-daemon` | `command-spec.ts:39-48` |

### 인증

| 명령 | 플래그 | 정의 |
| --- | --- | --- |
| `capy auth login` | `--device` | `command-spec.ts:53-57` |
| `capy auth api` | `--stdin` | `command-spec.ts:58-63` |
| `capy auth status` | — | `command-spec.ts:64` |
| `capy auth logout` | `--all` | `command-spec.ts:65-69` |

`capy auth api`에 키를 위치 인자로 주면 셸 히스토리 경고와 함께 거부됩니다 (`args.ts:338-343`). 이것이 `operandPolicy: "deferred"`의 목적입니다 — 일반적인 인자 개수 검증을 우회해 보안 메시지가 먼저 나오게 합니다. TTY도 없고 `--stdin`도 없으면 종료 코드 3입니다.

`capy auth login`은 이 빌드에서 운영자가 제공한 `account-registration.json`이 없으면 항상 종료 코드 3과 "Account sign-in is unavailable in this build"를 던집니다 (`auth.ts:76-86`). 내장 OAuth 등록이 포함되어 있지 않습니다.

### 모델 / 설정 / 신뢰

| 명령 | 플래그 | 정의 |
| --- | --- | --- |
| `capy model refresh` | — | `command-spec.ts:76` |
| `capy config set <path> <value>` | 둘 다 필수 | `command-spec.ts:83-90` |
| `capy trust` | `--show-diff` | `command-spec.ts:124-130` |

`capy config`의 서브커맨드는 `set` 하나뿐입니다. `get`/`list`/`unset`/`validate`는 존재하지 않습니다.

`capy trust`를 `--show-diff` 없이 비대화식 환경에서 실행하면 종료 코드 4와 "capy trust requires an interactive terminal"이 나오며, CI용으로 `--show-diff`를 쓰라고 안내합니다 (`trust.ts:37-43`).

### 통합

| 명령 | 플래그 | 정의 |
| --- | --- | --- |
| `capy acp` | — | `command-spec.ts:93-96` |
| `capy clients list\|doctor` | — | `command-spec.ts:100-103` |
| `capy integration doctor [vscode\|acp\|github]` | — | `command-spec.ts:109-114` |
| `capy github install\|doctor` | — | `command-spec.ts:119-122` |
| `capy daemon start\|stop\|status\|logs` | — | `command-spec.ts:279-282` |
| `capy daemon attach [sessionId]` | — | `command-spec.ts:283-287` |

`capy acp`는 데몬을 필수로 요구하며, 붙지 못하면 종료 코드 10입니다 (`acp.ts:14-20`).

### 패키지 / 플러그인

| 명령 | 위치 인자 | 플래그 |
| --- | --- | --- |
| `capy bootstrap` | — | `--frozen`, `--offline`, `--project`, `--user` |
| `capy package search` | `<query>` | — |
| `capy package info` | `<id>` | `--project\|--user\|--effective` |
| `capy package add` | `<source>` | `--project\|--user`, `--allow-unsigned-local`, `--grant-requested`, `--offline` |
| `capy package remove` | `<id>` | `--project\|--user` |
| `capy package update` | `[id]` | `--project\|--user`, `--offline` |
| `capy package verify` | `<source>` | `--project\|--user`, `--allow-unsigned-local`, `--offline` |
| `capy package list` | — | `--project\|--user\|--effective` |
| `capy package doctor` | `[id]` | `--project\|--user\|--effective` |
| `capy package publish` | `[path]` (기본 `.`) | `--dry-run` |
| `capy package init` | `[path]` (기본 `.`) | — |
| `capy plugin list` | — | — |
| `capy plugin inspect\|enable\|disable\|grants` | `<id>` | — |

정의는 `command-spec.ts:131-240`, 파싱은 `args.ts:290-451`, 핸들러는 `commands/packages.ts:21-225`.

스코프 플래그 규칙 (`args.ts:492-513`): 변경 작업은 `--project`(기본)/`--user` 중 하나만, 목록 작업은 `--project`/`--user`/`--effective`(기본) 중 하나만. 둘 이상 지정하면 사용법 오류입니다.

`capy package publish`는 `--dry-run` 없이 실행하면 종료 코드 4와 "publishing is approval-gated; this build supports --dry-run only"를 던집니다 (`packages.ts:144-150`).

### 스킬

| 명령 | 플래그 |
| --- | --- |
| `capy skills list` | `--json` |
| `capy skills doctor` | `--json` |
| `capy skills validate <path>` | `--json`, `--strict` |

정의는 `command-spec.ts:247-265`.

### 기타

| 명령 | 플래그 |
| --- | --- |
| `capy update` | `--check` |
| `capy version` | — |
| `capy help [topic]` | — |

`capy version`은 `capy 0.1.2-alpha.1`을 출력합니다 (`router.ts:135`).

`capy help`는 `args.ts:515-552`의 정적 `HELP_TEXT`를 출력합니다. **도움말 주제(topic)는 실제로 존재하지 않습니다.** `topic`은 파싱되지만 라우터가 무시하고 항상 같은 텍스트를 출력합니다 (`router.ts:139`).

### 숨겨진 명령

`capy session-worker --session-id <v>` 하나뿐입니다. 파서 레지스트리에는 있지만 `commandNames()`에서 필터링되고 `HELP_TEXT`에도 없습니다 (`command-spec.ts:268-274`, `332-338`). 데몬이 spawn하는 자식으로, stdin/stdout에서 NDJSON JSON-RPC를 말합니다. 지원 메서드는 `session.close`, `turn.submit`, `turn.cancel`, `turn.input.get|update|resolve`, `graph.get`, `graph.listNodes`, `task.get|wait|message|cancel`, `plugin.list` 및 패키지 런타임 App 메서드이며, 알 수 없는 메서드는 JSON-RPC `-32601`입니다.

## 종료 코드

`apps/cbc/src/exit.ts:10-35`, 설명은 `:39-52`.

| 코드 | 이름 | 의미 |
| --- | --- | --- |
| 0 | ok | 성공 |
| 1 | failure | 실패 |
| 2 | usage | 사용법 오류 |
| 3 | auth | 인증 문제 |
| 4 | permission | 권한 거부 |
| 5 | provider | 프로바이더 오류 |
| 6 | tool | 도구 오류 |
| 7 | cancelled | 취소됨 |
| 8 | partial | 부분 완료 |
| 9 | config | 설정 오류 |
| 10 | internal | 내부 오류 |
| 42 | updateHandoff | 런처 업데이트 핸드오프 (내부용) |

턴 상태 → 종료 코드 매핑 (`exit.ts:60-73`): completed→0, partial→8, cancelled→7, failed→1.

**주의:** `capy update`는 2를 "업데이트 가능"으로 재사용합니다 (`update.ts:23`). 이 명령에서만 2는 사용법 오류를 의미하지 않습니다.

분류되지 않은 예외는 10이 됩니다 (`router.ts:169`). 스택 트레이스는 `CBC_DEBUG=1`일 때만 출력됩니다 (`router.ts:166`).

패키지 오류는 특수하게 매핑됩니다 (`router.ts:149-158`): `PackageInstallError`는 영수증을 stderr에 JSON으로 출력한 뒤 1, `PackageVerificationError`/`UnsupportedPackageSourceError`는 9.

## `capy run` 상세

`run`은 구조적으로 비대화식이 강제됩니다 — `router.ts:42`에서 `kind === "run"`일 때만 `nonInteractive: true`를 설정합니다.

### 프롬프트 소스

argv(공백으로 join, trim — `args.ts:263`) 또는 `--event-file` 봉투의 `promptText`입니다. 둘 다 주면 사용법 오류(2), 둘 다 없으면 사용법 오류(2)입니다. **`run`은 stdin에서 프롬프트를 읽지 않습니다.** stdin을 읽는 명령은 `auth api --stdin`과 `acp`뿐입니다.

### 출력

`--json`이나 `--format` 플래그는 없습니다. 터미널 출력은 `renderChatResponse`를 한 번 출력합니다 (`run.ts:104`, `141`).

기계 판독 출력은 `--result-file`에 한 줄 JSON으로 씁니다 (`run.ts:34-54`, `186-190`): `schemaVersion: "1.0"`, `sessionId`, 그리고 `FinalStatusPayload` 필드 — `status`, `exitCode`, `changedFiles`, `turnId`, `summary`, `commitSha`(항상 null), `evidenceIds`, `verification`, `annotations`, `artifacts`, `tests{passed,failed,notRun}`, 선택적 `risks`, `errorCategory`. 모드 `0o600`으로 원자적으로 씁니다 (`run.ts:225-236`).

저널 JSONL도 함께 씁니다: `CBC_RUN_JOURNAL_PATH`, 없으면 `<resultFile>.journal.jsonl` (`run.ts:215-219`). 결과/저널 쓰기 실패는 경고만 하고 종료 코드를 바꾸지 않습니다 (`run.ts:191-206`).

`errorCategory` 값: `cli_error`, `cancelled`, `timeout`, `unhandled` (`run.ts:238-244`).

### `--permission-policy`

정확히 세 값만 허용됩니다 (`args.ts:267-274`), 기본은 `deny-on-ask` (`run.ts:68`).

| 값 | 동작 |
| --- | --- |
| `deny-on-ask` | 승인이 필요한 동작을 거부 |
| `allow-listed` | 사전 규칙에 맞는 것만 허용 (규칙 미일치 = 거부) |
| `fail-on-ask` | 승인이 필요해지면 종료 코드 4로 즉시 종료 |

`fail-on-ask`가 종료하는 이유는 AC-38이 hang이 아닌 exit를 요구하기 때문입니다 (`approvals.ts:206-230`).

### `--event-file`

파일 없음 → 2, 잘못된 JSON → 2, 봉투 검증 실패 → **4**, `trusted !== true` → **4** (`run.ts:263-283`).

### 신뢰 처리

`run`은 신뢰를 절대 묻지 않습니다. 신뢰되지 않은 워크스페이스는 경고와 함께 조용히 `read-only`로 격하되어 분석은 계속 가능합니다 (`workspace-trust.ts:53-60`).

## 시작 순서

설정과 런타임은 모두 지연 로딩입니다 (`commands/context.ts:178-248`). 설정만 다루는 명령은 사이드카를 띄우지 않습니다.

`context.config()`는 먼저 `trust()`를 호출합니다 — 신뢰가 프로젝트 설정의 참여 여부를 결정하기 때문입니다 (`context.ts:180-184`). `requireConfig()`는 error 심각도 이슈를 모두 나열하며 종료 코드 9를 던집니다 (`context.ts:189-200`). `runtime()`은 `requireConfig()`를 먼저 호출하므로 깨진 설정은 조용한 기본값이 아니라 명시적 실패가 됩니다 (`context.ts:218`).

대화형 시작 순서 (`interactive.ts:163-255`):

1. `beginUpdateCheck` — **가장 먼저**, 병렬로. 사용자가 신뢰 박스를 읽는 동안 GitHub 왕복을 겹칩니다.
2. `ensureTrust` — 워크스페이스를 읽는 어떤 코드보다 먼저. `exit` 선택은 종료 코드 **0**입니다.
3. `settleUpdateCheck` — 남은 1500 ms 예산 소진. 후보가 있으면 여기서 프롬프트. 업데이트를 선택하면 TUI는 열리지 않습니다.
4. 설정 읽기 (관대하게, `requireConfig` 아님 — 설정 오류가 터미널을 중간에 방치하지 않도록), 키맵 재매핑, 권한 정책 해석.
5. `ui.open(...)` — 화면 그리기.
6. 늦게 도착한 업데이트 결과는 프롬프트가 아니라 논블로킹 배너.
7. 런타임 생성 후 `ensureTrust` **재호출** — 호스트 결정을 Rust 파일시스템 가드에 미러링.
8. `bootstrapSession` → `warmContext`.

`bootstrapSession` 순서 (`bootstrap.ts:237+`): 런타임 시작 → 실행 파일 능력 조회 → 설정 + `requireConfig` → 검증 계약 → 신뢰 → 모델 예산이 반영된 세션 로컬 설정 복제 → 인증 모드 → 계정 세션 **또는** 자격 증명 해석(둘 다 아님 — 계정 모드는 API 키 우선순위를 의도적으로 우회해 청구가 조용히 이동하지 않게 합니다, `bootstrap.ts:274-299`) → 프로바이더 구성 → 레거시 세션 인덱스 마이그레이션 → resume 해석 → 워크스페이스 신원 + 승인 규칙 → 승인 브로커 → LSP/플러그인/메모리 → 임베디드 app 클라이언트 → `ensureSessionDaemon`.

## 환경 변수

### 경로 (`host.ts:124-193`)

| 변수 | 용도 |
| --- | --- |
| `CAPYBARA_CONFIG` | 설정 파일 경로를 그대로 지정 |
| `CAPYBARA_HOME` | 모든 하위 경로의 루트 |
| `CAPYBARA_DATA_DIR` / `CAPYBARA_CACHE_DIR` / `CAPYBARA_LOG_DIR` | 개별 루트 |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` | POSIX 표준 |
| `APPDATA` / `LOCALAPPDATA` | Windows |
| `HOME` / `USERPROFILE` | 호스트 신원 (`bun-host.ts:933-935`) |

### 런타임 탐색

`CBC_RUNTIME_BINARY` (`host.ts:212`), `CARGO_TARGET_DIR` (`host.ts:234`).

### 동작 제어

| 변수 | 효과 |
| --- | --- |
| `CBC_DEBUG=1` | 스택 트레이스(`router.ts:166`) + 런타임 stderr 에코(`context.ts:239`) |
| `CBC_DAEMON` | `0`/`false` → 임베디드 모드 (`daemon.ts:92`) |
| `CAPY_DAEMON_RUNTIME_DIR` | 데몬 런타임 디렉터리 (`daemon.ts:44`) |
| `CBC_VERIFICATION_CONTRACT` | 검증 계약 JSON (최대 32768바이트, `bootstrap.ts:245-248`) |
| `CBC_MOCK_PROVIDER` | 모의 프로바이더 (`provider.ts:79`) |
| `CBC_TUI_PERF=1` | TUI 성능 계측 (`tui-perf.ts:103`) |
| `CBC_HOSTED_TOOLS` / `CBC_ALLOW_CHATGPT_HOSTED_TOOLS` | 호스티드 도구 제어 (`provider.ts:115-117`) |
| `CBC_ACCOUNT_REGISTRATION` | 계정 등록 문서 경로 (`credentials.ts:611`) |
| `CBC_RUN_RESULT_PATH` / `CBC_RUN_JOURNAL_PATH` | `run` 출력 경로 (`run.ts:210,216`) |
| `CBC_CAPABILITY_URL` / `CBC_CAPABILITY_OVERRIDE` | 능력 매니페스트 소스 |
| `CBC_NO_COLOR` | 색상 비활성 (릴리스 스모크 테스트가 사용) |

### 설정 레이어에 매핑되는 변수 (`packages/config-schema/src/schema.ts:1805-1823`)

| 변수 | 설정 경로 |
| --- | --- |
| `CBC_MODEL` | `model.default` |
| `CBC_REASONING_EFFORT` | `model.reasoningEffort` |
| `CBC_REASONING_MODE` | `model.reasoningMode` |
| `CBC_PERMISSION_MODE` | `agent.permissionMode` |
| `NO_COLOR` | `ui.color = "never"` (비어 있지 않은 값) |
| `CBC_NO_UPDATE_CHECK` | `updates.check = false` (비어 있지 않은 값) |

`OPENAI_API_KEY`는 자격 증명 소스이며 **설정으로 복사되지 않습니다** (`schema.ts:1821`).

### 프로바이더

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` (`provider.ts:112,135,138`).

### 패키지 레지스트리 (`commands/context.ts:354-356`)

`CAPYBARA_PACKAGE_REGISTRY`, `CAPYBARA_PACKAGE_ROOT_KEYS_FILE`, `CAPYBARA_PACKAGE_ROOT_KEYS_JSON`. 두 키 소스 중 정확히 하나가 필요하고, 둘 중 하나가 설정되면 레지스트리 URL이 필수입니다. 위반 시 종료 코드 9.

### 업데이트 게이팅

`CI`, `GITHUB_ACTIONS` (`update-check.ts:272`).

## 알려진 불일치

- `HELP_TEXT`는 `capy --no-daemon [prompt...]`를 광고하고 플래그가 모든 명령에서 허용되지만, 실제로 소비하는 것은 `interactive`, `run`, bootstrap/daemon 경로뿐입니다. 예를 들어 `capy version --no-daemon`은 파싱되고 조용히 무시됩니다.
- `capy help <topic>`의 topic 인자는 파싱되지만 사용되지 않습니다.
