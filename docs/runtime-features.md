# Runtime feature rollout

The modification-plan features are gated by `experimental.*` and are **on by default**. A user can set any gate to `false`. A project cannot re-enable a user-disabled gate.

| Flag | What it enables |
|---|---|
| `experimental.editEngineV2` | `fs.edit` / `fs.edit.preview`; Rust revalidates anchors |
| `experimental.fullLsp` | Supervised LSP query tools and WorkspaceEdit → EditPlan |
| `experimental.sessionDaemon` | Local daemon owns attach/detach; `--no-daemon` stays in-process |
| `experimental.durableMemory` | Evidence-backed `memory.*` plus compiler recall |
| `experimental.persistentAgentGraph` | Durable graph reducer snapshots |
| `experimental.worktreeMultiAgent` | Isolated writer worktrees and Edit Engine merge |
| `experimental.pluginRuntime` | Isolated plugin hooks; before-hooks cannot widen authority |
| `experimental.appServer` | TUI/headless submit turns through the App Protocol |

`fs.apply_patch` remains available alongside `fs.edit`. `--no-daemon` and `CBC_DAEMON=0` keep execution in-process.
Daemon mode still uses the Rust runtime as filesystem/process/Git authority. Writer subagents get a Git worktree and a dedicated `cbc-runtime` sidecar.

Schema migrations 7–13 are forward-only. An older binary refuses a newer SQLite schema.
