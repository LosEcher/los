# Input Preprocessor Spec

## Pre-Development Checklist

- [ ] This change processes or transforms user input before it reaches the LLM.
- [ ] The change belongs in `@los/input-preprocessor`, not in an existing package.
- [ ] Relevant ADRs (if any) have been read and reconciled.
- [ ] Content type detection heuristics are appropriate for the target format.

## Coding Guidelines

### Architecture

The input preprocessor follows a **detect-first, route-then-process** architecture:

1. **Content type detection** (`detectors/`) — heuristic pattern matching with confidence scoring.
2. **Pipeline stages** (`stages/`) — composable `PreprocessStage` implementations: tokenizer, classifier, deduplicator, compressor.
3. **Type-specific denoisers** (`denoisers/`) — assemble stage chains for each content type.
4. **Safety layer** (`safety.ts`) — enforces non-negotiable invariants on every pipeline run.

### Key Rules

1. **ERROR/FATAL entries are NEVER removed.** This is hard-coded in `safety.ts`, not configurable.
2. **All stages implement `PreprocessStage`** — same input/output contract, composable in any order.
3. **Safety is accumulated via shared `StageContext`** — stages mutate `context.safety` as a side channel, not via return values.
4. **Backreferences are always preserved** — every removed/merged entry is tracked in `safetyReport.backreferenceMap`.
5. **Unknown content types pass through unchanged** — the preprocessor must never corrupt or lose input it doesn't understand.
6. **Minimum retention ratio is enforced** — at least `minRetentionRatio` entries must survive processing.

### Detection Heuristics (Log)

- **Timestamp prefix**: `[HH:MM:SS]` in ≥60% of first 10 lines → confidence 0.95
- **Log level keywords**: DEBUG/INFO/WARN/ERROR/FATAL/TRACE in ≥15% of first 50 lines → confidence 0.85+
- **JSON log density**: ≥30% lines parse as JSON with `level`/`timestamp`/`message` keys → confidence 0.90
- **Newline density**: >20 lines, avg line <300 chars → confidence boost

### Configuration

All configuration is Zod-driven in `config.ts`. Follow the `@los/infra/config` pattern:
- Single schema → TypeScript types auto-derived
- `resolveConfig(overrides?)` merges partial overrides into defaults
- No YAML/JSON files needed for P0

### Anti-Patterns

- **Do not** split multi-line entries (stack traces, JSON objects) — tokenizer must group continuations.
- **Do not** remove ERROR/FATAL entries — `isProtectedEntry()` gate must be checked.
- **Do not** add new stages without implementing the `PreprocessStage` interface.
- **Do not** hard-code detection rules — use heuristics with confidence scoring, not binary yes/no.
- **Do not** make destructive changes without backreference tracking.

### Integration

The preprocessor is invoked from `@los/agent/loop/message-builder.ts`:

```typescript
import { preprocessInput } from '@los/input-preprocessor';
const processed = preprocessInput({ rawText: prompt, config: compression?.preprocessor });
messages.push({ role: 'user', content: processed.processedText });
```

The `ContextCompressionConfig` type in `@los/agent` carries an optional `preprocessor` field.

### Key Source Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API barrel |
| `pipeline.ts` | Main orchestrator: detect → route → execute |
| `config.ts` | Zod config schema |
| `safety.ts` | Safety guards and invariants |
| `types.ts` | All interfaces and type aliases |
| `detectors/log-detector.ts` | Log content type detection |
| `stages/tokenizer.ts` | Logical entry split |
| `stages/classifier.ts` | Density scoring |
| `stages/deduplicator.ts` | Exact + fingerprint dedup |
| `stages/compressor.ts` | Stack folding, JSON elision, truncation |
| `denoisers/log-denoiser.ts` | Full log pipeline assembly |

## Quality Check

```bash
# Type check
pnpm --filter @los/input-preprocessor check

# Run tests (65 tests, pure computation, no DB required)
pnpm --filter @los/input-preprocessor test

# Full gate (type check all packages that depend on this one)
pnpm --filter @los/agent check
```
