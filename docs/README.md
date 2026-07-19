# los Documentation Index

This directory is the project-owned documentation surface for `los`. It should
answer project-specific questions that do not belong in global agent rules or
in the broader `los-workspace` legacy-boundary docs.

## Read Order

1. `../AGENTS.md` - project rules, architecture principles, commands, and AI
   change-management requirements.
2. `../SKILL.md` - repeated los-specific workflows for runtime truth,
   ADR/source reconciliation, provider gates, and periodic governance.
3. `adr/` - accepted or proposed design decisions.
4. `operations/` - live smoke records and current runtime evidence.
5. `governance/` - recurring analysis, documentation hygiene, and agent-use
   evaluation practices.
6. `research/` - exploratory notes that are not yet design policy.

## Truth Surfaces

Keep these surfaces separate when writing or reviewing docs:

| Surface | Owner | Use it for |
| --- | --- | --- |
| Config truth | `.env`, `~/.los/config.yaml`, package scripts, workspace config | What the system is configured to do |
| Runtime truth | `pnpm run status`, `pnpm run executor:status`, health endpoints | What is running now |
| Persisted evidence | `task_runs`, `session_events`, `executor_nodes`, `service_instances` | What actually executed or was registered |
| Design intent | `docs/adr/` | Why the project chose a direction |
| Live proof | `docs/operations/` | Exact commands and observations from a smoke |
| Governance queue | `docs/governance/`, todos, ADR gaps | What should be checked or improved next |

Do not use one surface as a substitute for another. For example, a healthy
gateway does not prove provider compatibility, and an ADR does not prove the
current implementation still matches it.

## Core Document Sets

### ADRs

Use `docs/adr/` for durable decisions. Important current ADRs:

- `0012-service-cluster-and-stateful-agent-roadmap.md` - service, execution,
  and run orchestration planes.
- `0014-testing-strategy-and-regression-gates.md` - required checks by change
  type.
- `0016-omx-tool-level-logging-scope.md` - boundary between external OMX logs
  and los-owned `session_events`.
- `0017-advisory-provider-promotion-playbook.md` - provider compatibility
  target states and promotion evidence.
- `0018-cli-fallback-gate.md` - requirements before any external CLI fallback.
- `0021-stage-b-operator-contract-implemented-state.md` - Stage B operator
  contract current-state declaration: fields, routes, state machines, gates,
  and evidence coverage.
- `0025-conversation-run-coordinator-boundary.md` - boundary between interactive
  coordination, persisted run state, bounded workers, GA governance jobs, and
  operator-gated memory.
- `0030-provider-account-credential-and-quota-boundary.md` - provider account
  identity, credential refresh safety, quota snapshots, explicit selection,
  and effective-call provenance.
- `0031-programmatic-agent-interface-over-mcp.md` - supported stdio MCP client
  adapter over the existing run, replay, and operator-control contracts.
- `0032-managed-jj-workspace-operations.md` - operator-gated jj workspace
  allocation and artifact-backed cleanup evidence for graph tasks.

### Operation Smokes

Use `docs/operations/` for dated runtime evidence. A smoke should record:

1. exact command or API call;
2. relevant ids such as `taskRunId`, `sessionId`, `requestId`, `traceId`,
   `nodeId`;
3. process/API/DB status observed;
4. what was verified and what remains unverified.

Use `operations/node-deployment-runbook.md` for executor bootstrap, rollout,
rollback, and offline-node reactivation. Keep dated node evidence in a separate
operation smoke.

Use `operations/database-migrations.md` for migration ownership, startup
application behavior, drift validation, and failure handling. Use
`operations/github-mirror-recovery.md` when the secondary GitHub `main` has
diverged from Forgejo and requires an explicitly approved lease-protected repair.

Use `operations/programmatic-agent-interface.md` for external agent access and
`operations/managed-workspaces.md` for operator-gated jj workspace allocation,
backup evidence, and release.

### Governance

Use `docs/governance/` for repeated analysis practices. Start with
`governance/periodic-analysis.md` when using `los` as the main execution and
review tool.

Use `governance/anti-patterns.md` when reviewing repeated los development
failure modes such as execution-state bypass, non-persisted plans, premature
success marking, stale spec loading, missing child-agent contracts, delayed
checks, or default-value drift.

Use `governance/agent-workflow-roadmap.md` when deciding how personal
high-autonomy agent workflows should affect `los` stage goals, evals,
toolchain governance, and future run metadata.

Use `governance/agent-execution-gap-plan.md` when comparing Codex, Claude
Code, Reasonix, OpenCode, and OMX against current `los` execution gaps and
deciding which missing capability should become docs, tests, runtime state, or
a future ADR.

Use `governance/hermes-web-ui-reference-plan.md` when comparing Hermes Web UI
patterns against `los` and deciding which UX, run-state, node-pairing,
provider-evidence, or harness ideas should become local work items.

Use `governance/2026-07-18-los-pi-harness-capability-and-operability-audit.md`
for the verified LOS capability map, concrete CLI/Web/MCP/channel/workspace
operator paths, and the current boundary against pi and Hermes Agent.

Use `governance/github-branch-gates.md` when pushing, opening PRs, merging to
`main`, checking GitHub Actions gate requirements, or separating local gate
results from GitHub branch protection and ruleset state.

Use `governance/branch-lifecycle.md` when pruning stale remotes after an
integration merge, aligning forgejo with `origin/main`, or deciding when a
short-lived branch has met observation metrics and can be deleted.

Use `governance/manual-node-pairing-plan.md` when adapting manual device or
node-pairing ideas to the existing `los` node registry, probe, and scheduler
eligibility model.

Use `governance/provider-promotion-evidence-display-plan.md` when deciding how
provider compatibility evidence should appear in API, CLI, and Web UI surfaces.

Use `governance/run-chain-changes/` when a change affects `/chat`, scheduler,
executor dispatch, provider gates, verification records, or run-inspection UI
and needs a small behavior-impact fragment.

Use `governance/run-contract-template.md` when a larger agent run needs an
explicit mode, editable scope, required checks, stop conditions, evidence
requirement, and commit boundary before execution.

Use `governance/toolchain-matrix.md` when deciding which external agent tool is
appropriate for a task and whether its output can be used only as external
summary input or needs a future ingestion ADR.

Use `governance/eval-backlog.md` when turning repeated agent failure modes into
review checklists, tests, harness probes, operation smokes, or runtime metrics.

Use `governance/coordinator-scenario-eval-set.md` for the fixed owner-routing,
artifact, review, code, recovery, verification, and memory scenarios required
before coordinator automation or model tiering can be considered.

## Documentation Rules

1. Keep project-specific runtime contracts in this repo, not in global
   `~/.codex/AGENTS.md`.
2. Keep workspace legacy-boundary rules in `../../../WORKSPACE.md` and
   `../../../AGENTS.md`.
3. Keep raw transcripts, auth snapshots, provider secrets, and local session
   dumps out of version control.
4. When a doc claims current behavior, cite source paths, commands, DB/API
   rows, or operation smoke evidence.
5. When a doc records a plan, state which verification surface will prove it.
