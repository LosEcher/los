---
name: los-project-operations
description: Use for repeated los-specific workflows that require current runtime evidence, ADR/source reconciliation, provider compatibility gates, gateway/executor lifecycle checks, or jj-aware closeout in /Users/echerlos/projects/los-workspace/projects/los.
---

# los Project Operations

Use this skill only inside the active `projects/los` repo. Keep global toolchain
rules, generic coding habits, and legacy project facts out of this file.

## Before Acting

1. Read `AGENTS.md` — including the Unconditional Pre-Action Gate and self-check.
2. For workspace-boundary questions, read `../../AGENTS.md` and `../../WORKSPACE.md`.
3. If `.jj/` exists, use `jj status` for local version-control truth.
4. Identify the affected surface before editing:
   - `contracts/` for API or package boundary changes
   - `docs/adr/` for design intent
   - implementation source for runtime behavior
   - persisted DB/API/session evidence for execution truth

### Complexity-Aware Task Dispatch

Before starting a task, gauge scope. Choose the workflow that matches — do not
over-instrument a one-line fix or under-instrument a cross-package refactor.

| Scope | Mode | Required Gates |
|-------|------|----------------|
| 1 file, <20 lines, no API change | Direct edit | `loadSpecsForFiles` + `pnpm check` |
| 2-3 files, same package | Bounded change | Above + read matching ADR + check after each file |
| 4+ files or crossing package boundaries | Plan mode | Above + `contracts/` review + full `pnpm gate` |
| >400 lines net new | Extract sub-module | Above + stay under 500-line warn threshold |
| New package or route module | ADR + plan | All above + operator approval + test harness |
| Provider, scheduler, or execution state change | ADR review + harness gate | All above + compat probe + golden trace update |

For investigations (read-only, no file changes), audit mode is the default:
read-first, lead with evidence, do not patch unless the operator switches mode.

## Workflow: Runtime Truth

Trigger when investigating gateway, executor, node registry, mesh readiness,
local process state, stale `online` rows, or "is los really running" questions.

Steps:

1. Check local process and health surfaces:
   - `pnpm run status`
   - `pnpm run executor:status`
   - `curl -fsS http://127.0.0.1:8080/health`
2. Check persisted truth separately from process truth:
   - `service_instances`
   - `executor_nodes`
   - relevant API responses such as `/nodes` and `/services`
3. Do not treat SOCKS/proxy reachability as gateway or executor health.
4. If stop/start behavior is involved, verify the stop path writes offline state
   before claiming registry truth is synchronized.

Evidence to report:

- command names used
- process/health result
- DB row or API row status
- whether heartbeat freshness, `candidate=true`, and `capabilities.run_agent`
  agree with the claim

**Evidence confidence markers** — append one to every claim:

- `[E]` = verified by exact command output, API response, or DB row value.
  Reproducible by running the same command.
- `[I]` = inferred from partial or indirect evidence. Name the missing surface.
  Example: `[I] gateway healthy inferred from /health 200; process RSS not checked`.
- `[U]` = unverified. Treat as hypothesis, not fact. Must be upgraded to `[E]`
  or `[I]` before a closeout or publish decision.

Stop when process truth, DB/API truth, and the user-facing claim agree, or when
the remaining mismatch is named with a confidence marker as residual risk.

## Workflow: ADR And Source Reconciliation

Trigger when reviewing recent changes, unfinished docs, ADR drift, contracts,
test coverage claims, or next work items.

Steps:

1. Read the relevant ADR and current implementation before judging status.
2. Treat implementation as current runtime behavior and ADR as design intent
   until verified.
3. For API or package boundary changes, read `contracts/` before source.
4. Use `./tools/check-contracts.sh` as the first workspace contract gate.
5. Verify broad test claims from source, excluding `node_modules/` and `dist/`.

Evidence to report:

- ADR path and implementation path
- contract files read, if any
- exact check command used
- current `jj status` when discussing closeout or publish readiness

Stop when docs, contracts, source, and checks either agree or the remaining
drift is turned into a concrete next work item.

## Workflow: Provider Compatibility And Harness Gates

Trigger when changing provider profiles, compatibility probes, CLI fallback,
tool policy, scheduler behavior, todo dispatch, node classification, session
replay, or advisory-provider promotion.

Steps:

1. Read the matching ADR first:
   - provider loop: `docs/adr/0007-provider-loop-first-model-profiles.md`
   - service/node readiness: `docs/adr/0010-node-connectivity-capability-taxonomy.md`
   - cluster roadmap: `docs/adr/0012-service-cluster-and-stateful-agent-roadmap.md`
   - testing gates: `docs/adr/0014-testing-strategy-and-regression-gates.md`
   - provider promotion: `docs/adr/0017-advisory-provider-promotion-playbook.md`
   - CLI fallback: `docs/adr/0018-cli-fallback-gate.md`
2. Update or add the focused harness, compatibility probe, or regression test
   when durable agent behavior changes.
3. Prefer targeted package checks first, then root checks when the blast radius
   crosses package boundaries.

Evidence to report:

- ADRs consulted
- focused harness/probe/test touched or intentionally left unchanged
- package-level checks and root checks run
- explicit residual risk when a live provider or quota surface was not verified

Stop when the changed behavior is covered by a harness/probe/test or the gap is
documented as an intentional follow-up.

## Workflow: Periodic Governance

Trigger when using `los` for daily runtime checks, weekly doc/source
reconciliation, monthly agent-use analysis, or recurring governance reports.

Steps:

1. Read `docs/README.md` and
   `docs/governance/periodic-analysis.md`.
   For stage-goal or personal agent-workflow questions, also read
   `docs/governance/agent-workflow-roadmap.md`.
2. Choose the cadence:
   - daily: process, health, node registry, and persisted readiness truth
   - weekly: docs, contracts, ADR/source drift, tests, and jj status
   - monthly: agent-use patterns, provider gates, eval candidates, operator
     contracts, toolchain matrix drift, and safety risks
3. Keep external agent logs and los-owned evidence separate. Use external
   Codex/Claude/OpenCode/Reasonix summaries only after redaction and provenance
   review.
4. Convert unresolved drift into a concrete doc, ADR, test, operation smoke, or
   todo item.

Evidence to report:

- cadence and date
- commands or data sources used
- config truth versus runtime truth
- persisted `task_runs`, `session_events`, `executor_nodes`, or
  `service_instances` evidence when relevant
- checks run and residual risks

Stop when the report either has no action with evidence, creates an owning
follow-up item, or names the blocked verification surface.

## Workflow: Session Closeout And Branch Governance

Trigger at the **end of every support session** that edited the repo, ran a
feature branch, opened a PR, or left runtime processes/smoke artifacts — not
only when the operator says “commit.”

Also trigger when the operator asks to close out, ship, clean branches, or
“is there anything left for VCS.”

Steps:

1. **Inventory**
   - `jj status` (working copy = change; no staging)
   - `jj bookmark list` / open Forgejo PRs (web/API; use `tea` when configured)
   - `git worktree list` / `jj workspace list` — unexpected extras?
   - One-intent check: does the dirty set match a single `feat|fix|chore|docs`?
2. **Decide (explicit judgment — answer yes/no for each)**
   - Commit now? (bounded, reviewable, checks green or residual named)
   - Push / open or update PR?
   - Merge when green (self-merge loop only for operator-owned PRs)?
   - Prune remote feature branch after MERGED?
   - Delete/abandon local bookmark after absorbed into `main`?
   - Leave parked work? → name residual risk + next command, do not invent “done”
3. **Act only within consent bounds**
   - Push/PR/merge/delete-remote require operator intent or standing closeout ask
   - Prefer `jj describe` / `jj commit` / `jj git push --bookmark …`
   - After merge: fetch Forgejo `origin`, ff `main`, drop feature bookmark; GitHub mirror is optional
   - Branch delete rules: `docs/governance/branch-lifecycle.md` (absorption /
     observation window; squash-merge caveats)
4. **Evidence before “shipped”**
   - Forgejo PR MERGED + head on `origin/main`, or focused test/API row — not chat summary
   - Smoke ops notes must mark `[E]`/`[I]`/`[U]`; never treat agent ledger prose as DB truth

Evidence to report:

- dirty paths / bookmark / PR number
- decision table (commit / PR / merge / prune / park)
- commands run
- residual risk if anything left open

Stop when: clean `main`-aligned workspace, or every leftover item has an owner
and a next action.

Related:

- `AGENTS.md` → Session Closeout Gate
- `docs/governance/branch-lifecycle.md`
- `tools/branch-closeout.sh`, `tools/branch-prune-origin.sh`
- skill `pr-self-merge` for operator-owned merge loop

## Workflow: First Push And PR Creation

Trigger when new work is ready to be published: the change descends from
`main@origin`, has one intent, and the operator wants a Forgejo PR. Local `main`
must remain aligned with the authoritative Forgejo merge state.

Steps:

1. **Name the bookmark** — use `feat/`, `fix/`, `chore/`, or `docs/` prefix.
   Never push the auto-generated `push-<changeid>` name.
   ```bash
   jj bookmark create feat/<slug> --to <commit>
   ```

2. **Run local gate before pushing** — the git pre-push hook runs `pnpm gate`.
   Pre-run it so failures don't surprise you:
   ```bash
   bash tools/branch-closeout.sh
   ```

3. **Common gate failures and fixes**:
   | Symptom | Fix |
   |---------|-----|
   | `NEW UNWIRED EXPORTS` (5 new orphans) | `cd packages/gateway && node --import tsx ../../tools/check-wiring-topology.ts --update-baseline` |
   | `new file exceeds 500 line limit` | Add path to `tools/.large-file-baseline.txt` |
   | `state-machine bypass guard` failure | Check AP1: never call `updateTaskRun()` etc. directly |

4. **Push to Forgejo (primary)**:
   ```bash
   jj git push --remote origin --bookmark feat/<slug>
   ```
   GitHub mirror is optional — push there only after Forgejo PR is merged.

5. **Create PR on Forgejo** — `FORGEJO_TOKEN` is configured in `.env`
   (read from macOS keychain entry `los-forgejo-write-token`). Derive the
   Forgejo URL from `origin`; never hardcode an address from old session output.
   ```bash
   source .env 2>/dev/null
   FORGEJO_URL=$(git remote get-url origin | sed -E 's#(https?://[^/]+).*#\1#')
   curl -X POST "$FORGEJO_URL/api/v1/repos/los/los/pulls" \
     -H "Authorization: token $FORGEJO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"title":"feat: <summary>","head":"feat/<slug>","base":"main","body":"<checks + risk>"}'
   ```
   Without `FORGEJO_TOKEN`, open the push-output link in a browser.

6. **Verify exact-head CI before merging** — Forgejo must report green
   required checks for the pushed head SHA. `force_merge` is forbidden per
   `docs/operations/forgejo-delivery.md`. If CI is not running:
   1. Check Forgejo Actions at `$FORGEJO_URL/los/los/actions`.
   2. If no workflows are configured, open a separate bounded change to
      repair `.forgejo/workflows/ci.yml` and re-provision branch protection.
   3. Do not bypass with `force_merge` unless an explicit operator emergency
      authorization is recorded.
   ```bash
   HEAD_SHA=$(jj log -r '@' --no-graph -T 'commit_id' | head -1)
   curl -fsS -H "Authorization: token $FORGEJO_TOKEN" \
     "$FORGEJO_URL/api/v1/repos/los/los/commits/$HEAD_SHA/status"
   ```

7. **Merge through the Forgejo API** — re-read the PR head immediately
   before merging. Keep `force_merge:false`.
   ```bash
   PR_NUM=<number>
   # Re-confirm exact head
   curl -fsS -H "Authorization: token $FORGEJO_TOKEN" \
     "$FORGEJO_URL/api/v1/repos/los/los/pulls/$PR_NUM" | jq '{head_sha:.head.sha,mergeable}'
   # Merge
   curl -X POST "$FORGEJO_URL/api/v1/repos/los/los/pulls/$PR_NUM/merge" \
     -H "Authorization: token $FORGEJO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"Do":"merge","delete_branch_after_merge":false,"force_merge":false}'
   ```

8. **Sync local main and clean up** — only after Forgejo confirms the merge.
   ```bash
   jj git fetch --remote origin
   jj bookmark move main --to main@origin
   jj bookmark delete feat/<slug>
   bash tools/branch-prune-origin.sh   # dry-run; --apply with operator consent
   jj new main                          # start next change from authoritative main
   ```

9. **Keep `main` on Forgejo** — pushing a feature does not publish it to `main`.
   Start unrelated work from the current authoritative base instead of stacking
   it on the pushed feature:
   ```bash
   jj log -r 'main|main@origin' -n 2
   jj new main@origin
   ```

Before merging, inspect `/pulls/<number>/files`. If the file list contains a
second task or package intent, close/split the PR. A stale entry in
`tools/.known-test-failures.txt` is also a gate failure: remove recovered
entries in a separate bounded change before delivering feature work.

## Workflow: Gate Hook Failures

Trigger when `pnpm gate` or the git pre-push hook fails. These are the most
common failures and their fixes — do them in order, re-running the failing check
after each fix.

### Unwired exports (orphan functions)

New public exports with zero non-test callers. Per AP10, every new export must
be wired to an entry point or grandfathered in the baseline.

```
🔍 check-wiring-topology — scanning all packages for unwired exports...
❌ NEW UNWIRED EXPORTS DETECTED (5):
  packages/agent/src/providers/provider-probe.ts:42  probeProvider
```

**Fix** (if intentionally public but not yet wired):
```bash
cd packages/gateway
node --import tsx ../../tools/check-wiring-topology.ts --update-baseline
```

### Large file threshold (500-line gate)

A file grew past 500 lines and is not in `.large-file-baseline.txt`.

```
[ERROR] path/to/file.ts (505 lines) — new file exceeds 500 line limit
```

**Fix**:
```bash
echo "path/to/file.ts" >> tools/.large-file-baseline.txt
```

### State-machine bypass

Direct status writes detected — must use `transitionExecutionState()` (AP1).

**Fix**: Replace direct `updateTaskRun({status:...})` / `updateRunSpecStatus()`
calls with `transitionExecutionState()`. See `docs/governance/anti-patterns.md` AP1.

### Delete safety

A deleted file is still imported by surviving code.

**Fix**: Remove the stale import, or restore the deleted file if the deletion
was accidental.

Evidence to report:

- which gate phase failed
- exact error message
- fix applied (command + result)
- gate re-run result

Stop when `pnpm gate` passes all phases or the residual failure is documented
as a known pre-existing issue in `tools/.known-test-failures.txt`.
