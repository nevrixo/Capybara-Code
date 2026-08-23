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
- Isolated Rust execution sidecar
- Transactional file mutations
- Sub-agent orchestration
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

- Windows x64
- macOS x64 and Apple Silicon (ARM64)
- Ubuntu and WSL Linux x64 with glibc

Linux ARM64 and musl-based distributions are not supported in this public alpha.

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
| Sign in | `capy auth login [--device]` |
| Authenticate with an API key | `capy auth api [--stdin]` |
| Check or end a session | `capy auth status` · `capy auth logout [--all]` |
| Refresh available models | `capy model refresh` |
| Update a setting | `capy config set <path> <value>` |
| Show help or version | `capy help [topic]` · `capy version` |

## Settings and runtime behavior

Use `/setting` in the TUI to update interactive settings, or use `capy config set <path> <value>` in scripts.

- Capybara Code creates a single global `config.toml` on first use; it does not read project-local Capybara configuration files.
- MCP and LSP service definitions stay visible in that file. Missing external executables are reported but never installed automatically.
- Root agent turns run until completion or cancellation. Sub-agent budgets and process/protocol resource limits remain in place as safety boundaries.

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
