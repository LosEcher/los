#!/usr/bin/env bash
# check-known-failures.sh — compare actual test output against the known-failure
# baseline. Used in ci-gate.sh after the test phase to distinguish NEW failures
# (which block) from KNOWN failures (which don't).
#
# The baseline file is tools/.known-test-failures.txt. See that file for format.
#
# STDIN: raw test output (e.g. from `pnpm run _test 2>&1`)
# Exit code: 0 = no NEW failures detected
#            1 = at least one NEW failure (block merge)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/tools/.known-test-failures.txt"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Parse stdin for actual failures ──────────────────────────
# Node --test emits:   ✖ src/path/to/file.test.ts
# or:                  ✖ src/path/to/file.test.ts (duration)
ACTUAL_FAILURES=$(cat | grep -E '✖[[:space:]]+.*\.test\.ts' | sed 's/^.*✖[[:space:]]*//' | sed 's/ [(].*//' | sort -u || true)

# ── Parse baseline ───────────────────────────────────────────
KNOWN_FILES=$( (grep '\.test\.ts' "$BASELINE" 2>/dev/null || true) | grep -v '^#' | awk '{print $1}' | sort -u)

# ── No failures at all ───────────────────────────────────────
if [ -z "$KNOWN_FILES" ] && [ -z "$ACTUAL_FAILURES" ]; then
  printf '  %b✓ No test failures detected%b\n' "$GREEN" "$NC"
  exit 0
fi

# ── Compare ──────────────────────────────────────────────────

match_known() {
  local failure="$1"
  local known="$2"
  # Substring match in either direction: Node test outputs "src/foo.test.ts"
  # but baseline stores "packages/agent/src/foo.test.ts".
  case "$failure" in
    *"$known"*) return 0 ;;
  esac
  case "$known" in
    *"$failure"*) return 0 ;;
  esac
  return 1
}

NEW_COUNT=0
KNOWN_COUNT=0
FIXED_COUNT=0

# Save to temp files to avoid here-string issues with set -e
TMP_ACTUAL=$(mktemp /tmp/los-kf-actual.XXXXXX)
TMP_KNOWN=$(mktemp /tmp/los-kf-known.XXXXXX)
echo "$ACTUAL_FAILURES" > "$TMP_ACTUAL"
echo "$KNOWN_FILES" > "$TMP_KNOWN"

# Check for NEW failures
while IFS= read -r failure_file; do
  [ -z "$failure_file" ] && continue
  matched=false
  while IFS= read -r known_file; do
    [ -z "$known_file" ] && continue
    if match_known "$failure_file" "$known_file"; then
      matched=true
      break
    fi
  done < "$TMP_KNOWN"
  if $matched; then
    KNOWN_COUNT=$((KNOWN_COUNT + 1))
    printf '  %b[KNOWN]%b %s\n' "$YELLOW" "$NC" "$failure_file"
  else
    NEW_COUNT=$((NEW_COUNT + 1))
    printf '  %b[NEW]  %b %s\n' "$RED" "$NC" "$failure_file"
  fi
done < "$TMP_ACTUAL"

# Check for FIXED
while IFS= read -r known_file; do
  [ -z "$known_file" ] && continue
  found=false
  while IFS= read -r failure_file; do
    [ -z "$failure_file" ] && continue
    if match_known "$failure_file" "$known_file"; then
      found=true
      break
    fi
  done < "$TMP_ACTUAL"
  if ! $found; then
    FIXED_COUNT=$((FIXED_COUNT + 1))
    printf '  %b[FIXED]%b %s — remove from baseline\n' "$GREEN" "$NC" "$known_file"
  fi
done < "$TMP_KNOWN"

rm -f "$TMP_ACTUAL" "$TMP_KNOWN"

# ── Summary ──────────────────────────────────────────────────
printf '\n%b─── Known-Failure Check ───%b\n' "$CYAN" "$NC"
printf '  KNOWN:  %d\n' "$KNOWN_COUNT"
printf '  NEW:    %d\n' "$NEW_COUNT"
printf '  FIXED:  %d\n' "$FIXED_COUNT"

if [ "$FIXED_COUNT" -gt 0 ]; then
  printf '\n  %bRemove fixed entries from tools/.known-test-failures.txt%b\n' "$GREEN" "$NC"
fi

if [ "$NEW_COUNT" -gt 0 ]; then
  printf '\n%bKNOWN-FAILURE GATE FAILED — %d new failure(s) detected%b\n' "$RED" "$NEW_COUNT" "$NC"
  printf '  Add them to tools/.known-test-failures.txt if pre-existing, or fix them.\n'
  exit 1
fi

printf '\n%bKNOWN-FAILURE GATE PASSED%b\n' "$GREEN" "$NC"
