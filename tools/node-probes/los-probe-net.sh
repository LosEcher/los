#!/usr/bin/env bash
# los-probe-net.sh — read-only network probe (Linux / node34).
#
# Pinned read-only diagnostic companion to los-probe-net.ps1 (Windows).
# Performs network reachability checks (TCP / ICMP / HTTP) and reports local
# service presence. Writes NOTHING to disk; the only output is a single JSON
# document on stdout. Intended to run exclusively through los-probe-run.sh,
# the hash-pinned supervisor (los agent tool `run_node_probe`, probe='net').
#
# This file is hash-pinned at deploy time: editing it invalidates the pin and
# the runner refuses to execute it (fail-closed).
#
# Env knobs (all optional, semicolon-separated):
#   LOS_PROBE_TARGETS  host:port TCP targets   (defaults below)
#   LOS_PROBE_PING     hosts to ICMP-ping      (default: 127.0.0.1)
#   LOS_PROBE_HTTP     URLs for HTTP checks    (default: gateway health)
#   LOS_PROBE_PROCESS  process names           (default: sing-box)

set -u

DEFAULT_TARGETS="1.1.1.1:443 8.8.8.8:53 100.112.77.123:8080"
DEFAULT_PING="127.0.0.1"
DEFAULT_HTTP="http://100.112.77.123:8080/health"
DEFAULT_PROCESS="sing-box"

split_list() {
  local raw="${1:-}" fallback="$2"
  if [ -z "$raw" ]; then printf '%s' "$fallback"; return; fi
  printf '%s' "$raw" | tr ';' ' '
}

tcp_probe() {
  local hp="$1" h p sw code detail
  h="${hp%:*}"; p="${hp##*:}"
  case "$hp" in
    *:*:*) printf '{"target":"%s","kind":"tcp","ok":false,"detail":"bad target format"}' "$hp"; return ;;
  esac
  case "$p" in ''|*[!0-9]*) printf '{"target":"%s","kind":"tcp","ok":false,"detail":"bad port"}' "$hp"; return ;; esac
  sw=$(date +%s%3N)
  if timeout 3 bash -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then
    code=0
  else
    code=1
  fi
  local ms=$(( $(date +%s%3N) - sw ))
  if [ "$code" -eq 0 ]; then
    printf '{"target":"%s","kind":"tcp","ok":true,"ms":%s}' "$hp" "$ms"
  else
    printf '{"target":"%s","kind":"tcp","ok":false,"ms":%s,"detail":"connect failed"}' "$hp" "$ms"
  fi
}

ping_probe() {
  local host="$1" sw ms ok=0
  sw=$(date +%s%3N)
  if ping -c1 -W2 "$host" >/dev/null 2>&1; then ok=1; fi
  ms=$(( $(date +%s%3N) - sw ))
  if [ "$ok" -eq 1 ]; then
    printf '{"target":"%s","kind":"ping","ok":true,"ms":%s}' "$host" "$ms"
  else
    printf '{"target":"%s","kind":"ping","ok":false,"ms":%s,"detail":"unreachable"}' "$host" "$ms"
  fi
}

http_probe() {
  local url="$1" sw ms code
  sw=$(date +%s%3N)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
  ms=$(( $(date +%s%3N) - sw ))
  if [ -n "$code" ]; then
    if [[ "$code" =~ ^[24] ]]; then
      printf '{"target":"%s","kind":"http","ok":true,"code":"%s","ms":%s}' "$url" "$code" "$ms"
    else
      printf '{"target":"%s","kind":"http","ok":false,"code":"%s","ms":%s}' "$url" "$code" "$ms"
    fi
  else
    printf '{"target":"%s","kind":"http","ok":false,"ms":%s,"detail":"no response"}' "$url" "$ms"
  fi
}

service_probe() {
  local name="$1" pid
  pid=$(pgrep -x "$name" 2>/dev/null | head -1)
  if [ -n "$pid" ]; then
    printf '{"name":"%s","running":true,"pid":%s}' "$name" "$pid"
  else
    printf '{"name":"%s","running":false,"pid":null}' "$name"
  fi
}

targets=$(split_list "${LOS_PROBE_TARGETS:-}" "$DEFAULT_TARGETS")
pings=$(split_list "${LOS_PROBE_PING:-}" "$DEFAULT_PING")
urls=$(split_list "${LOS_PROBE_HTTP:-}" "$DEFAULT_HTTP")
procs=$(split_list "${LOS_PROBE_PROCESS:-}" "$DEFAULT_PROCESS")

first=1
printf '{"ts":%s,"host":"%s","probe":"net","probes":[' "$(date +%s)" "$(hostname)"
for t in $targets; do
  [ "$first" -eq 0 ] && printf ','
  first=0
  tcp_probe "$t"
done
for h in $pings; do
  [ "$first" -eq 0 ] && printf ','
  first=0
  ping_probe "$h"
done
for u in $urls; do
  [ "$first" -eq 0 ] && printf ','
  first=0
  http_probe "$u"
done
printf '],"services":['
first=1
for n in $procs; do
  [ "$first" -eq 0 ] && printf ','
  first=0
  service_probe "$n"
done
printf ']}'
printf '\n'
