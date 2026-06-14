#!/usr/bin/env bash
# los-common.sh — shared process management utilities for los gateway and executor.
# Source this file, then call the functions with the appropriate arguments.

# ── Generic utilities ───────────────────────────────────

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

read_env_value() {
  local key="$1"
  local file="${2:-$ROOT/.env}"
  [ -f "$file" ] || return 1
  local val
  val="$(awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\''\"]|["'\''\"]$/, "", value)
      print value
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$file")" || return 1
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

pid_from_file() {
  local pid_file="${1:-}"
  [ -f "$pid_file" ] && tr -d '[:space:]' < "$pid_file" || true
}

pid_command() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  ps -p "$pid" -o command= 2>/dev/null || true
}

is_los_pid() {
  # Usage: is_los_pid <pid> <src_path_fragment> [dist_js_fragment]
  local pid="${1:-}" src="${2:-}" dist_js="${3:-}"
  local command
  command="$(pid_command "$pid")"
  [ -n "$command" ] || return 1
  [[ "$command" == *"$ROOT"* ]] || return 1
  [[ "$command" == *"$src"* || ( -n "$dist_js" && "$command" == *"$dist_js"* ) ]]
}

node_bin() {
  command -v node
}

tsx_dist() {
  # Usage: tsx_dist <package_name>  (e.g. "gateway" or "executor")
  local pkg="${1:-gateway}"
  local candidate
  for candidate in \
    "$ROOT"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist \
    "$ROOT"/packages/"$pkg"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist
  do
    if [ -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# ── Port / process detection ─────────────────────────────

port_owner() {
  # Usage: port_owner <port> <host> <pid_file> <url> <src_fragment> [dist_js_fragment]
  local port="${1:-}" host="${2:-127.0.0.1}" pid_file="${3:-}" url="${4:-}" src="${5:-}" dist_js="${6:-}"

  # Prefer the PID file for managed processes.
  local pid
  pid="$(pid_from_file "$pid_file")"
  if [ -n "$pid" ] && is_running "$pid"; then
    printf '%s' "$pid"
    return 0
  fi

  # Recover the listener PID when the pid file is missing or stale.
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then
      # Check if this pid belongs to a los process
      if [ -z "$src" ] || is_los_pid "$pid" "$src" "$dist_js"; then
        printf '%s' "$pid"
        return 0
      fi
    fi
  fi

  # Fall back to connection probe when PID attribution is unavailable.
  if command -v nc >/dev/null 2>&1; then
    if nc -z "$host" "$port" 2>/dev/null; then
      printf 'unknown'
      return 0
    fi
  elif [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
    if curl -fsS "$url/health" >/dev/null 2>&1; then
      printf 'unknown'
      return 0
    fi
  fi

  # Port appears free.
  true
}

# ── Process lifecycle ───────────────────────────────────

write_pid_file() {
  # Usage: write_pid_file <pid> <pid_file> <runtime_dir>
  local pid="${1:-}" pid_file="${2:-}" runtime_dir="${3:-}"
  mkdir -p "$runtime_dir"
  printf '%s\n' "$pid" > "$pid_file"
}

health_check() {
  # Usage: health_check <url>  (e.g. "http://127.0.0.1:8080")
  local url="${1:-}"
  command -v curl >/dev/null 2>&1 || return 2
  curl -fsS "$url/health" >/dev/null 2>&1
}

wait_for_health() {
  # Usage: wait_for_health <pid> <url> [deadline_seconds]
  local pid="${1:-}" url="${2:-}" deadline_sec="${3:-25}"
  local deadline=$((SECONDS + deadline_sec))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_check "$url"; then
      return 0
    fi
    if [ -n "$pid" ] && ! is_running "$pid"; then
      return 1
    fi
    sleep 1
  done
  return 1
}

parent_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true
}

# ── launchctl integration ────────────────────────────────

launch_label() {
  # Usage: launch_label <prefix>  (e.g. "com.los.gateway" or "com.los.executor")
  local prefix="${1:-com.los}"
  local suffix
  suffix="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
  printf '%s.%s.%s' "$prefix" "$(id -u)" "$suffix"
}

launch_remove() {
  local prefix="${1:-com.los}"
  command -v launchctl >/dev/null 2>&1 || return 0
  launchctl remove "$(launch_label "$prefix")" >/dev/null 2>&1 || true
}

# ── Service / node status management ─────────────────────

mark_status() {
  # Usage: mark_status <status> <message> <maint_filter> [extra_args...]
  local status="$1" message="${2:-}" maint_filter="${3:-}" extra_args="${4:-}"
  (
    cd "$ROOT"
    if [ "$status" = "draining" ]; then
      # shellcheck disable=SC2086
      pnpm --filter "$maint_filter" run maint -- drain $extra_args
    elif [ "$status" = "online" ]; then
      # shellcheck disable=SC2086
      pnpm --filter "$maint_filter" run maint -- promote $extra_args
    else
      # shellcheck disable=SC2086
      pnpm --filter "$maint_filter" run maint -- set-status $extra_args offline
      pnpm --filter "$maint_filter" run maint -- set-rollout $extra_args idle "$message"
    fi
  ) >/dev/null 2>&1 || true
}

# ── Daemon process launchers ─────────────────────────────

start_daemon_perl() {
  # Usage: start_daemon_perl <launch_command> <log_file> <launch_prefix>
  # Prints PID to stdout. Requires perl for proper daemonization via setsid().
  local command="$1" log_file="$2" launch_prefix="${3:-com.los}"
  launch_remove "$launch_prefix"
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
  ' "$command" "$log_file"
}

start_daemon_nohup() {
  # Usage: start_daemon_nohup <command> <log_file> [cd_dir]
  # Prints PID to stdout.
  local command="$1" log_file="$2" cd_dir="${3:-}"
  local pid
  if [ -n "$cd_dir" ]; then
    pushd "$cd_dir" >/dev/null
    nohup /bin/bash -lc "$command" </dev/null >"$log_file" 2>&1 &
    pid="$!"
    popd >/dev/null
  else
    nohup /bin/bash -lc "$command" </dev/null >"$log_file" 2>&1 &
    pid="$!"
  fi
  printf '%s' "$pid"
}

start_daemon_launchctl() {
  # Usage: start_daemon_launchctl <command> <log_file> <launch_prefix>
  # Does NOT return a PID (launchctl submit doesn't provide one).
  local command="$1" log_file="$2" launch_prefix="${3:-com.los}"
  local label
  label="$(launch_label "$launch_prefix")"
  launch_remove "$launch_prefix"
  launchctl submit -l "$label" -o "$log_file" -e "$log_file" -- /bin/bash -lc "$command"
}

# ── Coordinated stop helper ──────────────────────────────

stop_process() {
  # Usage: stop_process <name> <pid_file> <port> <host> <url> <src_frag> <dist_frag> <maint_filter> <maint_extra_args> <launch_prefix> [kill_parent]
  # Returns 0 on success (stopped or already stopped), non-zero on forced kill.
  local name="$1" pid_file="$2" port="$3" host="$4" url="$5"
  local src_frag="$6" dist_js_frag="${7:-}" maint_filter="$8" maint_extra="${9:-}" launch_prefix="${10:-com.los}"
  local kill_parent="${11:-0}"

  launch_remove "$launch_prefix"

  # Resolve PID: prefer port owner if it's a los process, fall back to PID file.
  local pid owner
  owner="$(port_owner "$port" "$host" "" "$url" "$src_frag" "$dist_js_frag")"
  if [ -n "$owner" ] && [ "$owner" != "unknown" ] && is_los_pid "$owner" "$src_frag" "$dist_js_frag"; then
    pid="$owner"
    write_pid_file "$pid" "$pid_file" "$(dirname "$pid_file")"
  else
    pid="$(pid_from_file "$pid_file")"
  fi

  if ! is_running "$pid"; then
    if [ -n "$owner" ] && [ "$owner" != "unknown" ] && is_los_pid "$owner" "$src_frag" "$dist_js_frag"; then
      pid="$owner"
      write_pid_file "$pid" "$pid_file" "$(dirname "$pid_file")"
      echo "adopted unmanaged los $name pid=$pid before stopping"
    else
      echo "los $name is not running from $pid_file"
      rm -f "$pid_file"
      mark_status offline "$name stop observed no local process" "$maint_filter" "$maint_extra"
      return 0
    fi
  fi

  local parent=""
  if [ "$kill_parent" = "1" ]; then
    parent="$(parent_pid "$pid")"
  fi

  echo "stopping los $name pid=$pid"
  mark_status draining "$name stop requested" "$maint_filter" "$maint_extra"

  if [ "$kill_parent" = "1" ] && [ -n "$parent" ] && is_los_pid "$parent" "$src_frag" "$dist_js_frag"; then
    echo "stopping los $name parent pid=$parent"
    kill "$parent" >/dev/null 2>&1 || true
  fi
  kill "$pid" >/dev/null 2>&1 || true

  local deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local still_alive=0
    is_running "$pid" && still_alive=1
    [ "$kill_parent" = "1" ] && [ -n "$parent" ] && is_running "$parent" && still_alive=1
    if [ "$still_alive" = "0" ]; then
      rm -f "$pid_file"
      mark_status offline "$name stopped" "$maint_filter" "$maint_extra"
      echo "stopped"
      return 0
    fi
    sleep 1
  done

  echo "process did not stop gracefully; sending SIGKILL"
  kill -9 "$pid" >/dev/null 2>&1 || true
  if [ "$kill_parent" = "1" ] && [ -n "$parent" ] && is_los_pid "$parent" "$src_frag" "$dist_js_frag"; then
    kill -9 "$parent" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
  mark_status offline "$name stopped after SIGKILL" "$maint_filter" "$maint_extra"
  return 1
}
