# 시작 시 업데이트 확인 기획서 — 폴더 신뢰와 같은 업데이트/건너뛰기 프롬프트

- 상태: 초안 (검토 대기)
- 작성일: 2026-08-27
- 대상: Capybara Code (`capy`) 대화형 시작 경로
- 소스 오브 트루스: [github.com/nevrixo/Capybara-Code](https://github.com/nevrixo/Capybara-Code) GitHub Releases
- 관련 코드: `apps/cbc/src/workspace-trust.ts`, `apps/cbc/src/commands/interactive.ts`, `crates/cbc-update`, `crates/cbc-runtime/src/handlers/update.rs`, `packages/config-schema/src/schema.ts`
- 이 문서는 기획만 고정한다. 구현 커밋은 포함하지 않는다.

---

## 1. 요약

`capy`를 대화형으로 실행하면, 폴더 신뢰 프롬프트와 같은 스타일의 박스가 뜬다. 설치된 버전보다 새 GitHub Release가 있으면 **지금 업데이트** 또는 **이 버전 건너뛰기**를 고른다.

핵심 원칙:

1. **묻지 않고 설치하지 않는다.** 자동 업데이트는 없다.
2. **확인 실패는 실행을 막지 않는다.** GitHub가 죽어도 `capy`는 그대로 뜬다.
3. **다운로드한 바이트는 검증 후에만 설치한다.** 체크섬(및 서명 정책)을 우회하지 않는다.
4. **프로젝트 설정은 업데이트 정책을 바꾸지 못한다.** `updates.*`는 이미 user-only다.

현재 제품은 Public Alpha다. npm `capybara-code@alpha`와 GitHub prerelease가 같이 나간다. 이 기획의 1차는 그 채널에서 **새 버전이 있으면 신뢰 프롬프트처럼 막고 물어보는 것**이다.

---

## 2. 왜 이 기능인가

사용자는 `capy`를 폴더에서 연다. 그 순간 이미 한 번 막힌다: *이 폴더의 파일을 신뢰합니까?* 같은 자리에서 새 버전이 있으면 한 번 더 고르게 한다. TUI에 들어간 뒤 배너만 보면 놓친다.

의도는 단순하다.

- 새 버전이 있다 → 업데이트하거나 건너뛴다.
- 건너뛴 버전은 더 새 버전이 나오기 전까지 다시 묻지 않는다.
- 네트워크나 GitHub가 불안정하면 조용히 이번 실행을 진행한다.

---

## 3. 코드베이스 현재 상태

조사 결과, **렌더 조각과 검증 권한은 이미 있고, 시작 시 확인·프롬프트·설치 경로는 없다.**

### 3.1 이미 있는 것

| 지점 | 위치 | 내용 |
|------|------|------|
| 폴더 신뢰 UX | `apps/cbc/src/workspace-trust.ts` | TUI 전에 주황 박스 + `host.io.select`. `trusted-once`는 세션만, `trusted-always`는 사용자 로컬 `trust.json`에 저장 |
| 시작 순서 | `apps/cbc/src/commands/interactive.ts` | §7.1: 워크스페이스 결정 → **trust** → 설정 → **paint** → 백그라운드 워밍 |
| 업데이트 배너 | `packages/tui-components/src/blocks.ts` `renderUpdateBanner` | 비차단 배너. 버전과 패키지 매니저 안내 |
| 배너 입력 | `packages/tui-components/src/screen.ts` `updateVersion?: string` | 화면은 받을 수 있다 |
| 설정 키 | `packages/config-schema` `updates.{channel,check,intervalHours}` | 기본 `stable` / `true` / `24`. 프로젝트 레이어가 덮어쓰지 못함 |
| 환경 변수 | `CBC_NO_UPDATE_CHECK` | 값이 있으면 `updates.check = false` |
| 버전 비교 | `cbc_update::is_newer` + RPC `update.verify` | 런타임이 비교한다. 호스트가 semver를 자체 해석하지 않는다 |
| 아티팩트 검증 | `cbc_update::verify_release` | SHA-256 + (정책상) Ed25519. **다운로드는 하지 않는다** |
| 릴리스 파이프라인 | `.github/workflows/release.yml` | 태그 `v*-alpha.*` → npm `@alpha` + GitHub **prerelease** + `SHA256SUMS.txt` |
| 저장소 상수 | `scripts/release-common.ts` | `HOMEPAGE_URL = https://github.com/nevrixo/Capybara-Code` |

### 3.2 없는 것 / 함정

1. **`updateVersion`을 실제로 넣는 코드가 없다.** 배너는 테스트에만 존재한다.
2. **`warmContext`는 저장소 맵만 워밍한다.** 주석의 “update check in the background”는 아직 구현이 아니다.
3. **`updates.check` / `intervalHours`는 게이트 키만 있다.** 소비자 명령이 없다.
4. GitHub `GET /repos/.../releases/latest`는 **prerelease를 무시한다.** Public Alpha는 전부 `--prerelease`이므로 이 엔드포인트를 쓰면 업데이트를 영원히 못 본다.
5. 릴리스 `manifest.json`은 아직 `signed: false`다. `PINNED_RELEASE_PUBLIC_KEY`는 플레이스홀더이고 TODO가 붙어 있다. **서명만 보고 설치하면 안 된다.**
6. 기본 `updates.channel = "stable"`인데 현재 출시는 alpha prerelease다. 채널을 글자 그대로 적용하면 alpha 사용자는 업데이트를 못 본다. 아래 5.3에서 실효 정책을 고정한다.

### 3.3 기존 PRD와의 긴장

| PRD | 현재 문구 | 이 기획의 결정 |
|-----|-----------|----------------|
| §7.1 | 업데이트 확인은 **paint 이후 백그라운드** | 메타데이터 확인은 시작과 동시에 병렬. 결과가 타임아웃 안에 오면 **TUI paint 전에** 신뢰 박스와 같은 프롬프트. 늦으면 이번 실행은 프롬프트 없이 진행 |
| §6.19 / AC-41 | **비차단 배너**만 | 대화형 TTY에서는 차단 프롬프트가 1차. 배너는 타임아웃·비 TTY 폴백 |
| §19.9 | 런타임은 검증만, 임의 postinstall 다운로드 금지 | 유지. 호스트가 GitHub에서만 받고, 설치 전에 `update.verify` |
| AC-04 | 첫 paint 지연을 재지 않는다 | 네트워크 대기는 하드 캡 (5.2). 캡을 넘기면 프롬프트를 생략한다 |

---

## 4. 목표 / 비목표

### 4.1 목표

- 대화형 `capy`에서 새 버전이 있으면 폴더 신뢰와 같은 박스로 업데이트 또는 건너뛰기를 고른다.
- 진실 공급원은 **GitHub Releases** (`nevrixo/Capybara-Code`)다. npm은 설치 수단일 뿐 버전 진실이 아니다.
- 건너뛴 버전은 더 새 버전이 나오기 전까지 다시 묻지 않는다.
- 확인·다운로드·설치 전 구간을 위협 모델에 넣고, 실패 시 실행을 막지 않는다.
- 기존 `cbc-update` / `update.verify`를 검증 권한으로 재사용한다.

### 4.2 비목표 (이번 기획 밖)

- 묻지 않는 자동 업데이트, 백그라운드 자가 교체 데몬
- 임의 미러, 사용자가 넣은 업데이트 URL, GitHub 외 호스트
- 저장소 소스 체크아웃(`bun run capy-dev`)을 릴리스 바이너리로 덮어쓰기
- 플러그인·MCP·LSP 바이너리 업데이트
- 다운그레이드, 채널 점프 UI (`stable` ↔ `nightly` 전환 마법사)
- 릴리스 노트 전체 렌더, 변경 로그 TUI
- 프로덕션 Ed25519 키 교체 자체 (서명은 게이트로만 다룬다. 키 교체는 별도 릴리스 작업)

---

## 5. 사용자 경험

### 5.1 프롬프트 모양

폴더 신뢰와 같은 주황 박스, 같은 `host.io.select` 입력. TUI 전체화면 이전, stderr에 그린다.

```
╭──────────────────────────────────────────────────────────╮
│                                                          │
│  A new version of Capybara Code is available             │
│                                                          │
│  current   0.1.1-alpha.7                                 │
│  latest    0.1.1-alpha.8                                 │
│                                                          │
│  Source: github.com/nevrixo/Capybara-Code                │
│  Release: https://github.com/nevrixo/Capybara-Code/      │
│           releases/tag/v0.1.1-alpha.8                    │
│                                                          │
│  Updates replace the installed capy binary. Skip keeps   │
│  this version and will not ask again until a newer one.  │
│                                                          │
╰──────────────────────────────────────────────────────────╯

  1. Update now
  2. Skip this version
```

Esc / 취소 = 이번 실행만 건너뛰기 (이 버전을 영구 스킵하지 않음). 폴더 신뢰의 “No, exit”와 달리 **프로세스를 종료하지 않는다.**

한국어 로케일이 켜져 있으면 동일한 카피로 표시한다. 신뢰 박스와 같이 고정 폭으로 줄바꿈한다.

### 5.2 시작 순서

```
process start
    │
    ├─(병렬) GitHub 메타데이터 확인 시작  ← 네트워크, 하드 타임아웃
    │
    ├─ workspace resolve
    ├─ ensureTrust()                   ← 기존, 네트워크 없음
    │
    ├─ 확인이 타임아웃 안에 끝났고, 새 버전이며, 스킵 목록에 없음
    │     → ensureUpdatePrompt()       ← 이 기획의 새 차단 단계
    │     → "Update now"면 설치 후 안내하고 종료 (재실행은 사용자)
    │     → "Skip this version"이면 저장 후 계속
    │     → Esc면 세션만 건너뛰고 계속
    │
    └─ TUI paint                       ← 기존 AC-04 지점
```

규칙:

- 메타데이터 확인은 **trust보다 먼저 시작**해서, 사용자가 폴더 신뢰에 답하는 동안 응답이 오도록 한다.
- 하드 타임아웃 **1500ms**. 초과 시 프롬프트 없이 진행. 나중에 배너를 띄울 수 있으면 띄운다.
- 확인 오류(DNS, TLS, 429, 잘못된 JSON)는 경고 한 줄 없이 실패 개방. 필요하면 디버그 로그에만 남긴다. 시작 화면을 오류로 채우지 않는다.
- `capy "프롬프트"`처럼 첫 턴 인자가 있어도 프롬프트는 trust 다음, TUI 전에 그대로 둔다. 업데이트가 설치를 바꾸기 때문이다.

### 5.3 언제 묻지 않는가

다음이면 네트워크도 프롬프트도 없다.

| 조건 | 이유 |
|------|------|
| `updates.check = false` | 사용자 설정 |
| `CBC_NO_UPDATE_CHECK`가 비어 있지 않음 | CI/스크립트 킬 스위치 |
| `capy run` 및 모든 `nonInteractive` | 폴더 신뢰가 비대화형에서 승격하지 않는 것과 같음 |
| stdin이 TTY가 아님 | 선택 UI가 hang 또는 파이프를 삼킴 |
| `CI=true` 또는 `GITHUB_ACTIONS=true` | 헤드리스 |
| `intervalHours` 안의 캐시가 “업데이트 없음” 또는 “이미 스킵한 버전” | 불필요한 네트워크 금지 |
| 현재 버전이 semver가 아님 | `is_newer`가 이미 false |
| 개발 체크아웃에서 실행 (`capy-dev` / 컴파일되지 않은 소스 엔트리) | 알림만 허용. 자가 교체 금지. 1차에서는 프롬프트 자체를 생략해 구현을 단순하게 유지하는 것을 권장 |

캐시에 **아직 스킵하지 않은 새 버전**이 있으면 네트워크 없이 프롬프트를 띄운다. `intervalHours`는 네트워크 재확인만 제한한다. “새 버전을 알고 있는데 안 묻는 것”을 막기 위함이다.

### 5.4 업데이트 vs 건너뛰기

| 선택 | 동작 |
|------|------|
| **Update now** | 설치 수단을 감지하고 검증된 설치를 실행한다 (7절). 성공하면 “updated to X. Run `capy` again.”을 출력하고 **프로세스 종료** (exit 0). 실행 중 바이너리를 교체한 뒤 같은 프로세스에서 TUI를 계속 열지 않는다. |
| **Skip this version** | `updates.json`에 해당 버전을 기록. 더 높은 버전이 나오기 전까지 프롬프트 없음. TUI 계속 |
| **Esc / 취소** | 세션만 건너뜀. 기록하지 않음. 다음 대화형 실행에서 `intervalHours`와 캐시에 따라 다시 물을 수 있음 |

실패 개방: 설치가 실패하면 기존 바이너리를 그대로 두고, 오류를 보여 준 뒤 TUI로 계속 갈지 종료할지 한 번 더 묻는다. 기본은 **기존 버전으로 계속**. 반쯤 설치된 상태로 TUI를 열지 않는다. 스테이징을 롤백한다.

---

## 6. 버전 발견 — GitHub만

### 6.1 고정 소스

코드 상수. 설정 파일, 환경 변수, 프로젝트 파일, 릴리스 노트 본문이 이 값을 바꾸지 못한다.

```
owner  = "nevrixo"
repo   = "Capybara-Code"
api    = https://api.github.com/repos/nevrixo/Capybara-Code/releases?per_page=20
html   = https://github.com/nevrixo/Capybara-Code/releases
```

사용하지 않는 것:

- `GET /releases/latest` — prerelease 누락
- npm registry를 버전 진실로 사용 — GitHub 태그보다 먼저 또는 늦게 갈 수 있음
- git tags API — 아티팩트 없는 태그를 제안할 수 있음
- `GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_PAT` — 사용자 토큰을 업데이트 확인에 실어 보내지 않는다. 공지 저장소는 인증 없는 읽기로 충분하다

### 6.2 릴리스 선택

1. `draft == true`인 릴리스는 버린다.
2. 태그에서 버전을 읽는다. `v` 접두만 허용 (`v0.1.1-alpha.8` → `0.1.1-alpha.8`). 다른 태그 형태는 무시.
3. 후보마다 런타임 `update.verify`를 **version-compare 모드**로 호출한다 (`currentVersion`, `candidateVersion`). `updateAvailable == true`인 것만 남긴다.
4. 남은 것 중 **가장 새 하나**만 제안한다. 여러 개를 나열하지 않는다.
5. 현재 버전이 이미 그 후보면 프롬프트 없음.

`cbc_update::is_newer` 정책 (이미 구현됨, 재사용):

- 안정 설치본에는 안정 업데이트만 제안한다.
- 프리릴리스 설치본(`0.1.1-alpha.7`)에는 더 새 프리릴리스와, 더 새다면 안정 릴리스를 제안한다.
- 깨진 버전 문자열은 업데이트를 절대 켜지 않는다.

이것이 Public Alpha 문제를 푼다. 채널 기본값이 `stable`이어도, 현재가 `*-alpha.*`이면 alpha.8을 볼 수 있다. `updates.channel`은 장래 제한용으로 남겨 둔다.

1차 채널 매핑:

| `updates.channel` | 1차 동작 |
|-------------------|----------|
| `stable` (기본) | 위 `is_newer` 그대로. 추가 필터 없음 |
| `beta` | 태그에 `beta`가 있거나 안정인 후보만 |
| `nightly` | 1차 미구현. `stable`과 동일하게 취급하고, 구현되면 경고 한 줄 |

### 6.3 캐시

사용자 데이터 디렉터리, 프로젝트 밖. trust store 옆.

- POSIX: `$XDG_DATA_HOME/capybara/updates.json` (기본 `~/.local/share/capybara/updates.json`)
- Windows: `%LOCALAPPDATA%/capybara-code/data/updates.json`

```json
{
  "version": 1,
  "lastCheckAt": "2026-08-27T12:00:00.000Z",
  "lastKnown": {
    "version": "0.1.1-alpha.8",
    "tag": "v0.1.1-alpha.8",
    "htmlUrl": "https://github.com/nevrixo/Capybara-Code/releases/tag/v0.1.1-alpha.8",
    "publishedAt": "2026-08-27T00:00:00.000Z"
  },
  "skippedVersions": {
    "0.1.1-alpha.8": { "decidedAt": "2026-08-27T12:01:00.000Z" }
  }
}
```

규칙:

- 알 수 없는 `version` 필드는 실패 폐쇄 → 빈 스토어. trust store와 같다.
- `skippedVersions` 키는 정규화된 semver 문자열이다. 해당 버전과 그보다 낮은 버전은 묻지 않는다. 더 높은 버전은 다시 묻는다.
- 프로젝트 트리에 이 파일을 쓰지 않는다.
- 워크스페이스 신뢰 상태가 확인 여부를 바꾸지 않는다. 업데이트 정책은 전역이다.

---

## 7. “Update now”가 하는 일

설치 수단을 먼저 감지한다. 감지에 실패하면 설치를 시도하지 않고, 릴리스 URL과 수동 명령을 보여 준 뒤 기존 버전으로 계속한다.

### 7.1 설치 수단

| 감지 | 신호 | Update now |
|------|------|------------|
| **npm global** | `process.execPath`가 node/bun이고, 패키지가 전역 npm prefix 아래 | 같은 매니저로 **정확한 버전** 설치. `npm install -g capybara-code@0.1.1-alpha.8` 또는 bun 대응. 태그 `@alpha` / `@latest`는 쓰지 않는다 |
| **standalone archive** | 컴파일된 `capy`/`capy.exe` (Bun compile) | GitHub 에셋 다운로드 → 체크섬 → stage → `update.verify` → 원자적 교체 |
| **개발 체크아웃** | `apps/cbc/src/main.ts`로 실행, 또는 `CBC_RUNTIME_BINARY`가 워크스페이스 `target/`을 가리킴 | 자가 교체 거부. GitHub 릴리스 URL만 출력 |

npm vs bun: 전역 설치에 쓴 매니저를 쓴다. 둘 다 있으면 **현재 `capy` shim을 소유한 쪽**. 섞지 말라는 README 규칙을 지킨다.

### 7.2 npm/bun 경로

1. GitHub 태그 버전 `X`를 고른다.
2. 레지스트리에서 `capybara-code@X`가 존재하고, dist-tag가 아니라 그 버전인지 확인한다.
3. 선택: GitHub 태그 `vX`와 npm `version`이 같아야 한다. 다르면 중단. **GitHub가 진실이다.** npm만 앞서 가면 설치하지 않는다.
4. 패키지 매니저를 직접 spawn한다. 셸 문자열은 쓰지 않는다.
5. 가능하면 `--ignore-scripts` 또는 동등 옵션. 네이티브 패키지는 이미 바이너리를 포함하고, 파이프라인은 postinstall 네트워크 다운로드를 금지한다.
6. 성공 후 `capy version`이 `X`를 출력해야 한다. 아니면 실패로 보고하고 기존 설치를 남긴다.

관리자 권한: 전역 설치가 EACCES/EPERM이면 실패한 명령을 그대로 보여 주고, 권한을 올려 재시도하라고 한다. 내부에서 `sudo`를 붙이지 않는다.

### 7.3 standalone 경로

에셋 이름 허용 목록 (`scripts/archive-release.ts`와 동일):

```
capybara-code-<version>-<target>.tar.gz    # darwin-*, linux-x64
capybara-code-<version>-<target>.zip       # windows-x64
SHA256SUMS.txt
```

`<target>`은 실행 중인 바이너리의 타깃과 같아야 한다 (`windows-x64` / `darwin-x64` / `darwin-arm64` / `linux-x64`). 다른 타깃 에셋은 거부한다.

순서:

1. `SHA256SUMS.txt`를 받는다.
2. 해당 타깃 아카이브만 받는다. 소스 zip/tar(`.../archive/refs/tags/...`)는 설치 에셋이 아니다. 거부한다.
3. 아카이브 SHA-256이 `SHA256SUMS.txt` 해당 줄과 일치하는지 확인한다.
4. 임시 디렉터리에 푼다. 레이스와 링크를 피하기 위해 사용자 캐시 아래 전용 stage (`$XDG_CACHE_HOME/capybara/updates/stage-<version>/`).
5. 경로 탈출(`../`, 절대 경로, 심링크가 stage 밖으로 나감)이 있으면 거부한다.
6. 스테이징된 `manifest.json` + 파일을 런타임 `update.verify`에 넘긴다. `safeToInstall != true`면 설치하지 않는다.
7. Public Alpha 서명 정책은 8.4. 체크섬 불일치는 항상 실패 폐쇄다.
8. 실행 중인 바이너리를 교체한다.
   - POSIX: 새 트리를 임시 이름으로 두고 rename. 실행 중 inode는 유지되고, 다음 실행이 새 파일을 연다.
   - Windows: 실행 중 `capy.exe`는 잠기는 경우가 많다. 옆에 `.new`로 쓰고, 짧은 helper가 종료를 기다렸다가 교체하거나, 다음 시작 때 교체한다. 1차는 “updated, restart capy” 후 종료 + 다음 시작 시 `.new` 승격으로도 충분하다.
9. 실패 시 stage를 지우고 기존 트리를 그대로 둔다.

설치 후 같은 프로세스에서 TUI를 재개하지 않는다. 교체된 바이너리와 이미 로드된 코드가 섞인다.

---

## 8. 보안

업데이트 경로는 공격자가 고른 코드를 사용자 권한으로 실행하는 것과 같다. 폴더 신뢰는 워크스페이스를 다룬다. 이 경로는 **캡피 자신**을 다룬다.

### 8.1 위협 모델 (요약)

| 위협 | 완화 |
|------|------|
| MITM이 릴리스 JSON 또는 에셋을 바꿈 | HTTPS만, 기본 TLS 검증, 호스트 허용 목록, 다운로드 후 SHA-256 |
| DNS 재바인딩 / SSRF | 호스트 허용 목록. 사용자 입력 URL 없음. OAuth와 같이 사설·링크-로컬·루프백 주소로 resolve된 연결 거부 |
| 오픈 리다이렉트로 github 밖으로 | 리다이렉트 허용 호스트만. 최대 3회. 그 외 origin은 거부 |
| GitHub HTML 릴리스 페이지를 아티팩트로 받음 | `Content-Type` + 크기 상한 + SHA-256. HTML/gzip 오탐은 체크섬에서 실패 |
| 소스 tarball을 “업데이트”로 실행 | 에셋 이름 허용 목록. `archive/refs/tags` URL 거부 |
| 릴리스 본문 markdown/HTML을 명령으로 실행 | 본문은 파싱만. 셸/평가 없음 |
| npm이 GitHub보다 먼저 가거나 하이재킹 | GitHub 태그가 진실. 버전 문자열이 일치할 때만 npm 설치 |
| 프로젝트 `config.toml`이 채널/URL을 바꿈 | `updates.*`는 이미 user-only. URL 설정 키를 만들지 않음 |
| 손상된 `updates.json`이 모든 버전을 스킵 | 알 수 없는 스키마는 빈 스토어. 스킵 키는 `is_newer(current, skipped)`로만 해석 |
| 업데이트 확인이 토큰·워크스페이스·프롬프트를 유출 | User-Agent는 `capybara-code/<version>`. 바디 없음. 환경 토큰 없음 |
| 확인이 시작을 막거나 강제 업그레이드 | 타임아웃 + 실패 개방 + 명시적 선택. 자동 설치 없음 |
| 서명 플레이스홀더 키를 “검증됨”으로 취급 | 8.4. 플레이스홀더 키만으로 `safeToInstall`을 통과시키지 않음 |
| 압축 폭탄 / 큰 JSON | JSON 상한 1MB. 에셋 상한 타깃별 합리적 값 (1차 512MB). 압축 비율 가드 |
| TOCTOU: 태그 vX를 보여 주고 다른 바이트를 설치 | 에셋 파일명, SUMS 줄, `manifest.productVersion`, 사용자가 본 버전이 모두 같아야 함 |
| 업데이트 프로세스가 워크스페이스 셸로 실행됨 | 호스트 레벨 spawn. 워크스페이스 샌드박스·에이전트 도구 경로를 타지 않음 |
| 의존성 confused deputy (`sudo npm`) | 권한 상승을 자동으로 하지 않음 |
| GitHub 계정 탈취로 악성 prerelease | 체크섬 + (키가 실제가 되면) 핀된 Ed25519. 그 전까지는 사용자 확인이 있는 명시적 옵트인. 자동 없음 |

### 8.2 네트워크 정책

`apps/cbc/src/oauth-network.ts`와 같은 하드닝을 재사용하거나 공유한다.

고정:

- `https://`만. `http://` 폴백 없음.
- 허용 호스트:
  - `api.github.com`
  - `github.com`
  - `objects.githubusercontent.com`
  - `release-assets.githubusercontent.com`
  - npm 경로만 `registry.npmjs.org`
- 그 외 호스트, IP 리터럴 URL, 사용자 정보(`https://user:pass@...`)는 거부.
- DNS 결과가 사설/루프백/링크-로컬/CGNAT이면 거부 (OAuth와 동일).
- 타임아웃: 메타데이터 1500ms (시작 경로), 다운로드 별도 더 긴 캡 (예: 120s).
- 응답 크기 상한. 스트리밍 카운터. 상한을 넘기면 중단.
- 리다이렉트: 같은 허용 목록, 최대 3. 크로스-호스트는 목록에 있을 때만.
- TLS: 시스템 트러스트. `NODE_TLS_REJECT_UNAUTHORIZED=0`을 이 클라이언트에서 무시.
- 프록시: 시스템 HTTPS 프록시는 허용하되, 최종 소켓이 허용 호스트로 가는지는 그대로 검사.

시작 시 업데이트 확인은 **워크스페이스 `permissions.network`를 쓰지 않는다.** 그 축은 에이전트 도구용이다. 이 확인은 사용자 전역이며 폴더 신뢰 전에 일어날 수 있다. 끄는 스위치는 `updates.check`와 `CBC_NO_UPDATE_CHECK`다.

### 8.3 페이로드 검증

GitHub 릴리스 JSON:

- 객체의 배열이어야 한다.
- 쓰는 필드만: `tag_name`, `draft`, `prerelease`, `html_url`, `published_at`, `assets[].name`, `assets[].size`, `assets[].browser_download_url`, `assets[].content_type`.
- `browser_download_url` 호스트가 허용 목록에 있어야 한다. 에셋 URL을 그대로 신뢰하지 않는다.
- `body` / 작성자 / 업로더 계정은 실행에 쓰지 않는다.

`SHA256SUMS.txt`:

- 텍스트, 줄 형식 `^[0-9a-f]{64}  [A-Za-z0-9._-]+$`.
- 상대 파일명만. `/`, `\\`, `..` 거부.
- 우리가 받을 에셋이 목록에 있어야 한다.

### 8.4 서명 정책 (Public Alpha)

사실:

- `cbc-update`는 Ed25519 검증을 구현한다.
- 릴리스 매니페스트는 아직 `signature.signed = false`다.
- 핀된 공개키는 플레이스홀더이며 소스에 TODO가 있다.

1차 정책:

1. SHA-256 (`SHA256SUMS.txt` + 매니페스트 파일 해시)은 **필수**. 불일치면 설치하지 않는다.
2. `requireSignature`는 키가 플레이스홀더인 동안 프로덕션 설치를 통과시키는 데 쓰지 않는다. 플레이스홀더 키로 서명된 매니페스트는 **InvalidSignature**와 같다.
3. 매니페스트가 아직 미서명이고 체크섬이 맞으면, 프롬프트에 이미 동의한 사용자에 한해 설치를 허용한다. UI에 “checksum verified, not yet signed”를 보여 준다.
4. 실제 릴리스 키를 핀하는 순간 (별도 작업) 정책은 **서명 필수**로 올라간다. 미서명은 그때 실패 폐쇄.
5. 검증 우회 플래그, 설정 키, 환경 변수를 추가하지 않는다.

즉 1차 안전장치는 **명시적 동의 + GitHub 고정 + SHA-256**이다. 서명은 구현되어 있으나, 키 세리머니 전에는 진실로 취급하지 않는다.

### 8.5 실행 경계

- 받은 아카이브에서 스크립트를 실행하지 않는다.
- `eval`, `sh -c`, `cmd /c`로 패키지 매니저를 돌리지 않는다. argv 배열만.
- 업데이트 spawn은 워크스페이스가 아니라 호스트 환경. 프로젝트 `.env`를 주입하지 않는다.
- 에이전트/서브에이전트/MCP는 이 경로를 호출할 수 없다. CLI 시작 + 명시적 `capy update`만.
- Stage 디렉터리는 사용자 캐시 소유. 모드 0700 (POSIX).

### 8.6 프라이버시

- 확인 요청에 워크스페이스 경로, 세션 id, 모델 이름, 인증 쿠키를 넣지 않는다.
- 텔레메트리 기본값은 이미 꺼져 있다. 업데이트 확인은 텔레메트리를 켜지 않는다.
- GitHub는 IP와 User-Agent를 본다. User-Agent는 `capybara-code/<version>`만.

---

## 9. 설정, 플래그, 명령

### 9.1 기존 키 (스키마 변경 없음)

```toml
[updates]
channel = "stable"       # 사용자 전용. 프로젝트 오버라이드 불가
check = true
interval_hours = 24
```

1차에 새 설정 키를 추가하지 않는다. `auto = true` 같은 키는 명시적으로 거부한다.

### 9.2 환경 변수

| 변수 | 동작 |
|------|------|
| `CBC_NO_UPDATE_CHECK` | 비어 있지 않으면 확인 비활성 (기존) |
| `CI`, `GITHUB_ACTIONS` | 확인 생략 |
| `CAPYBARA_DATA_DIR` 등 | 기존 경로 해석. `updates.json`이 따라감 |

업데이트 URL 오버라이드 변수는 만들지 않는다.

### 9.3 CLI (권장, 프롬프트와 같은 PR에 넣을 수 있음)

```
capy update              # 확인하고, 있으면 같은 박스. 대화형만
capy update --check      # 종료 코드로만 보고. 설치 없음
                         # 0 = 최신, 2 = 업데이트 있음, 1 = 오류
capy version             # 현재 유지. 업데이트 확인 없음
```

`capy update`는 비 TTY에서 설치하지 않는다. `--check`는 스크립트용이다.

---

## 10. 기존 배너는 어떻게 되나

차단 프롬프트가 1차다. `renderUpdateBanner`는 폴백으로 남긴다.

- 확인이 1500ms를 넘겼고, 이후에 새 버전이 확인되면 TUI 배너를 띄운다.
- 비 TTY 대화형은 없지만, 향후 호스트가 paint 후 배너를 쓸 수 있다.
- 배너 카피를 바꿔 차단 프롬프트와 모순되지 않게 한다: “New version X. Restart capy to be asked, or update with the package manager used to install Capybara Code.”
- 배너는 설치하지 않는다.

---

## 11. 구현 계획 (코드는 이 문서에서 하지 않음)

권장 순서. 각 단계는 단독으로 리뷰 가능하다.

### PR 1 — 발견 + 스킵 저장소 + 프롬프트

- `apps/cbc/src/update-check.ts` (가칭): GitHub 목록, 캐시, 스킵, 타임아웃
- `apps/cbc/src/workspace-trust.ts`와 같은 박스 UI
- `interactive.ts`에서 `ensureTrust` 다음, `ui.open` 전에 호출
- 런타임 `update.verify` version-compare 재사용
- 네트워크 하드닝 (공유 또는 OAuth 헬퍼 복제)
- 단위 테스트: 픽스처 JSON, 타임아웃 실패 개방, 스킵 지속성, prerelease `is_newer`, `/releases/latest` 미사용
- 이 단계의 “Update now”는 아직 설치하지 않는다. 검증된 수동 명령을 출력하고 종료한다:

  `npm install -g capybara-code@<exact>` 또는 릴리스 URL

이 단계 단독으로 사용자 요청을 충족한다: **새 버전이 있으면 업데이트하거나 건너뛴다.**

### PR 2 — 검증된 standalone 설치

- 허용된 에셋 다운로드
- `SHA256SUMS.txt` + `update.verify`
- 원자적 교체 + Windows `.new` 승격
- 경로 탈출·크기·타깃 불일치 테스트

### PR 3 — npm/bun 정확 버전 설치

- 매니저 감지
- GitHub 태그와 npm 버전 일치
- argv spawn, 셸 없음
- 권한 실패 시 명령을 보여 줌

### PR 4 — 폴백 배너 연결

- 늦은 확인 결과를 `updateVersion`에 연결
- 배너 카피 수정
- 기존 tui 테스트 갱신

서명 키 교체는 이 기능 열차에 넣지 않는다. 키가 실제가 되면 `cbc-update` 정책만 올리면 된다.

---

## 12. 수용 기준

1. 대화형 TTY `capy`에서, 스킵하지 않은 더 새 GitHub Release가 타임아웃 안에 보이면, TUI 전에 신뢰 스타일 박스가 뜬다. 선택지는 **Update now**와 **Skip this version**이다.
2. **Skip this version** 후 같은 버전은 다시 묻지 않는다. 더 새 버전은 묻는다.
3. Esc는 TUI로 계속 진행하고, 그 버전을 영구 스킵하지 않는다.
4. GitHub가 타임아웃·429·잘못된 JSON을 반환하면 `capy`는 프롬프트 없이 기존처럼 시작된다. 종료 코드는 성공이다.
5. `CBC_NO_UPDATE_CHECK=1`, `updates.check = false`, `capy run`, CI는 네트워크 확인을 하지 않는다.
6. 확인은 `https://api.github.com/repos/nevrixo/Capybara-Code/releases`만 사용한다. `/releases/latest`는 쓰지 않는다.
7. 호스트·URL·채널을 바꾸는 설정 키는 없다. 프로젝트 config는 `updates.*`를 설정하지 못한다 (이미 강제됨).
8. 환경의 GitHub 토큰을 업데이트 요청에 붙이지 않는다.
9. 설치를 구현하는 경우 (PR 2/3): 체크섬 불일치는 바이트를 설치하지 않는다. 소스 tarball은 설치하지 않는다. 잘못된 타깃 아카이브는 설치하지 않는다.
10. 개발 체크아웃 실행은 설치된 `capy`를 자가 교체하지 않는다.
11. 폴더 신뢰 프롬프트는 동작·카피·순서가 그대로다. 업데이트 박스는 그 다음이다.
12. Public Alpha (`0.1.1-alpha.7` → `0.1.1-alpha.8`)가 제안된다. 안정 `1.0.0`에 `1.0.1-alpha.1`은 제안되지 않는다 (`is_newer`).

---

## 13. 테스트 계획

픽스처 기반. 구현 시 실 GitHub에 의존하지 않는다.

- 더 새 prerelease → 프롬프트
- 같은 버전 → 프롬프트 없음
- 더 낮은 버전 → 프롬프트 없음
- 안정 현재 + prerelease 후보 → 프롬프트 없음
- draft 릴리스 → 무시
- 스킵한 버전 → 프롬프트 없음
- 스킵한 버전보다 새 버전 → 프롬프트
- `lastKnown`가 새것이고 `lastCheckAt`이 신선함 → 네트워크 없이 프롬프트
- 타임아웃 → 실패 개방
- 리다이렉트 허용 목록 밖 → 거부
- `SHA256SUMS` 불일치 → 설치 없음
- 에셋 이름에 `..` → 거부
- 소스 아카이브 URL → 거부
- npm 버전이 GitHub 태그와 다름 → 설치 없음
- `CBC_NO_UPDATE_CHECK` → fetch 없음
- 손상된 `updates.json` → 빈 스토어, 충돌 없음
- 신뢰 프롬프트 골든 경로가 여전히 통과

---

## 14. 주요 결정

1. **GitHub Releases가 진실이다.** npm은 설치 수단이다.
2. **목록 엔드포인트, latest 아님.** Alpha prerelease를 보기 위함이다.
3. **폴더 신뢰와 같은 차단 박스.** 배너는 늦은 확인 폴백이다.
4. **Skip은 이 버전을 유지한다.** Esc는 이번 실행만.
5. **자동 업데이트 없음.** 키도 없다.
6. **실패 개방, 타임아웃 1500ms.** 시작 품질(AC-04)을 지킨다.
7. **검증은 Rust `cbc-update`에 남긴다.** 호스트는 받고 묻는다.
8. **1차 SHA-256 + 명시적 동의.** 플레이스홀더 Ed25519 키를 신뢰하지 않는다.
9. **업데이트 URL을 설정할 수 없다.** 호스트 허용 목록은 코드에 핀한다.
10. **설치 후 프로세스 종료.** 섞인 코드로 TUI를 계속하지 않는다.

---

## 15. 열린 이슈 (구현 전 확인하면 좋은 것)

아래는 권장 기본값이 있다. 구현 전에 번복하지 않으면 기본값을 따른다.

| # | 질문 | 권장 기본 |
|---|------|-----------|
| Q1 | “Update now” 1차 범위 | **PR 1: 명령/URL을 출력하고 종료.** 자가 설치는 PR 2/3 |
| Q2 | 개발 체크아웃에서 알림 | **1차는 생략** (자가 교체 사고 방지) |
| Q3 | 프롬프트 언어 | 신뢰 박스와 같이 영어 1차, 로케일 인프라가 있으면 한국어 카피 |
| Q4 | 설치 성공 후 자동 재실행 | **아니오.** 사용자가 `capy`를 다시 실행 |
| Q5 | `updates.channel = nightly` | 1차는 stable과 동일 + 추후를 위한 무시 |

---

## 16. 참고 경로

- 신뢰 UX: `apps/cbc/src/workspace-trust.ts`
- 대화형 순서: `apps/cbc/src/commands/interactive.ts`
- 버전 상수: `apps/cbc/src/main.ts` `CBC_VERSION`
- 검증: `crates/cbc-update/src/lib.rs`
- RPC: `crates/cbc-runtime/src/handlers/update.rs`
- 설정: `packages/config-schema/src/schema.ts` `UpdatesConfig`
- 릴리스: `.github/workflows/release.yml`
- 에셋 이름: `scripts/archive-release.ts` `archiveNameFor`
- 저장소: https://github.com/nevrixo/Capybara-Code
- npm: https://www.npmjs.com/package/capybara-code
