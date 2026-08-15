#!/bin/sh
# PRD §14.6, RT-001, AC-20: parent -> child -> grandchild, all long-lived.
#
# PIDs are printed before sleeping so a test can assert on the tree directly instead of
# parsing `ps`. Without that, "the tree died" and "we never found the tree" look alike.

set -eu

echo "parent=$$"

# Grandchild first, so its PID is known before the child starts waiting.
sh -c '
  echo "grandchild=$$"
  # 30s is long enough that the test can never race a natural exit and read it as a
  # successful kill.
  sleep 30
' &
CHILD_OF_PARENT=$!
echo "child=$CHILD_OF_PARENT"

# A second branch, so a kill that only walks one path is still caught.
sh -c '
  echo "sibling=$$"
  sh -c '\''echo "sibling-grandchild=$$"; sleep 30'\'' &
  wait
' &
echo "sibling-parent=$!"

echo "ready"
wait
