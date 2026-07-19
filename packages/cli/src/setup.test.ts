import assert from 'node:assert/strict';
import test from 'node:test';

import { setupCommand } from './setup.js';

const SECRET = 'must-not-appear-in-output';

test('setup aggregates readiness without exposing source secrets or paths', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args) => lines.push(args.join(' '));
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    return json(responseFor(path));
  };
  try {
    await setupCommand([], ['--gateway', 'http://gateway.test', '--auth-token', SECRET, '--json']);
    const serialized = lines.join('\n');
    const report = JSON.parse(serialized) as { checks: Array<{ id: string; state: string }> };
    assert.equal(report.checks.length, 8);
    assert.equal(report.checks.find(check => check.id === 'provider')?.state, 'ready');
    assert.equal(report.checks.find(check => check.id === 'executor')?.state, 'ready');
    assert.equal(report.checks.find(check => check.id === 'workspace')?.state, 'ready');
    assert.doesNotMatch(serialized, new RegExp(SECRET));
    assert.doesNotMatch(serialized, /workspace\/secret-project|credentials\.json|api-key-value/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('setup keeps auth and compatibility gaps actionable and redacted', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args) => lines.push(args.join(' '));
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (!['/health', '/settings', '/onboarding'].includes(path)) return json({ error: SECRET }, 401);
    return json(responseFor(path, false));
  };
  try {
    await setupCommand([], ['--gateway', 'http://gateway.test']);
    const output = lines.join('\n');
    assert.match(output, /Auth\s+enabled; no access token supplied/);
    assert.match(output, /compatibility evidence is still required/);
    assert.match(output, /set LOS_AUTH_TOKEN/);
    assert.doesNotMatch(output, new RegExp(SECRET));
    assert.doesNotMatch(output, /api-key-value|credentials\.json/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

function responseFor(path: string, passingCompat = true): unknown {
  if (path === '/health') return { status: 'ok', uptime: 5, sourceSecret: SECRET };
  if (path === '/settings') return { auth: { enabled: true }, executor: { enabled: true } };
  if (path === '/onboarding') return {
    providers: [{
      name: 'deepseek', readiness: { ready: true }, apiKey: 'api-key-value',
      compatEvidence: { count: passingCompat ? 1 : 0, latest: passingCompat ? { passed: true } : null },
    }],
    tools: [{ name: 'Hermes', installed: true, configPath: '/workspace/secret-project/credentials.json' }],
  };
  if (path === '/workspace') return { workspaceRoot: '/workspace/secret-project' };
  if (path === '/projects') return { projects: [{ projectId: 'secret-project', workspacePath: '/workspace/secret-project' }] };
  if (path === '/services') return [{ serviceId: 'gateway-local' }];
  if (path === '/nodes') return [{ nodeId: 'local', status: 'online', execution: { candidate: true } }];
  if (path === '/communication/accounts') return {
    channels: [{ id: 'web', live: true, status: 'live' }, { id: 'weixin', live: true, status: 'connected' }],
    weixin: { weclawBinary: '/workspace/secret-project/weclaw' },
  };
  return {};
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
