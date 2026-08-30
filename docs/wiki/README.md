# Capybara Code Wiki

Capybara Code(`capy`)는 GPT 계열 모델에 최적화된 터미널 코딩 에이전트이자 하네스입니다. 이 위키는 **실제 코드베이스를 근거로** 작성되었으며, 각 문서는 가능한 경우 `파일:줄` 형식으로 출처를 표기합니다.

> 현재 버전: `0.1.2-alpha.1` (Public Alpha) — `package.json:3`, `Cargo.toml:[workspace.package] version`, `apps/cbc/src/main.ts:9`
>
> 네 곳의 버전이 모두 일치해야 릴리스가 통과합니다 (`scripts/release-common.ts:99-133`).

## 문서 목록

| 문서 | 내용 |
| --- | --- |
| [설치](installation.md) | 지원 플랫폼, npm/Bun 설치, 업데이트, 아티팩트 검증 |
| [시작하기](getting-started.md) | 첫 실행, 신뢰 승인, Build/Plan 모드, 첫 턴의 흐름 |
| [주요 기능](features.md) | 이 프로젝트가 실제로 제공하는 기능 요약과 각 기능의 구현 위치 |
| [아키텍처](architecture.md) | 레이어 구성, TS/Rust 경계, 패키지 지도, 이벤트 흐름 |
| [CLI 레퍼런스](cli-reference.md) | 모든 명령어·플래그·종료 코드·환경 변수 |
| [터미널 UI](tui-guide.md) | 슬래시 명령어, 키보드 단축키, 오버레이, 렌더링 백엔드 |
| [설정](configuration.md) | 설정 파일 위치, 우선순위, 전체 키 목록과 기본값 |
| [권한과 신뢰](permissions-and-trust.md) | 권한 프리셋, 승인 흐름, 워크스페이스 신뢰, 프로젝트 상한 |
| [도구 레퍼런스](tools.md) | 66개 내장 도구, 위험 등급, 스케줄링, 편집 트랜잭션 |
| [에이전트와 컨텍스트](agent-and-context.md) | 턴 루프, 컨텍스트 컴파일러, 토큰 예산, 압축, 검증 계약 |
| [서브에이전트와 AgentGraph](subagents-and-graph.md) | 역할, 커스텀 에이전트, 예산, 그래프 내구성, 메모리 |
| [스킬](skills.md) | 스킬 탐색 경로, `SKILL.md` 형식, 진단, 내장 스킬 |
| [MCP와 LSP](mcp-and-lsp.md) | MCP 전송/도구/인증, LSP 서버 정의와 17개 브리지 도구 |
| [패키지와 플러그인](packages-and-plugins.md) | 공급망 신뢰 모델, 잠금 파일, 권한 부여, 플러그인 SDK |
| [통합](integrations.md) | VS Code, 데몬, ACP v1, App Protocol, GitHub Actions, SDK |
| [프로바이더와 모델](provider-and-models.md) | 인증 방식, 백엔드 차이, 모델 카탈로그, Fast mode, 1M 컨텍스트 |
| [Rust 런타임](rust-runtime.md) | 사이드카 프로세스 모델, 13개 crate, 샌드박스 |
| [사용 예시](usage-examples.md) | 실제 워크플로 시나리오 |
| [문제 해결](troubleshooting.md) | 오류 메시지별 원인과 대처, 진단 명령, 로그 수집 |
| [개발자 가이드](contributing.md) | 빌드·테스트·검증 게이트·릴리스 파이프라인·벤치마크 |

## 이 위키의 원칙

- **추측 금지.** 각 문서의 내용은 실제 소스 파일을 읽어 확인한 것입니다.
- **드리프트를 숨기지 않음.** 스키마에 선언되어 있으나 코드가 읽지 않는 설정 키, 문서와 구현이 어긋난 부분은 해당 문서 안에 "알려진 불일치" 항목으로 명시합니다.
- **버전 고정.** 이 위키는 `0.1.2-alpha.1` 시점의 코드를 기준으로 합니다. Public Alpha이므로 세부 값은 변경될 수 있습니다.

## 빠른 시작

```bash
# 설치
npm install -g capybara-code@alpha

# 워크스페이스에서 실행
cd my-project
capy

# 비대화식 실행
capy run "이 저장소의 테스트 구조를 설명해줘"
```

자세한 내용은 [설치](installation.md) → [시작하기](getting-started.md) 순서로 읽으십시오.
