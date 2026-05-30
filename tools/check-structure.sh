#!/bin/bash
# check-structure.sh — structural health gate for los
# Usage: ./tools/check-structure.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WARNINGS=0
MAX_LINES=600
MAX_DIR_FILES=15

warn() { echo -e "  \033[1;33m[WARN]\033[0m $*"; WARNINGS=$((WARNINGS + 1)); }
header() { echo ""; echo -e "\033[0;36m--- $1 ---\033[0m"; }

# 1. Large files
header "Large files (>$MAX_LINES lines)"
find "$ROOT/packages" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/test/*' ! -name '*.test.*' \
  -exec wc -l {} + 2>/dev/null | awk -v max="$MAX_LINES" \
  '$2 != "total" && $1 > max { printf "  \033[1;33m[WARN]\033[0m %s (%d lines)\n", $2, $1; c++ } END { exit c }' || WARNINGS=$((WARNINGS + 1))

# 2. Flat directories
header "Flat directories (>$MAX_DIR_FILES files, no subdirs)"
find "$ROOT/packages" -type d ! -name 'node_modules' ! -name 'dist' ! -path '*/node_modules/*' ! -path '*/dist/*' \
  -print0 2>/dev/null | while IFS= read -r -d '' d; do
  fc=$(find "$d" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')
  [ "$fc" -gt "$MAX_DIR_FILES" ] || continue
  sd=$(find "$d" -maxdepth 1 -type d ! -name '.' ! -name '..' 2>/dev/null | wc -l | tr -d ' ')
  [ "$sd" -le 1 ] && warn "$d/ has $fc files, no subdirectories"
done

# 3. Process-phase names
header "Process-phase naming (legacy/v2/temp/backup/_new/_old)"
find "$ROOT/packages" -type f \
  \( -name '*legacy*' -o -name '*v2*' -o -name '*temp*' -o -name '*backup*' \
     -o -name '*_new.*' -o -name '*_old.*' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/archive/*' 2>/dev/null | while read -r f; do
  warn "$f"
done

# 4. Direct infra bypass (imports of third-party libs outside infra/)
header "Direct third-party imports (should go through @los/infra)"
for pkg in "$ROOT/packages"/*/; do
  name=$(basename "$pkg")
  [ "$name" = "infra" ] && continue
  grep -rn "from ['\"]better-sqlite3\|from ['\"]zod\|from ['\"]winston\|from ['\"]pino" \
    "$pkg/src/" --include='*.ts' 2>/dev/null | head -5 | while read -r line; do
    warn "$name: $line"
  done
done

echo ""
[ "$WARNINGS" -gt 0 ] && echo -e "\033[1;33m$WARNINGS warning(s)\033[0m" || echo -e "\033[0;32mClean\033[0m"
