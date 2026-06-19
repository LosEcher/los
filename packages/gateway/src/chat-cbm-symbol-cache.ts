/**
 * CBM symbol cache for write-tool → symbol resolution.
 * Extracted to keep chat-service.ts under the 600-line CI gate.
 *
 * Phase 3: when the agent calls write_edit / multi_edit / write_file,
 * we resolve the target file paths to CBM symbols and cache the result.
 * On persistChatSuccess(), drainSymbolCache() retrieves the mapping
 * for inclusion in the observation's metadata_json.symbolRefs.
 */

import { CBMClient } from '@los/memory';

const cache = new Map<string, Array<{ id: string; name: string; kind: string; file: string }>>();

/**
 * Extract file paths from tool call args and resolve to CBM symbols.
 * Called asynchronously from the onToolCall callback — never blocks
 * the agent loop.
 */
export async function cacheSymbolsForToolCall(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const paths = extractEditedPaths(tool, args);
  if (paths.length === 0) return;

  try {
    const cbm = CBMClient.createDefault();
    await cbm.connect();
    const symbols = await cbm.resolveSymbols(paths.map(p => ({ path: p })));
    await cbm.close();

    if (symbols && symbols.length > 0) {
      cache.set(callId, symbols.map(s => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        file: s.file,
      })));
    }
  } catch {
    // Symbol resolution is best-effort
  }
}

/**
 * Drain the accumulated symbol cache. Call once per session
 * in persistChatSuccess().
 */
export function drainSymbolCache(): Map<string, Array<{ id: string; name: string; kind: string; file: string }>> {
  const result = new Map(cache);
  cache.clear();
  return result;
}

function extractEditedPaths(tool: string, args: Record<string, unknown>): string[] {
  const paths: string[] = [];

  if ((tool === 'multi_edit' || tool === 'write_edits') && Array.isArray(args.files)) {
    for (const f of args.files) {
      if (f && typeof f === 'object' && typeof (f as any).file_path === 'string') {
        paths.push((f as any).file_path);
      }
    }
  } else if ((tool === 'write_file' || tool === 'write_to_file') && typeof args.file_path === 'string') {
    paths.push(args.file_path);
  } else if (tool === 'replace' && typeof args.file_path === 'string') {
    paths.push(args.file_path);
  }

  return paths;
}
