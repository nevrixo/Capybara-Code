# 개발자 가이드 (빌드·검증·릴리스)

이 문서는 Capybara Code(`capy`, 0.1.2-alpha.1) 저장소에 기여할 때 필요한 빌드·테스트·검증 게이트·릴리스 파이프라인·벤치마크 절차를 다룹니다. 모든 사실은 저장소 파일의 행 번호로 인용합니다.

## 저장소 레이아웃

| 경로 | 내용 |
| --- | --- |
| `apps/*` | 실행 가능한 애플리케이션 (`apps/cbc` = `capy` CLI 본체) |
| `packages/*` | `@cbc/*` 워크스페이스 라이브러리 |
| `benchmarks/*` | 벤치마크 워크스페이스 (`benchmarks/cbc-bench`) |
| `crates/` | Rust 런타임 크레이트 (Cargo 워크스페이스) |
| `scripts/` | 빌드·검증·릴리스 스크립트 |
| `schemas/` | 프로토콜 스키마 (TS↔Rust 대조 대상) |
| `fixtures/` | 생성형 픽스처 (`fixtures/generate.ts`) |
| `perf/` | 성능 하니스 |
| `docs/wiki/` | 이 위키 |
| `.source-truth.json` | 소스 진실 매니페스트 |

워크스페이스 선언은 `package.json:8-12`와 `pnpm-workspace.yaml:1-4` 두 곳에 있고 목록은 동일하게 `apps/*`, `packages/*`, `benchmarks/*`입니다.

## 패키지 매니저: Bun이 정본입니다

루트에 `bun.lock`과 `pnpm-lock.yaml`이 **동시에** 존재하고 `pnpm-workspace.yaml`도 있습니다. 정본은 **Bun**입니다:

| 근거 | 위치 |
| --- | --- |
| `engines`가 Bun만 요구 (`"bun": ">=1.3.0"`) | `package.json:13-15` |
| 루트 스크립트 28개가 모두 `bun run` / `bun test` / `cargo`로 실행 | `package.json:17-44` |
| `devDependencies`에 `@types/bun` 고정 | `package.json:47` |
| `tsconfig.json`의 `types: ["bun"]` | `tsconfig.json:8` |

즉 `pnpm-lock.yaml`/`pnpm-workspace.yaml`은 현재 스크립트 경로에서 사용되지 않습니다. 이 중복은 `## 알려진 불일치`에 기록합니다.

## 툴체인 요구사항

Bun `>=1.3.0` (`package.json:14`), TypeScript `5.9.3` 고정 (`:48`), Rust는 `stable` 채널에 `rustfmt`·`clippy` 포함 `profile = minimal` (`rust-toolchain.toml:1-4`). `rust-toolchain.toml`이 채널을 고정하므로 `rustup`이 있으면 `cargo` 호출 시 툴체인이 자동 선택됩니다.

## TypeScript 설정

`tsconfig.json`은 **단일 루트 설정**이며 `references` 필드를 쓰는 프로젝트 참조 구성이 **아닙니다**. 대신 `paths` 별칭(`tsconfig.json:28-57`)으로 `@cbc/*` 워크스페이스를 직접 소스 엔트리에 매핑합니다.

엄격성 플래그가 모두 켜져 있습니다 (`tsconfig.json:11-19`): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`.

`noEmit: true` (`tsconfig.json:24`)이므로 `tsc`는 타입 검사 전용이고 번들링은 Bun이 담당합니다. 검사 범위는 `include: ["apps", "packages", "benchmarks", "scripts"]` (`:59`)이며 `node_modules`·`target`·`dist`는 제외됩니다 (`:60`). `paths` 매핑은 26개이므로 새 워크스페이스 패키지를 추가하면 이 목록에도 등록해야 타입 검사가 통과합니다.

## 루트 스크립트 전체

`package.json:16-45`의 모든 스크립트입니다.

| 스크립트 | 명령 | 용도 |
| --- | --- | --- |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | 전체 TS 타입 검사 |
| `test` | `bun test apps packages benchmarks/cbc-bench/test` | 기본 TS 테스트 |
| `test:ts` | `bun test packages apps benchmarks/cbc-bench/test` | `test`와 동일 범위(순서만 다름) |
| `test:rust` | `cargo test --workspace` | Rust 크레이트 전체 테스트 |
| `test:perf` | `bun test perf/harness.test.ts` | 성능 하니스 회귀 검사 |
| `build:runtime` | `bun run scripts/build-runtime.ts` | Rust 런타임 바이너리 빌드/스테이징 |
| `build:capy` | `bun run scripts/build-standalone.ts --compile` | `capy` 단일 실행 파일 컴파일 |
| `build` | `build:runtime && build:capy` | 릴리스용 전체 빌드 |
| `stage` | `bun run scripts/build-standalone.ts --development-launcher` | 컴파일 없이 개발용 런처 스테이징 |
| `release:check` | `bun run scripts/check-release.ts` | 릴리스 사전 점검 |
| `release:package` | `bun run scripts/package-npm.ts` | npm 배포 패키지 구성 |
| `release:archive` | `bun run scripts/archive-release.ts` | 배포 아카이브 생성 |
| `release:smoke` | `bun run scripts/smoke-release.ts` | 산출물 스모크 테스트 |
| `release:checksums` | `bun run scripts/write-release-checksums.ts` | 체크섬 파일 작성 |
| `test:release` | `bun test scripts/release.test.ts` | 릴리스 스크립트 자체의 단위 테스트 |
| `dev:link` | `bun run scripts/dev-link.ts link` | 로컬 `capy` 심링크 설치 |
| `dev:unlink` | `bun run scripts/dev-link.ts unlink` | 로컬 심링크 제거 |
| `legacy:cleanup` | `powershell -ExecutionPolicy Bypass -File scripts/cleanup-legacy-capy.ps1` | Windows 레거시 설치 정리 |
| `legacy:cleanup:wsl` | `bash scripts/cleanup-legacy-capy-wsl.sh` | WSL 레거시 설치 정리 |
| `verify` | 아래 게이트 전체 순차 실행 | **PR 제출 전 단일 관문** |
| `schemas:check` | `bun run scripts/check-protocol-drift.ts` | TS↔Rust 프로토콜 드리프트 검사 |
| `source-truth` | `bun run scripts/source-truth.ts` | 소스 진실 매니페스트 갱신 |
| `source-truth:check` | `bun run scripts/source-truth.ts --check` | 매니페스트 최신성 검증 |
| `runtime-boundary:check` | `bun run scripts/check-no-codex-runtime.ts` | 런타임 경계 위반 검사 |
| `fixtures` | `bun run fixtures/generate.ts` | 픽스처 재생성 |
| `fixtures:check` | `bun run fixtures/generate.ts --check` | 픽스처 최신성 검증 |
| `bench` | `bun run benchmarks/cbc-bench/src/cli.ts` | 벤치마크 CLI |
| `capy-dev` | `bun run apps/cbc/src/main.ts` | 소스에서 직접 CLI 실행 |

### `verify`가 실행하는 게이트 순서

`package.json:36`은 다음 9단계를 `&&`로 연결하며, 앞 단계가 실패하면 즉시 중단됩니다:

`typecheck` → `schemas:check` → `runtime-boundary:check` → `fixtures:check` → `source-truth:check` → `test:ts` → `test:perf` → `test:release` → `test:rust`

기여자는 PR 전에 `bun run verify` 하나만 실행하면 됩니다.

## `scripts/` 전체 목록

| 파일 | 줄 | 역할 | 실행 시점 |
| --- | --- | --- | --- |
| `build-runtime.ts` | 222 | Rust 사이드카를 배포용으로 빌드하고 **빌드 호스트 경로가 새지 않게** `--remap-path-prefix`를 모든 크레이트에 적용합니다 (`scripts/build-runtime.ts:2-9`) | `bun run build:runtime` |
| `build-standalone.ts` | 611 | §19.2 아카이브 레이아웃(`bin/capy`, `libexec/cbc-runtime`, `libexec/capy-daemon`, `share/capybara/{skills,schemas,model-registry.json,notices}`, `manifest.json`)을 생성합니다 (`scripts/build-standalone.ts:6-14`) | `bun run build:capy` / `bun run stage` |
| `package-npm.ts` | 243 | 검증된 standalone 스테이지에서 **npm 배포 디렉터리**를 조립합니다 (`scripts/package-npm.ts:2`) | `bun run release:package` |
| `archive-release.ts` | 106 | 검증된 스테이지에서 네이티브 플랫폼 아카이브를 만듭니다 (`scripts/archive-release.ts:2`) | `bun run release:archive` |
| `release-common.ts` | 238 | 릴리스 메타데이터·검증·산출물 안전성 헬퍼 공유 모듈 (`scripts/release-common.ts:2`) | 다른 릴리스 스크립트가 import |
| `release.test.ts` | 403 | 위 릴리스 스크립트들의 순수 함수 단위 테스트 (`scripts/release.test.ts:7-22`에서 7개 모듈 import) | `bun run test:release` |
| `release-launcher.cjs` | 273 | 배포되는 **공개 `capy` 런처**(Node CJS). npm/Bun이 설치 시 선택한 플랫폼 패키지를 찾아 실행하고, 네이티브 바이너리가 정확한 버전 업데이트를 요청하면 종료를 기다린 뒤 패키지 매니저를 호출합니다 — Windows에서 실행 중 바이너리가 자기 자신을 교체할 수 없기 때문입니다 (`scripts/release-launcher.cjs:4-10`) | 사용자의 설치본에서 실행 (기여자가 직접 실행하지 않음) |
| `smoke-release.ts` | 212 | 패키징된 바이너리를 **실제로 실행**해 사이드카가 `bin/` 기준 상대 경로로 해석되는지 확인합니다 (`scripts/smoke-release.ts:2`) | `bun run release:smoke` |
| `check-release.ts` | 29 | 릴리스에 노출되는 **모든 버전 소스가 태그와 일치**하는지 강제합니다 (`scripts/check-release.ts:2`) | `bun run release:check` |
| `check-protocol-drift.ts` | 585 | TS↔Rust 프로토콜 상수 3부 사본의 불일치를 검사합니다 | `bun run schemas:check` (`verify` 2단계) |
| `check-no-codex-runtime.ts` | 309 | `no-codex-runtime-dependency` 게이트 — Codex 런타임 의존성 부재를 증명합니다 | `bun run runtime-boundary:check` (`verify` 3단계) |
| `source-truth.ts` | 267 | G0 소스 진실 가드 — 정본 구현 루트만 지문화합니다 | `bun run source-truth[:check]` (`verify` 5단계) |
| `generate-sdk-types.ts` | 105 | 프로토콜/앱 스키마에서 **공개 SDK 타입 표면**(닫힌 메서드·이벤트 유니온)을 TypeScript·Python 양쪽으로 생성합니다 (`scripts/generate-sdk-types.ts:3-6`) | 프로토콜 메서드/이벤트를 추가·변경한 뒤 |
| `write-release-checksums.ts` | 39 | GitHub Release 자산의 결정적 SHA-256 매니페스트(`SHA256SUMS.txt`)를 작성합니다 (`scripts/write-release-checksums.ts:2`, `:18`) | `bun run release:checksums` |
| `dev-link.ts` | 162 | 체크아웃을 **`capy-dev`로만** 등록합니다. Bun의 `link --global`이 현재 Windows Bun에서 신뢰할 수 없으므로 Bun 링크 레지스트리 등록 후 네이티브 Bun bin 디렉터리에 검증된 shim 하나를 만듭니다. **공개 `capy`는 절대 건드리지 않습니다** (`scripts/dev-link.ts:3-8`) | `bun run dev:link` / `dev:unlink` |
| `cleanup-legacy-capy-wsl.sh` | 85 | WSL/Linux 레거시 설치 정리 | `bun run legacy:cleanup:wsl` |
| `cleanup-legacy-capy.ps1` | 106 | Windows PowerShell 레거시 설치 정리 | `bun run legacy:cleanup` |

`generate-sdk-types.ts`는 `verify`에 포함되지 않고 루트 스크립트에도 등록돼 있지 않습니다 — `package.json:16-45`에 해당 항목이 없습니다. 직접 `bun run scripts/generate-sdk-types.ts`로 실행합니다.

### 생성 vs 검사 — 의도된 설계

`check-protocol-drift.ts:2-19`의 주석은 이 선택을 명시합니다. PRD §20.11은 `schemas/`를 진실의 출처로 두고 양쪽 생성 타입을 요구하지만, 이 저장소는 **상수를 각 언어에 손으로 쓰고 이 스크립트가 생성기를 대체**합니다. 이유:

- 빌드 경로의 코드 생성기는 **아무도 리뷰하지 않은 산출물**을 조용히 만들 수 있습니다.
- §19.9는 릴리스 경로가 무엇도 가져오지 않도록 이미 금지합니다.
- 검사는 한 면에서 약하고(상수를 두 번 써야 함) 다른 면에서 강합니다 — Rust·TypeScript 정의가 각 언어답고 읽기 쉬우며 diff 가능한 상태로 남습니다.

Rust 측은 **컴파일 없이 텍스트로 읽습니다**. 이것이 실제 한계이며 출력에 명시됩니다: 선언된 목록은 검증하지만 그것을 소비하는 디스패처는 검증하지 않습니다 (`check-protocol-drift.ts:16-18`).

## 검증 게이트

### 1. `source-truth` — G0 소스 진실 가드

저장소에는 과거 `.orig` 스냅샷과 생성된 Rust/JS 산출물이 섞여 있습니다. 이 게이트는 **정본 구현 루트만 지문화**해서, 벤치마크나 리뷰가 낡은 스냅샷을 소스로 실수로 가져오는 것을 막습니다 (`scripts/source-truth.ts:1-11`).

지문화 대상 루트 (`source-truth.ts:19`):

`apps`, `packages`, `benchmarks`, `crates`, `schemas`, `scripts`, `fixtures`

정본 최상위 파일 (`source-truth.ts:26-35`) — P1-08. 코드 루트만 지문화하면 낡은 `Cargo.toml`이나 `package.json`을 여전히 가져올 수 있기 때문입니다: `package.json`, `Cargo.toml`, `Cargo.lock`, `bun.lock`, `rust-toolchain.toml`, `tsconfig.json`, `pnpm-workspace.yaml`, `README.md`.

**문서는 의도적으로 소스 진실 경계 밖**입니다 (`source-truth.ts:16-18`) — 로컬 체크아웃에서 문서를 추가·삭제해도 정본 구현 신원이 바뀌지 않습니다. 즉 `docs/wiki/`를 수정해도 이 게이트는 깨지지 않습니다.

제외 패턴 (`source-truth.ts:36-48`): `node_modules`, `dist`, `target`, `__pycache__`, `.pytest_cache`, `benchmarks/*/results`, `.orig`, `.bak`, `.tmp`, 그리고 매니페스트 자신(`매니페스트는 자기 자신을 지문화할 수 없습니다`).

**CRLF 정규화**: Git이 Windows에서 CRLF, Linux에서 LF로 체크아웃할 수 있으므로 유효한 UTF-8 텍스트는 LF로 정규화한 뒤 해싱합니다. 바이너리·비UTF-8은 바이트 그대로 해싱합니다 (`source-truth.ts:50-56`, `:66-68`).

`.source-truth.json` 필드: `schemaVersion` `"1.0"` (`:2`), `generatedAt` (`:3`), `git{commit,dirty,dirtyHash}` (`:4-8`), `roots`/`rootFiles`/`ignoredPatterns`/`excludedPaths` (`:9-34`), `toolVersions{bun,node,cargo,rustc,typescript}` (`source-truth.ts:234-249`), `fileCount` `716` (`:58`), `historicalArtifacts` `[]` (`:59`), `files`(경로별 `{path,bytes,sha256}` — `source-truth.ts:70-74`), `digest` `49210cfd…9ec2f81` (`:3642`).

**`--check`는 정본 내용만 비교합니다.** `git`과 `toolVersions`는 출처 기록(provenance)일 뿐이며, 다른 머신이나 더러운 체크아웃이 동일 소스를 실패시키지 않아야 하기 때문입니다 (`source-truth.ts:166-169`). 비교 대상은 `roots`, `rootFiles`, `excludedPaths`, `historicalArtifacts`, `fileCount`, `files`, `digest` 7개입니다 (`:170-187`).

일치 시 `source truth OK (<n> files, <digest>)`로 종료 코드 0, 불일치 시 `.source-truth.json is stale; run bun run source-truth --write`로 1, 매니페스트가 없으면 `… is missing; run bun run source-truth --write`로 1입니다 (`source-truth.ts:164`, `:190`).

**정확한 갱신 명령**: `bun run source-truth --write` (`source-truth.ts:251-257`). 루트 스크립트 `source-truth`(`package.json:38`)는 `--write` 없이 실행하면 매니페스트를 **표준 출력에 인쇄만** 하고 파일을 쓰지 않습니다 (`source-truth.ts:262-264`). 파일을 갱신하려면 반드시 `--write`를 붙여야 합니다. 최근 커밋 `b3f1b1e chore: refresh the source-truth manifest for the new event kinds`가 이 갱신 커밋의 예시입니다.

### 2. `schemas:check` — TS↔Rust 프로토콜 드리프트

`check-protocol-drift.ts`는 TypeScript 상수, Rust 소스 텍스트, JSON 스키마 **3부 사본**을 대조합니다.

읽는 Rust 파일: `crates/cbc-protocol/src/methods.rs` (`check-protocol-drift.ts:172`), `crates/cbc-fs/src/lib.rs` (`:173`), `crates/cbc-protocol/src/limits.rs` (`:174`), `crates/cbc-protocol/src/jsonrpc.rs` (`:175`), `crates/cbc-protocol/src/handshake.rs` (`:402`).

읽는 스키마 파일: `schemas/protocol/rpc.schema.json` (`:177`), `schemas/protocol/handshake.schema.json` (`:178`), `schemas/events/event.schema.json` (`:179`), `schemas/config/config.schema.json` (`:180`), `schemas/tools/tool.schema.json` (`:181`).

추가로 `schemas/CHANGELOG.md`에 현재 `PROTOCOL_VERSION`·`EVENT_SCHEMA_VERSION` 항목이 있는지 확인하고, 없으면 실패합니다 (`:524-533`). 생성된 SDK 표면도 `sdk.generated` 영역에서 검사합니다 (`:538`).

통과 시 `schemas: <n> checks passed`와 `note:` 행을, 실패 시 `schemas: <k> of <n> checks failed`와 영역별 상세를 출력합니다 (`check-protocol-drift.ts:548-549`, `:561`).

**실패 시 정확한 수정 방향** (`check-protocol-drift.ts:571-573`):

> `packages/protocol-ts`, `crates/cbc-protocol`, `schemas/`를 함께 갱신한 뒤 `schemas/CHANGELOG.md`에 변경을 기록하십시오.

SDK 유니온이 어긋난 경우에는 `bun run scripts/generate-sdk-types.ts`로 재생성합니다.

명시된 한계 (`:544-546`): Rust 상수를 소스 텍스트로 읽으므로 **선언된 목록만** 검증합니다. 디스패처는 `cargo test -p cbc-protocol`이 담당합니다.

### 3. `runtime-boundary:check` — Codex 런타임 의존성 부재

PRD §0.2 / AC-01. §0.2는 런타임 의존성 목록을 금지하고 **부재를 증명하는 테스트**를 CI에 요구합니다. 부재는 검증하기 어색한 대상이므로 — 다른 모든 검사는 두 산출물을 비교하지만 이것은 한 범주의 코드가 애초에 작성되지 않았음을 주장해야 합니다 — 네 가지 서로 다른 종류의 증거를 확인합니다 (`check-no-codex-runtime.ts:10-16`):

| # | 조건 | 증거 방식 |
| --- | --- | --- |
| 1 | 프로덕션 의존성 그래프에 Codex 런타임 패키지 없음 | 매니페스트 |
| 2 | `codex` / `codex app-server` / `codex exec` 프로세스 스폰 없음 | 소스 스캔 |
| 3 | 기본 실행 경로에서 `~/.codex` 접근 없음 | 소스 스캔 |
| 4 | Root Agent 통합 테스트가 mock 프로바이더에서 완주 | 이음새 존재 확인 |

금지 패턴 (`check-no-codex-runtime.ts:67-91`):

| ID | 패턴 | 이유 |
| --- | --- | --- |
| `bareProgram` | `/["'`]codex["'`]/i` | `codex`가 프로그램/명령 리터럴로 등장 |
| `subcommand` | `/codex[ \t]+(app-server\|exec)\b/i` | `codex app-server` 또는 `codex exec` 호출 |
| `codexHome` | `/~[\\/]\.codex\b\|\.codex[\\/]\|\bCODEX_HOME\b/` | `~/.codex` 경로 또는 `CODEX_HOME` 조회 |
| `sdk` | `/@openai\/codex\|codex-sdk\|openai-codex/i` | Codex SDK import |

**스캔은 무엇이 위반인지에 대해 의도적으로 좁습니다.** §0.2는 어휘가 아니라 *행위*에 관한 것입니다 — `capy auth login`은 Capybara가 Codex 자격증명을 재사용하지 않는다고 사용자에게 알려야 하고, `crates/cbc-protocol`은 `codex.app_server`가 알려진 메서드가 아님을 단언해야 합니다. 둘 다 **거부하기 위해** Codex를 언급합니다. 이를 플래그하는 검사는 저자에게 거부 코드를 삭제하도록 압박하게 되므로 — 의도와 정반대입니다 — **실행 가능한 형태만** 실패로 취급합니다 (`check-no-codex-runtime.ts:17-22`, `:60-66`). `bareProgram`은 `codex`가 인용부호로 감싼 **문자열 전체**일 것을 요구하므로 `"codex.app_server"`와 `"Codex credentials"`는 모두 범위 밖입니다.

통과 시 `no-codex-runtime-dependency: <n> checks passed across <m> file(s)`를 출력합니다 (`check-no-codex-runtime.ts:279`). 실패 시 조치는 우회가 아니라 **`cbc-runtime`(§20.3)을 통해 기능을 라우팅**하는 것입니다 (`check-no-codex-runtime.ts:299-301`).

### 4. `fixtures:check`

`fixtures/generate.ts --check`는 체크인된 픽스처가 생성기 출력과 일치하는지 확인합니다 (`package.json:41-42`). 실패 시 `bun run fixtures`로 재생성합니다.

### 게이트 실패 → 수정 명령 요약

| 실패한 게이트 | 수정 명령 |
| --- | --- |
| `typecheck` | 타입 오류 수정. 새 워크스페이스면 `tsconfig.json` `paths`에도 추가 |
| `schemas:check` | `packages/protocol-ts` + `crates/cbc-protocol` + `schemas/` 동시 갱신 → `schemas/CHANGELOG.md` 기록 → 필요 시 `bun run scripts/generate-sdk-types.ts` |
| `runtime-boundary:check` | 실행 가능한 Codex 참조 제거, `cbc-runtime` 경유로 대체 |
| `fixtures:check` | `bun run fixtures` |
| `source-truth:check` | `bun run source-truth --write` 후 매니페스트 커밋 |
| `test:release` | `bun test scripts/release.test.ts`로 국소 재현 |

## 테스트

### 러너 구성

| 러너 | 범위 | 명령 | 근거 |
| --- | --- | --- | --- |
| `bun test` | TypeScript 전체 (`apps`, `packages`, `benchmarks/cbc-bench/test`) | `bun run test:ts` | `package.json:18-19` |
| `bun test` | 릴리스 스크립트 | `bun run test:release` | `package.json:31` |
| `bun test` | 성능 하니스 | `bun run test:perf` | `package.json:21` |
| `cargo test` | Rust 워크스페이스 전체 | `bun run test:rust` | `package.json:20` |
| `pytest` | Python SDK만 | `pytest`(패키지 디렉터리에서) | `packages/sdk-python/pyproject.toml:30-31` |

**Vitest는 사용하지 않습니다** — `apps`/`packages`/`benchmarks`의 어떤 `package.json`에도 `vitest` 참조가 없고, TS 러너는 Bun 내장 테스트 러너 하나입니다. `*.test.ts` 파일은 워크스페이스 전체에 170개입니다.

### 루트 `.pytest_cache` / `__pycache__`의 정체

`.pytest_cache/v/cache/nodeids`의 노드 ID는 전부 `test_capy_pier_agent.py::CapybaraPierAdapterTests::*`이고, `__pycache__`에는 `capy_pier_agent`, `codex_chatgpt`, `test_capy_pier_agent`, `win_docker_env`의 `.pyc`가 있습니다. **원본 `.py` 파일은 저장소에 존재하지 않습니다** — 두 디렉터리는 추적되지 않는 외부 Python 스크립트를 이 위치에서 실행한 잔여물입니다. 저장소 안의 유일한 Python 코드는 `packages/sdk-python/`이고 그 pytest 설정은 `testpaths = ["tests"]`로 자기 디렉터리에 한정됩니다 (`packages/sdk-python/pyproject.toml:30-31`).

`.gitignore:13`이 `__pycache__/`를 무시하지만 **`.pytest_cache`는 `.gitignore`에 없습니다**. pytest가 자체 생성한 `.pytest_cache/.gitignore`가 내부를 무시하고 `source-truth.ts:40-41`이 두 디렉터리를 제외 패턴에 넣으므로 검증 게이트에는 영향이 없습니다.

### Python SDK 테스트

```
cd packages/sdk-python && pip install -e ".[dev]" && pytest
```

`dev` 추가 의존성은 `pytest>=8`뿐이고 (`packages/sdk-python/pyproject.toml:24`) `requires-python = ">=3.11"` (`:9`)입니다. 이 테스트는 루트 `verify` 게이트에 **포함되지 않습니다** — `package.json:36`에 pytest 호출이 없습니다.

### 테스트 위치

| 위치 | 내용 |
| --- | --- |
| `apps/cbc/test` | CLI 본체 |
| `apps/capy-daemon/test`, `apps/capy-vscode/test` | 데몬·VS Code 확장 |
| `packages/<name>/test` | 패키지별 단위 테스트 (30개 패키지) |
| `packages/integration-conformance/test/conformance.test.ts` | 통합 적합성 스위트 (`fixtures/` 동반) |
| `packages/evals/test` | 평가 스위트 4개 |
| `benchmarks/cbc-bench/test`, `perf/harness.test.ts` | 벤치마크·성능 하니스 |
| `scripts/release.test.ts` | 릴리스 스크립트 |
| `packages/sdk-python/tests/test_client.py` | Python SDK |

### 단일 테스트 실행

| 목적 | 명령 |
| --- | --- |
| 파일 하나 | `bun test packages/skills/test/registry.test.ts` |
| 이름으로 필터 | `bun test packages/skills --test-name-pattern "precedence"` |
| 디렉터리 하나 | `bun test packages/permissions` |
| Rust 크레이트 하나 | `cargo test -p cbc-protocol` |
| Rust 테스트 하나 | `cargo test -p cbc-protocol <테스트명>` |
| Python 테스트 하나 | `pytest packages/sdk-python/tests/test_client.py::<테스트명>` |

`cargo test -p cbc-protocol`은 프로토콜 디스패처를 덮으므로 `schemas:check`의 텍스트 기반 한계를 보완하는 짝입니다 (`check-protocol-drift.ts:544-546`).

## CI — `.github/workflows/release.yml`

워크플로는 **하나뿐**입니다. `.github/`에는 `workflows/` 디렉터리만 있고 `PULL_REQUEST_TEMPLATE`·`CODEOWNERS`·`CONTRIBUTING.md`는 없습니다.

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 이름 | `Public Alpha release` | `release.yml:1` |
| 트리거 | `push` — 태그 `v*-alpha.*` 만 | `release.yml:3-6` |
| 기본 권한 | `contents: read` | `release.yml:8-9` |
| 동시성 | 그룹 `public-alpha-${{ github.ref }}`, `cancel-in-progress: false` | `release.yml:11-13` |

**PR이나 `push` to `main`에서 실행되는 CI 워크플로는 없습니다.** 즉 `bun run verify`는 기여자가 로컬에서 직접 돌려야 하는 게이트입니다.

### 잡

| 잡 | 이름 | 러너 | `needs` | 근거 |
| --- | --- | --- | --- | --- |
| `validate` | Validate release gate | `ubuntu-24.04` | — | `release.yml:16-18` |
| `build-native` | Build ${{ matrix.target }} | 매트릭스 | `validate` | `release.yml:49-68` |
| `build-linux` | Build linux-x64 (glibc 2.31) | `ubuntu-24.04` + `ubuntu:20.04` 컨테이너 | `validate` | `release.yml:121-126` |
| `publish` | Publish npm packages and GitHub prerelease | `ubuntu-24.04` | `[validate, build-native, build-linux]` | `release.yml:202-205` |

### `build-native` 매트릭스

`fail-fast: false` (`release.yml:53`).

| 러너 | `target` | `package_dir` | `MACOSX_DEPLOYMENT_TARGET` |
| --- | --- | --- | --- |
| `windows-2025` | `windows-x64` | `capybara-code-win32-x64` | (없음) |
| `macos-15-intel` | `darwin-x64` | `capybara-code-darwin-x64` | `13.0` |
| `macos-15` | `darwin-arm64` | `capybara-code-darwin-arm64` | `13.0` |

근거: `release.yml:54-70`.

`linux-x64`는 매트릭스에 없고 **별도 잡**입니다. 이유는 주석에 명시돼 있습니다 (`release.yml:120`) — *GitHub 러너가 문서화된 GLIBC 2.31 요구사항을 조용히 올려버릴 수 없게* 하기 위함입니다. 따라서 `ubuntu:20.04` 컨테이너에서 빌드하고 `CBC_RELEASE_GLIBC_BASELINE: "2.31"`을 설정한 뒤 (`:127-128`) `test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"`로 빌드 환경 자체를 검증합니다 (`:164-165`).

### 고정된 툴체인 버전 (CI)

Bun `1.3.10` (4개 잡 전부 — `release.yml:24`, `:76`, `:154`, `:223`), Rust `1.85.0` (`:27-28`, `:158-162`), Node `24` (`build-linux`·`publish` — `:149`, `:216`).

`rust-toolchain.toml:2`은 `stable`이지만 CI는 `1.85.0`을 명시적으로 설치·기본 설정합니다. `Cargo.toml:22`의 `rust-version = "1.85"`가 이 하한과 일치합니다.

### `validate` 단계

`bun install --frozen-lockfile` (`release.yml:32`) → `bun run release:check -- --version "$GITHUB_REF_NAME"` (`:35`) → `bun run typecheck` (`:38`) → `bun run test:ts` (`:41`) → `bun run test:release` (`:44`) → `bun run test:rust` (`:47`).

`bun install --frozen-lockfile`은 `bun.lock`을 사용합니다 — CI에서도 Bun이 정본임을 확인하는 증거입니다.

**CI `validate`는 `bun run verify`의 부분집합입니다.** `schemas:check`, `runtime-boundary:check`, `fixtures:check`, `source-truth:check`, `test:perf`가 CI에 없습니다. 이 불일치는 아래에 기록합니다.

## 릴리스 파이프라인

### 버전은 4곳에서 일치해야 합니다

`readReleaseVersions`(`scripts/release-common.ts:99-118`)가 읽는 네 소스:

| # | 소스 | 추출 방식 | 현재 값 |
| --- | --- | --- | --- |
| 1 | `package.json` `version` | JSON (`release-common.ts:101`) | `0.1.2-alpha.1` (`package.json:3`) |
| 2 | `apps/cbc/package.json` `version` | JSON (`:102`) | `0.1.2-alpha.1` (`apps/cbc/package.json:3`) |
| 3 | `Cargo.toml` `[workspace.package] version` | 정규식 `/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"$/mu` (`:103`, `:106`) | `0.1.2-alpha.1` (`Cargo.toml:20`) |
| 4 | `apps/cbc/src/main.ts` `CBC_VERSION` | 정규식 `/export const CBC_VERSION\s*=\s*"([^"]+)";/u` (`:104`, `:107`) | `0.1.2-alpha.1` (`apps/cbc/src/main.ts:9`) |

네 값 중 하나라도 다르면 `assertReleaseVersions`가 `release versions disagree: {...}`로 실패합니다 (`release-common.ts:120-126`).

버전 형식은 `ALPHA_VERSION = /^\d+\.\d+\.\d+-alpha\.\d+$/u`로 강제됩니다 (`release-common.ts:59`, `:84-89`). 알파 형식이 아니면 `expected an alpha version like 0.1.0-alpha.1` 오류입니다.

태그는 `v` 접두사가 필수이며 (`release-common.ts:91-97`) `versionFromTag`가 접두사를 벗기고 알파 형식을 재확인합니다. 즉 태그 `v0.1.2-alpha.1` ↔ 버전 `0.1.2-alpha.1`.

`check-release.ts`는 `--version` / `--version=` 인자 또는 `GITHUB_REF_NAME` 환경변수에서 기대 버전을 얻습니다 (`scripts/check-release.ts:6-15`).

### 릴리스 순서

| # | 단계 | 명령 | 실행 위치 |
| --- | --- | --- | --- |
| 0 | 4곳의 버전을 새 알파 버전으로 올리고 커밋 | — | 로컬 |
| 1 | 로컬 전체 검증 | `bun run verify` | 로컬 |
| 2 | 버전 일치 확인 | `bun run release:check -- --version 0.x.y-alpha.n` | 로컬 |
| 3 | 태그 푸시 (`v0.x.y-alpha.n`) → 워크플로 트리거 | `git push origin v…` | 로컬 |
| 4 | 릴리스 게이트 검증 | `validate` 잡 | CI |
| 5 | Rust 런타임 빌드 | `bun run build:runtime` | CI 빌드 잡 |
| 6 | standalone 빌드 | `bun run build:capy -- --target <t>` | CI |
| 7 | 네이티브 npm 패키지 조립 | `bun run release:package -- --target <t>` | CI |
| 8 | 독립 릴리스 아카이브 생성 | `bun run release:archive -- --target <t>` | CI |
| 9 | 스모크 테스트 (바이너리 + 상대 사이드카 경로, linux는 `runtime.initialize` 핸드셰이크까지) | `bun run release:smoke -- --target <t>` | CI |
| 10 | 아티팩트 전송 **전에** npm tarball 팩 | `npm pack ./dist/npm/<pkg> --pack-destination dist/npm-tarballs` | CI |
| 11 | 불변 tarball + 네이티브 아카이브 업로드 (`retention-days: 7`, `if-no-files-found: error`) | `actions/upload-artifact@v4` | CI |
| 12 | 저장소가 공개인지 확인 (trusted publishing 전제) | `gh repo view … --jq '.isPrivate'` = `false` | CI `publish` |
| 13 | 네이티브 아티팩트 다운로드 (`pattern: native-*`, `merge-multiple: true`) | `actions/download-artifact@v4` | CI |
| 14 | 루트 런처 패키지 조립·팩 | `bun run release:package -- --launcher --out dist` | CI |
| 15 | tarball 5개 검증 + POSIX 실행 비트 검증 | `npm publish --dry-run --tag alpha --access public` | CI |
| 16 | npm 게시 | `npm publish --tag alpha --access public --provenance` | CI |
| 17 | SHA-256 매니페스트 작성 | `bun run release:checksums -- --dir dist/release` | CI |
| 18 | GitHub 프리릴리스 생성 | `gh release create … --verify-tag --prerelease` | CI |

근거: `release.yml:30-47`, `:86-118`, `:167-200`, `:225-306`.

### 게시되는 npm 패키지 5개

루트 런처 `capybara-code-<version>.tgz`(`release-launcher.cjs` 기반) 하나와 네이티브 4개 `ilbie-capybara-code-{win32-x64,darwin-x64,darwin-arm64,linux-x64}-<version>.tgz`.

근거: `release.yml:252-258`, `:285-291`. 네이티브 패키지 스코프는 `NATIVE_PACKAGE_SCOPE = "@ilbie"` (`release-common.ts:12`), 제품 패키지명은 `PRODUCT_PACKAGE = "capybara-code"` (`:11`).

**dist-tag는 `alpha`입니다** — dry-run과 실제 게시 모두 `--tag alpha`를 씁니다 (`release.yml:263`, `:292`). 즉 `npm install capybara-code`는 알파를 가져오지 않고, 명시적으로 `@alpha` 또는 정확한 버전을 요구해야 합니다.

### 산출물 검증

| 검증 | 방식 | 근거 |
| --- | --- | --- |
| 버전 4곳 일치 | `verifyReleaseVersion` (모든 릴리스 스크립트가 호출) | `release-common.ts:135-137` |
| standalone 스테이지 형태 | `assertStandaloneArtifact` | `package-npm.ts:13`, `archive-release.ts:11` |
| 산출물 안전성 | `assertArtifactSafety` | `package-npm.ts:12` |
| 실행 파일 존재·권한 | `requireExecutableFile` | `package-npm.ts:17` |
| 사이드카 상대 경로 해석 | 실제 실행 (`smoke-release.ts`) | `smoke-release.ts:2` |
| tarball 5개 존재 + npm 수용 가능 | `test -f` + `npm publish --dry-run` | `release.yml:261-265` |
| POSIX 실행 비트 (`bin/capy`, `libexec/cbc-runtime`) | tarball 추출 후 `test -x` | `release.yml:267-277` |
| GLIBC 심볼 버전 상한 | `build:runtime` 내 검증 (`assertGlibcBuildHost`, `newestGlibcSymbolVersion`) | `release.yml:170-171`, `release.test.ts:11-14` |
| SHA-256 | `SHA256SUMS.txt` | `write-release-checksums.ts:18` |
| npm provenance | `--provenance` + `id-token: write` | `release.yml:292`, `:211` |
| 태그-커밋 일치 | `gh release create --verify-tag` | `release.yml:302-303` |

`publish` 잡은 `environment: npm-publish`를 사용하고 `contents: write` + `id-token: write` 권한을 추가로 요구합니다 (`release.yml:205-211`) — npm trusted publishing(OIDC) 경로입니다.

재현성: `build-runtime.ts`는 Rust가 최적화된 Windows 산출물에 소스 경로를 임베드하므로 **모든 크레이트에 경로 remap을 적용**합니다. 패키징된 런타임은 안정적인 가상 접두사만 포함합니다 (`scripts/build-runtime.ts:4-8`).

## 벤치마크와 성능

### `benchmarks/cbc-bench`

워크스페이스 멤버(`package.json:11`)이며 CLI는 `bun run bench` → `benchmarks/cbc-bench/src/cli.ts` (`package.json:43`)입니다. 테스트는 `benchmarks/cbc-bench/test`에 있고 루트 `test`/`test:ts`가 이 디렉터리를 명시적으로 포함합니다 (`package.json:18-19`). 결과물은 `benchmarks/*/results`에 쌓이며 소스 진실 지문에서 **제외**되므로 (`source-truth.ts:42`) 벤치마크 실행이 검증 게이트를 깨뜨리지 않습니다.

### `perf/`

구성: `harness.ts`(본체), `harness.test.ts`(회귀 테스트 — `bun run test:perf`), `cli.ts`, `tsconfig.json`(별도 TS 설정), `README.md`.

`test:perf`는 `bun run verify`의 7단계이므로 (`package.json:36`) 성능 회귀는 로컬 검증에서 잡히지만 CI `validate` 잡에는 없습니다.

### 평가·적합성 스위트

`packages/evals/test`에는 `evals.test.ts`, `paired.test.ts`, `performance-metrics.test.ts`, `statistics.test.ts` 네 스위트가 있습니다 — 짝지은 비교(`paired`)와 통계(`statistics`)가 분리돼 있습니다. `bun test packages/evals`로 실행합니다. `packages/integration-conformance`는 단일 스위트 `test/conformance.test.ts`와 `fixtures/`로 구성되며 `bun test packages/integration-conformance`로 실행합니다.

## 규약

### 커밋 메시지

Conventional Commits 형식 `<type>(<scope>): <소문자 영어 요약>`을 씁니다. 최근 40개 커밋(`git log --oneline -40`)에서 관찰된 타입:

| 타입 | 실제 예시 |
| --- | --- |
| `feat(<scope>)` | `feat(kernel): report which native lane the turn actually got` |
| `fix(<scope>)` | `fix(openai): stop advertising api-only native tools on chatgpt accounts` |
| `chore` / `chore(<scope>)` | `chore: refresh the source-truth manifest for the new event kinds`, `chore(config): promote wired programmatic tool calling keys` |
| `docs` / `docs(<scope>)` | `docs: add the missing korean wiki pages`, `docs(deep-plan): publish contracts and operator guide` |

관찰된 스코프: `kernel`, `openai`, `cbc`, `tui`, `context-engine`, `context`, `protocol`, `session`, `subagents`, `plan`, `bench`, `daemon`, `deep-plan`, `config`.

- 요약은 **영어, 소문자 시작, 명령형 현재시제**, 끝에 마침표 없음.
- 스코프는 워크스페이스/서브시스템 이름이며 저장소 전역 변경은 생략합니다.
- 소스 진실 매니페스트 갱신은 **별도 `chore:` 커밋으로 분리**합니다 (`b3f1b1e`, `c8d6f38`, `ae1d8f1`, `dc0d329`) — 코드 변경과 지문 갱신이 섞이지 않게 하기 위한 관행입니다.
- 릴리스 준비도 별도 커밋입니다 (`d813ea7 chore: prepare v0.1.2-alpha.1 release`).

### 브랜치·PR

기본 브랜치는 `main`입니다. `.github/`에는 `workflows/`만 존재하므로 **PR 템플릿·CODEOWNERS·CONTRIBUTING.md·이슈 템플릿이 없습니다**. PR 검증 워크플로도 없으므로 제출 전 `bun run verify` 통과가 사실상의 요구사항입니다.

### 라이선스

Apache License 2.0 (`LICENSE:1-3`). `package.json:6`의 `"license": "Apache-2.0"`, `packages/sdk-python/pyproject.toml:10`의 `license = { text = "Apache-2.0" }`가 일치합니다.

### 로컬 개발 루프

`bun run capy-dev`(소스에서 직접 실행) · `bun run dev:link` / `dev:unlink`(`capy-dev` 셸 명령 등록·해제) · `bun run stage`(컴파일 없이 스테이징) · `bun run verify`(전체 검증).

`dev-link.ts`는 **공개 `capy`를 절대 건드리지 않고** `capy-dev`만 등록합니다 (`scripts/dev-link.ts:3-8`). 정식 설치본과 개발 체크아웃이 같은 머신에서 공존할 수 있습니다.

## 알려진 불일치

| # | 불일치 | 근거 |
| --- | --- | --- |
| 1 | **pnpm 잔재.** `pnpm-lock.yaml`과 `pnpm-workspace.yaml`이 존재하지만 `engines`는 Bun만 요구하고(`package.json:13-15`) 모든 스크립트·CI가 Bun을 씁니다(`release.yml:32` 등). pnpm으로 설치하면 사용되지 않는 락파일을 갱신하게 됩니다. 다만 `pnpm-workspace.yaml`은 `source-truth.ts:33`의 정본 최상위 파일 목록에 포함돼 있어 삭제하면 매니페스트를 갱신해야 합니다. | `package.json:13-15`, `pnpm-workspace.yaml:1-4`, `source-truth.ts:33` |
| 2 | **CI가 `verify`의 부분집합입니다.** `validate` 잡은 `typecheck`·`test:ts`·`test:release`·`test:rust`만 실행하고 `schemas:check`, `runtime-boundary:check`, `fixtures:check`, `source-truth:check`, `test:perf`는 실행하지 않습니다. `check-no-codex-runtime.ts:6-7`은 §0.2가 "CI에 부재를 증명하는 테스트를 요구한다"고 적고 있으나 현재 워크플로는 그 게이트를 호출하지 않습니다. | `release.yml:37-47` vs `package.json:36`, `check-no-codex-runtime.ts:6-7` |
| 3 | **PR 시 실행되는 워크플로가 없습니다.** 유일한 워크플로가 `v*-alpha.*` 태그 푸시에만 트리거되므로 (`release.yml:3-6`) PR·main 푸시에 자동 검증이 없습니다. | `release.yml:3-6`, `ls .github/workflows/` |
| 4 | **Rust 채널 표기 차이.** `rust-toolchain.toml:2`은 `channel = "stable"`이지만 CI는 `1.85.0`을 명시 설치합니다. 로컬 `stable`이 CI보다 앞서 나갈 수 있습니다. | `rust-toolchain.toml:2` vs `release.yml:27-28` |
| 5 | **`generate-sdk-types.ts`가 스크립트로 등록되지 않았습니다.** `check-protocol-drift.ts:538`이 `sdk.generated` 실패를 보고할 수 있으나 재생성용 루트 스크립트가 `package.json:16-45`에 없어 경로를 직접 입력해야 합니다. | `package.json:16-45`, `scripts/generate-sdk-types.ts:1-6` |
| 6 | **`.pytest_cache`가 `.gitignore`에 없습니다.** `.gitignore:13`은 `__pycache__/`만 무시합니다. 두 디렉터리 모두 저장소에 원본 `.py`가 없는 외부 스크립트(`capy_pier_agent`, `codex_chatgpt`, `win_docker_env`)의 잔여물이며, 검증 게이트에는 `source-truth.ts:40-41`이 둘 다 제외하므로 영향이 없습니다. | `.gitignore:13`, `.pytest_cache/v/cache/nodeids`, `source-truth.ts:40-41` |
| 7 | **`tsconfig.json`은 프로젝트 참조를 쓰지 않습니다.** `references` 필드 없이 `paths` 별칭 26개로 소스 엔트리를 직접 매핑하므로 (`tsconfig.json:28-57`) 증분 빌드 이득이 없고 새 패키지 추가 시 수동 등록이 필요합니다. | `tsconfig.json:28-60` |
| 8 | **`test`와 `test:ts`가 동일합니다.** 인자 순서만 다르고 범위가 같습니다. | `package.json:18-19` |

## 관련 문서

- [architecture.md](architecture.md)
- [rust-runtime.md](rust-runtime.md)
- [installation.md](installation.md)
- [tools.md](tools.md)
- [packages-and-plugins.md](packages-and-plugins.md)
- [integrations.md](integrations.md)
- [troubleshooting.md](troubleshooting.md)
