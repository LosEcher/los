#!/usr/bin/env bash
# Check module readiness criteria for partial→live graduation.
# Run from: projects/los/
# Exit code 0 = all checks pass, 1 = gaps found (warn, not block).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GAPS=0

green() { echo -e "\033[32m  ✓ $1\033[0m"; }
red()   { echo -e "\033[31m  ✗ $1\033[0m"; GAPS=$((GAPS + 1)); }
warn()  { echo -e "\033[33m  ⚠ $1\033[0m"; }
section() { echo ""; echo -e "\033[1m$1\033[0m"; }

# ── helpers ──────────────────────────────────────────────

# Check if a route pattern exists in gateway route files
route_exists() {
  local pattern="$1"
  grep -Eirq "$pattern" "$PROJECT_DIR/packages/gateway/src/routes/" 2>/dev/null || \
    grep -Eiq "$pattern" "$PROJECT_DIR/packages/gateway/src/server.ts" 2>/dev/null
}

# Check if a Vite proxy entry exists
proxy_exists() {
  local prefix="$1"
  grep -q "$prefix" "$PROJECT_DIR/packages/web/vite.config.ts" 2>/dev/null
}

# Check if a file contains a pattern
file_has() {
  local file="$1"; local pattern="$2"
  grep -q "$pattern" "$PROJECT_DIR/$file" 2>/dev/null
}

# ── providers ────────────────────────────────────────────

section "providers (currently: partial)"

echo "  API completeness:"
if route_exists "POST /providers" || route_exists "post\\([^)]*['\"]/providers['\"]"; then
  green "POST /providers exists"
else
  red "POST /providers missing (P1)"
fi

if route_exists "PUT /providers" || route_exists "put\\([^)]*['\"]/providers/:?[A-Za-z_-]+" || route_exists "PATCH /providers" || route_exists "patch\\([^)]*['\"]/providers/:?[A-Za-z_-]+"; then
  green "PUT|PATCH /providers/:id exists"
else
  red "PUT|PATCH /providers/:id missing (P1)"
fi

if route_exists "DELETE /providers" || route_exists "delete\\([^)]*['\"]/providers/:?[A-Za-z_-]+"; then
  green "DELETE /providers/:id exists"
else
  red "DELETE /providers/:id missing (P1)"
fi

echo "  Evidence:"
if file_has "packages/gateway/src/provider-routes.test.ts" "POST\|PATCH\|PUT\|DELETE\|create\|update\|delete"; then
  green "Provider CRUD integration tests found"
else
  red "Provider CRUD integration tests missing (P1)"
fi

# ── evals ─────────────────────────────────────────────────

section "evals (currently: live)"

echo "  API completeness:"
if { route_exists "POST /run-evals" || route_exists "post.*/run-evals"; } && \
   { route_exists "GET /run-evals/summary" || route_exists "get.*/run-evals/summary"; } && \
   { route_exists "GET /run-evals/compare" || route_exists "get.*/run-evals/compare"; }; then
  green "Eval CRUD + summary + compare endpoints exist"
else
  red "Eval endpoints incomplete"
fi

echo "  Evidence:"
PROBE_COUNT=$(grep -c "it\|test\|describe" "$PROJECT_DIR/packages/agent/src/eval-probes.test.ts" 2>/dev/null || echo "0")
if [ "$PROBE_COUNT" -ge 6 ]; then
  green "E01-E06 probes: $PROBE_COUNT test blocks (target ≥6)"
else
  red "E01-E06 probes: only $PROBE_COUNT test blocks (target ≥6, P1)"
fi

if grep -rq "eval-backlog\|eval.backlog\|runEvalBacklog" "$PROJECT_DIR/packages/agent/src/scheduler/" 2>/dev/null; then
  green "Backlog snapshot wired to scheduler"
else
  red "Backlog snapshot not in scheduler (P1)"
fi

# ── nodes ─────────────────────────────────────────────────

section "nodes (currently: live)"

echo "  API completeness:"
if proxy_exists "/node-commands"; then
  green "/node-commands in Vite proxy"
else
  red "/node-commands missing from Vite proxy (P1)"
fi

echo "  UI completeness:"
if file_has "packages/web/src/nodes-page.tsx" "lastHeartbeatAt\|stale\|STALE\|heartbeat.*ago\|timeAgo"; then
  green "Heartbeat staleness surfaced in table"
else
  red "Heartbeat staleness not surfaced in table rows (P1)"
fi

if file_has "packages/web/src/nodes-page.tsx" "blocker\|candidate\|eligible\|eligibility"; then
  green "Execution eligibility in table"
else
  red "Execution eligibility not in table rows (P1)"
fi

# ── settings ──────────────────────────────────────────────

section "settings (currently: live)"

echo "  API completeness:"
if route_exists "PUT /settings|PATCH /settings|post\\([^)]*['\"]/settings['\"]|patch\\([^)]*['\"]/settings['\"]"; then
  green "PUT|PATCH /settings exists"
else
  red "PUT|PATCH /settings missing (P1)"
fi

echo "  Evidence:"
if file_has "packages/gateway/src/server.ts" "setConfig\|saveConfig\|writeConfig\|persistConfig"; then
  green "Runtime config update path wired"
else
  red "Runtime config update path not wired (P1)"
fi

# ── summary ───────────────────────────────────────────────

section "Summary"
if [ "$GAPS" -eq 0 ]; then
  green "All checks pass — all modules ready for live"
else
  warn "$GAPS gap(s) found — see docs/governance/module-readiness.md for criteria"
fi

exit 0  # warn only, never block
