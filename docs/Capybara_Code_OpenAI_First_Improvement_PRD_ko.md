# Capybara Code OpenAI-First Harness 개선 기획서 v1.0

> **Claude Code · Pi Agent · Prime Agent 비교 기반**  
> **멀티 프로바이더 개선 제외 / OpenAI·ChatGPT 모델 활용 품질에 집중**  
> 기준일: 2026-08-30

---

## 0. 문서 결론

Capybara Code에 지금 필요한 것은 기능을 더 많이 추가하는 것이 아니다. 현재 코드베이스에는 이미 다음과 같은 강한 기반이 있다.

- Rust 런타임이 소유하는 프로세스·파일·자격 증명 경계
- 체크섬 기반 동시 수정 방지와 트랜잭션 편집
- TODO 완료 게이트, 독립 리뷰, 실패 반성, 체크포인트 롤백
- 역할·권한·예산이 분리된 로컬 서브에이전트
- 증거·신선도·워크스페이스 격리가 포함된 컨텍스트/메모리 시스템
- 세션 데몬, 영속 AgentGraph, Worktree 멀티 에이전트, LSP, 플러그인 런타임
- 150개 태스크·통계적 paired gate를 전제로 한 자체 벤치마크 체계

문제는 이 기능들이 **OpenAI 모델이 실제 요청에서 선택하고 실행하는 하나의 수직 경로**로 충분히 연결되지 않았다는 점이다. 특히 OpenAI 네이티브 Programmatic Tool Calling, Multi-agent, persisted reasoning, explicit prompt caching은 정책·타입·설정 일부만 존재하거나 읽기 전용 스캐폴딩에 머물러 있다.

따라서 제품 방향을 다음 한 문장으로 고정한다.

> **OpenAI가 판단하고 계획하며, Capybara가 권한을 승인하고 실행하며 검증한다.**

즉, OpenAI 네이티브 기능은 **Decision Plane**으로 적극 사용하되, 쓰기·셸·승인·트랜잭션·증거·검증은 계속 **Capybara Authority Plane**이 소유한다.

---

# 1. 비교 결과 요약

## 1.1 상대 비교표

| 비교 대상 | 잘하는 점 | Capybara의 현재 차이 | 가져올 것 | 가져오지 않을 것 |
|---|---|---|---|---|
| Claude Code | 격리된 서브에이전트, 자동화 훅, 자동 메모리, Skills/플러그인, 완성도 높은 기본 동작 | Capybara도 대부분의 엔진은 있으나 사용자가 설정하지 않아도 자연스럽게 작동하는 기본값과 통합 UX가 약함 | 자동 위임 기본값, 훅 템플릿, 학습 가능한 프로젝트 메모리 UX, 간단한 진단 화면 | Claude 전용 생태계 복제, 기능별 UI 복제품 |
| Pi Agent | 작은 코어, 간결한 SDK, 단일 파일 확장, 낮은 실험 비용 | Capybara는 내부 계약과 안전 계층이 많아 확장·실험 비용이 큼 | 모델이 보는 도구 표면 단순화, 얇은 확장 API, 빠른 실험 프로필 | 사용자 권한 그대로 실행하는 기본 보안 모델 |
| Prime Agent | 컨텍스트를 프로그램 변수처럼 다룸, 재귀 서브에이전트, 장기 세션, `/refine` 기반 Continual Harness | Capybara는 안전성과 검증은 강하지만 프로그램 가능한 오케스트레이션과 궤적 기반 개선 루프가 약함 | 읽기 전용 프로그램 호출, 증거 기반 Strategy Capsule, 장기 목표 루프 | 무제한 로컬 IPython, 모델의 임의 셸/쓰기, 베이스 시스템 프롬프트 자동 변경 |
| Capybara Code | 권한·트랜잭션·증거·검증·복구가 구조적으로 강함 | 설계 면적에 비해 실제 OpenAI 요청→실행→검증까지 연결된 경로가 부족함 | 기존 기반 보존, OpenAI 네이티브 기능의 수직 통합 | 또 다른 대형 하위 시스템 추가 |

## 1.2 가장 부족한 다섯 가지

### 1위. OpenAI 네이티브 기능이 실행 경로까지 연결되지 않음

`provider.openai.native.*` 설정은 실험 상태이며 정책 digest에만 영향을 주고, Programmatic Tool Lane은 호출을 허용할지 판정하지만 실제 출력은 만들지 않는 admission-only 구조다. Hosted Scout도 검증 구조는 있으나 OpenAI 응답 스트림과 실제로 이어지는 제품 경로가 핵심 병목이다.

**결과**

- GPT-5.6의 장점이 모델 성능에만 머물고 하네스 효율 개선으로 이어지지 않음
- 읽기·검색·집계 작업도 모델 왕복 호출이 반복됨
- 라우터가 `lane`, `maxAgents`, `maxParallelTools`를 계산해도 실제 실행이 달라지지 않는 경우가 생김

### 2위. Task Epoch 설계와 persisted reasoning 제어가 분리됨

`TaskEpochManager`는 목표·정책·워크스페이스·도구·모델·가설·리뷰 변화에 대응하도록 잘 설계돼 있다. 그러나 실제 샘플 요청에서 `goalStable=true`, `hypothesisInvalidated=false`가 고정되어 한 턴 내부 재계획·가설 폐기·리뷰가 `reasoning.context`에 반영되지 않는다.

**결과**

- 접근법이 틀렸는데도 이전 숨은 추론을 계속 재사용할 수 있음
- 반대로 안전하게 재사용해도 되는 장기 작업에서는 연속성 최적화를 충분히 활용하지 못함
- `previous_response_id`, 수동 replay, compaction의 경계가 Task Epoch와 완전히 일치하지 않음

### 3위. 풍부한 내부 기능이 모델에게는 복잡한 도구·프롬프트 비용으로 노출됨

Capybara는 L0–L8 프롬프트, 세밀한 도구, LSP, AgentGraph, TODO, 증거, 권한 계약을 갖고 있다. 이는 호스트 내부에는 장점이지만, 매 샘플 모델이 모든 세부 규칙과 스키마를 이해해야 한다면 Pi의 작은 코어보다 선택 오류와 토큰 비용이 커질 수 있다.

**결과**

- 도구 선택 전에 긴 설명을 해석해야 함
- 같은 의미의 규칙이 프롬프트·스키마·오류 메시지에 반복될 가능성
- 고급 기능을 추가할수록 모델 표면이 더 복잡해지는 역설

### 4위. 검증 엔진은 강하지만 작업 영향도와 자동 연결이 덜 제품화됨

현재 커널은 독립 리뷰, TODO 완료 게이트, 실패 반성, repair loop, 롤백을 지원한다. 다만 어떤 변경에 어떤 검증을 자동 선택할지, 어느 시점에 reviewer를 추가할지, 최종 증거가 정확히 어떤 워크스페이스 revision을 검증했는지가 하나의 공개 계약으로 더 명확해야 한다.

**결과**

- 안전한 소규모 변경에 과도한 검증이 붙거나
- 반대로 넓은 영향 범위 변경에 충분한 검증이 빠질 수 있음
- “테스트 통과”와 “현재 파일 revision 검증” 사이에 시간차가 생길 수 있음

### 5위. 비교 벤치가 강하지만 경쟁 대상이 Codex 중심으로 고정됨

CBC Bench 자체는 강하다. 그러나 외부 비교 타입이 사실상 `codex_matched` 중심이어서 Claude Code·Pi·Prime과의 제품 수준 차이를 정량적으로 닫는 루프가 부족하다.

**결과**

- 무엇이 실제 약점인지보다 기능 인상비교에 의존
- Pi/Prime과 같은 GPT-5.6 동일 백본 비교와 Claude Code 제품 기본값 비교가 분리되지 않음
- 개선 후 회귀 여부는 검증해도 경쟁력 향상 여부는 자동으로 확인되지 않음

---

# 2. 범위

## 2.1 포함 범위

- OpenAI API 기반 GPT-5.6 Sol/Terra/Luna 활용 최적화
- ChatGPT 계정 로그인 백엔드의 호환·연속성·fallback 품질
- Programmatic Tool Calling 수직 통합
- OpenAI Multi-agent 기반 읽기 전용 Scout/Reviewer Lane
- `reasoning.context`, `previous_response_id`, 수동 replay, WebSocket 연결 정책
- 명시적 prompt caching과 Tool Search
- 모델 라우팅 결과의 실제 실행 반영
- 검증·repair·review 자동화
- 안전한 Continual Strategy Memory
- Claude Code·Pi·Prime·Codex 비교 벤치

## 2.2 제외 범위

- Anthropic, Google, OpenRouter 등 멀티 프로바이더 동등 지원
- 모든 프로바이더를 위한 공통 capability 추상화 확장
- Prime Agent식 무제한 로컬 Python REPL
- OpenAI hosted shell이 Rust 실행 경계를 우회하는 구조
- 모델이 베이스 시스템 프롬프트를 자동 수정하는 기능
- 당장 필요하지 않은 신규 TUI 프레임워크 재작성
- 역할 수를 늘리는 것 자체를 목표로 한 서브에이전트 확장

---

# 3. 제품 원칙

## 3.1 핵심 아키텍처

```text
User / TUI / SDK
        │
        ▼
AgentSession + TaskEpoch + Route Policy
        │
        ▼
OpenAI Decision Plane
  ├─ Direct reasoning / function calls
  ├─ Programmatic Tool Calling (읽기 전용)
  ├─ Hosted Multi-agent Scout / Reviewer
  ├─ Tool Search
  ├─ Prompt Cache / WebSocket / Compaction
  └─ Persisted Reasoning
        │
        ▼
Capybara Authority Plane
  ├─ Permission / Approval
  ├─ Rust Sandbox / Process
  ├─ Transactional Edit Engine
  ├─ Local Writer Subagents / Worktrees
  ├─ Evidence / Freshness / Revision Binding
  └─ TODO / Verification / Rollback
        │
        ▼
Outcome + Route Receipt + Eval Ledger
```

## 3.2 절대 불변 조건

1. 모델은 행위를 **제안**할 수 있지만 권한을 확대할 수 없다.
2. Programmatic Tool Calling은 1차 출시에서 읽기 전용이다.
3. Hosted Multi-agent 요청에는 읽기 전용 도구만 제공한다.
4. 모든 파일 쓰기는 기존 Rust/Edit Engine 경로를 통한다.
5. 모든 외부 부작용은 기존 approval 정책을 통한다.
6. 최종 완료 판정은 모델 문장이 아니라 TODO·증거·검증 결과가 결정한다.
7. OpenAI 네이티브 기능이 실패하면 동일한 안전 계약을 유지한 채 로컬/direct 경로로 fallback한다.
8. ChatGPT 계정 모드는 느릴 수 있으나 정답·안전 계약은 API 모드와 동일해야 한다.

---

# 4. 백엔드 프로필 분리

OpenAI API와 ChatGPT 계정 백엔드는 실제 capability가 다르므로 하나처럼 숨기지 않는다.

## 4.1 `openai-api-enhanced`

사용 가능할 때 다음을 활성화한다.

- Responses API
- `previous_response_id`
- WebSocket continuation
- Programmatic Tool Calling
- OpenAI Multi-agent beta
- explicit prompt caching
- native compaction
- Tool Search
- Fast service tier
- `reasoning.context = all_turns | current_turn`

## 4.2 `chatgpt-account-compatible`

- HTTP 기반 full replay
- 로컬 AgentGraph 및 로컬 서브에이전트
- 모든 이전 output item과 assistant `phase` 보존
- reasoning item을 포함한 정확한 수동 replay
- 로컬 adaptive compaction
- API 전용 PTC·Multi-agent·service tier는 비활성화
- 사용자가 API 전용 기능이 없는 이유를 `/doctor openai`에서 확인 가능

## 4.3 공통 행동 계약

두 프로필은 아래 결과를 동일하게 보장해야 한다.

- 동일한 permission/approval 판단
- 동일한 트랜잭션 쓰기 경계
- 동일한 TODO 완료 조건
- 동일한 검증 증거 형식
- 동일한 partial/blocked/failure 의미
- 동일한 사용자 언어·대화형 최종 답변 규칙

성능 최적화 기능의 차이는 허용하지만 정답·안전 의미의 차이는 허용하지 않는다.

---

# 5. P0 수정 요구사항

## P0-01. OpenAI Native Execution Plane 수직 통합

### 목표

현재 정책·타입·테스트에 머문 PTC와 Hosted Scout를 실제 OpenAI 요청→스트림 파싱→도구 실행→증거 수집→응답 재개 경로에 연결한다.

### 5.1 Programmatic Tool Calling 적용 범위

PTC를 쓰는 작업:

- 여러 파일의 metadata/read/search 결과 필터링
- 독립적인 LSP symbol/diagnostic 조회 집계
- git status/diff/log 등 읽기 전용 결과 집계
- 다수 검색 결과 deduplication/ranking
- 정확한 입력·출력 스키마가 있는 반복 조회
- 큰 중간 결과를 작은 구조화 결과로 축약할 수 있는 단계

PTC를 쓰지 않는 작업:

- 파일 생성·수정·삭제·이동
- `process.run`, shell, package install
- 사용자 approval이 필요한 작업
- 각 중간 결과가 다음 의미 판단을 크게 바꾸는 탐색
- 최종 citation/native artifact 검증
- 사용자 의도 재해석, 설계 선택, 보안 판단

### 5.2 PTC 도구 allowlist

초기 허용 후보:

- `fs.read`
- `fs.search`
- `repo.map.query`
- `lsp.diagnostics`
- `lsp.symbols`
- `lsp.references`
- `lsp.definition`
- `lsp.implementation`
- `git.status.read`
- `git.diff.read`
- `artifact.read_excerpt`

초기 금지:

- 모든 mutation 도구
- 모든 process/shell 도구
- 모든 credential 도구
- 네트워크 쓰기·외부 부작용 도구
- 사용자 승인 요청 자체

### 5.3 요청 직렬화

`packages/provider-openai`에 다음 지원을 추가한다.

- `type: "programmatic_tool_calling"`
- 함수 도구의 `allowed_callers`
- 예측 가능한 결과에 대한 `output_schema`
- `program` output item
- program이 발생시킨 `function_call`
- `function_call_output`의 `call_id`와 `caller` 보존
- `program_output` item
- 수동 replay에서 위 item 전체 보존

### 5.4 Incremental Program Coordinator

기존 admission-only 구조를 다음 상태 머신으로 확장한다.

```text
idle
  → program_received
  → call_admitted
  → host_execution
  → output_validated
  → output_submitted
  → program_resumed
  → program_completed | fallback | denied
```

각 프로그램은 다음 예산을 가진다.

- 최대 함수 호출 수
- 최대 병렬 호출 수
- 최대 누적 입력/출력 byte
- 최대 wall time
- 재시도 횟수
- 허용 도구 ID
- taskEpochId
- workspaceIdentityDigest
- caller lineage

### 5.5 프로그램 결과 계약

PTC의 최종 구조는 자유 텍스트가 아니라 다음 형식을 권장한다.

```ts
interface ProgramEvidenceResult {
  status: "complete" | "partial" | "failed";
  claims: Array<{
    text: string;
    evidenceIds: string[];
    paths?: string[];
  }>;
  missing: string[];
  diagnostics: string[];
  stats: {
    calls: number;
    parallelPeak: number;
    inputBytes: number;
    outputBytes: number;
  };
}
```

호스트가 evidence ID·workspace identity·epoch를 검증하지 못하면 프로그램 결과를 모델의 사실 근거로 주입하지 않는다.

### 5.6 Hosted Multi-agent Scout Lane

OpenAI Multi-agent는 트리 전체가 같은 도구 집합을 보므로, 쓰기 도구가 포함된 root mutation 요청에 그대로 활성화하면 안 된다. 별도의 읽기 전용 요청으로 실행한다.

허용 역할:

- `explore`
- `architect`
- `reviewer`

비허용 역할:

- `executor`
- `refactorer`
- 쓰기 권한이 필요한 모든 custom role

기본 정책:

- 동시 실행 최대 3
- task epoch당 최대 hosted agent 수 제한
- subtree 전체 시간·토큰 예산
- 별도 읽기 전용 tool catalog
- 결과는 기존 `HostedScoutReport`/evidence capsule로 검증
- 결과 수집 실패 시 로컬 subagent로 fallback

### 5.7 이벤트

추가 이벤트:

- `native_lane.selected`
- `native_lane.fallback`
- `program.started`
- `program.tool_call_admitted`
- `program.tool_call_denied`
- `program.completed`
- `program.failed`
- `hosted_agent.requested`
- `hosted_agent.fallback_local`
- `hosted_agent.evidence_rejected`

모든 이벤트는 `turnId`, `taskEpochId`, `workspaceIdentityDigest`, `routeId`를 포함한다.

### 5.8 완료 기준

- PTC가 mutation/process/credential 도구를 호출할 수 없음
- program-issued call도 기존 permission classifier를 우회하지 않음
- 모든 `caller`/`call_id` 연계가 replay·resume 후 유지됨
- Hosted Multi-agent에는 읽기 전용 catalog만 노출됨
- 네이티브 기능 미지원·오류 시 direct/local fallback 후 동일 태스크가 계속됨
- PTC 적합 태스크에서 provider request·입력 토큰·wall time 감소
- 최종 답변 품질·필수 증거는 direct 기준보다 열화되지 않음

---

## P0-02. Task Epoch 기반 Adaptive Reasoning Continuity

### 목표

`TaskEpochManager`를 단순 세션 metadata가 아니라 OpenAI persisted reasoning의 실제 제어원으로 만든다.

### 5.9 변경 원칙

`reasoning.context = all_turns` 조건:

- root agent
- 동일 taskEpochId
- 목표·제약·우선순위가 안정적
- 현재 접근 가설이 유효
- reviewer가 아님
- toolset/model/capability/policy가 동일

`reasoning.context = current_turn` 조건:

- 모든 reviewer
- 모든 일반 subagent의 첫 요청
- 사용자 mid-turn redirect
- 접근법 폐기 또는 가설 invalidation
- 보안·정책 변경
- 모델 또는 capability 변경
- toolset 의미 변경
- 외부 workspace 변경으로 기존 증거가 stale
- 독립 리뷰 시작

### 5.10 커널 인터페이스

`KernelOptions`에 다음 중 하나를 추가한다.

```ts
reasoningScope: () => ReasoningScope
```

또는 기존 `taskEpochId` callback을 다음 구조로 확장한다.

```ts
reasoningEpoch: () => {
  id: string;
  continuity: "all_turns" | "current_turn";
  resetReason: EpochResetReason;
  goalStable: boolean;
  hypothesisInvalidated: boolean;
}
```

현재 하드코딩된 `goalStable: true`, `hypothesisInvalidated: false`를 제거한다.

### 5.11 epoch 신호 연결

다음 커널 사건이 `TaskEpochManager.transition()`으로 전달돼야 한다.

| 사건 | reset reason |
|---|---|
| 새 사용자 목표 | `goal_changed` |
| mid-turn redirect | `goal_changed` 또는 보수적으로 `constraint_changed` |
| reflection이 approach invalid 판정 | `hypothesis_invalidated` |
| 독립 reviewer 시작 | `review_requested` |
| 외부 파일 변경 감지 | `workspace_stale` |
| mutation 적용 후 다음 논리 단계 | workspace generation 갱신, 필요 시 `workspace_changed` |
| 모델 변경 | `model_changed` |
| capability manifest 변경 | `capability_changed` |
| permission/policy 변경 | `policy_changed` |
| active tool catalog 의미 변경 | `toolset_changed` |

단순 도구 호출 실패가 항상 epoch reset을 일으키지는 않는다. 기존 접근이 여전히 유효하면 같은 epoch에서 correction만 수행한다.

### 5.12 continuation 처리

epoch가 바뀌면:

- `previous_response_id` 연결 해제
- 열린 WebSocket response continuation 종료
- program/multi-agent pause 상태 정리
- full prompt 재컴파일
- 캐시 가능한 stable prefix는 유지
- 이전 reasoning item은 journal에 남기되 다음 샘플 reasoning context에는 재사용하지 않음

같은 epoch면:

- API 모드에서 `previous_response_id`/WebSocket continuation 사용
- ChatGPT 계정 모드에서 모든 이전 output item을 정확히 replay
- assistant `phase`, reasoning item, program item, tool call/output 순서 보존

### 5.13 완료 기준

- reviewer는 항상 parent reasoning 없이 독립 평가
- 접근법 폐기 후 이전 reasoning이 다음 샘플에 재사용되지 않음
- 동일 장기 목표에서는 persisted reasoning이 유지됨
- epoch 변경 시 continuation signature와 실제 provider 상태가 동시에 초기화됨
- 수동 replay 테스트가 모든 output item 종류와 phase를 보존함
- long-session 품질과 입력 토큰이 기존 대비 개선됨

---

## P0-03. 라우터를 Telemetry가 아닌 실행 계약으로 변경

### 목표

라우터가 계산한 모든 필드는 실제 실행 동작을 바꾸거나 제거돼야 한다.

### 5.14 단일 Route Decision

```ts
interface ExecutableRouteDecision {
  routeId: string;
  model: string;
  reasoningMode: "standard" | "pro";
  effort: ReasoningEffort;
  reasoningContext: "all_turns" | "current_turn";
  lane: "direct" | "programmatic" | "hosted_scout" | "local_agents";
  contextBand: string;
  maxAgents: number;
  maxParallelTools: number;
  verificationLevel: "focused" | "package" | "integration" | "independent_review";
  outputReserveTokens: number;
  reasons: string[];
}
```

### 5.15 실행 반영

- `lane` → 실제 coordinator 선택
- `maxAgents` → hosted/local scheduler의 ceiling
- `maxParallelTools` → provider request와 local tool graph 모두 반영
- `contextBand` → ContextCompiler hard/target budget
- `reasoningContext` → OpenAI request
- `verificationLevel` → Verification Contract
- `outputReserveTokens` → provider generation budget와 context pressure 계산

### 5.16 Route Execution Receipt

턴 종료 시 계획과 실제 실행을 비교해 기록한다.

```ts
interface RouteExecutionReceipt {
  routeId: string;
  planned: ExecutableRouteDecision;
  actual: {
    model: string;
    lane: string;
    agentsSpawned: number;
    parallelPeak: number;
    reasoningContext: string;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    fallbackReasons: string[];
  };
}
```

이 receipt가 있어야 “라우터가 좋아졌다”를 벤치에서 검증할 수 있다.

### 5.17 분류 정책

- 별도 모델 호출을 매 턴 추가하지 않는다.
- 우선 kernel phase, interaction mode, 변경 여부, risk, 입력 압력, 태스크 구조를 결정적 feature로 사용한다.
- 텍스트 regex는 보조 신호로만 사용한다.
- 애매한 경우 direct lane을 안전 기본값으로 선택한다.
- PTC/hosted lane은 명확한 eligibility를 통과할 때만 사용한다.

### 5.18 설정 진실성

`key-status.ts`를 사용자 설정의 단일 진실 원천으로 유지한다.

- end-to-end 소비자가 없는 키는 `experimental/no-op`으로 표시
- 기본 `/setting`에서 no-op 키 숨김
- `/config validate --explain`에서 각 키의 consumer와 fallback 출력
- 실제 수직 테스트가 통과해야 `wired`로 승격

### 5.19 완료 기준

- 기본 프로필에 사용자-visible no-op 설정 0개
- route event와 실제 receipt 간 필수 필드 불일치 0개
- fallback 발생 시 이유가 사용자와 bench artifact에 기록됨
- 같은 입력·같은 capability snapshot에서 route 결정이 재현 가능함

---

## P0-04. OpenAI 특화 Verify → Repair → Finish 루프

### 목표

기존 강한 커널을 유지하면서 변경 영향도에 맞는 검증과 reasoning epoch를 연결한다.

### 5.20 Verification Contract

각 mutation 턴은 첫 쓰기 전 또는 첫 쓰기 직후 다음 계약을 가진다.

```ts
interface VerificationContract {
  workspaceGeneration: number;
  changedPaths: string[];
  impactedPackages: string[];
  requiredChecks: Array<{
    id: string;
    command?: string;
    tool?: string;
    scope: string[];
    required: boolean;
  }>;
  reviewRequired: boolean;
  evidenceRequirements: string[];
}
```

### 5.21 영향도 계산

입력:

- changed paths
- LSP references/call hierarchy
- package/monorepo dependency graph
- git diff size와 semantic change type
- public API/schema/config 변경 여부
- migration/credential/security path 여부
- 이전 reflection이 지목한 경로

출력:

- focused check
- package-level check
- integration check
- independent reviewer 필요 여부

### 5.22 검증 순서

1. 파일 revision/hash가 mutation 결과와 일치하는지 확인
2. 가장 가까운 syntax/type/format 검사
3. 변경 패키지 단위 테스트
4. 영향받는 소비자 테스트
5. 고위험이면 독립 reviewer
6. 최종 evidence freshness 재검증
7. TODO 상태와 Completion Report 합치 확인

### 5.23 실패 처리

- 환경/권한 오류: 기존 접근 유지, blocked/partial 처리
- 테스트 오류: reflection 실행
- 논리 오류로 approach invalid: 새 epoch, rollback 가능성 평가, 재계획
- reviewer blocking finding: candidate final 폐기, repair, 필수 검사 재실행
- 동일 실패 반복: 기존 repetition ceiling 유지

### 5.24 완료 기준

- 완료 응답이 나간 뒤 required TODO가 남는 경우 0개
- stale revision을 근거로 “검증 완료” 판정하는 경우 0개
- false-complete rate 1% 미만
- critical safety regression 0개
- 저위험 수정에서 불필요한 전체 테스트 실행 감소
- 고위험 수정에서 reviewer 누락 0개

---

## P0-05. 경쟁 제품 비교 Scorecard 일반화

### 목표

CBC Bench를 그대로 살리면서 비교 대상을 일반화한다.

### 5.25 비교 종류 분리

#### A. Backbone-matched 비교

동일 GPT-5.6 모델·reasoning effort·예산으로 비교 가능한 대상:

- Capybara Code
- Pi Agent
- Prime Agent
- Codex adapter가 같은 모델 surface를 지원하는 경우

이 비교는 **하네스 차이**를 측정한다.

#### B. Product-native 비교

각 제품의 권장 기본 모델·기본 설정을 사용하는 비교:

- Claude Code native
- Codex native
- Prime Agent native/default
- Capybara recommended profile

이 비교는 **사용자가 실제 설치했을 때의 제품 결과**를 측정한다. 두 비교를 섞어 “모델이 같았다”거나 “제품이 우수하다”고 주장하지 않는다.

### 5.26 타입 일반화

현재 특정 문자열에 고정된 comparison target을 다음처럼 바꾼다.

```ts
type ComparisonTarget =
  | "capybara_baseline"
  | "external_backbone_matched"
  | "external_product_native";

interface ExternalAdapterIdentity {
  product: "codex" | "claude_code" | "pi" | "prime_agent" | string;
  version: string;
  model: string;
  authSurface: string;
  mode: "backbone_matched" | "product_native";
}
```

### 5.27 추가 cohort

기존 150개를 유지하면서 다음 태스크를 별도 OpenAI-native cohort로 추가한다.

- 대량 읽기·검색·집계 PTC 적합 태스크
- PTC 부적합 semantic pivot 태스크
- 승인/쓰기 경계 태스크
- multi-agent로 깔끔하게 분할되는 탐색·리뷰
- 분할하면 오히려 손해인 태스크
- mid-turn redirect/goal change
- reviewer independence
- long-session persisted reasoning
- cache write/read 경제성
- native lane 실패 후 fallback
- false-complete/검증 revision mismatch

### 5.28 평가 지표

- hidden acceptance success
- task quality score
- required evidence completeness
- false-complete rate
- median/p95 wall time
- provider request count
- input/output/reasoning token
- cache read/write token
- local pre-provider latency
- PTC fallback rate
- parallel peak와 idle wait
- permission scope precision
- critical safety regression
- successful-task cost

### 5.29 초기 release gate

다음 값은 현재 성능 주장 없이, 개선 브랜치의 초기 목표로 사용한다.

- 전체 품질 lower 95% CI: baseline 대비 비열화
- repository understanding/long-session: +3%p 목표
- P50 wall time: baseline의 0.80배 이하
- P95 wall time: baseline의 0.90배 이하
- PTC eligible task provider request: 0.75배 이하
- PTC eligible task input token: 0.80배 이하
- redundant read: 0.60배 이하
- eligible PTC unexpected fallback: 5% 미만
- false-complete: 1% 미만
- critical safety regression: 0

품질 gate를 통과하지 못하면 속도·토큰 감소는 개선으로 인정하지 않는다.

---

# 6. P1 수정 요구사항

## P1-01. Evidence-backed Strategy Capsules

### 목표

Claude Code의 auto memory와 Prime Agent의 Continual Harness 장점을 가져오되, 모델이 하네스 전체를 임의 수정하지 못하게 한다.

### 6.1 저장 대상

- 이 저장소에서 반복 확인된 빌드/테스트 규칙
- 사용자가 반복해서 준 선호·수정 사항
- 여러 번 검증된 성공 workflow
- 반복 실패한 접근과 피해야 할 조건
- 코드에서 직접 유도할 수 없는 운영 결정

저장하지 않는 것:

- 코드에서 쉽게 다시 읽을 수 있는 구조
- 일회성 임시 상태
- 비밀·토큰·credential
- 검증되지 않은 추측
- 모델이 만든 임의 정책 확대

### 6.2 Capsule 형식

```ts
interface StrategyCapsule {
  id: string;
  kind: "invariant" | "workflow" | "failure_pattern" | "user_preference";
  statement: string;
  scope: "session" | "workspace" | "user";
  evidenceIds: string[];
  confidence: number;
  observedCount: number;
  invalidators: string[];
  expiresAt?: string;
  createdFromRouteIds: string[];
  status: "proposed" | "active" | "contested" | "forgotten";
}
```

### 6.3 적용 정책

- 기본은 suggestion-only
- workspace/user scope 활성화는 사용자 승인 필요
- session scope도 evidence 없는 자동 저장 금지
- 최소 2~3개의 독립된 검증 궤적 요구
- 코드·policy·toolset 변경 시 invalidator 평가
- 상충 memory는 contested로 이동, recall 제외
- `/learn review`, `/learn accept`, `/learn reject`, `/learn forget`, `/learn rollback`
- immutable ROOT_POLICY는 자동 수정하지 않음

### 6.4 완료 기준

- memory로 permission이 넓어질 수 없음
- 근거 없는 capsule 활성화 0개
- 사용자가 모든 active memory를 감사·수정·삭제 가능
- 반복 태스크에서 재탐색 감소
- 변경된 저장소 조건에서 stale strategy 자동 제외

---

## P1-02. 모델이 보는 Action Surface 단순화

### 목표

Pi처럼 실험과 선택은 단순하게 만들고, Capybara의 내부 안전 계층은 유지한다.

### 6.5 상위 동작군

모델의 기본 표면:

- `inspect`
- `change`
- `verify`
- `delegate`
- `remember`

세부 도구는 Tool Search로 필요할 때 로드한다.

예시:

- `inspect` → read/search/LSP/git read
- `change` → preview/apply transaction
- `verify` → plan/run checks/review
- `delegate` → local/hosted role 선택
- `remember` → capsule 제안

내부 tool ID와 permission classifier는 유지한다. 상위 tool은 권한을 합치거나 우회하지 않고, 적절한 기존 도구 호출을 만드는 facade다.

### 6.6 프롬프트 정리

- 같은 규칙을 한 번만 명시
- 모델에게 필요 없는 호스트 내부 invariant 제거
- 실패 메시지에 이미 담긴 규칙의 중복 설명 축소
- active tool만 노출
- stable prefix와 variable suffix를 명확히 분리
- 한 번에 한 그룹씩 제거하고 CBC Bench 재실행

### 6.7 완료 기준

- 기본 tool schema token 감소
- 잘못된 tool 선택률 감소
- 동일 파일 반복 read 감소
- prompt 축소 후 품질·안전 비열화
- host 내부 계약은 기존과 동일

---

## P1-03. Claude 수준의 기본값·진단·훅 제품화

현재 플러그인/훅 기반을 새로 만들지 말고 사용성을 제품화한다.

### 기본 훅 템플릿

- `after_edit`: formatter/LSP diagnostics
- `before_final`: Verification Contract 검사
- `on_failure`: failure evidence와 epoch transition 기록
- `on_session_start`: project instructions/memory freshness 점검
- `on_compaction`: TODO/evidence capsule 보존 검사

### `/doctor openai`

출력 항목:

- active backend profile
- 모델과 실제 reasoning effort/mode
- current taskEpochId와 reasoning context
- PTC eligibility와 비활성 이유
- hosted multi-agent eligibility와 비활성 이유
- WebSocket/previous-response 상태
- cache mode, breakpoint, hit/write token
- compaction 모드와 generation
- fallback 횟수와 최근 이유
- no-op/experimental 설정

### 추천 프로필

| 프로필 | 모델 전략 | 실행 전략 | 검증 전략 |
|---|---|---|---|
| Fast | Luna/low, capability fallback | direct 우선, 작은 PTC | focused |
| Balanced | Terra/medium | PTC eligible, 필요 시 local scout | impact-based |
| Deep | Sol/high 또는 xhigh | hosted scout + local writer | independent review |
| Quality | Sol/pro, max는 측정 후 선택 | 명확한 분할만 multi-agent | full contract |

최고 effort를 무조건 기본으로 하지 않고 실제 eval이 이득을 증명할 때만 승격한다.

---

## P1-04. Persistent Goal Contract

Deep Plan/TODO/daemon을 하나의 장기 목표 계약으로 묶는다.

```ts
interface GoalContract {
  goal: string;
  successCriteria: string[];
  allowedScope: string[];
  stopConditions: string[];
  heartbeatPolicy: string;
  verificationPolicy: string;
  budget: {
    wallTimeMs: number;
    costUsd?: number;
    maxTurns: number;
  };
}
```

- 각 턴 뒤 deterministic evaluator가 완료 조건을 평가
- 미완료이면 다음 TODO를 선택
- budget/approval/blocked 조건에서는 멈추고 사용자에게 정확한 상태 제공
- daemon detach 후에도 goal/TODO/epoch/receipt 유지
- 무한 “계속 시도” 대신 명확한 stop condition과 반복 실패 ceiling 유지

---

# 7. P2 후보

다음은 P0/P1 데이터가 개선 효과를 증명한 뒤 진행한다.

## P2-01. Visual Verification Lane

- frontend 변경 후 스크린샷·접근성·레이아웃 검사
- computer use는 검증에만 우선 적용
- 외부 부작용이 있는 브라우저 조작은 approval 유지

## P2-02. OpenAI Apply Patch Adapter

- provider가 만든 patch를 직접 쓰지 않음
- Capybara Edit Plan으로 변환
- preview → permission → transaction apply → receipt
- expected revision/hash 필수

## P2-03. 원격 장기 실행

- 사용자가 명시적으로 장기 작업을 원할 때만 background API mode
- webhook/event journal을 기존 daemon/session protocol에 투영
- local session 의미와 동일한 completion/approval 계약 유지

---

# 8. 구현 파일 지도

## 8.1 Provider

### `packages/provider-openai/src/openai.ts`

- PTC/Multi-agent capability 직렬화
- backend profile별 feature gate
- `program`, `program_output`, `multi_agent_call` 파싱
- `allowed_callers`, `output_schema` 지원
- replay item 보존

### `packages/provider-openai/src/programmatic.ts`

- admission-only 구조를 incremental coordinator로 확장
- injected read-only executor
- 실제 tool output 수집
- caller lineage·예산·evidence validation

### `packages/provider-openai/src/native-lanes.ts`

- 기존 read-only allowlist 유지
- output schema와 evidence capsule 계약 추가
- direct/PTC 경계 명문화

### `packages/provider-openai/src/multi-agent.ts`

- hosted Scout/Reviewer request 생성
- HTTP/WebSocket event 처리
- concurrency ceiling
- read-only catalog 강제

### `packages/provider-openai/src/response-items.ts`

- program/multi-agent item 타입
- caller linkage
- replay/serialization round-trip 테스트

### `packages/provider-openai/src/turn-session.ts`

- response pause/resume
- WebSocket injection
- epoch 변화 시 continuation reset
- fallback 상태 관리

## 8.2 Kernel/Session

### `packages/agent-kernel/src/kernel.ts`

- adaptive reasoning scope
- 실제 lane dispatch
- route decision의 모든 필드 소비
- reflection/replan → epoch signal
- RouteExecutionReceipt 생성

### `packages/session-domain/src/epoch.ts`

- provider continuation transition 계약
- redirect/review/reflection/workspace stale reason 테스트
- snapshot/recovery와 generation 연결

### `apps/cbc/src/agent.ts`

- TaskEpoch 이벤트 연결
- native coordinator 생성
- backend profile 선택
- workspace/toolset/model/capability 변경 반영

### `apps/cbc/src/tools.ts` 또는 신규 `native-readonly-executor.ts`

- PTC/hosted agent 전용 read-only executor
- mutation/process/credential hard rejection
- bounded output/evidence 생성

## 8.3 Context/Memory

### `packages/context-engine/*`

- route별 context band 실제 적용
- program/agent evidence capsule의 utility·freshness 처리
- strategy capsule invalidator

### `packages/memory-service/src/service.ts`

- StrategyCapsule proposal/activate/contest/forget
- evidence count/confidence/expiry
- 사용자 감사 API

## 8.4 Configuration

### `packages/config-schema/src/key-status.ts`

- 수직 통합 완료 후 native 키를 `wired`로 변경
- consumer 없는 키는 기본 UI에서 제외

예시 설정:

```toml
[provider.openai]
profile = "auto" # auto | api-enhanced | chatgpt-compatible
transport = "auto" # auto | http | websocket
service_tier = "standard"

[provider.openai.native]
programmatic_tools = "auto" # off | auto | on
hosted_agents = "auto"      # off | auto | on
max_concurrent_agents = 3

[model.reasoning]
continuity = "adaptive" # current-turn | all-turns | adaptive

[model.cache]
mode = "explicit" # off | implicit | explicit
breakpoint = "stable-prefix"
ttl = "30m"

[agent.learning]
strategy_capsules = "suggest"
min_verified_observations = 3
```

## 8.5 Bench

### `benchmarks/cbc-bench/src/*`

- generic external adapter identity
- backbone-matched/product-native 분리
- native lane cohort
- route receipt ingestion
- PTC/cache/agent metrics

---

# 9. 테스트 계획

## 9.1 Unit

- PTC allowlist와 denylist
- `allowed_callers` 직렬화
- caller/call_id round-trip
- program output schema 검증
- multi-agent read-only catalog
- epoch transition 우선순위
- reasoning context 선택
- route decision→executor binding
- StrategyCapsule secret/contested/stale 처리

## 9.2 Contract

- OpenAI response fixture: program 시작→function call→output→resume→final
- multi-agent fixture: spawn→parallel calls→wait→synthesis
- WebSocket injection success/failure
- HTTP pause/resume
- ChatGPT full replay item 보존
- capability 미지원 fallback

## 9.3 Security

- program이 mutation tool 이름을 위조
- caller lineage 변조
- hosted child가 writer tool 호출
- stale workspace digest evidence 제출
- 다른 epoch evidence 재사용
- path traversal/symlink/secret output
- 프로그램 output 폭주
- agent tree budget 우회

## 9.4 E2E

1. 20개 파일에서 특정 symbol 사용처 집계: PTC
2. 넓은 아키텍처 조사: hosted scouts
3. 작은 버그 수정: direct + transaction + focused verify
4. 다중 패키지 refactor: local writers + worktree + independent review
5. 테스트 실패 후 approach invalid: epoch reset + rollback + repair
6. mid-turn 사용자 redirect: persisted reasoning reset
7. API 네이티브 장애: local fallback
8. ChatGPT 계정 모드: 동일 completion contract
9. daemon detach/resume: program/agent/epoch 상태 복구
10. stale external edit: final verification 거부

---

# 10. 단계별 출시 게이트

시간 기준이 아니라 의존성과 증거 기준으로 진행한다.

## M0. Capability Truth

- 설정 키 wired/no-op 지도 확정
- 현재 baseline CBC Bench 저장
- route planned/actual 차이 계측
- OpenAI API/ChatGPT capability snapshot 분리

**Exit**: 어떤 기능이 실제 소비되는지 자동 검증 가능.

## M1. Task Epoch & Persisted Reasoning

- 하드코딩 제거
- reflection/review/redirect/workspace signal 연결
- previous response/replay reset 계약

**Exit**: stale reasoning regression test 통과.

## M2. PTC Vertical Slice

- read/search/LSP 3~5개 도구만 허용
- program lifecycle와 caller replay
- direct fallback

**Exit**: PTC cohort에서 품질 비열화 없이 요청·토큰 감소.

## M3. Hosted Scout + Executable Routing

- 별도 read-only multi-agent request
- route decision 실제 소비
- route receipt

**Exit**: cleanly decomposable cohort에서 wall time 개선, 안전 회귀 0.

## M4. Verification & Strategy Capsules

- impact-based contract
- revision-bound evidence
- suggestion-only learning

**Exit**: false-complete와 반복 재탐색 감소.

## M5. Competitive Scorecard & Defaults

- Claude/Pi/Prime/Codex adapter
- Fast/Balanced/Deep/Quality 프로필
- `/doctor openai`

**Exit**: 기본 설정이 벤치로 증명되고 no-op 키 0.

---

# 11. 위험과 대응

| 위험 | 대응 |
|---|---|
| PTC가 핵심 citation을 잃음 | 최종 citation/native artifact 단계는 direct 호출, evidence schema 강제 |
| 프로그램이 지나치게 많은 호출 수행 | 호출·병렬·byte·시간·retry hard budget |
| Multi-agent가 비용만 늘림 | 분할 가능성 gate, 최대 동시 3, route receipt 기반 자동 비활성화 |
| 모든 agent가 같은 도구를 공유 | 별도 읽기 전용 hosted request, writer role 금지 |
| persisted reasoning이 잘못된 접근에 고착 | TaskEpoch와 reflection/review/redirect reset 연결 |
| prompt caching write 비용 증가 | stable prefix 뒤 explicit breakpoint, cache write/read 실측 |
| ChatGPT 계정과 API 결과 차이 | 공통 행동 계약 + backend-specific conformance suite |
| Strategy Memory 오염 | evidence·confidence·반복 관측·사용자 승인·contested/forget/rollback |
| beta API 변경 | capability manifest, wire fixture, kill switch, local/direct fallback |
| 프롬프트 단순화로 규칙 손실 | 한 그룹씩 제거하고 동일 cohort paired gate |

---

# 12. 하지 말아야 할 개선

1. 멀티 프로바이더 추상화를 먼저 넓히지 않는다.
2. OpenAI 기능을 지원한다는 이유로 hosted shell/write를 켜지 않는다.
3. Prime Agent의 로컬 무제한 IPython을 그대로 복제하지 않는다.
4. 베이스 시스템 프롬프트를 모델이 자동 수정하게 하지 않는다.
5. 라우터가 쓰지 않는 설정 키를 더 만들지 않는다.
6. 역할을 더 추가하기 전에 현재 역할의 자동 선택과 결과 합성을 고친다.
7. Claude Code UI를 기능별로 복제하지 않는다.
8. Pi의 간결함을 따라가면서 권한 경계를 제거하지 않는다.
9. 벤치 결과 없이 최고 reasoning effort/pro/multi-agent를 기본값으로 만들지 않는다.
10. 기능 수를 경쟁력 지표로 사용하지 않는다.

---

# 13. 최종 우선순위

## 반드시 먼저

1. **Task Epoch → `reasoning.context` 연결**
2. **PTC read-only vertical slice**
3. **라우터 lane/maxAgents/maxParallelTools 실제 소비**
4. **Hosted Scout 별도 읽기 전용 요청**
5. **Route Receipt와 경쟁 adapter 일반화**

## 그다음

6. Impact-based Verification Contract
7. Strategy Capsules
8. 모델-facing tool/prompt 축소
9. `/doctor openai`와 추천 프로필
10. Persistent Goal Contract

## 현재 유지해야 하는 차별점

- Rust 권한 경계
- transactional edit
- checksum/revision conflict protection
- evidence freshness
- TODO false-complete gate
- independent reviewer
- failure reflection + rollback
- paired statistical release gate

---

# 14. 최종 제품 정의

수정 후 Capybara Code는 “기능이 많은 또 하나의 코딩 에이전트”가 아니라 다음 제품이어야 한다.

> **GPT-5.6의 프로그램 호출·멀티에이전트·장기 추론을 적극 활용하되, 모든 실제 권한·변경·검증은 로컬의 감사 가능한 안전 계층이 소유하는 OpenAI-first coding harness.**

Claude Code보다 **검증과 권한 경계가 명확**하고, Pi보다 **안전한 기본값**을 제공하며, Prime Agent보다 **제한적이지만 증거와 롤백이 강한 프로그램 가능성**을 제공하는 것이 목표다.

핵심 성공 조건은 새로운 기능의 존재가 아니라 아래 세 가지다.

1. 모델이 올바른 lane을 자동 선택한다.
2. 선택한 lane이 실제 실행과 성능 차이를 만든다.
3. 최종 완료 주장은 항상 현재 workspace의 검증된 증거와 일치한다.

---

# 15. 근거 코드 위치

- `packages/config-schema/src/key-status.ts`: 설정별 실제 wiring 상태
- `packages/provider-openai/src/openai.ts`: API/ChatGPT capability, 요청/응답 처리
- `packages/provider-openai/src/native-lanes.ts`: read-only native lane 정책
- `packages/provider-openai/src/programmatic.ts`: admission-only programmatic lane
- `packages/subagents/src/hosted-scout.ts`: hosted scout evidence acceptance
- `packages/session-domain/src/epoch.ts`: Task Epoch/ReasoningScope
- `packages/agent-kernel/src/kernel.ts`: reasoning scope, reflection, verification, repair
- `apps/cbc/src/agent.ts`: TaskEpoch·Kernel·Context·Provider wiring
- `packages/memory-service/src/service.ts`: workspace-bound evidence memory
- `packages/agent-kernel/src/prompt.ts`: L0–L8 prompt, stable prefix, TODO/Plan contract
- `benchmarks/cbc-bench/README.md`: 150-task paired statistical gate
- `packages/evals/src/statistics.ts`: comparison target와 통계 집계

# 16. 외부 비교 기준 문서

- Anthropic Claude Code: Subagents, Hooks, Memory, Feature Overview, Agent SDK
- Pi Agent Harness: repository README, extension examples, SDK examples
- Prime Agent: 공식 소개, repository README, RLM runtime/trust model
- OpenAI API: GPT-5.6 Model Guidance, Programmatic Tool Calling, Multi-agent, Conversation State, Prompt Caching

