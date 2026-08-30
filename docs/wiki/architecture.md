# 아키텍처

## 큰 그림

Capybara Code는 두 개의 언어 평면으로 나뉩니다.

```
┌─────────────────────────────────────────────────────────────┐
│  TypeScript (Bun 컴파일 단일 바이너리)                        │
│                                                             │
│  apps/cbc          CLI · TUI · 부트스트랩 · 도구 디스패치      │
│  packages/*        28개 도메인 패키지                         │
│                                                             │
│  카탈로그와 의도(intent)를 소유                                │
└───────────────────────┬─────────────────────────────────────┘
                        │ 길이 접두사 JSON-RPC 2.0 (stdio)
┌───────────────────────▼─────────────────────────────────────┐
│  Rust 사이드카 (libexec/cbc-runtime)                         │
│                                                             │
│  crates/*          13개 crate                                │
│                                                             │
│  실행과 강한 경계를 소유                                       │
└─────────────────────────────────────────────────────────────┘
```

`packages/tool-registry/src/catalog.ts:1-8`이 이 분담을 명시합니다. `apps/cbc/src/tools.ts:1-12`는 TS 측 어떤 코드도 파일시스템을 직접 만지거나 프로세스를 spawn하지 않는다고 확인합니다 — 모든 효과는 열거된 RPC 표면을 통과하며 런타임이 재검증합니다.

이 경계가 `scripts/check-no-codex-runtime.ts`의 정직한 한계 진술의 근거이기도 합니다: 런타임에 조립되는 spawn 이름은 정적으로 잡을 수 없지만, `apps/cbc`가 OS에 도달하는 유일한 경로가 열거된 RPC라는 구조적 완화가 있습니다.

## 프로세스 지형

세 개의 실행 파일이 있습니다.

| 실행 파일 | 역할 | 위치 |
| --- | --- | --- |
| `bin/capy` | CLI + TUI. Bun `--compile` 산출물 | `apps/cbc/src/main.ts` |
| `libexec/cbc-runtime` | Rust 실행 사이드카 | `crates/cbc-runtime` |
| `libexec/capy-daemon` | 세션 데몬 | `apps/capy-daemon/src/main.ts` |

사이드카와 데몬은 **PATH를 절대 보지 않습니다.** 런처 기준 상대 경로로만 해석됩니다 (`apps/cbc/src/host.ts:167-175`, `apps/cbc/src/commands/daemon.ts:69-79`).

### 사이드카 spawn

`apps/cbc/src/runtime.ts:117-124`:

```
Bun.spawn({
  cmd: [binary, "--workspace", ws, "--data-dir", dataDir],
  cwd: workspace,
  stdin/stdout/stderr: "pipe",
  env: runtimeSidecarEnvironment(...)
})
```

환경 변수는 허용 목록으로 제한됩니다 (`RUNTIME_ENV_ALLOWLIST`, `runtime.ts:73-87`): `HOME`, `LANG`, `LC_ALL`, `NO_COLOR`, `PATH`, `PATHEXT`, `SYSTEMROOT`, `TEMP`, `TERM`, `TMPDIR`, `USERPROFILE`, `WINDIR`. 나머지는 모두 제거되므로 프로바이더 비밀이 `/proc/<pid>/environ`에서 읽히지 않습니다.

바이너리 탐색 순서 (`host.ts:205-230`): `CBC_RUNTIME_BINARY` → `<parent(execDir)>/libexec/cbc-runtime[.exe]` → `execDir/name` → `target/debug/name` → `target/release/name`. 없으면 시도한 모든 경로를 나열하는 CliError를 던집니다.

### 전송

**4바이트 부호 없는 빅엔디언 길이 접두사 + UTF-8 JSON.** 헤더도 구분자도 없습니다 (`crates/cbc-protocol/src/frame.rs:1-11`).

- Rust: `LENGTH_PREFIX_BYTES = 4`, `MAX_FRAME_BYTES = 8 MiB` (`limits.rs:7,23`). 과대 선언 길이는 **할당 전에** 거부됩니다 (`frame.rs:113-119`).
- TS 미러: `encodeFrame`이 `DataView.setUint32(0, len, false)`, 증분 `FrameDecoder.drain()` (`packages/protocol-ts/src/rpc.ts:553-613`).
- 프레임마다 개별 flush (`frame.rs:87-92`).

봉투: 요청 `{jsonrpc:"2.0", id, method, params?}`, 응답 `{jsonrpc, id, result?|error?}` (`result`/`error`는 없으면 생략), 알림 `{jsonrpc, method, params}`.

오류는 `{code, message, data?}`를 담고 `data.taxonomy`가 안정적인 문자열 분류입니다. 코드는 표준 −32700/−32600/−32601/−32602/−32603 + −32000…−32019 (`jsonrpc.rs:15-41`), `rpc.ts:424-450`에 정확히 미러링됩니다.

**진입 방어:** `parse_request`가 핸들러가 값을 보기 **전에** `jsonrpc="2.0"`, 비어 있지 않은 method, `MAX_JSON_DEPTH=64`, `MAX_STRING_BYTES=4 MiB`를 강제합니다 (`jsonrpc.rs:230-286`).

### 핸드셰이크

`runtime.initialize` 파라미터 (`handshake.rs:7-39`): `protocolVersion`, `clientVersion`, `workspace`, `capabilities{pty, eventJournal, credentialLease, artifactHandles}`, 선택적 `dataDir`, `sandboxLevel`, `networkForShell`, `interactionMode`, `capabilityIssuerToken`.

결과 (`handshake.rs:56-83`): `protocolVersion`, `runtimeVersion`, `workspaceId`, `capabilities{enhancedSandbox, keychain, pty, git, sandboxLevel, sandboxBackends, networkDeny, platform, arch, maxFrameBytes, artifactStore, eventJournal}`.

`PROTOCOL_VERSION = "1.0"`이며 **major 불일치는 거부됩니다** (`limits.rs:36`, `:62-64`; 서버 `server.rs:817-837`, 클라이언트 `client.ts:203-208` 양쪽에서 강제).

initialize가 하는 일 (`server.rs:839-974`): 워크스페이스 열기 → 데이터 디렉터리 생성 → `trust.json` 로드/마이그레이션 → git/keychain/session-store/artifacts 열기 → 샌드박스 레벨 clamp → `recover_interrupted_transactions` → `initialized` 설정. `workspaceId = "ws_" + workspace.fingerprint()` (`server.rs:902`).

### 동시성과 생존성

- stdin 리더 루프. shutdown이 아닌 모든 요청은 자체 스레드에서 실행되며 `req:<id>`로 등록된 `CancelToken`을 가집니다 (`main.rs:216-269`).
- `MAX_OUTSTANDING_REQUESTS = 128`, 초과 시 `TOO_MANY_REQUESTS` (`main.rs:197-214`).
- 하트비트 스레드가 5초마다 `uptimeMs`/`activeProcesses`/`openTransactions`를 보냅니다 (`main.rs:144-162`). 클라이언트는 15초에 degraded, 30초에 fatal로 표시합니다 (`client.ts:491-503`).
- **잘못된 프레임은 치명적입니다** — 다음 경계를 알 수 없으므로 런타임이 `runtime.fatal`을 발행하고 종료 코드 10으로 끝냅니다 (`main.rs:169-182`).
- 종료 시 `supervisor.terminate_all(1_500)`, `runtime.shutdown`은 1_000을 씁니다.

클라이언트 측: 단조 증가 정수 id, `#pending` 맵, 요청당 기본 120초 타임아웃, `maxOutstandingRequests`에서 거부하는 백프레셔, `AbortSignal` → `runtime.cancel {requestId}` 전송(취소 자체는 취소하지 않음). stderr는 줄 단위로 분리되어 `onStderr`로 라우팅되며 **타임라인에 절대 끼어들지 않습니다** (`client.ts:423-447`).

## 프로토콜 메서드

**요청 75개, 알림 11개.** 정확한 문자열은 `crates/cbc-protocol/src/methods.rs:8-99`에 있고 `packages/protocol-ts/src/rpc.ts:298-391`이 동일하게 미러링합니다. 디스패처의 75개 match arm이 목록과 정확히 집합 동등입니다.

그룹별 요약:

| 그룹 | 메서드 |
| --- | --- |
| runtime (5) | `initialize`, `capabilities`, `shutdown`, `cancel`, `capability.issue` |
| workspace (7) | `inspect`, `mode.write`, `trust.read/write/list/set/remove` |
| fs (16) | `list`, `glob`, `search`, `read`, `read_many`, `fingerprint`, `edit.preview`, `edit`, `transaction.begin`, `patch`, `write`, `move`, `delete`, `transaction.commit`, `transaction.rollback`, `transaction.rollback_to_checkpoint` |
| process (5) | `run`, `start`, `input`, `stop`, `status` |
| git (5) | `status`, `diff`, `log`, `show`, `checkpoint` |
| worktree (7) | `create`, `list`, `inspect`, `status`, `diff`, `remove`, `reconcile` + `merge.preview` |
| credential (3) | `store`, `lease`, `delete` |
| session (11) | `open`, `append`, `snapshot`, `load`, `list`, `resolve`, `set_status`, `export`, `fork`, `delete` |
| memory (7) | `search`, `remember`, `list`, `get`, `forget`, `resolve_contest`, `verify` |
| app (5) | `client.upsert`, `subscription.create/ack/state/replay` |
| artifact (3) | `create`, `read`, `delete` |
| update (1) | `verify` |

**변경 메서드 10개** (`methods.rs:118-132`): `fs.patch`, `fs.write`, `fs.move`, `fs.delete`, `fs.edit`, `fs.transaction.rollback_to_checkpoint`, `git.checkpoint`, `worktree.create`, `worktree.remove`, `worktree.reconcile`.

**pre-initialize 2개**: `runtime.initialize`, `runtime.shutdown`.

`schemas/protocol/rpc.schema.json`의 `$defs.requestMethod`가 75개, `notificationMethod`가 11개이며 `$defs.limits`가 8388608/64/4194304/1048576/128/4를 고정합니다 — Rust와 일치합니다. 이 3자 일치는 `scripts/check-protocol-drift.ts`가 검증합니다.

### 알려진 프로토콜 드리프트

1. **미선언 알림.** `main.rs:79-87`이 `"lsp.stdio.output"`과 `"mcp.stdio.output"`을 발행하지만 둘 다 `NOTIFICATION_METHODS`에 없습니다. `Outbound::notify`에 `debug_assert!(is_known_notification(method))`가 있어 (`server.rs:641-644`) **디버그 빌드는 MCP/LSP stdio 자식이 stdout에 쓰는 순간 패닉합니다.** 릴리스 빌드는 assert가 컴파일되지 않아 동작합니다. TS 측은 둘을 소비하므로 와이어 동작은 의도된 것이고, 레지스트리와 assert가 잘못된 쪽입니다.
2. **선언되었으나 발행되지 않는 알림 6개.** `workspace.changed`, `transaction.conflict`, `journal.committed`, `artifact.spilled`, `sandbox.degraded`, `runtime.warning`은 Rust에 발행 지점이 **하나도 없습니다.** 실제로 전송되는 것은 `runtime.heartbeat`, `process.output`, `process.exited`, `process.limit_warning`, `runtime.fatal` 뿐입니다. `sandbox.degraded`는 RT-006 강등이 실제로 계산되는데도 죽어 있습니다.
3. **`networkDeny`가 핸드셰이크 스키마에 없습니다.** Rust가 직렬화하고 TS가 요구하지만, `handshake.schema.json`의 `runtimeCapabilities`가 `additionalProperties: false`로 11개 속성만 나열하고 이를 빼먹었습니다 — 실제 initialize 결과가 자기 스키마 검증에 실패합니다.

## 레이어 구조 (TS)

### 앱

| 경로 | 역할 |
| --- | --- |
| `apps/cbc` | CLI 진입점, 인자 파싱, 라우팅, TUI, 부트스트랩, 도구 실행기, 승인 브로커, MCP/LSP 호스트 |
| `apps/capy-daemon` | 세션 데몬 — 인스턴스 락, 로컬 전송, 워크스페이스 슈퍼바이저, 세션 액터, 이벤트 허브 |
| `apps/capy-vscode` | VS Code 확장 (`nevrixo.capybara-code-vscode`) |

### 도메인 패키지 (28개)

핵심 흐름 순서로 정리하면:

**요청 조립**
- `config-schema` — 설정 스키마, 병합, 프로젝트 상한, 키 상태 레지스트리
- `context-engine` — 컨텍스트 IR, 결정적 컴파일러, 증거 원장, 발췌 저장소, 선택 스코어러, 컨텍스트 연산
- `inference-domain` — 모델 서술자, 소프트 컨텍스트 예산
- `provider-openai` — Responses API 클라이언트, 능력 매니페스트, PTC 게이트, 재시도 정책

**실행**
- `agent-kernel` — 턴 루프, 프롬프트 조립, 관찰 정규화, 검증, 위험 평가
- `tool-registry` — 66개 도구 카탈로그, 탐색 랭킹, 스케줄러, 실행 그래프, 복구 결정
- `permissions` — 권한 모드/프리셋, 정책 평가, 명령 분류기
- `edit-domain` — 앵커/범위 편집 계획, preflight, 충돌 감지
- `lsp-domain` — 진단 정규화 (순수, 파일시스템/프로세스 권한 없음)
- `mcp-client` — MCP 전송, 카탈로그, OAuth, 결과 정규화

**오케스트레이션**
- `subagents` — 7개 역할, 커스텀 에이전트, 스케줄러, 위임 코디네이터, 예산 원장, 그래프 권한
- `agent-graph-domain` — 순수 그래프 리듀서, 사이클 감지
- `session-domain` — 세션 저널, 리듀서, 압축, 영속화
- `memory-service` — 워크스페이스 격리 메모리 파사드
- `skills` — 스킬 매니페스트 파서, 레지스트리, 내장 스킬

**표면**
- `app-protocol` — App Protocol 메서드/능력/명령 봉투
- `app-server` — 전송 독립 JSON-RPC 디스패치 코어
- `acp-adapter` — ACP v1 NDJSON 브리지
- `protocol-ts` — Rust 프로토콜의 TS 측
- `sdk-typescript` / `sdk-python` — 클라이언트 SDK
- `plugin-sdk` — 플러그인 작성자 API, WASI 아이솔레이트
- `package-manager` — 패키지 해석/검증/설치
- `tui-components` — 순수 렌더링 컴포넌트 (블록, 크롬, 오버레이, 완성, 타임라인)
- `github-action` — GitHub Actions 트리거 승인과 쓰기 코디네이터
- `integration-core` / `integration-conformance` — 통합 공통 로직과 적합성 스위트
- `evals` — 채점 전용 (실행 없음)
- `tool-registry`, `edit-domain` 등은 위에 포함

### Rust crate (13개)

| Crate | 역할 |
| --- | --- |
| `cbc-protocol` | 버전 관리된 RPC 경계 — 프레임 코덱, JSON-RPC, 한계 상수, 메서드 표 |
| `cbc-runtime` | 사이드카 바이너리. 상태 · 디스패처 · 핸들러 · 능력 영수증 |
| `cbc-sandbox` | 능력 탐지 **및** 강제 (Landlock, seccomp, netns) |
| `cbc-process` | 프로세스/PTY 감독, rlimit, 종료 의미론 |
| `cbc-fs` | 원자적 파일시스템 연산, 낙관적 동시성, 목록/검색, 경로 가드 |
| `cbc-patch` | 구조화된 패치 파싱, 크래시 안전 변경 트랜잭션 |
| `cbc-git` | Git 읽기 서비스, status/diff 정규화, 안전 체크포인트, 워크트리 |
| `cbc-keychain` | OS 키체인 접근, 자격 증명 리스, 암호화 파일 폴백 |
| `cbc-session-store` | 이벤트 소싱 세션 저널 (SQLite WAL + 무결성 체인) |
| `cbc-artifacts` | 내용 주소 아티팩트 저장소, 다이제스트 검증, 보존 클래스 |
| `cbc-update` | 릴리스 매니페스트 체크섬·서명 검증 |
| `cbc-redaction` | 비밀 탐지·마스킹, 터미널 제어 시퀀스 정화 |
| `cbc-workspace` | 정규 워크스페이스 경계, 경로 가드, 신뢰 레코드 |

주목할 의존성 사실:

- `cbc-git`은 `git2`/`libgit2`가 **없습니다.** `GitError::CommandFailed{argv, stderr}`가 `git` 바이너리를 shell out한다는 증거입니다.
- `cbc-redaction`은 `regex`가 **없습니다.** 매칭이 손으로 작성되었습니다.
- `cbc-keychain`은 `ed25519-dalek`이 **없습니다.** 서명은 `cbc-update`에만 있습니다.
- `cbc-session-store`는 `rusqlite`를 **bundled** 기능으로 씁니다 — 시스템 SQLite에 의존하지 않습니다.

## 샌드박스: 실제로 강제되는 것

**Linux만 강제 계층입니다** (`crates/cbc-sandbox/src/enforce.rs:1-17`).

### 파일시스템 — Landlock

원시 syscall 번호 444/445/446 (`enforce.rs:30-32`). `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`으로 ABI를 읽어 탐지합니다 (`:214-231`).

`apply_landlock`은 `handled_access_for_abi`로 규칙 집합을 만듭니다 — v1 권한, ABI≥2에서 `+FS_REFER`, ABI≥3에서 `+FS_TRUNCATE` (`:72-81`). 각 루트를 `O_PATH|O_CLOEXEC`로 열고 `fstat`한 뒤 디렉터리가 아닌 것은 `FS_FILE_ONLY`로 마스킹합니다 (Landlock은 파일에 디렉터리 권한을 주면 EINVAL, `:616-627`). 그다음 `LANDLOCK_RULE_PATH_BENEATH` 추가, `prctl(PR_SET_NO_NEW_PRIVS, 1)`, `landlock_restrict_self` (`:648-659`).

`required`가 아닌 루트가 없으면 건너뛰므로 `/lib64` 부재가 spawn을 실패시키지 않습니다 (`:596-613`).

strict 허용 목록 (`handlers/process.rs:235-257`):

- 쓰기 가능: 워크스페이스 루트, `temp_dir()`, `/dev/pts`
- 읽기 가능: `/usr /bin /sbin /lib /lib64 /etc /opt /dev/null /dev/urandom /dev/random /dev/tty`

**홈 디렉터리와 자격 증명을 담은 데이터 디렉터리는 의도적으로 목록 밖입니다.**

### 네트워크 거부 — 두 백엔드

선호는 `unshare(CLONE_NEWNET)`이며, 실제로 실행하는 자식을 fork해 탐지합니다 (`:261-272`).

폴백은 **클래식 BPF seccomp 필터**입니다 (`:301-444`): 대체 ABI가 syscall을 밀반입하지 못하도록 audit arch를 먼저 확인 → 비트 30으로 x32 거부 → arg0가 `AF_INET(2)`/`AF_INET6(10)`일 때 `socket`/`socketpair` 거부 → `io_uring_setup` 무조건 거부 → `SECCOMP_RET_ERRNO|EACCES` 반환. **`AF_UNIX`는 허용됩니다.**

`PR_SET_NO_NEW_PRIVS` 이후에 설치됩니다 (`:452-472`). 필터는 **x86_64와 aarch64에만** 있으며, 다른 아키텍처는 `None`을 반환해 강제가 오류를 냅니다.

비특권 userns 경로는 문서화된 이유와 함께 의도적으로 거부됩니다 (`:106-113`).

### 적용 지점과 fail-closed

`pre_exec` 안에서 `setsid`/`setpgid`와 rlimit 다음에 — 네트워크 먼저, Landlock 마지막(설정 파일이 이미 열려 있도록) (`cbc-process/src/lib.rs:640-694`).

- `network=Deny`인데 백엔드 없음 → `ProcessError::NetworkDenied`
- 비어 있지 않은 `SandboxPolicy`인데 Landlock 없음 → `SandboxUnavailable`

둘 다 **spawn 전에** 발생하며 `-32011`/`-32010`으로 매핑됩니다 (`lib.rs:533-552`, `handlers/process.rs:215-222`).

### 강제되지 **않는** 것

- **macOS: seatbelt는 절대 적용되지 않습니다.** `detect`는 `Rlimit`만 push하며, §24.5가 적용되지 않는 백엔드를 보고하는 것을 금지한다는 주석이 명시되어 있습니다 (`lib.rs:156-161`).
- **Windows: 전혀 없습니다.** Job Object도, 제한된 토큰도, rlimit조차 없습니다 (`applied_backend_labels`의 폴백이 `#[cfg(unix)]` 가드).
- `has_fs_isolation`이 `Landlock|Seatbelt`를 요구하고 seatbelt가 push되지 않으므로 **`SandboxLevel::Strict`는 macOS와 Windows에서 도달 불가능합니다.** `available_level`이 `Standard`에서 상한을 칩니다 (`lib.rs:171-185`) — 따라서 그 플랫폼에서 `enhancedSandbox`는 항상 false입니다.
- `CgroupV2`, `JobObject`, `RestrictedToken`은 구현 없는 enum 변형입니다.
- `max_open_files`/`RLIMIT_NOFILE`은 선언되어 있으나 소비자가 없습니다.

테스트 전용 킬 스위치: `CBC_TEST_DISABLE_{NETNS,SECCOMP,LANDLOCK}` (`enforce.rs:24-26`).

## 데몬 계층

> **중요한 구조적 사실:** 세션 소유권이 **두 번** 구현되어 있고, 엄격한 쪽에 호출자가 없습니다.

`crates/cbc-session-store/src/daemon.rs` (974줄)가 epoch 펜싱, 리스 만료, split-brain 방지, 비후퇴 첨부 커서를 구현합니다. API는 `lib.rs:24,38-41`에서 export됩니다. `daemon.rs`와 그 테스트 파일을 제외한 `crates/`의 모든 `.rs`를 grep한 결과 **호출자 0개**입니다. 세 테이블(`daemon_instances`, `session_owners`, `client_attachments`)은 마이그레이션 8 `daemon-ownership`이 생성하고 무결성 검사가 존재를 단정하므로 **모든 데이터베이스에 있지만 절대 쓰이지 않습니다.**

실제로 동작하는 것은 `apps/capy-daemon/src/`입니다 — pid 락 파일, 인메모리 `SessionActor`, `capy session-worker` 자식 프로세스. **Rust 계층의 모든 내구성 보장은 런타임에 부재합니다.**

사용되지 않는 계층이 살아 있는 쪽보다 세심한 지점들: 하트비트는 단조여야 함 (`UPDATE ... WHERE heartbeat_at <= ?2`), 타임스탬프는 SQLite에서 리스 비교가 사전식이므로 정확히 24바이트 정규 RFC 3339 UTC여야 함, `release_session_owner`가 행을 유지해 낡은 epoch가 재사용될 수 없게 함.

`daemon.*` RPC 네임스페이스는 **없습니다.** 첨부 표면은 `session.attach`/`session.detach`/`session.ensure`입니다.

### 디스크 산출물 (실동작 계층)

모두 `runtimeDir` 아래, 모두 모드 `0o600`, 디렉터리는 `0o700`이며 심볼릭 링크와 외부 uid를 거부합니다 (`instance-lock.ts:175-187`).

| 파일 | 생성 |
| --- | --- |
| `daemon.lock` | `openSync(path, "wx", 0o600)` |
| `daemon.sock` | `listen` 후 `chmodSync(path, 0o600)` |
| `daemon.pid` | `main.ts:116` |
| `daemon.log` | `main.ts:117-120` |
| `recovery.json` | `recovery.ts:78-81` |

기본 위치: `XDG_RUNTIME_DIR/capybara-code` → `tmpdir()/capybara-$uid`. Windows는 `LOCALAPPDATA/Capybara Code/runtime`이며 명명 파이프 `\\.\pipe\capybara-code-$uid`. 우선순위는 `--runtime-dir` > `CAPY_DAEMON_RUNTIME_DIR`.

락 레코드: 스키마 `"1.0"`, `daemonId`, `pid`, `executablePathDigest`(`sha256:` hex), `protocolVersion`, `nonce`, `uid`. 인수는 최대 3회 시도. 죽은 pid의 락은 unlink 후 재시도, 살아 있는 pid는 `DAEMON_ALREADY_RUNNING`, 외부 uid는 `DAEMON_UNAUTHORIZED_CLIENT`.

### 워커 소유 턴

`apps/cbc/src/commands/session-worker.ts:1-6`의 계약: 숨겨진 데몬 자식이 `AgentSession`을 소유하므로 TUI 종료가 턴을 죽일 수 없습니다. 프로세스는 `turn.cancel`, `session.close`, `SIGTERM`에만 멈춥니다.

detach는 의도적으로 작업을 보존합니다 (`session-actor.ts:330-344`): 같은 `clientId`를 공유하는 다른 연결이 없을 때만 클라이언트를 삭제하고 리스를 해제하며, `:342`의 주석 "Intentionally leave activeTurnId / pending approvals intact."가 명시합니다. `apps/cbc/test/session-daemon.test.ts:72-106`이 이를 증명합니다 — 진행 중 detach 후에도 await 결과가 `status: "completed"`입니다.

### 알려진 데몬 결함

1. **컴파일된 설치에서 턴이 조용히 에코로 격하됩니다.** `spawnSessionWorker`가 `existsSync(apps/cbc/src/main.ts)`로 게이트됩니다 (`main.ts:22-34`). 소스가 없으면 `SessionWorkerHost.ensure`가 `DeferredTurnExecutor`로 폴백하고, 그 `submit`은 `{turnId, status: "completed", answer: request.prompt}`를 반환합니다 — 프롬프트를 성공한 답변으로 되돌려줍니다 (`session-worker-host.ts:59`, `:112-118`). 소스 트리 없는 `--compile` 빌드에서 모든 데몬 턴이 아무것도 하지 않고 성공을 보고합니다.
2. **TUI 강제 종료가 첨부 클라이언트를 영구히 남깁니다.** `connection.onClose`가 `closeConnection`만 호출하고 그것은 `this.#connections.delete(...)`뿐입니다 (`packages/app-server/src/index.ts:221-223`) — `detach_client` 디스패치가 없습니다. 낡은 `AttachedClient`가 `SessionActor.#clients`에 남아 `WorkspaceSupervisor.isIdle()`을 영구 차단합니다. 재첨부가 `connectionId = "app_" + clientId`를 도출하므로 재연결 클라이언트는 `SESSION_ALREADY_ATTACHED`를 맞습니다. 리퍼(reaper)는 없습니다.
3. **`recovery.json`은 우아한 종료에서만 쓰입니다.** `#persistRecovery()`가 `stop()`에서만 호출되고 주기적 체크포인트가 없습니다 (`daemon.ts:230`). `SIGKILL`은 인메모리 이벤트 저널과 `pendingQuestionnaireId`를 잃습니다 — 후자는 `docs/deep-plan.md`가 약속하는 Deep Plan 재개 경로입니다.
4. **제어 리스가 강제되지 않습니다.** `expiresAt`(기본 `controlLeaseSeconds ?? 30`)이 `session-actor.ts:357`에서 계산되지만 **어떤 것과도 비교되지 않습니다.** `#requireController`는 `clientId`만 확인합니다. `steal_control`이 존재하지만 매핑되는 App Protocol 메서드가 없어 멈춘 컨트롤러를 밀어낼 수 없습니다.
5. **실동작 데몬에 하트비트가 없습니다** — `apps/capy-daemon/src` 어디에도 `setInterval`이 없습니다. `heartbeatSeconds: 5`, `ownerLeaseSeconds: 20`, `idleShutdownMinutes: 30`, `gracefulShutdownSeconds: 10` 등은 검증 범위만 있고 소비자가 없습니다.

강제되는 수치는 시작 준비 예산 `8_000` ms에 `50` ms 폴링 (`commands/daemon.ts:127`, `:201-209`)과 워크스페이스 유휴 `10 * 60_000` ms뿐이며, 후자도 타이머로 `evictIdle`을 호출하는 코드가 없습니다.

### 이벤트 버퍼링

`apps/capy-daemon/src/event-hub.ts:1-6`: 저널된 이벤트는 절대 버려지지 않고, 느린 클라이언트는 무한 성장 대신 replay 모드로 전환됩니다(커서 유지, 라이브 큐 비움).

한계: `maxQueueItems = 1_000`, `maxQueueBytes = 8 MiB`, 크기 추정 폴백 `1_024`바이트. 오버플로 시 큐를 0으로 만들고 구독자를 `"replay"`로 전환하며, ephemeral 이벤트는 대신 건너뜁니다.

**attach는 아무것도 replay하지 않습니다** — `eventCursor`만 기록합니다. Replay는 명시적 `events.subscribe` → `events.replay` → `events.ack` 루프이며, 이를 올바르게 수행하는 것은 VS Code 컨트롤러뿐입니다. `capy daemon attach`는 observer로 붙어 즉시 닫고 결과를 버리는 프로브입니다.

## 컨텍스트 흐름

```
사용자 메시지
  ↓
ContextEngine — 저장소 스캔 · 증거 원장 · 발췌 저장소 · 선택 스코어러
  ↓
ContextCompiler — 6개 버킷 할당 · 단일 패스 승인 · MMR 정렬
  ↓
PromptContextProjection — 불변 · 다이제스트 바인딩
  ↓
assemblePrompt — 안정 접두사(메모이즈) + 프로젝션 + 대화
  ↓
Provider (Responses API) — 스트리밍 SSE
  ↓
관찰 정규화 — 정화 · 비밀 탐지 · head/tail · 반복 축약 · 아티팩트 스필
  ↓
도구 스케줄러 → Rust RPC → 도구 결과
  ↓ (루프)
CompletionReport
```

자세한 내용은 [에이전트와 컨텍스트](agent-and-context.md)를 참고하십시오.

## 스키마 3자 일치

`schemas/` 아래의 JSON 스키마는 장식이 아니라 강제됩니다. `scripts/check-protocol-drift.ts`가 다음을 검증합니다.

- `REQUEST_METHODS` TS vs Rust vs 스키마 — **순서까지 동일해야 하며** 개수가 정확히 75
- `NOTIFICATION_METHODS` 3자, 개수 정확히 11
- `MUTATING_METHODS`, `PRE_INITIALIZE_METHODS` (Rust vs 스키마), 모든 변경 메서드가 요청 메서드여야 함
- `PROTOCOL_VERSION` 3자
- 6개 한계 상수, 3개 하트비트 값
- `DEFAULT_READ_MAX_LINES`가 Rust·스키마 const·`fs.read` 기본값·`fs.read_many` 기본값 모두에서 일치
- **25개 JSON-RPC 오류 코드** 각각 3자 + `Object.keys(JSONRPC_ERROR_CODES).length === 25` 메타 검사(새 코드를 검사 확장 없이 추가할 수 없게)
- `ALL_EVENT_KINDS` vs 스키마, `EVENT_SCHEMA_VERSION`, 모든 kind의 level/visibility/durability가 스키마 적법
- 설정: `defaultConfig()` 키가 스키마 `properties`와 순서까지 일치
- 도구: `NATIVE_TOOLS` id가 스키마 enum과 일치, 각 도구의 `parameters.type === "object"`, `additionalProperties === false`, `riskIndex(maxRisk) >= riskIndex(defaultRisk)`
- `schemas/CHANGELOG.md`에 `protocol <버전>`과 `events <버전>` 문자열 존재

Rust는 **소스 텍스트로** 읽습니다 (`pub const NAME: &[&str] = &[…]`에 대한 정규식) — 즉 선언된 목록을 검증하며 디스패처를 검증하지는 않습니다. 이 사실은 출력에 주석으로 명시됩니다.
