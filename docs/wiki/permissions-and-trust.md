# 권한과 신뢰

## 핵심 불변식

`packages/permissions/src/policy.ts:5-6`이 §24.1을 직접 인용합니다.

> 모델은 permission을 직접 grant할 수 없다.

이어서 명시합니다: **모델이 말하는 어떤 것도 `allow`에 도달할 수 없고, 사용자 결정이나 기존 규칙만이 가능합니다.**

## 권한 모드

`PermissionMode = "plan" | "ask" | "auto" | "auto-review"` (`policy.ts:28`).

주석에 명시되어 있습니다: **`full`과 `dangerously-skip-permissions`는 존재하지 않습니다.**

## 신뢰 상태

`TrustState = "untrusted" | "trusted-once" | "trusted-always" | "read-only"` (`policy.ts:31`).

## 프리셋

`presets.ts:25-54`, 9개 축:

| 프리셋 | nativeWrite | process | directProcess | shellLike | network | destructive | credentials | externalSideEffect |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `read` | deny | deny | deny | deny | deny | deny | **deny** | deny |
| `edit` | allow | deny | deny | deny | ask | ask | **deny** | ask |
| `auto` | allow | risk | risk | ask | ask | ask | **deny** | ask |
| `yolo` | allow | allow | allow | allow | allow | allow | **deny** | allow |

**자격 증명은 YOLO를 포함한 모든 프리셋에서 `deny`입니다.**

설정은 **단조 상한(monotonic ceiling)**입니다. `applyPermissionRestrictions` (`:146-184`)는 축 순위를 낮추지 않는 변경을 거부하며(deny 0 < ask 1 < risk 2 < allow 3), `nativeRead`는 절대 건드리지 않습니다.

YOLO는 소프트한 `ask` 오버레이를 무시하지만 **명시적 `deny` 값은 여전히 구속합니다.**

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

`allowsBroadRule` (`:26-28`): **R4–R6은 세션 또는 프로젝트 범위의 allow 규칙을 절대 받을 수 없습니다.**

## 평가 순서

`policy.ts:629-791`. **하드 경계가 프리셋과 저장된 규칙보다 먼저 평가됩니다.**

1. `hardDeny` 규칙 (`:649-651`)
2. **자격 증명** — `config.credentials === "deny"`(기본) 또는 프리셋이 YOLO면 거부. 주석: "승인이 있어도 모델에 전달되지 않습니다" (`:652-654`)
3. `readOnly` — 프로세스 실행과 네이티브 쓰기 거부 (`:655-658`)
4. `trust === "untrusted"` — 프로세스 거부, 모든 효과적 동작 거부 (`:659-662`)
5. `trust === "read-only"` — 동일 (`:663-666`)
6. 설정 축 — destructive/network/externalSideEffect/shell이 `deny`, `projectWrite === "plan"`이면 모든 효과 거부 (`:667-673`)
7. 저장된 **deny** 규칙 (`:676-678`)
8. **역할 상한** — `nativeWrite`는 역할이 root, executor, refactorer 중 하나가 아니면 거부 (`:679-681`)
9. 능력 상한 — `canRunProcess === false`, `canWrite === false`, forbidden/allowed 경로 검사 (`:683-695`)

그다음 Plan 범위 게이팅 → Plan 모드 → 프리셋 분기 (`read` → `yolo` → `edit`) → **저장된 allow 규칙**(하드 경계와 Plan 범위 뒤에서만) → AUTO → 레거시 ASK → `ask` 요청.

저장된 allow 루프의 두 가지 미묘한 점 (`:742-747`): 현재 위험이 부여받은 위험을 **초과**하면 규칙을 건너뜁니다(`riskExceeds`); 현재 위험이 R4–R6이면 건너뜁니다(`!allowsBroadRule`); `project` 범위 규칙은 추가로 프로젝트가 신뢰되어야 합니다.

`process.stop`은 특수 처리로 항상 허용됩니다 — "기존 프로세스를 멈추는 것은 항상 안전하다" (`:704`, `:714`).

### spawn 시점 사전 점검

`mutationBlockReason` / `processBlockReason` (`:534-575`)는 **spawn 시점** 검사입니다. 게이트가 특정 동작에 의존하지 않으므로, 이를 무시하고 승인된 writer 자식은 "예산 전체를 절대 착지할 수 없는 작업에 쓴 뒤 최종 쓰기에서야 거부를 발견"하게 됩니다.

## 승인 흐름

### 요청 형태

`ApprovalRequest` (`:187-207`): `approvalId`(`ap_<actionHash>`), `riskClass`, `reason`, `network`, `sideEffects`, `offeredScopes`, `actionHash`, `ruleCandidate`.

### 제공되는 범위

`offeredScopes` (`:792-806`):

| 조건 | 범위 |
| --- | --- |
| R4–R6 | `["once"]`만 |
| 셸 계열 | `["once", "turn"]` |
| 그 외 | `["once", "turn", "session"]` + `trust === "trusted-always"`면 `"project"` |

셸 계열이 `session`을 받지 못하는 이유 (P0-04): "셸 스크립트나 인라인 인터프리터 코드는 파싱되지 않은 하나의 프로그램이므로, 어떤 저장 규칙도 그것을 정직하게 서술할 수 없다."

### actionHash

`:223-236`. 정규화된 `{toolId, arguments, program, args, cwd, env, networkIntent, 정렬된 writes, 정렬된 reads, mcp}`에 대한 SHA-256입니다.

### 규칙 매칭

`matchesRule` (`:819-879`)은 정확하고 조합 가능합니다. 두 가지 fail-closed 기본값이 있습니다.

- 규칙에 `envHash`가 없는데 동작에 **명시적 env가 있으면** 규칙이 매칭되지 않습니다 (`:865-870`)
- 규칙에 `argumentsHash`가 없는데 MCP 인자 집합이 비어 있지 않으면 동일 (`:872-876`)

`commandPrefixRule` (`:922-936`)은 `direct-executable`이 아닌 것에는 `undefined`를 반환합니다 — 셸 스크립트에 대한 접두사 규칙은 "다른 모든 스크립트를 조용히 포함하게" 됩니다. 영속화되는 규칙은 접두사가 아니라 `argsExact`를 씁니다.

## 브로커

### 대화형

`InteractiveApprovalBroker` (`apps/cbc/src/approvals.ts:77-183`):

- **선택기 취소는 거부이며 절대 승인이 아닙니다** (`:116-118`)
- `allow_session`은 인메모리 `StoredRule`을 추가
- `Always allow`는 `persistRule`도 best-effort로 호출하고, **영속화 실패는 조용히 잊히지 않고 진단 싱크로 알려집니다** (P0-13, `:146-157`)
- `#ruleFor`는 정책 엔진의 `ruleCandidate`를 선호하고, 명령 형태가 없는 동작에만 도구 범위 규칙으로 폴백합니다

### 헤드리스

`HeadlessApprovalBroker` (`:206-230`):

- `fail-on-ask` → `CliError(EXIT.permission)` = **종료 코드 4**. AC-38이 hang이 아니라 exit를 요구하기 때문입니다
- `allow-listed`는 의도적으로 얇습니다 — 요청이 브로커에 도달한 시점에 정책 엔진이 이미 모든 규칙을 적용했으므로, `allow-listed`에서 요청이 도착했다는 것은 규칙이 매칭되지 않았다는 뜻이고 거부만이 정직한 답입니다. 여기서 매칭을 재구현하면 첫 번째 매처와 불일치할 수 있는 두 번째 매처가 생깁니다 (`:196-205`)

### `allow_turn`

**규칙으로 저장되지 않습니다.** `GrantedRules.clearTurnScoped()` (`:42-46`)는 의도적인 no-op 플레이스홀더이고, 커널이 대신 동작 해시를 `#turnAllowedActions`에 추가합니다 (`kernel.ts:3465-3470`). 동일한 작업은 재승인 없이 통과하되 상승(escalation)이 있으면 다시 묻습니다.

## 자식 권한의 단조성

자식 권한 컨텍스트 (`apps/cbc/src/subagent-bridge.ts:942-955`)는 **루트의** 컨텍스트를 spread하고 `catalog`, `agentRole`, `agentCapabilities`만 재정의합니다. 자식은 축을 넓힐 수 없고 상속과 축소만 가능합니다.

### 역할 권한 클래스

`packages/subagents/src/roles.ts:26`: `"read" | "write" | "process"`.

| 역할 | 클래스 | canWrite | canRunProcess |
| --- | --- | --- | --- |
| `explore` | read | 아니오 | 아니오 |
| `planner` | read | 아니오 | 아니오 |
| `architect` | read | 아니오 | 아니오 |
| `reviewer` | read | 아니오 | 아니오 |
| `executor` | write | **예** | **예** |
| `refactorer` | write | **예** | **예** |
| `test` | process | 아니오 | **예** |

커스텀 에이전트 정의는 `narrower()`를 통과합니다 (`custom.ts:152-156`, 순서 read 0 < process 1 < write 2). 기본 역할의 권한을 초과하는 요청은 진단과 함께 조용히 축소됩니다.

### 세 겹의 위임 검사

**(a) 코디네이터가 spawn 시 확대를 거부** (`delegation-coordinator.ts:183-196`):

```
definition.canWrite && !parent.permissions.canWrite
  → AUTHORITY_WIDENING "a read-only parent cannot delegate writer authority"
definition.canRunProcess && !parent.permissions.canRunProcess
  → AUTHORITY_WIDENING "the child process authority would exceed its parent"
```

**(b) 경로 범위 포함** — `narrowTask` (`:398-420`): 부모 상한 중 어느 것에도 `pathWithin`하지 않는 자식 `allowedPaths` 항목은 `AUTHORITY_WIDENING`. `forbiddenPaths`는 부모의 것과 **합집합**됩니다 — forbidden은 아래로 누적되고 allowed는 좁아지기만 합니다.

**(c) 스케줄러가 상한과 교집합** (`scheduler.ts:397-412`):

```
canWrite:      definition.canWrite && (ceiling?.canWrite ?? true)
canRunProcess: definition.canRunProcess && (ceiling?.canRunProcess ?? true)
forbiddenPaths: [...new Set([...task.forbiddenPaths, ...ceiling.forbiddenPaths])]
mayRequestApproval: definition.permissionClass !== "read" && (ceiling?.mayRequestApproval ?? true)
```

스킬은 **교집합으로만** 도구를 좁힙니다 (`packages/skills/src/skill.ts:436-456`) — 호스트가 허용하지 않는 요청 도구는 `denied`에 들어갑니다.

## 루트 소유 승인

읽기 클래스 자식은 **아예 물을 수 없습니다**: `mayRequestApproval: definition.permissionClass !== "read"` (`scheduler.ts:409-411`). 근거는 `instance.ts:45-49` — 물을 수 없는 자식은 부모를 보고 있는 사람을 기다리며 멈출 수 없습니다.

중첩 자식(`depth > 1`)은 승인을 소유하지 않고 **루트로 상승시킵니다** (`subagent-bridge.ts:1011-1026`):

```
emit("approval.requested", {...request, ancestry: ancestryFor(...), escalatedTo: "root"})
approvals.request({...request,
  display: "[" + ancestry.join(" > ") + "] " + request.display,
  reason: request.reason + " (escalated from nested subagent)"})
```

`ancestryFor` (`:161-173`)가 `parentId`를 따라 올라가며 `"root"`를 앞에 붙입니다. 중첩 스케줄러는 부모 자신의 값과 무관하게 상한에 `mayRequestApproval: false`를 강제합니다 (`delegation-coordinator.ts:340-345`).

자식은 비대화식 모드에서 `ask` 브리지를 아예 받지 못합니다 (`subagent-bridge.ts:796-798`).

## Plan 범위 실행 (다이제스트 바인딩)

`ApprovedPlanScope` (`:103-109`)는 `plan-sha256-<64hex>` 다이제스트를 명시적 파일 앵커, 명령, MCP 동작에 바인딩합니다.

`normalizeApprovedPlanScope` (`:351-389`)는 어떤 기형에도 fail-closed입니다: `commands`는 `workspaceRoot`가 필요하고, 각 명령의 `cwd`는 `workspaceRoot`와 **같아야** 하며, 경로 앵커는 `validatePlanScopePath`를 통과해야 합니다(절대 경로·`~`·`..`·**와일드카드** 금지).

`actionInApprovedPlanScope` (`:456-523`)는 범위 내 멤버십을 부여하지만 다음에는 **재확인을 강제합니다.**

- 파괴적 파일 변경 (`fs.delete`/`fs.move`)
- 셸 계열 명령 — "원시 셸 명령은 절대 자동 승인되지 않습니다"
- 모든 MCP 동작

`process.input`은 범주적으로 범위 밖입니다 — "Plan에는 정확한 명령 증명이 없습니다."

프로세스 매칭은 정확한 program + 정확한 argv 길이와 내용 + 일치하는 네트워크 기대 + 신뢰된 루트와 같은 cwd를 요구하고, 환경 주입을 담은 명령은 거부합니다.

## 워크스페이스 신뢰 상세

### 저장 위치

| 파일 | 내용 |
| --- | --- |
| `<data>/trust.json` | 워크스페이스 신뢰 |
| `<data>/project-trust.json` | 승인된 프로젝트 제어 스냅샷 |
| `<data>/approvals.json` | 영속된 도구별 승인 부여 |

`trust.json`은 **런타임의 형태로** 영속됩니다: `{records: {<key>: {canonicalPath, filesystemId, state, decidedAt}}}`, `version` 래퍼 없음 — Rust 신뢰 권한자와 TS 호스트가 하나의 형식을 읽습니다 (`state.ts:108-131`). 리더는 레거시 `{version:1, records:{…{path, fingerprint}}}` 형태도 수용합니다.

손상된 `trust.json`은 허용적인 것이 아니라 **빈 저장소**를 만듭니다 (`state.ts:101-105`).

조회 키는 소문자화하고 백슬래시를 정규화하고 후행 슬래시를 제거한 경로입니다 (`state.ts:162-164`).

### 프로젝트 신뢰 다이제스트

`captureProjectTrustSnapshot` (`project-trust.ts:26-72`)이 `<workspace>/.capybara/` 아래 네 파일을 읽습니다: `config.toml`, `config.local.toml`, `packages.json`, `packages.lock.json`. 각각 1 MiB로 제한되며 **초과하면 절단이 아니라 `ProjectTrustSnapshotError`를 던집니다**.

CRLF는 해싱 전에 정규화되고 JSON은 키를 정렬해 정규화하므로 다이제스트가 줄바꿈과 키 순서에 안정적입니다.

다섯 개의 컴포넌트 다이제스트가 하나의 `projectDigest`를 만듭니다 (`:57-63`): `configDigest`(두 TOML 파일 합), `packageManifestDigest`, `packageLockDigest`, `executableDigest`, `capabilityDigest`.

`executableDigest`는 `/command|entrypoint|executable|hook|mcp|lsp|network|workspace_write|credential/i`에 매칭되는 줄들의 정렬된 집합 (`:114-123`) + `/plugin|hook|command|entrypoint|\.wasm$/i`에 매칭되는 매니페스트 문자열 (`:125-135`)을 해싱합니다. 파싱 불가한 `packages.json`은 리터럴 마커 `"invalid-packages-json"`을 기여합니다.

`requestedCapabilities`는 연결된 텍스트에 대한 정규식으로 도출한 정렬된 집합입니다 (`:137-158`): `mcp`, `lsp`, `plugin-runtime`, `hooks`, `network`, `workspace-write`, `credentials`, `process`.

`projectTrustMatches` (`:83-89`)는 프로젝트 제어 파일이 전혀 없으면 true이고, 아니면 정확한 `projectDigest` 일치를 요구합니다.

`projectTrustWidening` (`:74-81`)은 지금 있으나 승인된 스냅샷에 없던 능력을 반환합니다 — 이전에 승인된 것이 없으면 현재 집합 전체입니다.

### `capy trust --show-diff`

`commands/trust.ts:7-52`. JSON 리포트를 출력하고 프롬프트 없이 0으로 종료합니다 (`:33-36`).

```
workspace, state, changed, approvedDigest, currentDigest,
addedCapabilities, requestedCapabilities,
files: { configDigest, packageManifestDigest, packageLockDigest,
         executableDigest, capabilityDigest }
```

`changed`는 `hasProjectControlFiles && approved?.projectDigest !== snapshot.projectDigest`입니다. `approvedDigest`는 승인된 것이 없으면 `null`입니다.

> **알려진 문제:** 플래그 없는 `capy trust`는 이미 `trusted-always`/`trusted-once`이면 "Workspace trust is current: <digest>"를 출력하고 반환하는데 (`:44-47`), 이 단축이 `changed`를 확인하기 **전에** 일어납니다. 이미 신뢰된 워크스페이스의 다이제스트가 그 후 드리프트했더라도 현재 상태로 보고됩니다. 드리프트는 `--show-diff`로만 보입니다.

## 신뢰되지 않은 모드가 비활성화하는 것

### 설정

`packages/config-schema/src/index.ts:55-63`: 두 프로젝트 설정 레이어가 레이어별 경고와 함께 제거됩니다. `read-only`도 이 목적에서는 신뢰되지 않은 것으로 계산됩니다.

### 정책

`policy.ts:659-666` — 프리셋과 저장된 규칙 전에 평가되는 하드 거부:

| 신뢰 상태 | 거부되는 것 |
| --- | --- |
| `untrusted` | 프로세스 실행 ("running processes requires a trust decision"), 모든 효과적 동작 |
| `read-only` | 동일 ("this project was opened read-only") |

효과적 동작은 `nativeWrite || processExecution || action.mcp !== undefined`입니다 (`:646`).

저장된 프로젝트 범위 규칙은 `trusted-always` 또는 `trusted-once`가 아니면 건너뛰어집니다 (`:745`). `allow_project` 승인 범위는 `trusted-always`에서만 제공됩니다 (`:803-804`).

`context.readOnly === true`는 독립적으로 프로세스 실행과 네이티브 쓰기를 거부합니다 (`:655-658`).

### 서브시스템

| 시스템 | 신뢰되지 않을 때 |
| --- | --- |
| **LSP** | 서버를 시작하지 않음 (`lsp-host.ts:236`, `:877` "LSP is unavailable in an untrusted workspace") |
| **MCP** | 프로젝트 설정 서버는 생략이 아니라 **disabled로 추가** — 목록에는 나타나지만 실행/spawn 불가 (`mcp-host.ts:18-21`) |
| **프로젝트 지침** | 아무것도 기여하지 않음. 각 후보는 이유와 함께 skipped로 기록되어 컨텍스트 검사기가 "보류됨"과 "부재"를 구분 (`context-engine/src/instructions.ts:186-194`) |
| **패키지 에이전트 정의** | `trusted: file.source === "user" \|\| trust === "trusted-always" \|\| "trusted-once"`로 파싱 (`bootstrap.ts:601-606`) |
| **프로젝트 스코프 스킬** | 나열되지만 본문을 로드할 수 없음 (`registry.ts:452-461`) |
| **로컬 경로 패키지** | `PACKAGE_TRUST_REQUIRED` (`package-runtime.ts:808-815`) |

## 영속된 승인 규칙

`apps/cbc/src/rules-store.ts:11-25`. 워크스페이스에 바인딩됩니다.

v2 항목은 `{canonicalPath, filesystemId, workspaceDigest}`를 기록하고 일치하는 워크스페이스에서만 로드됩니다 (`:96-111`).

마이그레이션은 fail-closed입니다 (`:102-108`): v1 **allow** 규칙은 워크스페이스 바인딩이 없으므로 비활성화되고 일회성 알림용으로 카운트됩니다. v1 **deny**는 보류가 안전한 방향이므로 유지됩니다.

손상된 저장소는 규칙 없음을 만들고 (`:235-238`), 출처를 증명할 수 없는 v2 항목은 버려집니다 (`:283-286`).

## 민감 경로

승인 여부와 무관하게 읽기와 쓰기 모두 거부 (`crates/cbc-workspace/src/lib.rs:129`):

```
.env, .env.*, *.pem, *.key, id_rsa, id_ed25519, id_ecdsa,
.ssh/**, .aws/credentials, .gnupg/**, .netrc,
*.p12, *.pfx, *.keystore
```

정책 레이어에서는 자격 증명 형태 경로가 R5로 상승합니다 (`policy.ts:323-328`): `.env`, `.pem`, `.key`, `id_rsa`, `id_ed25519`, `.ssh/`, `.aws/`, `.npmrc`, `.netrc`.

선택 스코어러는 16개 정규식으로 `-1000` 점수와 `excluded: true`를 부여합니다 (`selection.ts:73-89`).

경로 언급 인덱스는 **인덱싱 시점에** 민감 경로를 제외하므로 (`path-mentions.ts:95`) `@` 완성에 나타나지 않습니다.

## 프로젝트 설정 상한

프로젝트는 다음을 할 수 없습니다.

- 자격 증명 형태 키 설정 (hard error)
- 사용자 전용 접두사 설정 — `provider.openai.`, `perf.`, `daemon.`, `updates.` 등
- 단조 스케일을 더 관대하게 이동
- 실효 엄격 boolean 뒤집기 (사용자가 끈 `experimental.*` 게이트를 다시 켤 수 없음)
- `permissions.preset = "yolo"` 설정
- `permissions.rules`에 `decision: "allow"` 추가 (deny만 허용)
- 사용자 정의 MCP/LSP 서버 재정의

전체 목록은 [설정 — 프로젝트가 설정할 수 없는 키](configuration.md#프로젝트가-설정할-수-없는-키)를 참고하십시오.

> **알려진 문제:** 단조·사용자 전용 검사는 프로젝트 소스에서만 동작합니다. 환경 레이어는 프로젝트 뒤에 적용되므로 `CBC_PERMISSION_MODE=auto`는 사용자가 설정한 하한을 무조건 넓힙니다.
