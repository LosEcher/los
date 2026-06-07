/**
 * @los/agent/loop/message-builder — Initial message construction and system prompts.
 * Pure functions for building the initial message array and selecting system prompts.
 */

import type { Message } from '../providers/index.js';
import type { ContextCompressionConfig } from '../loop.js';
import { estimateMessageTokens } from './token-utils.js';
import { compressOrTrimMessages } from './compression.js';

// ── System Prompts ────────────────────────────────────────

const DEFAULT_SYSTEM = `You are a helpful coding assistant with access to tools for reading, writing, searching, patching, spawning child agents, and executing code.
You can: read files (read_file), write files (write_file), patch files (preview_patch, apply_patch, edit_file), search code (search_content, search_files, glob), analyze code (get_symbols, find_in_code), inspect directories (list_directory, directory_tree, get_file_info), create directories (create_directory), delete files (delete_file), spawn constrained child agents (spawn_agent), run shell commands (run_shell), and manage background jobs (run_background, job_output, stop_job, list_jobs).

Rules:
- Read files before editing them
- Prefer preview_patch/apply_patch/edit_file for focused changes instead of whole-file overwrites
- Use absolute or relative paths within the workspace
- For shell commands, be specific — use exact paths
- When you're done, provide a clear summary
- If you're unsure about something, ask instead of guessing`;

const READ_ONLY_SYSTEM = `You are a helpful coding assistant with read-only access to a workspace.
You can: read files (read_file), search code (search_content, search_files, glob), analyze code (get_symbols, find_in_code), inspect directories (list_directory, directory_tree, get_file_info).

Rules:
- Inspect files before making claims about the code
- Do not claim to edit files, run shell commands, or execute tests in this mode
- Use absolute or relative paths within the workspace
- When you're done, provide a clear summary with evidence and next steps
- If you're unsure about something, ask instead of guessing`;

const PROJECT_WRITE_SYSTEM = `You are a helpful coding assistant with project-write access to a workspace.
You can: read files (read_file), write files (write_file), search code (search_content, search_files, glob), analyze code (get_symbols, find_in_code), inspect directories (list_directory, directory_tree, get_file_info), create directories (create_directory), and delete files (delete_file).
You can also manage the project planning ledger with todo_list, todo_create, todo_update, todo_archive, todo_reopen, and todo_link_dependency.

Rules:
- Read files before editing them
- Limit changes to the provided workspace root
- Do not run shell commands in this mode
- For todo writes, preserve tenantId/projectId/requestId/traceId when available
- When you're done, provide a clear summary with the files changed
- If you're unsure about something, ask instead of guessing`;

// ── System Prompt Selection ───────────────────────────────

/**
 * Get the default system prompt based on the tool mode.
 */
export function getDefaultSystemPrompt(toolMode: 'all' | 'project-write' | 'read-only'): string {
  if (toolMode === 'read-only') return READ_ONLY_SYSTEM;
  if (toolMode === 'project-write') return PROJECT_WRITE_SYSTEM;
  return DEFAULT_SYSTEM;
}

// ── Message Construction ──────────────────────────────────

const RESUME_CONTEXT_BUDGET = 100_000;
const RESUME_ESTIMATED_THRESHOLD = 80_000;

/**
 * Build the initial message array from the user prompt, system prompt, and
 * optional initial messages (for session resume). Applies context compression
 * when a maxContextTokens budget is configured or when resuming a large session.
 */
export function buildInitialMessages(
  prompt: string,
  systemPrompt: string,
  initialMessages: Message[] | undefined,
  maxContextTokens?: number,
  compression?: ContextCompressionConfig,
): Message[] {
  const messages = initialMessages?.length
    ? initialMessages.map(message => ({ ...message }))
    : [{ role: 'system' as const, content: systemPrompt }];
  if (!messages.some(message => message.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // Auto-enable compression for resumed sessions with many messages to prevent
  // context overflow. Explicit maxContextTokens always takes precedence.
  const isResumed = Boolean(initialMessages?.length);
  const estimatedTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const effectiveBudget = (maxContextTokens && maxContextTokens > 0)
    ? maxContextTokens
    : (isResumed && estimatedTokens > RESUME_ESTIMATED_THRESHOLD ? RESUME_CONTEXT_BUDGET : 0);

  if (effectiveBudget > 0) {
    const compressed = compressOrTrimMessages(messages, effectiveBudget, {
      ...compression,
      enabled: compression?.enabled !== false,
    });
    return compressed;
  }
  return messages;
}
