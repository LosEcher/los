import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

import { createNodeCheckRunner } from './node-check-runner.js';

async function withServer<T>(
  handler: (body: unknown) => { status: number; body: unknown },
  run: (url: string, seen: unknown[]) => Promise<T>,
): Promise<T> {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push(body);
      const result = handler(body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1/nodes/n/commands`;
  try {
    return await run(url, seen);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('node check runner sends run-check to the node and maps the node result', async () => {
  await withServer(
    () => ({ status: 202, body: { ok: true, command: { status: 'succeeded', output: { exitCode: 0, stdout: 'Linux', stderr: '' } } } }),
    async (url, seen) => {
      const runner = createNodeCheckRunner({ nodeId: 'node34-executor-1', agentKey: 'secret', commandUrl: url });
      const result = await runner('uname -s', { cwd: '/opt/los/los-workspace', timeoutMs: 5_000 });
      assert.equal(result.exitCode, 0);
      assert.equal(result.outputSummary, 'Linux');
      assert.equal(result.error, undefined);
      assert.deepEqual(seen[0], {
        command: 'run-check',
        args: { command: 'uname -s', cwd: '/opt/los/los-workspace', timeoutMs: 5_000 },
      });
    },
  );
});

test('node check runner surfaces a node rejection instead of pretending success', async () => {
  await withServer(
    () => ({ status: 501, body: { error: 'command not implemented: run-check' } }),
    async (url) => {
      const runner = createNodeCheckRunner({ nodeId: 'stale-node', commandUrl: url });
      const result = await runner('uname -s', { cwd: '/opt/los/los-workspace' });
      assert.equal(result.exitCode, null);
      assert.match(String(result.error), /command not implemented|501/);
    },
  );
});

test('node check runner reports a missing endpoint rather than running locally', async () => {
  const runner = createNodeCheckRunner({ nodeId: 'node-without-endpoint', commandUrl: '' });
  const result = await runner('uname -s', { cwd: '/opt/los/los-workspace' });
  assert.equal(result.exitCode, null);
  assert.match(String(result.error), /no governed command endpoint/);
});
