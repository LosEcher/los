#!/usr/bin/env bash
# deploy-probes.sh — deploy the hash-pinned read-only probe runner to a los
# executor node via SSH. Idempotent; safe to re-run.
#
# Enforces the invariant "repo script == node script == pin record":
#   1. compute the probe script SHA-256 from THIS repo (source of truth)
#   2. copy the script (+ supervisor) to the node
#   3. write the pin record (Linux: pins.sha256; Windows: pins.json)
#   4. read the hash back from the node and compare (fail-closed on drift)
#   5. smoke-run the pinned probe once
#
# Usage:
#   ./tools/node-probes/deploy-probes.sh <ssh-alias> [--dir <path>] [--win] [--dry-run]
#
#   --dir <path>   remote probe directory (auto default: /opt/los/bin/probe on
#                  Linux, C:\los\bin\probe on Windows)
#   --win          force the Windows layout (auto-detected via uname otherwise)
#   --dry-run      print the plan and hashes, do nothing
#
# Linux notes: the target directory may be owned by a service user (los) while
# the SSH account is a sudoer (e.g. ubuntu@oracle). Files are staged in /tmp
# and installed via sudo when the directory is not writable directly.
#
# Examples:
#   ./tools/node-probes/deploy-probes.sh localnode34-r-t
#   ./tools/node-probes/deploy-probes.sh win-los
#   ./tools/node-probes/deploy-probes.sh oracle-t
#
# Exit codes: 0 ok; 1 verification/drift failure; 2 usage error.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false
FORCE_WIN=false
TARGET=""
REMOTE_DIR=""

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) REMOTE_DIR="$2"; shift 2 ;;
    --win) FORCE_WIN=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) TARGET="$1"; shift ;;
  esac
done
[[ -z "$TARGET" ]] && { echo "missing <ssh-alias>" >&2; usage; }

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }   # macOS lacks sha256sum

# ── Detect platform ─────────────────────────────────────────────
detect_platform() {
  if [[ "$FORCE_WIN" == "true" ]]; then echo "win"; return; fi
  # Windows OpenSSH default shell (cmd) mangles quoting; probe via
  # EncodedCommand (the channel the rest of this toolchain uses).
  local b64 ps os
  b64="$(printf '%s' '[Environment]::OSVersion.Platform.ToString()' | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
  ps="$(ssh -o ConnectTimeout=12 -o BatchMode=yes "$TARGET" "powershell -NoProfile -EncodedCommand $b64" 2>/dev/null | tr -d '\r')"
  if [[ "$ps" == *Win32NT* ]]; then echo "win"; return; fi
  os="$(ssh -o ConnectTimeout=12 -o BatchMode=yes "$TARGET" "uname -s" 2>/dev/null | tr -d '\r')"
  case "$os" in
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *) echo "linux" ;;
  esac
}

PLATFORM="$(detect_platform)"
if [[ -z "$REMOTE_DIR" ]]; then
  if [[ "$PLATFORM" == "win" ]]; then REMOTE_DIR='C:\los\bin\probe'; else REMOTE_DIR='/opt/los/bin/probe'; fi
fi

if [[ "$PLATFORM" == "win" ]]; then PROBE_SCRIPT="los-probe-net.ps1"; else PROBE_SCRIPT="los-probe-net.sh"; fi
SHA="$(sha_of "$SRC_DIR/$PROBE_SCRIPT")"

echo "[deploy-probes] target=$TARGET platform=$PLATFORM dir=$REMOTE_DIR"
echo "[deploy-probes] script=$PROBE_SCRIPT sha256=$SHA"
[[ "$DRY_RUN" == "true" ]] && { echo "[deploy-probes] dry-run: nothing done"; exit 0; }

run_remote() { ssh -o ConnectTimeout=15 -o BatchMode=yes "$TARGET" "$1"; }

if [[ "$PLATFORM" == "linux" ]]; then
  # ── Linux: sh script + run.sh supervisor + pins.sha256 ────────────────
  # Stage in /tmp, then install (sudo when the target dir is not writable).
  run_remote "mkdir -p /tmp/los-probes-deploy" || exit 1
  scp -q -o ConnectTimeout=15 "$SRC_DIR/$PROBE_SCRIPT" "$SRC_DIR/los-probe-run.sh" "$TARGET:/tmp/los-probes-deploy/" || exit 1
  printf '%s  %s\n' "$SHA" "$REMOTE_DIR/los-probe-net.sh" > /tmp/los-probes-deploy-pins.sha256
  scp -q -o ConnectTimeout=15 /tmp/los-probes-deploy-pins.sha256 "$TARGET:/tmp/los-probes-deploy/pins.sha256" || exit 1
  INSTALL="install -m 0755 /tmp/los-probes-deploy/los-probe-net.sh '$REMOTE_DIR/' && install -m 0755 /tmp/los-probes-deploy/los-probe-run.sh '$REMOTE_DIR/' && install -m 0644 /tmp/los-probes-deploy/pins.sha256 '$REMOTE_DIR/'"
  if run_remote "mkdir -p '$REMOTE_DIR' 2>/dev/null && [ -w '$REMOTE_DIR' ] && $INSTALL"; then
    : # direct write worked
  else
    # fallback: sudo install
    run_remote "sudo mkdir -p '$REMOTE_DIR' && sudo sh -c '$INSTALL'" || { echo "[deploy-probes] install failed (direct+sudo)" >&2; exit 1; }
  fi
  run_remote "rm -rf /tmp/los-probes-deploy" >/dev/null 2>&1
  ACTUAL="$(run_remote "sha256sum '$REMOTE_DIR/los-probe-net.sh' | awk '{print \$1}'" | tr -d '\r')"
  if [[ "$ACTUAL" != "$SHA" ]]; then
    echo "[deploy-probes] FAIL: node hash drift (expected $SHA, got $ACTUAL)" >&2
    exit 1
  fi
  echo "[deploy-probes] node hash verified: $ACTUAL"
  OUT="$(run_remote "bash '$REMOTE_DIR/los-probe-run.sh' '$REMOTE_DIR/los-probe-net.sh' 30 2>&1" | head -c 600)"
  echo "[deploy-probes] smoke: $OUT"
else
  # ── Windows: ps1 script + compile runner + pins.json ──────────────────
  run_remote "powershell -NoProfile -Command \"if (-not (Test-Path '$REMOTE_DIR')) { New-Item -ItemType Directory -Path '$REMOTE_DIR' | Out-Null }; if (-not (Test-Path '$REMOTE_DIR\\src')) { New-Item -ItemType Directory -Path '$REMOTE_DIR\\src' | Out-Null }; 'dir-ready'\"" >/dev/null || exit 1
  scp -q -o ConnectTimeout=15 "$SRC_DIR/$PROBE_SCRIPT" "$TARGET:$REMOTE_DIR/" || exit 1
  scp -q -o ConnectTimeout=15 "$SRC_DIR/../windows-sandbox/los-probe-runner.cs" "$TARGET:$REMOTE_DIR/src/" || exit 1
  ENC_CMD="powershell -NoProfile -EncodedCommand"
  CMD="C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe /nologo /platform:anycpu /target:exe /out:$REMOTE_DIR\\los-probe-runner.exe $REMOTE_DIR\\src\\los-probe-runner.cs"
  PS="\$cmd = '$CMD'; Invoke-Expression \$cmd; 'compile exit=' + \$LASTEXITCODE"
  B64="$(printf '%s' "$PS" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
  run_remote "$ENC_CMD $B64" | grep -q "compile exit=0" || { echo "[deploy-probes] remote compile failed" >&2; exit 1; }
  # pins.json — single backslash path keys: the runner's minimal parser does
  # not unescape, and Path.GetFullPath() yields single-backslash paths.
  printf '{"%s\\los-probe-net.ps1": "%s"}\n' "$REMOTE_DIR" "$SHA" > /tmp/los-probes-deploy-pins.json
  scp -q -o ConnectTimeout=15 /tmp/los-probes-deploy-pins.json "$TARGET:$REMOTE_DIR/pins.json" || exit 1
  RAW="$(run_remote "certutil -hashfile $REMOTE_DIR\\los-probe-net.ps1 SHA256 2>&1")"
  ACTUAL="$(printf '%s' "$RAW" | grep -oE '[0-9a-fA-F]{64}' | head -1 | tr 'A-F' 'a-f')"
  if [[ "$ACTUAL" != "$SHA" ]]; then
    echo "[deploy-probes] FAIL: node hash drift (expected $SHA, got $ACTUAL)" >&2
    exit 1
  fi
  echo "[deploy-probes] node hash verified: $ACTUAL"
  OUT="$(run_remote "$REMOTE_DIR\\los-probe-runner.exe --script $REMOTE_DIR\\los-probe-net.ps1 --timeout-ms 30000 2>&1" | head -c 600)"
  echo "[deploy-probes] smoke: $OUT"
fi

echo "[deploy-probes] OK: $TARGET ready ($REMOTE_DIR)"
