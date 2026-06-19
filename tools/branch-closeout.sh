#!/usr/bin/env bash
# Read-only branch closeout check — never writes, pushes, or merges.
# Run from: projects/los/
# Exit code 0 = all checks pass, 1 = issues found (review before merge).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ISSUES=0

green() { echo -e "\033[32m  ✓ $1\033[0m"; }
red()   { echo -e "\033[31m  ✗ $1\033[0m"; ISSUES=$((ISSUES + 1)); }
warn()  { echo -e "\033[33m  ⚠ $1\033[0m"; }
info()  { echo -e "\033[37m  ℹ $1\033[0m"; }
section() { echo ""; echo -e "\033[1m$1\033[0m"; }

# ── 1. jj status ────────────────────────────────────────

section "1. jj status"
if command -v jj &>/dev/null && jj root 2>/dev/null | grep -q .; then
  if jj status 2>&1 | grep -q "The working copy is clean"; then
    green "Working copy clean"
  else
    warn "Working copy has uncommitted changes:"
    jj status 2>&1 || true
    ISSUES=$((ISSUES + 1))
  fi
else
  warn "jj not available or not in a jj repo — skipping status check"
fi

# ── 2. Diff scope ────────────────────────────────────────

section "2. Diff scope"
if command -v jj &>/dev/null && jj root 2>/dev/null | grep -q .; then
  CHANGES=$(jj log -r 'main..@' --no-graph -T '' 2>/dev/null || true)
  if [ -z "$CHANGES" ]; then
    info "No changes on top of main (or main is the current change)"
  else
    echo "  Changed files vs main:"
    jj diff -r 'main..@' --summary 2>/dev/null || warn "Could not compute diff summary"
    STATS=$(jj diff -r 'main..@' --stat 2>/dev/null || true)
    if [ -n "$STATS" ]; then
      echo "$STATS" | tail -1
    fi
  fi
else
  # Fallback: git
  if git rev-parse --git-dir &>/dev/null; then
    git diff --stat origin/main...HEAD 2>/dev/null || warn "Could not compute git diff"
  fi
fi

# ── 3. Local gate ────────────────────────────────────────

section "3. Local gate"
GATE_CMD=""
if [ -f "package.json" ] && grep -q '"gate"' package.json 2>/dev/null; then
  GATE_CMD="pnpm run gate"
elif [ -f "Makefile" ] && grep -q '^gate:' Makefile 2>/dev/null; then
  GATE_CMD="make gate"
fi

if [ -n "$GATE_CMD" ]; then
  echo "  Running: $GATE_CMD"
  if eval "$GATE_CMD" 2>&1; then
    green "Local gate passed"
  else
    red "Local gate failed — fix before merge"
  fi
else
  warn "No gate command found — running checks defined in tools/"
  # Fall back to individual checks
  for script in tools/check-*.sh; do
    if [ -x "$script" ]; then
      echo "  Running: $script"
      bash "$script" 2>&1 || warn "$script returned non-zero"
    fi
  done
fi

# ── 4. Remote SHA match ──────────────────────────────────

section "4. Remote SHA match"
if command -v jj &>/dev/null && jj root 2>/dev/null | grep -q .; then
  LOCAL_SHA=$(jj log -r '@' --no-graph -T 'commit_id.shortest(8)' 2>/dev/null || echo "")
  REMOTE_REF=$(jj git remote list 2>/dev/null | head -1 | awk '{print $1}' || echo "origin")
  jj git fetch 2>/dev/null || warn "Could not fetch from remote"
  REMOTE_MAIN_SHA=$(jj log -r "main@$REMOTE_REF" --no-graph -T 'commit_id.shortest(8)' 2>/dev/null || echo "")
  if [ -n "$LOCAL_SHA" ]; then
    info "Local @ commit: $LOCAL_SHA"
  fi
  if [ -n "$REMOTE_MAIN_SHA" ]; then
    info "Remote main commit: $REMOTE_MAIN_SHA"
  fi

  # Check if @ has been pushed (its commits exist on the remote)
  if [ -n "$LOCAL_SHA" ]; then
    PUSHED=$(jj log -r "main..@ & remote_branches()" --no-graph -T '' 2>/dev/null || true)
    if [ -n "$PUSHED" ]; then
      green "Current change appears pushed to remote"
    else
      warn "Current change may not be pushed to remote — verify with 'jj git push --dry-run'"
    fi
  fi
else
  warn "jj not available — check remote SHA manually"
fi

# ── 5. Remote CI ─────────────────────────────────────────

section "5. Remote CI"
if command -v gh &>/dev/null; then
  REPO=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]\(.*\)\.git|\1|' || echo "")
  if [ -z "$REPO" ]; then
    REPO="LosEcher/los"
  fi
  SHA=$(jj log -r '@' --no-graph -T 'commit_id' 2>/dev/null || git rev-parse HEAD 2>/dev/null || echo "")
  if [ -n "$SHA" ]; then
    echo "  Checking CI for SHA: ${SHA:0:8}"
    RUNS=$(gh run list --repo "$REPO" --commit "$SHA" --limit 5 \
      --json databaseId,status,conclusion,workflowName,headSha,createdAt 2>/dev/null || echo "[]")
    if [ "$RUNS" != "[]" ] && [ -n "$RUNS" ]; then
      echo "$RUNS" | python3 -c "
import json,sys
runs=json.load(sys.stdin)
for r in runs:
  status=r.get('status','?')
  conclusion=r.get('conclusion','pending')
  sha=r.get('headSha','')[:8]
  name=r.get('workflowName','?')
  print(f'  [{status}/{conclusion}] {name} @ {sha}')
" 2>/dev/null || echo "$RUNS"
      # Check if gate job succeeded
      GATE_OK=$(echo "$RUNS" | python3 -c "
import json,sys
runs=json.load(sys.stdin)
ok=any(r.get('conclusion')=='success' and 'gate' in r.get('workflowName','').lower() for r in runs)
print('true' if ok else 'false')
" 2>/dev/null || echo "false")
      if [ "$GATE_OK" = "true" ]; then
        green "Remote CI gate passed for this commit"
      else
        warn "No green CI gate found for this commit — verify before merge"
      fi
    else
      warn "No CI runs found for this commit — push or trigger CI first"
    fi
  else
    warn "Could not determine current commit SHA"
  fi
else
  warn "gh CLI not available — check CI manually: https://github.com/LosEcher/los/actions"
fi

# ── Summary ──────────────────────────────────────────────

section "Summary"
if [ "$ISSUES" -eq 0 ]; then
  green "All closeout checks pass — ready for merge review"
else
  warn "$ISSUES issue(s) found — review before merging"
fi

# ── 6. Stale remote branches ────────────────────────────

section "6. Stale remote branches"
STALE_BRANCHES=$(git branch -r --merged origin/main 2>/dev/null | grep -v 'origin/HEAD\|origin/main' | sed 's/^[[:space:]]*//' || true)
if [ -n "$STALE_BRANCHES" ]; then
  STALE_COUNT=$(echo "$STALE_BRANCHES" | wc -l | tr -d ' ')
  warn "$STALE_COUNT stale remote branch(es) merged into main but not deleted:"
  echo "$STALE_BRANCHES" | while read -r branch; do
    echo "    $branch"
  done
  echo ""
  echo "  To delete: git push origin --delete <branch>"
  ISSUES=$((ISSUES + 1))
else
  green "No stale remote branches"
fi

exit 0  # warn only, never block
