#!/usr/bin/env bash
# deploy-to-remote.sh — push los executor code to a remote node via Tailscale SSH.
# No git/jj dependency on the remote; syncs via tar pipe over SSH.
#
# Usage (phased):
#   deploy-to-remote.sh <node> preflight           # Check remote resources
#   deploy-to-remote.sh <node> sync                # Push code (tar pipe, no VCS)
#   deploy-to-remote.sh <node> install             # Install deps (pnpm install)
#   deploy-to-remote.sh <node> install --low-resource  # Low-memory install
#   deploy-to-remote.sh <node> install-service     # Install systemd unit
#   deploy-to-remote.sh <node> restart             # Restart executor
#   deploy-to-remote.sh <node> verify              # Health + mode + registry check
#   deploy-to-remote.sh <node> mode                # Read-only mode contract check
#   deploy-to-remote.sh mode-check <env> [health]  # Local fixture validation (no SSH)
#
# Recovery shortcuts:
#   deploy-to-remote.sh <node> status              # Show remote state
#   deploy-to-remote.sh <node> logs                # Tail executor journal
#   deploy-to-remote.sh <node> firewall            # Apply firewall rules
#   deploy-to-remote.sh <node> cmd "..."           # Run arbitrary command
#   deploy-to-remote.sh <node> deploy              # sync + install + install/start service
#
# Environment:
#   LOS_REMOTE_USER=root        # Remote SSH user
#   LOS_REMOTE_HOME=/opt/los    # Remote los path
#   LOS_LOW_RESOURCE=1          # Force low-resource mode
#   LOS_SSH_TRANSPORT=ssh       # Use OpenSSH instead of Tailscale SSH
#   LOS_SSH_TARGET=node-alias   # OpenSSH config alias or explicit target
#   LOS_REMOTE_PRIVILEGE=sudo   # Elevate remote deployment commands
#   LOS_DEPLOY_VERIFY_GRACE_SECONDS=90  # Bounded wait for transitional systemd state
set -euo pipefail

# ── Executor DB/token mode contract ─────────────────────────
# One validator, four callers: `mode-check` (local fixtures), `preflight`
# (remote .env, no health), `verify` (remote .env + /health), and the read-only
# `mode` command. The parser lives in tools/executor-mode-snapshot.mjs so the
# local and remote paths cannot disagree with each other (or with
# `loadEnvFile()`); this script only enforces the policy.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE_SNAPSHOT_HELPER="$SCRIPT_DIR/executor-mode-snapshot.mjs"

# Snapshot lines are emitted by the helper: plain `KEY=value`, no quotes/BOM.
snapshot_value() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2-
}

# Returns 0 only when the snapshot (and optional health JSON) satisfy the
# declared mode. Prints FAIL/WARN lines to stderr; prints one `mode:` summary.
validate_mode_env() {
  local env_file="$1" health_file="${2:-}"
  local fails=0
  local db_mode task_mode gateway_url database_url
  local health_fields="" h_db="" h_task="" h_lease="" h_event="" h_spool=""

  fail() { printf 'FAIL: %s\n' "$*" >&2; fails=$((fails + 1)); }
  note() { printf 'WARN: %s\n' "$*" >&2; }

  if [ -z "$env_file" ] || [ ! -r "$env_file" ]; then
    fail "mode snapshot is missing or unreadable: ${env_file:-<none>}"
    printf 'mode-check: FAILED (%d)\n' "$fails" >&2
    return 1
  fi
  case "$(head -1 "$env_file")" in
    __ENV_MISSING__)
      fail "the node has no .env at the configured path (mode cannot be declared)"
      printf 'mode-check: FAILED (%d)\n' "$fails" >&2
      return 1
      ;;
    __ENV_UNREADABLE__)
      fail "the node .env is unreadable by the deploy identity (check owner/mode, or use LOS_REMOTE_PRIVILEGE=sudo)"
      printf 'mode-check: FAILED (%d)\n' "$fails" >&2
      return 1
      ;;
    __ENV_NOT_A_FILE__)
      fail "the configured .env path is not a regular file"
      printf 'mode-check: FAILED (%d)\n' "$fails" >&2
      return 1
      ;;
  esac

  db_mode="$(snapshot_value "$env_file" EXECUTOR_DB_MODE)"
  task_mode="$(snapshot_value "$env_file" EXECUTOR_TASK_TOKEN_MODE)"
  gateway_url="$(snapshot_value "$env_file" GATEWAY_URL)"
  database_url="$(snapshot_value "$env_file" DATABASE_URL)"

  case "$db_mode" in
    none)
      [ -z "$database_url" ] || fail "EXECUTOR_DB_MODE=none but DATABASE_URL is set (remove it; a credential is not a mode)"
      [ -n "$gateway_url" ] || fail "EXECUTOR_DB_MODE=none requires GATEWAY_URL"
      [ "$task_mode" = "required" ] || fail "EXECUTOR_DB_MODE=none requires EXECUTOR_TASK_TOKEN_MODE=required (found '${task_mode:-unset}')"
      ;;
    required)
      [ -n "$database_url" ] || fail "EXECUTOR_DB_MODE=required but DATABASE_URL is unset"
      ;;
    "")
      note "EXECUTOR_DB_MODE is undeclared; treating this node as legacy DB mode (declare required or none)"
      [ -n "$database_url" ] || fail "EXECUTOR_DB_MODE is undeclared and DATABASE_URL is unset; declare none (with GATEWAY_URL and EXECUTOR_TASK_TOKEN_MODE=required) or set DATABASE_URL"
      ;;
    *)
      fail "EXECUTOR_DB_MODE='$db_mode' is invalid (expected required|none)"
      ;;
  esac

  if [ "$task_mode" = "required" ] && [ -z "$gateway_url" ]; then
    fail "EXECUTOR_TASK_TOKEN_MODE=required requires GATEWAY_URL"
  fi

  if [ -n "$health_file" ]; then
    if [ ! -s "$health_file" ]; then
      fail "health snapshot is empty: $health_file"
    else
      health_fields="$(node -e '
        const fs = require("node:fs");
        try {
          const h = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const s = (v) => (v === undefined || v === null ? "" : String(v));
          process.stdout.write([s(h.db), s(h.taskTokenMode), s(h.leaseTransport), s(h.eventBacklog), s(h.spoolBacklog)].join("|"));
        } catch {
          process.exit(3);
        }
      ' "$health_file" 2>/dev/null)" || fail "health snapshot is not valid JSON: $health_file"
    fi
  fi

  if [ -n "$health_fields" ]; then
    IFS='|' read -r h_db h_task h_lease h_event h_spool <<< "$health_fields"
    case "$db_mode" in
      none)
        [ "$h_db" = "none" ] || fail "health.db='${h_db:-<missing>}' but EXECUTOR_DB_MODE=none"
        [ "$h_task" = "required" ] || fail "health.taskTokenMode='${h_task:-<missing>}' but expected required"
        [ "$h_lease" = "http-when-token" ] || fail "health.leaseTransport='${h_lease:-<missing>}' but expected http-when-token"
        if [ -n "$h_event" ] && [ "$h_event" != "0" ]; then
          if [ "${LOS_DEPLOY_REQUIRE_ZERO_BACKLOG:-0}" = "1" ]; then
            fail "eventBacklog=$h_event (LOS_DEPLOY_REQUIRE_ZERO_BACKLOG=1)"
          else
            note "eventBacklog=$h_event — the gateway event sink is behind; re-check before promoting"
          fi
        fi
        if [ -n "$h_spool" ] && [ "$h_spool" != "0" ]; then
          if [ "${LOS_DEPLOY_REQUIRE_ZERO_BACKLOG:-0}" = "1" ]; then
            fail "spoolBacklog=$h_spool (LOS_DEPLOY_REQUIRE_ZERO_BACKLOG=1)"
          else
            note "spoolBacklog=$h_spool — unacknowledged events remain on disk"
          fi
        fi
        ;;
      required)
        [ "$h_db" = "postgres" ] || fail "health.db='${h_db:-<missing>}' but EXECUTOR_DB_MODE=required"
        ;;
      "")
        # Undeclared means the legacy DB path. A process booted from a YAML or
        # unit-level `dbMode: none` would report db=none here; that must not pass
        # as "legacy is fine" (the false green the adversarial review found).
        if [ -n "$h_db" ] && [ "$h_db" != "postgres" ]; then
          fail "health.db='$h_db' but this node declares no EXECUTOR_DB_MODE (legacy assumes postgres); declare none explicitly"
        elif [ -z "$h_db" ]; then
          note "health has no db field (older build); legacy mode cannot be confirmed from /health"
        fi
        ;;
    esac
    if [ "$task_mode" = "required" ] && [ "$db_mode" != "none" ] && [ -n "$h_lease" ] && [ "$h_lease" != "http-when-token" ]; then
      fail "health.leaseTransport='$h_lease' but EXECUTOR_TASK_TOKEN_MODE=required"
    fi
  fi

  local gw_state="unset" db_state="unset"
  [ -n "$gateway_url" ] && gw_state="set"
  [ -n "$database_url" ] && db_state="set"
  printf 'mode: db=%s taskToken=%s gateway=%s database=%s\n' \
    "${db_mode:-legacy}" "${task_mode:-auto}" "$gw_state" "$db_state"
  if [ "$fails" -eq 0 ]; then
    printf 'mode-check: ok\n'
    return 0
  fi
  printf 'mode-check: FAILED (%d)\n' "$fails" >&2
  return 1
}

# Local negative-control entry point. Runs the same snapshot helper as the node
# path, so a fixture cannot get a different verdict from the remote validator:
#   deploy-to-remote.sh mode-check <env-file> [health-json]
if [ "${1:-}" = "mode-check" ]; then
  case "${2:-}" in
    "" )
      echo "usage: deploy-to-remote.sh mode-check <env-file> [health-file]" >&2
      exit 2
      ;;
    -h|--help)
      cat <<'EOF'
mode-check — validate an executor env file (and optional /health JSON)

Usage:
  deploy-to-remote.sh mode-check <env-file> [health-file]

The env file is parsed by tools/executor-mode-snapshot.mjs, the same helper the
node path uses. EXECUTOR_DB_MODE=none requires no DATABASE_URL, a GATEWAY_URL,
and EXECUTOR_TASK_TOKEN_MODE=required; health must report db=none and
leaseTransport=http-when-token. EXECUTOR_DB_MODE=required requires DATABASE_URL
and health db=postgres. An undeclared mode is legacy and warns, but it still
needs DATABASE_URL and health.db=postgres when /health is supplied.

Set LOS_DEPLOY_REQUIRE_ZERO_BACKLOG=1 to fail on non-zero event/spool backlog.
EOF
      exit 0
      ;;
  esac
  mode_snapshot="$(mktemp "${TMPDIR:-/tmp}/los-executor-mode.XXXXXX")"
  if ! node "$MODE_SNAPSHOT_HELPER" "$2" > "$mode_snapshot"; then
    rm -f "$mode_snapshot"
    echo "FAIL: executor-mode-snapshot.mjs could not read $2" >&2
    exit 2
  fi
  validate_mode_env "$mode_snapshot" "${3:-}"
  mode_rc=$?
  rm -f "$mode_snapshot"
  exit "$mode_rc"
fi

NODE="${1:-}"
CMD="${2:-help}"
# `tarball` 是"不需要目标节点"的工具型子命令（Windows 驱动用它拿到与 Linux 完全相同的
# 下发内容），因此必须在按 NODE 做连通性检查**之前**处理。
if [ "$NODE" = "tarball" ]; then
  _out="${2:-/tmp/los-ship.tar.gz}"
  # LOS_DEPLOY_TARBALL：复用一份**已冻结**的包（编排器在滚动开始时打一次，所有节点共用）。
  # 好处是结构性的：一次滚动里所有节点拿到的字节完全相同，滚到一半有人改工作树也影响不到这一轮
  # ——"目标漂移"从"要检测的故障"变成"不可能发生"。见 los-fleet-rollout.sh 的 freeze_payload。
  if [ -n "${LOS_DEPLOY_TARBALL:-}" ]; then
    [ -f "$LOS_DEPLOY_TARBALL" ] || { echo "LOS_DEPLOY_TARBALL not found: $LOS_DEPLOY_TARBALL" >&2; exit 1; }
    _out="$LOS_DEPLOY_TARBALL"
  else
    COPYFILE_DISABLE=1 tar czf "$_out" -C "$(cd "$(dirname "$0")/.." && pwd)" \
      --exclude='node_modules' --exclude='.git' --exclude='.jj' --exclude='.DS_Store' \
      --exclude='._*' --exclude='packages/*/.los' --exclude='packages/*/.los/*' \
      --exclude='.los-runtime' --exclude='tmp' --exclude='dist' --exclude='.tsbuildinfo' \
      --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' --exclude='test-results' \
      tools/ deploy/ packages/ contracts/ \
      package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json \
      || { echo "tarball build failed" >&2; exit 1; }
  fi
  # 同时落一份**清单**（`$_out.list`）：它是"这次到底下发了哪些文件"的唯一真源，
  # 由 tar 自己枚举，所以不可能与包内容漂移。Linux 侧的剪枝在远程重新枚举一次；
  # Windows 驱动没有 bash，需要把这份清单传上节点才能做同样的剪枝
  # （2026-10-11：Windows 一直没有剪枝，节点上积了 45 个陈旧文件，内容摘要与目标不符
  #  却看不出来 —— 那时 Windows 还没有摘要）。复用冻结包时清单可能不存在，就地从包里重算。
  if [ ! -f "$_out.list" ]; then
    COPYFILE_DISABLE=1 tar tzf "$_out" | grep -v '/$' | LC_ALL=C sort > "$_out.list" \
      || { echo "tarball manifest build failed" >&2; exit 1; }
  fi
  printf '%s %s\n' "$_out" "$(shasum -a 256 "$_out" | cut -d' ' -f1)"
  exit 0
fi
shift 2 2>/dev/null || true
CMD_ARGS=("$@")


if [ -z "$NODE" ] || [ "$NODE" = "help" ] || [ "$NODE" = "-h" ] || [ "$NODE" = "--help" ]; then
  cat <<'EOF'
deploy-to-remote.sh — push los executor to a Tailscale node (no remote VCS needed)

Phased commands:
  preflight           Check remote memory/swap/disk/PSI before heavy ops
  sync                Push code via tar pipe (no git/jj on remote)
  install             Install deps (pnpm) + the pinned unirun (supports --low-resource)
  install-service     Install systemd unit
  restart             Restart executor service
  verify              Health + mode contract + connectivity validation
  digest              Read-only: compare the node content digest against the target
  mode                Read-only: validate the node .env + /health mode contract
  promote             Clear the restart-induced drain (needs --node-id <id>)

Options:
  --node-id <id>      Registry node id (also via LOS_REMOTE_NODE_ID); enables auto-promote after verify

Environment:
  LOS_DEPLOY_AUTO_PROMOTE=0   Do not promote automatically at the end of verify
  LOS_SSH_OPTS                Extra ssh(1) options, e.g. -o ControlPath=none
  LOS_DEPLOY_SYNC_MODE        upload (default: scp + sha256 + extract on the node) | pipe (legacy)
  LOS_REQUIRE_UNIRUN=1        Fail instead of warning when the pinned unirun is missing/unusable
  LOS_DEPLOY_REQUIRE_ZERO_BACKLOG=1  Fail verify/mode when event or spool backlog is non-zero

Shortcuts:
  status              Show remote state
  logs                Tail executor journal
  firewall            Apply firewall rules
  cmd "<cmd>"         Run arbitrary command on remote
  deploy              sync + install + install/start service (all-in-one)
  full-setup          preflight + sync + install + install/start service + verify

Options:
  --low-resource      Use reduced concurrency for pnpm install (only with 'install')

Verification:
  LOS_DEPLOY_VERIFY_GRACE_SECONDS  Wait for transitional systemd state (default: 90s)

Nodes: oracle, tencent-sin, vultr, hh-sgp1, 34 (via tencent-sin relay)
EOF
  exit 0
fi

# ── Config ──────────────────────────────────────────────────
REMOTE_USER="${LOS_REMOTE_USER:-root}"
REMOTE_HOME="${LOS_REMOTE_HOME:-/opt/los}"
SSH_TRANSPORT="${LOS_SSH_TRANSPORT:-tailscale}"
REMOTE_PRIVILEGE="${LOS_REMOTE_PRIVILEGE:-none}"
LOCAL_REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_BASE="${LOCAL_REPO}/.los-runtime/deploy-logs"
mkdir -p "$LOG_BASE"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BUILD_VERSION="${LOS_DEPLOY_VERSION:-$(bash "$LOCAL_REPO/tools/los.sh" build-version)}"
VERIFY_GRACE_SECONDS="${LOS_DEPLOY_VERIFY_GRACE_SECONDS:-90}"
# Extra ssh(1) options, word-split. Set LOS_SSH_OPTS='-o ControlPath=none
# -o ControlMaster=no' to bypass ~/.ssh/config connection multiplexing: a
# multiplexed master that drops mid-transfer makes sync abort silently (the
# local script runs under `set -e`), which is how node34 lost its version stamp
# and tencent-sin lost a whole sync during the 2026-10-06 rollout.
SSH_OPTS="${LOS_SSH_OPTS:-}"
# Registry node id, used by `promote` and by the post-verify hint.
NODE_ID="${LOS_REMOTE_NODE_ID:-}"
for ((i = 0; i < ${#CMD_ARGS[@]}; i++)); do
  if [ "${CMD_ARGS[$i]}" = "--node-id" ] && [ $((i + 1)) -lt ${#CMD_ARGS[@]} ]; then
    NODE_ID="${CMD_ARGS[$((i + 1))]}"
  fi
done

# ── Detect Tailscale hostname ───────────────────────────────
resolve_ts_host() {
  local name="$1"
  if echo "$name" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "$name"; return
  fi
  if command -v tailscale >/dev/null 2>&1; then
    local ip
    ip="$(tailscale status --json 2>/dev/null | grep -i "\"hostname\":\"$name\"" -A1 | grep '"tailscale_ip"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || true)"
    if [ -n "$ip" ]; then echo "$ip"; return; fi
  fi
  echo "$name"
}

TS_HOST="$(resolve_ts_host "$NODE")"
SSH_TARGET="${LOS_SSH_TARGET:-$REMOTE_USER@$TS_HOST}"

log()      { printf '[deploy:%s] %s\n' "$NODE" "$*" | tee -a "$1"; }
log_info() { printf '[deploy:%s] %s\n' "$NODE" "$*"; }
log_warn() { printf '[deploy:%s] WARN: %s\n' "$NODE" "$*"; }
die()      { printf '[deploy:%s] FATAL: %s\n' "$NODE" "$*"; exit 1; }

case "$VERIFY_GRACE_SECONDS" in
  ''|*[!0-9]*) die "LOS_DEPLOY_VERIFY_GRACE_SECONDS must be a positive integer" ;;
esac
[ "$VERIFY_GRACE_SECONDS" -gt 0 ] || die "LOS_DEPLOY_VERIFY_GRACE_SECONDS must be greater than zero"

case "$SSH_TRANSPORT" in
  tailscale|ssh|local) ;;
  *) die "unsupported LOS_SSH_TRANSPORT '$SSH_TRANSPORT' (expected tailscale, ssh or local)" ;;
esac

case "$REMOTE_PRIVILEGE" in
  none|sudo) ;;
  *) die "unsupported LOS_REMOTE_PRIVILEGE '$REMOTE_PRIVILEGE' (expected none or sudo)" ;;
esac

# ── Remote exec helpers ─────────────────────────────────────
remote_exec() {
  local remote_command
  printf -v remote_command '%q ' "$@"
  if [ "$SSH_TRANSPORT" = "local" ]; then
    # ── local：目标就是本机的一棵**钉树**（2026-10-11，mbp-executor-1）──
    # 为什么不另写一套"本地同步"：那会给"把内容放进一棵树"造出第二份实现，而两份必然漂移
    # （本仓已被这句话打中多次）。这里让同一套 tar／剪枝／盖章／收敛守卫作用在本机目录上，
    # 于是钉树与 M3、与远端节点走的是**同一条路径**。
    # 不经过登录 shell：与 SSH 上 `sh -c` 的语义一致（PATH 由调用方给）。
    bash -c "$remote_command"
  elif [ "$SSH_TRANSPORT" = "ssh" ]; then
    # $SSH_OPTS is intentionally unquoted so operators can pass several flags.
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "$SSH_TARGET" "$remote_command"
  else
    tailscale ssh "$SSH_TARGET" -- "$remote_command"
  fi
}

remote_sh() {
  if [ "$REMOTE_PRIVILEGE" = "sudo" ]; then
    remote_exec sudo -- "$@"
  else
    remote_exec "$@"
  fi
}

remote_su_sh() {
  remote_sh su - los -c "$*"
}

# Read only the mode-shaped keys from the node's .env. The node reduces
# DATABASE_URL to set/unset, so a credential never leaves the host. Output is a
# tiny env-shaped snapshot consumed by validate_mode_env.
read_remote_mode_env() {
  # Run the local helper over stdin instead of requiring a synced copy on the
  # node: preflight runs before sync, so a remote helper file would create a
  # bootstrap deadlock (and would let old/new helper versions disagree).
  remote_sh node --input-type=module - "$REMOTE_HOME/.env" < "$MODE_SNAPSHOT_HELPER"
}

# Fail-closed mode gate used by preflight (env only) and verify (env + health).
# Keep the temp files out of the deploy log: they carry GATEWAY_URL, not secrets.
check_remote_mode() {
  local health_file="${1:-}"
  local snapshot rc=0
  snapshot="$(mktemp "${TMPDIR:-/tmp}/los-executor-mode.XXXXXX")"
  if ! read_remote_mode_env > "$snapshot"; then
    rm -f "$snapshot"
    printf 'FAIL: could not read mode keys from %s/.env\n' "$REMOTE_HOME" >&2
    return 1
  fi
  validate_mode_env "$snapshot" "$health_file" || rc=$?
  rm -f "$snapshot"
  return "$rc"
}

# pnpm 必须以**节点的服务身份**运行，否则 node_modules 的链接归错人。
# Linux 节点的服务用户是 `los`，但 macOS 节点没有这个用户（launchd 以登录用户跑执行器），
# `su - los` 在那里必然失败。2026-10-11 实测：新增 workspace 包 `@los/mcp-stdio` 后，
# M3 的 packages/agent/node_modules/@los 缺链接，重启即 ERR_MODULE_NOT_FOUND 崩溃循环
# —— 与 Windows 那次是同一个失效模式（"发布器没有 install 步骤"）。
#
# 判据必须是"能不能真的 su 过去"，不能是"这个名字存不存在"：M3 的目录服务把**不存在的名字**
# `los` 解析成了当前用户（`id -u los` → 501、exit 0，而 `dscl . -list /Users` 里没有 los），
# 用它做判据会选错分支。`su - los -c true` 在 M3 上立刻 "su: Sorry"（无 TTY，不会挂住），
# 在 Linux 节点上成功。
remote_pnpm_sh() {
  if remote_sh su - los -c true </dev/null >/dev/null 2>&1; then
    remote_su_sh "$1"
  else
    remote_sh sh -c "$1"
  fi
}

check_conn() {
  log_info "checking $SSH_TRANSPORT connectivity to $SSH_TARGET..."
  if ! remote_exec echo "ok" >/dev/null 2>&1; then
    die "cannot connect to $SSH_TARGET with $SSH_TRANSPORT. Check SSH config and authentication."
  fi
  log_info "  connected"
}

# ── Preflight ───────────────────────────────────────────────
# Returns 0 if safe, emits warnings otherwise.
# Blocks (exit 1) only if RAM <=1GB + no swap (pnpm install would OOM).
do_preflight() {
  local log_file="$LOG_BASE/${NODE}-preflight-${TIMESTAMP}.log"
  log_info "running preflight on $TS_HOST (log: $log_file)"

  remote_sh bash -s <<'PREFLIGHT' > "$log_file" 2>&1
set -euo pipefail

safe=true
ram_kb=0 swap_kb=0

# RAM
if [ -f /proc/meminfo ]; then
  ram_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
fi
ram_mb=$((ram_kb / 1024))
printf 'RAM: %d MB\n' "$ram_mb"

free -h 2>/dev/null || true

# Swap
swapon --show 2>/dev/null || echo "  (no active swap)"
if [ -f /proc/meminfo ]; then
  swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
fi
swap_mb=$((swap_kb / 1024))
printf 'SwapTotal: %d MB\n' "$swap_mb"

# PSI pressure
for psi in /proc/pressure/*; do
  [ -f "$psi" ] || continue
  printf '%s: %s\n' "$(basename "$psi")" "$(tr '\n' ' ' < "$psi")"
done

# Disk
df -h / /opt 2>/dev/null || true

# Essential services
for svc in tailscaled ssh docker; do
  if command -v systemctl >/dev/null 2>&1; then
    state=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
    printf 'service %s: %s\n' "$svc" "$state"
  fi
done

# Docker containers (non-LOS)
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || true
fi

# Rules
if [ "$ram_mb" -le 1024 ] && [ "$swap_mb" -eq 0 ]; then
  printf 'BLOCK: RAM <= 1GB and no swap — cannot run pnpm install\n'
  safe=false
fi
if [ "$swap_mb" -gt 0 ] && [ "$swap_mb" -lt 2048 ]; then
  printf 'WARN: swap < 2GB — consider increasing or use --low-resource\n'
fi
# Check PSI full pressure
for psi_file in /proc/pressure/memory /proc/pressure/io; do
  [ -f "$psi_file" ] || continue
  full_avg=$(awk -F'[ =]' '/full avg/{print $3}' "$psi_file" 2>/dev/null || true)
  if [ -n "$full_avg" ] && [ "$full_avg" != "0.00" ]; then
    printf 'WARN: %s full avg10=%.2f — system under pressure\n' "$(basename "$psi_file")" "$full_avg"
  fi
done

printf 'preflight_result: %s\n' "$safe"
PREFLIGHT

  if grep -q 'preflight_result: false' "$log_file"; then
    log_warn "preflight BLOCKED — see $log_file"
    log_warn "Next: resolve resource issues and retry, or manually run: $0 $NODE preflight"
    return 1
  fi

  # Configuration truth is part of preflight. A node that declares `none` but
  # still carries DATABASE_URL (or declares `required` with no database) must be
  # stopped here, before install/cutover, not discovered after a restart.
  if ! check_remote_mode; then
    log_warn "preflight BLOCKED — executor mode contract violated (see FAIL lines above)"
    log_warn "Fix $REMOTE_HOME/.env, then re-run: $0 $NODE preflight"
    return 1
  fi

  log_info "preflight passed — see $log_file"
}

# ── Sync (tar pipe, no VCS on remote) ──────────────────────
# 下发内容的唯一打包实现：Windows 驱动也调用它（`tarball` 子命令），
# 避免"同一份文件选择"出现第 4 个拷贝（2026-10-06 的教训：两套实现必然漂移）。
build_ship_tar() {
  local out="$1"
  COPYFILE_DISABLE=1 tar czf "$out" -C "$LOCAL_REPO" \
    --exclude='node_modules' --exclude='.git' --exclude='.jj' --exclude='.DS_Store' \
    --exclude='._*' --exclude='packages/*/.los' --exclude='packages/*/.los/*' \
    --exclude='.los-runtime' --exclude='tmp' --exclude='dist' --exclude='.tsbuildinfo' \
    tools/ deploy/ packages/ contracts/ \
    package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json
}

do_sync() {
  local log_file="$LOG_BASE/${NODE}-sync-${TIMESTAMP}.log"
  SYNC_EXTRACTED=0   # 供 EXIT trap 区分「还没动过节点」与「解包到一半」
  # 收敛守卫由 EXIT trap 调用，看不到 do_sync 的 local，所以路径要放到全局，
  # 否则守卫的诊断信息会以 "log_file: unbound variable" 半路夭折。
  SYNC_LOG_FILE="$log_file"
  log_info "syncing code to $TS_HOST via tar pipe (log: $log_file)"
  # 收敛判定（含"中途失败"这条路径）在退出时统一执行。
  trap 'sync_convergence_guard' EXIT

  # Ship every workspace package so frozen-lockfile validation sees the same
  # manifests as the lockfile. Omitting runtime dependencies left stale source;
  # omitting unrelated manifests also makes pnpm reject the workspace.
  local tmp_tar="$LOG_BASE/${NODE}-sync-${TIMESTAMP}.tar.gz"
  # 冻结包复用：编排器在滚动开始时打一次包，这一轮所有节点共用同一份字节。
  # 结构性地消除"滚到一半源变了"（否则只能事后检测 + 中止，而中止时前面的节点已经滚过了）。
  local frozen_tar=""
  if [ -n "${LOS_DEPLOY_TARBALL:-}" ]; then
    [ -f "$LOS_DEPLOY_TARBALL" ] || die "LOS_DEPLOY_TARBALL not found: $LOS_DEPLOY_TARBALL"
    frozen_tar="$LOS_DEPLOY_TARBALL"
    tmp_tar="$frozen_tar"
    log_info "  payload: frozen by the orchestrator ($(basename "$frozen_tar"))"
  fi

  # Create tar from local repo — only ship what the executor needs.
  # COPYFILE_DISABLE stops bsdtar from emitting AppleDouble `._*` sidecar
  # entries, which otherwise land on the node as junk that pollutes its
  # content-hash version.
  [ -n "$frozen_tar" ] || COPYFILE_DISABLE=1 tar czf "$tmp_tar" -C "$LOCAL_REPO" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.jj' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    --exclude='packages/*/.los' \
    --exclude='packages/*/.los/*' \
    --exclude='.los-runtime' \
    --exclude='tmp' \
    --exclude='dist' \
    --exclude='.tsbuildinfo' \
    --exclude='*.db' \
    --exclude='*.db-shm' \
    --exclude='*.db-wal' \
    --exclude='test-results' \
    tools/ \
    deploy/ \
    packages/ \
    contracts/ \
    package.json \
    pnpm-lock.yaml \
    pnpm-workspace.yaml \
    tsconfig.base.json \
    turbo.json

  log_info "  tar: $(du -h "$tmp_tar" | cut -f1)"
  # 与 remote_sh 的 ssh 选项保持一致：少了 BatchMode/ConnectTimeout，scp 会走交互式认证并
  # 以 "Connection closed" 失败（实测：同一目标手动加 BatchMode 即成功）。
  LOS_SCP_OPTS="-o BatchMode=yes -o ConnectTimeout=20 ${LOS_SSH_OPTS:-}"

  # 传输方式。默认 **upload**：先 scp 到节点 /tmp、双侧比对 sha256、再在节点本地解包。
  # 原因是 pipe 模式（`cat tar | ssh … 'tar xzf -'`）在 SSH 控制连接中途断开时会留下
  # **半截树** —— 2026-10-06 tencent-sin 因此崩溃掉线、vultr 树到目标但 .env 未盖章，
  # 而且每次重试都得到不同的 build-version 摘要。已传完的文件不会因连接断开而截断，
  # 所以 upload 是可判定的：sha256 不符就是不完整，重传即可。
  # LOS_DEPLOY_SYNC_MODE=pipe 可回退到旧行为（仅用于对比排查）。
  local sync_mode="${LOS_DEPLOY_SYNC_MODE:-upload}"
  if [ "$sync_mode" = "pipe" ]; then
    log_info "  transport: pipe (legacy)"
    cat "$tmp_tar" | remote_sh sh -c \
      "mkdir -p '$REMOTE_HOME' && cd '$REMOTE_HOME' && tar xzf - && { chown -R los:los . 2>/dev/null || true; }" \
      >> "$log_file" 2>&1
  else
    local local_sha
    local_sha="$(shasum -a 256 "$tmp_tar" | cut -d' ' -f1)"
    local remote_tar="/tmp/${NODE}-sync-${TIMESTAMP}.tar.gz"
    local ok=0
    for attempt in 1 2 3; do
      # 必须用 $SSH_TARGET（与 ssh 路径同一个目标），**不能**用 $TS_HOST：
      # resolve_ts_host 会把别名解析成裸 Tailscale IP，从而丢掉 ssh config 里的
      # Port/User/IdentityFile —— 实测表现为 "Connection closed by <ip> port 22"，
      # 而手动用别名 scp 则成功。
      if [ "$SSH_TRANSPORT" = "local" ]; then
        # local 传输没有 scp：同一台机器上就是一次 cp（路径语义与远端 /tmp 一致）
        if ! cp "$tmp_tar" "$remote_tar" >> "$log_file" 2>&1; then
          log_warn "  upload attempt $attempt failed (cp)"
          sleep 3
          continue
        fi
      elif ! scp $LOS_SCP_OPTS "$tmp_tar" "$SSH_TARGET:$remote_tar" >> "$log_file" 2>&1; then
        log_warn "  upload attempt $attempt failed (scp)"
        sleep 3
        continue
      fi
      local got_sha
      got_sha="$(remote_sh sh -c "shasum -a 256 '$remote_tar' 2>/dev/null || sha256sum '$remote_tar' 2>/dev/null" | cut -d' ' -f1 | tr -d '\r')"
      if [ "$got_sha" != "$local_sha" ]; then
        log_warn "  upload attempt $attempt failed (sha256 mismatch: ${got_sha:-<none>})"
        sleep 3
        continue
      fi
      ok=1
      break
    done
    [ "$ok" = "1" ] || die "upload to $TS_HOST failed after 3 attempts (sha256 never matched) — nothing was extracted"
    log_info "  transport: upload (sha256 verified)"
    remote_sh sh -c "mkdir -p '$REMOTE_HOME' && cd '$REMOTE_HOME' && tar xzf '$remote_tar' && rm -f '$remote_tar' && { chown -R los:los . 2>/dev/null || true; }" \
      >> "$log_file" 2>&1
  fi

  SYNC_EXTRACTED=1
  log_info "  extracted to $REMOTE_HOME"

  # Normalize source modes. A file created under umask 077 lands as 0600, and
  # `tools/los.sh build-version` hashes every source file — for an SSH user that
  # is not the owner the read fails and the fleet version identity breaks
  # (observed on oracle 2026-10-06: "shasum: tools/ci-health-check.sh: Permission
  # denied" instead of a version). tar carries modes, so fixing them here makes
  # every future sync self-healing. node_modules is pruned: it is huge, is not
  # shipped, and already has sane modes.
  remote_sh sh -c "cd '$REMOTE_HOME' && chmod -R a+rX tools deploy contracts 2>/dev/null; find packages -name node_modules -prune -o -exec chmod a+rX {} + 2>/dev/null; true" \
    >> "$log_file" 2>&1 || true

  # Prune files that no longer exist in the repo. tar extraction only adds and
  # overwrites, so a file deleted upstream lingers on the node forever — and
  # since `tools/los.sh build-version` hashes every source file, the node's own
  # version then never converges to the fleet target (observed on vultr
  # 2026-10-06: 41 stale files from the old flat packages/agent/src/tools layout
  # kept it reporting 0.1.0+b857d2dfc47ee while the target was another hash).
  # node_modules / dist / .turbo are pruned on both sides, so installed deps and
  # build output are never candidates.
  local shipped_list="$LOG_BASE/${NODE}-shipped-${TIMESTAMP}.list"
  COPYFILE_DISABLE=1 tar tzf "$tmp_tar" | grep -v '/$' | LC_ALL=C sort > "$shipped_list"
  local want_lines got_lines
  want_lines="$(wc -l < "$shipped_list" | tr -d ' ')"
  got_lines=""
  for attempt in 1 2; do
    cat "$shipped_list" | remote_sh sh -c 'cat > /tmp/los-shipped.list' >> "$log_file" 2>&1 || true
    got_lines="$(remote_sh sh -c 'wc -l < /tmp/los-shipped.list' 2>/dev/null | tr -d ' \r' || true)"
    [ "$got_lines" = "$want_lines" ] && break
    log_warn "  shipped manifest upload mismatch ($got_lines/$want_lines lines), retrying"
    sleep 3
  done
  if [ "$got_lines" != "$want_lines" ]; then
    # 清单缺失必须让剪枝"跳过"而不是"全删":2026-10-06 vultr 上它曾表现为
    # "1235 个陈旧文件",靠 >500 的闸门才没误删。
    log_warn "  shipped manifest upload failed ($got_lines/$want_lines) — skipping the stale-file prune"
    remote_sh sh -c 'rm -f /tmp/los-shipped.list' >> "$log_file" 2>&1 || true
  fi
  # 这一步的输出必须**落进 sync 日志**：2026-10-11 M3 的排查卡了很久，正是因为 prune
  # 的输出既不在日志里（日志 0 字节，看起来像"传输前就断了"），失败也不出声
  # （下一行无条件打印 "prune: done"）。现在输出统一进日志，摘要回显到编排器的 stdout，
  # 失败显式 return 1（由 EXIT trap 的收敛守卫接手）。
  local prune_out=""
  if ! prune_out="$(remote_sh bash -s "$REMOTE_HOME" <<'PRUNE_STALE' 2>&1
# 全脚本强制 C locale：两个列表用 `LC_ALL=C sort` 生成，但 comm **自身**会按环境 locale
# 校验"是否有序"。vultr 的 LANG=en_US.UTF-8 下，comm 把 C 排序的清单判成无序 → 乱序双指针
# 产出 1235 个假"陈旧"项（2026-10-06 实测），而 locale 为 C 的节点一切正常 —— 这正是
# "只在部分节点发作"的原因。破坏性路径上不允许任何 locale 依赖。
export LC_ALL=C
export LANG=C
set -euo pipefail
los_home="$1"
cd "$los_home"
find tools deploy packages contracts \
  -type d \( -name node_modules -o -name dist -o -name .turbo -o -name .los -o -name .los-runtime \) -prune -o \
  -type f ! -name '*.tsbuildinfo' -print | LC_ALL=C sort > /tmp/los-present.list
LC_ALL=C comm -23 /tmp/los-present.list /tmp/los-shipped.list > /tmp/los-stale.list || true
if [ ! -s /tmp/los-shipped.list ]; then
  echo "prune: SKIPPED — shipped manifest missing or empty (upload failed); deleting nothing"
  exit 0
fi
stale_count="$(wc -l < /tmp/los-stale.list | tr -d ' ')"
echo "prune: $stale_count stale file(s) not in the shipped manifest"
if [ "$stale_count" -gt 0 ]; then
  # Safety rails: never delete installed deps or anything outside the shipped
  # source trees, and refuse an implausibly large delete.
  if grep -qE '(^|/)(node_modules|\.git|\.env)(/|$)' /tmp/los-stale.list; then
    echo "prune: ABORT — unsafe path in stale list"; head -20 /tmp/los-stale.list; exit 1
  fi
  if [ "$stale_count" -gt 500 ]; then
    echo "prune: ABORT — stale count $stale_count exceeds 500"; exit 1
  fi
  head -20 /tmp/los-stale.list
  # `xargs -a FILE -d '\n'` 是 **GNU 专有**写法，macOS 的 BSD xargs 两个选项都不认
  # （`xargs: invalid option -- a`）⇒ 删除静默失败、陈旧文件留在节点上，而节点的内容摘要
  # 覆盖每一个源文件，于是 digest 永远不等于机队目标。2026-10-11 M3 的"同步反复中断"就是这一条：
  # 传输、校验、解包全部成功，只有一个被上游重命名删除的文件（mcp-stdio-transport.ts）没被清掉。
  # 用可移植的 read 循环，两个平台行为一致；失败立即非零退出（set -e），不再"删不掉也算完"。
  while IFS= read -r stale_path; do
    rm -f -- "$stale_path"
  done < /tmp/los-stale.list
  # 复核：删不掉的陈旧文件必须吵，否则收敛守卫会把"清理失败"误报成"半同步"。
  while IFS= read -r stale_path; do
    if [ -e "$stale_path" ]; then
      echo "prune: FAILED — could not remove stale path: $stale_path"
      exit 1
    fi
  done < /tmp/los-stale.list
  echo "prune: removed $stale_count stale file(s)"
fi
PRUNE_STALE
  )"; then
    printf '%s\n' "$prune_out" | tee -a "$log_file" >&2
    log_warn "  prune FAILED — see $log_file"
    log_warn "  a stale source file that survives the prune keeps this node's content digest away from the fleet target"
    return 1
  fi
  printf '%s\n' "$prune_out" | tee -a "$log_file" >/dev/null
  log_info "  $(printf '%s\n' "$prune_out" | grep '^prune:' | tail -1 || printf 'prune: done')"

  remote_sh bash -s "$REMOTE_HOME" "$BUILD_VERSION" <<'STAMP_VERSION' >> "$log_file" 2>&1
set -euo pipefail
los_home="$1"
build_version="$2"
env_file="$los_home/.env"
if [ ! -f "$env_file" ]; then
  echo "WARN: $env_file missing; version stamp deferred until node configuration exists"
  exit 0
fi
# 用 awk + mv 而不是 `sed -i`：BSD sed(macOS) 要求 `-i ''`，GNU 形式会在 macOS 上直接
# 失败（2026-10-07 m3pro 实测：`sed: invalid command code e`），而这一步失败会让整个 sync
# 中止 —— 明明内容已经解包成功。可移植性在这里比简洁更重要。
#
# 但 `mv` 会用**新文件**（umask 派生）的权限位替换旧文件，于是每次 sync 都把 `.env` 的
# 0600 悄悄变成 0644 —— runbook 明确要求 600，而手工收紧会在下一次滚动时被打回
# （2026-10-11 实测：M3 收到 600 后跑一次 sync 即回到 644）。所以先记住原权限、写完恢复：
# 节点各自的策略（M3 是 600，Linux 上是 root:root 644 以便服务用户 `los` 能读）都保持不变。
# 这里刻意**不**硬编码 600：把 root 属主的 `.env` 强行改成 600 会让 `los` 读不到而弄坏执行器。
env_mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file" 2>/dev/null || true)"
for key in LOS_VERSION EXECUTOR_VERSION; do
  awk -v k="$key" -v v="$build_version" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$env_file" > "$env_file.tmp" && mv "$env_file.tmp" "$env_file"
done
[ -n "$env_mode" ] && chmod "$env_mode" "$env_file"
echo "version=$build_version (mode ${env_mode:-unchanged})"
STAMP_VERSION
  log_info "  version: $BUILD_VERSION"

  log_info "  sync steps finished (convergence is asserted on exit)"

  # Sync systemd unit to /etc
  # 只在**真的有 systemd** 的节点上同步 unit。判据不能是"仓库里有这个文件"——那在每台
  # 节点上都成立，于是 macOS 节点每次 sync 都要尝试一次注定失败的 cp 并打一条
  # "could not copy systemd unit (may need root)" 的假警告。macOS 路径既然受支持，
  # 就不该每次都给运维一条看起来像故障的 WARN。
  if remote_sh test -d /etc/systemd/system 2>/dev/null &&
    remote_sh test -f "$REMOTE_HOME/deploy/systemd/los-executor.service" 2>/dev/null; then
    remote_sh sh -c \
      "cp '$REMOTE_HOME/deploy/systemd/los-executor.service' /etc/systemd/system/los-executor.service && chmod 644 /etc/systemd/system/los-executor.service" \
      >> "$log_file" 2>&1 || log_warn "could not copy systemd unit (may need root)"
  fi

  # 冻结包**不删**：同一轮里后面的节点还要用（编排器负责清理/覆盖）
  [ -n "$frozen_tar" ] || rm -f "$tmp_tar"
  log_info "sync complete — see $log_file"
}

# ── Install deps ───────────────────────────────────────────
do_install() {
  local low_resource=false
  for arg in "${CMD_ARGS[@]}"; do
    case "$arg" in
      --low-resource) low_resource=true ;;
    esac
  done

  if [ "${LOS_LOW_RESOURCE:-0}" = "1" ]; then
    low_resource=true
  fi

  local log_file="$LOG_BASE/${NODE}-install-${TIMESTAMP}.log"
  log_info "installing deps on $TS_HOST (low_resource=$low_resource, log: $log_file)"

  if $low_resource; then
    # Keep platform optional dependencies: tsx needs esbuild's native binary.
    remote_pnpm_sh "cd $REMOTE_HOME && CI=true NODE_OPTIONS='--max-old-space-size=128' pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1" \
      >> "$log_file" 2>&1 || {
      log_warn "pnpm install failed — see $log_file"
      log_warn "Diagnose: $0 $NODE cmd 'journalctl -u los-executor -n 20'"
      log_warn "Or check: $0 $NODE cmd 'free -h && swapon --show'"
      return 1
    }
  else
    remote_pnpm_sh "cd $REMOTE_HOME && CI=true pnpm install --frozen-lockfile" \
      >> "$log_file" 2>&1 || {
      log_warn "pnpm install failed — see $log_file"
      log_warn "Try low-resource mode: $0 $NODE install --low-resource"
      return 1
    }
  fi

  log_info "install complete — see $log_file"

  do_install_unirun
}

# ── Install pinned unirun ───────────────────────────────────
# The gateway only dispatches `unirun ssh` for a binary that answers
# `unirun capabilities --json` with the keys it needs
# (packages/gateway/src/unirun-capabilities.ts); deploy/unirun-pin.txt holds the
# version and sha256, and the installer verifies both. Audit C4/F1 found hosts
# with an older unirun installed, which is not "missing" — it is unusable, and
# every remote-cwd/env call silently ran on native ssh.
#
# A failed install warns by default rather than failing the deploy: github.com
# is not reachable from every node, and the native fallback still works. Set
# LOS_REQUIRE_UNIRUN=1 to make it fatal.
do_install_unirun() {
  local log_file="$LOG_BASE/${NODE}-unirun-${TIMESTAMP}.log"
  log_info "installing pinned unirun on $TS_HOST (log: $log_file)"

  if remote_sh sh "$REMOTE_HOME/tools/install-unirun.sh" --dest /usr/local/bin >> "$log_file" 2>&1; then
    log_info "  $(tail -1 "$log_file")"
    return 0
  fi

  log_warn "unirun install failed — see $log_file"
  log_warn "this node dispatches ssh via the native fallback until it succeeds"
  log_warn "Diagnose: $0 $NODE cmd 'sh $REMOTE_HOME/tools/install-unirun.sh --check'"
  if [ "${LOS_REQUIRE_UNIRUN:-0}" = "1" ]; then
    die "LOS_REQUIRE_UNIRUN=1 and the pinned unirun is not installed on $TS_HOST"
  fi
  return 0
}

# ── Install systemd service ─────────────────────────────────
do_install_service() {
  local log_file="$LOG_BASE/${NODE}-install-service-${TIMESTAMP}.log"
  log_info "installing systemd service on $TS_HOST (log: $log_file)"

  # install-service starts or restarts the unit. Gate it here too: `deploy` and
  # standalone use must not restart a node whose declared mode is violated.
  if ! check_remote_mode; then
    die "refusing to install/start the service: executor mode contract violated (see FAIL lines; run sync first if the helper is missing)"
  fi

  remote_sh bash -s "$REMOTE_HOME" <<'INSTALL_SVC' >> "$log_file" 2>&1
set -euo pipefail
LOS_HOME="$1"
UNIT_SRC="$LOS_HOME/deploy/systemd/los-executor.service"
UNIT_DST="/etc/systemd/system/los-executor.service"

if [ ! -f "$UNIT_SRC" ]; then
  echo "FATAL: systemd unit not found at $UNIT_SRC"
  exit 1
fi

cp "$UNIT_SRC" "$UNIT_DST"
chmod 644 "$UNIT_DST"
systemctl daemon-reload
systemctl enable los-executor
install -d -o los -g los "$LOS_HOME/.los-runtime" "$LOS_HOME/tmp"
echo "service installed and enabled"

# Don't start non-LOS containers. If executor was already running, restart it.
if systemctl is-active --quiet los-executor 2>/dev/null; then
  systemctl restart los-executor
  echo "service restarted"
else
  systemctl start los-executor
  echo "service started"
fi
INSTALL_SVC

  log_info "install-service complete — see $log_file"
}

# ── Restart ─────────────────────────────────────────────────
do_restart() {
  log_info "restarting executor on $TS_HOST..."
  local log_file="$LOG_BASE/${NODE}-restart-${TIMESTAMP}.log"

  if ! check_remote_mode; then
    die "refusing to restart: executor mode contract violated (see FAIL lines; run sync first if the helper is missing)"
  fi

  if remote_sh test -f /etc/systemd/system/los-executor.service 2>/dev/null; then
    remote_sh systemctl restart los-executor >> "$log_file" 2>&1
    log_info "  service restarted (systemd)"
  elif remote_sh test -f "$REMOTE_HOME/tools/los.sh" 2>/dev/null; then
    remote_su_sh "cd $REMOTE_HOME && bash tools/los.sh restart" >> "$log_file" 2>&1
    log_info "  restarted via los.sh"
  else
    die "no service or los.sh found on remote"
  fi
}

# ── Verify ──────────────────────────────────────────────────
do_verify() {
  local log_file="$LOG_BASE/${NODE}-verify-${TIMESTAMP}.log"
  log_info "verifying executor on $TS_HOST (log: $log_file)"

  # One snapshot, one parser. Port, gateway and mode all come from the same
  # lines the executor reads; a second awk/grep here was how a quoted or
  # space-padded GATEWAY_URL produced a false red after the validator passed.
  local mode_snapshot=""
  mode_snapshot="$(mktemp "${TMPDIR:-/tmp}/los-executor-mode.XXXXXX")"
  if ! read_remote_mode_env > "$mode_snapshot"; then
    rm -f "$mode_snapshot"
    die "could not read mode keys from $REMOTE_HOME/.env"
  fi
  local port="${EXECUTOR_PORT:-}"
  [ -n "$port" ] || port="$(snapshot_value "$mode_snapshot" EXECUTOR_PORT)"
  port="${port:-8090}"
  local connect_host=""
  connect_host="$(snapshot_value "$mode_snapshot" EXECUTOR_HOST)"
  case "$connect_host" in
    ""|0.0.0.0|::|"[::]") connect_host="127.0.0.1" ;;
  esac

  # 1. Service status
  printf '=== systemd status ===\n' >> "$log_file"
  local service_state=""
  local previous_service_state=""
  local service_attempt
  for service_attempt in $(seq 1 "$VERIFY_GRACE_SECONDS"); do
    service_state=$(remote_sh systemctl is-active los-executor 2>/dev/null || true)
    if [ "$service_state" != "$previous_service_state" ]; then
      printf 'attempt=%s state=%s\n' "$service_attempt" "${service_state:-unknown}" >> "$log_file"
      previous_service_state="$service_state"
    fi
    [ "$service_state" = "active" ] && break
    [ "$service_state" = "failed" ] && break
    sleep 1
  done
  if [ "$service_state" != "active" ]; then
    log_warn "service not active"
    log_warn "last systemd state: ${service_state:-unknown} (waited ${VERIFY_GRACE_SECONDS}s)"
    log_warn "Diagnose: $0 $NODE logs"
    log_warn "Or: $0 $NODE cmd 'systemctl status los-executor'"
    return 1
  fi
  if [ "$service_attempt" -gt 1 ]; then
    log_info "  service: active (after ${service_attempt}s verification grace)"
  else
    log_info "  service: active"
  fi

  # 2. Health endpoint
  printf '\n=== health ===\n' >> "$log_file"
  local health=""
  local attempt
  for attempt in $(seq 1 30); do
    health=$(remote_sh curl -sf "http://$connect_host:$port/health" 2>/dev/null || true)
    [ -n "$health" ] && break
    sleep 1
  done
  if [ -z "$health" ]; then
    log_warn "  health endpoint not responding on port $port after 30 seconds"
    log_warn "Diagnose: $0 $NODE logs"
    return 1
  fi
  printf '%s\n' "$health" >> "$log_file"
  log_info "  health: ok"
  if ! printf '%s' "$health" | grep -Fq "\"version\":\"$BUILD_VERSION\""; then
    log_warn "  version mismatch: expected $BUILD_VERSION"
    return 1
  fi
  log_info "  version: $BUILD_VERSION"

  # 2b. Mode contract (fail-closed). The version can match while the node is
  #     mislabeled — e.g. `db=none` with a leftover DATABASE_URL, a health
  #     `db=postgres` on a legacy node, or a token mode that would let a 401
  #     fall back to the DB. Refuse before reporting a healthy rollout.
  local mode_health=""
  mode_health="$(mktemp "${TMPDIR:-/tmp}/los-executor-health.XXXXXX")"
  printf '%s' "$health" > "$mode_health"
  if ! validate_mode_env "$mode_snapshot" "$mode_health"; then
    rm -f "$mode_health" "$mode_snapshot"
    die "executor mode contract violated — verify must not report success (see FAIL lines)"
  fi
  rm -f "$mode_health"
  local db_mode="" gateway_url=""
  db_mode="$(snapshot_value "$mode_snapshot" EXECUTOR_DB_MODE)"
  gateway_url="$(snapshot_value "$mode_snapshot" GATEWAY_URL)"
  rm -f "$mode_snapshot"

  # 3. Port listening
  printf '\n=== port listener ===\n' >> "$log_file"
  remote_sh ss -tlnp "sport = :$port" 2>/dev/null >> "$log_file" || true
  log_info "  port $port: listening"

  # 4. GATEWAY_URL reachability check (dead-gateway guard — heartbeat fails
  #    silently otherwise; vultr/tencent-sin crashed/starved on a stale URL)
  printf '\n=== gateway reachability ===\n' >> "$log_file"
  if [ -n "$gateway_url" ]; then
    if curl -sf --max-time 5 "${gateway_url%/}/health" >/dev/null 2>&1; then
      log_info "  gateway $gateway_url: reachable"
    else
      if [ "$db_mode" = "none" ]; then
        die "gateway $gateway_url is NOT reachable; EXECUTOR_DB_MODE=none has no direct-DB fallback"
      fi
      log_warn "  gateway $gateway_url: NOT reachable from this machine"
      log_warn "  executor heartbeats will fail; fix $REMOTE_HOME/.env GATEWAY_URL"
      log_warn "  Diagnose: $0 $NODE cmd 'grep GATEWAY_URL $REMOTE_HOME/.env'"
    fi
  else
    if [ "$db_mode" = "none" ]; then
      die "GATEWAY_URL is unset but EXECUTOR_DB_MODE=none (mode-check should have failed first)"
    fi
    log_info "  GATEWAY_URL not set on remote (direct-to-DB heartbeat mode)"
  fi

  # 5. Registry registration check (best-effort; the gateway owns the row)
  printf '\n=== db registration ===\n' >> "$log_file"
  if remote_sh test -f "$REMOTE_HOME/.env" 2>/dev/null; then
    if [ "$db_mode" = "none" ]; then
      log_info "  stateless node: no executor DB writes; check the registry from the gateway"
    else
      log_info "  .env present — DB registration must be checked from gateway"
    fi
    log_info "  Check: GET <gateway>/nodes and look for node_id=$NODE"
  else
    log_warn "  .env missing on remote"
  fi

  # 6. unirun (the pinned ssh transport for node dispatch — see do_install_unirun)
  printf '\n=== unirun ===\n' >> "$log_file"
  local unirun_state=""
  unirun_state=$(remote_sh sh "$REMOTE_HOME/tools/install-unirun.sh" --check --dest /usr/local/bin 2>&1 || true)
  printf '%s\n' "$unirun_state" >> "$log_file"
  if printf '%s' "$unirun_state" | grep -q 'capabilities=ok'; then
    log_info "  unirun: ok ($(printf '%s' "$unirun_state" | sed -n 's/^unirun: .* version=\([^ ]*\) capabilities=ok$/\1/p' | head -1))"
  else
    log_warn "  unirun: missing or unusable on this node — ssh dispatch falls back to native"
    log_warn "  fix: $0 $NODE install"
    if [ "${LOS_REQUIRE_UNIRUN:-0}" = "1" ]; then
      return 1
    fi
  fi

  log_info "verify complete — see $log_file"

  # A restart always leaves the node draining (see do_promote). Close the loop
  # here instead of leaving it to the operator's memory.
  if ! auto_promote_after_verify; then
    die "verified but not schedulable: $NODE_ID is still not online in the registry"
  fi
}

# ── Status ──────────────────────────────────────────────────
do_status() {
  log_info "status of $TS_HOST:"
  echo ""
  if remote_sh test -f "$REMOTE_HOME/tools/setup-node.sh" 2>/dev/null; then
    remote_sh bash "$REMOTE_HOME/tools/setup-node.sh" --status 2>/dev/null || true
  else
    remote_sh systemctl status los-executor --no-pager -l 2>/dev/null || echo "  no systemd service"
  fi
}

# ── Logs ────────────────────────────────────────────────────
do_logs() {
  log_info "executor logs from $TS_HOST:"
  remote_sh journalctl -u los-executor -n 50 --no-pager 2>/dev/null || {
    remote_sh tail -50 "$REMOTE_HOME/.los-runtime/executor.log" 2>/dev/null || echo "  no logs found"
  }
}

# ── Firewall ────────────────────────────────────────────────
do_firewall() {
  log_info "applying firewall on $TS_HOST..."
  if remote_sh test -f "$REMOTE_HOME/tools/firewall/los-firewall.sh" 2>/dev/null; then
    remote_sh bash "$REMOTE_HOME/tools/firewall/los-firewall.sh" apply
  else
    die "los-firewall.sh not found on remote. Run: $0 $NODE sync"
  fi
}

# ── Arbitrary command ───────────────────────────────────────
do_cmd() {
  log_info "running on $TS_HOST: ${CMD_ARGS[*]}"
  remote_sh sh -c "${CMD_ARGS[*]}"
}

# ── Composite: deploy (all-in-one legacy compat) ────────────
do_deploy() {
  # The gate lives inside do_install_service (it starts/restarts the unit), so
  # `deploy` cannot skip it. Keep this composition explicit rather than adding
  # a second preflight/resource check.
  do_sync && do_install && do_install_service
}

# ── Composite: full-setup ───────────────────────────────────
do_full_setup() {
  do_preflight && do_sync && do_install && do_install_service && do_verify
}

# ── Main dispatch ───────────────────────────────────────────
check_conn

# ── Promote (clear the post-restart drain) ─────────────────
# A restart ALWAYS leaves the node `status='draining'` in the registry: the
# executor sends one `status='draining'` heartbeat while shutting down, and
# resolveHeartbeatStatus() preserves an existing 'draining' when a later
# heartbeat carries no explicit status (its online heartbeats omit it on
# purpose, so an operator-requested drain is not silently undone). Net effect: a
# node that is up and healthy stops receiving work until someone promotes it —
# verified on all 8 nodes during the 2026-10-06 rollout.
# Requires the registry node id; `--node-id`/LOS_REMOTE_NODE_ID or a mapping for
# the known node names below.
# 读注册表状态。两个坑都踩过：`nodes command <id> status` 不是有效节点命令会静默返回空；
# 网关 /nodes 的载荷形状也会变。因此以 psql 为主(网关主机一定有),API 为备。
registry_status() {
  local node_id="$1" psql_bin db auth base
  psql_bin="$(command -v psql 2>/dev/null || true)"
  [ -n "$psql_bin" ] || psql_bin="/opt/homebrew/opt/postgresql@17/bin/psql"
  db="$(grep -E '^DATABASE_URL=' "$LOCAL_REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  if [ -n "$db" ] && [ -x "$psql_bin" ]; then
    "$psql_bin" "$db" -t -A -c "select status from executor_nodes where node_id = '$node_id'" 2>/dev/null | head -1 | tr -d ' \r'
    return 0
  fi
  auth="$(grep -E '^LOS_AUTH_TOKEN=' "$LOCAL_REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  base="$(grep -E '^GATEWAY_URL=' "$LOCAL_REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  base="${base:-http://127.0.0.1:8080}"
  curl -s -m 10 -H "Authorization: Bearer $auth" "${base%/}/nodes" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const body = JSON.parse(s);
        const list = body.nodes || body.results || body.items || (Array.isArray(body) ? body : []);
        const wanted = process.argv[1];
        const hit = list.find(n => (n.node_id || n.nodeId) === wanted);
        process.stdout.write(hit ? String(hit.status || "") : "");
      } catch { /* empty → caller reports unknown */ }
    });
  ' "$node_id"
}

do_promote() {
  local reason="deploy-to-remote verify passed $BUILD_VERSION"
  local node_id="$NODE_ID"
  if [ -z "$node_id" ]; then
    die "promote needs the registry node id: pass --node-id <id> or set LOS_REMOTE_NODE_ID"
  fi
  local auth op
  auth="$(grep -E '^LOS_AUTH_TOKEN=' "$LOCAL_REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  op="$(grep -E '^LOS_OPERATOR_TOKEN=' "$LOCAL_REPO/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  [ -n "$auth" ] || die "promote needs LOS_AUTH_TOKEN (repo .env)"
  log_info "promoting $node_id (clears the restart-induced drain)"
  ( cd "$LOCAL_REPO" && ./bin/los nodes command "$node_id" promote \
      -t "$auth" ${op:+--operator-token "$op"} --reason "$reason" ) 2>&1 | tail -3
}

# 自动 promote：只在"内容与版本都对上"时执行，并在执行后复核注册表真的 online。
# 依据（2026-10-06 实测）：
#  - 每次重启都会留下 status='draining'（关机时发一次 draining 心跳，而 online 心跳不带
#    status → resolveHeartbeatStatus 保留 draining），忘记 promote 的节点会静默不接活；
#  - promote 会把 registry 里**陈旧**的版本置为 online（P0-3 已让 promote 支持期望版本校验）；
#  - promote 之后仍可能被翻回 draining（oracle 实测），所以必须复核而不是相信返回值。
auto_promote_after_verify() {
  [[ "${LOS_DEPLOY_AUTO_PROMOTE:-1}" == "0" ]] && { log_info "  auto-promote disabled (LOS_DEPLOY_AUTO_PROMOTE=0)"; return 0; }
  if [ -z "$NODE_ID" ]; then
    log_warn "  auto-promote skipped: no --node-id/LOS_REMOTE_NODE_ID (node stays 'draining')"
    return 0
  fi
  local got
  got="$(remote_digest)"
  if [ "$got" != "$BUILD_VERSION" ]; then
    log_warn "  auto-promote REFUSED: node digest '${got:-<no output>}' != target '$BUILD_VERSION' (a stale node must not be promoted online)"
    return 0
  fi
  do_promote || true
  sleep 8
  local st
  st="$(registry_status "$NODE_ID")"
  if [ "$st" != "online" ]; then
    log_warn "  auto-promote did NOT stick: registry status='${st:-unknown}' for $NODE_ID"
    log_warn "  the node is verified but receives no work; re-run '$0 $NODE promote --node-id $NODE_ID'"
    return 1
  fi
  log_info "  auto-promote verified: $NODE_ID is online"
  return 0
}

# ── Digest check (read-only) ───────────────────────────────
# `sync` streams the archive through a single SSH pipe (`cat tar | ssh … 'tar xzf -'`),
# so a connection that drops mid-transfer leaves a PARTIALLY extracted tree. On
# 2026-10-06 that left tencent-sin half-synced (executor crash-looped until systemd
# gave up) and vultr with the tree updated but `.env` never stamped. Compare the
# node's own content digest against the target; on mismatch use upload-then-extract
# (scp to /tmp + shasum on both sides + extract locally on the node).
remote_digest() {
  remote_sh sh -c "cd '$REMOTE_HOME' && bash tools/los.sh build-version" 2>/dev/null | tail -1 | tr -d '\r'
}

# 收敛判定必须"无论如何都执行":sync 的每一步都可能因 SSH 断流失败,而 set -e 会直接
# 退出 —— 那样调用方只看到"没有输出",无法判断节点是完整的还是半截的(2026-10-06 两次
# 事故都属于这一类:tencent-sin 半截树崩溃掉线、vultr 树到目标但 .env 未盖章)。
sync_convergence_guard() {
  local st=$?
  local got
  got="$(remote_digest 2>/dev/null)"
  if [ "$got" != "$BUILD_VERSION" ]; then
    if [ "$st" -eq 0 ]; then
      log_warn "  sync reported success but the node did not converge"
      die "sync did not converge: remote digest '${got:-<no output>}' != target '$BUILD_VERSION' — re-run the sync; see docs/operations/node-deployment-runbook.md"
    elif [ "${SYNC_EXTRACTED:-0}" = "0" ]; then
      # 中止发生在解包之前：节点**未被改动**，仍停在它原来的修订上。这不是半截树，
      # 不要用"must NOT be restarted"去吓人（实测会误导：vultr 那次 scp 失败即属此类）。
      log_warn "  sync aborted BEFORE extraction (exit $st) — the node is untouched and still on '${got:-<no output>}'"
      exit "$st"
    else
      # 走到这里只说明"解包之后 digest 仍不等于目标"，**不等于半截树**。2026-10-11 M3 的
      # "同步反复中断"就是这样被误判成传输问题的：解包完全成功，只有一个被上游删除的源文件
      # 没被 prune 清掉（BSD xargs 不认 GNU 的 -a/-d），于是摘要永远差一截 —— 而这条 die
      # 断言"may be half-synced; do NOT restart it"，把排查方向指到了传输路径上。
      log_warn "  sync aborted after extraction (exit $st) — remote content differs from the target"
      die "sync did not converge after extraction: remote digest '${got:-<no output>}' != target '$BUILD_VERSION'. Two distinguishable causes — read '${SYNC_LOG_FILE:-<sync log>}' before acting: (a) the log says 'prune: FAILED'/'prune: SKIPPED'/'stale file(s)': the node still holds source files the manifest no longer ships, and because the digest covers every source file it can never converge — fix the prune, the tree itself is fine; (b) the log shows no prune complaint: then files really are missing on the node and it may be half-synced — do NOT restart it in that case. See docs/operations/node-deployment-runbook.md"
    fi
  fi
  [ "$st" -eq 0 ] && log_info "  digest verified: $got"
  return "$st"
}

do_digest() {
  local got
  got="$(remote_digest)"
  log_info "  target (local deployable digest): $BUILD_VERSION"
  log_info "  remote ($REMOTE_HOME)             : ${got:-<no output>}"
  if [ "$got" = "$BUILD_VERSION" ]; then
    log_info "  digest: MATCH"
    return 0
  fi
  log_warn "  digest: MISMATCH — node is not on the target revision"
  log_warn "  a mismatch between rollouts is expected; a mismatch right after sync means a half-synced tree"
  exit 1
}

# Read-only mode check against a live node: remote .env + /health, no version
# or digest assertion. Useful after a restart, during an incident, and as the
# live acceptance surface for the deployment contract.
do_mode() {
  local health_file snapshot rc=0 port connect_host
  snapshot="$(mktemp "${TMPDIR:-/tmp}/los-executor-mode.XXXXXX")"
  health_file="$(mktemp "${TMPDIR:-/tmp}/los-executor-health.XXXXXX")"

  if ! read_remote_mode_env > "$snapshot"; then
    log_warn "could not read mode keys from $REMOTE_HOME/.env"
    rm -f "$snapshot" "$health_file"
    return 1
  fi
  port="$(snapshot_value "$snapshot" EXECUTOR_PORT)"
  port="${port:-8090}"
  connect_host="$(snapshot_value "$snapshot" EXECUTOR_HOST)"
  case "$connect_host" in
    ""|0.0.0.0|::|"[::]") connect_host="127.0.0.1" ;;
  esac
  # A dead /health is a failure, not an empty state: the validator then reports
  # an empty health snapshot instead of inventing a healthy mode.
  remote_sh curl -sf --max-time 8 "http://$connect_host:$port/health" > "$health_file" 2>/dev/null || true

  validate_mode_env "$snapshot" "$health_file" || rc=$?
  rm -f "$snapshot" "$health_file"
  if [ "$rc" -eq 0 ]; then
    log_info "mode contract: OK"
  else
    log_warn "mode contract: VIOLATED"
  fi
  return "$rc"
}

case "$CMD" in
  preflight)      do_preflight ;;
  sync)           do_sync ;;
  install)        do_install ;;
  install-service) do_install_service ;;
  restart)        do_restart ;;
  verify)         do_verify ;;
  digest)         do_digest ;;
  mode)           do_mode ;;
  promote)        do_promote ;;
  status)         do_status ;;
  logs)           do_logs ;;
  firewall)       do_firewall ;;
  cmd)            do_cmd ;;
  deploy)         do_deploy ;;
  full-setup)     do_full_setup ;;
  *)
    die "unknown command '$CMD'. Commands: preflight sync install install-service restart verify digest mode status logs firewall cmd deploy full-setup mode-check"
    ;;
esac
