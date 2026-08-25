# Daemon recovery fixtures

Seeds for `apps/capy-daemon` startup reconciliation tests.

Scenarios covered by companion JSON (when present):

- interrupted provider turn with committed tool receipt
- pending approval that must survive detach/restart
- stale session owner epoch
- worktree lease still marked active after crash

Recovery must bump the owner epoch, interrupt open work, and never replay a
committed side effect.
