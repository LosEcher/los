/**
 * Tests for TodoHandler dispatch branch (#run / #dispatch) — verifies the
 * dispatchTodo dependency injection contract without touching the DB.
 *
 * The dispatch branch only calls deps.dispatchTodo + ctx.reply, so a mock
 * callback is sufficient; list/show/create branches (DB-backed) are covered
 * elsewhere via integration tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter } from './router.js';
import { createBuiltinHandlers } from './handlers.js';
import type { ChannelContext, NormalizerInput, RouteOptions } from './types.js';

const OPERATOR_OPTIONS: RouteOptions = {
  principal: {
    kind: 'operator',
    subject: 'test-operator',
    authenticatedBy: 'operator_token',
    capabilities: ['operator:*'],
  },
};

function buildRouter(opts: { dispatchTodo?: any } = {}) {
  const delivered: string[] = [];
  const ch: ChannelContext = {
    kind: 'direct',
    id: 'test-chan',
    send: async (text) => { delivered.push(text); return { ok: true }; },
  };
  const router = new MessageRouter({
    channels: [ch],
    defaultChannelId: 'test-chan',
    handlers: createBuiltinHandlers({ config: {} as any, dispatchTodo: opts.dispatchTodo }),
  });
  return { router, delivered };
}

describe('TodoHandler #run / #dispatch', () => {
  it('replies with not-configured when dispatchTodo is absent', async () => {
    const { router, delivered } = buildRouter(); // no dispatchTodo
    const input: NormalizerInput = {
      sourceKind: 'wx-weixin',
      text: '#run todo-los-p0-2',
    };
    const result = await router.route(input, OPERATOR_OPTIONS);
    assert.equal(result.handled, true);
    assert.equal(result.error, 'dispatch_not_configured');
    assert.ok(delivered.some(t => t.includes('not configured')));
  });

  it('dispatches via injected callback and reports task run', async () => {
    const captured: { id?: string; force?: boolean } = {};
    const dispatchTodo = async (todoId: string, o?: { force?: boolean }) => {
      captured.id = todoId;
      captured.force = o?.force;
      return {
        ok: true,
        status: 200,
        body: {
          todo: { id: todoId, sessionId: 'sess-abcdef12' },
          taskRun: { id: 'tr-12345678-aaaa', sessionId: 'sess-abcdef12' },
          schedulerStatus: 'completed',
        },
      };
    };
    const { router, delivered } = buildRouter({ dispatchTodo });

    const result = await router.route({ sourceKind: 'wx-weixin', text: '#run todo-los-p0-2' }, OPERATOR_OPTIONS);

    assert.equal(result.handled, true);
    assert.equal(captured.id, 'todo-los-p0-2');
    assert.equal(captured.force, false);
    assert.equal(result.sessionId, 'sess-abcdef12');
    assert.ok(delivered.some(t => t.includes('Dispatching')));
    assert.ok(delivered.some(t => t.includes('tr-12345'))); // taskRun.id is sliced to 8 chars
    assert.ok(delivered.some(t => t.includes('completed')));
  });

  it('passes force=true through #run <id> force', async () => {
    let forceSeen: boolean | undefined;
    const dispatchTodo = async (_id: string, o?: { force?: boolean }) => {
      forceSeen = o?.force;
      return { ok: true, status: 200, body: { taskRun: { id: 'tr-aaaaaaaa', sessionId: 's-00000000' } } };
    };
    const { router } = buildRouter({ dispatchTodo });
    await router.route({ sourceKind: 'wx-weixin', text: '#run todo-los-p0-2 force' }, OPERATOR_OPTIONS);
    assert.equal(forceSeen, true);
  });

  it('reports failure body when dispatch returns non-ok', async () => {
    const dispatchTodo = async () => ({
      ok: false,
      status: 400,
      body: { error: 'todo_not_ready', message: 'Todo status is "done"' },
    });
    const { router, delivered } = buildRouter({ dispatchTodo });
    const result = await router.route({ sourceKind: 'wx-weixin', text: '#dispatch todo-x-1234' }, OPERATOR_OPTIONS);
    assert.equal(result.handled, true);
    assert.equal(result.error, 'todo_not_ready');
    assert.ok(delivered.some(t => t.includes('Dispatch failed')));
    assert.ok(delivered.some(t => t.includes('todo_not_ready')));
  });
});
