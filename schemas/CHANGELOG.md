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

## config 1.0 — action surface groups

Added agent.actionSurface, a list of the §6.5 groups (inspect, change, verify,
delegate, remember) whose facade is active. It defaults to the empty list, which
means the default session sees no group at all.

It is a list rather than a boolean because §6.6 requires the groups to be
introduced one at a time with the bench re-run between them: a single switch
could not express "front the writers but leave the reads direct", and the bench
could not attribute a quality change to one group. An enabled group takes over
its members' always-active flag; the members stay in the catalog, still reachable
by internal id and by tool.discover, because §6.5 keeps the internal ids.

This is an additive 1.x change with an empty default, so no existing config
becomes more permissive.

## events 1.0 — action group expansion

Added tool.group_expanded, journaled when a §6.5 action-group call is rewritten
into the internal tool it names. The kind exists because the rest of the timeline
deliberately never mentions the group: validation, the permission check,
tool.started, and the evidence all carry the expanded tool id, which is the
guarantee that a facade cannot widen authority. Without this one record there
would be nothing in a replay showing that the model asked through a group at all,
and a wrong-group-selection rate could not be measured. Hidden, because the
expansion is not a step the user needs to see.

This is an additive 1.x change. Older event consumers skip the new kind.

## events 1.0 — native lane and hosted agent lifecycle kinds

Added native_lane.selected and native_lane.fallback so a route receipt records
which native OpenAI lane a turn chose and, when the lane could not be used, the
reason the runtime fell back to the local or direct path. Selection is hidden and
fallback surfaces in the drawer because a fallback is the interesting case.

Added program.tool_call_admitted and program.tool_call_denied for programmatic
tool calling. A program-issued call is journaled at the moment the permission
boundary admits or refuses it, so a denied call leaves evidence even though it
never reaches a tool. Admission is hidden and denial surfaces as a warning.

Added hosted_agent.requested, hosted_agent.fallback_local, and
hosted_agent.evidence_rejected to cover the parts of the hosted multi-agent
lifecycle that the existing spawned, progress, completed, and cancelled kinds do
not describe: the request before a spawn is granted, the fallback to a local
subagent, and evidence discarded because it failed the freshness or lineage
check.

All seven kinds are ancestry-bearing and require turnId, agentId, callerId, and
taskEpochId, so a native lane decision, an admitted or denied program call, and a
hosted agent step are all attributable to a caller lineage within one task epoch.
All seven are journaled.

These are additive 1.x changes. Older event consumers skip the new kinds.

## config · tools · events · app 1.0 — Deep Plan questionnaires

Added the user-only agent.deepPlan = "off" | "on" setting, defaulting to
"off". Deep Plan is a conversational policy layered over Plan mode; it does
not add an execution mode or weaken Plan's read-only boundary.

Added the strict, always-active user.ask_batch tool for one to four
single-select, multi-select, or text questions. Stable questionnaireId and
decisionKey fields provide retry idempotency and resolved-decision
deduplication. The existing user.ask contract is unchanged.

Added hidden journaled deep_plan.* events, including questionnaire draft
checkpoints and Plan-answer revision binding. Added turn.input.get,
turn.input.update, and turn.input.resolve App methods so a detached TUI can
inspect or answer the questionnaire owned by a daemon session worker.
Observers may inspect input; only a controller may update or resolve it.

These are additive 1.x changes. Older event consumers skip the new kinds, and
existing configs retain ordinary Plan behavior because Deep Plan defaults off.

## app capability schema 2.0 — method support snapshot

App Protocol initialization now includes a connection-scoped, digest-bound
capability snapshot. It distinguishes implemented, role-limited, policy-disabled,
and unsupported methods and negotiates event and presentation features with the
client. The previous flat capability map remains available for 1.x clients.

Added strict integration trigger and action-result schemas. Raw provider payloads
remain outside the agent prompt; coordinators consume only the minimized envelope
and validated receipt-backed result.

## config · tools 1.0 — recursive durable AgentGraph

The stable subagent depth default is now 2 with an absolute maximum of 3.
AgentGraph defaults are bounded to 16 nodes, six concurrent nodes, one writer,
240 tool calls, four dollars, and 30 minutes. Writer delegation defaults to
worktree-lease and fails closed when an isolated runtime cannot be created.

Added task.await and task.message to the native tool catalog. Nested agents receive
only the subtree-scoped task facade while the coordinator persists mailbox and
budget reservations with the graph snapshot.

## config — trust-gated project layers

Trusted workspaces may now contribute `.capybara/config.toml` and
`.capybara/config.local.toml` between user and environment precedence. The existing
monotonic project validator continues to reject credentials, yolo, user-owned
supply-chain policy changes, allow rules, and user MCP overrides. Trust records bind
the config, package, executable declaration, and requested-capability digests;
digest changes fail closed and require a new trust decision.

## package schema 1.0 — signed packages and frozen locks

Added strict package manifest, request, and lock contracts for plugins, Skills,
agents, prompts, themes, hooks, schemas, and assets. Registry entries require
verified Ed25519 metadata; local unsigned sources require an explicit development
opt-in. Every content path is digest-covered, grants only narrow, and postinstall
or unknown fields fail closed.

Added signed static registry index, artifact, and pinned-root-key schemas. The
registry transport verifies canonical Ed25519 signatures, expiry, revocation,
withdrawal, HTTPS confinement, exact artifact identity, and decompressed bounds.
App Protocol now includes package search, inspect, install, remove, update,
verify, and frozen bootstrap methods; generated TypeScript and Python method
unions were updated. This is an additive 1.x change.

## events 1.0 — Skills catalog revision

Added the journaled, hidden `skills.changed` event. It records the active Agent
Skills catalog revision, metadata digest, counts, and invalidated names after a
successful startup discovery or manual reload; Skill bodies are never included.

## config — Agent Skills discovery

Added the defaulted `skills` section for native/compatibility roots, explicit
paths, bundled Skill selection, and bounded scan budgets. `skills.autoReload` is
reserved as experimental while manual reload is the active implementation.

## config — experimental runtime surfaces default on

`experimental.*` gates now default to `true`. A user can still set any gate to
`false`. A project cannot re-enable a user-disabled gate. This is a more
permissive default (rule 4) for a fresh install; existing user configs that
already set the keys keep their values.

## tools 1.0 — plugin.invoke

Model-facing plugin invocation goes through ToolRegistry and permission
policy. Plugins cannot widen authority.

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

## 1.3.0

- Added `schemas/memory/capsule.schema.json` for the §6.2 StrategyCapsule: a capsule
  enters as `proposed`, carries at least one evidence reference at every scope, and
  records the independent observation count and invalidators the §6.3 gates read.
- Added the wired `[agent.learning]` configuration section (`strategy_capsules`,
  `min_verified_observations`) from §8.4.
- Added the `goal.evaluated` event kind for the §P1-04 persistent goal contract. The
  per-turn verdict is journaled because a re-attached session has to reconstruct why
  a long-running goal stopped, rather than re-deriving it from a budget it can no
  longer observe.
