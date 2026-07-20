# Database Migration Operations

## Current Behavior

`packages/infra/src/migrate.ts` is the ordered migration runner. Gateway and
executor startup both call `migrateDir()` before their `ensure*Store()`
bootstrap. Applied migration sequence numbers are recorded in
`schema_migrations`.

The two startup layers answer different questions:

| Layer | Entry point | Responsibility |
| --- | --- | --- |
| Ordered migrations | `migrateDir()` | Upgrade an existing database and retain an applied-version history |
| Runtime compatibility | `ensureAllStores()` / `ensureAllAgentStores()` | Idempotently ensure the current code's required tables and columns exist |
| Drift validation | `pnpm check:migration-drift` | Compare migration-only and ensure-only scratch databases; never migrate the business database |

There is no standalone `@los/infra db:migrate` package script. Starting a
gateway or executor is the production migration entry point.

## Change Procedure

1. Add the next zero-padded SQL file under `packages/infra/migrations/`. Never
   edit or delete a migration that may already be recorded in
   `schema_migrations`.
2. Update the owning `ensure*Store()` schema when the runtime compatibility
   path owns the same table or column.
3. Update every package test setup that transitively uses the store. Package
   tests use isolated schemas and must not race on schema creation.
4. Run the focused package test, then `pnpm check:migration-drift` with a
   PostgreSQL role that has `CREATEDB`.
5. Run `pnpm gate` before delivery when the change crosses package boundaries.

## Drift Gate

The drift gate creates and later drops two scratch databases. Its connection
role therefore needs `CREATEDB`; a normal application role may be unable to run
it locally.

```bash
SERVER_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres \
  pnpm check:migration-drift
```

`NODE_ENV` and `TEST_DATABASE_URL` must be unset for this command. The CI
`gate-drift` job does this explicitly so the test-database guard cannot redirect
both comparison URLs to the same database.

Successful drift validation proves schema agreement on fresh scratch
databases. It does not prove that a particular production database has applied
the migration. Verify that separately:

```sql
SELECT seq, name, applied_at
FROM schema_migrations
ORDER BY seq;
```

## Failure Handling

1. If startup reports a migration error, stop rollout and preserve the exact
   migration filename and PostgreSQL error. Do not manually insert a
   `schema_migrations` row.
2. If the drift gate reports ensure-only objects, add or correct a migration.
3. If it reports migration-only objects, decide whether they are intentionally
   migration-owned before changing the runtime bootstrap.
4. Rollback uses a new forward migration unless an accepted ADR documents a
   reversible operation. Published migration files remain immutable.
