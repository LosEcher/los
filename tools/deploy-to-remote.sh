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
#   deploy-to-remote.sh <node> verify              # Health + DB registration check
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
set -euo pipefail

NODE="${1:-}"
CMD="${2:-help}"
shift 2 2>/dev/null || true
CMD_ARGS=("$@")

if [ -z "$NODE" ] || [ "$NODE" = "help" ] || [ "$NODE" = "-h" ] || [ "$NODE" = "--help" ]; then
  cat <<'EOF'
deploy-to-remote.sh — push los executor to a Tailscale node (no remote VCS needed)

Phased commands:
  preflight           Check remote memory/swap/disk/PSI before heavy ops
  sync                Push code via tar pipe (no git/jj on remote)
  install             Install deps (supports --low-resource)
  install-service     Install systemd unit
  restart             Restart executor service
  verify              Health check + connectivity validation

Shortcuts:
  status              Show remote state
  logs                Tail executor journal
  firewall            Apply firewall rules
  cmd "<cmd>"         Run arbitrary command on remote
  deploy              sync + install + install/start service (all-in-one)
  full-setup          preflight + sync + install + install/start service + verify

Options:
  --low-resource      Use reduced concurrency for pnpm install (only with 'install')

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

case "$SSH_TRANSPORT" in
  tailscale|ssh) ;;
  *) die "unsupported LOS_SSH_TRANSPORT '$SSH_TRANSPORT' (expected tailscale or ssh)" ;;
esac

case "$REMOTE_PRIVILEGE" in
  none|sudo) ;;
  *) die "unsupported LOS_REMOTE_PRIVILEGE '$REMOTE_PRIVILEGE' (expected none or sudo)" ;;
esac

# ── Remote exec helpers ─────────────────────────────────────
remote_exec() {
  local remote_command
  printf -v remote_command '%q ' "$@"
  if [ "$SSH_TRANSPORT" = "ssh" ]; then
    ssh "$SSH_TARGET" "$remote_command"
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
  log_info "preflight passed — see $log_file"
}

# ── Sync (tar pipe, no VCS on remote) ──────────────────────
do_sync() {
  local log_file="$LOG_BASE/${NODE}-sync-${TIMESTAMP}.log"
  log_info "syncing code to $TS_HOST via tar pipe (log: $log_file)"

  # Ship every workspace package so frozen-lockfile validation sees the same
  # manifests as the lockfile. Omitting runtime dependencies left stale source;
  # omitting unrelated manifests also makes pnpm reject the workspace.
  local tmp_tar="$LOG_BASE/${NODE}-sync-${TIMESTAMP}.tar.gz"

  # Create tar from local repo — only ship what the executor needs.
  tar czf "$tmp_tar" -C "$LOCAL_REPO" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.jj' \
    --exclude='packages/*/.los' \
    --exclude='packages/*/.los/*' \
    --exclude='.los-runtime' \
    --exclude='tmp' \
    --exclude='dist' \
    --exclude='.tsbuildinfo' \
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

  # Pipe tar to remote and extract
  cat "$tmp_tar" | remote_sh sh -c \
    "mkdir -p '$REMOTE_HOME' && cd '$REMOTE_HOME' && tar xzf - && chown -R los:los ." \
    >> "$log_file" 2>&1

  log_info "  extracted to $REMOTE_HOME"

  remote_sh bash -s "$REMOTE_HOME" "$BUILD_VERSION" <<'STAMP_VERSION' >> "$log_file" 2>&1
set -euo pipefail
los_home="$1"
build_version="$2"
env_file="$los_home/.env"
if [ ! -f "$env_file" ]; then
  echo "WARN: $env_file missing; version stamp deferred until node configuration exists"
  exit 0
fi
for key in LOS_VERSION EXECUTOR_VERSION; do
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${build_version}|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$build_version" >> "$env_file"
  fi
done
echo "version=$build_version"
STAMP_VERSION
  log_info "  version: $BUILD_VERSION"

  # Sync systemd unit to /etc
  if remote_sh test -f "$REMOTE_HOME/deploy/systemd/los-executor.service" 2>/dev/null; then
    remote_sh sh -c \
      "cp '$REMOTE_HOME/deploy/systemd/los-executor.service' /etc/systemd/system/los-executor.service && chmod 644 /etc/systemd/system/los-executor.service" \
      >> "$log_file" 2>&1 || log_warn "could not copy systemd unit (may need root)"
  fi

  rm -f "$tmp_tar"
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
    remote_su_sh "cd $REMOTE_HOME && CI=true NODE_OPTIONS='--max-old-space-size=128' pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1" \
      >> "$log_file" 2>&1 || {
      log_warn "pnpm install failed — see $log_file"
      log_warn "Diagnose: $0 $NODE cmd 'journalctl -u los-executor -n 20'"
      log_warn "Or check: $0 $NODE cmd 'free -h && swapon --show'"
      return 1
    }
  else
    remote_su_sh "cd $REMOTE_HOME && CI=true pnpm install --frozen-lockfile" \
      >> "$log_file" 2>&1 || {
      log_warn "pnpm install failed — see $log_file"
      log_warn "Try low-resource mode: $0 $NODE install --low-resource"
      return 1
    }
  fi

  log_info "install complete — see $log_file"
}

# ── Install systemd service ─────────────────────────────────
do_install_service() {
  local log_file="$LOG_BASE/${NODE}-install-service-${TIMESTAMP}.log"
  log_info "installing systemd service on $TS_HOST (log: $log_file)"

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
  local port="${EXECUTOR_PORT:-}"
  local log_file="$LOG_BASE/${NODE}-verify-${TIMESTAMP}.log"
  log_info "verifying executor on $TS_HOST (log: $log_file)"

  if [ -z "$port" ]; then
    port=$(remote_sh awk -F= '/^EXECUTOR_PORT=/{print $2; exit}' "$REMOTE_HOME/.env" 2>/dev/null || true)
  fi
  port="${port:-8090}"

  # 1. Service status
  printf '=== systemd status ===\n' >> "$log_file"
  remote_sh systemctl is-active los-executor 2>/dev/null >> "$log_file" || {
    log_warn "service not active"
    log_warn "Diagnose: $0 $NODE logs"
    log_warn "Or: $0 $NODE cmd 'systemctl status los-executor'"
    return 1
  }
  log_info "  service: active"

  # 2. Health endpoint
  printf '\n=== health ===\n' >> "$log_file"
  local health=""
  local attempt
  for attempt in $(seq 1 30); do
    health=$(remote_sh curl -sf "http://127.0.0.1:$port/health" 2>/dev/null || true)
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

  # 3. Port listening
  printf '\n=== port listener ===\n' >> "$log_file"
  remote_sh ss -tlnp "sport = :$port" 2>/dev/null >> "$log_file" || true
  log_info "  port $port: listening"

  # 4. DB registration check (best-effort, requires psql or gateway access)
  printf '\n=== db registration ===\n' >> "$log_file"
  if remote_sh test -f "$REMOTE_HOME/.env" 2>/dev/null; then
    log_info "  .env present — DB registration must be checked from gateway"
    log_info "  Check: GET <gateway>/nodes and look for node_id=$NODE"
  else
    log_warn "  .env missing on remote"
  fi

  log_info "verify complete — see $log_file"
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
  do_sync && do_install && do_install_service
}

# ── Composite: full-setup ───────────────────────────────────
do_full_setup() {
  do_preflight && do_sync && do_install && do_install_service && do_verify
}

# ── Main dispatch ───────────────────────────────────────────
check_conn

case "$CMD" in
  preflight)      do_preflight ;;
  sync)           do_sync ;;
  install)        do_install ;;
  install-service) do_install_service ;;
  restart)        do_restart ;;
  verify)         do_verify ;;
  status)         do_status ;;
  logs)           do_logs ;;
  firewall)       do_firewall ;;
  cmd)            do_cmd ;;
  deploy)         do_deploy ;;
  full-setup)     do_full_setup ;;
  *)
    die "unknown command '$CMD'. Commands: preflight sync install install-service restart verify status logs firewall cmd deploy full-setup"
    ;;
esac
