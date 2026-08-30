# 터미널 UI

## 슬래시 명령어

정식 표는 `packages/tui-components/src/overlays.ts:107-149`의 `SLASH_COMMANDS`입니다. 파싱은 `apps/cbc/src/slash.ts:61-146`, 실행은 `commands/interactive.ts:1621-1987`.

명령은 전부 로컬에서 처리되며 **모델에 전송되지 않습니다.** `/`가 첫 비공백 문자일 때만 인식됩니다 (`slash.ts:63`).

| 명령 | 인자 | 동작 |
| --- | --- | --- |
| `/help [topic]` | 주제(파싱되나 미사용) | 슬래시 명령 목록 + 키 목록 오버레이 |
| `/model [model]` | 모델 id 또는 별칭 | 인자 없으면 선택기. 있으면 검증 후 세션에 적용, 모델 지원에 맞게 effort clamp, 사용자 설정에 저장 |
| `/effort [effort]` | effort 또는 모드 | 인자 없으면 선택기. 있으면 `REASONING_EFFORTS`로 검증 후 clamp·저장 |
| `/setting [name] [value]` | 키, 값 | 인자 없으면 설정 메뉴. 이름만 주면 해당 행의 값 선택기. 둘 다 주면 즉시 적용. 세션에 즉시, 저장은 직렬화된 쓰기 큐로 |
| `/permissions [preset] [--save]` | `read\|edit\|auto\|yolo` | 인자 없으면 실효 정책 + 다이제스트 + 소스 출력. `yolo`는 **항상** 전역 저장, 나머지는 `--save` 필요 |
| `/mode [build\|plan] [--save] [--stop-active]` | 모드 | 인자 없으면 현재/대기 모드 표시. 있으면 전환 요청 |
| `/status` | — | 약 20줄: 세션, 모델+effort, 모드, 토큰 절약, 권한 정책, 프로젝트/설정 다이제스트, 패키지, 신뢰, 샌드박스, 소스, 대기 모드, 턴 수, 컨텍스트 토큰, Todo, 토큰, 비용, 자격 증명 |
| `/skills [action\|skill] [skill]` | `list\|show\|reload\|doctor` 또는 스킬명 | `reload`는 재스캔 후 `skills.changed` 발행. 알 수 없는 토큰은 스킬명으로 취급. 기본 `list` |
| `/mcp` | — | 설정된 MCP 서버 목록: `이름  전송  enabled\|disabled` |
| `/context` | — | `session.inspectContext()`로 컨텍스트 사용량 + 압력 |
| `/memory [inspect\|forget\|resolve] [id]` | 동작 + id | `experimental.durableMemory` && `memory.enabled` 게이트. `forget <id>`는 `memory-` 접두사 자동 부여 |
| `/graph` | — | 타임라인 `task` 항목: `sequence  role  summary\|state` |
| `/worktree` | — | `runtime.listWorktrees()` 결과 |
| `/plugins [action] [pkg]` | `list\|search\|install\|update\|remove\|inspect\|enable\|disable\|grants` | 전체 패키지 생애주기. `install path:…`는 거부하고 `capy package add … --allow-unsigned-local`로 안내 |
| `/compact` | — | `session.compactContext({userRequested:true})`. `Compacted N event(s): 이전 → 이후 예상 토큰 (트리거)` + "Original journal events were retained." |
| `/new` | — | 새 세션 부트스트랩, UI 리셋, 터미널 유지 |
| `/resume [session]` | 세션 id | 인자 없으면 세션 선택기. 있으면 해당 세션으로 전환 |
| `/quit`, `/exit` | — | 종료. `/exit`은 라우팅되지만 `SLASH_COMMANDS`에 **없어서** 완성과 `/help`에 나타나지 않습니다 |

### 키로만 열리는 오버레이

표에 없지만 단축키로 접근 가능한 것들 (`interactive.ts:2281-2404`): `agents`(내장 `SUBAGENT_ROLES` + 권한 클래스), `jobs`(활성 태스크 + 백그라운드 작업), `diff`(`runtime.gitDiff` 파일 목록 + ± 합계), `todo`, `details`(최근 200개 타임라인 이벤트), `command_palette`.

### 턴 실행 중

**`/mode`만 동작합니다** (`interactive.ts:820-827`). 나머지는 "Commands cannot be used while running. Press Esc to stop the turn first."를 출력합니다.

### 알 수 없는 명령

`unknown command '<name>'` 경고와 함께 최대 5개 제안을 표시합니다 (`slash.ts:139-145`).

---

## 키보드 단축키

실효 맵은 `packages/tui-components/src/keymap.ts:143-196`의 `DEFAULT_KEYMAP`입니다. 사용자는 `[keymap]` 설정으로 액션 이름 기준 재매핑할 수 있으며 (`keymap.ts:444-464`), 알 수 없는 액션은 조용히 무시되지 않고 보고됩니다.

> `keymap` 설정 섹션의 상태는 **experimental**입니다 — 현재 바인딩은 `tui-components`에 고정되어 있습니다.

### 편집과 제출

| 키 | 동작 |
| --- | --- |
| `Enter` | 제출 |
| `Shift+Enter`, `Ctrl+J` | 줄바꿈 |
| 줄 끝의 `\` + `Enter` | 줄바꿈 (`composer.ts:902-905`) |
| `Ctrl+A` | 논리적 줄 시작 |
| `Ctrl+E` | 논리적 줄 끝 |
| `Home` / `End` | 동일 |
| `Ctrl+K` | 줄 끝까지 삭제 |
| `Ctrl+U` | 줄 시작까지 삭제 |
| `Ctrl+W` | 이전 단어 삭제 |
| `Ctrl+Y` | 삭제 버퍼 붙여넣기 |
| `Ctrl+D` | 텍스트 있으면 앞으로 삭제. **빈 컴포저에서는 2단계 EOF** — 첫 번째는 "Press Ctrl+D again to exit." 알림, 1000 ms 내 두 번째는 종료 |
| `Ctrl+R` | 역방향 히스토리 검색 (최대 100개 항목에 대한 부분 문자열 매칭) |
| `Up` / `Down` | 줄 이동. 첫/마지막 줄에서는 프롬프트 히스토리 탐색 (초안 저장). 타임라인이 스크롤된 상태면 스크롤 |

편집은 전체적으로 **grapheme cluster 단위**입니다 (`composer.ts:263-293`).

### 중단과 종료

**`Esc` 계층** (`resolveEscape`, `keymap.ts:333-382`), 안쪽부터:

1. 완성 팝업 닫기
2. 오버레이 닫기
3. 서브에이전트 대기 중단
4. 턴 취소 준비/취소

`DOUBLE_ESCAPE_WINDOW_MS = 1000` (태스크), `TURN_CANCEL_WINDOW_MS = 2000` (턴). 턴 레벨 첫 누름은 `Press Esc again to stop this turn.`를 표시합니다.

**유휴 프롬프트에서 `Esc`는 반쯤 입력된 줄을 지우고 절대 종료하지 않습니다** (`composer.ts:846-851`).

유휴 빈 컴포저에서 백그라운드 태스크가 살아 있으면 별도의 준비→취소 쌍이 있습니다: `Press Esc again to cancel background task <id>.`

**`Ctrl+C`** (`resolveCtrlC`, `keymap.ts:423-436`): 초안이 있으면 준비 없이 초안만 지웁니다. 빈 컴포저에서 첫 누름은 `Press Ctrl+C again to exit.`, `CTRL_C_EXIT_WINDOW_MS = 3000` 내 두 번째는 종료. 다른 키를 누르면 두 준비 상태 모두 해제됩니다.

### 선택기와 오버레이

| 키 | 동작 |
| --- | --- |
| `Ctrl+P` | 명령 팔레트 — 두 번째 리더가 아니라 컴포저에 `/`를 **입력**하는 방식으로 구현되어 stdin 소유자가 하나로 유지됩니다 (`composer.ts:508-519`). 비-슬래시 텍스트가 있으면 "Clear the composer before opening commands."로 거부 |
| `Alt+P`, `Ctrl+X M`, `Ctrl+M` | 모델 선택기 (`/model ` 삽입) |
| `Alt+T` | Thinking 모드 순환 |
| `Ctrl+O` | 트랜스크립트 `details` 오버레이 / 증거 아코디언 토글 |
| `Ctrl+T` | 추론 effort 순환. 턴 실행 중에는 알림에 "(applies to the next turn)" 접미사 |
| `Ctrl+B` | 사이드바 / 활성 작업 레일 토글 |
| `Ctrl+L` | 재그리기 |

**`Ctrl+X` 리더 코드**, 1500 ms 창 (`composer.ts:379-411`). 누르면 `Ctrl+X: A agents, T tasks, P todo, D diff, L sessions, C context, M models, H help` 알림이 나옵니다.

| 접미사 | 대상 |
| --- | --- |
| `A` | agents |
| `T` | tasks/jobs |
| `D` | diff |
| `L` | sessions |
| `C` | context |
| `P` | TODO |
| `Y` | durable memory |
| `G` | agent graph |
| `W` | worktrees |
| `U` | plugins |
| `M` | 모델 선택기 |
| `H` | help |

알 수 없는 접미사는 `Unknown Ctrl+X chord. Press Ctrl+X H for help.`

> **알려진 충돌:** `composer.ts:537-538`이 `Ctrl+A`에 `open_overlay agents`를 반환하지만 `DEFAULT_KEYMAP`은 같은 키를 `line_start`에 바인딩합니다. `resolveKey`가 먼저 매칭하므로 키맵이 유효한 동안 `Ctrl+A`는 `line_start`이고 switch 분기는 죽은 코드입니다.

### 완성 팝업 스코프

팝업이 열려 있으면 **모든 것보다 우선합니다** (`keymap.ts:229-232`).

| 키 | 동작 |
| --- | --- |
| `Tab`, `Enter` | 수락 |
| `Down` / `Up` | 다음 / 이전 (순환) |
| `Shift+Tab` | 이전 |
| `Esc` | 닫기 |

인자 없는 명령에서 `Enter`는 수락과 제출을 동시에 합니다 (`composer.ts:882-900`).

### 모드와 스크롤

| 키 | 동작 |
| --- | --- |
| `Shift+Tab` | 팝업이 닫혀 있으면 Build/Plan 순환 |
| `PageUp` / `PageDown` | 뷰포트 절반 페이지 |
| `Shift+Up/Down`, `Ctrl+Up/Down`, `Alt+Up/Down` | 3줄 스크롤 |
| `?` | 빈 컴포저에서 도움말 |

### 결정 카드

승인·Plan 승인·`user.ask`·질문지·입력 프롬프트는 키 스트림을 **배타적으로** 소유합니다 (`tui.ts:1175-1236`, `1257-1319`, `1819-1877`, `1895-1968`).

| 키 | 동작 |
| --- | --- |
| `Up`, `Ctrl+P` | 이전 |
| `Down`, `Ctrl+N`, `Tab` | 다음 |
| `Shift+Tab` | 이전 |
| `Home` / `End` | 처음 / 끝 |
| `Enter` | 확정 |
| `Esc`, `Ctrl+C` | `-1` — **승인이 아니라 거부** |
| `1`–`9` | 즉시 선택 + 확정 |

질문지는 추가로 (`tui.ts:1638-1816`): `Left`/`Right` 질문 이동, `Space` 다중 선택 토글(단일 선택에서는 무동작), `Ctrl+B`/`Ctrl+F` 텍스트 커서, `Ctrl+U` 지우기, `Ctrl+Enter` 제출, `Esc` 일시정지 메뉴.

### 마우스

SGR 1006, 디코딩은 `keys.ts:443-464`.

- 휠 버튼 64/65 → 3줄 스크롤
- 좌클릭·드래그·릴리스 → 선택. 릴리스 시 호스트 클립보드 브리지로 복사(OSC 52 폴백) + 토스트
- 마지막 열은 드래그 가능한 스크롤바
- **`Shift+드래그`는 의도적으로 터미널의 네이티브 선택으로 통과됩니다**

`ui.mouse = false`로 끌 수 있습니다.

---

## UI 구조

### 렌더 영역

`renderSessionFrame` (`tui-frame.ts:690-879`). 영역별 dirty 추적 키 (`tui.ts:215-225`): `layout`, `timeline`, `live`, `sidebar`, `composer`, `completion`, `status`, `overlay`, `selection`.

프레임은 하나의 dirty 경계 뒤에서 합쳐지며, 턴이 회전 중일 때 100 ms `FULL_SCREEN_SPINNER_INTERVAL_MS` 애니메이션 타이머가 돕니다 (`tui.ts:3171-3286`).

### 컴포넌트

`packages/tui-components/src`:

| 파일 | 주요 export |
| --- | --- |
| `blocks.ts` | `renderUserMessage`, `renderThinking`, `renderCommentary`, `renderToolDiscovery`, `renderToolCall`, `renderMiniDiff` (`MAX_MINI_DIFF_LINES = 4`), `renderDiffBox`, `renderTaskCard`, `renderTaskToolTree`, `renderJob`, `renderApproval`, `renderDiffSummary`, `renderNotice`, `renderPlan`, `renderFinal`, `renderReportEvidence`, `renderUpdateBanner`, `renderTimelineItem`, `projectTimeline`, `renderInputPrompt`, `renderUserAsk` |
| `chrome.ts` | `renderLiveLine`(스피너 + 단계 태그), `SPINNER_FRAMES`, `renderStatusBar`, `renderComposer`, `COMPOSER_HINT`, `renderRightSidebar`, `renderGauge`, `compactPath` |
| `overlays.ts` | 20개 오버레이 종류와 제목, `renderOverlay`(중앙 모달, 최소 폭 60), `renderSelectableList`, `renderDiffViewer`, `parseUnifiedDiff` |
| `completion.ts` | `renderCompletionPopup`(`COMPLETION_MAX_ROWS = 8`), `computeCompletions`, `acceptCompletion` |
| `timeline.ts` / `timeline-store.ts` | 증분 프로젝션, `PagedTimelineStore`(`maxResidentPages: 3`) |
| `todo.ts` | `renderTodoList`, `renderPlanContract` |
| `questionnaire.ts` | `renderQuestionnaire`, `questionnairePauseActions` |
| `toast.ts` | `TOAST_DURATION_MS = 2500`, 우상단 |
| 기타 | `selection.ts`, `clipboard.ts`, `context-usage.ts`, `markdown.ts`, `sanitize.ts`, `width.ts`, `theme.ts`, `layout.ts`, `screen.ts` |

`COMPOSER_HINT`는 `@: Files/folders · Ctrl+P: Commands · Shift+Enter: New line`입니다.

### 레이아웃 브레이크포인트

`layout.ts:1-32`, `42-72`:

| 폭 | 분류 | 컴포저 최대 줄 |
| --- | --- | --- |
| ≥120 | wide | 8 |
| 80–119 | target | 8 |
| 60–79 | narrow | 6 |
| <60 | compact (경고 표시) | 4 |

사이드바는 콘텐츠 폭의 25% + 3셀 구분선, 최소 20 / 최대 40열, 메인 최소 폭 48. ≥120에서 full, 90–119에서 compact, <90 또는 행 <16에서 숨김.

상태 필드는 우선순위가 낮은 것부터 순서대로 제거됩니다 (`layout.ts:310-348`): model, mode, activeState, gitBranch, contextPercent, reasoning, usage, workspacePath.

### 알림 제한

**최대 3개**이며 반복은 `text [xN]`으로 축약됩니다 (`tui.ts:3288-3302`). 이 때문에 여러 줄 명령 출력은 오버레이로 라우팅됩니다 (`tui.ts:798-802`).

---

## 최종 답변 렌더링

세 가지 UI 설정이 결정하며 기본값은 `chat` / `hidden` / `false`입니다.

`renderFinal` (`blocks.ts:2056-2142`) 분기:

- **서브에이전트 최종** (`agentId !== "root"`) → **아무것도 렌더링하지 않습니다.** 알림 줄로 충분합니다.
- 항목에 비-레거시 `presentation`이 있고 스타일이 `report`가 아니면 `renderChatFinal` (`:1988-2054`): 프로바이더의 산문을 마크다운으로, 박스 없음, "Final answer" 헤더 없음.
- 레거시 이벤트 또는 `style: "report"`는 박스 경로: `━` 구분선, `▎`/`|` 거터, 헤더는 상태별로 — `partial` → **"Partial result"** (경고 아이콘, 황색), `failed` → "Failed result"(적색), `cancelled` → "Cancelled result"(황색), 그 외 "Final answer"(청록).

`finalAnswerText` (`:1927-1934`)는 비-레거시 프레젠테이션에서 답변이 없으면 `report.summary`를 대체하지 않고 `""`를 반환합니다 — 구조화된 리포트는 opt-in 증거이며 답변의 대역이 아닙니다.

답변 텍스트가 없고 처분이 `cancelled`가 아니면 상태 헤더를 대신 표시합니다: "The task could not be completed"(failure), "Progress is blocked"(blocked), "Task cancelled" — 각각 `presentation.locale`에 따른 한국어 변형이 있습니다.

### 증거 규칙

| 모드 | 표시 |
| --- | --- |
| `hidden` (또는 모드 없음) | 없음 |
| `collapsed` | 한 줄 — `Changed N · Verification P/T · Attention A  [Enter: details]` |
| `expanded` | 전체 `renderReportEvidence` — 변경 파일(± + 목적), 검증 단계(passed/failed 색상 구분). `suppressDuplicates`가 답변에 이미 언급된 것을 건너뜀 |

`completed`가 아닌 리포트 상태는 색상 없이도 읽히도록 `status: <상태>` 경고 행을 명시적으로 출력합니다 (`blocks.ts:2179-2194`).

`Ctrl+O`가 아코디언을 토글합니다 (`tui.ts:681-694`). 접으면 `completionEvidenceExpanded = false`, 펴면 `true`. 알림은 "Details collapsed · Ctrl+O to expand" / "Details expanded · Ctrl+O to collapse".

접힌 상태에서도 **라이브 작업은 열려 있습니다** — 활성 도구/태스크/작업, 스트리밍 id, 실행 중 턴의 후행 커멘터리는 `liveExpandedIds`로 면제됩니다 (`tui-frame.ts:672-688`).

### `partial`이 나타나는 곳

1. 활성이 아닌 `turnStatus` — `turnActive`가 `idle, completed, cancelled, failed, partial`을 제외
2. 라이브 라인 레이블 "Turn paused" + 단계 `PARTIAL` + 경고 아이콘 + 황색
3. 프로세스 종료 코드 **8**

---

## Plan 컨트롤

Plan 모드에서는 Plan 컨트롤 행이 추가되어 네 상태 중 하나를 표시합니다 (`tui-frame.ts:166-265`):

- `Plan approved · Shift+Tab to proceed`
- `Plan execution blocked`
- `Plan needs work · type feedback + Enter`
- `Plan ready · Choose an option below`

승인은 TODO 리비전이 아니라 **plan 다이제스트**에 바인딩되므로 진행 업데이트가 변경된 계약을 승인된 것처럼 보이게 할 수 없습니다 (`tui-frame.ts:220-225`).

### Plan → Build 전환

`onCycleInteractionMode` (`interactive.ts:684-799`):

- 계약이 **없으면** (`document === undefined && items.length === 0`) 평범한 토글
- 계약이 **있으면** 준비 게이트 실행:
  - 턴 진행 중 → 거부, "Finish or stop the current turn before approving a Plan."
  - 준비 안 됨 → 차단 요인 출력
  - 이미 승인되고 다이제스트 일치 → 즉시 실행
  - 준비됐으나 미승인 → 집중 승인 선택기 `PLAN_APPROVAL_CHOICES` (`tui.ts:127-132`): "Yes, proceed", "Approve and keep planning", "Open plan (read-only)", "No, keep planning"
- 선택기가 열린 동안 다이제스트가 바뀌면 "Plan changed while approval was open; review the updated Plan again."로 중단

plain/append-only 모드에서는 선택기를 그릴 수 없으므로 "Plan is ready; continue in the full-screen interface to approve or execute it."를 표시합니다.

---

## 경로 언급과 자동 완성

### `@path`

`WorkspacePathMentionIndex` (`apps/cbc/src/path-mentions.ts`)는 동기 인메모리 인덱스이므로 `@` 입력이 디스크를 건드리지 않습니다.

- 상한: 5000 파일 + 5000 파생 폴더
- `isSensitivePath` 항목은 **인덱싱 시점에 제외됩니다** (`:95`)
- 맨 `@` 또는 `/`로 끝나는 질의는 한 디렉터리 레벨을 나열
- 랭킹 (`:343-360`): 정확(0) → 경로 접두사(1) → basename 접두사(2) → 임의 세그먼트 접두사(3) → 부분 문자열(4) → 부분 수열(5). 파일은 폴더 뒤, 얕은 것 먼저
- 결과는 `detail: "file"` 또는 `folder · N files`를 담고 `@path `(뒤에 공백)를 삽입
- 기본 상한 100개 후보

**토큰 경계:** `@`는 입력 시작이나 공백 뒤에서만 언급을 시작하므로 이메일 주소는 절대 경로가 되지 않습니다 (`:260`). `@"path with spaces"`도 `\"` 이스케이프 포함 지원.

`normalizeWorkspacePath` (`:235-245`)가 절대 경로, 드라이브 문자, `..`, 제어/양방향 문자를 거부합니다.

인덱스는 변경 턴 후 갱신되고 키 입력 없이 열린 팝업에 반영되지만, 명시적 `Esc` 해제는 다음 편집까지 존중됩니다 (`composer.ts:195-209`).

### 완성 단계

`completion.ts:38-55`의 네 단계: `path`(`@`), `skill`(`$`), `command`(입력 시작의 `/`), `argument`(수락된 명령 뒤).

인자 값은 호스트가 공급합니다 (`slash.ts:191-247`): `MODEL_REGISTRY`의 모델, effort, 권한 프리셋, `read-only`/`implementation` 설명이 붙은 `build`/`plan`, 스킬, 세션. `/model`과 `/effort`는 현재 값을 먼저 정렬하고 `current`로 표시합니다.

> `$skill` 소스는 대화형 호스트에 배선되어 있지 않습니다 — `sources`가 `commands`, `paths`, `argumentValues`만 공급하므로 (`interactive.ts:829-862`) `$` 완성은 결과가 없습니다. `/skills` 인자 완성은 스킬을 나열합니다.

### 붙여넣기

Bracketed paste(`ESC[?2004h`)가 키 스트림에서 활성화되고 (`bun-host.ts:477`) **단일 `paste` 이벤트**로 디코딩되므로 포함된 줄바꿈이 프롬프트를 제출할 수 없습니다 (`keys.ts:11-16`, `182-197`). 부분 종료 마커는 청크 경계를 넘어 유지됩니다.

3줄 초과 또는 200자 초과 붙여넣기는 칩 `[paste #N +M lines]`으로 축약되고, 작은 것은 그대로 삽입됩니다 (`composer.ts:545-565`).

칩은 원자적입니다: 화살표가 뛰어넘고, Backspace/Delete가 칩 전체를 제거하며, `expandedText()`가 제출 시 원본 바이트를 대입합니다 (`composer.ts:240-251`, `349-368`, `1027-1063`).

### 이미지

`ComposerAttachment` 타입이 `kind: "image" | "text"`와 `path`를 지원하고 호스트가 `Attached image: [Image 1] -> path`로 확인하지만, `composer.ts:38-45`의 주석에 따르면 **붙여넣기의 첨부 토큰화가 비활성화되어 있습니다.** 파이프라인은 배선되어 있으나 실제로는 `lastAttachments`가 비어 있습니다.

---

## 세션 재개

`/resume`(인자 없음)이 `buildResumeCandidates` (`resume-picker.ts:21-35`)를 소스로 완성 선택기를 엽니다.

- 최대 **30개** 세션, 최근 활동 순 (`updatedAt` → `createdAt` → `ses_YYYYMMDDHHMMSS_…` id에서 파싱한 타임스탬프)
- 각 행은 **사람이 읽는 제목만 표시**하고 **불투명한 세션 id를 삽입**합니다 — id를 선택기에서 의도적으로 감춥니다. 턴이 0이면 "Empty session", 아니면 "Untitled session"
- `acceptCompletion`이 레이블이 아니라 삽입 신원을 비교하므로 이 제목/id 분리가 동작합니다 (`completion.ts:462-479`)

맨 `/resume`에서 `Enter`를 누르면 제출이 아니라 `/resume `(뒤에 공백)를 재삽입해 선택기를 엽니다 (`composer.ts:908-911`).

선택 시 `switchToSession` (`interactive.ts:877-927`): 현재 세션 영속화 → 봇 교체 → 이전 것의 영속화 큐가 비워진 뒤 폐기 → `ui.setSessionInfo`/`resetSession`/`setEarlierHistoryLoader` → `Resumed <id> (<N> prior turn(s))` 보고.

`resetSession` (`tui.ts:2355-2417`)은 집중된 plan/ask/질문지 프로미스를 cancel로 해소해 키 소유권이 세션 간에 누출되지 않게 하고, 타임라인 id가 각 세션에서 같은 시퀀스 값으로 재시작하므로 새 `ProjectedTimeline`을 만듭니다.

가장 오래된 행으로 스크롤하면 `#requestEarlierHistory()`가 불변 페이지를 앞에 붙이고 스크롤 오프셋을 한 페이지 올립니다. 세대 카운터가 대체된 로더의 결과를 버립니다 (`tui.ts:539-608`). 이전 히스토리 페이징은 전체 화면 전용입니다.

`Ctrl+X L`의 `sessions` 오버레이는 최근 15개를 나열하고 현재 세션에 `*`를 표시합니다.

---

## 렌더링 백엔드

`decideRenderMode` (`output.ts:30-46`)가 `host.io.isTty !== true`면 `"plain"`(이유 "not a terminal"), 네이티브 렌더러가 없으면 동일, 아니면 `"opentui"`를 반환합니다.

### 1. 네이티브 OpenTUI

`apps/cbc/src/opentui-view.ts`. 대체 화면, 터미널 행마다 하나의 `TextRenderable`이므로 변경된 행만 재그리기, `targetFps: 60`, `exitOnCtrlC: false`.

Kitty 키보드 플래그는 **끕니다** — Capybara가 stdin 디코딩을 소유합니다. 120 ms `OPEN_TUI_INPUT_HANDOFF_GRACE_MS` 후 OpenTUI 자체 stdin 리스너를 분리해 능력 프로브 응답이 컴포저에 들어가지 않고 바이트가 이중 디코딩되지 않게 합니다.

SGR 마우스는 자체적으로 활성화합니다 (`ui.mouse = false`가 아닌 한). **하드웨어 커서를 보이게 유지하고 위치를 지정합니다** — Windows IME가 조합 창을 커서에 고정하기 때문입니다.

`resume()`이 행 캐시를 무효화해 강제 재그리기가 실제로 재그리게 합니다.

### 2. ANSI 전체 화면 폴백

같은 프레임을 `TerminalFrameWriter` (`terminal-writer.ts`)로 씁니다. 행 단위 diff(`ESC[row;1H ESC[2K …`), 요청 시 전체 재그리기, 백프레셔에서 프레임을 합쳐 `drain` 시 가장 최신 대기 프레임만 씁니다.

네이티브 임포트나 `OpenTuiView.create`가 던지면 여기로 폴백합니다 (`tui.ts:2158-2180`).

### 3. plain append-only

대체 화면 없음, 네이티브 스크롤백 보존.

- `open()`이 네트워크 호출 전에 배너, "Independent coding agent for GPT-5.6", 워크스페이스·신뢰·세션 줄을 출력합니다
- 컴포저는 `\r ESC[NA ESC[0J`로 제자리 재그리기
- 오버레이는 모달이 아니라 인라인 출력
- `openSettings`가 `false`를 반환하고 호스트가 `host.io.select`로 폴백
- `requestApproval`, `requestPlanApproval`, `requestUserAsk`, `requestUserQuestionnaire`가 모두 `-1`/`unavailable`로 단축, `requestPrompt`는 `host.io.prompt`에 위임
- `handleMouseEvent`와 스크롤은 무동작
- 스트리밍은 `Thinking...`/`Working...` 단계 헤더와 함께 스트림 위치에 바이트를 씁니다. **숨김/프리뷰 사고는 억제됩니다** — 스크롤백은 누출된 텍스트를 회수할 수 없습니다

plain 모드는 변경 가능한 타임라인 항목을 `#renderedSnapshots`/`#renderedSources`와 조정하고 태스크 자식을 시간순으로 평탄화합니다 — 전체 화면 경로는 ingest를 상수 시간으로 유지하기 위해 이 기계장치를 완전히 건너뜁니다.

### 비-TTY 입력

`stdin.isTTY !== true`면 `createKeyStream`이 `inertKeyStream()`을 반환하므로 (`bun-host.ts:390-392`) `readPrompt`가 팝업 없는 줄 단위 `host.io.prompt`로 폴백하고 중단은 `SIGINT`에 맡겨집니다.

TTY에서는 프롬프트 **사이에도** raw 모드를 유지해 `Esc`가 실행 중인 턴에 도달합니다. 대가는 `Ctrl+C`가 `SIGINT`가 아니라 바이트 `0x03`으로 도착하는 것이며, 그래서 둘이 같은 핸들러를 통과합니다.

청크 경계에 버퍼된 맨 `Esc`는 35 ms 유휴 간격 후 진짜 Escape로 승격됩니다 (`bun-host.ts:431-439`). CP949/UTF-8 부분 입력은 16 ms 후 flush됩니다.

### 기타 환경 차이

- `ui.animations = false` → `reducedMotion` → 정적 아이콘 스피너 + 느린 프레임 배칭
- `theme.depth === "none"` → `renderAnsi` 대신 `renderPlain`
- `capabilities.unicode`가 모든 글리프 쌍을 결정 (`▸`/`>`, 박스 그리기/`+-|`, 배너/텍스트 로고)
- `withExternalPrompt`가 네이티브 선택기가 터미널을 소유하는 동안 렌더러를 중단하고, 복귀 시 완전한 재그리기를 강제합니다 — diff는 계단/손상된 화면을 남깁니다
- `installTerminalGuards`가 `exit`, `SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection`에서 복원합니다. `restore()`는 멱등입니다
