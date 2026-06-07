# Hermes Web UI Reference Plan

Date: 2026-06-07

## Purpose

This note records what `los` should learn from
`EKKOLearnAI/hermes-web-ui` after a read-only comparison against the local
`los` repository and the current GitHub main branch of Hermes Web UI.

It is a planning surface, not an ADR. Promote an item to an ADR, contract, test,
or implementation task only after the owning `los` module has been inspected.

## Evidence Used

Verified local `los` surfaces:

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/governance/agent-execution-gap-plan.md`
4. `docs/governance/agent-workflow-roadmap.md`
5. `docs/governance/toolchain-matrix.md`
6. `docs/architecture/2026-06-02-next-work-items.md` in the workspace root
7. `jj status`, `jj log`, and `jj bookmark list` in `projects/los`

Verified Hermes Web UI surfaces from a fresh shallow clone:

1. GitHub main HEAD: `efff9c4` on 2026-06-07,
   `Add manual remote device pairing (#1384)`.
2. `package.json` package version: `0.6.11`.
3. `ARCHITECTURE.md`
4. `AGENTS.md`
5. `docs/cli-chat-sessions.md`
6. `docs/chat-chain-changes/`
7. `docs/harness/validation.md`
8. `packages/client/src`, `packages/server/src`, and `packages/desktop`

## Current los Baseline

`los` is the active project in `los-workspace`; legacy projects are reference
sources by default. New work should land under `projects/los/` unless a legacy
hotfix is both current-runtime-affecting and not yet covered by `los`.

Current `los` direction:

1. PostgreSQL-first persistence, including single-node local deployments.
2. `task_runs`, `session_events`, `executor_nodes`, and `service_instances` as
   `los`-owned evidence surfaces.
3. Contract-first boundaries under `contracts/`.
4. Provider readiness, advisory targets, and compatibility gates separated from
   credential discovery.
5. Current execution gaps around run contracts, recovery-grade replay,
   scheduler recovery, provider promotion evidence, and eval feedback.

## Hermes Web UI Module Map

| Hermes area | Observed implementation | los comparison | Reuse posture |
| --- | --- | --- | --- |
| Client UI | Vue 3, Pinia stores, API wrappers, i18n, Naive UI components | `los` uses React in `packages/web` and Fastify-backed API helpers | Reuse UX structure only; do not port framework code |
| Server API | Koa routes, controllers, services, middleware, SQLite stores | `los` uses gateway routes and package-level modules with PostgreSQL | Reuse route/controller/service separation where it reduces large route files |
| Chat runtime | Socket.IO `/chat-run`, `ChatRunSocket`, queue, resume, abort, approval, clarify | `los` has `/chat`, SSE/session events, task runs, tool states, and recovery gaps | Reuse state-machine semantics, not Socket.IO as a required transport |
| Chat chain docs | One stable chain doc plus one fragment per PR in `docs/chat-chain-changes/` | `los` has ADRs, operation smokes, and governance docs, but no per-change chain fragments | Strong candidate for a low-risk governance task |
| Session database | Web UI-owned SQLite sessions/messages, Hermes state read-only for history | `los` owns PostgreSQL state and must not add SQLite fallback | Do not reuse storage model |
| Device pairing | LAN discovery, manual URL pairing, signed nonce, inbound/outbound relation states | `los` has executor nodes, service instances, connect config, candidate status | Reuse manual-pairing UX and state taxonomy after mapping to existing tables |
| Peer tools | WebSocket peer file transfer, exec, terminal with approval relation | `los` has executor HTTP endpoints, artifact transfer, node commands | Reuse capability vocabulary only after contract review |
| Coding agents page | Install/status/config/launch for Codex and Claude Code | `los` treats external tools as external-only until ingestion ADR exists | Reuse as operator-facing config inspiration, not as runtime ingestion |
| Provider/model management | Provider CRUD, OAuth/device flows, model discovery, visibility | `los` already separates readiness and compatibility evidence | Reuse evidence display patterns for provider promotion history |
| Harness docs | Change-type validation matrix and harness check | `los` has ADR 0014 and `pnpm check`, but less task-type command mapping | Reuse as executable validation-map pattern |
| Desktop runtime | Electron shell, bundled runtime, platform releases | `los` is currently local/web/CLI oriented | Defer; not a current architecture gap |

## What los Should Absorb

### H1. Per-Change Run Chain Fragments

Hermes keeps one stable Chat chain document and requires one fragment per PR
when Chat, bridge, compression, or Group Chat runtime paths change.

For `los`, the equivalent should cover:

1. `/chat` request and streaming behavior.
2. scheduler and executor dispatch.
3. `run_specs`, `task_runs`, `session_events`, and `tool_call_states`.
4. verifier runner and required-check blocking.
5. provider compatibility and promotion decisions.

Recommended owner: `docs/governance/` first, then a harness check if the rule
becomes repeated.

Expected proof: a docs-only change can pass `./tools/check-contracts.sh`; a
later harness change should fail when a runtime-chain source file changes
without a fragment.

### H2. Recovery-Grade Chat State Semantics

Hermes explicitly models run queueing, resume, abort, approval, clarify, and
compression state on one session channel. `los` already has stronger durable
evidence than Hermes in some areas, but the operator-facing contract is still
less explicit.

For `los`, translate this into:

1. `run_specs` contract fields visible before execution.
2. `/runs/:id/events?since=...` as the stable event cursor surface.
3. UI/CLI status that shows queued, running, awaiting approval, awaiting
   clarification, verifying, failed, and completed states.
4. scheduler consumption of tool recovery decisions.

Recommended owner: `docs/governance/agent-execution-gap-plan.md` until API
shape changes require ADR 0012 or contract updates.

Expected proof: focused gateway/agent tests plus an operation smoke for
interrupted run review.

### H3. Manual Node Pairing UX

Hermes main added manual remote device pairing on 2026-06-07. The useful pattern
is the operator flow:

1. enter a remote URL;
2. fetch signed device identity;
3. persist an outbound request status;
4. show online, pending, approved, rejected, and blocked states;
5. connect only after approval.

For `los`, map this to node configuration:

1. manual executor/gateway endpoint entry;
2. identity and capability probe;
3. `connectConfig` update;
4. candidate eligibility display;
5. relation status kept separate from runtime health.

Recommended owner: Node UI and gateway node routes after checking
`contracts/node-registry.yaml` and `packages/agent/src/executor-nodes.ts`.

Expected proof: node-route tests and a live node operation smoke.

### H4. Provider Promotion Evidence UI

Hermes has a broad provider/model UI. `los` should not copy its provider store,
but it should make provider promotion evidence visible:

1. configured credential source;
2. readiness blocker;
3. advisory or required target;
4. last compatibility run;
5. task/session evidence ids;
6. usage and failed-tool summary when available.

Recommended owner: `packages/agent` provider compatibility evidence,
gateway provider routes, then `packages/web` Providers page.

Expected proof: compat harness test, provider route test, and a Providers page
smoke when UI changes.

### H5. Mechanical Validation Matrix

Hermes maps change type to minimum checks. `los` has ADR 0014, but the command
selection can become more mechanical.

For `los`, add or refine a repo-local validation map for:

1. docs-only changes;
2. contracts/API changes;
3. gateway route changes;
4. agent scheduler/tool-policy changes;
5. web UI changes;
6. executor/node-command changes;
7. provider compatibility changes.

Recommended owner: ADR 0014 plus a script or docs checklist only after the
first repeated failure.

Expected proof: `pnpm check`, package tests, and later a harness script that
validates required docs exist.

## What los Should Not Absorb Now

1. Do not introduce SQLite as a `los` runtime state fallback.
2. Do not replace Fastify/SSE with Koa/Socket.IO only because Hermes uses it.
3. Do not port Vue/Naive UI components into the React web package.
4. Do not add a Python bridge runtime path for normal execution.
5. Do not ingest Hermes, Codex, Claude Code, Reasonix, or OMX raw transcripts
   without a redaction and provenance ADR.
6. Do not make Electron desktop packaging a current milestone before the
   evidence harness and recovery state are stable.

## Execution Queue

| Priority | Task | Owner surface | Validation |
| --- | --- | --- | --- |
| P0 | Add run-chain change fragment policy for `los` chat/scheduler/tool-state changes | `docs/governance/` and `docs/README.md` | `./tools/check-contracts.sh` |
| P1 | Add manual node pairing design note mapped to `node-registry` and executor nodes | governance doc first; contract/API after review | contract read + focused node-route tests when implemented |
| P1 | Add provider promotion evidence display plan | `agent-execution-gap-plan.md`, provider routes, web Providers page | compat harness + provider route test |
| P2 | Expose recovery-grade run state vocabulary in CLI/UI | `run_specs`, gateway routes, web/CLI | agent/gateway tests + operation smoke |
| P2 | Convert ADR 0014 into a more mechanical validation matrix | ADR 0014 and tools script if repeated | `pnpm check` plus harness script |
| P3 | Revisit external coding-agent config pages as an operator-only surface | toolchain matrix and external-summary ADR boundary | no raw transcript import |
| Defer | Desktop runtime packaging | future product packaging plan | not current |

## First Implementation Slice

Start with P0 because it is docs-first, low risk, and supports later runtime
changes. The first slice should:

1. create a `docs/governance/run-chain-changes/README.md` policy;
2. add an initial fragment for the recent `feat/agent-enhancements` chat and
   web-console changes;
3. link the policy from `docs/README.md`;
4. keep it advisory until a later harness script can enforce it.

This keeps the immediate change reversible while giving future runtime changes
a concrete place to record behavior impact.

Status on 2026-06-07: started in
`docs/governance/run-chain-changes/` with an initial fragment for
`feat/agent-enhancements`.
