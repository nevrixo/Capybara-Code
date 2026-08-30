# 에이전트와 컨텍스트

이 문서는 한 번의 턴이 어떻게 조립되고 실행되고 마감되는지를 다룹니다. 두 개의 패키지가 중심입니다 — `packages/agent-kernel` (8,579줄)과 `packages/context-engine` (13,127줄).

## 턴 상태 기계

턴은 자유로운 루프가 아니라 **명시적 전이 표**입니다 (`agent-kernel/src/state.ts:80-160`). 상태를 임의로 할당하지 않고 간선 집합을 인코딩한 이유는 주석에 적혀 있습니다 — 그래야 상태 전이가 테스트 가능하고, 라이브 상태 표시줄이 정직해집니다.

16개 상태:

```
idle → preparing → sampling ─┬→ tool_selection → executing → observing ─┬→ sampling (루프)
                             │        ↓                ↓                │
                             │  awaiting_approval   cancelling          ├→ reflecting → re_planning
                             │                                          │
                             └→ verifying ─┬→ completed                 └→ verifying
                                           ├→ sampling (needs_repair)
                                           └→ partial
                              cancelled · failed · retrying
```

주목할 설계 결정:

- **`reflecting`이 별도 상태입니다.** 없으면 실패와 성공이 같은 경로를 지나가고, "그게 바로 에이전트가 같은 깨진 호출을 세 번 재시도하는 방식"이라는 주석이 이유를 밝힙니다 (`state.ts:18-24`).
- **`re_planning`이 `reflecting`과 분리되어 있습니다.** 트랜잭션 체크포인트를 롤백할 수 있는 것은 `re_planning` 하나뿐입니다 (`:26-31`).
- `reflecting`에서 `budget_exhausted`는 `verifying`이 아니라 **`partial`로 갑니다** — "reflection은 주차장이 아니다" (`:123-125`).
- `tool_selection`은 `observed` 간선을 가집니다. 없으면 인라인 관찰만 낸 배치에서 턴 루프가 영원히 도는 dead end가 됩니다 (`:98-101`).
- `response_incomplete` → `partial`. 프로바이더가 완전한 응답 전에 멈춘 것은 **절대 final이 아닙니다**.

## 턴 시작: 상태 리셋

`runTurn` (`kernel.ts:1176`)의 첫 블록은 이 턴을 서술하는 **모든** 필드를 비웁니다 — 변경 파일, 위험, 사용량, 검증 결과, 변경 발생 여부까지. 주석이 이유를 밝힙니다: 남아 있으면 다음 리포트로 새어 들어가 새 턴이 다른 턴의 작업을 자기 것으로 주장하게 됩니다 (`:1188-1191`).

빈 입력은 `invalid_input` → `failed`로 즉시 끝나며 `run.trace_completed{reason: "empty_input"}`을 냅니다.

## 프롬프트 레이어 L0–L8

`context-engine/src/engine.ts:64-77`이 레이어를 순서대로 정의하고, 렌더링은 `agent-kernel/src/prompt.ts`의 `assemblePrompt`가 소유합니다.

| 레이어 | 내용 |
| --- | --- |
| `L0_policy` | `ROOT_POLICY` + 모드 정책 (`PLAN_POLICY` / `DEEP_PLAN_POLICY`) + `TODO_POLICY` |
| `L1_tool_semantics` | `TOOL_PROTOCOL` + 도구 스키마 |
| `L2_project_instructions` | 신뢰 게이트된 프로젝트 지침 파일 |
| `L3_active_skills` | 활성 스킬 메타데이터 (본문 아님) |
| `L4_task_and_plan` | 태스크, 계획, 결정, 가정 |
| `L5_compact_state` | 압축 상태 + 메모리 핸들 |
| `L6_repository_context` | 저장소 맵, 파일 발췌, diff |
| `L7_tool_observations` | 정규화된 도구 관찰 |
| `L8_user_input` | 사용자 메시지 |

**설계의 핵심 규칙:** 낮은 레이어는 높은 레이어의 신뢰되지 않은 지침으로 절대 덮이지 않습니다 (`engine.ts:4-6`). 외부 텍스트는 `wrapUntrusted(source, content)` (`prompt.ts:321`)를 통과합니다.

### 안정 접두사 캐싱

`materializeStablePrompt` (`prompt.ts:492`)가 `WeakMap` 두 개로 메모이즈합니다 — `STABLE_PROMPT_CACHE`(정책+도구 스키마)와 `TOOL_SCHEMA_CACHE`(도구별). 캐시 키는 `stablePromptVersion(inputs, toolVersions)`이며 도구 정의가 바뀌면 무효화됩니다. `promptMaterializationCacheStats()` (`:450`)가 히트율을 노출합니다.

지문 함수들 (`prompt.ts:1008-1048`): `fingerprint(text)`, `toolsetFingerprint`, `skillMetaFingerprint`, `policyFingerprint`, `safetyIdentifier(installationId, salt)`.

`EAGER_TOOL_SEARCH_IDS`는 `tool.discover`, `todo.write`, `user.ask` 세 개뿐입니다 (`:994`) — 나머지는 네임스페이스별로 지연됩니다.

## 컨텍스트 IR

`context-engine/src/ir.ts`가 타입 지정 중간 표현을 정의합니다. `CONTEXT_IR_VERSION = "context-ir-v1"`.

**IR에는 프로바이더 렌더링 정책이 없습니다** (`ir.ts:3-7`) — 선택, 프롬프트 조립, 라우팅, 캐시 계획, 검사가 공유하는 단일 진실입니다.

15개 `ContextKind`: `policy`, `tool_schema`, `instruction`, `task`, `plan`, `symbol`, `file_excerpt`, `diff`, `test_result`, `tool_observation`, `decision`, `assumption`, `memory`, `artifact_ref`, `dialogue`.

각 항목이 지니는 축:

- `ContextAuthority`: `system` | `user` | `workspace_maintainer` | `tool` | `external`
- `ContextTrust`: `trusted` | `untrusted`
- `ContextFreshnessState`: `fresh` | `stale` | `invalid` | `unknown`
- `ContextResolution`: `map` | `signature` | `snippet` | `full` | `summary` | `handle`

**정확한 관찰과 요약은 구분 가능하게 유지되며**, 모든 항목이 나중에 설명하거나 무효화할 수 있을 만큼의 출처(`ContextProvenance{source, locator, digest}`)를 지닙니다.

## 예산 배분

`compiler.ts:799-816`이 target 토큰을 여섯 버킷에 나눕니다.

| 버킷 | 비율 | 담기는 kind |
| --- | --- | --- |
| `stable_prefix` | 24% | `policy`, `tool_schema`, `instruction` |
| `task_state` | 14% | `task`, `plan`, `decision`, `assumption` |
| `exact_evidence` | 28% (**하한 있음**) | 정확 표현 항목, `file_excerpt`, `diff`, `test_result`, `tool_observation` |
| `memory_handles` | 8% | `memory` |
| `recent_dialogue` | 10% | 대화 |
| `working_code` | 잔여 (약 16%) | 그 외 |

`bucketFor` (`compiler.ts:630-635`)가 분류하며, 비율이 아니라 **분류가 우선**입니다.

두 개의 특별 제약:

1. **exact evidence 하한** (`:267-268`): `bucketTokens.exact_evidence < budget.exactEvidenceFloor`인 동안 `exact_evidence` 후보를 `"exact_evidence_floor"` 이유로 강제 승인합니다. 정확한 증거가 요약에 밀려나지 않게 합니다.
2. **탐색 상한** (`:280-281`): `working_code`이면서 `representation.exact`가 아닌 후보는 `explorationCeiling`을 넘으면 거부됩니다. 추측성 탐색이 예산을 먹지 못하게 합니다.

승인은 **단일 패스**이며 의존성과 함께 포함됩니다 (`includeWithDependencies`). 정렬은 MMR (`DEFAULT_MMR_LAMBDA = 0.45`, `DEFAULT_MAX_CONTEXT_CANDIDATES = 2_048`, `compiler.ts:27-28`).

`stable_prefix` 세그먼트만 `cacheBreakpoint: true`를 받고 (`:457`), `cacheBreakpoints`는 `[grouped.stable_prefix.length]` 하나뿐입니다 (`:515`).

## 토큰 절약 (`agent.tokenSaving`)

**하나의 사용자 설정이 다섯 가지를 동시에 움직입니다** (`agent-kernel/src/token-saving.ts:1-13`): 컨텍스트 target, 탐색 상한, 로컬 히스토리 압축 시점, 내부 구현 최소화 정책("Ponytail"), 응답 스타일.

| 레벨 | targetInputRatio | explorationRatio | localCompactionRatio | ponytail | responseStyle |
| --- | --- | --- | --- | --- | --- |
| `off` | 1 | 0.30 | 0.70 | `off` | `normal` |
| `light` | 1 | 0.30 | 0.65 | `lite` | `concise` |
| `balanced` | 0.85 | 0.22 | 0.55 | `full` | `concise` |
| `strong` | 0.70 | 0.15 | 0.45 | `ultra` | (다음 표 참고) |

`PonytailPolicy`는 **의도적으로 설정으로 노출되지 않습니다** — 각 절약 레벨이 내부 정책에 매핑됩니다 (`:7-9`).

해석기는 순수·결정적입니다: 같은 입력이 항상 같은 계획을 내므로 재생된 턴이 정확히 같은 예산을 재현합니다. 그리고 **fail-safe**입니다 — 내부 오류는 `off`로 해석됩니다. 깨진 절약 정책이 품질을 조용히 격하시켜서는 안 되기 때문입니다 (`:10-13`).

## 검색 컨트롤러

`retrieval-controller.ts`는 어댑터 기반입니다. 컨트롤러가 순서·예산·preview/exact 권위 경계를 소유하고, 호스트가 실제 검색과 런타임 읽기를 소유합니다 — 여기에 두 번째 파일시스템 경로를 만들지 않기 위해서입니다 (`:1-8`).

4단계: `search` → `preview` → `exact` → `stop`.

`RetrievalBudget`: `maxSearchCalls`, `maxPreviewCalls`, `maxExactCalls`, `maxBytesScanned`, `maxEvidenceTokens`.

## 컨텍스트 연산 (7종)

`context-ops.ts:55-61`이 컨텍스트를 변형하는 7개 연산을 정의합니다.

| 연산 | 의미 |
| --- | --- |
| `keep` | id 집합 유지 |
| `snippet` | 항목을 줄 범위로 좁힘 |
| `compress` | id들을 `StructuredCompactStateV2`로 압축 |
| `delete` | 명시적 `reason`과 함께 제거 |
| `rollback` | 체크포인트로 복귀, `preserveEvidence` 보존 |
| `offload` | 아티팩트로 방출 |
| `recall` | 증거 id 재소환 |

모든 연산은 정규화 시 `sortedUnique`와 `deepFreeze`를 통과합니다 (`:1077-1083`) — 결정성이 목적입니다.

## 학습 최적화 경계

`optimizer.ts`는 P4 경계입니다. 요지는 첫 문단에 있습니다: **학습 컴포넌트는 의도적으로 선택적이며 신뢰되지 않습니다.** 압축 상태나 컨텍스트 연산을 *제안*할 수 있지만, 작업 뷰로 들어가는 유일한 경로는 결정적 검증입니다.

거부되거나 throw한 어댑터는 항상 폴백합니다:
- 압축 → 추출적 P3 상태 (`DeterministicExtractiveCompressor`)
- 컨텍스트 연산 → 보수적 keep/no-op (`DeterministicConservativePolicy`)

한계: `DEFAULT_MAX_SUMMARY_CHARACTERS = 256 KiB`, `DEFAULT_MAX_CONTEXT_OPERATIONS = 32`, `MAX_VALIDATION_ISSUES = 64`.

10종 실패 유형(`OptimizationFailureKind`)이 압축 지침으로 번역됩니다: `critical_text_dropped`, `decision_dropped`, `unresolved_work_dropped`, `evidence_reference_dropped`, `unsupported_summary_claim`, `stale_evidence_retained`, `summary_budget_exceeded`, `redundant_summary_content`, `invalid_context_operation`, `unsafe_context_operation`.

## 압축

`session-domain/src/compaction.ts`가 세션 저널 압축을 소유합니다.

- `COMPACTION_SOFT_BUDGET_RATIO = 0.7`
- `COMPACTION_EMERGENCY_RATIO = 0.9`
- `DEFAULT_RETAIN_PER_GROUP = 6`
- `DEFAULT_MAX_ITEM_CHARS = 600`

`shouldCompact` (`:156`)가 트리거를 판정하고 `compact` (`:209`)가 실행합니다. **원본 저널 이벤트는 유지됩니다** — `/compact`의 출력이 "Original journal events were retained."로 끝나는 이유입니다.

`mergeCompactionCapsules` (`:397`)가 여러 캡슐을 합치고, `renderCompactState` (`:527`)가 L5용 텍스트를 만듭니다.

## 메모리

두 계층입니다.

**`context-engine/src/memory.ts` — `MemoryBank`** (순수 저장·조회)
- `MemoryScope`: `workspace` | `session` | `task`
- `MemoryStatus`: `active` | `superseded` | `contested`
- `MemoryEvidenceFreshness`: `fresh` | `stale` | `invalid` | `unknown`

**`memory-service/src/service.ts` — `MemoryService`** (프로덕션 파사드)

파사드가 추가하는 네 가지 (`:1-5`):

1. **비밀 거부.** 7개 패턴(`password`, `api[-_]?key`, 각종 token, `secret`/`client_secret`, `credential(s)`, `private[-_]?key`, `(set-)?cookie`)이 **키 또는 값** 어디에 나타나도 영속 메모리 진입을 막습니다 (`:20-28`).
2. **필수 워크스페이스 격리.** `workspaceIdentity`가 생성자 필수이며 빈 문자열은 `RangeError`. 쿼리 identity가 불일치하면 recall이 빈 배열을 반환합니다 (`:97-101`) — 크로스 워크스페이스 오염이 구조적으로 불가능합니다.
3. **contested 제외.** `recall`은 `statuses: ["active"]`로 강제하고 추가로 `status === "contested"`를 걸러냅니다.
4. **논리적 forget.** `#forgotten` 집합이 레코드를 지우지 않고 회상에서만 제외합니다.

투영은 `MemoryContextItem{kind: "memory", layer: "L5_compact_state"}`이며 `provenance`에 `memoryId`, `evidenceIds`, `scope`, `confidence`를 담습니다.

## 관찰 정규화

`observation.ts:1-8`의 파이프라인: 정화 → 비밀 탐지 → 구조화 필드 파싱 → head/tail 유지 → 반복 줄 요약 → 아티팩트 스필 → 압축 관찰 발행. **원시 도구 출력은 프롬프트로 직행하지 않습니다.**

인라인 한계 (`INLINE_LIMITS`, `:13-17`): `maxLines: 200`, `maxBytes: 64 KiB`, `maxSingleLineBytes: 8 KiB`.

### 실패 분류 4종

의도적으로 거친 4개인데, 실제로 다른 네 가지 다음 행동에 매핑되기 때문입니다 (`:29-41`).

| 분류 | 다음 행동 |
| --- | --- |
| `schema_mismatch` | 같은 의도를 고친 인자로 재발행 |
| `permission_denied` | 범위가 틀렸다 — 접근을 좁히거나 묻는다 |
| `logic_bug` | 코드에 대한 모델이 틀렸다 — 다시 읽는다 |
| `environment_issue` | 계획은 맞고 세상이 틀렸다 |

더 세밀한 분류는 "루프가 그것으로 무엇을 하는지를 바꾸지 않으면서 더 정밀해 보이기만 할 뿐"이라 원시 `code`를 함께 보관합니다.

## 자기 성찰 루프

`#reflect` (`kernel.ts:4216`) → `#analyzeFailure` (`:4248`) → `#rollbackAbandonedApproach` (`:4322`).

`renderReflectionPrompt(analysis)` (`:4994`)와 `categoryInstructions(category)` (`:5036`)가 분류별 지시문을 만들고 `describeRootCause` (`:5066`)가 근본 원인을 서술합니다.

## 검증

### 구조화 검증 계획 (`verification-planner.ts`)

**명령은 호스트 권한 계층이 승인·실행하기 전까지 데이터입니다.** 누락된 필수 단계는 명시적으로 표현되고 완료를 강등해야 합니다 (`:1-5`).

5개 tier (`VerificationTier = 0 | 1 | 2 | 3 | 4`), 8개 영향 신호:

`mutation`, `cross_module`, `config`, `auth`, `dependency`, `generated`, `test`, `docs_only`.

영향 신호 판정 (`impactSignals`, `:264-280`):

- `.json|.ya?ml|.toml|.env|.config` → `config`
- `auth|permission|credential|security|policy` → `auth`
- `package|lock|cargo|go.mod|requirements` → `dependency`
- `generated|schema|protocol` → `generated`
- 최상위 디렉터리가 2개 이상 → `cross_module`
- **모든 경로가 `.md|.txt|.adoc`이면** `mutation`을 제거하고 `docs_only`를 추가

언어별 명령 (`focusedCommandFor`, `broaderCommandFor`):

| 언어 | 집중 명령 | 넓은 명령 |
| --- | --- | --- |
| Rust | `cargo test --workspace` (120 s) | `cargo test --workspace` (180 s) |
| Python | `python -m pytest <tests>` (120 s) | `python -m pytest` (180 s) |
| TypeScript / 기타 | `bun test <tests>` (120 s) | `bun test` (180 s) |

### 턴 검증 계약

`buildTurnVerificationContract` (`:192`)가 계획에서 계약을 **파생**합니다. 주석의 표현: 모든 변경 턴이 하나의 계약을 소유하며, 계약은 런타임이 디스패치하는 것과 **같은 계획**에서 파생되므로 필수 검사가 단계와 드리프트할 수 없습니다 (`:186-188`).

계약 필드: `workspaceGeneration`, `changedPaths`, `impactedPackages`, `requiredChecks`, `reviewRequired`, `evidenceRequirements`.

`impactedPackagesFor` (`:225`)가 `packages/*`, `apps/*`, `crates/*` 최상위 두 세그먼트를 패키지로 집계하고, 나머지는 최상위 디렉터리(또는 `.`)로 집계합니다.

각 검사의 `scope`: tier ≤ 1이면 변경 경로, 그 외에는 영향 패키지 (`:210`).

### 검증 명령 승인

`#authorizeVerificationCommand` (`kernel.ts:4664`) → `#authorizeVerificationAction` (`:4711`) → `#executeAuthorizedVerificationCommand` (`:4911`). 검증 명령도 다른 프로세스 실행과 같은 권한 경로를 통과합니다.

보조 검사: `#runFileSanity` (`:4765`), `#runGitDiffSanity` (`:4857`).

## 변경 위험 평가

`risk.ts:38`의 `assessChangeRisk`는 **결정적이고 프로바이더 중립적**입니다. 완료 경계에서 사용 가능한 사실만 쓰기 때문에 같은 패치는 모델 산문과 무관하게 같은 리뷰 결정을 받습니다.

점수:

| 조건 | 점수 |
| --- | --- |
| 워크스페이스 변경됐는데 변경 경로 미해결 | +4 |
| 파일 8개 이상 / 3개 이상 | +2 / +1 |
| 500줄 초과 / 120줄 초과 | +3 / +1 |
| `auth\|credential\|secret\|permission\|policy\|sandbox\|security\|crypto` 경로 | **최소 5로 상승** |
| `migration\|schema\|protocol\|api\|transaction\|concurren\|lock` | +2 |
| 락파일 / `generated` / `vendor` | +1 |
| 이미 수리 사이클을 거침 | +min(2, 횟수) |
| 외부 부작용 적용됨 | +2 |

등급: `≥8` critical, `≥4` high, `≥2` medium, 그 외 low. `reviewRequired = RISK_RANK[level] >= RISK_RANK[minimumReviewRisk ?? "medium"]`.

권한 임계값 매핑 (`riskLevelForPermissionThreshold`): R6 → critical, R4–R5 → high, R2–R3 → medium, R0–R1 → low.

## 완료 계약

`CompletionReport` (`observation.ts:526`):

```ts
{
  status: "completed" | "partial" | "failed" | "cancelled";
  summary: string;
  changedFiles: Array<{ path; additions?; deletions?; purpose }>;
  verification: Array<{ kind?; command?; required?; status: "passed"|"failed"|"not_run"; evidence }>;
  delegatedTasks: Array<{ id; role; status; summary }>;
  risks: string[];
  nextStep?: string;
}
```

**진단 검사(`required: false`)는 보고되지만 완료 상태를 결정하지 않습니다** (`:537`).

### 진실성 강제

`enforceTruthfulness(report)` (`:667`)가 리포트를 교정하고 문제 목록을 반환합니다. 규칙:

1. **권한 차단된 쓰기 + 변경 파일 0개** → `passed` 검증을 모두 `not_run`으로 되돌리고, `completed`를 `partial`로 강등하고, 위험에 이유를 추가하고 `nextStep`을 신뢰 확인으로 설정.
2. **필수 검증 실패가 있는데 `completed`** → `partial`.
3. **파일이 바뀌었는데 필수 검증이 하나도 없음** → 위험 "no verification was run against these changes" 추가 + `partial`.
4. **`not_run`인데 `evidence`가 비어 있음** → 문제로 기록 (왜 실행할 수 없었는지 반드시 남겨야 함).
5. **요약이 `all tests pass` / `everything works` / `fully working` / `verified working`을 주장하는데 검증이 뒷받침하지 않음** → 요약에 `(note: verification did not confirm this)`를 덧붙임.
6. **요약이 비어 있음** → `describeFallbackSummary`로 대체.

`deriveCompletionPresentation` (`:559`)이 표시용 disposition을 파생합니다 — `report.status`는 손대지 않습니다. 한국어 감지는 `/[가-힣]/u`이며 blocking/attention 이슈 코드를 이중 언어로 만듭니다.

> **알려진 불일치:** `KernelOptions`에 `completionRequiresFreshEvidence` (`kernel.ts:669`)와 `falseCompletePolicy: "block" | "warn"` (`:671`)이 선언되어 있으나 커널이 읽지 않습니다. 동작은 항상 block입니다.

## Thinking 조립

`thinking.ts`는 프로바이더 중립입니다. 프로바이더 추론 이벤트는 전송 세부사항이며, 이 모듈은 그것을 하나의 의미론적 세그먼트로 바꿉니다 — **프로바이더가 공개하지 않은 텍스트를 절대 제조하지 않습니다** (`:1-8`).

TUI와 의도적으로 독립이므로 live·durable·resume·export 투영이 같은 계약을 공유합니다.

- `ThinkingFragmentChannel`: `detail` | `summary`
- `ThinkingBoundary`: `tool` | `final` | `response_end` | `interrupted` | `failed`
- 프래그먼트 3종: `delta` (`authoritative?: false`), `replace` (`authoritative: true`), `boundary`
- `ThinkingAssemblyState`: `streaming` | `completed` | `interrupted` | `failed`
- `ThinkingAssemblySource`: `provider_summary` | `provider_reasoning` | `status_only`
- `ThinkingAssemblySummaryOrigin`: `provider` | `derived_from_visible_detail`

중복 억제는 `sequence`와 `deltaId`로 합니다.

## 스트리밍 합체

`AssistantDeltaCoalescer` (`kernel.ts:265`)가 델타를 배칭합니다: `STREAM_FLUSH_MS = 24`, `STREAM_FLUSH_CHARS = 1_024` (`:243-244`).

5개 델타 단계: `progress`, `thinking`, `reasoning`, `reasoning_summary`, `candidate_final`.

## 인터럽트

`InterruptMode` 3종 (`kernel.ts:780`): `queue`, `interrupt_and_redirect`, `new_task`. `redirect(text)` (`:1171`)가 진행 중 턴에 방향 전환을 주입합니다.

## 도구 예산 넛지

`TOOL_BUDGET_NUDGE_REMAINING = 2` (`:132`) — 남은 호출이 2개일 때 `TOOL_BUDGET_WRAP_UP_PROMPT` (`:788`)를 주입해 마무리를 유도합니다. `#budgetNudged`가 한 턴에 한 번만 나가게 합니다.

## TODO 게이트

`isActionableTodo` / `isContinuableTodo` (`kernel.ts:154-165`)가 미완료 항목을 판정하고, `renderTodoContinuationPrompt` (`:179`)가 계속 프롬프트를, `renderUnfinishedTodoAnswer` (`:204`)가 정직한 부분 답변을 만듭니다.

Deep Plan 쪽은 `deepPlanBlockerLine` (`:208`), `renderDeepPlanContinuationPrompt` (`:214`), `renderIncompleteDeepPlanAnswer` (`:226`)가 대응합니다.

`todo.write` 실패 복구는 `isTodoMutationRecovery` (`:144`)로 `TODO_MUTATION_ERROR_ID = "todo-controller-error"` 항목을 식별합니다.

## 관련 문서

- 도구 스케줄링과 실행 → [도구 레퍼런스](tools.md)
- 서브에이전트 위임 → [서브에이전트와 AgentGraph](subagents-and-graph.md)
- 모델·effort 라우팅 → [프로바이더와 모델](provider-and-models.md)
- Deep Plan 상세 → `docs/deep-plan.md`
