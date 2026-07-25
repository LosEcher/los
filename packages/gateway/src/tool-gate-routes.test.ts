import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { registerToolGateRoutes } from './routes/orchestration/tool-gate-routes.js';
import type { ToolGateRouteDependencies } from './routes/orchestration/tool-gate-routes.js';

// ── Stub deps: in-memory state with mutable fragileFiles, no DB ──

const fragileFiles = new Set<string>();
const failureFingerprints = new Set<string>();
const events: Array<Record<string, unknown>> = [];

const stubDeps: ToolGateRouteDependencies = {
  createPreActionFailureEvidence: (toolName, args, error, callId) =>
    ({ toolName, args, error, callId, fingerprint: `fp-${toolName}`, recordedAt: new Date().toISOString() } as any),
  loadPreActionEvidence: async (_opts) =>
    ({ fragileFiles: new Set(fragileFiles), failureFingerprints: new Set(failureFingerprints) } as any),
  preActionGate: (_toolName, _args, config): any => {
    const tp = typeof _toolName === 'string' ? _toolName : '';
    const filePath = typeof _args.file_path === 'string' ? _args.file_path : '';
    const fpKey = `fp-${tp}`;
    const isFragile = config?.fragileFiles?.has(filePath) ?? false;
    const isKnownFailure = config?.failureFingerprints?.has(fpKey) ?? false;
    const isKnown = isFragile || isKnownFailure;
    // Real preActionGate surfaces flaggedFiles for fragile files AND known-failure tool+file combos
    return {
      safe: true,
      warnings: isKnown ? ['Previously failed. Proceed with caution.'] : [],
      knownFailure: isKnown,
      failurePatterns: isKnownFailure ? [fpKey] : [],
      flaggedFiles: isKnown ? [filePath] : [],
    };
  },
  appendSessionEvent: async (input) => {
    events.push(input as unknown as Record<string, unknown>);
    const data = input as any;
    if (data.type === 'tool.pre_action.fragile_file.added' && typeof data.payload?.path === 'string') {
      fragileFiles.add(data.payload.path);
    } else if (data.type === 'tool.pre_action.fragile_file.removed' && typeof data.payload?.path === 'string') {
      fragileFiles.delete(data.payload.path);
    } else if (data.type === 'tool.pre_action.failure') {
      const fp = data.payload?.fingerprint;
      if (typeof fp === 'string') failureFingerprints.add(fp);
    }
    return { id: events.length, ...input } as any;
  },
};

test('tool feedback is restored by a new gateway instance', async () => {
  const suffix = randomUUID();
  const sessionId = `tool-gate-${suffix}`;
  const projectId = `tool-gate-project-${suffix}`;
  const filePath = `src/failed-${suffix}.ts`;
  const firstGateway = Fastify();
  registerToolGateRoutes(firstGateway, stubDeps);

  const feedback = await firstGateway.inject({
    method: 'POST',
    url: '/operator/tool-feedback',
    payload: {
      callId: 'failed-call',
      toolName: 'write',
      args: { file_path: filePath },
      ok: false,
      error: 'typecheck failed',
      sessionId,
      projectId,
    },
  });
  assert.equal(feedback.statusCode, 200);
  assert.equal(feedback.json().failureFingerprints, 1);
  await firstGateway.close();

  const secondGateway = Fastify();
  registerToolGateRoutes(secondGateway, stubDeps);
  const gate = await secondGateway.inject({
    method: 'POST',
    url: '/operator/tool-gate',
    payload: {
      callId: 'retry-call',
      toolName: 'write',
      args: { file_path: filePath },
      sessionId: `retry-${suffix}`,
      projectId,
    },
  });
  assert.equal(gate.statusCode, 200);
  assert.equal(gate.json().allowed, true);
  assert.equal(gate.json().knownFailure, true);
  assert.deepEqual(gate.json().flaggedFiles, [filePath]);
  await secondGateway.close();
});

test('operator fragile-file changes persist and can be removed', async () => {
  const filePath = `src/operator-${randomUUID()}.ts`;
  const app = Fastify();
  registerToolGateRoutes(app, stubDeps);

  const added = await app.inject({
    method: 'POST',
    url: '/operator/tool-gate/fragile-files',
    payload: { action: 'add', paths: [filePath] },
  });
  assert.equal(added.statusCode, 200);
  assert.equal(added.json().fragileFiles.includes(filePath), true);

  const removed = await app.inject({
    method: 'POST',
    url: '/operator/tool-gate/fragile-files',
    payload: { action: 'remove', paths: [filePath] },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().fragileFiles.includes(filePath), false);
  await app.close();
});
