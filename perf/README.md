# Capybara Code performance regression harness

This directory contains a Bun/TypeScript JSON CLI for deterministic performance
regression checks. It gates **correctness, operation counters, cache behavior,
batch boundaries, and work-growth ratios**. Median and p95 wall-clock timings are
reported for diagnosis but are intentionally not hard gates, so a slow CI runner
does not create noise.

## Run

From the repository root:

```bash
# Required 10k/100k histories and giant-item workload; compact JSON on stdout.
bun run perf/cli.ts > perf-results.json

# Human-readable JSON.
bun run perf/cli.ts --pretty

# Fast local smoke configuration (1k/10k histories).
bun run perf/cli.ts --quick --pretty

# Controlled long-session runner enables wall-clock and memory release gates
CBC_PERF_FIXED_RUNNER=1 bun run perf/cli.ts --scenario long-session-resume-741x231mb --pretty

# One or more scenarios.
bun run perf/cli.ts --scenario projected-timeline,giant-markdown --pretty

# Discover scenario names.
bun run perf/cli.ts --list
```

The CLI exits `0` when all gates pass, `1` when a regression gate fails, and `2`
for invalid command-line arguments. Aside from `--help`, `--list`, and argument
errors, stdout is one JSON document suitable for CI artifact collection.

## Test and type-check

```bash
bun test perf/harness.test.ts
bunx tsc -p perf/tsconfig.json --noEmit
```

Tests use quick sizes and assert only deterministic gates; they do not compare
wall-clock values.

## Scenarios

| Scenario | Deterministic coverage |
| --- | --- |
| `unicode-width-hotloop` | Printable-ASCII width allocation gate plus Unicode width correctness matrix. |
| `streaming-markdown-growth` | Arbitrary chunk append work, exact source length, chunkability, and linear inspected-character growth. |
| `active-frame-surrogate` | Two-column active streaming frame height, reused projection, and zero streaming fingerprints. |
| `composer-edit-latency` | Large draft set plus insert/backspace cursor/text correctness workload. |
| `path-completion-max-index` | Max-size normalized path index, zero full sort, and bounded top-K retention. |
| `ansi-diff-and-backpressure` | Changed-row output, no normal full clear, and one pending frame under a blocked sink. |
| `projected-timeline` | `ProjectedTimeline` unchanged and append fast paths at 10k/100k; source-inspection/rebuild counters; cold and warm deep viewport work independent of total history. |
| `giant-markdown` | Cold misses and warm hits for a 1,000,000-character Markdown item; exact cache identity plus an authoritative, source-line-bounded viewport render. |
| `reducer-delta-burst` | Root `assistant.delta` burst over 10k/100k resident histories; zero timeline-reference copies and exact ordered-text reconstruction surrogate. |
| `live-span-cleanup` | Repeated concurrent `LiveSpanRegistry` landed/cancelled cleanup; peak/final resident spans and exact reconciliation. |
| `session-recorder-batching` | `SessionRecorder` 32-event and byte-limit splits with an ordered fake transport and exact durable acknowledgements. |
| `idle-frame-surrogate` | Public `renderSessionFrame` semantic surrogate: idle `liveFrame` changes produce no changed frame. |
| `resident-window-and-paging` | Frozen multi-page tail replay, earlier-page cursors, `ResidentJournalWindow` pins/eviction ranges, `boundResidentViewModel`, and the exact 32-child reducer detail cap. |
| `long-session-resume-741x231mb` | Deterministic 741-turn / 231MiB target with 48-item/768KiB resume tail, 64-item/1MiB paging, three historical pages, prompt/RPC/memory counters, and fixed-runner release gates. |
| `read-cache-coalescing` | Revision-scoped read reuse, concurrent in-flight coalescing, 400-line default alignment, and path-only invalidation. |
| `repository-scan-truncation` | Bounded repository walk truncation propagation and dirty-path preservation. |
| `selection-shortlist-50k` | Deterministic 50k-file shortlist cap, explicit mention retention, and bounded scoring work. |
| `retrieval-controller-stop-rules` | Search-before-preview-before-exact ordering, write-authority checks, and byte/evidence budgets. |

## JSON contract

The top-level report contains runtime metadata, overall `pass`, a summary, and a
`scenarios` array. Every scenario reports:

- workload `sizes`;
- timing distributions (`samples`, `medianMs`, `p95Ms`, `minMs`, `maxMs`);
- public/observable operation `counters`;
- normalized `ratios` (timing ratios are labeled `Diagnostic`);
- `correctness`, individual `gates`, and scenario `pass`.

The residency scenario both discovers and actively exercises the public session
paging/window exports. It reconstructs a frozen hash-bounded journal across pages,
loads an earlier cursor, verifies bounded resident data and pinned lifecycle state,
and checks exact omission ranges/counters.
