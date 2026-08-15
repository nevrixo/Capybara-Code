# ADR 0001: Harness latency program and evidence boundary

- Status: Accepted for Public Alpha measurement
- Date: 2026-08-15

## Context

Capybara Code needs faster local interaction without weakening the execution
contract. Latency numbers are easy to overstate when a benchmark uses a different
model, permissions, network capability, cache state, or task cohort. The repository
therefore needs one explicit boundary between implementation verification and
empirical release evidence.

## Decision

CBC Bench is the canonical harness. It records the applied profile, capability
snapshot, task metadata, raw event timings, hidden acceptance outcome, and paired
baseline/candidate observations. The `paired` command produces the only artifact
eligible for a release gate; `gate` deterministically recomputes the decision from
that artifact. A filtered run, a local smoke test, or an estimated multiplier may
inform development but cannot establish a release claim.

Production code does not import or invoke an external agent runtime. A matched
external comparison, when needed, is supplied through an operator-owned neutral
adapter with a schema-validated manifest and capability digest.

## Consequences

- Every performance claim is traceable to raw paired data and a fixed cohort.
- Safety, permission, network, sandbox, and model controls remain product controls.
- Results under `benchmarks/cbc-bench/results/` stay out of source-truth hashing;
  their release copies are referenced by SHA-256.
- A failed or incomplete pair blocks publication and is rerun with the same policy,
  not repaired by editing a summary.

The implementation plan and rollback procedure are linked from the repository
[performance-program documentation](../capybara-context-agent-performance-improvement-plan.md).
