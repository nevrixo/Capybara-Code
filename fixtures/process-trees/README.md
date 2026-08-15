# `process-trees/`

Scripts for §25.9's PTY tests and RT-001: cancelling a job must terminate the whole
process tree, not just the direct child.

The distinction is the whole point. A naive implementation kills the process it spawned
and leaves the grandchildren running, which looks like success — the `process.stop` call
returns, the job disappears from the drawer, and a background `sleep` keeps holding a
file handle. Each script below spawns at least one grandchild so that the difference is
observable.

## Files

| Script | Shape | Asserts |
|---|---|---|
| `spawn-grandchild.sh` | parent → child → grandchild, all sleeping | no descendant survives cancellation |
| `spawn-grandchild.cmd` | the same on Windows without a POSIX shell | `taskkill /T` reaches the tree |
| `detached.sh` | child `setsid`s away from the parent's group | a re-parented process is still cleaned up |
| `output-flood.sh` | writes far past the output cap, fast | §22.5 backpressure, and that the cap stops it |
| `ignores-sigterm.sh` | traps `TERM` and keeps running | the grace period expires and `SIGKILL` follows |

## Running them by hand

```bash
sh fixtures/process-trees/spawn-grandchild.sh &
# then, from another shell, confirm the descendants exist:
pgrep -P $! -a
```

On Windows the POSIX scripts need a shell; the tests locate Git for Windows' `sh.exe`
or honour `CBC_TEST_SH`, and skip rather than fail when neither is present. That skip is
reported, because a silently skipped cancellation test is worse than a missing one.

## Portability notes

- No `bash`-only syntax: `#!/bin/sh` throughout, so these run under `dash` and BusyBox.
- Every script writes its own PID and its children's PIDs to stdout before sleeping, so
  a test can assert on the tree without needing `ps` output parsing.
- Sleep durations are long enough (30 s) that a test never races the process exiting on
  its own and mistaking that for a successful kill.
