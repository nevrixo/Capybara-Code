# `fixtures/`

Test data referenced by PRD §25. Each directory serves a specific section, and the
point of keeping them here rather than inline in tests is that several of them are
consumed by more than one language or more than one test type.

```text
fixtures/
├─ provider-events/       §25.6 provider contract tests, and CBC_MOCK_PROVIDER scripts
├─ tui-golden/            §25.8 golden TUI expectations
├─ malicious-workspaces/  §25.15 security regressions and §25.10 filesystem tests
├─ process-trees/         §25.9 PTY and cancellation tests
└─ mcp-servers/           §25.13 MCP client tests
```

## `provider-events/`

Two shapes live here:

- **Raw SSE frames** (`*.sse.jsonl`) — one JSON frame per line, exactly as the OpenAI
  Responses API emits them. §25.6 requires the stream parser to be tested against
  recorded frames rather than a hand-built object graph, because the interesting bugs
  are in assembly (interleaved deltas, duplicate events, mid-stream errors).
- **Scripted turns** (`*.script.json`) — `MockProvider` input. `CBC_MOCK_PROVIDER`
  points at one of these to drive a real `cbc run` with no network, which is what makes
  AC-47 and §26's evals possible.

## `tui-golden/`

§25.8 asks for golden tests that assert *semantic cells* rather than colour bytes, so
that a palette change does not churn every expectation. Each fixture holds an input
view model and the expected plain rendering.

## `malicious-workspaces/`

Inputs for §24.4's threats: path traversal, symlink escape, terminal escape injection,
prompt injection in project instructions, and secret-shaped content. Each directory has
a `manifest.json` describing what the workspace contains and which invariant must hold —
the assertion is the point, and without it a fixture is just a strange repository.

These are **inert data**. Nothing here is executed; the files exist to be *rejected*.

## `process-trees/`

Shell scripts that spawn grandchildren, so §25.9 can verify RT-001: cancelling a job
kills the whole tree, not just the direct child. Written POSIX-portable, with a
`.cmd` twin where Windows needs one.

## `mcp-servers/`

Minimal MCP servers and recorded exchanges for §25.13: a stdio server, a Streamable
HTTP transcript for each protocol era, and a deliberately hostile server whose output
contains terminal escapes and injected instructions (AC-33).
