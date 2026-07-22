# ADR 0039: Pluggable Execution Kernel And Pi Adoption

- Status: Accepted
- Date: 2026-07-22
- Implementation status: K0-K2 complete; K3 explicit read-only shadow is
  implemented with an initial live record. Local, HTTP executor, and SSH
  executor paths still select only the LOS adapter through the fail-closed
  production registry. Pi remains comparison-only and is not selectable.
- Supersedes: ADR 0007 for execution-kernel ownership and default-runtime
  selection only

## Context

LOS has a durable control plane: Work Items, RunContracts, task and run state,
leases and fencing, graph attempts, verification records, managed workspaces,
operator controls, and pairwise execution evidence. Its current built-in loop
also owns provider transport, message normalization, turn continuation, context
management, tool-call repair, and completion production.

That ownership split is not required by the control-plane invariants. A
low-level execution library can run model turns without owning LOS persistence
or introducing a second task state machine. ADR 0007 correctly rejected
framework-owned state and ungoverned CLI fallback, but treated those concerns
as reasons for LOS to own the complete provider and turn loop. This combined
two separate decisions:

1. LOS must own durable execution truth and governance.
2. LOS must implement every algorithm used to produce an agent turn.

Only the first decision is an invariant.

The legacy `lsclaw` project reached the intended layer split on 2026-05-28:
Pi owned the L1 agent runtime while `lsclaw` owned L2 governance. That migration
did not establish a sound protocol. The local adapter recreated an Agent for
each prompt, buffered subscribed events until the prompt completed, returned
child identifiers without durable child instances, and left compaction and
final evidence validation as future work. It then emitted task completion from
the Pi loop while retaining the legacy loop as a fallback. The lesson is not
that Pi is the wrong boundary; it is that dependency wiring is not migration
evidence.

## Decision

LOS will introduce a provider-neutral `ExecutionKernel` protocol. Pi will be
the first external implementation and is intended to become the default kernel
after shadow and canary gates. The existing LOS loop will first be wrapped as
`LosKernelAdapter`, remain the production baseline during comparison, and then
become a candidate and rollback kernel.

The Web, gateway, scheduler, graph, and verification paths continue to use LOS
contracts. They select a kernel through an LOS-owned registry; they do not call
Pi types or provider-native messages directly.

```text
Web / CLI / MCP / Gateway / Scheduler
                  |
          LOS governed runtime
 WorkItem / RunContract / AP gates / graph / lease / verifier
                  |
          ExecutionKernel registry
          /          |          \
   PiKernelAdapter  LosKernelAdapter  future adapters
                  |
             LOS ToolBroker
      policy / approval / sandbox / executor
```

The protocol draft lives in `contracts/execution-kernel.yaml`.

## Ownership Boundary

| Concern | LOS | Execution kernel |
| --- | --- | --- |
| Work Item, RunContract, approved plan | authoritative | receives bounded input |
| task/run/graph state and final transition | authoritative | no direct write |
| tenant, identity, workspace, policy, approval | resolves and enforces | consumes resolved capabilities |
| tool execution | ToolBroker authorizes and executes | requests a canonical tool call |
| provider transport and message normalization | records effective evidence | performs invocation |
| turn/tool continuation | observes and limits | performs loop |
| steering, follow-up, interrupt | persists operator intent | consumes at safe points |
| transcript | canonical event/message projection | produces canonicalizable messages |
| checkpoint | stores identity and bytes | produces and consumes private format |
| verification and success | authoritative | may only report `kernel.finished` |

`kernel.finished` means the kernel stopped normally. It does not mean the task
or run succeeded. Only LOS may call `transitionExecutionState()`, and every
successful final transition remains subject to `canMarkSucceeded()` and the
required verification records.

## Canonical Protocol

The first implementation phase defines TypeScript equivalents of:

- `ExecutionKernel`;
- `KernelRunInput` and `KernelResumeInput`;
- `KernelEvent` and `KernelResult`;
- `KernelCheckpoint`;
- `KernelCapabilities`;
- canonical message and tool-call types;
- `ToolBroker`.

As of 2026-07-22, `packages/agent/src/execution-kernel.ts` defines the protocol,
wraps `runAgent()` as the LOS implementation, and is called by the local path in
`scheduler/scheduled-task-runner.ts`. The adapter preserves the existing loop
callbacks and emits ordered canonical in-process events. Task metadata records
the kernel kind, version, and protocol version. The scheduler-owned
`kernel-event-projection.ts` persists audit-tier event summaries to the existing
`session_events` ledger, including sequence, lineage, kernel identity, usage,
and bounded lifecycle evidence. It does not duplicate raw message deltas, tool
arguments, or checkpoint contents. The existing loop still builds its governed
tool catalog, but execution now crosses `LosToolBroker`, which owns capability
and phase decisions, pre-action checks, state callbacks, canonical events,
registry invocation, retry evidence, and persisted retrieval evidence.
`execution-kernel-registry.ts` selects the adapter for both scheduler and
executor entrypoints; only `los` is registered, it is the explicit default,
and unknown kinds fail before task-run creation. HTTP and SSH requests carry
`executionKernelKind`, and both NDJSON readers forward canonical
`kernel_event` chunks to the scheduler-owned durable projection. These
properties complete K1; they do not constitute Pi adoption.

Every attempt persists `kernel_kind`, exact `kernel_version`, and
`kernel_protocol_version`. Provider-native objects and Pi event types remain
inside `PiKernelAdapter`. Gateway routes and Web projections consume only LOS
events.

One LOS component owns each durable write. The adapter may produce an event or
checkpoint, but it may not write `task_runs`, `run_specs`, `session_events`,
tool-call state, verification records, or graph attempts.

## Tool Boundary

Pi tools will be descriptors backed by the LOS ToolBroker rather than Pi coding
tools with direct filesystem or shell authority. The ToolBroker receives the
canonical call id and the already resolved run context, then applies:

1. run phase and tool-mode policy;
2. tenant, project, workspace, and editable-surface bounds;
3. approval and pre-action gates;
4. sandbox or executor routing;
5. timeout, cancellation, lease, and fencing checks;
6. canonical tool state and evidence persistence.

The kernel receives the bounded result needed for the next turn. It does not
receive database handles, operator credentials, or unrestricted workspace
resolution.

## Pi Integration Choice

The first adapter uses Pi's low-level agent-loop and provider packages. It does
not initially adopt the complete `AgentHarness` lifecycle or Pi coding tools.

The local Pi reference at commit `304f42d20937ff06e8b63e4e7e330b953dedad76`
documents provisional settlement semantics and pending work for lifecycle
reentrancy, automatic compaction/retry, and some session-facade behavior. LOS
already owns durable sessions and recovery, so importing both lifecycle owners
in the first step would make failures harder to classify. The adapter may move
internally to `AgentHarness` later if its lifecycle becomes migration-ready and
the canonical LOS protocol remains unchanged.

Pi is an implementation dependency, not the source of LOS contracts. K2a pins
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to `0.81.1` and
raises the LOS Node declaration to Pi's required `>=22.19.0`; the verified local
runtime is Node `24.14.0`. `pi-execution-kernel.ts` translates the low-level Pi
event stream to LOS events, delegates every declared tool to an injected LOS
`ToolBroker`, and supports exact-version message checkpoints. Deterministic
faux-provider tests cover no-tool, brokered tool, denial, provider failure,
interrupt, checkpoint, and resume behavior. The adapter is deliberately not
registered in the production kernel registry. K2b now maps the resolved LOS
profile, credential, canonical history, model limits, and ToolRegistry catalog
into a single-model Pi runtime. A live no-tool DeepSeek probe passed through
that input path and the canonical adapter. The input adapter fails closed on
provider fallback, architect-editor, context compression, and model settings
that do not yet have equivalent Pi semantics. The Pi stream wrapper records
LOS-owned provider-call telemetry with trace/session, effective provider/model,
API shape, status, duration, and normalized usage. K3 adds an explicit
scheduler-owned Pi shadow that forces read-only policy, derives candidate
session/task/trace lineage, and writes only a bounded hash/count comparison to
the production session. The first live DeepSeek no-tool scheduler shadow
completed with equal output hashes and separated evidence. Corpus `1.0.0` now
preregisters no-tool, read-only-tool, broker-denial, provider-failure, and
interruption observations against rubric `pi-shadow-readonly-v1`. Readiness is
keyed by exact kernel and protocol version and cannot trigger registry
admission. The earlier live smoke predates the corpus and is not retroactively
counted. Production registration remains blocked on completing these
observations and a later canary decision; Pi is still absent from the
production registry.

Pi `0.81.1` documents low-level `agentLoop` streams as observational: their
consumer callbacks are not producer barriers. The adapter therefore uses
`runAgentLoop` with an awaited event sink and acknowledges each canonical LOS
event before Pi advances. Tool authority is enforced through the actual Pi
tool `execute` callback, not inferred from a later event subscription.

## Checkpoints And Resume

LOS stores two separate surfaces:

1. a canonical transcript and event projection used for replay, evaluation,
   audit, and cross-kernel comparison;
2. an opaque kernel checkpoint identified by kernel, exact version, protocol
   version, and checkpoint codec.

A checkpoint accelerates or improves resume but cannot replace the canonical
transcript. Each adapter version declares whether it can:

- resume its own checkpoint;
- resume checkpoints from the previous supported version;
- reconstruct from canonical messages;
- fail closed when neither is safe.

Unsupported checkpoint migration creates a blocked recovery decision. It must
not silently restart the task and present the new run as a continuation.

## Upgrade Policy

Pi upgrades follow a controlled dependency process:

1. detect a new upstream release or selected commit;
2. inspect API, event, tool, checkpoint, provider, and Node-engine changes;
3. update the exact version on a dedicated change;
4. run deterministic golden traces without project writes;
5. run pairwise shadow scenarios against the current Pi version and LOS
   production baseline;
6. promote through read-only, temporary-workspace, and project-write canaries;
7. retain per-run rollback until the observation window is accepted.

An upstream release is not promoted from version freshness alone. A failed
compatibility trace leaves the current version active and records the missing
adapter or upstream capability.

LOS-specific improvements should prefer stable hooks or upstream contributions.
A fork is allowed only with a small, reviewable patch queue and a documented
rebase test. A growing permanent fork triggers an ownership review because it
would recreate the maintenance burden this decision is intended to reduce.

## Migration Sequence

1. **Protocol:** accept this ADR and the draft contract.
2. **Current-loop adapter:** wrap `runAgent()` without changing production
   behavior and prove that scheduler/gateway callers depend on the protocol.
3. **Pi deterministic adapter:** implement no-provider faux traces for event,
   tool, interrupt, failure, checkpoint, and resume semantics.
4. **Shadow:** run Pi read-only beside the production LOS kernel without using
   its output or side effects.
5. **Read-only canary:** allow explicitly selected planning and inspection
   attempts.
6. **Write canary:** allow temporary and then managed project workspaces while
   keeping LOS policy, lease, and verification ownership.
7. **Graph worker:** use Pi for bounded executor tasks; keep the verifier as an
   independent LOS-governed run.
8. **Default promotion:** make Pi the default only after preregistered pairwise
   non-inferiority gates and an operator-reviewed observation period.
9. **Candidate reversal:** continue improving `LosKernelAdapter` behind the same
   protocol and promote it only when the replacement gates pass.
10. **Cleanup:** remove duplicate provider/loop paths only after the rollback
    window and checkpoint compatibility decision are complete.

Each step has its own rollback and stop condition. No phase is complete merely
because a feature flag points to the new adapter.

## Replacement Meanings And Gates

Two replacement claims remain separate:

1. **Pi dependency internalized or removed:** LOS no longer installs the Pi
   packages but may retain compatible or Pi-derived primitives with required
   provenance and license notices.
2. **Independent LOS kernel:** the LOS implementation is maintained and evolved
   independently and is not inferior on the accepted task distribution.

An independent LOS kernel may become default only when all of these are true:

- the control plane, protocol, ToolBroker, and canonical transcript have no Pi
  type dependency;
- deterministic semantics cover no-tool, typed and malformed tools, parallel
  tools, denial/approval, interrupt, steering, provider failure, truncation,
  compaction, checkpoint, resume, planning, and verifier handoff;
- existing `run_evals` pairwise evidence compares verifier-confirmed success,
  first-pass success, operator intervention, invalid/repeated calls, recovery,
  context loss, latency, tokens, cost, and governance violations;
- a per-run fallback remains available through the accepted observation
  window;
- the maintenance cost is justified by lower total ownership cost or a
  measured LOS-specific capability that Pi cannot provide.

Numeric promotion thresholds must be preregistered in an eval ADR before the
comparison data is inspected. They are not chosen retrospectively.

## Consequences

Positive consequences:

- LOS can consume Pi execution improvements without moving durable state or
  governance out of LOS.
- the existing loop becomes an executable baseline rather than an all-or-
  nothing legacy path;
- Pi upgrades and LOS replacement use the same pairwise evidence surface;
- provider and turn-loop maintenance no longer has to compete with Work-first
  product and governance work.

Costs and risks:

- a canonical message/event protocol adds translation and versioning work;
- checkpoint portability may remain incomplete between kernels;
- double execution during shadow evaluation adds model cost unless faux or
  sampled runs are used;
- an adapter that leaks Pi types or bypasses ToolBroker would recreate lock-in
  and a second policy path.

## Non-Goals

This ADR does not authorize:

1. an immediate switch of production execution to Pi;
2. direct Pi database, filesystem, shell, approval, or credential ownership;
3. removal of the current LOS loop before parity and rollback gates pass;
4. adoption of Pi TUI, product navigation, or package ecosystem as LOS UX;
5. automatic provider, model, kernel, or version promotion;
6. treating loop completion, judge preference, or UI status as verification.

## Verification

The decision is implemented only when:

1. the TypeScript protocol and `LosKernelAdapter` are wired through a real
   scheduler or chat entrypoint;
2. Pi deterministic traces cover the protocol's terminal and tool paths;
3. a shadow operation record proves event translation without project writes;
4. pairwise records contain immutable baseline, candidate, rubric revision,
   deterministic verification, and separate human/judge evidence;
5. AP1, AP2, and AP3 checks and the full project gate remain green.

## References

- `contracts/execution-kernel.yaml`
- `contracts/execution-pairwise-eval.yaml`
- `docs/adr/0007-provider-loop-first-model-profiles.md`
- `docs/adr/0018-cli-fallback-gate.md`
- `docs/adr/0038-web-first-daily-coding-agent-product-boundary.md`
- `docs/governance/2026-07-22-lsclaw-los-pi-kernel-migration-plan.md`
- `docs/governance/2026-07-18-los-pi-harness-capability-and-operability-audit.md`
- Pi `packages/agent/docs/agent-harness.md`, local reference commit
  `304f42d20937ff06e8b63e4e7e330b953dedad76`
