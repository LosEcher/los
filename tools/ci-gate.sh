#!/usr/bin/env bash
# ci-gate.sh — single CI gate for los (typecheck → structure → state-machine → contracts → unwired → test)
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
#   state-machine    → prevents direct status-update bypass
#   contracts        → bidirectional event ↔ route coverage
#   unwired exports  → catches implemented-but-not-wired antipattern
#   delete-safety     → catches deleted files still imported by surviving code
#   tests last       → most expensive, only runs if everything else passes
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

GATE_FAILURES=0
START_TIME=$(date +%s)

# ── helpers ──────────────────────────────────────────────────

phase_start() {
  printf '\n%b━━━ Phase: %s ━━━%b\n' "$CYAN" "$1" "$NC"
  printf '    start: %(%H:%M:%S)T\n' -1
}

phase_ok() {
  printf '    %b✓ %s%b (%(%H:%M:%S)T)\n' "$GREEN" "$1" "$NC" -1
}

phase_fail() {
  printf '    %b✗ %s%b (%(%H:%M:%S)T)\n' "$RED" "$1" "$NC" -1
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
    exit 1
  fi
  printf '\n%bGATE PASSED%b\n' "$GREEN" "$NC"
}

PHASES_RUN=0

# ── Phase 1: typecheck ─────────────────────────────────────

phase_start "Typecheck (turbo check)"
if pnpm run _typecheck; then
  phase_ok "typecheck"
else
  phase_fail "typecheck"
fi
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

# ── Phase 7: tests ─────────────────────────────────────────

phase_start "Tests (turbo test)"
if pnpm run _test; then
  phase_ok "tests"
else
  phase_fail "tests"
fi
PHASES_RUN=$((PHASES_RUN + 1))

# ── Summary ─────────────────────────────────────────────────

gate_summary
