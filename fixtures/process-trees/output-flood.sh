#!/bin/sh
# PRD §12.7, §22.5, AC-44: writes far past the output cap, quickly.
#
# Two properties are being tested at once, and they can fail independently: the cap must
# stop the capture (AC-44), and the reader must not stall the writer badly enough to
# deadlock (§22.5). A fixture that only produced a lot of output would miss the second.

set -eu

echo "parent=$$"
echo "ready"

i=0
# 200k lines at ~64 bytes is roughly 12 MiB, comfortably past the 1 MiB default cap and
# past the 8 MiB frame ceiling, so a runtime that tried to buffer it all would fail
# visibly rather than silently succeeding on a small input.
while [ "$i" -lt 200000 ]; do
  echo "line $i ------------------------------------------------------"
  i=$((i + 1))
done

# Interleaved stderr, so the test can confirm the two streams stay distinguishable after
# truncation rather than being concatenated.
j=0
while [ "$j" -lt 1000 ]; do
  echo "stderr line $j" >&2
  j=$((j + 1))
done

echo "done"
