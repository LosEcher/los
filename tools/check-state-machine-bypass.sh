#!/bin/bash
# check-state-machine-bypass.sh — enforce transitionExecutionState as sole state-change path
# Usage: ./tools/check-state-machine-bypass.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILURES=0

# Low-level state mutation APIs that must only be called by
# transitionExecutionState or the documented exception paths.
BYPASS_APIS=(
  "updateTaskRun"
  "updateTaskRunFields"
  "updateRunSpecStatus"
  "updateToolCallState"
)

# Files allowed to import these APIs directly:
# - tool-call-recovery.ts: documented exception for recovery paths
# - execution-store.ts / execution-transitions.ts: the transitionEntryPoint itself
# - task-runs.ts: owns updateTaskRun/updateTaskRunFields
# - run-specs.ts: owns updateRunSpecStatus
# - tool-call-states.ts: owns updateToolCallState
# - tool-call-state-persistence.ts: scheduler helper that mirrors tool_call_states
# - scheduled-task-runner.ts: scheduler helper calling updateTaskRunFields for
#   metadata updates (not status transitions)
ALLOWED_FILES=(
  "packages/agent/src/execution-store.ts"
  "packages/agent/src/execution-transitions.ts"
  "packages/agent/src/task-runs.ts"
  "packages/agent/src/run-specs.ts"
  "packages/agent/src/tool-call-states.ts"
  "packages/agent/src/tool-call-recovery.ts"
  "packages/agent/src/scheduler/tool-call-state-persistence.ts"
  "packages/agent/src/scheduler/scheduled-task-runner.ts"
)

for api in "${BYPASS_APIS[@]}"; do
  while IFS= read -r -d '' file; do
    rel="${file#$ROOT/}"
    allowed=0
    for af in "${ALLOWED_FILES[@]}"; do
      [[ "$rel" == "$af" ]] && allowed=1 && break
    done
    if [ "$allowed" -eq 0 ]; then
      echo "[BYPASS] $rel imports $api — must use transitionExecutionState() instead"
      FAILURES=$((FAILURES + 1))
    fi
  done < <(grep -rl "import.*$api\|from.*$api" "$ROOT/packages/agent/src/" --include='*.ts' 2>/dev/null | grep -v '/dist/' | grep -v '.test.ts' | tr '\n' '\0' || true)
done

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "$FAILURES state-machine bypass violation(s) found"
  echo "Use transitionExecutionState() for all status transitions (see AP1 in AGENTS.md)"
  exit 1
fi

echo "state-machine bypass gate: clean"
