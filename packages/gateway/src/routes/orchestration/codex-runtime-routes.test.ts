import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { getConfig, setConfig } from '@los/infra/config';
import type { CodexRuntimeHandle } from '@los/agent/runtime-adapter';
import { registerRequestContext } from '../../request-context.js';
import {
  registerRuntimeAdapterRoutes,
  type RuntimeAdapterRouteDependencies,
} from './runtime-adapter-routes.js';

// Codex availability checks must run BEFORE the SSE handshake: once SSE
// headers are written, reply.status() throws "Cannot write headers after
// they are sent to the client" (regression guard for that bug).

function dependencies(codex: RuntimeAdapterRouteDependencies['codex']): RuntimeAdapterRouteDependencies {
  return {
    scanGrokAccount: () => ({
      candidateId: 'xai-grok-default',
      provider: 'xai',
      runtimeKind: 'grok',
      available: false,
      cliInstalled: false,
      authMode: 'oidc',
      sourceKind: 'default_home',
      reason: null,
    }),
    loadProviderAccount: async () => null,
    setProviderAccountState: async (input) => {
      throw new Error(`unexpected setProviderAccountState(${input.state})`);
    },
    spawnGrok: () => {
      throw new Error('spawnGrok should not be called in codex tests');
    },
    codex,
  };
}

async function buildApp(deps: RuntimeAdapterRouteDependencies) {
  const config = getConfig();
  config.auth.enabled = false;
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerRuntimeAdapterRoutes(app, undefined, deps);
  await app.ready();
  return app;
}

test('codex runtime returns plain 400 (no SSE) when codex CLI is unavailable', async () => {
  const app = await buildApp(dependencies({ codexSupportsOtel: () => false }));
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/runtimes/codex/run',
      payload: { prompt: 'hello', workspaceRoot: process.cwd() },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'codex_not_available');
    // No SSE headers were written — plain JSON error response.
    assert.doesNotMatch(response.headers['content-type'] ?? '', /text\/event-stream/);
  } finally {
    await app.close();
  }
});

test('codex runtime streams runtime.process/completed events on success', async () => {
  const deps = dependencies({
    codexSupportsOtel: () => true,
    isOtelBridgeRunning: () => true,
    startOtelBridge: async () => ({ port: 4318, stop: async () => undefined }),
    spawnCodex: () => ({
      pid: 4242,
      kill: () => true,
      exited: Promise.resolve({ exitCode: 0, signal: null }),
      output: Promise.resolve({
        output: 'codex review output',
        exitCode: 0,
        spawnFailed: false,
        truncated: false,
        outputBytes: 18,
        stderrBytes: 0,
      }),
    }) as unknown as CodexRuntimeHandle,
  });
  const app = await buildApp(deps);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/runtimes/codex/run',
      payload: { prompt: 'review this', workspaceRoot: process.cwd(), timeoutMs: 5_000 },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
    assert.match(response.body, /event: runtime\.process/);
    assert.match(response.body, /event: runtime\.completed/);
    assert.match(response.body, /"exitCode":0/);
  } finally {
    await app.close();
  }
});
