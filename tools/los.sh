#!/usr/bin/env bash
# los.sh — local process helper for the los gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${LOS_RUNTIME_DIR:-$ROOT/.los-runtime}"
PID_FILE="$RUNTIME_DIR/gateway.pid"
LOG_FILE="$RUNTIME_DIR/gateway.log"

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

mark_service_status() {
  local status="$1"
  local message="${2:-}"
  (
    cd "$ROOT"
    if [ "$status" = "draining" ]; then
      pnpm --filter @los/gateway run maint -- drain "$message"
    elif [ "$status" = "online" ]; then
      pnpm --filter @los/gateway run maint -- promote "$message"
    else
      pnpm --filter @los/gateway run maint -- set-status offline
      pnpm --filter @los/gateway run maint -- set-rollout idle "$message"
    fi
  ) >/dev/null 2>&1 || true
}

port_owner() {
  # Prefer the PID file for managed processes.
  local pid
  pid="$(pid_from_file)"
  if [ -n "$pid" ] && is_running "$pid"; then
    printf '%s' "$pid"
    return 0
  fi

  # Recover the listener PID when the pid file is missing or stale.
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -nP -tiTCP:"$(server_port)" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then
      printf '%s' "$pid"
      return 0
    fi
  fi

  # Fall back to a connection probe when PID attribution is unavailable.
  if command -v nc >/dev/null 2>&1; then
    if nc -z "$(server_host)" "$(server_port)" 2>/dev/null; then
      printf 'unknown'
      return 0
    fi
  elif command -v curl >/dev/null 2>&1; then
    # Fallback: if health endpoint responds, something is listening.
    if curl -fsS "$(server_url)/health" >/dev/null 2>&1; then
      printf 'unknown'
      return 0
    fi
  fi

  # Port appears free.
  true
}

pid_command() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  ps -p "$pid" -o command= 2>/dev/null || true
}

is_los_gateway_pid() {
  local pid="${1:-}"
  local command
  command="$(pid_command "$pid")"
  [ -n "$command" ] || return 1
  [[ "$command" == *"$ROOT"* ]] || return 1
  [[ "$command" == *"src/server.ts"* || "$command" == *"dist/server.js"* ]]
}

write_pid_file() {
  mkdir -p "$RUNTIME_DIR"
  printf '%s\n' "$1" > "$PID_FILE"
}

launch_label() {
  local suffix
  suffix="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
  printf 'com.los.gateway.%s.%s' "$(id -u)" "$suffix"
}

launch_remove() {
  command -v launchctl >/dev/null 2>&1 || return 0
  launchctl remove "$(launch_label)" >/dev/null 2>&1 || true
}

node_bin() {
  command -v node
}

tsx_dist() {
  local candidate
  for candidate in \
    "$ROOT"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist \
    "$ROOT"/packages/gateway/node_modules/.pnpm/tsx@*/node_modules/tsx/dist
  do
    if [ -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

gateway_launch_command() {
  local node tsx
  node="$(node_bin)"
  tsx="$(tsx_dist)"
  printf 'cd %s && exec %s --require %s --import %s %s' \
    "$(shell_quote "$ROOT")" \
    "$(shell_quote "$node")" \
    "$(shell_quote "$tsx/preflight.cjs")" \
    "$(shell_quote "file://$tsx/loader.mjs")" \
    "$(shell_quote "$ROOT/packages/gateway/src/server.ts")"
}

start_gateway_process() {
  STARTED_GATEWAY_PID=""
  mkdir -p "$RUNTIME_DIR"
  : > "$LOG_FILE"

  local command
  command="$(gateway_launch_command)"

  launch_remove
  if command -v perl >/dev/null 2>&1; then
    STARTED_GATEWAY_PID="$(
      perl -MPOSIX=setsid -e '
        my ($command, $log_file) = @ARGV;
        defined(my $pid = fork) or die "fork failed: $!";
        if ($pid) {
          print "$pid\n";
          exit 0;
        }
        setsid() or die "setsid failed: $!";
        open STDIN, "<", "/dev/null" or die "stdin redirect failed: $!";
        open STDOUT, ">", $log_file or die "stdout redirect failed: $!";
        open STDERR, ">&", \*STDOUT or die "stderr redirect failed: $!";
        exec "/bin/bash", "-lc", $command;
        die "exec failed: $!";
      ' "$command" "$LOG_FILE"
    )"
    return 0
  fi

  nohup /bin/bash -lc "$command" </dev/null >"$LOG_FILE" 2>&1 &
  STARTED_GATEWAY_PID="$!"
}

show_help() {
  cat <<EOF
los local process helper

Usage:
  pnpm start          Start gateway in background, or adopt an existing los gateway
  pnpm run status     Show process and health status
  pnpm run stop       Stop managed or adopted los gateway
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
    echo "  process: running pid=$pid managed=true"
  elif [ -n "$pid" ]; then
    echo "  process: stopped stale_pid=$pid"
  else
    local owner
    owner="$(port_owner)"
    if [ "$owner" = "unknown" ]; then
      echo "  process: running pid=unknown managed=false"
    elif is_los_gateway_pid "$owner"; then
      echo "  process: running pid=$owner managed=false"
    else
      echo "  process: stopped"
    fi
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
    if is_los_gateway_pid "$owner"; then
      write_pid_file "$owner"
      echo "los gateway already running pid=$owner; adopted into $PID_FILE"
      status_cmd
      return 0
    fi

    echo "port $(server_port) is already in use by non-los pid=$owner"
    echo "not starting a second gateway"
    return 1
  fi

  echo "starting los gateway at $(server_url)"
  start_gateway_process
  pid="$STARTED_GATEWAY_PID"
  if [ -n "$pid" ]; then
    write_pid_file "$pid"
  fi

  if wait_for_health "$pid"; then
    owner="$(port_owner)"
    if is_los_gateway_pid "$owner"; then
      pid="$owner"
      write_pid_file "$pid"
    fi
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
    local owner
    owner="$(port_owner)"
    if is_los_gateway_pid "$owner"; then
      pid="$owner"
      write_pid_file "$pid"
      echo "adopted unmanaged los gateway pid=$pid before stopping"
    else
      echo "los gateway is not running from $PID_FILE"
      rm -f "$PID_FILE"
      mark_service_status offline "gateway stop observed no local process"
      return 0
    fi
  fi

  echo "stopping los gateway pid=$pid"
  mark_service_status draining "gateway stop requested"
  launch_remove
  kill "$pid" >/dev/null 2>&1 || true

  local deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_running "$pid"; then
      rm -f "$PID_FILE"
      mark_service_status offline "gateway stopped"
      echo "stopped"
      return 0
    fi
    sleep 1
  done

  echo "process did not stop gracefully; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  mark_service_status offline "gateway stopped after SIGKILL"
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
