#!/bin/sh
# PRD §7.7, §14.6: a process that ignores SIGTERM.
#
# §7.7 sends a graceful signal, waits a grace period, then forces termination. This
# fixture makes the second half observable: a runtime that only ever sends TERM will
# hang here, and the test will time out rather than pass.

set -eu

trap 'echo "caught TERM, ignoring"' TERM
trap 'echo "caught INT, ignoring"' INT

echo "parent=$$"
echo "ready"

# A loop rather than one long `sleep`, because a signal handler in POSIX sh only runs
# between commands — a single 30s sleep would delay the handler until it finished and the
# test could not tell "ignored the signal" from "did not receive it".
i=0
while [ "$i" -lt 300 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done

echo "exited on its own"
