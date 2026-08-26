# `/setting` 확장 기획서 — OpenAI Fast Mode 토글 & 1M 컨텍스트 허용 옵션

- 상태: 초안 (검토 대기)
- 작성일: 2026-08-27
- 대상: Capybara Code (`capy`) TUI `/setting` 메뉴
- 관련 명령: `/setting`, `capy config set <path> <value>`

---

## 1. 요약

`/setting` 메뉴에 두 가지 옵션을 추가한다.

| # | 옵션 | 설정 키 (기존 존재) | 값 | 기본값 |
|---|------|--------------------|----|--------|
| 1 | **Fast mode** (OpenAI 전용, On/Off) | `provider.openai.serviceTier` | `standard` / `fast` | `standard` (Off) |
| 2 | **1M context** (272k → 최대 1M 허용) | `model.context.premiumBandPolicy` | `utility-gated` / `allow` / `deny` | `utility-gated` (Off) |

핵심 발견: **두 기능의 설정 키와 런타임 배선은 이미 코드베이스에 존재하고 동작한다.**
빠진 것은 `/setting` TUI 메뉴에서의 노출과 세션 중 라이브 적용 경로뿐이다.
따라서 스키마 변경 없이 작은 서페이스 확장으로 구현 가능하다.

---

## 2. 조사 결과

### 2.1 OpenAI Fast mode (공식 문서 기준, 2026-08 확인)

출처: <https://developers.openai.com/api/docs/guides/fast-mode>

- "Priority processing"가 **2026-07-30에 "Fast mode"로 이름 변경**됨.
- Responses/Chat Completions API에서 `service_tier: "fast"`로 요청별 활성화.
  `service_tier: "priority"`도 동일하게 동작(하위 호환). 응답 객체에는
  GPT-5.6 이전 세대까지 항상 `priority`로 보고됨.
- 효과: **최대 2.5배 빠른 속도**, 더 일관된 레이턴시. `gpt-5.6-sol` 기준.
- 가격: **토큰당 프리미엄 부과** (표준 대비).
  - GPT-5.6 Sol 표준: 입력 $4 / 출력 $20 (1M 토큰당, ~2026-11-21 프로모션)
  - Fast mode 단문 컨텍스트: 입력 $8 / 출력 $40 (표준의 2배)
  - Fast mode 장문 컨텍스트(272K 초과): 입력 $16 / 출력 $60
  - 캐시 입력 할인은 Fast mode에서도 유지됨.
- 레이트 리밋: 표준 처리와 **동일한 리밋을 공유** (별도 쿼터 아님).
  트래픽 급증 시(≥1M TPM에서 15분 내 50%+ 증가) 일부 요청이 표준 속도로
  다운그레이드되고 `service_tier: "default"`로 청구될 수 있음(ramp limit).
- 프로젝트 단위 기본값 설정도 지원(요청 파라미터가 우선).
- 프로젝트 레벨이 아닌 **요청 레벨 토글**이 우리가 사용할 경로.

### 2.2 1M 컨텍스트 (공식 문서 기준, 2026-08 확인)

출처: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>

- GPT-5.6 Sol: **컨텍스트 윈도우 1,050,000** / 최대 입력 922,000 / 최대 출력 128,000.
  (코드베이스 번들 capability의 `contextWindow: 1_050_000`과 정확히 일치 —
  `packages/provider-openai/src/capabilities.ts:132`)
- 별도 베타 헤더 없이 모델 윈도우 자체가 1.05M. 즉 "1M 활성화"는
  **정책 게이트 해제** 문제이지 프로토콜 변경이 아님.
- 가격 경계: **입력 272K 초과 시 해당 요청 전체가 입력 2배 + 출력 1.5배로 청구.**
  - 272K는 하드 리밋이 아니라 **청구 경계(billing boundary)**. 코드베이스도 이를
    명시함: "272K is the published premium-pricing boundary, not a context cap."
    (`packages/provider-openai/test/provider.test.ts:119`)
- ChatGPT 계정 백엔드(`capy auth login` 계정 모드)는 별도 봉투:
  **400,000 윈도우 / 128,000 출력** → 입력 예산 **272K**
  (`CHATGPT_CODEX_CONTEXT_WINDOW`, `capabilities.ts:112-113`).
  → 사용자가 현재 사이드바에서 보는 "기본 272k"의 실체.
  계정 모드에서는 1M이 물리적으로 불가능(백엔드 상한 400k).

### 2.3 코드베이스 현재 상태

#### Fast mode 배선 (이미 완성됨)

| 지점 | 위치 | 내용 |
|------|------|------|
| 스키마 | `schemas/config/config.schema.json:1028-1035` | `provider.openai.serviceTier: standard\|fast`, 기본 `standard` |
| 기본값 | `packages/config-schema/src/schema.ts:600` | `serviceTier: "standard"` |
| 부트스트랩 | `apps/cbc/src/bootstrap.ts:345` | 실효 설정 → `buildProvider` 전달 |
| 서브에이전트 | `apps/cbc/src/subagent-bridge.ts:843` | 생성 시점에서 설정 읽음 |
| 커널 옵션 | `packages/agent-kernel/src/kernel.ts:542` | `serviceTier?: "standard" \| "fast"` — "OpenAI Fast mode (priority processing alias)" |
| 요청 반영 | `kernel.ts:2271` | `capabilities.fastTier`일 때만 요청에 포함 |
| 와이어 변환 | `packages/provider-openai/src/openai.ts:523-525` | `fast → service_tier: "priority"`, `standard → "default"` |
| capability 게이트 | `openai.ts:174-180` | `fastTier`는 **플랫폼(API 키) 백엔드에서만 true**. ChatGPT 계정 백엔드는 false |
| 키 상태 | `packages/config-schema/src/key-status.ts:147` | `wired` |
| 롤백 플래그 | `packages/config-schema/src/performance-rollbacks.ts:107` | `fast_service_tier` |
| 테스트 | `packages/provider-openai/test/service-tier.test.ts` | HTTP/WS 바디의 `service_tier` 와이어 값 검증 |

→ `capy config set provider.openai.serviceTier fast`로는 이미 동작하지만,
`/setting`에는 없고 세션 시작 후 변경이 불가능하다(커널 옵션이 고정).

#### 1M 컨텍스트 배선 (부분 완성 — 갭 1개 존재)

| 지점 | 위치 | 내용 |
|------|------|------|
| 밴드 | `packages/provider-openai/src/utility.ts:39-41` | `[64k, 192k, 272k, 512k, 1M]`, 프리미엄 임계 `272_000` |
| 스키마 | `config.schema.json:314-347` | `model.context.bands`, `defaultBand(192k)`, `premiumThresholdTokens(272k)`, `premiumBandPolicy: deny\|allow\|utility-gated` (기본 `utility-gated`) |
| 밴드 선택 | `utility.ts:53-109` `selectContextBand()` | 272k 초과 밴드는 정책에 따라 허용/거부 |
| 컴파일 시 반영 | `apps/cbc/src/agent.ts:2013-2032` | 샘플마다 `config.model.context.premiumBandPolicy`를 읽음 → **라이브 변경이 다음 샘플부터 반영 가능한 구조** |
| 라우팅 갭 | `packages/agent-kernel/src/kernel.ts:1936-1947` | `#decideRoute()`가 `decide()`에 `premiumPolicy`를 **전달하지 않음** → 라우팅 결정은 항상 기본값 `utility-gated` 사용. 설정값이 라우팅 단계까지 닿으려면 배선 필요 |
| 키 상태 | `packages/config-schema/src/key-status.ts:70` | `wired`로 표기되나 실제로는 컴파일 시점에만 소비됨 |

#### `/setting` 메뉴 구조 (확장 지점)

- 행 정의: `apps/cbc/src/commands/interactive.ts:1169` `settingDescriptors()`
  - 각 행: `key`, `label`, `value`(현재값), `values`(`{value,label}[]`),
    선택적으로 `configPath`, `apply(session, value)`
- 적용+영속화: `interactive.ts:1521-1534` `applyAndPersist()`
  - `apply()` 즉시 세션 반영 → `result.value`를 `configPath`로
    `persistAgentSetting()` → `setUserConfigValue()`가 전역 `config.toml`에 기록
  - `ui.*` 외 경로는 이 자동 영속화 대상 → **새 행은 `configPath`만 지정하면 저장 완료**
- 슬래시 파서: `apps/cbc/src/slash.ts:88-93` — `/setting <name> [value]` 형태가
  행만 등록되면 자동으로 동작
- 라이브 적용 선례: `agent.ts:2726-2781` (`setReasoningEffort`, `setModel`,
  `setTokenSaving`) — 커널/실효 설정을 동기화하는 패턴 재사용

---

## 3. 기능 설계

### 3.1 옵션 1: Fast mode (On/Off)

**UX**

```
/setting → "Fast mode (off)" 행 선택
  Off   Standard processing (default)
  On    Fast mode — up to 2.5x faster, token premium applies
```

- 행 정의: `key: "fast-mode"`, `label: "Fast mode"`,
  `configPath: "provider.openai.serviceTier"`
- picker 값 = 설정 값 그대로 (`"standard"` / `"fast"`) → 자동 영속화와
  `/setting fast-mode fast` 직접 지정이 그대로 동작
- On 선택 시 알림 메시지에 가격 프리미엄 고지:
  "Fast mode is active. Tokens cost ~2x standard ($8/$40 per M on gpt-5.6-sol; $16/$60 over 272K)."
- Off 전환 시: "Fast mode off; standard processing from the next request."

**라이브 적용 경로 (신규)**

1. `AgentKernel`에 `setServiceTier(tier)` 추가 — `#currentEffort`/`setReasoningEffort`
   패턴(`kernel.ts:940`)과 동일하게 가변 필드 `#serviceTier`를 두고,
   `kernel.ts:869`(prewarm)과 `kernel.ts:2271`(샘플 요청)에서 해당 필드를 읽도록 변경.
2. `AgentSession.setServiceTier(tier)` 추가 (`agent.ts`):
   - `this.kernel.setServiceTier(tier)`
   - `this.#options.config.provider.openai.serviceTier = tier` 동기화
     → 이후 생성되는 서브에이전트(`subagent-bridge.ts:843`)도 새 값 사용
3. 행의 `apply()`가 `session.setServiceTier()` 호출.

**백엔드 게이트**

- `capabilities.fastTier`가 false인 ChatGPT 계정 모드에서는 커널이 애초에
  `service_tier`를 보내지 않는다(`kernel.ts:2271`).
- 따라서 `apply()`에서 지원 여부를 먼저 확인하고, 미지원 시 값을 바꾸지 않고
  정직한 메시지로 거절: "Fast mode needs the API backend; this session is on the
  ChatGPT account backend." (코드베이스 원칙: "되어 보이는 것보다 안 된다고
  말하는 것이 낫다" — `interactive.ts:1360-1362`)
- `AgentSession`에 지원 여부 게터 추가 (예: `fastModeSupported`) — 프로바이더
  capability 노출. 행 자체는 항상 표시하되 거절 메시지로 안내.

**와이어 값 참고 (선택 후속 작업)**

- 현재 `openai.ts:525`는 `fast`를 `"priority"`로 변환해 전송. 문서상 둘 다
  유효하므로 동작에는 문제 없음. 최신 표기(`"fast"`)로 전환하는 것은 별도
  작은 변경으로 분리 가능(응답/대시보드 표기가 `priority`로 동일하므로 급하지 않음).

### 3.2 옵션 2: 1M context (허용 토글)

**의미 정의**

- Off(기본) = `premiumBandPolicy: "utility-gated"` — 272k 초과 밴드는 측정된
  효용+비용 상한이 있을 때만 허용 (현행 기본 동작 유지)
- On = `premiumBandPolicy: "allow"` — 512k / 1M 밴드 허용. 실제 선택은
  컴파일된 입력 토큰 수와 모델 상한에 따라 밴드 사다리에서 결정됨.
- `deny`는 수동 `config.toml` 편집 사용자용 고급 값으로 유지하고 picker에는
  노출하지 않음 (2값 토글로 단순화).

**UX**

```
/setting → "1M context (off)" 행 선택
  Off   Default — premium bands gated (272k pricing boundary)
  On    Allow up to 1M — premium pricing over 272k input (2x input / 1.5x output)
```

- 행 정의: `key: "long-context"`, `label: "1M context"`,
  `configPath: "model.context.premiumBandPolicy"`
- On 선택 시 고지: "Premium context allowed. Input over 272K is billed at 2x input
  / 1.5x output for the whole request."

**라이브 적용 경로 (신규)**

1. `AgentSession.setPremiumContextPolicy(policy)` 추가:
   `this.#options.config.model.context.premiumBandPolicy = policy` —
   `agent.ts:2013-2032`가 샘플마다 이 값을 읽으므로 **다음 샘플부터 즉시 반영**.
   `setTokenSaving` 패턴(`agent.ts:2768`) 재사용, `context.policy_changed` 계열
   이벤트 방출.
2. **라우팅 갭 해소**: `KernelOptions`에 `premiumContextPolicy` 필드 추가,
   `kernel.ts:#decideRoute()`(1936-1947)에서 `decide({ ..., premiumPolicy })`로 전달.
   `agent.ts:1076-1106` 커널 옵션 조립 시 설정 값 주입.
   `AgentSession.setPremiumContextPolicy()`가 커널 필드도 동기화해야 라우팅이
   세션 중에 따라온다.
3. 행의 `apply()`가 `session.setPremiumContextPolicy()` 호출.

**백엔드별 실제 효과 (정직한 표시)**

| 백엔드 | 윈도우 | 1M On 시 실제 상한 |
|--------|--------|--------------------|
| API 키 (플랫폼) | 1,050,000 | 512k/1M 밴드 도달 가능 (입력 예산 = 윈도우 − 출력 예비분) |
| ChatGPT 계정 | 400,000 | 밴드 사다리상 도달 가능한 최대는 여전히 272k (512k는 400k−예비분 초과) |

- 계정 모드에서 On을 선택하면 값을 저장하되 메시지에 상한을 병기:
  "Allowed, but this account backend caps the window at 400k; the 272k band stays
  the effective maximum."

### 3.3 두 옵션의 상호작용

- Fast mode 문서에 "GPT-5.6 models support long context" 명시 → 두 옵션은
  동시 사용 가능. 단, 조합 시 최고 단가 구간(장문 Fast: $16/$60)이므로
  둘 다 On일 때 상태창/알림에서 비용 가시성을 높이는 것을 권장
  (`ui.showCost` 기본 on — 기존 비용 표시 서페이스 재사용).

---

## 4. 변경 범위 체크리스트

### 신규/수정 파일

| 파일 | 변경 |
|------|------|
| `apps/cbc/src/commands/interactive.ts` | `settingDescriptors()`에 행 2개 추가, `apply()` 구현 |
| `apps/cbc/src/agent.ts` | `setServiceTier()`, `setPremiumContextPolicy()`, capability 게터, 커널 옵션에 프리미엄 정책 주입 |
| `packages/agent-kernel/src/kernel.ts` | `#serviceTier` 가변화 + `setServiceTier()`, `KernelOptions.premiumContextPolicy`, `#decideRoute()` 전달 |
| `apps/cbc/src/tui.ts` | 변경 없음 (메뉴는 데이터 구동) |
| `schemas/config/config.schema.json`, `packages/config-schema/src/schema.ts` | **변경 없음** (키 이미 존재) |
| `README.md` | `/setting` 섹션에 두 옵션 설명 추가 |

### 변경하지 않는 것

- 설정 스키마/기본값: 기존 사용자의 `config.toml`과 기본 동작이 그대로 유지됨.
- `config-template.ts`: 초기 템플릿은 최소 유지 원칙 → 새 키를 템플릿에
  추가하지 않음 (`/setting`이 기록하면 자연스럽게 파일에 등장).
- 와이어 포맷(`priority`) 유지.

---

## 5. 구현 태스크 분해

1. **T1** 커널 라이브 서비스 티어: `kernel.ts` 가변 필드 + `setServiceTier()` +
   기존 읽기 지점(869, 2271) 교체.
2. **T2** 커널 프리미엄 정책 배선: `KernelOptions.premiumContextPolicy` +
   `#decideRoute()` 전달.
3. **T3** `AgentSession` 라이브 세터 2종 + capability 게터 + 설정 동기화.
4. **T4** `settingDescriptors()` 행 2개 + `apply()` (거절/고지 메시지 포함).
5. **T5** 테스트 (아래 6절).
6. **T6** README 갱신.
7. **T7** 검증 스위트: `bun run typecheck` → `bun test` → `bun run test:rust` →
   `bun run build` (README "Verification" 절차).

순서: T1 → T3(티어 부분), T2 → T3(정책 부분) → T4 → T5 → T6/T7.
T1/T2는 독립이라 병렬 가능.

---

## 6. 테스트 계획

기존 자산 재활용 + 신규:

- `packages/provider-openai/test/service-tier.test.ts` — 와이어 매핑 회귀(기존 유지 확인).
- 신규: 커널 `setServiceTier()` 이후 다음 샘플 바디에 `service_tier` 반영/제거.
- 신규: `fastTier: false` 프로바이더에서 `service_tier`가 절대 나가지 않는지
  (계정 백엔드 시뮬레이션).
- 신규: `premiumContextPolicy: "allow"` 시 `#decideRoute()` 결과가
  512k/1M 밴드를 `allowed: true`로 반환 (272k 초과 입력 샘플).
- 신규: `settingDescriptors` 스냅샷 — 행 2개 존재, 값/라벨,
  `apply()`의 메시지(계정 모드 거절 포함).
- 기존 `packages/config-schema/test/performance-config.test.ts`가
  `provider.openai.serviceTier: "fast"` 머지를 이미 검증 → 영속화 경로 회귀.
- `bun run schemas:check`(프로토콜 드리프트) — 스키마 무변경이므로 통과해야 함.

---

## 7. 리스크 / 오픈 이슈

1. **계정 모드 사용자의 기대**: 사이드바의 "272k"는 계정 백엔드 상한에서 비롯된
   값이므로, 1M 토글을 켜도 계정 모드에서는 체감 변화가 없다. 메시지로 명확히
   안내해야 함(3.2절 반영).
2. **비용 서프라이즈**: 두 옵션 모두 단가를 크게 올린다(특히 조합 시).
   On 전환 알림에 숫자를 명시하고, `/status` 출력에서 현재 티어/정책을
   확인할 수 있도록 `status` 오버레이에 2줄 추가 검토.
3. **`deny` 값의 표시**: `config.toml`에서 수동으로 `deny`를 설정한 사용자는
   picker에서 현재값과 일치하는 항목이 없음 → `openSettings`가 첫 항목으로
   폴백(`tui.ts:863`). 허용 가능한 동작이나 문서에 기록.
4. **와이어 값 현대화**(`priority` → `fast`): 응답 표기가 동일하므로 이번 범위에서
   제외. 원하면 후속 1줄 변경.

---

## 8. 참고 자료

- OpenAI Fast mode 가이드: <https://developers.openai.com/api/docs/guides/fast-mode>
- GPT-5.6 Sol 모델 페이지(1,050,000 윈도우, 272K 프리미엄 가격 경계):
  <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- GPT-5.6 사용 가이드: <https://developers.openai.com/api/docs/guides/latest-model>
- 코드 내 근거: 2.3절 표의 파일/라인 참조
