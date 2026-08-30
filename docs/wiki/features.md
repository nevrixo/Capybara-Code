# 주요 기능

이 문서는 Capybara Code가 **실제로 구현한** 기능과 각각의 구현 위치를 정리합니다. 계획이나 의도가 아니라 코드에 있는 것만 담았습니다.

## 1. 터미널 UI

세 가지 렌더링 백엔드 — 네이티브 OpenTUI(행 단위 재그리기, 60 fps), ANSI 전체 화면 폴백, plain append-only. TTY가 없으면 자동으로 plain으로 격하됩니다.

- 20종 오버레이, 명령 팔레트, `Ctrl+X` 리더 코드
- `@` 경로 언급 (동기 인메모리 인덱스, 민감 경로는 인덱싱 시점 제외)
- Bracketed paste를 단일 이벤트로 디코딩 — 붙여넣은 줄바꿈이 프롬프트를 제출하지 않음
- grapheme cluster 단위 편집, 한글 폭 계산
- SGR 1006 마우스 (휠 스크롤, 드래그 선택, OSC 52 복사). `Shift+드래그`는 터미널 네이티브 선택으로 통과

→ [터미널 UI](tui-guide.md)

## 2. Build / Plan 이중 모드

모드는 하나의 플래그가 아니라 **여섯 개의 독립적인 강제 지점**입니다.

| 지점 | Plan에서 달라지는 것 |
| --- | --- |
| 프롬프트 정책 | `PLAN_POLICY`가 L0에 추가 |
| 도구 표면 | `isPlanSafeTool` 필터 (read + R0 + 비변경 + 비네트워크만) |
| 도구 **스키마** | `todo.write`의 `document` 필드가 Build에서 제거 |
| 권한 상한 | 워크스페이스 변경과 프로세스 실행 거부 |
| 완료 게이트 | Deep Plan 준비 게이트 (Build는 루트 TODO 게이트) |
| 인자 검증 | `validateCall`이 모드를 받음 |

모드 전환은 정지 상태 게이트를 통과합니다 — 활성 writer 서브에이전트, 프로세스 작업, 열린 트랜잭션, 대기 승인이 모두 끝나야 Plan에 진입합니다.

## 3. Deep Plan 질문지

저장소 기반 조사가 1–4개의 실질적 제품 결정을 탭 배치로 열 수 있습니다.

- `questionnaireId`로 프로바이더 재시도가 멱등 — 완료된 id는 `{kind: "replay"}` 반환
- `decisionKey`가 같은 결정 재질문을 방지. `conflicted` 결정은 비어 있지 않은 `revisitReason`으로만 재방문 가능
- 초안이 데몬 detach/resume을 넘어 유지 (`pendingQuestionnaire`에 활성 탭과 부분 답변 포함)
- 헤드리스에서는 `unavailable`을 반환하고 재개 가능한 상태로 남음
- **draft-now**는 미답변 결정을 `assumed`로 변환하며 답을 발명하지 않음
- 구조화된 Plan Contract가 답변을 반영할 때까지 조기 최종 답변을 보류

6개의 완료 규칙이 모두 통과해야 Plan이 준비됩니다. 자세한 내용은 `docs/deep-plan.md`(코드와 일치 확인됨)와 [에이전트와 컨텍스트](agent-and-context.md)를 참고하십시오.

## 4. 격리된 Rust 실행 사이드카

TS는 카탈로그와 의도를 소유하고, Rust는 실행과 강한 경계를 소유합니다. TS 측 어떤 코드도 파일시스템을 직접 만지거나 프로세스를 spawn하지 않습니다.

- 4바이트 길이 접두사 JSON-RPC 2.0 over stdio, 8 MiB 프레임 상한
- 75개 요청 메서드, 11개 알림. 스키마·TS·Rust 3자 일치를 스크립트가 강제
- 요청당 전용 스레드 + `CancelToken`, 미결 요청 128개 상한
- 5초 하트비트, 15초 degraded, 30초 fatal
- 잘못된 프레임은 치명적 — 다음 경계를 알 수 없으므로 종료 코드 10

**Linux에서만 실제 OS 격리가 강제됩니다**: Landlock 파일시스템 격리 + `unshare(CLONE_NEWNET)` 또는 seccomp 네트워크 거부. macOS의 seatbelt와 Windows의 Job Object는 구현되지 않았고, 코드가 이를 정직하게 보고합니다(적용되지 않은 백엔드를 보고하지 않음).

→ [Rust 런타임](rust-runtime.md)

## 5. 트랜잭션 파일 변경

3단계 트랜잭션(begin → stage → commit)이 다중 파일 패치를 all-or-nothing으로 만듭니다.

- 사전 이미지가 내용 주소 아티팩트 저장소에 **크래시 전에** 영속화
- 커밋 전에 `status = "applying"` 행 기록 — 이것이 크래시 신호
- 크래시 복구는 `post_hash == 디스크 현재 해시`일 때만 복원. 사용자가 그 후 편집했으면 건너뛰고 `recovery_required` 표시
- 실패 시 적용된 연산을 **역순으로** 되돌림
- 체크포인트/롤백 (커밋 후에도 유효)
- 원자적 쓰기: 같은 디렉터리의 임시 파일 → `sync_all()` → `rename` → 부모 디렉터리 fsync
- 유닉스는 디렉터리 fd + `*at` syscall + 모든 홉에 `O_NOFOLLOW`, Windows는 `FILE_SHARE_DELETE` 없이 핸들 고정

두 가지 패치 형식: 텍스트 unified diff(`fs.apply_patch`)와 구조화된 `EditPlan`(`fs.edit`, 8개 연산 · 3종 앵커).

→ [도구 레퍼런스](tools.md)

## 6. 66개 내장 도구

파일시스템 11개, LSP 17개, 메모리 2개, 프로세스/셸 5개, 아티팩트·Git·워크트리·머지 13개, 상호작용·태스크·확장 15개, 세션 상태·복합 3개.

18개가 항상 활성이고 나머지는 `tool.discover`로 활성화합니다(기본 예산 10, always-active는 예산에서 제외).

**커밋 도구는 의도적으로 없습니다.**

스케줄링은 read → 배리어 → write → 배리어 → process/external → interactive 순서를 강제합니다. 한 턴에서 겹치는 경로에 두 번 쓰는 것은 직렬화가 아니라 거부됩니다.

## 7. 권한 모델

4개 프리셋(read/edit/auto/yolo) × 9개 축. **자격 증명은 YOLO를 포함한 모든 프리셋에서 거부됩니다.**

- 설정은 단조 상한 — 축 순위를 낮추지 않는 변경은 거부
- 하드 경계가 프리셋과 저장된 규칙보다 먼저 평가
- R4–R6은 세션/프로젝트 범위 allow 규칙을 절대 받지 못함
- 셸 계열은 `session` 범위를 받지 못함 — 파싱되지 않은 하나의 프로그램을 규칙이 정직하게 서술할 수 없음
- 선택기 취소는 거부이며 절대 승인이 아님
- `allow_turn`은 규칙이 아니라 동작 해시 집합

명령 분류기가 위험을 **올릴 수만** 있습니다: `sudo` → R4, `rm -r` → R4, `git push` → R6, 패키지 publish → R6, kubectl/terraform 변경 동사 → R6. 셸 인라인 코드도 분석해 `| sh`나 워크스페이스 외부 리다이렉션을 잡습니다.

→ [권한과 신뢰](permissions-and-trust.md)

## 8. 워크스페이스 신뢰

`dev:ino` 파일시스템 신원으로 키잉되므로 디렉터리를 이동·재생성하면 다시 묻습니다.

- `trusted-once`는 **의도적으로 저장되지 않음**
- 프로젝트 제어 파일 4개에 대한 5개 컴포넌트 다이제스트
- `capy trust --show-diff`가 CI용 읽기 전용 검사 제공
- 신뢰되지 않으면: 프로젝트 설정 레이어 제거, 프로세스 실행 거부, LSP 미시작, MCP 서버는 disabled로 추가(목록에는 보임), 프로젝트 지침 미기여

## 9. 컨텍스트 엔진

결정적 컨텍스트 컴파일러가 6개 버킷에 예산을 배분합니다.

| 버킷 | target 대비 비율 |
| --- | --- |
| `stable_prefix` | 24% |
| `task_state` | 14% |
| `exact_evidence` | 28% (**하한 있음**) |
| `memory_handles` | 8% |
| `recent_dialogue` | 10% |
| `working_code` | 잔여 (약 16%) |

**단일 패스 승인 할당기입니다** — 축출도 절단도 없고, 승인 아니면 제외입니다. 필수 항목(policy/tool_schema/instruction/task)은 버킷과 target을 우회하지만 하드 상한은 우회하지 않습니다.

MMR(λ=0.45) 정렬, Jaccard 유사도, 결정적 동점 처리. 안정 접두사는 메모이즈되어 프로바이더 캐시 브레이크포인트 하나를 만듭니다.

## 10. 적응형 압축

세 정책(`off`/`legacy`/`adaptive`, 기본 `adaptive`).

압력 평가는 **다음** 요청을 예측합니다: `projected = current + pendingHistoryDelta + pendingContextPack + max(growthP95, reservedToolExpansion)`.

- 상태: `stable` → `prepare`(80% 선) → `compact` → `emergency`(비율 ≥0.9)
- `off`도 emergency에서는 압축합니다
- **프로바이더 샘플당 재컴파일 1회** 하드 경계 — 두 번째 평가도 통과하지 못하면 `CONTEXT_BUDGET_EXCEEDED`로 샘플 실패
- 압축 세대 가드가 진전 없는 압축 루프를 방지
- 손실 없는 출력 외부화가 의미적 압축 **전에** 실행
- TODO/증거 캡슐 보존, 저널은 절대 삭제되지 않음 (`journalPreserved: true`)

압축은 **추출적이며 절대 생성적이지 않습니다** — 결정적 추출은 결정을 환각할 수 없습니다.

→ [에이전트와 컨텍스트](agent-and-context.md)

## 11. 서브에이전트 오케스트레이션

서브에이전트는 프로바이더 기능이 아니라 **다른 역할·컨텍스트·권한 범위·예산으로 실행되는 같은 `AgentKernel`**입니다.

7개 내장 역할 + `agents/*.md` 커스텀 정의(단조 축소 강제).

- 태스크 계약이 spawn 전제조건 — 목표 최소 20자, 6개 모호 패턴 거부, writer는 쓰기 범위 필수
- 결과는 사실이 아니라 **주장** — `verifyChildResult`가 파일 해시를 런타임 트랜잭션 로그와, 명령 종료를 프로세스 이벤트와 대조. 모순이 있으면 `completed`를 `blocked`로 격하
- 부모의 원시 트랜스크립트는 절대 병합되지 않음 (SUB-004)
- 모델은 루트 경로에 고정 — 프로필이 effort는 바꿀 수 있으나 모델은 상승시킬 수 없음
- `await` 중단과 `cancel`은 다른 연산 — Esc로 프롬프트를 되찾는 것이 20초의 작업을 버리라는 뜻은 아님

## 12. 내구성 있는 재귀 AgentGraph

순수 리듀서가 노드 신원·깊이·종료 상태의 진실 소유자입니다. 스케줄러는 그래프가 승인하지 않은 노드를 발명할 수 없습니다.

- 기본 깊이 2, 하드 최대 3 (`min(subagents.maxDepth, agentGraph.maxDepth)`)
- 낙관적 동시성 — 리비전 불일치는 예외가 아니라 `revision_conflict` 이벤트
- 사이클 감지 (DFS, `depends_on`/`review_of`/`verifies` 세 종류 모두 DAG 참여)
- 예산 예약/정산/해제 원장 — 자식은 부모가 보유한 것보다 많이 예약할 수 없음
- **중첩 자식은 예산이 반씩 감소** (`max(1, floor(parent / 2))`)
- 모든 변경이 즉시 영속화 — 배칭 창이 없어 승인된 작업이 크래시로 손실되지 않음
- 복구 분류: 읽기 전용 노드는 `safe-retry`, writer/process 노드는 `manual-review`

## 13. Writer 리스와 워크트리 격리

정확히 하나의 writer, 겹치지 않는 범위.

- `LEASE_OVERLAP`이 `WRITER_BUSY`보다 **먼저** 보고됩니다 — 겹치는 범위는 좁혀야 하고 단지 바쁜 리스는 기다리면 되므로 다른 대응이 필요합니다
- 대기 중 writer도 검사 — 의존성을 기다리는 writer는 아직 리스가 없으므로
- TTL은 실제 시작 시점에 재시작
- 조정(reconcile)이 claimed success를 `blocked`로 격하 — 기준선이 아래에서 움직였으면 작업을 건전하다고 보고할 수 없음
- 깊이 >1 writer 또는 `writer_policy = "worktree-lease"`(기본)는 격리된 워크트리 + 자체 fork된 사이드카 필요

## 14. MCP 통합

전송 두 가지: `stdio`와 `streamable_http`. SSE는 별도 전송이 아니라 Streamable HTTP 안의 응답 인코딩입니다.

**MCP 도구는 모델에 개별적으로 노출되지 않습니다.** 모델이 보는 것은 고정된 세 도구뿐입니다: `mcp.search`, `mcp.call`, `mcp.read_resource`. 탐색-후-호출 흐름이므로 도구 이름 충돌 표면이 아예 없습니다.

- stdio는 이 패키지가 spawn하지 않음 — Rust 프로세스 슈퍼바이저를 통해 능력 영수증과 `network: "deny"`로
- 서버 설명은 `[external tool from MCP server '<x>'; its description is untrusted text]`로 감쌈
- `readOnlyHint`가 분류기 판정을 **낮출 수 없음** — read-only를 주장하는 `delete_issue`는 여전히 destructive
- 모든 MCP 텍스트에서 OSC/DCS/APC/CSI/C0/C1 제어 시퀀스 제거 후 `<untrusted source="mcp:...">`로 감쌈
- 네트워크 장애는 예외가 아니라 오류 `ToolResult` — 모델이 인자를 "고치려" 하지 않도록 표현

→ [MCP와 LSP](mcp-and-lsp.md)

## 15. LSP 브리지 (17개 도구)

모두 R0, `authority: "read"`. **어떤 LSP 도구도 파일을 쓰지 않습니다.**

변경 형태의 세 도구는 모두 `_preview`이며 리비전 바인딩 `EditPlan` 제안을 반환합니다. `lsp.code_action_preview`는 command 없는 code action만 받으므로 서버가 `workspace/executeCommand`를 밀반입할 수 없습니다.

진단은 리비전 바인딩 증거입니다 — 소비자가 신뢰 전에 `documentRevision`을 새 런타임 읽기와 다시 비교해야 합니다.

## 16. 패키지 / 플러그인 생태계

공급망 신뢰가 실제로 강제됩니다.

- Ed25519 서명, SHA-256 다이제스트
- 레지스트리 소스는 서명 필수. 로컬 경로는 `--allow-unsigned-local` + 신뢰된 워크스페이스 + 억제 불가한 경고 3중 게이트
- 불변 캐시가 스테이징 시 매니페스트와 **모든** 파일을 다시 읽고 다시 해싱
- **frozen bootstrap**이 요청 수 = 잠금 항목 수를 요구하고, 새로 계산한 잠금 항목이 잠긴 것과 `JSON.stringify` 동일해야 함
- 권한 부여는 기본 비어 있음. 좁히기 불변식 — 배열은 부분집합, enum은 순위 초과 금지
- 부여가 잠금 파일에 있으므로 frozen 다이제스트 비교에 참여 — 넓힌 권한을 조용히 재도입할 수 없음
- 프로젝트 스코프 플러그인은 **반드시 WASI**여야 함. `node:vm` 아이솔레이트에 `process`/`require`/`Buffer`/`global` 전부 `undefined`
- 36개 훅 종류, 결정적 순서, 단조 권한(각 훅은 이미 좁혀진 연산을 봄)
- 서킷 브레이커 — 세대 카운터가 이전 세대의 늦은 완료로 새 서킷이 닫히는 것을 방지

→ [패키지와 플러그인](packages-and-plugins.md)

## 17. 스킬

9개 탐색 루트(`.capybara/skills`, `.opencode/skills`, `.agents/skills`, `.claude/skills`, 사용자 경로들, 내장), 5요소 우선순위 튜플.

- 파일명은 항상 `SKILL.md`
- 탐색은 **유계 접두사만** 읽음(32 KiB), 본문은 명시적 `skill.load` 시 지연 로드
- `readPrefix`가 없는 호스트에서는 루트를 거부 — "bounded file reads are unavailable on this host; refusing unbounded discovery"
- 제한된 YAML 프론트매터 — 태그·앵커·별칭·머지 키·중첩 컨테이너 거부
- 심볼릭 링크 사이클 감지, 프로젝트 스코프는 세 번의 이탈 검사
- 인젝션 지시자 7종 스캔 — **사람을 위한 경고이며 자동 차단이 아님**. 키워드 매칭으로 결정하면 자격 증명 로테이션에 관한 정당한 스킬을 못 쓰게 됨
- 도구 요청은 **교집합** — 부여가 아님

6개 내장 스킬. `commit-message`는 커밋 없이 메시지만 생성 — 커밋 도구를 아예 안 만든 결정과 일치합니다.

→ [스킬](skills.md)

## 18. 통합 표면

| 표면 | 상태 |
| --- | --- |
| **VS Code 확장** | `nevrixo.capybara-code-vscode`. 5개 명령, 웹뷰 채팅, diff 리뷰 |
| **세션 데몬** | pid 락, unix 소켓/명명 파이프, 워커 소유 턴 |
| **ACP v1** | `capy acp` over stdio. 5개 메서드 구현 (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`) |
| **App Protocol** | 다이제스트 바인딩 능력 스냅샷, 4개 메서드 상태(`available`/`read-only`/`disabled`/`unsupported`) |
| **GitHub Actions** | `capy github install`이 워크플로 작성(덮어쓰기 거부). 트리거 승인 + 쓰기 코디네이터 |
| **TypeScript SDK** | `@cbc/sdk` — TS 소스 직접 제공 |
| **Python SDK** | **완전 구현됨** (스텁 아님). asyncio, 런타임 의존성 0개 |

→ [통합](integrations.md)

## 19. 프로바이더와 모델 정책

Responses API 전용. Chat Completions 경로는 없습니다.

- 두 백엔드: API와 ChatGPT 계정. 판별자는 `options.chatGpt !== undefined` 하나이며 6개 능력이 모두 그 boolean
- 모델 3개, 모두 1,050,000 컨텍스트 / 128,000 최대 출력
- **Fast mode** (`serviceTier`) — `"fast"` → 와이어 `"priority"`. **API 백엔드만 인정**
- **1M 컨텍스트** (`premiumBandPolicy`) — 272k 경계, 기본 `utility-gated`(복잡도 점수 ≥7만 허용)
- 도구 이름 전단사 코덱 — 점 ID ↔ API 호환 이름
- 원격 매니페스트는 능력을 **넓힐 수 없음** — 번들과 프로바이더가 둘 다 supported일 때만 supported
- SSRF 방어, DNS 고정, 교차 출처 리다이렉트 거부, PKCE S256 전용

→ [프로바이더와 모델](provider-and-models.md)

## 20. 검증 계약과 완료 게이트

호스트가 제공하는 검증 계약이 실행기의 명령을 권위 있게 만듭니다. 계약 밖의 "검증처럼 보이는" 명령은 `off_contract`로 하드 차단됩니다 — 추측된 패키지 매니저가 좋은 결과를 무관한 실패로 바꾸는 것을 막습니다.

`enforceTruthfulness`가 모델을 신뢰하는 대신 **격하합니다**.

- 쓰기가 권한 차단되고 `changedFiles`가 비었으면 모든 `passed`를 `not_run`으로, `completed` → `partial`
- `completed` + 필수 검사 실패 → `partial`
- `completed` + 변경 파일 있음 + 필수 검사 **0개** → `partial` + "no verification was run against these changes"
- "all tests pass" 류 주장이 검증에 뒷받침되지 않으면 "(note: verification did not confirm this)" 추가

커버리지 게이트가 `blocked`/`partial`/`complete`를 계산하고, `complete`가 아니면 `completed`를 `partial`로 격하합니다.

`partial`은 실패 레이블이 아니라 기계 상태입니다 — UI가 기록된 증거로 success/attention/blocked/failure를 분류합니다.

## 21. 재현 가능한 서명 패키지

- 4개 릴리스 타깃, 네 곳의 버전이 모두 일치해야 통과
- 경로 리매핑(`--remap-path-prefix`)으로 재현성
- SBOM CycloneDX 1.5, `bun.lock` + `Cargo.lock`에서 생성
- 스테이지에서 `.map` 파일 삭제, 체크아웃 루트 문자열 유출 검사
- 릴리스 스모크가 패키지된 사이드카를 **실제로 시작**하고 `runtime.initialize` 핸드셰이크를 완료해야 배포 가능
- npm 배포는 OIDC trusted publishing만 (`--provenance`, 토큰 없음)
- `manifest.json`이 코드 서명이 **아직 없다는 사실을 명시**

→ [개발자 가이드](contributing.md)

## 22. 저장소 불변식

스크립트가 강제하는 것들.

| 스크립트 | 강제 대상 |
| --- | --- |
| `source-truth.ts --check` | 711개 파일의 내용 신원 매니페스트 |
| `check-protocol-drift.ts` | 스키마↔TS↔Rust 3자 일치 (메서드 75/11, 오류 코드 25개, 한계, 도구, 설정 키) |
| `check-no-codex-runtime.ts` | 런타임 경계 규칙 — 매니페스트·설치된 node_modules·소스 스캔·모의 프로바이더 이음새 |
| `fixtures:check` | 5개 생성 픽스처 (터미널 이스케이프, 과대 출력, 합성 비밀, 프레임 디코더 코퍼스) |

## 알려진 미완성 영역

정직하게 명시할 것들:

- **MCP OAuth/bearer 인증이 전송에 배선되지 않았습니다** — `auth = "oauth"|"bearer"`가 자격 증명을 보내지 않으므로 실질적으로 `auth = "none"`만 동작합니다
- **LSP 설정 키 8개가 비활성**입니다 (`key-status.ts`가 일부를 `"wired"`로 표기하지만 소비자 없음)
- **데몬 소유권이 두 번 구현**되어 있고 엄격한 Rust 계층에 호출자가 없습니다. 실동작 데몬에 하트비트가 없고 제어 리스가 강제되지 않습니다
- **소스 트리 없는 컴파일 설치에서 데몬 턴이 프롬프트를 에코**합니다 (`DeferredTurnExecutor` 폴백)
- **App Protocol 알림이 소켓으로 전송되지 않습니다** — 클라이언트가 `events.replay` 폴링으로 이벤트를 받습니다
- **알림 6개가 선언만 되어 있고 발행되지 않습니다** (`sandbox.degraded` 포함)
- **릴리스 서명 키가 `TODO(release)` 플레이스홀더**입니다
- **프록시 지원이 없습니다** (환경 변수를 읽지 않음)
- **`.gitignore`를 파싱하지 않습니다** — 하드코딩된 20개 디렉터리 목록만
- `falseCompletePolicy`와 `completionRequiresFreshEvidence`가 선언되어 있으나 읽히지 않습니다 (동작은 항상 block)
- **PR CI가 없습니다** — `.github/workflows/`에 태그 트리거 `release.yml` 하나뿐
