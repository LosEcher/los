/**
 * @los/agent/loop/message-builder — Initial message construction and system prompts.
 * Pure functions for building the initial message array and selecting system prompts.
 */

import type { Message } from '../providers/index.js';
import type { ContextCompressionConfig } from './types.js';
import { estimateMessageTokens } from './token-utils.js';
import { compressOrTrimMessages } from './compression.js';
import { preprocessInput } from '@los/input-preprocessor';
import { appendSessionEvent } from '../session-events.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('agent');

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
 *
 * @param toolMode — tool access level
 * @param identityBlock — optional identity block to prepend before the base prompt.
 *   When provided, the identity block is placed first, followed by a blank line
 *   separator and the tool-mode system prompt.
 */
export function getDefaultSystemPrompt(
  toolMode: 'all' | 'project-write' | 'read-only',
  identityBlock?: string,
): string {
  const base = toolMode === 'read-only' ? READ_ONLY_SYSTEM
    : toolMode === 'project-write' ? PROJECT_WRITE_SYSTEM
    : DEFAULT_SYSTEM;

  if (identityBlock) {
    return identityBlock + '\n\n' + base;
  }
  return base;
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
  sessionId?: string,
): Message[] {
  const messages = initialMessages?.length
    ? initialMessages.map(message => ({ ...message }))
    : [{ role: 'system' as const, content: systemPrompt }];
  if (!messages.some(message => message.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  // Apply input preprocessing (log denoising, dedup, etc.) when configured.
  const preprocessorConfig = compression?.preprocessor;
  let processedPrompt = prompt;
  if (compression?.enabled !== false && preprocessorConfig) {
    const result = preprocessInput({ rawText: prompt, config: preprocessorConfig });
    processedPrompt = result.processedText;

    // Log significant preprocessing outcomes for observability.
    const { metadata, safetyReport: safety } = result;
    if (metadata.processingTimeMs > 100) {
      log.warn('input preprocessing took >100ms', {
        contentType: metadata.contentType,
        timeMs: metadata.processingTimeMs,
        originalTokens: safety.originalTokenEstimate,
        finalTokens: safety.finalTokenEstimate,
        compressionRatio: Math.round(safety.compressionRatio * 100) / 100,
        removedByClassifier: safety.removedByClassifier,
        deduplicatedCount: safety.deduplicatedCount,
      });
    } else if (metadata.contentType !== 'unknown' && safety.compressionRatio < 0.95) {
      log.info('input preprocessed', {
        contentType: metadata.contentType,
        timeMs: metadata.processingTimeMs,
        reduction: Math.round((1 - safety.compressionRatio) * 100),
        originalLen: metadata.originalLength,
        processedLen: metadata.processedLength,
      });
    }

    // Emit session event for audit trail (non-blocking, best-effort).
    if (sessionId && metadata.contentType !== 'unknown' && safety.compressionRatio < 0.99) {
      appendSessionEvent({
        sessionId,
        type: 'input.preprocessed',
        source: 'input-preprocessor',
        payload: {
          contentType: metadata.contentType,
          contentTypes: metadata.contentTypes,
          confidence: Math.round(metadata.confidence * 100) / 100,
          originalLength: metadata.originalLength,
          processedLength: metadata.processedLength,
          tokenEstimate: metadata.tokenEstimate,
          compressionRatio: Math.round(safety.compressionRatio * 1000) / 1000,
          processingTimeMs: metadata.processingTimeMs,
          removedByClassifier: safety.removedByClassifier,
          deduplicatedCount: safety.deduplicatedCount,
          warnings: safety.warnings.slice(0, 5),
        },
      }).catch(() => undefined); // non-blocking
    }
  }
  messages.push({ role: 'user', content: processedPrompt });

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
