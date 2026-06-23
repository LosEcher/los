#!/usr/bin/env bash
# check-security.sh — security scan for los CI gate
# Scans source files for hardcoded secrets, credentials, and unsafe patterns.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WARNINGS=0
ERRORS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

warn()  { echo -e "  ${YELLOW}[WARN]${NC} $*"; WARNINGS=$((WARNINGS + 1)); }
err()   { echo -e "  ${RED}[ERROR]${NC} $*"; ERRORS=$((ERRORS + 1)); }
header() { echo ""; echo -e "${CYAN}--- $1 ---${NC}"; }
ok()    { echo -e "  ${GREEN}[OK]${NC} $*"; }

# ── 1. Hardcoded secrets in source files ─────────────────────
header "Hardcoded secrets scan"
# Pattern matches keys named secret/token/password/api_key/credential etc.
# Same regex as packages/agent/src/session-events.ts SECRET_KEY_RE
SECRET_KEY_PATTERN='(secret|token|password|passphrase|api[-_]?key|authorization|cookie|credential|passwd|pwd)'

# Scan for assignment-like patterns that look like hardcoded secrets:
#   const x = "actual-value"
#   let y = 'actual-value'
#   KEY=value (in shell/config files)
FOUND_SECRETS=0
while IFS= read -r match; do
  # Skip false positives: test fixtures, .example files, comments, env-var reads
  if echo "$match" | grep -qE '(\.test\.|\.example|\.d\.ts|node_modules|dist/|\.bak)'; then
    continue
  fi
  if echo "$match" | grep -qE '^\s*//|^\s*#|^\s*\*|process\.env\.|readEnv|getEnv|env\s*\['; then
    continue
  fi
  # Skip known test tokens and placeholders, and CI env var references
  if echo "$match" | grep -qE '(test-token|TEST_TOKEN|REDACTED|xxxx|changeme|example|placeholder|your-.*-here|\$\{|secrets\.)'; then
    continue
  fi
  echo "  ${match}"
  FOUND_SECRETS=$((FOUND_SECRETS + 1))
done < <(git -C "$ROOT" grep -n -i -E "$SECRET_KEY_PATTERN" \
  -- ':!node_modules/' \
  -- ':!dist/' \
  -- ':!*.lock' \
  -- ':!*.log' \
  -- ':!*.map' \
  -- ':!*.json' \
  -- '*.ts' '*.tsx' '*.sh' '*.env*' '*.yml' '*.yaml' '*.md' \
  2>/dev/null | grep -vE '(binary file matches|^$)' || true)

if [ "$FOUND_SECRETS" -gt 0 ]; then
  warn "$FOUND_SECRETS potential hardcoded secret(s) found — review manually"
else
  ok "No hardcoded secrets detected"
fi

# ── 2. .env file in git tracking ─────────────────────────────
header ".env file tracking check"
ENV_FILES=$(git -C "$ROOT" ls-files -- '*.env' '.env' 2>/dev/null | grep -v '.env.example' | grep -v '.env.local' || true)
if [ -n "$ENV_FILES" ]; then
  while IFS= read -r envfile; do
    if [ -n "$envfile" ]; then
      err "$envfile is tracked by git — add to .gitignore"
    fi
  done <<< "$ENV_FILES"
else
  ok "No .env files tracked by git"
fi

# ── 3. eval() calls in TypeScript source ─────────────────────
header "eval() usage in source"
EVAL_COUNT=$(git -C "$ROOT" grep -n '\beval\s*(' \
  -- ':!node_modules/' \
  -- ':!dist/' \
  -- '*.ts' '*.tsx' '*.js' \
  2>/dev/null | grep -cvE '(binary file matches|^$|^\s*//|^\s*\*|^\s*\#|template literals|eval\(s\)|eval\()' || true)
if [ "$EVAL_COUNT" -gt 0 ]; then
  err "$EVAL_COUNT eval() call(s) found — review for removal"
  git -C "$ROOT" grep -n '\beval\s*(' \
    -- ':!node_modules/' \
    -- ':!dist/' \
    -- '*.ts' '*.tsx' '*.js' \
    2>/dev/null | grep -vE '(binary file matches|^$|^\s*//|^\s*\*)' | while IFS= read -r line; do
      if [ -n "$line" ]; then
        echo "  $line"
      fi
    done
else
  ok "No eval() calls found"
fi

# ── 4. npm/pnpm audit check (if dependencies installed) ──────
header "Dependency vulnerability audit"
if [ -f "$ROOT/pnpm-lock.yaml" ] || [ -f "$ROOT/package-lock.json" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    AUDIT_OUTPUT=$(cd "$ROOT" && pnpm audit --json 2>/dev/null || true)
    if echo "$AUDIT_OUTPUT" | grep -q '"severity":"critical"'; then
      CRIT_COUNT=$(echo "$AUDIT_OUTPUT" | grep -c '"severity":"critical"' || true)
      err "$CRIT_COUNT critical vulnerability(s) found — run 'pnpm audit' for details"
    else
      ok "No critical vulnerabilities detected"
    fi
  else
    warn "pnpm not available — skipping dependency audit"
  fi
else
  warn "No lockfile found — skipping dependency audit"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo -e "${CYAN}--- Security Scan Summary ---${NC}"
echo "  errors:   $ERRORS"
echo "  warnings: $WARNINGS"

if [ "$ERRORS" -gt 0 ]; then
  echo -e "  ${RED}SECURITY GATE FAILED — $ERRORS error(s)${NC}"
  exit 1
fi
echo -e "  ${GREEN}SECURITY GATE PASSED${NC}"
