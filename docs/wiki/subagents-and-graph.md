# 서브에이전트와 AgentGraph

## 근본 아이디어

**서브에이전트는 프로바이더 기능이 아니라 같은 `AgentKernel`이 다른 역할·컨텍스트·권한 범위·예산으로 실행되는 것입니다** (`packages/subagents/src/roles.ts:1-8`).

이 결정의 결과로, 한 역할을 다른 역할과 구별하는 모든 것이 **코드가 아니라 데이터**에 있습니다. 그래서 `ROLE_DEFINITIONS` 한 테이블이 7개 역할 전체를 정의합니다.

## 7개 내장 역할

`roles.ts:62-283`. `root`는 부모이며 절대 spawn되지 않습니다 (`SubagentRole = Exclude<AgentRole, "root">`).

| 역할 | 권한 등급 | 모델 프로필 | 도구 예산 | 소프트 컨텍스트 | 쓰기 | 프로세스 | 명시 계약 필수 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `explore` | read | `fast` | 12 | 32,000 | ✗ | ✗ | ✗ |
| `planner` | read | `balanced` | 10 | 48,000 | ✗ | ✗ | ✗ |
| `architect` | read | `review` | 20 | 64,000 | ✗ | ✗ | ✗ |
| `executor` | write | `balanced` | 24 | 48,000 | ✓ | ✓ | **✓** |
| `refactorer` | write | `balanced` | 24 | 56,000 | ✓ | ✓ | **✓** |
| `reviewer` | read | `review` | 16 | 64,000 | ✗ | ✗ | ✗ |
| `test` | process | `fast` | 16 | 24,000 | ✗ | ✓ | ✗ |

공통 기본값: `DEFAULT_CHILD_MODEL_CALLS = 8`, `DEFAULT_CHILD_DURATION_MS = 5분`.

소프트 컨텍스트 예산은 `@cbc/inference-domain`의 `SOFT_CONTEXT_BUDGETS`에서 옵니다 (`inference-domain/src/model.ts:27-40`). `root`는 96,000입니다. **상태 바의 퍼센트는 모델 윈도우가 아니라 이 값 대비입니다.**

### 역할별 프롬프트의 공통 규율

각 역할의 `instructions`에 반복되는 세 가지 원칙이 있습니다.

1. **증거 인용.** explore: "모든 주장에 대해 읽은 파일과 줄 범위를 인용하라." architect: "'이건 auth 계층을 건드린다'는 발견이 아니다. 'src/auth/session.ts:88-140의 이 네 호출 지점이 옛 시그니처를 가정한다'가 발견이다."
2. **없는 것을 발명하지 않기.** explore: "찾지 못했으면 추측하지 말고 그렇게 말하라 — 부모가 보고에 따라 행동하므로 자신 있게 틀린 답이 정직한 공백보다 나쁘다."
3. **과장하지 않기.** reviewer: "변경이 옳아 보이면 그렇게 말하라 — 철저해 보이려고 발견을 제조하는 리뷰는 없는 것보다 나쁘다." architect도 같은 취지: "변경이 국소적이면 분명히 말하라. 철저해 보이려 아키텍처적 우려를 제조하면 executor의 예산을 애초에 필요 없던 작업에 낭비한다."

`refactorer`에게는 추가 계약이 있습니다: **동작은 변하지 않아야 합니다.** 리팩터 중 버그를 찾으면 같은 패스에서 고치지 말고 보고해야 합니다 — "리팩터 안에 숨은 동작 수정은 리뷰에 보이지 않습니다."

`reviewer`는 **의도적으로 변경이 어떻게 추론되었는지 듣지 못합니다** (`§11.9`) — diff 자체만으로 판단합니다.

## 하드 한계

`SUBAGENT_LIMITS` (`roles.ts:286-296`):

| 한계 | 값 | 의미 |
| --- | --- | --- |
| `maxConcurrent` | 8 | 프로바이더 병렬성만. 초과 등록 자식은 FIFO 대기 |
| `maxDepth` | 3 | 절대 실험적 상한. 안정 설정 기본은 2 |
| `maxWriterAgents` | 1 | **정확히 하나의 writer** |
| `aggregateContextFraction` | 0.5 | 컨텍스트 텔레메트리용 집계 목표 (승인 기준 아님) |

`DEFAULT_SUBAGENT_MAX_DEPTH = 2`.

컨텍스트 예약 (`SUBAGENT_CONTEXT_RESERVATIONS`)은 보수적 p75 추정치이며 **per-child 상한이 아닙니다** — 실제 프로바이더 사용량이 완료 시 정산합니다.

| 역할 | 예약 |
| --- | --- |
| `explore` | 8,000 |
| `planner`, `test` | 12,000 |
| `architect`, `executor`, `refactorer`, `reviewer` | 20,000 |

`contextReservationForRole(role, parentContextTokens)`가 세 값의 최솟값을 취합니다: 역할의 `softContextTokens`, 예약값, `parentContextTokens × 0.5`.

## 태스크 검증 (SUB-002)

`validateTask(task, role)` (`task.ts:90`). 읽기 전용 역할은 더 가벼운 기준을 적용받습니다 — 워크스페이스를 손상시킬 수 없으므로 explorer에게 완전한 검증 계약을 요구하는 것은 형식주의입니다.

공통 규칙:

- `title`이 비면 오류 (타임라인 카드에 필요)
- `goal`이 비면 오류, `MIN_GOAL_LENGTH = 20`자 미만이면 오류
- `deadlineMs <= 0` 또는 역할의 `maxDurationMs` 초과면 오류

`requiresExplicitContract`인 역할(`executor`, `refactorer`)에 추가:

- `constraints`가 비면 거부
- `expectedOutput`이 비면 거부

### 너무 넓은 목표 거부

`isTooBroad(goal)` (`task.ts:75`)가 6개 패턴을 검사합니다.

```
fix the repo|repository|project|codebase|everything|it|bugs
make|get it work
clean up the code|repo|everything
improve the code|codebase|quality|everything
refactor the repo|codebase|everything
do it|the work|whatever
```

**정규화가 먼저입니다** — 후행 구두점 제거 + 내부 공백 축약. 그래서 `"Fix the repo........."`는 `"Fix the repo"`와 같은 지시로 취급되고, 패딩으로 애매한 브리프를 통과시킬 수 없습니다 (`:69-73`).

## 태스크 계약 렌더링

`renderTaskContract(task, {upstream})` (`task.ts:413`)가 자식에게 주는 마크다운을 만듭니다. 섹션 순서: `# Goal` → `# Context` → `# Upstream results` → `# Constraints` → `# Contract` → `# Write scope` → `# Forbidden` → `# Verification`.

**상류 결과에는 경고문이 붙습니다:**

> "These are reports from tasks that ran before yours. They are claims, not verified facts — confirm anything you depend on before you build on it."

각 상류 결과는 역할·제목·상태, 요약, 변경 파일, 증거, 열린 위험, 권고 다음 단계를 담습니다.

## 스케줄러

`SubagentScheduler` (`scheduler.ts:167`)는 **프로바이더와 대화하지 않습니다.** 자식이 실행될 수 있는지, 어떤 권한으로, 끝났을 때 무슨 일이 일어나는지만 결정합니다 — 그래서 모든 인수 기준이 네트워크 없이 테스트됩니다 (`:160-166`).

### 스케줄러가 책임지는 인수 기준

`scheduler.ts:1-17`에 명시:

| 기준 | 내용 |
| --- | --- |
| SUB-002 | goal/constraints/contract 없으면 spawn 불가 |
| SUB-003 | 두 writer가 겹치는 경로를 절대 동시 보유 불가 |
| SUB-004 | 자식의 원시 전사가 부모 컨텍스트에 절대 병합되지 않음 |
| SUB-005 | 루트 인터럽트가 250 ms 내에 자식 취소를 보여줌 |
| SUB-007 | depth 1을 넘는 중첩 spawn 거부 |
| AC-21 | `Esc`는 **대기**를 멈춤. 자식은 계속 실행 |
| AC-22 | 명시적 취소는 모델 요청·프로세스·트랜잭션을 함께 해체 |

**§6.11이 이 모듈이 인코딩하는 선을 긋습니다: "대기 중지"와 "태스크 취소"는 다른 연산이며, 이를 혼동하는 것이 작업이 조용히 사라지는 방식입니다.**

### Spawn 거부 코드 9종

`SpawnRejectionCode` (`scheduler.ts:97`):

`INVALID_TASK`, `DEPTH_EXCEEDED`, `WRITER_BUSY`, `LEASE_OVERLAP`, `UNKNOWN_DEPENDENCY`, `AUTHORITY_WIDENING`, `BUDGET_EXCEEDED`, `NODE_LIMIT`, `FANOUT_LIMIT`.

`SpawnRejected` 예외가 `code`와 `issues[]`를 함께 실어 왜 거부되었는지 구조적으로 전달합니다.

### Writer 리스

writer는 `baseline: readonly PathBaseline[]`(경로 + 해시)이 **필수**입니다 (`scheduler.ts:76-91`). 겹침 검사는 `overlappingGlobs`(`@cbc/tool-registry`에서 재export, `:1039`)로 하고, 리스 관리는 `createLease` / `leaseExpired` / `reconcileLease`입니다.

`writerPartition(task)`가 writer 격리 키를 정합니다. 기본 `base`가 스케줄러당 writer 하나를 보존합니다.

### 권한 상한 전파

`permissionCeiling?: AgentPermissionScope` — "부모의 권한 상한. 중첩 스케줄러는 좁힐 수만 있습니다" (`:143-144`). `AUTHORITY_WIDENING` 거부 코드가 이를 강제합니다.

`AgentPermissionScope` (`instance.ts:39-49`):

```ts
{ canWrite, canRunProcess, allowedPaths, forbiddenPaths, mayRequestApproval }
```

`mayRequestApproval`의 이유가 주석에 있습니다 — §15.2 Explore는 "제한된 읽기 외에는 사용자 승인 요청 없음"이며, **묻을 수 없는 자식은 부모를 보고 있는 사람을 기다리며 멈출 수 없습니다** (`:44-48`).

## 에이전트 상태

`AgentState` 7종 (`instance.ts:19-26`): `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `blocked`.

`TERMINAL_AGENT_STATES`: `completed`, `failed`, `cancelled`, `blocked`.

**`waiting`과 `blocked`는 의도적으로 다릅니다** (`:12-17`): `waiting`은 자식이 살아 있고 무언가에 의존한다는 뜻이고, `blocked`는 진행할 수 없었다는 **종단** 결과입니다 — 타임아웃이나 리스 충돌에 쓰이므로 부모가 조용한 멈춤 대신 구조화된 답을 받습니다.

## 부모 종합 (SUB-006)

`synthesis.ts`가 §15.11을 구현합니다: **"Root는 child result를 신뢰 가능한 사실로 바로 취급하지 않는다."**

이유가 명시적입니다 (`:8-11`): **자식은 언어 모델입니다. 실행하지 않은 통과 테스트를 보고할 수 있습니다.** AC-50이 최종 답변에서 그 주장을 반복하는 것을 금지하므로, 검사는 주장이 리포트에 도달하기 **전에** 일어나야 합니다.

검증 대상 (`RuntimeEvidence`):

- `fileHashes`: 워크스페이스 상대 경로 → 런타임이 변경 후 기록한 해시 (트랜잭션 로그)
- `commandExits`: 명령 표시 → 프로세스 슈퍼바이저가 관찰한 종료 코드 (프로세스 이벤트)
- `artifactIds`: 아티팩트 저장소가 실제로 보유한 id

`ClaimStatus` 3종:

| 상태 | 의미 |
| --- | --- |
| `verified` | 런타임 기록과 일치 |
| `unverified` | 런타임에 기록이 **없음** — 증거가 불완전할 수 있음 (읽기 전용 자식은 정당하게 아무것도 안 바꿈) |
| `contradicted` | 런타임이 **불일치** — 부모의 위험 목록에 들어감 |

`SynthesisResult.trustworthy`는 모든 주장이 확인될 때만 true입니다.

## AgentGraph — 순수 도메인

`packages/agent-graph-domain`은 I/O도 런타임 핸들도 없는 순수 리듀서입니다 (780줄).

상수 (`types.ts:3-5`): `GRAPH_SCHEMA_VERSION = "1.0"`, `MAX_GRAPH_NODES = 10_000`, `MAX_GRAPH_DEPTH = 3`.

브랜드 id 타입: `GraphId = \`grf_${string}\``, `NodeId = \`agt_${string}\``, `AttemptId = \`att_${string}\``, `EdgeId = \`edg_${string}\``.

### 상태

- `GraphLifecycle`: `active` | `paused` | `completed` | `failed` | `cancelled` | `blocked`
- `NodeState` 10종: `queued`, `ready`, `running`, `waiting`, `paused`, `completed`, `partial`, `failed`, `cancelled`, `blocked`
- `AttemptState`: `created` | `running` | `completed` | `failed` | `cancelled` | `interrupted`
- `EdgeKind`: `depends_on` | `review_of` | `verifies`

노드는 `pausedFrom?: NodeState`를 지녀 재개 시 원래 상태로 돌아갑니다.

### 낙관적 동시성

모든 명령이 `expectedRevision`을 실어야 하고, 불일치 시 예외가 아니라 **`revision_conflict` 이벤트**를 반환합니다 (`reducer.ts:42-52`). 종단 그래프에 `close_graph` 외 명령이 오면 `GRAPH_TERMINAL` 오류입니다.

### 사이클 감지

`cycle.ts`가 DFS + 재귀 스택으로 O(N+E)이며 `MAX_GRAPH_NODES`로 유계입니다. **세 개의 간선 종류 모두가 DAG에 참여합니다** (`DAG_KINDS = {depends_on, review_of, verifies}`). 자기 간선(`from === to`)은 즉시 사이클입니다.

간선 의미: `from → to`는 "`to`가 `from`의 완료를 먼저 기다린다"입니다 (`cycle.ts:18`).

### 시도 예산

`maxAttempts` 기본 3 (`reducer.ts:114`, `:175`). `reviveNode` (`:327`)가 `attemptCount >= maxAttempts`면 `GRAPH_ATTEMPT_BUDGET`으로 거부합니다.

## 그래프 권한 계층

`GraphAuthority` (`graph-authority.ts:43`)가 리듀서를 인프로세스 스케줄러 위에 올립니다.

**리듀서가 노드 신원·depth·종단 상태의 단일 진실입니다. 스케줄러는 여전히 자식을 실행하지만, 그래프가 승인하지 않은 노드를 발명할 수 없습니다** (`:1-8`).

워크스페이스 신원 검사: 스냅샷의 `workspaceIdentityDigest`가 세션과 다르면 생성자가 throw합니다 (`:68-70`) — 다른 워크스페이스의 그래프를 복원할 수 없습니다.

노드 id 정규화: `agt_` 접두사가 없으면 붙입니다 (`nodeId()`, `:35-37`).

## 그래프 영속화

`graph-store.ts`가 스냅샷 포트를 정의합니다. **리듀서는 순수하게 유지되고 영속화는 호스트 주입 사이드카**이므로 테스트는 메모리로 왕복하고 프로덕션은 데몬이 크래시 후 복원할 수 있는 JSON 스냅샷을 씁니다 (`:1-6`).

`GRAPH_SNAPSHOT_SCHEMA_VERSION = "1.0"`, `MAX_GRAPH_MAILBOX = 10_000`.

**중요한 계층 경계** (`:7-10`): 내구성 있는 메일박스, 체크포인트, 예산 예약은 `cbc-session-store`의 `agent_messages`, `agent_checkpoints`, `agent_budget_reservations` 테이블이 소유합니다. **이 패키지는 SQLite와 대화해서는 안 됩니다.**

`GraphSnapshotStore`의 선택적 사이드카: `persistDurable(graphId, snapshotJson, at)` / `loadDurable(graphId)` — SessionStore를 감싸는 호스트가 이 패키지가 SQLite를 열지 않고도 그래프 루트 체크포인트에 JSON을 영속화할 수 있게 합니다.

메일박스 메시지: `{id, from, to, kind, body, createdAt, deliveredAt?, acknowledgedAt?}`.

## 그래프 예산 원장

`GraphBudgetLedger` (`budget-ledger.ts:41`)가 5개 자원을 추적합니다.

```ts
{ toolCalls, modelCalls, wallClockMs, contextTokens, costUsd }
```

3단계 상태: `reserved` → `settled` | `released`.

`reserve()` 검사 순서:

1. 같은 `nodeId`의 예약이 이미 있으면 오류
2. `parentCeiling`이 주어지면 **모든** 자원이 부모 상한 이내여야 함 (초과 시 `GraphBudgetExceeded(resource)`)
3. `consumed + 기존예약 + 신규금액 > limit`이면 `GraphBudgetExceeded(resource)`

`settle(nodeId, actual?)`가 실제 사용량으로 정산합니다 — 미지정 필드는 예약값을 씁니다.

## 위임 코디네이터

`DelegationCoordinator` (`delegation-coordinator.ts`)가 스케줄러 + 그래프 권한 + 예산 원장을 하나로 묶습니다.

`DelegationCoordinatorLimits`: `maxDepth`, `maxChildrenPerNode`, `maxNodesPerTurn`, `maxWriterNodes`, `messageBytes`.

중첩 스케줄러는 `graph`, `parentDepth`, `parentAgentId`, `maxDepth`, `newAgentId`, `permissionCeiling`을 코디네이터가 주입받으므로 (`SchedulerBaseOptions`가 이들을 `Omit`) 호출자가 우회할 수 없습니다.

## 커스텀 에이전트

`custom.ts`가 `*.md` 정의를 파싱합니다. 위치:

```
~/.config/capybara-code/agents/*.md
.capybara/agents/*.md
```

**보안 규칙** (`:11-15`): §15.13의 마지막 문장 — "Project agents는 trusted workspace에서만 활성화한다." 프로젝트 제공 에이전트 정의는 신뢰되지 않은 콘텐츠이므로 권한을 **좁힐 수만** 있고 넓힐 수 없습니다. Skills의 §16.6과 같은 원칙입니다.

프론트매터 필드 7개 (`KNOWN_FIELDS`, `:47-56`): `name`, `description`, `mode`, `model_profile`, `permissions`, `max_tools`, `base_role`. **그 외는 보고되지만 반영되지 않습니다.**

`mode`는 `subagent`만 의미가 있습니다. `permissions`는 `read` | `write` | `process`.

신뢰되지 않은 프로젝트 정의는 **파싱은 되고** `{field: "trust"}` 문제를 반환합니다 (`:71-82`) — 설정 진단이 "파일이 존재하지만 활성화되지 않았다"를 보여줄 수 있도록. 침묵은 파일이 없는 것처럼 보이기 때문입니다.

## 역할 탐색

`searchAgents(query, options)` (`discovery.ts:37`)가 역할을 자연어 질의에 대해 순위 매깁니다. **최종 결정은 루트에 남습니다** — 이 함수는 선택지만 정렬합니다.

가중치: 역할명 ×3, `keywords` ×2, `description` ×1, `capabilities` ×1.

`suitability`는 **확률이 아니라 휴리스틱 순위값**입니다 (`:13-16`) — 도구 탐색 점수(§6.9)와 같은 취지로, 모델 확신도로 제시되어서는 안 됩니다.

커스텀 에이전트는 `options.customAgents`로 후보에 합류하며 이름 ×3, 설명 ×1, capabilities ×1로 채점됩니다.

## Hosted Scout Lane

`hosted-scout.ts`가 프로바이더 측 읽기 전용 정찰을 다룹니다.

**프로바이더가 유계 읽기 전용 정찰을 실행할 수 있지만, CBC가 승인 결정을 소유하고 신원 일치 증거 캡슐만 받아들입니다.** 전송이 주입되므로 테스트나 로컬 프로바이더가 셸·패치·자격 증명·외부 부작용 능력을 우발적으로 획득할 수 없습니다 (`:1-8`).

6개 이벤트: `hosted_agent.spawned`, `hosted_agent.progress`, `hosted_agent.completed`, `hosted_agent.cancelled`, `hosted_agent.fallback_local`, `hosted_agent.evidence_rejected`.

폴백은 **한 번만** 쓰이는 로컬 읽기 전용 전송입니다 (`fallback?: HostedScoutTransport`).

정책·검증은 `@cbc/provider-openai`의 `DEFAULT_HOSTED_SCOUT_POLICY`, `validateHostedScoutRequest`, `acceptHostedScoutReport`가 소유합니다.

## 설정 키

`subagents` (`config-schema/src/schema.ts:595-599`):

| 키 | 기본값 | 범위 |
| --- | --- | --- |
| `subagents.maxConcurrent` | 3 | 1–8 |
| `subagents.maxDepth` | 2 | 0–3 |
| `subagents.writerPolicy` | `worktree-lease` | `single-lease` \| `worktree-lease` |

`agentGraph` (`:726-738`):

| 키 | 기본값 |
| --- | --- |
| `agentGraph.enabled` | `true` |
| `agentGraph.maxDepth` | 3 |
| `agentGraph.maxNodes` | 16 |
| `agentGraph.maxConcurrentNodes` | 6 |
| `agentGraph.maxConcurrentReaders` | 6 |
| `agentGraph.maxConcurrentWriters` | **1** |
| `agentGraph.maxAttemptsPerNode` | 2 |
| `agentGraph.checkpointEvents` | 25 |
| `agentGraph.messageBytes` | 65,536 |
| `agentGraph.recoveryPolicy` | `safe-retry` (\| `manual`) |
| `agentGraph.budget.mode` | `hard` (\| `advisory`) |
| `agentGraph.budget.maxCostUsd` | 4 |
| `agentGraph.budget.maxToolCalls` | 240 |
| `agentGraph.budget.maxWallClockMinutes` | 30 |

> **알려진 불일치:** `subagents.maxPerTurn`은 deprecated이며 "child registration is now unbounded per turn and excess parallel work is queued"라는 메시지를 냅니다 (`schema.ts:1002`). `SchedulerOptions.maxChildrenPerTurn`도 `@deprecated`입니다.

## TUI에서 보기

`/graph`가 내구성 있는 에이전트 그래프를 검사합니다. 태스크 카드는 타임라인에 나타나고, `Esc`는 대기를 멈추되 자식을 죽이지 않습니다.

자세한 내용은 [터미널 UI](tui-guide.md)를 참고하십시오.

## 관련 문서

- 커널 턴 루프 → [에이전트와 컨텍스트](agent-and-context.md)
- writer 리스와 도구 스케줄링 → [도구 레퍼런스](tools.md)
- 권한 범위 → [권한과 신뢰](permissions-and-trust.md)
- 모델 프로필 (`fast`/`balanced`/`review`) → [프로바이더와 모델](provider-and-models.md)
