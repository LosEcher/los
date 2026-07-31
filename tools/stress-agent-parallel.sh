#!/usr/bin/env bash
# Stress @los/agent the way Forgejo CI does: 3 LOS_TEST_GROUP processes in
# parallel, repeated for N rounds. Fails on the first non-zero group exit.
#
# Usage:
#   bash tools/stress-agent-parallel.sh              # 5 rounds (default)
#   bash tools/stress-agent-parallel.sh 3            # 3 rounds
#   ROUNDS=10 bash tools/stress-agent-parallel.sh
#
# Requires a reachable TEST_DATABASE_URL / DATABASE_URL (postgres).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ROUNDS="${1:-${ROUNDS:-5}}"
DB_URL="${TEST_DATABASE_URL:-${DATABASE_URL:-postgres://los:los@127.0.0.1:55432/los_test}}"

export NODE_ENV=test
export DATABASE_URL="$DB_URL"
export TEST_DATABASE_URL="$DB_URL"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }

info "stress-agent-parallel: rounds=${ROUNDS} db=${DB_URL%%@*}@…"

# Quick connectivity probe via psql when available
if command -v psql >/dev/null 2>&1; then
  if ! psql "$DB_URL" -c 'select 1' >/dev/null 2>&1; then
    red "cannot connect to $DB_URL"
    exit 2
  fi
fi

run_round() {
  local round="$1"
  local run_id="stress-r${round}-$$-$(date +%s)"
  local logdir
  logdir="$(mktemp -d "${TMPDIR:-/tmp}/los-agent-stress.XXXXXX")"
  info "=== round ${round}/${ROUNDS} run_id=${run_id} logs=${logdir} ==="

  local pids=()
  local g
  for g in 1 2 3; do
    (
      export LOS_TEST_GROUP="$g"
      # Distinct base id per group so schema names never collide even if
      # Date.now() aligns across the three forks.
      export LOS_TEST_RUN_ID="${run_id}-g${g}"
      pnpm --filter @los/agent test >"${logdir}/group-${g}.log" 2>&1
    ) &
    pids+=("$!")
  done

  local status=0
  local i=0
  for pid in "${pids[@]}"; do
    i=$((i + 1))
    if wait "$pid"; then
      info "  group ${i} OK (pid ${pid})"
    else
      local ec=$?
      red "  group ${i} FAILED exit=${ec} (pid ${pid}) — tail ${logdir}/group-${i}.log"
      tail -40 "${logdir}/group-${i}.log" >&2 || true
      status=1
    fi
  done

  if [[ "$status" -ne 0 ]]; then
    red "round ${round} FAILED — logs kept at ${logdir}"
    return 1
  fi
  green "round ${round} PASSED"
  rm -rf "$logdir"
  return 0
}

FAILED=0
for r in $(seq 1 "$ROUNDS"); do
  if ! run_round "$r"; then
    FAILED=1
    break
  fi
done

if [[ "$FAILED" -eq 0 ]]; then
  green "stress-agent-parallel: ${ROUNDS}/${ROUNDS} rounds passed"
  exit 0
fi
red "stress-agent-parallel: failed before completing ${ROUNDS} rounds"
exit 1
