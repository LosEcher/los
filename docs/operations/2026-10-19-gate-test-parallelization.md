---
subject: Parallelize gate-test agent groups and packages suites
auditedRev: 313a7b0f (los main before the experiment, 2026-10-19)
readOnly: false
method:
  - Forgejo gate-test step timings from run 1423
  - local concurrent run (10 cores, isolated schemas)
  - two CI runs with a temporary probe forcing the heavy path (1429, 1430)
---

# gate-test parallelization

Date: 2026-10-19
Scope: `.forgejo/workflows/ci.yml` gate-test only. No product code change.

## 1. Problem

Run 1423 gate-test timings:

```text
agent-groups elapsed_sec=330
packages     elapsed_sec=240
coverage     elapsed_sec=7
```

The agent groups and the packages suite ran **sequentially**. Wall was
~10.2m, and gate-test was the critical path for every code PR.

## 2. Acceptance criteria (before the change)

- gate-test runs the packages suite concurrently with the three agent groups.
- Both suite exit statuses are preserved; a failure in either reds the job.
- No schema/isolation failures: schemas derive from `ppid-pid` when
  `LOS_TEST_RUN_ID` is unset, so the separate processes get distinct schemas.
- CI wall ≤ 8m, all four jobs green.
- If the 8 vCPU runner contends or any suite fails, revert.

## 3. Change

The `Test other packages` step is folded into the agent step. The step starts
four background pipelines (agent groups 1–3 and packages), waits for all four,
records the agent join time and the packages suite's **own** finish time, and
requires every exit status to be zero. Step timeout is 15m (was 12m + 10m).

## 4. Evidence `[E]`

Local (10 cores, no `LOS_TEST_RUN_ID`):

```text
wall 158s
agent groups: 132 + 198 + 161 tests, all pass
packages: gateway 127 pass, 0 fail
```

CI (8 vCPU, temporary probe file forced the heavy path):

```text
run 1429: gate-test 7m01s, all four jobs green
  agent-groups elapsed_sec=375, packages elapsed_sec=375 (join-time bug in
  the first timing report; both ran concurrently)
run 1430: gate-test 6m59s, all four jobs green
  agent-groups elapsed_sec=370, packages elapsed_sec=369
```

Agent groups slowed from 330s to ~370s under concurrency (CPU contention),
but eliminating the 240s sequential packages step still cuts the job from
~10.2m to ~7.0m. Wall is now ~7m for code PRs.

## 5. Residuals

- Two CI runs + one local run, not the planned five CI runs. The change is
  easy to revert (single commit) and is visible in every subsequent gate-test
  timing.
- Contention is real: agent groups +14%, packages likely slower than their
  standalone 240s. The net wall win is still ~3m; a second runner is still
  not justified by these numbers.
- The temporary `packages/agent/ci-parallel-probe.txt` was removed before
  merge; the final head is path-gated (`.forgejo/` is a safe prefix), so its
  own CI run only exercises gate-fast. The heavy evidence above is from the
  immediately preceding head with the same workflow.
- `check-known-failures.sh` still classifies known failures; this change does
  not alter the baseline.
