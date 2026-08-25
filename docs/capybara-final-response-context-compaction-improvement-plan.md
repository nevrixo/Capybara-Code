# Capybara Code 최종 응답 UX 및 적응형 컨텍스트 압축 개선 기획서

> 문서 상태: 구현 기획안  
> 대상 제품: Capybara Code CLI/TUI  
> 주요 범위: 최종 응답 표시, TODO 상태 경고, 로컬 컨텍스트 압축, 프로바이더 네이티브 압축  
> 우선순위: P0~P1  
> 작성 기준: 업로드된 Repomix 저장소 스냅샷 및 제공된 TUI 화면

---

## 1. 문서 목적

현재 Capybara Code에는 다음 두 가지 사용자 경험 문제가 있다.

1. 작업을 완료했거나 유용한 결과를 만들었는데도 최종 응답이 항상 `Final answer`, `Partial result`, `Changed`, `Verification`, `Risks`와 같은 감사 보고서 형식으로 출력된다. 특히 `partial`은 실패가 아님에도 큰 경고 제목과 황색 블록으로 표시되어 실패처럼 느껴진다.
2. 컨텍스트 압축이 사용자 기대와 다르게 동작한다. 일반적으로 사용자는 컨텍스트가 거의 찼을 때 자동 압축되거나, 필요 시 명시적으로 요약을 요청하는 흐름을 기대한다. 현재 구현은 로컬 70% 기준, Token Saving별 45~70% 기준, 프로바이더 기본 80,000 토큰 기준이 혼재하고, 다음 요청의 예상 크기보다 직전 요청의 사용량에 반응하는 구조에 가깝다.

본 문서는 두 문제를 함께 해결하되 다음 원칙을 유지하는 구현안을 제시한다.

- 사용자에게는 자연스러운 대화형 답변을 제공한다.
- 내부적으로는 변경 파일, 검증 결과, 위험, TODO 상태를 구조화된 데이터로 계속 보존한다.
- 검증 미실행이나 일부 미완료는 실패가 아닌 `확인 필요` 상태로 표시한다.
- 컨텍스트 압축은 단일 고정 비율이 아니라 다음 요청의 예상 토큰 압력을 기준으로 수행한다.
- 압축 때문에 현재 작업의 TODO, 증거, 변경 파일, 검증 상태가 소실되지 않아야 한다.
- 원본 세션 저널은 삭제하지 않는다.

---

## 2. 현행 구조 요약

### 2.1 최종 응답 구조

현재 최종 응답은 개념적으로 다음 두 계층으로 분리되어 있다.

```text
모델 자연어 응답
  └─ answer / text

호스트가 관리하는 완료 보고서
  └─ status
  └─ summary
  └─ changedFiles
  └─ verification
  └─ delegatedTasks
  └─ risks
  └─ nextStep
```

이 구조 자체는 적절하다. 모델의 자연어 답변과 검증 가능한 감사 데이터를 분리할 수 있기 때문이다.

다만 현재는 모델 프롬프트가 변경 파일·검증·남은 위험을 응답에 다시 작성하도록 유도하고, TUI가 동일한 `report`를 다시 `Changed`, `Verification`, `Risks` 섹션으로 렌더링한다. 그 결과 동일 정보가 두 번 노출된다.

```text
모델 답변
  └─ 구현 결과
  └─ 검증
  └─ 남은 위험

TUI 구조화 블록
  └─ Changed
  └─ Verification
  └─ Risks
```

### 2.2 상태 표현 구조

현재 기계 상태는 다음과 같다.

```ts
type CompletionStatus =
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
```

`partial`은 실패와 별도 상태이며, 일부 결과가 유용할 수 있음을 나타낸다. 그러나 화면에서는 다음과 같이 제목이 매핑된다.

```text
completed  → Final answer
partial    → Partial result
failed     → Failed result
cancelled  → Cancelled result
```

`partial`에 경고 아이콘과 큰 황색 제목이 붙기 때문에 사용자는 이를 사실상 실패로 인식한다.

### 2.3 TODO 복구 구조

현재 TODO 컨트롤러는 다음과 같은 상태를 사용한다.

```ts
type TodoStatus =
  | "pending"
  | "active"
  | "done"
  | "blocked"
  | "skipped";
```

완료된 TODO의 범위가 변경될 때 같은 write에서 다시 `pending`으로 여는 복구 로직이 일부 존재하지만, 모델 write, live reducer, journal replay가 동일한 전이 결과를 공유하지 못하면 `TODO_INVALID_TRANSITION`이 노출될 수 있다.

이 오류는 대부분 복구 가능한 상태인데도 현재 화면에서는 작업 실패처럼 보인다.

### 2.4 컨텍스트 압축 구조

현재 압축 정책은 여러 기준이 혼재한다.

| 계층 | 현행 기준 |
|---|---:|
| 기본 로컬 압축 | 입력 예산의 70% |
| Token Saving `off` | 70% |
| Token Saving `light` | 65% |
| Token Saving `balanced` | 55% |
| Token Saving `strong` | 45% |
| 프로바이더 네이티브 압축 | 기본 80,000 토큰 |
| TUI 적색 표시 | 약 90% 이상 |

추가로 압축 준비 순서가 다음과 유사하다.

```text
백그라운드 작업 정리
→ 신규 도구 출력 계산
→ 필요 시 artifact 처리
→ compactContext()
→ context pack 준비
→ prompt compile
```

이 순서는 다음 요청에 실제로 포함될 컨텍스트 팩을 만들기 전에 압축 여부를 판단한다. 따라서 다음 요청이 갑자기 커지는 상황을 정확히 예측하기 어렵다.

---

## 3. 문제 정의

## 3.1 문제 A: 최종 응답이 대화가 아니라 감사 보고서처럼 보인다

### 사용자 영향

- 모든 답변이 유사한 형식으로 끝나서 대화가 단조롭다.
- 모델 답변과 호스트 보고서가 중복된다.
- 실제 핵심 답변보다 내부 검증 정보가 더 크게 보인다.
- `partial`이 실패처럼 느껴진다.
- 간단한 수정에도 불필요하게 긴 결과 블록이 생성된다.
- 한국어 답변 아래에 영문 `Changed`, `Verification`, `Risks`가 섞여 언어 일관성이 깨진다.

### 시스템 원인

1. 모델 프롬프트가 자체적으로 구조화 보고서를 작성하도록 요구한다.
2. TUI가 모델 답변 뒤에 구조화 보고서를 다시 붙인다.
3. `report.status`가 곧바로 화면의 제목·색상·아이콘을 결정한다.
4. `partial` 원인이 타입화되어 있지 않고, 주로 `risks` 문자열과 `nextStep`으로만 전달된다.
5. 기본 화면과 상세 감사 화면이 분리되어 있지 않다.

---

## 3.2 문제 B: 컨텍스트 압축 기준이 사용자 기대와 실제 요청 크기를 반영하지 못한다

### 사용자 영향

- 컨텍스트가 충분히 남아 보이는데도 조기 압축될 수 있다.
- 반대로 90%에 가까워졌을 때도 다음 요청 크기를 고려하지 못해 늦게 대응할 수 있다.
- Token Saving 설정이 응답 길이, 탐색량, 압축 시점까지 동시에 바꿔 동작을 예측하기 어렵다.
- 고정 80,000 토큰 프로바이더 압축은 큰 모델과 작은 모델에서 같은 의미를 갖지 않는다.
- 압축 결과가 왜 발생했는지 사용자와 개발자가 확인하기 어렵다.

### 시스템 원인

1. 압축 판단이 단일 비율 또는 절대 토큰값에 의존한다.
2. 다음 요청 후보가 아닌 직전 요청 사용량을 중심으로 판단한다.
3. Token Saving이 안전 압축과 비용 절약을 함께 제어한다.
4. 압축 결과 목표 토큰이 명시되지 않는다.
5. 장기 세션에서 전체 타임라인을 반복해서 다시 압축한다.
6. 로컬 압축과 프로바이더 압축의 책임 경계가 명확하지 않다.

---

## 4. 개선 목표

### 4.1 최종 응답 UX 목표

- 정상 완료는 자연스러운 채팅 문장으로 끝난다.
- 검증 미실행, 일부 TODO 미완료, 환경 제약은 실패가 아니라 `확인 필요`로 보인다.
- 실제 실패만 적색 실패 UI를 사용한다.
- 변경 파일·검증·위험 정보는 기본적으로 한 줄 요약 또는 접힌 상세 영역에 둔다.
- 사용자가 상세 보고서를 요청한 경우에만 전체 감사 정보를 펼친다.
- 모델 답변과 호스트 감사 정보가 중복되지 않는다.
- `CompletionReport`, 종료 코드, SDK 계약은 유지한다.

### 4.2 컨텍스트 압축 목표

- 다음 provider 요청의 예상 입력 크기를 기준으로 압축한다.
- 90%는 일반 압축 시작점이 아니라 비상 안전선으로 사용한다.
- 먼저 무손실 축소를 수행하고, 부족할 때만 의미 압축을 수행한다.
- 현재 작업의 목표, active/pending TODO, 변경 파일, 검증, 오류, exact evidence를 보존한다.
- 압축 후 목표 토큰을 검증한다.
- 동일 샘플에서 무한 압축·재컴파일이 발생하지 않는다.
- 모델 창 크기와 출력 예약량을 반영해 프로바이더 압축 기준을 동적으로 계산한다.
- 원본 journal은 유지한다.

---

## 5. 비목표

- `CompletionReport`를 제거하지 않는다.
- 검증이 부족한 결과를 무조건 `completed`로 승격하지 않는다.
- `partial` 종료 코드를 성공 코드로 변경하지 않는다.
- 원본 세션 이벤트를 삭제하지 않는다.
- 자유 형식 LLM 요약만을 세션 정본으로 사용하지 않는다.
- 단순히 로컬 압축 기준을 70%에서 90%로 바꾸는 것으로 종료하지 않는다.
- 모든 내부 감사 정보를 기본 화면에서 숨기지 않는다. 실패·보안·권한 관련 핵심 정보는 항상 표시한다.

---

# 6. 개선안 A: 채팅 우선 최종 응답 UX

## 6.1 기계 상태와 화면 상태 분리

기존 `CompletionStatus`는 호환성을 위해 유지한다.

```ts
type CompletionStatus =
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
```

화면 표현 전용 상태를 신규 도입한다.

```ts
type CompletionDisposition =
  | "success"
  | "attention"
  | "blocked"
  | "failure"
  | "cancelled";

interface CompletionPresentation {
  disposition: CompletionDisposition;
  issues: CompletionIssue[];
  evidenceMode: "summary" | "expanded";
}

interface CompletionIssue {
  code:
    | "verification_not_run"
    | "verification_stale"
    | "todo_unfinished"
    | "todo_transition_rejected"
    | "permission_blocked"
    | "budget_exhausted"
    | "provider_incomplete"
    | "tool_failure"
    | "review_not_run"
    | "environment_limitation";

  severity: "attention" | "blocking" | "error";
  message: string;
  nextAction?: string;
  evidenceIds?: string[];
}
```

### 분류 원칙

| 조건 | `report.status` | 화면 상태 | 기본 색상 |
|---|---|---|---|
| 작업과 필수 검증 완료 | `completed` | `success` | 기본/청록 |
| 변경 반영, 일부 확인만 남음 | `partial` | `attention` | 황색 |
| 권한·TODO·환경으로 진행 불가 | `partial` | `blocked` | 황색 |
| 결과가 없거나 안전하게 확정 불가 | `failed` 또는 `partial` | `failure` | 적색 |
| 사용자 취소 | `cancelled` | `cancelled` | 중립 |

핵심 규칙은 `partial` 문자열만으로 화면을 결정하지 않는 것이다.

예:

```text
브라우저 스모크 테스트만 미실행
  → attention

파일 쓰기 권한이 거부되어 변경 없음
  → blocked

구문 오류로 변경을 롤백함
  → failure
```

---

## 6.2 기본 화면을 답변 우선으로 변경

### 정상 완료 예시

```text
랜딩 페이지를 하나로 통합했습니다. `index.html`이 기존
`landing.css`와 `game.js`를 직접 사용하도록 정리했고,
게임 조작과 최고 점수 저장 로직은 유지했습니다.

정적 연결과 DOM ID 검사는 통과했습니다.

변경 1 · 검증 2/2
```

기본 화면에서 다음 고정 제목은 제거한다.

```text
Final answer
Status: completed
Changed
Verification
Risks
```

### 확인 필요 예시

```text
랜딩 페이지 통합은 반영됐습니다.

⚠ 확인이 남았습니다
원인: 현재 Windows 격리 환경에서는 브라우저 스모크 테스트를 실행할 수 없었습니다.
영향: 파일 변경은 유지되며, 정적 연결 검사는 통과했습니다.
다음 확인: `index.html`을 브라우저에서 열어 렌더링과 키 입력을 점검하세요.

변경 1 · 검증 1/2 · 확인 필요 1
```

### 진행 차단 예시

```text
랜딩 페이지 파일은 준비했지만 기존 파일 교체 권한이 거부되어 반영하지 못했습니다.

⚠ 진행이 멈췄습니다
원인: workspace write 권한이 없습니다.
변경: 없음
다음 단계: 프로젝트 신뢰 상태를 확인한 뒤 다시 실행하세요.
```

### 실제 실패 예시

```text
✕ 작업을 완료하지 못했습니다

`game.js` 구문 검사가 실패해 변경을 안전하게 확정할 수 없었습니다.
이번 시도에서 작성한 변경은 롤백했습니다.

오류: Unexpected token at game.js:368
```

---

## 6.3 감사 정보는 접힌 상세 영역으로 이동

기본 표시:

```text
변경 3 · 검증 2/3 · 확인 필요 1    [Enter: 자세히]
```

펼친 표시:

```text
변경 파일
- index.html — 랜딩 페이지와 게임 통합
- landing.css — 반응형 스타일
- game.js — 게임 로직

검증
✓ DOM 연결 확인
✓ 정적 구문 검사
○ 브라우저 스모크 테스트 — 실행 환경 제약으로 미실행

남은 확인
- 실제 브라우저 렌더링
- 키보드 입력 및 모바일 포인터 이동
```

### 자동 확장 조건

다음 경우에는 상세 영역을 자동으로 펼친다.

- 사용자가 상세 보고서를 명시적으로 요청했다.
- `disposition === "failure"`이다.
- 보안, 권한, 데이터 손실 가능성이 있다.
- 비대화형 `--verbose` 실행이다.
- 세션 export 또는 CI 결과 출력이다.

### 기본 접기 조건

다음 경우에는 한 줄 요약만 보인다.

- 정상 완료
- 확인 필요가 1~2개이고 사용자 조치가 단순함
- 변경 파일과 검증 결과가 모델 답변에 이미 자연스럽게 포함됨

---

## 6.4 모델 프롬프트 변경

현행 완료 지시는 모델이 다시 구조화 보고서를 작성하도록 유도한다. 이를 다음 방향으로 변경한다.

```text
When you finish, answer naturally in the user's language.
State what was accomplished and any material limitation.
Do not add Status, Changed, Verification, Risks, or Next step sections.
The host renders verified audit evidence separately.
```

한국어 의미:

```text
작업을 마치면 사용자의 언어로 자연스럽게 답한다.
완료한 내용과 중요한 제한 사항만 설명한다.
Status, Changed, Verification, Risks, Next step 섹션은 작성하지 않는다.
검증된 감사 정보는 호스트가 별도로 표시한다.
```

### 응답 길이 정책 수정

Token Saving의 `concise`, `minimal`은 형식이 아니라 길이만 바꾼다.

```text
concise:
  Answer naturally and briefly. Preserve material limitations.

minimal:
  Give the direct result and one necessary caveat.
  The host will render audit evidence.
```

금지할 지시:

```text
Keep final reporting minimal: changed files, verification results, and remaining risks
```

이 지시는 모델이 감사 보고서 형식을 반복하도록 만들기 때문이다.

---

## 6.5 최종 이벤트 확장

기존 이벤트에 optional 필드를 추가한다.

```ts
interface AssistantFinalPayload {
  text: string;
  answer?: string;
  report: CompletionReport;

  presentation?: CompletionPresentation;
}
```

### 호환성

- 이전 journal에는 `presentation`이 없다.
- reducer는 `presentation`이 없으면 `report`에서 파생한다.
- 신규 journal은 명시된 `presentation`을 사용한다.
- SDK는 기존 `report.status`를 계속 제공한다.
- CLI exit code는 변경하지 않는다.

---

## 6.6 중복 제거 정책

단순 문자열 정규식만으로 중복을 제거하지 않는다.

### 우선순위

1. 모델 프롬프트에서 감사 섹션 생성을 금지한다.
2. 기본 UI는 감사 정보를 접는다.
3. 상세 영역을 펼칠 때만 중복 여부를 평가한다.
4. 변경 경로, 명령, 위험 메시지를 정규화해 fingerprint를 생성한다.
5. 모델 답변에 동일 fingerprint가 존재하면 해당 상세 행을 생략한다.
6. 실패·보안·권한 관련 행은 중복이어도 숨기지 않는다.

### 예시

모델 답변:

```text
`index.html`을 만들고 DOM 연결 검사를 통과했습니다.
```

상세 보고서:

```text
변경 파일
- index.html — 랜딩 페이지 통합

검증
✓ DOM 연결 검사
```

기본 화면에서는 위 상세 보고서를 접고 `변경 1 · 검증 1/1`만 표시한다.

---

## 6.7 TODO 전이 오류 개선

### 사용자 표시

`TODO_INVALID_TRANSITION`을 곧바로 적색 실패로 표시하지 않는다.

```text
⚠ 체크리스트 상태를 자동으로 정리하지 못했습니다

원인: 완료된 TODO의 작업 범위가 변경됐지만 재개 전이가 기록되지 않았습니다.
영향: 작업 결과는 유지하고 완료 판정만 보류했습니다.
다음 단계: 해당 항목을 pending 또는 active로 다시 연 뒤 갱신된 범위를 기록합니다.
```

### 내부 상태 머신 개선

공용 전이 컴파일러를 도입한다.

```ts
interface TodoTransitionCompilation {
  normalizedItems: PlanItem[];
  trace: TodoTransitionStep[];
  recovered: boolean;
  issues: CompletionIssue[];
}

function compileTodoTransition(input: TodoTransitionInput): TodoTransitionCompilation;
```

동일 결과를 다음 모두가 사용한다.

```text
model todo.write
host recovery
live reducer
journal replay
completion gate
```

### 완료된 TODO 범위 변경 규칙

| 조건 | 처리 |
|---|---|
| 실제 추가 작업이 필요함 | `done → pending` |
| 분석 메타데이터만 추가되고 기존 증거가 충분함 | `done` 유지 |
| 증거가 부족함 | `attention`, 완료 판정 보류 |
| 다른 active TODO가 이미 있음 | 새 항목을 `pending`으로 재개 |

---

# 7. 개선안 B: 적응형 컨텍스트 압축

## 7.1 90%의 의미 재정의

90%를 일반 압축 시작점으로 사용하지 않는다.

```text
90% 이상
  = 비상 상태
  = 다음 provider 요청 전에 반드시 축소 또는 중단
```

일반 압축은 다음 요청 예상량과 필요한 여유 공간으로 판단한다.

90%까지 기다리면 다음 요소가 추가되는 순간 예산을 초과할 수 있다.

- 신규 사용자 메시지
- 도구 스키마
- context pack
- 최근 도구 출력
- 시스템 지시
- output reserve
- provider continuation metadata

---

## 7.2 ContextPressureController 도입

신규 순수 정책 모듈을 추가한다.

```ts
interface ContextPressureInput {
  currentCompiledTokens: number;
  inputBudgetTokens: number;

  pendingHistoryDeltaTokens: number;
  pendingContextPackTokens: number;
  recentRequestGrowthP95: number;
  reservedToolExpansionTokens: number;

  lastCompaction?: {
    generation: number;
    tokensAfter: number;
    newTokensSince: number;
  };

  tokenSavingLevel: TokenSavingLevel;
}

interface ContextPressureDecision {
  state: "stable" | "prepare" | "compact" | "emergency";
  projectedTokens: number;
  requiredFreeTokens: number;
  targetTokens?: number;
  reasonCodes: string[];
}
```

### 계산식

```text
projectedNext =
  currentCompiledTokens
  + pendingHistoryDeltaTokens
  + pendingContextPackTokens
  + max(recentRequestGrowthP95, reservedToolExpansionTokens)
```

```text
requiredFree =
  max(
    recentRequestGrowthP95 × safetyMultiplier,
    reservedToolExpansionTokens,
    model별 최소 여유 정책
  )
```

### 상태 판정

```text
projectedNext + requiredFree <= inputBudget
  → stable

여유는 있으나 다음 1~2개 요청에서 부족 가능성이 높음
  → prepare

예상 요청이 안전 여유를 침범함
  → compact

예상 요청이 예산을 초과하거나 현재 사용량이 90% 이상
  → emergency
```

---

## 7.3 하드코딩 제거의 정의

모든 숫자를 제거하는 것이 목표가 아니다. 정책값은 필요하다.

하드코딩 제거는 다음을 의미한다.

- 코드 내부의 단일 `0.7`, `80_000`에 전적으로 의존하지 않는다.
- 모델의 실제 입력 예산과 출력 예약량을 사용한다.
- 최근 요청 증가량을 측정한다.
- 정책값은 config schema와 policy version으로 관리한다.
- 압축 이유와 계산값을 이벤트로 기록한다.
- 모델 또는 provider capability가 바뀌면 자동으로 다시 계산한다.

---

## 7.4 압축 전 평가 순서 변경

### 현행

```text
compact
→ context pack 준비
→ prompt compile
```

### 개선

```text
1. 백그라운드 작업 정리
2. 대형 도구 출력 artifact 처리
3. 다음 요청 후보 context pack 생성
4. 후보 prompt 1차 컴파일
5. 정확한 다음 요청 토큰량 평가
6. 필요 시 로컬 압축
7. context pack과 prompt를 최대 한 번 재컴파일
8. 안전 기준 확인
9. provider 요청
```

Kernel hook 예시:

```ts
contextPressureGuard?: (
  prompt: CompiledModelRequest,
) => Promise<
  | { action: "accept" }
  | { action: "compact"; targetTokens: number }
  | { action: "emergency"; targetTokens: number }
>;
```

### 재컴파일 제한

- provider sample당 최대 1회만 재컴파일한다.
- 두 번째 컴파일도 예산을 초과하면 선택적 컨텍스트를 축소한다.
- 그래도 초과하면 명시적 오류로 종료한다.

```text
CONTEXT_BUDGET_EXCEEDED
```

무한 압축·재컴파일 루프는 허용하지 않는다.

---

## 7.5 압축 단계

## 7.5.1 1단계: 무손실 축소

의미를 요약하기 전에 중복과 불필요한 원문을 제거한다.

- 동일 도구 출력 중복 제거
- 최신 결과로 대체된 관찰 제거
- 대형 stdout/stderr artifact화
- 중복 candidate final 제거
- superseded history 제외
- 동일 checksum의 반복 파일 읽기를 단일 evidence ref로 통합
- 이전 provider continuation에서 이미 보존된 항목 재전송 방지
- 완료된 과거 도구 호출의 상세 본문을 summary + artifact handle로 교체

## 7.5.2 2단계: 의미 압축

현재 결정론적 압축 방향을 유지하되 목표 토큰을 전달한다.

```ts
compact(model, trigger, estimateTokens, {
  targetTokens,
  preserveRecentTurns,
  preserveCurrentEpoch: true,
  preserveExactEvidence: true,
});
```

### 반드시 보존할 항목

- 가장 최근 사용자 요청
- 현재 작업 목표
- active/pending TODO
- blocked TODO와 사유
- 변경 파일 및 transaction receipt
- 최신 검증 결과
- stale verification 정보
- 미해결 오류
- self-correction reflection
- exact evidence ref
- artifact handle
- 다음 행동

## 7.5.3 3단계: 비상 축소

다음 조건에서 수행한다.

- 현재 사용량이 90% 이상
- 예상 다음 요청이 입력 예산 초과
- provider context error 발생
- 일반 압축 후 target 미달

비상 축소에서는 오래된 상세 대화와 완료된 도구 본문을 더 강하게 줄이지만, 핵심 작업 상태는 유지한다.

---

## 7.6 세대별 Compaction Capsule

매 압축마다 전체 타임라인을 다시 순회하는 대신 세대별 capsule을 사용한다.

```ts
interface CompactionCapsule {
  id: string;
  generation: number;

  sourceRange: {
    firstSequence: number;
    lastSequence: number;
  };

  goal: string;
  decisions: string[];
  mutations: ChangedFileEvidence[];
  verification: VerificationEvidence[];
  unresolved: CompletionIssue[];
  todoSnapshot: TodoListState;
  evidenceRefs: string[];

  tokenCount: number;
  digest: string;
}
```

### provider-facing history 구성

```text
직전 compaction capsule
+ 최근 raw turn window
+ 현재 task epoch
+ exact evidence refs
+ 활성 context pack
```

### capsule 병합

capsule 수가 많아지면 계층적으로 병합한다.

```text
generation 1 + generation 2
  → generation 3 aggregate capsule
```

### 장점

- 전체 타임라인 재압축 비용 감소
- 압축 범위 추적 가능
- digest 기반 replay 검증 가능
- resume 시 동일 상태 복구 가능
- 원본 journal 유지
- 결정·파일·검증이 자유 형식 요약에 종속되지 않음

### 모델 보조 요약 사용 범위

모델 보조 요약을 추가하더라도 비정본 필드로 제한한다.

```ts
interface CompactionCapsule {
  // authoritative fields ...
  narrativeHint?: string;
}
```

`narrativeHint`는 읽기 편의를 위한 설명일 뿐, TODO·검증·변경 판정에는 사용하지 않는다.

---

## 7.7 Token Saving과 안전 압축 분리

### 개선된 책임 분리

```text
ContextPressureController
  └─ 입력 예산 초과 방지
  └─ 항상 활성
  └─ tokenSaving=off에서도 emergency 압축 수행

TokenSavingPolicy
  └─ 선택적 컨텍스트 목표량
  └─ 탐색량
  └─ 압축 후 목표 여유의 공격성

ResponseVerbosityPolicy
  └─ 자연어 응답 길이
  └─ 최종 UI 구조에는 영향 없음
```

### 예시

`strong` 모드는 다음을 할 수 있다.

- 더 작은 target token을 선택한다.
- 낮은 우선순위 context를 더 일찍 제외한다.
- 탐색 ceiling을 낮춘다.

그러나 다음은 바꾸지 않는다.

- 실패 판정
- 검증 기준
- 보안 기준
- 최종 응답 UI 구조
- 90% emergency safety line

---

## 7.8 프로바이더 네이티브 압축

고정 80,000 토큰 대신 모델별 동적 threshold를 사용한다.

```text
providerNativeThreshold =
  min(
    modelWindow - outputReserve - emergencyMargin,
    adaptiveLocalTarget + providerHeadroom
  )
```

### 책임 경계

- 로컬 Compaction Capsule이 정본이다.
- provider native compaction은 서버 측 continuation 크기를 제한하는 보조 장치다.
- provider가 native compaction을 지원하지 않아도 로컬 정책만으로 안전해야 한다.
- provider 압축 후 실제 usage를 reconcile한다.
- provider가 opaque compaction을 수행했어도 local capsule은 유지한다.

---

## 7.9 수동 `/compact`

수동 압축은 유지한다.

개선 출력 예시:

```text
컨텍스트를 압축했습니다.
사용량: 84.2k → 51.7k
보존: 최근 대화 3개, active TODO 2개, exact evidence 14개
원본 세션 기록은 유지됩니다.
```

수동 요청은 사용량과 관계없이 한 번 수행하며 `manual` trigger를 기록한다.

---

# 8. 설정 설계

기본 설정은 단순하게 유지한다.

```toml
[ui.finalAnswer]
style = "chat"             # chat | report
evidence = "collapsed"     # hidden | collapsed | expanded
attentionDetails = true

[model.context]
compactionPolicy = "adaptive"  # off | legacy | adaptive
providerCompaction = "auto"    # off | auto | on
minFreeTokens = "auto"
targetFreeTokens = "auto"
emergencyRatio = 0.90
```

### 고급 실험 설정

초기에는 공개하지 않아도 된다.

```toml
[experimental.contextPressure]
growthWindow = 6
growthPercentile = 0.95
recompileLimit = 1
capsuleMergeLimit = 4
```

### 설정 의미

| 설정 | 의미 |
|---|---|
| `ui.finalAnswer.style=chat` | 자연어 답변 우선 |
| `ui.finalAnswer.style=report` | 기존 보고서 중심 출력 |
| `evidence=collapsed` | 한 줄 감사 요약 |
| `compactionPolicy=legacy` | 기존 비율 기반 압축 |
| `compactionPolicy=adaptive` | 예상 요청 기반 압축 |
| `providerCompaction=auto` | capability 지원 시 동적 threshold 사용 |
| `emergencyRatio=0.90` | 최후 안전선 및 UI 적색 기준 |

---

# 9. 이벤트 및 관찰성

## 9.1 기존 이벤트 확장

```ts
interface SessionCompactedPayload {
  trigger:
    | "manual"
    | "projected_pressure"
    | "tool_output"
    | "emergency_pressure"
    | "provider_context_error";

  policyVersion: number;
  generation: number;

  budgetTokens: number;
  currentTokens: number;
  projectedTokens: number;
  targetTokens: number;
  tokensAfter: number;

  exactEvidenceRetained: number;
  artifactsCreated: number;
  sourceFirstSequence: number;
  sourceLastSequence: number;

  providerThreshold?: number;
}
```

## 9.2 신규 이벤트

```text
context.pressure_evaluated
context.compaction_planned
session.compacted
context.compaction_target_missed
context.compaction_emergency
```

### 텔레메트리 정책

- `context.pressure_evaluated`: 성능 텔레메트리 설정을 따른다.
- `session.compacted`: 항상 journal에 기록한다.
- `context.compaction_target_missed`: 항상 기록한다.
- exact evidence 본문은 이벤트에 포함하지 않는다.
- token 수와 reason code만 기록한다.

### 제거 또는 변경할 트리거명

```text
soft_budget_70
```

실제 ratio가 45%, 55%, 65%일 수 있으므로 의미가 틀린 이름이다. 다음과 같이 교체한다.

```text
projected_pressure
legacy_ratio
emergency_pressure
```

---

# 10. 변경 파일 계획

| 영역 | 대상 파일 | 변경 내용 |
|---|---|---|
| 모델 완료 정책 | `packages/agent-kernel/src/prompt.ts` | 감사 섹션 작성 의무 제거, 자연어 답변 계약 추가 |
| 응답 길이 정책 | `packages/agent-kernel/src/token-saving.ts` | 응답 길이와 압축 정책 분리 |
| 완료 분류 | `packages/agent-kernel/src/observation.ts` | `CompletionIssue`, `CompletionPresentation` 추가 |
| 최종 이벤트 | `packages/agent-kernel/src/kernel.ts` | `assistant.final.presentation` 생성 |
| 압력 guard | `packages/agent-kernel/src/kernel.ts` | candidate prompt 평가 및 1회 재컴파일 hook |
| 세션 reducer | `packages/session-domain/src/reducer.ts` | presentation 및 pressure 상태 replay |
| TODO 전이 | `packages/session-domain/src/todo.ts` | 공용 transition compiler 및 trace |
| 압축 정책 | `packages/session-domain/src/compaction.ts` | target-token 기반 capsule 생성 |
| 신규 모듈 | `packages/session-domain/src/context-pressure.ts` | 적응형 압력 계산 |
| 세션 orchestration | `apps/cbc/src/agent.ts` | candidate compile → pressure 평가 → compact → recompile |
| TUI 최종 응답 | `packages/tui-components/src/blocks.ts` | chat-first 렌더링, attention card |
| TUI timeline | `packages/tui-components/src/timeline.ts` | evidence 접기/펼치기 |
| TUI 키 처리 | `apps/cbc/src/tui.ts`, `apps/cbc/src/input-reader.ts` | 최종 evidence accordion 제어 |
| 일반 출력 | `apps/cbc/src/output.ts` | non-TTY chat/report 정책 |
| Provider | `packages/provider-openai/src/openai.ts` | 동적 native compaction threshold |
| Provider request | `packages/provider-openai/src/types.ts` | 동적 context management metadata |
| 설정 | `packages/config-schema/src/schema.ts` | 신규 UI 및 context 정책 |
| 설정 직렬화 | `packages/config-schema/src/toml.ts` | TOML 지원 |
| JSON schema | `schemas/config/config.schema.json` | 설정 스키마 반영 |
| 문서 | `docs/runtime-features.md`, `README.md` | 상태 의미, 설정, `/compact` 안내 |

---

# 11. 테스트 계획

## 11.1 최종 응답 단위 테스트

### 정상 완료

- 자연어 답변이 먼저 표시된다.
- `Final answer` 고정 제목이 없어야 한다.
- `Status: completed`가 없어야 한다.
- `Changed`, `Verification`, `Risks`가 기본 펼침 상태로 보이지 않아야 한다.
- `변경 N · 검증 N/N` 요약이 표시된다.

### 확인 필요

- `partial`이어도 `Failed`라는 단어가 없어야 한다.
- 황색 `확인이 남았습니다`가 표시되어야 한다.
- 원인, 영향, 다음 확인이 있어야 한다.
- exit code는 기존 partial code를 유지해야 한다.

### 진행 차단

- 권한 거부와 단순 검증 미실행을 구분해야 한다.
- 변경 없음이 명시되어야 한다.
- 사용자 조치가 구체적으로 표시되어야 한다.

### 실제 실패

- 적색 실패 아이콘과 제목을 사용해야 한다.
- 롤백 여부를 표시해야 한다.
- 상세 evidence가 자동 확장되어야 한다.

### 중복 제거

- 모델 답변에 파일명과 검증 명령이 이미 포함되어도 기본 화면에서 반복되지 않아야 한다.
- 보안 경고는 중복이어도 제거하면 안 된다.

### 다국어

- 한국어 사용자에게 UI 제목도 한국어로 표시한다.
- 영어 사용자에게는 영어로 표시한다.
- 경로, 명령, 식별자는 원문을 유지한다.

### NO_COLOR / ASCII

- 색상 없이도 `완료`, `확인 필요`, `진행 차단`, `실패`가 텍스트로 구분되어야 한다.

---

## 11.2 TODO 테스트

- `pending → active → done` 정상 전이
- host evidence가 충분한 `pending → done` 컴파일
- 완료 항목 범위 변경 시 `done → pending`
- 분석 메타데이터만 추가 시 `done` 유지
- 다른 active TODO 존재 시 새 범위는 `pending`
- rejected write 복구 후 mutation error 제거
- live 실행과 journal replay의 transition trace 동일성
- 기존 journal migration
- 사용자 clear와 모델 clear 권한 차이 유지

---

## 11.3 컨텍스트 압력 단위 테스트

1. 현재 60%이지만 다음 pack을 포함하면 예산 초과
   - `compact` 또는 `emergency`가 나와야 한다.

2. 현재 91%
   - 무조건 `emergency`가 나와야 한다.

3. 현재 70%, 최근 증가량 작음
   - 안전 여유가 충분하면 `stable`이어야 한다.

4. 대형 도구 출력 예정
   - `reservedToolExpansionTokens`를 반영해야 한다.

5. 최근 요청 증가량 p95가 큼
   - 더 큰 `requiredFreeTokens`를 계산해야 한다.

6. 입력 예산이 다른 모델
   - 같은 절대 토큰에서 다른 결정을 내려야 한다.

7. `tokenSaving=strong`
   - safety line은 같고 targetTokens만 더 작아야 한다.

8. 잘못된 config
   - fail-safe로 adaptive 기본값 또는 legacy 안전값을 사용해야 한다.

---

## 11.4 압축 통합 테스트

- context pack 준비 후 예상량을 계산한다.
- 압축 후 prompt가 최대 한 번만 재컴파일된다.
- 두 번째 컴파일도 초과 시 선택적 컨텍스트가 축소된다.
- 그래도 초과 시 `CONTEXT_BUDGET_EXCEEDED`가 발생한다.
- 대형 도구 출력은 의미 압축보다 먼저 artifact화된다.
- active TODO와 최신 검증이 압축 후 유지된다.
- exact evidence handle이 유지된다.
- stale read는 압축 후 재노출되지 않는다.
- 원본 journal 이벤트 수와 해시 체인이 유지된다.
- resume 후 capsule digest가 검증된다.
- 동일 샘플에서 반복 압축이 발생하지 않는다.

---

## 11.5 프로바이더 테스트

- 모델 window와 output reserve로 threshold를 계산한다.
- capability가 없으면 context management 필드를 전송하지 않는다.
- API backend와 account backend 차이를 유지한다.
- native compaction 후 usage reconcile이 동작한다.
- 고정 80k legacy 설정은 legacy mode에서만 사용된다.
- provider context error 후 local emergency compaction과 full replay를 최대 한 번 수행한다.

---

## 11.6 Golden TUI 테스트

다음 화면을 폭별로 golden fixture로 추가한다.

- 정상 완료
- 확인 필요
- 진행 차단
- 실패
- 상세 evidence 펼침
- 한국어 좁은 터미널
- ASCII fallback
- NO_COLOR
- 긴 파일명 및 긴 검증 메시지

---

# 12. 롤아웃 계획

## 12.1 1단계: Chat-first 표시만 적용

기능 플래그:

```toml
[ui.finalAnswer]
style = "chat"
```

변경 내용:

- 내부 `CompletionReport` 유지
- TUI만 자연어 답변 우선으로 변경
- evidence 기본 접기
- `partial`을 `attention`과 `blocked`로 표현

이 단계는 내부 완료 판정과 exit code를 건드리지 않으므로 가장 낮은 위험으로 첫 번째 문제를 해결한다.

## 12.2 2단계: CompletionIssue 타입화

- 문자열 `risks` 파싱 의존도 축소
- producer 단계에서 issue code 생성
- 이전 journal은 파생 로직 사용
- UI는 typed issue를 우선 사용

## 12.3 3단계: Context Pressure shadow mode

```toml
[model.context]
compactionPolicy = "legacy"
```

adaptive controller는 결정을 기록만 하고 실제 압축은 기존 로직으로 수행한다.

비교 지표:

- context error 발생률
- 압축 횟수
- 압축 전후 토큰
- prompt 재컴파일 횟수
- provider retry
- 작업 완료율
- exact evidence 누락
- 평균 응답 지연

## 12.4 4단계: 적응형 로컬 압축

```toml
compactionPolicy = "adaptive"
providerCompaction = "off"
```

먼저 로컬 정책만 활성화한다.

## 12.5 5단계: 동적 provider 압축

```toml
providerCompaction = "auto"
```

capability 지원 시 모델별 threshold를 전송한다.

## 12.6 6단계: legacy 제거

다음 기준을 만족한 뒤 제거한다.

- context error 감소 또는 동일
- 완료율 회귀 없음
- exact evidence 누락 없음
- p95 지연 허용 범위 내
- resume/replay 불일치 없음
- 최소 2개 provider transport에서 검증

---

# 13. 위험과 대응

| 위험 | 설명 | 대응 |
|---|---|---|
| 경고 과소 표시 | `partial`을 너무 가볍게 보여 실제 문제를 놓칠 수 있음 | typed severity, 보안·권한 자동 확장 |
| 정보 은닉 | 감사 정보가 접혀 사용자가 변경 내용을 못 볼 수 있음 | 한 줄 요약과 Enter 상세 제공 |
| 중복 검출 오탐 | 모델 답변과 evidence가 일부만 유사할 수 있음 | 행 단위 fingerprint, 실패 정보는 제거 금지 |
| 압축 지연 증가 | candidate compile 후 재컴파일로 latency 증가 | 최대 1회 제한, shadow 측정 |
| 압축 루프 | target 미달로 반복 압축 가능 | generation guard, recompile limit |
| capsule drift | resume 시 capsule과 journal이 불일치할 수 있음 | source range와 digest 검증 |
| exact evidence 손실 | 의미 압축에서 원문이 사라질 수 있음 | evidence ref/handle 필수 보존 |
| provider opaque compaction | 서버 압축 결과를 직접 검증하기 어려움 | local capsule을 정본으로 유지 |
| Token Saving 품질 저하 | strong 모드가 중요한 증거를 제외할 수 있음 | safety invariant와 필수 evidence pinning |

---

# 14. 구현 작업 분해

## P0-1. Chat-first 최종 응답

- [ ] `CompletionPresentation` 타입 추가
- [ ] report → presentation 파생 함수 추가
- [ ] `renderFinal`에서 고정 `Final answer` 제목 제거
- [ ] `attention`, `blocked`, `failure` 카드 구현
- [ ] evidence 한 줄 요약 구현
- [ ] evidence accordion 연결
- [ ] 한국어 UI copy 추가
- [ ] plain/non-TTY 출력 정책 추가
- [ ] 기존 journal fallback 추가

## P0-2. 모델 보고서 중복 제거

- [ ] ROOT_POLICY 완료 지시 변경
- [ ] Token Saving 응답 지시 변경
- [ ] 감사 섹션 작성 금지 테스트
- [ ] 모델 답변과 report 분리 회귀 테스트

## P0-3. TODO 복구 일관성

- [ ] 공용 transition compiler 도입
- [ ] transition trace event 추가
- [ ] live/replay 동일성 테스트
- [ ] 완료 항목 rescope 자동 reopen
- [ ] `TODO_INVALID_TRANSITION` presentation mapping

## P0-4. Context Pressure shadow mode

- [ ] `context-pressure.ts` 추가
- [ ] candidate prompt 토큰 평가
- [ ] pressure event 추가
- [ ] legacy decision과 adaptive decision 비교 telemetry

## P1-1. Target-token 로컬 압축

- [ ] `compact()`에 `targetTokens` 추가
- [ ] 필수 보존 항목 pinning
- [ ] 압축 후 target 검증
- [ ] 재컴파일 1회 제한
- [ ] target 미달 fallback

## P1-2. Compaction Capsule

- [ ] capsule schema 추가
- [ ] source range와 digest
- [ ] snapshot persistence
- [ ] resume 검증
- [ ] capsule merge

## P1-3. 동적 native compaction

- [ ] 모델별 threshold 계산
- [ ] request context management 반영
- [ ] provider capability fallback
- [ ] usage reconcile

## P2. 세부 UX 및 운영 도구

- [ ] `/context`에 pressure state 표시
- [ ] `/compact` 보존 항목 요약
- [ ] `--report` 호환 모드
- [ ] telemetry dashboard 지표
- [ ] 사용자별 evidence 기본 상태 설정

---

# 15. 완료 기준

## 최종 응답 UX

- [ ] 정상 완료 응답에서 보고서형 제목이 기본 노출되지 않는다.
- [ ] 모델 답변과 구조화 evidence가 중복되지 않는다.
- [ ] 검증 미실행은 실패가 아닌 `확인 필요`로 표시된다.
- [ ] 실제 실패만 적색 실패 표현을 사용한다.
- [ ] 변경 파일·검증·위험은 접힌 상세 영역에서 확인할 수 있다.
- [ ] 상세 보고서 요청 시 자동 확장된다.
- [ ] 한국어 입력에는 한국어 UI 문구를 사용한다.
- [ ] CLI/SDK의 `CompletionReport`와 종료 코드는 유지된다.
- [ ] 기존 journal replay가 동일한 의미로 표시된다.

## TODO

- [ ] 완료 TODO의 범위 변경이 자동으로 재개된다.
- [ ] live와 replay가 동일한 transition trace를 생성한다.
- [ ] 복구 가능한 TODO 오류가 실패처럼 표시되지 않는다.
- [ ] 실제 미완료 TODO는 completion gate를 계속 차단한다.

## 컨텍스트 압축

- [ ] 압축이 다음 요청 예상량을 기준으로 동작한다.
- [ ] 90% 이상에서는 provider 요청 전에 반드시 안전 조치가 수행된다.
- [ ] 압축 후 target token 충족 여부를 검증한다.
- [ ] 현재 TODO, 변경 내역, 검증, 오류, exact evidence가 유지된다.
- [ ] 원본 journal은 완전히 보존된다.
- [ ] 동일 sample에서 압축 재컴파일은 최대 1회다.
- [ ] 모델별 native threshold가 동적으로 계산된다.
- [ ] Token Saving 수준이 최종 응답 UI 구조를 바꾸지 않는다.
- [ ] provider가 native compaction을 지원하지 않아도 안전하다.

---

# 16. 권장 구현 우선순위

1. **P0: Chat-first TUI와 `attention` 상태 도입**  
   내부 판정은 유지하면서 사용자에게 가장 크게 보이는 문제를 먼저 해결한다.

2. **P0: ROOT_POLICY 및 Token Saving 응답 지시 수정**  
   모델이 감사 보고서를 반복 작성하는 원인을 제거한다.

3. **P0: TODO transition compiler 통합**  
   복구 가능한 체크리스트 상태 오류가 최종 결과를 실패처럼 만드는 문제를 줄인다.

4. **P0: Context Pressure shadow mode**  
   실제 사용자 세션에서 adaptive 기준의 결정 품질을 측정한다.

5. **P1: Target-token 압축과 1회 재컴파일**  
   직전 사용량이 아니라 다음 요청 크기를 기준으로 안전하게 압축한다.

6. **P1: Compaction Capsule과 동적 provider threshold**  
   장기 세션의 재현성, 성능, provider continuation 안정성을 개선한다.

---

## 최종 설계 요약

```text
최종 응답
  모델: 자연스러운 답변만 생성
  호스트: 검증 가능한 report 유지
  UI: 답변 우선 + 한 줄 evidence + 필요 시 경고 카드
  partial: 실패가 아니라 원인에 따라 attention/blocked/failure로 표현

컨텍스트 압축
  후보 prompt를 먼저 계산
  다음 요청의 projected token pressure 평가
  무손실 축소 → 의미 압축 → 비상 축소
  target token 검증
  최대 1회 재컴파일
  local capsule을 정본으로 유지
  provider native compaction은 보조 안전장치로 사용
```
