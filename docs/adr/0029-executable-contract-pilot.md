# ADR 0029: Executable Contract Pilot

## Status

Accepted.

## Context

The files under `contracts/` describe package boundaries, routes, events, and
request fields, but the contract gate historically used grep. That allowed
invalid YAML, stale route paths, handwritten TypeScript drift, and requests
that were never checked against the declared schema.

## Decision

1. Contract files use a YAML envelope validated by
   `contracts/meta-schema.yaml`. JSON Schema 2020-12 keywords define executable
   request schemas inside that envelope.
2. Contract lifecycle states are `draft`, `accepted`, `implemented`, and
   `deprecated`. Semantic versions change whenever generated public types or
   runtime validation behavior changes. Breaking changes require a major
   version; additive compatible changes require a minor version; prose-only
   corrections require a patch version.
3. `@los/contracts` owns generated TypeScript types, event unions, and runtime
   validators. Generated files are committed so package consumers do not run
   code generation during normal builds.
4. `run-spec.yaml` and `run-stream.yaml` are the initial executable pilot.
   Other contracts remain envelope-validated and can migrate incrementally.
5. `tools/check-contracts.ts` parses YAML, validates the envelope and pilot
   schema, compares declared routes with Fastify route registrations, compares
   literal event emitters with the run-stream union, and fails when generated
   output differs from the committed files. Dynamic relay calls do not count
   as evidence for a declared event.
6. The run-spec validator runs at the HTTP `/chat` boundary and again at the
   `createRunSpec()` service boundary. The second check protects non-HTTP
   callers such as integration ingress.

## Consequences

- Invalid YAML and stale generated artifacts fail the contract gate.
- Removing a declared route or removing an emitted event from the contract
  fails CI without relying on wildcard relays.
- The pilot does not claim that all contracts generate types yet.
- JSON Schema remains the contract source; generated TypeScript must never be
  edited by hand.

## Verification

- `pnpm contracts:generate`
- `pnpm check:contracts`
- `pnpm --filter @los/contracts test`
- `pnpm --filter @los/gateway test`
- `pnpm gate`
