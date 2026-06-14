#!/usr/bin/env bash
# los-firewall.sh — idempotent firewall configuration for los executor nodes.
#
# Opens the executor port (8090) and Tailscale UDP (41641) on the Tailscale
# interface. Supports iptables (Linux) and ufw (Linux). macOS (pf) uses a
# separate path since Tailscale on macOS typically doesn't need it.
#
# Usage:
#   los-firewall.sh apply          # Open los ports on tailscale0
#   los-firewall.sh apply --dry-run
#   los-firewall.sh remove         # Remove los rules
#   los-firewall.sh remove --dry-run
#   los-firewall.sh status         # Show current rules
#   los-firewall.sh help
set -euo pipefail

# ── Config ──────────────────────────────────────────────────
EXECUTOR_PORT="${EXECUTOR_PORT:-8090}"
TS_UDP_PORT="${TS_UDP_PORT:-41641}"
TS_INTERFACE="${TS_INTERFACE:-tailscale0}"
ACTION="${1:-help}"
DRY_RUN=false
[ "${2:-}" = "--dry-run" ] && DRY_RUN=true

# ── Help ────────────────────────────────────────────────────
if [ "$ACTION" = "help" ] || [ "$ACTION" = "-h" ] || [ "$ACTION" = "--help" ]; then
  cat <<EOF
los-firewall.sh — idempotent firewall for los executor on Tailscale

Commands:
  apply           Open executor ($EXECUTOR_PORT/tcp) + Tailscale ($TS_UDP_PORT/udp)
  remove          Remove both rules
  status          Show current iptables/ufw state
  help            This help

Options:
  --dry-run       Print what would be done without doing it

Required:
  Must run as root (sudo los-firewall.sh apply)
EOF
  exit 0
fi

# ── Root check ──────────────────────────────────────────────
need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: must run as root. Use: sudo $0 $ACTION"
    exit 1
  fi
}

# ── OS detection ────────────────────────────────────────────
is_linux() { [ "$(uname -s)" = "Linux" ]; }
is_macos() { [ "$(uname -s)" = "Darwin" ]; }
has_ufw() { command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; }
has_iptables() { command -v iptables >/dev/null 2>&1; }

# ── Interface check ─────────────────────────────────────────
ts_interface_exists() {
  ip link show "$TS_INTERFACE" >/dev/null 2>&1
}

# ── iptables path ───────────────────────────────────────────
ipt_rule_exists() {
  local chain="$1" port="$2" proto="$3"
  iptables -C "$chain" -i "$TS_INTERFACE" -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null
}

ipt_status() {
  echo "=== iptables INPUT rules for $TS_INTERFACE ==="
  if ts_interface_exists; then
    iptables -L INPUT -n -v --line-numbers 2>/dev/null | grep -E "(Chain INPUT|$TS_INTERFACE|$EXECUTOR_PORT|$TS_UDP_PORT)" || echo "  (no los rules found)"
  else
    echo "  (interface $TS_INTERFACE does not exist)"
  fi
}

ipt_apply() {
  need_root
  if ! ts_interface_exists; then
    echo "WARNING: $TS_INTERFACE not found, adding rules anyway (will activate when interface exists)"
  fi

  # Executor port 8090/tcp
  if ipt_rule_exists INPUT "$EXECUTOR_PORT" tcp; then
    echo "  [skip] iptables -A INPUT -i $TS_INTERFACE -p tcp --dport $EXECUTOR_PORT -j ACCEPT (exists)"
  else
    if $DRY_RUN; then
      echo "  [dry-run] iptables -A INPUT -i $TS_INTERFACE -p tcp --dport $EXECUTOR_PORT -j ACCEPT"
    else
      iptables -A INPUT -i "$TS_INTERFACE" -p tcp --dport "$EXECUTOR_PORT" -j ACCEPT
      echo "  [ok] iptables -A INPUT -i $TS_INTERFACE -p tcp --dport $EXECUTOR_PORT -j ACCEPT"
    fi
  fi

  # Tailscale UDP 41641
  if ipt_rule_exists INPUT "$TS_UDP_PORT" udp; then
    echo "  [skip] iptables -A INPUT -i $TS_INTERFACE -p udp --dport $TS_UDP_PORT -j ACCEPT (exists)"
  else
    if $DRY_RUN; then
      echo "  [dry-run] iptables -A INPUT -i $TS_INTERFACE -p udp --dport $TS_UDP_PORT -j ACCEPT"
    else
      iptables -A INPUT -i "$TS_INTERFACE" -p udp --dport "$TS_UDP_PORT" -j ACCEPT
      echo "  [ok] iptables -A INPUT -i $TS_INTERFACE -p udp --dport $TS_UDP_PORT -j ACCEPT"
    fi
  fi
  if ! $DRY_RUN; then
    save_iptables
  fi
}

ipt_remove() {
  need_root
  local removed=0

  if ipt_rule_exists INPUT "$EXECUTOR_PORT" tcp; then
    if $DRY_RUN; then
      echo "  [dry-run] iptables -D INPUT -i $TS_INTERFACE -p tcp --dport $EXECUTOR_PORT -j ACCEPT"
    else
      iptables -D INPUT -i "$TS_INTERFACE" -p tcp --dport "$EXECUTOR_PORT" -j ACCEPT
      echo "  [ok] removed executor port rule"
    fi
    removed=1
  else
    echo "  [skip] no executor port rule to remove"
  fi

  if ipt_rule_exists INPUT "$TS_UDP_PORT" udp; then
    if $DRY_RUN; then
      echo "  [dry-run] iptables -D INPUT -i $TS_INTERFACE -p udp --dport $TS_UDP_PORT -j ACCEPT"
    else
      iptables -D INPUT -i "$TS_INTERFACE" -p udp --dport "$TS_UDP_PORT" -j ACCEPT
      echo "  [ok] removed Tailscale UDP rule"
    fi
    removed=1
  else
    echo "  [skip] no Tailscale UDP rule to remove"
  fi

  if [ "$removed" -eq 0 ]; then
    echo "  (no los rules were present)"
  fi
}

# ── ufw path ────────────────────────────────────────────────
ufw_status() {
  echo "=== ufw rules ==="
  if has_ufw; then
    ufw status numbered 2>/dev/null | grep -E "$EXECUTOR_PORT|$TS_UDP_PORT|$TS_INTERFACE" || echo "  (no los-related ufw rules found)"
  else
    echo "  (ufw not active)"
  fi
}

ufw_apply() {
  need_root
  if ! has_ufw; then
    echo "ERROR: ufw is not active. Enable with: sudo ufw enable"
    exit 1
  fi

  if ufw status | grep -q "$EXECUTOR_PORT/tcp.*ALLOW"; then
    echo "  [skip] ufw allow $EXECUTOR_PORT/tcp (exists)"
  else
    if $DRY_RUN; then
      echo "  [dry-run] ufw allow $EXECUTOR_PORT/tcp"
    else
      ufw allow "$EXECUTOR_PORT/tcp" >/dev/null
      echo "  [ok] ufw allow $EXECUTOR_PORT/tcp"
    fi
  fi

  if ufw status | grep -q "$TS_UDP_PORT/udp.*ALLOW"; then
    echo "  [skip] ufw allow $TS_UDP_PORT/udp (exists)"
  else
    if $DRY_RUN; then
      echo "  [dry-run] ufw allow $TS_UDP_PORT/udp"
    else
      ufw allow "$TS_UDP_PORT/udp" >/dev/null
      echo "  [ok] ufw allow $TS_UDP_PORT/udp"
    fi
  fi
}

ufw_remove() {
  need_root
  if has_ufw; then
    if $DRY_RUN; then
      echo "  [dry-run] ufw delete allow $EXECUTOR_PORT/tcp"
      echo "  [dry-run] ufw delete allow $TS_UDP_PORT/udp"
    else
      ufw delete allow "$EXECUTOR_PORT/tcp" 2>/dev/null && echo "  [ok] removed ufw $EXECUTOR_PORT/tcp" || echo "  [skip] no ufw $EXECUTOR_PORT/tcp rule"
      ufw delete allow "$TS_UDP_PORT/udp" 2>/dev/null && echo "  [ok] removed ufw $TS_UDP_PORT/udp" || echo "  [skip] no ufw $TS_UDP_PORT/udp rule"
    fi
  fi
}

# ── Persistence ──────────────────────────────────────────────
save_iptables() {
  if command -v iptables-save >/dev/null 2>&1; then
    if [ -d /etc/iptables ]; then
      iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    elif command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save 2>/dev/null || true
    else
      echo "  NOTE: install iptables-persistent to survive reboots: apt install iptables-persistent"
    fi
  fi
}

# ── macOS / pf path ─────────────────────────────────────────
macos_status() {
  echo "=== macOS firewall ==="
  echo "  macOS pf is rarely an issue for Tailscale. If needed, configure via:"
  echo "    sudo pfctl -f /etc/pf.conf"
  echo "  No automatic rules are applied by this script."
}

# ── Main dispatch ───────────────────────────────────────────

if [ "$ACTION" = "status" ]; then
  if is_linux; then
    ipt_status
    ufw_status
  elif is_macos; then
    macos_status
  else
    echo "Unknown OS: $(uname -s)"
    exit 1
  fi
  exit 0
fi

if [ "$ACTION" = "apply" ]; then
  echo "los-firewall: apply (dry-run=$DRY_RUN)"
  if is_linux; then
    if has_iptables; then
      ipt_apply
    else
      echo "WARNING: iptables not found"
    fi
    if has_ufw; then
      ufw_apply
    fi
    if ! has_iptables && ! has_ufw; then
      echo "ERROR: no supported firewall found (iptables or ufw)"
      exit 1
    fi
  elif is_macos; then
    echo "macOS: Tailscale firewall is usually not needed (no iptables)"
    echo "If you need pf rules, configure /etc/pf.conf manually."
  else
    echo "Unknown OS: $(uname -s)"
    exit 1
  fi
  if ! $DRY_RUN; then
    echo ""
    echo "=== Updated state ==="
    "$0" status
  fi
  exit 0
fi

if [ "$ACTION" = "remove" ]; then
  echo "los-firewall: remove (dry-run=$DRY_RUN)"
  if is_linux; then
    if has_iptables; then
      ipt_remove
    fi
    if has_ufw; then
      ufw_remove
    fi
  elif is_macos; then
    echo "macOS: nothing to remove (no iptables/ufw rules managed by this script)"
  fi
  exit 0
fi

echo "ERROR: unknown action '$ACTION'. Use: apply, remove, status, help"
exit 1
