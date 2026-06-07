---
date: 2026-06-07
change: dag-provider-model-selection
surface: scheduler, DAG tasks, provider compatibility evidence
impact: Graph executor tasks can select provider/model targets from passing compatibility evidence before execution.
---

## Evidence

- Source: `packages/agent/src/scheduler.ts` reads graph task
  `providerModelTargets` and `requireProviderCompat` metadata before running an
  executor task.
- Evidence boundary: selection reads `provider_compat_evidence`; provider
  readiness alone is not enough when `requireProviderCompat` is true.
- Runtime record: selected provider, model, source, target label, and evidence
  id are written to task attempt/provider fields and task-run metadata.
- Validation: `packages/agent/src/scheduler.test.ts` covers selecting a graph
  task provider/model from passing compatibility evidence.

## Notes

This is a DAG runtime promotion slice. It does not add eval metrics, memory
compression, or new provider policy commands.
