# 도구 레퍼런스

## 아키텍처 원칙

`packages/tool-registry/src/catalog.ts:1-8`가 역할 분담을 명시합니다. **TypeScript는 카탈로그와 의도를 소유하고, Rust 런타임은 실행과 강한 경계를 소유합니다.** `apps/cbc/src/tools.ts:1-12`는 TS 측 어떤 코드도 파일시스템을 직접 만지거나 프로세스를 spawn하지 않는다고 확인합니다 — 모든 효과는 런타임이 재검증하는 RPC입니다.

전체를 관통하는 불변식은 **"모델은 제안하고, 절대 부여하지 않는다"**입니다. `packages/permissions/src/policy.ts:5-6`가 §24.1을 직접 인용합니다: "모델은 permission을 직접 grant할 수 없다." 모델이 말하는 어떤 것도 `allow`에 도달할 수 없고, 사용자 결정이나 기존 규칙만이 가능합니다.

이 불변식이 다음 설계 결정들의 이유입니다.

- `process.run` 스키마에서 `network` **모드**가 제거되었습니다 (선언인 `networkIntent`만 남음)
- 편집 앵커의 `occurrence`는 모호성을 해결할 수 없는 진단 힌트로 격하되었습니다
- MCP의 `readOnlyHint`는 분류기가 무시할 수 있는 힌트입니다
- Build 모드에서 `todo.write`의 `document` 필드가 스키마에서 제거됩니다
- 헤드리스 `allow-listed` 브로커는 규칙 매칭을 재구현하지 않습니다

## 도구 이름 인코딩

모델이 보는 이름은 점 표기 ID(`fs.read`, `process.run`)입니다. OpenAI Responses API는 `[A-Za-z0-9_-]{1,64}`만 허용하므로 `packages/provider-openai/src/openai.ts:1583-1642`가 **요청별 전단사(bijective) 코덱**을 만듭니다.

- 점 ID → `<readable>_<sha256 앞 16자리 hex>` (예: `fs_read_<hash>`)
- 이미 유효한 이름을 **먼저 예약**하므로 인코딩된 ID가 기존 이름을 가릴 수 없습니다
- `fromProvider`로 역매핑

레지스트리, 권한 규칙, 저널, MCP 라우팅은 와이어 이름을 절대 보지 않습니다.

## 위험 등급

`catalog.ts:11-21`:

| 등급 | 의미 |
| --- | --- |
| R0 | 읽기 전용 / 로컬 / 유계 |
| R1 | 로컬 가역 실행 |
| R2 | 유계 워크스페이스 변경 |
| R3 | 네트워크 / 의존성 / 광범위 실행 |
| R4 | 파괴적 또는 특권 로컬 |
| R5 | 자격 증명 또는 워크스페이스 외부 |
| R6 | 외부 부작용 |

**R4–R6은 세션 또는 프로젝트 범위의 allow 규칙을 절대 받을 수 없습니다** (`allowsBroadRule`, `catalog.ts:26-28`).

## 내장 도구 (66개)

`packages/tool-registry/src/catalog.ts:202-1813`. 18개가 `alwaysActive: true`입니다. 나머지는 `tool.discover`로 활성화해야 합니다.

공유 스키마 조각: `relativePath` (최대 4096자, `:93-98`), `timeoutMs` (100–600000, 기본 120000, `:111-117`), `maxOutputBytes` (1024–10485760, 기본 1048576, `:119-125`), `DEFAULT_READ_MAX_LINES = 400` (`:128`).

표기: 위험 = `defaultRisk`→`maxRisk`, **A** = alwaysActive, **M** = mutates.

### 파일시스템과 검색

| 도구 | 위험 | A | M | 주요 파라미터 |
| --- | --- | --- | --- | --- |
| `fs.read` | R0→R5 | ✓ | | `path`*, `startLine`, `maxLines`(1–5000, 기본 400), `mode`(preview\|exact), `maxBytes`(1024–8MiB), `recordEvidence`, `allowAbsolute` |
| `fs.read_many` | R0→R5 | | | `paths`(1–20) 또는 `items`(1–20 범위 객체), `maxTotalLines`(≤1000), `maxTotalBytes`(≤16MiB), `concurrency`(1–8, 기본 4) |
| `fs.list` | R0→R0 | ✓ | | `path`(기본 `.`), `maxEntries`(1–5000, 기본 500), `includeIgnored` |
| `fs.glob` | R0→R0 | ✓ | | `pattern`*(≤512), `limit`(1–2000, 기본 200) |
| `fs.search` | R0→R0 | ✓ | | `query`*(≤1024), `include`, `caseSensitive`, `regex`, `maxMatches`(1–500, 기본 100) |
| `fs.apply_patch` | R2→R2 | ✓ | ✓ | `diff`*(≤2,000,000자), `expectedHashes`(경로→SHA-256) |
| `fs.edit.preview` | R0→R5 | ✓ | | `plan`* — 쓰기 없이 앵커/범위 계획을 해석 |
| `fs.edit` | R2→R2 | ✓ | ✓ | `plan`* — 재-preflight 후 한 트랜잭션으로 원자 적용 |
| `fs.write` | R2→R2 | ✓ | ✓ | `path`*, `content`*(≤1MiB), `intent`*(create\|replace\|upsert), `expectedHash` |
| `fs.move` | R2→R2 | | ✓ | `from`*, `to`*, `expectedHash` |
| `fs.delete` | **R3→R4** | | ✓ | `path`*, `recursive`, `expectedHash` |

`fs.delete`가 R3 이상인 이유는 삭제가 로컬에서 가역적이지 않기 때문입니다 (`:912`).

`fs.read`의 `recordEvidence`는 유계 발췌를 읽어도 **파일 전체를 해싱**합니다. preview 또는 민감 읽기에서는 거부됩니다.

### LSP (17개, 모두 R0→R0, `authority: "read"`)

모두 `fullLsp` 게이트 뒤에 있습니다. 위치 파라미터는 `path`(≤512), `line`, `character`이며 **0부터 시작하는 UTF-16**으로 LSP 와이어 프로토콜과 일치합니다.

`lsp.diagnostics`, `lsp.symbols`, `lsp.workspace_symbols`, `lsp.definition`, `lsp.declaration`, `lsp.type_definition`, `lsp.implementation`, `lsp.references`(+`includeDeclaration`, 기본 true), `lsp.hover`, `lsp.signature_help`, `lsp.document_highlights`, `lsp.call_hierarchy`(+`direction`*, `offset` 0–256, `limit` 1–32 기본 16), `lsp.code_actions`, `lsp.code_action_preview`(+`actionIndex`* 0–255), `lsp.format_preview`, `lsp.range_format_preview`, `lsp.rename_preview`(+`newName`* ≤1024).

**결정적 설계 속성: 어떤 LSP 도구도 파일을 쓰지 않습니다.** 변경 형태의 세 도구는 모두 `_preview`이고 `mutates: false`이며, 별도의 `fs.edit` 권한 경로를 통과해야 하는 리비전 바인딩 `EditPlan` 제안을 반환합니다. `lsp.code_action_preview`는 command 없는 code action만 받으므로 서버가 `workspace/executeCommand`를 몰래 넣을 수 없습니다 (`:611`).

### 메모리 (`durableMemory` 게이트)

| 도구 | 위험 | 파라미터 |
| --- | --- | --- |
| `memory.search` | R0→R0 | `key`(≤512), `query`(≤2048), `statuses`(active\|superseded\|contested), `scopes`(workspace\|session\|task), `taskId`, `path`, `limit`(1–200, 기본 32) |
| `memory.remember` | R1→R1 | `key`*(≤512), `value`*(≤16KiB), `scope`, `taskId`, `paths`(≤128), `evidenceIds`*(1–128), `confidence`(0–1), `reason`(≤512) |

`memory.remember`는 `authority: "session_state"`, `idempotency: "reconcilable"`, `mutates: false`입니다. 저장에는 런타임이 발급한 증거 ID가 최소 1개 필요하며, 스키마가 `value`에 원시 트랜스크립트/비밀/숨겨진 추론을 넣는 것을 금지합니다.

### 프로세스와 셸

| 도구 | 위험 | A | 파라미터 |
| --- | --- | --- | --- |
| `process.run` | R1→**R6** | ✓ | `program`*(≤512), `args`(≤128개, 각 ≤4096), `cwd`, `timeoutMs`*, `maxOutputBytes`, `env`, `networkIntent{required*, reason}` |
| `process.start` | R1→R6 | | `program`*, `args`, `cwd`, `timeoutMs`*, `maxOutputBytes` |
| `process.input` | R1→R6 | | `jobId`*, `data`(≤65536), `close` |
| `process.stop` | R1→R1 | | `jobId`* |
| `shell.run` | **R3**→R6 | | `script`*(≤65536), `cwd`, `timeoutMs`*, `maxOutputBytes` |

두 가지 설계 결정이 핵심입니다.

1. `process.run`은 **실행 파일 + argv를 받고 원시 문자열은 절대 받지 않습니다** (`:946`).
2. 모델이 `allow`로 설정할 수 있었던 네트워크 **모드**가 스키마에서 제거되었습니다 (`:953-955`). 모드는 부여이고, 모델은 부여할 수 없습니다. 선언인 `networkIntent`만 남았습니다.

`shell.run`은 원시 셸이 승인 게이트를 거쳐야 하므로 기본이 R3입니다 (`:1030`).

### 아티팩트, Git, 워크트리, 머지

| 도구 | 위험 | A | M | 파라미터 |
| --- | --- | --- | --- | --- |
| `artifact.read` | R0→R0 | ✓ | | `digest`*(28–71자), `excerptHeadLines`(0–2000, 기본 200), `excerptTailLines`(동일), `excerptMaxBytes`(1024–65536) |
| `git.status` | R0→R0 | ✓ | | 없음 |
| `git.diff` | R0→R0 | ✓ | | `range`, `paths`(≤64) |
| `git.log` | R0→R0 | | | `limit`(1–200, 기본 20), `path` |
| `git.show` | R0→R0 | | | `revision`*, `path` |
| `git.checkpoint` | R2→R2 | | ✓ | `label`(≤200) — 로컬 안전 객체, 어떤 브랜치에도 커밋하지 않음 |
| `worktree.list` | R0→R1 | | | 없음 |
| `worktree.inspect` | R0→R1 | | | `path`* |
| `worktree.create` | R2→R3 | | ✓ | `path`*, `commit`*, `requireClean`(기본 true) |
| `worktree.remove` | **R3→R4** | | ✓ | `path`* — writer 리스가 먼저 해제되어야 함 |
| `merge.preview` | R1→R2 | | | `base`*, `ours`*, `theirs`* |
| `merge.apply` | **R3→R4** | | ✓ | 동일 — 충돌 시 **fail-closed, 충돌 마커를 절대 쓰지 않음** |
| `merge.resolve` | R3→R4 | | ✓ | `path`*, `choice`*(ours\|theirs\|manual), `manualText` 등 |

**커밋 도구는 의도적으로 없습니다** (`packages/permissions/src/classifier.ts:368`: "§12.2 withholds a commit tool").

### 상호작용, 태스크, 확장

| 도구 | 위험 | A | 주요 파라미터 |
| --- | --- | --- | --- |
| `user.ask` | R0→R0 | ✓ | `question`*(≤2000), `choices`(≤8) |
| `user.ask_batch` | R0→R0 | ✓ | `questionnaireId`*, `reason`*(≤1200), `questions`*(1–4개), `allowDraftNow` |
| `task.search` | R0→R0 | | `query`*(≤500) |
| `task.spawn` | R1→R2 | | `role`*, `title`*, `goal`*(**최소 20자**, ≤2000), `constraints`/`expectedOutput`/`context`(각 ≤12), `allowedPaths`/`forbiddenPaths`(≤32), `verification`, `modelProfile`, `deadlineMs`(1000–**300000**), `detached` |
| `task.status` | R0→R0 | | `taskId`, `awaitCompletion`, `collectContext` |
| `task.await` | R0→R0 | | `taskId`*, `collectContext` |
| `task.message` | R0→R0 | | `taskId`*, `kind`*, `text`(≤32768), `ids`/`paths`(≤256) |
| `task.cancel` | R1→R1 | | `taskId`*, `reason`(≤500) |
| `plugin.invoke` | R1→R2 | | `pluginId`*, `method`*, `params` |
| `skill.search` | R0→R0 | | `query`*(≤500) |
| `skill.load` | R0→R0 | | `name`*(≤128) |
| `mcp.search` | R0→R0 | | `query`*(≤500) |
| `mcp.call` | R1→**R6** | | `server`*, `tool`*, `arguments`. `network: true` |
| `mcp.read_resource` | R0→R1 | | `server`*, `uri`*. `authority: "network"` |

`task.spawn`의 `deadlineMs` 상한이 300000인 이유: §15.7이 모든 자식을 5분으로 제한하고 `buildTask`가 더 큰 값을 clamp하므로, 스키마가 spawn이 받을 수 없는 값 대신 실제 상한을 명시합니다 (`:1474-1477`).

### 세션 상태와 복합 도구

**`todo.write`** (`:1662`, R0→R0, alwaysActive, `authority: "session_state"`). 커스텀 복구 정책: `{maxAttempts: 2, retryableCodes: ["TODO_REVISION_CONFLICT"], retrySafety: "before_dispatch"}`.

파라미터: `expectedRevision`*, `reason`*(≤300), `items`*(≤20개: `id`≤64, `text`≤240, `status`*(pending\|active\|done\|blocked\|skipped), `kind`(analysis\|implementation\|verification), `files`/`symbols`/`acceptanceCriteria`≤32, `dependsOn`≤20, `commands`≤20, `evidence`≤12, `blockedReason`), 그리고 `document`(Plan Contract: `goal`*, `context`*, `criticalFiles`*, `verification`*, `risks`*, `rollback`*, 선택적 `assumptions`, `externalActions`).

`packages/tool-registry/src/index.ts:18-33`이 **Build 모드에서 `document`를 스키마에서 제거하고** 구조화된 Plan Contract는 Plan 모드 전용이라는 주석을 추가합니다.

**`tool.discover`** (`:1737`, R0→R0, alwaysActive): `query`*(≤500), `limit`(1–25, 기본 10).

**`repo.investigate`** (`:1756`, R0→R5, alwaysActive): `queries`(≤5), `paths`(≤20), `includeManifests`(기본 true), `includeGitDiff`, `maxFiles`(1–50, 기본 20), `maxLinesPerFile`(1–1000, 기본 200). 실행은 `apps/cbc/src/tools.ts:1149-1238` — 검색·읽기·선택적 diff를 동시에 팬아웃하고, 8개 매니페스트 경로(`package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`)를 자동 포함하며 **렌더링 출력을 64 KiB에서 절단**합니다.

**`verification.run_many`** (`:1788`, R1→R4, alwaysActive): `commands`*(1–12, 각 ≤2000), `maxParallel`(1–4, 기본 2), `failFast`. 실행기가 아니라 커널 내부에서 처리됩니다 (`packages/agent-kernel/src/kernel.ts:3268-3397`). 검증 계약 외부의 명령은 `not_run`/blocked로 기록되며, **승인은 별도의 직렬 단계로 실행**되어 브로커가 미결 요청을 최대 하나만 갖고 `fail-on-ask`가 이미 시작된 작업과 경쟁하지 않습니다.

## 도구 활성화와 게이팅

`ToolRegistry` (`packages/tool-registry/src/index.ts:40-193`)는 `#tools` 맵과 `#active` 집합을 가집니다. 스킬과 MCP는 **같은 레지스트리**에 등록합니다 — §6.9가 동적 도구도 별도 UI가 아니라 같은 탐색 UI를 쓰도록 요구합니다.

네 개의 독립적인 게이트가 있습니다.

**(a) 기능 플래그** — `nativeToolsForFeatures` (`catalog.ts:1867-1887`).

| 플래그 | 게이트되는 도구 | 개수 |
| --- | --- | --- |
| `editEngineV2` | `fs.edit.preview`, `fs.edit` | 2 |
| `durableMemory` | `memory.search`, `memory.remember` | 2 |
| `worktreeMultiAgent` | `worktree.*` 4개, `merge.*` 3개 | 7 |
| `fullLsp` | `lsp.*` 전체 | 17 |
| `pluginRuntime` | `plugin.invoke` | 1 |
| `lspRenamePreview` **+ editEngineV2** | `lsp.rename_preview` | 1 |
| `lspCodeActionPreview` **+ editEngineV2** | `lsp.code_action_preview` | 1 |
| `lspFormattingPreview` **+ editEngineV2** | `lsp.format_preview`, `lsp.range_format_preview` | 2 |
| `agent.compoundTools` | `repo.investigate`, `verification.run_many` | 2 |

세 LSP 변경 플래그는 `editEngineV2`와 **논리곱**입니다 — 편집 계획을 만드는 preview는 그것을 적용할 엔진 없이는 쓸모가 없습니다.

`apps/cbc/src/agent.ts:607-642`에서 추가로: `fullLsp`는 `lsp.enabled` + 신뢰된 워크스페이스 + 살아 있는 LSP 브리지를 요구하고, `durableMemory`는 활성화된 메모리 스코프가 최소 하나 필요합니다.

실행 경계에서도 이중으로 강제합니다. 어떻게든 디스패치에 도달한 도구는 여전히 fail-closed입니다: `fs.edit` → `NOT_FOUND` "structured edit is disabled; enable experimental.editEngineV2 to use it" (`tools.ts:1469-1477`), `plugin.invoke` → `NOT_FOUND` "plugin runtime is disabled; enable experimental.pluginRuntime" (`:1964-1972`).

**(b) 탐색 활성화** — `discoverFor` (`:139-163`)는 §21.4 활성화 예산(기본 10)에서 alwaysActive 도구를 제외합니다. 그렇지 않으면 기본 카탈로그가 예산 전체를 소진해 탐색이 아무것도 활성화할 수 없게 됩니다.

랭킹은 결정적 BM25 계열 키워드 매칭입니다 (`discovery.ts:54-117`): id 정확 3.2×idf, id 접두사 1.6×, 제목 2.4×, 키워드 2.0×, 키워드 접두사 0.9×, 설명 0.8×, ID 전체가 그대로 나타나면 +2.5. 동점은 id 오름차순. 토크나이저는 한글을 지원합니다 (`:155`).

**(c) 상호작용 모드** — `isPlanSafeTool` (`:1929-1936`)은 Plan 모드에서 `authority === "session_state"`이거나, `authority === "read"` **및** `defaultRisk === "R0"` **및** `!mutates` **및** `!network`를 모두 만족하는 도구만 허용합니다.

**(d) 호출 검증** — `validateCall` (`:166-192`)이 알 수 없는 도구, 비활성 도구("call tool.discover first"), Plan 모드 비안전 도구를 스키마 검증 전에 거부합니다.

### 실행 메타데이터

`withExecutionMetadata` (`:1890-1926`)가 기본값을 채웁니다.

- `authority` — mutates/process/network 접두사로 추론
- `maxParallelism` — 8(read) / 2(process) / 1(그 외)
- `canRunInProgram`/`canRunInHostedAgent` — 정확히 `fs.read, fs.read_many, fs.list, fs.glob, fs.search, git.status, git.diff, git.log`만 허용
- `recovery.maxAttempts` — pure/idempotent/reconcilable이면 3, 아니면 1

## 스케줄링

`schedule()` (`scheduler.ts:89-195`)가 순서를 강제합니다: **read → 배리어 → write → 배리어 → process/external → interactive**.

`DEFAULT_SCHEDULER_LIMITS` (`:44-49`): `maxConcurrentProcesses: 4`, `maxConcurrentReads: 8`, `maxConcurrentPerMcpServer: 2`, `maxToolCallsPerTurn: 64`.

거부 코드: `LEASE_VIOLATION`, `PATH_OVERLAP`, `BUDGET_EXHAUSTED`, `UNKNOWN_TOOL`.

**한 턴에서 겹치는 경로에 두 번 쓰는 것은 직렬화가 아니라 거부됩니다** (`:86-87`) — 모델이 그 사이에 다시 읽어야 하기 때문입니다. 쓰기는 배치당 하나입니다 (`:171-172`).

`ToolExecutionGraph` (`graph.ts`)가 더 세밀한 플래너입니다. `DEFAULT_TOOL_GRAPH_LIMITS`: `maxParallelReads: 8`, `maxParallelTests: 2`, `serializeMutations: true`, `stableResultOrder: true`, `maxNodes: 64`. `mustOrder` (`:246-254`)가 모든 충돌에 happens-before 엣지를 강제하고, interactive/external/process 종류에는 무조건 강제합니다. 배치 내 동일한 읽기는 `toolId + 정렬된 conflictKeys`로 키잉된 공유 프로미스로 병합됩니다 (`:202-209`).

`overlappingGlobs` (`:223-234`)는 의도적으로 겹침 보고 쪽으로 기울어 있습니다: "오탐은 범위를 좁히는 비용이지만, 미탐은 모순된 경로 권한을 부여할 수 있다."

## 편집 도메인: 트랜잭션 파일 변경

### 원자성

`preflightEditPlan` (`packages/edit-domain/src/engine.ts:55-115`)은 **순수하고 부작용이 없습니다** — "의도적으로 파일시스템에 절대 쓰지 않으며, 호출자가 staged 파일 결과를 Rust 트랜잭션 권한에 넘긴다" (`:51-54`). 반환값의 각 `PreparedFileChange`는 **완성된 staged 텍스트 전체**를 담습니다.

실제 원자성은 `apps/cbc/src/tools.ts:2212-2287`의 3단계 트랜잭션입니다.

1. `beginTransaction` → `transactionId`, `started` 이벤트
2. `stage(transactionId)` — 예외 시: `rollbackTransaction`, `rolled_back` 이벤트, 오류 반환
3. `commitTransaction` — 예외 시: 롤백, `rolled_back` 이벤트, 오류 반환

**stage와 commit을 분리한 것이 다중 파일 패치를 all-or-nothing으로 만드는 이유입니다** (AC-14). 사용자의 동시 편집으로 인한 해시 불일치로 staging이 실패해도 롤백 경로가 실행됩니다 (AC-13, `:2205-2211`).

모든 단계가 능력 3원소(`capabilityReceipt`, `capabilitySessionId`, `capabilityActionHash`)를 전달합니다. 커밋 시 `readCache.invalidatePaths(...)`가 보고된 경로로 무효화를 한정하고, 트랜잭션이 경로를 보고하지 않으면 `invalidateAll()`입니다.

`fs.edit` (`tools.ts:1497-1532`)은 먼저 preview한 뒤 `expectedPlanDigest: preview.planDigest`를 `applyEdit`에 넘기므로, 런타임이 preflight와 apply 사이에 계획이 드리프트하지 않았음을 재검증합니다.

### 두 가지 패치 형식

**텍스트 unified diff** (`fs.apply_patch`): `--- a/path` / `+++ b/path` 헤더, 고유한 old-side 컨텍스트를 가진 bare `@@`를 선호하되 번호가 붙은 hunk도 수용 (`catalog.ts:811-816`). 파일별 낙관적 동시성은 `expectedHashes`(경로 → SHA-256).

**구조화된 `EditPlan`** (`fs.edit`, `edit-domain/src/types.ts:127-141`, 스키마 `schemas/edit/plan.schema.json`). 8개 연산: `replace_anchor`, `replace_range`, `insert_before`, `insert_after`, `delete_anchor`, `create_file`, `move_file`, `delete_file`.

앵커 3종:

- `exact_text` — digest + 선택적 `expectedRange` + `occurrence` 힌트
- `context` — before/after 줄, `whitespacePolicy` ∈ exact\|normalize_eol\|normalize_indent
- `symbol` — 언어 + 심볼 경로 + 선택적 `fallbackContext`

### 충돌 감지 (계층적)

**계획 검증** (`:127-163`): 스키마 버전이 `"1.0"`, `id`가 `edp_` 접두사, 연산 ID가 `edo_` 접두사이며 고유, `createdAt`이 ISO-8601, 연산 수가 1..`maxOperations`, 그리고 `plan.workspaceIdentityDigest === snapshot.workspaceIdentityDigest` — 아니면 `EDIT_SCOPE_VIOLATION`.

**경로 검증** (`:187-200`): 빈 문자열, 백슬래시 포함, 절대 경로, 드라이브 접두사, 빈/`.`/`..` 세그먼트를 모두 거부.

**연산 간 충돌** (`:202-262`): 같은 경로의 중복 create/delete/move, move 원본 == 대상, move 원본/대상 충돌, 그리고 **같은 경로의 파일 연산과 텍스트 연산 충돌**.

**범위 겹침** (`:414-448`): `rangesConflict`는 두 지점 삽입은 비충돌로, 범위 내부의 지점은 엄격히 내부일 때만 충돌로, 두 범위는 엄격한 구간 교차에서 충돌로 처리 → `EDIT_OVERLAP`.

**앵커 해석** (`anchors.ts:52-201`):

- *exact_text* — `textDigest(originalText) === originalTextDigest` 검증. 리비전이 일치하고 `expectedRange`가 검증되면 점수 160으로 해석. `conflictPolicy: "fail"` 하에서 기준 리비전 불일치는 `EDIT_REVISION_MISMATCH`. 후보가 여럿이면 `EDIT_ANCHOR_AMBIGUOUS`이며, **`occurrence` 힌트는 모호성을 해소할 수 없습니다** — "독립적인 범위/컨텍스트 증거 없이 중복 텍스트를 쓰기 대상으로 바꿀 수 없다" (`:123-124`).
- *context* — `targetDigest`와 일치하는 유계 `targetPreview` 필요. 후보 점수: 기본 100, before-context 일치 +30, after-context +30, 근사 줄 근접도 ≤5/≤20에 +15/+8, normalize_indent에 +5. 최고 − 차상위 < `anchorAmbiguityMargin`(기본 **5**)이면 모호.
- *symbol* — **fail-closed**: 신뢰된 로컬 범위 영수증 또는 컨텍스트 폴백 필요 (`:189-195`).

기본값: `maxOperations` 100, `maxFileBytes` 2 MiB, `maxAnchorCandidates` 32, `anchorAmbiguityMargin` 5, `maxDiffPreviewLines` 80.

**인코딩 안전성** (`position.ts:18-39`): `assertValidText`가 고립 서로게이트를 거부 → `EDIT_ENCODING_MISMATCH`. 오프셋 변환은 서로게이트 페어나 유니코드 스칼라 내부에 착지하면 예외. 지원 인코딩 3종: `utf8`, `utf16`, `unicode_scalar`.

13개 오류 코드 (`types.ts:208-221`). 적용 순서가 중요합니다: `applyResolvedOperations` (`:456-471`)는 **시작 오프셋 내림차순**으로 정렬하므로 앞선 편집이 뒤의 편집을 밀지 않습니다.

`merge.apply` 충돌은 쓰지 않고 거부합니다: `#applyMergeFiles` (`tools.ts:2289-2338`)가 코디네이터가 깔끔히 적용할 수 없을 때 `TRANSACTION_CONFLICT`를 반환하며, `containsConflictMarkers`를 임포트해 마커 텍스트가 작업 파일에 도달하지 않도록 강제합니다.

## 읽기/쓰기 경로 제한

**Rust가 권한자입니다.** `crates/cbc-fs/src/beneath.rs:25-51`의 `relative_parts`가 절대 경로와 모든 `ParentDir`/`RootDir`/`Prefix` 컴포넌트를 거부하고 최소 하나의 일반 컴포넌트를 요구합니다. 유닉스에서는 디렉터리 fd + `*at` 시스템콜, Windows에서는 일반 디렉터리 고정을 사용합니다. `:659` — "워크스페이스 접근 중 심볼릭 링크를 따르는 것을 거부".

**TypeScript는 정규화만 하고 결정하지 않습니다.** `apps/cbc/src/normalizer.ts:36-45`는 `..`를 의도적으로 **보존한다**고 명시합니다: "여기서 제거하면 승인 카드에서 순회 시도가 감춰지며, Rust 가드가 거부할 권한을 가진 컴포넌트다."

`workspacePath` (`tools.ts:214-243`)는 모델이 낸 절대 경로(WSL `/mnt/<drive>` ↔ Windows `C:` 별칭 포함, 해당 루트에서는 대소문자 무시)를 워크스페이스 상대 형태로 변환하고, 워크스페이스 소속을 증명할 수 없는 것은 **변경 없이 반환**하여 Rust가 거부하게 합니다.

`stripPath` (`:2342-2345`)는 전달 옵션에서 `path`/`paths`/`items`/`pattern`/`query`를 제거하므로 잘못된 인자가 런타임이 도출한 값을 덮어쓸 수 없습니다.

정책 레이어는 독립적으로 위험을 올립니다: `..`/`/`/`~`로 시작하는 경로 → R5 "워크스페이스 외부 경로를 대상으로 함" (`policy.ts:311-314`); 자격 증명 형태 경로(`.env`, `.pem`, `.key`, `id_rsa`, `id_ed25519`, `.ssh/`, `.aws/`, `.npmrc`, `.netrc`) → R5 (`:323-328`).

### 쓰기 도출

`WRITE_TOOLS` (`normalizer.ts:25-31`)는 정확히 `fs.apply_patch`, `fs.write`, `fs.move`, `fs.delete`, `fs.edit`입니다. 이들에 대해 수집된 경로는 `writes`가 되고, 그 외는 `reads`가 됩니다. 경로는 선언된 키뿐 아니라 diff 본문(`pathsFromDiff`)과 편집 계획(`pathsFromEditPlan`)에서도 추출됩니다.

커널은 런타임이 보고한 변경 경로를 `action.writes`보다 우선합니다 — "`action.writes`는 정규화된 *의도*일 뿐이고, `fs.apply_patch` 같은 도구는 대상을 diff 안에 담는다" (`kernel.ts:3516-3521`).

### 무시 규칙

`crates/cbc-fs/src/search.rs:16-37`의 `DEFAULT_IGNORED_DIRS`는 20개입니다: `.git`, `node_modules`, `target`, `dist`, `build`, `out`, `.next`, `.nuxt`, `vendor`, `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.gradle`, `.idea`, `.cache`, `coverage`, `.turbo`, `.svelte-kit`.

`WalkOptions` 기본값: `max_entries: 5000`, `max_depth: 32`, `include_ignored: false`, 추가로 `extra_ignored`.

> **`.gitignore`는 파싱되지 않습니다.** 필터링은 위의 하드코딩 목록과 TS 측 vendor/generated 목록이 전부입니다. 목록에 없는 이름의 대형 빌드 디렉터리는 순회되고 5000 엔트리 상한을 소모합니다.

### 민감 읽기

민감 경로를 건드리는 읽기는 능력 영수증을 요구합니다 (`tools.ts:393-395`). 관찰 파이프라인이 세 처분 중 하나를 적용합니다 (`:660-670`): `promoted`(컨텍스트 승격 후 본문을 경로+체크섬 참조로 교체), `withheld`, `raw`(정화됨). 컨텍스트 컴파일러가 예외를 던지면 민감 내용은 `withheld`로 fail-closed 됩니다 (`:993-998`).

## 셸/프로세스 실행 세부

`shell.run`은 스크립트를 `program`으로 보내고 `args: []`, `rawShell: true`, `capabilityOperation: "shell.run"`을 설정합니다 — "런타임이 프로그램 이름에서 의도를 추론하는 대신 더 엄격한 격리를 적용하도록" (`tools.ts:2190-2192`).

P0-03에 따라 **호출자가 선택한 네트워크 모드는 런타임에 도달하지 않습니다** (`:2178-2181`). 런타임이 자체 기본값을 유지하며, 능력 리스만이 더 엄격한 값으로 가는 경로입니다.

`#issueCapability` (`:2159`)는 `classifyCommand(command).network`가 true일 때만 `network: "allow"`를 설정하고, `networkIntent`가 선언되면 `ttlMs: 120_000`을 추가합니다.

### 정확한 수치 한계

`crates/cbc-process/src/limits.rs:28-37`:

| 자원 | 루트 기본 | 서브에이전트 |
| --- | --- | --- |
| 프로세스 타임아웃 | 600,000 ms (10분) | 300,000 ms (5분) |
| PTY 유휴 타임아웃 | 1,800,000 ms (30분) | 동일 |
| 스필 전 캡처 출력 | 10,485,760 B (10 MiB) | 동일 |
| 인메모리 인라인 버퍼 | 1,048,576 B (1 MiB) | 동일 |
| 동시 프로세스 | 4 | 2 |
| 최대 열린 파일 | 1,024 | 동일 |
| 최대 메모리 / CPU 초 | `None` | 동일 |

`clamp_timeout` (`:58-63`)과 `clamp_output` (`:65-70`)은 `0`을 "상한 사용"으로 취급하고 그 외에는 상한과 `min`하므로 §12.4에 따라 모델이 무제한 프로세스를 요청할 수 없습니다.

모델이 보는 스키마 범위는 더 좁습니다: `timeoutMs` 100–600,000 (기본 120,000), `maxOutputBytes` 1,024–10,485,760 (기본 1,048,576).

### 관찰 수준 스필

`OBSERVATION_ARTIFACT_THRESHOLD_BYTES = 8 * 1024` (`tools.ts:438`)를 넘는 도구 텍스트는 아티팩트로 스필됩니다. 모델은 4,096자 head, 4,096자 tail, 그리고 포인터를 봅니다:

```
[artifact id:… sha256:… N bytes; use artifact.read with {"digest":"…"}]
```

`spill` (`:1034-1071`)은 런타임의 `artifact.create`를 **await하고 저장소가 발급한 id/digest만 사용합니다** (P0-08) — 발명한 핸들로는 저장된 바이트를 절대 되읽을 수 없습니다. 실패 시 `undefined`를 반환해 관찰이 "저장할 수 없었다"고 말할 수 있게 합니다.

### 캐시 펜싱

`process.run`/`shell.run`은 `beginPotentialMutation()` 펜스를 열고 런타임이 `workspaceChangeObserved === false`를 증명할 때만 엔트리를 복원합니다 (`:1636-1649`). `process.start`, `process.input`, `process.stop`은 각각 `readCache.invalidateAll()`을 호출합니다 — 백그라운드 작업은 호출 반환 후에도 계속 변경하기 때문입니다.

### 명령 분류

`detectProcessSemantics` (`classifier.ts:241-251`)는 `direct-executable` | `shell-script` | `interpreter-inline-code`를 반환합니다. 이 구분이 P0-04 수정의 핵심입니다: `process.run sh -c "…"`는 직접 실행 호출이 *아니며*, 세 형태를 동일하게 취급한 것이 `shell = "deny"`를 `process.run`으로 셸을 실행해 우회할 수 있게 했습니다 (`:12-19`).

`classifyCommand` (`:254-526`)는 위험을 **올릴 수만 있고 도구 기준선 아래로 내릴 수 없습니다** (`:4-7`). 주요 규칙:

| 조건 | 결과 |
| --- | --- |
| 명시적 env | R3 |
| `EXECUTABLE_CONTROL_ENV` 일치 (LD_*, DYLD_*, NODE_OPTIONS, PYTHONPATH, GIT_CONFIG…) | +R4 |
| 자격 증명 형태 env | +R5 |
| 특권 프로그램 (sudo/doas/su/runas/pkexec/setcap/chown) | R4 |
| `rm -r` / `-f` | R4 |
| mkfs/dd/fdisk/diskutil/shred/srm | R4 |
| `git reset --hard` / `clean -f` / `checkout --force` | R4 |
| `git push` | R6 |
| 패키지 매니저 install | R3 network |
| 패키지 매니저 publish | R6 |
| 업로드 플래그가 있는 네트워크 프로그램 | R6 |
| kubectl/helm/terraform/aws/gcloud/az + 변경 동사 | R6 |

셸 계열 호출은 **인라인 코드 문자열을 분석**합니다: 워크스페이스 외부 리다이렉션 → R4, `| sh`/`| python` → R4, fork-bomb 패턴 → R4, 그리고 모든 `fetch(`/`http(s)://`/`curl`/`wget`은 담고 있는 프로그램 자신의 분류와 무관하게 network로 표시 (P0-03, `:471-476`).

`isFixedReadOnlyInvocation` (`:528-543`)이 안전 자동 승인의 좁은 게이트입니다: `direct-executable`만, 작은 프로그램 목록만, 모든 인자가 `[;&|<>$\`]`를 포함하지 않아야 함.

## 도구 복구

두 계층입니다.

### 결정 매트릭스

`packages/tool-registry/src/recovery.ts:82-109`의 `decideRecovery`는 순수합니다: "전송을 호출하거나 상태를 변경하지 않는다."

6개 복구 클래스: `input_repair`, `state_rebase`, `state_fence_wait`, `transient_safe_replay`, `unknown_outcome_reconcile`, `terminal`.

`NEVER_RETRY` (`:33-43`): `APPROVAL_DENIED`, `PERMISSION_DENIED`, `CANCELLED`, `INVALID_ARGUMENT`, `PROCESS_EXIT_NONZERO`, `PROCESS_FAILED`, `COMMAND_NOT_FOUND`, `AUTHENTICATION`, `HASH_MISMATCH_SCOPE`.

`DEFAULT_RETRYABLE` (`:45-55`): `INTERNAL`, `NOT_INITIALIZED`, `TIMEOUT`, `PATH_CHANGED`, `HASH_MISMATCH`, `NETWORK_UNAVAILABLE`, `RATE_LIMITED`, `TEMPORARY_UNAVAILABLE`, `MCP_TRANSPORT`.

백오프: `min(1000, 25 * 2^(attempt-1))` ms (`:91`).

순서: terminal 코드 우선 → `session_state` 도구의 `TODO_REVISION_CONFLICT` → `state_rebase` → pure/idempotent 도구의 `PATH_CHANGED` → `state_fence_wait` → 그 외 retryable + pure/idempotent → `transient_safe_replay` → reconcilable/process/external_effect → `unknown_outcome_reconcile` → 그 외 terminal.

### 실행기

`apps/cbc/src/tool-recovery.ts:138-352`의 `executeWithRecovery`. 핵심 속성 (`:131-137`): **호출자가 모델에 보이는 `tool.started`/`completed`/`failed` 생애주기를 소유하고, 이 실행기는 숨겨진 텔레메트리만 발행하며 최종 실행 하나를 반환합니다** — 재시도가 모델에 보이는 관찰을 중복시킬 수 없습니다.

시도 횟수는 `max(1, min(5, configuredMax, toolMax))`로 제한됩니다 (`:150`).

**abort는 terminal입니다** — 실행기 측 abort를 일시적 `INTERNAL`로 재분류해 또 다른 물리적 시도를 시작하지 않습니다 (`:174-177`).

`state_fence_wait`에서는 `PATH_CHANGED` 세대 전이를 `fencedPathChangedTransitions`로 추적하여, 펜스 한 번 후 **동일한** `path:before->after` 전이가 반복되면 `quiescence: "not_reached"`인 재시도 불가 `PATH_CHANGED`로 변환합니다 (`:259-277`).

소진 시 `withRecoveryExhaustedSummary` (`:93-101`)가 관찰 텍스트에 `Recovery exhausted after N attempt(s) (<class>): <reason>`을 덧붙입니다. 텔레메트리 발행은 try/catch로 감싸져 있습니다 — "복구 텔레메트리는 관찰적이며 도구의 진실을 절대 바꾸지 않아야 한다" (`:152-158`).

모드: `off`(완전 우회), `safe`, `full`.

### 잘못된 형식의 호출

AC-10은 복구 **전에** 처리됩니다 (`packages/tool-registry/src/validate.ts`). 검증기는 "검증할 수 없는 것은 통과시키지 않고 거부하므로, 인식되지 않는 키워드가 실수로 allow가 될 수 없다" (`:8-11`):

- 알 수 없는 `type` → 오류
- `enum` 없이 `type` 누락 → "schema has no declared type"
- `additionalProperties: false` 하의 알 수 없는 속성 → 조용한 제거가 아니라 오류, "모델이 올바른 형태를 배우도록" (`:135-141`)

빈 인자 텍스트는 `{}`로 파싱됩니다. `renderValidationErrors` (`:249-257`)가 `INVALID_ARGUMENT: <tool> was not executed because its arguments are invalid.` + 최대 12개 경로 + "Re-issue the call with corrected arguments."를 생성합니다.

`INVALID_ARGUMENT`는 `NEVER_RETRY`에 있으므로 **잘못된 형식의 호출은 설계상 terminal입니다** — 모델이 관찰하고 스스로 고쳐야 합니다.
