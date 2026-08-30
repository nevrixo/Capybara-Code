# 설치

## 지원 플랫폼

릴리스 대상은 **네 개**입니다 (`scripts/release-common.ts:25-55`).

| 타깃 | npm 패키지 | os / cpu | 비고 |
| --- | --- | --- | --- |
| `windows-x64` | `@ilbie/capybara-code-win32-x64` | win32 / x64 | Windows 10 1809 이상 |
| `darwin-x64` | `@ilbie/capybara-code-darwin-x64` | darwin / x64 | macOS 13 Ventura 이상 |
| `darwin-arm64` | `@ilbie/capybara-code-darwin-arm64` | darwin / arm64 | Apple Silicon |
| `linux-x64` | `@ilbie/capybara-code-linux-x64` | linux / x64 | glibc 2.31 이상 (`libc: ["glibc"]` 선언) |

`linux-arm64`와 `linux-x64-musl`은 **빌드는 가능하지만 릴리스 대상이 아닙니다.** `releaseTarget("linux-arm64")`는 예외를 던집니다 (`scripts/release.test.ts:74`).

미지원 호스트에서 런처를 실행하면 다음 메시지와 함께 종료 코드 1로 끝납니다 (`scripts/release-launcher.cjs:169-175`):

```
Capybara Code Public Alpha does not support <platform>/<arch>.
Supported: Windows x64, macOS x64/ARM64, and Linux x64 (glibc).
```

명시적으로 지원하지 않는 환경: Linux ARM64, musl 기반 배포판, Windows ARM64, WSL1, macOS 12 이하.

### 플랫폼 하한선이 실제로 강제되는 지점

문서상의 선언이 아니라 빌드/릴리스 스크립트가 실제로 검사합니다.

- **glibc 2.31** — 네 겹으로 검사합니다.
  1. CI가 Linux 아티팩트를 `container: image: ubuntu:20.04` 안에서 빌드합니다 (`.github/workflows/release.yml:118-126`).
  2. 빌드 전 `test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"` 단정 (`release.yml:165`).
  3. `CBC_RELEASE_GLIBC_BASELINE=2.31`이 설정되면 호스트 glibc가 기준선보다 **새로우면** 빌드를 거부합니다 (`scripts/build-runtime.ts:70-83`, `156-162`).
  4. 빌드 후 `readelf --version-info`로 사이드카가 요구하는 최신 `GLIBC_x.y` 심볼을 확인하고 기준선을 넘으면 실패시킵니다 (`build-runtime.ts:165-175`, 호출은 `:209-211`).
- **macOS 13.0** — 두 macOS 매트릭스 잡에 `MACOSX_DEPLOYMENT_TARGET: "13.0"`이 잡 환경으로 설정됩니다 (`release.yml:63,67,70`).
- **Windows 정적 CRT** — `-Ctarget-feature=+crt-static`가 win32에서만 RUSTFLAGS에 추가되므로 별도의 Visual C++ 재배포 패키지가 필요하지 않습니다 (`build-runtime.ts:126-128`).

`README.md`에 적힌 네 개의 하한선 문자열은 `scripts/release.test.ts:151-154`가 존재를 검사합니다. 즉 문서에서 하한선을 몰래 낮추면 `bun run test:release`가 깨집니다.

## 설치 방법

전역 `capy` 명령을 npm 또는 Bun으로 설치합니다.

```bash
# npm
npm install -g capybara-code@alpha

# Bun
bun install -g capybara-code@alpha
```

`capybara-code`는 **런처 패키지**입니다. 실제 네이티브 바이너리는 `optionalDependencies`로 선언된 네 개의 플랫폼 패키지 중 하나로 설치되고, `bin/capy.cjs`가 현재 플랫폼에 맞는 것을 `require.resolve`로 찾아 실행합니다 (`scripts/release-launcher.cjs:22-27`, `177-191`).

### 설치 시 주의사항

- **npm과 Bun을 동시에 쓰지 마십시오.** 두 shim이 충돌합니다. 설치에 쓴 패키지 매니저로 업그레이드도 하십시오.
- `--omit=optional`로 설치하면 네이티브 패키지가 빠져 실행이 실패합니다. 런처가 그 경우 재설치를 안내합니다 (`release-launcher.cjs:177-191`).
- **WSL에서는** `/mnt/c/...` 아래의 Windows 실행 파일이 아니라 리눅스 네이티브 `node`, `npm`, `bun`으로 설치·실행하십시오.

### 설치된 레이아웃

플랫폼 패키지는 다음 구조를 담습니다 (`scripts/build-standalone.ts:148-152`).

```
bin/capy[.exe]                       # Bun으로 컴파일한 단일 실행 파일
libexec/cbc-runtime[.exe]            # Rust 실행 사이드카
libexec/capy-daemon[.exe]            # 세션 데몬
share/capybara/skills/<name>/SKILL.md
share/capybara/schemas/**.json
share/capybara/model-registry.json   # 콜드 스타트에 네트워크를 쓰지 않기 위한 모델/가격 스냅샷
share/capybara/notices/THIRD-PARTY.md
share/capybara/notices/sbom.json     # CycloneDX 1.5
manifest.json
```

사이드카는 **항상 `bin/` 기준 상대 경로로만** 해석됩니다. PATH를 보지 않습니다 (`scripts/smoke-release.ts:169-197`의 2단계가 이를 검증하고, 데몬도 동일하게 `../libexec/capy-daemon`만 봅니다 — `apps/cbc/src/commands/daemon.ts:69-79`).

## 업데이트

### 자동 확인

대화형 시작 시 매 실행마다 GitHub Releases를 확인합니다. 확인은 신뢰 프롬프트와 **병렬로** 시작해 왕복 시간을 감춥니다 (`apps/cbc/src/commands/interactive.ts:163`), 시작 시 예산은 1500 ms (`update-check.ts:33`).

새 릴리스가 있으면 주황색 박스로 두 선택지를 제시합니다 (`update-prompt.ts:59-78`).

1. `Update now with <bun|npm>` — 패키지 매니저가 감지된 경우. 감지되지 않으면 `Show update instructions`
2. `Remind me next time`

Esc/취소는 "나중에"로 처리되며 **아무것도 저장하지 않으므로** 다음 실행에서 다시 묻습니다.

### 업데이트가 동작하는 방식 (exit 42 핸드오프)

실행 중인 바이너리는 Windows에서 자기 자신을 교체할 수 없습니다. 그래서 교체는 런처가 수행합니다.

1. 런처가 자식에게 `CAPYBARA_UPDATE_REQUEST_FILE`과 `CAPYBARA_UPDATE_MANAGER`를 넘깁니다. 공격자가 심어둔 값이 살아남지 못하도록 **상속 환경에서 두 변수를 먼저 제거합니다** (`release-launcher.cjs:193-216`).
2. 네이티브 바이너리는 요청 파일에 `{schemaVersion:1, packageName:"capybara-code", version, tag}`를 원자적으로 쓰고 **종료 코드 42**로 끝냅니다 (`update-install.ts:40-67`).
3. 런처가 요청을 재검증합니다 — `schemaVersion === 1`, 패키지 이름 정확히 일치, semver 형태, `tag === "v" + version` (`release-launcher.cjs:106-114`).
4. `<manager> install -g capybara-code@<version>`을 실행하고, **설치된 `package.json`의 버전이 실제로 바뀌었는지 확인한 뒤** 성공을 보고합니다 (`release-launcher.cjs:146-157`).

패키지 매니저 감지는 런처가 합니다: 런처 경로에 `/.bun/`이 포함되면 `bun`, 아니면 `npm` (`release-launcher.cjs:54-56`). Windows에서는 `npm.cmd`를 셸 없이 spawn할 수 없으므로 `node <…>/node_modules/npm/bin/npm-cli.js`로 호출합니다 (`:89-99`).

아카이브를 직접 실행한 경우에는 교체할 런처가 없으므로 정확한 버전을 명시한 수동 안내만 표시합니다.

### 수동 확인

```bash
capy update          # 확인 후 대화형 프롬프트
capy update --check  # 확인만
```

종료 코드에 주의하십시오 (`apps/cbc/src/commands/update.ts:23`).

| 상황 | 종료 코드 |
| --- | --- |
| 최신 버전 | 0 |
| 업데이트 확인 비활성/개발 체크아웃/비 semver | 0 (메시지 출력 후) |
| **새 릴리스 존재** | **2** |
| 후보 없음 + 오류 발생 | 1 |

여기서 `2`는 일반적인 "사용법 오류"가 아니라 "업데이트 가능"을 의미합니다.

### 업데이트를 끄는 방법

- 설정: `updates.check = false`
- 환경 변수: `CBC_NO_UPDATE_CHECK`에 비어 있지 않은 값

시작 시 확인은 다음 중 하나라도 해당하면 건너뜁니다 (`update-check.ts:260-276`): `updates.check` 비활성, 비대화식, stdin이 TTY가 아님, `CI === "true"` 또는 `GITHUB_ACTIONS === "true"`, 개발 체크아웃, semver가 아닌 버전.

### 네트워크 동작

- 엔드포인트: `https://api.github.com/repos/nevrixo/Capybara-Code/releases?per_page=20` (`update-check.ts:31`). `/releases/latest`가 아닌 이유는 그 경로가 프리릴리스를 영구히 감추기 때문입니다.
- 호스트 허용 목록: `api.github.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (`update-check.ts:37-42`). HTTPS만, URL 내 자격 증명 금지, 응답 1 MiB 상한.
- 전송되는 식별자는 `User-Agent: capybara-code/<version>`뿐입니다.
- 표시되는 릴리스 URL은 API의 `html_url`이 아니라 고정된 저장소 상수로 **재구성**합니다 (`update-check.ts:54-55`, `206-208`).
- semver 비교는 호스트가 하지 않고 런타임의 `update.verify`에 위임합니다 (`update-check.ts:62-70`).

상태 저장 위치는 `<data>/updates.json`입니다 (`update-store.ts:39-41`). 손상된 JSON이나 알 수 없는 `version`은 빈 저장소로 fail-closed 처리하므로, 망가진 skip 목록이 "전부 건너뛰기"로 변질되지 않습니다 (`update-store.ts:46-61`).

## 아티팩트 검증

GitHub Release 아카이브에는 `SHA256SUMS.txt`가 포함됩니다 (`scripts/write-release-checksums.ts`). 형식은 `<hex>  <상대경로>`이며 정렬되어 있습니다.

npm 배포는 OIDC 기반 trusted publishing만 사용합니다 — `npm publish --tag alpha --access public --provenance`, 토큰 없음 (`release.yml`의 publish 잡; `release.test.ts`가 `id-token: write`와 `--provenance`의 존재, `NODE_AUTH_TOKEN`/`NPM_BOOTSTRAP_TOKEN`의 부재를 단정합니다).

`manifest.json`은 코드 서명이 **아직 없다는 사실을 명시**합니다 (`build-standalone.ts:310-327`):

```json
"signature": {
  "signed": false,
  "note": "unsigned Public Alpha artifact; verify the release SHA-256 checksums"
}
```

## 레거시 설치 정리

이전 설치가 남아 충돌하는 경우 정리 스크립트가 있습니다. 둘 다 기본은 dry-run입니다.

```bash
# Windows (기본 dry-run, 실제 적용은 -Apply)
npm run legacy:cleanup

# WSL / Linux (기본 dry-run, 실제 적용은 --apply)
npm run legacy:cleanup:wsl
```
