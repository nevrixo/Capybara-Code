# 패키지와 플러그인

두 개의 층입니다.

- **패키지**는 사용자가 요청·잠금·복원·업데이트·제거하는 단위입니다. 플러그인, 스킬, 프롬프트, 테마, 커스텀 에이전트, 훅, 스키마, 에셋을 담을 수 있습니다.
- **플러그인**은 그중 실행 가능한 부분집합입니다.

구현: `packages/package-manager` (2,173줄), `packages/plugin-sdk` (3,479줄).

운영자 관점 요약은 `docs/package-ecosystem.md`에도 있습니다(코드와 일치 확인됨).

---

# 패키지

## 상태 파일

프로젝트 상태는 커밋됩니다.

| 파일 | 내용 |
| --- | --- |
| `.capybara/packages.json` | 소스, 스코프, 요청된 권한 |
| `.capybara/packages.lock.json` | 정확한 버전, 소스, 패키지·매니페스트 SHA-256 다이제스트, 검증된 서명 키, 콘텐츠, 유효 권한 |

사용자 스코프 선언과 잠금은 Capybara 데이터 디렉터리 아래에 있습니다. 불변 패키지 바이트와 연산 영수증은 캐시·데이터 디렉터리 아래에 있습니다. 플러그인 활성/비활성 상태는 **호스트 로컬**이며 안정적인 워크스페이스 SHA-256 신원으로 키잉됩니다.

유효 우선순위: **사용자 패키지 상태 → 신뢰된 프로젝트 패키지 상태.** 프로젝트 패키지는 워크스페이스 신뢰가 성공하기 전에는 절대 참여하지 않습니다.

요청 파일·잠금 파일·실행 선언·요청 능력이 변경되면 **Project Trust v2 다이제스트가 변경되어 재검토를 요구합니다.**

## 매니페스트

`CapybaraPackageManifest` (`package-manager/src/contracts.ts:26-37`):

```ts
{
  schemaVersion: "1.0";
  id; version; capybara;          // capybara = 호환 버전 범위
  contents: CapybaraPackageContents;
  permissions: PluginPermissionRequest;
  integrity: { files: Record<path, digest>; packageDigest };
  signature?: { keyId; algorithm: "ed25519"; value };
}
```

`contents`의 8개 종류 (`:9-18`): `plugins`, `skills`, `agents`, `prompts`, `themes`, `hooks`, `schemas`, `assets`. 각 배열은 최대 512개이며 중복이 금지됩니다 (`verify.ts:257-263`).

서명 알고리즘은 **ed25519 하나뿐**입니다.

## 설치 파이프라인 (10단계)

모든 install과 update가 하나의 트랜잭션을 따릅니다.

1. `registry:` 또는 `path:` 소스 해석
2. 소스 신원, 매니페스트 스키마, 호환성 메타데이터, 경계 검증
3. 해당하는 경우 서명된 레지스트리 인덱스와 패키지 매니페스트 검증
4. 정확한 파일 집합, 파일별 SHA-256, 패키지 다이제스트, 경로, 확장 바이트 한계 검증
5. **심볼릭 링크, 특수 파일, 경로 탈출, 알 수 없는 매니페스트 필드, postinstall 스크립트 거부**
6. 포함된 플러그인 승인 실행. **프로젝트 플러그인은 WASI여야 합니다**
7. 요청 권한과 명시적 부여 권한 비교. **부여는 좁힐 수만 있습니다**
8. 호스트 소유 디렉터리로 스테이징 후 모든 스테이징된 다이제스트 재확인
9. 잠금 파일 원자적 교체, 슈퍼바이저 활성화, 헬스 체크
10. 멱등 연산 영수증 영속화

어느 단계든 실패하면 이전 잠금, 이전 플러그인 활성화, 이전 패키지 요청 파일을 복원하고 새로 스테이징한 바이트를 제거하며 실패/롤백 영수증을 기록합니다.

**스코프 단위 큐와 라이브 PID 연산 락**이 동시 클라이언트가 잠금 파일 업데이트를 잃는 것을 막습니다.

`PackageInstallStore` 인터페이스 (`installer.ts:48-65`)가 이 단계들을 포트로 노출합니다: `readLockfile`, `writeLockfileAtomic`, `readReceipt`, `writeReceipt`, `stage`, `activate`, `healthCheck`, `rollback`, `cleanup`.

## 검증 한계

`verify.ts:22-23`:

| 상수 | 값 |
| --- | --- |
| `MAX_CAPYBARA_PACKAGE_FILES` | 4,096 |
| `MAX_CAPYBARA_PACKAGE_BYTES` | 64 MiB (압축 해제 기준) |

`static-registry.ts:27-30`:

| 상수 | 값 |
| --- | --- |
| `MAX_INDEX_BYTES` | 4 MiB |
| `MAX_ARTIFACT_BYTES` | 96 MiB |
| `MAX_INDEX_PACKAGES` | 20,000 |
| `MAX_VERSIONS_PER_PACKAGE` | 256 |

## 정적 레지스트리

`static-registry.ts:1`: **"Signed, read-only static package registry over HTTPS."**

`StaticRegistryPackageVersion`이 버전별로 `artifact`, `manifestDigest`, `packageDigest`, `keyId`, **`withdrawn`**을 담습니다 — 철회된 버전이 목록에 남되 설치되지 않습니다.

서명 검증은 `node:crypto`의 `createPublicKey` + `verify`이며 정규화는 `canonicalJson`(`@cbc/app-protocol`)입니다.

## 권한 좁힘 강제

`assertGrantNarrowing(grant, requested)` (`verify.ts:223`).

배열 필드는 **부분집합**이어야 하고, 열거 필드는 **랭크가 낮거나 같아야** 합니다. 위반 시 `PACKAGE_GRANT_WIDENING` 오류입니다.

`PluginPermissionRequest`의 열거 필드와 랭크 (`contracts.ts:52-63`):

| 필드 | 랭크 순서 (낮음 → 높음) |
| --- | --- |
| `artifacts` | `none` → `read-own` → `create` |
| `sessionState` | `none` → `read` → `write-own` |
| `memory` | `none` → `search` → `propose` |
| `graph` | `none` → `observe` → `propose-node` |

배열 필드: `events`, `tools`, `workspaceRead`, `workspaceWrite`, `networkDomains`, `credentials`.

## CLI

```bash
capy bootstrap [--frozen] [--offline] [--project|--user]
capy package search <query>
capy package info <id>      [--project|--user|--effective]
capy package add <source>   [--project|--user] [--allow-unsigned-local] [--grant-requested] [--offline]
capy package remove <id>    [--project|--user]
capy package update [id]    [--project|--user] [--offline]
capy package verify <source> [--project|--user] [--allow-unsigned-local] [--offline]
capy package list           [--project|--user|--effective]
capy package doctor [id]    [--project|--user|--effective]
capy package publish [path] --dry-run
capy package init [path]
```

스코프 플래그 규칙: 변경 작업은 `--project`(기본)/`--user` 중 하나만, 목록 작업은 `--project`/`--user`/`--effective`(기본) 중 하나만.

**`capy package publish`는 `--dry-run` 없이는 종료 코드 4와 "publishing is approval-gated; this build supports --dry-run only"를 던집니다.**

TUI에서는 `/plugins <action> [package|plugin]`으로 같은 작업을 합니다.

---

# 플러그인

## 버전과 종류

`PLUGIN_SCHEMA_VERSION = "1.0"`, `PLUGIN_PROTOCOL_VERSION = "1.0"`.

`PluginRuntimeKind`: `wasi` | `stdio`.
`PluginInstallScope`: `builtin` | `user` | `project`.
`PluginRiskClass`: `R0`–`R4` (도구 카탈로그의 R0–R6과 다른 좁은 범위).
`PluginToolSideEffect`: `read` | `write` | `destructive` | `external` | `unknown`.

**프로젝트 플러그인은 WASI여야 합니다** — `plugins.allowProjectStdio`가 타입 수준에서 `false`로 고정되어 있습니다 (`config-schema/src/schema.ts` `PluginsConfig`).

## 매니페스트 검증

`validatePluginManifest(manifest)` (`plugin-sdk/src/manifest.ts:37`). 첫 문단이 자세를 정합니다 (`:1-7`):

> **매니페스트 요청은 부여가 아닙니다.** 이 검증기는 패키지가 유계하고 재현 가능한 요청을 서술한다는 것만 증명합니다. 런타임이 서명 검증, 스코프 정책, 유효 권한을 계속 책임집니다.

`rejectUnknown`으로 **알 수 없는 최상위 필드를 거부**합니다 (18개 허용 필드).

한계와 패턴 (`:17-23`):

| 상수/패턴 | 값 |
| --- | --- |
| `MAX_PERMISSION_ENTRIES` | 128 |
| `MAX_CONTRIBUTIONS` | 128 |
| `MAX_MANIFEST_TEXT_BYTES` | 4,096 |
| `SHA256_DIGEST` | `^sha256:[a-f0-9]{64}$` |
| `SEMVER` | 엄격한 semver (선행 0 금지) |
| `ID_SEGMENT` | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `OPAQUE_ID` | `^[A-Za-z0-9_.-]+$` |

**`manifest.publisher`는 `manifest.id`의 publisher 세그먼트와 일치해야 합니다** (`:65-67`) — 배포자 사칭을 막습니다.

`fail closed`가 원칙입니다: 잘못된 형식, 애매한, 경로 탈출 선언은 설치 검증기나 영속 저장소에 진입하기 **전에** 거부됩니다 (`:33-36`).

## 잠금 파일

`PLUGIN_LOCKFILE_SCHEMA_VERSION = "1.0"`, `MAX_PLUGIN_LOCKFILE_ENTRIES = 512`.

`PluginSignaturePolicy`: `required` | `allow-unverified`.

`PluginLockEntry`: `version`, `source`, `packageDigest`, `manifestDigest`, `signature?{keyId, verified}`, `grants`.

`assertPluginLockEntryMatchesVerifiedManifest`가 잠금 항목이 검증된 매니페스트 문서와 일치하는지 확인하고, `assertPluginSignaturePolicy`가 정책을 강제합니다.

## 설치 승인

`admitPluginInstall(input)` (`admission.ts:52`). **의도적으로 설치기가 아닙니다** — 내구성 있는 설치 기록이나 샌드박스 슈퍼바이저에 적합한 **불변 증거만** 생성합니다 (`:50-51`).

`PluginInstallSourceKind`: `builtin` | `registry` | `local-path`.

결과 `PluginInstallAdmission`: `pluginId`, `version`, `scope`, `sourceKind`, `source`, `runtimeKind`, `packageDigest`, `manifestDigest`, `signatureVerified`, `package`.

실패는 `PluginInstallAdmissionError{code: "PLUGIN_INSTALL_ADMISSION_DENIED"}`입니다.

## 36개 훅

`PLUGIN_HOOK_KINDS` (`contracts.ts:11-49`).

| 그룹 | 훅 |
| --- | --- |
| 세션 (6) | `before/after.session_create`, `before/after.session_resume`, `before/after.session_close` |
| 턴·프롬프트 (6) | `before.turn`, `before/after.prompt_compile`, `before.model_request`, `after.model_response`, `after.turn` |
| 도구 (5) | `before.tool`, `before/after.tool_execute`, `after.tool`, `on.tool_error` |
| 편집·트랜잭션 (4) | `before.edit_plan`, `before/after.transaction_commit`, `on.transaction_conflict` |
| 검증·리뷰 (4) | `before/after.verification`, `before/after.review` |
| 에이전트 (2) | `before.agent_spawn`, `after.agent_complete` |
| 워크트리·머지 (4) | `before.worktree_create`, `after.worktree_proposal`, `before/after.merge` |
| 컨텍스트 (2) | `before.context_select`, `after.context_pack` |
| 메모리 (3) | `before/after.memory_write`, `on.memory_invalidate` |

## 훅 디스패치 규율

`hooks.ts:1-8`: 이 모듈은 전송·런타임 중립입니다. WASI나 stdio 슈퍼바이저가 호출 함수를 제공하고, 이 계층이 **순서, 예산, 실패 정책, 단조 권한 적용**을 고정합니다.

> **after/observation 훅은 fail-open이며 권한을 변경하거나 영수증을 재작성할 수 없습니다.**

### before 훅의 4가지 결정

`BeforeHookDecision` (`hooks.ts:29-33`):

| 결정 | 내용 |
| --- | --- |
| `continue` | 계속. 선택적 `annotations` |
| `deny` | `reason`과 함께 거부 |
| `ask` | `reason` + 선택적 `riskFloor` |
| `narrow` | `constraints`로 좁힘 + `reason` |

### 순서

`hookGroup` (`hooks.ts:632-638`) — §13.14 순서:

| 그룹 | 대상 |
| --- | --- |
| 0 | builtin 정책 훅 |
| 1 | user critical |
| 2 | project critical |
| 3 | user ordinary |
| 4 | project ordinary |

같은 그룹 안에서는 **바이트 단위 플러그인 id → 매니페스트 ordinal** 순입니다. 완전 결정적입니다.

### 실패 정책

`failClosed` 판정 (`hooks.ts:387-390`, `:425-428`)이 세 조건 중 하나면 참입니다:

- `scope === "builtin"`
- `priority === "critical"`
- `options.ordinaryFailure === "closed"`

fail-closed면 `{action: "deny"}`가 나갑니다.

| 상황 | fail-closed 메시지 |
| --- | --- |
| 서킷 열림 | `a required plugin hook is unavailable because its circuit is open` |
| 훅 실패 | `a required plugin hook could not complete safely` |

fail-open이면 경고만 추가됩니다 (`PLUGIN_CIRCUIT_OPEN` 등).

## 단조 권한 (`authority.ts`)

`authority.ts:1-7`: **플러그인은 능력을 제거하거나 주의를 높일 수만 있습니다.** 경로 추가, 네트워크·샌드박스 정책 완화, 경계 증가, 호스트가 평가한 위험 낮추기는 절대 불가능합니다.

`EffectivePluginOperation`의 11개 축:

```ts
{ workspaceRead, workspaceWrite, credentialScopes, toolIds, contextCandidateIds,
  network, timeoutMs, outputBytes, maxNodes, risk, sandbox }
```

`validateNarrowing(original, proposed)` (`:99`)의 랭크:

| 축 | 랭크 (좁음 → 넓음) |
| --- | --- |
| `network` | `deny` 0 → `ask` 1 → `allow` 2 |
| `sandbox` | `strict` 0 → `standard` 1 → `unrestricted` 2 |

집합 축은 `narrowedSet`(부분집합), 수치 축은 `narrowedPositiveBound`(더 작아야 함)입니다.

**단 하나의 확장이 전체 결정을 무효화합니다.** 이유가 주석에 있습니다 (`:94-98`): "부분 적용은 훅 동작을 애매하게 만듭니다."

## WASI 아이솔레이트

`wasi-runtime.ts:1-7`: **플러그인은 프로세스 환경도, 무제한 파일시스템도, 네트워크도 받지 않습니다.** 호스트 import는 유효 부여에 대해 능력 검사를 받습니다. 누락되거나 적대적인 import는 fail closed이며 **stdio는 절대 폴백이 아닙니다.**

### `assertNoAmbientAuthority` (`authority.ts:76`)

3가지 불변식:

1. `grants.network !== "deny"` → `plugin isolate network must be deny`
2. `grants.workspaceWrite.length > 0` → `plugin isolate workspace write must be empty`
3. 호스트 객체가 `PLUGIN_ISOLATE_HOST_KEYS` 밖의 키를 노출 → `plugin isolate host exposes unexpected authority`

허용 키 9개: `pluginId`, `method`, `params`, `grants`, `log`, `env`, `read`, `write`, `network`.

### JS 샌드박스

`invokeJsSandbox` (`wasi-runtime.ts:69`)가 `node:vm`의 `createContext`로 컨텍스트를 만듭니다.

호스트 객체 `capy` (동결됨):

| 키 | 동작 |
| --- | --- |
| `params` | 전달된 파라미터 (기본 `{}`) |
| `grants` | 유효 부여의 동결된 복사본 |
| `log` | **no-op** |
| `env` | **동결된 빈 객체** |
| `read(path)` | `assertGrantedRead` 통과 후 호스트 주입 `readFile` 호출. `readFile` 없으면 `PLUGIN_CAPABILITY_DENIED` |
| `write(path)` | **항상** `PLUGIN_CAPABILITY_DENIED: workspace write is denied by default` |
| `network()` | **항상** `PLUGIN_CAPABILITY_DENIED: network is denied` |

컨텍스트에서 **제거된 전역** (`:95-105`): `process`, `require`, `Buffer`, `global`, `globalThis` 모두 `undefined`. `console`은 no-op 3개(`log`/`error`/`warn`)로 대체됩니다.

소스는 `"use strict"`로 감싸집니다.

`.wasm` 확장자이거나 소스가 `\0asm`으로 시작하면 `invokeWasm` 경로를 탑니다.

## 서킷 브레이커

`circuit.ts:1-8`: 슈퍼바이저가 훅·도구·명령 호출에 걸쳐 하나의 브레이커를 공유해 반복 실패하는 플러그인이 호스트를 지연시키거나 불안정하게 만드는 것을 막습니다. **이 모듈은 프로세스 라이프사이클을 소유하지 않습니다** — 승인·복구 결정만 내립니다.

`PluginCircuitState`: `closed` | `open` | `half-open`.

`PluginCircuitPermit.generation`이 중요합니다 (`:22-26`): **서킷이 열릴 때마다 바뀝니다. 따라서 이전 세대의 늦은 완료가 더 새로운 서킷을 닫을 수 없습니다.**

`permit.kind`: `normal` | `probe` (half-open 상태의 탐침).

## 재진입 제한

`reentrancy.ts:1-3`: **이 제한 계층은 절대 권한을 부여하지 않습니다.** 호스트는 모든 승인 후에도 일반 정책·부여·이벤트·영수증 검사를 계속 실행해야 합니다.

| 상수 | 값 |
| --- | --- |
| `DEFAULT_PLUGIN_REENTRANCY_DEPTH` | 2 |
| `DEFAULT_PLUGIN_TOOL_CALL_BUDGET` | 8 |
| `MAX_PLUGIN_REENTRANCY_DEPTH` | 8 |
| `MAX_PLUGIN_TOOL_CALL_BUDGET` | 64 |

`PluginInvocationContext`가 `visitedPluginHooks[]`를 실어 **같은 플러그인-훅 쌍의 순환 재진입**을 감지합니다.

## 플러그인 설정

`config-schema/src/schema.ts:750-759`:

| 키 | 기본값 | 비고 |
| --- | --- | --- |
| `plugins.enabled` | `true` | — |
| `plugins.allowProjectWasi` | `true` | — |
| `plugins.allowProjectStdio` | **`false` (타입 고정)** | 프로젝트 stdio 플러그인 불가 |
| `plugins.allowUnsafeLocal` | **`false` (타입 고정)** | — |
| `plugins.requireSignatureForRegistry` | `true` | — |
| `plugins.maxActivePerWorkspace` | 16 | — |
| `plugins.limits.beforeHookMs` | 2,000 | — |
| `plugins.limits.afterHookMs` | 5,000 | — |
| `plugins.limits.aggregateBeforeHookMs` | 5,000 | before 훅 합계 |
| `plugins.limits.maxOutputBytes` | 1,048,576 | — |
| `plugins.limits.maxStateBytes` | 1,048,576 | — |
| `plugins.limits.maxReentrancyDepth` | 2 | — |
| `plugins.limits.maxNestedToolCalls` | 8 | — |
| `plugins.failure.criticalBefore` | **`closed` (타입 고정)** | — |
| `plugins.failure.ordinaryBefore` | `open-with-warning` | \| `closed` |
| `plugins.failure.after` | **`open` (타입 고정)** | — |
| `plugins.failure.circuitFailures` | 3 | — |

**타입 고정 값 4개**(`allowProjectStdio: false`, `allowUnsafeLocal: false`, `criticalBefore: "closed"`, `after: "open"`)는 설정으로 변경할 수 없습니다 — TypeScript 리터럴 타입이 강제합니다.

## 플러그인 도구

`plugin.list`, `plugin.inspect`, `plugin.enable`, `plugin.disable`, `plugin.grants`가 CLI와 App Protocol 양쪽에 있습니다. 프로그램적 호출용 `plugin.<id>.<method>` 형태 디스패치도 카탈로그에 있습니다(`pluginId`, `method` 필수).

## 관련 문서

- 도구 위험 등급 → [도구 레퍼런스](tools.md)
- 워크스페이스 신뢰와 Project Trust v2 → [권한과 신뢰](permissions-and-trust.md)
- 설정 키 전체 → [설정](configuration.md)
- 스킬 배포 → [스킬](skills.md)
- App Protocol의 `plugin.*` / `package.*` 메서드 → [통합](integrations.md)
