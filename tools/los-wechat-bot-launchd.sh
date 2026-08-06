#!/bin/bash
# los WeChat bot launchd wrapper — WeClaw bridge + mobile web (com.los.wechat-bot).
# launchd KeepAlive ensures this wrapper stays resident; it (re)starts the bot
# process whenever it is missing (30s health loop).
set -uo pipefail

ROOT="/Users/echerlos/projects/los-workspace/projects/los"
RUNTIME_DIR="$ROOT/.los-runtime"
BOT_LOG="$RUNTIME_DIR/wechat-bot.log"
BOT_PID_FILE="$RUNTIME_DIR/wechat-bot.pid"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$RUNTIME_DIR/launchd-wrapper.log"; }

bot_alive() {
  local pid
  [ -f "$BOT_PID_FILE" ] || return 1
  pid="$(cat "$BOT_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_bot() {
  local node tsx
  node="$(command -v node || true)"
  tsx="$ROOT/packages/wechat-bot/node_modules/.bin/tsx"
  [ -n "$node" ] || { log "bot start: node not found"; return 1; }
  [ -x "$tsx" ] || { log "bot start: tsx not found at $tsx"; return 1; }
  cd "$ROOT" || return 1
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env" 2>/dev/null; set +a
  nohup "$node" "$tsx" "$ROOT/packages/wechat-bot/src/index.ts" \
    >> "$BOT_LOG" 2>&1 &
  echo $! > "$BOT_PID_FILE"
  log "bot started pid=$(cat "$BOT_PID_FILE")"
}

log "=== los wechat-bot wrapper up ==="
while true; do
  if ! bot_alive; then
    log "bot not alive — starting"
    start_bot || log "bot start failed"
  fi
  sleep 30
done
