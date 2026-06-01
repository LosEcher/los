#!/usr/bin/env bash
# executor.sh — local maintenance helper for the los executor node.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${LOS_RUNTIME_DIR:-$ROOT/.los-runtime}"
PID_FILE="$RUNTIME_DIR/executor.pid"
LOG_FILE="$RUNTIME_DIR/executor.log"

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

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
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$file"
}

executor_host() {
  printf '%s' "${EXECUTOR_HOST:-$(read_env_value EXECUTOR_HOST || printf '127.0.0.1')}"
}

executor_port() {
  printf '%s' "${EXECUTOR_PORT:-$(read_env_value EXECUTOR_PORT || printf '8090')}"
}

executor_url() {
  printf 'http://%s:%s' "$(executor_host)" "$(executor_port)"
}

executor_node_id() {
  printf '%s' "${EXECUTOR_NODE_ID:-$(read_env_value EXECUTOR_NODE_ID || hostname -s 2>/dev/null || hostname)}"
}

node_bin() {
  command -v node
}

launch_label() {
  local suffix
  suffix="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
  printf 'com.los.executor.%s.%s' "$(id -u)" "$suffix"
}

launch_remove() {
  command -v launchctl >/dev/null 2>&1 || return 0
  launchctl remove "$(launch_label)" >/dev/null 2>&1 || true
}

tsx_dist() {
  local candidate
  for candidate in \
    "$ROOT"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist \
    "$ROOT"/packages/executor/node_modules/.pnpm/tsx@*/node_modules/tsx/dist
  do
    if [ -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

pid_from_file() {
  [ -f "$PID_FILE" ] && tr -d '[:space:]' < "$PID_FILE" || true
}

is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

pid_command() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  ps -p "$pid" -o command= 2>/dev/null || true
}

is_los_executor_pid() {
  local pid="${1:-}"
  local command
  command="$(pid_command "$pid")"
  [ -n "$command" ] || return 1
  [[ "$command" == *"packages/executor/src/index.ts"* || "$command" == *"packages/executor/dist/index.js"* ]]
}

port_owner() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -tiTCP:"$(executor_port)" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

health_check() {
  command -v curl >/dev/null 2>&1 || return 2
  curl -fsS "$(executor_url)/health" >/dev/null 2>&1
}

write_pid_file() {
  mkdir -p "$RUNTIME_DIR"
  printf '%s\n' "$1" > "$PID_FILE"
}

parent_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true
}

start_executor_process() {
  mkdir -p "$RUNTIME_DIR"
  : > "$LOG_FILE"

  local node tsx
  node="$(node_bin)"
  tsx="$(tsx_dist)"

  local command
  command="$(printf 'cd %s && export EXECUTOR_HOST=%s && export EXECUTOR_PORT=%s && exec %s %s %s' \
    "$(shell_quote "$ROOT")" \
    "$(shell_quote "$(executor_host)")" \
    "$(shell_quote "$(executor_port)")" \
    "$(shell_quote "$node")" \
    "$(shell_quote "$tsx/cli.mjs")" \
    "$(shell_quote "$ROOT/packages/executor/src/index.ts")")"

  if command -v launchctl >/dev/null 2>&1; then
    launch_remove
    launchctl submit \
      -l "$(launch_label)" \
      -o "$LOG_FILE" \
      -e "$LOG_FILE" \
      -- /bin/bash -lc "$command"
    return 0
  fi

  (
    cd "$ROOT"
    export EXECUTOR_HOST="$(executor_host)"
    export EXECUTOR_PORT="$(executor_port)"
    nohup "$node" "$tsx/cli.mjs" "$ROOT/packages/executor/src/index.ts" </dev/null >"$LOG_FILE" 2>&1 &
    printf '%s' "$!"
  )
}

wait_for_health() {
  local pid="${1:-}"
  local deadline=$((SECONDS + 25))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_check; then
      return 0
    fi
    if [ -n "$pid" ] && ! is_running "$pid"; then
      return 1
    fi
    sleep 1
  done
  return 1
}

status_cmd() {
  local pid owner node_id
  node_id="$(executor_node_id)"
  pid="$(pid_from_file)"
  owner="$(port_owner)"
  echo "los executor status"
  echo "  node: $node_id"
  echo "  url: $(executor_url)"
  echo "  pid file: $PID_FILE"
  echo "  log file: $LOG_FILE"

  if is_los_executor_pid "$owner"; then
    if [ "$owner" != "$pid" ]; then
      write_pid_file "$owner"
      echo "  process: running pid=$owner managed=true adopted_from=${pid:-none}"
    else
      echo "  process: running pid=$owner managed=true"
    fi
  elif is_running "$pid"; then
    echo "  process: running pid=$pid managed=true"
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

  if [ -n "$owner" ]; then
    echo "  port: $(executor_port) owned_by_pid=$owner"
  else
    echo "  port: $(executor_port) not_listening"
  fi

  pnpm --filter @los/executor run maint -- status "$node_id"
}

set_status_cmd() {
  local status="${1:-online}"
  local node_id
  node_id="$(executor_node_id)"
  pnpm --filter @los/executor run maint -- set-status "$node_id" "$status"
}

set_rollout_cmd() {
  local rollout_state="${1:-idle}"
  local rollout_message="${2:-}"
  local node_id
  node_id="$(executor_node_id)"
  if [ -n "$rollout_message" ]; then
    pnpm --filter @los/executor run maint -- set-rollout "$node_id" "$rollout_state" "$rollout_message"
  else
    pnpm --filter @los/executor run maint -- set-rollout "$node_id" "$rollout_state"
  fi
}

drain_cmd() {
  local timeout_ms="${1:-120000}"
  local node_id
  node_id="$(executor_node_id)"
  pnpm --filter @los/executor run maint -- drain "$node_id" "$timeout_ms"
}

promote_cmd() {
  local node_id
  node_id="$(executor_node_id)"
  if ! health_check; then
    echo "executor health is unavailable at $(executor_url)/health"
    return 1
  fi
  pnpm --filter @los/executor run maint -- promote "$node_id"
}

start_cmd() {
  mkdir -p "$RUNTIME_DIR"

  local pid owner
  owner="$(port_owner)"
  if [ -n "$owner" ]; then
    if is_los_executor_pid "$owner"; then
      write_pid_file "$owner"
      echo "executor already running pid=$owner; adopted into $PID_FILE"
      status_cmd
      return 0
    fi

    echo "port $(executor_port) is already in use by non-los pid=$owner"
    echo "not starting a second executor"
    return 1
  fi

  pid="$(pid_from_file)"
  if is_running "$pid"; then
    echo "executor already running pid=$pid"
    status_cmd
    return 0
  fi

  echo "starting los executor at $(executor_url)"
  pid="$(start_executor_process)"
  if [ -n "$pid" ]; then
    write_pid_file "$pid"
  fi

  if wait_for_health "$pid"; then
    owner="$(port_owner)"
    if is_los_executor_pid "$owner"; then
      pid="$owner"
      write_pid_file "$pid"
    fi
    echo "started pid=$pid"
    echo "log: $LOG_FILE"
    return 0
  fi

  echo "executor did not become healthy"
  if ! is_running "$pid"; then
    echo "process exited; recent log:"
  else
    echo "process still running but health is unavailable; recent log:"
  fi
  tail -40 "$LOG_FILE" 2>/dev/null || true
  return 1
}

stop_cmd() {
  local pid owner parent
  launch_remove
  owner="$(port_owner)"
  if is_los_executor_pid "$owner"; then
    pid="$owner"
    write_pid_file "$pid"
  else
    pid="$(pid_from_file)"
  fi
  if ! is_running "$pid"; then
    if is_los_executor_pid "$owner"; then
      pid="$owner"
      write_pid_file "$pid"
      echo "adopted unmanaged los executor pid=$pid before stopping"
    else
      echo "los executor is not running from $PID_FILE"
      rm -f "$PID_FILE"
      return 0
    fi
  fi

  parent="$(parent_pid "$pid")"
  echo "stopping los executor pid=$pid"
  if is_los_executor_pid "$parent"; then
    echo "stopping los executor parent pid=$parent"
    kill "$parent" >/dev/null 2>&1 || true
  fi
  kill "$pid" >/dev/null 2>&1 || true

  local deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_running "$pid" && ! is_running "$parent"; then
      rm -f "$PID_FILE"
      echo "stopped"
      return 0
    fi
    sleep 1
  done

  echo "process did not stop gracefully; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  if is_los_executor_pid "$parent"; then
    kill -9 "$parent" >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
}

restart_cmd() {
  set_rollout_cmd draining "draining before restart"
  drain_cmd
  set_rollout_cmd upgrading "restarting executor"
  stop_cmd
  start_cmd
  set_rollout_cmd verifying "validating health"
  promote_cmd
  set_rollout_cmd idle "restart complete"
}

upgrade_cmd() {
  set_rollout_cmd draining "draining before upgrade"
  drain_cmd
  set_rollout_cmd upgrading "restarting executor"
  stop_cmd
  start_cmd
  set_rollout_cmd verifying "validating health"
  promote_cmd
  set_rollout_cmd idle "upgrade complete"
}

show_help() {
  cat <<EOF
los executor maintenance helper

Usage:
  pnpm run executor:status
  pnpm run executor:start
  pnpm run executor:stop
  pnpm run executor:restart
  pnpm run executor:drain
  pnpm run executor:promote
  pnpm run executor:upgrade

Direct:
  ./tools/executor.sh <status|start|stop|restart|drain|promote|upgrade>

Runtime:
  url:      $(executor_url)
  node:     $(executor_node_id)
  pid file: $PID_FILE
  log file: $LOG_FILE
EOF
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
    restart_cmd
    ;;
  drain)
    drain_cmd
    ;;
  promote)
    promote_cmd
    ;;
  upgrade)
    upgrade_cmd
    ;;
  *)
    echo "unknown command: $1"
    echo
    show_help
    exit 2
    ;;
esac
