# Rust 런타임

Capybara Code의 특권 작업은 TypeScript CLI가 아니라 별도의 Rust 사이드카 프로세스에서 실행됩니다. 파일 쓰기, 프로세스 실행, git 조작, 샌드박스 강제, 세션 영속화가 모두 이 경계 뒤에 있습니다.

워크스페이스는 13개 crate, 총 **38,647줄**입니다 (`crates/*/src/*.rs`).

## 워크스페이스 구성

`Cargo.toml`은 `resolver = "2"` 단일 워크스페이스이며, 13개 멤버가 의존 순서대로 나열되어 있습니다.

| 항목 | 값 | 위치 |
| --- | --- | --- |
| `version` | `0.1.2-alpha.1` (전 crate 공유) | `Cargo.toml:20` |
| `edition` | `2021` | `Cargo.toml:21` |
| `rust-version` | `1.85` (MSRV) | `Cargo.toml:22` |
| `license` | `Apache-2.0` | `Cargo.toml:23` |
| 툴체인 채널 | `stable` | `rust-toolchain.toml:2` |
| 툴체인 컴포넌트 | `rustfmt`, `clippy` | `rust-toolchain.toml:3` |
| 툴체인 프로파일 | `minimal` | `rust-toolchain.toml:4` |

버전이 `workspace.package`에 한 번만 있으므로 13개 crate가 항상 같은 버전으로 나갑니다. 이는 핸드셰이크 버전 협상과 직접 연결됩니다.

### 릴리스 프로파일

| 키 | 값 | 위치 |
| --- | --- | --- |
| `opt-level` | 3 | `Cargo.toml:54` |
| `lto` | `"thin"` | `Cargo.toml:55` |
| `codegen-units` | 1 | `Cargo.toml:56` |
| `panic` | `"unwind"` | `Cargo.toml:57` |
| `strip` | `"debuginfo"` | `Cargo.toml:58` |

`panic = "unwind"`이 `abort`가 아닌 것이 중요합니다 — 사이드카는 하나의 RPC가 패닉해도 프로세스 전체를 죽이지 않아야 합니다.

### 공유 의존성

`[workspace.dependencies]` (`Cargo.toml:27-38`)에 고정된 버전:

| 크레이트 | 버전 | 용도 |
| --- | --- | --- |
| `serde` | 1.0.229 (`derive`) | 프로토콜 직렬화 |
| `serde_json` | 1.0.145 (`preserve_order`) | JSON-RPC 본문 |
| `semver` | 1.0.27 | 버전 협상 |
| `sha2` | 0.10.9 | 다이제스트 |
| `ed25519-dalek` | 2 | 서명 검증 |
| `chacha20poly1305` | 0.11.0 (`getrandom`, `zeroize`) | 로컬 시크릿 암호화 |
| `getrandom` | 0.3.4 | 엔트로피 |
| `zeroize` | 1.8.2 | 메모리 소거 |
| `libc` | 0.2.180 | 플랫폼 syscall |
| `rusqlite` | 0.32.1 (`bundled`) | 세션 스토어 |
| `tempfile` | 3.27.0 | 원자적 쓰기 |

`rusqlite`의 `bundled`가 핵심입니다 — SQLite를 정적 링크하므로 사용자 시스템의 libsqlite3에 의존하지 않습니다.

`serde_json`의 `preserve_order`는 JSON 객체 키 순서를 유지합니다. 다이제스트 계산과 왕복(round-trip) 안정성에 필요합니다.

## crate 목록

| crate | 줄 수 | 책임 |
| --- | --- | --- |
| `cbc-protocol` | 1,262 | 프레이밍, 핸드셰이크, JSON-RPC, 메서드 상수, 크기 제한 |
| `cbc-redaction` | 1,174 | 시크릿 탐지, 로그·출력 새니타이즈 |
| `cbc-workspace` | 1,731 | 워크스페이스 해석, 신뢰(`trust.rs`) |
| `cbc-fs` | 3,221 | 원자적 쓰기, 경로 감금(`beneath.rs`), 검색 |
| `cbc-patch` | 5,670 | diff, edit, 편집 트랜잭션 |
| `cbc-process` | 2,732 | 프로세스 실행, 환경 정책, 리소스 제한 |
| `cbc-git` | 2,171 | git 조작, worktree, merge |
| `cbc-keychain` | 637 | 자격증명 저장 |
| `cbc-sandbox` | 1,075 | 플랫폼별 샌드박스 강제 |
| `cbc-session-store` | 18,339 | SQLite 세션·그래프·메모리·플러그인 영속화 |
| `cbc-artifacts` | 811 | 아티팩트 저장·조회 |
| `cbc-update` | 539 | 런타임 자체 업데이트 |
| `cbc-runtime` | 10,194 | 사이드카 바이너리, 서버 루프, 핸들러 |

`cbc-session-store`가 전체의 47%입니다. 단일 crate로는 압도적으로 크며, 아래 별도 절에서 다룹니다.

## 사이드카 프로세스 모델

`capy`(TypeScript)는 특권 작업을 직접 하지 않고 `cbc-runtime` 바이너리를 자식 프로세스로 띄워 위임합니다. crate 문서가 요약합니다 — stdin에서 길이 접두사 JSON-RPC 2.0 프레임을 읽고, 응답과 알림을 stdout에 쓰고, **새니타이즈된** 진단을 stderr로 보냅니다 (`crates/cbc-runtime/src/main.rs:3-5`).

| 채널 | 방향 | 내용 |
| --- | --- | --- |
| stdin | TS → Rust | 요청 프레임 |
| stdout | Rust → TS | 응답 프레임, 알림 프레임 |
| stderr | Rust → TS | 라인 단위 진단(레닥션 적용) |

로컬 포트도, 소켓도, 임시 파일도 없습니다.

### 바이너리 탐색

`runtimeBinaryCandidates` (`apps/cbc/src/host.ts:205-245`)가 후보를 우선순위대로 만듭니다:

| 순서 | 위치 | 용도 |
| --- | --- | --- |
| 1 | `$CBC_RUNTIME_BINARY` | 명시적 override |
| 2 | `<install>/libexec/cbc-runtime[.exe]` | 릴리스 아카이브 표준 위치 |
| 3 | `<executableDir>/cbc-runtime[.exe]` | 아카이브를 제자리에서 실행 |
| 4-5 | `<projectRoot>/target/{debug,release}/…` | 개발 체크아웃 (debug 우선) |
| 6 | `$CARGO_TARGET_DIR/{debug,release}/…` | WSL Linux 빌드 분리 |
| 7 | `<cwd>/target/{debug,release}/…` | `cargo build` 출력 |

**`PATH`는 절대 검색하지 않습니다** (`host.ts:167-169`, `:200-202`) — 모든 후보는 알려진 위치에서 파생한 절대 경로입니다. `bin/cbc`와 `libexec/cbc-runtime`이 릴리스 아카이브 안에서 형제이므로 사이드카는 자기 실행 파일 기준으로 찾습니다.

debug가 release보다 먼저인 이유 (`host.ts:218-222`): `cargo build`/`cargo test`가 debug를 갱신하는데 오래된 릴리스 아티팩트가 남아 있을 수 있고, 그 stale 릴리스를 고르면 현재 TS 호스트가 **다른 도구 표면을 구현한 런타임**과 짝지어집니다.

`findRuntimeBinary` (`host.ts:254-263`)가 전부 실패하면 `{ missing }`를 돌려주고, `Runtime.start`가 이를 설치 안내로 바꿉니다 (`apps/cbc/src/runtime.ts:604-613`). 바이너리 검사가 핸드셰이크보다 먼저인 이유도 주석에 있습니다 (`runtime.ts:594-600`) — spawn 스택 트레이스가 아니라 설치 메시지가 나오게 하기 위해서입니다.

### spawn과 핸드셰이크

`defaultSpawner` (`packages/protocol-ts/src/client.ts:519-532`)는 `Bun.spawn`으로 `cmd: [binary]`를 실행하며 stdin/stdout/stderr 전부 `"pipe"`입니다. **인자는 없습니다** — 모든 설정은 핸드셰이크 파라미터로 전달됩니다. `RuntimeSpawner`는 주입 가능하며 (`client.ts:112`, `:140-143`), 테스트에서 실제 사이드카 없이 CLI 전체를 돌리는 데 씁니다 (`runtime.ts:571`).

`RuntimeClient.start` (`client.ts:166-214`) 순서:

| 단계 | 내용 | 위치 |
| --- | --- | --- |
| 1 | spawn, stdio 파이프 확인 — 없으면 `runtime process has no stdio pipes` | `client.ts:168-172` |
| 2 | stdout 읽기 루프·stderr 소비 루프 기동 | `client.ts:173-175` |
| 3 | `runtime.initialize` 전송. `pty` 기본 `true`, `eventJournal`/`credentialLease`/`artifactHandles` 모두 `true` | `client.ts:177-200` |
| 4 | `InitializeResult` 수신 후 major 버전 검사 | `client.ts:202-208` |
| 5 | 불일치면 `stop()` 후 예외 — 실행 거부 | `client.ts:203-208` |
| 6 | health `ready`, 하트비트 감시 시작 | `client.ts:210-213` |

`isProtocolCompatible` (`packages/protocol-ts/src/rpc.ts:661-666`)는 Rust 측과 동일하게 major만 비교하며, 파싱 실패는 `false`이므로 형식이 깨진 버전 문자열도 실행 거부입니다.

`RUNTIME_VERSION`은 `env!("CARGO_PKG_VERSION")`입니다 (`crates/cbc-runtime/src/server.rs:48`) — 워크스페이스 공유 버전이 그대로 실려 나가므로 별도 동기화 지점이 없습니다.

### 비-RPC 표면

핸드셰이크 없이 쓸 수 있는 표면이 있습니다. 목적은 `capy doctor`가 핸드셰이크 없이 바이너리를 검증하고 패키징 검사가 버전을 단정하는 것입니다 (`main.rs:18-19`).

| 인자 | 출력 | 위치 |
| --- | --- | --- |
| `--version`, `-V` | `cbc-runtime <버전>` + `protocol <프로토콜 버전>` | `main.rs:21-25` |
| `--capabilities` | 호스트 기능 JSON — `runtimeVersion`, `protocolVersion`, `platform`, `arch`, `sandbox`, `networkDeny`, `maxFrameBytes` | `main.rs:26-42` |
| `--help`, `-h` | 사용법 | `main.rs:43-54` |

`--capabilities`는 `cbc_sandbox::detect(SandboxLevel::Standard)`를 실제로 호출합니다 (`main.rs:27`).

### 서버 루프

`main`은 스레드 3종을 씁니다.

**프로세스 이벤트 스레드** (`main.rs:64-142`): `supervisor.attach_events()` 채널을 알림으로 변환합니다. `SupervisorEvent::Output`은 `chunk.protocol_channel`에 따라 메서드가 갈립니다 (`main.rs:72-87`) — `lsp_` 접두사면 `lsp.stdio.output`, 다른 프로토콜 채널이면 `mcp.stdio.output`, 아니면 `process.output`.

레닥션이 여기서 갈립니다 (`main.rs:88-92`): 프로토콜 채널 stdout은 **원문 그대로** 통과하고 일반 프로세스 출력만 `state.safe_text()`를 거칩니다 — MCP/LSP JSON-RPC 본문을 새니타이즈하면 프레이밍이 깨지기 때문입니다. `LimitWarning`의 `detail`은 `state.redact()`를 거칩니다 (`main.rs:132`).

**하트비트 스레드** (`main.rs:145-162`): 5초마다 `runtime.heartbeat`를 보내며 페이로드는 `uptimeMs`, `activeProcesses`, `openTransactions`입니다. TS 측은 `HEARTBEAT` 상수(`rpc.ts:22-26`, 5,000/15,000/30,000 — Rust와 동일)로 감시하며, 침묵이 `fatalMs` 이상이면 health `fatal`, `degradedMs` 이상이면 `degraded`, 하트비트가 다시 오면 `ready`로 복귀합니다 (`client.ts:475-500`). `RuntimeHealth`는 `starting`/`ready`/`degraded`/`fatal`/`stopped`입니다 (`client.ts:81`).

**요청 스레드** (`main.rs:253-268`): 메인 루프는 프레임을 읽고 즉시 요청당 스레드를 띄웁니다. 이유가 주석에 있습니다 (`main.rs:229-232`) — 리더와 실행자를 분리하므로 긴 `process.run`이 자기 응답을 붙잡고 있는 동안에도 `runtime.cancel`이나 `process.stop`이 도착할 수 있습니다. 취소 토큰은 `req:<id>` 키로 등록됩니다 (`main.rs:234-241`).

`Outbound`는 `Arc<Mutex<…>>`로 감싼 소유 `Stdout`입니다 (`main.rs:61`). lock guard가 아닌 이유 (`main.rs:59-60`): 하트비트와 프로세스 이벤트 스레드가 둘 다 프레임을 쓰므로 싱크가 `Send`여야 합니다.

### 루프의 오류 처리

| 상황 | 동작 | 위치 |
| --- | --- | --- |
| `FrameError::Eof` | 종료 코드 0 | `main.rs:168` |
| 그 외 프레임 오류 | `runtime.fatal` 알림 + stderr + **종료 코드 10** | `main.rs:169-182` |
| JSON-RPC 파싱 실패 | id 0으로 오류 응답, 루프 계속 | `main.rs:185-196` |
| in-flight > 128 | `TOO_MANY_REQUESTS`(−32017) 응답 | `main.rs:198-222` |
| `runtime.shutdown` | 인라인 처리 후 루프 종료 | `main.rs:226-250` |

깨진 프레임이 스트림 전체에 치명적인 이유 (`main.rs:170-171`): **다음 경계가 어디인지 알 수 없습니다.** 길이 접두사 프레이밍의 필연적 결과입니다. 파싱 실패 시 id 0으로라도 응답하는 이유 (`main.rs:186-187`): 클라이언트가 무한정 대기하지 않게 합니다. `runtime.shutdown`만 인라인인 이유 (`main.rs:227-228`): 그때까지 쓰인 모든 응답을 관찰하고 루프를 결정적으로 끝내야 합니다.

종료 직전 `supervisor.terminate_all(1_500)`을 호출합니다 (`main.rs:271-272`) — 주석이 불변식으로 표시합니다: **고아 프로세스를 절대 남기지 않습니다.**

### 런타임 상태

`RuntimeState` (`server.rs:69-` 이하)가 세션 상태를 소유합니다. 주목할 필드:

| 필드 | 역할 | 위치 |
| --- | --- | --- |
| `sandbox_level` | 요청을 호스트 강제 가능 수준으로 클램프한 **유효** 수준 | `server.rs:78-82` |
| `network_for_shell` | `deny`는 raw shell에 network deny 강제 | `server.rs:83-86` |
| `write_admissions` | in-flight 변경/프로세스 허용 수 | `server.rs:88-91` |
| `job_owners` | job id는 capability가 아님 — 발급 세션만 조회/입력/중단 가능 | `server.rs:92-94` |
| `transactions` | 열린 파일 트랜잭션 | `server.rs:101` |
| `commit_order` | 커밋 순서 벡터 | `server.rs:102-108` |
| `leases` | 트랜잭션 id별 쓰기 리스 | `server.rs:109-110` |

`commit_order`가 `HashMap`과 별도로 존재하는 이유 (`server.rs:103-107`): 체크포인트 롤백은 **최신 것부터 역순으로** 풀어야 합니다 — 나중 트랜잭션이 앞선 것이 만든 것을 rename·replace했을 수 있고 `HashMap`은 도착 순서에 답할 수 없습니다.

`write_admissions` 주석은 경쟁 조건 방어를 설명합니다 (`server.rs:88-91`) — 모드 전환과 허용이 `interaction_mode`에서 직렬화되므로 plan 모드 진입이 어떤 작업의 마지막 모드 검사와 등록 사이를 뚫고 들어갈 수 없습니다.

## cbc-protocol

`cbc-protocol` (1,262줄)이 경계 전체를 정의합니다. 모듈 5개 — `frame`, `handshake`, `jsonrpc`, `limits`, `methods` (`crates/cbc-protocol/src/lib.rs:7-11`). crate 문서는 이를 "내부 신뢰 경계"로 명시합니다 (`lib.rs:1-5`).

### 프레임 형식

```text
4바이트 unsigned big-endian 페이로드 길이
UTF-8 JSON 페이로드
```

`frame.rs:9-11`이 선택 이유를 기록합니다 — 개입된 개행과 바이너리성 문자열에 안전하고, 패킷 경계가 명시적이며, 크로스플랫폼 stdio에서 동작하고, 로컬 포트가 필요 없고, 픽스처로부터 결정적으로 재생됩니다.

`write_frame`은 프레임마다 `flush()`합니다 (`frame.rs:84-89`) — 프로바이더 이벤트에서 렌더까지 75ms 예산을 지키려면 지연이 유계여야 합니다. `read_frame`은 선언 길이가 `MAX_FRAME_BYTES`를 넘으면 **할당을 시도하지 않고** 거부합니다 (`frame.rs:110-117`) — 공격자가 제어하는 길이를 할당하지 않습니다.

| `FrameError` | 의미 | 위치 |
| --- | --- | --- |
| `Eof` | 프레임 경계에서 정상 종료 | `frame.rs:19-20` |
| `TruncatedFrame { expected, got }` | 프레임 중간에서 종료 | `frame.rs:21-25` |
| `FrameTooLarge { declared, max }` | `MAX_FRAME_BYTES` 초과 | `frame.rs:26-30` |
| `EmptyFrame` | 길이 0은 절대 무효 | `frame.rs:31-32` |
| `InvalidUtf8` | 페이로드가 UTF-8 아님 | `frame.rs:33-34` |
| `Io(io::Error)` | 그 외 I/O | `frame.rs:35` |

`io::ErrorKind::UnexpectedEof`는 `From` 구현에서 `Eof`로 접힙니다 (`frame.rs:57-64`).

### 크기·시간 제한

`limits.rs`의 하드 불변식입니다. 런타임은 **TypeScript 클라이언트가 무엇을 주장하든 독립적으로** 이를 강제합니다 (`limits.rs:3-4`).

| 상수 | 값 | 위치 |
| --- | --- | --- |
| `MAX_FRAME_BYTES` | 8 MiB | `limits.rs:7` |
| `MAX_JSON_DEPTH` | 64 | `limits.rs:10` |
| `MAX_STRING_BYTES` | 4 MiB | `limits.rs:13` |
| `MAX_EVENT_PAYLOAD_BYTES` | 1 MiB | `limits.rs:17` |
| `MAX_OUTSTANDING_REQUESTS` | 128 | `limits.rs:20` |
| `LENGTH_PREFIX_BYTES` | 4 | `limits.rs:23` |
| `HEARTBEAT_INTERVAL_MS` | 5,000 | `limits.rs:26` |
| `HEARTBEAT_DEGRADED_MS` | 15,000 | `limits.rs:29` |
| `HEARTBEAT_FATAL_MS` | 30,000 | `limits.rs:32` |
| `PROTOCOL_VERSION` | `"1.0"` | `limits.rs:36` |

`MAX_EVENT_PAYLOAD_BYTES`를 넘는 내용은 인라인으로 보내지 못하고 **아티팩트 핸들로 이동해야** 합니다 (`limits.rs:15-16`) — `cbc-artifacts`가 존재하는 이유입니다.

하트비트 3단계는 침묵의 길이를 정책으로 바꿉니다: 5초 주기 → 15초 침묵이면 UI degraded 표시 → 30초 침묵이면 통제된 재시작 또는 세션 중단 결정.

### 버전 협상

`ProtocolVersion`은 `major.minor` 2요소만 받습니다. 3요소(`1.2.3`)는 `None`, 1요소(`3`)는 minor 0입니다 (`limits.rs:50-58`, 테스트 `lib.rs:109-113`). 호환 규칙은 **major만** 비교합니다 (`limits.rs:62-64`):

```rust
pub fn is_compatible_with(&self, other: &Self) -> bool {
    self.major == other.major
}
```

`1.0` 클라이언트는 `1.4` 런타임과 동작하지만 `2.0`은 거부합니다 (테스트 `lib.rs:101-106`). major 불일치는 경고가 아니라 실행 거부입니다 (`limits.rs:34-36`).

### 핸드셰이크

`InitializeParams` (`handshake.rs:5-40`), camelCase 직렬화:

| 필드 | 타입 | 필수 | 의미 |
| --- | --- | --- | --- |
| `protocolVersion` | `String` | O | 클라이언트 프로토콜 버전 |
| `clientVersion` | `String` | O | CLI 버전 |
| `workspace` | `String` | O | 워크스페이스 루트 |
| `capabilities` | `ClientCapabilities` | — | `pty`, `eventJournal`, `credentialLease`, `artifactHandles` (`:42-52`) |
| `dataDir` | `Option<String>` | — | 영속 데이터 디렉터리 override, `CAPYBARA_DATA_DIR` |
| `sandboxLevel` | `Option<String>` | — | `none`/`workspace`/`standard`/`strict`, 기본 `standard` |
| `networkForShell` | `Option<String>` | — | `deny`/`ask`/`allow`, 기본 `ask` |
| `interactionMode` | `Option<String>` | — | 초기 강제 모드, `plan`은 읽기 전용 |
| `capabilityIssuerToken` | `Option<String>` | — | 검증된 제어 평면만 보유, capability 영수증 발급 전제 |

`sandboxLevel`은 요청일 뿐입니다. 런타임이 **호스트가 실제로 강제할 수 있는 수준으로 클램프**하고 유효 수준을 되돌려 보고합니다 (`handshake.rs:16-20`) — 강제는 런타임에 있고 제어 평면에는 절대 없습니다.

응답 `InitializeResult` (`handshake.rs:54-61`): `protocolVersion`, `runtimeVersion`, `workspaceId`, `capabilities`. `RuntimeCapabilities` (`handshake.rs:67-82`)는 `enhancedSandbox`, `keychain`(`os-native`/`encrypted-file`/`session-only`/`unavailable`), `pty`, `git`, `sandboxLevel`, `sandboxBackends`, `networkDeny`, `platform`, `arch`, `maxFrameBytes`, `artifactStore`, `eventJournal` 12개 필드입니다.

`handshake.rs:63-65`가 계약을 밝힙니다 — UI가 샌드박스를 과대 주장하지 않고 실제 가드 수준을 말해야 하므로, 이 필드들은 **호스트에 대한 사실**이며 희망적 기본값이 아닙니다.

### RPC 메서드

`methods.rs`가 런타임이 받는 모든 메서드를 열거합니다. 목적은 디스패처와 `scripts/check-protocol-drift.ts` 드리프트 검사가 **하나의 진실 소스를 공유**하는 것입니다 (`methods.rs:3-5`). 요청 메서드는 **75개**입니다 (`methods.rs:8-84`, 단정 `:153`):

| 네임스페이스 | 개수 | 메서드 | 위치 |
| --- | --- | --- | --- |
| `runtime.` | 5 | `initialize`, `capabilities`, `shutdown`, `cancel`, `capability.issue` | `:9-13` |
| `workspace.` | 7 | `inspect`, `mode.write`, `trust.read`, `trust.write`, `trust.list`, `trust.set`, `trust.remove` | `:14-20` |
| `fs.` | 16 | `list`, `glob`, `search`, `read`, `read_many`, `fingerprint`, `edit.preview`, `edit`, `transaction.begin`, `patch`, `write`, `move`, `delete`, `transaction.commit`, `transaction.rollback`, `transaction.rollback_to_checkpoint` | `:21-36` |
| `process.` | 5 | `run`, `start`, `input`, `stop`, `status` | `:37-41` |
| `git.` | 5 | `status`, `diff`, `log`, `show`, `checkpoint` | `:42-46` |
| `worktree.` | 7 | `create`, `list`, `inspect`, `status`, `diff`, `remove`, `reconcile` | `:47-53` |
| `merge.` | 1 | `preview` | `:54` |
| `credential.` | 3 | `store`, `lease`, `delete` | `:55-57` |
| `session.` | 10 | `open`, `append`, `snapshot`, `load`, `list`, `resolve`, `set_status`, `export`, `fork`, `delete` | `:58-67` |
| `memory.` | 7 | `search`, `remember`, `list`, `get`, `forget`, `resolve_contest`, `verify` | `:68-74` |
| `app.` | 5 | `client.upsert`, `subscription.create`, `subscription.ack`, `subscription.state`, `subscription.replay` | `:75-79` |
| `artifact.` | 3 | `create`, `read`, `delete` | `:80-82` |
| `update.` | 1 | `verify` | `:83` |

알림은 Rust → TS 단방향 **11개**입니다 (`methods.rs:87-99`, 단정 `:186`): `runtime.heartbeat`, `process.output`, `process.exited`, `process.limit_warning`, `workspace.changed`, `transaction.conflict`, `journal.committed`, `artifact.spilled`, `sandbox.degraded`, `runtime.warning`, `runtime.fatal`.

`PRE_INITIALIZE_METHODS`는 `runtime.initialize`와 `runtime.shutdown` 둘뿐이며 (`methods.rs:102`), 나머지 73개는 핸드셰이크 성공 후에만 호출 가능합니다 (`:112-114`).

`MUTATING_METHODS` 10개 (`methods.rs:118-132`): `fs.patch`, `fs.write`, `fs.move`, `fs.delete`, `fs.edit`, `fs.transaction.rollback_to_checkpoint`, `git.checkpoint`, `worktree.create`, `worktree.remove`, `worktree.reconcile`. 이들은 **클라이언트 측 승인과 무관하게** 쓰기 리스와 경로 가드를 매번 재검증합니다 (`:116-117`). `rollback_to_checkpoint`가 포함된 이유도 적혀 있습니다 (`:124-127`) — 체크포인트 롤백은 파일을 다시 쓰므로 저작이 아니라 복원이더라도 경로 가드는 동일하게 관여해야 합니다. 반대로 `fs.transaction.rollback`은 mutating이 **아닙니다** (테스트 `:221`) — 커밋되지 않은 트랜잭션을 버리므로 워크스페이스를 건드리지 않습니다.

### 오류 코드

`jsonrpc.rs:11`이 `JSONRPC_VERSION = "2.0"`을 고정합니다. 표준 코드 (`:15-19`): −32700 `PARSE_ERROR`, −32600 `INVALID_REQUEST`, −32601 `METHOD_NOT_FOUND`, −32602 `INVALID_PARAMS`, −32603 `INTERNAL_ERROR`.

Capybara 고유 코드 20개, `-32000` 대역 (`jsonrpc.rs:22-41`):

| 코드 | 상수 | 발생 상황 |
| --- | --- | --- |
| −32000 | `PATH_OUTSIDE_WORKSPACE` | 경로 감금 위반 |
| −32001 | `HASH_MISMATCH` | 기대 해시와 실제 내용 불일치 |
| −32002 | `PATH_CHANGED` | 미리보기 이후 경로 변경 |
| −32003 | `NOT_FOUND` | 대상 없음 |
| −32004 | `ALREADY_EXISTS` | 대상 이미 존재 |
| −32005 | `UNSUPPORTED_ENCODING` | 인코딩 미지원 |
| −32006 | `OUTPUT_LIMIT` | 출력 한도 초과 |
| −32007 | `TIMEOUT` | 시간 초과 |
| −32008 | `CANCELLED` | 취소됨 |
| −32009 | `PROCESS_EXIT_NONZERO` | 프로세스 비정상 종료 코드 |
| −32010 | `SANDBOX_UNAVAILABLE` | 요청 수준 샌드박스 사용 불가 |
| −32011 | `NETWORK_DENIED` | 네트워크 차단 |
| −32012 | `TRANSACTION_CONFLICT` | 편집 트랜잭션 충돌 |
| −32013 | `PROTOCOL_INCOMPATIBLE` | major 버전 불일치 |
| −32014 | `LEASE_VIOLATION` | 쓰기 리스 위반 |
| −32015 | `RESOURCE_LIMIT` | 리소스 제한 |
| −32016 | `NOT_INITIALIZED` | 핸드셰이크 전 호출 |
| −32017 | `TOO_MANY_REQUESTS` | in-flight 128개 초과 |
| −32018 | `INVALID_ARGUMENT` | 인자 오류 |
| −32019 | `PERMISSION_DENIED` | 권한 거부 |

`RpcError::taxonomy(code, taxonomy, message)` (`jsonrpc.rs:109`)가 코드와 별도로 문자열 분류를 실어 보냅니다 — `invalid_params`는 −32602 + `INVALID_ARGUMENT` (`:124-126`), `internal`은 −32603 + `INTERNAL` (`:128-130`). `ParseError`는 JSON 파싱 실패를 `PARSE_ERROR`로, 그 외 구조 문제를 `INVALID_REQUEST`로 매핑합니다 (`:220-221`). `validate_value` (`:230`)가 깊이·문자열 길이 제한을 검사합니다. `RequestId`는 열거형이라 숫자와 문자열 id를 모두 받습니다 (`:46`).

## 샌드박스

`cbc-sandbox` (1,075줄)는 `lib.rs`(탐지·수준, 355줄)와 `enforce.rs`(실제 강제, 720줄)로 나뉩니다. 핵심 원칙이 주석에 반복해 박혀 있습니다 — **워크스페이스 가드를 보안 샌드박스라고 부르지 않습니다** (`lib.rs:204`), 리포트는 정직한 최저선을 유지합니다 (`lib.rs:161-167`).

### 수준

`SandboxLevel` (`lib.rs:24-28`)은 3단계이며 `PartialOrd`가 파생되어 크기 비교가 가능합니다:

| 수준 | 라벨 | 가드 설명 (`lib.rs:203-207`) |
| --- | --- | --- |
| `None` | `none` | `path guard only` |
| `Standard` | `standard` | `workspace` |
| `Strict` | `strict` | `workspace + OS isolation` |

`parse` (`lib.rs:39-48`)는 설정 표기 `workspace`를 `Standard`의 앨리어스로 받으며 대소문자 무관입니다 (테스트 `lib.rs:238`).

### 백엔드와 플랫폼별 강제

`SandboxBackend` (`lib.rs:52-61`)에 8개가 **선언**되어 있으나 실제 적용은 4개뿐입니다:

| 백엔드 | 라벨 | 실제 적용 |
| --- | --- | --- |
| `Landlock` | `landlock` | Linux |
| `Seccomp` | `seccomp` | Linux (network deny 대체 경로) |
| `NetworkNamespace` | `network-namespace` | Linux |
| `Rlimit` | `rlimit` | unix 전반 |
| `CgroupV2` | `cgroup-v2` | 선언만 |
| `Seatbelt` | `seatbelt` | 선언만 — macOS 탐지는 presence-only, 미적용 |
| `JobObject` | `job-object` | 선언만 — Windows 미적용 |
| `RestrictedToken` | `restricted-token` | 선언만 |

`applied_backend_labels` (`enforce.rs:183-205`)의 독스트링이 구분을 명시합니다 — **탐지되었지만 적용되지 않는 메커니즘(cgroups, seatbelt presence)은 나열하지 않습니다.**

| 플랫폼 | 파일시스템 격리 | 네트워크 차단 | 리소스 | 최대 도달 수준 |
| --- | --- | --- | --- | --- |
| Linux | Landlock (ABI 탐지) | netns 또는 seccomp-BPF | rlimit | `strict` (둘 다 있을 때) |
| macOS | 없음 | 없음 | rlimit | `standard` |
| Windows | 없음 | 없음 | 없음 | `standard` |

`detect` (`lib.rs:129-217`)의 Linux 분기 (`:134-154`)는 Landlock을 enforcement가 쓰는 것과 **같은 진입점**(ruleset-version syscall)으로 검증하고 (`:136-137`), 네트워크 차단은 fork한 자식이 실제 `unshare(CLONE_NEWNET)`이나 seccomp 필터 설치를 수행해 검증합니다 — 거부된 spawn이 하게 될 일과 정확히 동일합니다 (`:141-143`). macOS 분기 (`:156-161`)는 `Rlimit`만 추가하며, Seatbelt가 launch 시점에 실제로 적용되기 전까지 available 보고가 금지되어 있습니다. Windows 분기 (`:163-167`)는 아무것도 추가하지 않습니다.

### strict 승격과 강등

`strict`는 **실제 파일시스템 제한 백엔드 + 네트워크 차단 수단** 둘 다를 요구합니다 (`lib.rs:169-186`) — `has_fs_isolation`은 `Landlock`/`Seatbelt` (`:171-173`), `has_network_deny`는 `NetworkNamespace`/`Seatbelt`/`Seccomp` (`:174-179`). 둘 다면 `Strict`, 아니면 `Standard`입니다 (`:181-185`). `Seatbelt`가 어느 백엔드 목록에도 실제로 들어가지 않으므로 실무상 **Linux에서만 `strict`가 가능**합니다.

`degraded`는 `requested > available_level`입니다 (`lib.rs:187`). 이유 문자열이 어느 축이 빠졌는지에 따라 갈립니다 (`lib.rs:188-200`):

| `has_fs_isolation` | `has_network_deny` | `degrade_reason` |
| --- | --- | --- |
| false | false | `no OS filesystem-isolation or network-deny backend is available on this host` |
| true | false | `no network-deny backend is available on this host` |
| false | true | `no OS filesystem-isolation backend is available on this host` |
| true | true | `requested level exceeds the detected capability` |

클램핑은 `effective_level` (`lib.rs:222-224`) 한 줄, `requested.min(caps.available_level)`입니다 — 요청은 절대 올려주지 않고 내려주기만 합니다. 결과가 `RuntimeState.sandbox_level`에 들어가고 (`server.rs:78-82`) `RuntimeCapabilities.sandboxLevel`로 보고되며, 강등 시 `sandbox.degraded` 알림이 나갑니다.

### Landlock

`enforce.rs:30-32`가 syscall 번호를 직접 씁니다 — `landlock_create_ruleset`(444), `landlock_add_rule`(445), `landlock_restrict_self`(446). 외부 크레이트 없이 `libc::syscall`로 호출합니다.

ABI 버전별 handled access (`enforce.rs:72-81`):

| ABI | 추가 권한 |
| --- | --- |
| v1 | `FS_ALL_V1` — execute, write/read file, read/remove/make 계열 13개 (`enforce.rs:57-70`) |
| v2 | `+ FS_REFER` (rename) |
| v3 | `+ FS_TRUNCATE` |

ABI를 정확히 따라가야 하는 이유 (`enforce.rs:51-52`): 어느 쪽이든 빠뜨리면 rename/truncate가 handled set **밖에** 남고 따라서 샌드박스 정책 밖에 남습니다. 파일 경로 규칙은 `FS_FILE_ONLY`로 마스킹됩니다 (`enforce.rs:84-86`) — Landlock이 파일에 대해 디렉터리 전용 권한(`READ_DIR`, `MAKE_*`, `REMOVE_DIR`)을 명명한 규칙을 거부하기 때문입니다.

`FsRule` (`enforce.rs:545-551`)에 `required` 플래그가 있습니다. 없는 경로는 건너뛰지만 (`:568-570` — `/lib64`가 없는 배포판에서 spawn이 실패해서는 안 됨), `required: true`인 규칙(쓰기 가능한 워크스페이스 루트)이 없으면 spawn을 중단합니다. `FS_READ_ACCESS`는 바이너리 실행·라이브러리 로드만 (`:553-555`), `FS_FULL_ACCESS`는 쓰기 가능 루트 전체 권한 (`:556-558`)이며 Linux가 아닌 플랫폼에서는 둘 다 `0`입니다 (`:560-563`).

`apply_landlock`의 안전 계약이 명시되어 있습니다 (`enforce.rs:571-573`) — **fork된 자식에서 exec 전에** 또는 단일 스레드 프로세스에서만 실행해야 합니다. 호출 후에는 나열된 루트 밖의 모든 open이 `EACCES`로 실패합니다.

### 네트워크 차단

`NetworkDenyBackend` (`enforce.rs:103-116`) 3상태:

| 변종 | 메커니즘 | 전제 |
| --- | --- | --- |
| `Netns` | `unshare(CLONE_NEWNET)` — 빈 네트워크 네임스페이스 | root 또는 `CAP_SYS_ADMIN` |
| `Seccomp` | seccomp-BPF로 IPv4/IPv6 소켓 생성 거부 | 비특권 |
| `Unavailable` | 없음 — `network = deny`를 지킬 수 없으므로 **거부해야 함** | — |

`Seccomp` 변종 주석에 중요한 설계 배제가 있습니다 (`enforce.rs:108-113`) — **비특권 user namespace 경로를 의도적으로 쓰지 않습니다.** 매핑되지 않은 user namespace는 워크스페이스를 소유한 uid를 잃어버리고, uid map은 *부모* 네임스페이스의 프로세스만 쓸 수 있는데 fork+exec spawn이 자식 안에서는 그것을 준비할 수 없습니다.

seccomp 프로그램은 x86_64와 aarch64만 있고 (`enforce.rs:384`), 다른 아키텍처에서는 `no seccomp network filter exists for this architecture` 오류가 납니다 (`:492-497`). 필터 설치 전에 `prctl(PR_SET_NO_NEW_PRIVS, 1, …)`이 선행합니다 (`:454-456`) — 비특권 seccomp의 커널 요구사항입니다.

Linux 아닌 플랫폼의 `apply_network_deny`는 항상 `ErrorKind::Unsupported`로 실패합니다 (`enforce.rs:536-542`). **fail-closed**입니다 — 지원 안 되는 플랫폼에서 조용히 허용하지 않고 spawn을 거부합니다.

### 탐지 캐싱과 테스트 override

`probe()` (`enforce.rs:134-139`)는 `OnceLock`으로 결과를 한 번만 계산합니다. fork 안전성이 주석에 있습니다 (`:129-132`) — 네트워크 프로브의 자식은 **할당하지 않고 stdio를 건드리지 않으므로** 멀티스레드 프로세스에서 fork해도 안전합니다.

강제 무효화용 환경 변수 3개 (`enforce.rs:24-26`): `CBC_TEST_DISABLE_NETNS`, `CBC_TEST_DISABLE_SECCOMP`, `CBC_TEST_DISABLE_LANDLOCK`. 이들은 캐시와 달리 **매번 live로 조회됩니다** (`:141-144`, `:150-170`) — 회귀 테스트가 캐시에 대한 경쟁 없이 fail-closed 경로를 강제할 수 있게 하기 위해서입니다.

`step_error` (`enforce.rs:510-513`)가 실패한 강제 단계 이름을 errno에 붙입니다 — spawn 거부가 맨 errno가 아니라 자기 이유를 설명하게 합니다.

## crate별 상세

### cbc-fs (3,221줄)

원자적 파일 연산, 낙관적 동시성, 목록, glob, 내용 검색 (`crates/cbc-fs/src/lib.rs:1-2`).

**`atomic.rs` (769줄)** — 쓰기 순서가 독스트링에 고정되어 있습니다 (`atomic.rs:3-11`): 같은 디렉터리에 임시 파일(rename이 한 파일시스템 안에 머물도록) → 제한적 기본 권한 → write + flush + fsync → owner/mode 보존 → 원자적 rename → 디렉터리 fsync → 실패 정리 → 전후 내용 해시. 불변식 (`atomic.rs:13-14`): **쓰기 중 크래시가 잘린 대상 파일을 절대 남기지 않습니다** — 대상은 오직 `rename`으로만 교체됩니다. API: `atomic_write`, `delete_path`, `fsync_dir`, `hash_file`, `hashes_match`, `is_probably_binary`, `move_path`, `read_text`, `WriteIntent`, `WriteOutcome`, `NewlineStyle`, `DEFAULT_MAX_FILE_BYTES` (`lib.rs:10-14`).

**`beneath.rs` (1,590줄)** — 경로 감금의 핵심입니다. 위협 모델이 정확히 서술되어 있습니다 (`beneath.rs:3-4`): **검증된 절대 경로명은 capability가 아닙니다** — 호출자가 열기 전에 다른 프로세스가 그 부모 중 하나를 바꿔치기할 수 있습니다(TOCTOU). 해법은 권한을 워크스페이스 객체에 고정하는 것입니다 (`beneath.rs:4-7`):

| 플랫폼 | 기법 |
| --- | --- |
| Unix | 컴포넌트 단위 디렉터리 fd 순회 + `*at` syscall |
| Windows | 모든 정상 디렉터리 핸들을 delete sharing 없이 pin, reparse point 거부 |

문자열 경로를 한 번 검증하고 나중에 여는 방식이 아니라, 순회 자체가 워크스페이스 루트에 묶여 있습니다.

**`search.rs` (674줄)** — `fs.list`, `fs.glob`, `fs.search`. 모든 결과는 워크스페이스 상대 경로이며 **유계**입니다 (`search.rs:4-5`) — 출력 한도가 필수이고 모델에 도달할 수 있는 양에 상한이 있습니다. 생성물·vendor 트리는 walk 시점에 건너뜁니다 (`search.rs:13-14`).

### cbc-patch (5,670줄)

**`transaction.rs` (1,816줄)** — 편집 트랜잭션 모델입니다 (`transaction.rs:6-9`):

```text
begin → stage operations (validate all) → commit (apply atomically)
                                       ↘ rollback (restore pre-images)
```

**모든 변경은 트랜잭션 안에서 실행됩니다** (`transaction.rs:4`). 규칙 두 개 (`transaction.rs:11-12`): 모든 hunk가 commit 전에 검증되어야 하고, **부분 다중 파일 패치는 금지** — 트랜잭션이거나 전체 롤백입니다. 따라서 검증이 적용 시점이 아니라 스테이징 시점에 일어납니다. 롤백은 역방향 diff 적용이 아니라 pre-image 복원입니다.

**`edit.rs` (2,177줄)** — 권위적이고 **부작용 없는** 편집 계획 검증·스테이징. TypeScript 편집 도메인이 클라이언트 측 미리보기를 제공하지만, 이 모듈이 **모든 안전 결정을 Rust에서 다시 수행**합니다 (`edit.rs:3-6`). 파일시스템 접근이 전혀 없고 호출자가 스냅샷을 제공하며 결과 파일 변경을 `FileTransaction`에 넘깁니다. 이것이 `fs.edit.preview`/`fs.edit` 두 메서드가 존재하는 이유입니다 — 미리보기는 상태를 만들지 않고 실제 편집만 트랜잭션을 엽니다.

**`diff.rs` (589줄)** — 통합 diff 텍스트를 **셸에 넘기지 않습니다** (`diff.rs:3`). 파싱과 적용을 분리한 이유 (`diff.rs:4-5`): 형식이 깨진 패치가 **어떤 파일도 열리기 전에** 거부됩니다.

### cbc-process (2,732줄)

**`env_policy.rs` (352줄)** — 기본 상속 허용 (`env_policy.rs:3-5`): `PATH`, `HOME`/`USERPROFILE`, 검증된 경로의 `TMP`/`TEMP`, 로케일, PTY용 터미널 변수, 안전한 패키지 매니저 캐시 변수. 기본 제외 (`:5-7`): 토큰·키, 클라우드 자격증명, CI 시크릿, SSH agent 소켓, 브라우저 세션 변수, 그리고 **`*_TOKEN`, `*_SECRET`, `*_KEY` 패턴 전부**. 판정은 `cbc_redaction::is_secret_env_name`에 위임합니다 (`:11`) — 레닥션과 환경 정책이 같은 시크릿 이름 규칙을 공유합니다.

**`limits.rs` (115줄)** — `DEFAULT_LIMITS` (`limits.rs:28-37`):

| 필드 | 기본값 |
| --- | --- |
| `process_timeout_ms` | 600,000 (10분) |
| `pty_idle_timeout_ms` | 1,800,000 (30분) |
| `captured_output_bytes` | 10 MiB (초과 시 spill) |
| `inline_buffer_bytes` | 1 MiB |
| `max_concurrent_processes` | 4 |
| `max_open_files` | 1,024 |
| `max_memory_bytes` | `None` |
| `max_cpu_seconds` | `None` |

`lib.rs` (2,190줄)가 `ProcessSupervisor`, `SupervisorEvent`(`Output`/`Exited`/`LimitWarning`), `CancelToken`, `OutputStream`을 제공합니다 — `main.rs`가 소비하는 것들입니다.

### cbc-git (2,171줄)

**`worktree.rs` (597줄)** — 경로는 호출자가 생성하지만 제공된 `data_root` 아래에 머물러야 하며, 백엔드는 **프로젝트가 제공한 임의의 체크아웃 위치를 절대 받지 않습니다** (`worktree.rs:3-4`).

**`merge.rs` (590줄)** — 3-way 병합 분석이며 **워킹 트리를 건드리지 않습니다** (`merge.rs:1`). `git merge-tree -z --write-tree`를 우선하고 `-z`가 없으면 deprecated trivial 형식으로 폴백합니다 (`:3-4`). 이것이 `merge.preview`가 mutating 목록에 없는 이유입니다. `lib.rs` (984줄)가 `GitService`·`GitError`로 `git.status`/`diff`/`log`/`show`/`checkpoint`를 뒷받침합니다.

### cbc-keychain (637줄)

**이 빌드에는 OS 네이티브 키체인 통합이 없습니다** (`crates/cbc-keychain/src/lib.rs:3`). 백엔드 2개뿐입니다:

| 백엔드 | 구현 |
| --- | --- |
| `encrypted-file` | 데이터 디렉터리 아래 인증 암호화 파일 — 자격증명 맵 전체에 XChaCha20-Poly1305, Unix 권한 노출 플랫폼에서는 키와 vault를 현재 사용자로 제한 |
| `session-only` | 데이터 디렉터리가 쓰기 불가일 때 메모리 내 폴백 |

독스트링이 정직성 요구를 명시합니다 (`lib.rs:7-9`) — 의도적으로 `encrypted-file` / `session-only`로 보고하며 **절대 "os-native"라고 하지 않습니다.**

### cbc-redaction (1,174줄)

**`secrets.rs` (650줄)** — 3신호 조합 (`secrets.rs:3-6`):

| 신호 | 내용 | 조건 |
| --- | --- | --- |
| 1 | 정확히 알려진 시크릿 리터럴 (등록된 자격증명, 환경 값) | 무조건 |
| 2 | 고신뢰 자격증명 형식 | 무조건 |
| 3 | 고엔트로피 후보 | **문맥상 대입 키워드가 함께 있을 때만** |

신호 3에 문맥 조건을 붙인 이유 (`secrets.rs:8-9`): 오탐율을 낮게 유지합니다 — 엔트로피만으로 판정하면 해시, base64 데이터, UUID가 모두 잡힙니다. `is_secret_env_name`이 여기서 나와 `cbc-process`의 환경 정책에 쓰입니다.

**`sanitize.rs` (467줄)** — 위협이 구체적으로 서술되어 있습니다 (`sanitize.rs:3-5`): 도구·MCP·스킬 출력에 든 OSC/DCS/APC/PM 시퀀스가 터미널 제목을 바꾸거나 **클립보드에 쓰거나**(OSC 52) 하이퍼링크를 낼 수 있습니다. 완화 4단계 (`:5-6`): OSC/DCS/APC/PM **전부 제거**, CSI는 안전한 SGR 부분집합만 남기고 새니타이즈, 남은 제어 문자 이스케이프, 라인 길이 상한. 이것이 `main.rs:88-92`가 프로토콜 채널 stdout을 새니타이즈에서 제외해야 하는 이유의 반대편입니다.

### cbc-workspace (1,731줄)

**`trust.rs` (488줄)** — 신뢰 레코드는 정규 경로 **그리고 파일시스템 identity**를 키로 씁니다 (`trust.rs:3-6`). 이유가 명시되어 있습니다 — 신뢰된 디렉터리를 적대적 트리로의 symlink로 교체해도 **신뢰가 상속되지 않습니다.** `lib.rs` (1,243줄)가 `Workspace`, `glob_match`를 제공하며 `cbc-fs`의 검색이 이것을 씁니다.

### cbc-artifacts (811줄)

내용 주소화 아티팩트 저장소 (`crates/cbc-artifacts/src/lib.rs:1`). 규칙 (`lib.rs:3-11`): 읽기 전 다이제스트 검증, temp → final 원자적 이동, 중복 내용 dedup(MAY), 기본적으로 raw 시크릿 아티팩트 금지, **모델 입력에는 유계 발췌·요약만 실리고 전체 blob은 절대 안 실림**, `capy artifact show <id>`가 유일한 raw 조회 경로이며 로컬 사용자 행위.

`MAX_EVENT_PAYLOAD_BYTES`(1 MiB)를 넘는 내용이 이 저장소로 흘러가고, 전환 시 `artifact.spilled` 알림이 나갑니다.

### cbc-update (539줄)

릴리스 아티팩트 **검증만** 담당합니다. 경계가 못박혀 있습니다 (`crates/cbc-update/src/lib.rs:5-8`) — `update.verify`의 검증 절반을 소유하며 **의도적으로 아무것도 다운로드하지 않습니다.** postinstall 임의 네트워크 다운로드를 기본 배포 경로로 삼는 것이 금지되어 있기 때문입니다. 역할 분담은 한 문장입니다 (`lib.rs:8`) — **TypeScript가 가져오고, 런타임이 검증합니다.** 서명은 `ed25519-dalek`, 체크섬은 `sha2`입니다.

### cbc-session-store (18,339줄)

SQLite 영속화 계층이며 워크스페이스에서 가장 큰 crate입니다. `rusqlite`의 `bundled`로 SQLite를 정적 링크합니다 (`Cargo.toml:37`).

| 모듈 | 줄 수 | 담당 |
| --- | --- | --- |
| `lib.rs` | 3,210 | `SessionStore`, `StoreError`, 세션·턴·이벤트 |
| `graph.rs` | 2,536 | 영속 에이전트 그래프 |
| `worktree.rs` | 2,297 | 다중 에이전트 worktree 상태 |
| `plugin.rs` | 2,187 | 플러그인 런타임·권한 메타데이터·서킷 헬스 |
| `memory.rs` | 2,155 | 지속 메모리, 증거 링크, 전이 |
| `migrations.rs` | 1,016 | 스키마 마이그레이션 |
| `daemon.rs` | 974 | 데몬 인스턴스·세션 소유권 |
| `app.rs` | 683 | app-server 커서·구독 |
| `edit.rs` | 349 | 편집 계획·연산·영수증 |

### 마이그레이션

정책은 **전진 전용, 번호 매김, 체크섬**이며 파괴적 마이그레이션은 데이터베이스를 먼저 백업합니다 (`migrations.rs:1-2`). `Migration` 구조체 (`:9-15`): `version: i64`, `name: &'static str`, `sql: &'static str`, `destructive: bool`. 체크섬은 `sha2::Sha256`입니다 (`:5`) — 이미 적용된 마이그레이션의 SQL이 나중에 바뀌면 감지됩니다.

`MIGRATIONS` (`migrations.rs:18`)는 15개입니다:

| 버전 | 이름 | 위치 |
| --- | --- | --- |
| 1 | `initial-schema` | `migrations.rs:20-21` |
| 2 | `session-turn-count` | `:182-183` |
| 3 | `journal-v2-lineage` | `:193-194` |
| 4 | `snapshot-stream-sequence` | `:210-211` |
| 5 | `artifact-ownership` | `:221-222` |
| 6 | `versioned-snapshot-envelope` | `:233-234` |
| 7 | `edit-receipts` | `:244-245` |
| 8 | `daemon-ownership` | `:297-298` |
| 9 | `durable-memory` | `:367-368` |
| 10 | `persistent-agent-graph` | `:465-466` |
| 11 | `worktree-multi-agent` | `:598-599` |
| 12 | `plugin-runtime` | `:690-691` |
| 13 | `app-server-cursors` | `:766-767` |
| 14 | `plugin-authority-metadata` | `:796-797` |
| 15 | `plugin-instance-circuit-health` | `:818-819` |

### 스키마 테이블

마이그레이션 1 (`migrations.rs:20-180`)이 만드는 13개: `schema_migrations` (`:24`), `workspaces` (`:31`), `sessions` (`:38`), `turns` (`:55`), `events` (`:66`), `snapshots` (`:85`), `transactions` (`:94`), `file_operations` (`:104`), `approvals` (`:119`), `tasks` (`:131`), `jobs` (`:142`), `artifacts` (`:153`), `usage` (`:164`).

이후 마이그레이션이 추가하는 주요 테이블:

| 테이블 | 위치 | 마이그레이션 |
| --- | --- | --- |
| `edit_plans`, `edit_operations`, `edit_receipts` | `:248`, `:266`, `:283` | 7 |
| `daemon_instances`, `session_owners`, `client_attachments` | `:301`, `:312`, `:323` | 8 |
| `command_receipts`, `session_commands` | `:335`, `:348` | 8 |
| `evidence_records`, `evidence_path_bindings`, `evidence_artifacts` | `:371`, `:393`, `:402` | 9 |
| `memory_records`, `memory_evidence_links`, `memory_relations`, `memory_transitions` | `:408`, `:436`, `:442`, `:449` | 9 |
| `agent_graphs` | `:469` | 10 |

`transactions`와 `file_operations`가 SQLite에 있다는 점이 중요합니다 — `cbc-patch`의 편집 트랜잭션이 메모리 내 상태만이 아니라 영속 저널을 가지므로, 커밋 후 크래시에도 무엇이 적용되었는지 재구성할 수 있습니다. `journal.committed` 알림이 이 저널에 대응합니다.

## 빌드와 테스트

### cargo 명령

리포지토리에는 워크플로가 `release.yml` 하나뿐이고, `cargo`를 직접 부르는 곳은 두 군데입니다.

| 명령 | 위치 |
| --- | --- |
| `cargo test --workspace` | `package.json:20` (`test:rust`), CI에서 `bun run test:rust` (`.github/workflows/release.yml:46-47`) |
| `cargo build --release -p cbc-runtime` | `scripts/build-runtime.ts:202` |
| `cargo build -p cbc-runtime` | 개발 체크아웃 안내 (`apps/cbc/src/runtime.ts:609`) |

CI 게이트 잡은 `release:check` → `typecheck` → `test:ts` → `test:release` → `test:rust` 순서입니다 (`release.yml:34-47`). Rust 테스트가 마지막이며 워크스페이스 전체를 한 번에 돌립니다.

`rust-toolchain.toml`이 `channel = "stable"`이므로 CI는 채널을 명시하지 않고 워크스페이스 툴체인을 선택합니다 (`release.yml:26-29`).

### 런타임 빌드

`scripts/build-runtime.ts`가 `cargo build --release -p cbc-runtime`을 감쌉니다. 추가로 하는 일:

| 처리 | 내용 | 위치 |
| --- | --- | --- |
| 소스 경로 remap | 로컬 절대 경로가 바이너리에 남지 않도록 `RUSTFLAGS` remap 플래그 생성 | `build-runtime.ts:117-130`, `:183` |
| Windows 정적 CRT | `-Ctarget-feature=+crt-static` 추가 | `build-runtime.ts:128` |
| Windows 링커 | `rustc --print target-libdir` 기준으로 번들 `rust-lld.exe`를 링커로 지정 | `build-runtime.ts:96-107`, `:195-198` |
| glibc 베이스라인 | `CBC_RELEASE_GLIBC_BASELINE` 설정 시 빌드 호스트 검증 + 산출물 심볼 검증 | `build-runtime.ts:178-180`, `:209-211` |
| 타깃 디렉터리 | `CARGO_TARGET_DIR` 우선, 없으면 `<root>/target` | `build-runtime.ts:133-136` |

glibc 검증은 두 단계입니다. 빌드 **전**에 호스트의 `getconf GNU_LIBC_VERSION`을 확인하고 (`build-runtime.ts:160`), 빌드 **후**에 `readelf --version-info`로 산출물이 요구하는 가장 높은 `GLIBC_*` 심볼을 확인합니다 (`build-runtime.ts:166-167`). 버전 비교는 전용 함수로 하는데 이유가 주석에 있습니다 (`build-runtime.ts:42`) — 문자열 비교는 `2.9`를 `2.31`보다 새것으로 취급하기 때문입니다.

베이스라인 강제는 Linux 빌드 호스트에서만 가능합니다 (`build-runtime.ts:158`).

### npm 아티팩트 패키징

릴리스 레이아웃은 `bin/`과 `libexec/`이 형제인 구조이며, 이것이 `host.ts`의 사이드카 탐색과 정확히 대응합니다.

`platformPackageManifest` (`scripts/package-npm.ts:106-131`)가 플랫폼별 패키지를 만듭니다:

| 필드 | 값 |
| --- | --- |
| `os` | 해당 타깃 플랫폼 하나 (`package-npm.ts:114`) |
| `files` | `bin`, `libexec`, `share`, `manifest.json`, `LICENSE` (`package-npm.ts:117`) |

상위 패키지는 플랫폼 패키지들을 `optionalDependencies`로 참조합니다 (`package-npm.ts:130`) — npm이 현재 플랫폼에 맞는 것만 설치하는 표준 패턴입니다.

스테이징 검증 (`package-npm.ts:147-165`): 허용된 경로 접두사는 `bin/`, `libexec/`, `share/`이며, 런처 전용 패키지는 `bin/`만 허용합니다. non-Windows에서는 `libexec/cbc-runtime`이 **실행 가능 파일인지 단정**합니다 (`package-npm.ts:165`).

복사 시 `libexec` 전체를 재귀 복사하고 (`package-npm.ts:197`), non-Windows에서 `libexec/cbc-runtime`에 `0o755`를 명시적으로 설정합니다 (`package-npm.ts:205`) — npm 아카이브가 실행 비트를 잃는 경우를 방어합니다.

CI 빌드 잡 순서 (`release.yml:86-99`): `build:runtime` → `build:capy` → `release:package` → `release:archive` → `release:smoke`. 마지막 스모크 테스트가 "패키징된 바이너리와 **상대 사이드카 경로**"를 확인합니다 (`release.yml:98`) — `PATH`를 쓰지 않는 설계가 실제로 패키지 안에서 성립하는지 검증하는 단계입니다.

### 경계 검사 스크립트

| 스크립트 | 검사 | package.json |
| --- | --- | --- |
| `scripts/check-protocol-drift.ts` | Rust `methods.rs`와 TS 메서드 정의 동기화 | `schemas:check` (`package.json:37`) |
| `scripts/check-no-codex-runtime.ts` | Codex 런타임 의존성 부재 | `runtime-boundary:check` (`package.json:40`) |
| `scripts/source-truth.ts` | 소스 진실 매니페스트 | `source-truth:check` (`package.json:39`) |

`check-no-codex-runtime.ts`의 접근이 특이합니다. 독스트링이 문제를 인정합니다 (`check-no-codex-runtime.ts:5-8`) — **부재를 테스트하는 것은 어색한 일**입니다. 리포의 다른 모든 검사는 두 산출물을 비교하는데, 이것은 어떤 코드 범주가 애초에 작성되지 않았음을 단정해야 합니다.

그래서 4가지 서로 다른 종류의 증거를 봅니다 (`check-no-codex-runtime.ts:10-14`): 프로덕션 의존성 그래프의 매니페스트, `codex` 프로세스 spawn 소스 스캔, `~/.codex` 접근 소스 스캔, 그리고 mock 프로바이더로 도는 Root Agent 통합 테스트.

스캔이 무엇을 위반으로 셀지에 대해 의도적으로 좁습니다 (`check-no-codex-runtime.ts:16-20`) — 문제는 **어휘가 아니라 행동**입니다. `capy auth login`은 Capybara가 Codex 자격증명을 재사용하지 않는다고 사용자에게 말해야 하고, `cbc-protocol`은 `codex.app_server`가 알려진 메서드가 아님을 단정해야 합니다. 둘 다 거부하기 위해 Codex를 언급합니다. 그런 것을 플래그하는 검사는 저자를 **거부 코드를 삭제하는 방향으로 밀어붙일** 것입니다.

실제로 `methods.rs:202`의 테스트가 `!is_known_request("codex.app_server")`를 단정합니다.

## 알려진 불일치

### 1. `mcp.stdio.output` / `lsp.stdio.output`이 미선언 알림

`main.rs:79-87`이 프로토콜 채널 출력에 대해 `mcp.stdio.output` 또는 `lsp.stdio.output` 알림을 보냅니다. 그런데 두 메서드는 `NOTIFICATION_METHODS` (`methods.rs:87-99`)에 **없습니다**.

`grep -rn 'lsp.stdio.output\|mcp.stdio.output' crates/`가 `main.rs:81`과 `:83` 두 줄만 반환합니다. `methods.rs:186`이 `NOTIFICATION_METHODS.len() == 11`을 단정하고 있으므로, 이 두 개는 열거되지 않은 채 와이어로 나갑니다.

`methods.rs:3-5`가 이 모듈의 목적을 "디스패처와 드리프트 검사가 하나의 진실 소스를 공유"하는 것이라고 밝혔으므로, 이 두 알림은 그 계약 밖에 있습니다.

### 2. `is_compatible_with` 독스트링과 본문 불일치

`limits.rs:60-61`의 독스트링은 이렇게 적혀 있습니다 — "differing major versions must refuse to run. Equal major with a runtime minor >= client minor is compatible."

본문 (`limits.rs:62-64`)은 `self.major == other.major`뿐이며 **minor를 전혀 비교하지 않습니다.** 클라이언트 minor보다 낮은 minor의 런타임도 호환으로 판정됩니다. TS 측 `isProtocolCompatible` (`packages/protocol-ts/src/rpc.ts:661-666`)도 동일하게 major만 봅니다.

두 구현이 서로 일치하므로 실동작에는 비대칭이 없습니다. 문서만 실제보다 엄격하게 적혀 있습니다.

### 3. 선언되었으나 미사용인 `SandboxBackend` 4개

`SandboxBackend` (`lib.rs:52-61`)에 8개가 선언되어 있으나 `detect` (`lib.rs:129-217`)가 push하는 것은 `Landlock`, `Seccomp`, `NetworkNamespace`, `Rlimit` 4개뿐입니다.

`CgroupV2`, `JobObject`, `RestrictedToken`은 어디에서도 push되지 않습니다. `Seatbelt`는 `has_fs_isolation`/`has_network_deny` 판정 조건에 **등장하지만** (`lib.rs:173`, `:178`) 어느 플랫폼 분기에서도 backends에 추가되지 않으므로 그 조건이 참이 될 수 없습니다. macOS 분기 (`lib.rs:156-161`)가 `Rlimit`만 추가하며 주석이 이유를 밝힙니다.

결과적으로 `strict`는 Linux 전용입니다. `label()`은 8개 전부를 구현합니다 (`lib.rs:64-77`).

### 4. `RuntimeCapabilities.keychain`의 `os-native`

`handshake.rs:70`이 `keychain` 필드의 값 집합을 `os-native` | `encrypted-file` | `session-only` | `unavailable`로 문서화합니다.

`cbc-keychain`은 OS 네이티브 백엔드를 구현하지 않으므로 (`crates/cbc-keychain/src/lib.rs:3`) 이 빌드는 `os-native`를 낼 수 없습니다. crate 독스트링이 이를 의도된 상태로 명시합니다 (`lib.rs:7-9`) — 절대 "os-native"라고 하지 않습니다. 필드 타입이 `String`이라 값 집합이 컴파일 타임에 강제되지는 않습니다.

### 5. 파괴적 마이그레이션 경로가 미발동

`Migration.destructive`가 존재하고 (`migrations.rs:13-14`) 정책상 파괴적 마이그레이션은 먼저 백업해야 합니다 (`migrations.rs:1-2`). 그러나 마이그레이션 15개 중 `destructive: true`인 것이 하나도 없습니다 — `grep -n 'destructive: true' crates/cbc-session-store/src/migrations.rs`가 빈 결과입니다.

백업 경로는 아직 실행된 적이 없습니다.

### 6. CPU·메모리 기본 상한 없음

`limits.rs:11`의 모듈 문서 표가 CPU/메모리를 "warning and platform enforcement"로 적었으나, `DEFAULT_LIMITS`의 `max_memory_bytes`와 `max_cpu_seconds`는 둘 다 `None`입니다 (`limits.rs:35-36`). 기본 구성에서는 하드 상한 없이 경고 경로만 동작합니다.

### 7. 샌드박스 테스트 override가 프로덕션 코드 경로

`CBC_TEST_DISABLE_NETNS`, `CBC_TEST_DISABLE_SECCOMP`, `CBC_TEST_DISABLE_LANDLOCK` (`enforce.rs:24-26`)은 캐시된 프로브 결과와 달리 매 호출마다 live로 조회됩니다 (`enforce.rs:141-144`). 이 설계는 테스트가 fail-closed 경로를 강제하기 위한 것이라고 주석에 명시되어 있으나, 실행 환경에 설정되어 있으면 실제 샌드박스가 조용히 약해집니다.

## 관련 문서

- 전체 아키텍처 → [아키텍처](architecture.md)
- 워크스페이스 신뢰와 권한 → [권한과 신뢰](permissions-and-trust.md)
- 도구가 런타임을 호출하는 경로 → [도구 레퍼런스](tools.md)
- 빌드·개발 환경 → [기여 가이드](contributing.md)
- 런타임 관련 장애 → [트러블슈팅](troubleshooting.md)
- 런타임 관련 설정 키 → [설정](configuration.md)
