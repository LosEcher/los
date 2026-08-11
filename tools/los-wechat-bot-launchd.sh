#!/bin/bash
# los WeChat bot launchd wrapper — WeClaw bridge + mobile web (com.los.wechat-bot).
# launchd KeepAlive keeps this wrapper resident. The bot process is only
# (re)started when LOS_WECHAT_BOT_MODE is optional|required (or legacy
# LOS_REQUIRE_WECHAT_BOT=1/true). mode=disabled stops any orphan bot and does
# not restart it — previously launchd ignored mode and kept pushing digests.
set -uo pipefail

ROOT="/Users/echerlos/projects/los-workspace/projects/los"
RUNTIME_DIR="$ROOT/.los-runtime"
BOT_LOG="$RUNTIME_DIR/wechat-bot.log"
BOT_PID_FILE="$RUNTIME_DIR/wechat-bot.pid"

# launchd has a clean PATH; expose fnm/pnpm/homebrew like tools/los-launchd-wrapper.sh.
export PATH="$HOME/Library/pnpm:$HOME/Library/Application Support/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$RUNTIME_DIR/launchd-wrapper.log"; }

load_env() {
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env" 2>/dev/null; set +a
}

# Mirrors tools/los-channels.sh channel_mode(wechat) without sourcing the full
# lifecycle helpers (launchd PATH must stay minimal and self-contained).
wechat_mode() {
  local value="${LOS_WECHAT_BOT_MODE:-}" legacy="${LOS_REQUIRE_WECHAT_BOT:-}"
  if [ -z "$value" ]; then
    case "$legacy" in
      1|true) value="required" ;;
      0|false) value="optional" ;;
      *) value="disabled" ;;
    esac
  fi
  printf '%s' "$value"
}

wechat_enabled() {
  case "$(wechat_mode)" in
    optional|required) return 0 ;;
    *) return 1 ;;
  esac
}

bot_alive() {
  local pid
  [ -f "$BOT_PID_FILE" ] || return 1
  pid="$(cat "$BOT_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop_bot() {
  local pid
  [ -f "$BOT_PID_FILE" ] || return 0
  pid="$(cat "$BOT_PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "mode=$(wechat_mode) — stopping bot pid=$pid"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$BOT_PID_FILE"
}

start_bot() {
  local tsx
  tsx="$ROOT/packages/wechat-bot/node_modules/.bin/tsx"
  [ -x "$tsx" ] || { log "bot start: tsx not found at $tsx"; return 1; }
  cd "$ROOT" || return 1
  load_env
  # .bin/tsx is a POSIX sh wrapper — execute it directly, not via node.
  nohup "$tsx" "$ROOT/packages/wechat-bot/src/index.ts" \
    >> "$BOT_LOG" 2>&1 &
  echo $! > "$BOT_PID_FILE"
  log "bot started pid=$(cat "$BOT_PID_FILE") mode=$(wechat_mode)"
}

mkdir -p "$RUNTIME_DIR"
load_env
log "=== los wechat-bot wrapper up mode=$(wechat_mode) ==="
while true; do
  load_env
  if wechat_enabled; then
    if ! bot_alive; then
      log "bot not alive (mode=$(wechat_mode)) — starting"
      start_bot || log "bot start failed"
    fi
  else
    # Disabled: do not keep an orphan process that still SSE-pushes digests.
    if bot_alive; then
      stop_bot
    fi
  fi
  sleep 30
done
