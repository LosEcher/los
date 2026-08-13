import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { loadConfig, setConfig } from '@los/infra/config';

import { registerRequestContext } from '../../request-context.js';
import { registerTodoRoutes } from './todo-routes.js';

test('non-operator todo creation pins tenant/project to requestContext (P1-08)', async () => {
  const previousConfig = await loadConfig();
  const authConfig = {
    ...previousConfig,
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
    defaultProjectId: 'los',
  };
  setConfig(authConfig);

  let captured: { tenantId?: string; projectId?: string } = {};
  const app = Fastify({ logger: false });
  registerRequestContext(app, authConfig);
  registerTodoRoutes(app, {
    createTodo: async (input: { tenantId?: string; projectId?: string }) => {
      captured = { tenantId: input.tenantId, projectId: input.projectId };
      return { id: 'todo-stub-1', ...input } as any;
    },
    listTodos: async () => [],
    loadTodo: async () => null,
    updateTodo: async () => null,
    archiveTodo: async () => null,
    unarchiveTodo: async () => null,
    reopenTodo: async () => null,
    dispatchTodo: async () => ({ ok: true } as any),
    seedLosPlanningTodos: async () => [],
  } as any);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/todos',
      headers: { 'x-los-auth-token': 'access-token' },
      payload: {
        title: 'scope isolation todo',
        tenantId: 'evil-tenant',
        projectId: 'evil-project',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(captured, { tenantId: 'local', projectId: 'los' });
  } finally {
    setConfig(previousConfig);
    await app.close();
  }
});
