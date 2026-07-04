/**
 * @los/agent/governance-auditors-code-topology — topology cluster auditor.
 *
 * Reads a target repo from job.config, connects to CBM (codebase-memory-mcp),
 * extracts the architecture graph, and groups routes into logical topology
 * clusters. Each cluster becomes a dispatchable todo for los chat review.
 *
 * This is detection-only (no auto-fix). The real work happens when the operator
 * dispatches the generated todos.
 */

import { existsSync } from 'node:fs';
import { getLogger } from '@los/infra/logger';

import type { GovernanceJob } from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

// ── Types ──────────────────────────────────────────────────

export interface TopologyCluster {
  /** Short label, e.g. "auth", "snapshots", "feed-analysis" */
  name: string;
  /** Route paths found in this cluster, e.g. ["POST /auth/register", ...] */
  routes: string[];
  /** File paths relative to the target repo root */
  files: string[];
  /** Deduplicated count of files */
  fileCount: number;
  /** Review dimensions to check */
  dimensions: string[];
  /** Priority for the generated todo */
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** If this maps to a CBM-detected cluster */
  cbmClusterLabel?: string;
  /** Cohesion score from CBM, if available */
  cohesionScore?: number;
}

export interface CodeTopologyAuditSummary {
  auditedAt: string;
  projectName: string;
  targetRepo: string;
  cbmAvailable: boolean;
  cbmError?: string;
  totalRoutes: number;
  totalFiles: number;
  totalPackages: number;
  clusterCount: number;
  clusters: TopologyCluster[];
}

// ── Dimension heuristics ───────────────────────────────────

const SECURITY_PATH_PATTERNS = [/\/auth\b/, /\/login\b/, /\/register\b/, /\/token\b/, /\/session\b/, /\/password\b/, /\/credential\b/, /\/apikey\b/, /api.?key/];
const DATA_PATH_PATTERNS = [/\/repository\b/, /\brepository\b/, /\/db\b/, /\/database\b/, /\/store\b/, /\/migrat/, /\/sql\b/];
const WIRING_PATH_PATTERNS = [/\/service\b/, /\bservice\b/, /\bcontainer\b/, /\/provider\b/, /\/factory\b/, /\/middleware\b/, /\bhandler\b/, /\brouter\b/];
const CRITICAL_PATH_PATTERNS = [/\/crypto\b/, /\/auth\b/, /\/jwt\b/, /\/token\b/, /\/api.?key/, /\/secret\b/, /\/password\b/];

function assignDimensions(files: string[], routes: string[]): string[] {
  const dims: string[] = [];
  const allText = [...files, ...routes].join(' ').toLowerCase();

  if (SECURITY_PATH_PATTERNS.some(p => p.test(allText))) dims.push('security');
  if (DATA_PATH_PATTERNS.some(p => p.test(allText))) dims.push('data-integrity');
  if (WIRING_PATH_PATTERNS.some(p => p.test(allText))) dims.push('wiring');
  dims.push('error-handling');
  dims.push('structure');
  return dims;
}

function assignPriority(files: string[], dims: string[], hasHotspots: boolean): TopologyCluster['priority'] {
  const fileText = files.join(' ').toLowerCase();
  const touchesCritical = CRITICAL_PATH_PATTERNS.some(p => p.test(fileText));

  if (hasHotspots && (dims.includes('security') || touchesCritical)) return 'P0';
  if (dims.includes('security') || touchesCritical) return 'P1';
  if (hasHotspots && files.length > 8) return 'P1';
  if (dims.includes('wiring') && files.length > 10) return 'P2';
  if (files.length > 10) return 'P2';
  return 'P3';
}

// ── Cluster formation ──────────────────────────────────────

interface RawRoute {
  method?: string;
  path?: string;
  file?: string;
  handler?: string;
}

interface RawHotspot {
  symbol?: string;
  file?: string;
  reason?: string;
}

function groupRoutes(routes: RawRoute[]): Map<string, { routes: RawRoute[]; files: Set<string> }> {
  const groups = new Map<string, { routes: RawRoute[]; files: Set<string> }>();

  for (const r of routes) {
    const path: string = r.path ?? '';
    const file: string = r.file ?? '';
    // Derive cluster name from route path prefix
    let name = 'misc';
    const segments = path.replace(/^\//, '').split('/');
    if (segments.length >= 1 && segments[0]) {
      name = segments[0]; // first path segment, e.g. "auth", "snapshots"
      // Special case: sub-resources like /admin/queue → "admin"
      // already handled by first-segment logic
    }

    if (!groups.has(name)) {
      groups.set(name, { routes: [], files: new Set() });
    }
    const group = groups.get(name)!;
    group.routes.push(r);
    if (file) group.files.add(file);
  }

  return groups;
}

function collectClusterFiles(groups: Map<string, { routes: RawRoute[]; files: Set<string> }>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, group] of groups) {
    result.set(name, [...group.files].sort());
  }
  return result;
}

function mergeSmallClusters(
  groups: Map<string, { routes: RawRoute[]; files: Set<string> }>,
  maxClusters = 25,
): Map<string, { routes: RawRoute[]; files: Set<string> }> {
  if (groups.size <= maxClusters) return groups;

  const miscRoutes: RawRoute[] = [];
  const miscFiles = new Set<string>();
  const kept = new Map<string, { routes: RawRoute[]; files: Set<string> }>();

  for (const [name, group] of groups) {
    if (group.routes.length <= 1 && kept.size < maxClusters) {
      // merge small clusters to keep cluster count manageable
      miscRoutes.push(...group.routes);
      for (const f of group.files) miscFiles.add(f);
    } else if (kept.size >= maxClusters) {
      // cap reached — funnel remaining into misc
      miscRoutes.push(...group.routes);
      for (const f of group.files) miscFiles.add(f);
    } else {
      kept.set(name, group);
    }
  }

  if (miscRoutes.length > 0) {
    kept.set('misc', { routes: miscRoutes, files: miscFiles });
  }

  return kept;
}

// ── Main auditor ───────────────────────────────────────────

export async function runCodeTopologyAudit(job: GovernanceJob): Promise<Record<string, unknown>> {
  const config = (job.config ?? {}) as Record<string, unknown>;
  const targetRepo: string = typeof config.targetRepo === 'string' ? config.targetRepo : '';
  const projectName: string = typeof config.projectName === 'string' ? config.projectName : '';

  if (!targetRepo || !projectName) {
    return {
      auditedAt: new Date().toISOString(),
      projectName: projectName || '(unset)',
      targetRepo: targetRepo || '(unset)',
      cbmAvailable: false,
      cbmError: 'Job config missing targetRepo or projectName',
      totalRoutes: 0,
      totalFiles: 0,
      totalPackages: 0,
      clusterCount: 0,
      clusters: [],
    };
  }

  // Validate target repo exists
  if (!existsSync(targetRepo)) {
    return {
      auditedAt: new Date().toISOString(),
      projectName,
      targetRepo,
      cbmAvailable: false,
      cbmError: `Target repo path does not exist: ${targetRepo}`,
      totalRoutes: 0,
      totalFiles: 0,
      totalPackages: 0,
      clusterCount: 0,
      clusters: [],
    };
  }

  // Connect to CBM
  let cbmAvailable = false;
  let cbmError: string | undefined;
  let architecture: Awaited<ReturnType<typeof importCbmArchitecture>> | null = null;

  try {
    architecture = await importCbmArchitecture(targetRepo);
    if (architecture) {
      cbmAvailable = true;
    } else {
      cbmError = 'CBM returned null architecture (project may not be indexed)';
    }
  } catch (err) {
    cbmError = `CBM connection failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!cbmAvailable || !architecture) {
    return {
      auditedAt: new Date().toISOString(),
      projectName,
      targetRepo,
      cbmAvailable: false,
      cbmError,
      totalRoutes: 0,
      totalFiles: 0,
      totalPackages: 0,
      clusterCount: 0,
      clusters: [],
    };
  }

  // Form clusters from routes
  const rawRoutes: RawRoute[] = (architecture.routes ?? []).map((r: any) => ({
    method: r.method ?? '',
    path: r.path ?? r.name ?? '',
    file: r.file ?? r.file_path ?? '',
    handler: r.handler ?? '',
  }));
  const rawHotspots: RawHotspot[] = (architecture.hotspots ?? []).map((h: any) => ({
    symbol: h.symbol ?? h.name ?? '',
    file: h.file ?? h.file_path ?? '',
    reason: h.reason ?? '',
  }));
  const hotspotFiles = new Set(rawHotspots.filter(h => h.file).map(h => h.file!));

  const groups = groupRoutes(rawRoutes);
  const merged = mergeSmallClusters(groups);
  const clusterFiles = collectClusterFiles(merged);

  // CBM cluster data for cross-reference
  const cbmClusters: Array<{ label: string; memberCount: number; cohesionScore: number }> =
    (architecture.clusters ?? []).map((c: any) => ({
      label: c.label ?? '',
      memberCount: c.memberCount ?? c.member_count ?? 0,
      cohesionScore: c.cohesionScore ?? c.cohesion_score ?? 0,
    }));

  // Build topology clusters
  const clusters: TopologyCluster[] = [];
  for (const [name, group] of merged) {
    const files = clusterFiles.get(name) ?? [];
    const routeLabels = group.routes.map(r => {
      const method = (r.method || '').trim().toUpperCase();
      return method ? `${method} ${r.path}` : r.path ?? '';
    }).filter(Boolean);

    const dims = assignDimensions(files, routeLabels);
    const hasHotspots = files.some(f => hotspotFiles.has(f));
    const priority = assignPriority(files, dims, hasHotspots);

    // Find matching CBM cluster
    const cbmMatch = cbmClusters.find(c =>
      c.label.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(c.label.toLowerCase()),
    );

    clusters.push({
      name,
      routes: routeLabels,
      files,
      fileCount: files.length,
      dimensions: dims,
      priority,
      cbmClusterLabel: cbmMatch?.label,
      cohesionScore: cbmMatch?.cohesionScore,
    });
  }

  // Sort by priority then file count descending
  clusters.sort((a, b) => {
    const priOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const priDiff = priOrder[a.priority] - priOrder[b.priority];
    if (priDiff !== 0) return priDiff;
    return b.fileCount - a.fileCount;
  });

  const allFiles = new Set<string>();
  for (const c of clusters) for (const f of c.files) allFiles.add(f);

  return {
    auditedAt: new Date().toISOString(),
    projectName,
    targetRepo,
    cbmAvailable: true,
    totalRoutes: rawRoutes.length,
    totalFiles: allFiles.size,
    totalPackages: (architecture.packages ?? []).length,
    clusterCount: clusters.length,
    clusters,
  };
}

// ── CBM bridge ─────────────────────────────────────────────

async function importCbmArchitecture(targetRepo: string) {
  // Use the generic MCPClient directly to avoid @los/memory → @los/agent circular
  // dependency. CBMClient is in @los/memory (depends on @los/agent). This auditor
  // is in @los/agent, so we call the CBM MCP server directly.
  const { MCPClient } = await import('./tools/external/mcp-client.js');
  const cbm = new MCPClient({
    command: 'codebase-memory-mcp',
    args: [],
  });
  await cbm.connect();

  try {
    // Derive CBM project name from targetRepo path (matches CBM's convention)
    const project = targetRepo.replace(/^\//, '').replace(/\//g, '-');
    const raw = await cbm.callTool('get_architecture', {
      project,
      aspects: ['all'],
    });
    const parsed: any = JSON.parse(raw);
    return {
      languages: parsed.languages ?? [],
      packages: parsed.packages ?? [],
      entryPoints: parsed.entry_points ?? parsed.entryPoints ?? [],
      routes: parsed.routes ?? [],
      hotspots: parsed.hotspots ?? [],
      boundaries: parsed.boundaries ?? [],
      clusters: (parsed.clusters ?? []).map((c: any) => ({
        label: c.label ?? '',
        memberCount: c.member_count ?? c.memberCount ?? 0,
        cohesionScore: c.cohesion_score ?? c.cohesionScore ?? 0,
      })),
    };
  } finally {
    await cbm.close();
  }
}
