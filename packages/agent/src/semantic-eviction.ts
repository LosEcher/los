/**
 * @los/agent/semantic-eviction — Layer 1: Mask persisted tool results before compaction.
 *
 * During agent execution, large tool results (file reads, search outputs, shell outputs)
 * accumulate in the context window. Once persisted (written to observations, file_sync,
 * or task_runs), these results can be replaced with lightweight stubs that:
 *   - Reference the persisted location (observation ID, file_sync entry, run_spec_id)
 *   - Include a 1-2 line summary of key findings
 *   - Strip the full content (which remains available on-demand via retrieval)
 *
 * This is "semantic eviction" because it preserves semantic access (the ability to
 * find and retrieve the result) while freeing context window space.
 *
 * Aligns with:
 *   - arXiv:2606.11213 CWL: Structured Context Eviction
 *   - Anthropic Context Engineering guide (guiding principle: evict, don't truncate)
 */
import { getLogger } from '@los/infra/logger';

const log = getLogger('semantic-eviction');

export interface MaskedToolResult {
  /** Original tool call ID */
  toolCallId: string;
  /** Original tool name */
  toolName: string;
  /** Original result size (bytes, before masking) */
  originalSizeBytes: number;
  /** Eviction stub text — brief summary of what the result contained */
  stub: string;
  /** Location references where the full content can be retrieved */
  locations: PersistentLocation[];
}

export interface PersistentLocation {
  /** Type of persistence backing */
  kind: 'observation' | 'file_sync_entry' | 'task_run' | 'artifact' | 'checkpoint' | 'workspace_path';
  /** ID for retrieval */
  id: string;
  /** Human-readable description (e.g., "observation #42: file content of src/foo.ts") */
  label: string;
}

export interface PersistedToolResultEvidence {
  toolName: string;
  locations: PersistentLocation[];
}

export interface SemanticEvictionConfig {
  /** Minimum result size in bytes to consider for eviction (default: 4096) */
  minResultBytes?: number;
  /** Maximum stub length in characters (default: 200) */
  maxStubChars?: number;
  /** When true, also evict results that were already observed in prior sessions (default: false) */
  crossSession?: boolean;
}

export interface SemanticEvictionResult {
  /** Number of tool results masked */
  maskedCount: number;
  /** Total bytes freed from context window */
  bytesFreed: number;
  /** The masked results (for logging / trace) */
  masked: MaskedToolResult[];
  /** Tool messages that should replace the original tool results */
  replacementMessages: Array<{ role: 'tool'; tool_call_id: string; content: string }>;
}

const DEFAULTS: Required<SemanticEvictionConfig> = {
  minResultBytes: 4096,
  maxStubChars: 200,
  crossSession: false,
};

/**
 * Determine if a tool result is eligible for eviction based on:
 * 1. Minimum size threshold (don't bother masking tiny results)
 * 2. Tool type: search, file-read, shell-output, directory-tree are primary eviction candidates
 * 3. Content already persisted (caller must pass location references)
 */
export function isEligibleForEviction(
  toolName: string,
  resultContent: string,
  config: SemanticEvictionConfig,
): boolean {
  const minBytes = config.minResultBytes ?? DEFAULTS.minResultBytes;
  if (resultContent.length < minBytes) return false;

  // High-eviction-priority tool categories
  const eligiblePrefixes = [
    'read', 'search', 'grep', 'find', 'list', 'cat',
    'shell', 'execute', 'glob', 'directory_tree',
  ];
  return eligiblePrefixes.some(p => toolName.startsWith(p) || toolName.includes(p));
}

/**
 * Generate a stub that summarizes what the tool result contained.
 *
 * Produces a compact reference string like:
 *   "[evicted: read_file src/foo.ts (4.2KB) → observation #42]"
 *
 * The caller can retrieve the full content from the referenced location.
 */
export function generateEvictionStub(
  toolName: string,
  toolCallId: string,
  resultContent: string,
  locations: PersistentLocation[],
  config: SemanticEvictionConfig,
): string {
  const maxChars = config.maxStubChars ?? DEFAULTS.maxStubChars;
  const sizeKB = (resultContent.length / 1024).toFixed(1);

  const locRefs = locations.length > 0
    ? ` → ${locations.map(l => `${l.kind} ${l.id}`).join(', ')}`
    : '';

  // Extract a 1-line summary: first non-empty line, trimmed
  const firstLine = resultContent.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
  const summary = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;

  const stub = `[evicted: ${toolName} (${sizeKB}KB)${locRefs}] ${summary}`;
  return stub.length > maxChars ? stub.slice(0, maxChars - 3) + '...' : stub;
}

/**
 * Build a persistent location reference from a tool result.
 */
export function buildLocationRef(
  kind: PersistentLocation['kind'],
  id: string,
  label: string,
): PersistentLocation {
  return { kind, id, label };
}

/**
 * Apply semantic eviction to a set of tool results.
 *
 * Walk through tool results, identify eligible ones (large, persisted, evictable tool type),
 * generate stubs, and return replacement messages.
 *
 * This is designed to be called from the compaction pipeline and from the context monitor's
 * onCritical handler in loop.ts.
 */
export function applySemanticEviction(
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    content: string;
    locations?: PersistentLocation[];
  }>,
  config: SemanticEvictionConfig = {},
): SemanticEvictionResult {
  const masked: MaskedToolResult[] = [];
  let bytesFreed = 0;

  const replacementMessages: SemanticEvictionResult['replacementMessages'] = [];

  for (const tr of toolResults) {
    if (!isEligibleForEviction(tr.toolName, tr.content, config)) continue;

    const locations = tr.locations ?? [];
    if (locations.length === 0) continue;
    const stub = generateEvictionStub(tr.toolName, tr.toolCallId, tr.content, locations, config);

    masked.push({
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      originalSizeBytes: tr.content.length,
      stub,
      locations,
    });

    bytesFreed += tr.content.length - stub.length;

    replacementMessages.push({
      role: 'tool',
      tool_call_id: tr.toolCallId,
      content: stub,
    });
  }

  if (masked.length > 0) {
    const kbFreed = (bytesFreed / 1024).toFixed(1);
    log.info(`Semantic eviction: masked ${masked.length} tool result(s), freed ${kbFreed}KB from context window`);
  }

  return { maskedCount: masked.length, bytesFreed, masked, replacementMessages };
}

/**
 * Scan existing messages for large tool results and apply eviction.
 * Returns a new messages array with evicted tool results replaced by stubs.
 *
 * This can be called mid-loop when context fill hits critical level,
 * or at the start of compaction.
 */
export function evictMessages<T extends { role: string; tool_call_id?: string; content?: string | null }>(
  messages: T[],
  persistedResults: Map<string, PersistedToolResultEvidence>,
  config: SemanticEvictionConfig = {},
): T[] {
  const toolResults: Array<{
    toolCallId: string;
    toolName: string;
    content: string;
    locations?: PersistentLocation[];
  }> = [];

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id && typeof msg.content === 'string') {
      const evidence = persistedResults.get(msg.tool_call_id);
      toolResults.push({
        toolCallId: msg.tool_call_id,
        toolName: evidence?.toolName ?? 'unknown',
        content: msg.content,
        locations: evidence?.locations,
      });
    }
  }

  const result = applySemanticEviction(toolResults, config);
  if (result.maskedCount === 0) return messages;

  const stubMap = new Map(result.masked.map(m => [m.toolCallId, m.stub]));

  return messages.map(msg => {
    if (msg.role === 'tool' && msg.tool_call_id && stubMap.has(msg.tool_call_id)) {
      return { ...msg, content: stubMap.get(msg.tool_call_id)! } as T;
    }
    return msg;
  });
}
