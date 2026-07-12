# ADR 0026: Feed Analysis Integration And Result Delivery

## Status

Implemented on 2026-07-12. The live cross-repository callback smoke was
completed on 2026-07-12.

## Context

`lot2extension` uses a Go backend as the data and authorization boundary for
browser-collected feed material. `los` is the workflow and model-execution
boundary. The browser extension must not call `los` directly, and `los` must
not control the extension or publish content on a user's behalf.

The intended flow is:

```text
extension -> Go backend -> los workflow -> Go backend -> extension
```

All task ownership, authorization, material access, result persistence, and
audit exchange between the extension and `los` pass through the Go backend.

The current draft contract and implementation provide:

1. target discovery;
2. dispatch and dispatch-status routes;
3. HTTP idempotency-key replay;
4. a `callback` placeholder;
5. a generic `run_spec` plus scheduled agent task.

Before this ADR, the runtime did not provide result persistence, result
retrieval, callback delivery, callback retry/dead-letter handling,
cancellation, or a versioned feed-analysis workflow. It also reported
`supportsResultReturning: true` even though `resultAvailable` is derived only
from task success and no result can be read. The generic ingress prompt keeps
at most ten observation summaries, runs one loop, and does not persist a
validated structured output.

## Decision

Adopt a dedicated integration boundary inside the existing modular monolith.
The gateway remains the HTTP edge, `@los/agent` owns integration workflow and
state, PostgreSQL owns durable truth, and existing provider/model profiles own
LLM execution. Do not add a second workflow framework or state machine.

The public integration evolves to a versioned `feed-analysis-v2` contract.
Until the v2 result path is live, target discovery must not advertise
`result_returning` as available.

## Ownership Boundary

| Component | Owns | Does not own |
| --- | --- | --- |
| Extension | page detection, user selection and consent, status UI, draft editing, assisted editor fill | credentials, los workflows, retry, authoritative result state, automatic publish |
| Go backend | user ownership, material normalization, dedupe, policy filtering, job truth, callback verification, result/artifact storage | deep research, agent orchestration, browser DOM operations |
| los | material validation, workflow execution, optional retrieval, structured generation, result query, signed callbacks | browser permissions, long-term raw browsing history, final publish action |

## Contract V2

The source of truth remains `contracts/integration-feed-analysis.yaml`. The v2
change must update the contract before generated types and implementation.

### Routes

```text
GET  /api/integrations/feed-analysis/targets
POST /api/integrations/feed-analysis/dispatch
GET  /api/integrations/feed-analysis/dispatch/:id
GET  /api/integrations/feed-analysis/dispatch/:id/result
POST /api/integrations/feed-analysis/dispatch/:id/cancel
```

`targets` reports executable capability, not intended roadmap:

```json
{
  "kind": "los-ingress",
  "contractVersions": ["feed-analysis-v2"],
  "supportedDeliveryModes": ["delivery_only", "result_returning"],
  "supportedOutputs": ["daily_digest", "content_brief", "platform_draft"],
  "supportedPlatforms": ["xiaohongshu", "weibo", "x"],
  "supportedLocales": ["zh-CN"],
  "maxInlineBytes": 1048576,
  "maxItems": 500,
  "supportsCallback": true,
  "supportsCancellation": true
}
```

Capabilities are derived from enabled workflow definitions and configured
callback/material-fetch policy. A disabled provider, workflow, or callback
profile must reduce the advertised capability.

### Material Bundle

Dispatch accepts exactly one of:

1. inline `materialBundle`; or
2. `materialBundleRef` containing `bundleId`, `inputDigest`, URL, expiry, and
   byte size.

The bundle schema is `material-bundle-v1` and contains the time range,
selection policy, normalized items, requested outputs, locale, citation rule,
external-research policy, and retention policy.

Remote bundle fetches must:

1. require HTTPS;
2. use a source-system allowlist rather than arbitrary callback-provided URLs;
3. reject credentials in URLs and unsafe redirects;
4. enforce expiry, byte, item-count, and timeout limits;
5. verify the declared SHA-256 digest before parsing;
6. reject private/link-local destinations unless explicitly configured for a
   trusted local deployment.

Raw bundle bodies must not be copied into `session_events`, task metadata, or
prompt previews. Those surfaces retain IDs, digests, counts, policy, and
redacted summaries only.

### Idempotency

HTTP idempotency remains useful for transport retries, but business identity is
independent of a caller-provided header.

The durable uniqueness key is:

```text
(tenant_id, project_id, source_system, source_job_id)
```

Reusing that key with the same canonical input digest returns the existing
dispatch. Reusing it with a different digest returns `409
source_job_conflict`. The response always returns the stored idempotency key
and whether the dispatch was deduplicated.

### Errors

The integration uses stable machine-readable codes:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | required field or shape is invalid |
| 401 | `integration_unauthorized` | service credential is missing or invalid |
| 404 | `dispatch_not_found` | dispatch does not exist in the caller scope |
| 409 | `source_job_conflict` | business idempotency key has a different digest |
| 409 | `invalid_state` | cancel or transition is illegal |
| 413 | `material_too_large` | byte or item limit exceeded |
| 422 | `capability_unsupported` | output, platform, locale, or policy is unsupported |
| 422 | `material_invalid` | bundle digest or schema validation failed |
| 422 | `result_invalid` | workflow output failed result-schema validation |
| 429 | `integration_quota_exceeded` | source or tenant limit exceeded |
| 503 | `workflow_unavailable` | required workflow/provider is unavailable |

## Durable Model

Add integration-specific tables rather than overloading `run_specs` or the
node-owned binary `artifacts` table.

### `feed_analysis_dispatches`

Stores business identity, tenant/project scope, source job, delivery mode,
contract and bundle versions, input digest, requested outputs, policy, callback
profile reference, current integration status, sequence, linked run/task IDs,
timestamps, and retention expiry.

The row is the integration projection. Execution status changes still flow
through `transitionExecutionState()` for `run_specs` and `task_runs`; the
integration projection is updated from those validated transitions.

### `feed_analysis_results`

Stores one validated result envelope per dispatch:

1. result schema version;
2. summary;
3. citations and warnings;
4. workflow ID and version;
5. prompt ID and version;
6. provider and model;
7. token usage, cost, and duration;
8. canonical result digest;
9. validation timestamp.

The result becomes available only after schema validation and atomic
persistence succeed.

### `feed_analysis_artifacts`

Stores structured generated content such as `daily_digest`, `content_brief`,
and `platform_draft`. Fields include target platform, locale, title candidates,
body, hashtags, structured payload, citation references, workflow/prompt
versions, review status, and timestamps.

Large binary exports may reference the existing generic `artifacts` table, but
structured drafts must not be encoded as node-local files merely to obtain an
ID.

### Callback Event And Delivery Tables

`feed_analysis_callback_events` stores immutable event IDs, per-dispatch
monotonic sequence, event version, status, payload digest, and creation time.

`feed_analysis_callback_deliveries` stores target profile, attempt count, next
attempt time, lease owner/expiry, last HTTP status/error, delivered time, and
dead-letter time. This must be a dedicated delivery outbox: the existing
`execution_outbox` is an audit ledger and is no longer polled for external
delivery.

## State Semantics

Integration status is:

```text
accepted -> queued -> processing -> result_ready -> completed
                              \-> failed
accepted/queued/processing/result_ready -> cancelled
```

Rules:

1. `delivery_only` is safely accepted after durable enqueue; the caller may
   treat that acknowledgement as delivery completion without waiting for an
   analysis result.
2. `result_returning` reaches `result_ready` only after a valid result and its
   artifacts are atomically stored.
3. `completed` means the los result is durable and readable. Callback delivery
   success is tracked separately and does not roll the workflow backward.
4. A succeeded agent task with missing or invalid structured output becomes
   `failed/result_invalid`; it never exposes `resultAvailable=true`.
5. Cancellation resolves the linked active task, calls the scheduler
   cancellation path, and uses `transitionExecutionState()` for task/run state.
   Repeated cancellation is idempotent.
6. `GET .../result` returns `202 result_pending` before `result_ready`, the
   validated envelope after readiness, and the stored terminal error for
   invalid/failed workflows.

## Workflow Model

Replace the generic one-loop ingress prompt with a versioned workflow registry.
The first required workflow is `lot2.daily-content@1.0.0`:

1. validate bundle and requested capabilities;
2. normalize and deduplicate items;
3. cluster by topic and behavior signal;
4. generate daily digest;
5. generate content brief;
6. generate requested platform drafts;
7. validate citations, platform limits, and result schemas;
8. persist result and artifacts atomically.

Workflow selection is deterministic from requested outputs, policy, and target
platform. Each LLM stage uses the existing provider adapter/model profile and
records the actual workflow, prompt, provider, model, tokens, cost, and elapsed
time. External research is disabled unless both the request policy and the
selected workflow allow it.

Workflow routing now distinguishes three versioned profiles:

1. `batch_summary` for explicit `evidence_batch` snapshots;
2. `daily_content` for the backward-compatible v2 daily-content path;
3. `research_deep` for explicit `research_topic` snapshots with topic context.

`research_deep` uses the existing durable agent task graph in conservative
serial mode: planner, evidence analyst, synthesis, platform writer, and final
verifier/writer. Full stage output is passed to the next stage in process and
only a bounded summary is persisted in `task_attempts`; the validated final
result remains the durable result boundary. This does not introduce a second
workflow framework or state store. Research stages run with an explicit empty
tool allowlist, so they cannot inspect the LOS workspace or drift beyond the
locked material and prior stage outputs. External retrieval remains disabled
until a dedicated retrieval tool policy and provider harness are approved. The
other profiles remain bounded single scheduled tasks.

## Callback Protocol

los emits `accepted`, `processing`, `progress`, `completed`, `failed`, and
`cancelled` events. Event IDs are immutable and sequence numbers increase per
dispatch.

Callback destinations and secrets are server-configured integration profiles,
selected by `sourceSystem`; dispatch requests may select a profile but may not
supply an arbitrary secret. The outbound callback credential is distinct from
the Bearer token used by the Go backend to call los.

Headers:

```text
X-Los-Event-Id: evt_...
X-Los-Event-Sequence: 4
X-Los-Timestamp: 1783876800
X-Los-Signature: v1=<hex hmac-sha256>
```

The signed input is `<timestamp>.<raw request body>`. Delivery uses bounded
exponential backoff with jitter, honors `Retry-After`, and dead-letters after a
configured attempt/age limit. Operator APIs must list and replay dead-lettered
callback deliveries without generating a new event ID or sequence.

Go backend `2xx` means the event was durably accepted. It does not mean the
extension displayed the result.

## Security And Retention

1. Add a dedicated inbound integration service credential; do not reuse the
   general gateway auth token or operator token.
2. Scope credentials to source system, tenant/project, allowed workflows,
   callback profile, and limits.
3. Validate callback and material URLs against configured profiles to prevent
   SSRF and credential exfiltration.
4. Redact secrets and sensitive fields before prompt construction and event
   persistence.
5. Store only the normalized material required for the workflow and attach an
   explicit retention expiry.
6. Governance cleanup removes expired material bodies while retaining bounded
   dispatch/result audit metadata.
7. Never let a platform draft workflow invoke browser automation or a publish
   action.

## Implementation Placement

Expected surfaces:

```text
contracts/integration-feed-analysis.yaml
packages/agent/src/integration/feed-analysis-ingress.ts
packages/agent/src/integration/feed-analysis-execution.ts
packages/agent/src/integration/feed-analysis-store.ts
packages/agent/src/integration/feed-analysis-workflow.ts
packages/agent/src/integration/feed-analysis-workflow-profile.ts
packages/agent/src/integration/feed-analysis-research-graph.ts
packages/agent/src/integration/feed-analysis-result-contract.ts
packages/agent/src/integration/feed-analysis-progress.ts
packages/agent/src/integration/feed-analysis-callback-outbox.ts
packages/gateway/src/routes/data/integration-routes.ts
packages/infra/src/config.ts
packages/infra/migrations/0xx_feed_analysis_v2.sql
```

Adding new files under `packages/infra/` requires package-level approval. The
new migration and config fields are expected; runtime integration modules stay
under `@los/agent`.

## Delivery Sequence

### Phase 0: Truthful Contract

1. Add v2 schemas, stable errors, capability fixture, and generated types.
2. Stop advertising result-returning support until its result route and store
   pass contract tests.
3. Add canonical request/result/callback fixtures shared with the Go backend.

### Phase 1: Result Polling

1. Add dispatch/result/artifact persistence and business idempotency.
2. Implement the versioned bounded workflow and result validation.
3. Add result query and cancellation routes.
4. Prove that task success without valid output produces `result_invalid`.

### Phase 2: Callback Delivery

1. Add callback profiles, signed event creation, delivery worker, retry, lease,
   dead-letter listing, and replay.
2. Keep polling as the compensation path.

### Phase 3: Workflow Expansion

1. Add citation-aware digest, brief, and Xiaohongshu draft quality gates.
2. Add optional retrieval only after policy and provider harnesses pass.
3. Add Weibo, X, and Zhihu adapters as output schemas, not browser tools.

### Phase 4: End-To-End Verification

Run fixed fixtures for duplicate dispatch, digest mismatch, oversized material,
unsupported output, invalid model output, cancellation, callback timeout,
callback replay, stale sequence, and polling recovery. Record a live operation
smoke with dispatch ID, result digest, callback event IDs, linked run/task IDs,
and persisted rows. Do not store the raw browsing bundle in the smoke report.

## Required Gates

Each phase reloads applicable specs and runs the narrow package check after
meaningful edits. Because the implementation crosses contract, agent, gateway,
infra, and migration boundaries, delivery requires:

```bash
./tools/check-contracts.sh
pnpm --filter @los/agent test
pnpm --filter @los/gateway test
pnpm --filter @los/infra test
pnpm run gate
```

The focused harness must cover provider output parsing and the callback worker.
A live provider is not required for deterministic contract/store tests, but at
least one configured provider must pass the fixed `lot2.daily-content` fixture
before `result_returning` is advertised in production.

## Consequences

The Go backend remains the user-facing fact source while los gains a durable,
queryable execution and result boundary. The design adds integration-specific
tables and a callback worker, but avoids abusing generic artifact storage or
introducing a parallel workflow framework. It also makes advertised capability
dependent on verified runtime support, preventing the current completed-without-
result ambiguity.
