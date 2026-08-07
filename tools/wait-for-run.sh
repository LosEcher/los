#!/bin/bash
# wait-for-run.sh — wait for a scheduled-work run / task_run to reach a
# terminal state, measuring phase durations from authoritative DB timestamps.
#
# Why: the naive `sleep N` pattern wastes time (completes early or hangs late)
# and cannot report where time went. This polls the DB every few seconds and
# prints started_at/completed_at phase durations from task_runs.
#
# Usage:
#   tools/wait-for-run.sh <runId|taskRunId> [--interval 3] [--timeout 300]
# Examples:
#   tools/wait-for-run.sh schedule-run-xxxx        # wait a scheduled-work run
#   tools/wait-for-run.sh task-xxxx                # wait a task_run by id
#   RUNID=$(psql ... -t -c "SELECT id FROM scheduled_work_item_runs ORDER BY created_at DESC LIMIT 1")
#   tools/wait-for-run.sh "$RUNID"
set -u

PG="postgres://los:los@127.0.0.1:55432/los"
ID="${1:-}"
INTERVAL="${2:-3}"
TIMEOUT="${3:-300}"
if [ -z "$ID" ]; then
  echo "usage: $0 <runId|taskRunId> [interval_sec] [timeout_sec]" >&2
  exit 2
fi

start_ts="$(date +%s)"
terminal=''

fetch_status() {
  # scheduled_work_item_runs first, task_runs fallback
  local row
  row="$(psql "$PG" -t -A -F'|' -c \
    "SELECT status FROM scheduled_work_item_runs WHERE id='$ID' UNION ALL SELECT status FROM task_runs WHERE id='$ID' LIMIT 1;" 2>/dev/null)"
  echo "$row"
}

while true; do
  status="$(fetch_status)"
  elapsed="$(( $(date +%s) - start_ts ))"
  if [ -n "$status" ]; then
    echo "[${elapsed}s] $ID: $status"
    case "$status" in
      succeeded|no_op|skipped|failed|cancelled|blocked) terminal="$status"; break ;;
    esac
  else
    echo "[${elapsed}s] $ID: (not found yet)"
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "timeout after ${TIMEOUT}s" >&2
    exit 3
  fi
  sleep "$INTERVAL"
done

# Phase duration report from the authoritative task_runs columns.
psql "$PG" -t -A -F' | ' -c \
  "SELECT 'created=' || to_char(created_at,'HH24:MI:SS')
        || ' started=' || to_char(started_at,'HH24:MI:SS')
        || ' completed=' || to_char(completed_at,'HH24:MI:SS')
        || ' run_secs=' || round(extract(epoch from (completed_at - started_at))::numeric,1)
   FROM task_runs WHERE id='$ID'
   UNION ALL
   SELECT 'created=' || to_char(created_at,'HH24:MI:SS') || ' completed=' || to_char(coalesce(completed_at, updated_at),'HH24:MI:SS')
   FROM scheduled_work_item_runs WHERE id='$ID';" 2>/dev/null | head -2

exit 0
