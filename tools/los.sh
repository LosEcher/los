#!/usr/bin/env bash
# los.sh — local process helper for the los gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${LOS_RUNTIME_DIR:-$ROOT/.los-runtime}"
PID_FILE="$RUNTIME_DIR/gateway.pid"
LOG_FILE="$RUNTIME_DIR/gateway.log"

read_env_value() {
  local key="$1"
  local file="$ROOT/.env"
  [ -f "$file" ] || return 1
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$file"
}

server_host() {
  printf '%s' "${SERVER_HOST:-$(read_env_value SERVER_HOST || printf '127.0.0.1')}"
}

server_port() {
  printf '%s' "${SERVER_PORT:-$(read_env_value SERVER_PORT || printf '8080')}"
}

server_url() {
  printf 'http://%s:%s' "$(server_host)" "$(server_port)"
}

is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

pid_from_file() {
  [ -f "$PID_FILE" ] && tr -d '[:space:]' < "$PID_FILE" || true
}

health_check() {
  command -v curl >/dev/null 2>&1 || return 2
  curl -fsS "$(server_url)/health" >/dev/null 2>&1
}

port_owner() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -tiTCP:"$(server_port)" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

show_help() {
  cat <<EOF
los local process helper

Usage:
  pnpm start      Start gateway in background
  pnpm run status     Show process and health status
  pnpm run stop       Stop background gateway started by this helper
  pnpm run restart    Stop then start gateway
  pnpm run doctor     Check local runtime prerequisites and config/db access
  pnpm run help       Show this help

Direct:
  ./tools/los.sh <start|status|stop|restart|doctor|help>

Runtime:
  url:      $(server_url)
  pid file: $PID_FILE
  log file: $LOG_FILE

Development foreground mode remains available:
  pnpm dev
EOF
}

status_cmd() {
  local pid
  pid="$(pid_from_file)"
  echo "los status"
  echo "  url: $(server_url)"
  echo "  pid file: $PID_FILE"
  echo "  log file: $LOG_FILE"

  if is_running "$pid"; then
    echo "  process: running pid=$pid"
  elif [ -n "$pid" ]; then
    echo "  process: stopped stale_pid=$pid"
  else
    echo "  process: stopped"
  fi

  if health_check; then
    echo "  health: ok"
  else
    echo "  health: unavailable"
  fi

  local owner
  owner="$(port_owner)"
  if [ -n "$owner" ]; then
    echo "  port: $(server_port) owned_by_pid=$owner"
  else
    echo "  port: $(server_port) not_listening"
  fi
}

wait_for_health() {
  local pid="$1"
  local deadline=$((SECONDS + 25))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_check; then
      return 0
    fi
    if ! is_running "$pid"; then
      return 1
    fi
    sleep 1
  done
  return 1
}

start_cmd() {
  mkdir -p "$RUNTIME_DIR"

  local pid
  pid="$(pid_from_file)"
  if is_running "$pid"; then
    echo "los gateway already running pid=$pid"
    status_cmd
    return 0
  fi

  local owner
  owner="$(port_owner)"
  if [ -n "$owner" ]; then
    echo "port $(server_port) is already in use by pid=$owner"
    echo "not starting a second gateway"
    return 1
  fi

  echo "starting los gateway at $(server_url)"
  (
    cd "$ROOT"
    pnpm --filter @los/gateway dev
  ) >"$LOG_FILE" 2>&1 &
  pid="$!"
  echo "$pid" > "$PID_FILE"

  if wait_for_health "$pid"; then
    echo "started pid=$pid"
    echo "log: $LOG_FILE"
    return 0
  fi

  echo "gateway did not become healthy"
  if ! is_running "$pid"; then
    echo "process exited; recent log:"
  else
    echo "process still running but health is unavailable; recent log:"
  fi
  tail -40 "$LOG_FILE" 2>/dev/null || true
  return 1
}

stop_cmd() {
  local pid
  pid="$(pid_from_file)"
  if ! is_running "$pid"; then
    echo "los gateway is not running from $PID_FILE"
    rm -f "$PID_FILE"
    return 0
  fi

  echo "stopping los gateway pid=$pid"
  kill "$pid" >/dev/null 2>&1 || true

  local deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_running "$pid"; then
      rm -f "$PID_FILE"
      echo "stopped"
      return 0
    fi
    sleep 1
  done

  echo "process did not stop gracefully; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
}

doctor_cmd() {
  echo "los doctor"
  echo "  root: $ROOT"

  if command -v node >/dev/null 2>&1; then
    echo "  node: $(node -v)"
  else
    echo "  node: missing"
    return 1
  fi

  if command -v pnpm >/dev/null 2>&1; then
    echo "  pnpm: $(pnpm -v)"
  else
    echo "  pnpm: missing"
    return 1
  fi

  if [ -d "$ROOT/node_modules" ]; then
    echo "  dependencies: installed"
  else
    echo "  dependencies: missing; run pnpm install"
    return 1
  fi

  echo "  config/db:"
  (
    cd "$ROOT"
    pnpm --filter @los/gateway exec tsx -e "
      import { loadConfig, printConfigDiagnostics } from '@los/infra/config';
      import { initDb, closeDb } from '@los/infra/db';
      async function main() {
        const cfg = await loadConfig();
        console.log(printConfigDiagnostics(cfg));
        await initDb(cfg.databaseUrl);
        console.log('database: ok');
        await closeDb();
      }
      main().catch((err) => {
        console.error(err?.message ?? String(err));
        process.exit(1);
      });
    "
  )

  if health_check; then
    echo "  health: ok at $(server_url)/health"
  else
    echo "  health: not running at $(server_url)/health"
  fi
}

case "${1:-help}" in
  help|-h|--help)
    show_help
    ;;
  status)
    status_cmd
    ;;
  start)
    start_cmd
    ;;
  stop)
    stop_cmd
    ;;
  restart)
    stop_cmd
    start_cmd
    ;;
  doctor)
    doctor_cmd
    ;;
  *)
    echo "unknown command: $1"
    echo
    show_help
    exit 2
    ;;
esac
