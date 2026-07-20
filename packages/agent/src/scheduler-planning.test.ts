import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import { runScheduledAgentTask } from './scheduler.js';
import { listSessionEvents } from './session-events.js';

test('planning disposition is read-only and stops at approval', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-scheduler-planning-${suffix}`;
  const taskRunId = `task-scheduler-planning-${suffix}`;
  const sessionId = `session-scheduler-planning-${suffix}`;
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    requests.push(JSON.parse(await readRequestBody(req)));
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: JSON.stringify({
          summary: 'One bounded step.',
          plan: [{
            id: 'step-1',
            title: 'Implement',
            description: 'Update the declared surface.',
            dependsOnIds: [],
            editableSurfaces: ['packages/agent/src/'],
            completionCriteria: 'The focused check passes.',
          }],
          verifications: [],
        }),
        turns: [],
        loopCount: 1,
        totalTokens: { prompt: 10, completion: 20 },
        messages: [],
      },
    });
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'Implement a bounded change',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        executionMode: 'standard',
        phase: 'planning',
        requiredChecks: ['pnpm --filter @los/agent check'],
      },
    });

    const result = await runScheduledAgentTask({
      prompt: 'Implement a bounded change',
      disposition: 'planning',
      taskRunId,
      runSpecId,
      sessionId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      sandboxMode: 'workspace-write',
      executor: {
        enabled: true,
        nodeUrls: [`http://127.0.0.1:${address.port}`],
        nodeId: `node-${suffix}`,
      },
    });

    assert.equal(result.status, 'awaiting_approval');
    assert.equal(result.taskRun.status, 'blocked');
    assert.equal(result.taskRun.metadata.awaitingApproval, true);
    assert.equal(result.planStepCount, 1);
    assert.equal(requests[0]?.config?.toolMode, 'read-only');
    assert.equal(requests[0]?.config?.sandboxMode, 'readonly');
    assert.equal(requests[0]?.config?.skipPreExecutionPhases, true);
    assert.match(String(requests[0]?.prompt), /Planning disposition/);
    const runSpec = await loadRunSpec(runSpecId);
    assert.equal(runSpec?.status, 'created');
    assert.equal(runSpec?.runContract?.phase, 'planning');
    assert.equal(runSpec?.runContract?.plan?.[0]?.id, 'step-1');
    const events = await listSessionEvents(sessionId);
    assert.ok(events.some(event => event.type === 'task.blocked'));
    assert.ok(!events.some(event => event.type === 'task.succeeded'));
  } finally {
    await getDb().query('DELETE FROM scheduler_decisions WHERE task_run_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
