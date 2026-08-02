# ADR 0030: Declarative Flow DSL

## Status

> Numbering conflict: `docs/adr/0030-provider-account-credential-and-quota-boundary.md` shares this number and is the
> canonical entry referenced by docs/README.md. Revisit numbering on the
> next archive pass.

Proposed.

## Context

los currently encodes execution plans as JSON arrays in `run_specs.run_contract_json` via `RunContract.plan`. Each step is a flat object with `id`, `title`, `description`, `dependsOnIds`, `editableSurfaces`, and `completionCriteria`. This is sufficient for linear/parallel step execution but offers no declarative way to express:

- Conditional branching ("if step A fails, go to step B instead of C")
- Loop/retry constructs ("retry step X up to 3 times")
- Tool-call orchestration ("before calling `write_file`, always call `read_file`")
- Verification gates as inline assertions
- Shared context between steps

Deer Workflow (deerwork-ai/deer-workflow) demonstrates a YAML-based declarative flow definition that maps directly to executable agent steps. Adopting a similar pattern for los would make RunContract plans both human-readable and machine-executable without requiring the scheduler to interpret ad-hoc `dependsOnIds` graphs.

## Decision

1. **Flow DSL as optional RunContract layer**: `RunContract.flow` is a new optional field alongside `RunContract.plan`. When `flow` is present, the scheduler derives `plan` from it automatically. When only `plan` is present, behavior is unchanged.

2. **YAML/JSON syntax** (contracts-first, following ADR 0029):

```yaml
flow:
  version: "1.0"
  steps:
    - id: discover
      title: "Discover codebase structure"
      toolMode: read-only
      prompt: "Explore the project and report key files and architecture."
      timeout: 120s
      verification:
        - kind: assertion
          description: "Must identify at least one package directory"

    - id: implement
      title: "Implement the feature"
      toolMode: project-write
      dependsOn: [discover]
      prompt: "Implement the feature described in {{inputs.feature}}."
      retry:
        maxAttempts: 3
        backoff: exponential
      verification:
        - kind: command
          command: "pnpm check"

    - id: review
      title: "Self-review the changes"
      toolMode: read-only
      dependsOn: [implement]
      prompt: "Review the diff for correctness and style."
      condition:
        if: "steps.implement.status == 'succeeded'"

    - id: fallback
      title: "Report implementation failure"
      dependsOn: [implement]
      condition:
        if: "steps.implement.status == 'failed'"
      prompt: "Report what went wrong with the implementation."
```

3. **Step types**:
   - `agent` (default): Full agent loop with prompt and tool access
   - `tool`: Single tool call without agent loop
   - `gate`: Pure verification step (no LLM call)
   - `parallel`: Fork-join container for concurrent steps

4. **Key DSL features**:
   - `dependsOn`: Explicit step dependencies (replaces ad-hoc graph parsing)
   - `condition`: Runtime condition for step execution (`if`/`unless`)
   - `retry`: Declarative retry policy (`maxAttempts`, `backoff`, `retryableErrors`)
   - `verification`: Inline verification requirements (replaces separate `runContract.verifications` array)
   - `inputs`/`outputs`: Typed step I/O with JSON Schema
   - `timeout`: Per-step timeout

5. **Execution model**:
   - The scheduler resolves `flow` → `plan` during the `planning` phase
   - Flow steps map 1:1 to RunContract plan steps
   - `dependsOnIds` in the generated plan reflect `dependsOn` from the flow
   - `verification` entries in the flow become `runContract.verifications`

6. **Migration path**:
   - Phase 1: Accept `flow` as optional field in `run-spec.yaml` contract, add Zod validation
   - Phase 2: Implement `resolveFlowToPlan()` in `packages/agent/src/run-spec-plans.ts`
   - Phase 3: Add flow authoring UI in web console
   - Existing `plan`-only RunContracts continue to work without changes

## Consequences

**Positive**:
- Plans become authorable without understanding internal graph topology
- Verification requirements are co-located with the steps they gate
- Declarative retry/condition reduces scheduler complexity
- Enables UI-based flow authoring (drag-and-drop step builder)

**Negative**:
- Two parallel plan representations increase maintenance surface
- Flow DSL adds a new contract surface that must be validated
- Resolver logic (`flow → plan`) is a new failure domain

**Risks**:
- Flow DSL might diverge from what the scheduler can actually execute
- Mitigation: `resolveFlowToPlan()` fails closed — any unresolvable flow step blocks plan approval

## References

- Deer Workflow YAML flow definitions (deerwork-ai/deer-workflow)
- ADR 0029 (Executable Contract Pilot) — contract validation pattern
- `packages/agent/src/run-spec-plans.ts` — current plan persistence
- `contracts/run-spec.yaml` — RunSpec contract schema
