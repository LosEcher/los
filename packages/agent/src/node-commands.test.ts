/**
 * P0-3 promote version-check tests — pure decision logic, no live DB.
 *
 * executeNodeCommand itself cannot be driven from here: it opens the
 * node_commands + executor_nodes stores through @los/infra/db and writes
 * through upsertExecutorNode (Postgres required). The promote branch delegates
 * its version decision to evaluatePromoteVersionCheck (same module), which is
 * exercised directly below; simulatePromoteBranch is a dependency-injected
 * copy of that branch's call site, used to assert a denied check never reaches
 * the registry writer with status='online'.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePromoteVersionCheck } from './node-commands.js';
import type { ExecuteNodeCommandInput } from './node-commands.js';
import type { ExecutorNodeRecord, ExecutorNodeUpsertInput } from './executor-nodes.js';

const RECORDED_VERSION = '0.1.0+b8883f8d4612c';
const EXPECTED_NEWER_VERSION = '0.1.0+c91af27e04d77';

function makeNode(overrides: Partial<ExecutorNodeRecord> = {}): ExecutorNodeRecord {
  return {
    nodeId: 'executor-node-1',
    nodeKind: 'executor',
    status: 'draining',
    version: RECORDED_VERSION,
    connectModes: ['agent_http'],
    connectConfig: {},
    capacity: {},
    capabilities: {},
    verified: {},
    queueDepth: 0,
    activeTaskCount: 2,
    meshLinks: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    execution: { candidate: true, blockers: [], warnings: [] },
    ...overrides,
  };
}

function promoteInput(overrides: Partial<ExecuteNodeCommandInput> = {}): ExecuteNodeCommandInput {
  return { nodeId: 'executor-node-1', command: 'promote', ...overrides };
}

type PromoteWrite = Pick<
  ExecutorNodeUpsertInput,
  'nodeId' | 'status' | 'rolloutState' | 'rolloutMessage' | 'activeTaskCount'
>;

/** Mirror of the promote branch in executeNodeCommand, with the registry injected. */
async function simulatePromoteBranch(
  node: ExecutorNodeRecord,
  input: ExecuteNodeCommandInput,
  upsert: (write: PromoteWrite) => Promise<ExecutorNodeRecord>,
): Promise<{ status: 'succeeded' | 'denied'; error?: string; promoted?: PromoteWrite }> {
  const versionCheck = evaluatePromoteVersionCheck(node, input);
  if (!versionCheck.allowed) {
    return { status: 'denied', error: versionCheck.error };
  }
  const promoted: PromoteWrite = {
    nodeId: node.nodeId,
    status: 'online',
    rolloutState: 'idle',
    rolloutMessage: versionCheck.rolloutMessage,
    activeTaskCount: node.activeTaskCount,
  };
  await upsert(promoted);
  return { status: 'succeeded', promoted };
}

describe('evaluatePromoteVersionCheck', () => {
  it('denies promote when the expected version does not match the recorded version', () => {
    const check = evaluatePromoteVersionCheck(makeNode(), promoteInput({ targetVersion: EXPECTED_NEWER_VERSION }));

    assert.equal(check.allowed, false);
    const error = check.error ?? '';
    assert.ok(error.includes(EXPECTED_NEWER_VERSION), `error must name the expected version: ${error}`);
    assert.ok(error.includes(RECORDED_VERSION), `error must name the recorded version: ${error}`);
    assert.ok(error.includes('executor-node-1'), `error must name the node: ${error}`);
  });

  it('denies promote when the node has no recorded version', () => {
    const check = evaluatePromoteVersionCheck(
      makeNode({ version: undefined }),
      promoteInput({ targetVersion: EXPECTED_NEWER_VERSION }),
    );

    assert.equal(check.allowed, false);
    const error = check.error ?? '';
    assert.ok(error.includes(EXPECTED_NEWER_VERSION), `error must name the expected version: ${error}`);
    assert.ok(error.includes('unknown'), `error must state the recorded version is unknown: ${error}`);
  });

  it('allows promote when the expected version matches the recorded version', () => {
    const check = evaluatePromoteVersionCheck(makeNode(), promoteInput({ targetVersion: RECORDED_VERSION }));

    assert.equal(check.allowed, true);
    assert.equal(check.error, undefined);
    assert.equal(check.rolloutMessage, `promoted (version ${RECORDED_VERSION})`);
  });

  it('tolerates surrounding whitespace on the expected version', () => {
    const check = evaluatePromoteVersionCheck(
      makeNode(),
      promoteInput({ targetVersion: `  ${RECORDED_VERSION}\n` }),
    );

    assert.equal(check.allowed, true);
    assert.equal(check.rolloutMessage, `promoted (version ${RECORDED_VERSION})`);
  });

  it('keeps the operator reason in the rollout message', () => {
    const check = evaluatePromoteVersionCheck(
      makeNode(),
      promoteInput({ targetVersion: RECORDED_VERSION, reason: 'drain window closed' }),
    );

    assert.equal(check.allowed, true);
    assert.equal(check.rolloutMessage, `drain window closed (version ${RECORDED_VERSION})`);
  });

  it('allows promote without an expected version (backward compatible) and records the version', () => {
    const check = evaluatePromoteVersionCheck(makeNode(), promoteInput());

    assert.equal(check.allowed, true);
    assert.equal(check.rolloutMessage, `promoted (version ${RECORDED_VERSION})`);
  });

  it('falls back to the legacy rollout message when the node has no recorded version', () => {
    const nodeWithoutVersion = makeNode({ version: undefined });

    assert.equal(evaluatePromoteVersionCheck(nodeWithoutVersion, promoteInput()).rolloutMessage, 'promoted');
    assert.equal(
      evaluatePromoteVersionCheck(nodeWithoutVersion, promoteInput({ reason: 'manual promote' })).rolloutMessage,
      'manual promote',
    );
  });
});

describe('promote branch contract (simulated call site)', () => {
  it('does not write status=online when the expected version is stale', async () => {
    const node = makeNode();
    const writes: PromoteWrite[] = [];
    const result = await simulatePromoteBranch(
      node,
      promoteInput({ targetVersion: EXPECTED_NEWER_VERSION }),
      async write => {
        writes.push(write);
        return { ...node, status: 'online', rolloutState: 'idle' };
      },
    );

    assert.equal(result.status, 'denied');
    assert.deepEqual(writes, []);
    assert.ok((result.error ?? '').includes(EXPECTED_NEWER_VERSION));
  });

  it('writes status=online with the promoted version when the expected version matches', async () => {
    const node = makeNode();
    const writes: PromoteWrite[] = [];
    const result = await simulatePromoteBranch(
      node,
      promoteInput({ targetVersion: RECORDED_VERSION }),
      async write => {
        writes.push(write);
        return { ...node, status: 'online', rolloutState: 'idle', rolloutMessage: write.rolloutMessage };
      },
    );

    assert.equal(result.status, 'succeeded');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.status, 'online');
    assert.ok((writes[0]?.rolloutMessage ?? '').includes(RECORDED_VERSION));
  });

  it('still promotes without an expected version (backward compatible)', async () => {
    const node = makeNode();
    const writes: PromoteWrite[] = [];
    const result = await simulatePromoteBranch(node, promoteInput({ reason: 'manual promote' }), async write => {
      writes.push(write);
      return { ...node, status: 'online', rolloutState: 'idle', rolloutMessage: write.rolloutMessage };
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.status, 'online');
    assert.equal(writes[0]?.rolloutMessage, `manual promote (version ${RECORDED_VERSION})`);
  });
});
