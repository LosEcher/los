import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(packageRoot, '..', '..');

test('gateway does not register the rejected ACP execution surface', async () => {
  const serverSource = await readFile(resolve(packageRoot, 'src/server.ts'), 'utf-8');
  const contractSource = await readFile(
    resolve(workspaceRoot, 'contracts/programmatic-agent-interface.yaml'),
    'utf-8',
  );

  assert.doesNotMatch(serverSource, /registerAcpRoutes|['"]\/acp['"]/);
  assert.match(contractSource, /ACP or a new JSON-RPC gateway route/);
  await assert.rejects(access(resolve(packageRoot, 'src/routes/acp.ts')));
});
