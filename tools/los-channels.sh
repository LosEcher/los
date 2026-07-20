#!/usr/bin/env bash
# Managed lifecycle helpers for local WeChat and Telegram channel processes.

channel_mode() {
  local kind="$1" value legacy
  case "$kind" in
    wechat)
      value="${LOS_WECHAT_BOT_MODE:-}"
      legacy="${LOS_REQUIRE_WECHAT_BOT:-}"
      ;;
    telegram)
      value="${LOS_TELEGRAM_BOT_MODE:-}"
      legacy="${LOS_REQUIRE_TELEGRAM_BOT:-}"
      ;;
    *) return 2 ;;
  esac

  if [ -z "$value" ]; then
    case "$legacy" in
      1|true) value="required" ;;
      0|false) value="optional" ;;
      *) value="disabled" ;;
    esac
  fi
  printf '%s' "$value"
}

validate_channel_mode() {
  local kind="$1" mode
  mode="$(channel_mode "$kind")"
  case "$mode" in
    disabled|optional|required) return 0 ;;
    *)
      echo "$kind: invalid mode '$mode' (expected disabled, optional, or required)" >&2
      return 1
      ;;
  esac
}

channel_is_enabled() {
  local mode
  validate_channel_mode "$1" || return 1
  mode="$(channel_mode "$1")"
  [ "$mode" != "disabled" ]
}

channel_is_required() {
  validate_channel_mode "$1" || return 1
  [ "$(channel_mode "$1")" = "required" ]
}

_channel_auth_preflight() {
  local kind="$1"
  local command_name
  for command_name in curl jq node; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "$kind: required command is missing: $command_name" >&2
      return 1
    fi
  done
  if [ "${LOS_AUTH_ENABLED:-false}" = "true" ] && [ -z "${LOS_OPERATOR_TOKEN:-}" ]; then
    echo "$kind: LOS_OPERATOR_TOKEN is required when gateway auth is enabled" >&2
    return 1
  fi
}

validate_wechat_channel_config() {
  local failures=0
  _channel_auth_preflight wechat || failures=$((failures + 1))

  if [ -z "${WECLAW_DEFAULT_TO:-}" ]; then
    if [ -z "${WXPUSHER_APP_TOKEN:-}" ]; then
      echo "wechat: configure WECLAW_DEFAULT_TO or WXPUSHER_APP_TOKEN" >&2
      failures=$((failures + 1))
    fi
    if [ -z "${WXPUSHER_UIDS:-}" ] && [ -z "${WXPUSHER_TOPIC_IDS:-}" ]; then
      echo "wechat: WxPusher requires WXPUSHER_UIDS or WXPUSHER_TOPIC_IDS" >&2
      failures=$((failures + 1))
    fi
  fi

  validate_channel_port wechat "${WEB_PORT:-8899}" || failures=$((failures + 1))
  [ "$failures" -eq 0 ]
}

validate_telegram_channel_config() {
  local failures=0 webhook_port="${TELEGRAM_WEBHOOK_PORT:-0}"
  _channel_auth_preflight telegram || failures=$((failures + 1))

  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || {
    echo "telegram: TELEGRAM_BOT_TOKEN is required" >&2
    failures=$((failures + 1))
  }
  [ -n "${TELEGRAM_ALLOWED_CHAT_IDS:-${TELEGRAM_CHAT_ID:-}}" ] || {
    echo "telegram: TELEGRAM_ALLOWED_CHAT_IDS is required" >&2
    failures=$((failures + 1))
  }
  [ -n "${TELEGRAM_ALLOWED_USER_IDS:-}" ] || {
    echo "telegram: TELEGRAM_ALLOWED_USER_IDS is required" >&2
    failures=$((failures + 1))
  }
  validate_channel_port telegram "${TELEGRAM_HEALTH_PORT:-3002}" || failures=$((failures + 1))

  if [ "$webhook_port" != "0" ]; then
    validate_channel_port telegram-webhook "$webhook_port" || failures=$((failures + 1))
    [ -n "${TELEGRAM_WEBHOOK_URL:-}" ] || {
      echo "telegram: TELEGRAM_WEBHOOK_URL is required in webhook mode" >&2
      failures=$((failures + 1))
    }
    [ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ] || {
      echo "telegram: TELEGRAM_WEBHOOK_SECRET is required in webhook mode" >&2
      failures=$((failures + 1))
    }
  fi
  [ "$failures" -eq 0 ]
}

validate_channel_port() {
  local name="$1" port="$2"
  case "$port" in
    ''|*[!0-9]*)
      echo "$name: health/listen port must be an integer" >&2
      return 1
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "$name: health/listen port must be between 1 and 65535" >&2
    return 1
  fi
}

validate_channel_config() {
  local kind="$1"
  validate_channel_mode "$kind" || return 1
  case "$kind" in
    wechat) validate_wechat_channel_config ;;
    telegram) validate_telegram_channel_config ;;
    *) return 2 ;;
  esac
}

channel_pid_file() { printf '%s/%s-bot.pid' "$RUNTIME_DIR" "$1"; }
channel_log_file() { printf '%s/%s-bot.log' "$RUNTIME_DIR" "$1"; }
channel_src() { printf 'packages/%s-bot/src/index.ts' "$1"; }
channel_dist() { printf 'packages/%s-bot/dist/index.js' "$1"; }
channel_launch_prefix() { printf 'com.los.%s-bot' "$1"; }

channel_port() {
  case "$1" in
    wechat) printf '%s' "${WEB_PORT:-8899}" ;;
    telegram) printf '%s' "${TELEGRAM_HEALTH_PORT:-3002}" ;;
    *) return 2 ;;
  esac
}

channel_url() { printf 'http://127.0.0.1:%s' "$(channel_port "$1")"; }

channel_launch_command() {
  local kind="$1" node tsx gateway_url
  node="$(node_bin)"
  tsx="$(tsx_dist "$kind-bot")"
  gateway_url="${LOS_GATEWAY_URL:-$(gw_url)}"
  printf 'cd %s && if [ -f .env ]; then set -a; . ./.env; set +a; fi; export LOS_GATEWAY_URL=%s LOS_VERSION=%s; exec %s %s %s' \
    "$(shell_quote "$ROOT")" \
    "$(shell_quote "$gateway_url")" \
    "$(shell_quote "$LOS_VERSION")" \
    "$(shell_quote "$node")" \
    "$(shell_quote "$tsx/cli.mjs")" \
    "$(shell_quote "$ROOT/$(channel_src "$kind")")"
}

channel_health_snapshot() {
  curl -fsS --max-time 3 "$(channel_url "$1")/health" 2>/dev/null
}

channel_is_ready() {
  local kind="$1" payload
  payload="$(channel_health_snapshot "$kind")" || return 1
  case "$kind" in
    wechat)
      printf '%s' "$payload" | jq -e '.status == "ok" and .ready == true and .externalReady == true' >/dev/null 2>&1
      ;;
    telegram)
      printf '%s' "$payload" | jq -e '.status == "ok" and .ready == true and .telegramConnected == true' >/dev/null 2>&1
      ;;
    *) return 2 ;;
  esac
}

wait_for_channel_ready() {
  local kind="$1" pid="$2" deadline=$((SECONDS + ${3:-25}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    channel_is_ready "$kind" && return 0
    if [ -n "$pid" ] && ! is_running "$pid"; then return 1; fi
    sleep 1
  done
  return 1
}

start_channel() {
  local kind="$1" mode pid owner command
  mode="$(channel_mode "$kind")"
  if ! channel_is_enabled "$kind"; then
    echo "$kind channel disabled"
    return 0
  fi
  if ! validate_channel_config "$kind"; then
    echo "$kind channel not started: configuration preflight failed" >&2
    return 1
  fi

  pid="$(pid_from_file "$(channel_pid_file "$kind")")"
  owner="$(port_owner "$(channel_port "$kind")" 127.0.0.1 "" "$(channel_url "$kind")" "$(channel_src "$kind")" "$(channel_dist "$kind")")"
  if [ -n "$owner" ] && [ "$owner" != "unknown" ]; then
    if is_los_pid "$owner" "$(channel_src "$kind")" "$(channel_dist "$kind")"; then
      write_pid_file "$owner" "$(channel_pid_file "$kind")" "$RUNTIME_DIR"
      echo "$kind channel already running pid=$owner mode=$mode"
      channel_is_ready "$kind"
      return
    fi
    echo "$kind channel port $(channel_port "$kind") is owned by non-los pid=$owner" >&2
    return 1
  fi
  if is_running "$pid"; then
    echo "$kind channel already running pid=$pid mode=$mode"
    channel_is_ready "$kind"
    return
  fi

  mkdir -p "$RUNTIME_DIR"
  : > "$(channel_log_file "$kind")"
  command="$(channel_launch_command "$kind")"
  pid="$(start_daemon_perl "$command" "$(channel_log_file "$kind")" "$(channel_launch_prefix "$kind")")"
  write_pid_file "$pid" "$(channel_pid_file "$kind")" "$RUNTIME_DIR"
  echo "starting $kind channel pid=$pid mode=$mode url=$(channel_url "$kind")"

  if wait_for_channel_ready "$kind" "$pid"; then
    echo "$kind channel ready"
    return 0
  fi

  echo "$kind channel did not become ready; recent log:" >&2
  tail -30 "$(channel_log_file "$kind")" 2>/dev/null || true
  if channel_is_required "$kind"; then
    stop_channel "$kind" >/dev/null 2>&1 || true
  fi
  return 1
}

stop_channel() {
  local kind="$1" pid owner deadline
  launch_remove "$(channel_launch_prefix "$kind")"
  owner="$(port_owner "$(channel_port "$kind")" 127.0.0.1 "" "$(channel_url "$kind")" "$(channel_src "$kind")" "$(channel_dist "$kind")")"
  if [ -n "$owner" ] && [ "$owner" != "unknown" ] && is_los_pid "$owner" "$(channel_src "$kind")" "$(channel_dist "$kind")"; then
    pid="$owner"
    write_pid_file "$pid" "$(channel_pid_file "$kind")" "$RUNTIME_DIR"
  else
    pid="$(pid_from_file "$(channel_pid_file "$kind")")"
  fi

  if ! is_running "$pid"; then
    rm -f "$(channel_pid_file "$kind")"
    echo "$kind channel is not running"
    return 0
  fi
  if ! is_los_pid "$pid" "$(channel_src "$kind")" "$(channel_dist "$kind")"; then
    echo "$kind channel pid file points to non-los process pid=$pid; refusing to stop" >&2
    return 1
  fi

  echo "stopping $kind channel pid=$pid"
  kill "$pid" >/dev/null 2>&1 || true
  deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_running "$pid"; then
      rm -f "$(channel_pid_file "$kind")"
      echo "$kind channel stopped"
      return 0
    fi
    sleep 1
  done
  echo "$kind channel did not stop gracefully; sending SIGKILL" >&2
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$(channel_pid_file "$kind")"
  return 1
}

channel_status() {
  local kind="$1" mode pid owner payload status ready connected delivery
  mode="$(channel_mode "$kind")"
  echo "  -- $kind channel --"
  echo "  mode: $mode"
  if ! validate_channel_mode "$kind"; then return 1; fi

  pid="$(pid_from_file "$(channel_pid_file "$kind")")"
  owner="$(port_owner "$(channel_port "$kind")" 127.0.0.1 "" "$(channel_url "$kind")" "$(channel_src "$kind")" "$(channel_dist "$kind")")"
  if [ -n "$owner" ] && [ "$owner" != "unknown" ] && is_los_pid "$owner" "$(channel_src "$kind")" "$(channel_dist "$kind")"; then
    [ "$owner" = "$pid" ] || write_pid_file "$owner" "$(channel_pid_file "$kind")" "$RUNTIME_DIR"
    echo "  process: running pid=$owner managed=true"
  elif is_running "$pid"; then
    echo "  process: running pid=$pid managed=true"
  else
    echo "  process: stopped"
  fi

  payload="$(channel_health_snapshot "$kind")" || {
    echo "  health: unavailable"
    [ "$mode" != "required" ]
    return
  }
  status="$(printf '%s' "$payload" | jq -r '.status // "unknown"')"
  ready="$(printf '%s' "$payload" | jq -r '.ready // false')"
  connected="$(printf '%s' "$payload" | jq -r '.sseConnected // false')"
  echo "  health: status=$status ready=$ready sseConnected=$connected"
  case "$kind" in
    wechat)
      delivery="$(printf '%s' "$payload" | jq -r '"externalReady=" + ((.externalReady // false) | tostring) + " weclawAvailable=" + ((.weclawAvailable // false) | tostring) + " wxpusherConfigured=" + ((.wxpusherConfigured // false) | tostring)')"
      ;;
    telegram)
      delivery="telegramConnected=$(printf '%s' "$payload" | jq -r '.telegramConnected // false')"
      ;;
  esac
  echo "  delivery: $delivery"
  [ "$mode" != "required" ] || { [ "$status" = "ok" ] && [ "$ready" = "true" ]; }
}

start_channels() {
  local failures=0 kind
  for kind in wechat telegram; do
    if ! validate_channel_mode "$kind"; then
      failures=$((failures + 1))
      continue
    fi
    if channel_is_enabled "$kind"; then
      if ! start_channel "$kind"; then
        if channel_is_required "$kind"; then failures=$((failures + 1));
        else echo "WARNING: optional $kind channel is unavailable" >&2; fi
      fi
    fi
  done
  [ "$failures" -eq 0 ]
}

stop_channels() {
  local failures=0 kind pid
  for kind in telegram wechat; do
    if ! validate_channel_mode "$kind"; then
      failures=$((failures + 1))
      pid="$(pid_from_file "$(channel_pid_file "$kind")")"
      if is_running "$pid"; then
        stop_channel "$kind" || failures=$((failures + 1))
      fi
      continue
    fi
    pid="$(pid_from_file "$(channel_pid_file "$kind")")"
    if channel_is_enabled "$kind" || is_running "$pid"; then
      stop_channel "$kind" || failures=$((failures + 1))
    fi
  done
  [ "$failures" -eq 0 ]
}

channels_status() {
  local failures=0 kind
  echo "  == channels =="
  for kind in wechat telegram; do
    channel_status "$kind" || failures=$((failures + 1))
  done
  [ "$failures" -eq 0 ]
}
