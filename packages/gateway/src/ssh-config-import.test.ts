import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSshImportItems } from './ssh-config-import.js';

test('ssh config import resolves ssh targets and endpoints', () => {
  const items = buildSshImportItems(
    `
Host hh-sgp1-r-t
  HostName 100.86.24.22
  User root
  Port 23452
  IdentityFile ~/.ssh/hh

Host node34
  HostName 192.168.31.34
  User admin
`,
    new Set(['node34']),
    { dryRun: true, createMissing: true },
  );

  assert.equal(items.length, 2);
  assert.equal(items[0].nodeId, 'hh-sgp1-r-t');
  assert.equal(items[0].action, 'create');
  assert.equal(items[0].willWrite, false);
  assert.equal((items[0].node?.connectConfig.tailscale_ssh as any).endpoint, 'root@100.86.24.22:23452');
  assert.equal((items[0].node?.connectConfig.ssh as any).host_name, '100.86.24.22');
  assert.equal(items[1].action, 'update');
  assert.equal(items[1].matchedNodeId, 'node34');
  assert.equal((items[1].node?.connectConfig.tailscale_ssh as any).endpoint, 'admin@192.168.31.34:22');
});
