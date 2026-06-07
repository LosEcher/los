# Provider Promotion Evidence Display Plan

Date: 2026-06-07

## Purpose

This note records how `los` should expose provider compatibility and promotion
evidence to operators. The current code already stores and displays part of
this evidence; the remaining work is to make the history and decision boundary
clearer.

## Current Evidence

Current implementation:

1. `packages/agent/src/provider-compat-evidence.ts` owns the
   `provider_compat_evidence` table and records provider, model, probe,
   decision, pass/fail state, session/task/run ids, token usage, and summary
   JSON.
2. `packages/agent/src/compat-harness.ts` defines required and advisory
   compatibility targets.
3. `packages/cli/src/compat.ts` records compat evidence after executed runs.
4. `packages/cli/src/provider.ts` lists provider readiness and promotion state
   from `/onboarding`.
5. `packages/gateway/src/server.ts` loads latest provider compat evidence for
   `/onboarding` and sanitizes provider discovery output.
6. `packages/web/src/pages.tsx` Providers page renders provider readiness and
   compatibility badges.
7. ADR 0017 defines advisory, verified advisory, required, and blocked
   promotion decisions.

Judgment: the base evidence model exists. The missing surface is a clear
operator view that explains why a provider is advisory, verified advisory,
required, or blocked, and which evidence ids support that state.

2026-06-07 decision: `los provider promote` remains a credential setup and
operator guidance command. It must not persist required-gate decisions or
change compatibility policy. Persisted compatibility evidence comes from
`los compat --execute` through `provider_compat_evidence`; future
promotion/demotion policy commands should be separate and should update ADR,
harness, and required-target code surfaces together.

2026-06-07 follow-up: proposed required-target promotion/demotion decisions are
now explicit records in `provider_promotion_decisions` and can be created with
`los provider policy promote|demote` or `POST /providers/promotion-decisions`.
These records do not enforce gates by themselves; they preserve the decision
and evidence link until ADR, harness, target lists, and operation evidence can
be changed together.

## Display Goals

The Providers UI and CLI should answer these questions without requiring a SQL
query:

1. Which providers are configured, discovered, ready, or blocked?
2. Which models have passing compatibility evidence?
3. Which probe produced that evidence?
4. Which `sessionId`, `taskRunId`, `runSpecId`, `traceId`, or `requestId`
   supports the claim?
5. Was the decision advisory, verified advisory, required, or blocked?
6. What was the token cost and tool outcome?
7. What is the next action: configure key, run advisory probe, promote, keep
   advisory, or demote/block?

## Proposed Surfaces

### API

Short term:

1. Keep `/onboarding` as the summary surface.
2. Include only bounded latest evidence per provider/model/probe.
3. Do not leak API keys, raw prompts, raw model output, or full transcripts.

Next API:

```text
GET /providers/compat-evidence
GET /providers/compat-evidence?provider=deepseek
```

Response should include:

1. provider, model, probeId, targetLabel;
2. decision and passed;
3. sessionId, taskRunId, runSpecId, traceId, requestId, nodeId;
4. totalTokens;
5. summary fields limited to tool names, failed tool count, denied tool count,
   completion state, and failure messages;
6. createdAt and updatedAt.

### Web UI

Providers page should keep the compact badge row, then add an inspectable
details area:

1. readiness summary;
2. latest compatibility evidence;
3. required/advisory target status;
4. linked session/task ids where routes exist;
5. recommended next command, for example:

```bash
./bin/los compat --execute --target <provider:model> --probe read-context --workspace .
```

Do not make the UI promote targets to required until code/policy surfaces can
be updated together.

### CLI

`los provider list` should eventually show:

```text
provider  ready  promotion          latest evidence
deepseek  yes    verified_advisory  deepseek-v4-pro/read-context task-...
openai    yes    advisory           no passing evidence
anthropic no     blocked            ANTHROPIC_API_KEY not set
```

`los compat --execute` already records evidence; keep that path as the source
of promotion proof.

## Decision Rules

1. Readiness from `/onboarding` is configuration visibility, not compatibility.
2. A passing `los compat --execute` run can mark a target verified advisory.
3. A target becomes required only when code and policy surfaces are updated
   together:
   - `DEFAULT_COMPATIBILITY_TARGETS`
   - `ADVISORY_COMPATIBILITY_TARGETS` if needed
   - ADR 0014
   - ADR 0017 or a follow-up ADR if the policy changes
   - operation smoke evidence
4. OAuth-like or local-session credentials stay advisory unless a CI-safe
   credential owner, quota rule, and refresh behavior are documented.
5. Failed evidence must stay visible enough to explain why a provider is
   blocked or remains advisory.

## Implementation Order

Implemented first slice:

1. `GET /providers/compat-evidence` exposes bounded provider/model/probe
   evidence with redacted summary fields.
2. `/onboarding` provider rows include traceable latest passing evidence.
3. Providers page renders latest evidence id, task/run ids, and token count.
4. `los provider list` prints latest evidence ids and the fallback compat
   command when a ready provider has no passing evidence.

Remaining order:

1. Operation smoke is recorded in
   `docs/operations/2026-06-07-provider-compat-evidence-display-smoke.md`
   for API, CLI, and Web provider evidence display.
2. Promote proposed promotion/demotion decisions into enforced target-list
   changes only after required-target policy is updated together with ADR and
   harness expectations.

## Verification

Docs-only design step:

```bash
./tools/check-contracts.sh
```

API implementation:

```bash
pnpm --filter @los/gateway test
pnpm check
```

Web implementation:

```bash
pnpm --filter @los/web test
pnpm --filter @los/web check
```

Live evidence smoke:

```bash
./bin/los compat --execute \
  --target deepseek:deepseek-v4-flash \
  --probe read-context \
  --workspace .

curl -fsS http://127.0.0.1:8080/onboarding
```

The smoke should record the provider target, `sessionId`, `taskRunId`, token
usage, tool outcome, and the UI/API surface that displays it.

## Non-Goals

1. Do not expose raw provider credentials.
2. Do not store raw model transcripts in provider evidence.
3. Do not promote every ready provider into a required gate.
4. Do not treat one passing advisory run as a required-gate decision.
5. Do not make `los provider promote` mutate compatibility policy.
