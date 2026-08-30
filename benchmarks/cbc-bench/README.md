# CBC Bench

CBC Bench is the outcome, latency, safety, and cost harness for Capybara Code. It
runs immutable repository snapshots through a real agent entry point, executes hidden
acceptance checks outside the agent-visible workspace, derives metrics from CBC JSONL
events, and evaluates paired statistical release gates.

## Evidence levels

| Command / artifact | Purpose | Release evidence? |
|---|---|---|
| `coverage` | Inspect category and language distribution | No |
| `validate` | Validate every task, snapshot recipe, and cohort manifest | Prerequisite |
| `run` | Measure one faithfully applied CBC profile | Development evidence |
| `paired` | Balanced baseline/candidate repetitions with cold/warm strata | Yes, when the full cohort and minimum repetitions are used |
| `gate` | Recompute statistics from raw paired runs and evaluate thresholds | Final decision |
| `cohort-manifest.json` | Canonical identity of prompts, hidden checks, budgets, and snapshots | Prerequisite |

A single suite summary is never accepted as release evidence. The gate requires raw
paired runs, exact task metadata, capability evidence, no skipped or harness-failed
observations, and a stored statistical aggregate that matches deterministic
recomputation.

## Release cohort

The checked-in cohort contains 150 tasks in ten fixed strata:

| Category | Tasks |
|---|---:|
| repository understanding | 15 |
| local bug fix | 20 |
| feature implementation | 20 |
| refactor | 15 |
| test diagnosis | 15 |
| diff review | 10 |
| multi-language / monorepo | 15 |
| permission denial adaptation | 10 |
| security / safety | 15 |
| long session / resume / compaction | 15 |

`bf-off-by-one` is a hand-authored end-to-end smoke fixture. The other 149 snapshots
are versioned deterministic recipes. Each recipe produces a fresh repository, a
SHA-256 manifest, and no agent-visible acceptance checker. Generated hidden checks
execute in the harness and inspect the post-run workspace.

## Commands

```bash
bun run benchmarks/cbc-bench/src/cli.ts coverage
bun run benchmarks/cbc-bench/src/cli.ts validate
bun run benchmarks/cbc-bench/src/cli.ts manifest
bun run benchmarks/cbc-bench/src/cli.ts profiles
```

### One-profile development run

```bash
CBC_RUNTIME_BINARY=/absolute/path/to/cbc-runtime \
CBC_MOCK_PROVIDER=/absolute/path/to/provider.script.json \
bun run benchmarks/cbc-bench/src/cli.ts run \
  --profile standard-medium \
  --filter bf-off-by-one \
  --out benchmarks/cbc-bench/results/smoke.json
```

The runner isolates configuration, trust/session data, caches, and logs. It applies the
profile through product controls rather than benchmark-only labels. A profile is refused
when CBC does not expose a control for one of its axes. Before measurement it probes the
actual runtime handshake. If any selected task requires `network = deny` but the runtime
reports neither `network-namespace` nor `seccomp`, the run stops without producing a score;
an unsupported host must not be counted as an agent failure.

For completed mutation tasks, only the task's declared shell-free verification command is
installed as an exact R1 user-config allow rule (for example `bun` with the `test` argument
prefix). Plan tasks and expected-partial denial tasks receive no such rule. Network,
destructive, credential, and external-side-effect policy remains unchanged.

### Paired CBC baseline comparison

```bash
bun run benchmarks/cbc-bench/src/cli.ts paired \
  --comparison capybara_baseline \
  --baseline-profile standard-medium \
  --candidate-profile standard-medium \
  --repetitions 5 \
  --order abba \
  --capability-snapshot /absolute/path/to/capabilities.json \
  --out benchmarks/cbc-bench/results/cbc-paired.json
```

A release-candidate run uses all 150 tasks, at least five repetitions per variant, and
both cold and warm strata. Filtered runs are development evidence only.

### External comparisons

CBC does not import or package another agent runtime. An operator-owned neutral adapter
is used for both external modes:

- `external_backbone_matched` measures harness differences under the exact same model,
  reasoning, profile, budget, and capability snapshot.
- `external_product_native` measures each product with its declared native/default
  profile. Its adapter carries its own capability digest; CBC Bench deliberately does
  not claim that it equals the Capybara candidate snapshot.

Every new manifest is schemaVersion 1.1 and binds the product identity into its digest:

```json
{
  "schemaVersion": "1.1",
  "id": "matched-agent-adapter",
  "identity": {
    "product": "codex",
    "version": "1.2.3",
    "model": "gpt-5.6-sol",
    "authSurface": "openai-api-key",
    "mode": "backbone_matched"
  },
  "program": "/absolute/path/to/adapter",
  "args": ["--input", "{input}", "--output", "{output}"],
  "appliedProfile": {
    "id": "standard-medium",
    "description": "The shipped default.",
    "model": "gpt-5.6-sol",
    "reasoningMode": "standard",
    "reasoningEffort": "medium",
    "autoReview": true,
    "toolDiscovery": true,
    "subagents": true,
    "promptCache": "prefix"
  },
  "implementationDigest": "sha256:<digest of the adapter implementation>",
  "passEnvironment": []
}
```

Run it with:

```bash
bun run benchmarks/cbc-bench/src/cli.ts paired \
  --comparison external_backbone_matched \
  --baseline-adapter /absolute/path/to/adapter-manifest.json \
  --capability-snapshot /absolute/path/to/capabilities.json \
  --repetitions 5 \
  --order seeded_randomized \
  --seed weekly-2026-08-12 \
  --out benchmarks/cbc-bench/results/matched-paired.json
```

For a native-default comparison, set `identity.mode` to `product_native`, declare the
adapter's actual native profile/model/auth surface plus its own `capabilityDigest`, and run with
`--comparison external_product_native`. The adapter receives a JSON file containing the
exact task, workspace, applied profile, budget, permission/network contract, identity,
and capability digest. It writes a schema-versioned result containing timing and CBC
events. The harness validates identity/digest provenance, event schema, timing order,
exit code, and the mode-specific profile/capability contract before accepting the
observation. Snapshot preparation, hidden acceptance, scoring, and teardown remain owned
by CBC Bench.

For `backbone_matched`, omit `capabilityDigest` from the input manifest: CBC Bench binds
the exact supplied capability snapshot into the canonical adapter manifest and digest.
If a backbone manifest supplies the field explicitly, it must match byte-for-byte.

`codex_matched` is accepted only when inspecting historical schemaVersion 1.0 artifacts;
new CLI runs canonicalize it to `external_backbone_matched` and require identity-bound
schemaVersion 1.1 evidence.

## Capability snapshot

A paired run requires explicit backend evidence; the harness never guesses it:

```json
{
  "backend": "api",
  "capturedAt": "2026-08-12T00:00:00.000Z",
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "capabilities": {
    "websocket": true,
    "previousResponse": true,
    "parallelToolCalls": true,
    "nativeCompaction": true,
    "serviceTier": "standard"
  },
  "metadata": {
    "region": "operator-recorded",
    "route": "operator-recorded"
  }
}
```

The digest is attached to the paired artifact and recomputed at gate time.

## Statistical gate

Repetitions are first reduced to one paired observation per task. The bootstrap then
resamples tasks while preserving category strata. The result records deterministic
95% confidence intervals for:

- candidate-minus-baseline quality difference;
- median and p95 task-level speed ratios;
- scope-precision difference;
- successful-task cost ratio;
- provider payload reduction;
- provider-request reduction;
- candidate pre-provider local p95.

Critical safety is a hard zero-regression gate. The gate also blocks any category whose
success rate falls more than three percentage points, incomplete pairs, CI tampering,
capability drift, changed task metadata, skipped tasks, or harness errors.

## Artifact handling

`benchmarks/cbc-bench/results/` is intentionally excluded from source-truth hashing.
Release artifacts should be copied to the release evidence store and referenced by their
SHA-256 digest. The cohort manifest and implementation documentation are checked in;
live model or external-comparator results are not fabricated during normal repository
tests.
