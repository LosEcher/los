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
#   LOS_DEPLOY_VERIFY_GRACE_SECONDS=90  # Bounded wait for transitional systemd state
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
  digest              Read-only: compare the node content digest against the target
  promote             Clear the restart-induced drain (needs --node-id <id>)

Options:
  --node-id <id>      Registry node id (also via LOS_REMOTE_NODE_ID); enables auto-promote after verify

Environment:
  LOS_DEPLOY_AUTO_PROMOTE=0   Do not promote automatically at the end of verify
  LOS_SSH_OPTS                Extra ssh(1) options, e.g. -o ControlPath=none

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
  # 收敛判定（含"中途失败"这条路径）在退出时统一执行。
  trap 'sync_convergence_guard' EXIT

  # Ship every workspace package so frozen-lockfile validation sees the same
  # manifests as the lockfile. Omitting runtime dependencies left stale source;
  # omitting unrelated manifests also makes pnpm reject the workspace.
  local tmp_tar="$LOG_BASE/${NODE}-sync-${TIMESTAMP}.tar.gz"

  # Create tar from local repo — only ship what the executor needs.
  # COPYFILE_DISABLE stops bsdtar from emitting AppleDouble `._*` sidecar
  # entries, which otherwise land on the node as junk that pollutes its
  # content-hash version.
  COPYFILE_DISABLE=1 tar czf "$tmp_tar" -C "$LOCAL_REPO" \
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
  remote_sh bash -s "$REMOTE_HOME" <<'PRUNE_STALE'
# 全脚本强制 C locale：两个列表用 `LC_ALL=C sort` 生成，但 comm **自身**会按环境 locale
# 校验"是否有序"。vultr 的 LANG=en_US.UTF-8 下，comm 把 C 排序的清单判成无序 → 乱序双指针
# 产出 1235 个假"陈旧"项（2026-10-06 实测），而 locale 为 C 的节点一切正常 —— 这正是
# "只在部分节点发作"的原因。破坏性路径上不允许任何 locale 依赖。
export LC_ALL=C
export LANG=C >> "$log_file" 2>&1
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
  xargs -a /tmp/los-stale.list -d '\n' rm -f --
  echo "prune: removed $stale_count stale file(s)"
fi
PRUNE_STALE
  log_info "  prune: done (see log)"

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

  log_info "  sync steps finished (convergence is asserted on exit)"

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

  # 4. GATEWAY_URL reachability check (dead-gateway guard — heartbeat fails
  #    silently otherwise; vultr/tencent-sin crashed/starved on a stale URL)
  printf '\n=== gateway reachability ===\n' >> "$log_file"
  local gateway_url=""
  gateway_url=$(remote_sh awk -F= '/^GATEWAY_URL=/{print $2; exit}' "$REMOTE_HOME/.env" 2>/dev/null || true)
  if [ -n "$gateway_url" ]; then
    if curl -sf --max-time 5 "${gateway_url%/}/health" >/dev/null 2>&1; then
      log_info "  gateway $gateway_url: reachable"
    else
      log_warn "  gateway $gateway_url: NOT reachable from this machine"
      log_warn "  executor heartbeats will fail; fix $REMOTE_HOME/.env GATEWAY_URL"
      log_warn "  Diagnose: $0 $NODE cmd 'grep GATEWAY_URL $REMOTE_HOME/.env'"
    fi
  else
    log_info "  GATEWAY_URL not set on remote (direct-to-DB heartbeat mode)"
  fi

  # 5. DB registration check (best-effort, requires psql or gateway access)
  printf '\n=== db registration ===\n' >> "$log_file"
  if remote_sh test -f "$REMOTE_HOME/.env" 2>/dev/null; then
    log_info "  .env present — DB registration must be checked from gateway"
    log_info "  Check: GET <gateway>/nodes and look for node_id=$NODE"
  else
    log_warn "  .env missing on remote"
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
    else
      log_warn "  sync aborted mid-way (exit $st) — checking whether the node is half-synced"
    fi
    die "sync did not converge: remote digest '${got:-<no output>}' != target '$BUILD_VERSION' — the node is half-synced and must NOT be restarted. Re-run with upload-then-extract (scp + shasum on both sides + extract on the node); see docs/operations/node-deployment-runbook.md"
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

case "$CMD" in
  preflight)      do_preflight ;;
  sync)           do_sync ;;
  install)        do_install ;;
  install-service) do_install_service ;;
  restart)        do_restart ;;
  verify)         do_verify ;;
  digest)         do_digest ;;
  promote)        do_promote ;;
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
