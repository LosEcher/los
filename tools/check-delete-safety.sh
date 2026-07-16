#!/usr/bin/env bash
# check-delete-safety.sh — Block deletion of .ts/.tsx files that are still imported
# by surviving code in the current tree. Compares current imports against
# deletions since origin/main to detect "deleted live code without rewiring
# importers". Using the working tree keeps local jj checks aligned with CI,
# where HEAD and the working tree are identical.
#
# Run from: projects/los/
# Exit: 0 = safe, 1 = unsafe deletion found (BLOCKS merge)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
ISSUES=0

green() { echo -e "  ${GREEN}✓${NC} $1"; }
red()   { echo -e "  ${RED}✗${NC} $1"; ISSUES=$((ISSUES + 1)); }

# ── Find deleted .ts/.tsx files (non-test) ──────────────────

DELETED=$(git diff --name-only --diff-filter=D origin/main -- 2>/dev/null | grep '\.tsx\?$' | grep -v '\.test\.' | grep -v '\.d\.ts$' || true)

if [ -z "$DELETED" ]; then
  green "No non-test .ts/.tsx files deleted — skip"
  exit 0
fi

echo "Checking $(echo "$DELETED" | wc -l | tr -d ' ') deleted file(s) against current importers..."

# ── For each deleted file, check if the current tree has surviving importers ──

for deleted_file in $DELETED; do
  RAW=$(node "$SCRIPT_DIR/check-delete-importers.mjs" "$deleted_file")

  if [ -z "$RAW" ]; then
    green "$deleted_file — no current importers found"
    continue
  fi

  # Filter out importers that are ALSO deleted in this branch
  SURVIVING=""
  for importer in $RAW; do
    if [ "$importer" = "$deleted_file" ]; then continue; fi
    if echo "$DELETED" | grep -qx "$importer"; then continue; fi
    SURVIVING="$SURVIVING $importer"
  done

  if [ -n "$SURVIVING" ]; then
    red "$deleted_file — SURVIVING importers in current tree:"
    for imp in $SURVIVING; do
      echo "      $imp"
    done
  else
    green "$deleted_file"
  fi
done

echo ""
if [ "$ISSUES" -eq 0 ]; then
  echo -e "${GREEN}✓ Delete safety — all deleted files are genuinely unreferenced${NC}"
else
  echo -e "${RED}✗ Delete safety FAILED — $ISSUES file(s) still imported by surviving code${NC}"
  echo ""
  echo "  These files were deleted but are still used at runtime."
  echo "  Either: (a) restore the file, or (b) remove + rewire the importers first."
  exit 1
fi
