/**
 * @los/memory/types — Shared types for the memory package.
 *
 * Extracted to avoid circular dependencies between store.ts and index.ts
 * while keeping individual files under 600-line limit.
 */

/**
 * Who or what produced an observation.
 * Stored in metadata_json.observerType — no schema change needed.
 */
export type ObserverType =
  | 'user'         // Human operator
  | 'agent'        // Agent recording about its work
  | 'agent_self'   // Agent recording about ITSELF (self-reflective)
  | 'judge'        // Self-check judge evaluation
  | 'system'       // Automated system (compaction, governance, etc.)
  | 'child_agent'; // Child/spawned agent
