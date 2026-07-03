# Pre-Existing Test Failure Tracking (AP11)

## Problem

Test failures unrelated to the current change are discovered during PR work
(e.g. `pnpm gate` in CI or locally). The operator notices, confirms they're
pre-existing, merges anyway — and the failure is never recorded or followed up.
Next time it surfaces, the same diagnosis cycle repeats.

This is the exact same class of problem as AP2 (plan only in chat memory) and
AP5 (spec staleness): **the discovery exists only in the operator's short-term
awareness, not in any persisted system that can re-surface it.**

## Mechanism

Three components, all built on existing los primitives:

### 1. Baseline file: `tools/.known-test-failures.txt`

Same ratchet pattern as `.large-file-baseline.txt`. One failure per line:

```
# <file>  <test-name-pattern>  <first-seen-date>  <symptom>
packages/agent/src/some-flaky.test.ts  *  2026-07-01  Promise resolution still pending (Node --test top-level await race)
packages/agent/src/another.test.ts  retry  2026-07-01  intermittent timeout under --test-concurrency 1
```

(above are format examples only — not real entries; the baseline ships empty
when no pre-existing failures are confirmed.)

- `#` comments and blank lines ignored
- Lines are `<file> <pattern> <date> <description>` (whitespace-separated, description is free text to EOL)
- `*` = all tests in file affected

### 2. CI gate integration: `tools/check-known-failures.sh`

Runs as a non-blocking phase in `ci-gate.sh` (or as part of the test phase).
Compares actual test failures against the baseline:

- **Failures matching baseline entries** → `[KNOWN]` label, non-blocking
- **New failures not in baseline** → `[NEW]` label, gate fails (this is a real regression)
- **Baseline entries that now pass** → `[FIXED]` label, prompts removal from baseline

This is the enforcement layer: **no new pre-existing failures enter silently.**

### 3. Governance job: `test-failure-sweep`

A periodic sweeper (monthly) that:
- Reads `.known-test-failures.txt`
- For entries older than 30 days, creates a `todo` item with priority based on age
- Reports stale entries as drift
- If a baseline entry has no associated todo and is >60 days old, auto-creates one

This is the follow-through layer: **stale failures don't rot forever.**

## Flow

```
PR author runs pnpm gate
  ├─ Test phase runs
  ├─ check-known-failures.sh compares output against baseline
  │   ├─ All failures are KNOWN → pass (with note)
  │   ├─ NEW failure detected → BLOCK, must either fix or add to baseline
  │   └─ FIXED (baseline entry passes) → prompt to trim baseline
  └─ Merge unblocks

Monthly governance sweep:
  ├─ Reads .known-test-failures.txt
  ├─ Stale entries → auto-create todos
  └─ Reports aging metrics
```

## Operator Actions

| Scenario | Action |
|---|---|
| Discover pre-existing failure | Add entry to `.known-test-failures.txt` in the same PR |
| Fix a known failure | Remove entry from baseline (CI will prompt if forgotten) |
| Baseline entry >60 days old | Governance sweep auto-creates todo; operator triages |

## Integration Points

This PR lands the first two layers (baseline file + CI gate). The third layer
(governance sweeper) and the formal AGENTS.md AP11 entry are tracked as
follow-up — see "Scope" below.

- `tools/check-known-failures.sh` — new ~40-line script ✅
- `tools/ci-gate.sh` — Phase 7 (tests) now distinguishes KNOWN vs NEW ✅
- `tools/.known-test-failures.txt` — new baseline file (ships empty) ✅
- `packages/agent/src/governance-jobs.ts` — add `test_failure_sweep` job type — **follow-up**
- `AGENTS.md` — add AP11 entry — **follow-up**

## Scope

This change is the CI enforcement layer only: detect NEW vs KNOWN failures
and block on NEW. The governance sweeper (`test_failure_sweep`) and the formal
AP11 anti-pattern entry in AGENTS.md are intentionally deferred to a separate
intent so this branch stays one-purpose (CI tooling). When the sweeper lands,
the AP11 entry should be added in the same change.

## Why Not Alternatives

| Alternative | Why Not |
|---|---|
| `test.skip()` in source | Modifies test files for a non-code reason; dirty git state; conflicts on rebase |
| GitHub Issues | External to the repo; no CI integration; same "forget to create" problem |
| todo-only approach | Still requires manual creation at discovery time; no CI enforcement |
| Flaky test retry | Masks the problem instead of tracking it; hides real regressions |

## Anti-Pattern (AP11)

**NEVER** merge a PR with test failures you "confirmed are pre-existing" without
adding them to `.known-test-failures.txt`.

**ALWAYS** record the failure in the baseline. The CI gate enforces this: a
failure not in the baseline is treated as a regression, not a known issue.
