/**
 * CBM code structure injection helper for chat-memory-augment.ts.
 * Extracted to keep the augmentation module under the 400-line gate.
 *
 * Phase 2: injects caller/callee context from CBM into the system prompt.
 * Uses A/B alternating injection to measure effectiveness.
 */

import { CBMClient, type CBMCallerInfo } from '@los/memory';

/**
 * Build a "Code Structure Context" block for the system prompt.
 * Only includes information that is expensive to get via grep/file reads:
 * callers and callees of the target symbols.
 *
 * Returns empty string if CBM is unavailable or no symbols were resolved.
 */
export async function buildCodeStructureBlock(
  userPrompt: string,
  workspaceRoot: string,
  maxTokens: number,
): Promise<string> {
  try {
    const targetFiles = extractFilePathsFromPrompt(userPrompt);
    if (targetFiles.length === 0) return '';

    const cbm = CBMClient.createDefault();
    await cbm.connect();

    // Resolve symbols in target files
    const symbols = await cbm.resolveSymbols(targetFiles.map(f => ({ path: f })));
    if (!symbols || symbols.length === 0) {
      await cbm.close();
      return '';
    }

    // Get callers for the resolved symbols (expensive to get via grep)
    const symbolIds = symbols.map(s => s.id);
    const callers = await cbm.getCallers(symbolIds);

    await cbm.close();

    if (callers.size === 0) return '';

    return formatCallerContext(symbols, callers, maxTokens);
  } catch {
    return ''; // graceful degradation
  }
}

// ── A/B toggle ──────────────────────────────────────────

let sessionCounter = 0;

/** Reset the A/B counter (for testing). */
export function resetABCounter(): void {
  sessionCounter = 0;
}

/**
 * Returns true if this session should receive code structure injection.
 * Alternates every session to enable A/B comparison.
 * When injectArchitecture is true but we want measurement, alternate.
 */
export function shouldInjectThisSession(): boolean {
  return (++sessionCounter) % 2 === 0;
}

// ── Formatting ──────────────────────────────────────────

function formatCallerContext(
  symbols: Array<{ id: string; name: string; kind: string; file: string }>,
  callers: Map<string, CBMCallerInfo[]>,
  maxTokens: number,
): string {
  const lines: string[] = ['## Code Context', ''];

  for (const sym of symbols.slice(0, 5)) {
    const symCallers = callers.get(sym.id);
    if (!symCallers || symCallers.length === 0) continue;

    lines.push(`Callers of \`${sym.name}\` (modify with care):`);
    for (const c of symCallers.slice(0, 8)) {
      lines.push(`- \`${c.callerFile}\` → \`${c.symbol}\``);
    }
    lines.push('');
  }

  if (lines.length <= 2) return '';

  return truncateToTokenBudget(lines.join('\n'), maxTokens);
}

// ── File path extraction ────────────────────────────────

function extractFilePathsFromPrompt(prompt: string): string[] {
  const paths: string[] = [];
  const tickRe = /`([a-zA-Z0-9_/.\-]+\.[a-z]{2,4}(:\d+)?)`/g;
  let m: RegExpExecArray | null;
  while ((m = tickRe.exec(prompt)) !== null) {
    paths.push(m[1].replace(/:.*/, ''));
  }
  const bareRe = /\b(packages\/[a-zA-Z0-9_/\-.]+\.[a-z]{2,4})\b/g;
  while ((m = bareRe.exec(prompt)) !== null) {
    if (!paths.includes(m[1])) paths.push(m[1]);
  }
  return paths;
}

// ── Token budget ────────────────────────────────────────

function truncateToTokenBudget(text: string, maxTokens: number): string {
  // Rough estimate: 1 token ≈ 3.5 chars for code-heavy text
  const maxChars = maxTokens * 3.5;
  if (text.length <= maxChars) return text;
  // Truncate at last newline before limit
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
}
