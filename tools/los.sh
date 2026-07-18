#!/usr/bin/env bash
# los.sh — unified process helper for the los gateway and executor.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${LOS_RUNTIME_DIR:-$ROOT/.los-runtime}"

# ── Source shared library ────────────────────────────────
# shellcheck source=tools/los-common.sh
. "$ROOT/tools/los-common.sh"

# ── Load .env into current shell before spawning daemons ──
_load_dotenv() {
  local env_file="$ROOT/.env"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

resolve_local_runtime_version() {
  local base revision
  base="$(node -p "require('$ROOT/packages/executor/package.json').version" 2>/dev/null || printf '0.1.0')"
  revision="$(
    cd "$ROOT"
    {
      find tools deploy packages contracts \
        -type d \( -name node_modules -o -name dist -o -name .turbo -o -name .los \) -prune -o \
        -type f ! -name '*.tsbuildinfo' -print
      printf '%s\n' package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json
    } | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-12
  )"
  if [ -n "$revision" ]; then
    printf '%s+b%s' "$base" "$revision"
  else
    printf '%s' "$base"
  fi
}

if [ "${1:-}" = "build-version" ]; then
  resolve_local_runtime_version
  printf '\n'
  exit 0
fi

_load_dotenv

export LOS_VERSION="${LOS_VERSION:-$(resolve_local_runtime_version)}"
export EXECUTOR_VERSION="${EXECUTOR_VERSION:-$LOS_VERSION}"

# ── Proxy env export helper (launchctl drops parent env) ─
_dotenv_proxy_exports() {
  local exports=""
  [ -n "${HTTPS_PROXY-}" ] && exports="$exports export HTTPS_PROXY='$HTTPS_PROXY';"
  [ -n "${HTTP_PROXY-}" ] && exports="$exports export HTTP_PROXY='$HTTP_PROXY';"
  [ -n "${NO_PROXY-}" ] && exports="$exports export NO_PROXY='$NO_PROXY';"
  printf '%s' "$exports"
}

# ── Gateway config ───────────────────────────────────────
GW_PID_FILE="$RUNTIME_DIR/gateway.pid"
GW_LOG_FILE="$RUNTIME_DIR/gateway.log"
GW_SRC="src/server.ts"
GW_DIST="dist/server.js"
GW_LAUNCH_PREFIX="com.los.gateway"
GW_MAINT_FILTER="@los/gateway"

gw_host() { printf '%s' "${SERVER_HOST:-$(read_env_value SERVER_HOST || printf '127.0.0.1')}"; }
gw_port() { printf '%s' "${SERVER_PORT:-$(read_env_value SERVER_PORT || printf '8080')}"; }
gw_url()  { printf 'http://%s:%s' "$(gw_host)" "$(gw_port)"; }

gw_launch_command() {
  local node tsx
  node="$(node_bin)"
  tsx="$(tsx_dist gateway)"
  printf 'cd %s && %s export LOS_VERSION=%s SERVER_PORT=%s SERVER_HOST=%s && exec %s --require %s --import %s %s' \
    "$(shell_quote "$ROOT")" \
    "$(_dotenv_proxy_exports)" \
    "$(shell_quote "$LOS_VERSION")" \
    "$(gw_port)" \
    "$(gw_host)" \
    "$(shell_quote "$node")" \
    "$(shell_quote "$tsx/preflight.cjs")" \
    "$(shell_quote "file://$tsx/loader.mjs")" \
    "$(shell_quote "$ROOT/packages/gateway/src/server.ts")"
}

start_gateway_process() {
  mkdir -p "$RUNTIME_DIR"
  : > "$GW_LOG_FILE"
  local command
  command="$(gw_launch_command)"

  if command -v perl >/dev/null 2>&1; then
    start_daemon_perl "$command" "$GW_LOG_FILE" "$GW_LAUNCH_PREFIX"
  else
    start_daemon_nohup "$command" "$GW_LOG_FILE"
  fi
}

# ── Executor config ──────────────────────────────────────
EX_PID_FILE="$RUNTIME_DIR/executor.pid"
EX_LOG_FILE="$RUNTIME_DIR/executor.log"
EX_SRC="packages/executor/src/index.ts"
EX_DIST="packages/executor/dist/index.js"
EX_LAUNCH_PREFIX="com.los.executor"
EX_MAINT_FILTER="@los/executor"

ex_host() { printf '%s' "${EXECUTOR_HOST:-$(read_env_value EXECUTOR_HOST || printf '127.0.0.1')}"; }
ex_port() { printf '%s' "${EXECUTOR_PORT:-$(read_env_value EXECUTOR_PORT || printf '8090')}"; }
ex_url()  { printf 'http://%s:%s' "$(ex_host)" "$(ex_port)"; }
ex_node_id() { printf '%s' "${EXECUTOR_NODE_ID:-$(read_env_value EXECUTOR_NODE_ID || hostname -s 2>/dev/null || hostname)}"; }
ex_node_id_arg() { printf '%s' "$(ex_node_id)"; }
ex_stop_timeout_seconds() {
  local grace_ms
  grace_ms="${EXECUTOR_SHUTDOWN_GRACE_MS:-$(read_env_value EXECUTOR_SHUTDOWN_GRACE_MS || printf '120000')}"
  case "$grace_ms" in
    ''|*[!0-9]*) grace_ms=120000 ;;
  esac
  printf '%s' "$(((grace_ms + 999) / 1000 + 35))"
}

is_executor_enabled() {
  local val
  val="${EXECUTOR_ENABLED:-$(read_env_value EXECUTOR_ENABLED || true)}"
  [ "$val" = "true" ]
}

ex_launch_command() {
  local node tsx
  node="$(node_bin)"
  tsx="$(tsx_dist executor)"
  printf 'cd %s && %s export LOS_VERSION=%s EXECUTOR_VERSION=%s EXECUTOR_HOST=%s EXECUTOR_PORT=%s && exec %s %s %s' \
    "$(shell_quote "$ROOT")" \
    "$(_dotenv_proxy_exports)" \
    "$(shell_quote "$LOS_VERSION")" \
    "$(shell_quote "$EXECUTOR_VERSION")" \
    "$(shell_quote "$(ex_host)")" \
    "$(shell_quote "$(ex_port)")" \
    "$(shell_quote "$node")" \
    "$(shell_quote "$tsx/cli.mjs")" \
    "$(shell_quote "$ROOT/packages/executor/src/index.ts")"
}

start_executor_process() {
  mkdir -p "$RUNTIME_DIR"
  : > "$EX_LOG_FILE"
  local command
  command="$(ex_launch_command)"

  if command -v launchctl >/dev/null 2>&1; then
    start_daemon_launchctl "$command" "$EX_LOG_FILE" "$EX_LAUNCH_PREFIX"
    # launchctl doesn't return a PID, caller must discover via lsof
    printf ''
  else
    # shellcheck disable=SC2034
    local tsx
    tsx="$(tsx_dist executor)"
    start_daemon_nohup "$command" "$EX_LOG_FILE" "$ROOT"
  fi
}

# ── Agent key check ──────────────────────────────────────

check_agent_key() {
  local key
  key="${EXECUTOR_AGENT_KEY:-$(read_env_value EXECUTOR_AGENT_KEY || true)}"
  if [ -z "$key" ]; then
    echo "  agent_key: WARNING — EXECUTOR_AGENT_KEY is not set"
    echo "    Gateway and executor will each generate independent random keys."
    echo "    They will not trust each other. Set EXECUTOR_AGENT_KEY in .env to fix this."
    return 2
  fi
  echo "  agent_key: configured"
  return 0
}

# ── Component-level: Gateway ─────────────────────────────

start_gateway() {
  local pid owner
  pid="$(pid_from_file "$GW_PID_FILE")"
  if is_running "$pid"; then
    echo "los gateway already running pid=$pid"
    return 0
  fi

  owner="$(port_owner "$(gw_port)" "$(gw_host)" "" "$(gw_url)" "$GW_SRC" "$GW_DIST")"
  if [ -n "$owner" ] && [ "$owner" != "unknown" ]; then
    if is_los_pid "$owner" "$GW_SRC" "$GW_DIST"; then
      write_pid_file "$owner" "$GW_PID_FILE" "$RUNTIME_DIR"
      echo "los gateway already running pid=$owner; adopted into $GW_PID_FILE"
      return 0
    fi
    echo "port $(gw_port) is already in use by non-los pid=$owner"
    echo "not starting a second gateway"
    return 1
  fi

  echo "starting los gateway at $(gw_url)"
  pid="$(start_gateway_process)"
  if [ -n "$pid" ]; then
    write_pid_file "$pid" "$GW_PID_FILE" "$RUNTIME_DIR"
  fi

  if wait_for_health "$pid" "$(gw_url)"; then
    owner="$(port_owner "$(gw_port)" "$(gw_host)" "" "$(gw_url)" "$GW_SRC" "$GW_DIST")"
    if [ -n "$owner" ] && [ "$owner" != "unknown" ] && is_los_pid "$owner" "$GW_SRC" "$GW_DIST"; then
      pid="$owner"
      write_pid_file "$pid" "$GW_PID_FILE" "$RUNTIME_DIR"
    fi
    echo "started pid=$pid"
    echo "log: $GW_LOG_FILE"
    return 0
  fi

  echo "gateway did not become healthy"
  if ! is_running "$pid"; then
    echo "process exited; recent log:"
  else
    echo "process still running but health is unavailable; recent log:"
  fi
  tail -40 "$GW_LOG_FILE" 2>/dev/null || true
  return 1
}

stop_gateway() {
  stop_process \
    "gateway" "$GW_PID_FILE" "$(gw_port)" "$(gw_host)" "$(gw_url)" \
    "$GW_SRC" "$GW_DIST" "$GW_MAINT_FILTER" "" "$GW_LAUNCH_PREFIX" "0"
}

gateway_status() {
  local pid owner
  pid="$(pid_from_file "$GW_PID_FILE")"
  owner="$(port_owner "$(gw_port)" "$(gw_host)" "" "$(gw_url)" "$GW_SRC" "$GW_DIST")"
  echo "  ── gateway ──"
  echo "  url: $(gw_url)"
  echo "  pid file: $GW_PID_FILE"
  echo "  log file: $GW_LOG_FILE"

  if is_los_pid "$owner" "$GW_SRC" "$GW_DIST"; then
    if [ "$owner" != "$pid" ]; then
      write_pid_file "$owner" "$GW_PID_FILE" "$RUNTIME_DIR"
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

  if health_check "$(gw_url)"; then
    echo "  health: ok"
  else
    echo "  health: unavailable"
  fi

  if [ -n "$owner" ]; then
    echo "  port: $(gw_port) owned_by_pid=$owner"
  else
    echo "  port: $(gw_port) not_listening"
  fi
}

# ── Component-level: Executor ────────────────────────────

start_executor() {
  local pid owner
  owner="$(port_owner "$(ex_port)" "$(ex_host)" "" "$(ex_url)" "$EX_SRC" "$EX_DIST")"
  if [ -n "$owner" ] && [ "$owner" != "unknown" ]; then
    if is_los_pid "$owner" "$EX_SRC" "$EX_DIST"; then
      write_pid_file "$owner" "$EX_PID_FILE" "$RUNTIME_DIR"
      echo "executor already running pid=$owner; adopted into $EX_PID_FILE"
      return 0
    fi
    echo "port $(ex_port) is already in use by non-los pid=$owner"
    echo "not starting a second executor"
    return 1
  fi

  pid="$(pid_from_file "$EX_PID_FILE")"
  if is_running "$pid"; then
    echo "executor already running pid=$pid"
    return 0
  fi

  echo "starting los executor at $(ex_url)"
  pid="$(start_executor_process)"
  if [ -n "$pid" ]; then
    write_pid_file "$pid" "$EX_PID_FILE" "$RUNTIME_DIR"
  fi

  if wait_for_health "$pid" "$(ex_url)"; then
    owner="$(port_owner "$(ex_port)" "$(ex_host)" "" "$(ex_url)" "$EX_SRC" "$EX_DIST")"
    if [ -n "$owner" ] && [ "$owner" != "unknown" ] && is_los_pid "$owner" "$EX_SRC" "$EX_DIST"; then
      pid="$owner"
      write_pid_file "$pid" "$EX_PID_FILE" "$RUNTIME_DIR"
    fi
    echo "started pid=$pid"
    echo "log: $EX_LOG_FILE"
    return 0
  fi

  echo "executor did not become healthy"
  if ! is_running "$pid"; then
    echo "process exited; recent log:"
  else
    echo "process still running but health is unavailable; recent log:"
  fi
  tail -40 "$EX_LOG_FILE" 2>/dev/null || true
  return 1
}

stop_executor() {
  stop_process \
    "executor" "$EX_PID_FILE" "$(ex_port)" "$(ex_host)" "$(ex_url)" \
    "$EX_SRC" "$EX_DIST" "$EX_MAINT_FILTER" "$(ex_node_id_arg)" "$EX_LAUNCH_PREFIX" "1" "$(ex_stop_timeout_seconds)"
}

executor_status() {
  local pid owner node_id
  node_id="$(ex_node_id)"
  pid="$(pid_from_file "$EX_PID_FILE")"
  owner="$(port_owner "$(ex_port)" "$(ex_host)" "" "$(ex_url)" "$EX_SRC" "$EX_DIST")"
  echo "  ── executor ──"
  echo "  node: $node_id"
  echo "  url: $(ex_url)"
  echo "  pid file: $EX_PID_FILE"
  echo "  log file: $EX_LOG_FILE"

  if is_los_pid "$owner" "$EX_SRC" "$EX_DIST"; then
    if [ "$owner" != "$pid" ]; then
      write_pid_file "$owner" "$EX_PID_FILE" "$RUNTIME_DIR"
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

  if health_check "$(ex_url)"; then
    echo "  health: ok"
  else
    echo "  health: unavailable"
  fi

  if [ -n "$owner" ]; then
    echo "  port: $(ex_port) owned_by_pid=$owner"
  else
    echo "  port: $(ex_port) not_listening"
  fi
}

# ── Unified commands ─────────────────────────────────────

unified_status() {
  echo "los status"
  echo "  version: $LOS_VERSION"
  if is_executor_enabled; then
    echo "  executor: enabled=true"
  else
    echo "  executor: enabled=false"
  fi
  gateway_status
  if is_executor_enabled; then
    executor_status
    echo ""
    check_agent_key
  else
    echo "  ── executor ──"
    echo "  disabled"
  fi
}

unified_start() {
  mkdir -p "$RUNTIME_DIR"

  if is_executor_enabled; then
    echo "==> starting executor"
    if ! start_executor; then
      echo "WARNING: executor did not start — gateway will run agents locally"
    else
      echo ""
      check_agent_key
    fi
    echo ""
  fi

  echo "==> starting gateway"
  start_gateway
}

unified_stop() {
  echo "==> stopping gateway"
  stop_gateway || true

  if is_executor_enabled; then
    echo ""
    echo "==> stopping executor"
    stop_executor || true
  fi
}

unified_restart() {
  unified_stop
  echo ""
  unified_start
}

# ── Executor maintenance commands ────────────────────────

drain_executor() {
  local timeout_ms="${1:-120000}"
  local node_id
  node_id="$(ex_node_id)"
  (cd "$ROOT" && pnpm --filter "$EX_MAINT_FILTER" run maint -- drain "$node_id" "$timeout_ms")
}

promote_executor() {
  if ! health_check "$(ex_url)"; then
    echo "executor health is unavailable at $(ex_url)/health"
    return 1
  fi
  local node_id
  node_id="$(ex_node_id)"
  (cd "$ROOT" && pnpm --filter "$EX_MAINT_FILTER" run maint -- promote "$node_id")
}

executor_maint_status() {
  local node_id
  node_id="$(ex_node_id)"
  (cd "$ROOT" && pnpm --filter "$EX_MAINT_FILTER" run maint -- status "$node_id")
}

# ── Doctor ───────────────────────────────────────────────

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
        if (cfg.executor.enabled) {
          console.log('executor: enabled (nodeId=' + (cfg.executor.nodeId || 'auto') + ')');
        } else {
          console.log('executor: disabled');
        }
        await closeDb();
      }
      main().catch((err) => {
        console.error(err?.message ?? String(err));
        process.exit(1);
      });
    "
  )

  if health_check "$(gw_url)"; then
    echo "  health: ok at $(gw_url)/health"
  else
    echo "  health: not running at $(gw_url)/health"
  fi
}

# ── Help ─────────────────────────────────────────────────

show_help() {
  cat <<EOF
los process helper

Unified commands:
  build-version Print the deterministic deployable-content version
  start         Start executor (if EXECUTOR_ENABLED=true), then gateway
  stop          Stop gateway first, then executor
  restart       Stop both, then start both
  status        Show gateway and executor health
  doctor        Check runtime prerequisites and config/db access
  help          Show this help

Executor-only (when EXECUTOR_ENABLED=true):
  start-executor   Start only the executor
  stop-executor    Stop only the executor
  drain-executor   Drain executor node (wait for active tasks)
  promote-executor Promote executor node to online
  status-executor  Show executor health + maint status

Gateway-only:
  start-gateway    Start only the gateway
  stop-gateway     Stop only the gateway

Runtime:
  gateway:  $(gw_url)
  executor: $(ex_url) (enabled: $(is_executor_enabled && echo true || echo false))
  pid dir:  $RUNTIME_DIR
EOF
}

# ── Command dispatch ─────────────────────────────────────

case "${1:-help}" in
  # Unified
  help|-h|--help)     show_help ;;
  build-version)      resolve_local_runtime_version; printf '\n' ;;
  status)             unified_status ;;
  start)              unified_start ;;
  stop)               unified_stop ;;
  restart)            unified_restart ;;
  doctor)             doctor_cmd ;;

  # Gateway-only
  start-gateway)      start_gateway ;;
  stop-gateway)       stop_gateway ;;
  status-gateway)     gateway_status ;;

  # Executor-only
  start-executor)     start_executor ;;
  stop-executor)      stop_executor ;;
  status-executor)    executor_status && echo "" && executor_maint_status ;;
  drain-executor)     drain_executor "${2:-}" ;;
  promote-executor)   promote_executor ;;

  *)
    echo "unknown command: $1"
    echo
    show_help
    exit 2
    ;;
esac
