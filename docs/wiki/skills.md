# 스킬 (Agent Skills)

스킬은 `SKILL.md` 파일 하나로 표현되는 절차적 지식입니다. 시작 시에는 **메타데이터만** 프롬프트에 들어가고, 본문은 모델이 명시적으로 요청할 때만 로드됩니다.

구현: `packages/skills` (2,133줄) — `skill.ts`(파서·신뢰 규칙), `registry.ts`(레지스트리), `frontmatter.ts`(제한된 YAML), `builtin.ts`(내장 6개).

## 2단계 점진적 공개

| 단계 | 로드되는 것 | 한계 |
| --- | --- | --- |
| **1단계** (시작 시) | `SkillCatalogEntry` — `name`, `description`, `risk?`, `source`, `scope`, `origin`, `version?`, `userInvocable` | `MAX_SKILL_CATALOG_BYTES = 32 KiB` 프론트매터 접두사만 읽음 |
| **2단계** (`skill.load` 호출 시) | `SKILL.md` 전체 본문 | `MAX_SKILL_BYTES = 256 KiB` |

`frontmatter.ts:33-36`이 두 상한을 정의합니다. 1단계가 유일하게 시작 프롬프트에 들어가는 것입니다 (SKILL-001).

이유는 MCP 카탈로그와 같습니다 — 큰 카탈로그는 캐시된 프롬프트 접두사를 잡아먹습니다.

## 두 개의 도구

| 도구 | 위험 | 항상 활성 | 파라미터 |
| --- | --- | --- | --- |
| `skill.search` | R0 | ✗ | `query` (1–500자) |
| `skill.load` | R0 | ✗ | `name` (1–128자) |

정의는 `tool-registry/src/catalog.ts:1585-1609`. 둘 다 `mutates: false`, `network: false`입니다.

## 탐색 경로

`SKILL_SEARCH_ROOTS` (`skill.ts:23-32`), 가까운 것 먼저:

| 순서 | 경로 | 소스 |
| --- | --- | --- |
| 1 | `.capybara/skills` | project |
| 2 | `.opencode/skills` | project |
| 3 | `.agents/skills` | agents-dir |
| 4 | `.claude/skills` | project |
| 5 | `<resolved config>/skills` | user |
| 6 | `~/.config/opencode/skills` | user |
| 7 | `~/.agents/skills` | user |
| 8 | `~/.claude/skills` | user |
| 9 | `<bundled>` | builtin |

**가까운 프로젝트 스코프가 이기지만 소스는 UI에 계속 보입니다** — 그래서 `SkillSource`가 모든 정의에 실려 있고 해석 과정에서 사라지지 않습니다 (`:17-21`).

## 우선순위 규칙

`SkillPrecedence`는 5튜플 `[number, number, number, number, string]`입니다.

`compareSkillFiles` (`registry.ts:553`)가 앞 4개 숫자를 순서대로 비교하고, 같으면 경로 문자열로 결정합니다 — 완전한 결정적 순서입니다.

`fallbackPrecedence` (`:564`)의 랭크:

**스코프 랭크:** `project` 0 → `user` 1 → `builtin` 2

**오리진 랭크:**

| 오리진 | 랭크 |
| --- | --- |
| `explicit` | 0 |
| `capybara` | 1 |
| `opencode` | 2 |
| `agents` | 3 |
| `claude` | 4 |
| `legacy` | 5 |
| `bundled` | 9 |

패배한 정의는 사라지지 않고 `SkillShadowRecord{name, winner, shadowed, reason}`로 기록됩니다 — `reason`은 `lower precedence than <경로>`입니다 (`registry.ts:206`).

동일 `canonicalPath` 중복은 `SkillDuplicateRecord`로 별도 기록됩니다.

## 프론트매터 형식

`frontmatter.ts`는 **제한된 YAML 파서**입니다. Agent Skills 형식이 필요한 데이터 모양만 구현합니다 (`:1-8`):

지원: 스칼라, 스칼라 리스트, 문자열→문자열 메타데이터 맵 하나, literal/folded 블록 스칼라.

**거부:** YAML 태그, 앵커, 앨리어스, 병합 키, 중첩 컨테이너.

거부 이유가 명시되어 있습니다 — **탐색이 객체 생성이나 확장 표면이 되지 않게** 하기 위해서입니다.

### 알려진 필드

`KNOWN_FIELDS` (`skill.ts:146-169`) — 그 외는 오탈자가 드러나도록 **경고로 보고**됩니다.

표준 필드: `name`, `description`, `license`, `version`, `compatibility`, `metadata`, `tools`, `risk`, `model_profile`, `tags`, `user_invocable`, `allowed_paths`, `allowed-tools`

Capybara 확장: `x-capybara-requires`, `x-capybara-version`, `x-capybara-risk`, `x-capybara-model-profile`, `x-capybara-user-invocable`, `x-capybara-allowed-paths`

`x-capybara-*` 접두사 필드가 표준 필드보다 우선합니다 (`aliasedScalar`).

### 필수 필드

`name`과 `description` **둘뿐**입니다. 나머지는 정의된 기본값을 가집니다.

누락이 치명적인 이유 (`skill.ts:188-192`): 이름 없는 스킬은 호출할 수 없고, 설명 없는 스킬은 선택할 수 없습니다 — 1단계는 모델에게 그 외의 근거를 주지 않습니다.

`name` 제약: `NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 최대 64자. 컴포저에서 `$name`으로 나타날 수 있어야 하기 때문입니다.

### 버전 게이트

`compatibility`는 **정보성이며 절대 버전 게이트가 아닙니다** (`skill.ts:80-81`) — Agent Skills 환경 노트입니다.

실제 게이트는 `x-capybara-requires`(→ `requiresCapybara`)이며 유효한 버전 범위여야 합니다. 잘못된 범위는 `severity: "error"`입니다.

## 위험 등급과 상한

`SkillRisk`: `read` | `write` | `process` | `network`.

`riskCeiling(risk)` (`skill.ts:60-73`)가 CBC 위험 등급으로 매핑합니다.

| 스킬 risk | CBC 상한 |
| --- | --- |
| `read` | R0 |
| `write` | R2 |
| `process` | R3 |
| `network` | R3 |
| **미선언** | **R3** |

**선언되지 않은 risk는 안전하다고 가정되지 않습니다** — 주석이 명시합니다.

## 도구 목록은 요청이지 권한 부여가 아님

`requestedTools` (`skill.ts:88-92`):

> §16.6: "frontmatter tool list은 권한 부여가 아니라 request declaration". 이것은 호스트가 좁힐 수 있는 상한이며, 절대 부여가 아닙니다.

## 신뢰 규칙

`isProjectSource(source, scope)` (`skill.ts:50-52`)가 워크스페이스 제공(=신뢰되지 않은 콘텐츠) 여부를 판정합니다. 사용자 레벨과 번들 스킬은 운영자가 의도적으로 설치한 것입니다.

`RegistryOptions.workspaceTrusted` (`registry.ts:88-89`): **프로젝트 스킬 본문은 신뢰되지 않은 워크스페이스에서 절대 로드되지 않습니다.**

`allowEmptyBody` 옵션 (`skill.ts:180-184`)이 §13.6/AC-28을 구현합니다 — 신뢰되지 않은 프로젝트 스킬은 메타데이터만으로 **목록에 나타나므로** 비어 있는 본문이 치명적 파싱 오류가 되어서는 안 됩니다. 레지스트리는 워크스페이스가 신뢰될 때까지 본문 로드를 계속 거부합니다.

## 참조 봉쇄 (SKILL-005)

`isContainedReference(reference)` (`skill.ts:465`)가 스킬 디렉터리 탈출을 막습니다.

거부 조건:

- `/` 또는 `\`로 시작 (절대 경로)
- `A:` 형태 (드라이브 한정)
- NUL 문자 포함
- **깊이가 순간적으로라도 음수가 되는 경우** — `a/../../b`는 결과가 안쪽이어도 거부됩니다 (`:477-479`)

참조 파일 읽기 상한: `DEFAULT_MAX_REFERENCE_BYTES = 64 KiB` (`registry.ts:94`).

## 프롬프트 인젝션 탐지

`INJECTION_INDICATORS` (`skill.ts:494-523`)가 7개 패턴을 검사합니다.

| 패턴 | 노트 |
| --- | --- |
| `ignore (all) (previous\|prior\|above) instructions` | 이전 지침 무시 지시 |
| `you are now a\|an ...` | 에이전트 신원 재할당 시도 |
| `(disregard\|override) (the) (system\|safety\|permission) (prompt\|policy\|rules)` | 호스트 정책 우회 시도 |
| `(exfiltrate\|send\|upload\|post) ... (.env\|secret\|token\|credential\|api key)` | 자격 증명 전송 참조 |
| `curl ... \| sh` | 파이프-투-셸 설치 명령 |
| `rm -rf\|sudo \|chmod 777` | 파괴적/권한 상승 셸 명령 |
| `do not (tell\|inform\|show) the user` | 사용자에게 활동 숨기기 요청 |

`scanForInjection(body)`가 각 패턴의 첫 매치를 최대 120자 발췌와 함께 반환합니다.

## 스크립트 자동 실행 금지

`referencedScripts(body)` (`skill.ts:548`)가 본문에 언급된 스크립트를 찾습니다.

**§16.6: "executable scripts 자동 실행 금지". 스킬은 명령을 *서술*할 수 있지만 절대 실행을 유발하지 않습니다** (`:543-547`).

탐지 확장자: `.sh`, `.bash`, `.zsh`, `.ps1`, `.bat`, `.cmd`, `.py`, `.rb`, `.pl`.

경계 처리가 세심합니다 (`:553-557`): 선행 경계를 공백이 아니라 "경로의 일부가 될 수 없는 임의 문자"로 잡습니다 — 스킬은 거의 항상 코드 스팬이나 인용부호 안에 명령을 보여주므로, 공백을 요구하면 가장 흔한 형태인 `` `./deploy.sh` ``를 놓칩니다.

`./x.sh`와 `x.sh`는 같은 파일이므로 하나의 형태로 정규화됩니다.

## 내장 스킬 6개

`builtin.ts`. `BUILTIN_SKILL_VERSION = "1.0.0"`. **소스로 유지되므로 standalone 바이너리 안에 들어가고**, 다른 스킬과 같은 테스트를 받습니다 (`:10-12`).

| 스킬 | risk | 요청 도구 | 태그 |
| --- | --- | --- | --- |
| `code-review` | read | `git.diff`, `git.status`, `fs.read`, `fs.search` | review, diff, quality, security |
| `test-triage` | process | `fs.read`, `fs.search`, `fs.glob`, `process.run`, `git.diff` | test, failure, triage, debug |
| `repo-onboarding` | read | — | — |
| `write-agents-md` | read | — | — |
| `dependency-audit-lite` | read | — | — |
| `commit-message` | read | — | — |

`commit-message`가 **커밋 없이 메시지만 생성**하는 것은 §12.2가 `git.commit` 도구를 아예 출하하지 않기로 한 결정과 일치합니다 (`:4-7`).

내장 스킬은 소스와 버전이 보여야 하고 각각 비활성화 가능해야 합니다 (`skills.builtin.disabled`).

### 내장 스킬 본문의 품질 기준

`code-review`의 검사 순서: 정확성 → 회귀 → 보안 → 테스트 공백 → 데이터/마이그레이션. 각 발견에 심각도, 파일·줄, 무엇이 잘못되는지, 최소 수정을 요구합니다.

그리고 명확한 금지: **포매팅, 명명 취향, 코드가 하는 일의 재진술을 보고하지 말라.** 변경이 건전하면 그렇게 말하고 멈추라 — "철저해 보이려고 발견을 발명하는 리뷰는 읽는 사람에게 주는 것보다 비용이 큽니다."

`test-triage`는 "실행 전에 선택하라"로 시작합니다 — 프로젝트 자체의 러너를 매니페스트(`package.json` scripts, `Cargo.toml`, `pyproject.toml`, `Makefile`)에서 찾고 가정하지 말라고 지시합니다. 그리고 "로그가 아니라 실패를 읽어라": 테스트명·파일, 기대와 실제, raise한 줄, 원인이 변경인지 환경인지.

## CLI

```bash
capy skills list [--json]
capy skills doctor [--json]
capy skills validate <path> [--json] [--strict]
```

`skills list`와 `doctor`는 `SkillDiscoveryService`로 실제 탐색을 돌린 뒤 `renderSkillSnapshotList` / `renderSkillDoctor`로 렌더링합니다 (`apps/cbc/src/commands/skills.ts:18-48`).

신뢰 상태가 `trusted-always` 또는 `trusted-once`일 때만 `workspaceTrusted: true`가 됩니다 (`:26-28`).

`validate`는 단일 파일을 파싱하고 문제를 나열합니다. `--strict`는 경고도 실패로 취급합니다.

## TUI

`/skills [action|skill] [skill]`:

| 인자 | 동작 |
| --- | --- |
| `list` (기본) | 스킬 목록 |
| `show <name>` | 상세 |
| `reload` | 재스캔 후 `skills.changed` 발행 |
| `doctor` | 진단 |
| 알 수 없는 토큰 | 스킬명으로 취급 |

> **알려진 제약:** 컴포저의 `$skill` 완성 소스는 대화형 호스트에 배선되어 있지 않습니다 — `sources`가 `commands`, `paths`, `argumentValues`만 공급하므로 `$` 완성은 결과가 없습니다 (`interactive.ts:829-862`). `/skills`의 인자 완성은 정상적으로 스킬을 나열합니다.

## 설정 키

`config-schema/src/schema.ts:772-784`:

| 키 | 기본값 | 범위 |
| --- | --- | --- |
| `skills.enabled` | `true` | — |
| `skills.paths` | `[]` | — |
| `skills.compatOpencode` | `true` | — |
| `skills.compatAgents` | `true` | — |
| `skills.compatClaude` | `true` | — |
| `skills.legacyPaths` | `true` | 마이그레이션 앨리어스(`~/.config/capybara-code/skills`) 유지 |
| `skills.autoReload` | `false` | — |
| `skills.maxRoots` | 64 | 1–256 |
| `skills.maxCandidates` | 512 | 1–10,000 |
| `skills.maxDepth` | 8 | 0–32 |
| `skills.scanTimeoutMs` | 1,500 | 1–60,000 |
| `skills.builtin.enabled` | `true` | — |
| `skills.builtin.disabled` | `[]` | — |

`skills.paths`와 `skills.builtin.disabled`는 프로젝트 설정 제한 대상입니다 (`schema.ts:1373`) — 자세한 내용은 [설정](configuration.md)을 참고하십시오.

## 레지스트리 원자성

`SkillRegistry`는 `prepare(files)` → `replace(snapshot)` 2단계로 교체합니다. `prepare`가 파싱·중복 제거·섀도잉을 모두 계산한 `PreparedSkillRegistrySnapshot`을 만들고, `replace`가 원자적으로 스왑합니다 — 재로드 중 부분 상태가 보이지 않습니다.

`#revision`이 매 교체마다 증가하고, `#loading` 맵이 동일 스킬의 동시 본문 로드를 하나로 합칩니다.

## 관련 문서

- 도구 위험 등급 R0–R6 → [도구 레퍼런스](tools.md)
- 워크스페이스 신뢰 → [권한과 신뢰](permissions-and-trust.md)
- 패키지로 스킬 배포 → [패키지와 플러그인](packages-and-plugins.md)
- 컨텍스트 레이어 L3 → [에이전트와 컨텍스트](agent-and-context.md)
