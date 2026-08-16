/**
 * Recursive subagent lineage for one session.
 *
 * Phase 4: parent_run_spec_id chains rooted at the session's run specs, each
 * node enriched with child.agent.* lifecycle status, token usage and cost from
 * the child session's model.response events, and duration. UI counterpart:
 * the DSH ui-subagent catalog tree pattern.
 */

import { getDb } from '@los/infra/db';
import { ensureRunSpecStore, listRunSpecsForSession, type RunSpecRecord } from './run-specs.js';
import { ensureSessionEventStore } from './session-events.js';

export interface SubagentUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
}

export interface SubagentTreeNode {
  runSpecId: string;
  sessionId: string;
  status: string;
  /** Latest child.agent.* lifecycle event on the child session, if any. */
  eventStatus: 'started' | 'completed' | 'failed' | 'killed' | null;
  provider?: string;
  model?: string;
  promptPreview: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  estimatedCostUsd: number;
  usage: SubagentUsage;
  children: SubagentTreeNode[];
}

export interface SessionSubagents {
  sessionId: string;
  roots: Array<{ runSpecId: string; status: string }>;
  tree: SubagentTreeNode[];
}

const EMPTY_USAGE: SubagentUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  totalTokens: 0,
};

interface UsageRow {
  prompt: string;
  completion: string;
  cache_hit: string;
  cache_miss: string;
  cost: string | null;
}

function num(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function eventStatusFrom(types: readonly string[]): SubagentTreeNode['eventStatus'] {
  const order: Array<SubagentTreeNode['eventStatus']> = ['killed', 'failed', 'completed', 'started'];
  for (const candidate of order) {
    if (candidate !== null && types.includes(`child.agent.${candidate}`)) return candidate;
  }
  return null;
}

function promptPreview(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

async function childRunSpecs(parentRunSpecId: string): Promise<RunSpecRecord[]> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM run_specs WHERE parent_run_spec_id = $1 ORDER BY created_at ASC`,
    [parentRunSpecId],
  );
  return rows.rows.map(row => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    parentRunSpecId: row.parent_run_spec_id ? String(row.parent_run_spec_id) : undefined,
    prompt: String(row.prompt ?? ''),
    provider: row.provider ? String(row.provider) : undefined,
    model: row.model ? String(row.model) : undefined,
    modelSettings: (row.model_settings_json ?? {}) as Record<string, unknown>,
    workspaceRoot: String(row.workspace_root ?? ''),
    toolMode: String(row.tool_mode ?? ''),
    allowedTools: Array.isArray(row.allowed_tools_json) ? row.allowed_tools_json as string[] : [],
    toolRetry: (row.tool_retry_json ?? {}) as Record<string, unknown>,
    maxLoops: Number(row.max_loops ?? 0),
    mcpServers: Array.isArray(row.mcp_servers_json) ? row.mcp_servers_json as Array<{ command: string }> : [],
    status: (String(row.status ?? 'created') as RunSpecRecord['status']),
    result: null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }));
}

/**
 * Child-agent lifecycle events live on the PARENT session, keyed by
 * childRunSpecId in the payload. Load them once per query for the root session.
 */
async function loadLifecycleIndex(sessionId: string): Promise<Map<string, string>> {
  await ensureSessionEventStore();
  const db = getDb();
  const rows = await db.query<{ type: string; child_run_spec_id: string | null }>(
    `SELECT type, payload_json->>'childRunSpecId' AS child_run_spec_id
      FROM session_events
      WHERE session_id = $1 AND type LIKE 'child.agent.%'
      ORDER BY id ASC`,
    [sessionId],
  );
  const byRunSpec = new Map<string, string>();
  for (const row of rows.rows) {
    if (!row.child_run_spec_id) continue;
    byRunSpec.set(row.child_run_spec_id, row.type);
  }
  return byRunSpec;
}

async function enrichUsage(sessionId: string): Promise<{ usage: SubagentUsage; costUsd: number }> {
  await ensureSessionEventStore();
  const db = getDb();
  const usageRows = await db.query<UsageRow>(
    `SELECT
        SUM(COALESCE((usage_json->>'promptTokens')::numeric, 0))::text AS prompt,
        SUM(COALESCE((usage_json->>'completionTokens')::numeric, 0))::text AS completion,
        SUM(COALESCE((usage_json->>'cacheHitTokens')::numeric, 0))::text AS cache_hit,
        SUM(COALESCE((usage_json->>'cacheMissTokens')::numeric, 0))::text AS cache_miss,
        SUM(COALESCE((payload_json->'cost'->>'totalCostUsd')::numeric, 0))::text AS cost
      FROM session_events
      WHERE session_id = $1 AND type = 'model.response'`,
    [sessionId],
  );
  const row = usageRows.rows[0];
  const promptTokens = num(row?.prompt);
  const completionTokens = num(row?.completion);
  const cacheHitTokens = num(row?.cache_hit);
  const cacheMissTokens = num(row?.cache_miss);
  const usage: SubagentUsage = {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: promptTokens + completionTokens,
  };
  return { usage, costUsd: num(row?.cost) };
}

async function buildNode(
  runSpec: RunSpecRecord,
  depth: number,
  maxDepth: number,
  lifecycleByChild: ReadonlyMap<string, string>,
): Promise<SubagentTreeNode> {
  const { usage, costUsd } = await enrichUsage(runSpec.sessionId);
  const lifecycleType = lifecycleByChild.get(runSpec.id);
  const started = new Date(runSpec.createdAt).getTime();
  const ended = new Date(runSpec.updatedAt).getTime();
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
    ? ended - started
    : null;
  const children = depth < maxDepth
    ? await Promise.all(
        (await childRunSpecs(runSpec.id)).map(child => buildNode(child, depth + 1, maxDepth, lifecycleByChild)),
      )
    : [];
  return {
    runSpecId: runSpec.id,
    sessionId: runSpec.sessionId,
    status: runSpec.status,
    eventStatus: lifecycleType ? eventStatusFrom([lifecycleType]) : null,
    provider: runSpec.provider,
    model: runSpec.model,
    promptPreview: promptPreview(runSpec.prompt),
    createdAt: runSpec.createdAt,
    updatedAt: runSpec.updatedAt,
    durationMs,
    estimatedCostUsd: costUsd,
    usage,
    children,
  };
}

export async function getSessionSubagents(
  sessionId: string,
  maxDepth = 4,
): Promise<SessionSubagents> {
  const depth = Math.min(8, Math.max(1, Math.floor(maxDepth)));
  const lifecycleByChild = await loadLifecycleIndex(sessionId);
  const roots = await listRunSpecsForSession(sessionId, 50);
  const tree = await Promise.all(roots.map(root => buildNode(root, 1, depth, lifecycleByChild)));
  return {
    sessionId,
    roots: roots.map(root => ({ runSpecId: root.id, status: root.status })),
    tree,
  };
}

export { EMPTY_USAGE };
