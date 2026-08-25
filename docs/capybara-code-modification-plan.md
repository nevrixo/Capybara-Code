# Capybara Code 핵심 런타임 개선 수정 기획서

> 문서 버전: 1.0-draft  
> 기준 저장소 스냅샷: 2026-08-23 Repomix 패킹본  
> 작성 기준일: 2026-08-24  
> 대상 제품: Capybara Code `0.1.0-alpha.8` 계열  
> 문서 상태: 구현 전 상세 설계·변경 기획  
> 적용 범위: Anchor/Range Edit Engine, Full LSP, Durable Memory, Session Daemon, Persistent AgentGraph, Worktree Multi-Agent, Hooks/Plugin SDK, App Server/TS·Python SDK

---

## 문서 목차

- 0. 문서 사용 규칙
- 1. 요약
- 2. 현행 아키텍처 기준선
- 3. 공통 설계 원칙
- 4. 공통 저장소 구조 변경안
- 5. 공통 DB 마이그레이션 계획
- 6. 공통 테스트 전략
- 7. 개선 항목 1 — Anchor / Range Edit Engine
- 8. 개선 항목 2 — Full LSP
- 9. 개선 항목 4 — Durable Memory production 연결
- 10. 개선 항목 5 — Session Daemon
- 11. 개선 항목 6 — Persistent AgentGraph
- 12. 개선 항목 7 — Worktree Multi-Agent
- 13. 개선 항목 8 — Hooks + Plugin SDK
- 14. 개선 항목 9 — App Server + TypeScript/Python SDK
- 15. 통합 아키텍처
- 16. 핵심 End-to-End 흐름
- 17. 통합 Event Catalog 추가안
- 18. 통합 Config 제안
- 19. 저장소 변경 Matrix
- 20. 구현 PR 분할 권장안
- 21. 단계별 롤아웃
- 22. Rollback 전략
- 23. Release Gate
- 24. 신규 Benchmark Task 제안
- 25. 통합 위험 등록부
- 26. 금지할 구현 패턴
- 27. 통합 Definition of Done
- 부록 A–G

---

## 0. 문서 사용 규칙

### 0.1 표시 규칙

이 문서는 저장소에서 확인된 사실과 향후 구현 제안을 혼합하지 않는다.

- **[현행]**: 업로드된 저장소 코드에서 확인된 현재 구현이다.
- **[문제]**: 현행 구조에서 해당 개선 목표를 막는 제약이다.
- **[결정]**: 본 기획서가 권고하는 설계 결정이다.
- **[제안]**: 구현 과정에서 조정 가능한 세부 설계다.
- **[필수]**: 완료 기준을 만족하려면 반드시 구현해야 한다.
- **[선택]**: 초기 릴리스에서 제외할 수 있는 확장 항목이다.
- **[비목표]**: 이 수정 범위에서 의도적으로 하지 않는 일이다.

### 0.2 원본 저장소 변경 원칙

- Repomix XML은 분석용 읽기 전용 산출물이다.
- 실제 수정은 원본 저장소 파일에서 수행한다.
- 문서의 파일 경로는 Repomix 내부의 원본 경로를 기준으로 한다.
- 구현 중 경로가 이동하면 계약 이름과 책임 경계를 우선 보존한다.
- 단순 리네임을 기능 완료로 간주하지 않는다.

### 0.3 문서의 목적

이 문서는 다음 질문에 구현 가능한 수준으로 답한다.

1. 현재 어느 코드가 변경 대상인가?
2. 어떤 신규 패키지와 Rust crate가 필요한가?
3. 모델이 호출하는 도구 계약은 어떻게 바뀌는가?
4. TypeScript 제어 계층과 Rust 권한 계층의 책임은 어떻게 나뉘는가?
5. 어떤 이벤트와 DB 스키마가 추가되는가?
6. 중단·재시작·중복 요청에서 어떻게 정확성을 보장하는가?
7. 기존 CLI·TUI·세션과 어떻게 호환되는가?
8. 어떤 테스트와 벤치마크를 통과해야 기능이 완료되는가?
9. 기능 간 선행 의존성과 단계별 롤아웃 순서는 무엇인가?
10. 실패 시 어떤 기능 플래그와 마이그레이션 경로로 되돌릴 수 있는가?

### 0.4 범위

본 문서는 아래 번호만 다룬다.

1. Anchor / Range Edit Engine
2. Full LSP
4. Durable Memory production 연결
5. Session Daemon
6. Persistent AgentGraph
7. Worktree Multi-Agent
8. Hooks + Plugin SDK
9. App Server + TypeScript/Python SDK

### 0.5 범위 밖

아래 항목은 본 기획의 직접 범위가 아니다.

- 신규 모델 provider 추가
- 브라우저·컴퓨터 사용 도구
- DAP 디버거
- 웹 UI 또는 클라우드 호스팅 서비스
- 모바일 클라이언트
- 결제·조직·좌석 관리
- 플러그인 공개 마켓플레이스 운영
- 임의의 `git push` 자동 허용
- Rust runtime 제거 또는 Node 단일 프로세스화
- 기존 permission model의 완화
- raw transcript 전체를 장기 기억으로 저장하는 기능

---

# 1. 요약

## 1.1 핵심 결론

Capybara Code는 새 기능을 CLI 프로세스 내부에 계속 추가하면 안 된다.

목표 구조는 다음과 같다.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Clients                                                             │
│ TUI · Headless CLI · IDE · GitHub/CI · TypeScript SDK · Python SDK  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ App Protocol
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Capybara App Server                                                 │
│ handshake · auth · session API · event stream · approval bridge     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ local actor commands/events
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Session Daemon                                                      │
│ WorkspaceSupervisor                                                 │
│ ├─ SessionActor                                                     │
│ ├─ Persistent AgentGraph                                            │
│ ├─ Durable Memory Service                                           │
│ ├─ LSP Supervisor                                                   │
│ ├─ Plugin Supervisor / Hook Bus                                     │
│ ├─ Worktree Manager / Merge Coordinator                             │
│ └─ Provider Sessions / Approval Manager                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ capability-bound RPC
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Rust Runtime Boundary                                               │
│ FS · Edit Transaction · Git/Worktree · Process · Artifact · Journal │
│ path guard · trust · sandbox · capability receipt · resource limit  │
└─────────────────────────────────────────────────────────────────────┘
```

핵심 원칙은 다음 한 문장으로 요약한다.

> **모든 지능적 제안은 TypeScript 계층에서 만들 수 있지만, 모든 부작용은 기존 Rust runtime의 capability·trust·transaction 검증을 통과해야 한다.**

## 1.2 기능별 한 줄 결정

| 번호 | 기능 | 설계 결정 |
|---:|---|---|
| 1 | Anchor / Range Edit Engine | 기존 `revisionToken`과 Rust transaction 위에 결정적 anchor/range edit plan을 추가한다. |
| 2 | Full LSP | LSP는 조회·진단·편집 제안 서비스이며 직접 파일을 쓰지 못한다. 모든 `WorkspaceEdit`는 Edit Engine으로 변환한다. |
| 4 | Durable Memory | 현재 `MemoryBank`를 production `MemoryService`로 감싸고 evidence ledger·SQLite·Context Compiler에 연결한다. |
| 5 | Session Daemon | 세션과 provider stream의 소유권을 TUI에서 로컬 daemon으로 이동한다. |
| 6 | Persistent AgentGraph | 현재 parent-local in-memory scheduler를 event-sourced durable DAG로 승격한다. |
| 7 | Worktree Multi-Agent | 같은 checkout의 multi-writer를 허용하지 않고 writer마다 격리 worktree를 제공한다. |
| 8 | Hooks + Plugin SDK | 플러그인은 별도 격리 worker에서 실행하고 권한을 축소하거나 거부할 수만 있다. |
| 9 | App Server + SDK | 내부 Rust RPC와 분리된 client-facing protocol을 만들고 TUI도 이 protocol의 첫 번째 client가 된다. |

## 1.3 가장 중요한 선행 의존성

```text
공통 계약·이벤트·DB 마이그레이션 기반
  ├─ Anchor/Range Edit Engine
  │    └─ Full LSP mutation support
  ├─ Session Daemon
  │    ├─ Durable Memory production wiring
  │    ├─ Persistent AgentGraph
  │    │    └─ Worktree Multi-Agent
  │    ├─ Hooks + Plugin runtime
  │    └─ App Server
  │         ├─ TUI client migration
  │         ├─ TypeScript SDK
  │         └─ Python SDK
  └─ 통합 벤치마크·복구 테스트
```

## 1.4 구현 웨이브

달력 기반 기간 대신 기능 게이트 기반 웨이브를 사용한다.

| 웨이브 | 포함 기능 | 종료 게이트 |
|---|---|---|
| W0 | 공통 계약, 이벤트, schema compatibility, feature flag | 구버전 세션 replay와 현재 테스트가 모두 통과한다. |
| W1 | Anchor/Range Edit Engine | stale·ambiguous·overlap edit가 fail-closed이고 기존 patch와 동등한 atomicity를 가진다. |
| W2 | Full LSP read/query + WorkspaceEdit adapter | rename·code action이 Edit Engine을 통과하고 diagnostics evidence가 생성된다. |
| W3 | Session Daemon 최소 소유권 이전 | TUI 종료 후 세션이 살아 있고 재접속할 수 있다. |
| W4 | Durable Memory + Persistent AgentGraph | daemon 재시작 후 memory와 graph가 정확히 복원된다. |
| W5 | Worktree Multi-Agent | 두 writer가 서로 다른 worktree에서 병렬 작업 후 검증된 merge를 수행한다. |
| W6 | Hooks + Plugin SDK | 격리 plugin이 hook·tool·command를 제공하되 권한 상승이 불가능하다. |
| W7 | App Server + TS/Python SDK | TUI와 SDK가 동일 protocol·event stream을 사용한다. |
| W8 | 통합 release gate | crash/failover/replay/security/long-session benchmark를 모두 통과한다. |

---

# 2. 현행 아키텍처 기준선

## 2.1 읽기와 파일 변경

**[현행]** `apps/cbc/src/runtime.ts`의 typed read 응답에는 다음 정보가 이미 있다.

- workspace-relative path
- exact 또는 preview mode
- `revisionToken`
- checksum
- `authoritativeForWrite`
- bounded excerpt
- binary/byte/line metadata

**[현행]** `fs.apply_patch`는 unified diff와 파일별 `expectedHashes`를 받는다.

**[현행]** `fs.write`, `fs.move`, `fs.delete`는 기존 파일 변경 시 expected hash를 요구한다.

**[현행]** `RuntimeToolExecutor`는 mutation마다 Rust transaction을 시작하고, stage 실패 시 rollback하며, commit 결과를 event로 변환한다.

**[현행]** `crates/cbc-patch`는 다음 invariant를 가진다.

- 모든 hunk가 검증된 뒤 commit한다.
- multi-file patch의 부분 적용을 허용하지 않는다.
- pre-image와 post-image hash를 기록한다.
- 현재 content가 post-image와 일치할 때만 undo한다.
- 사용자 동시 변경을 덮어쓰지 않는다.

**[문제]** 모델은 큰 unified diff를 생성해야 한다.

**[문제]** line number가 이동했을 때 재탐색·rebase 계약이 없다.

**[문제]** LSP `WorkspaceEdit`를 안전하게 수용할 공통 edit plan 형식이 없다.

## 2.2 LSP

**[현행]** `apps/cbc/src/lsp-host.ts`는 trusted Build workspace에서만 language server를 시작한다.

**[현행]** 외부 LSP 프로세스는 Rust runtime의 supervised job으로 실행된다.

**[현행]** protocol frame, total output, document 크기, document 수, symbol 수, 병렬 요청 수에 상한이 있다.

**[현행]** 실제 기능은 repository scan 후 `textDocument/documentSymbol`을 요청해 `RepositoryIntelligence`를 보강하는 수준이다.

**[현행]** Plan mode 진입 시 LSP process를 종료한다.

**[문제]** definition/reference/hover/diagnostics/rename/code action/formatting을 agent tool로 사용할 수 없다.

**[문제]** live document version과 didChange가 없다.

**[문제]** LSP가 생성한 edit를 안전하게 transaction으로 적용할 adapter가 없다.

## 2.3 Memory

**[현행]** `packages/context-engine/src/memory.ts`에는 evidence-backed `MemoryBank`가 있다.

**[현행]** memory는 workspace/session/task scope, branch/path validity, confidence, expiry, supersede, contest, transition log를 표현한다.

**[현행]** write는 fresh resolvable evidence를 요구한다.

**[현행]** deterministic snapshot/deserialize가 있다.

**[문제]** production `AgentSession`과 bootstrap에서 MemoryBank가 생성·복원·저장되지 않는다.

**[문제]** session-store에 memory table과 evidence link가 없다.

**[문제]** restart 후 evidence resolver를 재구성하는 production 경로가 없다.

**[문제]** recall 결과를 Context Compiler 후보로 주입하는 end-to-end flow가 없다.

## 2.4 Session persistence

**[현행]** Rust SQLite store에는 workspaces, sessions, turns, events, snapshots, transactions, file operations, approvals, tasks, jobs, artifacts, usage가 있다.

**[현행]** event에는 hash chain과 sequence가 있다.

**[현행]** snapshot은 versioned envelope와 journal boundary를 가진다.

**[현행]** startup reconciliation은 열린 transaction, running job, active session을 interrupted로 전환한다.

**[문제]** foreground CLI/TUI process가 `AgentSession`, provider stream, LSP host, MCP host를 직접 소유한다.

**[문제]** client disconnect와 session cancellation을 분리한 daemon ownership이 없다.

**[문제]** daemon instance lease, client attachment, event cursor, actor mailbox가 없다.

## 2.5 Subagent

**[현행]** 현재 scheduler는 role, task contract, dependency, context budget, cancellation, one-writer lease를 관리한다.

**[현행]** child raw transcript는 parent context에 합쳐지지 않는다.

**[현행]** await interruption과 actual cancel이 구분된다.

**[현행]** child claim은 runtime evidence와 대조된다.

**[문제]** scheduler state는 parent process의 Map에만 존재한다.

**[문제]** depth 1을 넘는 delegation이 거부된다.

**[문제]** task row 저장 API는 있으나 graph state의 production authority로 사용되지 않는다.

**[문제]** retry attempt, mailbox, pause/resume, revive, checkpoint, dependency edge가 durable model에 없다.

## 2.6 Git과 worktree

**[현행]** Rust Git service는 status, diff, log, show, checkpoint, tracked/recent files를 제공한다.

**[현행]** generic commit/push/reset은 의도적으로 도구에 없다.

**[문제]** worktree create/remove/list, private ref, merge proposal, conflict 분석 기능이 없다.

**[문제]** single writer를 유지하면서 writer parallelism을 늘릴 격리 단위가 없다.

## 2.7 Extensions

**[현행]** extension bridge는 Skills, MCP, user.ask, task, todo 중심이다.

**[현행]** Skill은 executable plugin이 아니라 instruction/reference/template이다.

**[현행]** MCP tool은 공통 registry와 policy engine을 사용한다.

**[문제]** lifecycle hook과 executable plugin SDK가 없다.

**[문제]** plugin isolation, manifest, capability request, lockfile, signature, timeout 정책이 없다.

## 2.8 Client protocol

**[현행]** `@cbc/protocol`과 Rust `cbc-protocol`은 TypeScript host와 Rust runtime 사이의 내부 RPC다.

**[현행]** event envelope는 kernel, TUI, journal, replay가 공유한다.

**[문제]** TUI/IDE/SDK가 사용할 client-facing app protocol이 없다.

**[문제]** foreground UI가 domain 객체를 직접 호출해 세션과 UI가 강하게 결합돼 있다.

---

# 3. 공통 설계 원칙

## 3.1 불변식

### INV-001: Rust runtime 최종 권한

- TypeScript의 `allow`는 최종 권한이 아니다.
- 모든 write/process/worktree operation은 Rust runtime에서 재검증한다.
- 새 App Server나 Plugin worker는 Rust runtime을 우회할 수 없다.
- LSP edit는 직접 filesystem write를 하지 않는다.

### INV-002: Claim과 fact 분리

- 모델, child agent, LSP, plugin의 출력은 기본적으로 claim 또는 proposal이다.
- 파일 hash, process exit, transaction commit, persisted event가 fact다.
- 최종 보고는 검증되지 않은 claim을 passed evidence처럼 표시하지 않는다.

### INV-003: Workspace identity 격리

- session, memory, approval, plugin grant, worktree, graph는 workspace identity digest에 바인딩한다.
- path 문자열만으로 persistent authority를 부여하지 않는다.
- filesystem identity가 바뀌면 기존 persistent grant를 fail-closed 처리한다.

### INV-004: 단일 writer per mutable tree

- 같은 worktree에 동시에 한 writer만 존재한다.
- 병렬 writer는 각자 별도 worktree를 사용한다.
- base workspace 반영은 하나의 merge coordinator만 수행한다.

### INV-005: 모든 mutation은 transaction

- Anchor edit, Range edit, LSP rename, code action, formatter, merge result 모두 transaction으로 stage한다.
- multi-file operation은 all-or-nothing이다.
- pre-image 없는 mutation은 복구 가능성 규칙을 통과해야 한다.

### INV-006: Event before view

- durable state 변경은 먼저 canonical event/DB transition으로 확정한다.
- TUI와 SDK view는 event/reducer projection이다.
- client가 끊겨도 state transition은 유실되지 않는다.

### INV-007: Idempotency

- client command, hook invocation, agent dispatch, edit application, merge attempt에는 idempotency key가 있다.
- 재전송은 같은 결과 또는 이미 완료된 receipt를 반환한다.
- provider/network retry가 side effect를 중복 실행하지 않는다.

### INV-008: 권한 단조성

- project config, plugin, hook, child agent는 user/runtime policy보다 권한을 넓힐 수 없다.
- before hook은 allow를 새로 만들 수 없고 deny/narrow/ask escalation만 가능하다.
- plugin이 다른 plugin의 권한을 위임할 수 없다.

### INV-009: bounded I/O

- 모든 protocol frame, event payload, plugin message, LSP result, SDK stream buffer에 상한이 있다.
- 큰 결과는 artifact handle로 spill한다.
- model context에는 bounded projection만 들어간다.

### INV-010: 복구 가능한 상태 전이

- daemon crash 후 transaction, job, provider request, graph attempt, worktree merge를 reconcile한다.
- “실행됐는지 모름” 상태를 성공이나 실패로 추측하지 않는다.
- uncertain operation은 `reconciling` 또는 `blocked`로 표시한다.

## 3.2 공통 식별자

모든 신규 식별자는 random UUID 또는 sortable UUID를 사용하되 prefix를 포함한다.

| 개체 | 형식 예시 |
|---|---|
| daemon instance | `dmn_<uuid>` |
| client connection | `cli_<uuid>` |
| workspace supervisor | `wsp_<digest-prefix>` |
| session | 기존 `ses_*` 또는 현재 형식 유지 |
| graph | `grf_<uuid>` |
| graph node | `agt_<uuid>` |
| attempt | `att_<uuid>` |
| message | `msg_<uuid>` |
| edit plan | `edp_<uuid>` |
| edit operation | `edo_<uuid>` |
| edit receipt | `edr_<uuid>` |
| LSP request | `lsp_<uuid>` |
| memory record | 기존 `memory-<digest>` 유지 가능 |
| worktree | `wt_<uuid>` |
| merge attempt | `mrg_<uuid>` |
| plugin install | `plg_<publisher>_<name>` |
| hook invocation | `hki_<uuid>` |
| app request | JSON-RPC id + `correlationId` |

## 3.3 공통 command envelope

모든 App Server mutation command는 다음 envelope를 사용한다.

```ts
export interface CommandEnvelope<T> {
  schemaVersion: "1.0";
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  clientId: string;
  workspaceIdentityDigest?: string;
  sessionId?: string;
  expectedRevision?: number | string;
  issuedAt: string;
  payload: T;
}
```

규칙:

- `commandId`는 observability용이다.
- `idempotencyKey`는 결과 중복 방지용이다.
- `expectedRevision`은 optimistic concurrency용이다.
- 서버는 동일 idempotency key와 다른 canonical payload를 거부한다.
- 완료된 command receipt는 retention 기간 동안 재조회 가능하다.

## 3.4 공통 receipt

```ts
export interface OperationReceipt<T = unknown> {
  schemaVersion: "1.0";
  receiptId: string;
  commandId: string;
  idempotencyKey: string;
  status: "accepted" | "completed" | "partial" | "failed" | "cancelled" | "blocked";
  startedAt: string;
  finishedAt?: string;
  revisionBefore?: string | number;
  revisionAfter?: string | number;
  evidenceIds: string[];
  result?: T;
  error?: StructuredError;
}
```

## 3.5 공통 오류 계약

```ts
export interface StructuredError {
  code: string;
  category:
    | "validation"
    | "conflict"
    | "permission"
    | "not_found"
    | "unavailable"
    | "timeout"
    | "resource_limit"
    | "protocol"
    | "provider"
    | "internal";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  evidenceIds?: string[];
}
```

공통 규칙:

- raw exception stack은 client protocol에 그대로 노출하지 않는다.
- secret-shaped 문자열은 persistence 전에 redaction한다.
- retryable은 호출자가 추정하지 않고 producer가 명시한다.
- conflict에는 expected/current revision을 포함한다.
- permission 오류에는 필요한 authority와 현재 authority를 포함한다.

## 3.6 이벤트 확장 원칙

신규 이벤트는 다음 세 부류로 나눈다.

1. **journaled state transition**
   - daemon/graph/edit/memory/worktree/plugin 상태 변경
2. **journaled audit evidence**
   - LSP diagnostics snapshot, hook decision, merge verification
3. **ephemeral progress**
   - stream delta, indexing percentage, plugin log tail

이벤트 추가 시 수행할 작업:

- `packages/protocol-ts/src/events.ts` 수정
- `schemas/events/event.schema.json` 수정
- reducer에서 unknown/new event handling
- `scripts/check-protocol-drift.ts` 통과
- `schemas/CHANGELOG.md` 기록
- legacy replay fixture 추가

## 3.7 공통 feature flag

초기 롤아웃은 다음 top-level config를 제안한다.

```toml
[experimental]
edit_engine_v2 = false
full_lsp = false
session_daemon = false
durable_memory = false
persistent_agent_graph = false
worktree_multi_agent = false
plugin_runtime = false
app_server = false
```

정식화 시 `experimental.*`에서 각 공식 section으로 이동한다.

## 3.8 공통 성능 예산

| 경로 | 목표 예산 |
|---|---:|
| local App Server command admission p95 | 20 ms 이하 |
| event publish to attached local client p95 | 50 ms 이하 |
| exact range edit preflight, 1 MB 이하 파일 p95 | 30 ms 이하 |
| anchor resolution, 후보 10개 이하 p95 | 50 ms 이하 |
| daemon warm attach p95 | 500 ms 이하 |
| graph state projection 10,000 node p95 | 100 ms 이하 |
| memory exact-key recall p95 | 20 ms 이하 |
| memory FTS/semantic candidate query p95 | 100 ms 이하 |
| plugin before-hook aggregate budget 기본값 | 2 s 이하 |
| LSP query timeout 기본값 | server config 기준 15 s 유지 |

위 값은 release gate 목표이며 특정 CI wall-clock을 직접 hard gate로 삼지 않는다.

## 3.9 공통 backward compatibility

- 기존 `fs.apply_patch`를 즉시 제거하지 않는다.
- 기존 `task.spawn/status/cancel` 도구는 compatibility adapter로 유지한다.
- 기존 interactive CLI는 daemon disabled일 때 embedded mode로 작동할 수 있다.
- 기존 session journal과 snapshot을 새 reducer가 읽을 수 있어야 한다.
- 기존 config 키는 migration warning 후 단계적으로 폐기한다.
- 구버전 runtime과 신버전 host 조합은 handshake capability로 기능을 내린다.
- 신버전 runtime과 구버전 host 조합은 unknown method를 호출하지 않는다.

---

# 4. 공통 저장소 구조 변경안

## 4.1 신규 TypeScript 패키지

```text
packages/
  edit-domain/
    src/
      anchor.ts
      range.ts
      plan.ts
      receipt.ts
      recovery.ts
      index.ts
    test/
  lsp-domain/
    src/
      protocol.ts
      capabilities.ts
      documents.ts
      diagnostics.ts
      workspace-edit.ts
      tools.ts
      index.ts
    test/
  memory-service/
    src/
      service.ts
      store.ts
      resolver.ts
      invalidation.ts
      projection.ts
      index.ts
    test/
  agent-graph-domain/
    src/
      node.ts
      edge.ts
      command.ts
      reducer.ts
      scheduler.ts
      mailbox.ts
      checkpoint.ts
      index.ts
    test/
  plugin-sdk/
    src/
      manifest.ts
      hooks.ts
      tools.ts
      commands.ts
      client.ts
      testing.ts
      index.ts
    test/
  app-protocol/
    src/
      methods.ts
      events.ts
      errors.ts
      handshake.ts
      schemas.ts
      index.ts
    test/
  sdk-typescript/
    src/
      client.ts
      session.ts
      stream.ts
      approvals.ts
      generated/
      index.ts
    test/
  sdk-python/
    capybara_code/
      client.py
      session.py
      stream.py
      approvals.py
      generated/
    tests/
```

## 4.2 신규 앱

```text
apps/
  capy-daemon/
    src/
      main.ts
      daemon.ts
      instance-lock.ts
      local-transport.ts
      workspace-supervisor.ts
      session-actor.ts
      event-hub.ts
      approval-manager.ts
      recovery.ts
      shutdown.ts
    test/
  capy-app-server/
    src/
      server.ts
      router.ts
      authentication.ts
      subscriptions.ts
      backpressure.ts
      adapters/
    test/
```

초기에는 daemon과 app server를 하나의 executable에 포함할 수 있다.

단, package 책임은 논리적으로 분리한다.

## 4.3 Rust 변경안

```text
crates/
  cbc-patch/
    src/
      edit/
        mod.rs
        anchor.rs
        range.rs
        plan.rs
        preview.rs
        rebase.rs
  cbc-git/
    src/
      worktree.rs
      refs.rs
      merge.rs
  cbc-runtime/
    src/handlers/
      edit.rs
      worktree.rs
      graph_store.rs      # 선택: store 전용 handler
      memory_store.rs     # 선택: store 전용 handler
  cbc-session-store/
    src/
      memory.rs
      graph.rs
      daemon.rs
      worktree.rs
      plugins.rs
```

Rust에 agent reasoning이나 scheduling을 옮기지 않는다.

Rust는 persistence integrity, filesystem/Git/process authority, transaction, path containment을 담당한다.

## 4.4 schema 변경안

```text
schemas/
  app/
    handshake.schema.json
    rpc.schema.json
    event-stream.schema.json
  edit/
    plan.schema.json
    receipt.schema.json
  lsp/
    result.schema.json
    workspace-edit.schema.json
  memory/
    record.schema.json
    transition.schema.json
  agent-graph/
    node.schema.json
    command.schema.json
    event.schema.json
  plugin/
    manifest.schema.json
    hook.schema.json
  sdk/
    openapi-or-jsonrpc-manifest.json
```

---

# 5. 공통 DB 마이그레이션 계획

현재 schema version 6을 기준으로 forward-only migration을 추가한다.

## 5.1 제안 migration 순서

| 버전 | 이름 | 주요 변경 |
|---:|---|---|
| 7 | `edit-receipts` | edit plan/operation/receipt와 file operation metadata 확장 |
| 8 | `daemon-ownership` | daemon instance, session ownership lease, client attachment, command idempotency |
| 9 | `durable-memory` | memory record/evidence link/transition/path binding |
| 10 | `persistent-agent-graph` | graph/node/edge/attempt/message/checkpoint/budget reservation |
| 11 | `worktree-multi-agent` | worktree, worktree lease, proposal, merge attempt/conflict |
| 12 | `plugin-runtime` | plugin install, permission grant, invocation, KV state |
| 13 | `app-server-cursors` | subscription cursor와 client replay state가 필요할 경우 추가 |

## 5.2 migration 정책

- 기존 migration checksum을 수정하지 않는다.
- 신규 migration은 append-only다.
- destructive migration이 필요하면 DB backup을 먼저 생성한다.
- 신규 table은 가능한 한 기존 session/workspace foreign key를 재사용한다.
- 큰 backfill은 transaction을 짧게 유지하도록 lazy migration을 사용한다.
- migration 후 integrity check를 수행한다.
- 실패하면 원본 DB를 유지하고 daemon startup을 중단한다.
- schema가 더 최신이면 구버전 daemon은 read-only diagnostic만 제공한다.

## 5.3 신규 공통 table

```sql
CREATE TABLE command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  canonical_payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_command_receipts_created
  ON command_receipts(created_at DESC);
```

용도:

- App Server command 재전송 처리
- daemon crash 후 command 결과 조회
- plugin hook에서 동일 operation 중복 실행 방지
- SDK timeout 후 safe retry

---

# 6. 공통 테스트 전략

## 6.1 테스트 계층

1. **pure domain unit test**
2. **schema contract test**
3. **TypeScript fake runtime integration test**
4. **real Rust runtime integration test**
5. **crash/restart test**
6. **security adversarial fixture**
7. **benchmark cohort**
8. **cross-platform packaging smoke test**

## 6.2 필수 fault injection

- event append 직전 crash
- event append 직후 snapshot 전 crash
- transaction stage 중 crash
- transaction commit 응답 유실
- daemon kill -9
- client disconnect
- LSP malformed frame
- LSP huge diagnostics
- plugin timeout
- plugin process crash
- SDK stream lag/backpressure
- worktree directory 삭제
- Git HEAD 변경
- memory evidence invalidation race
- graph dependency completion과 cancel race
- idempotent command 중복 전송

## 6.3 보안 fixture 추가

```text
fixtures/
  edit-engine/
    ambiguous-anchor/
    unicode-offset/
    stale-revision/
    overlapping-edits/
    symlink-swap/
  lsp-servers/
    malicious-workspace-edit.ts
    oversized-diagnostics.ts
    invalid-utf16-range.ts
    stdout-noise.ts
  plugins/
    escape-workspace/
    secret-exfiltration/
    infinite-hook/
    authority-escalation/
    forged-receipt/
  worktrees/
    path-escape/
    replaced-git-dir/
    conflict-after-proposal/
  app-server/
    unauthorized-socket-client/
    replay-cursor-gap/
    request-id-collision/
```

---
# 7. 개선 항목 1 — Anchor / Range Edit Engine

## 7.1 목표

### 7.1.1 제품 목표

- 모델이 전체 unified diff를 재생성하지 않고 작은 변경을 정확히 표현한다.
- line drift가 있어도 안전하게 anchor를 재해결할 수 있다.
- stale read를 자동 덮어쓰지 않는다.
- LSP `WorkspaceEdit`와 모델 편집이 같은 transaction 경로를 사용한다.
- multi-file rename과 code action을 all-or-nothing으로 적용한다.
- 적용 전 preview와 적용 후 receipt를 제공한다.
- 실패 원인이 model이 복구 가능한 구조화 오류로 반환된다.

### 7.1.2 성공 지표

- 1 MB 이하 text file의 단일 edit first-apply 성공률 95% 이상
- stale revision을 잘못 적용한 건수 0
- ambiguous anchor를 임의 선택한 건수 0
- multi-file partial commit 0
- Unicode offset 변환 오류 0
- 기존 `fs.apply_patch` 대비 평균 edit output token 감소 측정
- edit retry 횟수 감소 측정
- LSP rename에서 누락 reference 0

## 7.2 비목표

- binary editor
- 이미지·PDF 구조 편집
- CRDT 공동 편집
- arbitrary regex replace를 기본 mutation tool로 제공
- LSP server가 직접 filesystem에 write
- expected revision 없는 기존 파일 overwrite 허용
- syntax tree parser를 모든 언어에 자체 구현

## 7.3 현행 연결 지점

### 7.3.1 TypeScript

- `apps/cbc/src/runtime.ts`
  - `ReadResponse.revisionToken`
  - `ReadResponse.authoritativeForWrite`
  - `Runtime.fingerprint`
  - transaction facade
- `apps/cbc/src/tools.ts`
  - `RuntimeToolExecutor.#mutate`
  - patch/write/move/delete dispatch
  - transaction event emit
- `apps/cbc/src/normalizer.ts`
  - path normalization
  - action hash에 들어갈 read/write path 추출
- `packages/tool-registry/src/catalog.ts`
  - model-facing tool schema
- `packages/tool-registry/src/validate.ts`
  - strict argument validation
- `packages/tool-registry/src/scheduler.ts`
  - writer serialization과 path overlap
- `packages/context-engine/src/engine.ts`
  - mutation 후 evidence/path invalidation

### 7.3.2 Rust

- `crates/cbc-patch/src/transaction.rs`
  - staged mutation
  - expected hash conflict
  - atomic commit/rollback
- `crates/cbc-patch/src/diff.rs`
  - unified diff compatibility
- `crates/cbc-runtime/src/handlers/transaction.rs`
  - begin/commit/rollback
- `crates/cbc-runtime/src/handlers/fs.rs`
  - patch/write/move/delete
- `crates/cbc-fs/src/atomic.rs`
  - atomic write
- `crates/cbc-fs/src/beneath.rs`
  - workspace path containment
- `crates/cbc-session-store`
  - file operation receipt persistence

## 7.4 설계 결정

### 7.4.1 하나의 canonical edit plan

모델, LSP, plugin, merge coordinator가 모두 다음 canonical plan을 생성한다.

```ts
export interface EditPlan {
  schemaVersion: "1.0";
  id: `edp_${string}`;
  source: "model" | "lsp" | "plugin" | "merge" | "user";
  workspaceIdentityDigest: string;
  worktreeId?: string;
  sessionId: string;
  turnId?: string;
  agentId?: string;
  baseWorkspaceRevision?: string;
  operations: EditOperation[];
  conflictPolicy: "fail" | "safe_rebase";
  verificationHints?: string[];
  createdAt: string;
}
```

### 7.4.2 operation union

```ts
export type EditOperation =
  | ReplaceAnchorOperation
  | ReplaceRangeOperation
  | InsertBeforeOperation
  | InsertAfterOperation
  | DeleteAnchorOperation
  | CreateFileOperation
  | MoveFileOperation
  | DeleteFileOperation;
```

기존 create/move/delete도 plan union에 포함하는 이유:

- LSP rename이 파일 rename과 text edit를 함께 제안할 수 있다.
- worktree merge가 create/delete/rename을 한 receipt로 표현할 수 있다.
- overlap과 path scope를 한 번에 계산할 수 있다.
- transaction 전부를 한 preflight 결과로 검증할 수 있다.

## 7.5 Range 표현

### 7.5.1 canonical 좌표

Rust runtime 내부 canonical 좌표는 UTF-8 byte offset이다.

외부 API는 다음 두 표현을 받는다.

```ts
export interface TextPosition {
  line: number;       // 1-based
  column: number;     // encoding 단위, 1-based
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
  encoding: "utf8" | "utf16" | "unicode_scalar";
}
```

규칙:

- model-facing 기본 encoding은 `utf8`이다.
- LSP adapter는 server가 협상한 `positionEncoding`을 명시한다.
- line ending은 logical line으로 계산한다.
- end는 exclusive다.
- surrogate pair 중간 좌표는 거부한다.
- invalid UTF-8 text file은 text edit 대상이 아니다.
- BOM은 파일 content 일부로 보존하되 line/column 계산에서 명시적으로 처리한다.

### 7.5.2 range edit operation

```ts
export interface ReplaceRangeOperation {
  kind: "replace_range";
  operationId: `edo_${string}`;
  path: string;
  baseRevision: string;
  range: TextRange;
  expectedTextDigest?: string;
  replacement: string;
}
```

`expectedTextDigest` 규칙:

- 제공되면 해당 range의 원문 digest와 일치해야 한다.
- 제공되지 않아도 baseRevision은 필수다.
- LSP edit는 document version과 file revision을 모두 바인딩한다.

## 7.6 Anchor 표현

### 7.6.1 anchor 종류

```ts
export type EditAnchor =
  | ExactTextAnchor
  | ContextAnchor
  | SymbolAnchor;
```

### 7.6.2 ExactTextAnchor

```ts
export interface ExactTextAnchor {
  kind: "exact_text";
  baseRevision: string;
  originalText: string;
  originalTextDigest: string;
  occurrence?: number;
  expectedRange?: TextRange;
}
```

정책:

- `originalText`는 크기 상한을 둔다.
- 동일 text가 여러 번 나오면 `expectedRange`, context, occurrence 중 하나가 필요하다.
- occurrence만으로 ambiguity를 숨기지 않는다.
- base revision이 같으면 exact position을 우선 검증한다.

### 7.6.3 ContextAnchor

```ts
export interface ContextAnchor {
  kind: "context";
  baseRevision: string;
  targetDigest: string;
  targetPreview?: string;
  before: string[];
  after: string[];
  approximateLine?: number;
  symbolPath?: string[];
  whitespacePolicy: "exact" | "normalize_eol" | "normalize_indent";
}
```

정책:

- `before`와 `after`는 bounded line array다.
- target 전체가 크면 digest와 preview를 사용한다.
- `normalize_indent`는 비교 단계에서만 사용한다.
- 실제 적용은 원문 byte range에 수행한다.
- normalization이 서로 다른 두 후보를 하나로 합치면 ambiguous 처리한다.

### 7.6.4 SymbolAnchor

```ts
export interface SymbolAnchor {
  kind: "symbol";
  baseRevision: string;
  languageId: string;
  symbolPath: string[];
  symbolKind?: string;
  relativeRange?: TextRange;
  symbolBodyDigest?: string;
  fallbackContext?: ContextAnchor;
}
```

정책:

- SymbolAnchor는 LSP/RepositoryIntelligence가 생성한다.
- 모델이 임의 symbol name만 넣어 mutation 권한을 얻지 못한다.
- symbol range는 current document revision과 함께 서명된 local receipt로 전달한다.
- LSP가 unavailable이면 fallback context를 사용할 수 있다.
- symbol이 둘 이상이면 ambiguous다.

## 7.7 anchor token

read 결과에 optional anchor metadata를 추가한다.

```ts
export interface ReadAnchorToken {
  schemaVersion: "1.0";
  token: string;
  path: string;
  revisionToken: string;
  range: TextRange;
  exactTextDigest: string;
  contextDigest: string;
  expiresAt?: string;
}
```

토큰 생성:

```text
HMAC/runtime-local-signature(
  workspaceIdentityDigest,
  path,
  revisionToken,
  canonicalRange,
  exactTextDigest,
  contextDigest
)
```

목적:

- model이 anchor 내부의 path/revision/range를 변조하지 못하게 한다.
- child context handoff에서 exact excerpt authority를 증명한다.
- plugin/LSP proposal을 runtime source와 구분한다.

초기 구현에서 HMAC 없이 canonical digest를 사용할 수 있으나,
App Server를 외부 client가 사용할 시점에는 daemon-local signing key가 필요하다.

## 7.8 model-facing tool

### 7.8.1 `fs.edit`

```json
{
  "id": "fs.edit",
  "title": "Edit",
  "defaultRisk": "R2",
  "mutates": true,
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["operations"],
    "properties": {
      "operations": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": { "$ref": "cbc:edit/operation" }
      },
      "conflictPolicy": {
        "type": "string",
        "enum": ["fail", "safe_rebase"],
        "default": "fail"
      },
      "preview": {
        "type": "boolean",
        "default": false
      }
    }
  }
}
```

### 7.8.2 활성화 정책

- `fs.edit`는 Build mode에서 always-active 후보로 검토한다.
- 초기 rollout에서는 `tool.discover` 뒤 활성화할 수 있다.
- Plan mode에서는 `preview=true`만 허용할 수 있다.
- 실제 mutation은 Plan mode에서 runtime이 거부한다.

### 7.8.3 tool result

```ts
export interface EditToolResult {
  planId: string;
  status: "previewed" | "committed" | "conflicted" | "no_change";
  transactionId?: string;
  receiptId?: string;
  files: Array<{
    path: string;
    revisionBefore: string;
    revisionAfter?: string;
    operations: number;
    additions: number;
    deletions: number;
  }>;
  diffPreview: DiffPreviewLine[];
  conflicts?: EditConflict[];
  evidenceIds: string[];
}
```

## 7.9 preflight pipeline

```text
1. schema validation
2. path normalization
3. workspace/worktree identity validation
4. permission classification
5. capability receipt issue
6. exact file read + current revision capture
7. range conversion to UTF-8 byte offsets
8. anchor resolution
9. safe rebase evaluation
10. operation overlap detection
11. per-file operation ordering
12. resulting content construction in memory
13. no-change detection
14. size/binary/line-ending validation
15. transaction begin
16. stage complete file outcomes
17. optional preview return or commit
18. commit receipt + evidence + context invalidation
```

## 7.10 anchor resolution algorithm

### 7.10.1 단계

1. current revision을 읽는다.
2. base revision과 같으면 recorded range를 검증한다.
3. exact text digest가 같으면 즉시 해결한다.
4. base revision이 다르고 policy가 `fail`이면 conflict다.
5. policy가 `safe_rebase`이면 bounded candidate search를 수행한다.
6. exact target text 후보를 찾는다.
7. before/after context score를 계산한다.
8. approximate line distance를 계산한다.
9. symbol containment score를 계산한다.
10. normalization policy별 score를 계산한다.
11. 최고 후보가 유일하고 minimum confidence 이상인지 확인한다.
12. 두 후보 score 차이가 margin보다 작으면 ambiguous다.
13. 해결된 byte range와 근거를 receipt에 기록한다.

### 7.10.2 점수 예시

```text
exact target digest              +100
all before lines exact           +30
all after lines exact            +30
symbol path exact                +25
approximate line within 5        +15
approximate line within 20       +8
normalized-indent-only match     +5
missing target digest            reject
multiple equal highest score     ambiguous
```

점수 값은 config로 노출하지 않고 코드 상수와 benchmark로 관리한다.

### 7.10.3 search bound

- 파일 크기 상한 내에서만 full search한다.
- 큰 파일은 approximate line 주변 window를 먼저 탐색한다.
- 후보 최대 수를 초과하면 ambiguous로 종료한다.
- regex backtracking을 사용하지 않는다.
- target length가 너무 짧으면 context 요구를 강화한다.

## 7.11 operation ordering과 overlap

### 7.11.1 range operation

- 한 파일의 모든 operation을 원본 revision 기준 byte range로 변환한다.
- range를 start ascending으로 정렬해 overlap을 검사한다.
- 실제 적용은 end descending으로 수행한다.
- 접하는 range는 허용한다.
- 겹치는 range는 기본적으로 거부한다.

### 7.11.2 insert ordering

같은 offset의 insert가 여러 개이면 다음 순서를 사용한다.

1. explicit `order`가 있으면 해당 값
2. source priority
3. operationId lexical order

초기 tool schema에서 `order`를 노출하지 않고 producer adapter가 설정한다.

### 7.11.3 file operation conflict

- move 후 원래 path edit는 거부한다.
- create와 delete가 같은 path를 가리키면 거부한다.
- delete 대상에 text edit가 있으면 거부한다.
- rename destination이 이미 존재하면 `AlreadyExists`다.
- case-insensitive filesystem collision을 runtime에서 검사한다.

## 7.12 safe rebase 정책

safe rebase가 허용되는 조건:

- operation이 anchor 기반이다.
- current file이 text file이다.
- target 후보가 유일하다.
- exact target digest가 일치한다.
- resolved range가 forbidden path나 lease 밖으로 이동하지 않는다.
- producer가 `safe_rebase`를 요청했다.
- policy가 source type에 대해 rebase를 허용한다.

safe rebase가 허용되지 않는 조건:

- raw range operation
- delete/move/create conflict
- target text가 변경됨
- 두 개 이상 후보
- document encoding 변경
- line ending normalization 외 content-wide transform
- generated file policy가 rebase를 금지
- user edit와 semantic conflict 가능성이 높음

## 7.13 preview

### 7.13.1 preview 결과

- resolved operation 목록
- current revision
- proposed post revision digest
- diff preview
- additions/deletions
- conflict 목록
- LSP diagnostic 예상값이 있으면 별도 hint
- permission requirement
- commit 시 발급될 capability scope

### 7.13.2 preview와 commit 사이

- preview receipt는 mutation authority가 아니다.
- commit 요청 시 current revision을 다시 검증한다.
- preview digest를 `expectedPlanDigest`로 전달할 수 있다.
- plan digest가 다르면 commit을 거부한다.

## 7.14 Runtime RPC 변경

### 7.14.1 신규 request

```text
fs.edit.preview
fs.edit
```

권장 최종 구조:

- `fs.edit.preview`: transaction 없이 결과 content/diff 계산
- `fs.edit`: 열린 transaction 안에서 stage

기존 mutation pattern과 맞추려면 model-facing executor는 다음 순서로 호출한다.

```text
runtime.capability.issue
fs.transaction.begin
fs.edit
fs.transaction.commit
```

### 7.14.2 `fs.edit` params

```rust
pub struct EditParams {
    pub transaction_id: String,
    pub plan: EditPlanWire,
    pub capability_receipt: String,
    pub capability_session_id: String,
    pub capability_action_hash: String,
}
```

### 7.14.3 runtime revalidation

- capability operation은 `fs.transaction` 또는 `fs.edit`에 바인딩한다.
- resources에는 모든 read/write path와 worktree identity를 포함한다.
- plan의 path와 capability resources가 정확히 일치해야 한다.
- expected revision과 current hash를 Rust에서 비교한다.
- TypeScript가 전달한 resolved byte range를 다시 검증하거나 Rust가 직접 resolve한다.

**[결정]** anchor resolution의 최종 authority는 Rust다.

TypeScript는 preview와 model recovery를 돕지만,
commit에 사용되는 range는 Rust가 current bytes에 대해 다시 계산한다.

## 7.15 Rust 내부 구조

```rust
pub struct EditPlan {
    pub id: String,
    pub source: EditSource,
    pub operations: Vec<EditOperation>,
    pub conflict_policy: ConflictPolicy,
}

pub enum EditOperation {
    ReplaceAnchor(ReplaceAnchor),
    ReplaceRange(ReplaceRange),
    InsertBefore(InsertAnchor),
    InsertAfter(InsertAnchor),
    DeleteAnchor(DeleteAnchor),
    Create(CreateFile),
    Move(MoveFile),
    Delete(DeleteFile),
}

pub struct ResolvedEdit {
    pub operation_id: String,
    pub path: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub replacement: String,
    pub resolution: ResolutionEvidence,
}
```

## 7.16 오류 코드

| 코드 | 의미 | retryable |
|---|---|---:|
| `EDIT_REVISION_MISMATCH` | base revision과 current revision 불일치 | 조건부 |
| `EDIT_ANCHOR_NOT_FOUND` | target 후보 없음 | true |
| `EDIT_ANCHOR_AMBIGUOUS` | 유일 후보를 결정할 수 없음 | true |
| `EDIT_RANGE_INVALID` | line/column/range가 유효하지 않음 | false |
| `EDIT_ENCODING_MISMATCH` | UTF-16/UTF-8 변환 불가능 | false |
| `EDIT_OVERLAP` | operation range가 겹침 | true |
| `EDIT_PATH_CONFLICT` | create/move/delete/text edit 충돌 | true |
| `EDIT_BINARY_UNSUPPORTED` | binary file edit 시도 | false |
| `EDIT_FILE_TOO_LARGE` | configured limit 초과 | false |
| `EDIT_NO_CHANGE` | 결과가 원문과 동일 | false |
| `EDIT_PLAN_DIGEST_MISMATCH` | preview 후 plan 변경 | false |
| `EDIT_SCOPE_VIOLATION` | writer lease 밖 path | false |
| `EDIT_TOKEN_INVALID` | anchor token 검증 실패 | false |

## 7.17 이벤트

추가 event kind:

```text
edit.plan_created
edit.preview_completed
edit.operation_resolved
edit.rebased
edit.conflicted
edit.staged
edit.committed
edit.no_change
```

권장 durability:

| 이벤트 | durability | visibility |
|---|---|---|
| `edit.plan_created` | journaled | hidden |
| `edit.preview_completed` | journaled | drawer |
| `edit.operation_resolved` | journaled | hidden |
| `edit.rebased` | journaled | timeline |
| `edit.conflicted` | journaled | timeline |
| `edit.staged` | journaled | hidden |
| `edit.committed` | journaled | timeline |
| `edit.no_change` | journaled | timeline |

기존 `transaction.*`와 `diff.updated` 이벤트는 유지한다.

## 7.18 persistence

### 7.18.1 migration 7

```sql
CREATE TABLE edit_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT,
  agent_id TEXT,
  source TEXT NOT NULL,
  workspace_identity_digest TEXT NOT NULL,
  worktree_id TEXT,
  base_workspace_revision TEXT,
  plan_digest TEXT NOT NULL,
  conflict_policy TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE edit_operations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES edit_plans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  base_revision TEXT,
  operation_json TEXT NOT NULL,
  resolved_range_json TEXT,
  resolution_evidence_json TEXT,
  status TEXT NOT NULL,
  error_code TEXT
);

CREATE INDEX idx_edit_operations_plan
  ON edit_operations(plan_id, ordinal);

CREATE TABLE edit_receipts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES edit_plans(id) ON DELETE CASCADE,
  transaction_id TEXT,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 7.18.2 retention

- committed receipt는 session retention을 따른다.
- large original/replacement text는 table에 직접 중복 저장하지 않는다.
- 큰 plan body는 redacted artifact CAS에 저장한다.
- DB에는 digest와 bounded metadata를 유지한다.

## 7.19 config

```toml
[edit]
engine = "anchor-range-v2"
max_operations_per_plan = 100
max_file_bytes = 8388608
max_anchor_text_bytes = 65536
max_anchor_candidates = 32
safe_rebase = true
preview_before_lsp_mutation = true
record_resolution_evidence = true

[edit.limits]
max_total_changed_bytes = 16777216
max_total_files = 100
max_diff_preview_lines = 300
```

정책:

- project config는 limit을 낮출 수만 있다.
- safe_rebase를 user가 false로 설정하면 project가 true로 바꾸지 못한다.
- plugin은 edit limit을 넓힐 수 없다.

## 7.20 파일 변경 목록

### 수정

```text
apps/cbc/src/runtime.ts
apps/cbc/src/tools.ts
apps/cbc/src/normalizer.ts
apps/cbc/src/agent.ts
packages/tool-registry/src/catalog.ts
packages/tool-registry/src/validate.ts
packages/tool-registry/src/scheduler.ts
packages/context-engine/src/engine.ts
packages/protocol-ts/src/events.ts
packages/config-schema/src/schema.ts
packages/config-schema/src/key-status.ts
crates/cbc-protocol/src/methods.rs
crates/cbc-runtime/src/server.rs
crates/cbc-runtime/src/handlers/fs.rs
crates/cbc-runtime/src/handlers/mod.rs
crates/cbc-patch/src/lib.rs
crates/cbc-patch/src/transaction.rs
crates/cbc-session-store/src/migrations.rs
schemas/events/event.schema.json
schemas/tools/tool.schema.json
schemas/config/config.schema.json
schemas/protocol/rpc.schema.json
schemas/CHANGELOG.md
```

### 신규

```text
packages/edit-domain/**
crates/cbc-patch/src/edit/**
crates/cbc-runtime/src/handlers/edit.rs
schemas/edit/**
fixtures/edit-engine/**
```

## 7.21 테스트 계획

### unit

- UTF-8 byte/line/column round trip
- UTF-16 surrogate pair conversion
- CRLF/LF preservation
- BOM preservation
- exact anchor unique match
- context anchor unique match
- ambiguous anchor detection
- symbol anchor fallback
- safe rebase threshold
- range overlap detection
- same-offset insert ordering
- create/move/delete conflict
- plan digest stability
- no-change detection

### Rust integration

- expected revision mismatch
- path traversal
- symlink swap
- multi-file atomic commit
- rollback after second file stage failure
- rollback after commit failure injection
- Unicode replacement
- very large replacement rejection
- capability resource mismatch
- worktree identity mismatch

### product integration

- model read → anchor edit → verify
- preview → concurrent user edit → commit conflict
- LSP rename → Edit Engine → diagnostics
- child writer lease enforcement
- context evidence invalidation
- session replay shows edit receipt

### fuzz/property

- random Unicode text range conversion never panics
- random overlapping operation set is deterministic
- canonical plan digest is stable across object key order
- edit then undo restores exact bytes when post-image unchanged
- edit never changes bytes outside resolved ranges

## 7.22 완료 기준

- [ ] `fs.edit` strict schema가 추가된다.
- [ ] Rust runtime이 anchor를 최종 재검증한다.
- [ ] 기존 transaction atomicity가 유지된다.
- [ ] ambiguous anchor는 항상 conflict다.
- [ ] UTF-8/UTF-16 변환 corpus가 통과한다.
- [ ] preview와 commit digest binding이 동작한다.
- [ ] LSP WorkspaceEdit adapter가 같은 plan을 사용한다.
- [ ] edit resolution evidence가 journal/replay된다.
- [ ] feature flag off에서 현재 behavior가 동일하다.
- [ ] 기존 `fs.apply_patch` fixture가 회귀 없이 통과한다.
- [ ] CBC Bench에 edit precision category가 추가된다.

## 7.23 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| EDT-001 | edit-domain package 생성 | 공통 TypeScript types |
| EDT-002 | edit JSON schema 생성 | strict operation union |
| EDT-003 | canonical serializer/digest | deterministic plan digest |
| EDT-004 | UTF-8 range converter | line/column ↔ byte offset |
| EDT-005 | UTF-16 converter | LSP position adapter |
| EDT-006 | anchor token type | read/edit binding |
| EDT-007 | exact anchor resolver | unique match engine |
| EDT-008 | context anchor resolver | bounded scored search |
| EDT-009 | symbol anchor adapter | LSP/RepoIntelligence bridge |
| EDT-010 | overlap validator | per-file interval analysis |
| EDT-011 | operation planner | ordered resolved plan |
| EDT-012 | result content builder | in-memory post image |
| EDT-013 | preview renderer | diff/stat/conflict output |
| EDT-014 | Rust wire types | serde contracts |
| EDT-015 | Rust range conversion | authoritative offset resolution |
| EDT-016 | Rust anchor resolver | final commit authority |
| EDT-017 | transaction stage adapter | complete-file staged mutation |
| EDT-018 | `fs.edit.preview` handler | read-only RPC |
| EDT-019 | `fs.edit` handler | transaction RPC |
| EDT-020 | capability binding | path/worktree/action hash |
| EDT-021 | Runtime facade | typed methods |
| EDT-022 | RuntimeToolExecutor path | begin/stage/commit/rollback |
| EDT-023 | normalizer support | read/write/resource paths |
| EDT-024 | tool catalog support | model-facing `fs.edit` |
| EDT-025 | events | edit lifecycle kinds |
| EDT-026 | reducer/TUI | edit conflict/receipt projection |
| EDT-027 | migration 7 | edit tables |
| EDT-028 | artifact spill | large plan/preview |
| EDT-029 | config | edit limits/policies |
| EDT-030 | compatibility adapter | `fs.apply_patch` coexistence |
| EDT-031 | fault injection tests | crash/rollback/conflict |
| EDT-032 | fuzz corpus | Unicode/anchor/overlap |
| EDT-033 | benchmark | first-apply/token/retry metrics |
| EDT-034 | documentation | tool contract and migration |

---

# 8. 개선 항목 2 — Full LSP

## 8.1 목표

Full LSP의 목적은 “language server가 파일을 수정하게 하는 것”이 아니다.

목적은 다음과 같다.

- 정확한 symbol 탐색
- definition/reference/type/implementation 조회
- current diagnostics 관찰
- rename/code action/formatting proposal 생성
- proposal을 Edit Engine으로 안전하게 변환
- 변경 후 diagnostics delta를 evidence로 기록
- workspace와 worktree별 language intelligence 유지

## 8.2 지원 기능 범위

### 8.2.1 P0 query

- `textDocument/documentSymbol`
- `workspace/symbol`
- `textDocument/definition`
- `textDocument/declaration`
- `textDocument/typeDefinition`
- `textDocument/implementation`
- `textDocument/references`
- `textDocument/hover`
- `textDocument/signatureHelp`
- `textDocument/documentHighlight`

### 8.2.2 P0 diagnostics

- `textDocument/publishDiagnostics`
- pull diagnostics capability가 있으면 `textDocument/diagnostic`
- workspace diagnostics capability가 있으면 bounded `workspace/diagnostic`

### 8.2.3 P1 mutation proposal

- `textDocument/prepareRename`
- `textDocument/rename`
- `textDocument/codeAction`
- `codeAction/resolve`
- `textDocument/formatting`
- `textDocument/rangeFormatting`
- `workspace/executeCommand` 제한적 지원

### 8.2.4 P1 hierarchy

- `textDocument/prepareCallHierarchy`
- `callHierarchy/incomingCalls`
- `callHierarchy/outgoingCalls`
- type hierarchy 대응 method

### 8.2.5 제외

- arbitrary server command 자동 실행
- dynamic registration을 무제한 신뢰
- server가 요청한 `workspace/applyEdit` 직접 적용
- server가 요청한 `window/showDocument` 자동 열기
- server가 요청한 network access 자동 허용
- language server 자동 다운로드/설치

## 8.3 아키텍처

```text
LspSupervisor
  ├─ LspServerRegistry
  ├─ LspProcessSession[]
  │    ├─ Framer
  │    ├─ CapabilityMatrix
  │    ├─ PendingRequestMap
  │    └─ NotificationRouter
  ├─ DocumentStore
  │    ├─ file revision
  │    ├─ document version
  │    ├─ text snapshot handle
  │    └─ position encoding
  ├─ DiagnosticIndex
  ├─ SymbolIndexAdapter
  ├─ WorkspaceEditAdapter
  ├─ LspEvidenceProjector
  └─ LspToolBridge
```

## 8.4 프로세스 소유권

### 8.4.1 현행에서 변경

현재 LSP host는 session bootstrap이 생성하고 session close 시 종료한다.

**[결정]** daemon 도입 후 LSP는 `WorkspaceSupervisor`가 소유한다.

key:

```text
workspaceIdentityDigest + worktreeId + serverDescriptorDigest
```

효과:

- TUI detach 후에도 index 유지
- 같은 workspace의 여러 session이 process를 공유
- worktree별 text state 격리
- server 재시작 횟수 감소
- memory/graph가 동일 diagnostics를 참조

### 8.4.2 lifecycle

```text
configured
  → resolving_executable
  → starting
  → initializing
  → ready
  → degraded
  → restarting
  → quiesced
  → stopped
```

### 8.4.3 restart policy

- malformed frame: 즉시 stop, bounded backoff 후 restart
- exit code 0: 요청에 따른 stop이면 정상
- repeated crash: degraded 후 circuit open
- output limit: stop, security finding 기록
- workspace trust revoke: 즉시 stop
- worktree delete: 즉시 stop
- daemon shutdown: graceful shutdown request 후 강제 종료

## 8.5 protocol framing

현행 bounded framing을 유지하고 강화한다.

- header 최대 크기
- frame 최대 크기
- total output 최대 크기
- invalid `Content-Length` 거부
- duplicate header 처리 규칙
- UTF-8 JSON decode 실패 처리
- notification flood rate limit
- pending request 수 상한
- request timeout
- late response 무시 및 metric 기록

## 8.6 initialize capability

client capability는 실제 지원 기능만 광고한다.

```ts
export interface LspClientFeatureSet {
  documentSymbol: boolean;
  workspaceSymbol: boolean;
  definition: boolean;
  references: boolean;
  hover: boolean;
  diagnostics: "push" | "pull" | "both" | "none";
  rename: boolean;
  codeAction: boolean;
  formatting: boolean;
  callHierarchy: boolean;
  positionEncodings: Array<"utf-8" | "utf-16" | "utf-32">;
}
```

동적 registration 정책:

- method allowlist 내 registration만 저장한다.
- selector가 workspace extension scope를 벗어나면 거부한다.
- command registration은 별도 allowlist가 없으면 비활성화한다.
- registration은 server process lifetime 동안만 유효하다.

## 8.7 DocumentStore

### 8.7.1 문서 상태

```ts
export interface LspDocumentState {
  uri: string;
  path: string;
  languageId: string;
  worktreeId?: string;
  fileRevision: string;
  lspVersion: number;
  textDigest: string;
  open: boolean;
  dirtyInServer: boolean;
  positionEncoding: "utf-8" | "utf-16" | "utf-32";
}
```

### 8.7.2 open 전략

- query 대상 문서만 lazy open한다.
- diagnostics 지속성이 필요한 active files는 bounded open set에 유지한다.
- open document cap을 초과하면 LRU close한다.
- close 전 pending request를 정리한다.
- current revision이 바뀌면 `didChange` 또는 close/reopen한다.

### 8.7.3 change source

문서 변경 source:

- committed Edit Engine transaction
- process/shell/background job 후 workspace changed
- external user edit 감지
- worktree merge
- checkout/base revision change

정확한 transaction file operation이 있으면 incremental `didChange`를 보낼 수 있다.

그 외에는 exact file reread 후 full text change를 보낸다.

## 8.8 position encoding

- initialize에서 server encoding을 협상한다.
- default LSP 3.17 behavior에 따라 UTF-16을 fallback으로 사용한다.
- Edit Engine canonical UTF-8 byte offset과 converter를 공유한다.
- converter cache key는 `path + revision + encoding`이다.
- invalid boundary는 `LSP_POSITION_INVALID`로 거부한다.
- server range를 model context에 넣기 전에 canonical 1-based line/column으로 변환한다.

## 8.9 LSP tool 계약

### 8.9.1 조회 도구

```text
lsp.symbols
lsp.workspace_symbols
lsp.definition
lsp.declaration
lsp.type_definition
lsp.implementation
lsp.references
lsp.hover
lsp.signature_help
lsp.diagnostics
lsp.call_hierarchy
```

### 8.9.2 변경 도구

```text
lsp.rename
lsp.code_actions
lsp.apply_code_action
lsp.format
```

`lsp.code_actions`는 조회다.

`lsp.apply_code_action`과 `lsp.rename`, `lsp.format`은 R2 mutation이다.

## 8.10 공통 query input

```ts
export interface LspLocationInput {
  path: string;
  position: TextPosition;
  revisionToken?: string;
  languageServer?: string;
  worktreeId?: string;
}
```

규칙:

- revision token이 제공되면 current file과 비교한다.
- preview read에서 얻은 non-authoritative token은 mutation에 사용할 수 없다.
- query는 stale token이어도 `stale=true` 표시와 함께 current query를 허용할 수 있다.
- mutation은 current exact revision을 요구한다.

## 8.11 diagnostics model

```ts
export interface DiagnosticRecord {
  id: string;
  server: string;
  path: string;
  worktreeId?: string;
  fileRevision: string;
  range: TextRange;
  severity: "error" | "warning" | "information" | "hint";
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInfo[];
  tags?: string[];
  observedAt: string;
}
```

### 8.11.1 evidence 변환

- diagnostics snapshot은 immutable evidence record로 만든다.
- evidence source는 `lsp:<server>`다.
- validFor에 workspace/worktree/path/revision을 기록한다.
- file revision 변경 시 stale 처리한다.
- full raw diagnostics가 크면 artifact로 spill한다.
- model context에는 severity별 bounded projection만 넣는다.

### 8.11.2 완료 gate

변경 전후 비교:

```text
errors_after > errors_before          → 기본 completion block
new_error_count > 0                   → block
warnings_after > warnings_before      → risk 또는 policy에 따라 block
server_unavailable                    → not_run, passed 아님
stale diagnostics                     → evidence로 사용 금지
```

## 8.12 WorkspaceEdit adapter

### 8.12.1 입력

LSP가 반환할 수 있는 형식:

- `changes: Record<uri, TextEdit[]>`
- `documentChanges: TextDocumentEdit[]`
- create/rename/delete file operations
- annotated edit

### 8.12.2 변환 절차

```text
1. URI scheme 검증
2. workspace/worktree path containment
3. document version 검증
4. LSP position → UTF-8 byte range 변환
5. 각 text edit에 expected text digest 생성
6. create/rename/delete file operation 정규화
7. annotation과 command metadata 보존
8. EditPlan 생성
9. overlap/ordering preflight
10. preview
11. permission approval
12. Rust transaction commit
13. didChange/didClose/didOpen reconcile
14. diagnostics refresh
15. verification evidence 기록
```

### 8.12.3 `workspace/applyEdit`

server가 client로 `workspace/applyEdit` 요청을 보내면:

- 자동 적용하지 않는다.
- pending proposal로 event를 생성한다.
- 요청을 시작한 LSP operation과 correlation한다.
- host가 승인·적용 후 `applied: true/false`를 반환한다.
- unsolicited applyEdit는 기본 거부한다.

## 8.13 rename flow

```text
user/model requests rename
  → exact file revision 확보
  → prepareRename
  → rename request
  → WorkspaceEdit normalize
  → EditPlan preview
  → path scope/approval
  → transaction commit
  → document revisions refresh
  → diagnostics refresh
  → reference query 재실행
  → rename coverage evidence
  → completion report
```

rename 완료 조건:

- WorkspaceEdit의 모든 file operation committed
- LSP error diagnostics 증가 없음
- old symbol reference bounded recheck 결과 없음 또는 설명된 예외
- transaction receipt 존재

## 8.14 code action policy

code action category:

- quickfix
- refactor
- refactor.extract
- refactor.inline
- source.organizeImports
- source.fixAll

정책:

- command-only action은 allowlist가 없으면 적용하지 않는다.
- edit가 포함된 action은 Edit Engine으로 변환한다.
- `source.fixAll`은 changed file 수와 byte limit을 더 낮게 둔다.
- action title은 신뢰 경계가 아니며 display text로만 사용한다.
- action data는 bounded JSON으로 저장한다.

## 8.15 formatting 정책

- whole-file formatting은 current revision 필수
- 결과가 file size limit을 넘으면 거부
- unrelated file edit 금지
- formatter 결과는 complete-file replacement가 아니라 diff/range plan으로 변환 가능
- generated file 정책과 project instruction을 검사
- default로 자동 formatting하지 않고 agent/user가 명시적으로 요청할 때 사용

## 8.16 security

### 8.16.1 environment

- provider secret 제거
- executable control env 제거
- bounded PATH
- workspace/worktree cwd
- network deny 기본
- runtime sandbox 적용
- credential lease 없음

### 8.16.2 server output

- message와 markdown sanitize
- terminal escape 제거
- URI scheme allowlist: `file` 중심
- outside-workspace URI withheld
- command argument redaction
- oversized output artifact spill 또는 process termination

### 8.16.3 authority

- LSP descriptor는 user-owned global config다.
- project는 descriptor를 새로 실행하도록 설정하지 못한다.
- project instruction이 LSP executable을 선택하지 못한다.
- server capability는 authority가 아니라 기능 hint다.
- server의 read-only claim을 그대로 신뢰하지 않는다.

## 8.17 Plan mode

초기 정책:

- 기존과 동일하게 Plan mode에서 external LSP process를 종료한다.

후속 정책 옵션:

- runtime이 read-only process sandbox를 완전히 보장하는 platform에서 query-only LSP 허용
- mutation method는 항상 disabled
- process가 filesystem write syscall을 수행하지 못하게 강제

config 예시:

```toml
[lsp]
plan_mode = "disabled" # disabled | read-only-certified
```

`read-only-certified`는 runtime capability가 없으면 자동으로 disabled로 clamp한다.

## 8.18 events

추가 event kind:

```text
lsp.server_starting
lsp.server_ready
lsp.server_degraded
lsp.server_stopped
lsp.document_opened
lsp.document_changed
lsp.document_closed
lsp.request_started
lsp.request_completed
lsp.request_failed
lsp.diagnostics_updated
lsp.workspace_edit_proposed
lsp.workspace_edit_applied
lsp.workspace_edit_rejected
```

ephemeral 후보:

- `lsp.index_progress`
- `lsp.request_progress`

## 8.19 오류 코드

| 코드 | 의미 |
|---|---|
| `LSP_UNAVAILABLE` | server가 없음/시작 실패 |
| `LSP_DISABLED` | trust/Plan/config로 비활성화 |
| `LSP_METHOD_UNSUPPORTED` | server capability 없음 |
| `LSP_TIMEOUT` | request timeout |
| `LSP_PROTOCOL_ERROR` | malformed frame/response |
| `LSP_OUTPUT_LIMIT` | output limit 초과 |
| `LSP_DOCUMENT_STALE` | document revision 불일치 |
| `LSP_DOCUMENT_TOO_LARGE` | open limit 초과 |
| `LSP_POSITION_INVALID` | position encoding/range 오류 |
| `LSP_URI_OUTSIDE_WORKSPACE` | 외부 URI 접근 |
| `LSP_WORKSPACE_EDIT_INVALID` | edit normalization 실패 |
| `LSP_COMMAND_DENIED` | command-only action 거부 |
| `LSP_DIAGNOSTICS_STALE` | 현재 revision과 맞지 않음 |

## 8.20 config

```toml
[lsp]
enabled = true
plan_mode = "disabled"
max_open_documents_per_server = 128
max_pending_requests_per_server = 64
max_diagnostics_per_file = 1000
max_workspace_symbols = 5000
restart_limit = 3
restart_window_seconds = 300
record_query_evidence = true

[lsp.mutations]
rename = true
code_actions = true
formatting = true
preview_required = true
max_files = 100
max_changed_bytes = 16777216

[lsp.commands]
allow = []
```

기존 `[lspServers.<name>]` map은 유지한다.

서버별 추가 config:

```toml
[lspServers.typescript]
command = "typescript-language-server"
args = ["--stdio"]
extensions = [".ts", ".tsx", ".js", ".jsx"]
language_id = "typescript"
enabled = true
timeout_ms = 15000
initialization_options = {}
workspace_configuration = {}
```

`initialization_options`와 `workspace_configuration`은 strict bounded JSON이며 secret path를 금지한다.

## 8.21 파일 변경 목록

### 리팩터링

```text
apps/cbc/src/lsp-host.ts
  → orchestration adapter로 축소
packages/lsp-domain/**
  → protocol/domain/normalization
apps/capy-daemon/src/lsp-supervisor.ts
  → process ownership
```

### 수정

```text
apps/cbc/src/bootstrap.ts
apps/cbc/src/agent.ts
apps/cbc/src/tools.ts
apps/cbc/src/runtime.ts
packages/context-engine/src/repository-intelligence.ts
packages/context-engine/src/evidence.ts
packages/context-engine/src/engine.ts
packages/tool-registry/src/catalog.ts
packages/protocol-ts/src/events.ts
packages/config-schema/src/schema.ts
packages/config-schema/src/key-status.ts
schemas/config/config.schema.json
schemas/events/event.schema.json
```

### 신규

```text
packages/lsp-domain/**
fixtures/lsp-servers/**
schemas/lsp/**
apps/capy-daemon/src/lsp-supervisor.ts
apps/capy-daemon/src/lsp-document-store.ts
```

## 8.22 테스트 계획

### protocol

- initialize capability negotiation
- UTF-8/UTF-16 position encoding
- dynamic registration allowlist
- malformed header
- invalid content length
- duplicate response ID
- late response
- notification flood
- output limit

### document sync

- lazy didOpen
- exact didChange
- external file mutation full-sync
- LRU didClose
- worktree isolation
- server restart re-open
- stale document rejection

### query

- definition
- references
- workspace symbol
- hover markdown sanitize
- call hierarchy
- unsupported capability

### diagnostics

- push diagnostics
- pull diagnostics
- stale diagnostics invalidation
- before/after delta
- oversized diagnostics spill
- outside-workspace related info withholding

### mutation

- rename single file
- rename multi-file
- create/rename/delete documentChanges
- overlapping text edit rejection
- code action command-only denial
- formatting current revision
- applyEdit unsolicited denial
- transaction rollback

### security

- language server attempts network
- language server attempts outside-workspace write
- malicious terminal escape
- path traversal URI
- symlink URI
- secret-shaped diagnostic content redaction

## 8.23 완료 기준

- [ ] 최소 3개 language family fixture에서 query tool이 동작한다.
- [ ] diagnostics가 revision-bound evidence로 기록된다.
- [ ] rename은 Edit Engine을 우회하지 않는다.
- [ ] code action의 direct command는 allowlist 없이는 실행되지 않는다.
- [ ] LSP server가 filesystem write authority를 갖지 않는다.
- [ ] worktree별 document state가 격리된다.
- [ ] daemon detach/attach 후 server state를 재사용한다.
- [ ] malformed server가 daemon을 crash시키지 않는다.
- [ ] output/frame/request limit이 강제된다.
- [ ] Plan mode 정책이 fail-closed다.
- [ ] diagnostics regression이 completion gate에 반영된다.

## 8.24 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| LSP-001 | lsp-domain package | protocol/domain types |
| LSP-002 | framing 분리 | bounded decoder/encoder |
| LSP-003 | capability matrix | negotiated support |
| LSP-004 | process session | pending request lifecycle |
| LSP-005 | supervisor | workspace/worktree ownership |
| LSP-006 | document store | revision/version/open state |
| LSP-007 | position converter 연결 | Edit Engine shared converter |
| LSP-008 | notification router | diagnostics/progress/applyEdit |
| LSP-009 | diagnostic index | revision-bound records |
| LSP-010 | evidence projector | Context Engine records |
| LSP-011 | symbol adapter | RepositoryIntelligence 유지 |
| LSP-012 | definition tool | typed query |
| LSP-013 | references tool | bounded locations |
| LSP-014 | hover/signature tool | sanitized result |
| LSP-015 | workspace symbol tool | bounded ranking |
| LSP-016 | call hierarchy tool | paged result |
| LSP-017 | prepareRename/rename | mutation proposal |
| LSP-018 | WorkspaceEdit adapter | EditPlan conversion |
| LSP-019 | code action query | action catalog |
| LSP-020 | code action apply | policy + edit transaction |
| LSP-021 | formatting | whole/range formatting |
| LSP-022 | command allowlist | safe executeCommand path |
| LSP-023 | Plan mode clamp | runtime capability check |
| LSP-024 | process restart/circuit | resilient lifecycle |
| LSP-025 | events/reducer | status and diagnostics UI |
| LSP-026 | config schema | global server options |
| LSP-027 | malicious fixtures | protocol/security corpus |
| LSP-028 | integration tests | real/fake LSP servers |
| LSP-029 | benchmark | rename/diagnostics precision |
| LSP-030 | docs | setup and trust behavior |

---
# 9. 개선 항목 4 — Durable Memory production 연결

## 9.1 목표

현재 `MemoryBank`의 evidence gate와 conflict semantics를 보존하면서 다음을 완성한다.

- 실제 session bootstrap에서 memory를 생성한다.
- SQLite에서 memory를 복원한다.
- evidence resolver를 restart 후에도 재구성한다.
- Context Compiler가 recall 결과를 bounded candidate로 사용한다.
- committed mutation과 branch/worktree 변화가 memory freshness를 갱신한다.
- model·child·plugin이 memory proposal을 제출할 수 있다.
- workspace memory의 오염과 과도한 자동 승격을 방지한다.
- inspect/forget/contest/verify API를 제공한다.

## 9.2 설계 보존 원칙

**[결정]** 초기 production 연결에서는 기존 scope를 유지한다.

```text
workspace
session
task
```

첫 릴리스에서 `user` 또는 `agent` scope를 추가하지 않는다.

이유:

- workspace identity isolation이 이미 정의돼 있다.
- cross-project contamination 위험을 먼저 제거해야 한다.
- user-global preference memory는 별도 privacy/consent 설계가 필요하다.
- current MemoryBank의 confidence threshold와 contest logic를 그대로 활용할 수 있다.

## 9.3 아키텍처

```text
MemoryService
  ├─ MemoryBank                 # 기존 deterministic domain logic
  ├─ MemoryStore               # SQLite persistence
  ├─ DurableEvidenceRegistry   # restart 가능한 evidence metadata
  ├─ MemoryCandidateBuilder    # event/result → proposal
  ├─ MemoryPolicy              # 자동 수락/검토/거부
  ├─ MemoryInvalidator         # path/revision/branch/worktree change
  ├─ MemoryRecallPlanner       # query/ranking/budget
  ├─ MemoryContextProjector    # ContextItem 변환
  └─ MemoryInspector           # UI/App Server 조회
```

## 9.4 소유권

### 9.4.1 daemon 도입 전 compatibility

- embedded `AgentSession`이 session-scoped MemoryService를 소유한다.
- session close 때 snapshot/store를 flush한다.
- workspace memory는 store에서 읽고 transactionally update한다.

### 9.4.2 daemon 도입 후

- `WorkspaceSupervisor`가 workspace memory bank를 소유한다.
- `SessionActor`가 session memory view를 소유한다.
- `AgentGraph` node attempt가 task memory view를 소유한다.
- 모든 write command는 WorkspaceSupervisor mailbox를 통해 serialize한다.

## 9.5 Durable Evidence Registry

### 9.5.1 필요성

현재 MemoryBank snapshot에는 evidence ID만 저장된다.

restart 후 memory를 검증하려면 ID가 가리키는 evidence metadata가 다시 필요하다.

따라서 immutable evidence의 최소 durable representation을 추가한다.

### 9.5.2 evidence record

```ts
export interface DurableEvidenceRecord {
  id: `evidence-${string}`;
  workspaceIdentityDigest: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
  taskId?: string;
  worktreeId?: string;
  kind: string;
  source: string;
  digest: string;
  exact: boolean;
  freshness: "fresh" | "stale" | "invalid" | "unknown";
  observedAt: string;
  expiresAt?: string;
  pathBindings: Array<{
    path: string;
    revisionToken?: string;
  }>;
  artifactIds: string[];
  summary: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}
```

### 9.5.3 저장 범위

DB에 저장:

- identity
- source/kind
- digest
- freshness
- timestamps
- path/revision binding
- artifact locator
- bounded summary

DB에 직접 저장하지 않음:

- 큰 raw tool output
- full file body
- provider raw response
- secret-bearing payload
- complete transcript

큰 body는 기존 artifact store에 redaction 후 보관한다.

## 9.6 Memory record persistence

기존 `MemoryRecord` semantic을 그대로 wire format으로 사용한다.

추가 metadata는 store row에 둔다.

```ts
export interface StoredMemoryEnvelope {
  schemaVersion: "1.0";
  record: MemoryRecord;
  workspaceIdentityDigest: string;
  ownerSessionId?: string;
  ownerTaskId?: string;
  worktreeId?: string;
  createdBy: "model" | "system" | "user" | "plugin" | "migration";
  createdByAgentId?: string;
  lastAccessedAt?: string;
  accessCount: number;
}
```

## 9.7 migration 9

```sql
CREATE TABLE evidence_records (
  id TEXT PRIMARY KEY,
  workspace_identity_digest TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  agent_id TEXT,
  task_id TEXT,
  worktree_id TEXT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  digest TEXT NOT NULL,
  exact INTEGER NOT NULL,
  freshness TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  summary TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT
);

CREATE INDEX idx_evidence_workspace_freshness
  ON evidence_records(workspace_identity_digest, freshness, observed_at DESC);

CREATE TABLE evidence_path_bindings (
  evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  revision_token TEXT,
  PRIMARY KEY (evidence_id, path)
);

CREATE INDEX idx_evidence_path
  ON evidence_path_bindings(path, revision_token);

CREATE TABLE evidence_artifacts (
  evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, artifact_id)
);

CREATE TABLE memory_records (
  id TEXT PRIMARY KEY,
  workspace_identity_digest TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  worktree_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_for_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  evidence_observed_at TEXT NOT NULL,
  exact_evidence_observed_at TEXT,
  expires_at TEXT,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_by_agent_id TEXT,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_memory_workspace_key
  ON memory_records(workspace_identity_digest, key, status);

CREATE INDEX idx_memory_scope_owner
  ON memory_records(scope, session_id, task_id);

CREATE TABLE memory_evidence_links (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
  PRIMARY KEY (memory_id, evidence_id)
);

CREATE TABLE memory_relations (
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  related_memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  PRIMARY KEY (memory_id, related_memory_id, relation)
);

CREATE TABLE memory_transitions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX idx_memory_transitions_record
  ON memory_transitions(memory_id, sequence);
```

### 9.7.1 저장 transaction

memory write는 다음을 하나의 DB transaction으로 처리한다.

1. evidence link 존재 검증
2. current related memory load
3. MemoryBank write/contest resolution
4. affected record upsert
5. relation upsert
6. transition append
7. canonical memory event append 또는 outbox 기록
8. commit

DB commit 후 event append가 실패하는 dual-write 문제를 피하기 위해 다음 중 하나를 사용한다.

- session-store 내부에서 event와 memory row를 같은 transaction에 기록
- 또는 `memory_event_outbox` table을 추가하고 daemon이 journal로 relay

**[결정]** 동일 SQLite store이므로 같은 transaction 기록을 권장한다.

## 9.8 Memory candidate source

### 9.8.1 user explicit

- “기억해” 명령
- `/memory retain`
- SDK `memory.remember`

### 9.8.2 model proposal

- task 완료 시 stable fact proposal
- 반복 확인된 repository convention
- verified command/build rule
- confirmed architectural invariant
- user preference가 아니라 workspace fact

### 9.8.3 system-derived

- repository config exact observation
- package manager/verification command
- workspace layout
- branch-specific deployment target
- accepted conflict resolution

### 9.8.4 plugin proposal

plugin은 memory를 직접 commit하지 못한다.

`MemoryProposal`을 제출하고 동일 write gate를 통과한다.

## 9.9 MemoryProposal

```ts
export interface MemoryProposal {
  proposalId: string;
  key: string;
  value: string;
  requestedScope: "workspace" | "session" | "task";
  confidence: number;
  evidenceIds: string[];
  validFor?: MemoryValidity;
  expiresAt?: string;
  reason: string;
  source: "user" | "model" | "system" | "plugin";
  sourceAgentId?: string;
}
```

## 9.10 write policy

### 9.10.1 task scope

자동 수락 가능 조건:

- task ID 존재
- fresh evidence 존재
- confidence threshold 충족
- expiry가 task lifetime과 모순되지 않음
- path가 task scope 밖이 아님

### 9.10.2 session scope

자동 수락 가능 조건:

- session ID 존재
- user/verified runtime evidence
- 현재 session에만 유효
- conflicting workspace memory를 덮어쓰지 않음

### 9.10.3 workspace scope

더 엄격한 조건:

- exact fresh evidence 최소 1개
- workspace identity 일치
- path-bound claim이면 revision binding 존재
- confidence threshold 충족
- secret/sensitive content 아님
- active memory와 conflict 시 contested 처리
- low confidence는 session fallback
- destructive/credential/network approval을 memory로 영구 허용하지 않음

## 9.11 기억하면 안 되는 데이터

- access token, API key, password, cookie
- `.env` raw value
- private key
- full terminal output에 포함된 secret
- raw provider chain-of-thought
- raw user transcript 전체
- approval receipt를 우회하는 “항상 허용” 문장
- 다른 workspace에서 가져온 path fact
- expired deployment endpoint
- unverified child report
- LSP diagnostic message만으로 추론한 repository invariant

## 9.12 자동 추출 정책

자동 추출은 final text에서 임의로 memory를 만들지 않는다.

권장 pipeline:

```text
candidate detector
  → structured candidate
  → evidence binding
  → sensitive-content scanner
  → scope classifier
  → confidence estimator
  → MemoryBank write gate
  → persistence
```

candidate detector는 rule 기반으로 시작한다.

예:

- `package.json` exact read에서 package manager 확인
- successful authoritative verification contract
- repository instruction exact read
- user가 명시적으로 확인한 naming convention

LLM 기반 추출은 후속 옵션이며, 결과는 proposal일 뿐이다.

## 9.13 recall query

```ts
export interface MemoryRecallRequest {
  query?: string;
  keys?: string[];
  scopes?: Array<"workspace" | "session" | "task">;
  path?: string;
  branch?: string;
  worktreeId?: string;
  statuses?: Array<"active" | "superseded" | "contested">;
  requireFreshEvidence?: boolean;
  limit?: number;
  tokenBudget?: number;
}
```

### 9.13.1 recall filter 순서

1. workspace identity
2. scope owner
3. status
4. expiry
5. branch/worktree
6. path containment
7. evidence freshness
8. key/query match
9. confidence
10. recency/verification value
11. token budget

## 9.14 Context Compiler 연결

### 9.14.1 ContextItem 변환

```ts
export function memoryToContextItem(record: MemoryRecord): ContextItem {
  return {
    kind: "memory",
    trust: "evidence-backed",
    freshness: deriveMemoryFreshness(record),
    provenance: {
      source: record.id,
      evidenceIds: record.evidenceIds,
    },
    representation: {
      resolution: "summary",
      exact: false,
      text: `${record.key}: ${record.value}`,
    },
    dependencies: [...record.evidenceIds],
    estimatedTokens: estimateTokens(record.key + record.value),
    utility: memoryUtility(record),
  };
}
```

### 9.14.2 layer

기존 L0–L8 계층을 변경하지 않는다.

memory는 다음 중 하나로 투영한다.

- task/plan에 직접 관련된 task memory: L4 보조 item
- compact state에 필요한 session memory: L5 보조 item
- repository fact인 workspace memory: L6 evidence index

rendering layer는 Context Compiler가 결정한다.

memory가 policy나 user input을 덮어쓰지 못한다.

### 9.14.3 manifest

Context manifest에 기록:

- included memory IDs
- excluded reason
- evidence dependencies
- freshness
- token cost
- scope

## 9.15 invalidation

### 9.15.1 path mutation

transaction commit 시:

- changed path와 ancestor/descendant binding 조회
- exact revision-bound evidence stale
- memory의 linked evidence 상태 재계산
- fresh exact evidence가 사라지면 memory를 active로 유지하지 않음
- 새 evidence가 동일 claim을 재검증하면 revision increment

### 9.15.2 branch change

- branch-bound memory는 선택 대상에서 제외
- workspace-global memory는 유지
- previous branch memory를 삭제하지 않고 dormant 상태로 둔다.

기존 status enum을 늘리지 않기 위해 selection filter로 처리할 수 있다.

### 9.15.3 worktree

- base workspace memory는 worktree가 읽을 수 있다.
- worktree-specific memory는 base에 자동 승격하지 않는다.
- merge 후 exact evidence가 base revision에서 재검증되면 승격 가능하다.
- abandoned worktree memory는 retention 후 GC한다.

### 9.15.4 trust revoke

- workspace memory를 삭제하지 않는다.
- untrusted session에서는 body recall을 금지하고 metadata-only inspection만 허용한다.
- process/plugin이 memory를 조회하지 못한다.

## 9.16 contest와 resolution

### 9.16.1 contested 상태

서로 다른 value가 overlapping validity domain에서 유효하면 contested다.

Context Compiler 기본 동작:

- contested memory를 instruction처럼 사용하지 않는다.
- 두 claim과 evidence locator를 risk/context inspector에 보여준다.
- 자동 선택하지 않는다.

### 9.16.2 resolution

```ts
export interface ResolveMemoryContestCommand {
  winnerId: string;
  evidenceIds: string[];
  reason: string;
  expectedRevisions: Record<string, number>;
}
```

- winner는 fresh evidence를 가져야 한다.
- loser는 superseded가 된다.
- transition과 user/agent provenance를 기록한다.

## 9.17 forget

forget은 두 종류다.

### logical forget

- record status를 superseded 또는 hidden tombstone으로 전환
- audit transition 유지
- normal recall에서 제외

### physical purge

- privacy/retention command
- evidence/artifact reference count 확인
- 다른 audit record가 필요로 하면 body만 redacted
- policy에 따라 irreversible confirmation 필요

## 9.18 도구와 command

### model-facing

```text
memory.search
memory.get
memory.remember
memory.forget
memory.resolve
memory.verify
```

초기 model-facing subset 권장:

```text
memory.search
memory.remember
```

forget/resolve는 user 또는 root-only command로 제한할 수 있다.

### slash/TUI

```text
/memory inspect
/memory search <query>
/memory retain <key> <value>
/memory forget <id>
/memory contest <id>
/memory verify <id>
```

### App Server

```text
memory.list
memory.get
memory.search
memory.propose
memory.remember
memory.forget
memory.resolveContest
memory.verify
memory.export
```

## 9.19 events

```text
memory.proposed
memory.rejected
memory.created
memory.revalidated
memory.superseded
memory.contested
memory.contest_resolved
memory.invalidated
memory.recalled
memory.forgotten
memory.purged
```

`memory.recalled`는 high-volume이므로 sampling 또는 aggregate event로 기록한다.

Context pack에 실제 포함된 memory는 반드시 journaled manifest에 나타난다.

## 9.20 오류 코드

| 코드 | 의미 |
|---|---|
| `MEMORY_EVIDENCE_REQUIRED` | evidence 없음 |
| `MEMORY_EVIDENCE_MISSING` | resolver가 ID를 찾지 못함 |
| `MEMORY_EVIDENCE_STALE` | fresh 조건 불충족 |
| `MEMORY_EVIDENCE_WORKSPACE_MISMATCH` | workspace identity 불일치 |
| `MEMORY_SCOPE_INVALID` | scope owner 누락 |
| `MEMORY_CONFIDENCE_TOO_LOW` | threshold 미달 |
| `MEMORY_SENSITIVE_CONTENT` | secret/sensitive 내용 |
| `MEMORY_CONTESTED` | competing claim 존재 |
| `MEMORY_REVISION_CONFLICT` | optimistic revision mismatch |
| `MEMORY_NOT_FOUND` | record 없음 |
| `MEMORY_PURGE_BLOCKED` | audit/reference로 물리 삭제 불가 |
| `MEMORY_STORE_UNAVAILABLE` | persistence failure |

## 9.21 config

```toml
[memory]
enabled = true
workspace_enabled = true
session_enabled = true
task_enabled = true
auto_candidates = true
require_exact_evidence_for_workspace = true
allow_session_fallback = true
max_records_per_workspace = 10000
max_value_bytes = 16384
recall_limit = 32
recall_token_budget = 4096
retention_days = 180

[memory.confidence]
workspace = 0.8
session = 0.5
task = 0.5

[memory.privacy]
store_raw_transcript = false
store_sensitive_paths = false
allow_plugin_proposals = true
```

`store_raw_transcript`는 schema const false로 둘 수 있다.

## 9.22 파일 변경 목록

### 수정

```text
apps/cbc/src/bootstrap.ts
apps/cbc/src/agent.ts
apps/cbc/src/slash.ts
apps/cbc/src/tui.ts
packages/context-engine/src/memory.ts
packages/context-engine/src/evidence.ts
packages/context-engine/src/engine.ts
packages/context-engine/src/ir.ts
packages/context-engine/src/compiler.ts
packages/context-engine/src/index.ts
packages/protocol-ts/src/events.ts
packages/tool-registry/src/catalog.ts
packages/config-schema/src/schema.ts
crates/cbc-session-store/src/migrations.rs
crates/cbc-session-store/src/lib.rs
crates/cbc-runtime/src/handlers/session.rs
schemas/events/event.schema.json
schemas/config/config.schema.json
```

### 신규

```text
packages/memory-service/**
crates/cbc-session-store/src/memory.rs
schemas/memory/**
fixtures/memory/**
```

## 9.23 테스트 계획

### domain regression

- current MemoryBank tests 전부 유지
- snapshot deterministic
- contested resolution
- confidence fallback
- path validity
- branch validity
- expiry

### persistence

- write/reload equality
- transition sequence
- evidence FK
- outbox/event atomicity
- duplicate proposal idempotency
- migration from schema 8
- corrupt row fail-closed

### production integration

- AgentSession startup recall
- session close/reopen
- daemon restart
- transaction commit invalidation
- branch switch
- worktree isolation
- child proposal → root commit
- ContextPack manifest inclusion

### security/privacy

- secret candidate rejected
- untrusted workspace body withheld
- cross-workspace query returns zero
- forged evidence ID rejected
- stale exact evidence rejected
- plugin cannot bypass scope policy
- raw transcript not persisted

### performance

- 10k record exact key query
- 10k record path invalidation
- 100k transition replay bounded
- memory projection token budget

## 9.24 완료 기준

- [ ] production bootstrap에서 MemoryService가 생성된다.
- [ ] daemon/embedded restart 후 record와 transition이 복원된다.
- [ ] evidence resolver가 durable record를 해석한다.
- [ ] Context Compiler manifest에 memory selection이 나타난다.
- [ ] committed file mutation이 관련 memory를 stale/contested로 처리한다.
- [ ] cross-workspace contamination test가 0건이다.
- [ ] secret memory 저장 test가 모두 거부된다.
- [ ] contested memory가 자동 instruction으로 사용되지 않는다.
- [ ] user가 inspect/forget/resolve할 수 있다.
- [ ] feature flag off에서 현재 context behavior가 동일하다.

## 9.25 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| MEM-001 | MemoryService interface | production facade |
| MEM-002 | DurableEvidenceRecord | restart-safe metadata |
| MEM-003 | evidence persistence | SQLite CRUD |
| MEM-004 | memory persistence | record/relation/transition CRUD |
| MEM-005 | migration 9 | durable memory schema |
| MEM-006 | atomic write path | memory + event transaction |
| MEM-007 | evidence resolver | DB/artifact-backed lookup |
| MEM-008 | candidate builder | verified event → proposal |
| MEM-009 | sensitive scanner | reject/redact policy |
| MEM-010 | scope classifier | workspace/session/task |
| MEM-011 | write policy | auto/review/reject |
| MEM-012 | recall planner | filter/rank/budget |
| MEM-013 | ContextItem projector | compiler integration |
| MEM-014 | context manifest | include/exclude reasons |
| MEM-015 | path invalidator | transaction events |
| MEM-016 | branch invalidator | Git identity changes |
| MEM-017 | worktree scope | base/worktree isolation |
| MEM-018 | task proposals | AgentGraph integration |
| MEM-019 | model tools | search/remember |
| MEM-020 | user commands | inspect/forget/resolve |
| MEM-021 | App Server API | memory methods |
| MEM-022 | TUI inspector | evidence/status/validity |
| MEM-023 | GC/retention | logical/physical cleanup |
| MEM-024 | privacy export | bounded safe export |
| MEM-025 | fault tests | crash/dual-write/restart |
| MEM-026 | security fixtures | cross-workspace/secret/forged evidence |
| MEM-027 | benchmark | recall precision/latency |
| MEM-028 | docs | policy and user controls |

---

# 10. 개선 항목 5 — Session Daemon

## 10.1 목표

- TUI process와 session execution lifetime을 분리한다.
- client가 종료돼도 session/agent/background task가 정책 범위에서 계속 실행된다.
- 다른 client가 같은 session에 attach할 수 있다.
- daemon crash 후 journal과 store에서 복구한다.
- provider stream, approval, LSP, MCP, memory, graph의 소유자를 명확히 한다.
- App Server의 안정적인 execution backend가 된다.

## 10.2 비목표

- 인터넷에 공개되는 multi-tenant server
- cloud account management
- remote daemon discovery
- unauthenticated TCP listener
- 여러 machine 사이 distributed scheduler
- daemon이 Rust runtime의 권한을 대체
- client가 daemon 내부 object reference를 직접 조작

## 10.3 현행 문제

현재 interactive bootstrap은 대체로 다음을 직접 수행한다.

```text
CLI process
  → Host 생성
  → Runtime sidecar 시작
  → trust/config/credential resolve
  → MCP/LSP host 생성
  → AgentSession 생성
  → session open/resume
  → input loop
  → close/flush/snapshot
  → runtime 종료
```

이 구조의 제약:

- TUI crash가 execution owner crash다.
- detach 개념이 없다.
- 여러 client attach가 어렵다.
- LSP/MCP process가 UI lifetime에 묶인다.
- background agent의 실제 지속성이 제한된다.
- SDK가 AgentSession을 직접 embed해야 한다.
- update/restart와 session recovery가 분리되지 않는다.

## 10.4 목표 topology

```text
capy CLI/TUI
  │
  │ UDS / Named Pipe
  ▼
Daemon Process
  ├─ InstanceManager
  ├─ AppServer
  ├─ CommandDeduplicator
  ├─ EventHub
  ├─ WorkspaceSupervisorMap
  │    └─ WorkspaceSupervisor
  │         ├─ RuntimeSidecarSupervisor
  │         ├─ LspSupervisor
  │         ├─ McpSupervisor
  │         ├─ PluginSupervisor
  │         ├─ DurableMemoryService
  │         ├─ WorktreeManager
  │         └─ SessionActorMap
  │              └─ SessionActor
  │                   ├─ AgentSession
  │                   ├─ PersistentAgentGraph
  │                   ├─ ProviderTurnSession
  │                   ├─ ApprovalQueue
  │                   └─ ClientAttachmentSet
  └─ RecoveryCoordinator
```

## 10.5 daemon instance

### 10.5.1 한 사용자당 한 daemon

기본값은 한 OS user당 한 daemon이다.

instance path 예시:

```text
Unix:
  $XDG_RUNTIME_DIR/capybara-code/daemon.sock
  $XDG_RUNTIME_DIR/capybara-code/daemon.lock

macOS fallback:
  ~/Library/Caches/capybara-code/runtime/daemon.sock

Windows:
  \\.\pipe\capybara-code-<user-sid-hash>
  %LOCALAPPDATA%\Capybara Code\runtime\daemon.lock
```

### 10.5.2 instance lock

lock record:

```ts
export interface DaemonLockRecord {
  schemaVersion: "1.0";
  daemonId: string;
  pid: number;
  startedAt: string;
  executablePathDigest: string;
  protocolVersion: string;
  nonce: string;
}
```

검증:

- PID 존재만 신뢰하지 않는다.
- socket handshake의 daemon ID와 lock record를 대조한다.
- stale lock은 filesystem ownership과 process identity 확인 후 정리한다.
- symlink lock path를 거부한다.

## 10.6 local transport 보안

### Unix

- Unix domain socket
- directory mode 0700
- socket mode 0600
- peer credential 확인 가능 시 UID 비교
- socket path symlink 거부

### Windows

- named pipe ACL을 current user SID로 제한
- remote clients 비활성화
- impersonation 사용 여부 명시
- pipe name에 raw username 사용 금지

### 공통

- localhost TCP는 기본 비활성화
- stdio transport는 child embedding에만 사용
- handshake challenge nonce
- client instance ID
- protocol version negotiation
- optional local auth token
- secret는 command log에 기록하지 않음

## 10.7 daemon handshake

```ts
export interface DaemonHello {
  protocolVersion: string;
  clientName: string;
  clientVersion: string;
  clientId: string;
  capabilities: {
    eventReplay: boolean;
    binaryArtifacts: boolean;
    approvals: boolean;
    interactiveInput: boolean;
  };
  challengeResponse?: string;
}

export interface DaemonWelcome {
  protocolVersion: string;
  daemonVersion: string;
  daemonId: string;
  capabilities: Record<string, boolean | string | number>;
  serverTime: string;
  connectionId: string;
}
```

## 10.8 WorkspaceSupervisor

### 10.8.1 key

```text
workspaceIdentityDigest
```

### 10.8.2 책임

- canonical workspace path와 filesystem identity 재검증
- trust state 관찰
- Rust runtime sidecar lifecycle
- LSP/MCP/plugin process lifecycle
- workspace memory
- worktree registry
- workspace change token
- active session map
- shared resource budgets

### 10.8.3 lifecycle

```text
created
  → initializing_runtime
  → ready
  → degraded
  → quiescing
  → stopped
```

### 10.8.4 idle eviction

- attached client 없음
- active/running session 없음
- graph task 없음
- background job 없음
- pending approval 없음
- configured idle timeout 경과

조건을 모두 만족할 때 shared service를 정리한다.

session persistence 자체는 유지한다.

## 10.9 RuntimeSidecarSupervisor

- workspace별 sidecar 기본 1개
- worktree는 별도 runtime workspace context 또는 scoped runtime session을 사용
- heartbeat 감시
- crash 횟수와 restart circuit
- protocol version mismatch 처리
- pending request registry
- cancel propagation
- capability issuer token lifecycle
- sidecar stdout/stderr bounded capture

sidecar restart 후:

1. workspace identity 재확인
2. trust state 재로딩
3. sandbox capability 비교
4. session-store startup reconciliation
5. open transaction/job 조회
6. graph attempt 상태 조정
7. LSP/MCP/plugin 재기동

## 10.10 SessionActor

### 10.10.1 actor mailbox

모든 session mutation은 하나의 mailbox에서 순차 처리한다.

```ts
export type SessionCommand =
  | SubmitTurn
  | CancelTurn
  | AttachClient
  | DetachClient
  | ResolveApproval
  | SpawnGraphNode
  | PauseSession
  | ResumeSession
  | SnapshotSession
  | CloseSession;
```

읽기 query는 immutable projection에서 병렬 처리할 수 있다.

### 10.10.2 actor state

```ts
export interface SessionActorState {
  sessionId: string;
  workspaceIdentityDigest: string;
  lifecycle: "loading" | "idle" | "running" | "waiting_approval" | "paused" | "recovering" | "closed" | "failed";
  revision: number;
  activeTurnId?: string;
  graphId?: string;
  attachedClients: Set<string>;
  lastJournalSequence: number;
  lastSnapshotSequence: number;
  providerContinuation?: ProviderContinuationState;
  pendingApprovals: string[];
}
```

## 10.11 attach와 detach

### attach

- session access 검증
- current projection snapshot 반환
- event cursor 결정
- client capabilities 등록
- interactive owner 여부 결정

### detach

- connection만 제거
- turn을 자동 cancel하지 않는다.
- 마지막 interactive client가 나가도 policy에 따라 계속 실행한다.
- pending user input이면 `waiting_client` 또는 approval timeout 정책을 적용한다.

### close

- explicit session close command
- active turn 처리 정책 필요
- flush/snapshot
- graph/task/process 정리 또는 background continuation 선택
- session status 업데이트

## 10.12 interactive owner

여러 client가 attach할 수 있지만 동시에 하나만 composer/approval owner가 된다.

```ts
export interface InteractiveLease {
  sessionId: string;
  clientId: string;
  leaseRevision: number;
  grantedAt: string;
  expiresAt: string;
}
```

규칙:

- read-only observer는 여러 개 허용
- control lease는 하나
- owner가 disconnect하면 grace period 후 lease 해제
- approval은 owner가 없으면 waiting 상태
- headless policy가 있으면 owner 없이 처리 가능
- steal control은 explicit command와 event를 남긴다.

## 10.13 daemon persistence

### migration 8

```sql
CREATE TABLE daemon_instances (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  executable_digest TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  stopped_at TEXT,
  state TEXT NOT NULL
);

CREATE TABLE session_owners (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  daemon_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE client_attachments (
  connection_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  detached_at TEXT,
  last_event_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_client_attachments_session
  ON client_attachments(session_id, detached_at);

CREATE TABLE session_commands (
  idempotency_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

## 10.14 ownership lease

- daemon은 session 실행 전 owner lease를 획득한다.
- lease에는 monotonic owner epoch가 있다.
- 다른 daemon instance는 만료 전 같은 session을 실행하지 못한다.
- stale daemon recovery는 OS process와 heartbeat를 확인한다.
- owner epoch가 바뀐 뒤 old daemon command 결과는 commit할 수 없다.

single-user local daemon이라도 update/restart race 때문에 필요하다.

## 10.15 command processing

```text
client request
  → App Server validation
  → idempotency lookup
  → session owner validation
  → SessionActor mailbox enqueue
  → command accepted receipt
  → durable transition/event
  → operation
  → completion receipt
  → event publish
```

client timeout 후 같은 idempotency key로 재요청하면:

- queued/running이면 현재 상태 반환
- completed이면 저장된 receipt 반환
- payload hash가 다르면 `IDEMPOTENCY_KEY_REUSED` 오류

## 10.16 EventHub

### 기능

- session event subscribe
- event replay from sequence
- live fan-out
- per-client bounded queue
- slow client detection
- visibility filter
- artifact handle substitution
- reconnect cursor

### backpressure

- ephemeral event는 coalesce/drop 가능
- journaled event는 drop 금지
- slow client는 disk replay mode로 전환
- queue limit 초과 시 connection을 끊되 cursor를 반환
- client는 last acknowledged sequence부터 reconnect

## 10.17 approval handling

### daemon-owned queue

```ts
export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  turnId: string;
  actionHash: string;
  request: ApprovalRequest;
  state: "pending" | "resolved" | "expired" | "cancelled";
  requestedAt: string;
  expiresAt?: string;
  resolvedByClientId?: string;
}
```

규칙:

- approval event는 journaled
- client disconnect가 approval을 자동 deny하지 않음
- headless contract가 deny라면 즉시 resolve
- 중복 resolve는 idempotent
- 다른 action hash로 forged resolve 거부
- owner client가 없으면 attached approval-capable client에게 표시

## 10.18 provider session ownership

- provider turn session은 SessionActor가 소유한다.
- client는 provider object를 직접 보지 않는다.
- provider continuation ID는 encrypted secret가 아니라 metadata 범위에서 저장한다.
- retry/fallback에서 tool side effect replay를 분리한다.
- daemon crash 후 in-flight provider request는 unknown/interrupted로 처리한다.
- 이미 commit된 tool receipt는 재실행하지 않는다.

## 10.19 crash recovery

### 10.19.1 startup 순서

```text
1. instance lock 획득
2. DB migration/checksum
3. stale daemon/session owner 탐색
4. Rust session-store reconcile
5. command receipt reconcile
6. graph attempt reconcile
7. worktree/merge reconcile
8. artifact/evidence integrity check
9. session actor lazy restore 준비
10. socket listen
```

### 10.19.2 session recovery state

- last snapshot load
- journal tail replay
- reducer deterministic check
- active turn event 확인
- open transaction 확인
- running job 확인
- graph attempt 확인
- pending approval 확인
- provider request 상태 확인

### 10.19.3 결과 분류

```text
safe_idle
interrupted_recoverable
waiting_approval
blocked_reconciliation
failed_integrity
```

### 10.19.4 불확실한 side effect

예:

- commit은 성공했으나 response가 유실됨

해결:

- transaction record와 file post hash 확인
- matching operation receipt 발견 시 completed로 reconcile
- 불일치하면 conflict/blocked
- 절대 동일 mutation을 무조건 재시도하지 않음

## 10.20 daemon shutdown

### graceful

1. 새 command admission 중단
2. active client에 shutdown notice
3. session actor quiesce
4. provider request cancel 또는 checkpoint policy
5. graph dispatch 중단
6. event flush
7. snapshot
8. child process stop
9. owner lease release
10. socket/lock 제거

### forced

- SIGTERM grace 이후 process 종료
- next startup reconciliation에 의존

## 10.21 update/restart

- 새 daemon binary는 protocol compatibility를 먼저 확인한다.
- old daemon에 `server.prepareRestart` 요청
- session checkpoint와 event flush
- socket handoff 또는 controlled reconnect
- new daemon owner epoch 획득
- clients reconnect
- incompatible DB migration이면 rollback 가능한 binary backup 필요

## 10.22 CLI 변경

```text
capy daemon start
capy daemon stop
capy daemon restart
capy daemon status
capy daemon logs

capy session list
capy session attach <id>
capy session detach
capy session pause <id>
capy session resume <id>
capy session recover <id>
```

기존 `capy` 동작:

1. daemon feature enabled 확인
2. daemon socket 연결
3. 없으면 autostart
4. workspace open
5. session create/resume
6. TUI client 실행

## 10.23 embedded compatibility mode

```text
capy --no-daemon
CBC_DAEMON=0 capy
```

용도:

- 디버깅
- 초기 rollout
- daemon startup 실패 진단
- minimal CI environment

제약:

- multi-client attach 없음
- persistent graph background 실행 제한
- plugin/worktree 일부 기능 제한 가능

## 10.24 events

```text
daemon.started
daemon.ready
daemon.degraded
daemon.shutting_down
daemon.stopped
workspace.supervisor_started
workspace.supervisor_stopped
session.owner_acquired
session.owner_lost
session.client_attached
session.client_detached
session.control_acquired
session.control_released
session.recovery_started
session.recovery_completed
session.recovery_blocked
command.accepted
command.completed
command.failed
```

일부 daemon global event는 session journal이 아니라 daemon log/store에 기록한다.

session 영향을 주는 event는 해당 session journal에도 기록한다.

## 10.25 오류 코드

| 코드 | 의미 |
|---|---|
| `DAEMON_NOT_RUNNING` | 연결할 daemon 없음 |
| `DAEMON_ALREADY_RUNNING` | instance lock 충돌 |
| `DAEMON_STALE_LOCK` | lock 검증 필요 |
| `DAEMON_PROTOCOL_MISMATCH` | client/server version 비호환 |
| `DAEMON_UNAUTHORIZED_CLIENT` | local peer 인증 실패 |
| `SESSION_OWNER_CONFLICT` | 다른 owner epoch가 활성 |
| `SESSION_RECOVERY_BLOCKED` | integrity/reconciliation 필요 |
| `SESSION_CONTROL_HELD` | interactive lease가 다른 client에 있음 |
| `SESSION_NOT_ATTACHED` | attachment 필요 |
| `IDEMPOTENCY_KEY_REUSED` | 다른 payload에 동일 key |
| `CLIENT_BACKPRESSURE_LIMIT` | event queue 초과 |
| `WORKSPACE_SUPERVISOR_UNAVAILABLE` | runtime/shared service 시작 실패 |

## 10.26 config

```toml
[daemon]
enabled = true
autostart = true
idle_shutdown_minutes = 30
workspace_idle_minutes = 10
heartbeat_seconds = 5
owner_lease_seconds = 20
graceful_shutdown_seconds = 10
log_level = "info"

[daemon.transport]
mode = "local"
allow_tcp = false
socket_path = "auto"
max_connections = 32
max_frame_bytes = 8388608

[daemon.clients]
control_lease_seconds = 30
detach_grace_seconds = 5
max_event_queue_items = 1000
max_event_queue_bytes = 8388608
```

project config는 daemon executable/transport를 설정하지 못한다.

## 10.27 파일 변경 목록

### 신규

```text
apps/capy-daemon/**
packages/app-protocol/**     # 최소 내부 버전부터 시작
crates/cbc-session-store/src/daemon.rs
fixtures/daemon-recovery/**
```

### 수정

```text
apps/cbc/src/main.ts
apps/cbc/src/args.ts
apps/cbc/src/router.ts
apps/cbc/src/bootstrap.ts
apps/cbc/src/commands/interactive.ts
apps/cbc/src/commands/run.ts
apps/cbc/src/runtime.ts
packages/session-domain/src/journal.ts
packages/session-domain/src/persistence.ts
packages/protocol-ts/src/events.ts
packages/config-schema/src/schema.ts
crates/cbc-session-store/src/migrations.rs
crates/cbc-session-store/src/lib.rs
scripts/build-standalone.ts
scripts/package-npm.ts
.github/workflows/release.yml
```

## 10.28 packaging

standalone layout 제안:

```text
bin/capy
libexec/capy-daemon
libexec/cbc-runtime
share/capybara/...
```

launcher 규칙:

- daemon binary는 launcher 상대 절대 경로로 실행
- PATH에서 임의 daemon 탐색 금지
- version mismatch 시 명확한 diagnostic
- old daemon이 다른 binary 경로로 실행 중이면 controlled restart 제안

## 10.29 테스트 계획

### instance

- stale lock
- two concurrent starts
- wrong user socket
- executable digest mismatch
- Windows pipe ACL
- Unix permission

### transport

- handshake version negotiation
- malformed frame
- oversized frame
- unauthorized client
- abrupt disconnect
- slow client backpressure

### session

- attach/detach
- two observers
- control lease
- turn continues after detach
- explicit cancel
- pending approval without client
- reconnect event replay

### crash recovery

- kill daemon during provider stream
- kill daemon after tool commit before final
- kill daemon during journal append
- kill daemon during snapshot
- kill daemon with running background process
- kill daemon with graph children
- stale owner epoch

### update

- graceful restart
- incompatible protocol
- schema migration failure
- client reconnect

### performance

- 100 attached idle sessions
- 32 clients
- long event replay
- large graph projection
- daemon memory bound

## 10.30 완료 기준

- [ ] TUI 종료 후 active session이 정책대로 유지된다.
- [ ] 다른 TUI가 session에 attach한다.
- [ ] event cursor로 누락 없이 replay한다.
- [ ] daemon kill 후 session reducer state가 복원된다.
- [ ] committed tool side effect가 중복 실행되지 않는다.
- [ ] local transport가 current user로 제한된다.
- [ ] pending approval이 client disconnect로 유실되지 않는다.
- [ ] embedded mode가 fallback으로 동작한다.
- [ ] package에 daemon binary가 포함된다.
- [ ] runtime final authority가 유지된다.

## 10.31 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| DMN-001 | daemon app skeleton | executable/main loop |
| DMN-002 | instance lock | single-instance guard |
| DMN-003 | Unix socket transport | local secure transport |
| DMN-004 | Windows named pipe | ACL transport |
| DMN-005 | handshake | version/capability/auth |
| DMN-006 | WorkspaceSupervisor | shared workspace owner |
| DMN-007 | RuntimeSidecarSupervisor | heartbeat/restart/reconcile |
| DMN-008 | SessionActor | mailbox/state/lifecycle |
| DMN-009 | session owner lease | epoch/heartbeat |
| DMN-010 | client attachment | observer/control roles |
| DMN-011 | EventHub | live fan-out/replay |
| DMN-012 | backpressure | bounded client queues |
| DMN-013 | approval manager | durable pending approvals |
| DMN-014 | command dedupe | idempotency receipt |
| DMN-015 | migration 8 | daemon ownership tables |
| DMN-016 | recovery coordinator | startup reconciliation |
| DMN-017 | graceful shutdown | flush/snapshot/quiesce |
| DMN-018 | update restart | owner epoch handoff |
| DMN-019 | CLI daemon commands | start/stop/status/logs |
| DMN-020 | CLI attach commands | session control |
| DMN-021 | TUI client adapter | no direct AgentSession ownership |
| DMN-022 | embedded fallback | `--no-daemon` |
| DMN-023 | packaging | daemon sidecar distribution |
| DMN-024 | cross-platform tests | socket/pipe/lock |
| DMN-025 | crash matrix | kill-point recovery |
| DMN-026 | perf harness | attach/replay/resource bounds |
| DMN-027 | docs | daemon operations/troubleshooting |

---
# 11. 개선 항목 6 — Persistent AgentGraph

## 11.1 목표

현재 `SubagentScheduler`가 가진 안전한 delegation semantics를 보존하면서 다음을 추가한다.

- task와 dependency를 durable DAG로 저장
- daemon restart 후 graph 복원
- node별 attempt/retry history
- pause/resume/revive
- durable mailbox와 steering
- configurable bounded depth
- global budget와 per-node budget
- worktree assignment
- exact evidence handoff
- multiple client inspection
- idempotent dispatch와 completion

## 11.2 비목표

- 무제한 재귀 agent
- 동일 mutable tree의 multi-writer
- child transcript를 parent prompt에 자동 병합
- child claim을 runtime fact로 승격
- graph node가 직접 permission policy를 확장
- 분산 machine cluster scheduler
- provider-native hosted agent를 graph authority로 사용

## 11.3 현행에서 보존할 계약

- task는 goal/constraints/expected output을 가져야 한다.
- writer task는 explicit path scope를 가져야 한다.
- broad writer lease를 금지한다.
- dependency result는 structured summary/evidence로 전달한다.
- raw child transcript는 parent에 합치지 않는다.
- await interruption은 child cancel이 아니다.
- explicit cancel은 provider/process/transaction에 전파한다.
- child result claim은 runtime evidence와 대조한다.
- role별 model/tool/time/context ceiling을 유지한다.

## 11.4 핵심 변경

현재 구조:

```text
Parent AgentSession
  └─ SubagentScheduler
       ├─ Map<agentId, AgentInstance>
       ├─ Map<agentId, AbortController>
       ├─ Map<agentId, Promise<Result>>
       └─ single writer lease
```

목표 구조:

```text
PersistentAgentGraphService
  ├─ AgentGraphDomain reducer
  ├─ GraphStore
  ├─ GraphCommandProcessor
  ├─ GraphScheduler
  ├─ WorkerLeaseManager
  ├─ BudgetLedger
  ├─ MailboxService
  ├─ HandoffService
  ├─ AttemptRecovery
  └─ CompatibilitySubagentBridge
```

## 11.5 Graph aggregate

```ts
export interface AgentGraph {
  schemaVersion: "1.0";
  id: `grf_${string}`;
  sessionId: string;
  workspaceIdentityDigest: string;
  rootNodeId: `agt_${string}`;
  state: "active" | "paused" | "completed" | "failed" | "cancelled" | "blocked";
  revision: number;
  maxDepth: number;
  budget: GraphBudget;
  createdAt: string;
  updatedAt: string;
}
```

## 11.6 Node model

```ts
export type AgentNodeState =
  | "created"
  | "queued"
  | "waiting_dependency"
  | "waiting_budget"
  | "waiting_approval"
  | "waiting_message"
  | "dispatching"
  | "running"
  | "paused"
  | "reconciling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "blocked"
  | "inactive";

export interface AgentNode {
  id: `agt_${string}`;
  graphId: `grf_${string}`;
  parentNodeId?: `agt_${string}`;
  depth: number;
  role: SubagentRole | string;
  name?: string;
  title: string;
  task: AgentTask;
  state: AgentNodeState;
  modelProfile: string;
  permissionScope: AgentPermissionScope;
  worktreeId?: string;
  activeAttemptId?: string;
  attemptCount: number;
  maxAttempts: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  result?: VerifiedAgentNodeResult;
  blockedReason?: StructuredError;
  revision: number;
}
```

## 11.7 Edge model

```ts
export type AgentEdgeKind =
  | "depends_on"
  | "parent_child"
  | "handoff"
  | "review_of"
  | "verifies"
  | "merges";

export interface AgentEdge {
  id: string;
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: AgentEdgeKind;
  required: boolean;
  condition?: EdgeCondition;
  createdAt: string;
}
```

### 11.7.1 DAG invariant

- `depends_on` edge는 cycle을 만들 수 없다.
- parent_child edge도 maxDepth를 초과할 수 없다.
- edge 추가 시 incremental cycle detection을 수행한다.
- graph restore 시 전체 DAG integrity를 다시 검사한다.
- cycle 발견 시 graph를 blocked로 열고 자동 dispatch하지 않는다.

## 11.8 Attempt model

node와 실행 attempt를 분리한다.

```ts
export interface AgentAttempt {
  id: `att_${string}`;
  nodeId: `agt_${string}`;
  ordinal: number;
  state:
    | "created"
    | "leased"
    | "running"
    | "waiting_tool"
    | "waiting_provider"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "unknown";
  daemonId?: string;
  ownerEpoch?: number;
  workerLeaseId?: string;
  modelProfile: string;
  providerRoute?: string;
  worktreeId?: string;
  turnId?: string;
  contextPackId?: string;
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  resultClaim?: ChildAgentResult;
  verifiedResult?: VerifiedAgentNodeResult;
  error?: StructuredError;
  usage?: AgentAttemptUsage;
}
```

장점:

- retry가 node history를 덮어쓰지 않는다.
- crash로 unknown이 된 attempt를 별도 reconcile한다.
- model/provider 변경 retry를 비교할 수 있다.
- worktree 재사용 여부를 attempt별로 관리한다.

## 11.9 Node state machine

### 11.9.1 정상 흐름

```text
created
  → queued
  → waiting_dependency
  → queued
  → dispatching
  → running
  → completed | partial | failed | blocked | cancelled
```

### 11.9.2 budget

```text
queued
  → waiting_budget
  → queued
```

### 11.9.3 approval

```text
running
  → waiting_approval
  → running | blocked | cancelled
```

### 11.9.4 pause/resume

```text
queued/running/waiting_*
  → paused
  → queued | waiting_dependency | waiting_approval
```

running node pause는 safe point에서 수행한다.

즉시 process freeze를 의미하지 않는다.

### 11.9.5 crash

```text
running
  → reconciling
  → queued | completed | partial | failed | blocked
```

## 11.10 Graph command

```ts
export type AgentGraphCommand =
  | CreateGraphCommand
  | AddNodeCommand
  | AddEdgeCommand
  | DispatchNodeCommand
  | CancelNodeCommand
  | PauseNodeCommand
  | ResumeNodeCommand
  | ReviveNodeCommand
  | SendMessageCommand
  | ResolveApprovalCommand
  | CompleteAttemptCommand
  | ReconcileAttemptCommand
  | CloseGraphCommand;
```

모든 command:

- expected graph revision
- idempotency key
- actor/client/agent provenance
- correlation ID
- workspace identity
- optional session/turn ancestry

## 11.11 Graph reducer

`packages/agent-graph-domain`의 reducer는 pure function이다.

```ts
reduceGraph(state: AgentGraphState, event: AgentGraphEvent): AgentGraphState
```

요구사항:

- 동일 event sequence replay 결과 동일
- mutable runtime handle 포함 금지
- AbortController/Promise 포함 금지
- normalized map/list projection
- invalid transition은 명시적 error
- schema migration 지원
- 10k node에서 bounded projection

## 11.12 GraphStore

### 11.12.1 event sourcing

graph 전용 event table을 둘지 기존 session events를 사용할지 결정해야 한다.

**[결정]** canonical audit event는 기존 `events` table을 사용한다.

별도 graph table은 query index와 current materialized state다.

장점:

- session timeline과 graph history가 한 sequence에 정렬된다.
- replay와 export가 분리되지 않는다.
- existing ancestry fields를 재사용한다.

### 11.12.2 write transaction

```text
graph command validate
  → current graph revision 확인
  → graph domain event 생성
  → graph materialized row update
  → session event append
  → command receipt update
  → commit
```

## 11.13 migration 10

```sql
CREATE TABLE agent_graphs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_identity_digest TEXT NOT NULL,
  root_node_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  budget_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_nodes (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
  parent_node_id TEXT REFERENCES agent_nodes(id) ON DELETE SET NULL,
  depth INTEGER NOT NULL,
  role TEXT NOT NULL,
  name TEXT,
  title TEXT NOT NULL,
  task_json TEXT NOT NULL,
  state TEXT NOT NULL,
  model_profile TEXT NOT NULL,
  permission_scope_json TEXT NOT NULL,
  worktree_id TEXT,
  active_attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  blocked_reason_json TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE INDEX idx_agent_nodes_graph_state
  ON agent_nodes(graph_id, state, priority DESC, created_at);

CREATE TABLE agent_edges (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  required INTEGER NOT NULL,
  condition_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(graph_id, from_node_id, to_node_id, kind)
);

CREATE INDEX idx_agent_edges_to
  ON agent_edges(graph_id, to_node_id, kind);

CREATE TABLE agent_attempts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  daemon_id TEXT,
  owner_epoch INTEGER,
  worker_lease_id TEXT,
  model_profile TEXT NOT NULL,
  provider_route TEXT,
  worktree_id TEXT,
  turn_id TEXT,
  context_pack_id TEXT,
  result_claim_json TEXT,
  verified_result_json TEXT,
  error_json TEXT,
  usage_json TEXT,
  started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  UNIQUE(node_id, ordinal)
);

CREATE INDEX idx_agent_attempts_state
  ON agent_attempts(state, heartbeat_at);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
  from_node_id TEXT,
  to_node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT
);

CREATE INDEX idx_agent_messages_pending
  ON agent_messages(to_node_id, delivered_at, created_at);

CREATE TABLE agent_checkpoints (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES agent_attempts(id) ON DELETE SET NULL,
  graph_revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  context_pack_id TEXT,
  worktree_revision TEXT,
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_budget_reservations (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES agent_graphs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES agent_attempts(id) ON DELETE SET NULL,
  resource TEXT NOT NULL,
  reserved REAL NOT NULL,
  consumed REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
```

기존 `tasks` table은 compatibility view 또는 migration source로 유지한다.

초기에는 삭제하지 않는다.

## 11.14 GraphScheduler

### 11.14.1 admission 순서

1. graph active 확인
2. node state 확인
3. dependency terminal 상태 확인
4. required dependency 성공 조건 확인
5. depth 확인
6. permission scope 확인
7. budget reserve
8. worktree assignment
9. writer lease
10. provider concurrency slot
11. worker lease 발급
12. attempt 생성
13. dispatch event commit
14. child kernel 시작

### 11.14.2 scheduling key

```text
priority DESC
ready_since ASC
estimated_cost ASC optional
node_id lexical
```

동일 입력에서 deterministic ordering을 유지한다.

### 11.14.3 fairness

- 한 graph가 모든 provider slot을 독점하지 않게 workspace/session quota
- read-only explorer burst 허용
- writer/merge coordinator 우선순위 별도
- waiting approval은 slot을 반납
- background job limit과 provider limit을 분리

## 11.15 dependency semantics

required dependency:

- completed이면 ready
- partial이면 edge condition에 따라 ready/blocked
- failed/cancelled/blocked면 downstream 기본 blocked

optional dependency:

- terminal이면 결과 전달
- 실패해도 downstream 실행 가능
- open risk에 dependency failure 추가

condition 예시:

```ts
export type EdgeCondition =
  | { kind: "terminal" }
  | { kind: "status_in"; statuses: string[] }
  | { kind: "evidence_present"; evidenceKind: string }
  | { kind: "files_changed"; paths: string[] };
```

임의 code expression은 허용하지 않는다.

## 11.16 Handoff

### 11.16.1 handoff capsule

```ts
export interface AgentHandoff {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  sourceAttemptId: string;
  summary: string;
  verifiedClaims: VerifiedClaim[];
  evidenceIds: string[];
  artifactIds: string[];
  filesChanged: Array<{
    path: string;
    postRevision: string;
    worktreeId?: string;
  }>;
  openRisks: string[];
  recommendedNextStep?: string;
  createdAt: string;
  digest: string;
}
```

### 11.16.2 수용 규칙

- source attempt가 terminal이어야 한다.
- evidence ID가 resolver에서 존재해야 한다.
- file revision/worktree binding이 current context와 맞아야 한다.
- contradicted claim은 handoff verifiedClaims에서 제외한다.
- raw transcript는 포함하지 않는다.
- downstream Context Compiler가 budget에 맞게 선택한다.

## 11.17 Mailbox와 steering

### message kind

```text
instruction
clarification
evidence
status_request
cancel_request
handoff
review_finding
merge_conflict
```

### 정책

- 실행 중 node는 safe point에서 message를 읽는다.
- provider request 중에는 next sample 전 반영한다.
- completed node에 message를 보내면 revive proposal이 된다.
- parent만 child에 message할 수 있다는 제한은 두지 않되 graph ancestry와 policy를 검사한다.
- child가 root에 escalation message를 보낼 수 있다.
- message body도 untrusted claim이다.

### API

```text
task.message
task.messages
task.acknowledge
```

## 11.18 Pause와 resume

### pause

- queued node는 즉시 paused
- waiting node는 state snapshot 후 paused
- running node는 safe checkpoint 요청
- process가 non-interruptible이면 pause pending
- writer transaction이 open이면 commit/rollback decision 후 pause

### resume

- dependency와 budget을 재평가
- worktree revision 확인
- context/evidence freshness 확인
- stale checkpoint면 new attempt

## 11.19 Revive

terminal node를 같은 attempt로 되살리지 않는다.

`revive`는 새 attempt를 생성한다.

조건:

- maxAttempts 미만 또는 explicit override
- task contract 재검증
- worktree 상태 존재
- previous result/evidence를 upstream context로 제공
- previous failure와 동일한 action 반복 방지

## 11.20 Retry policy

자동 retry 가능:

- provider transient failure
- rate limit
- daemon restart interrupted attempt
- LSP transient unavailable
- safe tool retryable error

자동 retry 금지:

- permission denied
- stale mutation conflict without new read
- repeated same failure threshold 초과
- contract invalid
- scope violation
- security violation
- unknown side effect reconciliation 전

## 11.21 Budget model

```ts
export interface GraphBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxReasoningTokens?: number;
  maxCostUsd?: number;
  maxToolCalls?: number;
  maxConcurrentNodes: number;
  maxConcurrentWriters: number;
  maxWallClockMs?: number;
}
```

per-node reservation:

- predictive estimate는 telemetry/admission aid
- hard budget mode에서는 reserve 실패 시 waiting_budget
- actual usage로 settle
- unused reserve release
- retry는 새 reserve

## 11.22 Writer policy

같은 worktree:

```text
maxWriterAgents = 1
```

전체 graph:

```text
maxConcurrentWriters = worktree count bound
```

writer node는 반드시:

- worktreeId 또는 base writer lease
- allowed path scope
- exact baseline revisions
- verification contract
- merge policy

## 11.23 cancellation

### node cancel

- 해당 node attempt abort
- child graph descendants policy에 따라 cancel 또는 orphan 금지
- process/job/transaction/worktree operation cancel
- state를 먼저 cancelled로 표시
- teardown 결과를 후속 event로 기록

### graph cancel

- 새 dispatch 중단
- active nodes에 cancel broadcast
- merge coordinator 중지
- open transaction rollback
- worktree retention policy 적용

### stop waiting

- observer/root의 wait만 종료
- node는 계속 실행
- current AC-21 semantic 유지

## 11.24 recovery

startup에서 attempt state가 running/leased이면:

1. owner daemon epoch 확인
2. provider request는 interrupted/unknown
3. process/job record 확인
4. transaction receipt 확인
5. worktree revision 확인
6. completed evidence가 있으면 reconcile complete
7. side effect unknown이면 blocked
8. safe no-side-effect attempt면 queued retry 가능

## 11.25 compatibility bridge

기존 `SubagentScheduler` API를 즉시 제거하지 않는다.

```ts
class PersistentSubagentBridge {
  spawn(options): AgentHandle
  await(agentId, signal): Promise<ChildAgentResult | undefined>
  cancel(agentId, reason): Promise<ChildAgentResult | undefined>
  status(agentId): AgentInstance | undefined
}
```

내부 구현은 AgentGraph command를 호출한다.

기존 tool contract:

- `task.spawn`
- `task.status`
- `task.cancel`

새 도구:

- `task.wait`
- `task.message`
- `task.pause`
- `task.resume`
- `task.revive`
- `task.inspect`
- `task.collect`

## 11.26 events

```text
graph.created
graph.updated
graph.paused
graph.resumed
graph.completed
graph.failed
graph.cancelled
graph.blocked
agent.node_created
agent.node_ready
agent.node_queued
agent.node_dispatched
agent.node_started
agent.node_waiting
agent.node_paused
agent.node_resumed
agent.node_completed
agent.node_partial
agent.node_failed
agent.node_cancelled
agent.node_blocked
agent.attempt_created
agent.attempt_interrupted
agent.attempt_reconciled
agent.message_sent
agent.message_delivered
agent.handoff_created
agent.handoff_accepted
agent.handoff_rejected
```

기존 `task.*` 이벤트는 compatibility projection으로 유지한다.

## 11.27 오류 코드

| 코드 | 의미 |
|---|---|
| `GRAPH_NOT_FOUND` | graph 없음 |
| `GRAPH_REVISION_CONFLICT` | expected revision mismatch |
| `GRAPH_NOT_ACTIVE` | paused/terminal graph mutation |
| `GRAPH_CYCLE_DETECTED` | edge가 cycle 생성 |
| `GRAPH_DEPTH_EXCEEDED` | max depth 초과 |
| `GRAPH_BUDGET_EXHAUSTED` | hard budget 소진 |
| `NODE_NOT_READY` | dependency/approval/budget 대기 |
| `NODE_STATE_CONFLICT` | invalid transition |
| `NODE_ATTEMPT_LIMIT` | max attempts 초과 |
| `NODE_WORKER_LEASE_CONFLICT` | 다른 worker가 실행 중 |
| `NODE_WRITER_LEASE_CONFLICT` | worktree writer busy |
| `NODE_CHECKPOINT_STALE` | resume 기준 stale |
| `HANDOFF_EVIDENCE_INVALID` | evidence mismatch |
| `MESSAGE_TARGET_TERMINAL` | revive 없이 terminal node message |
| `ATTEMPT_RECONCILIATION_REQUIRED` | side effect unknown |

## 11.28 config

```toml
[agent_graph]
enabled = true
max_depth = 3
max_nodes = 1000
max_concurrent_nodes = 8
max_concurrent_readers = 8
max_concurrent_writers = 4
max_attempts_per_node = 3
checkpoint_events = 25
message_bytes = 65536
recovery_policy = "safe-retry"

[agent_graph.budget]
mode = "hard"
max_cost_usd = 20.0
max_tool_calls = 1000
max_wall_clock_minutes = 120
```

project는 max를 낮출 수만 있다.

## 11.29 파일 변경 목록

### 신규

```text
packages/agent-graph-domain/**
apps/capy-daemon/src/agent-graph-service.ts
apps/capy-daemon/src/graph-scheduler.ts
apps/capy-daemon/src/graph-recovery.ts
crates/cbc-session-store/src/graph.rs
schemas/agent-graph/**
fixtures/agent-graph/**
```

### 수정

```text
packages/subagents/src/scheduler.ts
packages/subagents/src/instance.ts
packages/subagents/src/task.ts
packages/subagents/src/synthesis.ts
apps/cbc/src/subagent-bridge.ts
apps/cbc/src/agent.ts
packages/tool-registry/src/catalog.ts
packages/protocol-ts/src/events.ts
packages/session-domain/src/reducer.ts
packages/config-schema/src/schema.ts
crates/cbc-session-store/src/migrations.rs
crates/cbc-session-store/src/lib.rs
```

## 11.30 테스트 계획

### reducer

- replay deterministic
- invalid transition
- revision conflict
- cycle detection
- 10k node projection

### scheduler

- dependency ordering
- optional dependency
- budget waiting
- priority/fairness
- provider slot queue
- one writer per worktree
- multi-worktree writers

### lifecycle

- pause/resume
- revive/new attempt
- message delivery
- await interruption
- explicit cancel
- graph cancel

### recovery

- daemon crash running reader
- daemon crash after transaction commit
- unknown process state
- stale worker lease
- stale worktree checkpoint
- duplicate complete command

### evidence

- verified handoff
- contradicted child claim
- missing artifact
- stale path revision
- raw transcript absence

### security

- depth explosion
- 1000 node limit
- child authority escalation
- path scope widening
- forged message ancestry
- cross-workspace node injection

## 11.31 완료 기준

- [ ] graph/node/attempt가 SQLite에 저장된다.
- [ ] daemon restart 후 ready/running/terminal 상태가 reconcile된다.
- [ ] dependency DAG cycle이 거부된다.
- [ ] pause/resume/revive가 새 attempt semantics를 따른다.
- [ ] mailbox message가 durable하다.
- [ ] raw child transcript가 handoff에 포함되지 않는다.
- [ ] one-writer-per-worktree invariant가 유지된다.
- [ ] global/per-node budget이 강제된다.
- [ ] 기존 task tools가 compatibility bridge로 동작한다.
- [ ] 10k node reducer/perf test가 bounded하다.

## 11.32 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| GRF-001 | graph domain types | aggregate/node/edge/attempt |
| GRF-002 | graph reducer | deterministic state machine |
| GRF-003 | cycle detector | DAG invariant |
| GRF-004 | graph command schema | optimistic commands |
| GRF-005 | migration 10 | graph persistence |
| GRF-006 | GraphStore | transactional query/update |
| GRF-007 | event integration | session journal canonical events |
| GRF-008 | GraphScheduler | ready/admission/dispatch |
| GRF-009 | worker lease | owner epoch and heartbeat |
| GRF-010 | attempt lifecycle | retry/reconcile/history |
| GRF-011 | dependency evaluator | required/optional/condition |
| GRF-012 | budget ledger | reserve/consume/settle |
| GRF-013 | mailbox | durable messages |
| GRF-014 | handoff service | verified capsules |
| GRF-015 | checkpoint | safe resume points |
| GRF-016 | pause/resume | lifecycle commands |
| GRF-017 | revive | new attempt semantics |
| GRF-018 | cancellation | node/descendant/graph |
| GRF-019 | recovery | crash reconciliation |
| GRF-020 | compatibility bridge | existing scheduler API |
| GRF-021 | new task tools | wait/message/pause/resume |
| GRF-022 | TUI graph drawer | DAG/status/messages |
| GRF-023 | App Server API | graph methods |
| GRF-024 | stress tests | 10k nodes/fairness |
| GRF-025 | security tests | depth/scope/identity |
| GRF-026 | benchmark | delegation quality/cost |
| GRF-027 | docs | graph operations and recovery |

---

# 12. 개선 항목 7 — Worktree Multi-Agent

## 12.1 목표

- 여러 writer agent가 서로의 working tree를 오염시키지 않고 병렬 작업한다.
- 같은 tree에서는 single writer를 유지한다.
- 각 writer 결과를 검증 가능한 proposal로 만든다.
- base 반영은 하나의 merge coordinator가 담당한다.
- conflict를 조용히 해결하지 않고 evidence와 함께 표시한다.
- abandoned worktree를 복구·정리한다.
- worktree별 LSP, diagnostics, memory, process authority를 격리한다.

## 12.2 비목표

- 여러 writer가 같은 checkout에 동시에 write
- model에게 unrestricted `git worktree` shell 권한 제공
- model에게 generic `git commit`/`git push` 자동 권한 제공
- dirty base를 추측해서 병합
- conflict marker가 남은 상태를 성공으로 보고
- worktree path를 project가 임의 지정
- submodule/worktree edge case를 첫 버전에서 모두 지원

## 12.3 초기 지원 정책

### P0

- Git repository만 지원
- clean HEAD 기준 worktree 생성
- detached worktree
- writer당 1 worktree
- diff proposal을 base Edit Engine으로 적용
- no generic commit/push

### P1

- dirty base overlay snapshot
- internal temporary commit/object
- partial path worktree assignment
- long-lived worktree reuse
- submodule-aware mode

### P2

- user-visible branch/commit proposal
- PR delivery integration

## 12.4 아키텍처

```text
WorktreeManager
  ├─ WorktreeStore
  ├─ GitWorktreeBackend
  ├─ WorktreeRuntimeSupervisor
  ├─ WorktreeLspSupervisor
  ├─ WorktreeLeaseManager
  ├─ ProposalBuilder
  ├─ MergeCoordinator
  ├─ ConflictAnalyzer
  ├─ MergeVerifier
  └─ CleanupReconciler
```

## 12.5 worktree path

Capybara가 소유하는 data directory 아래에 둔다.

```text
<data>/worktrees/<workspace-digest>/<worktree-id>/repo
```

규칙:

- project input으로 absolute path를 받지 않는다.
- directory component는 generated ID만 사용한다.
- parent directory ownership/permission 검증
- symlink component 금지
- runtime path guard에서 canonical path 확인
- worktree `.git` file이 예상 main repository를 가리키는지 검증

## 12.6 WorktreeRecord

```ts
export interface WorktreeRecord {
  id: `wt_${string}`;
  workspaceIdentityDigest: string;
  graphId: string;
  nodeId?: string;
  path: string;
  state:
    | "creating"
    | "ready"
    | "leased"
    | "dirty"
    | "proposal_ready"
    | "merging"
    | "merged"
    | "conflicted"
    | "abandoned"
    | "deleting"
    | "deleted"
    | "recovery_required";
  baseCommit: string;
  baseWorkspaceRevision: string;
  headCommit?: string;
  dirtyDigest?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  ownerNodeId?: string;
  writerLeaseId?: string;
  revision: number;
}
```

## 12.7 base descriptor

```ts
export interface WorktreeBaseDescriptor {
  gitRootIdentity: string;
  headCommit: string;
  workspaceChangeToken: string;
  dirty: boolean;
  dirtyOverlayArtifactId?: string;
  untrackedManifestArtifactId?: string;
  createdAt: string;
}
```

### clean base

- `dirty=false`
- exact HEAD commit
- current workspace change token
- worktree create 직전 재검증

### dirty base P0 정책

- 기본 거부
- error에 clean/checkpoint/include-overlay 선택지를 제공
- base workspace 변경을 자동 stash하지 않는다.

### dirty overlay P1

- tracked diff와 allowed untracked files를 artifact로 snapshot
- secret/sensitive file 자동 제외
- worktree 생성 후 Edit Engine transaction으로 overlay 적용
- overlay 적용 결과 revision을 worktree base로 기록
- base workspace와 동일하다는 claim을 manifest digest로 검증

## 12.8 Git backend

Rust `cbc-git`에 안전한 wrapper를 추가한다.

지원 command 예시:

```text
git worktree add --detach <generated-path> <exact-commit>
git worktree remove --force <generated-path>
git worktree prune --expire now
git rev-parse --verify <commit>
git diff --binary --no-ext-diff <base> -- <paths>
```

정책:

- direct argv
- pager off
- terminal prompt off
- hooks off
- global/system config off
- generated path only
- exact commit only
- no arbitrary refspec from model
- no remote/network command

## 12.9 derived trust

worktree filesystem identity는 base와 다르다.

기존 persistent trust를 path만으로 상속하면 안 된다.

**[결정]** ephemeral derived authority를 사용한다.

```ts
export interface DerivedWorktreeAuthority {
  worktreeId: string;
  baseWorkspaceIdentityDigest: string;
  baseTrustDecisionRevision: string;
  gitRootIdentity: string;
  baseCommit: string;
  path: string;
  expiresAt: string;
  authority: "read" | "build";
}
```

- user trust store에 새 persistent record를 쓰지 않는다.
- base trust가 revoke되면 즉시 worktree authority도 revoke한다.
- daemon lifetime 또는 worktree lifetime 동안만 유효하다.
- worktree runtime capability receipt에 worktree ID를 포함한다.

## 12.10 writer lease

```ts
export interface WorktreeWriterLease {
  id: string;
  worktreeId: string;
  nodeId: string;
  allowedPaths: string[];
  baselineRevisions: Record<string, string>;
  ownerEpoch: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}
```

규칙:

- worktree당 writer 1개
- allowedPaths overlap 검증은 worktree 내부에서도 유지
- lease expiration이 자동 다른 writer admission을 의미하지 않음
- old writer attempt 상태를 reconcile한 후 재발급
- process tool도 worktree cwd와 capability에 묶는다.

## 12.11 graph 연결

`AgentNode.worktreeId`를 사용한다.

spawn 옵션 제안:

```ts
export interface WorktreeIsolationRequest {
  mode: "none" | "new" | "reuse";
  worktreeId?: string;
  base: "current_head" | "parent_proposal";
  retention: "until_node_terminal" | "until_graph_terminal" | "manual";
}
```

writer role 기본:

- root/base writer: explicit
- executor/refactorer: `mode=new` 권장
- reviewer/test/explore: parent worktree read-only 공유 가능

## 12.12 process와 runtime

각 worktree는 다음 중 하나를 사용한다.

### 옵션 A: 별도 cbc-runtime process

장점:

- workspace root가 명확
- trust/path guard 단순
- process/LSP 격리

단점:

- process 수 증가

### 옵션 B: 하나의 runtime에서 workspace handle

장점:

- 자원 절약

단점:

- 현재 runtime state가 single workspace를 가정
- protocol과 authority 변경 범위 큼

**[결정]** 초기에는 worktree별 runtime sidecar를 사용한다.

Daemon의 RuntimeSidecarSupervisor가 자원 상한과 idle eviction을 관리한다.

## 12.13 LSP와 worktree

- LSP key에 worktreeId 포함
- document URI는 worktree path
- base diagnostics와 섞지 않음
- proposal 생성 시 worktree diagnostics snapshot 첨부
- merge 후 base LSP가 새 revision을 다시 진단
- worktree LSP evidence는 base memory로 자동 승격하지 않음

## 12.14 WorktreeProposal

```ts
export interface WorktreeProposal {
  id: string;
  worktreeId: string;
  graphId: string;
  nodeId: string;
  attemptId: string;
  baseCommit: string;
  baseWorkspaceRevision: string;
  worktreeRevision: string;
  changedFiles: Array<{
    path: string;
    kind: "create" | "modify" | "delete" | "rename";
    oldPath?: string;
    baseRevision?: string;
    postRevision?: string;
    additions: number;
    deletions: number;
  }>;
  diffArtifactId: string;
  fileManifestArtifactId: string;
  verificationEvidenceIds: string[];
  diagnosticsEvidenceIds: string[];
  openRisks: string[];
  createdAt: string;
  digest: string;
}
```

proposal은 worktree result claim과 runtime facts를 분리한다.

- changed file hash는 runtime record에서 생성
- test exit는 process event에서 생성
- child summary는 별도 claim
- proposal digest는 canonical facts에 기반

## 12.15 proposal 생성

```text
node terminal candidate
  → open transaction 없음 확인
  → running process 없음 또는 명시된 background 제외
  → worktree status/diff 수집
  → allowed path scope 검증
  → sensitive/untracked file 검사
  → file manifest + diff artifact 생성
  → verification evidence 확인
  → diagnostics snapshot
  → proposal digest 생성
  → worktree proposal_ready
```

## 12.16 MergeCoordinator

### 12.16.1 단일 base writer

MergeCoordinator만 base workspace writer lease를 획득한다.

다른 root mutation과 동시에 merge하지 않는다.

### 12.16.2 merge input

- one or more WorktreeProposal
- base current workspace revision
- merge order
- conflict policy
- required verification

### 12.16.3 merge 방식

초기 권장:

```text
proposal diff/file manifest
  → current base exact reads
  → 3-way comparison(base-at-fork, proposal, current-base)
  → canonical EditPlan
  → preview/conflict
  → base transaction commit
```

직접 `git cherry-pick`을 기본 merge로 사용하지 않는다.

이유:

- agent가 commit을 만들지 않아도 된다.
- current dirty base와 transaction semantics를 통합할 수 있다.
- expected revision과 user edit 보호가 유지된다.
- file operation receipt가 기존 journal에 남는다.

## 12.17 3-way merge

입력:

```text
BASE  = worktree fork 시 content
OURS  = current base workspace content
THEIRS = worktree proposal content
```

자동 병합 가능:

- OURS == BASE
- THEIRS == BASE
- non-overlapping range edits
- rename destination free
- independent file create

conflict:

- same range different change
- delete/modify
- rename/rename
- create/create different content
- current base revision 불명
- missing pre-image artifact

conflict는 다음 구조로 반환한다.

```ts
export interface MergeConflict {
  id: string;
  path: string;
  kind: "content" | "delete_modify" | "rename" | "create" | "revision";
  baseArtifactId?: string;
  oursArtifactId?: string;
  theirsArtifactId?: string;
  ranges?: TextRange[];
  proposals: string[];
  resolutionOptions: Array<"ours" | "theirs" | "manual" | "replan">;
}
```

## 12.18 conflict resolution

- model이 자동 resolution proposal을 만들 수 있다.
- resolution은 새 EditPlan이다.
- reviewer가 conflict evidence를 독립 검토할 수 있다.
- user는 ours/theirs/manual을 선택할 수 있다.
- conflict marker를 base file에 임시 write하지 않는다.
- unresolved conflict 상태에서 merge completed 이벤트를 내지 않는다.

## 12.19 multi-proposal merge

여러 worktree proposal을 병합할 때:

1. dependency/priority order 결정
2. 각 proposal base compatibility 검증
3. proposal 간 path overlap 분석
4. disjoint proposal은 하나의 transaction 또는 순차 transaction 선택
5. 각 commit 후 next proposal을 current base에 rebase
6. 전체 verification

초기 정책:

- proposal별 transaction
- 각 proposal 후 verification checkpoint
- 실패 시 해당 proposal undo 가능
- cross-proposal all-or-nothing은 후속 옵션

## 12.20 merge verification

필수 evidence:

- base transaction receipt
- changed file post hashes
- LSP diagnostics delta
- proposal verification 재실행 또는 impact planner 결과
- independent review policy
- old symbol/reference check if rename
- no unresolved conflict

worktree에서 passed한 test만으로 base merge 검증을 대체하지 않는다.

## 12.21 worktree cleanup

### 자동 삭제 조건

- state merged/abandoned
- active node 없음
- pending merge 없음
- process/LSP/runtime 종료
- artifact/proposal persisted
- retention elapsed

### 삭제 절차

1. lease revoke
2. runtime/LSP stop
3. Git worktree registration 확인
4. `git worktree remove`
5. directory absence 확인
6. store state deleted
7. prune

### 실패

- state `recovery_required`
- path를 수동 `rm -rf`하지 않음
- next startup에서 reconcile

## 12.22 migration 11

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  workspace_identity_digest TEXT NOT NULL,
  graph_id TEXT REFERENCES agent_graphs(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES agent_nodes(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  base_workspace_revision TEXT NOT NULL,
  head_commit TEXT,
  dirty_digest TEXT,
  owner_node_id TEXT,
  writer_lease_id TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX idx_worktrees_workspace_state
  ON worktrees(workspace_identity_digest, state);

CREATE TABLE worktree_leases (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  owner_epoch INTEGER NOT NULL,
  allowed_paths_json TEXT NOT NULL,
  baseline_revisions_json TEXT NOT NULL,
  state TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE worktree_proposals (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  base_workspace_revision TEXT NOT NULL,
  worktree_revision TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE merge_attempts (
  id TEXT PRIMARY KEY,
  workspace_identity_digest TEXT NOT NULL,
  graph_id TEXT,
  proposal_ids_json TEXT NOT NULL,
  base_revision_before TEXT NOT NULL,
  base_revision_after TEXT,
  transaction_id TEXT,
  state TEXT NOT NULL,
  conflict_policy TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE merge_conflicts (
  id TEXT PRIMARY KEY,
  merge_attempt_id TEXT NOT NULL REFERENCES merge_attempts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  conflict_json TEXT NOT NULL,
  state TEXT NOT NULL,
  resolution_plan_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

## 12.23 Runtime RPC

```text
worktree.create
worktree.inspect
worktree.list
worktree.status
worktree.diff
worktree.remove
worktree.reconcile
```

`worktree.merge`는 high-level daemon operation이며 Rust runtime에는 low-level safe primitives만 둘 수 있다.

Rust Git handler는 arbitrary path/ref를 받지 않는다.

## 12.24 model/root 도구

```text
worktree.search
worktree.inspect
worktree.propose
worktree.discard
merge.preview
merge.apply
merge.resolve
```

일반 child에게 `worktree.create/remove/merge.apply`를 직접 주지 않는다.

GraphScheduler가 create/lease를 수행한다.

## 12.25 events

```text
worktree.create_started
worktree.created
worktree.ready
worktree.leased
worktree.dirty
worktree.proposal_created
worktree.abandoned
worktree.delete_started
worktree.deleted
worktree.recovery_required
merge.started
merge.preview_completed
merge.conflicted
merge.resolution_proposed
merge.resolution_applied
merge.committed
merge.verification_started
merge.verification_completed
merge.failed
```

## 12.26 오류 코드

| 코드 | 의미 |
|---|---|
| `WORKTREE_UNSUPPORTED` | non-Git/host 미지원 |
| `WORKTREE_BASE_DIRTY` | P0 clean base 요구 |
| `WORKTREE_BASE_CHANGED` | create 전 base revision 변경 |
| `WORKTREE_PATH_INVALID` | generated path integrity 실패 |
| `WORKTREE_GIT_IDENTITY_MISMATCH` | 다른 repo를 가리킴 |
| `WORKTREE_ALREADY_LEASED` | writer lease 충돌 |
| `WORKTREE_RUNTIME_UNAVAILABLE` | scoped runtime 실패 |
| `WORKTREE_PROPOSAL_STALE` | base/proposal revision 불일치 |
| `WORKTREE_SCOPE_VIOLATION` | allowed path 밖 변경 |
| `MERGE_CONFLICT` | 자동 병합 불가 |
| `MERGE_BASE_CHANGED` | preview 후 base 변경 |
| `MERGE_VERIFICATION_FAILED` | base 검증 실패 |
| `WORKTREE_CLEANUP_FAILED` | remove/reconcile 필요 |

## 12.27 config

```toml
[worktrees]
enabled = true
root = "auto"
max_active = 8
max_active_writers = 4
require_clean_base = true
retention_hours = 24
runtime_per_worktree = true
lsp_per_worktree = true

[worktrees.merge]
preview_required = true
independent_review = true
verify_on_base = true
auto_merge_disjoint = true
conflict_policy = "block"
```

project는 root path나 active limit을 늘릴 수 없다.

## 12.28 파일 변경 목록

### 수정

```text
crates/cbc-git/src/lib.rs
crates/cbc-runtime/src/server.rs
crates/cbc-runtime/src/handlers/git.rs
crates/cbc-runtime/src/handlers/mod.rs
apps/cbc/src/runtime.ts
apps/cbc/src/subagent-bridge.ts
packages/subagents/src/instance.ts
packages/agent-graph-domain/**
packages/protocol-ts/src/events.ts
packages/config-schema/src/schema.ts
crates/cbc-session-store/src/migrations.rs
scripts/build-standalone.ts
```

### 신규

```text
crates/cbc-git/src/worktree.rs
crates/cbc-git/src/merge.rs
crates/cbc-runtime/src/handlers/worktree.rs
apps/capy-daemon/src/worktree-manager.ts
apps/capy-daemon/src/merge-coordinator.ts
crates/cbc-session-store/src/worktree.rs
schemas/worktree/**
fixtures/worktrees/**
```

## 12.29 테스트 계획

### create/identity

- clean repo worktree
- non-Git refusal
- dirty base refusal
- exact commit verification
- generated path only
- symlink parent refusal
- different Git identity refusal

### leases

- one writer per worktree
- multiple worktree writers
- stale lease recovery
- base trust revoke
- process cwd binding

### proposal

- allowed path changes
- out-of-scope change rejection
- create/delete/rename
- untracked sensitive file withholding
- proposal digest stability
- runtime hash evidence

### merge

- no base change fast path
- non-overlapping 3-way merge
- same-line conflict
- delete/modify
- rename conflict
- base changes after preview
- transaction rollback
- diagnostics/test/review gate

### cleanup

- normal remove
- daemon crash during remove
- manually missing directory
- stale Git worktree registration
- active process prevents delete

### cross-platform

- Windows path length
- case-insensitive collision
- macOS case normalization
- Unix permission

## 12.30 완료 기준

- [ ] clean Git repo에서 두 writer가 병렬 실행된다.
- [ ] 각 writer는 별도 runtime/worktree root를 사용한다.
- [ ] 같은 worktree에 두 writer가 들어가지 못한다.
- [ ] proposal은 runtime hash와 verification evidence를 가진다.
- [ ] base merge는 Edit Engine transaction을 사용한다.
- [ ] conflict marker가 working file에 남지 않는다.
- [ ] base 변경 후 stale merge가 거부된다.
- [ ] merge 후 base diagnostics/test/review가 수행된다.
- [ ] cleanup/recovery가 daemon restart에서 동작한다.
- [ ] base trust revoke가 derived authority를 무효화한다.

## 12.31 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| WTK-001 | Rust worktree wrapper | safe create/list/remove |
| WTK-002 | generated path guard | data-root containment |
| WTK-003 | Git identity verifier | main repo binding |
| WTK-004 | WorktreeRecord store | lifecycle persistence |
| WTK-005 | migration 11 | worktree/proposal/merge tables |
| WTK-006 | derived authority | ephemeral trust binding |
| WTK-007 | runtime supervisor | sidecar per worktree |
| WTK-008 | LSP supervisor binding | worktree document isolation |
| WTK-009 | writer lease | one writer/tree |
| WTK-010 | graph assignment | node worktree lifecycle |
| WTK-011 | status/diff collector | bounded proposal facts |
| WTK-012 | ProposalBuilder | canonical proposal digest |
| WTK-013 | sensitive scanner | untracked/secret policy |
| WTK-014 | MergeCoordinator | base single writer |
| WTK-015 | three-way analyzer | auto merge/conflict |
| WTK-016 | EditPlan converter | proposal → base transaction |
| WTK-017 | conflict model | artifacts/options/state |
| WTK-018 | conflict resolver | new edit plan |
| WTK-019 | base verification | diagnostics/tests/review |
| WTK-020 | cleanup reconciler | stop/remove/prune/recover |
| WTK-021 | runtime RPC | worktree safe primitives |
| WTK-022 | root tools | inspect/propose/merge |
| WTK-023 | TUI worktree drawer | state/proposal/conflict |
| WTK-024 | App Server API | worktree/merge methods |
| WTK-025 | fault tests | crash/create/merge/remove |
| WTK-026 | security fixtures | path/trust/repo identity |
| WTK-027 | benchmark | parallelism/merge success |
| WTK-028 | docs | constraints and recovery |

---
# 13. 개선 항목 8 — Hooks + Plugin SDK

## 13.1 목표

- session/turn/model/tool/edit/verification/graph/memory lifecycle에 확장 지점을 제공한다.
- plugin이 tool, command, agent definition, context provider, UI metadata를 등록할 수 있게 한다.
- plugin 실행을 host process에서 격리한다.
- plugin이 ambient filesystem/network/credential authority를 갖지 않게 한다.
- hook이 권한을 넓히지 못하게 한다.
- 설치·버전·digest·grant를 lockfile과 DB에 기록한다.
- SDK와 test harness를 제공한다.
- existing Skill/MCP surface와 충돌하지 않게 계층을 구분한다.

## 13.2 확장 계층

```text
Layer 1: Skill
  - instruction/reference/template
  - executable code 없음
  - 기존 방식 유지

Layer 2: MCP
  - external tool/resource service
  - MCP protocol와 risk classification
  - 기존 방식 유지

Layer 3: Plugin
  - lifecycle hook
  - custom tool/command/agent/context provider
  - versioned Capybara Plugin Protocol
  - isolated execution
```

Skill을 plugin으로 자동 승격하지 않는다.

MCP server를 plugin package에 묶을 수는 있으나 authority는 각각 평가한다.

## 13.3 plugin 실행 tier

### Tier A — WASI plugin

기본 권장 형식이다.

- `wasm32-wasi` 또는 component model
- ambient directory 없음
- ambient network 없음
- host function allowlist
- deterministic resource limits
- portable sandbox
- project plugin에도 적합

### Tier B — stdio plugin process

- user가 explicit global config로 등록
- Rust process supervisor로 실행
- sanitized environment
- workspace path 직접 전달 금지
- RPC host API만 사용
- platform sandbox capability가 부족하면 경고/거부
- project가 executable path를 지정하지 못함

### Tier C — unsafe local developer plugin

- 개발 편의용 opt-in
- 명시적 `unsafe=true`
- production/release default off
- project에서 활성화 불가
- 경고 배너와 audit event
- benchmark/release gate에서 별도 profile

## 13.4 plugin package 구조

```text
my-plugin/
  capybara-plugin.json
  plugin.wasm                 # Tier A
  README.md
  LICENSE
  schemas/
    tools/*.schema.json
    state.schema.json
  assets/
  signature.json              # optional during alpha, required for registry
```

stdio plugin 예시:

```text
my-plugin/
  capybara-plugin.json
  dist/plugin.cjs
  package.json
  lockfile
  README.md
  LICENSE
```

## 13.5 manifest

```ts
export interface PluginManifest {
  schemaVersion: "1.0";
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  runtime: {
    kind: "wasi" | "stdio";
    entrypoint: string;
    protocolVersion: string;
  };
  compatibility: {
    capybara: string;
    platforms?: string[];
  };
  hooks?: HookSubscriptionManifest[];
  tools?: PluginToolManifest[];
  commands?: PluginCommandManifest[];
  agents?: PluginAgentManifest[];
  contextProviders?: PluginContextProviderManifest[];
  ui?: PluginUiManifest;
  permissions: PluginPermissionRequest;
  limits?: PluginLimitRequest;
  integrity: {
    files: Record<string, string>;
    packageDigest: string;
  };
  signature?: PluginSignature;
}
```

### 13.5.1 permission request

```ts
export interface PluginPermissionRequest {
  events?: string[];
  tools?: string[];
  workspaceRead?: string[];
  workspaceWrite?: string[];
  networkDomains?: string[];
  credentials?: string[];
  artifacts?: "none" | "read-own" | "create";
  sessionState?: "none" | "read" | "write-own";
  memory?: "none" | "search" | "propose";
  graph?: "none" | "observe" | "propose-node";
}
```

요청은 grant가 아니다.

실제 grant는 user policy가 더 좁게 만든다.

## 13.6 plugin lockfile

```json
{
  "schemaVersion": "1.0",
  "plugins": {
    "publisher/name": {
      "version": "1.2.3",
      "source": "registry-or-path",
      "packageDigest": "sha256:...",
      "manifestDigest": "sha256:...",
      "signature": {
        "keyId": "...",
        "verified": true
      },
      "grants": {
        "events": ["after.tool"],
        "workspaceRead": ["src/**"],
        "networkDomains": []
      }
    }
  }
}
```

규칙:

- exact version/digest pin
- update는 explicit
- package content 변경 시 실행 거부
- missing signature policy에 따라 거부/경고
- project lockfile은 global grant를 넓히지 못함

## 13.7 설치 scope

```text
builtin
user
project
```

### builtin

- release artifact에 포함
- Capybara release signature로 보호
- 기본 disabled 또는 explicit enabled

### user

- global config/data directory
- user가 executable authority를 승인
- 모든 trusted workspace에서 사용할 수 있으나 path grant는 workspace별

### project

- trusted workspace에서만 manifest/body 로드
- Tier A WASI만 기본 허용
- executable stdio path 등록 금지
- user가 enable 및 grant해야 함
- project는 version/digest를 제안할 수 있지만 자동 다운로드 금지

## 13.8 Plugin Supervisor

```text
PluginSupervisor
  ├─ PackageVerifier
  ├─ ManifestRegistry
  ├─ PermissionGrantStore
  ├─ PluginProcess/WasiInstance
  ├─ InvocationScheduler
  ├─ HookDispatcher
  ├─ ToolAdapter
  ├─ CommandAdapter
  ├─ AgentAdapter
  ├─ PluginStateStore
  └─ Health/CircuitBreaker
```

소유권:

- WorkspaceSupervisor가 workspace plugin set을 소유
- daemon global plugin registry는 package metadata만 소유
- plugin process는 workspace/worktree scope로 분리 가능
- session-only plugin instance는 명시적 manifest일 때만 생성

## 13.9 Plugin Protocol

JSON-RPC 또는 framed message를 사용한다.

### host → plugin

```text
plugin.initialize
plugin.hook
plugin.tool.execute
plugin.command.execute
plugin.context.collect
plugin.shutdown
```

### plugin → host

```text
host.log
host.artifact.create
host.workspace.read
host.tool.call
host.memory.propose
host.graph.propose_node
host.state.get
host.state.set
```

plugin은 Rust runtime RPC를 직접 호출하지 않는다.

모든 host request는 plugin grant와 session policy를 통과한다.

## 13.10 initialize

```ts
export interface PluginInitializeParams {
  protocolVersion: string;
  pluginId: string;
  pluginVersion: string;
  instanceId: string;
  workspaceIdentityDigest?: string;
  worktreeId?: string;
  grantedCapabilities: PluginGrantedCapabilities;
  limits: PluginEffectiveLimits;
  hostCapabilities: Record<string, boolean>;
}
```

secret, raw workspace path, credential value는 기본적으로 전달하지 않는다.

path는 workspace-relative logical path로 제공한다.

## 13.11 Hook taxonomy

### daemon/session

```text
before.session_create
after.session_create
before.session_resume
after.session_resume
before.session_close
after.session_close
```

### turn/model

```text
before.turn
before.prompt_compile
after.prompt_compile
before.model_request
after.model_response
after.turn
```

### tool

```text
before.tool
before.tool_execute
after.tool_execute
after.tool
on.tool_error
```

### edit/transaction

```text
before.edit_plan
before.transaction_commit
after.transaction_commit
on.transaction_conflict
```

### verification/review

```text
before.verification
after.verification
before.review
after.review
```

### graph/worktree

```text
before.agent_spawn
after.agent_complete
before.worktree_create
after.worktree_proposal
before.merge
after.merge
```

### context/memory

```text
before.context_select
after.context_pack
before.memory_write
after.memory_write
on.memory_invalidate
```

## 13.12 hook phase semantics

### before hook

반환 가능:

```ts
export type BeforeHookDecision =
  | { action: "continue"; annotations?: HookAnnotation[] }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string; riskFloor?: RiskClass }
  | { action: "narrow"; constraints: HookConstraints; reason: string };
```

`narrow`가 가능한 항목:

- path subset
- network allow → deny
- timeout 감소
- output limit 감소
- model tool list subset
- context candidate subset
- max node count 감소

`narrow`로 할 수 없는 항목:

- deny → allow
- network deny → allow
- read → write
- path 추가
- timeout 증가
- risk class 감소
- approval 생략
- sandbox level 완화

### after hook

- annotation
- metric
- memory proposal
- follow-up graph proposal
- artifact creation
- user notification

이미 발생한 receipt를 수정하지 못한다.

## 13.13 authority monotonicity validator

hook decision 적용 전 host가 비교한다.

```ts
validateNarrowing(original: EffectiveOperation, proposed: HookConstraints): Result
```

검사:

- set inclusion
- numeric upper bound
- risk order
- permission order
- network order
- sandbox order
- credential scope equality/subset

plugin의 “이 변경은 안전하다” 문장은 risk downgrade 근거가 아니다.

## 13.14 hook ordering

결정적 순서:

1. builtin policy hooks
2. user critical hooks
3. project critical hooks
4. user ordinary hooks
5. project ordinary hooks
6. plugin ID lexical order
7. manifest ordinal

동일 우선순위에서 설치 시간으로 정렬하지 않는다.

재현 가능해야 한다.

## 13.15 hook failure policy

### critical policy hook

- user가 critical로 승인
- timeout/crash/protocol error 시 fail-closed
- operation blocked
- clear diagnostic

### ordinary before hook

- default fail-open 또는 config에 따라 fail-closed
- 실패 event와 risk 기록
- permission을 자동 완화하지 않음

### after/observation hook

- fail-open
- primary operation receipt는 유지
- plugin circuit counter 증가

### max duration

- before hook 기본 2 s
- after hook 기본 5 s
- 전체 hook aggregate budget
- timeout 후 invocation cancel
- repeated timeout 시 circuit open

## 13.16 reentrancy

plugin hook가 host tool을 호출할 수 있으므로 cycle 방지 필요.

```ts
export interface InvocationContext {
  invocationId: string;
  rootOperationId: string;
  depth: number;
  visitedPluginHooks: string[];
  toolCallBudget: number;
}
```

정책:

- default max reentrancy depth 2
- 같은 plugin의 같은 hook 재진입 금지
- before.tool hook에서 mutation tool 호출 금지
- observation hook의 read-only tool만 제한적으로 허용
- nested call도 일반 policy/event를 통과

## 13.17 Plugin Tool

### manifest

```ts
export interface PluginToolManifest {
  id: string;
  title: string;
  description: string;
  parametersSchema: string;
  requestedRisk: RiskClass;
  sideEffect: "read" | "write" | "destructive" | "external" | "unknown";
  network: boolean;
  resultSchema?: string;
}
```

### host registration

- namespace `plugin.<pluginId>.<toolName>`
- strict object schema
- `additionalProperties:false`
- host risk classifier가 effective risk 결정
- plugin requested risk는 lower bound가 아니다.
- unknown side effect는 escalation
- tool discovery에 들어감
- result는 redaction/sanitization/spill

### execution

```text
model tool call
  → ToolRegistry validation
  → HostActionNormalizer
  → policy/approval
  → plugin grant validation
  → plugin invocation
  → nested host calls if allowed
  → result sanitize
  → evidence/event
```

## 13.18 Plugin Command

- slash/CLI/App Server command contribution
- command name namespace
- local parsing schema
- model에 자동 노출되지 않음
- side effect command는 동일 approval flow
- interactive UI required 여부 명시

예:

```json
{
  "name": "dependency-report",
  "aliases": [],
  "description": "Generate a dependency report",
  "argumentsSchema": "schemas/dependency-report.json",
  "headless": true
}
```

## 13.19 Plugin Agent

plugin은 custom agent definition을 제공할 수 있다.

규칙:

- 기존 base role을 사용
- authority를 base role보다 넓히지 못함
- max tools/duration/context ceiling을 높이지 못함
- instruction body는 trust/injection scan
- executable plugin과 agent instruction provenance를 함께 표시
- graph spawn 시 manifest version/digest를 attempt에 기록

## 13.20 Context Provider

plugin은 context candidate를 제안할 수 있다.

```ts
export interface PluginContextCandidate {
  id: string;
  kind: string;
  text?: string;
  artifactId?: string;
  estimatedTokens: number;
  trust: "plugin";
  freshness: string;
  evidenceIds: string[];
  validFor: MemoryValidity;
}
```

- Context Compiler가 최종 선택
- plugin이 L0/L1 policy layer를 작성하지 못함
- project plugin candidate는 untrusted instruction으로 표시
- evidence 없는 fact claim은 낮은 confidence/제외

## 13.21 UI contribution

초기에는 declarative metadata만 허용한다.

```ts
export interface PluginUiManifest {
  drawers?: Array<{
    id: string;
    title: string;
    dataSource: string;
  }>;
  statusItems?: Array<{
    id: string;
    label: string;
    eventKinds: string[];
  }>;
}
```

plugin이 arbitrary terminal escape/HTML/JS를 TUI에 렌더링하지 못한다.

모든 text는 host renderer와 sanitizer를 통과한다.

## 13.22 Plugin state

plugin당 namespaced KV를 제공한다.

```ts
export interface PluginStateValue {
  pluginId: string;
  workspaceIdentityDigest?: string;
  scope: "global" | "workspace" | "session";
  key: string;
  value: unknown;
  revision: number;
}
```

제약:

- JSON size limit
- secret 저장 금지
- compare-and-set
- plugin uninstall 시 retention policy
- 다른 plugin state 접근 금지

## 13.23 migration 12

```sql
CREATE TABLE plugin_installations (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  signature_json TEXT,
  runtime_kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plugin_id, version, package_digest)
);

CREATE TABLE plugin_grants (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  workspace_identity_digest TEXT,
  grant_json TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_plugin_grants_workspace
  ON plugin_grants(workspace_identity_digest, revoked_at);

CREATE TABLE plugin_instances (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  workspace_identity_digest TEXT,
  worktree_id TEXT,
  session_id TEXT,
  state TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT,
  heartbeat_at TEXT,
  stopped_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plugin_invocations (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES plugin_instances(id) ON DELETE CASCADE,
  hook_or_method TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  decision_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_plugin_invocations_correlation
  ON plugin_invocations(correlation_id, started_at);

CREATE TABLE plugin_state (
  installation_id TEXT NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  workspace_identity_digest TEXT,
  session_id TEXT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, workspace_identity_digest, session_id, key)
);
```

## 13.24 signing과 supply chain

### 설치 검증

1. manifest schema
2. path traversal 없는 package layout
3. file digest
4. package digest
5. signature
6. publisher key trust/revocation
7. compatibility
8. runtime kind policy
9. permission diff
10. lockfile update

### alpha 정책

- local path plugin은 unsigned 허용 가능
- explicit warning
- registry-distributed plugin은 signature 요구
- builtin은 release signature chain

### update

- 자동 major update 금지
- permission diff 표시
- 새 permission은 재승인
- digest 변경 후 old process stop
- migration hook은 restricted state API만 사용
- rollback package 보존

## 13.25 events

```text
plugin.discovered
plugin.installed
plugin.updated
plugin.enabled
plugin.disabled
plugin.grant_requested
plugin.grant_resolved
plugin.started
plugin.ready
plugin.degraded
plugin.stopped
plugin.hook_started
plugin.hook_completed
plugin.hook_failed
plugin.hook_denied
plugin.tool_registered
plugin.command_registered
plugin.agent_registered
plugin.context_proposed
plugin.circuit_opened
plugin.state_changed
```

## 13.26 오류 코드

| 코드 | 의미 |
|---|---|
| `PLUGIN_MANIFEST_INVALID` | schema/layout 오류 |
| `PLUGIN_INTEGRITY_FAILED` | digest mismatch |
| `PLUGIN_SIGNATURE_INVALID` | signature 검증 실패 |
| `PLUGIN_INCOMPATIBLE` | protocol/product version 불일치 |
| `PLUGIN_PERMISSION_DENIED` | grant 없음 |
| `PLUGIN_AUTHORITY_ESCALATION` | narrowing rule 위반 |
| `PLUGIN_RUNTIME_UNAVAILABLE` | WASI/process host 미지원 |
| `PLUGIN_PROTOCOL_ERROR` | malformed message |
| `PLUGIN_TIMEOUT` | invocation timeout |
| `PLUGIN_RESOURCE_LIMIT` | memory/output/call limit |
| `PLUGIN_REENTRANCY_LIMIT` | recursion/cycle 제한 |
| `PLUGIN_CIRCUIT_OPEN` | repeated failure로 비활성 |
| `PLUGIN_STATE_CONFLICT` | CAS revision conflict |
| `PLUGIN_TOOL_SCHEMA_INVALID` | strict schema 불충족 |

## 13.27 config

```toml
[plugins]
enabled = true
allow_project_wasi = true
allow_project_stdio = false
allow_unsafe_local = false
require_signature_for_registry = true
max_active_per_workspace = 16

[plugins.limits]
before_hook_ms = 2000
after_hook_ms = 5000
aggregate_before_hook_ms = 5000
max_output_bytes = 1048576
max_state_bytes = 1048576
max_reentrancy_depth = 2
max_nested_tool_calls = 8

[plugins.failure]
critical_before = "closed"
ordinary_before = "open-with-warning"
after = "open"
circuit_failures = 3
```

project config는 unsafe/stdin/signature 정책을 완화하지 못한다.

## 13.28 TypeScript Plugin SDK

```ts
import { definePlugin } from "@capybara-code/plugin-sdk";

export default definePlugin({
  manifest,
  hooks: {
    async beforeTool(ctx) {
      if (ctx.action.toolId === "process.run" && ctx.action.network === true) {
        return {
          action: "ask",
          reason: "Networked process requires explicit review",
          riskFloor: "R3",
        };
      }
      return { action: "continue" };
    },
  },
  tools: {
    async dependencyReport(args, ctx) {
      const manifest = await ctx.workspace.read({ path: "package.json" });
      return { summary: analyze(manifest.text) };
    },
  },
});
```

SDK는 host capability가 없는 API를 compile-time type에서 숨길 수 있다.

runtime grant가 더 좁으면 runtime error를 반환한다.

## 13.29 testing SDK

```ts
import { createPluginTestHost } from "@capybara-code/plugin-sdk/testing";

const host = createPluginTestHost({
  manifest,
  grants: { workspaceRead: ["package.json"] },
  workspace: { "package.json": "{...}" },
});

const result = await host.invokeTool("dependencyReport", {});
```

테스트 host 기능:

- fake events
- fake workspace reads
- permission assertions
- hook timeout
- authority monotonicity
- golden manifest
- deterministic clock/random
- artifact inspection

## 13.30 파일 변경 목록

### 수정

```text
apps/cbc/src/extensions.ts
apps/cbc/src/bootstrap.ts
apps/cbc/src/tools.ts
packages/tool-registry/src/index.ts
packages/tool-registry/src/catalog.ts
packages/subagents/src/custom.ts
packages/context-engine/src/engine.ts
packages/protocol-ts/src/events.ts
packages/config-schema/src/schema.ts
crates/cbc-process/src/lib.rs
crates/cbc-sandbox/src/lib.rs
crates/cbc-runtime/src/server.rs
crates/cbc-session-store/src/migrations.rs
scripts/build-standalone.ts
```

### 신규

```text
packages/plugin-sdk/**
packages/plugin-protocol/** optional separate package
apps/capy-daemon/src/plugin-supervisor.ts
apps/capy-daemon/src/hook-dispatcher.ts
apps/capy-daemon/src/plugin-package.ts
crates/cbc-session-store/src/plugins.rs
schemas/plugin/**
fixtures/plugins/**
```

## 13.31 테스트 계획

### manifest/package

- valid WASI
- path traversal file
- digest mismatch
- signature mismatch
- compatibility mismatch
- permission diff
- lockfile reproducibility

### isolation

- workspace direct read attempt
- network attempt
- environment secret access
- process spawn attempt
- excessive memory/output
- infinite loop timeout

### hooks

- deterministic order
- deny
- ask escalation
- valid narrowing
- invalid widening
- critical fail-closed
- ordinary fail-open
- after hook failure
- reentrancy cycle

### tools/commands/agents

- strict schema
- risk escalation
- result redaction
- artifact spill
- agent authority clamp
- command headless behavior

### persistence

- grants restart
- state CAS
- uninstall cleanup
- update rollback
- circuit state

### security

- forged capability
- cross-plugin state access
- cross-workspace grant use
- project stdio executable injection
- malicious terminal content

## 13.32 완료 기준

- [ ] default plugin runtime에는 ambient workspace/network 권한이 없다.
- [ ] before hook은 authority를 넓히지 못한다.
- [ ] critical/ordinary/after failure policy가 구분된다.
- [ ] plugin tool도 ToolRegistry/permission/runtime을 통과한다.
- [ ] project plugin은 trusted workspace에서만 활성화된다.
- [ ] package digest와 lockfile이 검증된다.
- [ ] grant가 workspace identity에 바인딩된다.
- [ ] timeout/crash가 daemon을 crash시키지 않는다.
- [ ] TypeScript SDK와 test harness가 제공된다.
- [ ] existing Skill/MCP behavior가 회귀하지 않는다.

## 13.33 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| PLG-001 | manifest schema | versioned plugin contract |
| PLG-002 | package verifier | layout/digest/signature |
| PLG-003 | lockfile | exact install state |
| PLG-004 | permission model | request/grant/effective |
| PLG-005 | monotonicity validator | deny/narrow only |
| PLG-006 | WASI host | default isolated runtime |
| PLG-007 | stdio host | supervised user plugin |
| PLG-008 | plugin protocol | framed RPC |
| PLG-009 | PluginSupervisor | lifecycle/circuit |
| PLG-010 | HookDispatcher | order/budget/failure |
| PLG-011 | reentrancy guard | invocation ancestry |
| PLG-012 | ToolAdapter | registry/policy integration |
| PLG-013 | CommandAdapter | CLI/App command integration |
| PLG-014 | AgentAdapter | base-role clamp |
| PLG-015 | ContextProvider | ContextItem proposal |
| PLG-016 | PluginStateStore | namespaced CAS KV |
| PLG-017 | migration 12 | install/grant/invocation/state |
| PLG-018 | events/reducer | plugin lifecycle visibility |
| PLG-019 | install CLI | add/remove/update/enable |
| PLG-020 | grants UI | permission diff/approval |
| PLG-021 | TypeScript SDK | authoring API |
| PLG-022 | testing SDK | fake host/assertions |
| PLG-023 | builtin sample plugins | reference implementation |
| PLG-024 | malicious fixtures | isolation/security corpus |
| PLG-025 | performance tests | hook/tool overhead |
| PLG-026 | docs | author/security/publishing guide |

---

# 14. 개선 항목 9 — App Server + TypeScript/Python SDK

## 14.1 목표

- TUI, headless CLI, IDE, CI, SDK가 같은 client-facing protocol을 사용한다.
- daemon 내부 객체를 직접 embed하지 않아도 session을 생성·제어한다.
- event stream을 cursor 기반으로 resume한다.
- approval, cancellation, artifact, graph, memory, LSP, worktree를 typed API로 제공한다.
- protocol schema에서 TypeScript/Python client type을 생성한다.
- 내부 Rust runtime RPC와 외부 App Protocol을 분리한다.

## 14.2 가장 중요한 경계

```text
App Protocol
  - client ↔ Session Daemon
  - high-level session/turn/graph/memory operations
  - user/client identity
  - event subscriptions

Runtime Protocol
  - trusted TypeScript control plane ↔ Rust runtime
  - low-level FS/process/Git/session-store authority
  - capability receipt
  - client에 직접 노출하지 않음
```

SDK가 `fs.write`, `runtime.capability.issue` 같은 Rust RPC를 직접 호출하지 못한다.

SDK는 high-level command를 App Server에 요청한다.

## 14.3 transport

### P0

- Unix domain socket
- Windows named pipe
- stdio embedding

### P1

- loopback WebSocket, explicit opt-in
- IDE extension용 local HTTP/WebSocket bridge

### 제외

- public network listen default
- plaintext remote TCP
- browser에서 임의 daemon 접속

## 14.4 protocol 형식

JSON-RPC 2.0 기반을 권장한다.

확장 envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "session.create",
  "params": {
    "command": {
      "schemaVersion": "1.0",
      "commandId": "cmd_...",
      "idempotencyKey": "...",
      "correlationId": "...",
      "clientId": "...",
      "payload": {}
    }
  }
}
```

notification:

```json
{
  "jsonrpc": "2.0",
  "method": "events.push",
  "params": {
    "subscriptionId": "sub_...",
    "cursor": { "sessionId": "ses_...", "sequence": 120 },
    "events": []
  }
}
```

## 14.5 App handshake

```text
server.initialize
server.capabilities
server.ping
server.shutdownClient
```

initialize params:

```ts
export interface AppInitializeParams {
  protocolVersion: string;
  client: {
    id: string;
    name: string;
    version: string;
    kind: "tui" | "cli" | "ide" | "sdk" | "ci" | "plugin-host";
  };
  capabilities: {
    eventStreaming: boolean;
    eventAck: boolean;
    approvals: boolean;
    interactivePrompts: boolean;
    artifactStreaming: boolean;
    richDiff: boolean;
  };
  authentication?: {
    challengeResponse?: string;
  };
}
```

result:

```ts
export interface AppInitializeResult {
  protocolVersion: string;
  serverVersion: string;
  daemonId: string;
  connectionId: string;
  capabilities: AppServerCapabilities;
  limits: AppServerLimits;
}
```

## 14.6 method namespace

### server

```text
server.initialize
server.capabilities
server.ping
server.health
server.version
server.logs.tail
```

### workspace

```text
workspace.open
workspace.inspect
workspace.list
workspace.close
workspace.trust.get
workspace.trust.set
workspace.services
```

### session

```text
session.create
session.list
session.get
session.attach
session.detach
session.fork
session.pause
session.resume
session.close
session.archive
session.export
session.recover
```

### turn

```text
turn.submit
turn.cancel
turn.get
turn.list
turn.wait
```

### events

```text
events.subscribe
events.unsubscribe
events.replay
events.ack
events.getSnapshot
```

### approval

```text
approval.list
approval.get
approval.resolve
approval.cancel
```

### graph/task

```text
graph.get
graph.listNodes
graph.pause
graph.resume
graph.cancel
task.spawn
task.get
task.wait
task.message
task.pause
task.resume
task.revive
task.cancel
```

### memory

```text
memory.list
memory.get
memory.search
memory.propose
memory.remember
memory.forget
memory.resolveContest
memory.verify
```

### LSP

```text
lsp.status
lsp.diagnostics
lsp.definition
lsp.references
lsp.hover
lsp.rename.preview
lsp.rename.apply
lsp.codeActions
lsp.codeAction.apply
```

### edit/diff

```text
edit.preview
edit.apply
edit.getReceipt
diff.get
diff.getFile
```

### worktree/merge

```text
worktree.list
worktree.get
worktree.getProposal
worktree.discard
merge.preview
merge.apply
merge.resolve
```

### plugin

```text
plugin.list
plugin.inspect
plugin.install
plugin.update
plugin.enable
plugin.disable
plugin.grants
plugin.resolveGrant
```

### artifact

```text
artifact.getMetadata
artifact.read
artifact.stream
artifact.export
```

## 14.7 method authority

App Server method는 client capability와 session role에 따라 제한한다.

client role:

```text
observer
controller
approval_resolver
administrator-local
```

예:

- observer: query/event subscribe
- controller: turn submit/cancel/task message
- approval_resolver: approval.resolve
- administrator-local: plugin install/trust/daemon controls

SDK client가 연결됐다는 이유로 controller 권한을 자동 받지 않는다.

## 14.8 workspace.open

input:

```ts
export interface WorkspaceOpenRequest {
  path: string;
  mode: "inspect" | "interactive";
  expectedIdentityDigest?: string;
}
```

보안:

- path는 App Server에서 canonicalize
- Rust runtime workspace.inspect로 identity 확인
- trust 상태 반환
- client-supplied digest와 다르면 conflict
- remote/loopback transport에서는 server-side allowlist 필요

## 14.9 session.create

```ts
export interface SessionCreateRequest {
  workspaceHandle: string;
  title?: string;
  modelProfile?: string;
  interactionMode?: "build" | "plan";
  permissionMode?: string;
  durable?: boolean;
  clientControl?: "request" | "observe";
}
```

result:

```ts
export interface SessionHandle {
  sessionId: string;
  workspaceIdentityDigest: string;
  state: string;
  revision: number;
  eventCursor: EventCursor;
  controlLease?: InteractiveLease;
}
```

## 14.10 turn.submit

```ts
export interface TurnSubmitRequest {
  sessionId: string;
  text: string;
  attachments?: AppAttachment[];
  modeOverride?: "build" | "plan";
  modelProfileOverride?: string;
  structuredOutputSchema?: unknown;
  wait?: "none" | "accepted" | "completed";
}
```

response는 즉시 accepted receipt를 반환한다.

`wait=completed`는 SDK convenience이며 server command와 event stream은 분리한다.

## 14.11 EventCursor

```ts
export interface EventCursor {
  sessionId: string;
  journalSequence: number;
  eventId?: string;
  snapshotSequence?: number;
}
```

규칙:

- cursor는 journal sequence 기준
- ephemeral event는 cursor continuity에 포함하지 않음
- cursor가 retention boundary보다 오래되면 snapshot + tail 반환
- hash chain validation 결과를 optional metadata로 제공
- event schema version을 각 event가 유지

## 14.12 subscription

```ts
export interface EventSubscriptionRequest {
  sessionIds: string[];
  from?: Record<string, EventCursor>;
  kinds?: string[];
  visibility?: string[];
  includeEphemeral?: boolean;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
}
```

### ack

- journaled batch를 client가 ack
- daemon은 last ack cursor를 attachment table에 저장 가능
- observer가 ack하지 않아도 session execution을 막지 않음
- slow client는 replay mode로 전환

## 14.13 snapshot API

`events.getSnapshot`은 현재 SessionViewModel projection을 반환한다.

주의:

- domain internal Set/Map을 wire-safe array/object로 변환
- secret/redaction
- bounded timeline window
- earlier events cursor 제공
- graph/memory/worktree summary 포함

SDK는 snapshot + events를 reducer로 조합할 수 있다.

## 14.14 artifact 전송

작은 artifact:

- JSON-RPC response에 bounded base64 또는 UTF-8 text

큰 artifact:

- stream handle
- chunk sequence
- digest
- total bytes
- cancellation

```ts
export interface ArtifactChunk {
  streamId: string;
  sequence: number;
  dataBase64: string;
  eof: boolean;
  digest?: string;
}
```

local transport라도 path를 직접 client에 넘기지 않는다.

client export 명령만 destination을 선택한다.

## 14.15 cancellation

- JSON-RPC request cancel과 domain turn/task cancel을 구분한다.
- client가 long query를 취소해도 underlying turn은 취소되지 않는다.
- `turn.cancel` 또는 `task.cancel`만 domain cancellation이다.
- SDK AbortSignal은 method별 semantic을 문서화한다.

## 14.16 App protocol error

JSON-RPC error data:

```ts
export interface AppErrorData {
  structured: StructuredError;
  commandReceiptId?: string;
  currentRevision?: number | string;
  retryAfterMs?: number;
}
```

표준 JSON-RPC code와 domain code를 함께 사용한다.

- parse error
- invalid request
- method not found
- invalid params
- internal error
- domain error range

## 14.17 protocol versioning

### compatibility rule

- additive optional field: minor
- new method: minor
- enum 추가: 소비자 처리 규칙에 따라 minor/breaking 판단
- required field 변경: major
- semantic default가 더 permissive: breaking
- event durability 변경: breaking
- authority 확대: breaking + security review

### negotiation

- exact major match
- server가 지원 minor range 반환
- unsupported feature는 capabilities로 비활성
- SDK generated code는 unknown event/method-safe parsing

## 14.18 schema source of truth

`schemas/app`의 JSON schema를 source of truth로 한다.

생성 순서:

```text
JSON schema
  → TypeScript generated types
  → Python Pydantic/dataclass models
  → method registry
  → documentation reference
  → protocol drift tests
```

hand-written type copy를 최소화한다.

## 14.19 TypeScript SDK

### 기본 사용

```ts
import { CapybaraClient } from "@capybara-code/sdk";

const client = await CapybaraClient.connect();
const workspace = await client.workspaces.open({
  path: process.cwd(),
  mode: "interactive",
});
const session = await client.sessions.create({
  workspaceHandle: workspace.handle,
  durable: true,
});

for await (const event of session.events()) {
  console.log(event.kind, event.payload);
}
```

### turn convenience

```ts
const result = await session.run("Fix the parser bug", {
  signal,
  onApproval: async (request) => {
    return { decision: "deny", reason: "CI is read-only" };
  },
});
```

### structured output

```ts
const result = await session.runStructured(prompt, schema);
```

SDK는 structured output이 provider에서 직접 보장됐는지 host validation인지 metadata로 표시한다.

## 14.20 TypeScript SDK API

```ts
class CapybaraClient {
  static connect(options?): Promise<CapybaraClient>;
  server: ServerApi;
  workspaces: WorkspaceApi;
  sessions: SessionApi;
  plugins: PluginAdminApi;
  close(): Promise<void>;
}

class Session {
  id: string;
  submit(text, options?): Promise<TurnHandle>;
  run(text, options?): Promise<CompletionReport>;
  events(options?): AsyncIterable<CbcEvent>;
  approvals(): AsyncIterable<ApprovalRequest>;
  graph(): Promise<AgentGraphView>;
  memory: SessionMemoryApi;
  pause(): Promise<void>;
  resume(): Promise<void>;
  detach(): Promise<void>;
}
```

## 14.21 Python SDK

### 기본 사용

```python
import asyncio
from capybara_code import CapybaraClient

async def main():
    async with await CapybaraClient.connect() as client:
        workspace = await client.workspaces.open(path=".", mode="interactive")
        session = await client.sessions.create(
            workspace_handle=workspace.handle,
            durable=True,
        )
        result = await session.run("Fix the parser bug")
        print(result.summary)

asyncio.run(main())
```

### event stream

```python
async for event in session.events(from_cursor=cursor):
    print(event.kind, event.payload)
```

### approval callback

```python
async def decide(request):
    if request.network:
        return ApprovalDecision.deny("offline policy")
    return ApprovalDecision.allow_once()

result = await session.run(prompt, on_approval=decide)
```

## 14.22 Python 구현 결정

- Python 3.10+ 제안
- asyncio native
- UDS/named pipe abstraction
- Pydantic 의존 여부는 package weight 검토
- stdlib dataclass + generated validator도 가능
- sync facade는 선택
- async iterator cancellation 지원
- typed exceptions에 domain code 포함

## 14.23 SDK reconnect

SDK connection state:

```text
connected
  → reconnecting
  → connected
  → closed
```

reconnect 시:

1. daemon handshake
2. existing session attachment 복원
3. last ack cursor 전달
4. missed journaled events replay
5. pending command receipt 조회
6. approval callback 재등록

SDK가 non-idempotent command를 자동 재전송하지 않는다.

idempotency key가 있는 command만 safe retry한다.

## 14.24 TUI migration

### 단계 A

- existing embedded AgentSession 유지
- App Protocol types와 fake server 생성

### 단계 B

- daemon/App Server가 AgentSession 소유
- TUI adapter가 session methods/events 사용
- renderer/reducer는 그대로 재사용

### 단계 C

- direct runtime/session object 접근 제거
- TUI를 first-party SDK client로 전환
- embedded mode도 in-process App Server transport 사용

**[결정]** embedded mode도 동일 App Protocol을 거치게 한다.

그래야 daemon/embedded behavior가 갈라지지 않는다.

## 14.25 Headless CLI migration

현재 `capy run` 결과 file과 event tap을 App Server command로 옮긴다.

```text
capy run
  → daemon connect or embedded server
  → session.create
  → turn.submit
  → events subscribe
  → completion receipt
  → exit code mapping
```

기존 exit code contract는 유지한다.

## 14.26 IDE 고려사항

본 문서가 IDE extension 자체를 구현하지는 않지만 App Protocol은 다음을 지원해야 한다.

- editor selection semantic attachment
- open file revision
- diff preview
- hunk accept/reject command
- diagnostics stream
- approval UI
- graph tree
- worktree proposal
- context/memory inspector

UI-specific rich object는 protocol core가 아니라 capability extension으로 둔다.

## 14.27 App Server 보안

- local peer authentication
- role-based method admission
- workspace handle rather than arbitrary path 반복 전달
- trust/approval method 분리
- artifact path 비노출
- plugin admin method는 administrator-local만
- raw credential method 없음
- server logs redaction
- request payload size limit
- subscription filter limit
- structured schema complexity limit

## 14.28 App Server observability

metric:

- request latency by method
- active connections
- active subscriptions
- event queue bytes
- replay events/bytes
- command dedupe hit
- reconnect count
- protocol error count
- approval latency
- SDK version distribution local log

trace ancestry:

```text
client request ID
  → command ID
  → session/turn ID
  → graph/node/attempt
  → tool/action hash
  → transaction/edit/merge receipt
```

## 14.29 migration 13

client cursor를 restart 후 복구할 필요가 있을 때 사용한다.

```sql
CREATE TABLE app_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES app_clients(client_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  last_acked_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_event_subscriptions_session
  ON event_subscriptions(session_id, state);
```

일회성 client는 persistence를 생략할 수 있다.

## 14.30 App protocol event

App Server 자체 notification:

```text
server.notice
server.restarting
server.capability_changed
events.push
events.gap
subscription.slow
command.progress
approval.pending
artifact.chunk
```

session domain event는 기존 `CbcEvent`를 그대로 전달한다.

## 14.31 오류 코드

| 코드 | 의미 |
|---|---|
| `APP_PROTOCOL_VERSION_MISMATCH` | handshake 불일치 |
| `APP_CLIENT_UNAUTHORIZED` | local auth 실패 |
| `APP_METHOD_FORBIDDEN` | client role 부족 |
| `APP_INVALID_WORKSPACE_HANDLE` | handle 없음/만료 |
| `APP_SESSION_NOT_ATTACHED` | attachment 필요 |
| `APP_EVENT_CURSOR_TOO_OLD` | snapshot부터 재개 필요 |
| `APP_EVENT_CURSOR_INVALID` | session/sequence 불일치 |
| `APP_SUBSCRIPTION_LIMIT` | connection/session limit |
| `APP_BACKPRESSURE` | client가 너무 느림 |
| `APP_REQUEST_TOO_LARGE` | frame/payload 초과 |
| `APP_SCHEMA_TOO_COMPLEX` | structured output/schema 제한 |
| `APP_COMMAND_UNKNOWN` | receipt를 찾을 수 없음 |
| `APP_CONNECTION_CLOSED` | transport 종료 |

## 14.32 config

```toml
[app_server]
enabled = true
transport = "local"
allow_loopback_websocket = false
max_connections = 32
max_request_bytes = 8388608
max_response_bytes = 8388608
max_subscriptions_per_client = 16
max_sessions_per_subscription = 32

[app_server.events]
max_batch_events = 100
max_batch_bytes = 1048576
ack_timeout_seconds = 30
slow_client_policy = "replay"

[sdk]
reconnect = true
reconnect_max_attempts = 8
```

## 14.33 package/release

### npm

```text
@capybara-code/app-protocol
@capybara-code/sdk
@capybara-code/plugin-sdk
```

현재 monorepo private package prefix와 public naming은 release 정책에 맞게 결정한다.

### PyPI

```text
capybara-code
```

Python package는 daemon binary를 포함하지 않는다.

local installed `capy` daemon에 연결한다.

별도 embedded distribution은 후속이다.

## 14.34 파일 변경 목록

### 신규

```text
packages/app-protocol/**
packages/sdk-typescript/**
packages/sdk-python/**
apps/capy-app-server/** 또는 daemon 내부 package
schemas/app/**
schemas/sdk/**
fixtures/app-server/**
```

### 수정

```text
apps/cbc/src/main.ts
apps/cbc/src/bootstrap.ts
apps/cbc/src/commands/interactive.ts
apps/cbc/src/commands/run.ts
apps/cbc/src/tui.ts
packages/protocol-ts/src/events.ts
packages/session-domain/src/reducer.ts
packages/config-schema/src/schema.ts
scripts/check-protocol-drift.ts
scripts/build-standalone.ts
scripts/package-npm.ts
.github/workflows/release.yml
```

## 14.35 테스트 계획

### protocol

- method registry/schema drift
- version negotiation
- unknown method
- invalid params
- oversized frame
- id collision
- cancellation

### subscriptions

- snapshot + tail
- reconnect cursor
- slow client
- multiple session filter
- ephemeral coalescing
- journaled no-drop
- retention gap

### command/idempotency

- retry after timeout
- duplicate payload
- same key different payload
- command crash recovery
- receipt lookup

### authority

- observer mutation denied
- approval role
- plugin admin denied
- workspace handle isolation
- cross-session attach denied

### SDK

- TS connect/run/events/cancel/reconnect
- Python connect/run/events/cancel/reconnect
- approval callback
- structured output
- typed error mapping
- context manager/resource cleanup

### TUI/headless

- same golden reducer output over protocol
- Ctrl+C/Esc cancellation
- approval input
- exit code parity
- embedded/daemon parity

### cross-platform

- UDS
- Windows named pipe
- stdio
- path encoding
- Unicode payload

## 14.36 완료 기준

- [ ] App Protocol과 Rust Runtime Protocol이 분리돼 있다.
- [ ] TUI가 App Protocol client로 동작한다.
- [ ] embedded mode도 같은 router를 사용한다.
- [ ] cursor reconnect에서 journaled event가 유실되지 않는다.
- [ ] approval/cancel semantic이 direct mode와 동일하다.
- [ ] TypeScript SDK가 async event/turn API를 제공한다.
- [ ] Python SDK가 asyncio API를 제공한다.
- [ ] schema에서 두 SDK type이 생성된다.
- [ ] client role이 method authority를 제한한다.
- [ ] artifact path가 직접 노출되지 않는다.
- [ ] headless exit code가 기존 계약과 동일하다.

## 14.37 구현 작업 분해

| ID | 작업 | 산출물 |
|---|---|---|
| APP-001 | app protocol method registry | namespace/source of truth |
| APP-002 | handshake schema | version/capabilities/auth |
| APP-003 | command envelope | idempotency/revision |
| APP-004 | error schema | typed domain errors |
| APP-005 | local transport router | UDS/pipe/stdio |
| APP-006 | method admission | client role policy |
| APP-007 | workspace API | handles/trust/services |
| APP-008 | session API | create/attach/lifecycle |
| APP-009 | turn API | submit/wait/cancel |
| APP-010 | event subscription | snapshot/replay/live |
| APP-011 | cursor ack | reconnect/backpressure |
| APP-012 | approval API | durable resolution |
| APP-013 | graph API | node/task commands |
| APP-014 | memory API | search/write/resolve |
| APP-015 | LSP/edit API | query/preview/apply |
| APP-016 | worktree/merge API | proposal lifecycle |
| APP-017 | plugin admin API | install/grants/lifecycle |
| APP-018 | artifact streaming | chunked bounded transfer |
| APP-019 | schema generator | TS/Python models |
| APP-020 | TypeScript transport | reconnect/cancel |
| APP-021 | TypeScript high-level SDK | Client/Session/Turn |
| APP-022 | Python transport | asyncio UDS/pipe/stdio |
| APP-023 | Python high-level SDK | Client/Session/Turn |
| APP-024 | SDK approval helpers | callback/iterator |
| APP-025 | TUI adapter | first-party client |
| APP-026 | headless adapter | exit/result parity |
| APP-027 | migration 13 | persistent cursors optional |
| APP-028 | protocol conformance | server/TS/Python fixtures |
| APP-029 | reconnect/fault tests | daemon restart/network break |
| APP-030 | package publishing | npm/PyPI artifacts |
| APP-031 | docs/reference | generated method/SDK guide |

---
# 15. 통합 아키텍처

## 15.1 최종 component 관계

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Client Layer                                                                 │
│                                                                              │
│  capy TUI        capy run        IDE client       TS SDK       Python SDK    │
│      └───────────────┴──────────────┴───────────────┴──────────────┘          │
│                                      │                                       │
│                               App Protocol                                   │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Session Daemon / App Server                                                  │
│                                                                              │
│  Command Router · Idempotency · EventHub · Client/Approval/Artifact streams  │
│                                      │                                       │
│                         WorkspaceSupervisor                                  │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │ SessionActor                      │ Shared Workspace Services          │  │
│  │ ├─ AgentSession                   ├─ Durable Memory                    │  │
│  │ ├─ Persistent AgentGraph          ├─ Full LSP                         │  │
│  │ ├─ Provider session               ├─ Plugin/Hook Supervisor            │  │
│  │ ├─ Turn/approval state            ├─ Worktree Manager                  │  │
│  │ └─ Context/verification           └─ Runtime Sidecar Supervisor        │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       │ capability-bound RPC
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Rust Authority Layer                                                         │
│                                                                              │
│  cbc-runtime                                                                 │
│  ├─ FS read/fingerprint                                                      │
│  ├─ Anchor/Range edit + transaction                                          │
│  ├─ Process/sandbox                                                          │
│  ├─ Git/worktree                                                             │
│  ├─ Artifact/redaction                                                       │
│  └─ Session store                                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 15.2 책임 경계

| 책임 | App Server | Session Daemon | Domain packages | Rust Runtime |
|---|---:|---:|---:|---:|
| client protocol validation | 주 | 보조 | schema | 아니오 |
| session actor ownership | 아니오 | 주 | state model | persistence only |
| graph scheduling | 아니오 | 주 | pure reducer/scheduler | persistence/authority facts |
| model loop | 아니오 | 주 | agent kernel | 아니오 |
| context selection | 아니오 | 주 | context engine | exact read facts |
| memory policy | API only | 주 | MemoryBank/MemoryService | persistence |
| LSP orchestration | API only | 주 | lsp-domain | process supervision |
| edit plan proposal | API only | 주 | edit-domain | 최종 resolve/apply |
| filesystem mutation | 아니오 | 요청 | plan types | 최종 authority |
| plugin hook dispatch | API/admin | 주 | plugin SDK/protocol | process sandbox |
| worktree scheduling | API only | 주 | graph/worktree model | Git/path authority |
| event projection | stream | publish | reducer | journal commit |

## 15.3 공통 operation ancestry

모든 주요 동작은 다음 ancestry를 추적한다.

```text
clientId
  → connectionId
  → commandId / idempotencyKey
  → workspaceIdentityDigest
  → sessionId
  → turnId
  → graphId
  → nodeId
  → attemptId
  → callId
  → actionHash
  → capabilityReceipt
  → transactionId / editPlanId / mergeAttemptId
  → evidenceIds / artifactIds
```

어느 단계가 없는 동작은 해당 필드를 생략한다.

ancestry를 문자열 log parsing으로 재구성하지 않는다.

## 15.4 authority flow

```text
Client intent
  → App method admission
  → Session/graph state validation
  → model/plugin/LSP proposal
  → HostActionNormalizer
  → hook narrowing/veto
  → permission policy
  → user approval if required
  → capability receipt issue
  → Rust invariant revalidation
  → operation
  → runtime receipt/evidence
  → journal/store
  → client event
```

## 15.5 데이터 일관성 전략

### strong consistency가 필요한 데이터

- session event sequence
- graph revision
- node state
- memory transition
- writer lease
- worktree proposal status
- merge receipt
- command idempotency receipt
- approval resolution

### eventual consistency 허용 데이터

- TUI drawer projection
- repository map cache
- LSP symbol cache
- diagnostics UI count
- memory access count
- telemetry aggregation
- plugin health metric

### consistency rule

- source-of-truth row/event가 먼저다.
- cache/projection failure가 source transition을 rollback하지 않는다.
- 안전 판단에 cache만 사용하지 않는다.

---

# 16. 핵심 End-to-End 흐름

## 16.1 일반 Anchor edit

```text
Client/TUI
  → turn.submit("rename local variable")
  → AgentSession prompt
  → fs.read exact
  → runtime returns revisionToken + anchor token
  → model calls fs.edit
  → edit-domain validates plan
  → before.edit_plan hooks narrow/deny
  → permission evaluates R2 write
  → capability receipt
  → Rust fs.transaction.begin
  → Rust resolves anchor against current bytes
  → Rust stages post-image
  → transaction commit
  → edit.committed + transaction.committed
  → context evidence invalidated
  → LSP didChange/diagnostics
  → verification planner
  → final evidence-backed report
```

### 실패 지점

- current revision 변경: `EDIT_REVISION_MISMATCH`
- target 이동, 유일 candidate: safe rebase
- target 두 개: `EDIT_ANCHOR_AMBIGUOUS`
- hook deny: operation blocked
- transaction stage failure: rollback
- diagnostics new error: completion block

## 16.2 LSP rename

```text
Client/model
  → lsp.rename preview
  → exact current document state
  → prepareRename
  → rename request
  → WorkspaceEdit received
  → URI/path/version validation
  → UTF-16 ranges converted
  → EditPlan generated
  → edit preview returned
  → approval if required
  → base transaction commit
  → all changed docs resynced
  → diagnostics refreshed
  → old references rechecked
  → rename evidence receipt
```

### 불변식

- LSP server는 직접 write하지 않음
- partial file application 없음
- stale document version에서 적용 없음
- command-only code action 자동 실행 없음

## 16.3 memory recall

```text
SessionActor prepares turn
  → MemoryRecallPlanner receives task/path/branch/worktree
  → workspace identity filter
  → active/not-expired/fresh-evidence filter
  → ranked memory candidates
  → Context Compiler dependencies checked
  → bounded ContextItem inclusion
  → context manifest records memory IDs
  → provider request
```

### mutation 이후

```text
transaction.committed
  → changed path revisions
  → EvidenceRegistry invalidation
  → MemoryInvalidator
  → memory revalidated/superseded/contested
  → next context no longer uses stale record
```

## 16.4 daemon detach/reconnect

```text
TUI attached with cursor 100
  → turn running
  → TUI process exits
  → App connection closed
  → SessionActor remains owner
  → events 101..140 journaled
  → new TUI connects
  → session.attach(from=100)
  → snapshot optional + events 101..140
  → control lease acquired
  → current approval/task state displayed
```

## 16.5 daemon crash after transaction commit

```text
Rust transaction commit succeeds
  → DB transaction receipt exists
  → daemon dies before client event
  → new daemon startup
  → session owner epoch advances
  → startup reconciliation finds committed transaction
  → file post hashes verified
  → graph/tool attempt reconciled completed
  → missing higher-level event synthesized with reconciliation provenance
  → client reconnect receives committed state
```

동일 edit를 재실행하지 않는다.

## 16.6 persistent graph delegation

```text
root creates graph
  → explorer A and architect B nodes
  → both read-only ready
  → parallel attempts
  → results verified
  → executor C depends_on A,B
  → handoff capsules generated
  → C assigned worktree
  → implementation
  → reviewer D review_of C
  → test E verifies C
  → merge coordinator waits for required edges
  → proposal merged and base verified
  → graph completed
```

## 16.7 worktree parallel writers

```text
base clean at commit X
  → worktree A from X
  → worktree B from X
  → writer A edits src/auth/**
  → writer B edits tests/**
  → each has one writer lease
  → proposals generated
  → path overlap analysis: disjoint
  → proposal A merged to base
  → proposal B rebased against new base
  → proposal B merged
  → base tests/review
```

## 16.8 worktree conflict

```text
A and B edit same function differently
  → proposals overlap
  → MergeCoordinator builds BASE/OURS/THEIRS
  → conflict record + artifacts
  → reviewer/model proposes resolution EditPlan
  → user/root chooses
  → Edit Engine applies resolution
  → verification
```

conflict marker는 file에 임시 기록되지 않는다.

## 16.9 plugin before-tool veto

```text
model proposes process.run with network
  → action normalized
  → builtin policy hook
  → user critical plugin hook returns ask/R3
  → monotonicity validator accepts escalation
  → approval requested
  → user denies
  → process never starts
  → plugin.hook_denied + approval events
```

## 16.10 SDK retry

```text
Python SDK sends turn.submit idempotency K
  → server accepts
  → response transport breaks
  → SDK reconnects
  → retries same K and same payload
  → server returns existing command receipt
  → no duplicate turn
  → event stream resumes from cursor
```

---

# 17. 통합 Event Catalog 추가안

## 17.1 Edit

```text
edit.plan_created
edit.preview_completed
edit.operation_resolved
edit.rebased
edit.conflicted
edit.staged
edit.committed
edit.no_change
```

## 17.2 LSP

```text
lsp.server_starting
lsp.server_ready
lsp.server_degraded
lsp.server_stopped
lsp.document_opened
lsp.document_changed
lsp.document_closed
lsp.request_started
lsp.request_completed
lsp.request_failed
lsp.diagnostics_updated
lsp.workspace_edit_proposed
lsp.workspace_edit_applied
lsp.workspace_edit_rejected
```

## 17.3 Memory

```text
memory.proposed
memory.rejected
memory.created
memory.revalidated
memory.superseded
memory.contested
memory.contest_resolved
memory.invalidated
memory.recalled
memory.forgotten
memory.purged
```

## 17.4 Daemon/session ownership

```text
daemon.started
daemon.ready
daemon.degraded
daemon.shutting_down
daemon.stopped
workspace.supervisor_started
workspace.supervisor_stopped
session.owner_acquired
session.owner_lost
session.client_attached
session.client_detached
session.control_acquired
session.control_released
session.recovery_started
session.recovery_completed
session.recovery_blocked
command.accepted
command.completed
command.failed
```

## 17.5 AgentGraph

```text
graph.created
graph.updated
graph.paused
graph.resumed
graph.completed
graph.failed
graph.cancelled
graph.blocked
agent.node_created
agent.node_ready
agent.node_queued
agent.node_dispatched
agent.node_started
agent.node_waiting
agent.node_paused
agent.node_resumed
agent.node_completed
agent.node_partial
agent.node_failed
agent.node_cancelled
agent.node_blocked
agent.attempt_created
agent.attempt_interrupted
agent.attempt_reconciled
agent.message_sent
agent.message_delivered
agent.handoff_created
agent.handoff_accepted
agent.handoff_rejected
```

## 17.6 Worktree/merge

```text
worktree.create_started
worktree.created
worktree.ready
worktree.leased
worktree.dirty
worktree.proposal_created
worktree.abandoned
worktree.delete_started
worktree.deleted
worktree.recovery_required
merge.started
merge.preview_completed
merge.conflicted
merge.resolution_proposed
merge.resolution_applied
merge.committed
merge.verification_started
merge.verification_completed
merge.failed
```

## 17.7 Plugin

```text
plugin.discovered
plugin.installed
plugin.updated
plugin.enabled
plugin.disabled
plugin.grant_requested
plugin.grant_resolved
plugin.started
plugin.ready
plugin.degraded
plugin.stopped
plugin.hook_started
plugin.hook_completed
plugin.hook_failed
plugin.hook_denied
plugin.tool_registered
plugin.command_registered
plugin.agent_registered
plugin.context_proposed
plugin.circuit_opened
plugin.state_changed
```

## 17.8 App Server notifications

App Server notification은 session domain event registry와 별도 registry로 관리할 수 있다.

```text
server.notice
server.restarting
server.capability_changed
events.push
events.gap
subscription.slow
command.progress
approval.pending
artifact.chunk
```

## 17.9 event 추가 작업 규칙

각 event에 대해 반드시 정의할 것:

- payload schema
- default level
- visibility
- durability
- ancestry requirement
- reducer behavior
- replay behavior
- redaction behavior
- max payload bytes
- artifact spill policy
- backward compatibility

---

# 18. 통합 Config 제안

```toml
[experimental]
edit_engine_v2 = false
full_lsp = false
session_daemon = false
durable_memory = false
persistent_agent_graph = false
worktree_multi_agent = false
plugin_runtime = false
app_server = false

[edit]
engine = "anchor-range-v2"
max_operations_per_plan = 100
max_file_bytes = 8388608
max_anchor_text_bytes = 65536
max_anchor_candidates = 32
safe_rebase = true
preview_before_lsp_mutation = true
record_resolution_evidence = true

[edit.limits]
max_total_changed_bytes = 16777216
max_total_files = 100
max_diff_preview_lines = 300

[lsp]
enabled = true
plan_mode = "disabled"
max_open_documents_per_server = 128
max_pending_requests_per_server = 64
max_diagnostics_per_file = 1000
max_workspace_symbols = 5000
restart_limit = 3
restart_window_seconds = 300
record_query_evidence = true

[lsp.mutations]
rename = true
code_actions = true
formatting = true
preview_required = true
max_files = 100
max_changed_bytes = 16777216

[lsp.commands]
allow = []

[memory]
enabled = true
workspace_enabled = true
session_enabled = true
task_enabled = true
auto_candidates = true
require_exact_evidence_for_workspace = true
allow_session_fallback = true
max_records_per_workspace = 10000
max_value_bytes = 16384
recall_limit = 32
recall_token_budget = 4096
retention_days = 180

[memory.confidence]
workspace = 0.8
session = 0.5
task = 0.5

[memory.privacy]
store_raw_transcript = false
store_sensitive_paths = false
allow_plugin_proposals = true

[daemon]
enabled = true
autostart = true
idle_shutdown_minutes = 30
workspace_idle_minutes = 10
heartbeat_seconds = 5
owner_lease_seconds = 20
graceful_shutdown_seconds = 10
log_level = "info"

[daemon.transport]
mode = "local"
allow_tcp = false
socket_path = "auto"
max_connections = 32
max_frame_bytes = 8388608

[daemon.clients]
control_lease_seconds = 30
detach_grace_seconds = 5
max_event_queue_items = 1000
max_event_queue_bytes = 8388608

[agent_graph]
enabled = true
max_depth = 3
max_nodes = 1000
max_concurrent_nodes = 8
max_concurrent_readers = 8
max_concurrent_writers = 4
max_attempts_per_node = 3
checkpoint_events = 25
message_bytes = 65536
recovery_policy = "safe-retry"

[agent_graph.budget]
mode = "hard"
max_cost_usd = 20.0
max_tool_calls = 1000
max_wall_clock_minutes = 120

[worktrees]
enabled = true
root = "auto"
max_active = 8
max_active_writers = 4
require_clean_base = true
retention_hours = 24
runtime_per_worktree = true
lsp_per_worktree = true

[worktrees.merge]
preview_required = true
independent_review = true
verify_on_base = true
auto_merge_disjoint = true
conflict_policy = "block"

[plugins]
enabled = true
allow_project_wasi = true
allow_project_stdio = false
allow_unsafe_local = false
require_signature_for_registry = true
max_active_per_workspace = 16

[plugins.limits]
before_hook_ms = 2000
after_hook_ms = 5000
aggregate_before_hook_ms = 5000
max_output_bytes = 1048576
max_state_bytes = 1048576
max_reentrancy_depth = 2
max_nested_tool_calls = 8

[plugins.failure]
critical_before = "closed"
ordinary_before = "open-with-warning"
after = "open"
circuit_failures = 3

[app_server]
enabled = true
transport = "local"
allow_loopback_websocket = false
max_connections = 32
max_request_bytes = 8388608
max_response_bytes = 8388608
max_subscriptions_per_client = 16
max_sessions_per_subscription = 32

[app_server.events]
max_batch_events = 100
max_batch_bytes = 1048576
ack_timeout_seconds = 30
slow_client_policy = "replay"

[sdk]
reconnect = true
reconnect_max_attempts = 8
```

## 18.1 Config authority 규칙

user-only:

- daemon transport
- plugin executable/runtime policy
- unsafe plugin
- App Server TCP/WebSocket
- worktree root
- retention/privacy
- signature requirement

project가 stricter로 변경 가능:

- edit limit 감소
- safe rebase 비활성화
- LSP mutation 비활성화
- memory workspace write 비활성화
- graph depth/concurrency 감소
- worktree writer 수 감소
- plugin event/tool grant 감소

project가 변경 불가:

- executable path
- network allow
- credential grant
- daemon socket
- signature bypass
- raw transcript storage

---

# 19. 저장소 변경 Matrix

## 19.1 apps/cbc

| 파일 | 변경 |
|---|---|
| `main.ts` | daemon/App Server client bootstrap |
| `args.ts` | daemon/attach/no-daemon flags |
| `router.ts` | 신규 CLI command routing |
| `bootstrap.ts` | embedded compatibility와 daemon client 분리 |
| `agent.ts` | MemoryService/GraphService adapter |
| `runtime.ts` | edit/worktree typed RPC |
| `tools.ts` | fs.edit, LSP/plugin tool adapters |
| `normalizer.ts` | new tools의 path/action normalization |
| `lsp-host.ts` | domain/supervisor adapter로 축소 |
| `extensions.ts` | Plugin bridge 통합 |
| `subagent-bridge.ts` | persistent graph compatibility bridge |
| `slash.ts` | memory/daemon/graph/plugin commands |
| `commands/interactive.ts` | App Protocol TUI client |
| `commands/run.ts` | App Protocol headless client |
| `tui.ts` | graph/worktree/memory/plugin drawer |

## 19.2 packages

| package | 변경 |
|---|---|
| `agent-kernel` | daemon-owned lifecycle adapter, hook points |
| `context-engine` | durable evidence/memory projection, LSP diagnostics evidence |
| `session-domain` | new event projection, snapshot wire view |
| `subagents` | compatibility adapter, current role/task contracts 유지 |
| `tool-registry` | edit/LSP/memory/plugin/worktree tools |
| `protocol-ts` | domain event additions |
| `config-schema` | new top-level sections and monotonic policy |
| `skills` | plugin과 구분, optional plugin-bundled skill provenance |
| `mcp-client` | daemon supervisor ownership adapter |
| `permissions` | plugin narrowing, worktree resource, app client role |
| `evals` | new metrics/task categories |

## 19.3 Rust crates

| crate | 변경 |
|---|---|
| `cbc-patch` | Anchor/Range edit resolver/plan/preview |
| `cbc-fs` | range read/hash helper, path safety 유지 |
| `cbc-git` | safe worktree/merge primitives |
| `cbc-process` | plugin/LSP/worktree process profiles |
| `cbc-sandbox` | plugin/WASI/readonly LSP certification |
| `cbc-runtime` | edit/worktree handlers and capabilities |
| `cbc-session-store` | migrations 7–13, memory/graph/plugin/worktree/daemon stores |
| `cbc-protocol` | low-level method/capability additions |
| `cbc-artifacts` | evidence/plugin/merge artifact ownership/retention |
| `cbc-redaction` | plugin/LSP/memory payload redaction |
| `cbc-workspace` | derived worktree authority identity |

---

# 20. 구현 PR 분할 권장안

대형 기능 branch 하나로 구현하지 않는다.

각 PR은 schema와 test가 함께 있어야 한다.

## 20.1 W0 공통 기반

| PR | 내용 |
|---:|---|
| 001 | 공통 `StructuredError`, command/receipt domain type |
| 002 | event registry 확장 방식과 schema drift test |
| 003 | feature flag config skeleton |
| 004 | session-store migration test helper 개선 |
| 005 | command idempotency table와 store API |
| 006 | fault injection helper와 crash harness |

## 20.2 Anchor/Range Edit

| PR | 내용 |
|---:|---|
| 010 | `@cbc/edit-domain` types/schema/digest |
| 011 | UTF-8/UTF-16 position converter |
| 012 | TypeScript anchor resolver와 preview |
| 013 | Rust edit wire types |
| 014 | Rust range resolver |
| 015 | Rust anchor resolver |
| 016 | transaction stage integration |
| 017 | `fs.edit.preview` RPC |
| 018 | `fs.edit` RPC |
| 019 | RuntimeToolExecutor/tool catalog |
| 020 | edit events/reducer/TUI |
| 021 | migration 7/receipts |
| 022 | compatibility/benchmark/fuzz |

## 20.3 Full LSP

| PR | 내용 |
|---:|---|
| 030 | `@cbc/lsp-domain` framing/capabilities |
| 031 | DocumentStore/position encoding |
| 032 | daemon-independent LspSupervisor prototype |
| 033 | query tools definition/references/hover |
| 034 | diagnostics index/evidence |
| 035 | WorkspaceEdit adapter |
| 036 | rename preview/apply |
| 037 | code action/formatting |
| 038 | security/restart/circuit fixtures |
| 039 | LSP events/config/docs |

## 20.4 Session Daemon/App skeleton

| PR | 내용 |
|---:|---|
| 040 | daemon executable/instance lock |
| 041 | local transport/handshake |
| 042 | WorkspaceSupervisor/runtime sidecar owner |
| 043 | SessionActor/mailbox |
| 044 | EventHub/replay/backpressure |
| 045 | attachment/control lease |
| 046 | approval manager |
| 047 | migration 8/owner lease/idempotency |
| 048 | startup recovery |
| 049 | CLI daemon commands/embedded fallback |

## 20.5 Durable Memory

| PR | 내용 |
|---:|---|
| 050 | MemoryService facade |
| 051 | durable evidence registry |
| 052 | migration 9/store |
| 053 | atomic memory transition/event |
| 054 | recall planner/context projector |
| 055 | mutation/branch/worktree invalidation |
| 056 | memory tools/TUI/App methods |
| 057 | privacy/retention/security tests |

## 20.6 Persistent AgentGraph

| PR | 내용 |
|---:|---|
| 060 | graph domain/reducer |
| 061 | graph schema/migration 10 |
| 062 | GraphStore transactional commands |
| 063 | scheduler/dependencies/budget |
| 064 | attempt/worker lease/recovery |
| 065 | mailbox/handoff/checkpoint |
| 066 | pause/resume/revive/cancel |
| 067 | subagent compatibility bridge |
| 068 | TUI/App graph APIs/stress tests |

## 20.7 Worktree Multi-Agent

| PR | 내용 |
|---:|---|
| 070 | Rust worktree create/list/remove |
| 071 | worktree store/migration 11 |
| 072 | derived authority/runtime sidecar |
| 073 | graph worktree assignment/lease |
| 074 | proposal builder |
| 075 | three-way conflict analyzer |
| 076 | merge coordinator/EditPlan converter |
| 077 | base verification/cleanup recovery |
| 078 | TUI/App worktree APIs/benchmarks |

## 20.8 Hooks/Plugin SDK

| PR | 내용 |
|---:|---|
| 080 | plugin manifest/schema/lockfile |
| 081 | grants/monotonicity validator |
| 082 | plugin protocol/process host |
| 083 | WASI host |
| 084 | HookDispatcher/failure policy |
| 085 | plugin tools/commands |
| 086 | plugin agents/context provider |
| 087 | migration 12/state/circuit |
| 088 | TypeScript Plugin SDK/testing |
| 089 | install/grants UI/security fixtures |

## 20.9 App Server/SDK 마감

| PR | 내용 |
|---:|---|
| 090 | app method registry/schema |
| 091 | workspace/session/turn methods |
| 092 | subscription/cursor/ack |
| 093 | graph/memory/LSP/worktree/plugin methods |
| 094 | artifact streaming |
| 095 | TUI App client migration |
| 096 | headless App client migration |
| 097 | TypeScript SDK |
| 098 | Python SDK |
| 099 | conformance/release packaging/docs |

---

# 21. 단계별 롤아웃

## 21.1 Anchor Edit

### 단계 1: shadow preview

- 기존 patch를 실행하기 전 EditPlan으로 변환 시도
- 실제 적용은 기존 patch
- resolution 성공률만 metric
- user-visible behavior 변화 없음

### 단계 2: opt-in mutation

- `edit_engine_v2=true`
- selected benchmark/profile
- fallback to patch는 conflict가 아닌 internal unsupported일 때만

### 단계 3: default

- `fs.edit` model preferred
- `fs.apply_patch` compatibility 유지

## 21.2 Full LSP

### 단계 1

- existing symbol index 유지
- new query methods hidden/internal

### 단계 2

- model-facing query tools
- diagnostics evidence
- no mutation

### 단계 3

- rename/code action preview

### 단계 4

- mutation apply opt-in

### 단계 5

- completion diagnostics gate default

## 21.3 Durable Memory

### 단계 1: observe

- candidate 생성만
- DB write 없음
- precision 평가

### 단계 2: session/task only

- workspace memory off
- explicit inspect

### 단계 3: workspace explicit

- user/model explicit remember
- no auto workspace promotion

### 단계 4: gated auto

- exact evidence + high confidence만 자동

## 21.4 Daemon

### 단계 1

- manual `capy daemon start`
- existing TUI embedded default

### 단계 2

- opt-in daemon client
- embedded fallback

### 단계 3

- daemon autostart default
- `--no-daemon` fallback

### 단계 4

- background persistent session/graph default for explicit durable sessions

## 21.5 AgentGraph

### 단계 1

- current scheduler events를 graph table에 shadow materialize

### 단계 2

- graph query/TUI only

### 단계 3

- scheduler authority를 graph service로 전환

### 단계 4

- depth 2/3, mailbox, revive

## 21.6 Worktree

### 단계 1

- clean repo, one isolated writer

### 단계 2

- two disjoint writers

### 단계 3

- conflict resolution

### 단계 4

- dirty overlay

## 21.7 Plugin

### 단계 1

- builtin signed WASI plugins only

### 단계 2

- user-installed WASI

### 단계 3

- trusted project WASI

### 단계 4

- user stdio plugin opt-in

### unsafe local

- default off 유지

## 21.8 App Server/SDK

### 단계 1

- daemon internal TUI protocol

### 단계 2

- TypeScript SDK private alpha

### 단계 3

- Python SDK private alpha

### 단계 4

- public stable method subset

---

# 22. Rollback 전략

## 22.1 원칙

- DB migration은 forward-only다.
- 기능 rollback은 binary/config rollback이지 DB schema 삭제가 아니다.
- 신규 table을 구버전 binary가 무시할 수 있어야 한다.
- 구버전 binary가 더 최신 schema를 안전하게 읽지 못하면 startup을 중단한다.

## 22.2 기능별 rollback

### Edit Engine

- feature flag off
- model tool에서 `fs.edit` 비활성
- `fs.apply_patch` 복귀
- edit table은 보존

### Full LSP

- mutation tools off
- query-only 또는 original documentSymbol index로 downgrade
- LSP process stop

### Memory

- recall off
- write off
- DB record 보존
- context에서 제외

### Daemon

- daemon stop
- `--no-daemon` embedded mode
- active session interrupted/reconcile

### AgentGraph

- new dispatch off
- running node cancel/reconcile
- compatibility scheduler 사용 가능 범위 명시
- graph rows 보존

### Worktree

- new create off
- existing proposal export
- merge off
- cleanup만 허용

### Plugin

- all plugin disable
- process stop
- grant revoke
- state/package 보존

### App Server/SDK

- protocol method capability off
- TUI embedded transport
- SDK 명확한 version error

---

# 23. Release Gate

## 23.1 기능 정확성 gate

- edit first-apply success lower bound
- LSP rename completeness
- memory recall precision
- graph dependency correctness
- worktree merge success
- SDK conformance

## 23.2 안전 gate

절대 0이어야 하는 항목:

- unapproved destructive side effect
- outside-workspace write
- stale revision overwrite
- cross-workspace memory recall
- plugin authority widening
- same-worktree concurrent writer
- duplicate side effect after retry
- forged approval/capability acceptance
- client role bypass

## 23.3 복구 gate

- daemon kill-point matrix
- transaction response loss
- graph worker lease loss
- worktree remove crash
- plugin crash
- LSP crash
- SDK reconnect

## 23.4 성능 gate

wall-clock 절대값만으로 release를 막지 않고 ratio/counter를 사용한다.

- event replay work growth
- graph projection work growth
- memory query index use
- anchor candidate bound
- plugin hook overhead
- daemon resident memory bound
- LSP pending request bound

## 23.5 통계 gate

CBC Bench paired run에 다음 profile을 추가한다.

```text
legacy-edit vs anchor-edit
lsp-query-off vs full-lsp-query
memory-off vs durable-memory
scheduler-v1 vs persistent-graph
single-writer-base vs worktree-multi-agent
plugin-off vs representative-hooks
embedded vs daemon-app-server
```

같은 model/reasoning/budget를 유지한다.

---

# 24. 신규 Benchmark Task 제안

## 24.1 Edit precision

- shifted function anchor
- duplicate text ambiguity
- Unicode identifier range
- CRLF file
- multi-file atomic rename
- concurrent user edit
- no-change edit
- create/move/delete mixed plan

## 24.2 Full LSP

- definition across package
- references across monorepo
- rename interface implementation
- quickfix code action
- organize imports
- diagnostics regression
- server unavailable
- malicious WorkspaceEdit

## 24.3 Memory

- remember verification command
- invalidate changed config
- contested branch target
- session fallback
- restart recall
- cross-workspace isolation
- secret candidate rejection
- stale evidence rejection

## 24.4 Daemon

- detach during turn
- attach from second client
- approval after reconnect
- kill after commit
- kill during provider stream
- update restart
- slow event client

## 24.5 AgentGraph

- dependency fan-in
- optional dependency failure
- pause/resume
- message steering
- retry transient provider
- block repeated failure
- 100-node graph
- depth limit attack

## 24.6 Worktree

- disjoint parallel feature/test
- same-file conflict
- rename conflict
- base changes after proposal
- failed base verification
- cleanup crash
- derived trust revoke

## 24.7 Plugin

- deny networked process
- add read-only tool
- timeout before hook
- authority escalation attempt
- state CAS
- malicious package path
- cross-workspace grant attempt

## 24.8 App Server/SDK

- TypeScript end-to-end
- Python end-to-end
- reconnect cursor
- duplicate command
- observer mutation denial
- artifact stream cancellation
- protocol minor compatibility

---

# 25. 통합 위험 등록부

| ID | 위험 | 심각도 | 완화 |
|---|---|---:|---|
| R-001 | daemon이 단일 장애점이 됨 | 높음 | journal/recovery/embedded fallback |
| R-002 | App Protocol과 Runtime Protocol 경계 혼동 | 높음 | package/method namespace 완전 분리 |
| R-003 | anchor safe rebase가 잘못된 위치 선택 | 치명 | unique match, margin, Rust 재검증 |
| R-004 | UTF-16 range 변환 오류 | 높음 | shared converter, corpus/fuzz |
| R-005 | LSP server가 direct write | 치명 | read-only process + WorkspaceEdit adapter only |
| R-006 | LSP diagnostics가 stale인데 completion에 사용 | 높음 | revision-bound evidence |
| R-007 | memory가 오래된 instruction을 유지 | 높음 | evidence freshness/path invalidation |
| R-008 | cross-project memory contamination | 치명 | workspace identity mandatory |
| R-009 | graph state와 session journal dual-write | 높음 | same SQLite transaction/outbox |
| R-010 | crash 후 attempt 중복 실행 | 치명 | owner epoch/idempotency/reconciliation |
| R-011 | multi-writer가 같은 tree에 진입 | 치명 | per-worktree writer lease hard invariant |
| R-012 | worktree가 다른 Git repo를 가리킴 | 높음 | Git root identity verification |
| R-013 | merge가 user current edit를 덮어씀 | 치명 | base revision + Edit Engine transaction |
| R-014 | plugin이 권한을 넓힘 | 치명 | monotonicity validator |
| R-015 | plugin runtime sandbox 미지원 platform | 높음 | WASI default, stdio fail-closed/explicit unsafe |
| R-016 | hook latency가 turn을 지연 | 중간 | aggregate budget/circuit |
| R-017 | event 수 증가로 journal 비대 | 중간 | durability 분류, compaction, artifact spill |
| R-018 | SDK slow client가 daemon memory 사용 | 높음 | bounded queue/replay mode/disconnect |
| R-019 | migration 실패로 세션 접근 불가 | 높음 | backup/checksum/fail-closed/diagnostic |
| R-020 | 기능 flag 조합 폭발 | 중간 | supported profile matrix와 config validation |
| R-021 | dirty base worktree semantics 오류 | 높음 | P0 clean-only, overlay 후속 |
| R-022 | plugin package supply-chain 공격 | 높음 | digest/signature/lockfile/revocation |
| R-023 | daemon socket hijack | 치명 | UID/SID ACL, mode, challenge |
| R-024 | raw transcript가 memory/plugin에 노출 | 높음 | typed bounded event payload, no raw default |
| R-025 | graph max depth 확대가 runaway cost 유발 | 높음 | hard node/depth/budget/concurrency limits |

---

# 26. 금지할 구현 패턴

## 26.1 Edit

- TypeScript에서 resolved range를 신뢰하고 Rust 재검증 생략
- stale revision이면 가장 가까운 문자열을 무조건 선택
- LSP edit를 `fs.write` complete replacement로 바로 적용
- preview 후 revision 재검증 없이 commit

## 26.2 LSP

- language server를 Bun에서 직접 spawn
- environment secret 상속
- `workspace/applyEdit` 자동 수락
- command title로 risk 결정
- diagnostics를 revision 없이 저장

## 26.3 Memory

- final answer text를 그대로 workspace memory로 저장
- evidence ID 없이 confidence만으로 수락
- 다른 branch/worktree memory 자동 승격
- contested memory 중 하나를 조용히 선택

## 26.4 Daemon

- PID file만으로 instance 진위 판단
- client disconnect를 turn cancel로 처리
- event queue를 무제한 유지
- daemon이 Rust path/trust check를 대체

## 26.5 AgentGraph

- Promise/AbortController를 persisted state에 넣음
- node retry가 previous attempt를 덮어씀
- graph cycle을 runtime에서 발견할 때까지 허용
- child transcript를 dependency context로 전달

## 26.6 Worktree

- model에게 raw worktree path/command 제공
- base trust를 filesystem identity 검사 없이 상속
- conflict marker를 base에 write 후 모델에게 해결 요청
- worktree test passed를 base verification으로 간주

## 26.7 Plugin

- plugin code를 TUI process에서 `import()`
- manifest requested permission을 grant로 간주
- before hook이 allow를 생성
- project plugin이 stdio executable 지정
- plugin state에 secret 저장

## 26.8 App Server

- SDK에 runtime capability issue 노출
- artifact host path 반환
- reconnect 시 non-idempotent mutation 자동 재전송
- observer가 approval/turn mutation 가능

---

# 27. 통합 Definition of Done

## 27.1 Architecture

- [ ] App Protocol과 Runtime Protocol package가 분리된다.
- [ ] daemon이 production session owner다.
- [ ] Rust runtime이 filesystem/process/Git 최종 authority다.
- [ ] 모든 신규 mutable aggregate가 revision/idempotency를 가진다.
- [ ] workspace identity가 memory/graph/worktree/plugin grant에 바인딩된다.

## 27.2 Edit/LSP

- [ ] Anchor/Range Edit Engine이 production default 후보가 된다.
- [ ] safe rebase는 유일 후보에서만 동작한다.
- [ ] Full LSP query와 diagnostics가 동작한다.
- [ ] rename/code action/formatting은 Edit Engine을 사용한다.
- [ ] diagnostics regression이 completion gate에 연결된다.

## 27.3 Memory

- [ ] MemoryBank가 production session에서 복원·저장된다.
- [ ] durable evidence resolver가 있다.
- [ ] context manifest에 memory provenance가 나타난다.
- [ ] path/branch/worktree invalidation이 동작한다.
- [ ] secret/cross-workspace test가 0건이다.

## 27.4 Daemon/Graph

- [ ] detach/reconnect가 동작한다.
- [ ] daemon crash 후 session/graph가 reconcile된다.
- [ ] graph node/attempt/message/checkpoint가 durable하다.
- [ ] cancellation과 stop-waiting이 구분된다.
- [ ] budget/depth/node limit이 hard gate다.

## 27.5 Worktree

- [ ] clean repo에서 parallel writer가 동작한다.
- [ ] per-worktree one-writer invariant가 증명된다.
- [ ] proposal과 merge receipt가 evidence-backed다.
- [ ] conflict가 base file을 오염시키지 않는다.
- [ ] base verification이 필수다.

## 27.6 Plugin

- [ ] default runtime은 no ambient authority다.
- [ ] grant는 workspace-bound다.
- [ ] hook는 deny/narrow/ask만 가능하다.
- [ ] package integrity/lock/signature policy가 있다.
- [ ] SDK와 malicious fixture가 제공된다.

## 27.7 App Server/SDK

- [ ] TUI가 first-party protocol client다.
- [ ] TypeScript SDK가 publish 가능하다.
- [ ] Python SDK가 publish 가능하다.
- [ ] cursor reconnect와 idempotent retry가 동작한다.
- [ ] method authority와 local peer auth가 강제된다.

## 27.8 Quality

- [ ] typecheck/Bun tests/Rust tests/build 통과
- [ ] schema drift/checksum 통과
- [ ] real runtime integration 통과
- [ ] crash matrix 통과
- [ ] security fixtures 통과
- [ ] CBC Bench paired gate 통과
- [ ] release artifact smoke test 통과
- [ ] 문서·migration guide·SDK reference 완료

---

# 부록 A. 권장 신규 Tool 목록

## A.1 Edit

```text
fs.edit
```

optional internal/discovery:

```text
edit.preview
edit.receipt
```

## A.2 LSP

```text
lsp.symbols
lsp.workspace_symbols
lsp.definition
lsp.declaration
lsp.type_definition
lsp.implementation
lsp.references
lsp.hover
lsp.signature_help
lsp.diagnostics
lsp.call_hierarchy
lsp.rename
lsp.code_actions
lsp.apply_code_action
lsp.format
```

## A.3 Memory

```text
memory.search
memory.get
memory.remember
memory.forget
memory.resolve
memory.verify
```

## A.4 Graph

```text
task.wait
task.message
task.pause
task.resume
task.revive
task.inspect
task.collect
```

기존 유지:

```text
task.search
task.spawn
task.status
task.cancel
```

## A.5 Worktree/Merge

```text
worktree.search
worktree.inspect
worktree.propose
worktree.discard
merge.preview
merge.apply
merge.resolve
```

## A.6 Plugin

plugin tool은 namespace를 사용한다.

```text
plugin.<plugin-id>.<tool-name>
```

---

# 부록 B. 권장 Runtime RPC 추가

```text
fs.edit.preview
fs.edit
worktree.create
worktree.inspect
worktree.list
worktree.status
worktree.diff
worktree.remove
worktree.reconcile
```

선택:

```text
session.memory.*
session.graph.*
```

다만 memory/graph high-level operation은 daemon store service가 직접 SQLite library를 사용하는 편이 낫다.

Rust runtime RPC에 agent scheduling semantics를 넣지 않는다.

---

# 부록 C. 주요 상태 머신 요약

## C.1 SessionActor

```text
loading
  → idle
  → running
  → waiting_approval
  → running
  → idle

idle/running/waiting_approval
  → paused
  → idle/recovering

any non-terminal
  → recovering
  → idle/paused/failed

idle/paused
  → closed
```

## C.2 Graph node

```text
created
  → queued
  → waiting_dependency | waiting_budget | dispatching
  → running
  → waiting_approval | waiting_message | paused
  → running
  → completed | partial | failed | cancelled | blocked

running after crash
  → reconciling
  → queued | completed | partial | failed | blocked
```

## C.3 Worktree

```text
creating
  → ready
  → leased
  → dirty
  → proposal_ready
  → merging
  → merged | conflicted
  → deleting
  → deleted

any active
  → recovery_required
```

## C.4 Plugin

```text
discovered
  → verified
  → enabled
  → starting
  → ready
  → degraded
  → circuit_open
  → disabled/stopped
```

---

# 부록 D. App Server 최소 Public Stable Surface

첫 public SDK에서는 모든 내부 기능을 공개하지 않는다.

## D.1 stable 후보

```text
server.initialize
server.capabilities
workspace.open
workspace.inspect
session.create
session.list
session.get
session.attach
session.detach
turn.submit
turn.cancel
turn.wait
events.subscribe
events.replay
events.ack
approval.list
approval.resolve
graph.get
task.get
task.wait
task.message
artifact.getMetadata
artifact.read
```

## D.2 experimental 후보

```text
memory.*
lsp.rename.*
lsp.codeAction.*
worktree.*
merge.*
plugin.install/update/grants
edit.apply direct client method
```

## D.3 internal-only

```text
runtime.capability.issue
fs.transaction.*
credential.*
raw process supervisor
session store mutation
owner epoch mutation
```

---

# 부록 E. 통합 테스트 시나리오 체크리스트

## E.1 Edit

- [ ] exact anchor same revision
- [ ] exact anchor shifted revision
- [ ] ambiguous duplicate
- [ ] target changed
- [ ] UTF-8 Korean identifier
- [ ] UTF-16 emoji position
- [ ] CRLF preservation
- [ ] multi-file rollback
- [ ] concurrent user edit
- [ ] preview digest mismatch

## E.2 LSP

- [ ] TypeScript definition/references
- [ ] Python diagnostics
- [ ] Rust symbols
- [ ] rename multi-file
- [ ] code action edit
- [ ] command-only denial
- [ ] invalid range
- [ ] malformed frame
- [ ] server crash/restart
- [ ] worktree isolation

## E.3 Memory

- [ ] exact workspace fact
- [ ] session fallback
- [ ] task memory
- [ ] contest
- [ ] resolve contest
- [ ] expiry
- [ ] path invalidation
- [ ] branch filter
- [ ] restart
- [ ] secret reject
- [ ] cross-workspace reject

## E.4 Daemon

- [ ] autostart
- [ ] stale lock
- [ ] attach/detach
- [ ] two observers
- [ ] control lease
- [ ] pending approval
- [ ] event replay
- [ ] slow client
- [ ] kill/recover
- [ ] graceful update
- [ ] embedded fallback

## E.5 Graph

- [ ] dependency fan-out/fan-in
- [ ] cycle reject
- [ ] depth reject
- [ ] budget wait
- [ ] transient retry
- [ ] repeated failure block
- [ ] pause/resume
- [ ] revive
- [ ] message
- [ ] cancel node
- [ ] cancel graph
- [ ] restart reconcile

## E.6 Worktree

- [ ] clean create
- [ ] dirty reject
- [ ] path identity
- [ ] parallel writers
- [ ] out-of-scope proposal
- [ ] disjoint merge
- [ ] content conflict
- [ ] base changed
- [ ] verification fail
- [ ] cleanup/recovery

## E.7 Plugin

- [ ] manifest verify
- [ ] signature fail
- [ ] hook order
- [ ] deny
- [ ] narrow
- [ ] widening reject
- [ ] timeout
- [ ] crash
- [ ] tool schema
- [ ] state CAS
- [ ] cross-workspace grant reject

## E.8 App Server/SDK

- [ ] handshake
- [ ] role admission
- [ ] session lifecycle
- [ ] turn lifecycle
- [ ] cursor resume
- [ ] idempotent retry
- [ ] approval callback
- [ ] artifact chunks
- [ ] TS SDK
- [ ] Python SDK
- [ ] protocol minor compatibility

---

# 부록 F. 구현 검토 질문

각 PR reviewer는 다음 질문에 답해야 한다.

## F.1 권한

- 이 코드가 Rust runtime을 우회하는가?
- 새로운 path/network/credential authority를 추가하는가?
- project/plugin/child가 user policy를 완화할 수 있는가?
- capability receipt가 exact operation/resource에 바인딩되는가?

## F.2 durability

- state change가 event와 DB에 원자적으로 기록되는가?
- crash 직후 replay 가능한가?
- duplicate command가 side effect를 반복하는가?
- owner epoch가 stale worker를 막는가?

## F.3 evidence

- 성공 claim은 어떤 runtime fact로 검증되는가?
- stale evidence를 사용할 수 있는가?
- revision/workspace/worktree binding이 있는가?
- raw untrusted text를 fact처럼 저장하는가?

## F.4 bounds

- input/frame/output/item/time/concurrency limit이 있는가?
- 큰 payload가 artifact로 spill되는가?
- slow client/plugin/server가 전체 daemon을 막는가?

## F.5 compatibility

- feature flag off에서 current behavior가 유지되는가?
- old session/event/config를 읽을 수 있는가?
- schema changelog와 drift test가 있는가?
- rollback 경로가 있는가?

---

# 부록 G. 최종 권장 우선순위

## G.1 반드시 먼저

1. 공통 command/idempotency/error/event contract
2. Anchor/Range Edit Engine
3. Full LSP query + diagnostics
4. Session Daemon 최소 구조
5. Durable Memory production wiring

## G.2 그 다음

6. Persistent AgentGraph
7. Worktree Multi-Agent
8. Full LSP mutation
9. Hooks + WASI Plugin SDK

## G.3 public ecosystem 전에

10. TUI App Protocol migration
11. TypeScript SDK
12. Python SDK
13. Plugin signing/lock/grant UX
14. 통합 crash/security/release gate

## G.4 가장 중요한 제품 판단

- Edit Engine이 안정되기 전 LSP mutation을 공개하지 않는다.
- Daemon이 안정되기 전 persistent graph를 default로 하지 않는다.
- Persistent graph가 안정되기 전 multi-worktree writer를 default로 하지 않는다.
- Plugin isolation이 증명되기 전 project executable plugin을 허용하지 않는다.
- TUI가 App Protocol을 실제로 사용하기 전 SDK를 stable로 선언하지 않는다.

---

# 결론

본 수정은 8개의 독립 기능 추가가 아니다.

하나의 실행 모델 전환이다.

```text
foreground CLI agent
  → local durable agent runtime
```

이 전환에서 유지해야 하는 Capybara의 핵심 자산은 다음이다.

- Rust runtime의 최종 권한 검증
- optimistic revision과 transaction
- event journal과 deterministic replay
- evidence-backed context
- child claim verification
- explicit approval와 trust
- bounded I/O와 fail-closed 정책

새 기능은 이 기반을 대체하지 않는다.

새 기능은 이 기반을 확장한다.

최종 제품은 다음 성질을 가져야 한다.

1. 모델은 작은 편집을 정확히 제안한다.
2. LSP는 semantic intelligence를 제공하되 직접 쓰지 않는다.
3. 기억은 증거와 수명을 가진다.
4. 세션은 UI보다 오래 살아남는다.
5. agent graph는 중단 후에도 복구된다.
6. writer는 worktree로 격리된다.
7. plugin은 확장 가능하지만 ambient authority가 없다.
8. 모든 client는 하나의 typed App Protocol을 사용한다.
9. 모든 side effect는 receipt와 evidence를 남긴다.
10. crash, retry, reconnect가 같은 일을 두 번 실행하지 않는다.

이 기준을 만족할 때 Capybara Code는 단순한 터미널 코딩 에이전트가 아니라,
검증 가능하고 복구 가능한 로컬 자율 코딩 런타임으로 진화한다.
