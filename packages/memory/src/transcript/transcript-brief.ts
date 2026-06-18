/**
 * @los/memory/transcript-brief — Structured transcript compression.
 *
 * Builds a compact, structured transcript brief from session_events.
 * Inspired by pi-vcc's algorithmic compaction pipeline:
 * extracts goals, files, conversation flow, and outstanding issues
 * without any LLM calls — pure SQL + string processing.
 */

import { getDb } from '@los/infra/db';

export interface TranscriptBrief {
  goal?: string;
  files: string[];
  flow: string[];
  outstanding: string[];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

/**
 * Build a structured transcript brief from session_events.
 */
export async function buildTranscriptBrief(
  sessionId: string,
  runSpecId?: string,
): Promise<TranscriptBrief> {
  const db = getDb();
  const brief: TranscriptBrief = { files: [], flow: [], outstanding: [] };

  try {
    // ── Goal from run_specs ──────────────────────────────
    if (runSpecId) {
      const specRows = await db.query<{ run_contract_json: unknown }>(
        `SELECT run_contract_json FROM run_specs WHERE id = $1`,
        [runSpecId],
      );
      const contract = specRows.rows[0]?.run_contract_json;
      if (contract && typeof contract === 'object') {
        const c = contract as Record<string, unknown>;
        if (typeof c.goal === 'string' && c.goal.trim()) {
          brief.goal = c.goal.trim();
        } else if (typeof c.prompt === 'string' && c.prompt.trim()) {
          brief.goal = c.prompt.trim().slice(0, 200);
        }
      }
    }

    // ── Session events (last 500, newest first → reverse to chronological) ──
    const eventRows = await db.query<{
      type: string; tool_name: string | null;
      payload_json: unknown; created_at: string;
    }>(
      `SELECT type, tool_name, payload_json, created_at
       FROM session_events
       WHERE session_id = $1
       ORDER BY id DESC LIMIT 500`,
      [sessionId],
    );

    const events = eventRows.rows.reverse(); // chronological order
    const seenFiles = new Set<string>();
    let toolCallSeq = 0;
    const toolCallLabels = new Map<string, string>(); // callId → (#N) label

    for (const ev of events) {
      const payload = normalizeJsonObject(ev.payload_json);

      // Track tool calls for file extraction and labeling
      if (ev.type === 'tool.call' || ev.type === 'tool_call_state.requested') {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const toolName = ev.tool_name ?? typeof payload.toolName === 'string' ? payload.toolName : '';
        toolCallSeq++;
        const label = `(#${toolCallSeq})`;
        if (callId) toolCallLabels.set(callId, label);

        const input = typeof payload.input === 'object' && payload.input ? payload.input as Record<string, unknown> : null;
        const filePaths = input ? extractFilePaths(input) : [];
        for (const fp of filePaths) {
          if (!seenFiles.has(fp) && seenFiles.size < 50) seenFiles.add(fp);
        }

        brief.flow.push(`[Tool Use ${label}] ${toolName || 'unknown_tool'}${filePaths.length ? ': ' + filePaths.slice(0, 3).join(', ') : ''}`);
      }

      // Tool results
      if (ev.type === 'tool.result' || ev.type === 'tool_call_state.succeeded') {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const label = callId ? toolCallLabels.get(callId) : '';
        const summary = typeof payload.outputSummary === 'string'
          ? payload.outputSummary.slice(0, 150)
          : typeof payload.result === 'string'
          ? payload.result.slice(0, 150)
          : 'ok';
        brief.flow.push(`[Tool Result ${label}] ${summary}`.trim());
      }

      // Tool errors
      if (ev.type === 'tool.error' || ev.type === 'tool_call_state.failed') {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const label = callId ? toolCallLabels.get(callId) : '';
        const errorText = typeof payload.error === 'string' ? payload.error.slice(0, 200) : 'tool failed';
        brief.flow.push(`[Tool Error ${label}] ${errorText}`);
        brief.outstanding.push(errorText.slice(0, 120));
      }

      // Assistant messages
      if (ev.type === 'model.response') {
        const content = typeof payload.content === 'string'
          ? payload.content
          : typeof payload.delta === 'string'
          ? payload.delta
          : '';
        if (content.trim()) {
          brief.flow.push(`[Assistant] ${content.slice(0, 200).replace(/\n/g, ' ')}`);
        }
      }
    }

    // Trim flow to ~120 lines (rolling window, keep newest)
    if (brief.flow.length > 120) brief.flow = brief.flow.slice(-120);

    // Deduplicate outstanding issues
    brief.outstanding = [...new Set(brief.outstanding)].slice(0, 10);

    // Trim common path prefix from files
    brief.files = trimCommonPrefix([...seenFiles]).slice(0, 50);
  } catch {
    // Best-effort: transcript brief is an augmentation, not a requirement
  }

  return brief;
}

/** Extract file paths from a tool input object (recursive, best-effort). */
function extractFilePaths(obj: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'file_path' || key === 'filePath' || key === 'filename' || key === 'path') {
      if (typeof value === 'string' && value.includes('/')) paths.push(value);
    } else if (key === 'paths' && Array.isArray(value)) {
      for (const p of value) {
        if (typeof p === 'string' && p.includes('/')) paths.push(p);
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      paths.push(...extractFilePaths(value as Record<string, unknown>));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          paths.push(...extractFilePaths(item as Record<string, unknown>));
        }
      }
    }
  }
  return paths;
}

/** Remove common path prefix to keep file lists short. */
function trimCommonPrefix(files: string[]): string[] {
  if (files.length <= 1) return files;
  let prefix = files[0];
  for (let i = 1; i < files.length; i++) {
    while (files[i].indexOf(prefix) !== 0 && prefix.length > 0) {
      prefix = prefix.slice(0, prefix.lastIndexOf('/'));
    }
  }
  if (prefix.length > 5) {
    return files.map(f => f.startsWith(prefix) ? f.slice(prefix.length + 1) : f);
  }
  return files;
}
