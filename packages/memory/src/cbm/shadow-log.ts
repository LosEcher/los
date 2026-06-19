/**
 * @los/memory/cbm/shadow-log — Shadow-mode measurement log.
 *
 * When codeGraph.shadowMode is enabled, every chat session records
 * CBM query metrics to a local JSONL file without affecting any
 * database tables or agent behavior.
 *
 * File: .los/cbm-shadow-log.jsonl
 * Format: one JSON object per line
 *
 * CLI: los cbm shadow-stats     → human-readable aggregation
 *       los cbm shadow-stats --json → machine-readable
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = '.los';
const LOG_FILE = 'cbm-shadow-log.jsonl';

// ── Types ────────────────────────────────────────────────

export interface ShadowLogEntry {
  timestamp: string;
  sessionId: string;
  runSpecId: string;
  targetFiles: string[];
  symbolCount: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface ShadowStats {
  totalEntries: number;
  successRate: number;
  avgLatencyMs: number;
  avgSymbolCount: number;
  sessionsWithFiles: number;
  sessionsWithoutFiles: number;
}

// ── Write ────────────────────────────────────────────────

let _logDir: string | null = null;

export function setShadowLogDir(dir: string): void {
  _logDir = dir;
}

export function appendShadowLog(entry: ShadowLogEntry): void {
  try {
    const dir = join(_logDir ?? process.cwd(), LOG_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, LOG_FILE);
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    // Shadow log failure must never affect the main flow
  }
}

// ── Read ─────────────────────────────────────────────────

export function readShadowLog(): ShadowLogEntry[] {
  try {
    const dir = join(_logDir ?? process.cwd(), LOG_DIR);
    const path = join(dir, LOG_FILE);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as ShadowLogEntry);
  } catch {
    return [];
  }
}

// ── Stats ────────────────────────────────────────────────

export function computeShadowStats(entries?: ShadowLogEntry[]): ShadowStats {
  const data = entries ?? readShadowLog();
  const successCount = data.filter(e => e.success).length;
  const filesCount = data.filter(e => e.targetFiles.length > 0).length;

  return {
    totalEntries: data.length,
    successRate: data.length > 0 ? successCount / data.length : 0,
    avgLatencyMs: data.length > 0
      ? data.reduce((s, e) => s + e.latencyMs, 0) / data.length
      : 0,
    avgSymbolCount: data.length > 0
      ? data.reduce((s, e) => s + e.symbolCount, 0) / data.length
      : 0,
    sessionsWithFiles: filesCount,
    sessionsWithoutFiles: data.length - filesCount,
  };
}

export function printShadowStats(): string {
  const stats = computeShadowStats();
  const lines = [
    `== CBM Shadow Mode Stats ==`,
    `  Total sessions:    ${stats.totalEntries}`,
    `  Success rate:      ${(stats.successRate * 100).toFixed(0)}%`,
    `  Avg latency:       ${stats.avgLatencyMs.toFixed(0)}ms`,
    `  Avg symbols:       ${stats.avgSymbolCount.toFixed(1)}`,
    `  With target files: ${stats.sessionsWithFiles}`,
    `  Without files:     ${stats.sessionsWithoutFiles}`,
  ];

  // Pass/fail thresholds from the plan
  if (stats.totalEntries >= 20) {
    lines.push('');
    lines.push('  Phase 1 decision thresholds (≥20 sessions):');
    lines.push(`    Success rate ≥ 90%:  ${stats.successRate >= 0.9 ? '✓ PASS' : '✗ FAIL'}`);
    lines.push(`    Avg latency < 200ms: ${stats.avgLatencyMs < 200 ? '✓ PASS' : '✗ FAIL'}`);
    lines.push(`    Avg symbols ≥ 3:    ${stats.avgSymbolCount >= 3 ? '✓ PASS' : '✗ FAIL'}`);
  } else {
    lines.push('');
    lines.push(`  (Need ${20 - stats.totalEntries} more sessions for Phase 1 decision)`);
  }

  return lines.join('\n');
}
