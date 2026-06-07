# Run Chain Change Fragments

Use this directory when a change affects the `los` run chain and the behavior
impact should stay reviewable without rewriting a central long document.

## Scope

Add one fragment when a change touches any of these surfaces:

1. `/chat` request, response, streaming, resume, replay, or idempotency.
2. scheduler dispatch, retry, recovery, or completion decisions.
3. executor-node task execution, NDJSON chunks, artifacts, or node commands.
4. `run_specs`, `task_runs`, `session_events`, `tool_call_states`, or
   `verification_records`.
5. provider compatibility runs, promotion evidence, or required/advisory gate
   policy.
6. Web or CLI surfaces that change how operators inspect a run, session,
   provider gate, node command, or verification result.

Do not add fragments for unrelated docs, copy-only UI text, or refactors that
provably do not change run behavior. If a refactor changes one of the surfaces
above, add a fragment and explicitly state the behavior is intended to remain
unchanged.

## Fragment Shape

Use one file per bounded change:

```md
---
date: YYYY-MM-DD
change: short-change-or-bookmark-name
commit: optional-short-sha
surface: chat | scheduler | executor | provider | verification | web | cli | docs
impact: one sentence describing behavior impact
---

## Evidence

- Source:
- Validation:
- Remaining risk:

## Notes

Optional details.
```

Before the commit hash is known, use `commit: pending`. Update the same
fragment after the change is pushed or merged.

## Validation

For a docs-only fragment change, run:

```bash
./tools/check-contracts.sh
```

For runtime changes, use ADR 0014 and the touched package tests. A fragment is
evidence of the intended behavior change; it does not replace tests, operation
smokes, `task_runs`, `session_events`, or compatibility evidence.

## Promotion

This directory is advisory for now. Promote it to a harness check only after
the same missing-fragment problem repeats or after run-chain source file
ownership stabilizes enough for a mechanical rule.
