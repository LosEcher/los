import test from 'node:test';
import assert from 'node:assert/strict';

import { approveRunSpecPhase, createRunSpec } from '@los/agent/run-specs';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from '@los/agent/scheduler';
import { getDb } from '@los/infra/db';
import { dispatchPersistedRunSpec } from './run-resume-dispatch.js';

test('approved execution rehydrates the persisted request envelope and plan', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-persisted-dispatch-${suffix}`;
  const sessionId = `session-persisted-dispatch-${suffix}`;
  const taskRunId = `task-persisted-dispatch-${suffix}`;
  let scheduledInput: ScheduledAgentTaskInput | undefined;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      tenantId: 'tenant-persisted',
      projectId: 'project-persisted',
      userId: 'user-persisted',
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
      prompt: 'Implement the stored plan',
      systemPrompt: 'Use the persisted system prompt.',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      modelSettings: { temperature: 0.2, maxTokens: 4096 },
      workspaceRoot: '/tmp/los-persisted-workspace',
      toolMode: 'project-write',
      allowedTools: ['read_file', 'write_file'],
      toolRetry: { maxRetries: 2, backoffMs: 25 },
      maxLoops: 7,
      timeoutMs: 45_000,
      mcpServers: [{ command: 'persisted-mcp', args: ['--stdio'], env: { MODE: 'test' } }],
      runContract: {
        mode: 'execution',
        executionMode: 'standard',
        phase: 'planning',
        planRevision: 3,
        plan: [{
          id: 'step-1',
          title: 'Implement',
          description: 'Use the stored request envelope.',
          dependsOnIds: [],
          editableSurfaces: ['packages/gateway/src/'],
          completionCriteria: 'The focused test passes.',
        }],
        requiredChecks: ['pnpm --filter @los/gateway check'],
      },
    });
    await approveRunSpecPhase(runSpecId, { actor: 'operator:test' });

    const result = await dispatchPersistedRunSpec(runSpecId, 'execution', {
      schedule: async (input): Promise<ScheduledAgentTaskResult> => {
        scheduledInput = input;
        return {
          status: 'deduplicated',
          sessionId,
          taskRun: {
            id: taskRunId,
            sessionId,
            runSpecId,
            traceId: `trace-${suffix}`,
            dedupeKey: `run:${runSpecId}:execution:3`,
            workspaceRoot: input.workspaceRoot ?? process.cwd(),
            toolMode: input.toolMode ?? 'project-write',
            status: 'running',
            attempt: 1,
            promptPreview: input.prompt.slice(0, 200),
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            leaseVersion: 1,
          },
        };
      },
    });

    assert.equal(result.status, 'deduplicated');
    assert.equal(result.planRevision, 3);
    assert.ok(scheduledInput);
    assert.equal(scheduledInput.prompt, 'Implement the stored plan');
    assert.equal(scheduledInput.systemPrompt, 'Use the persisted system prompt.');
    assert.equal(scheduledInput.provider, 'deepseek');
    assert.equal(scheduledInput.model, 'deepseek-reasoner');
    assert.deepEqual(scheduledInput.modelSettings, { temperature: 0.2, maxTokens: 4096 });
    assert.equal(scheduledInput.workspaceRoot, '/tmp/los-persisted-workspace');
    assert.equal(scheduledInput.toolMode, 'project-write');
    assert.deepEqual(scheduledInput.allowedTools, ['read_file', 'write_file']);
    assert.deepEqual(scheduledInput.toolRetry, { maxRetries: 2, backoffMs: 25 });
    assert.equal(scheduledInput.maxLoops, 7);
    assert.equal(scheduledInput.timeoutMs, 45_000);
    assert.deepEqual(scheduledInput.mcpServers, [{ command: 'persisted-mcp', args: ['--stdio'], env: { MODE: 'test' } }]);
    const scheduledContract = scheduledInput.runContract as {
      planRevision?: number;
      plan?: Array<{ id?: string }>;
    };
    assert.equal(scheduledContract.planRevision, 3);
    assert.equal(scheduledContract.plan?.[0]?.id, 'step-1');
    assert.equal(scheduledInput.dedupeKey, `run:${runSpecId}:execution:3`);
    assert.equal(scheduledInput.disposition, 'execution');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
  }
});
