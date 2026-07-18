#!/usr/bin/env bash
set -euo pipefail

format="text"
store_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) format="json" ;;
    --store)
      shift
      store_path="${1:-}"
      ;;
    --help|-h)
      echo "usage: $0 [--json] [--store PATH]"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$store_path" ]; then
  store_path="$(pnpm store path --silent)"
fi
if [ ! -d "$store_path" ]; then
  echo "pnpm store directory not found: $store_path" >&2
  exit 2
fi

store_kib="$(du -sk "$store_path" | awk '{print $1}')"
read -r fs_total_kib fs_used_kib fs_available_kib fs_used_percent < <(
  df -Pk "$store_path" | awk 'NR == 2 { gsub(/%/, "", $5); print $2, $3, $4, $5 }'
)
observed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
host="$(hostname 2>/dev/null || printf 'unknown')"

if [ "$format" = "json" ]; then
  OBSERVED_AT="$observed_at" HOST_NAME="$host" STORE_PATH="$store_path" \
  STORE_KIB="$store_kib" FS_TOTAL_KIB="$fs_total_kib" FS_USED_KIB="$fs_used_kib" \
  FS_AVAILABLE_KIB="$fs_available_kib" FS_USED_PERCENT="$fs_used_percent" \
    node -e 'console.log(JSON.stringify({observedAt:process.env.OBSERVED_AT,host:process.env.HOST_NAME,storePath:process.env.STORE_PATH,storeKiB:Number(process.env.STORE_KIB),filesystem:{totalKiB:Number(process.env.FS_TOTAL_KIB),usedKiB:Number(process.env.FS_USED_KIB),availableKiB:Number(process.env.FS_AVAILABLE_KIB),usedPercent:Number(process.env.FS_USED_PERCENT)}}))'
else
  echo "observed_at=$observed_at"
  echo "host=$host"
  echo "store_path=$store_path"
  echo "store_kib=$store_kib"
  echo "filesystem_total_kib=$fs_total_kib"
  echo "filesystem_used_kib=$fs_used_kib"
  echo "filesystem_available_kib=$fs_available_kib"
  echo "filesystem_used_percent=$fs_used_percent"
fi
