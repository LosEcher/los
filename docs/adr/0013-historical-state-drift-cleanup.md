# ADR 0013: Historical State Drift Cleanup

## Status

Accepted.

## Background

The workspace review on 2026-06-02 compared `.omx`, `.reasonix`, legacy
repositories, workspace docs, `los` ADRs, and operation smokes. The most
important finding was not a missing feature. It was state drift: documents
described `los` as if some capabilities were still unimplemented after the code
and operation smokes had already moved.

This ADR records the cleanup decisions so the fixes live in project decision
surfaces, not only in a review document.

## Observations

1. ADR 0012 still said Phase 1 was the next implementation slice, while
   `service_instances`, `/live`, `/ready`, `/services`, drain/promote, tests,
   and a multi-gateway readiness smoke already exist.
2. The historical review repeated an older "zero tests" observation. Current
   source truth is different: excluding `node_modules/` and `dist/`, `los`
   has 17 source test files under `packages/**/src`.
3. The root workspace rules said legacy projects are read-only references, but
   `lsclaw`, `vpsagentweb`, `los-ast`, `los-memory`, and `pi` all have commits
   from 2026-05-28 or 2026-05-29.
4. `projects/los/AGENTS.md` lists legacy projects as reference codebases. That
   must not be read as a live dependency or a mandate to call those repos at
   runtime.

## Decisions

1. ADR 0012 status is now "Partially implemented." Its remaining work is gap
   validation and Phases 3-7, not greenfield Phase 1 implementation.
2. Legacy projects remain reference sources by default. A legacy hotfix is
   allowed only when `los` has not covered the capability and the bug affects
   the current runtime. After the hotfix, the owner must evaluate whether
   `los` needs the corresponding implementation.
3. Legacy commits do not promote a legacy project back into an active workspace
   dependency. Feature enhancements should land in `projects/los/`.
4. The PI and vpsagentweb references in `projects/los/AGENTS.md` mean
   "compare or adapt patterns." They do not mean `los` should import PI packages
   or call vpsagentweb services unless a later ADR explicitly decides that.
5. Testing is no longer a zero-test problem. The remaining problem is missing
   test strategy: what must be unit-tested, what must be covered by harnesses,
   and what requires operation smoke evidence.

## Follow-Up Tasks

1. M-1 execution observability smoke is complete. Current result:
   `task_runs` and `session_events` can reconstruct operation-audit evidence,
   but they cannot replay exact `model.delta` SSE chunks.
2. Testing strategy ADR is complete:
   `docs/adr/0014-testing-strategy-and-regression-gates.md`.
3. Sync legacy AGENTS/CLAUDE boundary references in a separate change, because
   the legacy worktrees already contain unrelated uncommitted edits.
4. `.reasonix` truncation and `los` run replay policy are now separated in
   ADR 0015. `.reasonix/truncated-results/` is external capture evidence, not
   the source of truth for `los` run replay.

## Verification

Current verification for this ADR:

```bash
./tools/check-contracts.sh
```

Result on 2026-06-02: PASS for active project path, `package.json`,
`pnpm check`, and `pnpm build`.
