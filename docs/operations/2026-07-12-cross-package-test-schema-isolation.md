# Cross-Package Test Schema Isolation Smoke

Date: 2026-07-12

## Scope

Verify P1-T1 with the local PostgreSQL test database: package-scoped schemas,
parallel Turbo execution, concurrent root runs, cleanup, and an unchanged
`public` schema.

## Evidence

1. `pnpm test` completed three consecutive times with 13/13 package tasks:
   3m11s, 3m06s, and 3m05s. [E]
2. Two simultaneous `pnpm test` processes completed with 13/13 package tasks
   each. Their run IDs were `67f1d556-a628-4283-9ff8-546903d5a188` and
   `bba728e7-a009-43c3-9675-0f4fc9378e94`. [E]
3. The `public` schema contained 626 columns before and after validation, with
   fingerprint `0a65600afd942aa007bc6e2efa3af28d`. [E]
4. `information_schema.schemata` returned no `los_test_%` schemas after normal
   completion. [E]
5. A focused integration assertion verified `current_schema()` equals the
   configured test schema and `public.<probe_table>` is absent. [E]

## Findings Closed

- Shared `public` table DROP/TRUNCATE operations were removed from package test
  setup paths.
- Gateway now has a uniform database test setup.
- Fresh-schema execution exposed and fixed the `governance_jobs.next_run_at`
  bootstrap ordering and schema-qualification defect.
- Test advisory locks are namespaced by `LOS_TEST_SCHEMA`; production lock keys
  are unchanged.
- Static-analysis fixtures use unique system temporary directories instead of
  a repository-global filename.

## Residual Risk

Abnormally terminated test processes can leave their uniquely named schema
until an operator removes it. Normal completion cleanup is verified. [I]
