#!/bin/bash
# Reloop eval: count test failures (lower is better, target: 0)
# Phase 1 (JS): use .js tests
# Phase 2 (TS): use .ts tests if they exist
if ls test/*.test.ts 1>/dev/null 2>&1; then
  RESULT=$(node --experimental-strip-types --test test/**/*.test.ts 2>&1)
else
  RESULT=$(node --test test/**/*.test.js 2>&1)
fi
FAIL=$(echo "$RESULT" | grep '^ℹ fail' | awk '{print $3}')
echo "${FAIL:-0}"
