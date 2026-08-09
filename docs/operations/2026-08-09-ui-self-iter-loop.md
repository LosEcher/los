# UI Self-Iteration Loop Contract

Date: 2026-08-09  
Status: active operator procedure  
Related todos: parent `todo-d192cff0-9d49-49be-a2b0-75b91a8dbae1` (`source=operator-2026-08-09-ui-backlog`)

## Goal

Make UI backlog items **executable and closable** without pretending full autonomy.
The loop is oracle-driven: no machine-checkable acceptance → no autonomous `done`.

## Loop

```
1. todo (backlog) with acceptance oracle in description
2. operator or claimer promotes status → ready
3. dispatch with project-write + narrow editableSurfaces
4. agent implements + tests
5. oracle passes (API smoke and/or e2e assertion)
6. todo outcome write-back → done | blocked
7. operator visual spot-check for layout/UX
```

## Default runtime `[E]`

| Surface | Value |
|---|---|
| Agent | los built-in loop (`dispatchTodo` → `runScheduledAgentTask`) |
| Provider / model | `settings.agent` → **deepseek / deepseek-v4-flash** |
| Dispatch default toolMode | **read-only** (must override to `project-write` for UI fixes) |
| External CLI (Codex/Claude/Grok) | only via `run_runtime_task` when explicitly chosen |

Do **not** force-dispatch UI todos with default read-only mode.

## Eligibility gates (dispatch)

`POST /todos/:id/dispatch` requires:

1. `status === 'ready'` (or `force: true`, discouraged for UI)
2. `kind` in `task|batch`
3. all `dependsOnIds` are `done`

## Acceptance oracle types

| Class | Oracle | Who marks done |
|---|---|---|
| A — mechanical list/filter | API count/filter + e2e GET query assert | agent after CI green |
| B — layout/scroll | e2e viewport + operator hard refresh | agent + operator |
| C — data archive/retire | operator-confirmed scope + before/after counts | operator |
| D — product IA (form redesign) | written design acceptance + PR review | operator |

## Operator commands

```bash
# Inventory UI self-iter todos
curl -fsS -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  "http://127.0.0.1:8080/todos?limit=200&source=operator-2026-08-09-ui-backlog"

# Promote one todo to ready (after acceptance text is complete)
curl -fsS -X PATCH -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  "http://127.0.0.1:8080/todos/<id>" \
  -d '{"status":"ready"}'

# Dispatch UI fix (project-write, repo root)
bash tools/ui-self-iter-dispatch.sh <todo-id>

# Schedules active-only oracle
curl -fsS -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  "http://127.0.0.1:8080/scheduled-work-items?limit=100&excludeRetired=true" \
  | jq '[.results[].status] | unique'
# must not include "retired"
```

## Closed-loop checklist (per item)

- [ ] Todo has explicit oracle (command or e2e name)
- [ ] `editableSurfaces` / toolMode recorded in todo metadata
- [ ] status `ready` before dispatch
- [ ] CI / focused test green
- [ ] Oracle command re-run after deploy/restart
- [ ] Todo terminal status matches task outcome (AP12)

## Explicit non-goals

- Auto-claiming all backlog UI todos on a timer without oracles
- Letting flash models redesign IA without operator design input
- Batch archive of production todos without operator scope confirmation
