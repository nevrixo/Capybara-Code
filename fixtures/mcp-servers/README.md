# `mcp-servers/`

Fixtures for §25.13. Three things live here: two runnable stdio servers, recorded HTTP
exchanges for each protocol era, and a hostile server whose output must be neutralised.

| Fixture | Kind | Covers |
|---|---|---|
| `echo-stdio.ts` | runnable stdio server | AC-29, catalog build, `mcp doctor` |
| `hostile-stdio.ts` | runnable stdio server | AC-33, §17.12, refused server requests |
| `modern-http.jsonl` | recorded exchange | AC-30, revision `2026-07-28` |
| `legacy-http.jsonl` | recorded exchange | AC-31, revision `2025-11-25` |
| `unknown-revision.jsonl` | recorded exchange | §17.2 fail-closed negotiation |

## Running a stdio fixture

```bash
bun run fixtures/mcp-servers/echo-stdio.ts
```

Both servers speak newline-delimited JSON-RPC on stdio, which is what §17.3 specifies.
They are deliberately dependency-free so a test can spawn them without an install step.

## Why `hostile-stdio.ts` is a fixture and not a test helper

It exercises four separate defences that are easy to get individually right and
collectively wrong:

1. **Terminal escapes in tool output** — must be stripped before display (AC-33).
2. **Injected instructions in tool output** — must arrive wrapped as untrusted data, so
   the model can tell data from policy (§T5).
3. **Server-initiated `sampling/createMessage`** — must be refused, not proxied. §17.4
   makes CBC the client; a server that can ask CBC to sample has inverted the
   relationship.
4. **A `readOnlyHint: true` annotation on a destructive-sounding tool** — §17.8 treats
   the annotation as a hint only, so the resolved risk must be promoted anyway.

Defence 4 is the one worth watching. It is the difference between trusting a server's
self-description and treating it as a claim.

## Recorded exchanges

Each `.jsonl` file is one JSON object per line, alternating direction:

```json
{"dir":"out","body":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}}
{"dir":"in","body":{"jsonrpc":"2.0","id":1,"result":{}}}
```

`dir` is from CBC's point of view: `out` is what the client sent, `in` is what the server
replied. Recording both directions means a test can assert on the request CBC *makes*,
not only on how it handles a reply — which is where the protocol-version header and the
capability declaration live.
