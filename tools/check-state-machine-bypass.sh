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
# - scheduled-task-runner.ts / scheduled-task-terminal.ts: scheduler helpers
#   calling updateTaskRunFields for metadata updates (not status transitions)
# - planning-disposition.ts: planning completion transitions through the
#   execution store, then records result metadata without changing status
# - verification-runner.ts: verification completion transitions first, then
#   records task metadata after a successful verification decision
ALLOWED_FILES=(
  "packages/agent/src/execution-store.ts"
  "packages/agent/src/execution-transitions.ts"
  "packages/agent/src/task-runs.ts"
  "packages/agent/src/run-specs.ts"
  "packages/agent/src/tool-call-states.ts"
  "packages/agent/src/tool-call-recovery.ts"
  "packages/agent/src/scheduler/tool-call-state-persistence.ts"
  "packages/agent/src/scheduler/scheduled-task-runner.ts"
  "packages/agent/src/scheduler/scheduled-task-terminal.ts"
  "packages/agent/src/scheduler/goal-self-check-runner.ts"
  "packages/agent/src/scheduler/planning-disposition.ts"
  "packages/agent/src/verification-runner.ts"
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

# The scheduled-work ledger keeps its OWN transition table (`LEGAL_TRANSITIONS` in
# scheduled-work/store.ts: queued/running/no_op/skipped/awaiting_approval have no
# equivalent in the execution state machine). Sharing `transitionExecutionState`
# between them would silently be a third state machine, not a cleanup — so the two
# must not be merged by accident (control-plane truth remediation §8).
#
# The negative control for this rule is the rule itself: `--self-test` writes a
# temporary file that imports the symbol and asserts the scan reports it.
FUSION_TARGET="packages/agent/src/scheduled-work/store.ts"
if grep -qE "transitionExecutionState" "$ROOT/$FUSION_TARGET" 2>/dev/null; then
  echo "[FUSION] $FUSION_TARGET references transitionExecutionState — the scheduled-work"
  echo "         transition table stays separate on purpose (see §8 of the truth remediation doc)"
  FAILURES=$((FAILURES + 1))
fi

if [ "${1:-}" = "--self-test" ]; then
  # Negative control for the fusion rule: append a violating import to the real
  # target, confirm the *same* scan the gate runs reports it, then restore. A gate
  # whose self-test runs a different check than the gate itself proves nothing.
  FUSION_FILE="$ROOT/$FUSION_TARGET"
  cp "$FUSION_FILE" "$FUSION_FILE.selftest-backup"
  printf "\nimport { transitionExecutionState as _selftestImport } from '../execution-store.js';\n" >> "$FUSION_FILE"
  if grep -qE "transitionExecutionState" "$FUSION_FILE"; then
    echo "  ok   self-test: the fusion scan reports a violating import in $FUSION_TARGET"
  else
    echo "  FAIL self-test: the fusion scan did not report its own injected violation"
    FAILURES=$((FAILURES + 1))
  fi
  mv "$FUSION_FILE.selftest-backup" "$FUSION_FILE"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "$FAILURES state-machine bypass violation(s) found"
  echo "Use transitionExecutionState() for all status transitions (see AP1 in docs/governance/anti-patterns.md)"
  exit 1
fi

echo "state-machine bypass gate: clean"
