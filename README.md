<p align="center">
  <img src="logo.png" alt="Capybara Code Logo" width="600"/>
</p>

<h1 align="center">Capybara Code</h1>

<p align="center">
  <b>High-performance AI coding agent & harness optimized for GPT models.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/capybara-code"><img src="https://img.shields.io/npm/v/capybara-code/alpha.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/Status-Public%20Alpha-orange.svg" alt="Status"></a>
  <a href="#"><img src="https://img.shields.io/badge/Runtime-Node%20%7C%20Bun%20%7C%20Rust-black.svg" alt="Runtime"></a>
</p>

---

> [!WARNING]
> **Public Alpha**: Capybara Code is currently in public alpha (`v0.1.0-alpha.1`). It is usable but under active development and not yet dependable for mission-critical production workflows.

> [!NOTE]
> **A Note from the Developer**:
> Thank you so much for visiting this repository!
> 
> Capybara Code is actively being built by a solo developer (assisted by AI coding tools). While I originally planned to polish the project further before opening it up, I decided to release an early **Public Alpha** so people who wanted to try it out could do so, and to continue developing openly with feedback.
> 
> Because this is a one-person effort, there are natural limits to how fast features and fixes can be shipped. **Issues, feedback, and pull requests are always warmly welcome!** Your support and contributions make a huge difference.

---

## Overview

Capybara Code is an AI coding agent designed to provide an optimal harness and toolset engineered specifically for GPT models.

While base model capabilities are essential, Capybara Code maximizes agent reliability, execution precision, and developer speed through harness engineering—combining a rich Terminal UI, an isolated Rust execution sidecar, transactional file mutations, sub-agent orchestration, and Model Context Protocol (MCP) integrations.

---

## Installation

Capybara Code is distributed as a standalone binary package via npm and bun.

```bash
# Using npm
npm install -g capybara-code@alpha

# Using bun
bun install -g capybara-code@alpha
```

### Supported Platforms

- Windows x64
- macOS x64 and Apple Silicon (ARM64)
- Ubuntu and WSL Linux x64 with glibc

Linux ARM64 and musl-based distributions are outside this first Public Alpha.

### Installation notes

Use one global package manager for `capy` at a time so npm and Bun do not install competing shims. `capy update` provides reinstall guidance only; it never downloads or replaces a binary automatically. GitHub Release archives include `SHA256SUMS.txt` for manual checksum verification.

Inside WSL, use native Linux `node`, `npm`, and `bun` for installation and testing. They must resolve to Linux paths rather than `/mnt/c/...` Windows executables.

---

## Quick Start

Once installed globally, launch Capybara Code in your workspace:

```bash
capy
```

## Global configuration

Capybara Code uses one global `config.toml`. It creates the file automatically on
first use, preserves an existing file, and never reads `.capybara/config.toml` or
`.capybara/config.local.toml` from a project. Print the exact platform-specific path
with:

```bash
capy config path
```

The generated file explicitly contains the Context7 MCP endpoint and the TypeScript
and Python LSP definitions. Service definitions are not hidden in code defaults, so
they can be edited, disabled, replaced, or removed. For another language, add a table
such as:

```toml
[lsp.servers.rust]
command = "rust-analyzer"
args = []
extensions = [".rs"]
language_id = "rust"
enabled = true
timeout_ms = 15000
```

Inspect and manage configured language servers with `capy lsp list`,
`capy lsp doctor [name]`, and `capy lsp enable|disable <name>`. Capybara reports a
missing executable but never installs one automatically. LSP processes start only in
a trusted Build workspace and remain read-only, bounded indexing helpers.

Root agent turns have no configurable maximum step, tool-call, or wall-time ceiling;
they continue until completion or explicit cancellation. Subagent budgets and
process/protocol resource limits remain safety boundaries.

## Developing from source

Keep the published `capy` command separate from the checked-out source tree. Register the source CLI as `capy-dev` with native Bun on each operating system where you develop:

```bash
bun install
bun run dev:link
capy-dev --version
```

Remove that development registration when needed:

```bash
bun run dev:unlink
```

On WSL, run the same commands from the Linux checkout and Linux Bun installation, not through Windows Bun or a Windows-mounted source launcher.

---

## Engineering Verification

The repository includes a versioned performance and quality program for validating harness changes without lowering model, permission, sandbox, or verification guarantees.

```bash
bun run typecheck
bun test
bun run test:rust
bun run build
```

---

## Performance program

The performance work is measured and released through a fixed, capability-bound
CBC Bench cohort. The [benchmarks/cbc-bench/README.md](benchmarks/cbc-bench/README.md)
documents commands, paired artifacts, and the statistical gate.

Design notes and release runbooks are optional documentation. They are not part
of the runtime or verification dependency graph, so they may be removed from a
checkout without changing `bun run verify` or release artifact identity.

## Contributing

We warmly welcome community feedback and contributions! As a solo-maintained project, community input is invaluable:

- **Issues & Bug Reports**: Found a bug or edge case? Open an issue with reproduction details.
- **Pull Requests**: Bug fixes, performance improvements, and documentation enhancements are greatly appreciated.
- **Feature Requests & Ideas**: Share your thoughts on harness design, tools, or workflow improvements.

---

## License

Licensed under the [Apache License 2.0](LICENSE).
