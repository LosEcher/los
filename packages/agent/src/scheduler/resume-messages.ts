/**
 * @los/agent/scheduler/resume-messages — answer injection for resumed blocked tasks.
 *
 * When a worker task blocked on `ask_coordinator` is resumed (the operator
 * answered via POST /runs/:id/answer), the scheduler re-runs it as a new
 * attempt. runAgent rebuilds the conversation from session history; this module
 * produces the extra message that tells the model what was asked and what the
 * operator answered, so it can continue instead of re-asking.
 *
 * The message is a single `user`-role message appended to initialMessages.
 * runAgent's buildInitialMessages places initialMessages after the session
 * history, so the model sees: [prior turns] → [your ask + the answer] → continue.
 */

import type { Message } from '../providers/types.js';

/**
 * Build the resume message that injects the operator's answer into the resumed
 * execution's initialMessages.
 *
 * @param question the question the worker asked (from the ask worker_message)
 * @param answer the operator's answer (from recordWorkerAnswer)
 * @returns a single user-role Message to append to initialMessages
 */
export function buildResumeMessage(question: string, answer: string): Message {
  return {
    role: 'user',
    content: `You previously asked the coordinator: "${question}"\n\nThe operator answered: "${answer}"\n\nResume the task with this answer. Do not ask the same question again.`,
  };
}
