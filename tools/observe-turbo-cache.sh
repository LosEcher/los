#!/usr/bin/env bash
# Report turbo cache directory capacity on the CI runner (sibling of
# observe-pnpm-store.sh). Verifies the persisted TURBO_CACHE_DIR volume is
# accumulating entries across jobs — B1 of docs/operations/ci-observability.md.
#
# Cache-hit verification is separate and machine-readable: ci-gate.sh phase 1
# folds the turbo run summary ("Cached: N cached, M total") into the gate
# summary JSON ("turbo" block, emitted by the workflow's gate-summary step).
# This tool only answers "is the directory there and how big is it".
set -euo pipefail

format="text"
cache_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) format="json" ;;
    --path)
      shift
      cache_path="${1:-}"
      ;;
    --help|-h)
      echo "usage: $0 [--json] [--path PATH]"
      echo "  default path: \$TURBO_CACHE_DIR, else <repo>/.turbo"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$cache_path" ]; then
  cache_path="${TURBO_CACHE_DIR:-}"
fi
if [ -z "$cache_path" ]; then
  cache_path="$(cd "$(dirname "$0")/.." && pwd)/.turbo"
fi

if [ ! -d "$cache_path" ]; then
  if [ "$format" = "json" ]; then
    printf '{"path":"%s","exists":false}\n' "$cache_path"
  else
    echo "turbo cache directory not found: $cache_path" >&2
  fi
  exit 2
fi

cache_kib="$(du -sk "$cache_path" | awk '{print $1}')"
# One .tar.zst per cached task run (plus -manifest.json/-meta.json peers).
# Layout: TURBO_CACHE_DIR holds entries directly; the default <repo>/.turbo
# nests them under <repo>/.turbo/cache.
entries_dir="$cache_path"
if [ -d "$cache_path/cache" ]; then
  entries_dir="$cache_path/cache"
fi
entries="$(find "$entries_dir" -maxdepth 1 -name '*.tar.zst' 2>/dev/null | wc -l | tr -d ' ')"
read -r fs_total_kib fs_used_kib fs_available_kib fs_used_percent < <(
  df -Pk "$cache_path" | awk 'NR == 2 { gsub(/%/, "", $5); print $2, $3, $4, $5 }'
)
observed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
host="$(hostname 2>/dev/null || printf 'unknown')"

if [ "$format" = "json" ]; then
  OBSERVED_AT="$observed_at" HOST_NAME="$host" CACHE_PATH="$cache_path" \
  CACHE_KIB="$cache_kib" ENTRIES="$entries" FS_TOTAL_KIB="$fs_total_kib" \
  FS_USED_KIB="$fs_used_kib" FS_AVAILABLE_KIB="$fs_available_kib" \
  FS_USED_PERCENT="$fs_used_percent" \
    node -e 'console.log(JSON.stringify({observedAt:process.env.OBSERVED_AT,host:process.env.HOST_NAME,path:process.env.CACHE_PATH,cacheKiB:Number(process.env.CACHE_KIB),entries:Number(process.env.ENTRIES),filesystem:{totalKiB:Number(process.env.FS_TOTAL_KIB),usedKiB:Number(process.env.FS_USED_KIB),availableKiB:Number(process.env.FS_AVAILABLE_KIB),usedPercent:Number(process.env.FS_USED_PERCENT)}}))'
else
  echo "observed_at=$observed_at"
  echo "host=$host"
  echo "cache_path=$cache_path"
  echo "entries=$entries"
  echo "cache_kib=$cache_kib"
  echo "filesystem_total_kib=$fs_total_kib"
  echo "filesystem_used_kib=$fs_used_kib"
  echo "filesystem_available_kib=$fs_available_kib"
  echo "filesystem_used_percent=$fs_used_percent"
fi
