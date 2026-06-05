# Run Contract Template

## Purpose

A run contract records the intended behavior before an agent run starts. It is
not execution evidence by itself. Execution evidence still belongs in
`run_specs`, `task_runs`, `session_events`, operation smokes, tests, and
explicit verifier records.

Use this template for larger `los` work until the fields are stable enough to
promote into CLI/UI affordances or stricter runtime schema.

## Template

```text
Mode:
Goal:
Editable surfaces:
Owner layer:
Workspace root:
Provider/model:
Tool mode:
Required checks:
Allowed skipped checks:
Stop and ask conditions:
Evidence to report:
Commit boundary:
External evidence allowed:
Raw evidence prohibited:
```

## Field Rules

| Field | Meaning | Example |
| --- | --- | --- |
| Mode | Operator intent for the run. | `audit`, `execution`, `closeout`, `governance` |
| Goal | The concrete outcome requested by the operator. | `wire execution gap plan into todo seeds` |
| Editable surfaces | Files or modules the agent may modify. | `docs/governance/*`, `packages/agent/src/todo-seeds-agent-workflow.ts` |
| Owner layer | Smallest layer that should own the change. | `project docs/todos`, `ADR`, `runtime schema`, `global skill` |
| Workspace root | Current project root used for commands and VCS. | `/Users/echerlos/projects/los-workspace/projects/los` |
| Provider/model | Configured route for the run when relevant. | `Codex GPT-5`, `Claude Code`, `Reasonix` |
| Tool mode | Tool authority expected for the run. | `read-only`, `project-write`, `all` |
| Required checks | Commands or smokes that must run before closeout. | `pnpm --filter @los/agent check`, `pnpm check` |
| Allowed skipped checks | Checks that may be skipped with a reason. | `pnpm test` skipped for docs-only change if source is untouched |
| Stop and ask conditions | Cases where autonomy should pause. | destructive VCS, auth secret handling, production mutation |
| Evidence to report | Truth surfaces that must be named in the result. | diff scope, command results, DB/API rows, runtime smoke |
| Commit boundary | The logical change that should become one commit. | `docs: wire agent execution gaps into todos` |
| External evidence allowed | Redacted summary sources that may inform the run. | toolchain matrix, operator-provided analysis |
| Raw evidence prohibited | Inputs that must not enter repo history. | auth snapshots, raw transcripts, session dumps |

## Mode Defaults

### Audit

Default behavior:

1. read source, docs, config, DB/API rows, or runtime surfaces first;
2. produce findings and evidence;
3. do not edit unless the operator switches mode;
4. turn unresolved drift into a todo, ADR, test, or doc recommendation.

Required evidence:

1. file paths, commands, row ids, endpoint responses, or named inference;
2. a clear boundary between current fact and future recommendation.

### Execution

Default behavior:

1. inspect the current owner layer;
2. make scoped edits;
3. update tests, docs, harnesses, or todos when durable behavior changes;
4. run the smallest check set that proves the change;
5. report remaining risks.

Required evidence:

1. diff scope;
2. verification commands;
3. explicit skipped checks when any expected check did not run.

### Closeout

Default behavior:

1. inspect `jj status`;
2. separate unrelated changes;
3. run required checks;
4. commit by logical theme;
5. verify remote state only if publishing was requested.

Required evidence:

1. clean or intentionally dirty worktree state;
2. commit id or change id;
3. validation result and residual risk.

## Runtime Promotion Notes

Current code already creates a basic `run_specs` row for `/chat`, including
prompt, provider, model, workspace root, tool mode, allowed tools, retry
policy, and MCP servers.

The template fields that still need runtime reconciliation are:

1. `mode`;
2. `goal`;
3. `required_checks`;
4. `allowed_skips`;
5. `stop_conditions`;
6. `evidence_required`;
7. `commit_boundary`;
8. `external_evidence_allowed`;
9. `raw_evidence_prohibited`.

Do not require all fields in `/chat` until focused gateway/agent tests and one
operation smoke prove the workflow.
