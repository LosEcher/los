#!/usr/bin/env bash
# los database backup — pg_dump snapshot into .los-runtime/db-backups/
# Roadmap R5: single supported path backup evidence (launchd primary).
# Usage: tools/db-backup.sh [label]
#   label  optional tag added to the snapshot name (default: manual)
# Retention: keeps the newest 14 snapshots, removes older ones.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$ROOT/.los-runtime/db-backups"
LABEL="${1:-manual}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/los-${STAMP}-${LABEL}.dump"

if [ ! -f "$ROOT/.env" ]; then
  echo "error: $ROOT/.env not found — cannot resolve DATABASE_URL" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ROOT/.env"
set +a
: "${DATABASE_URL:?DATABASE_URL is required}"

mkdir -p "$BACKUP_DIR"
PG_DUMP_BIN="${PG_DUMP:-}"
if [ -z "$PG_DUMP_BIN" ]; then
  for cand in \
    /opt/homebrew/opt/libpq/bin/pg_dump \
    /opt/homebrew/opt/postgresql@17/bin/pg_dump \
    /opt/homebrew/opt/postgresql@16/bin/pg_dump \
    "$(command -v pg_dump 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then PG_DUMP_BIN="$cand"; break; fi
  done
fi
if [ -z "$PG_DUMP_BIN" ]; then
  echo "error: pg_dump not found — install libpq or set PG_DUMP=/path/to/pg_dump" >&2
  exit 1
fi
"$PG_DUMP_BIN" --no-owner --no-privileges --format=custom "$DATABASE_URL" > "$OUT"

# Retention: newest 14 snapshots
ls -1t "$BACKUP_DIR"/los-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f

SIZE="$(du -h "$OUT" | cut -f1)"
echo "backup written: $OUT ($SIZE)"
echo "snapshots kept: $(ls -1 "$BACKUP_DIR"/los-*.dump 2>/dev/null | wc -l | tr -d ' ')"
