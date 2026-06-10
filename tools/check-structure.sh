#!/bin/bash
# check-structure.sh — structural health gate for los
# Usage: ./tools/check-structure.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WARNINGS=0
ERRORS=0
MAX_LINES=600
WARN_LINES=400
MAX_DIR_FILES=15

# Files exceeding MAX_LINES with active/in-progress split work.
# These produce warnings instead of errors (tracked, not forgotten).
ALLOWED_LARGE_FILES="
"

warn()  { echo -e "  \033[1;33m[WARN]\033[0m $*"; WARNINGS=$((WARNINGS + 1)); }
error() { echo -e "  \033[1;31m[ERROR]\033[0m $*"; ERRORS=$((ERRORS + 1)); }
header() { echo ""; echo -e "\033[0;36m--- $1 ---\033[0m"; }

is_allowed() {
  local file="$1"
  local rel="${file#$ROOT/}"
  for allowed in $ALLOWED_LARGE_FILES; do
    [[ "$rel" == "$allowed" ]] && return 0
  done
  return 1
}

# 1. Large files
header "Large files (>$MAX_LINES lines)"
while IFS= read -r line; do
  file=$(echo "$line" | awk '{print $2}')
  count=$(echo "$line" | awk '{print $1}')
  if is_allowed "$file"; then
    warn "$file ($count lines) — allowed, split in progress"
  else
    error "$file ($count lines) — exceeds $MAX_LINES line limit"
  fi
done < <(find "$ROOT/packages" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/test/*' ! -name '*.test.*' \
  -exec wc -l {} + 2>/dev/null | awk -v max="$MAX_LINES" \
  '$2 != "total" && $1 > max { print $1, $2 }')

# 1b. Warning-level large files (>WARN_LINES but <= MAX_LINES)
while IFS= read -r line; do
  file=$(echo "$line" | awk '{print $2}')
  count=$(echo "$line" | awk '{print $1}')
  if ! is_allowed "$file"; then
    warn "$file ($count lines) — exceeds $WARN_LINES line warning threshold"
  fi
done < <(find "$ROOT/packages" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/test/*' ! -name '*.test.*' \
  -exec wc -l {} + 2>/dev/null | awk -v min="$WARN_LINES" -v max="$MAX_LINES" \
  '$2 != "total" && $1 > min && $1 <= max { print $1, $2 }')

# 2. Flat directories
header "Flat directories (>$MAX_DIR_FILES files, no subdirs)"
while IFS= read -r -d '' d; do
  fc=$(find "$d" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | wc -l | tr -d ' ')
  [ "$fc" -gt "$MAX_DIR_FILES" ] || continue
  sd=$(find "$d" -maxdepth 1 -type d ! -name '.' ! -name '..' 2>/dev/null | wc -l | tr -d ' ')
  [ "$sd" -le 1 ] && warn "$d/ has $fc files, no subdirectories"
done < <(find "$ROOT/packages" -type d ! -name 'node_modules' ! -name 'dist' ! -path '*/node_modules/*' ! -path '*/dist/*' \
  -print0 2>/dev/null)

# 2b. Gateway route placement
header "Gateway route placement"
while IFS= read -r f; do
  error "$f — route modules belong in packages/gateway/src/routes/"
done < <(find "$ROOT/packages/gateway/src" -maxdepth 1 -type f -name '*-routes.ts' 2>/dev/null | sort)

# 2c. Web package dual-track prevention (no file sharing a name with a directory)
header "Web package dual-track (api.ts + api/, pages.tsx + pages/)"
while IFS= read -r f; do
  base=$(basename "$f")
  name="${base%.*}"  # remove extension
  dir=$(dirname "$f")
  if [ -d "$dir/$name" ]; then
    error "$f — file shares name with directory $dir/$name/; use $dir/$name/index.ts instead"
  fi
done < <(find "$ROOT/packages/web/src" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | sort)

# 3. Process-phase names
header "Process-phase naming (legacy/v2/temp/backup/new/old/tmp/bak)"
while IFS= read -r f; do
  error "$f"
done < <(find "$ROOT/packages" -type f \
  \( -name '*legacy*' -o -name '*v2*' -o -name '*temp*' -o -name '*backup*' \
     -o -name '*_new.*' -o -name '*_old.*' -o -name '*.new' -o -name '*.tmp' \
     -o -name '*.bak' -o -name '*~' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' \
  ! -path '*/archive/*' 2>/dev/null)

# 4. Direct infra bypass (imports of third-party libs outside infra/)
header "Direct third-party imports (should go through @los/infra)"
for pkg in "$ROOT/packages"/*/; do
  name=$(basename "$pkg")
  [ "$name" = "infra" ] && continue
  while IFS= read -r line; do
    error "$name: $line"
  done < <(grep -rn "from ['\"]better-sqlite3\|from ['\"]zod\|from ['\"]winston\|from ['\"]pino\|from ['\"]pg['\"]" \
    "$pkg/src/" --include='*.ts' 2>/dev/null | head -5)
done

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "\033[1;31m$ERRORS error(s), $WARNINGS warning(s)\033[0m"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "\033[1;33m$WARNINGS warning(s)\033[0m"
else
  echo -e "\033[0;32mClean\033[0m"
fi
