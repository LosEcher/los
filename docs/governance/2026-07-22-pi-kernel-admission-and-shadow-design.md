# Pi Kernel Admission And Read-Only Shadow Design

- Date: 2026-07-22
- Status: K3 implemented; candidates `0.81.1` and `0.81.1+los.1` both failed
  corpus `1.1.0` at 14/17; deterministic second-turn probe complete
- Owner: `packages/agent`
- Decision source: ADR 0039

## Observed State

1. The production scheduler resolves only the LOS kernel. Unknown `pi` requests
   fail before task-run creation.
2. The Pi adapter already maps one LOS-resolved provider, model, credential,
   canonical history, and governed tool catalog. Its deterministic traces and a
   live no-tool provider probe pass.
3. The Pi input adapter rejects provider fallback, architect-editor mode,
   context compression, unsupported sampling penalties, and explicit reasoning
   disablement. It omits `spawn_agent` from the Pi tool catalog.
4. Pi setup can emit session and tool evidence. Reusing production identifiers
   for a second invocation would mix candidate evidence with the authoritative
   run and could duplicate tool-call persistence.
5. LOS already owns durable task/run state, verification, execution experiments,
   pairwise eval records, canonical session events, and provider telemetry.

## Inference

Registry admission is not the next safe step. The missing evidence is not
whether Pi can return text; it is whether the scheduler can run Pi beside the
LOS baseline without creating a second authority for output, tools, or final
state. The first scheduler integration therefore needs to be an explicitly
selected experiment whose failure is evidence rather than production failure.

## Decision

K3 adds a scheduler-owned `pi` shadow mode with these constraints:

1. The production registry continues to contain only `los`.
2. Shadow is explicit per invocation; there is no default sampling in K3. The
   candidate is limited to six turns and a 60-second default/120-second maximum
   timeout so comparison cannot consume unbounded turns or wait indefinitely.
3. The production LOS run and Pi shadow may execute concurrently, but the
   scheduler returns only the LOS result and uses only LOS verification and
   terminal transitions.
4. Pi receives `toolMode=read-only`, `sandboxMode=readonly`, the LOS read-only
   catalog, and no child-agent tool. A remote-executor production run is not
   shadowed in K3 because local and remote workspace evidence would not be
   comparable.
5. Pi session, task, and trace identifiers are derived from the production
   lineage. Candidate kernel events, tool evidence, and provider telemetry are
   stored under that derived lineage. The production session receives one
   bounded comparison event containing identities, counts, usage, latency,
   hashes, and terminal classification; it never receives candidate text or
   raw tool arguments.
6. Pi preparation, provider, tool, interruption, or projection failure produces
   `skipped`, `failed`, or `interrupted` shadow evidence. It does not change the
   production result or task/run state.
7. A versioned scenario counts only when its actual prompt and allowed tool
   catalog match the preregistered fixture. The effective route determines the
   evidence class. Invalid scenario metadata becomes a bounded evidence error
   and cannot fail production settlement.

## Admission Decisions

| Semantic | K3 shadow | Read-only canary | Later requirement | Ownership decision |
| --- | --- | --- | --- | --- |
| Provider fallback | reject when requested | disabled by candidate profile | required before default promotion | LOS selects and records routes; the kernel transports the active route |
| Architect-editor | reject when requested | disabled | refactor as LOS orchestration before admitting the mode | LOS owns role/task orchestration; Pi runs a bounded turn loop |
| Context compression | reject when requested | bounded prompts only | required before long write canaries and default | kernel produces transforms/checkpoints; LOS owns canonical transcript and recovery decision |
| `topP` and penalties | reject when requested | common settings subset only | may remain profile-restricted | LOS admission validates equivalence; no silent setting drop |
| Explicit reasoning disablement | reject when requested | reasoning-compatible profiles only | map or keep profile-restricted | LOS records requested/effective settings |
| Child-agent execution | omit from catalog | disabled | use LOS graph workers; do not add kernel-private children | LOS owns child identity, RunContract inheritance, lease, and attempts |

These decisions distinguish “not implemented” from “not owned by Pi.” Child
execution and architect/editor orchestration should not be recreated inside the
adapter. Provider fallback and compaction still need an equivalent protocol or
an explicit default-profile restriction before broad promotion.

## Implementation Placement

- `pi-kernel-admission.ts`: versioned, testable semantic decision matrix and
  fail-closed eligibility report.
- `pi-kernel-shadow.ts`: derived lineage, forced read-only input, candidate
  execution, bounded evidence, and comparison projection.
- `scheduler/scheduled-task-runner.ts`: explicit start/join points only. It
  remains the owner of the production result and transitions.
- `pi-kernel-input.ts`: consumes the same admission rules so direct Pi probes
  and scheduler shadow cannot drift.

No new database table is required for K3. Exact candidate events remain in
`session_events`, provider calls remain in `provider_call_telemetry`, and the
production comparison bookmark is another audit event. K3 does not create a
candidate `run_spec`, so it also does not manufacture a formal `run_evals`
pair. Formal promotion data continues through the existing execution experiment
and pairwise eval contracts once K4 owns a real candidate run spec.

## Verification

K3 is acceptable only when deterministic tests cover:

1. no-tool completion;
2. one brokered read-only tool;
3. a denied tool result;
4. provider failure and interruption;
5. derived lineage and bounded comparison output;
6. scheduler output/state independence when shadow is skipped or fails;
7. zero candidate project-write or tool-call-state persistence.

The first live K3 probe must use an explicitly selected, bounded, read-only
request. Registry admission remains a later decision even if that probe passes.

## Remaining Verification

- Corpus `1.0.1` and rubric `pi-shadow-readonly-v1` completed all 17 fixed
  observations. Sixteen passed. All three live read-only-tool observations
  passed tool sequence, tool state, terminal, and actual input-lineage
  assertions; two output hashes matched and one did not. The report remains
  `collecting`; the earlier live no-tool smoke and superseded corpus `1.0.0`
  remain ignored by readiness.
- Corpus `1.0.0` was superseded because its lineage assertion checked outcome
  strings rather than the identifiers actually passed into Pi. Its 17 records
  remain persisted and are not reinterpreted as `1.0.1` evidence.
- The failed observations are immutable evidence. Corpus `1.1.0` and rubric
  `pi-shadow-readonly-v2` now preregister a typed JSON `packageName` result
  comparator. Candidate `0.81.1` completed 14/17: its three live tool scenarios
  failed because Pi performed two real brokered reads while LOS performed one.
  Candidate `0.81.1+los.1` mapped the profile's parallel-tool policy, started
  with zero qualifying observations, and also completed 14/17. Its three live
  tool cases made a second narrower read in the next turn. Neither revision
  reinterprets or overwrites earlier evidence.
- The deterministic second-turn probe found equal prompt/history, call ids,
  tool result, parallel policy, and normalized tool schema. Pi additionally
  sent streaming usage fields, an explicit output limit, explicit reasoning
  disablement, and several representation defaults. The probe narrows the next
  adapter hypothesis but does not establish a unique cause.
- No read-only canary or write canary is authorized.
- Provider fallback, compaction, and long-context equivalence remain unproven.
- Web-first manual acceptance and graph integration review remain separate and
  continue to block completion of the parent daily-agent product task.
