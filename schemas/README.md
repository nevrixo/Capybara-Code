# `schemas/`

PRD §20.11 makes this directory the source of truth for the protocol, the domain
events, the configuration surface, and the tool contract.

```text
schemas/
├─ protocol/   runtime RPC framing, methods, limits, handshake  (§20.1–§20.5)
├─ events/     the domain event envelope and its kinds           (§20.6–§20.7)
├─ config/     the configuration surface                          (§21.4)
├─ tools/      tool definitions and the result envelope          (§12.2, §12.4)
├─ integration/ client capability, trigger, and action contracts
├─ package/     package manifests, requests, and deterministic lockfiles
└─ CHANGELOG.md
```

## How the three copies stay in agreement

§20.11 asks for generated types on both sides. This repository keeps the constants
hand-written in each language and enforces agreement with a check instead:

```bash
bun run schemas:check
```

`scripts/check-protocol-drift.ts` compares, and fails the build on any disagreement:

| Contract | TypeScript | Rust | Schema |
|---|---|---|---|
| request methods | `packages/protocol-ts/src/rpc.ts` | `crates/cbc-protocol/src/methods.rs` | `protocol/rpc.schema.json` |
| notifications | same | same | same |
| mutating methods | — | same | same |
| protocol version | same | `crates/cbc-protocol/src/limits.rs` | same |
| frame and rate limits | same | same | same |
| heartbeat thresholds | same | same | same |
| JSON-RPC error codes | same | `crates/cbc-protocol/src/jsonrpc.rs` | same |
| tool error taxonomy | same | — | same |
| event kinds | `packages/protocol-ts/src/events.ts` | — | `events/event.schema.json` |
| config surface | `packages/config-schema/src/schema.ts` | — | `config/config.schema.json` |
| native tool ids | `packages/tool-registry/src/catalog.ts` | — | `tools/tool.schema.json` |

The trade is deliberate. Generation would remove the duplication but put an
unreviewed artifact in the build path, and §19.9 already forbids the release path from
fetching anything. A check keeps both languages idiomatic and diffable, at the cost of
writing each constant twice — and the check is what makes that cost safe.

Two limitations are worth knowing:

- The Rust side is read as **source text**, not compiled. This verifies the declared
  lists, not the dispatcher that consumes them; `cargo test -p cbc-protocol` covers
  that.
- `mcpServers`, `lspServers`, and `keymap` are open maps, so their keys are user data
  rather than schema and are not compared.

## Dialect

Each file declares `"x-dialect": "json-schema-draft-2020-12"` and uses a `cbc:` URN for
`$id` rather than an HTTP URL. Nothing in the build resolves a schema over the network
(§19.9), so an HTTP `$id` would imply a fetch that never happens.

## Changing a contract

1. Edit the schema first — it is the source of truth.
2. Update the TypeScript constant and the Rust constant to match.
3. Run `bun run schemas:check` until it passes.
4. Record the change in `CHANGELOG.md`, including whether it is breaking under the
   rules listed there.

Order matters for step 4. `CHANGELOG.md`'s breaking-change rule 4 — a default that
becomes more permissive — is the only one no automated check can catch, so it depends
on someone writing the entry.
