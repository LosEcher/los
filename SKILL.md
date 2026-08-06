---
name: los-project-operations
description: Use for repeated los-specific workflows that require current runtime evidence, ADR/source reconciliation, provider compatibility gates, gateway/executor lifecycle checks, or jj-aware closeout in /Users/echerlos/projects/los-workspace/projects/los.
---

# los Project Operations

Use this skill only inside the active `projects/los` repo. Keep global toolchain
rules, generic coding habits, and legacy project facts out of this file.

## Before Acting

1. Read `AGENTS.md` — hard invariants (AP1/AP2/AP3/AP5/AP7/AP9/AP11),
   Change Rules, Operator Consent, and Workflow Routing (closeout evidence
   requirements).
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
4. Verify the DB instance before trusting rows: after the 2026-08-05 split,
   the authoritative runtime DB is the local Homebrew postgres on
   `127.0.0.1:55432`; the `docker los-postgres` container was stopped
   (archive dump in `.los-runtime/db-backups/`). Check `lsof -nP -i :55432`
   and the `.env` `DATABASE_URL` comment before querying — "连错库" rows
   (stale governance jobs, empty schedules) are a known false-signal source.
5. gateway.log is not a real-time observable surface: `tools/los.sh` truncates
   it on start and stdout buffering can lag hours (observed 8h gap 2026-08-05).
   Judge the runtime loop by DB rows (`scheduled_work_item_runs`,
   `governance_jobs.last_run_at`) and `/health`, not by log freshness.
6. If stop/start behavior is involved, verify the stop path writes offline state
   before claiming registry truth is synchronized.
7. Remote execution (2026-08-06): scheduled_execution supports
   `runTemplate.executor` (nodeUrls/agentKey) + `workspaceRoot` override +
   `maxLoops`; tasks run on remote nodes via agent_http (e.g. node34). The
   agent tool `run_runtime_task` (L2, approval) delegates to codex/grok CLIs
   from within a task. Async approval: `approve` queues the run
   (`awaiting_approval -> queued`, resultSummary.approvedBy), executed by the
   ~30s tick. Approve HTTP returns immediately.

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
5. For doc-vs-repo drift checks, run the `los-doc-drift-sweep` skill checklist
   (doc anchors, command surface, ADR numbering, memory vs persisted truth).
   Loop/scheduled-task candidates are listed in `periodic-analysis.md` →
   "Loop / Scheduled-Task Candidates".

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

- `AGENTS.md` → Workflow Routing (session closeout reporting requirements)
- `docs/governance/branch-lifecycle.md`
- `tools/branch-closeout.sh`, `tools/branch-prune-origin.sh`
- `tools/mirror-github-main.sh` for optional GitHub mirror PR path after Forgejo merge
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
   For the mirror sync workflow (ruleset constraints, PR path), see
   `## Workflow: GitHub Mirror Sync` below.

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

## Workflow: GitHub Mirror Sync

Trigger when `main@github` lags Forgejo `main` and the mirror must be pulled
even. Verified on 2026-07-31 (PR #197, 6 commits behind; PR #200 content-equal).

**Why direct push is impossible** — GitHub `main` is protected by the ruleset
`main-protection` (`repos/LosEcher/los/rulesets/17481877`), which applies to
`refs/heads/main`:

| Rule | Effect |
|------|--------|
| `required_status_checks` | `gate-fast` / `gate-test` / `gate-drift` — **enforced on direct push too** (unlike classic protection, which only gates PR merges) |
| `non_fast_forward` | force push blocked |
| `deletion` | branch deletion blocked |

`bypass_actors` is empty, so there is no bypass — even a pure fast-forward push
is rejected (`push declined due to repository rule violations`) because the
target commit has no GitHub Actions check records (Forgejo-merged commits never
ran GitHub CI). **The only legal path is a PR merge** (prior art: #195–#200).

### Preferred: automated script

```bash
# Full path: fetch → content-diff short-circuit → local gate --no-tests →
# push mirror bookmark → open/reuse PR → gh pr checks --watch →
# assert non-empty statusCheckRollup + required contexts → merge commit →
# cleanup → verify content equality → realign local main to Forgejo.
bash tools/mirror-github-main.sh

bash tools/mirror-github-main.sh --dry-run          # plan only
bash tools/mirror-github-main.sh --skip-gate        # when gate just ran
bash tools/mirror-github-main.sh --wait-only <PR>   # reliable waiter only
bash tools/mirror-github-main.sh --merge-only <PR>  # wait + merge + cleanup
```

**Observation rule** — never treat empty `gh pr view --jq` output as pending.
The script hard-fails on empty JSON and requires `statusCheckRollup` to contain
the required contexts before merge. That guards the 2026-07-31 mirror #200
false-pending bug (~6 minutes of human wait after checks were already green).

### Manual steps (same path the script encodes)

1. **Create the mirror bookmark** on local `main`:
   ```bash
   jj bookmark create mirror/forgejo-main-sync --to main
   jj git push --remote github --bookmark mirror/forgejo-main-sync
   ```
   Feature branches are not covered by the ruleset, so the push succeeds.
   (`jj git push` does not run the git pre-push hook — run `pnpm gate` once
   yourself before pushing.)

2. **Open the PR on GitHub**:
   ```bash
   gh pr create --base main --head mirror/forgejo-main-sync \
     --title "mirror: sync Forgejo main → GitHub (N commits)" \
     --body "Mirror sync from Forgejo (authoritative). Direct push blocked by ruleset main-protection (required_status_checks)."
   ```

3. **Wait for required checks green** — `gate-fast`, `gate-test`, `gate-drift`
   (gate-web-e2e runs but is not a ruleset required context):
   ```bash
   gh pr checks <PR_NUM> --watch --interval 20
   # Then verify non-empty rollup before merge:
   gh pr view <PR_NUM> --json mergeStateStatus,statusCheckRollup \
     | jq '{mergeStateStatus, checks: [.statusCheckRollup[]? | {name, status, conclusion}]}'
   ```

4. **Merge with a merge commit** (matches #195–#200 shape; do not
   squash/rebase):
   ```bash
   gh pr merge <PR_NUM> --merge --delete-branch=false
   ```

5. **Clean up and re-align local `main`**:
   ```bash
   git push github --delete mirror/forgejo-main-sync
   jj bookmark delete mirror/forgejo-main-sync
   jj git fetch --remote github
   jj bookmark move main --to main@origin   # keep main on Forgejo; --allow-backwards if a mirror merge commit auto-advanced it
   ```

Expected end state: GitHub `main` is ahead of Forgejo by exactly one mirror
merge commit with identical content — verify with
`jj diff --from main@origin --to main@github --stat` (must print `0 files
changed` or an empty stat). Local `main` stays aligned with Forgejo.

**When gate-test fails on GitHub**: do not patch the mirror PR. Fix Forgejo
`main` first (own Forgejo PR, exact-head CI green), then re-run this workflow
by moving the mirror bookmark forward. Known 2026-07-31 blockers that all had
to be fixed in Forgejo main before the mirror could go green: `test-runner.mjs`
unclassified test files (#115 added tests without classifying them — fails
every CI immediately), orca computer-use MCP defaulting on (`registry.execute()`
blocked ~60s per call; now opt-in via `LOS_ORCA_ENABLED=1`), a hardcoded past
`once` trigger date in `scheduled-work.test.ts`, and test lanes sharing one
`LOS_TEST_RUN_ID` schema (CREATE TYPE collisions).

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

## Workflow: CI Failure Triage And Retrigger

Trigger when a Forgejo PR check fails, especially right after a push.

Steps:

1. Judge the failure by **conclusion**, not pending: a check that fails in
   seconds is infrastructure (runner/network), a check that fails after
   minutes is code. Read `commit/<sha>/status` and list every context with its
   `status` — do not stop at "no longer pending".
2. Network-jitter signature (observed 2026-08-03 on node34): log lines with
   `ETIMEDOUT <cloudflare-ip>:443` or `ENETUNREACH 2606:4700::…:443` while the
   host itself can reach the registry. Mitigations already in place:
   workflow-level `NODE_OPTIONS=--dns-result-order=ipv4first`. Remaining
   follow-up (not yet implemented): persistent pnpm store cache for the
   Forgejo runner.
3. Retrigger a PR without touching content:
   ```bash
   jj new <base-commit> -m "docs: retrigger N"
   jj bookmark set --allow-backwards <bookmark> -r @   # siblings need this
   jj git push --remote origin --bookmark <bookmark>
   ```
   Empty commits on the same base become siblings; `--allow-backwards` is
   required to move the bookmark sideways.
4. Merge caveats: Forgejo rejects merges with `head behind base` (chain
   merges need rebase+CI per PR) and occasionally reports 405 then closes the
   PR without merging — check `pulls/<n>` `merged` field and reopen as a new
   PR if `closed && !merged`.

Evidence to report: failing context names + conclusions, the log signature,
retrigger commands run, final check states before merge.

## Workflow: pnpm 11 Operations

Trigger when installing, upgrading, or debugging pnpm in this repo.

1. Version policy: `package.json` `packageManager: pnpm@11.6.0`; CI images
   pin the same; remote nodes match. Do not downgrade without a deliberate
   toolchain change.
2. Settings live in `pnpm-workspace.yaml` (package.json `pnpm` field is
   ignored with a warning). Build-script allowlist uses **`allowBuilds`**
   (esbuild, @google/genai, protobufjs) — not the pnpm-10 name
   `onlyBuiltDependencies`.
3. Lockfile is v9-compatible: `pnpm install` produces zero lockfile drift.
   Non-interactive installs need `CI=true` (store may land in the repo root
   as `.pnpm-store/`; it is gitignored).
4. In restricted shells (sandbox), the pnpm launcher cannot write its
   install dir: use
   `node ~/.cache/node/corepack/v1/pnpm/11.6.0/bin/pnpm.mjs <cmd>`.
   Run repo scripts with
   `./packages/gateway/node_modules/.bin/tsx tools/<script>.mts`
   and relative-path imports (tsconfig paths are not resolved).

## Workflow: Execution Lab Operations (experiments, K4, sample gate)

Trigger when driving execution experiments, the Pi K4 canary path, or
producing pairwise sample-gate samples.

1. Source run spec must carry a persisted plan (AP2): model-driven planning
   may fail repeatedly — use `tools/k4-create-source.mts` (operator-constructed
   plan) when needed. The source run must have `tenant_id`/`project_id` set or
   `select-candidate` rejects it as out-of-scope.
2. Lifecycle: create experiment → `select-candidate` (draft only) → approve
   experiment → approve candidate plan via `POST /runs/:id/approve` (K4
   candidates are **not** auto-dispatched by approve) → `authorize-canary`
   with `confirmCandidateRunSpecId` → `execute`. Planning-disposition
   candidates end in `blocked` awaiting operator approval; results stay
   advisory until the formal sample gate passes.
3. Sample production: `tools/pairwise-sample-ingest.mts --experiment <id>
   --scenario <sid>` extracts deterministic kernel evidence (idempotent).
   Gate registration contract requires `scenarios[].label` and
   `baselineRef/candidateRef {experimentId, runSpecId}`.
4. Auth for all gateway operator endpoints: header `x-los-operator-token`
   (not Bearer).

Evidence to report: experiment/candidate ids, kernel.started/finished events,
gate evaluation JSON (`collectedPairs`, `scenarioCoverage`, `passed`).
