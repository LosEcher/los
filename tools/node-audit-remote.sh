#!/usr/bin/env bash
# node-audit-remote.sh — read-only audit body, run ON the audited node.
# Used by tools/node-audit.sh both locally (bash node-audit-remote.sh) and
# remotely (ssh <node> 'bash -s' < node-audit-remote.sh). Never writes.
set -uo pipefail

node_name="$(hostname 2>/dev/null || uname -n)"
printf '== host ==\n'
printf 'hostname: %s\n' "$node_name"
printf 'kernel: %s\n' "$(uname -sr 2>/dev/null || echo 'n/a')"
if [ -f /etc/os-release ]; then
  printf 'os: %s %s\n' "$(grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2 | tr -d '"')" \
    "$(grep '^VERSION=' /etc/os-release | cut -d= -f2 | tr -d '"')"
elif command -v sw_vers >/dev/null 2>&1; then
  printf 'os: %s %s\n' "$(sw_vers -productName)" "$(sw_vers -productVersion)"
fi
printf 'arch: %s\n' "$(uname -m)"

printf '\n== resources ==\n'
if command -v free >/dev/null 2>&1; then free -h | head -2; else sysctl -n hw.memsize 2>/dev/null | awk '{printf "mem_bytes: %d (%.1f GB)\n",$1,$1/1073741824}'; fi
# All real disk mounts (exclude tmpfs/overlay/squashfs virtual filesystems) —
# multi-disk nodes (e.g. node34 vda + vdb) must be fully visible.
df -hT 2>/dev/null | grep -vE "tmpfs|overlay|squashfs|^Filesystem" || df -h / 2>/dev/null | tail -1
if command -v swapon >/dev/null 2>&1; then swapon --show 2>/dev/null || echo "swap: none"; fi

printf '\n== tools ==\n'
for t in node pnpm npm git jj docker bun go rustc cargo python3 rg jq tmux tailscale sing-box; do
  if command -v "$t" >/dev/null 2>&1; then
    case "$t" in
      node)  v="$(node -v 2>/dev/null)" ;;
      pnpm)  v="$(pnpm --version 2>/dev/null)" ;;
      npm)   v="$(npm -v 2>/dev/null)" ;;
      git)   v="$(git --version 2>/dev/null | sed 's/git version //')" ;;
      jj)    v="$(jj --version 2>/dev/null | head -1 | sed 's/.*jj //;s/ .*//')" ;;
      docker) v="$(docker --version 2>/dev/null | sed 's/Docker version //')" ;;
      bun)   v="$(bun --version 2>/dev/null)" ;;
      go)    v="$(go version 2>/dev/null | sed 's/go version //;s/ .*//')" ;;
      rustc) v="$(rustc --version 2>/dev/null | awk '{print $2}')" ;;
      cargo) v="$(cargo --version 2>/dev/null | awk '{print $2}')" ;;
      python3) v="$(python3 --version 2>/dev/null | awk '{print $2}')" ;;
      rg)    v="$(rg --version 2>/dev/null | head -1 | awk '{print $2}')" ;;
      jq)    v="$(jq --version 2>/dev/null)" ;;
      tmux)  v="$(tmux -V 2>/dev/null | awk '{print $2}')" ;;
      tailscale) v="$(tailscale version 2>/dev/null | head -1 | awk '{print $1}')" ;;
      sing-box) v="$(sing-box version 2>/dev/null | head -1)" ;;
      *)     v="present" ;;
    esac
    printf '%-10s %s\n' "$t" "${v:-present}"
  else
    printf '%-10s MISSING\n' "$t"
  fi
done

printf '\n== herdr ==\n'
if command -v herdr >/dev/null 2>&1; then
  printf 'herdr: %s\n' "$(herdr --version 2>/dev/null | head -1)"
else
  printf 'herdr: MISSING\n'
fi
for d in "$HOME/.herdr" "$HOME/.config/herdr"; do
  if [ -e "$d" ]; then printf 'dir: %s\n' "$d"; fi
done
if [ -f "$HOME/.config/herdr/config.toml" ]; then
  printf 'config: present (%s bytes)\n' "$(wc -c < "$HOME/.config/herdr/config.toml")"
fi

printf '\n== los runtime ==\n'
if [ -d /opt/los ]; then
  printf 'repo: /opt/los present\n'
  if [ -f /opt/los/.env ]; then
    grep -E '^(LOS_VERSION|EXECUTOR_VERSION|EXECUTOR_PORT|GATEWAY_URL)=' /opt/los/.env 2>/dev/null | sed 's/\(DATABASE_URL\|EXECUTOR_AGENT_KEY\)=.*/\1=<redacted>/' || true
  fi
  # GATEWAY_URL reachability probe (dead-gateway guard)
  gateway_url="$(grep -E '^GATEWAY_URL=' /opt/los/.env 2>/dev/null | cut -d= -f2-)"
  if [ -n "$gateway_url" ]; then
    if curl -sf --max-time 5 "${gateway_url%/}/health" >/dev/null 2>&1; then
      printf 'gateway: %s reachable\n' "$gateway_url"
    else
      printf 'gateway: %s UNREACHABLE (heartbeats will fail)\n' "$gateway_url"
    fi
  fi
else
  printf 'repo: /opt/los MISSING\n'
fi
if command -v systemctl >/dev/null 2>&1; then
  for svc in los-executor tailscaled docker ssh sing-box forgejo; do
    st="$(systemctl is-active "$svc" 2>/dev/null || echo 'n/a')"
    printf 'service %-14s %s\n' "$svc" "$st"
  done
fi
# executor health (ports 8090/8091)
for port in 8090 8091; do
  if command -v curl >/dev/null 2>&1; then
    h="$(curl -sf --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
    if [ -n "$h" ]; then
      ver="$(printf '%s' "$h" | grep -oE '"version":"[^"]+"' | head -1)"
      printf 'health :%s -> %s\n' "$port" "${ver:-ok}"
    fi
  fi
done

printf '\n== listeners (common los/herdr ports) ==\n'
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | grep -E ':(2080|23452|8080|8090|8091|3000|5432|8088)\b' || echo "none of 2080/23452/8080/8090/8091/3000/5432/8088 listening"
elif command -v netstat >/dev/null 2>&1; then
  netstat -tlnp 2>/dev/null | grep -E ':(2080|23452|8080|8090|8091|3000|5432|8088)\b' || echo "none of the common ports listening"
else
  echo "no ss/netstat"
fi

printf '\n== docker ==\n'
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null | head -15; then
    :
  else
    echo "(docker present but daemon not accessible / not running)"
  fi
else
  echo "docker: MISSING"
fi

printf '\n== tailscale ==\n'
if command -v tailscale >/dev/null 2>&1; then
  tailscale status 2>/dev/null | head -8 || echo "(tailscale status not readable)"
fi

printf '\n== package manager outdated (quick) ==\n'
if command -v apt >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
  apt list --upgradable 2>/dev/null | head -5 || true
elif command -v brew >/dev/null 2>&1; then
  brew outdated 2>/dev/null | head -10 || true
else
  echo "(no apt-as-root / brew; skip)"
fi
