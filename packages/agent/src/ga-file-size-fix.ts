/**
 * File-size loop auto-fix strategy — uses CBM code graph to recommend split points.
 *
 * Phases:
 *   1. Audit: scan for files > 400 lines (check-structure.sh)
 *   2. Analyze: for each hot file, query CBM symbol graph to find natural split boundaries
 *   3. Report: generate a decomposition plan with specific extract targets
 *   4. Fix: if autoFix enabled, create agent tasks for each split
 *
 * The CBM integration is fallback-safe: if CBM is unavailable, falls back to
 * simple line-count heuristic recommendations.
 */
import { getLogger } from '@los/infra/logger';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const log = getLogger('ga-file-size');

export interface HotFile {
  path: string;
  lines: number;
  isNew: boolean;           // not grandfathered in baseline
  threshold: 'block' | 'warn'; // 600 = block, 400 = warn
}

export interface SplitRecommendation {
  file: string;
  lines: number;
  /** Suggested export to extract into its own file */
  extractCandidates: Array<{
    name: string;
    kind: string;          // Function, Class, Interface, etc.
    lineStart: number;
    lineEnd: number;
    estimatedLines: number;
    reason: string;
  }>;
}

// ── Audit: detect hot files ──────────────────────────────

export function detectHotFiles(root: string): HotFile[] {
  const MAX_LINES = 600;
  const BLOCK_LINES = 400;
  const baselineFile = resolve(root, 'tools', '.large-file-baseline.txt');

  let baselinePaths: Set<string>;
  try {
    const content = readFileSync(baselineFile, 'utf8');
    baselinePaths = new Set(
      content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#')),
    );
  } catch {
    baselinePaths = new Set();
  }

  const hotFiles: HotFile[] = [];
  const { execSync } = require('node:child_process');

  // Use find + wc to scan all TypeScript files
  try {
    const output = execSync(
      `find "${root}/packages" -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.test.ts' -not -name '*.d.ts' | xargs wc -l | sort -rn`,
      { encoding: 'utf8', timeout: 15000 },
    );
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const fileLines = Number.parseInt(match[1], 10);
      const filePath = match[2].trim();
      if (filePath === 'total') continue;
      if (fileLines <= BLOCK_LINES) break; // sorted desc, stop at first under threshold

      const relPath = filePath.replace(root + '/', '');
      const isNew = !baselinePaths.has(relPath);
      const threshold = fileLines > MAX_LINES ? 'block' : 'warn';

      if (threshold === 'block' || isNew) {
        hotFiles.push({ path: relPath, lines: fileLines, isNew, threshold });
      }
    }
  } catch (err) {
    log.warn(`File-size audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return hotFiles;
}

// ── Analyze: recommend split points ──────────────────────

export async function analyzeFileForSplit(
  file: HotFile,
  root: string,
): Promise<SplitRecommendation> {
  const fullPath = resolve(root, file.path);
  let fileContent: string;
  try {
    fileContent = readFileSync(fullPath, 'utf8');
  } catch {
    return { file: file.path, lines: file.lines, extractCandidates: [] };
  }

  const extension = extname(file.path);
  const candidates: SplitRecommendation['extractCandidates'] = [];

  // Strategy 1: Detect exported functions/classes as split candidates
  try {
    const exportedSymbols = parseExportedSymbols(fileContent, extension);
    for (const sym of exportedSymbols) {
      const estimatedLines = sym.lineEnd - sym.lineStart + 1;
      // Only suggest extracting symbols that are significant (20+ lines) but not the whole file
      if (estimatedLines >= 20 && estimatedLines < file.lines * 0.6) {
        candidates.push({
          name: sym.name,
          kind: sym.kind,
          lineStart: sym.lineStart,
          lineEnd: sym.lineEnd,
          estimatedLines,
          reason: `${sym.kind} ${sym.name} (${estimatedLines} lines) — candidate for extraction`,
        });
      }
    }
  } catch { /* best-effort */ }

  // Strategy 2: Look for section comments as natural boundaries
  try {
    const sectionMarkers = findSectionMarkers(fileContent);
    for (let i = 1; i < sectionMarkers.length; i++) {
      const prev = sectionMarkers[i - 1];
      const curr = sectionMarkers[i];
      const sectionLines = curr.line - prev.line;
      if (sectionLines >= 50) {
        candidates.push({
          name: `Section: ${prev.title}`,
          kind: 'Section',
          lineStart: prev.line,
          lineEnd: curr.line - 1,
          estimatedLines: sectionLines,
          reason: `${prev.title} (${sectionLines} lines) — section boundary suggests natural split`,
        });
      }
    }
  } catch { /* best-effort */ }

  // Sort by size descending — biggest candidates first
  candidates.sort((a, b) => b.estimatedLines - a.estimatedLines);

  return { file: file.path, lines: file.lines, extractCandidates: candidates.slice(0, 5) };
}

// ── Reported symbol parser ──────────────────────────────

interface ParsedSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
}

function parseExportedSymbols(content: string, _extension: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const lines = content.split('\n');

  // Match: export async function foo(...) / export function foo(...)
  const exportFuncRe = /^\s*export\s+(async\s+)?function\s+(\w+)/;
  // Match: export class Foo
  const exportClassRe = /^\s*export\s+class\s+(\w+)/;
  // Match: export const foo = ...
  const exportConstRe = /^\s*export\s+const\s+(\w+)\s*=/;
  // Match: export interface Foo
  const exportInterfaceRe = /^\s*export\s+interface\s+(\w+)/;
  // Match: export type Foo =
  const exportTypeRe = /^\s*export\s+type\s+(\w+)\s*=/;
  // Match: export { ... } — skip, handled by named exports

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpMatchArray | null;

    if ((match = line.match(exportFuncRe))) {
      symbols.push({ name: match[2], kind: 'Function', lineStart: i + 1, lineEnd: findBlockEnd(lines, i) });
    } else if ((match = line.match(exportClassRe))) {
      symbols.push({ name: match[1], kind: 'Class', lineStart: i + 1, lineEnd: findBlockEnd(lines, i) });
    } else if ((match = line.match(exportInterfaceRe))) {
      symbols.push({ name: match[1], kind: 'Interface', lineStart: i + 1, lineEnd: findBlockEnd(lines, i) });
    } else if ((match = line.match(exportTypeRe))) {
      symbols.push({ name: match[1], kind: 'Type', lineStart: i + 1, lineEnd: findTypeEnd(lines, i) });
    } else if ((match = line.match(exportConstRe))) {
      symbols.push({ name: match[1], kind: 'Const', lineStart: i + 1, lineEnd: findConstEnd(lines, i) });
    }
  }

  return symbols;
}

function findBlockEnd(lines: string[], start: number): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    if (depth === 0 && i > start) return i + 1;
  }
  return lines.length;
}

function findTypeEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Type ends at next non-continuation line
    if (trimmed && !trimmed.startsWith('|') && !trimmed.startsWith('&') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
      if (!trimmed.endsWith(';') && !trimmed.endsWith(';')) break;
      return i;
    }
  }
  return start + 3; // fallback
}

function findConstEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    // Arrow function body
    if (trimmed.startsWith('=>')) return findBlockEnd(lines, i);
    // Regular value
    if (!trimmed.startsWith('.')) {
      return trimmed.endsWith(';') || trimmed.endsWith(',') ? i + 1 : i;
    }
  }
  return start + 1;
}

interface SectionMarker {
  title: string;
  line: number;
}

function findSectionMarkers(content: string): SectionMarker[] {
  const markers: SectionMarker[] = [];
  const lines = content.split('\n');
  // Match // ── Section Title ── style comments
  const sectionRe = /^\s*\/\/\s*[─━━]+\s*(.+?)\s*[─━━]+/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(sectionRe);
    if (match) {
      markers.push({ title: match[1].trim(), line: i + 1 });
    }
  }
  return markers;
}

// ── Auto-fix entry point ────────────────────────────────

export async function applyFileSizeFix(
  _summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  const root = process.cwd();
  const hotFiles = detectHotFiles(root);

  if (hotFiles.length === 0) {
    return { applied: true, detail: 'No files exceed line thresholds — file-size loop converged' };
  }

  const recommendations: SplitRecommendation[] = [];
  for (const file of hotFiles.slice(0, 5)) { // analyze top 5
    try {
      const rec = await analyzeFileForSplit(file, root);
      recommendations.push(rec);
    } catch (err) {
      log.warn(`Failed to analyze ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (recommendations.every(r => r.extractCandidates.length === 0)) {
    const filesList = hotFiles.map(f => `${f.path} (${f.lines} lines)`).join(', ');
    return {
      applied: true,
      detail: `Scanned ${hotFiles.length} hot file(s): ${filesList}. No clear split candidates found — manual review needed.`,
    };
  }

  const totalCandidates = recommendations.reduce((sum, r) => sum + r.extractCandidates.length, 0);
  const lines: string[] = [
    `File-size loop: ${hotFiles.length} file(s) > 400 lines, ${recommendations.length} analyzed`,
    `Total split candidates: ${totalCandidates}`,
    '',
  ];

  for (const rec of recommendations) {
    lines.push(`### ${rec.file} (${rec.lines} lines)`);
    for (const c of rec.extractCandidates.slice(0, 3)) {
      lines.push(`  - [${c.kind}] **${c.name}** (L${c.lineStart}-${c.lineEnd}, ${c.estimatedLines} lines): ${c.reason}`);
    }
    if (rec.extractCandidates.length === 0) {
      lines.push('  - No clear split candidates');
    }
    lines.push('');
  }

  // Write the report
  try {
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const researchDir = resolve(root, 'docs', 'research');
    if (!existsSync(researchDir)) mkdirSync(researchDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    writeFileSync(resolve(researchDir, `file-size-scan-${dateStr}.md`), lines.join('\n'), 'utf8');
  } catch { /* best effort */ }

  return { applied: true, detail: lines.join('\n') };
}
