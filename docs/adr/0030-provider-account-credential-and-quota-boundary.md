# ADR 0030: Provider Account, Credential, Quota, And Provenance Boundary

## Status

Accepted. Phase 0 credential safety and CLI routing are implemented. Phase 0B
and Phases 1-4 remain pending and must follow the gates below.

## Date

2026-07-18

## Context

LOS already separates provider configuration, model profiles, compatibility
evidence, call telemetry, scheduler decisions, and task runs. It does not yet
have a stable provider-account identity or an account-scoped quota history.
The existing xAI OAuth implementation also has a narrower correctness gap that
must be fixed before adding account selection or using xAI to assess existing
dead letters.

At ADR acceptance, the source and runtime observations were:

1. `resolveXaiOAuthCredential()` can refresh an expiring token, but the
   production provider factory calls `getXaiOAuthCredentialSync()` instead.
   The synchronous path rejects an expired token and never invokes the async
   refresh path. See `packages/agent/src/auth/xai-oauth.ts` and
   `packages/agent/src/providers/index.ts`.
2. The auth store writer uses direct `writeFileSync()`. A malformed store is
   read as an empty object, so a later save can overwrite the original file.
   The writer does not set an explicit file mode, perform atomic replacement,
   or coordinate concurrent refresh-token rotation.
3. A terminal refresh failure clears the current store entry without proving
   that it is still the credential generation that failed. A sibling process
   could have written a newer token first.
4. `packages/cli/src/auth.ts` parses `<subcommand> <provider>`, while its help
   and examples declare `<provider> <subcommand>`. On 2026-07-18,
   `./bin/los auth xai status` failed with `Unknown auth subcommand: xai`, while
   `./bin/los auth status xai` reported an expired credential.
5. On the same date, `./bin/los provider list --json` still reported xAI as
   ready because discovery found an OAuth entry. Readiness therefore does not
   prove that the effective request credential is valid.
6. The operator-reported dead-letter set contains 15 unacknowledged
   `unrecoverable_error` entries. They remain outside this ADR's mutation
   scope. A fresh CLI summary was not available in this phase because the
   gateway correctly required an operator token.

The current schema has suitable provenance consumers but no stable account
foreign key:

- `task_runs`
- `provider_call_telemetry`
- `provider_compat_evidence`
- `scheduler_decisions`

## Reference Evidence

External repositories are pattern references only. This ADR does not create a
package, service, runtime, or file-format dependency on either repository.

### Orca

Reference commit:
`4e08f78e8b0f905a0acfc439368d97efae026705`.

Useful patterns:

1. `src/main/codex-accounts/service.ts` serializes account mutations through a
   single promise queue so overlapping add, reauthentication, and removal
   operations cannot lose updates.
2. `src/main/codex-accounts/fs-utils.ts` writes through a uniquely named
   temporary file and atomically renames it over the target.
3. `src/main/rate-limits/service.ts` clears the old quota view and increments a
   generation when the selected account changes.
4. The same rate-limit service applies an asynchronous quota result only when
   both request generation and account provenance still match.

LOS should reuse the serialization, atomic-write, generation, and provenance
ideas. It should not copy Orca's desktop managed-home or implicit account
switching architecture.

### Grok Build

Reference commit:
`c1b5909ec707c069f1d21a93917af044e71da0d7`.

Useful patterns:

1. `crates/codegen/xai-grok-shell/src/auth/manager.rs` has one refresh mutation
   point, an in-process mutex, an exclusive cross-process file lock held across
   the identity-provider call, and sibling-token adoption after lock waits.
2. The refresh path never proceeds without the file lock when reuse of a
   single-use refresh token is possible.
3. `crates/codegen/xai-grok-shell/src/auth/model.rs` separates auth mode,
   stable user/team/organization identity, refresh data, and expiry metadata.
4. `crates/codegen/xai-grok-shell/src/extensions/billing.rs` keeps current
   period, included usage, on-demand usage, prepaid balance, and subscription
   metadata distinct.

LOS should reuse the refresh-serialization and identity-shape lessons. Grok
Build's billing path is an internal product endpoint and is not an approved LOS
dependency. Its response fields may inform fixtures only after an independently
verified xAI API contract exists.

## Decision

### 1. Keep Provider Truth Surfaces Separate

LOS must not collapse these surfaces into one `ready` or `available` value:

| Surface | Question | Initial owner |
| --- | --- | --- |
| Provider configuration | Which endpoint and default model are configured? | `@los/infra` config and discovery |
| Account identity | Which credential-bearing identity is selected? | `provider_accounts` |
| Credential state | Can the selected secret produce a valid request now? | secret backend and credential resolver |
| Compatibility evidence | Did this provider, model, and probe pass? | `provider_compat_evidence` |
| Health | Is the endpoint or service reachable? | readiness and operation probes |
| Quota or entitlement | What allowance or access state did the provider report? | `provider_quota_snapshots` |
| Usage and cost | What did LOS calls consume or estimate? | `provider_call_telemetry` and run evidence |
| Effective route | Which provider, model, account, and node handled the call? | task, call, compatibility, and scheduler provenance |

A provider can be configured and discovered while its credential is expired.
A credential can be valid while a model probe fails. Quota can be unknown while
calls still succeed. Each condition must remain independently observable.

### 2. Introduce Stable Provider Accounts Without Storing Secrets In PostgreSQL

The first persistent account model is `provider_accounts`. Its minimum logical
shape is:

| Field | Meaning |
| --- | --- |
| `id` | Stable LOS account id |
| `provider` | Provider catalog key |
| `auth_mode` | OAuth, API key, external reference, or future adapter mode |
| `display_label` | Operator-controlled non-secret label |
| `secret_ref` | Opaque reference resolved by an approved secret backend |
| `state` | Active, disabled, auth failed, or unavailable |
| `credential_generation` | Monotonic generation used to reject stale writers |
| `secret_scope` | Local node, named node, or external backend scope |
| `node_id` | Optional binding when the secret is node-local |
| `verified_at` | Last successful credential verification time |
| `created_at`, `updated_at` | Record lifecycle timestamps |

PostgreSQL must not store raw access tokens, refresh tokens, API keys, cookies,
copied auth snapshots, or raw provider responses. The initial secret backends
are:

1. restricted local file storage for OAuth;
2. environment or external references for API keys;
3. opaque `secret_ref` values in the account row.

An OS keychain can be added later as an adapter. It is not required for the
first account schema and must not change account identity semantics.

### 3. Make Credential Refresh A Generation-Fenced Mutation

Before `provider_accounts` is introduced, the existing xAI path must satisfy
these P0 rules:

1. The production provider call path awaits `resolveXaiOAuthCredential()`.
2. One process serializes refresh through an in-process mutex.
3. An exclusive cross-process lock covers the single-use refresh-token network
   call and the following durable write.
4. After acquiring the lock, the process re-reads the store and adopts a newer
   sibling credential when available.
5. Every credential write carries or derives a monotonic generation. A stale
   writer cannot overwrite a newer generation.
6. A terminal refresh failure can clear or disable only the same generation it
   attempted. It cannot delete a newer sibling credential.
7. The auth store is written by atomic replacement. The directory is
   user-restricted and the credential file uses mode `0600` where POSIX modes
   apply.
8. Malformed JSON fails closed. LOS preserves the original file and must not
   interpret it as an empty store for a subsequent save.
9. The documented CLI order is canonical:
   `los auth <provider> <login|status|logout>`.

The lock timeout must return a retryable error or adopt a sibling token. It
must never continue to the refresh endpoint without the lock.

### 4. Store Account-Scoped Quota Snapshots As Advisory Evidence

`provider_quota_snapshots` stores time-bounded observations, not an account
balance ledger. Its minimum logical shape is:

| Field | Meaning |
| --- | --- |
| `id` | Snapshot id |
| `provider_account_id` | Stable account provenance |
| `bucket` | Provider-defined allowance bucket |
| `window_kind` | Session, daily, weekly, monthly, rolling, or unknown |
| `used`, `remaining`, `limit_value` | Nullable normalized numeric values |
| `unit` | Tokens, requests, credits, currency minor units, percent, or provider-defined |
| `window_start`, `resets_at` | Provider-reported or derived time boundary |
| `source` | Verified API, response headers, CLI adapter, or operator import |
| `freshness` | Fresh, stale, expired, or unknown |
| `fetch_status`, `error_code` | Fetch result without raw secret-bearing response bodies |
| `observed_at`, `created_at` | Observation and persistence times |

The derived advisory state is one of:

- `available`
- `degraded`
- `rate_limited`
- `exhausted`
- `auth_failed`
- `unknown`

Initial quota state affects diagnostics and operator warnings only. It must not
silently change scheduler routing, switch accounts, purchase credits, recharge
an account, or enable provider auto top-up.

### 5. Require Explicit Account Selection

LOS must not silently fail over between provider accounts. Initial selection
rules are:

1. A run may use an explicitly selected `providerAccountId`.
2. A project or node may define one explicit default account later.
3. When selection is absent or ambiguous, LOS returns a bounded diagnostic.
4. Account state or quota may explain why an account is unsuitable, but cannot
   authorize selecting another account.
5. Any future scheduler-based account selection requires a separate ADR,
   focused harness, operator consent, and persisted decision evidence.

### 6. Persist Effective Account Provenance

After the account store exists, add nullable `provider_account_id` provenance
to these existing records:

1. `task_runs`
2. `provider_call_telemetry`
3. `provider_compat_evidence`
4. `scheduler_decisions`

The value is captured from the effective credential resolution, not inferred
later from the current default account. Historical records without an account
id remain valid and explicitly mean `unknown`, not the current account.

## Delivery Phases And Acceptance Evidence

Each phase is one jj change, one short-lived bookmark, and one Forgejo PR. The
exact PR head must pass required CI before merge. GitHub mirror updates remain
ordinary non-force pushes only.

Implementation progress:

1. Phase 0 implements the atomic restricted auth store, in-process refresh
   serialization, cross-process refresh locking, credential-generation fences,
   malformed-store preservation, async production credential resolution, and
   provider-first CLI routing.
2. Phase 0B remains blocked on operator reauthentication and a live
   `xai:grok-composer-2.5-fast` compatibility probe.
3. Phases 1-4 remain pending. Phase 1 still requires package-level approval
   before an infra migration or a new file under `packages/infra/`.

### Phase 0: xAI Credential Safety And CLI Routing

Owned surfaces:

- `packages/agent/src/auth/xai-oauth.ts`
- `packages/agent/src/providers/index.ts` and necessary async callers
- `packages/cli/src/auth.ts`
- focused tests in the same packages

Required evidence:

1. concurrent refresh uses one network call per credential generation;
2. a waiting process adopts a sibling's rotated token;
3. a stale writer and terminal failure cannot erase a newer token;
4. malformed auth JSON is preserved and blocks mutation;
5. atomic file replacement and permissions are tested;
6. `los auth xai status` follows the documented routing;
7. the production provider path exercises async refresh;
8. focused agent and CLI tests, then `pnpm check` and the provider harness gate.

After merge, the operator must reauthenticate xAI. The login itself remains an
interactive operator action and is not performed by tests or migrations.

### Phase 0B: Same-Model Compatibility And Dead-Letter Decision

After reauthentication, run a live compatibility probe against the exact model
needed for the failed work, currently `grok-composer-2.5-fast`. Record effective
provider, model, credential class, account provenance when available, task/run
ids, tool outcomes, and token usage.

Until that probe passes and the operator makes an explicit recovery decision:

1. do not acknowledge the 15 identified `unrecoverable_error` entries;
2. do not replay or requeue them;
3. do not classify provider readiness as compatibility proof.

### Phase 1: Provider Account Store

This phase requires package-level approval before adding an infra migration or
new file under `packages/infra/`. It must update every transitive package test
setup that creates the schema.

Required evidence:

1. contract and migration review before implementation;
2. no raw secret fields in schema, API, logs, or fixtures;
3. stable identity and generation semantics;
4. node-local secret references remain distinguishable from portable external
   references;
5. focused persistence tests and migration-drift gate.

### Phase 2: Quota Snapshots

Required evidence:

1. fixtures cover missing values, multiple buckets and windows, stale data,
   auth failure, rate limit, and malformed provider responses;
2. async results apply only when account id and credential generation match;
3. raw provider response bodies and secrets are not persisted;
4. quota remains advisory and does not change scheduler behavior.

### Phase 3: Effective Account Provenance

Required evidence:

1. account id is captured at credential resolution and carried into all four
   evidence surfaces;
2. retries and compatibility probes preserve the effective account id;
3. historical nulls remain `unknown`;
4. scheduler selection records why an explicitly selected account was used or
   rejected;
5. focused cross-package tests and `pnpm run gate` pass.

### Phase 4: Operator Account Selection

This phase adds explicit API, CLI, or Web selection only after Phases 1-3. It
must not add automatic failover. Any write surface requires authorization,
redaction tests, and an operation smoke with persisted provenance.

## Migration And Compatibility Rules

1. Existing provider configuration remains the source for endpoint and model
   defaults during migration.
2. Existing single-account installations may be represented by one generated
   account row whose `secret_ref` points to the current approved backend.
3. Account ids must not be derived from email addresses, access tokens, or
   other mutable or sensitive values.
4. Migration must be additive first. Existing runs and evidence rows remain
   readable with null account provenance.
5. No migration may copy `~/.los/auth.json`, `~/.hermes/auth.json`, environment
   values, or external CLI auth files into PostgreSQL.

## Consequences

1. Credential correctness is fixed before a broader account schema can hide or
   amplify the existing refresh race.
2. Operators can later compare quota and compatibility by stable account
   without exposing credentials.
3. Scheduler and provider diagnostics gain traceable account provenance but do
   not gain implicit failover authority.
4. Quota collection remains provider-specific at the adapter boundary while
   persistence and advisory states remain provider-neutral.
5. The design introduces several small delivery phases because auth mutation,
   schema ownership, provider calls, and scheduler policy require different
   evidence and consent boundaries.

## Non-Goals

1. Automatic account rotation, quota balancing, or cheapest-provider routing.
2. Automatic purchase, recharge, subscription change, or auto top-up.
3. Treating quota as entitlement, readiness, compatibility, health, or cost.
4. Importing Orca managed homes or Grok Build internal billing endpoints.
5. Storing raw credentials, auth snapshots, or provider billing responses in
   PostgreSQL.
6. Acknowledging or replaying dead letters as part of auth or account work.

## Remaining Verification

1. Verify xAI's supported billing or quota API from an official, stable
   contract before implementing a live quota collector.
2. Decide the first `secret_ref` URI/identifier grammar during Phase 1 without
   making it provider-specific.
3. Confirm whether account provenance belongs in public contracts before
   changing any route response.
4. Re-run the dead-letter summary with an authorized operator surface before
   making the recovery decision; the counts in this ADR are not execution
   authority.
5. Define retention and compaction policy for quota snapshots after real sample
   volume is measured.

## Verification For This ADR

This change is documentation-only. It requires source-grounded readback and:

```bash
./tools/check-contracts.sh
```

No live provider call, database mutation, dead-letter action, or migration is
part of this ADR change.
