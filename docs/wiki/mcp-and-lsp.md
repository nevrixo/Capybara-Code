# MCP와 LSP

두 개의 외부 통합 표면입니다. 둘 다 **CBC가 클라이언트이며 모델은 절대 서버와 직접 대화하지 않습니다.**

- MCP: `packages/mcp-client` (3,391줄) + `apps/cbc`의 호스트
- LSP: `packages/lsp-domain` (3,117줄, 순수) + `apps/cbc/src/lsp-host.ts` + `lsp-tool-bridge.ts`

---

# MCP (Model Context Protocol)

## 자세 (posture)

`mcp-client/src/client.ts:1-7`:

> §17.1이 자세를 진술합니다: CBC가 클라이언트이며, 라이프사이클·인증·탐색·권한·결과 정규화를 통제합니다. **모델은 서버와 대화하지 않습니다. CBC에게 요청하고, CBC가 결정합니다.**

## 프로토콜 리비전

| 상수 | 값 | 시대 |
| --- | --- | --- |
| `MCP_REVISION_CURRENT` | `2026-07-28` | `modern` |
| `MCP_REVISION_LEGACY` | `2025-11-25` | `legacy` |

**알 수 없는 *더 새로운* 리비전은 fail-closed입니다** — 호환성 메타데이터가 허용하지 않는 한 거부됩니다. 이유는 런타임 RPC(§19.12)와 동일합니다: **추론할 수 없는 리비전이 보안 관련 기본값을 옮겼을 수 있습니다** (`protocol.ts:1-13`).

두 시대의 차이:

- `modern`: 무상태(stateless), 요청 수준 메타데이터
- `legacy`: 연결에 세션 신원을 실음

modern이 무상태라서 **CBC는 연결을 대화 신원으로 취급하지 않습니다.** 그래서 서버를 세션 중간에 재시작해도 에이전트가 자기 위치를 잃지 않습니다 (`:11-13`).

Streamable HTTP에서 협상된 리비전은 `mcp-protocol-version` 헤더로 전달됩니다.

운영자 탈출구: `compatibleRevisions` — 내장되지 않은 리비전을 명시적으로 보증할 때만 사용합니다.

## 두 전송의 신뢰 속성 차이

`transport.ts:1-15`:

**stdio** — 로컬 프로세스를 띄웁니다. §19.6이 자식 감독을 Rust 런타임에 배정했으므로 **이 모듈은 아무것도 직접 spawn하지 않습니다** — 호스트가 `process.start`에 배선한 `StdioChannel`을 주입받아 그것을 통해 말합니다. 그래서 §17.12의 "stdio 명령 공급망 침해"가 그것을 봉쇄하도록 만든 하나의 프로세스 경계 안에 머무릅니다.

**Streamable HTTP** — 네트워크 I/O이므로 §19.4가 TypeScript에 배정했습니다. HTTPS가 기본이고, 리다이렉트는 origin 검사를 받으며, **TLS 검증은 설정 가능하지 않습니다** — §17.3이 프로젝트 설정이 이를 약화시킬 수 없다고 명시합니다.

### URL 규칙

`transport.ts:360-382`:

| 스킴 | 결과 |
| --- | --- |
| `https:` | 허용 |
| `http:` + 루프백 + `allowInsecureLoopback: true` | 허용 |
| `http:` + 루프백 (플래그 없음) | 거부 — "set allowInsecureLoopback to permit a local development server" |
| `http:` + 비루프백 | 거부 — "must use https:// (§17.3)" |
| 그 외 | `unsupported URL scheme` |

루프백 판정 (`isLoopback`): `localhost`, `127.0.0.1`, `::1`, `[::1]`, `*.localhost`.

### 리다이렉트 origin 검사

`fetch`가 `redirect: "manual"`로 호출되어 origin 검사가 실제로 실행되게 합니다 (`:567-568`).

**교차 origin 리다이렉트는 거부됩니다.** 이유가 오류 메시지에 명시됩니다 (`:585-588`): 요청이 원래 origin으로 스코프된 bearer 토큰을 실고 있으므로, 따라가면 그 토큰을 제3자에게 넘기게 됩니다 — §17.12의 confused deputy 위협(T7)입니다.

리다이렉트 대상도 `https:`여야 합니다. 리다이렉트 횟수 초과 시 `redirected too many times`, `Location` 헤더 없으면 별도 오류입니다.

설정 헤더는 **`Authorization`을 포함할 수 없고 TLS를 재정의할 수 없습니다** (`:342`).

## 서버 상태 8종

`McpServerState` (`client.ts:42-50`): `configured`, `starting`, `connecting`, `ready`, `degraded`, `failed`, `disabled`, `stopped`.

`McpServerStatus`가 `server`, `state`, `transport`, `revision?`, `era?`, `serverInfo?`, `toolCount`, `resourceCount`, `promptCount`, `lastError?`, `diagnostics[]`를 노출합니다 — `/mcp` 오버레이가 이것을 렌더링합니다.

## 재시작 백오프

`restartDelayMs(attempt, baseMs = 500, maxMs = 30_000)` (`transport.ts:776`):

```
지수 = min(30_000, 500 × 2^(attempt-1))
지연 = round(지수 × (0.5 + random × 0.5))
```

**지터가 있는 이유가 명시되어 있습니다:** 여러 서버가 함께 실패했을 때 lockstep으로 재시도하지 않도록 (`:778-779`).

클라이언트는 `#restarts` 맵으로 서버별 시도 횟수를 추적하고, 성공 시 삭제합니다 (`client.ts:735-748`).

## 거부되는 서버→클라이언트 메서드

`REFUSED_SERVER_METHODS` (`protocol.ts:182-196`). §17.4는 타임아웃이나 조용한 드롭이 아니라 **명시적 프로토콜 오류**를 요구합니다 — 서버 작성자가 왜 자기 기능이 동작하지 않았는지 볼 수 있어야 하기 때문입니다.

| 메서드 | 거부 이유 |
| --- | --- |
| `sampling/createMessage` | CBC는 서버에게 모델 접근을 부여하지 않습니다. 샘플링 비활성 |
| `elicitation/create` | 승인 경로 밖에서 부작용을 일으킬 수 있으므로 이 릴리스에서 비활성 |
| `tasks/create`, `tasks/get`, `tasks/list`, `tasks/cancel` | MCP Tasks 확장은 이 릴리스에서 미지원 |

거부는 `{code: -32601, message: <이유>, data: {method, disabledBy: "client-policy"}}`로 나갑니다.

## 카탈로그와 지연 스키마 로드

`§17.7`의 흐름 (`catalog.ts:1-12`):

```
모델이 mcp.search 호출
  → CBC가 서버 능력을 순위 매김
  → 상위 서술자 반환
  → 모델이 하나 선택
  → CBC가 정확한 스키마 로드
  → 권한 평가
  → 그다음에야 호출
```

**스키마가 선택 시점에 로드되는 이유는 스킬 본문 지연(§16.4)과 같습니다** — 큰 카탈로그가 캐시된 프롬프트 접두사를 잡아먹습니다.

**서버 제공 설명은 신뢰되지 않은 외부 텍스트로 라벨링되어야 합니다** — 설명은 악의적 서버가 통제하는 채널이기 때문입니다 (§17.12).

`DEFAULT_CATALOG_TTL_MS = 5분`. 갱신은 TTL **또는** `listChanged` 알림 중 하나로 트리거됩니다. 둘 다 있는 이유: 서버가 `listChanged`를 구현하지 않을 수 있고, TTL만으로는 이름이 바뀐 도구가 몇 분간 깨진 상태로 남습니다 (`catalog.ts:46-52`).

`McpCapabilityDescriptor`는 `inputSchemaHash`(`schemaHash(tool.inputSchema)`)를 실어 스키마 변경을 감지합니다.

## 위험 해석 체인

`resolveMcpRisk(input)` (`permission.ts:48`)가 §17.8 순서를 그대로 구현합니다. 권위 높은 순:

| 순서 | `RiskSource` | 설명 |
| --- | --- | --- |
| 1 | `user-override` | 사용자 설정의 `server/tool` 또는 bare `tool` 키 |
| 2 | `builtin-metadata` | CBC와 함께 출하되거나 신뢰된 배포자가 서명한 메타데이터 |
| 3 | `annotation` | 도구 애노테이션 |
| 4 | `classifier` | 휴리스틱 분류기 |
| 5 | `unknown-default` | 알 수 없음 → ask |

**순서가 중요한 이유:** 이것이 자기 위험을 서술하는 것들 중에서 **서버를 마지막에** 놓습니다. §17.8의 마무리 문장이 명시합니다 — **서버는 read-only를 주장하고도 승격될 수 있습니다** (`permission.ts:10-14`).

`ResolvedMcpRisk.promotedOverServerClaim`이 CBC가 서버 주장 위로 위험을 올렸는지 알려줍니다.

### 이름 기반 분류기

`classifyMcpCapability` (`catalog.ts:203`)가 이름 토큰을 `DESTRUCTIVE_VERBS`, `WRITE_VERBS`, `READ_VERBS`와 맞춰봅니다.

`McpCapabilityRisk`: `read` | `write` | `destructive` | `unknown`.

애노테이션 상호작용:

- `destructiveHint: true`이고 분류가 destructive가 아니면 → **destructive로 승격**
- `readOnlyHint: true`이고 분류가 `read`/`unknown`이면 → `read`
- `readOnlyHint: true`인데 이름이 write/destructive를 시사하면 → **분류기가 이깁니다**

마지막 경우의 주석이 논리를 밝힙니다 (`:239-243`): "read-only를 주장하는 `delete_issue`는 잘못 라벨링되었거나 거짓말하는 것이며, 두 경우 모두 더 높은 등급을 받을 만합니다."

이름이 아무 단서도 주지 않으면 `unknown`이며 이유는 `'<name>' gives no reliable indication of its side effects`입니다.

## 결과 정규화

`results.ts`가 §17.10을 구현합니다: 콘텐츠 타입 정규화, 텍스트 발췌 상한, 바이너리·이미지를 아티팩트 참조로, 애노테이션을 메타데이터로 유지, 텍스트를 모델 컨텍스트에서 untrusted로 래핑, **도구 오류를 전송 오류와 구분**, 출처 서버와 도구를 항상 첨부.

한계: `MAX_TEXT_BLOCK_CHARS = 32 KiB` (블록당), `MAX_RESULT_CHARS = 64 KiB` (결과 전체 텍스트 예산, 초과분은 스필).

### 터미널 제어 시퀀스 정화

`sanitizeExternalText(raw)` (`results.ts:31`). **정화가 TUI가 아니라 여기 있는 이유** (`:8-11`): MCP 응답 안의 OSC 클립보드 시퀀스가 터미널에 절대 도달해서는 안 되고, 응답은 무엇에 도달하기 전에 이 함수를 통과합니다 (AC-33).

제거 대상:

| 대상 | 이유 |
| --- | --- |
| OSC (`ESC ] … BEL\|ST`) | 창 제목 설정, **클립보드 쓰기 (OSC 52)**, 장치 질의 시작 가능 |
| DCS, SOS, PM, APC (`ESC P/X/^/_ … ST`) | 동일 부류 |
| CSI (`ESC [ params final`) | "유지할 가치가 있는 CSI는 색상뿐이고, MCP 도구 결과가 타임라인을 색칠할 이유가 없습니다" |
| 남은 2문자 이스케이프 | — |
| C1 제어 도입자 (`U+0080`–`U+009F`) | 일부 터미널이 CSI/OSC로 취급 |
| C0 제어 (탭·개행 제외, `U+007F` 포함) | **단독 CR은 텍스트가 자기를 덮어쓰게 함** |

## MCP 인증 (OAuth)

`oauth.ts`가 §17.9를 구현합니다: 인증 서버 메타데이터 탐색, PKCE, state·nonce 검증, 루프백 또는 device flow, 스코프 표시, **OS 키체인에 토큰 저장**, refresh 회전, 서버별 자격 증명 격리, 로그아웃·revoke, **모델에 토큰 노출 없음**.

마지막 항목은 기억해야 할 규칙이 아니라 **구조적**입니다 (`:9-12`): 여기 어떤 함수도 프롬프트에 넣을 수 있는 호출자에게 토큰을 반환하지 않습니다. 전송이 요청 시점에 `Authorization` 헤더 값을 요청하고 **절대 보관하지 않습니다.**

§17.12의 confused deputy(T7) 때문에 **audience가 리소스별로 추적됩니다** — 한 MCP 서버에 발행된 토큰이 다른 서버에 제시되어서는 안 됩니다 (`:14-15`).

탐색 경로 (`:37-39`):

| 상수 | 경로 |
| --- | --- |
| `PROTECTED_RESOURCE_PATH` | `/.well-known/oauth-protected-resource` |
| `AUTHORIZATION_SERVER_PATH` | `/.well-known/oauth-authorization-server` |
| `OPENID_CONFIGURATION_PATH` | `/.well-known/openid-configuration` |

`parseAuthorizationServerMetadata`는 `issuer`와 `token_endpoint`를 필수로 하고, `authorization_endpoint` 또는 `device_authorization_endpoint` 중 **하나는 있어야** 합니다 — device flow에는 authorization endpoint가 필요 없으므로 단독 필수는 아닙니다 (`:52-57`).

## MCP 도구 3개

| 도구 | 설명 |
| --- | --- |
| `mcp.search` | MCP 서버 능력 찾기 |
| `mcp.call` | 선택된 능력 호출 |
| `mcp.read_resource` | 리소스 읽기 |

## 워크스페이스 루트

`McpClientOptions.workspaceRoot` — **서버에 노출되는 유일한 루트**입니다 (§17.4, `client.ts:57-58`).

## MCP 설정

`mcpServers.<name>` (`config-schema/src/schema.ts:287-298`):

| 필드 | 타입 | 비고 |
| --- | --- | --- |
| `transport` | `stdio` \| `streamable_http` | 필수 |
| `command` | string? | stdio용 |
| `args` | string[]? | — |
| `url` | string? | HTTP용 |
| `env` | string[]? | 환경 변수 **이름** 목록 (값이 아님) |
| `auth` | `none` \| `oauth` \| `bearer` | — |
| `enabled` | boolean? | — |
| `connectOnStartup` | boolean? | 세션 부트스트랩 시 연결 vs 첫 사용 시 |
| `timeoutMs` | number? | — |

기본값은 `{}`입니다 — 내장 MCP 서버가 없습니다.

**신뢰되지 않은 워크스페이스에서는 MCP 서버가 `disabled`로 추가됩니다** (목록에는 보이지만 시작되지 않음). 자세한 내용은 [권한과 신뢰](permissions-and-trust.md)를 참고하십시오.

---

# LSP (Language Server Protocol)

## 자세

`apps/cbc/src/lsp-host.ts:1-7`:

> 호스트는 의도적으로 언어 서버를 **신뢰된 Build 워크스페이스**, **읽기 전용 document-symbol 요청**, **유계 프로토콜 프레임**으로 제한합니다. LSP 출력은 `RepositoryIntelligence`를 풍부하게 하며, **절대 무계 모델 컨텍스트가 되지 않습니다.**

`packages/lsp-domain`은 순수합니다 — 파일시스템도 프로세스 권한도 없습니다. 정규화와 계획 수립만 합니다.

## 17개 브리지 도구

**전부 R0이고 전부 `mutates: false`이며 `authority: "read"`입니다.** 미리보기(preview)를 만드는 도구조차 파일을 쓰지 않습니다.

### 진단·심볼 (3)

| 도구 | 결과 스키마 |
| --- | --- |
| `lsp.diagnostics` | `lsp.diagnostics.v1` |
| `lsp.symbols` | `lsp.symbols.v1` |
| `lsp.workspace_symbols` | `lsp.workspace_symbols.v1` |

### 정의 이동 (4)

`lsp.definition`, `lsp.declaration`, `lsp.type_definition`, `lsp.implementation`

### 참조·정보 (4)

`lsp.references`, `lsp.hover`, `lsp.signature_help`, `lsp.document_highlights`

### 구조 (1)

`lsp.call_hierarchy` — `MAX_CALL_HIERARCHY_OFFSET = 256`, `MAX_CALL_HIERARCHY_LIMIT = 32` (`lsp-tool-bridge.ts:59-60`)

### 미리보기 (5)

| 도구 | 하는 일 |
| --- | --- |
| `lsp.code_actions` | 코드 액션 카탈로그 (최대 `MAX_CODE_ACTIONS = 16`) |
| `lsp.code_action_preview` | 카탈로그 인덱스로 제안 생성. **"The returned proposal does not write files."** |
| `lsp.rename_preview` | revision-bound 이름 변경 제안, `newName` 최대 1,024자 |
| `lsp.format_preview` | 현재 리비전 포매팅 제안 |
| `lsp.range_format_preview` | 범위 포매팅 제안 |

`lsp.code_action_preview`의 `actionIndex` 설명이 계약을 명시합니다: "Zero-based index from `lsp.code_actions`" — 그리고 `lsp-host.ts:173`의 주석이 보강합니다: **"Index from a fresh lsp.code_actions catalog; it is never an apply capability."**

미리보기 도구들은 `maxParallelism: 1`, `idempotency: "idempotent"`입니다.

## 진단 정규화

`lsp-domain/src/diagnostics.ts`의 `LspDiagnostic`은 **의도적으로 LSP `data`, code description, related information을 제외합니다** — 서버가 통제하는 무계 페이로드이기 때문입니다 (`:24-27`).

남는 필드: `range`, `severity?` (1–4), `code?`, `source?`, `message`.

### 한계 상수

`diagnostics.ts:10-20`:

| 상수 | 값 |
| --- | --- |
| `MAX_INPUT_DIAGNOSTICS` | 4,096 |
| `MAX_DIAGNOSTICS_PER_SNAPSHOT` | 256 |
| `DEFAULT_MAX_DIAGNOSTICS` | 128 |
| `MAX_INPUT_WORKSPACE_DIAGNOSTIC_REPORTS` | 512 |
| `MAX_WORKSPACE_DIAGNOSTIC_DOCUMENTS` | 128 |
| `MAX_WORKSPACE_DIAGNOSTIC_SNAPSHOTS` | 64 |
| `DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_SNAPSHOTS` | 32 |
| `MAX_DIAGNOSTIC_MESSAGE_BYTES` | 4,096 |
| `MAX_DIAGNOSTIC_METADATA_BYTES` | 256 |
| `MAX_IDENTIFIER_BYTES` | 256 |
| `MAX_WORKSPACE_ROOT_BYTES` | 32,768 |

브리지 측 별도 한계 (`lsp-tool-bridge.ts:50-60`): `MAX_SERVERS = 8`, `MAX_DIAGNOSTICS = 64`, `MAX_MESSAGE_BYTES = 512`, `MAX_METADATA_BYTES = 128`, `MAX_REVISION_BYTES = 256`, `MAX_TEXT_BYTES = 48 KiB`, `MAX_SEMANTIC_PATH_BYTES = 512`.

### 리비전 바인딩

진단 스냅샷은 **정확한 LSP document-version 일치 후에만** 발행됩니다. 그리고 소비자는 스냅샷을 현재로 취급하기 전에 `documentRevision`을 **새 런타임 소유 읽기와 다시 비교해야 합니다** (`diagnostics.ts:37-40`).

이것이 LSP 결과가 증거로 쓰일 수 있는 조건입니다 — LSP 서버가 본 파일과 지금 디스크의 파일이 같음을 런타임이 확인해야 합니다.

## LSP 서버 설정

`lspServers.<name>` (`config-schema/src/schema.ts:300-308`):

| 필드 | 타입 | 비고 |
| --- | --- | --- |
| `command` | string | 필수 |
| `args` | string[]? | — |
| `extensions` | string[] | **필수** — 확장자 목록 |
| `languageId` | string | **필수** |
| `enabled` | boolean? | — |
| `installHint` | string? | 서버가 없을 때 안내 |
| `timeoutMs` | number? | — |

`configuredLspServers` (`lsp-host.ts:57`)가 설정을 결정적 서술자로 변환하며 **기본값을 추가하지 않습니다** — 내장 언어 서버가 없습니다.

## LSP 동작 설정

`config-schema/src/schema.ts:685-697`:

| 키 | 기본값 | 범위 |
| --- | --- | --- |
| `lsp.enabled` | `true` | — |
| `lsp.planMode` | `disabled` | `disabled` \| `read-only-certified` |
| `lsp.maxOpenDocumentsPerServer` | 128 | ≥1 |
| `lsp.maxPendingRequestsPerServer` | 64 | ≥1 |
| `lsp.maxDiagnosticsPerFile` | 1,000 | ≥1 |
| `lsp.maxWorkspaceSymbols` | 5,000 | ≥1 |
| `lsp.restartLimit` | 3 | ≥0 |
| `lsp.restartWindowSeconds` | 300 | ≥1 |
| `lsp.recordQueryEvidence` | `true` | — |
| `lsp.mutations.rename` | `true` | — |
| `lsp.mutations.codeActions` | `true` | — |
| `lsp.mutations.formatting` | `true` | — |
| `lsp.mutations.previewRequired` | `true` | — |
| `lsp.mutations.maxFiles` | 100 | 1–100 |
| `lsp.mutations.maxChangedBytes` | 16,777,216 | ≥1 |
| `lsp.commands.allow` | `[]` | — |

**프로젝트 설정이 잠그는 키:** `lsp.mutations.rename`, `lsp.mutations.codeActions`, `lsp.mutations.formatting`은 프로젝트 레이어에서 `false`로만 설정할 수 있습니다 (`schema.ts:916-918`). 즉 프로젝트는 LSP 변경을 **끌 수만** 있고 켤 수 없습니다.

`lsp.commands.allow`도 프로젝트 제한 대상입니다 (`schema.ts:1389`).

워크트리 관련: `worktrees.lspPerWorktree` 기본 `true` (`:747`).

## LSP 편집 계획

`buildLspEditPlan` (`lsp-domain/src/workspace-edit.ts`)이 LSP `WorkspaceEdit`을 CBC의 `EditPlan`으로 변환합니다. `collectLspWorkspaceEditPaths`가 영향 경로를 모아 권한 평가에 넘깁니다.

`workspacePathFromLspUri`가 `file://` URI를 워크스페이스 상대 경로로 정규화합니다 — 여기서 워크스페이스 밖 경로가 걸러집니다.

실제 적용은 `fs.edit` 트랜잭션 경로를 통과합니다 — LSP는 계획만 만들고, 쓰기는 Rust 런타임이 합니다. 자세한 내용은 [도구 레퍼런스](tools.md)를 참고하십시오.

## LSP 런타임 접근면

`LspRuntime` (`lsp-host.ts:40-43`)이 호스트가 런타임에서 쓰는 것을 좁힙니다:

```ts
Pick<Runtime, "issueCapability" | "startJob" | "sendInput" | "stopJob" | "subscribeNotifications">
```

LSP 서버는 `process.start`로 시작되고 `lsp.stdio.output` 알림으로 출력을 받습니다.

> **알려진 프로토콜 드리프트:** `lsp.stdio.output`과 `mcp.stdio.output`은 Rust가 발행하지만 `NOTIFICATION_METHODS`에 선언되어 있지 않습니다. 디버그 빌드에는 `debug_assert!(is_known_notification(method))`가 있어 MCP/LSP stdio 자식이 stdout에 쓰는 순간 패닉합니다. 릴리스 빌드는 정상 동작합니다. 자세한 내용은 [아키텍처 — 알려진 프로토콜 드리프트](architecture.md#알려진-프로토콜-드리프트)를 참고하십시오.

## TUI

`/mcp`가 MCP 서버 헬스를 보여줍니다. LSP 상태는 사이드바의 서비스 목록(`SidebarService`)에 나타납니다.

## 관련 문서

- 도구 위험 등급과 스케줄링 → [도구 레퍼런스](tools.md)
- 신뢰가 MCP/LSP에 미치는 영향 → [권한과 신뢰](permissions-and-trust.md)
- 설정 키 전체와 프로젝트 제한 → [설정](configuration.md)
- 프로세스 감독 → [Rust 런타임](rust-runtime.md)
