#!/usr/bin/env bash
# Dispatch one UI self-iter todo with project-write and print oracle hints.
# Usage:
#   bash tools/ui-self-iter-dispatch.sh <todo-id> [--force]
# Requires: LOS_AUTH_TOKEN, LOS_OPERATOR_TOKEN, gateway on :8080
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TODO_ID="${1:-}"
FORCE=false
if [[ "${2:-}" == "--force" ]]; then FORCE=true; fi
if [[ -z "$TODO_ID" ]]; then
  echo "usage: $0 <todo-id> [--force]" >&2
  exit 2
fi

if [[ -z "${LOS_AUTH_TOKEN:-}" || -z "${LOS_OPERATOR_TOKEN:-}" ]]; then
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true
fi
if [[ -z "${LOS_AUTH_TOKEN:-}" || -z "${LOS_OPERATOR_TOKEN:-}" ]]; then
  echo "LOS_AUTH_TOKEN and LOS_OPERATOR_TOKEN required" >&2
  exit 2
fi

AUTH=(-H "Authorization: Bearer ${LOS_AUTH_TOKEN}" -H "x-los-operator-token: ${LOS_OPERATOR_TOKEN}")
GW="${LOS_GATEWAY_URL:-http://127.0.0.1:8080}"

echo "==> load todo $TODO_ID"
TODO_JSON="$(curl -fsS "${AUTH[@]}" "$GW/todos/$TODO_ID")"
echo "$TODO_JSON" | jq '{id, title, status, kind, priority, parentId, source, description: (.description|.[0:200])}'

STATUS="$(echo "$TODO_JSON" | jq -r .status)"
KIND="$(echo "$TODO_JSON" | jq -r .kind)"
if [[ "$KIND" != "task" && "$KIND" != "batch" ]]; then
  echo "refusing: kind=$KIND (need task|batch)" >&2
  exit 1
fi
if [[ "$STATUS" != "ready" && "$FORCE" != "true" ]]; then
  echo "refusing: status=$STATUS (need ready). Promote first or pass --force" >&2
  exit 1
fi

echo "==> dispatch project-write at $ROOT"
BODY="$(jq -n --arg root "$ROOT" --argjson force "$FORCE" \
  '{toolMode:"project-write", workspaceRoot:$root, force:$force}')"
RESULT="$(curl -fsS -X POST "${AUTH[@]}" -H "content-type: application/json" \
  "$GW/todos/$TODO_ID/dispatch" -d "$BODY")"
echo "$RESULT" | jq '{todo:(.todo|{id,status,title}), schedulerStatus, taskRunId:(.taskRun.id//.taskRun.taskRunId//null)}'

echo
echo "==> after agent finishes, re-check todo status and run oracles from"
echo "    docs/operations/2026-08-09-ui-self-iter-loop.md"
echo "==> schedules active-only oracle example:"
echo "    curl -fsS -H \"Authorization: Bearer \$LOS_AUTH_TOKEN\" \\"
echo "      $GW/scheduled-work-items?limit=100\\&excludeRetired=true | jq '[.results[].status]|unique'"
