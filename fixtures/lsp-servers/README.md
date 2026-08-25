# LSP server fixtures

Minimal descriptors for three language families used by daemon/LSP host tests.

| Family | Languages | Notes |
|---|---|---|
| `web` | TypeScript / JavaScript | `typescript-language-server` style stdio |
| `systems` | Rust | `rust-analyzer` style stdio |
| `scripting` | Python | `pyright` / `pylsp` style stdio |

Fixtures in this directory are **inert**. They document capability matrices and
startup argv only; tests must spawn mocked servers rather than downloading
toolchains from the network.
