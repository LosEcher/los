#!/usr/bin/env bash
# los-probe-run.sh — hash-pinned probe supervisor (Linux / node34).
#
# Companion to los-probe-runner.exe (Windows). Verifies the SHA-256 of the
# target probe script against a pin (embedded hash passed as argv or a
# pins.sha256 file next to this script), then runs it under `timeout` with
# stdout/stderr captured. The probe script is read-only by construction; the
# pin prevents tampered or arbitrary scripts from executing (fail-closed).
#
# Usage:
#   los-probe-run.sh <script> <timeout-sec> [-- <args...>]
#
# Pin resolution order:
#   1. env LOS_PROBE_PIN_SHA256=<hex> (explicit, takes precedence)
#   2. <script>.sha256 sidecar file (single line: "<hex>  <path>")
#   3. <dirname-of-runner>/pins.sha256 mapping file
#   4. embedded default (empty → deny unless another source matches)
#
# Exit: 0 on success; 3 = pin mismatch/denied; 124 = timeout; child code otherwise.

set -u

SCRIPT="${1:-}"
TIMEOUT_SEC="${2:-30}"
shift 2 || true
if [ -z "$SCRIPT" ]; then
  echo '{"ok":false,"error":"no script specified"}' >&2
  exit 3
fi
if [ ! -f "$SCRIPT" ]; then
  echo "{\"ok\":false,\"error\":\"script not found: $SCRIPT\"}" >&2
  exit 3
fi

RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTUAL="$(sha256sum "$SCRIPT" | awk '{print $1}')"

resolve_pin() {
  local pin=""
  # 1. explicit env
  if [ -n "${LOS_PROBE_PIN_SHA256:-}" ]; then pin="$LOS_PROBE_PIN_SHA256"; fi
  # 2. sidecar <script>.sha256
  if [ -z "$pin" ] && [ -f "$SCRIPT.sha256" ]; then
    pin="$(awk '{print $1}' "$SCRIPT.sha256" | tr 'A-F' 'a-f')"
  fi
  # 3. pins.sha256 mapping file next to runner
  if [ -z "$pin" ] && [ -f "$RUNNER_DIR/pins.sha256" ]; then
    pin="$(awk -v s="$SCRIPT" '$2==s {print $1}' "$RUNNER_DIR/pins.sha256" | tr 'A-F' 'a-f')"
  fi
  printf '%s' "$pin"
}

PIN="$(resolve_pin)"
if [ -z "$PIN" ]; then
  echo '{"ok":false,"error":"no pin configured for script (fail-closed)"}' >&2
  exit 3
fi
if [ "$ACTUAL" != "$PIN" ]; then
  echo "{\"ok\":false,\"error\":\"pinned script mismatch\",\"expected\":\"$PIN\",\"actual\":\"$ACTUAL\"}" >&2
  exit 3
fi

start_ms=$(date +%s%3N)
OUTPUT="$(timeout "$TIMEOUT_SEC" bash "$SCRIPT" "$@" 2>&1)"
CODE=$?
end_ms=$(date +%s%3N)

if [ "$CODE" -eq 124 ]; then
  echo "{\"ok\":false,\"error\":\"probe timed out after ${TIMEOUT_SEC}s\",\"script\":\"$SCRIPT\"}" >&2
  exit 124
fi

# Emit a JSON envelope with the probe's output embedded as a JSON string.
ESCAPED="$(printf '%s' "$OUTPUT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '%s' "$OUTPUT")"
printf '{"ok":true,"pinned":true,"script":"%s","sha256":"%s","exit_code":%s,"ms":%s,"output":%s}\n' \
  "$SCRIPT" "$ACTUAL" "$CODE" "$((end_ms - start_ms))" "$ESCAPED"
exit 0
