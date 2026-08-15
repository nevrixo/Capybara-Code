# Performance program rollback runbook

Use this runbook when a paired gate fails, an artifact is incomplete, or a released
change shows a safety, quality, or operational regression.

## Stop and classify

1. Stop publication and mark the candidate as blocked.
2. Preserve raw paired JSONL, the capability snapshot, cohort manifest, gate output,
   and SHA-256 checksums. Do not edit the evidence in place.
3. Classify the failure as product behavior, harness integrity, capability drift,
   or release packaging. A harness error is not an agent failure.

## Revert safely

- For an unreleased candidate, revert the candidate commit to the last known-good
  tag and rerun repository verification.
- For a published npm alpha, publish a new patch-level prerelease only after review;
  never overwrite an npm version. Point users to the last known-good `alpha.N` and
  document the failed version in the release notes.
- Keep the `capy` launcher and platform package versions aligned. Verify `--version`,
  `--help`, and runtime-relative paths on every supported native runner.

## Re-measure and close

Recreate the exact cohort and capability snapshot, run a fresh balanced paired
comparison, and execute `gate` from raw artifacts. Attach the new digest and review
safety/quality deltas before reopening publication. Update the implementation plan's
release decision state only when empirical evidence is complete.

For package-specific incidents, use the release workflow's protected `npm-publish`
environment and record whether the trusted-publisher or bootstrap-token path was
used. Never commit tokens or credentials to the repository.
