---
date: 2026-06-07
change: memory-compaction-adr
surface: governance, adr
impact: ADR 0020 defines the memory compaction surface, evidence gate, review gate, and output schema for session-to-summary distillation and procedural rule candidate extraction.
---

## Evidence

- Source: `docs/adr/0020-memory-compaction-procedural-learning.md` defines:
  - Compaction as a read-only session → structured summary operation stored in
    `memory_compactions` and `procedural_candidates` tables.
  - Evidence gate: 3-session minimum (or 1 session + operator attestation),
    non-regression proof, verification alignment, confidence ≥ 0.7.
  - Review gate: operator approval required before any candidate becomes a rule;
    approval recorded as `rule_approval` event.
  - Non-goals: no automatic rule creation, no session content replacement, no
    embedding/statistical models in initial implementation.
- Remaining risk: implementation of the compaction pipeline and integration
  with the existing memory observation store.
