# Protocol and schema changelog

PRD §20.11 requires a protocol changelog alongside the schemas, and §19.12 gives the
runtime RPC, the event schema, the session store, and the product each an independent
version. This file records changes to the first two.

`scripts/check-protocol-drift.ts` runs in CI (`bun run schemas:check`) and fails when
the TypeScript constants, the Rust constants, and these schemas disagree. That check is
what makes the entries below trustworthy: a change that is not reflected in all three
places cannot land.

## Compatibility rules

- **Runtime RPC** (`schemas/protocol/`) — `cbc` refuses to run against a runtime whose
  *major* protocol version differs (§19.12). A minor mismatch runs only where
  capability negotiation allows it.
- **Event schema** (`schemas/events/`) — adding an event kind is a minor change,
  because §20.10 requires a consumer to skip an unknown kind. Removing a kind, renaming
  a field, or changing a field's type is breaking.
- **Config schema** (`schemas/config/`) — adding an optional key with a default is a
  minor change. Removing a key, narrowing an enum, or changing a default that weakens a
  permission is breaking.
- **Tool contract** (`schemas/tools/`) — adding a tool is minor. Changing an existing
  tool's argument schema in a way that rejects previously valid arguments is breaking.

## Breaking-change definition

A change is breaking when any of these becomes true:

1. A previously valid document is rejected.
2. A field's meaning changes without its name changing.
3. An enum member is removed or renamed.
4. A default changes such that an existing config becomes *more* permissive than the
   user intended.

Rule 4 is listed because it is the one that does not look breaking. Loosening a default
does not fail validation, so nothing would catch it except a human reading this list.

---

## protocol 1.0 · events 1.0 — worktree/merge + memory store methods

Additive request methods (still protocol 1.0 major):

- After `git.checkpoint`: `worktree.create`, `worktree.list`, `worktree.inspect`,
  `worktree.status`, `worktree.diff`, `worktree.remove`, `worktree.reconcile`,
  `merge.preview`
- After `memory.remember`: `memory.list`, `memory.get`, `memory.forget`,
  `memory.resolve_contest`, `memory.verify`
- Mutating set gains `worktree.create`, `worktree.remove`, `worktree.reconcile`
- `fs.edit` may carry optional `expectedPlanDigest` (stale preview →
  `HASH_MISMATCH` / `EDIT_PREVIEW_STALE`)

Request method count is now 75.

## tools 1.0 — merge.apply / merge.resolve

Model-facing merge tools apply conflict-free results through the structured
Edit Engine. They are not additional runtime RPC methods.

## protocol 1.0 · events 1.0 — runtime feature catalog

Added the modification-plan §17 event kinds as a minor, additive change:

- `edit.*` plan/preview/commit/conflict receipts
- `lsp.*` server/document/query/WorkspaceEdit lifecycle
- `memory.*` durable recall transitions
- `daemon.*` / session ownership / command receipts
- `graph.*` / `agent.*` persistent AgentGraph
- `worktree.*` / `merge.*` isolated writers
- `plugin.*` hook/tool/grant lifecycle

Unknown kinds remain skippable on replay (§20.10). App Server transport
notifications stay in `@cbc/app-protocol`, not this journal catalog.

## protocol 1.0 · events 1.0 — unreleased

Initial published contract, matching PRD v1.0.

**Runtime RPC 1.0**

- 48 request methods across `runtime`, `workspace`, `fs`, `process`, `git`,
  `credential`, `session`, `artifact`, and `update` (§20.3). The count grew from the
  PRD's 39 as deliberate additions: `fs.transaction.rollback_to_checkpoint` (§11.2
  self-correction), `workspace.trust.{list,set,remove}` (P0-01 — the CLI manages
  trust through the runtime instead of writing the store file directly), and
  `session.{list,set_status,export,fork,delete}` (P0-05 — the SQLite store becomes
  the single session authority, replacing the host-side index and journal files).
- 11 notification methods (§20.3).
- Length-prefixed framing, 4-byte unsigned big-endian prefix, 8 MiB frame ceiling
  (§20.1, §20.4).
- Heartbeat at 5 s, degraded at 15 s, fatal at 30 s (§20.5).
- 25 JSON-RPC error codes, each mapping onto the 17-member §12.10 tool error taxonomy.
- `runtime.initialize` handshake with client and runtime capability blocks (§20.2).
  `RuntimeCapabilities.keychain` and `sandboxLevel` are enumerated rather than free
  text, because §24.5 and R-06 forbid overclaiming and an open string invites it.

**Event schema 1.0**

- 45 event kinds (§20.7), including the ephemeral `assistant.delta` stream event for low-latency rendering.
- Per-kind defaults for `level`, `visibility`, and `durability`; the §20.9 MUST-journal
  set is expressed as `durability: "journaled"`.
- `sequence` is strictly monotonic within a session (§20.10).
- `run.completed` carries the §8.9 `exitCode`, so a journal consumer learns the outcome
  without inspecting the process. The kernel emits exactly one `turn.completed` per
  turn; the headless runner appends `run.completed` for the invocation-level status.
- Added the journaled `permission.changed` event used when the effective permission
  policy changes.


**v1.3 amendment additions**

- Added model routing/capability, TaskEpoch/reasoning, cache, context/evidence,
  programmatic-tool, hosted-agent, tool-batch, and verification lifecycle events.
- Added the hidden, journaled Context P0 telemetry kinds
  `context.observation_ingested`, `context.pack_compiled`, `context.item_evicted`,
  `context.evidence_rejected`, and `context.cache_segment`. These additive events make
  compiled prompt/token accounting, evidence rejection, working-set eviction, and
  cache segmentation derivable from the ordinary journal stream.
- Added scoped-agent lifecycle and validated handoff events: context.scope_created, context.scope_seeded, context.handoff_created, context.handoff_validation_failed, context.handoff_accepted, context.handoff_rejected, context.handoff_consumed, and context.scope_disposed. These events expose isolation and exactly-once collection without recording exact source bodies.
- Added optional `callerId`, `taskEpochId`, and `workspaceIdentityDigest` envelope
  fields so provider-native observations remain attributable and identity-aware.
- v1.3 program/hosted/tool-batch events now require turn, agent, caller, and epoch ancestry; opaque provider items remain bounded and non-executable.
- Added hidden, journaled performance lifecycle events for run traces, repository
  orientation/full scans, context preparation, prompt compilation, provider connection/
  request/first-delta/completion/fallback, verification, and independent review.
- Added performance rollout settings for transport, provider compaction, Fast service
  tier, phase routing, progressive orientation, prompt compiler, compound tools,
  command/provider parallelism, risk-based review, and sampled telemetry.
- Added strict schemas for the bounded compound tools `repo.investigate` and
  `verification.run_many`.

**Thinking unification amendment**

- Added the journaled assistant.thinking canonical event. Legacy
  assistant.reasoning and assistant.reasoning_summary remain readable and
  project into one semantic Thinking part.
- Added ui.thinkingMode = expanded|collapsed|off and
  model.reasoning.providerSummary = auto|off, with deprecated aliases and
  deterministic migration warnings. The UI disclosure setting no longer controls
  provider summary generation.
Canonical Thinking text is bounded at 4 KiB for provider summaries and 64 KiB for visible detail; oversized parts retain `truncated: true`.

**Config schema 1.0**

- The full §21.4 surface. `subagents.writerPolicy` is a `const` rather than an enum
  because P6 admits exactly one policy, and an enum with one member would imply others
  are coming.
- `permissions.credentials` defaults to `deny`, matching §13.2's treatment of
  credential access as R5.
- No property anywhere in this schema holds a secret value, per §21.3.
- `permissions.preset` is optional and has no implicit `auto` default, so it cannot
  override an explicit permission mode.
- Added the open `lspServers` map, written as `[lsp.servers.<name>]` in the single
  global TOML. Server commands, extensions, language IDs, activation, install hints,
  and request timeouts are explicit configuration rather than built-in definitions.

**Tool contract 1.0**

- 31 native tool ids (§12.2), including model-bound bounded retrieval for runtime-minted `artifact.read` handles.
- `parameters` must be a strict object schema with `additionalProperties: false`
  (§12.4).
- `ToolResult.error.retryable` is required, so §10.13's retry decision is explicit in
  the data rather than inferred from the code.
# 1.1.0

- Added wired `agent.toolRecovery` and `agent.todo` configuration with safe defaults.

- Added hidden, journaled tool recovery lifecycle events for preflight repair, failed internal attempts, safe replay, reconciliation, and exhausted recovery.

- Added durable `mode.changed` and `plan.approved` event kinds.
- Added additive context usage and TODO revision payload fields.

## 1.2.0

- Added additive runtime RPC methods `memory.search` and `memory.remember`.
  The runtime, rather than a client, binds each persisted claim to its workspace and
  derives timestamps from fresh opaque evidence.
- Added feature-gated `memory.search` and `memory.remember` native tool IDs plus
  `fs.read.recordEvidence`; the default catalog remains unchanged while
  `experimental.durableMemory` is off.
- Synchronized `fs.edit.preview` and `fs.edit` tool IDs with the generated tool schema.
