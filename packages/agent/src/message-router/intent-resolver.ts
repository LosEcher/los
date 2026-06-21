/**
 * @los/agent/message-router/intent-resolver — Resolve inbound text to intent.
 *
 * Two-phase resolution:
 *   Phase 1: #command regex parsing (fast path, exact match)
 *   Phase 2: NL heuristics (confidence-scored fallback)
 *
 * Commands:
 *   #approve <sessionId>    → steering (approve)
 *   #deny <sessionId>       → steering (deny)
 *   #escalate <sessionId>   → steering (escalate)
 *   #status <sessionId>     → status
 *   #task                   → todo: list
 *   #task <id>              → todo: show
 *   #task new <title>       → todo: create
 *   #claude <prompt>        → runtime: claude-code
 *   #codex <prompt>         → runtime: codex
 */

import type { ResolvedIntent } from './types.js';

// loose session-id: 8-64 alphanumeric/hyphen chars
const SESSION_ID_RE = /[\w-]{8,64}/;

// ── Command patterns ─────────────────────────────────────────────

const COMMANDS: Array<{
  pattern: RegExp;
  build: (match: RegExpMatchArray) => ResolvedIntent;
}> = [
  // #approve <sessionId>
  {
    pattern: /^#approve\s+(?<sid>[\w-]{8,64})\s*$/i,
    build: (m) => ({ type: 'steering', instruction: 'approve', sessionId: m.groups!.sid! }),
  },
  // #deny <sessionId>
  {
    pattern: /^#deny\s+(?<sid>[\w-]{8,64})\s*$/i,
    build: (m) => ({ type: 'steering', instruction: 'deny', sessionId: m.groups!.sid! }),
  },
  // #escalate <sessionId>
  {
    pattern: /^#escalate\s+(?<sid>[\w-]{8,64})\s*$/i,
    build: (m) => ({ type: 'steering', instruction: 'escalate', sessionId: m.groups!.sid! }),
  },
  // #status <sessionId>
  {
    pattern: /^#status\s+(?<sid>[\w-]{8,64})\s*$/i,
    build: (m) => ({ type: 'status', sessionId: m.groups!.sid! }),
  },
  // #claude <prompt>  (must have content after #claude)
  {
    pattern: /^#claude\s+(?<prompt>.+)$/i,
    build: (m) => ({ type: 'runtime', kind: 'claude-code', prompt: m.groups!.prompt!.trim() }),
  },
  // #codex <prompt>
  {
    pattern: /^#codex\s+(?<prompt>.+)$/i,
    build: (m) => ({ type: 'runtime', kind: 'codex', prompt: m.groups!.prompt!.trim() }),
  },
  // #task new <title>
  {
    pattern: /^#task\s+new\s+(?<title>.+)$/i,
    build: (m) => ({ type: 'todo', action: 'create', title: m.groups!.title!.trim() }),
  },
  // #task <id>
  {
    pattern: /^#task\s+(?<id>[\w-]{4,64})\s*$/i,
    build: (m) => ({ type: 'todo', action: 'show', todoId: m.groups!.id! }),
  },
  // #task (bare — list)
  {
    pattern: /^#task\s*$/i,
    build: () => ({ type: 'todo', action: 'list' }),
  },
];

// ── Phase 1: command parsing ────────────────────────────────────

function tryParseCommand(text: string): ResolvedIntent | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('#')) return null;

  for (const cmd of COMMANDS) {
    const match = trimmed.match(cmd.pattern);
    if (match) return cmd.build(match);
  }

  // Unrecognized #command — treat as NL chat
  return null;
}

// ── Phase 2: NL heuristics ──────────────────────────────────────

function heuristicIntent(text: string): ResolvedIntent {
  const trimmed = text.trim();
  if (!trimmed) return { type: 'chat', prompt: '' };

  // "approve abc123" without # → steering (0.7 confidence if session-like token)
  const approveMatch = trimmed.match(/^(approve|deny|escalate)\s+(?<sid>[\w-]{8,64})\s*$/i);
  if (approveMatch) {
    const instruction = approveMatch[1]!.toLowerCase();
    return {
      type: 'steering',
      instruction,
      sessionId: approveMatch.groups!.sid!,
    };
  }

  // "status of abc123" → status
  const statusMatch = trimmed.match(/^status\s+(?:of\s+)?(?<sid>[\w-]{8,64})\s*$/i);
  if (statusMatch) {
    return { type: 'status', sessionId: statusMatch.groups!.sid! };
  }

  // "run claude ..." or "use claude to ..." → runtime
  const runtimeMatch = trimmed.match(/^(?:run|use|spawn)\s+(claude|codex)\s+(?:to\s+)?(?<prompt>.+)$/i);
  if (runtimeMatch) {
    const kind = runtimeMatch[1]!.toLowerCase() === 'codex' ? 'codex' : 'claude-code';
    return { type: 'runtime', kind, prompt: runtimeMatch.groups!.prompt!.trim() };
  }

  // Default: natural language → chat
  return { type: 'chat', prompt: trimmed };
}

// ── Public API ──────────────────────────────────────────────────

export function resolveIntent(text: string): ResolvedIntent {
  const trimmed = text.trim();

  if (trimmed.startsWith('#')) {
    const cmd = tryParseCommand(trimmed);
    if (cmd) return cmd;
    // Unrecognized #command → NL chat with original text
    return { type: 'chat', prompt: trimmed };
  }

  return heuristicIntent(trimmed);
}
