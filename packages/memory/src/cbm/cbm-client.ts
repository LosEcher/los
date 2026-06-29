/**
 * @los/memory/cbm/cbm-client — Codebase-memory-mcp (CBM) client wrapper.
 *
 * Reuses @los/agent's MCPClient for stdio transport. Provides a
 * narrow, typed interface over the CBM knowledge graph. All methods
 * are best-effort: CBM unavailability returns empty results, never
 * throws to the caller.
 *
 * Measurement: every operation records latency and success/failure
 * in an internal CBMMetrics bag. Call `getMetrics()` to read it.
 */

import { MCPClient } from '@los/agent';
import type { MCPServerConfig } from '@los/agent';
import { getLogger } from '@los/infra/logger';

const log = getLogger('cbm-client');

// ── Public types ──────────────────────────────────────────

export interface CBMArchitecture {
  languages: string[];
  packages: string[];
  entryPoints: CBMSymbol[];
  routes: CBMRoute[];
  hotspots: CBMHotspot[];
  boundaries: CBMBoundary[];
  clusters: CBMCluster[];
}

export interface CBMSymbol {
  id: string; // qualified_name
  name: string;
  kind: 'Function' | 'Method' | 'Class' | 'Interface' | 'Type' | 'Module' | 'File' | 'Route' | 'Resource';
  file: string; // file_path
  line?: number;
  language?: string;
}

export interface CBMRoute {
  method: string;
  path: string;
  file?: string;
  handler?: string;
}

export interface CBMHotspot {
  symbol: string;
  file: string;
  reason: string;
}

export interface CBMBoundary {
  name: string;
  files: string[];
}

export interface CBMCluster {
  label: string;
  memberCount: number;
  cohesionScore: number;
}

export interface CBMCallerInfo {
  symbol: string;
  callerFile: string;
  callerLine?: number;
}

export interface CBMPathResult {
  path: Array<{ symbol: string; file: string; relation: string }>;
}

export interface CBMChangeImpact {
  symbol: CBMSymbol;
  blastRadius: Array<{ symbolId: string; relation: string; distance: number }>;
  risk: 'low' | 'medium' | 'high';
}

export interface CBMMetrics {
  queries: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  totalBytesReturned: number;
  byOperation: Record<string, { count: number; avgLatency: number; errors: number }>;
}

// ── Client ────────────────────────────────────────────────

export class CBMClient {
  private client: MCPClient | null = null;
  private initialized = false;
  private metrics: CBMMetrics = {
    queries: 0, successes: 0, failures: 0, avgLatencyMs: 0, totalBytesReturned: 0, byOperation: {},
  };

  private workspaceRoot?: string;

  constructor(private config: MCPServerConfig) {}

  /** Set the workspace root for project-name derivation in queries. */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
  }

  /** Create a default CBM client targeting the current workspace. */
  static createDefault(opts?: { command?: string; args?: string[] }): CBMClient {
    return new CBMClient({
      command: opts?.command ?? 'codebase-memory-mcp',
      args: opts?.args ?? [],
    });
  }

  async connect(): Promise<void> {
    try {
      this.client = new MCPClient(this.config);
      await this.client.connect();
      this.initialized = true;
      log.info('CBM connected');
    } catch (err) {
      log.warn(`CBM connect failed: ${err instanceof Error ? err.message : String(err)}`);
      this.initialized = false;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this.initialized = false;
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  getMetrics(): CBMMetrics {
    return { ...this.metrics, byOperation: { ...this.metrics.byOperation } };
  }

  // ── Operations ─────────────────────────────────────────

  /**
   * Get high-level architecture overview. Useful for orienting an agent
   * before it starts exploring files.
   */
  async getArchitecture(): Promise<CBMArchitecture | null> {
    return this.callTool('get_architecture', { aspects: ['all'] }, raw => {
      return {
        languages: raw.languages ?? [],
        packages: raw.packages ?? [],
        entryPoints: normalizeEntryPoints(raw.entry_points ?? []),
        routes: raw.routes ?? [],
        hotspots: raw.hotspots ?? [],
        boundaries: raw.boundaries ?? [],
        clusters: (raw.clusters ?? []).map((c: any) => ({
          label: c.label ?? '', memberCount: c.member_count ?? 0, cohesionScore: c.cohesion_score ?? 0,
        })),
      };
    });
  }

  /**
   * Resolve a set of file paths to their CBM symbols.
   * Each file is queried independently; results are merged and deduplicated.
   */
  async resolveSymbols(files: Array<{ path: string; line?: number }>): Promise<CBMSymbol[]> {
    const all: CBMSymbol[] = [];
    for (const f of files) {
      const result = await this.callTool('search_graph', { query: f.path, limit: 50 }, raw => {
        const results: any[] = raw.results ?? raw.nodes ?? [];
        return results
          .filter((r: any) => r.file_path === f.path || r.file === f.path)
          .map((r: any) => ({
            id: r.qualified_name ?? r.id ?? `${f.path}:${r.name}`,
            name: r.name ?? '?',
            kind: r.label ?? r.kind ?? 'Function',
            file: r.file_path ?? r.file ?? f.path,
            line: r.start_line ?? r.line ?? undefined,
            language: r.language ?? undefined,
          }));
      });
      if (result) all.push(...result);
    }
    // Deduplicate by id
    const seen = new Set<string>();
    return all.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }

  /**
   * Given a list of CBM symbol IDs, return the callers of each symbol.
   */
  async getCallers(symbolIds: string[]): Promise<Map<string, CBMCallerInfo[]>> {
    const result = new Map<string, CBMCallerInfo[]>();
    for (const sid of symbolIds) {
      const callers = await this.callTool('trace_path', {
        function_name: sid,
        direction: 'inbound',
        depth: 1,
      }, raw => {
        const edges: any[] = raw.edges ?? raw.results ?? [];
        return edges.map((e: any) => ({
          symbol: e.from_name ?? e.from ?? '?',
          callerFile: e.from_file ?? '?',
          callerLine: e.from_line ?? undefined,
        }));
      });
      if (callers && callers.length > 0) result.set(sid, callers);
    }
    return result;
  }

  /**
   * Query for a Cypher pattern. Returns raw rows.
   */
  async cypherQuery(query: string, limit = 50): Promise<{ columns: string[]; rows: any[][] } | null> {
    return this.callTool('query_graph', { query, limit }, raw => ({
      columns: raw.columns ?? [],
      rows: raw.rows ?? [],
    }));
  }

  // ── Internals ──────────────────────────────────────────

  private async callTool<T>(
    tool: string,
    args: Record<string, unknown>,
    map: (raw: any) => T,
  ): Promise<T | null> {
    const opKey = tool;
    const start = Date.now();
    this.metrics.queries++;
    this.metrics.byOperation[opKey] ??= { count: 0, avgLatency: 0, errors: 0 };
    this.metrics.byOperation[opKey].count++;

    if (!this.initialized || !this.client) {
      this.metrics.failures++;
      this.metrics.byOperation[opKey].errors++;
      return null;
    }

    try {
      // Ensure project is set for tools that need it
      if (!args.project && tool !== 'get_architecture') {
        args.project = CBMClient.projectName(this.workspaceRoot);
      }

      const rawText = await this.client.callTool(tool, args);
      const parsed = JSON.parse(rawText);
      const elapsed = Date.now() - start;

      this.metrics.successes++;
      this.metrics.totalBytesReturned += rawText.length;

      // Rolling average latency
      const prev = this.metrics.byOperation[opKey];
      prev.avgLatency = (prev.avgLatency * (prev.count - 1) + elapsed) / prev.count;
      this.metrics.avgLatencyMs =
        (this.metrics.avgLatencyMs * (this.metrics.queries - 1) + elapsed) / this.metrics.queries;

      return map(parsed);
    } catch (err) {
      this.metrics.failures++;
      this.metrics.byOperation[opKey].errors++;
      log.warn(`CBM ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Derive a stable CBM project name from the workspace root. */
  static projectName(workspaceRoot?: string): string {
    if (workspaceRoot) {
      // Convert /absolute/path/to/project → absolute-path-to-project
      // CBM auto-names from repo paths by replacing separators.
      return workspaceRoot.replace(/^\//, '').replace(/\//g, '-');
    }
    // Fall back to the los project name when no workspace is given.
    return 'Users-echerlos-projects-los-workspace-projects-los';
  }
}

// ── Helpers ──────────────────────────────────────────────

function normalizeEntryPoints(raw: any[]): CBMSymbol[] {
  return raw.map((ep: any) => ({
    id: ep.qualified_name ?? ep.id ?? ep.name ?? '?',
    name: ep.name ?? '?',
    kind: ep.kind ?? ep.label ?? 'Function',
    file: ep.file_path ?? ep.file ?? '?',
    line: ep.line ?? ep.start_line ?? undefined,
  }));
}
