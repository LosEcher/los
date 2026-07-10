#!/usr/bin/env bash
# smoke-im-run-approval.sh — los self-bootstrap smoke for:
#   create tiny todo → dispatch → (optional) inject attention → print IM commands
#
# Prerequisites:
#   - gateway :8080 healthy
#   - weclaw  :18011 healthy + logged in
#   - wechat-bot running with:
#       WECLAW_DEFAULT_TO=<user@im.wechat>
#       LOS_GATEWAY_URL=http://127.0.0.1:8080
#       LOS_AUTH_TOKEN / LOS_OPERATOR_TOKEN as required
#
# Usage:
#   ./tools/smoke-im-run-approval.sh              # create smoke todo + print next steps
#   ./tools/smoke-im-run-approval.sh --dispatch    # also POST /todos/:id/dispatch (read-only)
#   ./tools/smoke-im-run-approval.sh --inject      # create run_spec + attention event for WeChat push

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then set -a; # shellcheck disable=SC1091
  source .env; set +a; fi

GATEWAY="${LOS_GATEWAY_URL:-http://127.0.0.1:8080}"
AUTH_TOKEN="${LOS_AUTH_TOKEN:-}"
OP_TOKEN="${LOS_OPERATOR_TOKEN:-}"
WORKSPACE="${SMOKE_WORKSPACE:-$ROOT}"

auth_headers=(-H "Content-Type: application/json" -H "x-tenant-id: local" -H "x-user-id: local" -H "x-project-id: los")
if [ -n "$AUTH_TOKEN" ]; then auth_headers+=(-H "x-los-auth-token: $AUTH_TOKEN"); fi
if [ -n "$OP_TOKEN" ]; then auth_headers+=(-H "x-los-operator-token: $OP_TOKEN"); fi

DO_DISPATCH=0
DO_INJECT=0
for arg in "$@"; do
  case "$arg" in
    --dispatch) DO_DISPATCH=1 ;;
    --inject) DO_INJECT=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

echo "== health =="
curl -sf -m 3 "$GATEWAY/health" >/dev/null && echo "gateway: ok" || { echo "gateway: FAIL"; exit 1; }
curl -sf -m 3 "http://127.0.0.1:18011/health" >/dev/null && echo "weclaw: ok" || echo "weclaw: WARN (not reachable)"
if [ -z "${WECLAW_DEFAULT_TO:-}" ]; then
  echo "WECLAW_DEFAULT_TO: MISSING — outbound WeChat alerts will not send"
else
  echo "WECLAW_DEFAULT_TO: set"
fi

TS="$(date +%Y%m%d-%H%M%S)"
TODO_ID="todo-smoke-im-approval-$TS"
TITLE="SMOKE: IM run approval ($TS)"
DESC=$(cat <<EOF
[smoke] Self-bootstrap IM approval loop for los.

Goal: prove dispatch → operator attention → WeChat notify → #approve-phase.

Constraints (keep tiny):
- Prefer docs-only or no code change.
- workspace: $WORKSPACE
- Do NOT modify production credentials.
- On completion, leave a short note in the run evidence.

Acceptance:
1. task_run + run_spec exist for this todo
2. WeChat received an operator alert (or inject path used)
3. Operator can #approve-phase <runId> or Web Approve plan
EOF
)

echo
echo "== create todo $TODO_ID =="
CREATE_BODY=$(python3 - <<PY
import json
print(json.dumps({
  "id": "$TODO_ID",
  "title": "$TITLE",
  "description": """$DESC""",
  "status": "ready",
  "kind": "task",
  "priority": "P2",
  "source": "smoke-im-run-approval",
  "projectId": "los",
  "tenantId": "local",
  "metadata": {
    "workspaceRoot": "$WORKSPACE",
    "smoke": True,
    "purpose": "im-run-approval",
  },
}, ensure_ascii=False))
PY
)

# API may ignore custom id — handle either way
RESP=$(curl -sS -m 10 -X POST "${auth_headers[@]}" \
  -d "$CREATE_BODY" "$GATEWAY/todos" || true)
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('todo', d.get('id'), d.get('status'), d.get('title','')[:60])" 2>/dev/null \
  || echo "create response: $RESP"

ACTUAL_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
if [ -z "$ACTUAL_ID" ]; then
  # retry without fixed id field if schema rejects it
  CREATE_BODY2=$(python3 - <<PY
import json
print(json.dumps({
  "title": "$TITLE",
  "description": """$DESC""",
  "status": "ready",
  "kind": "task",
  "priority": "P2",
  "source": "smoke-im-run-approval",
  "projectId": "los",
  "tenantId": "local",
}, ensure_ascii=False))
PY
)
  RESP=$(curl -sS -m 10 -X POST "${auth_headers[@]}" -d "$CREATE_BODY2" "$GATEWAY/todos")
  ACTUAL_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
  echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('todo', d.get('id'), d.get('status'))"
fi
echo "SMOKE_TODO_ID=$ACTUAL_ID"

if [ "$DO_DISPATCH" = "1" ] && [ -n "$ACTUAL_ID" ]; then
  echo
  echo "== dispatch (toolMode=read-only) =="
  DRESP=$(curl -sS -m 30 -X POST "${auth_headers[@]}" \
    -d '{"toolMode":"read-only"}' \
    "$GATEWAY/todos/$ACTUAL_ID/dispatch")
  echo "$DRESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
tr=d.get('taskRun') or {}
print('scheduler', d.get('schedulerStatus'))
print('taskRunId', (tr.get('id') or '')[:40])
print('sessionId', (tr.get('sessionId') or d.get('todo',{}).get('sessionId') or '')[:40])
print('runSpecId', (tr.get('runSpecId') or '')[:40])
" 2>/dev/null || echo "$DRESP"
fi

if [ "$DO_INJECT" = "1" ]; then
  echo
  echo "== inject planning run_spec + operator attention event =="
  pnpm --filter @los/agent exec tsx ../../tools/smoke-im-inject-attention.ts
fi

echo
echo "== next steps =="
cat <<EOF
1) Ensure wechat-bot is running, e.g.:
   export LOS_GATEWAY_URL=http://127.0.0.1:8080
   export WECLAW_DEFAULT_TO='<from ~/.weclaw accounts ilink_user_id>'
   export LOS_AUTH_TOKEN=...
   export LOS_OPERATOR_TOKEN=...
   pnpm --filter @los/wechat-bot dev

2) If you used --inject, WeChat should receive an alert with:
     #approve-phase run-smoke-im-...
     #verify-run run-smoke-im-...

3) Approve via WeChat:
     #approve-phase <runId> smoke ok

4) Or Web → Run Specs → select run → Approve plan / Verify

5) Mark smoke todo done when finished:
     PATCH /todos/\$SMOKE_TODO_ID  { "status": "done" }
EOF
