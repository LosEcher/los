/**
 * ssh-client.test.ts — Tests for SSH executor client.
 *
 * Tests cover: config parsing, SSH args building, URL resolution,
 * and exercise the line iterator without needing a real SSH server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSSHConfig, resolveSSHExecutorNodeUrl, resolveSSHExecutor, sshExecutorUrlToConnectConfig } from './ssh-client.js';
import type { ExecutorNodeRecord } from '../executor-nodes.js';

function makeNode(overrides: Partial<ExecutorNodeRecord> = {}): ExecutorNodeRecord {
  return {
    nodeId: 'test-ssh-node',
    nodeKind: 'ssh_target',
    status: 'online',
    baseUrl: '',
    hostLabel: 'test-host',
    connectModes: ['direct_ssh'],
    connectConfig: {
      direct_ssh: {
        user: 'runner',
        host: '10.0.0.2',
        port: 22,
        identityFile: '/home/runner/.ssh/id_ed25519',
      },
    },
    capacity: {},
    capabilities: {},
    verified: {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    execution: { candidate: true, blockers: [], warnings: [] },
    ...overrides,
  };
}

describe('readSSHConfig', () => {
  it('parses direct_ssh connect config', () => {
    const config = readSSHConfig({
      direct_ssh: { user: 'runner', host: '10.0.0.5', port: 2222 },
    });
    assert.ok(config);
    assert.equal(config!.user, 'runner');
    assert.equal(config!.host, '10.0.0.5');
    assert.equal(config!.port, 2222);
  });

  it('parses tailscale_ssh connect config', () => {
    const config = readSSHConfig({
      tailscale_ssh: { user: 'root', host: 'node-34' },
    });
    assert.ok(config);
    assert.equal(config!.user, 'root');
    assert.equal(config!.host, 'node-34');
  });

  it('parses cf_tunnel_ssh connect config', () => {
    const config = readSSHConfig({
      cf_tunnel_ssh: { user: 'deploy', host: 'executor.internal' },
    });
    assert.ok(config);
    assert.equal(config!.host, 'executor.internal');
  });

  it('returns null for non-SSH config', () => {
    const config = readSSHConfig({
      agent_http: { baseUrl: 'http://localhost:8090' },
    });
    assert.equal(config, null);
  });

  it('returns null when user is missing', () => {
    const config = readSSHConfig({
      direct_ssh: { host: '10.0.0.5' },
    });
    assert.equal(config, null);
  });

  it('returns null when host is missing', () => {
    const config = readSSHConfig({
      direct_ssh: { user: 'runner' },
    });
    assert.equal(config, null);
  });

  it('reads optional fields', () => {
    const config = readSSHConfig({
      direct_ssh: {
        user: 'runner',
        host: '10.0.0.5',
        identityFile: '/custom/key',
        connectTimeoutSec: 10,
        executorBin: 'my-los-exec',
        executorPort: 9090,
      },
    });
    assert.equal(config!.identityFile, '/custom/key');
    assert.equal(config!.connectTimeoutSec, 10);
    assert.equal(config!.executorBin, 'my-los-exec');
    assert.equal(config!.executorPort, 9090);
  });
});

describe('resolveSSHExecutorNodeUrl', () => {
  it('builds ssh:// URL from direct_ssh config', () => {
    const node = makeNode();
    const url = resolveSSHExecutorNodeUrl(node);
    assert.ok(url);
    assert.ok(url!.startsWith('ssh://runner@10.0.0.2'));
    assert.ok(url!.includes('bin=los-executor'));
    assert.ok(url!.includes('port=8090'));
  });

  it('returns null when node has no SSH config', () => {
    const node = makeNode({
      connectConfig: { agent_http: { baseUrl: 'http://localhost:8090' } },
      connectModes: ['agent_http'],
      nodeKind: 'executor',
    });
    assert.equal(resolveSSHExecutorNodeUrl(node), null);
  });

  it('includes non-default port in URL', () => {
    const node = makeNode({
      connectConfig: {
        direct_ssh: { user: 'runner', host: '10.0.0.2', port: 2222 },
      },
    });
    const url = resolveSSHExecutorNodeUrl(node);
    assert.ok(url!.includes('runner@10.0.0.2:2222'));
  });

  it('round-trips identity file, port, executor bin, and executor port without SSH arg leakage', () => {
    const node = makeNode({
      connectConfig: {
        direct_ssh: {
          user: 'runner',
          host: '10.0.0.34',
          port: 2222,
          identityFile: '/home/runner/.ssh/id_ed25519',
          executorBin: '/opt/los/bin/los-executor',
          executorPort: 19090,
        },
      },
    });
    const url = resolveSSHExecutorNodeUrl(node);
    assert.ok(url);
    assert.match(url!, /^ssh:\/\/runner@10\.0\.0\.34:2222\?/);
    assert.doesNotMatch(url!, / -i /);
    assert.doesNotMatch(url!, / -p /);

    const parsed = readSSHConfig(sshExecutorUrlToConnectConfig(url!));
    assert.ok(parsed);
    assert.equal(parsed!.user, 'runner');
    assert.equal(parsed!.host, '10.0.0.34');
    assert.equal(parsed!.port, 2222);
    assert.equal(parsed!.identityFile, '/home/runner/.ssh/id_ed25519');
    assert.equal(parsed!.executorBin, '/opt/los/bin/los-executor');
    assert.equal(parsed!.executorPort, 19090);
  });
});

describe('resolveSSHExecutor', () => {
  it('returns SSH executor for node with direct_ssh mode', () => {
    const node = makeNode();
    const executor = resolveSSHExecutor(node);
    assert.ok(executor);
    assert.equal(executor!.nodeId, 'test-ssh-node');
    assert.equal(executor!.sshConfig.user, 'runner');
    assert.equal(executor!.sshConfig.host, '10.0.0.2');
  });

  it('returns null for HTTP-only executor node', () => {
    const node = makeNode({
      nodeKind: 'executor',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl: 'http://localhost:8090' },
      },
    });
    const executor = resolveSSHExecutor(node);
    assert.equal(executor, null);
  });

  it('detects tailscale_ssh node', () => {
    const node = makeNode({
      connectModes: ['tailscale_ssh'],
      connectConfig: {
        tailscale_ssh: { user: 'deploy', host: 'ts-node' },
      },
    });
    const executor = resolveSSHExecutor(node);
    assert.ok(executor);
    assert.equal(executor!.sshConfig.host, 'ts-node');
  });

  it('returns null when SSH config is missing despite mode', () => {
    const node = makeNode({
      connectModes: ['direct_ssh'],
      connectConfig: {},
    });
    const executor = resolveSSHExecutor(node);
    assert.equal(executor, null);
  });
});

describe('extractSSHConfigFromUrl (via executor-client integration)', () => {
  it('ssh:// URL resolves to correct node URL', () => {
    // Test that the URL format used by resolveSSHExecutorNodeUrl
    // carries enough info to reconstruct the SSH session.
    const node = makeNode({
      connectConfig: {
        direct_ssh: {
          user: 'runner',
          host: '10.0.0.34',
          port: 22,
          identityFile: '/home/runner/.ssh/id_ed25519',
          executorBin: 'los-executor',
          executorPort: 8090,
        },
      },
    });
    const url = resolveSSHExecutorNodeUrl(node);
    assert.ok(url);
    assert.match(url!, /^ssh:\/\/runner@10\.0\.0\.34/);
    assert.match(url!, /bin=los-executor/);
    assert.match(url!, /port=8090/);

    // Verify that readSSHConfig can parse the config reconstructed from URL.
    const parsed = readSSHConfig(sshExecutorUrlToConnectConfig(url!));
    assert.ok(parsed);
    assert.equal(parsed!.user, 'runner');
    assert.equal(parsed!.host, '10.0.0.34');
    assert.equal(parsed!.identityFile, '/home/runner/.ssh/id_ed25519');
  });
});
