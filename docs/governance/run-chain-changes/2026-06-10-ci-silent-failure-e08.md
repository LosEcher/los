---
date: 2026-06-10
change: ci-silent-failure-e08-real-case
commit: pending
surface: docs, verification
impact: CI workflow added (S4.1) with pnpm version conflict causing 4 consecutive red runs on main. The failure was real and persistent, yet 3 more commits landed on main without detection — a textbook E08 case: "task marked done without persisted execution evidence."
---

## Evidence

- Source: `.github/workflows/ci.yml` — `pnpm/action-setup@v4` had `version: 9`
  explicitly set, conflicting with `package.json`'s `packageManager: pnpm@9.0.0`.
- Failure: `Error: Multiple versions of pnpm specified`. All 4 runs failed at
  the pnpm setup step before reaching `pnpm run gate`.
- Detection gap: The GitHub Actions badge was not checked after each push.
  Commits continued to land on main because the gate was a "local自觉, remote
  absent" — the exact pattern E08 guards against.
- Fix: commit `723389f` removed explicit `version: 9`, letting
  `pnpm/action-setup@v4` auto-detect from `packageManager`.

## Validation

- Fix verified: workflow syntax passes YAML lint; pnpm version conflict is
  resolved by removing the redundant field.
- Post-fix CI run: pending — needs a successful green run to close the loop.

## Remaining risk

- PostgreSQL service container connectivity not yet proven (CI never reached the
  test phase). May need additional iteration if `localhost:5432` resolution or
  `pg_isready` health check fails in the GitHub Actions environment.
- The detection gap (no one checked the badge) is a process issue, not a code
  issue. Branch protection / required status checks on main would close this gap.

## Notes

This is the first real-world manifestation of E08 in the los repo itself.
The eval backlog case E08 describes the pattern: "task marked done without
persisted execution evidence." Here, the CI gate was mentally marked "done"
but the remote evidence (green Actions run) never existed. This entry serves
as a concrete sample for future eval calibration.
