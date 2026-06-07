# ADR 0020: Memory Compaction and Procedural Learning

## Status

Proposed.

## Context

ADR 0012 non-goal #6 prohibits promoting memory compaction output into
procedural rules without evidence and review. The current memory system stores
observations (`memory_observations`) and sessions store messages and turns
(`sessions`), but no mechanism exists to compact raw session content into
structured, reusable summaries or to extract cross-session procedural patterns.

Without a defined compaction surface, the system has no safe path from "raw
session content" to "evidence-backed procedural rule." Operators must manually
read sessions and write rules, which doesn't scale.

## Decision

### 1. Compaction Definition

Memory compaction is a read-only operation that takes session content (messages,
turns, observations, task runs, and eval records) and produces a **structured
summary record**. It does not modify the source data.

Compaction inputs:
- Session messages and turns
- Memory observations linked to the session
- Task runs and their tool call states
- Eval records (success, failure class, failover scope, etc.)

Compaction output:
- A `memory_compactions` record with:
  - `id`, `session_id`, `run_spec_id` (optional, if tied to a specific run)
  - `summary`: structured JSON with key facts, decisions, and outcomes
  - `observed_patterns`: array of pattern observations (e.g., "tool X failed
    under condition Y")
  - `procedural_candidates`: array of suggested rule candidates (name, content,
    severity, rationale)
  - `confidence`: 0.0–1.0 score for each candidate
  - `evidence_count`: number of distinct sessions supporting each pattern
  - `created_at`, `created_by` (operator or system)

### 2. Evidence Gate

Before a procedural candidate can be promoted to a rule:

1. **Cross-session evidence**: the pattern must be observed in at least 3
   distinct sessions, or 1 session with operator attestation.
2. **Non-regression proof**: promoting the rule must not break existing
   operation smokes or verification checks.
3. **Verification alignment**: the candidate's rationale must cite specific
   verification records or eval failures.
4. **Confidence threshold**: candidates with confidence < 0.7 are stored for
   review but marked as draft-only.

### 3. Review Gate

Promotion from procedural candidate → active rule requires:

1. An operator explicitly reviews and approves the candidate.
2. The approval is recorded as a `rule_approval` event with operator identity
   and timestamp.
3. The resulting rule is created with `status: active` and metadata linking
   back to the compaction record and source sessions.
4. Rejected candidates remain in `memory_compactions` with a `rejected_at`
   timestamp and optional rejection reason.

No automatic rule creation from compaction output is permitted.

### 4. Output Surface

| Table | Purpose | Relationship |
|-------|---------|--------------|
| `memory_compactions` | Stores compaction results and candidates | FK to sessions, run_specs |
| `procedural_candidates` | Individual rule candidates within a compaction | FK to memory_compactions |
| Rules (`rules`) | Approved rules promoted from candidates | Metadata links to compaction |

A compaction is a point-in-time snapshot. Re-compacting the same session
produces a new record; it does not overwrite.

### 5. Non-Goals

1. Compaction does not replace or rewrite session content.
2. Compaction does not automatically create, update, or delete rules.
3. Compaction does not feed into the runtime agent loop without explicit
   operator configuration.
4. Cross-session pattern extraction requiring statistical models or embeddings
   is out of scope for the initial implementation.

## Consequences

- **Positive**: Operators have a defined, auditable path from session evidence
  to procedural rules.
- **Positive**: The evidence gate prevents spurious pattern promotion.
- **Positive**: The review gate ensures human accountability for rule creation.
- **Negative**: Adds two new tables and a compaction pipeline that must be
  maintained.
- **Negative**: The 3-session evidence minimum may be too conservative for
  high-severity patterns discovered in a single session.

## Implementation Slice

The first bounded implementation:

1. `packages/agent/src/memory-compaction.ts` with `ensureMemoryCompactionStore`,
   `compactSession(id)`, and `listCompactions`.
2. `POST /memory/compact` and `GET /memory/compactions` gateway routes.
3. `los memory compact SESSION_ID` and `los memory compactions list` CLI commands.
4. Tests proving: compaction creates a record, candidates are not automatically
   promoted, cross-session evidence tracking works.
5. A web UI section showing compaction history per session.

## Verification

- `pnpm --filter @los/agent test`
- `pnpm --filter @los/gateway test`
- `pnpm check`
- `./tools/check-contracts.sh`
- One operation smoke proving compaction does not modify source session data.
