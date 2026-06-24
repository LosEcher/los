#!/usr/bin/env bash
# check-coupling.sh — dependency coupling gate for los CI
# Uses dependency-cruiser to detect circular dependencies and cross-package boundary violations.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0
WARNINGS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

warn()  { echo -e "  ${YELLOW}[WARN]${NC} $*"; WARNINGS=$((WARNINGS + 1)); }
err()   { echo -e "  ${RED}[ERROR]${NC} $*"; ERRORS=$((ERRORS + 1)); }
header() { echo ""; echo -e "${CYAN}--- $1 ---${NC}"; }
ok()    { echo -e "  ${GREEN}[OK]${NC} $*"; }

# ── 1. Circular dependency detection ───────────────────────────
header "Circular dependency check"

if command -v npx >/dev/null 2>&1; then
  CRUISER_OUTPUT=$(cd "$ROOT" && npx --yes dependency-cruiser \
    --config .dependency-cruiser.json \
    --output-type text \
    --no-metrics \
    --include-only "^packages/" \
    src packages 2>&1) || true

  if echo "$CRUISER_OUTPUT" | grep -q "no-circular"; then
    echo "$CRUISER_OUTPUT" | grep -A2 "no-circular" | while IFS= read -r line; do
      if [ -n "$line" ]; then
        err "$line"
      fi
    done
  else
    ok "No circular dependencies detected"
  fi
else
  warn "npx not available — skipping dependency-cruiser check"
fi

# ── 1b. @los/infra is a leaf (no upward @los/* imports) ─────────
# infra must not depend on any other @los/* package — it is the foundational
# cross-cutting layer. Uses grep -rEn (filesystem) rather than `git grep`,
# which is unreliable in jj-collocated working copies. The broader 'cross-
# cutting concerns through @los/infra' invariant (no direct pg/zod/winston/
# pino/better-sqlite3 in non-infra packages) is enforced by check-structure.sh §7.
header "@los/infra leaf check (no @los/* imports in infra)"
INFRA_UPWARD=0
while IFS= read -r match; do
  err "$match"
  INFRA_UPWARD=$((INFRA_UPWARD + 1))
done < <(grep -rEn "from ['\"]@los/(agent|memory|gateway|executor|cli|web|telegram-bot|wechat-bot|media|input-preprocessor)" \
  "$ROOT/packages/infra/src" --include='*.ts' 2>/dev/null || true)
if [ "$INFRA_UPWARD" -eq 0 ]; then
  ok "@los/infra has no upward @los/* imports"
fi

# ── 2. Forbidden import list check ─────────────────────────────
header "Forbidden import patterns"

FORBIDDEN_PATTERNS=0
# Check for imports from packages we explicitly want to avoid
# These patterns mirror AP1-AP9 from AGENTS.md
while IFS= read -r match; do
  if echo "$match" | grep -qE '(node_modules|dist/|\.test\.)'; then
    continue
  fi
  echo "  $match"
  FORBIDDEN_PATTERNS=$((FORBIDDEN_PATTERNS + 1))
done < <(git -C "$ROOT" grep -n "from ['\"].*updateTaskRun\b\|from ['\"].*updateTaskRunFields\b\|from ['\"].*updateRunSpecStatus\b" \
  -- ':!node_modules/' \
  -- ':!dist/' \
  -- ':!tools/check-state-machine-bypass.sh' \
  -- ':!packages/agent/src/execution-store.ts' \
  -- ':!packages/agent/src/execution-persistence.ts' \
  -- ':!packages/agent/src/task-runs.ts' \
  -- ':!packages/agent/src/todos.ts' \
  -- ':!packages/agent/src/ga-loop-fixes.ts' \
  -- ':!packages/agent/src/governance-runtime-cleanup.ts' \
  -- ':!packages/agent/src/execution-transitions.ts' \
  -- ':!packages/agent/src/**/test*' \
  -- '*.ts' '*.tsx' \
  2>/dev/null || true)

if [ "$FORBIDDEN_PATTERNS" -gt 0 ]; then
  err "$FORBIDDEN_PATTERNS forbidden import(s) of state-mutation APIs"
  echo "  These functions must only be called through transitionExecutionState()."
  echo "  See AGENTS.md AP1 for details."
else
  ok "No forbidden imports detected"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo -e "${CYAN}--- Coupling Scan Summary ---${NC}"
echo "  errors:   $ERRORS"
echo "  warnings: $WARNINGS"

if [ "$ERRORS" -gt 0 ]; then
  echo -e "  ${RED}COUPLING GATE FAILED — $ERRORS error(s)${NC}"
  exit 1
fi
echo -e "  ${GREEN}COUPLING GATE PASSED${NC}"
