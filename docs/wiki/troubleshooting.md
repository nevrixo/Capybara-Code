# 문제 해결

## 두 개의 오류 분류 체계

문제를 진단할 때 가장 먼저 알아야 할 구조적 사실: **오류 분류가 두 층으로 나뉘어 있습니다.**

- **TypeScript** — 프로세스 종료 코드 (`apps/cbc/src/exit.ts:10-35`)
- **Rust** — JSON-RPC 오류 코드 (`crates/cbc-protocol/src/jsonrpc.rs:14-41`) + `data.taxonomy`의 안정적인 문자열 분류

세 번째 층이 있습니다. `data.taxonomy` (`jsonrpc.rs:109`)는 TS 제어 평면이 메시지 문자열을 절대 매칭하지 않도록 존재합니다.

### 종료 코드

| 코드 | 이름 | 의미 |
| --- | --- | --- |
| 0 | ok | 성공 |
| 1 | failure | 일반 실패 |
| 2 | usage | 잘못된 CLI 사용 |
| 3 | auth | 인증 필요 또는 실패 |
| 4 | permission | 권한 거부 또는 승인 불가 |
| 5 | provider | 재시도 후에도 프로바이더/레이트리밋 실패 |
| 6 | tool | 도구 또는 프로세스 실패 |
| 7 | cancelled | 취소 또는 중단 |
| 8 | partial | 부분 완료 |
| 9 | config | 설정 오류 |
| 10 | internal | 내부 프로토콜/런타임 실패 |
| 42 | updateHandoff | 내부 패키지 매니저 업데이트 핸드오프 |

`CliError` (`exit.ts:76-87`)는 `code`와 `detail: readonly string[]`을 담습니다. **detail 배열이 곧 대처 방법이며** 메시지 다음에 줄 단위로 출력됩니다.

> **주의할 함정:** `capy update --check`는 "업데이트 가능"에 **2**를 반환합니다 (`commands/update.ts:23`). 이는 `EXIT.usage`와 충돌하므로 CI가 종료 코드만으로 "업데이트 가능"과 "잘못된 명령줄"을 구분할 수 없습니다.

### JSON-RPC 도메인 코드

| 코드 | 이름 |
| --- | --- |
| −32000 | `PATH_OUTSIDE_WORKSPACE` |
| −32001 | `HASH_MISMATCH` |
| −32002 | `PATH_CHANGED` |
| −32003 | `NOT_FOUND` |
| −32004 | `ALREADY_EXISTS` |
| −32005 | `UNSUPPORTED_ENCODING` |
| −32006 | `OUTPUT_LIMIT` |
| −32007 | `TIMEOUT` |
| −32008 | `CANCELLED` |
| −32009 | `PROCESS_EXIT_NONZERO` |
| −32010 | `SANDBOX_UNAVAILABLE` |
| −32011 | `NETWORK_DENIED` |
| −32012 | `TRANSACTION_CONFLICT` |
| −32013 | `PROTOCOL_INCOMPATIBLE` |
| −32014 | `LEASE_VIOLATION` |
| −32015 | `RESOURCE_LIMIT` |
| −32016 | `NOT_INITIALIZED` |
| −32017 | `TOO_MANY_REQUESTS` |
| −32018 | `INVALID_ARGUMENT` |
| −32019 | `PERMISSION_DENIED` |

**중요:** `TIMEOUT`, `CANCELLED`, `PROCESS_EXIT_NONZERO`, `LEASE_VIOLATION`, `RESOURCE_LIMIT`는 정의되어 있으나 **RPC 오류로 발행되지 않습니다.** 타임아웃/취소/비영 종료는 대신 **성공한** `process.run` 응답의 `taxonomy` 문자열로 도착합니다 (`cbc-process/src/lib.rs:248`, `handlers/process.rs:496`). **실패한 프로세스는 RPC 오류가 아닙니다.**

Rust 프로세스 종료 코드는 **두 개뿐입니다** (`crates/cbc-runtime/src/main.rs:275`가 유일한 `process::exit`): 깨끗한 EOF나 `runtime.shutdown`에 **0**, 치명적 프레임 디코드 실패나 outbound 파이프 끊김에 **10**. 종료 전에 `terminate_all(1_500)`을 호출해 고아 프로세스를 남기지 않습니다.

---

## 설치 / 실행 문제

### 사이드카를 찾을 수 없음

`apps/cbc/src/runtime.ts:605-612`, 종료 코드 10:

```
the cbc-runtime sidecar could not be found
Looked in:
  <시도한 각 경로>

In a development checkout, build it with `cargo build -p cbc-runtime`.
On WSL, build with Linux rustc so the sidecar is `cbc-runtime`, not `cbc-runtime.exe`.
In a release install, reinstall the archive so bin/ and libexec/ stay together.
```

**`PATH`는 절대 검색하지 않습니다** (`host.ts:202-203`). 탐색 순서 (`:205-245`): `CBC_RUNTIME_BINARY` → `<install>/libexec/cbc-runtime` → `executableDir` → `target/debug` → `target/release` → `CARGO_TARGET_DIR` → `cwd/target/*`.

debug가 release보다 먼저인 것은 의도적입니다 — 낡은 패키지 release가 새 호스트를 오래된 도구 표면과 짝지을 수 있기 때문입니다 (`:219-223`).

### 핸드셰이크 실패

`runtime.ts:653-657`: 원래 메시지 + `The runtime sidecar did not complete the protocol handshake.`

### 런처 오류

`scripts/release-launcher.cjs`:

| 상황 | 메시지 |
| --- | --- |
| 미지원 플랫폼 (`:170-174`) | `Capybara Code Public Alpha does not support ${platform}/${arch}. Supported: Windows x64, macOS x64/ARM64, and Linux x64 (glibc).` |
| **네이티브 패키지 누락** (`:182-190`) | `Capybara Code could not find its ${packageName} optional dependency.` / `Reinstall capybara-code without --omit=optional (or Bun's equivalent).` / `For a manual install, use the matching archive from GitHub Releases and verify SHA256SUMS.txt.` / `Resolver detail: ${detail}` |
| spawn 실패 (`:224`) | `could not start ${binary}: ...` |
| 안전하지 않은 업데이트 (`:229`) | `requested an update without a secure launcher handoff.` |
| 업데이트 요청 거부 (`:237`) | `rejected the update request: ...` |
| 시그널 종료 (`:246`) | `stopped after signal ${signal}.` |

두 번째 항목이 실무에서 가장 흔한 실패입니다.

---

## 인증 문제 (종료 코드 3)

`apps/cbc/src/provider.ts`. 계정 모드와 API 모드가 의도적으로 구분됩니다 — `capy auth api`가 청구 대상을 조용히 바꿀 수 있기 때문입니다 (`:89-91`).

| 상황 | 메시지와 대처 |
| --- | --- |
| `:93-96` | `the account session is not usable` + `The stored account token is missing, expired beyond refresh, or revoked.` / `Run capy auth status for detail, then capy auth login to sign in again.` |
| `:98-101` | `no OpenAI credential is available` + `Run capy auth api or set OPENAI_API_KEY.` / `ChatGPT sign-in credentials are not general OpenAI API credentials and are not reused.` |
| `:105-108` | `the ChatGPT account selector is missing` + `Run capy auth login again.` |

> **알려진 문제: 잠긴 키체인과 "자격 증명 없음"이 구분되지 않습니다.** `credentials.ts:150-153`이 읽기 오류 시 `undefined`를 반환하므로 잠긴 키체인이 자격 증명 부재와 동일하게 보입니다. Rust 측에는 정직한 메시지가 있습니다: `persistent credential storage is unavailable; credentials are kept in memory for this session only` (`cbc-keychain/src/lib.rs:80`).

---

## 설정 문제 (종료 코드 9)

| 위치 | 메시지 |
| --- | --- |
| `provider.ts:177` | `CBC_HOSTED_TOOLS contains an unsupported tool '${token}'` + `Use web_search and/or image_generation, separated by commas.` |
| `provider.ts:193` | `CBC_ALLOW_CHATGPT_HOSTED_TOOLS must be a boolean` + `Use true/false, yes/no, on/off, or 1/0.` |
| `provider.ts:208` | `CBC_MOCK_PROVIDER points at a file that does not exist` |
| `provider.ts:217` | `CBC_MOCK_PROVIDER is not valid JSON: ...` |
| `provider.ts:231` | `the mock provider script has no steps` |

프로젝트 설정이 상한을 위반하면 `requireConfig()`가 각 `path: message`를 나열하며 9를 던집니다 (`commands/context.ts:189-200`). 자세한 상한 규칙은 [설정](configuration.md#프로젝트가-설정할-수-없는-키)을 참고하십시오.

---

## 사용법 오류 (종료 코드 2)

`apps/cbc/src/args.ts`:

| 위치 | 메시지 |
| --- | --- |
| `:184` | `unknown flag ${name} for ${context}` + `Run capy help for the supported command list.` |
| `:189` | `${flag} takes no value` |
| `:192` | `${flag} needs a value` |
| `:212` | `${context} needs ${usage}` |
| `:215` | `${context} takes at most ${n} argument(s)` |
| `:243` | `${context} needs a subcommand` + `Available: ...` |
| `:273` | `--permission-policy must be deny-on-ask, allow-listed, or fail-on-ask` |
| `:339` | `capy auth api does not accept the key as an argument` |
| `:360` | `capy integration doctor target must be vscode, acp, or github` |
| `:489` | `unsupported command: capy ${cmd} ${sub}` |
| `:497` | `${context} accepts only one of --project or --user` |

---

## 신뢰와 권한

### 신뢰

`commands/trust.ts:38-42`, 종료 코드 4: `capy trust requires an interactive terminal` + `Use capy trust --show-diff for a read-only CI inspection.`

신뢰 레이블 (`cbc-workspace/src/trust.rs:49`): `untrusted`, `trusted (session)`, `trusted`, `read-only`.

> **신뢰된 디렉터리를 이동하거나 재생성하면 조용히 untrusted로 되돌아갑니다.** 신뢰는 `dev:ino` 파일시스템 신원으로 키잉되기 때문입니다 (`:191`, `:227`). 이는 버그가 아니라 의도된 동작입니다 — 같은 경로의 다른 디렉터리를 같은 것으로 취급하면 위험합니다.

### 승인

`approvals.ts:214`: `approval is required for ${action} (${riskClass}) but this run is non-interactive`. `fail-on-ask`에서는 종료 코드 4와 `Re-run interactively, or pre-approve it in the permissions config.`를 던집니다.

**헤드리스 기본 정책은 `deny-on-ask`입니다** (`:241`) — 조용히 거부합니다.

### 런타임 측 거부

`crates/cbc-runtime/src/server.rs`:

| 위치 | 메시지 |
| --- | --- |
| `:192` | `Plan mode forbids workspace mutation` |
| `:202` | `workspace trust is '{label}'; mutation requires a trusted workspace` |
| `:216` | `Plan mode forbids process execution` |
| `:223` | `workspace is untrusted; running processes requires a trust decision` |
| `:228` | `workspace is read-only; process execution can mutate it and is denied` |
| `:167` | `runtime.initialize must succeed before workspace operations` |
| `:828` | `protocol major version mismatch: client {c} vs runtime {r}` |

### 민감 경로

승인 여부와 무관하게 **읽기와 쓰기 모두 거부되는** 경로 (`cbc-workspace/src/lib.rs:129`): `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `.ssh/**`, `.aws/credentials`, `.gnupg/**`, `.netrc`, `*.p12`, `*.pfx`, `*.keystore`.

---

## 파일 편집과 패치 문제

`server.rs`가 각 오류에 사람이 읽을 `action`을 붙입니다. 이것이 실무에서 가장 유용한 대처 안내입니다.

| 상황 | `action` |
| --- | --- |
| 낡은 체크섬 (`:1089`) | `re-read the file and retry with the new checksum` |
| hunk 불일치 (`:1103`) | `re-read the current file and regenerate a complete unified diff` |
| 파일 없음 (`:1107`) | `confirm the path with fs.list or use fs.write intent=create` |
| 이미 존재 (`:1111`) | `re-read the path and choose replace/upsert only when intended` |
| 롤백 실패 (`:1122`) | `inspect the listed paths before retrying or making further mutations` |
| 워크스페이스 외부 (`:1155`) | `use a workspace-relative path` |

### 패치 파싱 안내

`handlers/transaction.rs:218`:

```
patch could not be parsed: {e}. Provide --- a/path and +++ b/path headers,
then use either a numbered hunk like '@@ -0,0 +1,3 @@' or bare '@@' with
enough exact old-side context to match one location. Hunk counts are derived
from the body. Use fs.write with intent=create for a new file.
```

### 낡은 파일 충돌

- `Patch conflict: {path} changed after Capybara read it. Expected {hash}, actual {hash}` (`transaction.rs:98`)
- `{path} changed after Capybara read it (expected {e}, actual {a})` (`cbc-fs/src/atomic.rs:92`)

### 앵커 문제

- `the context matched more than once` (`transaction.rs:1727`)
- `no matching context was found` (`transaction.rs:1740`)
- `exact anchor has {n} candidates` (`edit.rs:1171`)

### 한계

| 자원 | 한계 |
| --- | --- |
| 파일 읽기 | 1 MiB 기본 (`atomic.rs:31`) |
| 아티팩트 | 64 MiB (`cbc-artifacts/src/lib.rs:95`) |
| 캡처 출력 | 10 MiB |
| 프로세스 타임아웃 | 600,000 ms |
| 동시 프로세스 | 4 (`cbc-process/src/limits.rs:28`) |

### 순회 / 심볼릭 링크 거부

- `refusing to follow a symlink during workspace access` (`beneath.rs:659`)
- `refusing to traverse a Windows reparse point` (`:1112`)
- `component '{c}' is a symlink to '{t}' outside the workspace`
- `symlink chain exceeds 32 hops (possible loop)` (`cbc-workspace/src/lib.rs:480`)

---

## 샌드박스 / 프로세스 문제

### fail-closed spawn 거부

`cbc-process/src/lib.rs:510`:

| 상황 | 메시지 | RPC 코드 |
| --- | --- | --- |
| `:514` | `concurrent process limit of {4} reached` | |
| `:535` | `no network-isolation backend is available on {OS}` | `NETWORK_DENIED` |
| `:548` | `no filesystem-isolation backend is available on {OS}` | `SANDBOX_UNAVAILABLE` |
| `:297` | `executable file not found: '{program}': {message}` | `NOT_FOUND` |

요청된 격리를 강제할 수 없으면 **강제 없이 실행하는 대신 spawn을 거부합니다** (`:530`).

### 강등 이유

`cbc-sandbox/src/lib.rs:188-202`:

- `no OS filesystem-isolation or network-deny backend is available on this host`
- `no network-deny backend is available on this host`
- `no OS filesystem-isolation backend is available on this host`
- `requested level exceeds the detected capability`

상태 블록은 정확히 4줄입니다 (`:102`): `Guard:` / `Sandbox: enhanced available`\|`Sandbox: unavailable` / `Network:` / `Project:`. Guard 레이블: `path guard only`, `workspace`, `workspace + OS isolation`.

능력은 **실제 syscall을 실행해 탐지합니다.** 지원을 주장하는 파일을 읽지 않습니다 (`:125-128`).

> seccomp로 차단된 네트워크 호출은 Capybara 오류가 아니라 **EACCES**로 나타납니다 (`enforce.rs:322`). 프로그램이 "Permission denied"를 보고하면 이것이 원인일 수 있습니다.

---

## 세션 저장소 문제

| 메시지 | 위치 |
| --- | --- |
| `database schema version {found} is newer than the supported version {supported}; upgrade cbc or open read-only` | `lib.rs:281` (현재 스키마 **15**) |
| `event chain broken in {s} at sequence {n}: expected prev {e}, found {a}` | `:268` |
| `session {id} is owned by daemon {d} until {t}` | `:341` |
| `refusing to persist credential-like field '{field}' in the session store` | `:285` |

무결성 보고서 세부: `sequence gap: expected {e}, found {a}`, `prev_hash mismatch at {n}`, `event_hash mismatch at {n}: payload was altered` (`:1744-1768`).

저장소는 `<data>/state.sqlite3`, WAL 모드, **`busy_timeout = 5000 ms`** (`:905-911`). 그 이상의 락 경합은 맨 `sqlite error: ...`로 나타납니다.

---

## 데몬 / 통합 문제

| 위치 | 메시지 |
| --- | --- |
| `commands/integrations.ts:112-114` | `Capybara daemon is not running` + `Run capy daemon start first.` |
| `commands/integrations.ts:100-102` | `GitHub workflow already exists` + `Refusing to overwrite it; run capy github doctor instead.` |
| `commands/daemon.ts:123` | `session daemon is enabled but not running; pass --no-daemon to stay in-process` |
| `commands/daemon.ts:129` | `session daemon did not become ready; continuing in-process` |
| `commands/daemon.ts:168` | `daemon process started but the instance lock did not appear` |
| `commands/daemon.ts:235` | `daemon: stopped` / `daemon: stale-lock` |
| `commands/daemon.ts:263` | `daemon is not running; start it with capy daemon start or pass --no-daemon` |

---

## 업데이트 문제

`commands/update.ts`:

| 위치 | 메시지 |
| --- | --- |
| `:40` | `update checks are disabled (updates.check = false or CBC_NO_UPDATE_CHECK)` |
| `:44` | `running from a development checkout; there is nothing to update` |
| `:67` | `update check failed: ${error}` |
| `:73` | `update available: ${version}` |
| `:82` | `capy ${version} is up to date` |

내부: `update check timed out` (`update-check.ts:501`), `GitHub returned status ${status}` (`:336`), `update URL is outside the pinned hosts` (`:111`).

검증 (`cbc-update`): `{path}: sha256 {d} does not match manifest {e}`, `release manifest is not signed`, `release manifest signature does not verify against the pinned release key`, `release manifest carries a signature but no release key is pinned to verify it against` (`lib.rs:121-188`).

> **알려진 문제: 고정 릴리스 키가 아직 `TODO(release)` 플레이스홀더입니다** (`cbc-update/src/lib.rs:70`).

crate는 설계상 아무것도 다운로드하지 않습니다 — TS가 가져오고 Rust가 검증합니다 (`lib.rs:1-8`).

### 업데이트 확인이 건너뛰어지는 이유

`updateStartupGate` (`update-check.ts:260-276`)가 이름 있는 이유와 함께 거부합니다: `updates.check is disabled`, `non-interactive run`, `stdin is not a TTY`, `CI environment` (`CI=true` 또는 `GITHUB_ACTIONS=true`), `development checkout`, `current version is not semver`.

---

## 진단 명령

권위 있는 레지스트리는 `apps/cbc/src/command-spec.ts`입니다.

> **`capy mcp doctor`와 `capy lsp` 명령은 존재하지 않습니다.** `mcp doctor`는 주석에만 나타나며 (`mcp-client/src/oauth.ts:294`, `protocol.ts:63`) Rust 바이너리에도 `doctor` 서브커맨드가 없습니다.

| 명령 | 동작 | 종료 코드 |
| --- | --- | --- |
| `capy clients list\|doctor` | JSON. 실행 중인 데몬 필요. `list`는 항상 `inventory: {state: "unsupported", reason: "this daemon does not expose other client identities yet"}` 보고 | 0 |
| `capy integration doctor [vscode\|acp\|github]` | JSON `checks[]`. `acp`는 `session.attach`+`turn.submit`+`events.replay` 모두 available일 때만 `ready`. `vscode`는 앞의 둘 + `richDiff`/`inlineApprovals`/`reconnect` 보고. `github`는 워크플로 파일 읽기 | **항상 0** — 상태는 JSON에만 |
| `capy github install\|doctor` | `doctor`는 데몬 불필요. `workflowHealth`는 `nevrixo/capybara-code-action@v1`, `permission-policy:`, `pull-requests: write` 셋 다 필요, 아니면 `invalid` | 0 |
| **`capy package doctor [id]`** | **종료 코드가 의미 있는 유일한 doctor.** 불변 캐시에서 각 패키지를 재해석해 `manifest.id`/`version`/`packageDigest`/`manifestDigest`를 잠금 파일과 비교 → `${id}: immutable cache does not match lockfile` | `report.ok ? 0 : 1` |
| `capy skills doctor [--json]` | 섹션: 헤더(cwd, worktree, 마지막 스캔, 소요, 리비전, 다이제스트), **Roots**(`+` 스캔 / `-` 없음 / `!` 기타), **Rejected/warnings**(`!` 오류, `~` 경고, `path:line: field: message`), **Shadowed**, **Canonical duplicates**. 비어 있으면 `- none` | 0 |

`capy skills doctor`의 모든 출력은 `safe()`를 통과해 제어 문자를 `?`로 바꿉니다 (`skill-diagnostics.ts:160`) — 터미널 인젝션 방어입니다.

### 핸드셰이크 없는 사전 점검

```bash
cbc-runtime --capabilities
```

`runtimeVersion`, `protocolVersion`, `platform`, `arch`, `sandbox`, `networkDeny`, `maxFrameBytes`를 JSON으로 출력합니다 (`main.rs:26-42`). 패키징 검사가 버전을 단정할 수 있도록 **의도적으로 핸드셰이크가 없습니다.**

### 인접한 유용한 명령

`capy skills validate <path> [--strict]`, `capy trust --show-diff`, `capy daemon status|logs`, `capy plugin inspect <id>`, `capy package verify`, `capy auth status`.

---

## 로깅과 디버그

### 주요 스위치

**`CBC_DEBUG=1`**이 두 가지를 합니다.

1. `CliError`가 아닌 실패에 스택 트레이스 출력 (`router.ts:166`)
2. 사이드카 stderr를 `runtime: <line>`으로 에코 (`commands/context.ts:239`)

### 기타 환경 변수

| 변수 | 효과 |
| --- | --- |
| `CBC_TUI_PERF=1` | `[CBC_TUI_PERF] {json}`을 stderr로 (`tui-perf.ts:103`) |
| `CBC_NO_UPDATE_CHECK` | 업데이트 확인 비활성 |
| `CBC_DAEMON=0\|false` | 임베디드 모드 강제 |
| `CBC_RUNTIME_BINARY` | 사이드카 경로 지정 |
| `CBC_MOCK_PROVIDER` | 모의 프로바이더 |
| `CBC_MODEL` / `CBC_REASONING_EFFORT` / `CBC_PERMISSION_MODE` | 설정 오버라이드 |
| `CBC_REDUCED_MOTION` | 애니메이션 감소 |
| `CAPY_DAEMON_RUNTIME_DIR` | 데몬 런타임 디렉터리 |
| `CBC_TEST_DISABLE_SECCOMP` / `_NETNS` / `_LANDLOCK` | **테스트 전용** (`cbc-sandbox/src/enforce.rs:24-26`) |

마지막 항목은 명시할 가치가 있습니다 — 이를 설정한 사용자는 fail-closed 거부를 보게 됩니다.

표준 변수: `NO_COLOR` (설계상 `FORCE_COLOR`보다 우선 — `theme.ts:175`), `FORCE_COLOR`, `TERM`, `COLORTERM`, `TERM_PROGRAM`, `WT_SESSION`, `CI`, `LANG`/`LC_ALL`, `OPENAI_*`, `CARGO_TARGET_DIR`.

### 경로

`host.ts:124-190`. `CAPYBARA_HOME`, `CAPYBARA_CONFIG`, `CAPYBARA_DATA_DIR`, `CAPYBARA_CACHE_DIR`, `CAPYBARA_LOG_DIR`로 재정의 가능합니다.

| 역할 | Linux/macOS | Windows |
| --- | --- | --- |
| config | `$XDG_CONFIG_HOME/capybara` 또는 `~/.config/capybara` | `%APPDATA%\capybara` |
| data | `$XDG_DATA_HOME/capybara` 또는 `~/.local/share/capybara` | `%LOCALAPPDATA%\capybara\data` |
| cache | `$XDG_CACHE_HOME/capybara` 또는 `~/.cache/capybara` | `%LOCALAPPDATA%\capybara\cache` |
| **logs** | `$XDG_STATE_HOME/capybara/logs` 또는 `~/.local/state/capybara/logs` | `<cache>\logs` |

추가로 `<config>/config.toml`, `<data>/sessions`, `<data>/artifacts`, `<data>/trust.json`, `<data>/state.sqlite3`.

모든 경로는 신뢰 레코드가 이식 가능하도록 **모든 플랫폼에서 슬래시로 정규화됩니다** (`:271-273`).

### 데몬 로그

`<runtimeDir>/daemon.log` (`commands/daemon.ts:52`). `capy daemon logs`는 **마지막 100줄**을 보여줍니다 (`:251`).

### 구조화된 로깅은 없습니다

**어떤 crate도 `tracing`을 의존하지 않습니다.** 프로덕션 `eprintln!` 지점은 5개뿐이며 모두 cbc-runtime에 있습니다.

- `cbc-runtime: fatal frame error: {e}` (`main.rs:180`)
- `warning: could not persist migrated trust store: {e}` (`server.rs:866`)
- `cbc-runtime: recovered {n} interrupted transaction(s) from a previous crash: {report}` (`:952`)
- `cbc-runtime: transaction recovery failed: {e}` (`:961`)
- `--help`

그 외 진단은 알림으로 이동합니다: `process.output`, `process.exited`, `process.limit_warning`, `runtime.heartbeat`, 그리고 `{"reason":"frame_decode_failed","detail":...}`를 담은 `runtime.fatal`.

### 버그 리포트 수집

```bash
CBC_DEBUG=1 capy … 2>&1 | tee capy-debug.log
capy daemon logs
cbc-runtime --capabilities
capy version
capy integration doctor    # 해당되는 doctor JSON
```

**로그 회전/보존, 텔레메트리/분석, 크래시 리포트 번들 명령은 없습니다.** `catch_unwind`/`set_hook`도 없어 poison된 락은 락 이름과 함께 그냥 패닉합니다.

---

## 무엇이 마스킹되는가 (공유 전 확인)

`crates/cbc-redaction`. 플레이스홀더는 **`***REDACTED***`**입니다 (`secrets.rs:13`).

세 가지 신호 (`:3-9`): 정확히 알려진 리터럴과 고신뢰 형식은 **무조건**, 엔트로피는 문맥이 필요합니다.

### 탐지되는 종류

`SecretKind` (`:66-96`):

| 종류 | 규칙 |
| --- | --- |
| `known-literal` | 등록된 정확한 리터럴 |
| `openai-key` | `sk-`/`rk-`, ≥20자 |
| `provider-key` | `anthropic-`, `sk_live_`, `sk_test_`, `pk_live_`, `hf_`, `gsk_`, `cbc_pat_`, ≥25 |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`, ≥30 |
| `slack-token` | `xox`, ≥20 |
| `google-api-key` | `AIza`, ≥35 |
| `aws-access-key-id` | `AKIA`/`ASIA`, 정확히 20 |
| `jwt` | `eyJ` + 세 세그먼트 각 ≥8 |
| `private-key-block` | `-----BEGIN … PRIVATE KEY-----`부터 END 마커까지 전체 블록 |
| `basic-auth-url` | `scheme://user:pass@host`의 비밀번호. **사용자 이름은 보존되고** 비밀번호만 교체 (`:420-431`) |
| `contextual-high-entropy` | 아래 규칙 |

### 엔트로피 규칙 — 사용자가 반드시 이해해야 할 부분

토큰은 다음 **셋 다** 만족할 때만 마스킹됩니다 (`:386-400`):

1. 길이 ≥20
2. Shannon 엔트로피 ≥3.4
3. 앞선 48자 안에 문맥 키(`token`, `secret`, `password`, `apikey`, `authorization`, `bearer`, `credential`, `signature` 등 약 20개) 중 하나가 나타남

따라서 `api_key = <랜덤>`은 마스킹되지만 **맨 고엔트로피 문자열은 마스킹되지 않습니다.**

### 환경 변수

**이름**에 다음이 포함되면 값을 비밀로 취급합니다 (`:21-39`): `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `APIKEY`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CLIENT_SECRET`, `REFRESH_TOKEN`, `SESSION_KEY`, `CREDENTIAL`, `AUTH`, `BEARER`, `PASSPHRASE`, `SIGNING_KEY`, `ENCRYPTION_KEY`.

8자 미만 리터럴은 정확 매칭 대상이 아닙니다 (`:17`).

### 순서가 중요합니다

`safe_for_display`는 **터미널 이스케이프를 먼저 정화한 뒤 마스킹합니다** (`lib.rs:22-25`). 적대적 프로세스가 커서 이동으로 비밀을 쪼개 탐지를 회피할 수 없습니다 — 정확히 그 케이스에 대한 테스트가 있습니다 (`:38-47`). `safe_for_pty_view`는 안전한 색상은 유지하되 여전히 마스킹합니다.

### 남는 위험 — 공유 전에 알아야 할 것

- **파일 경로와 홈 디렉터리는 마스킹되지 않습니다.**
- **이메일 주소는 탐지 종류가 아닙니다.**
- 근처에 키워드가 없는 맨 고엔트로피 비밀은 살아남습니다.
- 짧은 비밀(8자 미만, 대부분 형식 규칙에서는 20자 미만)은 살아남습니다.
- **이 crate는 Rust 평면 전용입니다.** TypeScript 측 출력(`CBC_DEBUG` 스택 트레이스와 데몬 로그 포함)이 이를 통과한다는 증거가 없습니다.

**결론: 마스킹을 절대적으로 신뢰하기보다 공유 전에 로그를 훑어보십시오.**

---

## 복구 경로

### 실패보다 격하 — 데몬

시작하지 못하거나 **8000 ms** 안에 준비되지 않으면 CLI가 경고하고 in-process로 계속합니다 (`commands/daemon.ts:127-131`, `:166-170`). `--no-daemon`이나 `CBC_DAEMON=0`이 임베디드를 강제합니다.

pid가 죽은 낡은 락은 인수될 수 있고, 다른 사용자가 소유한 락은 거부됩니다. `capy daemon status`가 이 상태를 `daemon: stale-lock`으로 명명합니다.

### 크래시 복구

`initialize` 시 런타임이 내구 상태 `["open","conflicted","recovery_required","applying"]`를 스캔하고 중단된 트랜잭션을 복원하며 `recovered {n} interrupted transaction(s) from a previous crash`를 출력합니다 (`handlers/transaction.rs:838`, `server.rs:282`).

런타임이 initialized로 표시되기 **전에** 보수적인 Build 측 상태로 실행됩니다 (`:933`). 복구 실패는 Plan 모드를 차단하지만 Build는 차단하지 않습니다.

`RollbackFailed`는 taxonomy `RECOVERY_REQUIRED`를 담고 수동 확인이 필요한 경로를 나열합니다.

### 업데이트 복구

CLI가 **42**로 종료하고 런처가 임시 요청 파일을 읽어 감지된 매니저로 정확한 버전을 설치합니다 (`release-launcher.cjs:224-243`).

임시 디렉터리를 만들 수 없으면 핸드오프를 건너뛰고 정확한 수동 안내를 출력합니다 (`:203-205`, `update-prompt.ts:81-94`): `npm install -g capybara-code@<v>`, `bun install -g capybara-code@<v>`, 또는 "verify SHA256SUMS.txt"와 함께 아카이브 URL.

업데이트 확인 실패는 시작을 절대 막지 않으며, 캐시 쓰기 실패는 삼켜집니다 (`update-check.ts:389`).

### 재인증 / 재신뢰 / 캐시 복구

| 목적 | 명령 |
| --- | --- |
| 계정 재인증 | `capy auth status` → `capy auth login` |
| API 키 | `capy auth api` 또는 `OPENAI_API_KEY` |
| 재신뢰 | `capy trust` (CI는 `capy trust --show-diff`) |
| 드리프트 탐지 | `capy package doctor` |
| 재구성 | `capy bootstrap [--frozen] [--offline]` |
| 활성화 없이 검사 | `capy package verify` |

### 레거시 정리 스크립트

둘 다 기본 dry-run이며, 레거시 설치를 긍정적으로 식별하지 못하면 동작을 거부합니다.

**`scripts/cleanup-legacy-capy-wsl.sh [--apply]`** — `bin/capy`, `libexec/cbc-runtime`, `bin/main.js.map`, `libexec/cbc-runtime.bak-20260812`, `share/capybara`가 **모두** 존재할 때만 `~/.local/lib/capybara-code`를 제거하고, 아니면 `refusing $legacy_root: ...`로 종료합니다 (`:41-51`). `.bashrc`에서 정확히 세 줄을 제거합니다 — 레거시 PATH export와 `/mnt/*/Capybara-Code`를 가리키는 두 형태의 `alias capy=` (`:18-20`).

**`scripts/cleanup-legacy-capy.ps1 [-Apply]`** — 검증된 `capy`/`capy.cmd` shim을 `%USERPROFILE%\.bun\bin`에서(체크아웃 소스를 참조할 때만), `%LOCALAPPDATA%\Programs\capybara-code`를(`manifest.json`이 `capybara-code-*`를 명명하고 `bin/capy.exe`를 나열할 때만), 그리고 대응하는 사용자 PATH 세그먼트를 제거합니다. Bun과 WSL interop은 건드리지 않습니다.

> **두 스크립트 모두 다음으로 끝납니다:** `Safety note: /usr/bin/cbc is the Coin-OR solver and is intentionally untouched.`
>
> 이 이름 충돌은 별도로 알아둘 가치가 있습니다 — `cbc`를 입력하는 사용자는 선형 계획법 솔버를 호출하고 있을 수 있습니다.

### 취소는 오류가 아니라 상태입니다

종료 코드 7입니다. 업데이트 프롬프트에서 Esc는 세션 한정 건너뛰기이며 프로세스를 종료하지 않습니다 (`update-prompt.ts:75-77`) — 신뢰의 "No, exit"과 다릅니다.

---

## 플랫폼별 함정

### glibc는 빌드 시점에만 강제됩니다

`scripts/build-runtime.ts`:

- `:74` `could not detect glibc while enforcing release baseline ${b}`
- `:78` `release host glibc ${d} is newer than supported baseline ${b}; build the Linux artifact in the pinned baseline container`
- `:172` `cbc-runtime requires GLIBC_${n}, newer than supported baseline ${b}`

비교는 숫자 기반이므로 2.9가 2.31보다 "새롭지" 않습니다 (`:42`).

> **결과: 너무 오래된 glibc에서는 친절한 메시지가 아니라 동적 로더 자체의 오류를 봅니다.**

`dist/cbc-runtime-linux-glibc236/`가 디스크에 존재하지만 **소스 트리에서 `glibc236`을 참조하는 것이 없습니다** — 고아 아티팩트이며 런타임 선택 메커니즘이 아닙니다.

### npm + Bun shim 충돌

`README.md:67-68`: "전역 `capy`에는 npm 또는 Bun 중 하나만 쓰십시오. shim이 충돌합니다." 설치에 쓴 매니저로 업그레이드하십시오. 런처가 업데이트 핸드오프용으로 매니저를 감지하고 (`release-launcher.cjs:196`) 프롬프트가 이를 명명합니다.

### WSL

세 지점:

1. 사이드카 힌트가 WSL 사용자에게 Linux rustc로 빌드해 바이너리가 `.exe`가 아니게 하라고 안내합니다 (`runtime.ts:610`).
2. `CARGO_TARGET_DIR`가 존중되므로 WSL 빌드가 아티팩트를 `/mnt/c` 밖에 두고 Windows `target/`과 충돌하지 않습니다 (`host.ts:232-238`).
3. `README.md:76`: `/mnt/c/...` 아래 Windows 실행 파일이 아니라 네이티브 Linux `node`/`npm`/`bun`을 쓰십시오.

경로 가드도 네이티브 Windows와 WSL `/mnt/<drive>` 표기를 의도적으로 좁게 연결합니다 (`cbc-workspace/src/lib.rs:335`).

### Windows

- `.exe` 접미사 (`host.ts:209`)
- unix 소켓 대신 명명 파이프 (`daemon.ts:269`)
- `file://` URL에서 프로젝트 루트를 도출할 때 드라이브 문자 보정 (`:226`)
- **예약 장치 이름은 모든 플랫폼에서 거부됩니다** — 크로스 플랫폼 체크아웃이 사용 불가가 되지 않도록 (`cbc-workspace/src/lib.rs:359`)
- reparse point 거부
- `PathTooLong`에 action `pass allowLongPath with a long-path prefix`
- Windows 터미널이 `LANG`을 생략하므로 `WT_SESSION`/네이티브 Windows TTY를 truecolor+unicode로 취급 (`theme.ts:187-221`)
- MSVC `link.exe` unwind 테이블 실패를 `rust-lld.exe` 선호로 우회 (`build-runtime.ts:84-88`)

### TTY 부재

렌더가 `plain`으로 격하되며 이유는 `not a terminal` 또는 `native renderer unavailable`입니다 (`output.ts`). 키 스트림이 inert가 됩니다 (`bun-host.ts:392`). `NO_COLOR`는 아이콘/레이블/들여쓰기로 의미를 유지합니다 (`theme.ts:8-12`). 업데이트 프롬프트는 억제되고 `capy trust`는 hard-fail합니다.

### 외부 실행 파일 누락

LSP 서버는 기본값이 `install '${server.command}' and make it available on PATH`인 힌트를 담습니다 (`lsp-host.ts:68`). 기본 LSP 타임아웃은 **15,000 ms** (`:70`), MCP eager-activation 시작 예산은 **25 ms** (`mcp-host.ts:50`)입니다.

런타임은 실행 파일 가용성을 boolean으로만 보고하고 PATH 값을 노출하지 않습니다 (`runtime.ts:670-680`).

### 프록시는 지원되지 않습니다

`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`를 `apps packages crates scripts` 전체에서 grep한 결과 **적중 0**입니다. 유일한 매치는 MCP 헤더 거부 목록의 `"proxy-authorization"`입니다 (`mcp-client/src/transport.ts:411`).

기업 프록시나 TLS 검사 미들박스 뒤에서는 업데이트 확인과 프로바이더 호출이 프록시 관련 안내 없이 원시 네트워크 오류로 실패합니다. **알려진 제약으로 취급하십시오.**

---

## 알려진 진단 취약점

1. **마이그레이션 체크섬 드리프트가 쓸모없는 메시지를 냅니다** — 변조된 마이그레이션이 체크섬이나 어느 마이그레이션인지 언급 없이 일반 `sqlite error: ...`로 나타납니다 (`migrations.rs:859`).
2. **spawn 시 permission denied가 `PERMISSION_DENIED`가 아니라 `INTERNAL_ERROR`입니다** — `classify_spawn_error`에 EACCES 분기가 없습니다. 파일시스템 경로만 재분류하며, 그것도 `"permission denied"`/`"access is denied"`에 대한 **로케일 의존 문자열 매칭**입니다 (`server.rs:1194`).
3. **RPC 코드 5개가 정의되었으나 발행되지 않습니다** (`TIMEOUT`, `CANCELLED`, `PROCESS_EXIT_NONZERO`, `LEASE_VIOLATION`, `RESOURCE_LIMIT`). 앞의 셋은 **성공한** 응답의 taxonomy 문자열로 도착합니다.
4. **알 수 없는 플래그로 `cbc-runtime`을 실행하면 조용히 RPC 루프를 시작합니다** (`main.rs:55`) — stdin을 기다리며 hang한 것처럼 보입니다.
5. **`capy update --check`의 종료 코드 2가 사용법 오류 2와 충돌합니다.**
6. **`SchemaTooNew`가 `read_only = true`를 설정하지만 `open()`이 `?`로 버립니다** (`lib.rs:887`) — 문서화된 읽기 전용 폴백이 `open`으로는 도달할 수 없습니다.
7. **릴리스 서명 키가 `TODO(release)` 플레이스홀더입니다** (`cbc-update/src/lib.rs:70`).
8. **`git_error`가 중복되어 있습니다** — `handlers/git.rs`와 `handlers/worktree.rs`가 같은 `GitError` 변형에 서로 다른 코드와 메시지를 부여합니다.
9. **잠긴 키체인이 TS 측에서 "자격 증명 없음"과 구분되지 않습니다.**
10. **프록시 지원이 전혀 없고, 로그 회전이나 텔레메트리도 없습니다.**
