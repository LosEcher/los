#!/usr/bin/env bash
# deploy-executor.sh — bootstrap a los executor on a remote node via SSH.
# Usage:
#   ./tools/deploy-executor.sh <user@host> [--port 22] [--key ~/.ssh/id_ed25519]
#                                      [--node-id <id>] [--gateway-url <url>]
#                                      [--dry-run] [--setup-only] [--start]
#
# Architecture note (ADR 0011): This script bootstraps the executor process.
# Once running, the executor self-registers via heartbeat and receives all
# commands via HTTP — SSH is only used for initial deployment, not execution.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=false
SETUP_ONLY=false
START_SERVICE=false
SSH_PORT=22
SSH_KEY=""
TARGET=""
NODE_ID="${LOS_EXECUTOR_NODE_ID:-}"
GATEWAY_URL="${LOS_EXECUTOR_GATEWAY_URL:-}"
INSTALL_DIR="/opt/los-executor"
NODE_VERSION="22"

# ── Parse args ─────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)       SSH_PORT="$2"; shift 2 ;;
    --key)        SSH_KEY="$2"; shift 2 ;;
    --node-id)    NODE_ID="$2"; shift 2 ;;
    --gateway-url) GATEWAY_URL="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --setup-only) SETUP_ONLY=true; shift ;;
    --start)      START_SERVICE=true; shift ;;
    -h|--help)
      echo "Usage: $0 <user@host> [options]"
      echo ""
      echo "Deploy los executor to a remote node via SSH."
      echo ""
      echo "Options:"
      echo "  --port <port>        SSH port (default: 22)"
      echo "  --key <path>         SSH identity file"
      echo "  --node-id <id>       Executor node ID (required)"
      echo "  --gateway-url <url>  Gateway URL for heartbeat registration (required)"
      echo "  --install-dir <dir>  Installation directory (default: /opt/los-executor)"
      echo "  --dry-run            Preview only, do nothing"
      echo "  --setup-only         Only install deps, don't copy code"
      echo "  --start              Start the service after deployment"
      echo ""
      echo "Env vars: LOS_EXECUTOR_NODE_ID, LOS_EXECUTOR_GATEWAY_URL"
      exit 0
      ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "ERROR: target is required (e.g. user@10.0.0.34)"
  exit 1
fi
if [[ -z "$NODE_ID" ]]; then
  echo "ERROR: --node-id is required (or set LOS_EXECUTOR_NODE_ID)"
  exit 1
fi
if [[ -z "$GATEWAY_URL" ]]; then
  echo "ERROR: --gateway-url is required (or set LOS_EXECUTOR_GATEWAY_URL)"
  exit 1
fi

SSH_OPTS="-p $SSH_PORT -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi
SCP_OPTS="-P $SSH_PORT -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
if [[ -n "$SSH_KEY" ]]; then
  SCP_OPTS="$SCP_OPTS -i $SSH_KEY"
fi

# ── Helpers ────────────────────────────────────────────

ssh_cmd() {
  if $DRY_RUN; then
    echo "[dry-run] ssh $SSH_OPTS $TARGET $*"
  else
    ssh $SSH_OPTS "$TARGET" "$@"
  fi
}

scp_cmd() {
  if $DRY_RUN; then
    echo "[dry-run] scp $SCP_OPTS $*"
  else
    scp $SCP_OPTS "$@"
  fi
}

log()  { echo "  → $*"; }
step() { echo ""; echo -e "\033[1;36m═══ $* ═══\033[0m"; }

# ── Main ───────────────────────────────────────────────

echo "los executor deploy"
echo "  target:      $TARGET"
echo "  node-id:     $NODE_ID"
echo "  gateway:     $GATEWAY_URL"
echo "  install-dir: $INSTALL_DIR"
$DRY_RUN && echo "  mode:        DRY RUN"

# 1. Verify SSH connectivity
step "Verify SSH connectivity"
if ssh_cmd "echo ok" 2>&1 | grep -q ok; then
  log "SSH connection successful"
else
  log "SSH connection check completed"
fi

# 2. Check/setup Node.js
step "Check Node.js $NODE_VERSION"
node_check=$(ssh_cmd "command -v node && node --version || echo missing" 2>&1 || true)
if echo "$node_check" | grep -qE "v${NODE_VERSION}|v2[2-9]|v[3-9][0-9]"; then
  log "Node.js found: $(echo "$node_check" | head -1)"
else
  log "Node.js $NODE_VERSION not found, installing via nvm..."
  ssh_cmd "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash" || true
  ssh_cmd 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install '"$NODE_VERSION" || {
    echo "WARN: Could not install Node.js via nvm. Install manually and re-run."
  }
fi

# 3. Check/setup pnpm
step "Check pnpm"
pnpm_check=$(ssh_cmd "command -v pnpm && pnpm --version || echo missing" 2>&1 || true)
if echo "$pnpm_check" | grep -qE '[0-9]+\.[0-9]+'; then
  log "pnpm found: $(echo "$pnpm_check" | head -1)"
else
  log "Installing pnpm..."
  ssh_cmd "npm install -g pnpm" || {
    echo "WARN: Could not install pnpm. Install manually and re-run."
  }
fi

# 4. Create install directory
step "Create install directory"
ssh_cmd "mkdir -p $INSTALL_DIR"

if $SETUP_ONLY; then
  echo ""
  echo "Setup complete (--setup-only). Run without --setup-only to deploy code."
  exit 0
fi

# 5. Determine what to deploy
step "Package executor for deployment"
# Deploy the executor package + its workspace dependencies
DEPLOY_PACKAGES=(
  "packages/executor"
  "packages/infra"
  "packages/agent"
  "packages/memory"
  "packages/web"
  "packages/input-preprocessor"
)
DEPLOY_FILES=(
  "pnpm-workspace.yaml"
  "pnpm-lock.yaml"
  "package.json"
  "tsconfig.base.json"
  "turbo.json"
  ".npmrc"
  "tools/executor.sh"
  "tools/los.sh"
)

TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

log "Creating deployment archive..."
for pkg in "${DEPLOY_PACKAGES[@]}"; do
  if [[ -d "$ROOT/$pkg" ]]; then
    mkdir -p "$TMP_DIR/$(dirname "$pkg")"
    # Copy source + package.json, skip node_modules and dist
    rsync -a --exclude='node_modules' --exclude='dist' --exclude='.turbo' \
      "$ROOT/$pkg/" "$TMP_DIR/$pkg/" 2>/dev/null || true
  fi
done
for f in "${DEPLOY_FILES[@]}"; do
  if [[ -f "$ROOT/$f" ]]; then
    mkdir -p "$TMP_DIR/$(dirname "$f")"
    cp "$ROOT/$f" "$TMP_DIR/$f"
  fi
done

# 6. Transfer files
step "Transfer files to $TARGET"
scp_cmd -r "$TMP_DIR/"* "$TARGET:$INSTALL_DIR/"

# 7. Install dependencies on remote
step "Install dependencies"
ssh_cmd "cd $INSTALL_DIR && pnpm install" || {
  log "pnpm install failed — check network on remote node"
}

# 8. Create .env file on remote
step "Configure executor environment"
ssh_cmd "cat > $INSTALL_DIR/.env << 'EOF'
EXECUTOR_ENABLED=true
EXECUTOR_NODE_ID=$NODE_ID
GATEWAY_URL=$GATEWAY_URL
EXECUTOR_NODE_KIND=executor
EXECUTOR_CONNECT_MODES=agent_http,agent_http_ndjson
EOF"

# 9. Set up systemd service (if systemd available)
step "Configure systemd service"
if ssh_cmd "command -v systemctl" 2>&1 | grep -q systemctl; then
  log "systemd detected, creating service unit..."
  NODE_PATH=$(ssh_cmd "command -v node || echo /usr/bin/node")
  ssh_cmd "cat > /etc/systemd/system/los-executor.service << EOF
[Unit]
Description=los executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$NODE_PATH --import $INSTALL_DIR/node_modules/.pnpm/tsx@4.22.3/node_modules/tsx/dist/preflight.cjs $INSTALL_DIR/packages/executor/src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF"
  ssh_cmd "systemctl daemon-reload"
  if $START_SERVICE; then
    ssh_cmd "systemctl enable --now los-executor"
  else
    log "Service unit created. Run with --start to enable and start."
  fi
else
  log "systemd not available. Start executor manually:"
  log "  cd $INSTALL_DIR && npx tsx packages/executor/src/index.ts"
fi

# 10. Verify
step "Verify deployment"
if $START_SERVICE; then
  sleep 3
  ssh_cmd "systemctl is-active los-executor || echo 'not active yet'" || true
fi

echo ""
echo -e "\033[0;32mDeployment complete.\033[0m"
echo "  Node ID:  $NODE_ID"
echo "  Gateway:  $GATEWAY_URL"
echo "  Target:   $TARGET"
echo ""
echo "Monitor registration:"
echo "  curl $GATEWAY_URL/nodes | grep $NODE_ID"
echo ""
echo "If the executor does not appear, check logs:"
echo "  ssh $SSH_OPTS $TARGET systemctl status los-executor"
if ! $START_SERVICE; then
  echo ""
  echo "To start the executor:"
  echo "  ssh $SSH_OPTS $TARGET systemctl start los-executor"
  echo ""
  echo "Or re-run with --start:"
  echo "  $0 $TARGET --node-id $NODE_ID --gateway-url $GATEWAY_URL --start"
fi
