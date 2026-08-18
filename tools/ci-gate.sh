#!/usr/bin/env bash
# ci-gate.sh — single CI gate for los (typecheck → structure → state-machine → contracts → unwired → static-analysis → test)
#
# This replaces the previous "pnpm gate" chain that concatenated 5 shell &&
# operators inside a package.json script. A standalone script gives us:
#   1. Clear exit codes per phase
#   2. Phase timing
#   3. Better CI log grouping
#   4. One place to add/remove checks without editing package.json
#
# Phase order is intentional:
#   typecheck first  → fastest feedback, no DB needed
#   security next    → hardcoded secrets, eval(), .env tracking
#   coupling next     → circular deps, forbidden imports, dep-cruiser
#   structure next   → catches file-size / flat-dir / route placement
#   ci-workflow-policy → job needs/concurrency invariants for both CI platforms
#   test-isolation   → fixed /tmp + Date.now()-only temp races under LOS_TEST_GROUP
#   state-machine    → prevents direct status-update bypass
#   contracts        → bidirectional event ↔ route coverage
#   unwired exports  → catches implemented-but-not-wired antipattern
#   delete-safety     → catches deleted files still imported by surviving code
#   static-analysis   → in-repo AST rules (los scan), error-only hard gate
#   tests last       → most expensive, only runs if everything else passes
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

# --no-tests skips Phase 7 (turbo test). Used by CI's gate-fast job so the
# expensive DB-dependent workspace test runs in gate-test only after the fast
# feedback path succeeds.
SKIP_TESTS=0
for arg in "$@"; do
  if [[ "$arg" == "--no-tests" ]]; then
    SKIP_TESTS=1
  fi
done

GATE_FAILURES=0
START_TIME=$(date +%s)
TEST_OUTPUT=""

# Phase-timing capture for CI observability: every phase start/end is appended
# to a temp file (bash 3.2-safe, no associative arrays), then gate_summary()
# folds it into a JSON file (GATE_SUMMARY_FILE, default /tmp/los-gate-summary.json).
# Workflow steps print this file so step-level timings survive the Forgejo
# job-log API staleness (2026-08-09 PR #256) without relying on log reads.
SUMMARY_TMP="${TMPDIR:-/tmp}/los-gate-phases.$$"
SUMMARY_FILE="${GATE_SUMMARY_FILE:-/tmp/los-gate-summary.json}"
rm -f "$SUMMARY_TMP" "$SUMMARY_FILE"

cleanup_test_output() {
  if [ -n "$TEST_OUTPUT" ]; then
    rm -f -- "$TEST_OUTPUT"
  fi
  rm -f -- "$SUMMARY_TMP"
}

trap cleanup_test_output EXIT

# ── helpers ──────────────────────────────────────────────────

phase_start() {
  printf '\n%b━━━ Phase: %s ━━━%b\n' "$CYAN" "$1" "$NC"
  printf '    start: %s\n' "$(date '+%H:%M:%S')"
  printf 'START\t%s\t%s\n' "$1" "$(date +%s)" >> "$SUMMARY_TMP"
}

phase_ok() {
  printf '    %b✓ %s%b (%s)\n' "$GREEN" "$1" "$NC" "$(date '+%H:%M:%S')"
  printf 'END\t%s\t%s\tok\n' "$1" "$(date +%s)" >> "$SUMMARY_TMP"
}

phase_fail() {
  printf '    %b✗ %s%b (%s)\n' "$RED" "$1" "$NC" "$(date '+%H:%M:%S')"
  printf 'END\t%s\t%s\tfail\n' "$1" "$(date +%s)" >> "$SUMMARY_TMP"
  GATE_FAILURES=$((GATE_FAILURES + 1))
}

gate_summary() {
  local elapsed=$(($(date +%s) - START_TIME))
  printf '\n%b━━━ Gate Summary ━━━%b\n' "$CYAN" "$NC"
  printf '    phases run:  %s\n' "$PHASES_RUN"
  printf '    failures:    %d\n' "$GATE_FAILURES"
  printf '    elapsed:     %ds\n' "$elapsed"
  if [ "$GATE_FAILURES" -gt 0 ]; then
    printf '\n%bGATE FAILED — %d phase(s) failed%b\n' "$RED" "$GATE_FAILURES" "$NC"
    write_gate_summary "$elapsed"
    exit 1
  fi
  printf '\n%bGATE PASSED%b\n' "$GREEN" "$NC"
  write_gate_summary "$elapsed"
}

# Fold START/END phase records into a JSON summary file for CI step reporting.
write_gate_summary() {
  local elapsed="$1"
  if [ ! -f "$SUMMARY_TMP" ]; then
    return 0
  fi
  python3 - "$SUMMARY_TMP" "$SUMMARY_FILE" "$elapsed" "$PHASES_RUN" "$GATE_FAILURES" "$START_TIME" <<'PY'
import json, os, sys

tmp, out, elapsed, phases_run, failures, start_epoch = sys.argv[1:7]
phases = []
turbo_stats = {}
with open(tmp, encoding="utf-8") as fh:
    for line in fh:
        parts = line.rstrip("\n").split("\t")
        if parts[0] == "START":
            phases.append({"name": parts[1], "start_epoch": int(parts[2])})
        elif parts[0] == "END":
            # Close the last unclosed phase. phase_ok/phase_fail pass short
            # names ("typecheck") while phase_start passes full titles
            # ("Typecheck (turbo check)"), so match by order, not by name.
            for p in reversed(phases):
                if "end_epoch" not in p:
                    p["end_epoch"] = int(parts[2])
                    p["ok"] = parts[3] == "ok"
                    p["elapsed_sec"] = p["end_epoch"] - p["start_epoch"]
                    break
        elif parts[0] == "TURBO":
            # TURBO\t<cached>\t<total>\t<tasks>\t<hit lines>\t<miss lines>
            turbo_stats = {
                "cached": int(parts[1]),
                "total": int(parts[2]),
                "tasks": int(parts[3]),
                "cache_hits": int(parts[4]),
                "cache_misses": int(parts[5]),
            }
for p in phases:
    p.setdefault("elapsed_sec", None)
    p.setdefault("ok", None)
summary = {
    "gate": "los ci-gate.sh",
    "started_at_epoch": int(start_epoch),
    "elapsed_sec": int(elapsed),
    "phases_run": int(phases_run),
    "failures": int(failures),
    "phases": phases,
}
if turbo_stats:
    summary["turbo"] = turbo_stats
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    json.dump(summary, fh, ensure_ascii=False, indent=1)
print(f"    summary: {out}")
PY
  rm -f "$SUMMARY_TMP"
}

PHASES_RUN=0

# ── Phase 1: typecheck ─────────────────────────────────────

phase_start "Typecheck (turbo check)"
TYPECHECK_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/los-typecheck-output.XXXXXX")
if pnpm run _typecheck 2>&1 | tee "$TYPECHECK_OUTPUT"; then
  phase_ok "typecheck"
else
  phase_fail "typecheck"
fi
# Turbo cache observability: fold per-task hit/miss lines and the run summary
# ("Cached: N cached, M total" on turbo 2.9; "Tasks: ... N cached" on older)
# into the gate summary so CI can machine-verify the persisted runner cache
# (TURBO_CACHE_DIR) is actually hitting across commits — see
# docs/operations/ci-observability.md (B1 checklist).
turbo_summary="$(grep -E '^[[:space:]]*(Tasks|Cached):' "$TYPECHECK_OUTPUT" | tail -n 1 | sed -E 's/^[[:space:]]+//' || true)"
if [ -n "$turbo_summary" ]; then
  # Summary line shapes: turbo 2.9 "Cached: N cached, M total" (task count is
  # not printed separately); older turbo "Tasks: N successful, M total, K cached".
  read -r N1 N2 N3 <<< "$(printf '%s\n' "$turbo_summary" | grep -oE '[0-9]+' | tr '\n' ' ')" || true
  case "$turbo_summary" in
    Cached:*)
      TURBO_TASKS="${N2:-$N1}"
      TURBO_TOTAL="${N2:-$N1}"
      TURBO_CACHED="${N1:-0}"
      ;;
    Tasks:*)
      TURBO_TASKS="${N1:-0}"
      TURBO_TOTAL="${N2:-0}"
      TURBO_CACHED="${N3:-0}"
      ;;
    *)
      TURBO_TASKS=""
      TURBO_TOTAL=""
      TURBO_CACHED=""
      ;;
  esac
  if [ -n "${TURBO_TOTAL:-}" ]; then
    TURBO_HITS="$(grep -c 'cache hit' "$TYPECHECK_OUTPUT" || true)"
    TURBO_MISSES="$(grep -c 'cache miss' "$TYPECHECK_OUTPUT" || true)"
    printf 'TURBO\t%s\t%s\t%s\t%s\t%s\n' "${TURBO_CACHED:-0}" "$TURBO_TOTAL" "${TURBO_TASKS:-$TURBO_TOTAL}" "${TURBO_HITS:-0}" "${TURBO_MISSES:-0}" >> "$SUMMARY_TMP"
    printf '    %bturbo cache: %s/%s tasks cached (hit lines=%s, miss lines=%s)%b\n' "$CYAN" "${TURBO_CACHED:-0}" "$TURBO_TOTAL" "${TURBO_HITS:-0}" "${TURBO_MISSES:-0}" "$NC"
  fi
fi
rm -f "$TYPECHECK_OUTPUT"
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 2: security ─────────────────────────────────────────

phase_start "Security (hardcoded secrets, eval(), .env tracking, pnpm audit)"
if ./tools/check-security.sh; then
  phase_ok "security"
else
  phase_fail "security"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 3: structure ─────────────────────────────────────

phase_start "Structure (file-size, flat-dirs, route placement, dual-track)"
if ./tools/check-structure.sh; then
  phase_ok "structure"
else
  phase_fail "structure"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 3b: CI workflow policy ───────────────────────────

phase_start "CI workflow policy (job needs / concurrency invariants)"
if ./tools/check-ci-workflow-policy.sh; then
  phase_ok "ci-workflow-policy"
else
  phase_fail "ci-workflow-policy"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 3c: test isolation ───────────────────────────────

phase_start "Test isolation (parallel LOS_TEST_GROUP filesystem races)"
if ./tools/check-test-isolation.sh; then
  phase_ok "test-isolation"
else
  phase_fail "test-isolation"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 4: coupling ─────────────────────────────────────

phase_start "Coupling (circular deps, forbidden imports, cross-package boundaries)"
if ./tools/check-coupling.sh; then
  phase_ok "coupling"
else
  phase_fail "coupling"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 4: state-machine bypass ──────────────────────────

phase_start "State-machine bypass guard"
if ./tools/check-state-machine-bypass.sh; then
  phase_ok "state-machine-bypass"
else
  phase_fail "state-machine-bypass"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 5: contracts ─────────────────────────────────────

phase_start "Contracts (coverage + cross-references)"
if ./tools/check-contracts.sh; then
  phase_ok "contracts"
else
  phase_fail "contracts"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 5: delete-safety ─────────────────────────────────────

phase_start "Delete safety (deleted files still imported by surviving code)"
if ./tools/check-delete-safety.sh; then
  phase_ok "delete-safety"
else
  phase_fail "delete-safety"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 6: unwired exports ──────────────────────────────

phase_start "Unwired exports (check-unwired-exports + wiring-topology guard)"
if ./tools/check-unwired-exports.sh && pnpm --filter @los/gateway exec node --import tsx ../../tools/check-wiring-topology.ts; then
  phase_ok "unwired-exports"
else
  phase_fail "unwired-exports"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 7: static-analysis ──────────────────────────────

phase_start "Static analysis (los scan, in-repo AST rules, error-only gate)"
if ./tools/check-static-analysis.sh; then
  phase_ok "static-analysis"
else
  phase_fail "static-analysis"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Phase 8: tests ─────────────────────────────────────────

if [ "$SKIP_TESTS" -eq 1 ]; then
  printf '\n%b━━━ Phase: Tests (turbo test) ━━━%b\n' "$CYAN" "$NC"
  printf '    %b⊘ skipped (--no-tests) — run via gate-test job%b\n' "$YELLOW" "$NC"
else
  phase_start "Tests (turbo test)"
  TEST_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/los-test-output.XXXXXX")
  if pnpm run _test > "$TEST_OUTPUT" 2>&1; then
    TEST_EXIT=0
  else
    TEST_EXIT=$?
  fi
  tail -30 "$TEST_OUTPUT"  # always show tail so failures are visible
  if [ "$TEST_EXIT" -eq 0 ]; then
    # Still run known-failure check so stale FIXED baseline entries block.
    if ./tools/check-known-failures.sh < "$TEST_OUTPUT"; then
      phase_ok "tests"
    else
      printf '    %bStale known-failure baseline (FIXED entries) — gate blocked%b\n' "$RED" "$NC"
      phase_fail "tests (stale known-failure baseline)"
    fi
  else
    # Tests failed — but distinguish KNOWN (pre-existing, non-blocking) from
    # NEW (a real regression, blocking). If every failure is in the baseline,
    # the gate continues; any NEW failure blocks.
    if ./tools/check-known-failures.sh < "$TEST_OUTPUT"; then
      printf '    %bAll test failures are KNOWN — gate continues%b\n' "$YELLOW" "$NC"
      phase_ok "tests (known failures only)"
    else
      printf '    %bNEW test failures or unparsed failure output — gate blocked%b\n' "$RED" "$NC"
      phase_fail "tests (new failures beyond known-failure baseline)"
    fi
  fi
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Summary ─────────────────────────────────────────────────

gate_summary
