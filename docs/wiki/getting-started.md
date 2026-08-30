# 시작하기

## 첫 실행

워크스페이스에서 실행합니다.

```bash
cd my-project
capy
```

프롬프트와 함께 시작할 수도 있습니다.

```bash
capy "이 프로젝트의 구조를 설명해줘"
```

등록되지 않은 첫 위치 인자는 오류가 아니라 프롬프트로 취급되므로 (`args.ts:226-236`), 따옴표 없이 자연어를 바로 써도 됩니다.

## 시작 시 일어나는 일

`apps/cbc/src/commands/interactive.ts:163-255`의 순서입니다.

1. **업데이트 확인이 먼저, 병렬로 시작합니다** (`:163`). 사용자가 신뢰 박스를 읽는 동안 GitHub 왕복 시간을 감춥니다. 예산 1500 ms.
2. **신뢰 프롬프트** (`:166`). 워크스페이스를 읽는 어떤 코드보다 먼저 실행됩니다.
3. 남은 업데이트 예산 소진. 후보가 있으면 여기서 프롬프트가 나옵니다 — 업데이트를 선택하면 TUI는 열리지 않습니다.
4. 설정 읽기 (관대하게 — 설정 오류가 터미널을 중간에 방치하지 않도록), 키맵 재매핑, 권한 정책 해석.
5. 화면 그리기.
6. 런타임 생성 후 신뢰 결정을 Rust 파일시스템 가드에 미러링 (`:280`).
7. 세션 부트스트랩 → 컨텍스트 워밍.

## 신뢰 승인

첫 실행 시 4개 선택지의 박스가 나옵니다 (`workspace-trust.ts:62-115`).

```
1. Yes, proceed              → trusted-once
2. Always trust this path     → trusted-always
3. Open read-only             → read-only
4. No, exit                   → 종료 (코드 0)
```

프로젝트 제어 파일(`.capybara/config.toml`, `config.local.toml`, `packages.json`, `packages.lock.json`)이 있으면 요청된 능력 목록과 신뢰 다이제스트 앞 26자를 함께 표시합니다 (`:93-100`).

### 각 선택의 의미

| 선택 | 저장됨 | 프로젝트 설정 | 프로세스 실행 | 파일 쓰기 |
| --- | --- | --- | --- | --- |
| `trusted-once` | **아니오** | 예 | 예 | 예 |
| `trusted-always` | 예 | 예 | 예 | 예 |
| `read-only` | 예 | **아니오** | 아니오 | 아니오 |
| untrusted (미결정) | — | 아니오 | 아니오 | 아니오 |

`trusted-once`는 **의도적으로 저장되지 않습니다** (`workspace-trust.ts:28-34`) — 세션 한정 답을 표준 답으로 조용히 승격시키지 않기 위해서입니다.

프로젝트 제어 스냅샷은 `trusted-always`에서만 기록됩니다.

### 다시 물어보는 경우

`state.ts:139-160`이 다음 중 하나면 `untrusted`를 반환합니다.

- 레코드 없음
- 파일시스템 신원 미제공
- 레코드에 지문 없음
- **레코드의 지문 ≠ 현재 파일시스템 신원**

마지막 항목 때문에 디렉터리를 이동·교체·재생성하면 같은 경로라도 다시 묻습니다. 신뢰는 `dev:ino`로 키잉되기 때문입니다.

캐시된 호스트 상태가 신뢰됨인데 런타임의 권위 있는 레코드가 불일치하면 "stored trust no longer matches the runtime filesystem identity; asking again" 경고 후 `untrusted`로 리셋됩니다 (`workspace-trust.ts:44-50`).

### 비대화식 실행

`capy run`은 절대 묻지 않습니다. 신뢰되지 않은 워크스페이스는 경고와 함께 `read-only`로 조용히 격하되어 분석은 계속 가능합니다 (`workspace-trust.ts:53-60`).

CI에서 신뢰 상태를 점검하려면:

```bash
capy trust --show-diff
```

JSON 리포트를 출력하고 프롬프트 없이 0으로 종료합니다.

## 화면 구성

전체 화면 프레임은 위에서 아래로 (`tui-frame.ts:690-879`):

```
배너
├─ 타임라인 (사용자 메시지 · 사고 · 도구 호출 · 태스크 카드 · 최종 답변)
├─ 빈 구분선
├─ 알림 (최대 3개, 반복은 [xN]으로 축약)
├─ 라이브 라인 (스피너 + [RUN]/[WAIT]/[TEST]/[DONE] 등 단계 태그)
├─ 결정 카드 (승인 · Plan 승인 · 질문 · 질문지 · 입력 프롬프트)
├─ 완성 팝업
└─ 컴포저 패널
상태 바
```

사이드바는 화면이 충분히 넓으면(≥90열, ≥16행) 오른쪽 열로 붙습니다.

깨끗한 새 세션은 대신 **홈 프레임**을 보여줍니다 — ASCII 로고, 중앙 컴포저(폭 70%, 최대 132열), 플레이스홀더 "Ask anything", 모드/모델/effort 푸터, 힌트 `shift+tab completion   ctrl+p commands`, 하단에 고정된 `경로 • N MCP • /status … vVERSION`.

## Build 모드와 Plan 모드

`Shift+Tab`으로 전환합니다.

| | Build | Plan |
| --- | --- | --- |
| 컴포저 강조색 | 산호색 | 청록색 |
| 파일 쓰기 | 허용 | **거부** |
| 프로세스 실행 | 허용 | **거부** |
| 사용 가능한 도구 | 전체 | `authority === "session_state"` 또는 (read + R0 + 비변경 + 비네트워크)만 |
| `todo.write`의 `document` 필드 | **스키마에서 제거됨** | 사용 가능 |
| 완료 게이트 | 루트 TODO 게이트 | Deep Plan 준비 게이트 |

Plan 모드의 읽기 전용 거부는 **계획 증거이며 실행 차단이 아닙니다** (`prompt.ts:85-86`).

두 게이트는 구조적으로 상호 배타적입니다 — 루트 TODO 게이트는 `role === "root" && mode === "build"`를, Deep Plan 게이트는 `root && plan && deepPlan on`을 요구합니다.

### 모드 전환은 정지 상태 게이트를 통과합니다

Plan 진입은 다음이 모두 끝나기를 기다립니다 (`session-domain/src/mode.ts:171-192`): 활성 writer 서브에이전트, 프로세스 작업, 열린 트랜잭션, 대기 중 승인, 쓰기 가능한 활성 도구 호출.

실행 중인 턴은 **항상 자신이 캡처한 모드로 끝납니다** (`:89`). 현재 선택된 모드를 다시 요청하면 대기 중인 변경이 취소됩니다 (`:91-97`).

## 첫 턴의 흐름

`packages/agent-kernel/src/kernel.ts:1053`의 `runTurn`입니다.

```
사용자 입력
  ↓ effort 선택 (모델 능력으로 clamp)
  ↓ 프롬프트 컴파일 (프로젝션 신원 자기 점검 포함)
  ↓ 라우팅 결정 — 턴당 정확히 한 번
  ↓ turn.started
┌─ sampling ─────────────────────────────┐
│   프로바이더 호출 (스트리밍 SSE)          │
│     → tool_calls  → tool_selection      │
│     → 최종 후보   → verifying            │
│     → incomplete  → partial (종료)       │
└────────────────────────────────────────┘
  tool_selection → 스키마 검증 → 스케줄 → Rust RPC
  ↓ observing (실패 시 reflecting)
  ↓ verifying — 게이트 스택
  ↓ 수락
CompletionReport
```

### 게이트 스택 (verifying)

순서대로 (`kernel.ts:1447-1638`):

1. **Deep Plan 준비** (루트 + plan + deepPlan on일 때만)
2. **루트 TODO 게이트** (Build 모드에서만)
3. `#verify` — 검증 실행, 필요 시 repair
4. **검증 후 TODO 재확인** — 테스트 진행 중 도착한 업데이트 대비
5. 수락

게이트가 후보 최종 답변을 보류하면 그 텍스트는 `phase: "final_answer"` → `"commentary"`로 재작성되어 커멘터리로 다시 발행됩니다 (`:227-233`). 최종 답변으로 렌더링되지 않습니다.

### 예산

`ROOT_LIMITS` (`state.ts:273-285`): 모델 스텝·도구 호출·벽시계 시간 모두 **무제한**; 동시 백그라운드 작업 4, 자식 깊이 1, repair 사이클 2, 리뷰 사이클 2, reflection 사이클 3.

도구 호출 예산이 소진되면 커널이 **정확히 한 번** 마지막 샘플을 허용합니다 (`kernel.ts:1199-1217`) — "no further tool call will be executed … write your final report now from the evidence you already gathered".

남은 도구 호출이 2개 이하가 되면 턴당 한 번 넛지가 나옵니다 (`kernel.ts:3744`).

### 같은 실패 3회

`MAX_CONSECUTIVE_SAME_FAILURE = 3` (`state.ts:271`). 같은 실패 서명이 3번 반복되면 턴이 `partial`로 멈추고 `#stopReason`이 "hit the same failure N times in a row"를 기록합니다. 예산이 소진되지 않았어도 그렇습니다 — 예산 메시지를 빌려 쓰면 도달하지 않은 한계를 보고하게 되므로 별도 이유를 씁니다.

실패 서명은 hex, 긴 해시, 단위 있는 숫자를 정규화하고 공백을 접어 160자로 자릅니다 (`observation.ts:203`).

## 첫 명령들

| 목적 | 입력 |
| --- | --- |
| 현재 상태 확인 | `/status` |
| 컨텍스트 사용량 | `/context` |
| 설정 변경 | `/setting` |
| 모델 변경 | `/model` |
| 추론 강도 변경 | `/effort` |
| 명령 팔레트 | `Ctrl+P` |
| 도움말 | `?` (빈 컴포저에서) 또는 `/help` |
| 파일 언급 | `@` 입력 후 경로 |
| 새 세션 | `/new` |
| 세션 재개 | `/resume` |
| 종료 | `Ctrl+C` 두 번 또는 `/quit` |

`Esc`는 계층적으로 동작합니다 (`keymap.ts:333-382`): 완성 팝업 닫기 → 오버레이 닫기 → 서브에이전트 대기 중단 → 턴 취소 준비/취소. **빈 프롬프트에서 Esc는 절대 종료하지 않습니다.**

## 비대화식 사용

```bash
capy run "테스트를 실행하고 실패를 요약해줘"
```

기계 판독 결과가 필요하면:

```bash
capy run "..." --result-file result.json --permission-policy fail-on-ask
```

`--result-file`은 한 줄 JSON을 모드 `0o600`으로 원자적으로 씁니다. `--permission-policy`의 기본값은 `deny-on-ask`(조용히 거부)이므로, 승인이 필요한 작업에서 실패를 명확히 보려면 `fail-on-ask`(종료 코드 4)를 쓰십시오.

종료 코드는 [CLI 레퍼런스](cli-reference.md#종료-코드)를 참고하십시오.

## 다음 단계

- 실제 워크플로 예시 → [사용 예시](usage-examples.md)
- 키보드 단축키 전체 → [터미널 UI](tui-guide.md)
- 권한 조정 → [권한과 신뢰](permissions-and-trust.md)
- 설정 키 전체 → [설정](configuration.md)
