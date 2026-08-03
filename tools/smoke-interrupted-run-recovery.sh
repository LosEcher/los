#!/usr/bin/env bash
# smoke-interrupted-run-recovery.sh — G1 interrupted-run recovery drill.
#
# Proves "kill gateway → restart → resume the same run" against the local
# gateway + executor + PostgreSQL stack, then prints evidence for
# docs/operations/.
#
# Scenarios:
#   auto        dispatch-window kill: run is plan_approved with NO task attempt;
#               gateway restart must auto-resume it (recoverApprovedRunDispatches)
#               and the run must finish succeeded.
#   in-flight   mid-execution kill: task is running on the executor; gateway
#               dies; execution completes independently, the run lands blocked
#               (verification); operator resumes via revise-plan + approve
#               (new revision) + verify → succeeded.
#
# Usage:
#   ./tools/smoke-interrupted-run-recovery.sh --scenario auto
#   ./tools/smoke-interrupted-run-recovery.sh --scenario in-flight
#
# Requires: running los gateway + executor (pnpm run status), .env with
# LOS_OPERATOR_TOKEN, and a configured provider (default deepseek).
# This script KILLS the local gateway process (kill -9). launchctl may
# auto-restart it; the script waits for health either way.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Args ──────────────────────────────────────────────────
SCENARIO="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO="${2:-auto}"; shift 2 ;;
    -h|--help) echo "usage: $0 --scenario auto|in-flight"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ "${SCENARIO}" = "auto" ] || [ "${SCENARIO}" = "in-flight" ] || {
  echo "usage: $0 --scenario auto|in-flight" >&2
  exit 2
}

# ── Env ───────────────────────────────────────────────────
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

TSX="$ROOT/packages/gateway/node_modules/.bin/tsx"
GW_URL="http://127.0.0.1:8080"
AUTH=(-H "x-los-operator-token: ${LOS_OPERATOR_TOKEN:-}")
SUFFIX="$(date +%s)${SCENARIO:0:1}"

say() { printf '\n==> %s\n' "$*"; }

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "$GW_URL/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "gateway did not become healthy" >&2
  return 1
}

run_state() { # runId -> phase
  curl -fsS "${AUTH[@]}" "$GW_URL/runs/$1/state" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('phase') or '')" 2>/dev/null || true
}

run_active_tasks() { # runId -> count
  curl -fsS "${AUTH[@]}" "$GW_URL/runs/$1/state" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('ids',{}).get('activeTaskRunIds',[])))" 2>/dev/null || true
}

kill_gateway() {
  local pid
  pid="$(cat "$ROOT/.los-runtime/gateway.pid" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "no running gateway pid found — refusing to proceed" >&2
    exit 1
  fi
  echo "kill -9 gateway pid=$pid at $(date +%H:%M:%S)"
  kill -9 "$pid"
  sleep 1
}

restart_gateway() {
  say "restarting gateway"
  bash "$ROOT/tools/los.sh" start >/dev/null 2>&1 || true   # launchctl may have restarted it already
  wait_healthy
  echo "gateway healthy at $GW_URL (pid=$(cat "$ROOT/.los-runtime/gateway.pid" 2>/dev/null || echo unknown))"
}

extract_json() { awk '/^\{/{found=1} found{print}'; }

# ── Scenario: auto ────────────────────────────────────────
run_auto() {
  say "injecting plan_approved run (no task attempt — dispatch-window crash state)"
  local inject
  inject="$("$TSX" tools/smoke-interrupted-run-inject.ts --phase plan_approved --suffix "$SUFFIX" 2>/dev/null | extract_json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['runId'])")"
  echo "runId=$inject"

  kill_gateway
  restart_gateway

  say "checking startup recovery log"
  grep -E "resumed .*approved run dispatch" "$ROOT/.los-runtime/gateway.log" \
    || { echo "no resume log line — recovery did not fire" >&2; exit 1; }

  say "waiting for auto-resumed run to finish"
  local phase=""
  for _ in $(seq 1 60); do
    phase="$(run_state "$inject")"
    echo "  phase=$phase"
    case "$phase" in
      succeeded) break ;;
      blocked) break ;;   # verification pending — closed by POST /runs/:id/verify below
      failed|cancelled) echo "run ended $phase — unexpected" >&2; exit 1 ;;
    esac
    sleep 3
  done
  if [ "$phase" = "blocked" ]; then
    say "POST /runs/:id/verify (runs required checks → succeeded)"
    curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" -d '{}' \
      "$GW_URL/runs/$inject/verify" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print('decision:', d.get('decision',{}).get('status'))"
    phase="$(run_state "$inject")"
    echo "  final phase=$phase"
  fi
  [ "$phase" = "succeeded" ] || { echo "run did not succeed (phase=$phase)" >&2; exit 1; }

  cat <<EOF

[E] SCENARIO auto: gateway killed (kill -9) while run was plan_approved with
    no task attempt; after restart the gateway log printed
    "$(grep -Eo 'Gateway startup resumed [0-9]+ approved run dispatch\(es\)' "$ROOT/.los-runtime/gateway.log" | head -1)" and the
    same run finished phase=succeeded.
    runId=$inject
EOF
}

# ── Scenario: in-flight ───────────────────────────────────
run_in_flight() {
  say "injecting planning run with an execution window (sleep 10)"
  local inject
  inject="$("$TSX" tools/smoke-interrupted-run-inject.ts --phase planning --suffix "$SUFFIX" \
    --prompt "Use the bash tool to run: sleep 10. Then reply exactly: los interrupted-run recovery smoke ok" 2>/dev/null \
    | extract_json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['runId'])")"
  echo "runId=$inject"

  say "approving (plan_approved → dispatch)"
  curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"reason":"g1 interrupted-run recovery smoke"}' \
    "$GW_URL/runs/$inject/approve" | python3 -c "import json,sys; d=json.load(sys.stdin); print('phase:', d.get('phase'), 'dispatch:', d.get('dispatch'))"

  say "waiting for task to go running (in-flight window)"
  local active=0
  for _ in $(seq 1 20); do
    active="$(run_active_tasks "$inject")"
    echo "  activeTasks=$active phase=$(run_state "$inject")"
    [ "$active" -ge 1 ] && break
    sleep 1
  done
  [ "$active" -ge 1 ] || { echo "task never reached running" >&2; exit 1; }

  kill_gateway
  say "waiting 40s so the task lease (30s) expires before restart"
  sleep 40
  restart_gateway

  say "run state after restart (expect blocked — verification pending)"
  local phase=""
  for _ in $(seq 1 20); do
    phase="$(run_state "$inject")"
    echo "  phase=$phase"
    [ "$phase" = "blocked" ] && break
    sleep 3
  done
  [ "$phase" = "blocked" ] || { echo "run not blocked after restart (phase=$phase)" >&2; exit 1; }

  say "POST /runs/:id/recover decision"
  curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"intent":"recover"}' "$GW_URL/runs/$inject/recover" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('recommendation:', d.get('recommendation'), 'status:', d.get('status'))"

  say "resuming: revise-plan (revision 2) → approve → dispatch"
  local plan='[{"id":"step-1","title":"Reply with the smoke marker","description":"Reply exactly with the text: los interrupted-run recovery smoke ok","dependsOnIds":[],"editableSurfaces":["docs/"],"completionCriteria":"Reply text equals \"los interrupted-run recovery smoke ok\""}]'
  curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d "{\"plan\":$plan,\"reason\":\"g1 resume after interruption\",\"actor\":\"operator:smoke\"}" \
    "$GW_URL/runs/$inject/revise-plan" >/dev/null
  curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"reason":"g1 resume after interruption"}' \
    "$GW_URL/runs/$inject/approve" >/dev/null

  say "waiting for resumed run to reach verification (blocked)"
  phase=""
  for _ in $(seq 1 60); do
    phase="$(run_state "$inject")"
    echo "  phase=$phase"
    case "$phase" in
      blocked) break ;;
      failed|cancelled) echo "run ended $phase — unexpected" >&2; exit 1 ;;
    esac
    sleep 3
  done
  [ "$phase" = "blocked" ] || { echo "resumed run did not reach verification (phase=$phase)" >&2; exit 1; }

  say "POST /runs/:id/verify (runs required checks → succeeded)"
  curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" -d '{}' \
    "$GW_URL/runs/$inject/verify" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('decision:', d.get('decision',{}).get('status'))"

  phase="$(run_state "$inject")"
  echo "final phase=$phase"
  [ "$phase" = "succeeded" ] || { echo "run did not succeed after verify" >&2; exit 1; }

  cat <<EOF

[E] SCENARIO in-flight: gateway killed while task was running on the executor;
    execution completed independently and the run landed blocked (verification
    pending). recover decision recorded, then revise-plan → approve (revision
    2) → dispatch → verify resumed the SAME run to phase=succeeded.
    runId=$inject
EOF
}

if [ "$SCENARIO" = "auto" ]; then
  run_auto
else
  run_in_flight
fi

echo
echo "done. Evidence lines above are safe to copy into docs/operations/."
