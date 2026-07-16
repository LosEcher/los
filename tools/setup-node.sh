#!/usr/bin/env bash
# setup-node.sh — bootstrap a fresh machine as a los executor node.
#
# Prerequisites:
#   - Linux (Debian/Ubuntu tested; others may work)
#   - Node.js >= 22 and pnpm installed
#   - Tailscale installed and authenticated
#   - PostgreSQL accessible (DATABASE_URL in .env)
#   - Running los gateway (or shared .env file)
#
# Usage:
#   sudo ./setup-node.sh                    # Interactive
#   sudo ./setup-node.sh --non-interactive  # Read values from env/.env
#   sudo ./setup-node.sh --low-resource     # Low-memory install mode
#   sudo ./setup-node.sh --check-only       # Verify prerequisites only
#   sudo ./setup-node.sh --status           # Show current state
#
# Environment variables (for --non-interactive):
#   LOS_REPO_URL=http://<forgejo-host>/los/los.git # Only for first-time git clone
#   LOS_REPO_BRANCH=main
#   DATABASE_URL=postgres://user:pass@host:5432/los
#   EXECUTOR_AGENT_KEY=<shared key>
#   EXECUTOR_PORT=8090
#   GATEWAY_URL=http://<gateway>:8080
#   LOS_USER=los
#
# Note: deploy-to-remote.sh is the preferred deployment path (tar sync, no remote VCS).
# This script remains for manual bootstrap on fresh nodes that already have the repo.
set -euo pipefail

# ── Config ──────────────────────────────────────────────────
LOS_USER="${LOS_USER:-los}"
LOS_HOME="/opt/los"
LOS_REPO_URL="${LOS_REPO_URL:-}"
LOS_REPO_BRANCH="${LOS_REPO_BRANCH:-main}"
LOG_FILE="${LOG_FILE:-/tmp/los-setup-$(date +%Y%m%d-%H%M%S).log}"
NON_INTERACTIVE=false
CHECK_ONLY=false
SHOW_STATUS=false
LOW_RESOURCE=false

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --low-resource) LOW_RESOURCE=true ;;
    --check-only) CHECK_ONLY=true ;;
    --status) SHOW_STATUS=true ;;
    --help|-h) cat <<'EOF' && exit 0
setup-node.sh — bootstrap a los executor node

Usage:
  sudo ./setup-node.sh                    # Interactive
  sudo ./setup-node.sh --non-interactive  # From env vars
  sudo ./setup-node.sh --low-resource     # Low-memory install mode
  sudo ./setup-node.sh --check-only       # Prereq check only
  sudo ./setup-node.sh --status           # Current state

For remote deployment, prefer deploy-to-remote.sh which syncs via tar (no remote VCS).
EOF
      ;;
  esac
done

# ── Logging ─────────────────────────────────────────────────
log()  { printf '[setup] %s\n' "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[setup] WARN: %s\n' "$*" | tee -a "$LOG_FILE"; }
die()  { printf '[setup] FATAL: %s\n' "$*" | tee -a "$LOG_FILE"; exit 1; }

# ── Root guard ──────────────────────────────────────────────
need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root. Use: sudo $0"
  fi
}

# ── Preflight: resource check ───────────────────────────────
preflight_resources() {
  log "Preflight: checking resources..."
  local ram_mb=0 swap_mb=0

  if [ -f /proc/meminfo ]; then
    ram_mb=$(($(awk '/^MemTotal:/{print $2}' /proc/meminfo) / 1024))
  fi
  log "  RAM: ${ram_mb}MB"

  free -h 2>/dev/null || true

  if [ -f /proc/meminfo ]; then
    swap_mb=$(($(awk '/^SwapTotal:/{print $2}' /proc/meminfo) / 1024))
  fi
  log "  Swap: ${swap_mb}MB"
  swapon --show 2>/dev/null || true

  df -h / /opt 2>/dev/null || true

  if [ "$ram_mb" -le 1024 ] && [ "$swap_mb" -eq 0 ]; then
    die "RAM <= 1GB and no swap. Cannot run pnpm install. Add swap: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
  fi

  if [ "$swap_mb" -gt 0 ] && [ "$swap_mb" -lt 2048 ] && ! $LOW_RESOURCE; then
    warn "swap < 2GB — consider rerunning with --low-resource"
  fi

  # Auto-enable low-resource if RAM is tight
  if [ "$ram_mb" -le 2048 ]; then
    log "  low memory detected, enabling low-resource mode"
    LOW_RESOURCE=true
  fi
}

# ── Prerequisites check ────────────────────────────────────
check_prereqs() {
  log "Checking prerequisites..."

  local ok=true

  if ! command -v node >/dev/null 2>&1; then
    warn "node not found — install Node.js >= 22"
    ok=false
  else
    log "  node: $(node -v)"
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    warn "pnpm not found — install: npm install -g pnpm"
    ok=false
  else
    log "  pnpm: $(pnpm -v)"
  fi

  if ! command -v tailscale >/dev/null 2>&1; then
    warn "tailscale not found — install: curl -fsSL https://tailscale.com/install.sh | sh"
    ok=false
  else
    local ts_status
    ts_status="$(tailscale status --json 2>/dev/null || true)"
    if [ -n "$ts_status" ]; then
      log "  tailscale: connected"
    else
      warn "tailscale installed but not authenticated — run: sudo tailscale up"
      ok=false
    fi
  fi

  if ! command -v iptables >/dev/null 2>&1 && ! command -v ufw >/dev/null 2>&1; then
    warn "iptables or ufw not found — firewall setup will be skipped"
  fi

  if ! getent passwd "$LOS_USER" >/dev/null 2>&1; then
    log "  user $LOS_USER: not created (will create)"
  else
    log "  user $LOS_USER: exists"
  fi

  if [ "$ok" = false ]; then
    die "prerequisites not met — fix the warnings above"
  fi
  log "  all prerequisites OK"
}

# ── Create los user ─────────────────────────────────────────
create_los_user() {
  if getent passwd "$LOS_USER" >/dev/null 2>&1; then
    log "user $LOS_USER already exists"
    return 0
  fi
  log "creating system user: $LOS_USER"
  useradd --system --user-group --home-dir "$LOS_HOME" --shell /bin/bash "$LOS_USER"
}

# ── Install deps ────────────────────────────────────────────
install_deps() {
  log "installing dependencies (low_resource=$LOW_RESOURCE)..."

  if ! su - "$LOS_USER" -c "cd $LOS_HOME && test -f package.json"; then
    die "no package.json in $LOS_HOME — sync code first with deploy-to-remote.sh sync"
  fi

  if $LOW_RESOURCE; then
    # Keep optional dependencies: tsx requires esbuild's platform binary.
    su - "$LOS_USER" -c "cd $LOS_HOME && CI=true NODE_OPTIONS='--max-old-space-size=128' pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1" || {
      warn "pnpm install failed in low-resource mode"
      warn "Check memory: free -h && swapon --show"
      return 1
    }
  else
    su - "$LOS_USER" -c "cd $LOS_HOME && CI=true pnpm install --frozen-lockfile" || {
      warn "pnpm install failed. Try: sudo $0 --low-resource"
      return 1
    }
  fi
}

# ── Write .env ──────────────────────────────────────────────
write_env() {
  if [ -f "$LOS_HOME/.env" ] && ! $NON_INTERACTIVE; then
    log ".env already exists at $LOS_HOME/.env"
    printf 'Overwrite? [y/N]: '
    read -r answer
    [ "$answer" != "y" ] && [ "$answer" != "Y" ] && return 0
  fi

  local db_url="${DATABASE_URL:-}"
  local agent_key="${EXECUTOR_AGENT_KEY:-}"
  local gateway_url="${GATEWAY_URL:-}"
  local runtime_version
  runtime_version="$(bash "$LOS_HOME/tools/los.sh" build-version)"

  if ! $NON_INTERACTIVE; then
    [ -z "$db_url" ] && printf 'DATABASE_URL: ' && read -r db_url
    [ -z "$agent_key" ] && printf 'EXECUTOR_AGENT_KEY: ' && read -r agent_key
    [ -z "$gateway_url" ] && printf 'GATEWAY_URL: ' && read -r gateway_url
  fi

  [ -n "$db_url" ] || die "DATABASE_URL is required"
  [ -n "$agent_key" ] || die "EXECUTOR_AGENT_KEY is required"
  [ -n "$gateway_url" ] || die "GATEWAY_URL is required"

  cat > "$LOS_HOME/.env" <<ENVEOF
# los executor — generated by setup-node.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_URL=$db_url
EXECUTOR_ENABLED=true
EXECUTOR_HOST=0.0.0.0
EXECUTOR_PORT=${EXECUTOR_PORT:-8090}
EXECUTOR_AGENT_KEY=$agent_key
GATEWAY_URL=$gateway_url
LOS_VERSION=$runtime_version
EXECUTOR_VERSION=$runtime_version
ENVEOF

  chown "$LOS_USER:$LOS_USER" "$LOS_HOME/.env"
  chmod 600 "$LOS_HOME/.env"
  log ".env written to $LOS_HOME/.env"
}

configured_executor_port() {
  local configured=""
  if [ -n "${EXECUTOR_PORT:-}" ]; then
    printf '%s' "$EXECUTOR_PORT"
    return
  fi
  configured="$(awk -F= '/^EXECUTOR_PORT=/{print $2; exit}' "$LOS_HOME/.env" 2>/dev/null || true)"
  printf '%s' "${configured:-8090}"
}

# ── Firewall ────────────────────────────────────────────────
apply_firewall() {
  local fw_script="$LOS_HOME/tools/firewall/los-firewall.sh"
  if [ -x "$fw_script" ] || [ -f "$fw_script" ]; then
    log "applying firewall rules..."
    bash "$fw_script" apply || warn "firewall apply had errors (may be non-fatal)"
  else
    warn "firewall script not found at $fw_script — skipping"
    warn "Run manually: sudo bash tools/firewall/los-firewall.sh apply"
  fi
}

# ── systemd service ─────────────────────────────────────────
install_service() {
  local unit_src="$LOS_HOME/deploy/systemd/los-executor.service"
  local unit_dst="/etc/systemd/system/los-executor.service"

  if [ ! -f "$unit_src" ]; then
    warn "systemd unit not found at $unit_src — skipping"
    return 0
  fi

  log "installing systemd service..."
  cp "$unit_src" "$unit_dst"
  chmod 644 "$unit_dst"
  systemctl daemon-reload
  systemctl enable los-executor

  if systemctl is-active --quiet los-executor 2>/dev/null; then
    systemctl restart los-executor
    log "  los-executor service restarted"
  else
    systemctl start los-executor
    log "  los-executor service started"
  fi
}

# ── Verify ──────────────────────────────────────────────────
verify_health() {
  log "waiting for executor health..."
  local port
  port="$(configured_executor_port)"
  local max_wait=30
  local waited=0

  while [ "$waited" -lt "$max_wait" ]; do
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      log "  executor healthy at http://127.0.0.1:$port/health"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  warn "executor did not become healthy within ${max_wait}s"
  warn "Check logs: journalctl -u los-executor -n 50"
  return 1
}

# ── Status ──────────────────────────────────────────────────
show_status() {
  echo "=== los executor status ==="
  echo ""

  if getent passwd "$LOS_USER" >/dev/null 2>&1; then
    echo "user: $LOS_USER (exists)"
  else
    echo "user: $LOS_USER (missing)"
  fi

  if [ -d "$LOS_HOME" ]; then
    echo "repo: $LOS_HOME (exists)"
  else
    echo "repo: not present"
  fi

  if [ -f "$LOS_HOME/.env" ]; then
    echo "env: $LOS_HOME/.env (present, permissions $(stat -c '%a' "$LOS_HOME/.env" 2>/dev/null || stat -f '%Lp' "$LOS_HOME/.env"))"
  else
    echo "env: missing"
  fi

  if systemctl is-active --quiet los-executor 2>/dev/null; then
    echo "service: active"
  else
    echo "service: inactive or not installed"
  fi

  local port
  port="$(configured_executor_port)"
  if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "health: ok (http://127.0.0.1:$port/health)"
  else
    echo "health: not responding"
  fi
}

# ── Main ────────────────────────────────────────────────────
log "los setup-node.sh starting (log: $LOG_FILE)"

need_root

if $SHOW_STATUS; then
  show_status
  exit 0
fi

if $CHECK_ONLY; then
  check_prereqs
  log "check-only complete — no changes made"
  exit 0
fi

# Full setup
check_prereqs
preflight_resources
create_los_user
install_deps
write_env
apply_firewall
install_service
verify_health

log ""
log "=== Setup complete ==="
log "Executor running at http://127.0.0.1:$(configured_executor_port)"
log "Check status: sudo $0 --status"
log "View logs: journalctl -u los-executor -f"
