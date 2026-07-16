#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f .env ]; then set -a; source .env; set +a; fi

WECHAT_URL="${WECHAT_BOT_HEALTH_URL:-http://127.0.0.1:${WEB_PORT:-8899}/health}"
TELEGRAM_URL="${TELEGRAM_BOT_HEALTH_URL:-http://127.0.0.1:${TELEGRAM_HEALTH_PORT:-3002}/health}"
FAILURES=0

check_bot() {
  local name="$1" url="$2" required="$3" payload
  if ! payload=$(curl -fsS --max-time 5 "$url" 2>/dev/null); then
    if [ "$required" = "1" ]; then
      echo "$name: unavailable ($url)"
      FAILURES=$((FAILURES + 1))
    else
      echo "$name: stopped (optional, $url)"
    fi
    return
  fi

  local status ready connected
  status=$(printf '%s' "$payload" | jq -r '.status // "unknown"')
  ready=$(printf '%s' "$payload" | jq -r '.ready // false')
  connected=$(printf '%s' "$payload" | jq -r '.sseConnected // false')
  echo "$name: status=$status ready=$ready sseConnected=$connected url=$url"
  if [ "$required" = "1" ] && { [ "$status" != "ok" ] || [ "$ready" != "true" ]; }; then
    FAILURES=$((FAILURES + 1))
  fi
}

check_bot wechat "$WECHAT_URL" "${LOS_REQUIRE_WECHAT_BOT:-1}"
check_bot telegram "$TELEGRAM_URL" "${LOS_REQUIRE_TELEGRAM_BOT:-0}"
exit "$FAILURES"
