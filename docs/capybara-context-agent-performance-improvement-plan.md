# Capybara Context/Agent Performance Improvement Plan

## Purpose

This program improves local harness latency and context efficiency while keeping
model choice, permission policy, sandboxing, hidden acceptance checks, and release
verification unchanged. CBC Bench is the measurement boundary; product code and
benchmark code remain separate.

## Workstream and acceptance

1. Profile the pre-provider path and record a baseline capability snapshot.
2. Make one implementation change at a time and run the repository verification suite.
3. Run the complete fixed cohort with balanced paired repetitions and cold/warm strata.
4. Recompute the gate from raw paired artifacts, not from a hand-edited summary.
5. Publish only when quality and safety have no prohibited regression and the paired
   latency/cost bounds meet the release policy.

Code completion is not empirical release evidence. A passing unit test or a local
smoke run proves implementation behavior only. A release claim requires the actual
paired artifact, its cohort and capability digests, raw observations, and a
reproducible gate result stored outside the source checkout.

## Release decision state

출시 판정 상태: **미측정**

The implementation work is intentionally complete enough to measure, but no public
release claim is made until a full paired run has been reviewed. The **실제 paired artifact**
(and its SHA-256 digest) must be attached to the release record before this state can
change.

## Non-goals and guardrails

- No competitor runtime or proprietary SDK is imported into production.
- No benchmark-only permission, network, model, or sandbox relaxation is allowed.
- No synthetic latency multiplier is treated as a measured result.
- Filtered or single-profile runs are development evidence only.

See the [CBC Bench operating guide](../benchmarks/cbc-bench/README.md), the
[latency program ADR](adr/0001-harness-latency-program.md), and the
[rollback runbook](performance-program-rollback-runbook.md).
