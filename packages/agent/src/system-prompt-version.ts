/**
 * @los/agent/system-prompt-version — Deterministic version tracking.
 *
 * Bump this version whenever system prompt, tool definitions, or context-window
 * strategy (compression thresholds, semantic eviction policy) are modified.
 * See docs/governance/code-first-determinism.md for the full checklist.
 */
export const SYSTEM_PROMPT_VERSION = '1.3.0';

/**
 * Context-window strategy version: tracks compression, compaction, eviction, and
 * cache-aware policy changes independently from system prompt changes.
 */
export const CONTEXT_STRATEGY_VERSION = '1.0.0';
