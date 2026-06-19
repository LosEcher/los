/**
 * @los/memory/retrieval — Memory retrieval policy per ADR 0020.
 *
 * Retrieves active procedural rules from compactions and routes
 * memory queries by task state (working/episodic/semantic/procedural).
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureMemoryCompactionStore } from './compaction.js';
import { ensureProceduralCandidateStore } from '../procedures/procedural-candidates.js';
import { ensureMemoryStore, searchObservations, type Observation } from './store.js';

const log = getLogger('memory-retrieval');

// ── Types ────────────────────────────────────────────────

export type TaskState = 'created' | 'queued' | 'running' | 'blocked' | 'failed' | 'cancelled' | 'succeeded';
export type RunPhase = 'plan_approved' | 'execution' | 'verification' | 'completed' | string;
export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'procedural' | 'self_reflective';

export interface ActiveRule {
  name: string;
  content: string;
  severity: 'info' | 'warn' | 'error';
  rationale: string;
  confidence: number;
  /** Compaction IDs that produced this rule. */
  sourceCompactionIds: string[];
}

export interface RetrievalOptions {
  taskState?: TaskState;
  runPhase?: RunPhase;
  sessionId?: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  /** Max observations per layer. Default 5. */
  maxObservationsPerLayer?: number;
}

export interface RetrievalResult {
  activeRules: ActiveRule[];
  /** Observations grouped by memory layer. */
  observationsByLayer: Record<MemoryLayer, Observation[]>;
  /** The layers that were queried and in what priority order. */
  queriedLayers: MemoryLayer[];
}

export interface AugmentPromptResult {
  augmentedPrompt: string;
  retrieval: RetrievalResult;
}

// ── Layer Routing ────────────────────────────────────────

/**
 * Map task state + run phase to prioritized memory layers.
 *
 * | Task State       | Primary Layers                    | Rationale |
 * |------------------|-----------------------------------|-----------|
 * | created / queued | working, procedural               | Load active rules before execution |
 * | running          | working, procedural, episodic     | Rules + similar past sessions |
 * | blocked          | episodic, procedural, semantic,   | What went wrong? What rules apply? |
 * |                  | self_reflective                   | What has the agent learned about itself? |
 * | failed           | episodic, semantic,               | Investigate similar failures + self-knowledge |
 * |                  | self_reflective                   | |
 * | cancelled        | episodic                          | Learn from abandoned sessions |
 * | succeeded        | (empty)                           | No retrieval needed — recording phase |
 */
export function resolveMemoryLayers(taskState?: TaskState, _runPhase?: RunPhase): MemoryLayer[] {
  if (!taskState) return ['working', 'procedural'];

  switch (taskState) {
    case 'created':
    case 'queued':
      return ['working', 'procedural'];
    case 'running':
      return ['working', 'procedural', 'episodic'];
    case 'blocked':
      return ['episodic', 'procedural', 'semantic', 'self_reflective'];
    case 'failed':
      return ['episodic', 'semantic', 'self_reflective'];
    case 'cancelled':
      return ['episodic'];
    case 'succeeded':
      return [];
    default:
      return ['working', 'procedural'];
  }
}

// ── Active Rule Retrieval ─────────────────────────────────

/**
 * Query all memory_compactions for procedural candidates with status 'active'.
 * Deduplicates by name and sorts by confidence descending.
 */
export async function retrieveActiveRules(options?: {
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  limit?: number;
}): Promise<ActiveRule[]> {
  const db = getDb();

  // Prefer standalone procedural_candidates table; fall back to JSONB
  // column for backwards compat during the dual-write transition.
  const results = await Promise.allSettled([
    queryStandaloneRules(db, options),
    queryCompactionRules(db, options),
  ]);

  const standaloneRules: ActiveRule[] = results[0].status === 'fulfilled' ? results[0].value : [];
  const compactionRules: ActiveRule[] = results[1].status === 'fulfilled' ? results[1].value : [];

  // Deduplicate by name, preferring standalone (newer) entries
  const seen = new Map<string, ActiveRule>();
  for (const rule of compactionRules) seen.set(rule.name, rule);
  for (const rule of standaloneRules) seen.set(rule.name, rule);

  const rules = [...seen.values()];
  const limit = options?.limit && options.limit > 0 ? options.limit : rules.length;
  return rules.slice(0, limit);
}

/**
 * Format active rules into a system prompt block.
 */
export function formatRulesForPrompt(rules: ActiveRule[]): string {
  if (rules.length === 0) return '';

  const lines: string[] = [
    '## Active Procedural Rules',
    'The following rules have been learned from past sessions and operator review.',
    'Apply them when relevant to the current task.',
    '',
  ];

  for (const rule of rules) {
    const severityLabel = rule.severity === 'error' ? '⚠️' : rule.severity === 'warn' ? '⚡' : 'ℹ️';
    lines.push(`### ${severityLabel} ${rule.name}`);
    lines.push(`**Confidence**: ${(rule.confidence * 100).toFixed(0)}%`);
    lines.push('');
    lines.push(rule.content);
    if (rule.rationale) {
      lines.push('');
      lines.push(`*Rationale*: ${rule.rationale}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Memory Retrieval Router ──────────────────────────────

/**
 * Route memory retrieval by task state.
 * Queries observations from prioritized memory layers and retrieves active rules
 * when the procedural layer is selected.
 */
export async function routeMemoryRetrieval(options: RetrievalOptions): Promise<RetrievalResult> {
  const layers = resolveMemoryLayers(options.taskState, options.runPhase);
  const maxPerLayer = options.maxObservationsPerLayer ?? 5;

  // Query observations for each selected layer (except procedural — that uses compaction rules)
  const observationLayers = layers.filter(l => l !== 'procedural');
  const queries = observationLayers.map(layer =>
    searchObservations('', {
      limit: maxPerLayer,
      memoryLayer: layer,
      sessionId: options.sessionId,
      tenantId: options.tenantId,
      projectId: options.projectId,
    }).catch(err => {
      log.warn(`Memory retrieval failed for layer ${layer}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as Observation[];
    }),
  );

  let activeRules: ActiveRule[] = [];
  if (layers.includes('procedural')) {
    try {
      activeRules = await retrieveActiveRules({
        tenantId: options.tenantId,
        projectId: options.projectId,
      });
    } catch (err) {
      log.warn(`Active rule retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const results = await Promise.all(queries);
  const observationsByLayer: Record<MemoryLayer, Observation[]> = {
    working: [],
    episodic: [],
    semantic: [],
    procedural: [],
    self_reflective: [],
  };

  for (let i = 0; i < observationLayers.length; i++) {
    const layer = observationLayers[i]!;
    observationsByLayer[layer] = results[i] ?? [];
  }

  return {
    activeRules,
    observationsByLayer,
    queriedLayers: layers,
  };
}

/**
 * Augment a base system prompt with memory retrieval results.
 * Appends active rules and relevant observations to the prompt.
 */
export function augmentSystemPrompt(
  basePrompt: string,
  retrieval: RetrievalResult,
): AugmentPromptResult {
  const sections: string[] = [basePrompt];

  // Active procedural rules
  if (retrieval.activeRules.length > 0) {
    const rulesBlock = formatRulesForPrompt(retrieval.activeRules);
    if (rulesBlock) sections.push('', rulesBlock);
  }

  // Relevant memory observations by layer
  const layerLabels: Record<MemoryLayer, string> = {
    working: 'Working Memory (current task context)',
    episodic: 'Episodic Memory (past session experiences)',
    semantic: 'Semantic Memory (facts and knowledge)',
    procedural: 'Procedural Memory (learned rules)',
    self_reflective: 'Self-Reflective Memory (agent self-knowledge)',
  };

  for (const layer of retrieval.queriedLayers) {
    const obs = retrieval.observationsByLayer[layer];
    if (!obs || obs.length === 0) continue;

    const lines: string[] = [
      '',
      `## ${layerLabels[layer]}`,
      '',
    ];

    for (const o of obs) {
      lines.push(`- **${o.title}**: ${o.summary || o.content.slice(0, 200)}`);
    }

    sections.push(lines.join('\n'));
  }

  return {
    augmentedPrompt: sections.join('\n'),
    retrieval,
  };
}

// ── Helpers ──────────────────────────────────────────────

async function queryStandaloneRules(
  db: ReturnType<typeof getDb>,
  options?: { runSpecId?: string; tenantId?: string; projectId?: string },
): Promise<ActiveRule[]> {
  try {
    await ensureProceduralCandidateStore();
  } catch {
    return [];
  }

  const params: unknown[] = [];
  const clauses: string[] = [];

  if (options?.runSpecId) {
    params.push(options.runSpecId);
    clauses.push(`compaction_id IN (SELECT id FROM memory_compactions WHERE run_spec_id = $${params.length})`);
  }
  if (options?.tenantId) {
    params.push(options.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (options?.projectId) {
    params.push(options.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  clauses.push(`status = 'active'`);
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = await db.query<{
    name: string;
    content: string;
    severity: string;
    rationale: string;
    confidence: string;
    compaction_id: string;
  }>(
    `SELECT name, content, severity, rationale,
       confidence::numeric::text AS confidence, compaction_id
     FROM procedural_candidates ${where}
     ORDER BY confidence DESC`,
    params,
  );

  const seen = new Map<string, ActiveRule>();
  for (const row of rows.rows) {
    const existing = seen.get(row.name);
    if (existing) {
      existing.sourceCompactionIds.push(row.compaction_id);
    } else {
      seen.set(row.name, {
        name: row.name, content: row.content,
        severity: normalizeSeverity(row.severity),
        rationale: row.rationale,
        confidence: Number(row.confidence),
        sourceCompactionIds: [row.compaction_id],
      });
    }
  }
  return [...seen.values()];
}

async function queryCompactionRules(
  db: ReturnType<typeof getDb>,
  options?: { runSpecId?: string; tenantId?: string; projectId?: string },
): Promise<ActiveRule[]> {
  try {
    await ensureMemoryCompactionStore();
  } catch {
    return [];
  }

  const params: unknown[] = [];
  const clauses: string[] = [];

  if (options?.runSpecId) {
    params.push(options.runSpecId);
    clauses.push(`run_spec_id = $${params.length}`);
  }
  if (options?.tenantId) {
    params.push(options.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (options?.projectId) {
    params.push(options.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  clauses.push(`candidate->>'status' = 'active'`);
  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = await db.query<{
    name: string; content: string; severity: string;
    rationale: string; confidence: string; compaction_id: string;
  }>(
    `SELECT candidate->>'name' AS name,
       candidate->>'content' AS content,
       candidate->>'severity' AS severity,
       candidate->>'rationale' AS rationale,
       (candidate->>'confidence')::numeric::text AS confidence,
       id AS compaction_id
     FROM memory_compactions,
       jsonb_array_elements(procedural_candidates_json) AS candidate
     ${where}
     ORDER BY (candidate->>'confidence')::numeric DESC`,
    params,
  );

  const seen = new Map<string, ActiveRule>();
  for (const row of rows.rows) {
    const existing = seen.get(row.name);
    if (existing) {
      existing.sourceCompactionIds.push(row.compaction_id);
    } else {
      seen.set(row.name, {
        name: row.name, content: row.content,
        severity: normalizeSeverity(row.severity),
        rationale: row.rationale,
        confidence: Number(row.confidence),
        sourceCompactionIds: [row.compaction_id],
      });
    }
  }
  return [...seen.values()];
}

function normalizeSeverity(value: string): ActiveRule['severity'] {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  return 'info';
}
