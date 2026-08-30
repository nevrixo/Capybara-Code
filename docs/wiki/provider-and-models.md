# 프로바이더와 모델

Capybara Code는 단일 프로바이더 어댑터를 가집니다 — OpenAI **Responses API**. Chat Completions는 사용하지 않습니다.

구현: `packages/provider-openai` (4,760줄) — `openai.ts`(와이어 포맷, 1,687줄), `turn-session.ts`(턴 전송, 745줄), `capabilities.ts`(능력 매니페스트, 548줄), `utility.ts`, `policy.ts`(추론·캐시·재시도 정책, 475줄), `types.ts`(중립 계약, 460줄), `native-lanes.ts`, `programmatic.ts`, `response-items.ts`, `mock.ts`, `capability-refresh.ts`, `multi-agent.ts`.

모델 중립 도메인: `packages/inference-domain` (431줄) — `model.ts`, `capability.ts`, `routing.ts`, `usage.ts`, `budget.ts`. **의존 방향은 한쪽입니다**: 프로바이더 어댑터와 커널이 이 패키지에 의존하고, 그 반대는 없습니다 (`inference-domain/src/index.ts:1-9`).

## 두 개의 백엔드

`openai.ts`는 하나의 `OpenAiResponsesProvider` 클래스가 두 백엔드를 담당합니다. 구분자는 `options.chatGpt`의 존재 여부입니다 (`openai.ts:186`).

| | 플랫폼 API (`chatGpt === undefined`) | ChatGPT/Codex 계정 백엔드 |
| --- | --- | --- |
| 기본 base URL | `https://api.openai.com/v1` (`openai.ts:51`) | 등록(registration)이 URL을 소유 |
| 스트림 엔드포인트 | `POST {base}/responses` (`:336`) | 동일 |
| 모델 목록 | `GET {base}/models` (`:242-246`) | **없음** — 번들 지식만 (`:232-238`) |
| WebSocket | 가능 (`{base}` → `ws...`/`responses`, `:203`) | 불가 — 항상 `http_full` (`:180-182`) |
| `previous_response_id` | 전송 (`:451-457`) | 거부됨 → 입력 전체 재생 (`:448-450`) |
| `max_output_tokens` | 전송 (`:458-460`) | 미전송 |
| 프롬프트 캐시 breakpoint / `safety_identifier` | 지원 시 전송 (`:509-524`) | 미전송 |
| `context_management` / `service_tier` | 가능 (`:525-550`) | 미전송 |
| `parallel_tool_calls` / `tool_search` | 가능 (`:504-506`, opt-in) | 불가 |
| 컨텍스트 / 최대 출력 | 1,050,000 / 128,000 | 400,000 / 128,000 (`capabilities.ts:112-113`) |
| 추론 모드 | `standard`, `pro`(sol만) | `standard`만 (`capabilities.ts:310`) |

이 차이가 `ProviderCapabilities`로 한 곳에 모입니다 (`openai.ts:186-194`) — `websocket`, `previousResponse`, `parallelToolCalls`, `nativeCompaction`, `fastTier`, `toolSearch`가 모두 `platformBackend = options.chatGpt === undefined`로 설정됩니다.

**계정 백엔드가 `pro` 모드를 제공하지 않는 것이 능력 스냅샷에 남아 있는 이유**는 `review` 프로필 같은 요청을 자식 요청 전송 *전에* 다운그레이드하기 위해서입니다 — 한 번 실패한 뒤 부모가 standard로 계속해서야 성공하는 동작을 피합니다 (`capabilities.ts:288-297`).

## 모델 카탈로그

`BUNDLED_CAPABILITY_MANIFEST` (`capabilities.ts:125-158`), 매니페스트 버전 `2026-08-11`. **네트워크를 타지 않고 코드에 유지되므로 콜드 스타트가 네트워크를 기다리지 않습니다** (`types.ts:349-362`).

| 모델 id | tier | 앨리어스 | 컨텍스트 | 최대 출력 | 추론 모드 | 추론 요약 |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-5.6-sol` | sol | `gpt-5.6`, `sol` | 1,050,000 | 128,000 | standard, pro | ✓ |
| `gpt-5.6-terra` | terra | `terra` | 1,050,000 | 128,000 | standard | ✓ |
| `gpt-5.6-luna` | luna | `luna` | 1,050,000 | 128,000 | standard | ✗ |

세 모델 모두 `family: "gpt-5.6"`, 추론 강도 6단계 전체(`none`–`max`), `supportsStreaming`·`supportsFunctionCalling`·`supportsPromptCacheBreakpoints`가 참입니다 (`capabilities.ts:172-198`). **레거시 `MODEL_REGISTRY`는 매니페스트에서 파생됩니다** (`types.ts:364-365`) — `snapshotDescriptor`를 매핑하므로 둘이 컨텍스트 윈도우·출력 예산·앨리어스·추론 표면에 대해 불일치할 수 없습니다 (P0-11).

### 가격 (§23.7)

`PRICING` (`types.ts:422-448`), 레지스트리 버전 `2026-07-31` (`inference-domain/src/usage.ts:37`). **표시되는 추정치이며 청구의 근거가 아닙니다**.

| 모델 | 입력 /1M | 캐시 입력 /1M | 캐시 쓰기 /1M | 출력 /1M |
| --- | --- | --- | --- | --- |
| `gpt-5.6` / `gpt-5.6-sol` | $1.25 | $0.125 | $1.5625 | $10 |
| `gpt-5.6-terra` | $0.40 | $0.04 | $0.50 | $3.20 |
| `gpt-5.6-luna` | $0.10 | $0.01 | $0.125 | $0.80 |

`estimateCostUsd` (`types.ts:449-461`)는 캐시된 입력을 총 입력에서 뺀 뒤 각 단가를 적용합니다. 번들 스냅샷 자체에는 `pricing`이 실려 있지 않습니다 — `bundled()`가 채우지 않으므로 (`capabilities.ts:172-198`) 가격은 별도 레지스트리에만 존재합니다.

### 가용성은 지식과 다릅니다

`ModelAvailability` (`inference-domain/src/model.ts:76`): `known` | `reachable` | `unavailable` | `unverified`.

| 상태 | 의미 |
| --- | --- |
| `reachable` / `unavailable` | `/models` 응답에 id·앨리어스가 있었음 / 없었음 (`openai.ts:265-274`) |
| `unverified` | 요청 실패, 비-OK 응답, 또는 **빈 목록** (`:246-248`, `:255-258`, `:280-284`) |
| `known` | ChatGPT 백엔드 — 확인할 라우트가 없음 (`:232-238`) |

**네트워크 실패가 번들 목록을 "사용 가능"으로 바꾸지 못합니다** — §24.5가 과대주장을 금지하므로 확인할 수 없었던 상태는 그렇다고 말합니다 (`model.ts:71-74`). `/models`에서 온 미지의 id는 버려지지 않고 `discoveredModelDescriptor`로 추가됩니다 — 컨텍스트나 도구 표면을 안다고 가정하지 않으면서 개수 차이를 설명할 수 있게 합니다 (`openai.ts:275-280`).

## 인증

### 우선순위

`resolveCredential` (`apps/cbc/src/credentials.ts:124-149`)이 §9.2를 문자 그대로 구현합니다.

| 순서 | 소스 | 판정 |
| --- | --- | --- |
| 1 | `explicitKey` (`--api-key`류) | `source: "cli"` |
| 2 | `OPENAI_API_KEY` 환경 변수 (trim 후 비어 있지 않을 때) | `source: "environment"` |
| 3 | 키체인 `openai:api-key` 계정 (`credentials.ts:83`) | `source: "keychain"` |
| — | 어느 것도 없음 | `undefined` — 오류가 아니라 부재 |

**계정 로그인 토큰은 이 리졸버에서 절대 나오지 않습니다** (P0-14, `credentials.ts:113-122`): 계정 토큰은 등록의 자체 엔드포인트를 위해 발급되고, 범용 리졸버는 어느 base URL이 그것을 받을지 모릅니다. 계정 모드는 `resolveAccountSession`으로 별도 해석되며 등록의 URL을 자격 증명과 함께 운반합니다.

`CredentialSource`는 `cli` | `environment` | `keychain` | `account` | `none` (`credentials.ts:85`). 키체인 저장 자체는 Rust 런타임이 소유합니다 (§9.1) — 이 모듈은 *어느* 자격 증명을 쓸지만 결정합니다.

### base URL과 환경 변수

base URL 순서 (`apps/cbc/src/provider.ts:112-114`): `options.baseUrl`(계정 등록이 제공) → `OPENAI_BASE_URL` → 어댑터 기본값 `https://api.openai.com/v1` (`openai.ts:51`, `:374-376`에서 후행 슬래시 제거).

**등록의 URL이 환경 변수를 이깁니다** — 환경 변수가 계정 토큰을 다른 호스트로 돌리면 발급되지 않은 곳으로 bearer 토큰을 보내게 됩니다 (`provider.ts:44-51`).

| 변수 | 효과 |
| --- | --- |
| `OPENAI_API_KEY` | API 키 (우선순위 2) |
| `OPENAI_BASE_URL` | base URL 재정의 (등록 URL보다 낮음) |
| `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` | `OpenAI-Organization` / `OpenAI-Project` 헤더 — 계정 모드에서는 미적용 (`provider.ts:135-140`) |
| `CBC_HOSTED_TOOLS` | 호스티드 도구 재정의. `off`/`none`/`disabled`는 전부 비활성 (`provider.ts:158-186`) |
| `CBC_ALLOW_CHATGPT_HOSTED_TOOLS` | 계정 백엔드 호스티드 도구 허용, 기본 `true` (`provider.ts:116-118`) |
| `CBC_MOCK_PROVIDER` | 스크립트 목 프로바이더 경로 — **가장 먼저 확인** (`provider.ts:78-85`) |
| `CBC_CAPABILITY_URL` / `CBC_CAPABILITY_OVERRIDE` | 능력 매니페스트 원격 URL / 로컬 재정의 파일 (`capability-refresh.ts:182-183`) |

### 헤더

`#headers()` (`openai.ts:378-397`)는 설정 헤더를 **먼저** 적용하고 파생 헤더가 충돌에서 이기게 합니다. `RESERVED_HEADERS` (`openai.ts:90-98`) — 호출자가 대체할 수 없는 이름: `authorization`, `openai-organization`, `openai-project`, `chatgpt-account-id`, `originator`, `session-id`, `user-agent`.

**`Authorization`이 중요합니다**: 설정 헤더가 이것을 덮어쓰면 호출자가 해석한 lease와 다른 비밀이 전송되어, `/status`의 fingerprint가 실제로 사용되지 않은 자격 증명을 서술하게 됩니다. org/project 헤더도 같은 이유로 예약됩니다 — **누가 청구되는지를 선택하기 때문**입니다 (`openai.ts:82-89`).

ChatGPT 모드는 `ChatGPT-Account-Id`, `originator`(기본 `capybara`), `User-Agent`(기본 `capybara-code/0.1.0`)를 추가하고, 세션 id가 있으면 `session-id`도 붙입니다 (`openai.ts:387-392`).

### 자격 증명 검증

`validateCredential` (`openai.ts:289-324`)는 `GET {base}/models`를 씁니다.

| 응답 | `status` |
| --- | --- |
| 401 / 403 | `invalid` |
| 5xx, 또는 예외 | `network_error` |
| 그 외 비-OK | `restricted` |
| OK + `gpt-5.6*` 포함 / 미포함 | `valid` / `restricted` |
| ChatGPT 모드 | 항상 `restricted` — 검증할 라우트가 없음 (`:293-299`) |

**§9.4: 네트워크나 서버 오류를 잘못된 키로 보고하지 않습니다** (`openai.ts:310-313`). 비밀은 `CredentialLease.secret`에만 존재하고 **로그·저널·이벤트에 절대 들어가지 않습니다** (`types.ts:318-319`) — 표시용으로는 `fingerprint()`(SHA-256 앞 12자, `credentials.ts:186-190`)와 `maskSecret()`(마지막 4자만, `:198-201`)을 씁니다.

## 요청 정형화

`#buildBody` (`openai.ts:423-554`)가 §10.6 요청 정책을 담당합니다. 항상 실리는 것은 `model`, `input`(`serializeInputItem` 직렬화), `reasoning`, 그리고 `store: false`이며, `stream: true`는 HTTP 전송일 때만 붙습니다(WebSocket은 생략).

**`ModelRequest.store`의 타입은 리터럴 `false`입니다** — 다른 값을 넣을 수 없습니다 (`types.ts:294-295`). 세션 소유권을 로컬에 유지하기 위한 것입니다.

### 추론

`reasoning.effort`와 `reasoning.context`는 항상 전송됩니다. `mode: "pro"`는 요청이 pro이고 모델이 지원할 때만 (`openai.ts:465-468`), `summary`는 `"none"`이 아니고 모델이 `supportsReasoningSummary`일 때만 붙습니다 (`:473-478`). **`none`은 요약을 요청하지 않는다는 우리 쪽 중립 센티널입니다** — Responses API는 요약 상세 수준만 받으므로 잘못된 리터럴을 보내는 대신 필드를 생략해서 전달합니다 (`:469-472`).

`ReasoningEffort` 6단계는 `none` | `low` | `medium` | `high` | `xhigh` | `max` (`inference-domain/src/model.ts:44`), `ReasoningMode`는 `standard` | `pro` (`:47`), `ReasoningContextScope`는 `current_turn` | `all_turns` (`:50`)입니다.

### 도구 변환

프로바이더 도구 이름 규칙은 `/^[A-Za-z0-9_-]+$/`, 최대 64자 (`openai.ts:53-54`). Capybara 도구는 `fs.read`처럼 점을 포함하므로 `createToolNameCodec` (`openai.ts:1583-1620`)이 요청별 양방향 코덱을 만듭니다: 이미 유효한 이름을 **먼저 예약**해서 인코딩된 점 표기 id가 그것을 가릴 수 없게 하고(`:1593-1598`), 나머지는 비허용 문자를 `_`로 치환한 뒤 `_<SHA-256 앞 16자>` 접미사를 붙입니다(`:1631-1637`, 충돌 시 salt 증가). 등록되지 않은 이름을 넣으면 예외입니다 (`:1615-1618`).

`strict` 스키마 (`types.ts:241-242`)는 §12.4의 요구지만 무조건 켜지지 않습니다 — `supportsProviderStrictSchema` (`openai.ts:1648`)가 임의 키 맵 스키마를 걸러내고, 그 경우 프로바이더 유연 모드를 쓰면서 로컬 검증기가 계속 형태를 강제합니다.

`normalizeProviderSchema` (`openai.ts:582-624`)는 프로바이더 경계에서만 복사본을 정규화합니다 — 모든 선언 속성을 `required`에 넣고 객체에 `additionalProperties: false`를 채웁니다. **카탈로그는 더 작은 `required` 집합을 유지해서 로컬 검증기가 기본값을 적용할 수 있게 합니다.**

### 호스티드 도구

`DEFAULT_HOSTED_TOOLS` (`openai.ts:103-106`)는 `web_search`와 `image_generation` 둘뿐이며, 모두 읽기/생성 전용입니다. `#hostedToolsForRequest` (`openai.ts:400-419`)가 활성 모델/백엔드 스냅샷이 증명한 것만 남깁니다:

| 도구 | 조건 |
| --- | --- |
| `web_search` / `web_search_preview` | 스냅샷의 `webSearch`가 `supported` |
| `image_generation` | 스냅샷의 `imageGeneration`이 `supported` |
| `programmatic_tool_calling` | 플랫폼 백엔드 **및** `programmaticToolCalling` supported (`:412-414`) |
| `tool_search` | `enableToolSearch === true` **및** `capabilities.toolSearch` (`:409-411`) |

**§10.14: 프로바이더 호스티드 셸, 파일 변경, 멀티 에이전트는 비활성 상태로 유지됩니다** (`openai.ts:8-10`). `SAFE_NATIVE` (`capabilities.ts:95-105`)가 9개 네이티브 능력을 전부 `unsupported`로 시작하고 `bundled()`가 그중 4개(`programmaticToolCalling`, `hostedMultiAgent`, `webSearch`, `imageGeneration`)만 켭니다 (`:187-196`).

## 스트림 이벤트 매핑

`parseResponseStream` (`openai.ts:731-838`)이 SSE를 `ModelEvent`로 변환합니다. **이 파일만 Responses API 와이어 포맷을 알고, 커널은 프로바이더 객체를 절대 보지 않습니다** (`openai.ts:1-6`).

블록 구분자는 `/\r?\n\r?\n/`로 LF·CRLF·혼합 줄바꿈을 모두 받습니다 — **Windows 응답이 스트림 종료를 기다리지 않고 프레임 도착 즉시 산출되게** 하기 위해서입니다 (`:759-765`). `data:` 줄만 이어붙이고(`:770-776`), `[DONE]`은 건너뛰며(`:777`), **파싱 불가 프레임은 턴을 중단하지 않고 무시합니다** (`:783`). 분할된 UTF-8 코드포인트는 마지막 블록 파싱 전에 flush됩니다 (`:753-758`).

주요 이벤트 매핑 (`translate`, `openai.ts:887-1090`):

| 프로바이더 이벤트 | 처리 |
| --- | --- |
| `response.created` / `.in_progress` | `:887`, `:895` |
| `response.output_text.delta` | 텍스트 델타 `:898` |
| `response.reasoning_text.delta` / `.done` / `.reasoning_summary_text.delta` | 추론 상세·요약 채널 `:911`, `:918`, `:925` |
| `response.web_search_call.*` / `.image_generation_call.*` | 호스티드 도구 진행 `:933-947` |
| `response.output_item.added` / `.done` | 항목 조립 `:948`, `:995` |
| `response.function_call_arguments.delta` / `.done` | 도구 호출 인자 조립 `:972`, `:981` |
| `response.completed` / `.incomplete` / `.failed` | 종료 `:1019`, `:1068`, `:1082` |

종료 규칙 (`openai.ts:788-811`): **프로바이더의 `completed`는 중복 done 프레임이 유실되었더라도 대기 중인 호출이 최종임을 증명합니다** — 그때만 미발행 호출을 `tool.call.completed`로 방출하고, **`incomplete`, `failed`, EOF 스트림은 부분 호출을 실행 가능으로 승격시키지 않습니다.** `response.completed` 없이 끝나면 `response.incomplete`가 `reason: "stream ended before response.completed"`로 합성됩니다 (`:812-817`).

사용량은 응답당 정확히 한 번 방출됩니다 — 저장된 총계를 여기서 다시 산출하면 저널의 모든 `usage.updated`가 두 배가 됩니다 (`:806-810`). `ModelUsage` (`inference-domain/src/usage.ts:9-16`)는 `inputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `totalTokens`입니다.

## 오류 정규화

`normalizeProviderError` (`openai.ts:1451-1500`):

| 조건 | `kind` | 재시도 |
| --- | --- | --- |
| `rate_limit` 타입 / `rate_limit_exceeded` / 429 | `rate_limit` | ✓ |
| status ≥ 500, 또는 과부하 메시지 패턴 | `server` | ✓ |
| 알려진 네트워크 코드 / `connection` 타입 | `network` | ✓ |
| `authentication` 타입 / 401 / 403 | `authentication` | ✗ |
| `invalid_request` 타입 / `previous_response_not_found` / 400 | `invalid_request` | ✗ |
| `context_length_exceeded` | `context_length` | ✗ |
| `content` 타입 / `content_filter` | `content_policy` | ✗ |
| 그 외 | `unknown` | ✗ |

**§10.13**: 위 세 종류와 status 408만 재시도 가능합니다. 검증과 인증은 재시도하지 않습니다 (`openai.ts:1489-1492`).

`extractErrorBody` (`openai.ts:1509-1531`)는 플랫폼의 `{ error: { message } }`, 게이트웨이의 `{ error: "..." }`, FastAPI 스타일 `{ detail: ... }`, 맨 메시지 객체를 모두 받습니다 — **실패한 턴이 불투명한 자리표시자 대신 프로바이더의 실제 문장을 보고하게** 하기 위해서입니다.

## Fast mode

Fast mode는 Responses API의 우선 처리(priority) 티어에 대한 별칭입니다.

| 지점 | 내용 |
| --- | --- |
| 요청 필드 | `ModelRequest.serviceTier?: "standard" \| "fast"` (`types.ts:301-302`) |
| 와이어 매핑 | `fast` → `service_tier: "priority"`, 그 외 → `"default"` (`openai.ts:549`) |
| 게이트 | `capabilities.fastTier` — **플랫폼 백엔드 전용** (`openai.ts:547-550`, `:191`) |
| 설정 키 | `provider.openai.serviceTier`, 기본 `standard`, 값 `["standard","fast"]` (`schema.ts:636`, `:941`) |
| 런타임 | `liveServiceTier` (`agent.ts:2983-2985`), `fastModeSupported` (`:2988-2990`) |
| 전환 | `setServiceTier(tier)` — 미지원이면 `false`를 반환하고 아무것도 바꾸지 않음 (`agent.ts:3001-3005`) |

요청별 값이 프로바이더 옵션 기본값을 이깁니다: `request.serviceTier ?? this.#options.serviceTier` (`openai.ts:547`).

`model.profiles.fast` (`schema.ts:559`)는 **별개입니다** — 그것은 `gpt-5.6-terra` + `reasoningEffort: "low"`를 고르는 모델 프로필이고, `service_tier`를 바꾸지 않습니다.

## 1M 컨텍스트

번들 세 모델 모두 컨텍스트 윈도우 1,050,000입니다 (`capabilities.ts:132`, `:142`, `:152`). 계정 백엔드에서는 400,000으로 재정의됩니다 (`capabilities.ts:311`).

### 컨텍스트 밴드와 프리미엄 임계값

`model.context.bands` 기본값은 `[64_000, 192_000, 272_000, 512_000, 1_000_000]`, `defaultBand`는 192,000 (`schema.ts:533-534`), `premiumThresholdTokens`는 272,000 (`:535`, 스냅샷 쪽은 `capabilities.ts:260`)입니다. `premiumBandPolicy` 기본은 `utility-gated`이며 `deny` | `allow` | `utility-gated` 중 하나입니다 (`schema.ts:936`).

**`pricingBand`는 청구 경계일 뿐이며 모델 컨텍스트 윈도우나 사용 가능 입력 예산 한계로 취급되어서는 안 됩니다** (`capabilities.ts:62-66`).

### 입력 예산과 소프트 예산

`inputContextBudget` (`types.ts:375-397`): `contextWindow - reservedOutput`, 최소 4,000. `reservedOutput`은 모델의 `maxOutputTokens`, 없으면 설정값, 없으면 0입니다 — 잘못된 레지스트리 항목에 대한 하한을 유지합니다.

**상태 바 백분율은 모델 윈도우가 아니라 역할별 소프트 예산에 대한 것입니다** (`inference-domain/src/model.ts:23-26`). `SOFT_CONTEXT_BUDGETS` (`model.ts:27-41`):

| 역할 | 토큰 |
| --- | --- |
| `root` | 96,000 |
| `architect`, `reviewer` | 64,000 |
| `refactorer` | 56,000 |
| `planner`, `executor` | 48,000 |
| `explore` | 32,000 |
| `test` | 24,000 |

`architect`가 읽기 전용 역할 중 가장 큰 예산을 받는 것은 **폭발 반경을 보는 것이 그 역할의 일**이기 때문입니다 (`:30-33`). `refactorer`는 한 파일이 아니라 옮길 호출 지점들을 담아야 합니다 (`:37`).

기본 `model.softContextTokens`는 96,000이며 4,000 미만이면 경고입니다 (`schema.ts:510`, `:1673-1679`).

### 네이티브 압축

`calculateNativeCompactionThreshold` (`types.ts:253-268`):

| 입력 | 기본 |
| --- | --- |
| `emergencyMarginTokens` / `providerHeadroomTokens` | `max(1_024, window × 0.02)` / `max(2_048, window × 0.04)` |
| 상한 | `window - reserve - emergencyMargin` |
| 결과 | `max(1_024, min(hardCeiling, target + headroom))` |

윈도우나 target이 0 이하면 `undefined`(=미전송)이고, 상한이 1,024 미만이면 1,024입니다.

동적 target은 `floor(max(1_024, contextWindow - maxOutputTokens) × 0.76)`이고 `maxOutputTokens`가 없으면 32,000을 가정합니다 (`openai.ts:526-533`). 최종 `compactThreshold`는 `max(1_024, compactionThresholdTokens ?? dynamicThreshold ?? 80_000)` (`:535-540`)이며, 설정 기본 `model.context.compactionThresholdTokens`도 80,000·최소 1,024입니다 (`schema.ts:542`, `:1502`).

`context_management`는 **설정과 프로바이더가 모두 지원할 때만** 전송됩니다 (`types.ts:298-299`, `openai.ts:541-546`).

## 추론 강도 선택 정책

`policy.ts`가 §10.4 라우팅을 담당합니다.

### 복잡도 점수와 강도

`complexityScore` (`policy.ts:47-59`)가 0–10으로 clamp하고, `effortForScore` (`:62-68`)가 강도로 사상합니다.

| 특성 | 가점 | | 점수 | 강도 |
| --- | --- | --- | --- | --- |
| `requestedConcerns - 1`, `previousFailedAttempts` | 각각 최대 +2 | | ≤ 2 | `low` |
| `expectedFilesTouched` ≥ 8 / ≥ 3 | +2 / +1 | | 3–5 | `medium` |
| `failingTestAmbiguity` (0–2) | +0…+2 | | 6–7 | `high` |
| `highRiskDomain` (보안·인증·데이터 마이그레이션) | +2 | | 8–9 | `xhigh` |
| `repositorySize` ≥ 20,000, `crossLanguageImpact`, `concurrencyInvolved` | 각각 +1 | | 10 | `max` |
| `userSpecifiedDepth` = `deep` / `low` | +2 / **−2** | | | |

`selectEffort` (`policy.ts:75-112`):

- **`max`는 명시적 사용자 확인 없이는 선택되지 않습니다** — 확인이 없으면 `xhigh`로 clamp하고 `requiresConfirmation: true`와 `clamped.reason`을 함께 반환합니다 (`:81-96`).
- 모델이 원하는 강도를 지원하지 않으면 `clampEffortToModel`로 내리고 `clamped`를 채웁니다 — **§AC-48: 조용한 다운그레이드 금지** (`:98-107`).
- 타임라인 문장은 `effortChangeLine` → `Reasoning adjusted: {from} → {to} · {reason}` (`:132-138`).

### pro 모드 게이트

`selectReasoningMode` (`policy.ts:155-186`):

| 조건 | 결과 |
| --- | --- |
| 모델이 pro 미지원 | `standard` |
| 사용자가 명시 요청 | `pro` + 비용 경고 |
| Auto Review 고심각도 프로필, 또는 평가로 이득이 입증된 작업군 — 둘 다 `configAllows` 필요 | `pro` + 비용 경고 |
| 그 외 | `standard` |

**§10.5: pro 모드를 긴 구간에 대해 자동으로 켜지 않습니다** (`:179-180`). pro는 항상 예상 지연·비용 영향을 표시해야 합니다 (`policy.ts:150-151`).

### 캐시와 재시도

| 상수 | 값 | 위치 |
| --- | --- | --- |
| `CACHE_MIN_PREFIX_TOKENS` / `CACHE_MAX_WRITES_PER_REQUEST` / `CACHE_DEFAULT_TTL` | 1,024 / 4 / `"30m"` | `policy.ts:291-293` |
| `MAX_RETRY_ATTEMPTS` | 10 | `policy.ts:368` |

스냅샷 쪽 캐시 계약은 `maxWritesPerRequest: 2`, `minimumTtl: "30m"`입니다 (`capabilities.ts:259`). 설정 기본 `model.cache.maxWritesPerTurn`도 2, `ttlMinutes`는 30이며 30이 아니면 경고합니다 (`schema.ts:551-552`, `:1681`).

## 모델 선택 표면

### 설정 키

`config-schema/src/schema.ts:505-565`:

| 키 | 기본값 | 허용 값 |
| --- | --- | --- |
| `model.profile` / `model.default` | `auto` / `gpt-5.6-sol` | — |
| `model.reasoningMode` / `model.reasoningEffort` | `standard` / `medium` | `standard`,`pro` / `none`–`max` (`:951-952`) |
| `model.softContextTokens` / `model.maxOutputTokens` | 96,000 / 32,000 | 최소 8,000 / 256 (`:1496-1497`) |
| `model.reasoning.summary` / `.providerSummary` | `auto` / `auto` | `auto`,`none` / `auto`,`off` (`:953-954`) |
| `provider.openai.transport` / `.serviceTier` / `.toolSearch` | `websocket` / `standard` / `false` | — / `standard`,`fast` (`:941`) / — |
| `provider.openai.native.programmaticToolCalling` | `read-only` | `read-only`, `disabled` (`:938`) |
| `provider.openai.native.hostedMultiAgent` | `read-only` | `read-only`, `disabled` (`:939`) |
| `…native.maxHostedAgents` / `.maxProgramToolCalls` / `.maxProgramParallelCalls` | 3 / 24 / 6 | 최소 0 / 0 / 1 (`:1520-1522`) |
| `…native.allowHostedShell` / `.allowHostedApplyPatch` / `.allowComputerUse` | 전부 `false` | — |

**`programmaticToolCalling`과 `hostedMultiAgent`의 허용 값에 "쓰기"가 없습니다** — `read-only` 아니면 `disabled`뿐입니다 (`schema.ts:117-118`).

`provider.openai.native.*`는 `key-status.ts:157`에서 `experimental`로 표시되며 노트가 이렇습니다: **"native lanes are read-only; the toggles feed the policy digest only"**.

`model.reasoning`은 `model.reasoningEffort`의 앨리어스이고, `model.reasoning.summary`는 `model.reasoning.providerSummary`로 마이그레이션됩니다 (`schema.ts:1007-1011`). 두 필드는 로드 시 서로 동기화됩니다 (`schema.ts:1338-1347`).

`model.default`, `model.reasoningMode`, `model.reasoningEffort`는 프로젝트 설정 제한 대상 목록에 있습니다 (`schema.ts:866-868`).

### 프로필 표 (§10.3)

`model.profiles` (`schema.ts:557-564`):

| 프로필 | 모델 | 모드 · 강도 |
| --- | --- | --- |
| `auto`, `balanced` | `gpt-5.6-sol` | standard · medium |
| `deep` | `gpt-5.6-sol` | standard · high |
| `review` | `gpt-5.6-sol` | **pro** · high |
| `fast` | `gpt-5.6-terra` | standard · low |
| `economy` | `gpt-5.6-luna` | standard · low |

### 라우터 티어

`model.router` (`schema.ts:513-522`): `strategy` `utility`(`utility` | `latency` | `cost`, `:932`), `cheapTier`/`defaultTier`/`escalationTier`가 각각 `gpt-5.6-luna`/`gpt-5.6-terra`/`gpt-5.6-sol`, `maxCostUsdPerTurn` 2, `targetLatencyMs` 90,000, `phasePolicy`·`recordDecisions` 모두 `true`.

`RouteEpoch` (`inference-domain/src/routing.ts:27-34`)가 각 결정을 `{epoch, phase, model, effort, mode, reason}`으로 기록합니다. `WorkPhase` 7단계: `orient` | `investigate` | `implement` | `repair` | `verify` | `review` | `finalize` (`routing.ts:15-22`). `TurnPhase`는 별개로 `commentary` | `tool_call` | `final_answer` 3단계입니다 (`:12`).

### CLI와 TUI

**`capy`는 모델을 고르는 최상위 플래그를 제공하지 않습니다.** `model` 명령의 유일한 하위 명령은 `refresh`입니다 (`command-spec.ts:72-78`, `args.ts:351-352`).

| 슬래시 명령 | 인자 없음 | 인자 있음 |
| --- | --- | --- |
| `/model` | `model_picker` 오버레이 (`slash.ts:81-83`) | `set_model` 직접 적용 |
| `/effort` | `reasoning_picker` 오버레이 (`slash.ts:84-87`) | `set_reasoning` 직접 적용 |

**인자를 받는 형태가 있는 이유**는 `/model gpt-5.6`을 스크립트 같은 흐름에서 쓸 수 있게 하기 위해서입니다 (`slash.ts:79-80`). 완성 소스는 `MODEL_REGISTRY`를 그대로 나열하고(`slash.ts:220-224`), `/effort`는 `REASONING_EFFORTS`를 나열합니다 (`:225-227`).

`set_model` 처리 (`commands/interactive.ts:1710-1747`)는 `findModel`로 해석하고(미지의 모델이면 경고만), 세션·UI를 설정한 뒤 **현재 추론 강도를 새 모델에 맞춰 `clampEffortToModel`로 다시 재단합니다** (`:1721-1725`). 그 다음 사용자 설정에 쓰는데, **쓰기가 실패해도 세션에는 적용된 채로 남고** 저장되지 않았다고만 알립니다 (`:1735-1738`). clamp가 일어나면 출력에 이유가 붙습니다 — `Model set: {id} · effort {e} ({reason})`.

`clampEffortToModel` (`policy.ts:457-475`)은 요청 강도부터 사다리를 위로 훑어 지원되는 첫 값을 찾고, 없으면 `none`으로 떨어집니다. **사용자가 고른 값을 작업이 단순해 보인다는 이유로 적응적 값으로 대체하지 않는 것이 복잡도 정책과의 차이입니다** (`:451-456`).

`nativeCompaction`은 `providerCompactionMode`가 `off`/`on`/`auto`인지에 따라 `false`/`true`/`model.context.providerCompaction`으로 3분기 매핑되고 (`apps/cbc/src/bootstrap.ts:358-362`), `nativeCompactionDynamic`은 `compactionPolicy === "adaptive"`일 때만 참입니다 (`:363`).

## 네이티브 레인

`native-lanes.ts` (377줄)는 프로바이더 네이티브 PTC와 호스티드 스카우트에 대한 **정책 게이트**입니다. **프로바이더 능력은 엔드포인트가 무엇을 제공하는지를 서술하고, 이 게이트는 CBC가 이 세션에서 무엇을 노출할 의지가 있는지를 서술합니다. Rust 권한, 라이터 리스, 승인을 절대 부여하지 않습니다** (`native-lanes.ts:1-6`).

`PROGRAM_TOOL_ALLOWLIST` (`native-lanes.ts:20-36`), 15개 — 모두 R0, 비변경, 네트워크 없는 읽기입니다: `fs.read`, `fs.read_many`, `fs.list`, `fs.glob`, `fs.search`, `git.status`, `git.diff`, `git.log`, `repo.investigate`, `lsp.diagnostics`, `lsp.symbols`, `lsp.references`, `lsp.definition`, `lsp.implementation`, `artifact.read`.

**이 목록에 도달한 프로그램도 파일을 만들거나 프로세스를 시작하거나 자격 증명을 만지거나 승인을 요구할 수 없습니다.** 집계형 읽기(`lsp.*`, `repo.investigate`, `artifact.read`)가 프로그램이 실제로 줄일 수 있는 것 — 모델 왕복의 팬아웃을 하나의 구조화된 결과로 바꾸는 것입니다 (`native-lanes.ts:10-19`).

| 정책 | 키 | 기본값 |
| --- | --- | --- |
| `DEFAULT_PROGRAM_POLICY` (`:66-79`) | `maxProgramBytes` / `maxWallTimeMs` / `maxIntermediateBytes` | 262,144 / 30,000 / 4,194,304 |
| | `maxToolCalls` / `maxParallelCalls` / `maxOutputBytes` | 24 / 6 / 1,048,576 |
| | `allowLoops` / `maxLoopIterations` / `maxRetries` | `false` / 0 / 1 |
| | `failOpen` | **리터럴 `false`** (`:58`) |
| `DEFAULT_HOSTED_SCOUT_POLICY` (`:217-227`) | `maxAgents` / `maxDepth` / `maxTokensPerAgent` | 3 / 1 / 16,000 |
| | `allowShell` / `allowApplyPatch` / `allowComputerUse` | **리터럴 `false`** (`:211-213`) |
| | `requireEvidenceCapsule` | **리터럴 `true`** (`:214`) |

세 개의 `allow*`와 `requireEvidenceCapsule`이 리터럴 타입인 것이 핵심입니다 — **설정으로 켤 수 없습니다.**

`HostedRole`은 **두 개뿐입니다**: `HostedScout` | `HostedReviewer` (`native-lanes.ts:203`). `multi-agent.ts`는 13줄짜리 재수출 전용 파일이고 첫 줄이 명시합니다 — **"호스티드 에이전트는 스카우트/리뷰어 전용"** (`multi-agent.ts:1`).

`validateProgramToolCall` (`:98-121`) 거부 코드: `disabled`, `budget_exhausted`, `parallel_budget_exhausted`, `caller_missing`, `epoch_missing`, `lineage_mismatch`, `unknown_tool`, `mutation_denied`, `invalid_arguments`. **허용 목록 검사는 두 번 일어납니다** (`:116-118`): 먼저 정경 `PROGRAM_TOOL_ALLOWLIST`에 있는지(→ `unknown_tool`), 다음으로 세션 정책이 켰는지(→ `mutation_denied`). **정책이 정경 목록을 넓힐 수 없습니다.**

`validateHostedScoutRequest` (`:249-269`) 거부 코드: `disabled`, `agent_budget`, `role_invalid`, `agent_missing`, `depth_budget`, `token_budget`, `caller_missing`, `epoch_missing`, `workspace_missing`, `prompt_invalid`, `tool_denied`. 실제 소비자는 `packages/subagents/src/hosted-scout.ts:91`입니다. `sanitizeProgramOutput` (`:193-201`)은 ANSI 이스케이프와 제어 문자를 제거하고 바이트 단위로 절단한 뒤 digest를 붙입니다.

`programmatic.ts` (374줄)의 `ProgrammaticToolLane`이 실행을 담당하며 `packages/agent-kernel/src/kernel.ts:928`에서 인스턴스화됩니다 — 설정 키 `provider.openai.native.maxProgramToolCalls`가 그 호출 예산에 배선되어 있습니다 (`config-schema/src/key-status.ts:155`).

## 컨텍스트 밴드 선택

`utility.ts` (505줄)의 `selectContextBand` (`utility.ts:55-111`)가 요청 토큰을 밴드로 사상합니다. 소비자는 `apps/cbc/src/agent.ts:2104`입니다. `CONTEXT_BANDS` = `[64_000, 192_000, 272_000, 512_000, 1_000_000]` (`:42`), `PREMIUM_CONTEXT_THRESHOLD = 272_000` (`:43`), `MIN_REASONING_GENERATION_TOKENS = 25_000` (`:45`).

| 조건 | 결과 |
| --- | --- |
| 요청 + reserve가 모델 상한 초과, 또는 밴드가 요청·상한에 맞지 않음 | `allowed: false` (`:77-87`) |
| 밴드 ≤ 272,000 | `allowed: true`, "within the standard context band" (`:88-90`) |
| 프리미엄 + 정책 `deny` / `allow` | `false` / `true` (`:92-97`) |
| 프리미엄 + `utility-gated` (기본) | `estimatedQualityGain > 0` **및** `estimatedCostUsd ≤ maxCostUsd`일 때만 (`:98-110`) |

**프리미엄 밴드는 측정된 효용과 비용 상한을 요구합니다** (`:109`). `SampleIntent` 7종 (`:32-39`): `route`, `inspect`, `tool_select`, `program`, `synthesize`, `final`, `review`. `InferenceLane` 4종 (`:208`): `direct`, `program`, `hosted_scout`, `local_agent`.

## 능력 매니페스트 갱신

`capability-refresh.ts` (254줄). 원격 매니페스트가 번들 매니페스트를 대체할 수 있습니다. `DEFAULT_CAPABILITY_MANIFEST_URL`은 `https://raw.githubusercontent.com/capybara-code/capability-manifest/main/manifest.json` (`:10-11`), 캐시 파일명 `capability-manifest.json` (`:12`), 갱신 주기 24시간 (`:13`)입니다.

`resolveCapabilityManifest` (`:176-220`) 해석 순서:

| 순서 | 소스 | 조건 |
| --- | --- | --- |
| 1 | `override` | `CBC_CAPABILITY_OVERRIDE`나 `options.overridePath`의 파일이 파싱될 때 (`:186-191`) |
| 2 | `cache` | 캐시가 있고 24시간 내 (`:196-198`) |
| 3 | `remote` | 캐시가 오래됐거나 없고 원격 fetch 성공 (`:199-203`, `:208-212`) |
| 4 | `cache` | 원격 실패 시 오래된 캐시로 되돌림 (`:204`) |
| 5 | `bundled` | 그 외 전부 (`:214-219`) |

URL 우선순위는 `options.manifestUrl` → `CBC_CAPABILITY_URL` → 기본값 (`:38-40`), 캐시 디렉터리는 `options.cacheDir` → `CAPYBARA_CACHE_DIR` → `XDG_CACHE_HOME` (`:184`)입니다. 원격 fetch 실패·비-OK 응답·파싱 실패는 모두 `undefined`를 반환해 다음 단계로 넘어갑니다 (`:156-165`) — **네트워크 실패가 예외로 새어나가지 않습니다.**

`capy model refresh`(`command-spec.ts:72-78`)가 `modelRefresh`를 호출하고 `{source} · {manifestVersion} · {n} model(s)`를 출력합니다 (`apps/cbc/src/commands/model.ts:7-16`).

## 턴 세션, 전송, 응답 항목

`turn-session.ts` (745줄)의 `OpenAiTurnSession`이 `ProviderTurnSession`을 구현합니다. `ProviderTransport` 3종: `http_full` | `http_previous` | `websocket` (`types.ts:65`). 소켓 관리 상수 (`turn-session.ts:58-61`): `MAX_SOCKET_AGE_MS` 55분(소켓 최대 수명), `SOCKET_FAILURE_THRESHOLD` 3(회로 차단 임계값), `SOCKET_CIRCUIT_COOLDOWN_MS` 30,000(냉각 시간).

`prewarm`은 전송이 `websocket`이 아니거나 `capabilities.websocket`이 거짓이면 **조용히 아무것도 하지 않습니다** (`:90`). 닫힌 세션의 `stream`은 예외를 던지지 않고 `response.failed`(`kind: "invalid_request"`, `retryable: false`)를 산출합니다 (`:110-119`). 설정 기본 `provider.openai.transport`는 `websocket`이지만 (`schema.ts:635`), ChatGPT 계정 세션은 이를 무시하고 항상 `http_full`을 씁니다 (`openai.ts:180-182`).

`response-items.ts` (259줄)가 응답 항목을 저장·재생 가능한 형태로 정규화합니다 — `normalizeResponseItem` (`:60`), `replayableResponseItems` (`:117`), `exportResponseItem` (`:160`), `buildResponseReplayPlan` (`:238`).

**§10.6: 암호화된 추론 콘텐츠는 불투명하며 절대 검사되지 않습니다.** 계정 백엔드는 재생된 추론 항목에 `summary`가 함께 오기를 요구하며, 요약 텍스트가 없을 때는 빈 배열이 그것을 만족시킵니다 (`openai.ts:679-690`) — `previous_response_id`가 없으므로 연속성 전체가 재생된 입력 항목에 달려 있습니다. `model.reasoning.preserveOpaqueItems` 기본값은 `true`, `continuity`는 `task-epoch`입니다 (`schema.ts:527`, `:531`).

## 목 프로바이더

`mock.ts` (267줄)가 `MockProvider`와 `ScriptedStep`을 제공합니다. **§0.2: "mock provider만으로 Root Agent 통합 테스트를 완료할 수 있어야 한다"** (`mock.ts:1-3`).

**스크립트는 선언적입니다 — 테스트가 SSE 바이트가 아니라 모델의 행동을 서술합니다. 실제 어댑터와 같은 `ModelProvider` 인터페이스를 구현하므로 커널이 둘을 구분할 수 없습니다** (`mock.ts:5-7`).

`ScriptedStep` 필드 (`mock.ts:25-43`):

| 필드 | 목적 |
| --- | --- |
| `commentary` / `reasoningSummary` | §10.7 가시 프리앰블 / 추론 요약 |
| `text` | 최종 답변 — **존재하면 턴이 끝납니다** |
| `toolCalls` / `usage` | `{callId, name, arguments}` 배열 / `Partial<ModelUsage>` |
| `error` / `incompleteReason` | 강제 오류 / `response.incomplete` 이유 |
| `deltaChunks` | 텍스트를 이 개수의 델타로 분할 — 스트리밍 조립 경로를 훈련 |
| `duplicateDeltas` | 모든 델타를 한 번 복제 — §25.6 dedupe 경로를 훈련 |
| `delayMs` | 첫 이벤트 전 지연 — 취소 경로를 훈련 |

`repeatLast`는 스텝이 소진되면 실패하는 대신 마지막 스텝을 무한 반복합니다 (`mock.ts:47-48`). `capabilities` 기본값은 `previousResponse`만 참이고 나머지 5개는 전부 `false`이며 (`mock.ts:63-71`), `options.capabilities`로 개별 덮어쓰기가 가능합니다. 검사용 접근자는 `callCount`, `lastRequest`(프롬프트 조립·도구 활성화 단정용, `:78-81`), `reset()`입니다.

**AC-47은 전체 에이전트 루프가 네트워크 없이 실행 가능해야 한다고 요구하며, `CBC_MOCK_PROVIDER`가 그 이유입니다** — JSON 턴 스크립트를 가리켜서 eval 하네스와 PTY 테스트가 실제 세션을 결정론적으로 구동합니다 (`apps/cbc/src/provider.ts:8-11`). `buildProvider`는 **목을 가장 먼저 확인합니다** — 실제 자격 증명이 있어도 테스트 환경이 네트워크에 도달할 수 없게 하기 위해서입니다 (`provider.ts:76-85`). `MockProvider`를 가져오는 파일은 15개이고 그중 13개가 `.test.ts`입니다.

## 알려진 불일치

**캐시 쓰기 상한이 세 곳에서 다릅니다.**

| 위치 | 값 |
| --- | --- |
| `policy.ts:292` `CACHE_MAX_WRITES_PER_REQUEST` | 4 |
| `capabilities.ts:259` 스냅샷 `cache.maxWritesPerRequest` | 2 |
| `schema.ts:551` `model.cache.maxWritesPerTurn` 기본 | 2 |

`decideCaching`은 `CACHE_MAX_WRITES_PER_REQUEST`(4)로 `breakpointCount`를 clamp합니다 (`policy.ts:336`). 능력 스냅샷과 설정은 2를 말합니다. 어느 쪽이 실효인지 코드 안에 조정 지점이 없습니다.

**`outputBudget`은 deprecated이며 테스트에서만 호출됩니다.** 주석이 명시합니다 — 표현 코드는 `presentationBudget()`(문자 단위)을 써야 하고 토큰 상한을 쓰면 안 됩니다 (`policy.ts:183-188`). 유일한 호출자는 `packages/provider-openai/test/provider.test.ts:392`입니다.

**`buildResponseReplayPlan`, `resolveCapabilityManifest`, `CACHE_MAX_WRITES_PER_REQUEST`, `CACHE_MIN_PREFIX_TOKENS`는 패키지 밖에서 소비되지 않습니다.** `capy model refresh`는 `refreshCapabilityManifest`만 씁니다 (`apps/cbc/src/commands/model.ts:3`).

**프리미엄 임계값이 두 번 하드코딩되어 있습니다** — `capabilities.ts:260`의 `pricingBand.premiumThresholdTokens`와 `utility.ts:43`의 `PREMIUM_CONTEXT_THRESHOLD`가 각각 272,000을 독립적으로 갖고, 설정 기본 `model.context.premiumThresholdTokens`(`schema.ts:535`)도 같은 값을 세 번째로 반복합니다. 세 값 중 어느 것도 다른 것에서 파생되지 않습니다.

**번들 스냅샷에는 `pricing`이 없습니다.** `ModelCapabilitySnapshot.pricing`은 선언되어 있지만 (`capabilities.ts:67`) `bundled()`가 채우지 않으므로 (`capabilities.ts:172-198`) 번들 세 모델의 스냅샷에는 가격이 실리지 않습니다. 비용 추정은 별도 `PRICING` 레지스트리(`types.ts:422-448`)만 사용합니다. 두 레지스트리의 버전 문자열도 다릅니다 — 매니페스트 `2026-08-11`, 가격 `2026-07-31`.

**`ModelDescriptor.contextWindow`와 `maxOutputTokens`는 옵셔널이지만 매니페스트 경로에서는 항상 존재합니다.** `model.ts:60-61`이 `?`를 붙이고 `types.ts:375-397`·`openai.ts:526-533`이 `undefined`를 방어하지만, `snapshotDescriptor`(`capabilities.ts:209-223`)가 스냅샷의 필수 필드를 복사하므로 `MODEL_REGISTRY` 항목에는 언제나 값이 있습니다. 방어 코드는 `discoveredModelDescriptor` 항목과 레거시 호출자를 위한 것입니다.

**`model.context.bands`와 `CONTEXT_BANDS`(`utility.ts:42`)가 별개로 같은 5개 값을 갖습니다.** `selectContextBand`는 설정값이 아니라 모듈 상수를 씁니다 — `ContextBand`가 리터럴 유니온 타입이므로 (`utility.ts:41`) 설정으로 밴드를 바꿀 수 없습니다.

## 관련 문서

- 설정 키 전체와 레이어 우선순위 → [설정](configuration.md)
- 컨텍스트 레이어·압축·소프트 예산의 사용 → [에이전트와 컨텍스트](agent-and-context.md)
- 커널 경계와 이벤트 흐름 → [아키텍처](architecture.md)
- 키체인·자격 증명 저장 → [Rust 런타임](rust-runtime.md)
- 역할별 예산이 실제로 쓰이는 곳 → [서브에이전트와 그래프](subagents-and-graph.md)
- `capy auth` 명령 → [CLI 레퍼런스](cli-reference.md)
- 인증·프로바이더 오류 해결 → [트러블슈팅](troubleshooting.md)
