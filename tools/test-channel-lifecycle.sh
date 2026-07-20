#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d)"
trap 'rm -rf "$RUNTIME_DIR"' EXIT
. "$ROOT/tools/los-common.sh"
. "$ROOT/tools/los-channels.sh"

unset LOS_REQUIRE_WECHAT_BOT LOS_REQUIRE_TELEGRAM_BOT
unset LOS_WECHAT_BOT_MODE LOS_TELEGRAM_BOT_MODE
[ "$(channel_mode wechat)" = "disabled" ]
[ "$(channel_mode telegram)" = "disabled" ]

LOS_REQUIRE_WECHAT_BOT=1
[ "$(channel_mode wechat)" = "required" ]
unset LOS_REQUIRE_WECHAT_BOT
LOS_TELEGRAM_BOT_MODE=optional
[ "$(channel_mode telegram)" = "optional" ]

LOS_TELEGRAM_BOT_MODE=invalid
if validate_channel_mode telegram >/dev/null 2>&1; then
  echo "invalid Telegram mode unexpectedly passed" >&2
  exit 1
fi

LOS_TELEGRAM_BOT_MODE=required
unset TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_CHAT_IDS TELEGRAM_CHAT_ID TELEGRAM_ALLOWED_USER_IDS
if validate_telegram_channel_config >/dev/null 2>&1; then
  echo "incomplete Telegram config unexpectedly passed" >&2
  exit 1
fi
TELEGRAM_BOT_TOKEN=test
TELEGRAM_ALLOWED_CHAT_IDS=1
TELEGRAM_ALLOWED_USER_IDS=2
validate_telegram_channel_config

LOS_WECHAT_BOT_MODE=required
unset WECLAW_DEFAULT_TO WXPUSHER_APP_TOKEN WXPUSHER_UIDS WXPUSHER_TOPIC_IDS
if validate_wechat_channel_config >/dev/null 2>&1; then
  echo "incomplete WeChat config unexpectedly passed" >&2
  exit 1
fi
WECLAW_DEFAULT_TO=test-user
validate_wechat_channel_config

LOS_AUTH_ENABLED=true
unset LOS_OPERATOR_TOKEN
if validate_wechat_channel_config >/dev/null 2>&1; then
  echo "auth-enabled channel without operator token unexpectedly passed" >&2
  exit 1
fi
LOS_OPERATOR_TOKEN=test-operator
validate_wechat_channel_config

WEB_PORT=0
if validate_wechat_channel_config >/dev/null 2>&1; then
  echo "invalid health port unexpectedly passed" >&2
  exit 1
fi

echo "channel lifecycle checks passed"
