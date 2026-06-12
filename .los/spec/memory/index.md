# memory — Memory & Observation Spec

## Pre-Development Checklist

- [ ] Does this change affect memory retrieval, compaction, or observation storage?
- [ ] Read ADR 0020 (Memory Compaction + Procedural Learning)
- [ ] Check `compaction.ts` pipeline for compaction-aware changes

## Coding Guidelines

### Memory Layers
- Episodic: session-scoped observations
- Semantic: cross-session patterns (compaction output)
- Procedural: promoted rules and specs (future)

### Compaction
- Pipeline: `compaction.ts` extracts patterns from run evals
- Compaction is incremental, not full-reprocessing
- Evidence counting: currently per-session; cross-session counting is Phase C delta work

### Observations
- Store in `observations` table with session + run_spec linkage
- `evidenceCount` counts source categories within one session
- Cross-session evidence aggregation is Phase C work

### MEMORY.md Management
- `.los/memory/` is the file-based memory surface
- One file per fact with frontmatter (name, description, metadata)
- `MEMORY.md` is the index — one line per memory, never content

## Quality Check

```bash
pnpm --filter @los/memory test    # 31 tests
pnpm check                         # Full type-check
```
