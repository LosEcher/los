#!/usr/bin/env bash
# Detect "implemented but not wired" antipattern.
# Checks that:
#   1. Every register*Routes import in server.ts is actually called.
#   2. Every route file in routes/ is imported somewhere reachable from server.ts.
#   3. Every export function register* in routes/ is called at least once in the
#      gateway entry path (server.ts → register*Routes(...)).
# Run from: projects/los/
# Exit code 0 = no issues, 1 = unwired exports found (warn, not block).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ISSUES=0

green() { echo -e "\033[32m  ✓ $1\033[0m"; }
red()   { echo -e "\033[31m  ✗ $1\033[0m"; ISSUES=$((ISSUES + 1)); }
warn()  { echo -e "\033[33m  ⚠ $1\033[0m"; }
section() { echo ""; echo -e "\033[1m$1\033[0m"; }

GATEWAY_DIR="$PROJECT_DIR/packages/gateway/src"
SERVER_TS="$GATEWAY_DIR/server.ts"
ROUTES_DIR="$GATEWAY_DIR/routes"

# ── 1. Imported but never called in server.ts ───────────

section "1. Register imports called in server.ts"
if [ -f "$SERVER_TS" ]; then
  # Extract imported register* function names from import statements (line must start with import)
  IMPORTS=$(grep "^import" "$SERVER_TS" | grep -oE "register[A-Za-z]+" | sort -u)
  for fn in $IMPORTS; do
    # Skip non-route helpers
    if echo "$fn" | grep -qE "registerSecurityHeaders|registerAuthMiddleware|registerBuiltinTools|registerSpawnAgent|registerChat"; then
      continue
    fi
    # Check if it's actually called (not just imported)
    if grep -q "$fn(" "$SERVER_TS" || grep -q "$fn (" "$SERVER_TS"; then
      green "$fn called in server.ts"
    else
      red "$fn imported but never called in server.ts"
    fi
  done
else
  warn "server.ts not found at $SERVER_TS"
fi

# ── 2. Route files not imported by any gateway source ────

section "2. Route files reachable from gateway sources"
if [ -d "$ROUTES_DIR" ]; then
  # Direct check: for each route file, see if it's imported anywhere in gateway/src
  # Use the full .ts path stem (without extension) to match imports with .js extension
  for rf in $(find "$ROUTES_DIR" -name "*.ts" ! -name "*.test.ts" ! -name "*.d.ts" -print | sort); do
    basename_noext=$(basename "$rf" .ts)
    dirname_rf=$(basename "$(dirname "$rf")")
    # Build import patterns: e.g. ".../integration-routes.js" or "../integration-routes.js"
    found=false
    for src in $(find "$GATEWAY_DIR" -name "*.ts" ! -name "*.test.ts" ! -name "*.d.ts" -print); do
      if grep -q "${basename_noext}\.js" "$src" 2>/dev/null; then
        found=true
        break
      fi
    done
    if $found; then
      green "$(basename "$rf") reachable from gateway sources"
    else
      red "$(basename "$rf") not imported by any gateway source — may be dead code"
    fi
  done
else
  warn "routes directory not found at $ROUTES_DIR"
fi

# ── 3. Exported register functions not called anywhere ───

section "3. register* functions called at least once"
if [ -d "$ROUTES_DIR" ]; then
  # Find all register* function regex matches ANYWHERE in gateway sources
  grep -rn "export function register[A-Za-z]*" "$ROUTES_DIR" --include="*.ts" | \
    grep -v "\.test\." | while read -r line; do
    fn=$(echo "$line" | sed 's/.*export function \(register[A-Za-z]*\).*/\1/')
    file=$(echo "$line" | cut -d: -f1)
    # Search all gateway sources for calls to this function (not just import)
    if grep -rq "$fn\b" "$GATEWAY_DIR" --include="*.ts" 2>/dev/null; then
      green "$fn defined in $(basename "$file") — called"
    else
      red "$fn defined in $(basename "$file") — never called (unwired route)"
    fi
  done
fi

# ── Summary ─────────────────────────────────────────────

section "Summary"
if [ "$ISSUES" -eq 0 ]; then
  green "All route registrations wired — no unwired exports detected"
else
  red "$ISSUES unwired export(s) found — wire to server.ts or remove dead code"
  exit 1
fi
