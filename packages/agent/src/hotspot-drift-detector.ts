/**
 * Hotspot & Tool Drift Detection — file size + tool usage hotspot governance.
 *
 * Detects two drift dimensions:
 *   1. File size drift — files approaching thresholds (400 / 600 lines) and trending
 *   2. Tool usage drift — tool call frequency changes, error patterns
 *
 * Integrated into governance sweep pipeline as a 'file_size' job type.
 * Stores baseline against first run and detects drift on subsequent runs.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('hotspot-drift');

// ── Types ───────────────────────────────────────────────

export interface FileSizeSnapshot {
  /** Absolute file path relative to workspace root */
  file: string;
  lines: number;
  package: string;
  /** Last time this file was seen at >400 lines */
  lastSeenAt?: string;
  /** Trend: +N lines since previous scan, negative = shrinking */
  delta?: number;
}

export interface FileHotspotReport {
  scannedAt: string;
  workspaceRoot: string;
  totalFilesScanned: number;
  filesOver600: FileSizeSnapshot[];
  filesOver400: FileSizeSnapshot[];
  newCrossers: FileSizeSnapshot[];  // files that crossed 400 since last scan
  new600Crossers: FileSizeSnapshot[]; // files that crossed 600 since last scan
  shrank: FileSizeSnapshot[];  // files that dropped below thresholds
  trend: {
    totalOver400Delta: number;
    totalOver600Delta: number;
    avgDelta: number;
    worseningFiles: string[];  // files that grew >10% since last scan
  };
}

export interface ToolCallFrequency {
  toolName: string;
  calls: number;
  errors: number;
  errorRate: number;
  averageDurationMs: number;
  lastUsedAt: string;
}

export interface ToolDriftReport {
  scannedAt: string;
  tools: ToolCallFrequency[];
  errorSpikes: ToolCallFrequency[];  // tools with error rate increase >50pp
  unusedTools: string[];  // tools not called in 7+ days
  hotTools: ToolCallFrequency[];  // tools with 2x frequency increase
}

// ── Config ───────────────────────────────────────────────

const SIZE_THRESHOLD_400 = 400;
const SIZE_THRESHOLD_600 = 600;
const DELTA_WARN_PERCENT = 10;     // 10% size increase triggers warn
const ERROR_RATE_SPIKE_PCT = 50;   // 50pp increase triggers spike alert
const TOOL_UNUSED_DAYS = 7;
const TOOL_HOT_FACTOR = 2.0;       // 2x frequency increase triggers hot

// ── File size scanning ──────────────────────────────────

function extractPackage(filePath: string): string {
  const match = filePath.match(/packages\/([^/]+)\//);
  return match ? match[1] : 'root';
}

/**
 * Scan workspace for files exceeding thresholds.
 * Uses the same glob pattern as check-structure.sh.
 */
export async function scanFileHotspots(opts: {
  workspaceRoot: string;
  excludePatterns?: string[];
}): Promise<FileHotspotReport> {
  const root = opts.workspaceRoot || process.cwd();
  const { glob } = await import('fast-glob');
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, relative } = await import('node:path');

  const exclude = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    '**/*.pbxproj',
    '**/*.plist',
    '**/*.lock',
    '**/*.json',
    '**/*.yaml',
    '**/*.yml',
    '**/*.md',
    '**/*.css',
    '**/*.svg',
    ...(opts.excludePatterns ?? []),
  ];

  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: root,
    absolute: true,
    ignore: exclude,
    dot: false,
  });

  const snapshots: { file: string; lines: number; package: string }[] = [];

  for (const abs of files) {
    try {
      const content = readFileSync(abs, 'utf-8');
      const lines = content.split('\n').length;
      const rel = relative(root, abs);
      snapshots.push({ file: rel, lines, package: extractPackage(rel) });
    } catch {
      // Permission denied, binary file, etc. — skip
    }
  }

  // Load previous baseline from governance_jobs
  const db = getDb();
  const prev = await db.query<{
    id: string;
    result_summary: unknown;
  }>(
    `SELECT id, result_summary
     FROM governance_jobs
     WHERE job_type = 'file_size'
       AND result_summary IS NOT NULL
     ORDER BY last_run_at DESC
     LIMIT 1`,
    [],
  );

  let previousFiles: Map<string, number> = new Map();

  if (prev.rows.length > 0) {
    const prevSummary = typeof prev.rows[0].result_summary === 'string'
      ? JSON.parse(prev.rows[0].result_summary)
      : (prev.rows[0].result_summary as Record<string, unknown>) ?? {};
    const prevOver400 = (prevSummary.filesOver400 as Array<{ file: string; lines: number }>) ?? [];
    const prevOver600 = (prevSummary.filesOver600 as Array<{ file: string; lines: number }>) ?? [];
    for (const f of [...prevOver400, ...prevOver600]) {
      previousFiles.set(f.file, f.lines);
    }
  }

  const over400 = snapshots
    .filter(s => s.lines > SIZE_THRESHOLD_400)
    .sort((a, b) => b.lines - a.lines);

  const over600 = over400.filter(s => s.lines > SIZE_THRESHOLD_600);

  const over400Set = new Set(over400.map(s => s.file));
  const over600Set = new Set(over600.map(s => s.file));

  const newCrossers: FileSizeSnapshot[] = [];
  const new600Crossers: FileSizeSnapshot[] = [];
  const shrank: FileSizeSnapshot[] = [];
  const worseningFiles: string[] = [];

  for (const s of over400) {
    const prevLines = previousFiles.get(s.file);
    const delta = prevLines !== undefined ? s.lines - prevLines : 0;

    if (prevLines === undefined || prevLines <= SIZE_THRESHOLD_400) {
      newCrossers.push({ ...s, delta });
    }
    if (prevLines === undefined || prevLines <= SIZE_THRESHOLD_600) {
      if (s.lines > SIZE_THRESHOLD_600) {
        new600Crossers.push({ ...s, delta });
      }
    }
    if (delta > 0 && prevLines !== undefined && (delta / prevLines) * 100 > DELTA_WARN_PERCENT) {
      worseningFiles.push(s.file);
    }
  }

  for (const [file, prevLines] of previousFiles) {
    if (!over400Set.has(file)) {
      shrank.push({ file, lines: 0, package: extractPackage(file), delta: -prevLines });
    }
  }

  const totalOver400Delta = over400.reduce((sum, s) => {
    const prev = previousFiles.get(s.file);
    return sum + (prev !== undefined ? s.lines - prev : s.lines);
  }, 0);

  const totalOver600Delta = over600.reduce((sum, s) => {
    const prev = previousFiles.get(s.file);
    return sum + (prev !== undefined ? s.lines - prev : s.lines);
  }, 0);

  const avgDelta = over400.length > 0 ? totalOver400Delta / over400.length : 0;

  return {
    scannedAt: new Date().toISOString(),
    workspaceRoot: root,
    totalFilesScanned: snapshots.length,
    filesOver600: over600,
    filesOver400: over400,
    newCrossers,
    new600Crossers,
    shrank,
    trend: {
      totalOver400Delta,
      totalOver600Delta,
      avgDelta: Math.round(avgDelta * 10) / 10,
      worseningFiles,
    },
  };
}

// ── Tool usage drift ─────────────────────────────────────

export async function scanToolDrift(opts: {
  sinceHours?: number;
}): Promise<ToolDriftReport> {
  const sinceHours = opts.sinceHours ?? 168; // default: 7 days
  const db = getDb();

  // Current period tool usage
  const currentRows = await db.query<{
    tool_name: string;
    call_count: string;
    error_count: string;
    avg_duration_ms: string;
    last_used: string;
  }>(
    `
    SELECT
      COALESCE(tool_name, 'unknown') AS tool_name,
      COUNT(*)::text AS call_count,
      COUNT(*) FILTER (WHERE event_type = 'tool.error' OR event_type = 'tool.failed')::text AS error_count,
      COALESCE(AVG(NULLIF((payload_json->>'duration_ms')::numeric, 0)), 0)::text AS avg_duration_ms,
      MAX(created_at)::text AS last_used
    FROM session_events
    WHERE created_at > now() - ($1 || ' hours')::INTERVAL
      AND event_type LIKE 'tool.%'
    GROUP BY tool_name
    ORDER BY call_count DESC
  `,
    [String(sinceHours)],
  );

  // Previous period for comparison
  const prevRows = await db.query<{
    tool_name: string;
    call_count: string;
    error_count: string;
  }>(
    `
    SELECT
      COALESCE(tool_name, 'unknown') AS tool_name,
      COUNT(*)::text AS call_count,
      COUNT(*) FILTER (WHERE event_type = 'tool.error' OR event_type = 'tool.failed')::text AS error_count
    FROM session_events
    WHERE created_at > now() - (($1 * 2) || ' hours')::INTERVAL
      AND created_at <= now() - ($1 || ' hours')::INTERVAL
      AND event_type LIKE 'tool.%'
    GROUP BY tool_name
    ORDER BY call_count DESC
  `,
    [String(sinceHours)],
  );

  const prevMap = new Map<string, { calls: number; errors: number }>();
  for (const r of prevRows.rows) {
    prevMap.set(r.tool_name, {
      calls: Number(r.call_count),
      errors: Number(r.error_count),
    });
  }

  const now = Date.now();
  const tools: ToolCallFrequency[] = currentRows.rows.map(r => {
    const calls = Number(r.call_count);
    const errors = Number(r.error_count);
    const errorRate = calls > 0 ? errors / calls : 0;
    const avgDurationMs = Number(r.avg_duration_ms);

    return {
      toolName: r.tool_name,
      calls,
      errors,
      errorRate: Math.round(errorRate * 1000) / 10,
      averageDurationMs: Math.round(avgDurationMs),
      lastUsedAt: r.last_used,
    };
  });

  const errorSpikes: ToolCallFrequency[] = [];
  const hotTools: ToolCallFrequency[] = [];
  const unusedTools: string[] = [];

  for (const t of tools) {
    const prev = prevMap.get(t.toolName);

    // Error spike: error rate increased >50 percentage points
    if (prev && prev.calls > 0) {
      const prevErrorRate = prev.errors / prev.calls;
      const diff = t.errorRate - (prevErrorRate * 100);
      if (diff > ERROR_RATE_SPIKE_PCT) {
        errorSpikes.push(t);
      }
    }

    // Hot tools: frequency 2x or more increase
    if (prev && prev.calls > 0 && t.calls >= prev.calls * TOOL_HOT_FACTOR) {
      hotTools.push(t);
    }

    // Unused tools: not called in TOOL_UNUSED_DAYS
    const lastMs = new Date(t.lastUsedAt).getTime();
    const daysSince = (now - lastMs) / (1000 * 60 * 60 * 24);
    if (daysSince >= TOOL_UNUSED_DAYS && t.calls > 0) {
      unusedTools.push(t.toolName);
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    tools,
    errorSpikes,
    unusedTools,
    hotTools,
  };
}
