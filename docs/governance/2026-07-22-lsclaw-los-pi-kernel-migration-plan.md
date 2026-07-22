# lsclaw To LOS: Pi Kernel Decision Record And Migration Plan

- Date: 2026-07-22
- Status: active plan; K0-K2 complete; K3 candidate `0.81.1+los.2` passes
  deterministic evidence 11/11 but has live-provider evidence 0/6; K4 blocked
- Owner: `packages/agent` execution kernel and LOS governance runtime
- Decision: `docs/adr/0039-pluggable-execution-kernel-and-pi-adoption.md`
- Protocol: `contracts/execution-kernel.yaml`

## Conclusion

LOS should use Pi as its near-term execution kernel while retaining LOS as the
authoritative harness for task state, policy, evidence, recovery, and product
workflow. The current LOS loop remains a baseline and future replacement
candidate behind the same protocol.

This direction preserves the useful result of the May LOS reconstruction -- a
single contract and control plane -- without requiring LOS to continue paying
the full maintenance cost of provider transports and turn-loop behavior before
the daily product workflow has proved its value.

## Evidence Scope

The historical claims below come from local repositories and documents:

- `projects/lsclaw` commit history and its May 2026 Pi adapter;
- `projects/los` commit history, ADRs, contracts, and current source;
- archived `docs/archive/seven-project-boundary-spec.md`;
- local Pi reference checkout at
  `304f42d20937ff06e8b63e4e7e330b953dedad76`.

External OpenClaw, Hermes, and Codex observations are architecture references,
not claims about LOS runtime state. Their upstream implementations may change;
the URLs in References identify the reviewed surfaces.

## Historical Timeline

| Date | Observed change | Inference and result |
| --- | --- | --- |
| 2026-02-10 | `lsclaw` first commit `734b16a2`; routing, cancellation, approval, metrics, tenant/RBAC, orchestration, memory, proxy, and administration expanded on the first day | Product and governance scope expanded before one stable daily execution path was measured |
| 2026-02 to 2026-04 | Commit counts were 183, 1036, and 1202 by month | High delivery volume existed, but there was no stable cross-runtime acceptance corpus to separate feature growth from task success |
| 2026-05 | The local loop accumulated checkpoint, critic, policy, graph, context, repair, and retry concerns | Orchestration breadth was used while worker execution was still changing |
| 2026-05-28 | Commit `ce72552a` added Pi single/team/dispatcher runners, deleted `react-loop.mjs`, retained `core-loop.mjs`, and enabled V2 by default | The L1 Pi / L2 governance boundary was directionally correct, but the migration gate measured wiring rather than behavior |
| 2026-05-30 | LOS began at commit `9afcd83` as a TypeScript modular monolith | The restart fixed repository and contract fragmentation but also brought provider and agent-loop ownership back into LOS |
| 2026-06 to 2026-07 | LOS added RunContract, legal transitions, verification, recovery, graph leasing, managed workspaces, Web controls, and pairwise eval evidence | The durable control plane is now the strongest asset; execution-kernel superiority remains unproven |
| 2026-07-22 | The bounded 2-worker plus verifier graph smoke completed 3/3 tasks with one legal graph-owned final transition | Controlled graph execution has a baseline, but Web-first manual integration and serial-versus-graph/kernel comparisons remain open |
| 2026-07-22 | LOS/Pi deterministic second-turn requests matched prompt/history, tool call/result, and parallel policy but differed in reasoning/output defaults and protocol representation | The probe excluded several earlier hypotheses without proving a unique causal field; a new exact adapter candidate is required before live recollection |

Commit volume is diagnostic context, not a quality metric. The historical
failure is the absence of a stable outcome baseline while product scope,
provider behavior, execution loop, orchestration, and UI all changed together.

## What Failed In The 2026-05 Pi Migration

The adapter had concrete lifecycle gaps:

1. `createAgent()` local mode returned metadata rather than a durable Agent.
2. `promptAgent()` constructed a new Agent on every prompt.
3. subscribed events were queued and yielded only after `agent.prompt()`
   resolved, so the local path was not live streaming.
4. `spawnChildAgent()` local mode returned an id without creating persistent
   child state.
5. compaction and final evidence validation were explicitly left as future
   work.
6. `pi-single-runner.mjs` emitted `TASK_COMPLETED` before an independent
   verification decision.
7. the legacy loop remained available without a measured removal gate, leaving
   dual lifecycle semantics.
8. provider output, duplicate-message, and event-shape fixes followed the
   migration declaration, showing that route selection was ahead of parity.

The archived boundary document simultaneously declared the migration complete
and listed an empty-reply provider defect plus a manual generated-file copy.
This is direct evidence that completion meant "components connected", not
"representative tasks accepted".

## What LOS Corrected And What It Repeated

LOS corrected:

- multi-repository contract drift;
- split task, approval, execution, and evidence ownership;
- non-durable task and session truth;
- missing legal transitions, verification gates, leases, and recovery records;
- lack of operator-visible Work Item and graph evidence.

LOS repeated:

- breadth-first implementation before a daily scenario corpus was stable;
- provider, loop, context, tool, orchestration, and product changes in the same
  evaluation window;
- implementation and test evidence being used more often than real task
  acceptance evidence;
- multi-agent work being advanced before a worker-kernel comparison existed;
- treating monorepo consolidation as a reason to reimplement execution
  algorithms already maintained upstream.

The result is not a failed platform. It is a platform whose control-plane
maturity is ahead of its demonstrated end-user execution quality.

## Root Causes

1. **No fixed job-to-be-done baseline.** The projects did not hold a small,
   versioned daily task corpus constant while changing the runtime.
2. **Implementation completion replaced behavioral acceptance.** Modules,
   routes, tests, and default flags were easier to count than first-pass task
   success and operator correction.
3. **Too many moving layers.** Provider adapters, tool behavior, loop state,
   orchestration, persistence, and UI changed together.
4. **Orchestration compensated for worker weakness.** More roles and graph
   structure increased coordination cost before the individual worker was a
   stable baseline.
5. **Repository pain caused an ownership overcorrection.** Removing cross-repo
   calls was necessary; owning every runtime algorithm was not.
6. **Fallback paths lacked deletion criteria.** Parallel old and new paths
   preserved rollback but also preserved incompatible lifecycle semantics.
7. **Governance evidence outpaced quality evidence.** LOS became good at
   proving how a run moved through state without yet proving that its coding
   result was competitive.
8. **External projects were pattern sources, not executable baselines.** Useful
   ideas were copied, but equivalent scenarios were not run before local
   implementation expanded.

## External Project Lessons

| Project | Observed design | Applicable lesson | Boundary for LOS |
| --- | --- | --- | --- |
| Pi | Narrow provider, turn, tool-call, streaming, steering, and context primitives | Use it for L1 execution and keep the adapter thin | Do not give Pi LOS persistence, policy, or success ownership |
| OpenClaw | Embedded a Pi-shaped runtime, established runtime/harness boundaries, then internalized Pi-derived primitives | Replacement follows a stable protocol and proven behavior; it does not begin with a clean rewrite | Internalization and independent invention are different claims |
| Hermes | CLI, gateway, cron, ACP, and batch reuse one central `AIAgent`; delegation reduces child capabilities | One execution core should serve every product entrypoint; child authority should be narrower | Keep LOS's durable RunContract, lease, and verifier semantics instead of copying in-process completion |
| Codex | Thread, turn, interrupt, resume, sandbox, and approval are explicit programmatic concepts | Lifecycle and permission semantics belong in the protocol rather than route-specific glue | External CLI output cannot become LOS state or verification truth |
| LOS | PostgreSQL evidence, AP1/AP2/AP3, graph attempts, leases, managed workspaces, and pairwise eval | This is the durable harness and product differentiation | Stop duplicating low-level provider/turn work without measured need |

## Target Architecture

```text
LOS product and control plane
  Work Item / RunContract / identity / AP gates
  scheduler / graph / lease / workspace / verifier / evidence
                              |
                      ExecutionKernel SPI
                       /             \
               PiKernelAdapter   LosKernelAdapter
                       \             /
                         LOS ToolBroker
```

The authoritative ownership matrix, protocol, checkpoint rules, and upgrade
policy are defined in ADR 0039 and `contracts/execution-kernel.yaml`.

## Delivery Plan

| Phase | Deliverable | Acceptance evidence | Stop condition |
| --- | --- | --- | --- |
| K0 Decision | ADR 0039, history record, contract draft | contract check and reviewed diff | complete 2026-07-22 |
| K1 Protocol | TypeScript kernel/message/event/checkpoint/ToolBroker types plus `LosKernelAdapter` | focused protocol tests and unchanged current behavior through a production entrypoint | complete 2026-07-22: fail-closed registry, local/HTTP/SSH parity, bounded `session_events` projection, and LOS ToolBroker wired |
| K2 Pi deterministic adapter | exact Pi versions, Node alignment, faux-provider golden traces, LOS-owned input mapping | complete: input/telemetry live probe and explicit unsupported-semantic decisions | stop on raw Pi event leakage, direct tool authority, or unowned provider telemetry |
| K3 Shadow | sampled read-only dual runs; Pi result has no user or project effect | candidates `0.81.1` and `0.81.1+los.1` failed at 14/17; `0.81.1+los.2` started at zero evidence, preserves unspecified reasoning/output-limit semantics, and passes deterministic evidence 11/11 | live evidence remains 0/6 and requires operator authorization; K3 remains `collecting` and K4 blocked |
| K4 Read-only canary | explicit planning/inspection kernel selection | persisted plan/evidence and operator-visible rollback | stop on AP2 or transcript drift |
| K5 Write canary | temporary then managed-workspace project writes | ToolBroker policy, lease fencing, verifier records, reviewed diff | stop on any policy or final-transition bypass |
| K6 Graph worker | Pi executes bounded worker tasks; verifier remains independent | worker/verifier attempts, graph completion, manual integration review | stop if child contract or editable surfaces are lost |
| K7 Default Pi | Pi selected by default with per-run rollback | preregistered pairwise non-inferiority and observation window | do not delete LOS baseline during the window |
| K8 LOS replacement | improve components behind `LosKernelAdapter` and compare against current Pi | semantic suite, real-task pairwise metrics, maintenance-cost review | no switch from feature-count parity |
| K9 Cleanup | remove obsolete duplicate provider/loop paths | unused-path proof, checkpoint migration decision, full gate | retain required provenance/license notices |

## Evaluation Matrix

The existing execution experiment and pairwise contracts are the owning
surfaces. Every comparison records the source run, baseline and candidate run
specs, immutable rubric revision, separate human/judge/deterministic evidence,
and exact kernel/provider/model versions.

Required scenario families:

1. no-tool answer and streaming order;
2. typed, malformed, denied, repeated, and parallel tool calls;
3. approval wait, cancellation, steering, and follow-up safe points;
4. provider timeout, rate limit, truncated response, and usage normalization;
5. context pressure, compaction, checkpoint, restart, and resume;
6. planning persistence and approval transition;
7. managed-workspace edit, required verification, and revision;
8. graph worker failure, retry, verifier block, and integration review.

Primary outcome fields:

- verifier-confirmed and first-pass success;
- accepted or revised diff;
- operator interventions and corrections;
- invalid, repeated, denied, and failed tool calls;
- recovery success and context loss;
- elapsed time, provider wait, tokens, cost, and retries;
- AP1/AP2/AP3, workspace, lease, or identity violations.

Promotion thresholds will be written before candidate results are reviewed.
Until that ADR exists, comparisons are evidence collection rather than an
automatic routing decision.

## Pi Upgrade And Collaboration Policy

1. Track exact versions and upstream commits; do not use caret ranges.
2. Separate update discovery from promotion.
3. Run deterministic traces before any live-provider or write canary.
4. Record configured and effective kernel, provider, and model independently.
5. Prefer upstream hooks and contributions for generic lifecycle gaps.
6. Keep any LOS fork patch queue small, documented, and rebase-tested.
7. Maintain one prior accepted Pi version for per-run rollback during the
   observation window.
8. Do not copy upstream code without provenance and license review.

## Replacement Decision

Pi removal is justified only after protocol independence, semantic coverage,
real-task non-inferiority, production rollback, and maintenance economics all
pass. Removing the package while retaining Pi-derived internals is dependency
internalization. Claiming an independent LOS kernel requires a separately
maintained implementation and sustained evidence against the current Pi
baseline.

The parent daily-agent product remains `in_progress` while Web-first manual
acceptance and graph integration review are incomplete. K0 has its required
documents and a passing contract check. K1 has a tested LOS adapter, a
fail-closed registry used by scheduler and executor entrypoints, HTTP/SSH
protocol parity, and an owned durable event projection in the existing
`session_events` ledger. The current loop also crosses an explicit
`LosToolBroker` without weakening its existing policy, pre-action, state,
retry, and evidence behavior. K2a pins `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` at `0.81.1`, aligns LOS with Node `>=22.19.0`, and adds
an unregistered adapter whose deterministic tests cover no-tool, brokered tool,
denial, provider failure, interrupt, exact-version checkpoint, and resume.
K2b now constructs a single-model Pi runtime from the LOS-resolved provider,
credential, profile, canonical history, and governed tool catalog. Its mapped
ToolBroker probe and the bounded live DeepSeek probe both pass; the latter is
recorded in `docs/operations/2026-07-22-pi-kernel-provider-input-probe.md`.
The live trace also produced one LOS `provider_call_telemetry` row with the
effective provider/model, Pi API shape, HTTP status, duration, and normalized
usage. Pi is still not registered or selectable. Explicit admission decisions
now keep provider fallback, context compression, and unsupported settings fail
closed, while architect/editor and child agents remain LOS-owned orchestration.
K3 adds an explicit local read-only scheduler shadow with derived candidate
lineage and bounded comparison evidence. Its first live no-tool DeepSeek run
completed with equal output hashes and isolated provider/kernel evidence. The
existing unknown-`pi` scheduler behavior remains fail closed. Corrected corpus
`1.0.1` completed all 17 observations: 16 passed, while one live read-only-tool
run failed only byte-level output-hash equality after matching the tool
sequence, successful tool state, terminal state, and actual input lineage.
Corpus `1.1.0` / rubric `pi-shadow-readonly-v2` is now preregistered with a
typed JSON `packageName` comparator. Candidate `0.81.1` completed 14/17: all
three live tool scenarios produced the expected candidate task value but made
two actual brokered reads while LOS made one. Candidate `0.81.1+los.1` mapped
`supportsParallelToolCalls=false`, started with zero qualifying observations,
and also completed 14/17. Its three typed values and terminal assertions passed,
but each candidate made a full read followed by a narrower read in the next
turn. The parallel-call hypothesis is therefore falsified as the root cause.
Corpus `1.0.0` remains persisted but ignored because its lineage assertion was
not bound to the Pi input. The second-turn envelope probe verified matching
prompt/history, tool call/result, normalized tool schema, and
`parallel_tool_calls=false`, while Pi added explicit reasoning/output defaults
and several protocol-shape fields. Exact candidate `0.81.1+los.2` started with
zero qualifying observations, preserves unspecified reasoning/output-limit
semantics, and passes the revised envelope plus all 11 deterministic corpus
requirements. Its six live-provider requirements remain unobserved, so K3
remains `collecting` and K4 remains blocked. Explicit `thinking='enabled'`
mapping remains a compatibility gap for broader promotion. The pre-corpus
smoke remains excluded rather than retroactively labeled. `pnpm --filter
@los/agent scenario:pi-shadow` reads current status without invoking a provider.

## Active Work Ledger

These identifiers are owned by this plan until they are persisted as structured
LOS todos. Their status here must not be presented as database todo state.

| Work id | Status | Deliverable |
| --- | --- | --- |
| `kernel-k0-decision-record` | complete in this document; not a DB todo | ADR, history record, contract, roadmap, and contract check |
| `kernel-k1-los-adapter` | complete in repository; not a DB todo | TypeScript protocol, registry-driven local/HTTP/SSH `LosKernelAdapter`, bounded durable event projection, and LOS ToolBroker |
| `kernel-k2-pi-deterministic` | complete; registry admission remains separate | exact dependencies, deterministic adapter, LOS input/catalog mapping, provider telemetry, live no-tool probe, and explicit unsupported-semantic decisions |
| `kernel-k3-shadow` | `0.81.1+los.2` deterministic evidence complete; live evidence pending authorization | failed candidate records remain immutable; current candidate is 11/11 deterministic, 0/6 live, and `collecting` |
| `kernel-k4-k6-canary` | pending | read-only, write, and graph-worker canaries |
| `kernel-k7-default-promotion` | pending | preregistered eval and default Pi decision |
| `kernel-k8-los-replacement` | pending | independent LOS candidate and replacement economics |

## References

- `docs/adr/0039-pluggable-execution-kernel-and-pi-adoption.md`
- `contracts/execution-kernel.yaml`
- `contracts/execution-experiment.yaml`
- `contracts/execution-pairwise-eval.yaml`
- `docs/adr/0038-web-first-daily-coding-agent-product-boundary.md`
- `docs/governance/2026-07-18-los-pi-harness-capability-and-operability-audit.md`
- `docs/operations/2026-07-22-pi-kernel-shadow-adapter-revision-result.md`
- `docs/operations/2026-07-22-pi-kernel-second-turn-envelope-probe.md`
- `docs/operations/2026-07-22-pi-kernel-semantic-default-revision-result.md`
- archived `docs/archive/seven-project-boundary-spec.md`
- Pi AgentHarness lifecycle:
  <https://github.com/earendil-works/pi/blob/main/packages/agent/docs/agent-harness.md>
- OpenClaw runtime architecture:
  <https://docs.openclaw.ai/agent-runtime-architecture>
- Hermes architecture:
  <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md>
- OpenAI Codex documentation: <https://developers.openai.com/codex/>
