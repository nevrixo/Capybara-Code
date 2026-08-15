#!/bin/sh
# PRD §14.6, §19.7: a child that leaves the parent's process group.
#
# §19.7 requires children to be tied to parent-death cleanup or a watchdog. A process
# that calls setsid escapes group-based signalling, so a runtime relying only on
# `kill(-pgid)` will leave it running. That is the case this fixture creates.
#
# `setsid` is not universally present, so the script degrades to a plain background child
# and says so — a test that cannot create the condition should skip, not silently pass.

set -eu

echo "parent=$$"

if command -v setsid > /dev/null 2>&1; then
  setsid sh -c 'echo "detached=$$"; sleep 30' &
  echo "mode=setsid"
else
  sh -c 'echo "detached=$$"; sleep 30' &
  echo "mode=fallback-not-detached"
fi

echo "child=$!"
echo "ready"
wait
