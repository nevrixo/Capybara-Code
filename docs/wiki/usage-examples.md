# 사용 예시

이 페이지는 시나리오 중심입니다. 각 절은 하나의 완결된 워크플로를 실제 명령·실제 슬래시 명령·실제 플래그로 따라갑니다. 개별 플래그의 정의는 [CLI 레퍼런스](cli-reference.md), 키 바인딩은 [터미널 UI](tui-guide.md), 설정 키는 [설정](configuration.md)에 있습니다. 여기서는 그것들을 다시 나열하지 않고 **엮어서** 씁니다.

모든 예시의 출력은 실제 렌더러가 낼 수 있는 최소 형태로만 적었습니다.

## 1. 새 워크스페이스에서 첫 세션

처음 여는 저장소입니다.

```bash
cd ~/work/payments-api
capy
```

신뢰 박스가 먼저 나옵니다. 워크스페이스를 읽는 어떤 코드보다 앞섭니다.

```text
1. Yes, proceed
2. Always trust this path
3. Open read-only
4. No, exit
```

앞으로 계속 작업할 저장소이므로 `2`를 선택합니다. 이 선택만이 신뢰 결정과 프로젝트 제어 스냅샷을 디스크에 남깁니다 — `1`(trusted-once)은 **의도적으로 저장하지 않습니다**.

TUI가 열리면 먼저 상태를 확인합니다.

```text
/status
```

그다음 코드를 만지기 전에 계획만 세우고 싶다면 `Shift+Tab`으로 Plan 모드로 갑니다. 슬래시로도 같은 전환이 됩니다.

```text
/mode plan
```

Plan 모드에서 이 세션에서만 쓰고 싶다면 인자 없이, 기본값으로 굳히려면 `--save`를 붙입니다. 대기 중인 승인이나 열린 트랜잭션이 있으면 전환이 그것들이 끝날 때까지 기다리는데, 기다리지 않고 끊으려면 `--stop-active`를 씁니다.

```text
/mode plan --stop-active
```

계획이 끝나면 Build로 돌아옵니다.

```text
/mode build
```

> `/mode`의 `build|plan` 값과 `--save`·`--stop-active` 토큰은 `apps/cbc/src/slash.ts:104-114`에서 파싱됩니다. 슬래시 명령표 자체는 `packages/tui-components/src/overlays.ts:107-149`이며, `/mode` 항목은 `:122`입니다. 신뢰 선택지 4개와 저장 규칙은 [권한과 신뢰](permissions-and-trust.md)를 참고하십시오.

## 2. 한 줄 질문을 CI에서 돌리기

대화 없이 한 번만 실행하려면 `run`입니다.

```bash
capy run "src/ 아래에서 사용되지 않는 export를 찾아 목록만 알려줘"
```

`run`은 구조적으로 비대화식이고, 신뢰 프롬프트도 띄우지 않습니다. 신뢰되지 않은 워크스페이스는 경고와 함께 `read-only`로 조용히 격하되므로 위와 같은 **분석**은 그대로 진행됩니다.

CI에서는 사람이 읽는 출력 대신 기계 판독 결과를 파일로 받습니다.

```bash
capy run "테스트를 실행하고 실패만 요약해줘" \
  --result-file /tmp/capy-result.json \
  --permission-policy fail-on-ask
echo "exit=$?"
```

`--result-file`은 한 줄 JSON을 모드 `0o600`으로 원자적으로 씁니다. 저널 JSONL은 `CBC_RUN_JOURNAL_PATH`가 없으면 `<resultFile>.journal.jsonl`로 함께 나옵니다.

```bash
jq -r '.status, .exitCode, (.tests | "\(.passed)/\(.failed)/\(.notRun)")' /tmp/capy-result.json
```

```text
completed
0
128/0/3
```

정책 선택이 CI 동작을 가릅니다.

| 값 | CI에서의 의미 |
| --- | --- |
| `deny-on-ask` (기본) | 승인이 필요한 동작만 조용히 거부하고 턴은 계속 |
| `allow-listed` | 사전 규칙에 맞는 것만 허용, 규칙 미일치는 거부 |
| `fail-on-ask` | 승인이 필요해지는 순간 종료 코드 4로 즉시 종료 |

파이프라인이 "승인이 필요했다"를 조용히 넘기지 않고 **실패로 보고**해야 한다면 `fail-on-ask`입니다. 종료 코드 4가 곧 그 신호입니다.

`run`에는 `--json`도 `--format`도 없습니다. 터미널로는 `renderChatResponse`가 한 번 출력되고, 구조화 출력은 `--result-file` 하나뿐입니다.

> 플래그 정의는 `apps/cbc/src/command-spec.ts:39-48`, 세 정책 값의 검증은 `apps/cbc/src/args.ts:267-274`, 종료 코드 표는 `apps/cbc/src/exit.ts:10-35`입니다.

## 3. 버그 하나 고치기

가장 흔한 워크플로입니다. Build 모드에서 자연어로 시작합니다.

```text
> tests/checkout.spec.ts의 "applies coupon twice" 실패를 고쳐줘
```

에이전트는 대체로 다음 순서로 움직입니다.

1. **탐색** — `fs.glob`·`fs.search`로 후보를 좁히고 `fs.read_many`로 관련 파일을 한 번에 읽습니다.
2. **정밀 조회** — 심볼의 실제 정의와 참조가 필요하면 LSP 도구(`lsp.definition`, `lsp.references`, `lsp.diagnostics`)를 씁니다. 텍스트 그렙보다 정확합니다.
3. **편집** — `fs.apply_patch` 또는 `fs.edit`으로 고칩니다.
4. **검증** — `process.run`으로 테스트를 돌립니다.
5. **확인** — `git.diff`로 최종 변경만 다시 봅니다.

타임라인에는 도구 호출이 카드로 쌓이고, 그 아래 라이브 라인 한 줄이 현재 단계를 보여줍니다. 형식은 `글리프 [단계] > 라벨`입니다.

```text
* [RUN] > fs.read_many
```

테스트를 돌리는 동안은 `[TEST]`, 서브에이전트를 기다리는 동안은 `[WAIT]`, 승인 대기 중에는 `[AUTH]`로 바뀝니다. 끝나면 `[DONE]`이고, 중단·부분 완료·실패는 각각 `[STOP]`·`[PARTIAL]`·`[FAIL]`입니다.

쓰기와 프로세스 실행은 권한 프리셋에 따라 결정 카드로 승인을 물을 수 있습니다. 이번 세션 동안 편집을 계속 승인하는 게 번거롭다면 프리셋을 올립니다.

```text
/permissions edit
```

`read`·`edit`·`auto`·`yolo` 네 값이며, `--save`가 없으면 세션 한정입니다. 단 `yolo`는 예외로 **선택하는 즉시 저장까지 함께** 됩니다 — 전역 취향을 조용히 세션에만 묶어두지 않기 위한 설계입니다.

변경을 직접 훑고 싶으면 마지막에 diff를 요청하면 됩니다.

```text
> 지금까지의 변경을 git diff로 보여줘
```

> 이 절에 등장한 도구 id는 모두 `packages/tool-registry/src/catalog.ts`에 정의되어 있습니다: `fs.search`(`:299`), `fs.read_many`(`:223`), `fs.apply_patch`(`:799`), `fs.edit`(`:844`), `process.run`(`:934`), `git.diff`(`:1092`), `lsp.definition`(`:396`), `lsp.references`(`:464`), `lsp.diagnostics`(`:321`). `/permissions`의 네 프리셋과 `yolo`의 자동 저장은 `apps/cbc/src/slash.ts:97-103`, 라이브 라인의 단계 태그 문자열은 `packages/tui-components/src/chrome.ts:181-201`입니다. 도구별 권한 등급은 [도구](tools.md)에 있습니다.

## 4. 큰 리팩터를 위임하기

여러 파일을 동시에 손대야 하는 작업은 루트 턴이 직접 다 하기보다 서브에이전트로 나누는 편이 낫습니다. 위임은 `task.spawn`으로 일어나고, 진행 상황은 그래프 오버레이에서 봅니다.

```text
> packages/*/src의 모든 로거 호출을 새 구조화 로거로 옮겨줘. 패키지별로 나눠서 진행해줘.
```

```text
/graph
```

writer 서브에이전트는 격리된 worktree에서 작업합니다. 어떤 worktree가 살아 있는지 확인합니다.

```text
/worktree
```

루트 턴의 예산은 넉넉합니다 — 모델 스텝·도구 호출·벽시계 시간은 무제한이고, 동시 백그라운드 작업 4개, 자식 깊이 1, repair 2회, 리뷰 2회, reflection 3회입니다. 자식 깊이가 1이라는 점이 중요합니다: 서브에이전트가 다시 서브에이전트를 낳지 않습니다.

서브에이전트 쪽은 반대로 좁습니다 — 모델 스텝 16, 도구 호출 32, 벽시계 30분입니다. 위임 단위를 "패키지 하나"처럼 잘라 달라고 지시하는 편이 실제로 유리합니다.

같은 실패 서명이 3번 반복되면 예산이 남아 있어도 턴이 `partial`로 멈춥니다. `capy run`으로 돌렸다면 종료 코드 8입니다.

> `task.spawn`은 `packages/tool-registry/src/catalog.ts:1392`, 상태 조회·대기·취소는 `:1484`, `:1504`, `:1548`입니다. `/graph`·`/worktree`는 오버레이 전용 명령으로 `apps/cbc/src/slash.ts:44-51`에 매핑됩니다. 예산 값은 `packages/agent-kernel/src/state.ts:273-285`(루트)과 `:287-290`(서브에이전트), 같은 실패 3회 한계는 `:271`입니다. writer worktree 격리 사전 점검은 `apps/cbc/src/subagent-bridge.ts:814`입니다. 위임 정책 전체는 [서브에이전트와 그래프](subagents-and-graph.md)를 참고하십시오.

## 5. 세션을 이어서 하기

어제 하던 작업으로 돌아갑니다. 인자 없이 부르면 세션 목록 오버레이가 열립니다.

```text
/resume
```

세션 id를 이미 알고 있으면 바로 지정합니다.

```text
/resume 01JD8Q2F7K
```

깨끗하게 새로 시작하려면 `/new`입니다.

컨텍스트가 차오르면 예산을 먼저 확인하십시오.

```text
/context
```

수동으로 줄이려면 압축을 직접 호출합니다.

```text
/compact
```

`/compact`가 모델에게 전달되지 않고 **로컬 라우터가 처리**한다는 점이 설계상 중요합니다. 모델이 이 줄을 산문으로 봤다면 호스트가 압축하는 대신 모델이 압축에 대해 대답해 버립니다. 슬래시 명령은 전부 이렇게 처리됩니다.

세션을 넘어 남는 기억은 별도 명령입니다.

```text
/memory inspect
/memory forget stale-api-shape
```

> `/resume`의 인자 유무 분기는 `apps/cbc/src/slash.ts:132-135`, `/compact`는 `:128`, `/memory`의 `inspect|forget|resolve`는 `:117-127`입니다. 슬래시 명령이 모델로 가지 않는 이유는 같은 파일 머리말(`apps/cbc/src/slash.ts:1-12`)에 적혀 있습니다. 기억 도구는 `packages/tool-registry/src/catalog.ts:723`(`memory.search`)·`:756`(`memory.remember`)입니다. 압축 시점의 규칙은 [에이전트와 컨텍스트](agent-and-context.md)에 있습니다.

## 6. MCP 서버와 LSP 도구 활용

MCP 서버를 붙인 뒤 건강 상태를 먼저 봅니다.

```text
/mcp
```

연결된 서버의 도구는 모델이 직접 부르지 않고 브리지 도구를 통해 씁니다 — 먼저 `mcp.search`로 무엇이 있는지 찾고, `mcp.call`로 호출하고, 리소스는 `mcp.read_resource`로 읽습니다.

```text
> 사내 MCP 서버에서 이 서비스의 최근 배포 이력을 가져와줘
```

LSP도 같은 구조입니다. 저장소를 이해할 때 그렙 대신 심볼 단위로 묻습니다.

```text
> resolvePricing 심볼의 정의와 모든 호출 지점을 정리해줘
```

이때 `lsp.workspace_symbols` → `lsp.definition` → `lsp.references` 순서로 호출됩니다. 이름 변경처럼 파일을 건드리는 동작도 미리보기 도구가 따로 있어 (`lsp.rename_preview`, `lsp.format_preview`, `lsp.code_action_preview`) 먼저 결과를 확인한 뒤 편집으로 넘어갑니다.

```text
> resolvePricing을 resolveUnitPricing으로 바꾸는 rename 미리보기를 보여줘
```

> `mcp.search`·`mcp.call`·`mcp.read_resource`는 `packages/tool-registry/src/catalog.ts:1611`, `:1624`, `:1644`입니다. `lsp.workspace_symbols`는 `:369`, `lsp.rename_preview`는 `:695`, `lsp.code_action_preview`는 `:609`, `lsp.format_preview`는 `:637`입니다. 서버 설정과 브리지 구조는 [MCP와 LSP](mcp-and-lsp.md)를 참고하십시오.

## 7. 스킬 작성 후 호출

스킬을 하나 만들고 나면 먼저 CLI로 검증합니다. 이 명령들은 런타임을 띄우지 않습니다.

```bash
capy skills validate .capybara/skills/release-notes/SKILL.md --strict
capy skills list --json
capy skills doctor --json
```

`validate`의 위치 인자는 디렉터리가 아니라 **`SKILL.md` 파일 하나**입니다. `--strict`는 경고도 실패로 취급하므로 CI에 넣기 좋습니다. `doctor`는 탐색 루트와 각 후보가 거부된 이유를 보여주므로 "스킬이 안 잡힌다" 상황의 첫 단서입니다.

TUI에서는 오버레이로 확인하고 그 자리에서 다시 읽어들일 수 있습니다.

```text
/skills
```

세션 중에는 모델이 `skill.search`로 후보를 찾고 `skill.load`로 본문을 읽어옵니다. 즉 스킬은 시스템 프롬프트에 미리 다 밀어넣는 것이 아니라 **필요할 때 로드**됩니다.

```text
> release-notes 스킬을 써서 v0.2.0 릴리스 노트 초안을 만들어줘
```

> `capy skills list|doctor|validate`와 `--json`·`--strict`는 `apps/cbc/src/command-spec.ts:244-267`에 정의되어 있습니다. `/skills` 오버레이 항목은 `packages/tui-components/src/overlays.ts:124-128`, 도구는 `packages/tool-registry/src/catalog.ts:1585`(`skill.search`)·`:1598`(`skill.load`)이며, `SKILL.md` 한 파일을 읽는 검증 동작은 `apps/cbc/src/commands/skills.ts:51-76`입니다. 프로젝트 탐색 루트 `.capybara/skills`는 `apps/cbc/src/skill-discovery.ts:231`입니다. 작성 규칙은 [스킬](skills.md)에 있습니다.

## 8. 패키지와 플러그인 설치

레지스트리에서 찾고, 검증하고, 넣습니다.

```bash
capy package search lint
capy package info @acme/lint-pack --effective
capy package verify @acme/lint-pack
capy package add @acme/lint-pack --project
capy package list --effective
```

스코프 플래그는 배타적입니다. 변경 작업은 `--project`(기본)/`--user` 중 하나, 목록 작업은 `--project`/`--user`/`--effective`(기본) 중 하나입니다. 둘 이상 주면 사용법 오류(2)입니다.

로컬에서 만든 서명 없는 패키지를 시험할 때는 명시적으로 열어줘야 합니다.

```bash
capy package add ./my-pack --allow-unsigned-local
```

권한을 요청하는 패키지는 승인 없이는 들어오지 않습니다. 비대화식에서 요청된 권한을 그대로 부여하려면 `--grant-requested`입니다.

락 파일 그대로 재현 설치를 하려면 (CI가 여기에 해당합니다):

```bash
capy bootstrap --frozen --offline
```

플러그인 쪽은 조회와 켜기/끄기입니다.

```bash
capy plugin list
capy plugin inspect acme.lint
capy plugin grants acme.lint
capy plugin disable acme.lint
```

TUI에서는 하나의 오버레이가 검색·설치·업데이트·제거·조회·활성/비활성·목록을 모두 받습니다.

```text
/plugins list
/plugins inspect acme.lint
```

문제가 생기면 진단이 먼저입니다.

```bash
capy package doctor @acme/lint-pack
```

`PackageInstallError`는 영수증을 stderr에 JSON으로 뱉고 종료 코드 1, `PackageVerificationError`는 9입니다. 검증 실패와 설치 실패를 CI에서 구분할 수 있습니다.

> 명령·플래그 정의는 `apps/cbc/src/command-spec.ts:132-240`, 스코프 배타 규칙은 `apps/cbc/src/args.ts:492-513`, 핸들러는 `apps/cbc/src/commands/packages.ts:21-225`, 오류→종료 코드 매핑은 `apps/cbc/src/router.ts:149-158`입니다. `/plugins` 오버레이의 액션 목록은 `packages/tui-components/src/overlays.ts:134-144`, 도구는 `packages/tool-registry/src/catalog.ts:1564`(`plugin.invoke`)입니다. 자세한 규칙은 [패키지와 플러그인](packages-and-plugins.md)에 있습니다.

## 9. 자동화에서 무인 실행

무인 실행의 핵심은 두 가지입니다. **승인이 필요한 지점에서 멈추지 않게 만들 것**, 그리고 **멈췄다면 조용히 지나가지 않게 할 것**.

환경 변수로 모델·추론 강도·권한 모드를 고정할 수 있습니다. 이 변수들은 설정 레이어로 매핑됩니다.

```bash
export CBC_MODEL=gpt-5.6
export CBC_REASONING_EFFORT=medium
export CBC_PERMISSION_MODE=auto
export CBC_NO_UPDATE_CHECK=1
export NO_COLOR=1

capy run "린트와 타입 검사를 돌리고 실패를 요약해줘" \
  --result-file result.json \
  --permission-policy allow-listed
```

`CI`와 `GITHUB_ACTIONS`가 설정되어 있으면 업데이트 확인은 알아서 게이팅되지만, 로컬 러너에서는 `CBC_NO_UPDATE_CHECK`를 명시하는 편이 확실합니다.

설정을 **사용자 설정 파일**에 영구 반영해야 한다면 `config set`입니다. 서브커맨드는 `set` 하나뿐입니다 — `get`·`list`·`unset`은 없습니다. `gpt-5.6`은 `gpt-5.6-sol`의 별칭이므로 그대로 써도 됩니다.

```bash
capy config set model.default gpt-5.6
capy config set permissions.preset edit
```

CI에서 신뢰 상태만 점검하려면 `--show-diff`를 반드시 붙이십시오. 없이 실행하면 대화형 터미널을 요구하며 종료 코드 4입니다.

```bash
capy trust --show-diff
```

인증 키를 넘길 때는 위치 인자로 주지 마십시오. 셸 히스토리 경고와 함께 거부됩니다.

```bash
printf '%s' "$OPENAI_API_KEY" | capy auth api --stdin
capy auth status
```

> 환경 변수→설정 매핑은 `packages/config-schema/src/schema.ts:1805-1823`, 업데이트 게이팅은 `apps/cbc/src/update-check.ts:272`, `capy config set`의 위치 인자 두 개는 `apps/cbc/src/command-spec.ts:80-91`, `permissions.preset`의 허용값은 `packages/config-schema/src/schema.ts:931`, `gpt-5.6` 별칭은 `packages/provider-openai/src/capabilities.ts:129-131`입니다. `capy trust`의 비대화식 거부는 `apps/cbc/src/commands/trust.ts:37-43`, `auth api`의 위치 인자 거부는 `apps/cbc/src/args.ts:338-343`입니다. `capy auth login`은 이 빌드에서 운영자가 제공한 등록 문서가 없으면 항상 종료 코드 3입니다 (`apps/cbc/src/commands/auth.ts:76-86`).

## 10. 에디터·외부 클라이언트에 붙이기

설치된 클라이언트 통합을 먼저 점검합니다.

```bash
capy clients list
capy clients doctor
capy integration doctor vscode
capy integration doctor acp
```

ACP를 말하는 에디터에서는 `capy acp`가 브리지가 됩니다. 이 명령은 데몬을 **필수로** 요구하므로, 붙지 못하면 종료 코드 10입니다. 데몬 상태를 따로 확인할 수 있습니다.

```bash
capy daemon status
capy daemon logs
```

GitHub 쪽 설치와 점검도 명령으로 있습니다.

```bash
capy github install
capy github doctor
capy integration doctor github
```

여러 터미널에서 같은 세션을 보려면 데몬에 붙습니다.

```bash
capy daemon attach 01JD8Q2F7K
```

> 정의는 `apps/cbc/src/command-spec.ts:93-97`(`acp`), `:98-104`(`clients`), `:106-115`(`integration doctor`), `:117-123`(`github`), `:276-288`(`daemon`)입니다. `acp`의 데몬 필수 조건은 `apps/cbc/src/commands/acp.ts:14-20`입니다. 클라이언트별 설정은 [통합](integrations.md)을 참고하십시오.

## 11. GitHub Action과 SDK로 프로그램적 사용

### GitHub Action

워크플로 파일은 직접 쓰지 않아도 됩니다. 저장소 루트에서 생성합니다.

```bash
capy github install
capy github doctor
```

`.github/workflows/capybara-code.yml`이 만들어집니다. 이미 있으면 **덮어쓰지 않고 거부**하고 `capy github doctor`를 쓰라고 안내합니다. 생성되는 워크플로의 핵심만 보면:

```yaml
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  workflow_dispatch:

jobs:
  capybara:
    if: github.event_name != 'issue_comment' || contains(github.event.comment.body, '/capy')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: nevrixo/capybara-code-action@v1
        with:
          mode: auto
          permission-policy: allow-listed
```

즉 PR 코멘트에 `/capy`를 포함시키는 것이 트리거이고, 권한 정책 기본값은 `allow-listed`입니다 — Action이 무인으로 도는 자리이므로 승인 대화가 아니라 사전 규칙으로 통제합니다.

Action의 입력은 `mode`, `permission-policy`, `event-file`, `result-file`, `capy-binary` 다섯 개이며, 내부적으로는 GitHub 이벤트를 봉투로 변환한 뒤 결국 앞에서 본 그 명령을 부릅니다.

```bash
capy run --event-file <봉투> --result-file <경로> --permission-policy <정책>
```

봉투는 모드 `0o600`으로 쓰이고 실행 후 삭제됩니다. 결과 파일 절대경로는 `result-file` 출력으로 노출되므로 후속 스텝에서 받아 쓸 수 있습니다.

`capy` 바이너리는 **절대경로이고 실제로 존재해야** 합니다. 아니면 "Capybara Action requires a verified absolute capy binary path"로 즉시 실패합니다.

> 워크플로 템플릿은 `apps/cbc/src/commands/integrations.ts:171-199`, 덮어쓰기 거부는 `:97-103`, doctor의 ready/invalid 판정은 `:153-159`입니다. Action 입력 정의는 `packages/github-action/action.yml`, CLI 호출 조립은 `packages/github-action/src/action-main.ts:31-47`, 바이너리 검증은 `:54-65`입니다.

### TypeScript SDK

`@cbc/sdk`는 App Protocol을 직접 말합니다. 최소 흐름은 연결 → 세션 → 제출 → 대기입니다.

```ts
import { CapybaraClient } from "@cbc/sdk";

const client = await CapybaraClient.connect({
  transport: "unix",
  client: { name: "my-tool", version: "1.0.0" },
});

const session = await client.createSession();
session.onApproval((request) => ({ decision: "deny", reason: `unattended: ${request.kind}` }));

const turn = await session.submit("이 저장소의 테스트를 실행해줘");
const receipt = await session.wait({ turnId: turn.turnId });

await client.close();
```

`transport`는 `"stdio" | "unix" | "pipe"` 세 값입니다. `submit`은 멱등 키가 붙은 봉투를 만들고 그것을 `lastSubmitEnvelope`에 남겨두므로, 재연결 후 같은 키로 다시 보내도 턴이 중복 실행되지 않습니다.

승인 결정은 `allow` · `allow_once` · `allow_session` · `deny` 네 값입니다. 핸들러를 등록하지 않으면 `"no approval handler registered"` 이유와 함께 **자동 거부**되므로 무인 클라이언트도 hang되지는 않습니다. 다만 왜 거부됐는지 로그에 남기려면 위처럼 명시적으로 등록하는 편이 낫습니다.

> `connect`는 `packages/sdk-typescript/src/client.ts:114-119`, `createSession`은 `:133`, `ConnectOptions`의 `transport` 값은 `:20`과 `:54-70`입니다. `submit`/`wait`는 `packages/sdk-typescript/src/session.ts:74`·`:118`, 승인 결정 네 값과 무핸들러 자동 거부는 `packages/sdk-typescript/src/approvals.ts:15-35`, 공개 표면 전체는 `packages/sdk-typescript/src/index.ts:5-49`입니다.

### Python SDK

`capybara-code` 패키지는 asyncio 기반이고 구조가 같습니다.

```python
import asyncio
from capybara_code import CapybaraClient

async def main() -> None:
    async with await CapybaraClient.connect(
        client={"name": "my-tool", "version": "1.0.0"},
    ) as client:
        session = client.session("01JD8Q2F7K")
        turn = await session.submit("이 저장소의 테스트를 실행해줘")
        await session.wait(turn.turn_id)

asyncio.run(main())
```

`path`를 생략하면 `default_socket_path()`로 로컬 데몬 소켓을 찾습니다. 프로토콜 상수는 코드에 하드코딩하지 말고 패키지에서 가져오십시오 — `PROTOCOL_VERSION`, `APP_METHODS`, `EVENT_KINDS`, `EVENT_SCHEMA_VERSION`이 모두 export되어 있습니다.

> `connect`의 인자와 소켓 기본값 처리는 `packages/sdk-python/capybara_code/client.py:179-202`, `default_socket_path`는 `:328`, `session()`은 `:243`입니다. `submit`/`wait`는 `packages/sdk-python/capybara_code/session.py:70`·`:127`이고, export 목록은 `packages/sdk-python/capybara_code/__init__.py:17-31`입니다.

## 12. 막혔을 때 처음 볼 것

세 가지 상황이 대부분입니다.

**설정 오류로 시작이 안 될 때.** 런타임을 필요로 하는 명령은 설정 검증을 먼저 통과해야 하므로, 깨진 설정은 조용한 기본값이 아니라 종료 코드 9로 드러납니다. error 심각도 이슈가 전부 나열됩니다.

**원인이 안 보일 때.** 스택 트레이스와 런타임 stderr를 켜십시오.

```bash
CBC_DEBUG=1 capy run "..." --result-file /tmp/r.json
```

**턴이 `partial`로 끝날 때.** 종료 코드 8입니다. 예산 소진이 아니라 같은 실패 3회일 수 있으므로 결과 JSON의 `status`와 `errorCategory`를 함께 보십시오. `errorCategory`는 `cli_error`·`cancelled`·`timeout`·`unhandled` 중 하나입니다.

```bash
jq -r '.status, .errorCategory, .summary' /tmp/r.json
```

> 설정 검증 실패의 종료 코드 9는 `apps/cbc/src/commands/context.ts:189-200`, `CBC_DEBUG`는 `apps/cbc/src/router.ts:166`과 `apps/cbc/src/commands/context.ts:239`, `errorCategory` 값은 `apps/cbc/src/commands/run.ts:238-244`입니다. 증상별 정리는 [문제 해결](troubleshooting.md)에 있습니다.

## 관련 문서

- [README](README.md)
- [설치](installation.md)
- [시작하기](getting-started.md)
- [기능](features.md)
- [아키텍처](architecture.md)
- [CLI 레퍼런스](cli-reference.md)
- [터미널 UI](tui-guide.md)
- [설정](configuration.md)
- [권한과 신뢰](permissions-and-trust.md)
- [도구](tools.md)
- [에이전트와 컨텍스트](agent-and-context.md)
- [서브에이전트와 그래프](subagents-and-graph.md)
- [스킬](skills.md)
- [MCP와 LSP](mcp-and-lsp.md)
- [패키지와 플러그인](packages-and-plugins.md)
- [통합](integrations.md)
- [프로바이더와 모델](provider-and-models.md)
- [Rust 런타임](rust-runtime.md)
- [문제 해결](troubleshooting.md)
- [기여하기](contributing.md)
