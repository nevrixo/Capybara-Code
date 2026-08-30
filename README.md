<p align="center">
  <img src="logo.png" alt="Capybara Code logo" width="360" />
</p>

<h1 align="center">Capybara Code</h1>

<p align="center">
  An AI coding agent and harness optimized for GPT models.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/capybara-code"><img src="https://img.shields.io/npm/v/capybara-code/alpha.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="Apache 2.0 license"></a>
  <a href="#"><img src="https://img.shields.io/badge/Status-Public%20Alpha-orange.svg" alt="Public alpha"></a>
  <a href="#"><img src="https://img.shields.io/badge/Runtime-Node%20%7C%20Bun%20%7C%20Rust-black.svg" alt="Node, Bun, and Rust"></a>
</p>

> [!WARNING]
> Capybara Code is in public alpha. It is actively developed and may not yet be suitable for mission-critical production workflows.

> [!NOTE]
> This is a solo-maintained project. Issues, feedback, and pull requests are very welcome.

## What it does

Capybara Code pairs GPT models with a purpose-built coding harness to improve reliability, execution precision, and development speed.

- Terminal UI for interactive agent work
- Deep Plan questionnaires with deterministic Plan-readiness gating
- Isolated Rust execution sidecar
- Transactional file mutations
- Sub-agent orchestration
- Durable recursive AgentGraph orchestration (stable depth 2, hard maximum 3)
- First-party VS Code, ACP v1, and GitHub Actions integration surfaces
- Trust-bound project configuration and reproducible signed packages
- Model Context Protocol (MCP) integrations

## Install

Install the global `capy` command with either npm or Bun:

```bash
# npm
npm install -g capybara-code@alpha

# Bun
bun install -g capybara-code@alpha
```

### Supported platforms

- Windows 10 version 1809 or newer, x64
- macOS 13 Ventura or newer, Intel x64 and Apple Silicon (ARM64)
- Ubuntu 20.04 or newer and Ubuntu on WSL2, Linux x64 with glibc 2.31 or newer

These are release compatibility floors, not only tested build hosts. Linux artifacts are built
and smoke-tested on Ubuntu 20.04, the Rust sidecar is rejected if it requires a GLIBC symbol newer
than 2.31, macOS binaries use deployment target 13.0, and the Windows sidecar statically links the
compiler runtime. Every native release must start its packaged sidecar and complete the
`runtime.initialize` protocol handshake before publishing.

Linux ARM64, musl-based distributions, Windows ARM64, WSL1, and macOS 12 or older are not supported
in this public alpha.

### Installation notes

- Use either npm or Bun globally for `capy`, not both, so their shims do not conflict.
- Upgrade with the same package manager used for installation.
- GitHub Release archives include `SHA256SUMS.txt` for manual checksum verification.
- In WSL, install and run with native Linux `node`, `npm`, and `bun` rather than Windows executables under `/mnt/c/...`.

## Get started

Open a terminal in your workspace and run:

```bash
capy
```

You can also start with a prompt:

```bash
capy "Explain the structure of this project"
```

## Common commands

| Task | Command |
| --- | --- |
| Start the interactive UI | `capy` |
| Start with a prompt | `capy [prompt...]` |
| Run non-interactively | `capy run [prompt...]` |
| Serve ACP v1 over stdio | `capy acp` |
| Inspect client/replay health | `capy clients doctor` |
| Diagnose integrations | `capy integration doctor [vscode\|acp\|github]` |
| Install or diagnose GitHub automation | `capy github install` · `capy github doctor` |
| Inspect or approve project trust | `capy trust --show-diff` · `capy trust` |
| Sign in | `capy auth login [--device]` |
| Authenticate with an API key | `capy auth api [--stdin]` |
| Check or end a session | `capy auth status` · `capy auth logout [--all]` |
| Refresh available models | `capy model refresh` |
| Update a setting | `capy config set <path> <value>` |
| Show help or version | `capy help [topic]` · `capy version` |

## Settings and runtime behavior

Use `/setting` in the TUI to update interactive settings, or use `capy config set <path> <value>` in scripts.

- `Fast mode` toggles OpenAI Fast mode (`provider.openai.serviceTier`): priority processing at up to ~2.5x speed for a per-token premium. It is only honored by the API backend and stays off by default.
- `1M context` toggles the premium context-band policy (`model.context.premiumBandPolicy`): off keeps bands utility-gated at the 272k pricing boundary; on admits bands up to the model's 1M window. Input above 272K is billed at premium rates for the whole request.
- Deep Plan toggles agent.deepPlan for the next Plan message. When enabled, repository-backed investigation can open one tabbed batch of 1–4 material product decisions, retain drafts across daemon detach/resume, and withhold an early final until the structured Plan Contract reflects the answers. It stays off by default and never runs in Build mode.

- Capybara Code creates a global `config.toml` on first use. A trusted workspace
  may add `.capybara/config.toml` and a git-ignored
  `.capybara/config.local.toml`; project values remain below environment/CLI
  precedence and cannot weaken user security or supply-chain policy.
- MCP and LSP service definitions stay visible in that file. Missing external executables are reported but never installed automatically.
- Root agent turns run until completion or cancellation. Children may delegate
  through a session-scoped facade to depth 2 by default (experimental maximum 3).
  Node/fan-out/tool/time/cost budgets, monotonic child permissions, root-owned
  approvals, subtree cancellation, and worktree-required writers remain hard
  safety boundaries.
- App Protocol initialization publishes a digest-bound capability snapshot.
  Methods that exist in the schema but are not connected in the active backend
  report `unsupported`; observer-only mutations report `read-only`.
- Final responses are chat-first by default. Verified file changes and checks remain available as collapsed evidence; failures, permission blocks, and security-sensitive findings expand automatically.
- `partial` is a machine status, not a failure label: the UI classifies it as success, attention, blocked, or failure based on the recorded evidence. Exit codes and `CompletionReport` remain compatible.
- Local context compaction uses the next compiled request's projected pressure. It performs lossless output externalization before semantic compaction, preserves TODO/evidence capsules, and allows at most one recompile per provider sample. The original journal is never deleted.

Example global settings:

```toml
[ui.final_answer]
style = "chat"             # chat | report
evidence = "collapsed"     # hidden | collapsed | expanded
attention_details = true

[model.context]
compaction_policy = "adaptive"  # off | legacy | adaptive
provider_compaction_mode = "auto" # off | auto | on
emergency_ratio = 0.90

[agent]
deep_plan = "off"          # off | on
```

Use `/compact` for an explicit compaction. It reports before/after usage and the preserved TODO/evidence counts.

See [Deep Plan](docs/deep-plan.md) for questionnaire controls, pause/resume
semantics, headless behavior, and the completion gate.

## Packages and plugins

Project requests live in <code>.capybara/packages.json</code>; exact versions,
digests, signatures, contents, and grants live in
<code>.capybara/packages.lock.json</code>. A frozen bootstrap refuses drift and
re-verifies immutable cached bytes before activation.

~~~bash
capy package init packages/example
capy package add path:packages/example --project --allow-unsigned-local
capy package doctor
capy bootstrap --frozen --offline
~~~

Unsigned local packages require an explicit flag. Package authority is empty by
default; <code>--grant-requested</code> is explicit consent after reviewing the
requested-versus-granted preview. In the TUI, <code>/plugins</code> supports
search, install, update, remove, inspect, enable, disable, grants, and list.

See [Package ecosystem and registry operations](docs/package-ecosystem.md) for
the trust model, signed registry configuration, CI behavior, App methods, and
key rotation/revocation procedure.

## Verification

If you are contributing to the repository, run the verification suite before submitting changes:

```bash
bun run typecheck
bun test
bun run test:rust
bun run build
```

## Benchmarks

Performance work is measured through the capability-bound CBC Bench cohort. See the [CBC Bench guide](benchmarks/cbc-bench/README.md) for commands, artifacts, and the statistical release gate.

## Contributing

Contributions are welcome. Please open an issue for bugs or feature ideas, and submit pull requests for fixes, performance improvements, or documentation updates.

## License

Licensed under the [Apache License 2.0](LICENSE).
