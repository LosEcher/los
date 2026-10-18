import assert from 'node:assert/strict';
import test from 'node:test';

import { _createLosMCPAdapter, type LosMCPAdapter } from './mcp-serve.js';

test('MCP adapter initializes and exposes only the contracted tools', async () => {
  const adapter = _createLosMCPAdapter({ fetchImpl: unreachableFetch });
  const initialized = asRecord((await adapter.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }))?.result);
  assert.equal(initialized.protocolVersion, '2024-11-05');

  const listed = asRecord((await adapter.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))?.result);
  const names = (listed.tools as Array<{ name: string }>).map(tool => tool.name);
  assert.deepEqual(names, [
    'los_run', 'los_runs_list', 'los_placed_run', 'los_nodes_list', 'los_run_state', 'los_run_replay',
    'los_run_verify', 'los_run_approve', 'los_run_recover', 'los_run_revise_plan',
    'los_task_cancel', 'los_operator_control',
  ]);
});

test('los_run forwards scoped access context without operator credentials and projects SSE evidence', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    tenantId: 'tenant-a',
    userId: 'external-editor',
    fetchImpl: captureFetch(requests, () => new Response([
      'event: session',
      'data: {"sessionId":"session-a","runSpecId":"run-a","taskRunId":"task-a"}',
      '',
      'event: tool.result',
      'data: {"toolName":"read_file"}',
      '',
      'event: done',
      'data: {"sessionId":"session-a","runSpecId":"run-a","taskRunId":"task-a","traceId":"trace-a","requestId":"request-a","runSpecStatus":"succeeded","text":"complete"}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })),
  });

  const result = toolContent(await callTool(adapter, 'los_run', {
    prompt: 'inspect the project',
    projectId: 'project-a',
  }));

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'http://gateway.test/chat');
  assert.equal(requests[0]?.headers.get('x-los-auth-token'), 'access-secret');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), null);
  assert.equal(requests[0]?.headers.get('x-tenant-id'), 'tenant-a');
  assert.equal(requests[0]?.headers.get('x-project-id'), 'project-a');
  assert.equal(requests[0]?.headers.get('x-user-id'), 'external-editor');
  // 缺省不再发随机幂等键（随机键对重试无保护，只会造假象）；调用方显式给键才发
  assert.equal(requests[0]?.headers.get('x-idempotency-key'), null);
  assert.deepEqual(await requests[0]?.json(), {
    prompt: 'inspect the project',
    projectId: 'project-a',
    toolMode: 'read-only',
  });
  assert.deepEqual(result, {
    status: 'done',
    sessionId: 'session-a',
    runSpecId: 'run-a',
    taskRunId: 'task-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    runSpecStatus: 'succeeded',
    text: 'complete',
    eventTypes: ['session', 'tool.result', 'done'],
  });
});

test('los_run rejects project-write before HTTP when no operator credential exists', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: '',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  const response = await callTool(adapter, 'los_run', {
    prompt: 'edit the project',
    projectId: 'project-a',
    toolMode: 'project-write',
  });
  const result = asRecord(response.result);
  assert.equal(result.isError, true);
  assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /LOS_OPERATOR_TOKEN is required/);
  assert.equal(called, false);
});

test('los_run rejects operatorScope before HTTP when no operator credential exists', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: '',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  const response = await callTool(adapter, 'los_run', {
    prompt: 'inspect another project',
    projectId: 'project-a',
    operatorScope: true,
  });
  const result = asRecord(response.result);
  assert.equal(result.isError, true);
  assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /LOS_OPERATOR_TOKEN is required for operator-scoped/);
  assert.equal(called, false);
});

test('operator-scoped los_run forwards the operator credential and projects the resolved project', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    tenantId: 'tenant-a',
    fetchImpl: captureFetch(requests, () => new Response(sse(
      intakeEnvelope({
        reason: 'explicit_project',
        ownerRepo: 'dsfolder-fmtguard',
        requestedProjectId: 'dsfolder-fmtguard',
        workspaceRoot: '/work/dsfolder/fmtguard',
      }),
      ['session', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a' }],
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 })),
  });

  const result = toolContent(await callTool(adapter, 'los_run', {
    prompt: 'inspect fmtguard',
    projectId: 'dsfolder-fmtguard',
    workspaceRoot: '/work/dsfolder/fmtguard',
    operatorScope: true,
  }));

  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.equal(requests[0]?.headers.get('x-project-id'), 'dsfolder-fmtguard');
  assert.deepEqual(await requests[0]?.json(), {
    prompt: 'inspect fmtguard',
    projectId: 'dsfolder-fmtguard',
    workspaceRoot: '/work/dsfolder/fmtguard',
    toolMode: 'read-only',
  });
  assert.equal(result.status, 'done');
  assert.equal(result.ownerRepo, 'dsfolder-fmtguard');
  assert.equal(result.requestedProjectId, 'dsfolder-fmtguard');
  assert.equal(result.workspaceRoot, '/work/dsfolder/fmtguard');
});

test('operator control forwards the operator credential for steering', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({ ok: true, event: { id: 44, type: 'operator.steering' } })),
  });

  const result = toolContent(await callTool(adapter, 'los_operator_control', {
    sessionId: 'session-a',
    projectId: 'project-a',
    type: 'steering',
    instruction: 'stop after the current tool',
    runSpecId: 'run-a',
    reason: 'operator correction',
  }));

  assert.equal(result.ok, true);
  assert.equal(requests[0]?.url, 'http://gateway.test/sessions/session-a/operator-events');
  assert.equal(requests[0]?.headers.get('x-los-auth-token'), 'access-secret');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.deepEqual(await requests[0]?.json(), {
    type: 'steering',
    instruction: 'stop after the current tool',
    runSpecId: 'run-a',
    reason: 'operator correction',
  });
});

test('los_run_verify runs the persisted checks with operator auth and bounds record output', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({
      runSpecId: 'run/a',
      ranRecordIds: ['verification-run-a-r1-1'],
      records: [
        {
          id: 'verification-run-a-r1-1', checkName: 'noop', kind: 'command', status: 'succeeded',
          required: true, outputSummary: 'x'.repeat(500),
        },
        { id: 'verification-run-a-r1-2', checkName: 'noop-2', kind: 'command', status: 'required', required: true },
      ],
      decision: {
        status: 'succeeded', blockedVerificationRecordIds: [], failedVerificationRecordIds: [],
        pendingVerificationRecordIds: [],
      },
    })),
  });

  const result = toolContent(await callTool(adapter, 'los_run_verify', {
    runSpecId: 'run/a', projectId: 'project-a', cwd: '/work/project-a', timeoutMs: 60_000,
  }));

  assert.equal(new URL(requests[0]!.url).pathname, '/runs/run%2Fa/verify');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.deepEqual(await requests[0]?.json(), { cwd: '/work/project-a', timeoutMs: 60_000 });
  const records = result.records as Array<{ id: string; outputSummary?: string; status: string }>;
  assert.equal(result.runSpecId, 'run/a');
  assert.equal((result.decision as { status: string }).status, 'succeeded');
  assert.equal(records.length, 2);
  assert.equal(records[0]?.outputSummary?.length, 300);
  assert.equal(records[1]?.outputSummary, undefined);
  assert.equal(result.recovery, undefined);
});

test('los_run_approve forwards the operator credential and the capability pair', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({ runSpecId: 'run-a', phase: 'plan_approved', dispatch: { status: 'scheduled' } })),
  });

  const hash = `sha256:${'a'.repeat(64)}`;
  const result = toolContent(await callTool(adapter, 'los_run_approve', {
    runSpecId: 'run-a', projectId: 'project-a', reason: 'plan reviewed', planRevision: 2, contractHash: hash,
  }));

  assert.equal(new URL(requests[0]!.url).pathname, '/runs/run-a/approve');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.deepEqual(await requests[0]?.json(), { reason: 'plan reviewed', planRevision: 2, contractHash: hash });
  assert.equal(result.phase, 'plan_approved');
});

test('operator-gated run tools refuse before HTTP without the operator credential', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: '',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  const verifyResponse = asRecord((await callTool(adapter, 'los_run_verify', { runSpecId: 'run-a', projectId: 'project-a' })).result);
  assert.equal(verifyResponse.isError, true);
  assert.match(String((verifyResponse.content as Array<{ text: string }>)[0]?.text), /LOS_OPERATOR_TOKEN is required/);

  const approveResponse = asRecord((await callTool(adapter, 'los_run_approve', { runSpecId: 'run-a', projectId: 'project-a' })).result);
  assert.equal(approveResponse.isError, true);
  assert.equal(called, false);
});

test('approve rejects a half-supplied capability pair before HTTP', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: 'operator-secret',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  const response = asRecord((await callTool(adapter, 'los_run_approve', {
    runSpecId: 'run-a', projectId: 'project-a', planRevision: 2,
  })).result);
  assert.equal(response.isError, true);
  assert.match(String((response.content as Array<{ text: string }>)[0]?.text), /must be provided together/);
  assert.equal(called, false);
});

test('state and replay use encoded run ids, bounded cursors, and ordinary auth', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, request => Response.json({ path: new URL(request.url).pathname })),
  });

  await callTool(adapter, 'los_run_state', { runSpecId: 'run/a', projectId: 'project-a' });
  await callTool(adapter, 'los_run_replay', { runSpecId: 'run/a', projectId: 'project-a', since: 4, streamSince: 9, limit: 50 });

  assert.equal(new URL(requests[0]!.url).pathname, '/runs/run%2Fa/state');
  assert.equal(new URL(requests[1]!.url).pathname, '/runs/run%2Fa/stream');
  assert.equal(new URL(requests[1]!.url).search, '?since=4&streamSince=9&limit=50');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), null);
  assert.equal(requests[1]?.headers.get('x-los-operator-token'), null);
});

test('los_run fails loudly when the gateway resolves a different project than requested', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => new Response(sse(
      intakeEnvelope({
        reason: 'explicit_project',
        ownerRepo: 'los',
        requestedProjectId: 'los',
        workspaceRoot: '/work/los',
      }),
      ['session', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a' }],
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 })),
  });

  const response = await callTool(adapter, 'los_run', {
    prompt: 'inspect fmtguard',
    projectId: 'dsfolder-fmtguard',
  });
  const result = asRecord(response.result);
  assert.equal(result.isError, true);
  const text = String((result.content as Array<{ text: string }>)[0]?.text);
  assert.match(text, /project scope mismatch/);
  assert.match(text, /requested projectId='dsfolder-fmtguard'/);
  assert.match(text, /ownerRepo='los'/);
  assert.match(text, /pass operatorScope=true/);
  assert.match(text, /runSpecId=run-a/);
  assert.match(text, /sessionId=session-a/);
  assert.equal(requests.length, 1);
});

test('los_run keeps the ordinary projection when the resolved project matches the request', async () => {
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: async () => new Response(sse(
      // 扁平形态（非信封）：验证读取对两种形状都成立
      ['coordinator.intake_resolved', { reason: 'configured_default', ownerRepo: 'los', requestedProjectId: 'los', workspaceRoot: '/work/los' }],
      ['session', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a' }],
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 }),
  });

  const result = toolContent(await callTool(adapter, 'los_run', { prompt: 'inspect', projectId: 'los' }));
  assert.equal(result.isError, undefined);
  assert.equal(result.ownerRepo, 'los');
  assert.equal(result.runSpecId, 'run-a');
});

test('los_run detach returns as soon as the run is registered and leaves the stream unread', async () => {
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: async () => sseStream(
      // 第一段：归属判定 + session。真实形状里 runSpecId 只在 intake 的 payload 内、session 只有 taskRunId
      sse(
        intakeEnvelope({
          reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los',
          workspaceRoot: '/work/los', runSpecId: 'run-a',
        }),
        ['session', { sessionId: 'session-a', taskRunId: 'task-a' }],
      ),
      // 第二段：只有"没在 id 齐全处停下"的实现才会读到它
      sse(['done', { sessionId: 'session-a', runSpecId: 'run-a', text: 'SHOULD-NOT-BE-READ', runSpecStatus: 'succeeded' }]),
    ),
  });

  const result = toolContent(await callTool(adapter, 'los_run', { prompt: 'long task', projectId: 'los', detach: true }));
  assert.equal(result.status, 'detached');
  assert.equal(result.detached, true);
  assert.equal(result.runSpecId, 'run-a');
  assert.equal(result.taskRunId, 'task-a');
  assert.equal(result.ownerRepo, 'los');
  assert.equal(result.text, undefined);
});

test('detached los_run still fails loudly when the resolved project differs', async () => {
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: async () => sseStream(sse(
      intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los' }),
      ['session', { sessionId: 'session-a', runSpecId: 'run-a' }],
    )),
  });

  const response = await callTool(adapter, 'los_run', { prompt: 'x', projectId: 'project-a', detach: true });
  const result = asRecord(response.result);
  assert.equal(result.isError, true);
  assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /project scope mismatch/);
});

test('los_runs_list filters, bounds, and trims the gateway run list with ordinary auth', async () => {
  const requests: Request[] = [];
  const rows = [
    {
      id: 'run-old', sessionId: 's-1', projectId: 'project-a', status: 'succeeded', toolMode: 'read-only',
      traceId: 'trace-x', prompt: 'p'.repeat(400), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
    },
    {
      id: 'run-new', sessionId: 's-2', projectId: 'project-a', status: 'blocked', toolMode: 'read-only',
      traceId: 'trace-x', prompt: 'newest', createdAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'run-other-project', sessionId: 's-3', projectId: 'project-b', status: 'succeeded',
      traceId: 'trace-x', prompt: 'other project', createdAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'run-other-trace', sessionId: 's-4', projectId: 'project-a', status: 'succeeded',
      traceId: 'trace-y', prompt: 'other trace', createdAt: '2026-02-02T00:00:00.000Z',
    },
  ];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json(rows)),
  });

  const all = toolContent(await callTool(adapter, 'los_runs_list', { projectId: 'project-a' }));
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), null);
  assert.equal(new URL(requests[0]!.url).pathname, '/runs');
  // 服务端过滤：projectId/limit 必须进 query（不再"取前 N 条再由客户端过滤"）
  assert.equal(new URL(requests[0]!.url).search, '?projectId=project-a&limit=10');
  assert.equal(all.matched, 3);
  assert.equal(all.returned, 3);
  const items = all.items as Array<{ runSpecId: string; promptPreview: string }>;
  assert.deepEqual(items.map(item => item.runSpecId), ['run-other-trace', 'run-new', 'run-old']);
  assert.equal(items[2]?.promptPreview.length, 120);

  const filtered = toolContent(await callTool(adapter, 'los_runs_list', {
    projectId: 'project-a', traceId: 'trace-x', status: 'blocked', limit: 1,
  }));
  // 第二次调用才带 status ⇒ 断言放在它之后（服务端过滤参数齐全）
  assert.equal(new URL(requests[1]!.url).search, '?projectId=project-a&limit=1&status=blocked');
  assert.equal(filtered.matched, 1);
  assert.equal(filtered.returned, 1);
  assert.equal((filtered.items as Array<{ runSpecId: string }>)[0]?.runSpecId, 'run-new');
});

test('los_task_cancel requires the operator credential even though the gateway route is ungated', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({ ok: true, live: true, taskRunId: 'task/a', status: 'cancelled', reason: 'operator stop' })),
  });

  const result = toolContent(await callTool(adapter, 'los_task_cancel', {
    taskRunId: 'task/a', projectId: 'project-a', reason: 'operator stop',
  }));

  assert.equal(new URL(requests[0]!.url).pathname, '/tasks/task%2Fa/cancel');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.deepEqual(await requests[0]?.json(), { reason: 'operator stop' });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.live, true);
});

test('los_task_cancel refuses before HTTP when the adapter has no operator credential', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: '',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  const response = asRecord((await callTool(adapter, 'los_task_cancel', { taskRunId: 'task-a', projectId: 'project-a' })).result);
  assert.equal(response.isError, true);
  assert.match(String((response.content as Array<{ text: string }>)[0]?.text), /LOS_OPERATOR_TOKEN is required/);
  assert.equal(called, false);
});

test('a blocked los_run carries the next action from the state projection', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    fetchImpl: captureFetch(requests, request => {
      if (new URL(request.url).pathname === '/chat') {
        return new Response(sse(
          intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los', runSpecId: 'run-a' }),
          ['session', { sessionId: 'session-a', taskRunId: 'task-a' }],
          ['blocked', {
            sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a', runSpecStatus: 'blocked',
            blockedVerificationRecordIds: ['verification-a'],
          }],
        ), { status: 200 });
      }
      return Response.json({
        phase: 'created',
        action: 'run_verification',
        summary: 'run is created; next action run_verification; blockers=1',
        blockers: [{ kind: 'verification', message: 'required verification records are not satisfied', ids: ['verification-a'] }],
        recovery: { reasons: [] },
      });
    }),
  });

  const result = toolContent(await callTool(adapter, 'los_run', { prompt: 'x', projectId: 'los' }));

  assert.equal(result.status, 'blocked');
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1]!.url).pathname, '/runs/run-a/state');
  assert.equal(requests[1]?.headers.get('x-los-operator-token'), null);
  const nextAction = asRecord(result.nextAction);
  assert.equal(nextAction.action, 'run_verification');
  assert.equal((nextAction.blockers as Array<{ kind: string }>)[0]?.kind, 'verification');
  assert.equal(result.nextActionError, undefined);
});

test('a completed los_run does not spend an extra state call', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    fetchImpl: captureFetch(requests, () => new Response(sse(
      intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los', runSpecId: 'run-a' }),
      ['session', { sessionId: 'session-a', taskRunId: 'task-a' }],
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', taskRunId: 'task-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 })),
  });

  const result = toolContent(await callTool(adapter, 'los_run', { prompt: 'x', projectId: 'los' }));
  assert.equal(result.status, 'done');
  assert.equal(result.nextAction, undefined);
  assert.equal(requests.length, 1);
});

test('a failed next-action lookup is reported without discarding the run result', async () => {
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    // 注意：适配器以 fetchImpl(url, init) 调用（不是 Request 对象）⇒ 用 captureFetch 包一层
    fetchImpl: captureFetch([], request => {
      if (new URL(request.url).pathname === '/chat') {
        return new Response(sse(
          intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los', runSpecId: 'run-a' }),
          ['session', { sessionId: 'session-a', taskRunId: 'task-a' }],
          ['error', { sessionId: 'session-a', runSpecId: 'run-a', message: 'boom' }],
        ), { status: 200 });
      }
      return new Response('state down', { status: 500 });
    }),
  });

  const result = toolContent(await callTool(adapter, 'los_run', { prompt: 'x', projectId: 'los' }));
  assert.equal(result.status, 'error');
  assert.equal(result.message, 'boom');
  assert.equal(result.nextAction, undefined);
  assert.match(String(result.nextActionError), /LOS gateway 500/);
});

test('los_run_recover previews by default and projects the recovery decision', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({
      status: 'action_required',
      recommendation: 'resume',
      resumeToolCallIds: ['tool-1'],
      retryToolCallIds: [],
      cancelToolCallIds: [],
      operatorAttentionToolCallIds: [],
      terminalFailedToolCallIds: [],
      activeToolCallIds: ['tool-2'],
      reasons: ['stale active tool call'],
    })),
  });

  const result = toolContent(await callTool(adapter, 'los_run_recover', { runSpecId: 'run/a', projectId: 'project-a' }));

  assert.equal(new URL(requests[0]!.url).pathname, '/runs/run%2Fa/recover');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.deepEqual(await requests[0]?.json(), {});
  assert.equal(result.applied, false);
  assert.equal(result.status, 'action_required');
  assert.equal(result.recommendation, 'resume');
  assert.deepEqual(result.resumeToolCallIds, { ids: ['tool-1'], truncated: false });
});

test('los_run_recover apply=true sends the transition and caps id lists', async () => {
  const requests: Request[] = [];
  const manyIds = Array.from({ length: 25 }, (_, index) => `tool-${index}`);
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({
      runSpecId: 'run-a',
      sessionId: 'session-a',
      action: 'cancel',
      runSpecStatus: 'cancelled',
      eventType: 'run.recovery_cancelled',
      reason: 'operator stop',
      decision: { status: 'action_required', recommendation: 'cancel', cancelToolCallIds: manyIds, reasons: ['stale'] },
      transitionedToolCallIds: manyIds,
      transitionedTaskRunIds: ['task-a'],
      liveCancelledTaskRunIds: [],
    })),
  });

  const result = toolContent(await callTool(adapter, 'los_run_recover', {
    runSpecId: 'run-a', projectId: 'project-a', apply: true, intent: 'cancel', reason: 'operator stop', staleMs: 60_000,
  }));

  assert.deepEqual(await requests[0]?.json(), { apply: true, intent: 'cancel', staleMs: 60_000, reason: 'operator stop' });
  assert.equal(result.applied, true);
  assert.equal(result.action, 'cancel');
  assert.equal(result.runSpecStatus, 'cancelled');
  const capped = result.transitionedToolCallIds as { ids: string[]; truncated: boolean };
  assert.equal(capped.ids.length, 20);
  assert.equal(capped.truncated, true);
  assert.equal((result.cancelToolCallIds as { ids: string[] }).ids.length, 20);
});

test('recover and revise-plan refuse before HTTP without the operator credential', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: '',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });

  const recover = asRecord((await callTool(adapter, 'los_run_recover', { runSpecId: 'run-a', projectId: 'project-a' })).result);
  assert.equal(recover.isError, true);
  const revise = asRecord((await callTool(adapter, 'los_run_revise_plan', {
    runSpecId: 'run-a', projectId: 'project-a', plan: [{ id: 'p1' }],
  })).result);
  assert.equal(revise.isError, true);
  assert.equal(called, false);
});

test('los_run_revise_plan rejects an empty plan locally and forwards a real one', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({ runSpecId: 'run-a', planRevision: 2, previousRevision: 1, phase: 'plan_approved' })),
  });

  const empty = asRecord((await callTool(adapter, 'los_run_revise_plan', { runSpecId: 'run-a', projectId: 'project-a', plan: [] })).result);
  assert.equal(empty.isError, true);
  assert.match(String((empty.content as Array<{ text: string }>)[0]?.text), /non-empty array/);
  assert.equal(requests.length, 0);

  const plan = [{ id: 'p1', title: 'revised', description: 'd', dependsOnIds: [], editableSurfaces: [], completionCriteria: 'c' }];
  const result = toolContent(await callTool(adapter, 'los_run_revise_plan', {
    runSpecId: 'run-a', projectId: 'project-a', plan, reason: 'scope narrowed',
  }));

  assert.equal(new URL(requests[0]!.url).pathname, '/runs/run-a/revise-plan');
  assert.deepEqual(await requests[0]?.json(), { plan, reason: 'scope narrowed' });
  assert.equal(result.planRevision, 2);
  assert.equal(result.previousRevision, 1);
});

test('a caller-supplied idempotency key becomes the retry-safe request key', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    fetchImpl: captureFetch(requests, () => new Response(sse(
      intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los', runSpecId: 'run-a' }),
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 })),
  });

  await callTool(adapter, 'los_run', { prompt: 'x', projectId: 'los', idempotencyKey: 'handoff-42' });
  assert.equal(requests[0]?.headers.get('x-idempotency-key'), 'handoff-42');
});

test('dedupeKey doubles as the idempotency key when no explicit key is given', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    fetchImpl: captureFetch(requests, () => new Response(sse(
      intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los', runSpecId: 'run-a' }),
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 })),
  });

  await callTool(adapter, 'los_run', { prompt: 'x', projectId: 'los', dedupeKey: 'nightly-gate' });
  assert.equal(requests[0]?.headers.get('x-idempotency-key'), 'nightly-gate');
  assert.equal(await requests[0]?.json().then(body => (body as { dedupeKey: string }).dedupeKey), 'nightly-gate');
});

test('operator-scoped lifecycle calls also honour the caller idempotency key', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({ runSpecId: 'run-a', decision: { status: 'succeeded' } })),
  });

  await callTool(adapter, 'los_run_verify', { runSpecId: 'run-a', projectId: 'los', idempotencyKey: 'verify-7' });
  assert.equal(requests[0]?.headers.get('x-idempotency-key'), 'verify-7');
});

test('every state-changing tool advertises its parameters inside properties', async () => {
  const adapter = _createLosMCPAdapter({ fetchImpl: unreachableFetch });
  const listed = asRecord((await adapter.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))?.result);
  const tools = listed.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;

  const writeTools = ['los_run', 'los_run_verify', 'los_run_approve', 'los_run_recover', 'los_run_revise_plan', 'los_task_cancel', 'los_operator_control'];
  for (const name of writeTools) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, `${name} missing`);
    assert.ok(tool.inputSchema.properties?.idempotencyKey, `${name}: idempotencyKey must live inside properties`);
  }

  // 反面控制：schema 顶层只允许 type/properties/required —— 自造键（曾经把 idempotencyKey
  // 插到 properties 之外）会让参数对严格客户端不可见
  for (const tool of tools) {
    for (const key of Object.keys(tool.inputSchema)) {
      assert.ok(['type', 'properties', 'required'].includes(key), `${tool.name}: unexpected schema key ${key}`);
    }
  }

  const run = tools.find(item => item.name === 'los_run');
  assert.ok(run);
  const runProps = Object.keys(run.inputSchema.properties ?? {});
  for (const key of ['sandboxMode', 'allowedTools', 'operatorScope', 'detach']) {
    assert.ok(runProps.includes(key), `los_run: ${key} must be advertised`);
  }
});

test('sandboxMode and allowedTools pass through only with operator scope', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => new Response(sse(
      intakeEnvelope({ reason: 'explicit_project', ownerRepo: 'los', requestedProjectId: 'los', runSpecId: 'run-a' }),
      ['done', { sessionId: 'session-a', runSpecId: 'run-a', runSpecStatus: 'succeeded', text: 'ok' }],
    ), { status: 200 })),
  });

  await callTool(adapter, 'los_run', {
    prompt: 'x', projectId: 'los', operatorScope: true, sandboxMode: 'readonly', allowedTools: ['read_file', 'glob'],
  });
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  const body = await requests[0]?.json() as Record<string, unknown>;
  assert.equal(body.sandboxMode, 'readonly');
  assert.deepEqual(body.allowedTools, ['read_file', 'glob']);
});

test('sandboxMode and allowedTools are refused locally without operator scope', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: 'operator-secret',
    fetchImpl: async () => { called = true; return new Response('{}'); },
  });

  const noScope = asRecord((await callTool(adapter, 'los_run', {
    prompt: 'x', projectId: 'los', sandboxMode: 'readonly',
  })).result);
  assert.equal(noScope.isError, true);
  assert.match(String((noScope.content as Array<{ text: string }>)[0]?.text), /require operatorScope=true/);

  const badMode = asRecord((await callTool(adapter, 'los_run', {
    prompt: 'x', projectId: 'los', operatorScope: true, sandboxMode: 'yolo',
  })).result);
  assert.equal(badMode.isError, true);
  assert.match(String((badMode.content as Array<{ text: string }>)[0]?.text), /sandboxMode must be one of/);

  const badTools = asRecord((await callTool(adapter, 'los_run', {
    prompt: 'x', projectId: 'los', operatorScope: true, allowedTools: 'read_file',
  })).result);
  assert.equal(badTools.isError, true);
  assert.match(String((badTools.content as Array<{ text: string }>)[0]?.text), /allowedTools must be an array/);

  assert.equal(called, false);
});

test('los_nodes_list projects the fleet with operator auth and capability keys', async () => {
  const requests: Request[] = [];
  const rows = [
    {
      nodeId: 'm3pro-executor-1', nodeKind: 'executor', hostLabel: 'losdeMacBook-Pro.local', status: 'online',
      resourceClass: 'standard_executor', version: '0.1.0+b47a933', queueDepth: 0, activeTaskCount: 1,
      // 真实形状：/nodes 的 capabilities 是对象（键→true/字符串/数组），不是数组
      capabilities: { run_agent: true, deploy_safe: true, heavy_task_safe: true, artifact_transfer: true, sandbox: 'macos-sandbox-exec', workspace_read: false },
      lastHeartbeatAt: '2026-10-11T03:55:10.950Z',
    },
    {
      nodeId: 'vultr-executor', nodeKind: 'executor', hostLabel: 'vultr', status: 'online',
      resourceClass: 'constrained_executor', queueDepth: 3, activeTaskCount: 0,
      capabilities: { run_agent: true, deploy_safe: true, heavy_task_safe: false, sandbox: 'tool_policy' }, lastHeartbeatAt: '2026-10-11T03:55:09.000Z',
    },
    { nodeId: 'old-node', nodeKind: 'executor', hostLabel: 'gone', status: 'offline', capabilities: {}, queueDepth: 0, activeTaskCount: 0 },
  ];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json(rows)),
  });

  const result = toolContent(await callTool(adapter, 'los_nodes_list', { projectId: 'los', status: 'online' }));

  assert.equal(new URL(requests[0]!.url).pathname, '/nodes');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.equal(result.total, 3);
  assert.equal(result.online, 2);
  assert.equal(result.matched, 2);
  const items = result.items as Array<{ nodeId: string; capabilities: string[]; sandbox?: string }>;
  assert.deepEqual(items.map(item => item.nodeId), ['m3pro-executor-1', 'vultr-executor']);
  // 只有值为 true 的键算能力（负向控制：workspace_read:false 不得出现）
  assert.deepEqual(items[0]?.capabilities, ['artifact_transfer', 'deploy_safe', 'heavy_task_safe', 'run_agent']);
  assert.equal(items[0]?.sandbox, 'macos-sandbox-exec');
  assert.deepEqual(items[1]?.capabilities, ['deploy_safe', 'run_agent']);
});

test('los_nodes_list refuses before HTTP without the operator credential', async () => {
  let called = false;
  const adapter = _createLosMCPAdapter({
    operatorToken: '',
    fetchImpl: async () => { called = true; return new Response('[]'); },
  });

  const response = asRecord((await callTool(adapter, 'los_nodes_list', { projectId: 'los' })).result);
  assert.equal(response.isError, true);
  assert.match(String((response.content as Array<{ text: string }>)[0]?.text), /LOS_OPERATOR_TOKEN is required/);
  assert.equal(called, false);
});

test('los_placed_run creates a placed schedule then triggers it, with operator auth', async () => {
  const requests: Request[] = [];
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: captureFetch(requests, () => Response.json({
      schedule: {
        id: 'schedule-placed-1',
        status: 'enabled',
        projectId: 'cantool',
        runTemplate: {
          templateId: 'scheduled_execution',
          executor: { enabled: true, nodeId: 'm3pro-executor-1', requiredCapabilities: ['heavy_task_safe', 'artifact_transfer'] },
        },
      },
    }, { status: 201 })),
  });

  // 触发调用返回调度运行记录：用请求序号区分两个响应
  const sequenced = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      requests.push(new Request(String(url), init as RequestInit));
      if (String(url).includes('/trigger')) {
        return Response.json({ id: 'schedule-run-placed-1', status: 'succeeded', attemptCount: 1 });
      }
      return Response.json({
        schedule: {
          id: 'schedule-placed-1', status: 'enabled', projectId: 'cantool',
          runTemplate: { templateId: 'scheduled_execution', executor: { enabled: true, nodeId: 'm3pro-executor-1', requiredCapabilities: ['heavy_task_safe', 'artifact_transfer'] } },
        },
      }, { status: 201 });
    }) as typeof fetch,
  });

  const result = toolContent(await callTool(sequenced, 'los_placed_run', {
    projectId: 'cantool',
    goalTemplate: 'build cantool on M3',
    nodeId: 'm3pro-executor-1',
    requiredCapabilities: ['heavy_task_safe', 'artifact_transfer'],
    workspaceRoot: '/Users/echerlos/projects/cantool',
    editableSurfaces: ['/Users/echerlos/projects/cantool'],
    requiredChecks: ['test -d src-tauri'],
    toolMode: 'project-write',
  }));

  assert.equal(new URL(requests[0]!.url).pathname, '/scheduled-work-items');
  assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-secret');
  const body = await requests[0]?.json() as Record<string, any>;
  assert.equal(body.templateId, 'scheduled_execution');
  assert.equal(body.approvalPolicy, 'preapproved_scope');
  assert.equal(body.trigger.kind, 'once');
  assert.deepEqual(body.executor, {
    enabled: true,
    nodeId: 'm3pro-executor-1',
    requiredNodeId: 'm3pro-executor-1',
    requiredCapabilities: ['heavy_task_safe', 'artifact_transfer'],
  });

  assert.equal(new URL(requests[1]!.url).pathname, '/scheduled-work-items/schedule-placed-1/trigger');
  assert.equal(requests[1]?.headers.get('x-los-operator-token'), 'operator-secret');
  assert.equal(result.scheduleId, 'schedule-placed-1');
  assert.equal(result.scheduleRunId, 'schedule-run-placed-1');
  assert.equal(result.runStatus, 'succeeded');
  assert.equal(result.nodeId, 'm3pro-executor-1');
  assert.ok(adapter); // 第一份适配器仅用于断言类型/构造不抛错
});

test('los_placed_run surfaces a capability refusal instead of hinting success', async () => {
  const adapter = _createLosMCPAdapter({
    gatewayUrl: 'http://gateway.test',
    authToken: 'access-secret',
    operatorToken: 'operator-secret',
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: 'unknown executor capability: heavy_task_safe_typo; allowed: workspace_read, ...' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch,
  });

  const response = asRecord((await callTool(adapter, 'los_placed_run', {
    projectId: 'cantool',
    goalTemplate: 'build',
    requiredCapabilities: ['heavy_task_safe_typo'],
  })).result);
  assert.equal(response.isError, true);
  assert.match(String((response.content as Array<{ text: string }>)[0]?.text), /unknown executor capability/);
});

test('unknown tools fail without touching the gateway', async () => {
  const adapter = _createLosMCPAdapter({ fetchImpl: unreachableFetch });
  const response = await callTool(adapter, 'los_unknown', {});
  const result = asRecord(response.result);
  assert.equal(result.isError, true);
  assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /Unknown MCP tool/);
});

async function callTool(adapter: LosMCPAdapter, name: string, args: Record<string, unknown>) {
  const response = await adapter.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.ok(response);
  return response;
}

function toolContent(response: Awaited<ReturnType<typeof callTool>>): Record<string, unknown> {
  const result = asRecord(response.result);
  assert.notEqual(result.isError, true);
  const text = (result.content as Array<{ text: string }>)[0]?.text;
  assert.ok(text);
  return asRecord(JSON.parse(text));
}

function captureFetch(requests: Request[], respond: (request: Request) => Response): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  };
}

/** 拼一段网关风格的 SSE：每个事件一个块，块间空行（与 `parseSSE` 的分块判据一致）。 */
function sse(...events: Array<[string, Record<string, unknown>]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join('\n');
}

/**
 * `coordinator.intake_resolved` 在真实流里是**信封**形状（归属字段在 `payload` 内，
 * 信封自身另有网关标注的 `projectId`）——2026-10-11 实测 `/tmp/sse-dump.txt`。
 */
function intakeEnvelope(payload: Record<string, unknown>): [string, Record<string, unknown>] {
  return ['coordinator.intake_resolved', {
    id: 1,
    sessionId: 'session-a',
    projectId: payload.ownerRepo,
    source: 'coordinator',
    payload,
  }];
}

/** 分多次下发的 SSE 响应体：用来验证"读到某事件就停"（detach）而不是一次读完。 */
function sseStream(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function unreachableFetch(): Promise<Response> {
  throw new Error('fetch should not be called');
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
