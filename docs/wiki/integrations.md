# 통합

Capybara Code는 TUI 외에 다섯 개의 통합 표면을 가집니다.

| 표면 | 프로토콜 | 위치 |
| --- | --- | --- |
| 세션 데몬 | App Protocol 1.0 (길이 접두사 JSON-RPC) | `apps/capy-daemon` |
| VS Code 확장 | App Protocol (데몬 소켓 경유) | `apps/capy-vscode` |
| ACP v1 | NDJSON JSON-RPC (stdio) | `packages/acp-adapter` + `capy acp` |
| GitHub Actions | 검증된 트리거 봉투 | `packages/github-action` |
| SDK (TS/Python) | App Protocol | `packages/sdk-typescript`, `packages/sdk-python` |

공통 계층: `packages/app-protocol`(메서드·능력·봉투), `packages/app-server`(전송 독립 디스패치), `packages/integration-core`(투영·재연결·리뷰).

---

# App Protocol

## 자세

`APP_PROTOCOL_VERSION = "1.0"` (`app-protocol/src/handshake.ts:4`).

`app-protocol/src/methods.ts:1`이 첫 줄에서 경계를 명시합니다:

> **"Stable App Protocol method names. Runtime RPC method names are intentionally absent."**

즉 App Protocol과 Rust 런타임 RPC는 **서로 다른 표면**입니다. SDK 주석도 같은 말을 합니다 (`sdk-typescript/src/client.ts:4`): "Speaks only App Protocol methods. **Never calls Rust runtime RPC methods.**"

## 메서드 그룹

`APP_METHODS` (`methods.ts:2-19`):

| 그룹 | 메서드 |
| --- | --- |
| server (6) | `initialize`, `capabilities`, `ping`, `health`, `version`, `logs.tail` |
| workspace (7) | `open`, `inspect`, `list`, `close`, `trust.get`, `trust.set`, `services` |
| session (13) | `create`, `list`, `get`, `attach`, `detach`, `ensure`, `fork`, `pause`, `resume`, `close`, `archive`, `export`, `recover` |
| turn (5) | `submit`, `cancel`, `get`, `list`, `wait` |
| turn.input (3) | `get`, `update`, `resolve` |
| events (5) | `subscribe`, `unsubscribe`, `replay`, `ack`, `getSnapshot` |
| approval (4) | `list`, `get`, `resolve`, `cancel` |
| graph (5) | `get`, `listNodes`, `pause`, `resume`, `cancel` |
| task (8) | `spawn`, `get`, `wait`, `message`, `pause`, `resume`, `revive`, `cancel` |
| memory (8) | `list`, `get`, `search`, `propose`, `remember`, `forget`, `resolveContest`, `verify` |
| lsp (9) | `status`, `diagnostics`, `definition`, `references`, `hover`, `rename.preview`, `rename.apply`, `codeActions`, `codeAction.apply` |
| edit/diff (5) | `edit.preview`, `edit.apply`, `edit.getReceipt`, `diff.get`, `diff.getFile` |
| worktree/merge (7) | `worktree.list/get/getProposal/discard`, `merge.preview/apply/resolve` |
| plugin (8) | `list`, `inspect`, `install`, `update`, `enable`, `disable`, `grants`, `resolveGrant` |
| package (7) | `search`, `inspect`, `install`, `remove`, `update`, `verify`, `bootstrap` |
| artifact (4) | `getMetadata`, `read`, `stream`, `export` |

`isAppMethod(method)`가 타입 가드로 노출됩니다.

## 핸드셰이크

`AppInitializeParams` (`handshake.ts:9-28`):

- `protocolVersion`
- `client{id, name, version, kind}` — `AppClientKind`: `tui` | `cli` | `ide` | `sdk` | `ci` | `plugin-host`
- `capabilities{eventStreaming, eventAck, approvals, interactivePrompts, artifactStreaming, richDiff, taskTree?, planReview?}`
- `authentication?{challengeResponse?}`

`negotiateAppProtocol(clientVersion, serverVersion)` (`:47`)가 **major 버전 불일치를 거부**합니다.

`AppInitializeResult`: `protocolVersion`, `serverVersion`, `daemonId`, `connectionId`, `capabilities`, `capabilitySnapshot`, `limits`.

`AppServerLimits`: `maxRequestBytes`, `maxResponseBytes`, `maxSubscriptionsPerClient`, `maxSessionsPerSubscription`.

## 클라이언트 역할 4종

`AppClientRole` (`handshake.ts:7`): `observer` | `controller` | `approval_resolver` | `administrator-local`.

부트스트랩이 이 네 개를 모두 부여합니다 (`apps/cbc/src/bootstrap.ts:873`).

## 능력 스냅샷

`APP_CAPABILITY_SCHEMA_REVISION = "2.0"` — App Protocol 1.x에 **추가적(additive)**이지만 자체 스키마 리비전을 가집니다 (`capabilities.ts:5`).

`AppCapabilitySnapshot`은 **불변이며 연결 스코프**입니다: "이 호스트가 실제로 할 수 있는 것의 선언." 다이제스트는 자기 자신을 제외하며 클라이언트가 진단용으로 영속화할 수 있습니다 (`:48-51`).

메서드별 상태 `AppMethodCapabilityState` 4종: `available` | `read-only` | `disabled` | `unsupported`. 각 항목은 `reason?`과 `requiresRole?`을 실을 수 있습니다.

`AppEventCapabilities`: `replay`, `ack`, `snapshots`, `maxBatchEvents`, `maxBatchBytes`.

`AppPresentationCapabilities`: `richDiff`, `inlineApprovals`, `taskTree`, `planReview`, `artifacts`.

`AppTransportKind`: `local-socket` | `named-pipe` | `stdio`.

`finalizeCapabilitySnapshot(body)`가 모든 항목을 동결하고 `snapshotDigest`를 붙입니다.

## 전송 독립 디스패치

`packages/app-server/src/index.ts:1-7`:

> HTTP, 루프백 WebSocket, stdio 전송이 모두 dispatch를 호출할 수 있지만, **데몬/도메인 객체에 직접 접근하지 않습니다.** 백엔드가 의도적으로 좁아서 프로덕션은 Rust 권위로 라우팅하고 테스트는 fake를 씁니다.

오류는 `AppJsonRpcError`로 `data{code, category, retryable, details?}`를 구조화해 실습니다 — 클라이언트가 재시도 가능성을 파싱할 수 있습니다.

## App Server 설정

`config-schema/src/schema.ts:760-770`:

| 키 | 기본값 |
| --- | --- |
| `appServer.enabled` | `true` |
| `appServer.transport` | `local` (타입 고정) |
| `appServer.allowLoopbackWebsocket` | **`false` (타입 고정)** |
| `appServer.maxConnections` | 32 |
| `appServer.maxRequestBytes` | 8,388,608 |
| `appServer.maxResponseBytes` | 8,388,608 |
| `appServer.maxSubscriptionsPerClient` | 16 |
| `appServer.maxSessionsPerSubscription` | 32 |
| `appServer.events.maxBatchEvents` | 100 |
| `appServer.events.maxBatchBytes` | 1,048,576 |
| `appServer.events.ackTimeoutSeconds` | 30 |
| `appServer.events.slowClientPolicy` | `replay` |

`allowLoopbackWebsocket: false`가 타입 고정이므로 **이 빌드에서 WebSocket 전송은 켤 수 없습니다.**

---

# 세션 데몬

## 명령

```bash
capy daemon start
capy daemon stop
capy daemon status
capy daemon logs
capy daemon attach [sessionId]
```

또는 직접: `capy-daemon start|stop|status|logs [--runtime-dir <dir>]`.

## 바이너리 해석

**데몬은 PATH를 절대 보지 않습니다** (`commands/daemon.ts:1-7`): "데몬 바이너리는 항상 이 런처 기준으로 해석됩니다 — PATH를 검색하지 않으므로 사용자가 설치한 동명 프로그램이 세션 소유권을 탈취할 수 없습니다."

탐색 순서 (`resolveDaemonExecutable`, `:68-78`):

1. `<executableDir>/../libexec/capy-daemon[.exe]`
2. `<dirname(process.execPath)>/../libexec/capy-daemon[.exe]`

## 인스턴스 락

**CLI는 인스턴스 락을 절대 쓰지 않습니다** — 데몬 프로세스가 유일한 소유자입니다 (`commands/daemon.ts:6`).

런타임 디렉터리 우선순위: `--runtime-dir` > `CAPY_DAEMON_RUNTIME_DIR` > 플랫폼 기본값.

디스크 산출물과 락 레코드 상세는 [아키텍처 — 데몬 계층](architecture.md#데몬-계층)을 참고하십시오.

## 세션 워커

데몬은 턴마다 `capy session-worker --session-id <id>` 자식을 spawn합니다 (`capy-daemon/src/main.ts:22-34`). 환경에 `CBC_DAEMON: "0"`을 넣어 자식이 다시 데몬을 찾지 않게 합니다.

계약 (`apps/cbc/src/commands/session-worker.ts:1-6`): **숨겨진 데몬 자식이 `AgentSession`을 소유하므로 TUI 종료가 턴을 죽일 수 없습니다.** 프로세스는 `turn.cancel`, `session.close`, `SIGTERM`에만 멈춥니다.

detach는 의도적으로 작업을 보존합니다 — `session-actor.ts:342`의 주석: "Intentionally leave activeTurnId / pending approvals intact."

> **알려진 결함:** 소스 트리 없는 `--compile` 빌드에서 `spawnSessionWorker`가 배선되지 않아 모든 데몬 턴이 프롬프트를 답변으로 되돌려주며 성공을 보고합니다. 그 외 4개 결함과 함께 [아키텍처 — 알려진 데몬 결함](architecture.md#알려진-데몬-결함)에 정리되어 있습니다.

## 이벤트 재연결 프로토콜

`events.subscribe` → `events.replay` → `events.ack` 루프입니다.

**attach는 아무것도 replay하지 않습니다** — `eventCursor`만 기록합니다. 저널된 이벤트는 절대 버려지지 않고, 느린 클라이언트는 무한 성장 대신 replay 모드로 전환됩니다 (커서 유지, 라이브 큐 비움).

한계: `maxQueueItems = 1_000`, `maxQueueBytes = 8 MiB`.

이 루프를 올바르게 수행하는 것은 **VS Code 컨트롤러뿐**입니다. `capy daemon attach`는 observer로 붙어 즉시 닫는 프로브입니다.

---

# VS Code 확장

`nevrixo.capybara-code-vscode`, 버전 `0.1.0`, `engines.vscode: ^1.96.0`.

## 기여

**명령 5개** (`apps/capy-vscode/package.json:22-28`):

| 명령 | 제목 |
| --- | --- |
| `capybara.connect` | Capybara: Connect to Daemon |
| `capybara.newSession` | Capybara: New Session |
| `capybara.attachSelection` | Capybara: Attach Selection |
| `capybara.cancelTurn` | Capybara: Cancel Turn |
| `capybara.reviewLatestDiff` | Capybara: Review Latest Diff |

**뷰 2개** (activitybar 컨테이너 `capybara`):

- `capybara.chat` (webview)
- `capybara.status` (Runtime Status)

**설정 2개:**

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `capybara.daemonPath` | `""` | 현재 사용자 데몬 소켓 또는 명명 파이프 경로 |
| `capybara.autoConnect` | `true` | Capybara 뷰가 열릴 때 호환 로컬 데몬에 연결 |

활성화 이벤트: `onView:capybara.chat`, `onCommand:capybara.connect`, `onCommand:capybara.newSession`.

## 컨트롤러

`VscodeIntegrationController` (`src/controller.ts`)가 `@cbc/integration-core`의 것들을 씁니다:

- `EventReplayProjector` — 이벤트를 타임라인으로 투영
- `ReconnectStateMachine` — 재연결 상태
- `createEditorContextAttachment` — 에디터 선택을 컨텍스트 첨부로
- `projectApproval` — 승인 표시
- `projectEditReceipt` — 편집 영수증 → rich diff

커서 영속화는 VS Code `workspaceState`에 `capybara.cursor.<sessionId>` 키로 저장됩니다 (`extension.ts:21-28`).

**`daemonPath`가 비면 연결하지 않고 오류를 던집니다** (`extension.ts:36-38`) — "Set capybara.daemonPath to the current-user daemon socket or named pipe." 자동 탐색을 하지 않습니다.

워크스페이스 신원 다이제스트는 `digestText`로 계산됩니다.

빌드: `bun build src/extension.ts --target=node --external vscode --outdir dist`.

---

# ACP v1

## 어댑터

`AcpAdapter` (`acp-adapter/src/adapter.ts:77`)는 **얇은 ACP v1 → App Protocol 브리지**입니다: "에이전트 루프를 소유하지 않고, 클라이언트를 대신해 파일시스템·터미널·자격 증명·프로세스 연산을 수행하지 않습니다" (`:74-76`).

지원 메서드 5개 (`ACP_AGENT_METHODS`, `:65-71`):

`initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`.

기본 에이전트 신원: `agentName = "Capybara Code"`, `agentVersion = "0.1.0"`.

## 프레이밍

`AcpNdjsonServer` (`ndjson.ts:15`): **"ACP stdio framing: one JSON-RPC object per UTF-8 line."**

`maxLineBytes` 기본 8 MiB, 최소 1,024. 위반 시 `TypeError`.

잘못된 메시지는 `-32600 invalid ACP JSON-RPC request`입니다. 알림(`id` 없음)에는 응답하지 않습니다.

## CLI

```bash
capy acp
```

**데몬을 필수로 요구하며**, 붙지 못하면 종료 코드 10과 "Run capy daemon start and inspect capy integration doctor acp." 안내가 나옵니다 (`commands/acp.ts:14-20`).

---

# GitHub Actions

## Action 정의

`packages/github-action/action.yml` — `runs.using: node20`, `main: dist/index.js`.

입력 5개:

| 입력 | 기본값 | 값 |
| --- | --- | --- |
| `mode` | `auto` | `auto` \| `review` \| `answer` |
| `permission-policy` | `allow-listed` | `deny-on-ask` \| `allow-listed` \| `fail-on-ask` |
| `event-file` | — | GitHub 이벤트 JSON 경로 |
| `result-file` | `capy-result.json` | 정규 액션 결과 경로 |
| `capy-binary` | — | 패키징된 CLI 절대 경로 (기본은 Action 번들) |

브랜딩: 아이콘 `code`, 색상 `brown`.

## 보안 자세

`packages/github-action/README.md`:

> Action은 헤드리스 턴 **전에** GitHub 페이로드를 서명 형태 트리거 봉투로 축약합니다. **원시 웹훅 JSON, 저장소 비밀, 알 수 없는 페이로드 필드를 모델에 전달하지 않습니다.** 전달 재시도는 같은 멱등 다이제스트를 재사용합니다.
>
> 릴리스 번들은 검증된 capy 실행 파일을 `dist/index.js` 옆에 놓아야 합니다. **개발용으로만** `capy-binary`가 명시적 절대 경로를 가리킬 수 있습니다.
>
> 외부 댓글, 커밋, PR, 애노테이션, 아티팩트는 검증된 `ActionResult`로부터 `GitHubWriteCoordinator`를 통해서만 생성되어야 합니다. **에이전트 산문만으로는 절대 외부 부작용의 권위가 되지 않습니다.**

## 트리거 파싱

`parseGitHubTrigger(input, policy)` (`src/event.ts:43`): "프로바이더 페이로드를 작고 고정된 모양의 봉투로 변환합니다. **PR 본문, 저장소 파일, 토큰, 알 수 없는 페이로드 필드는 절대 이 경계를 넘지 않습니다**" (`:39-42`).

`GitHubTriggerPolicy`: `commandPrefix?`, `allowedAssociations?`, `trustedActors?`, `allowForks?`, `admitUntrusted?`, `schedulePrompt?`.

기본 허용 연관 (`DEFAULT_ASSOCIATIONS`): `OWNER`, `MEMBER`, `COLLABORATOR`.

`GitHubEventInput`에서 넘어가는 필드: `eventName`, `deliveryId`, `repository`, `actor`, `ref`, `sha`, `payload`. 봉투가 된 뒤에는 `fork` 여부와 `actorAssociation`만 남습니다.

## 쓰기 코디네이터

`GitHubSideEffectKind` 5종: `comment` | `commit` | `pull-request` | `annotations` | `artifact`.

`GitHubWriter` 인터페이스에서 **`comment`만 필수**이고 나머지 4개는 optional입니다 — 정책이 허용하지 않으면 구현이 없어도 됩니다.

`commit`은 `expectedHeadSha`를 요구합니다 — 낙관적 동시성으로 경쟁 푸시를 감지합니다.

`GitHubWritePolicy`가 5종 각각을 개별 boolean으로 켜고, 추가로 `allowWorkflowChanges?`가 있습니다.

`GitHubSideEffectJournal.executeOnce(input, operation)`가 멱등성을 강제합니다 — `InMemoryGitHubSideEffectJournal`이 `#receipts`(완료)와 `#pending`(진행 중) 두 맵으로 중복 실행을 막습니다. 결과 `GitHubSideEffectReceipt{key, kind, externalId, completedAt}`.

## 설치

```bash
capy github install
capy github doctor
```

`install`이 `.github/workflows/capybara-code.yml`을 씁니다 (`commands/integrations.ts:171-199`):

```yaml
name: Capybara Code
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  issues: write
jobs:
  capybara:
    if: github.event_name != 'issue_comment' || contains(github.event.comment.body, '/capy')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: nevrixo/capybara-code-action@v1
        with:
          mode: auto
          permission-policy: allow-listed
```

**기존 파일이 있으면 덮어쓰지 않고** 종료 코드 4와 "Refusing to overwrite it; run capy github doctor instead."를 던집니다 (`:96-102`).

---

# SDK

## TypeScript

`@cbc/sdk` (`packages/sdk-typescript`).

```ts
import { CapybaraClient } from "@cbc/sdk";

const client = await CapybaraClient.connect({
  transport: "unix",           // "stdio" | "unix" | "pipe"
  path: "/run/user/1000/capybara-code/daemon.sock",
  client: { name: "my-tool", version: "1.0.0", kind: "sdk" },
});

const session = await client.createSession();
const turn = await session.submit("이 저장소의 테스트 구조를 설명해줘");
const receipt = await session.wait();
await client.close();
```

`CapybaraClient` API: `connect`(static), `createSession`, `reconnect`, `close`, `request`.

`Session` API: `submit`, `resubmitLast`, `wait`, `cancel`, `handleApprovalNotification`.

### 전송

`createUnixTransport(path, maxFrameBytes = 8 MiB)` (`src/unix.ts:17`). **프레임이 데몬 `LocalTransport`와 일치합니다: 4바이트 빅엔디언 길이 + JSON** (`:1-5`) — Rust 사이드카 프레이밍과 같은 형태입니다.

`JsonRpcTransport` 인터페이스(`send`/`subscribe`/`close`)를 구현하면 커스텀 전송도 가능합니다.

## Python

`capybara-code` (PyPI 이름), 버전 `0.1.0`, `requires-python >= 3.11`, **의존성 없음**.

```python
from capybara_code import CapybaraClient, Session, ApprovalDecision
```

노출되는 생성 상수: `APP_METHODS`, `CAPABILITY_SCHEMA_REVISION`, `EVENT_KINDS`, `EVENT_SCHEMA_VERSION`, `METHOD_CAPABILITY_STATES`, `PROTOCOL_VERSION`.

asyncio 기반입니다 (`Framework :: AsyncIO`). 지원 Python: 3.11, 3.12, 3.13.

두 SDK의 `generated.ts` / `generated.py`는 `scripts/generate-sdk-types.ts`가 만듭니다 — 프로토콜 상수가 손으로 복사되지 않습니다.

---

# 진단 명령

## `capy clients list|doctor`

```bash
capy clients list
capy clients doctor
```

`list` 출력: `connectedClient`, `roles`, `inventory{state: "unsupported", reason: "this daemon does not expose other client identities yet"}`.

`doctor` 출력: `daemon`, `transport`, `capabilityDigest`, `replay`, `currentClientRoles`, `clientInventory: "unsupported"`.

> **알려진 제약:** 다른 클라이언트 신원 목록은 구현되어 있지 않고, 코드가 이를 `"unsupported"`로 정직하게 보고합니다.

## `capy integration doctor [vscode|acp|github]`

대상별 검사 (`commands/integrations.ts:37-82`):

| 대상 | ready 조건 | 함께 보고 |
| --- | --- | --- |
| `acp` | `session.attach` + `turn.submit` + `events.replay`가 available | `framing: "ndjson"`, `protocolVersion: 1` |
| `vscode` | `session.attach` + `turn.submit`이 available | `richDiff`, `inlineApprovals`, `reconnect`(= replay && ack) |
| `github` | `.github/workflows/capybara-code.yml` 존재 + 헬스 | `workflow` 경로, `headlessApprovalPolicy`(= `permission-policy:` 포함 여부) |

`github` 외 대상은 **데몬이 실행 중이어야 합니다** — 아니면 종료 코드 `EXIT.internal`과 "Run capy daemon start first."입니다.

내부적으로 `CapybaraClient.connect`(win32는 `pipe`, 그 외 `unix`)로 붙어 `server.capabilities`를 호출합니다.

---

# 적합성 스위트

`packages/integration-conformance`가 `CANONICAL_INTEGRATION_TRANSCRIPT`(스키마 `1.0`) 하나를 노출합니다 — 모든 통합이 같은 정규 전사에 대해 검증됩니다.

`packages/integration-core`의 공유 모듈: `context.ts`(에디터 컨텍스트 첨부), `errors.ts`, `projection.ts`(rich diff·승인 투영), `reconnect.ts`(재연결 상태 기계), `review.ts`, `trigger.ts`(트리거 봉투).

## 관련 문서

- 데몬 내부와 알려진 결함 → [아키텍처](architecture.md)
- 이벤트 종류와 세션 저널 → [Rust 런타임](rust-runtime.md)
- 헤드리스 실행과 권한 정책 → [CLI 레퍼런스](cli-reference.md), [권한과 신뢰](permissions-and-trust.md)
- 패키지·플러그인 App Protocol 메서드 → [패키지와 플러그인](packages-and-plugins.md)
