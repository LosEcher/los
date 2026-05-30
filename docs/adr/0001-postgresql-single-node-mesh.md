# ADR 0001: PostgreSQL Persistence For Single-Node And Mesh Deployments

## Status

Accepted.

## Context

`los` is built as a mesh/cloud-capable agent platform. Running it on one machine should not create a separate persistence mode, schema, or operational path.

The earlier MVP draft treated SQLite as the local/single-node default and PostgreSQL as a later multi-node option. That split creates two runtime truths and makes later mesh deployment a migration rather than a scale-out step.

## Decision

`los` uses PostgreSQL as the only application persistence backend.

A single-node deployment is treated as a mesh/cloud deployment with:

- one gateway process,
- one agent runtime,
- one executor node if enabled,
- one PostgreSQL database.

The same schema, query layer, configuration key, and operational assumptions apply when more nodes are added.

## Consequences

- `DATABASE_URL` must be `postgres://...` or `postgresql://...`.
- Local development needs a PostgreSQL instance instead of an embedded database file.
- Memory search uses PostgreSQL full-text search.
- Session and memory persistence use async database calls.
- There is no SQLite fallback path for los-owned state.

SQLite may still appear in provider discovery when reading third-party tool state such as `cc-switch`; that does not make SQLite a los persistence backend.
