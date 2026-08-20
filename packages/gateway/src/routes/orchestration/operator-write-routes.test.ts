import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { loadConfig, setConfig, type Config } from '@los/infra/config';
import authMiddleware from '../../auth-middleware.js';
import { registerRequestContext } from '../../request-context.js';
import { registerRunRoutes } from './run-routes.js';
import { registerRuntimeAdapterRoutes } from './runtime-adapter-routes.js';
import { registerGovernanceRoutes } from '../infrastructure/governance-routes.js';
import { registerProviderEvidenceRoutes } from '../providers/provider-evidence-routes.js';
import { registerProviderCrudRoutes } from '../providers/provider-crud-routes.js';
import { registerSessionRoutes } from '../data/session-routes.js';
import { registerTodoRoutes } from '../data/todo-routes.js';
import { registerMCPRoutes } from '../tools/mcp-routes.js';
import { registerNodeCommandRoutes } from './node-command-routes.js';
import { registerFileSyncRoutes } from '../infrastructure/file-sync-routes.js';
import { registerChatRoute } from '../../chat-route.js';
import { registerProjectRoutes } from '../infrastructure/project-routes.js';

function config(): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
    integrations: { feedAnalysis: {
      resultReturningEnabled: true, maxInlineBytes: 1048576, maxItems: 500,
      materialHosts: [], materialFetchTimeoutMs: 10000, executionTimeoutMs: 120000, callbackPollMs: 5000, callbackProfiles: {},
    } },
    agent: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      maxLoops: 20,
      sandboxMode: 'workspace-write',
      sandboxNetwork: 'isolated',
      windowsSandboxBackend: 'acl',
      allowNativeShell: false,
      identity: { name: 'default', inheritForChildren: false },
      skills: { runtimeEnabled: true, autoInject: false, maxAutoSkills: 3, maxSkillTokens: 2500 },
      rules: { operatorInject: true, enforcementEnabled: true, maxPromptRules: 20 },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    providerFallbacks: {},
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
      persistChatDefault: true,
      selfReflectionEnabled: false,
      codeGraph: {
        enabled: false,
        shadowMode: false,
        injectArchitecture: false,
        cbmCommand: 'codebase-memory-mcp',
        cbmArgs: [],
        maxPromptTokens: 400,
      },
    },
    executor: { enabled: false, host: '127.0.0.1', port: 8090, shutdownGraceMs: 120_000, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

test('ordinary access token cannot invoke operator write routes', async () => {
  const previousConfig = await loadConfig();
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);
  await authMiddleware(app, { config: effectiveConfig });
  registerRunRoutes(app);
  registerRuntimeAdapterRoutes(app);
  registerGovernanceRoutes(app);
  registerProviderEvidenceRoutes(app);
  registerProviderCrudRoutes(app);
  registerSessionRoutes(app);
  registerTodoRoutes(app);
  registerMCPRoutes(app);
  registerNodeCommandRoutes(app);
  registerFileSyncRoutes(app, {});
  registerChatRoute(app, effectiveConfig, process.cwd());
  registerProjectRoutes(app);

  try {
    const requests: Array<{ method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: Record<string, unknown> }> = [
      { url: '/runs/run-test/recover', payload: {} },
      { url: '/runs/run-test/answer', payload: {} },
      { url: '/runs/run-test/verify', payload: {} },
      { url: '/runs/run-test/approve', payload: {} },
      { url: '/runs/run-test/revise-plan', payload: {} },
      { url: '/runtimes/codex/run', payload: { prompt: 'test' } },
      { url: '/runtimes/grok/run', payload: { prompt: 'test' } },
      { url: '/runtimes/bridge/start', payload: {} },
      { url: '/governance/jobs/sweep', payload: {} },
      { url: '/providers/promotion-decisions', payload: { action: 'promote_required' } },
      { url: '/providers/promotion-decisions/enforce', payload: { id: 'decision-test' } },
      { url: '/providers/accounts/grok', payload: {} },
      { url: '/providers', payload: { name: 'attacker', apiKey: 'sk-secret' } },
      { method: 'PATCH', url: '/providers/deepseek', payload: { apiKey: 'sk-stolen' } },
      { method: 'DELETE', url: '/providers/deepseek' },
      { url: '/sessions/session-test/operator-events', payload: { type: 'steering', instruction: 'approve' } },
      { url: '/todos/seed', payload: { overwrite: true } },
      { url: '/todos/todo-test/dispatch', payload: { toolMode: 'all', workspaceRoot: '/' } },
      { url: '/mcp-servers/inspect', payload: { id: 'x', transport: 'stdio', command: '/bin/sh' } },
      { url: '/mcp-servers', payload: { id: 'x', transport: 'stdio', command: '/bin/sh', inspectedVersionHash: 'vh' } },
      { url: '/mcp-servers/x/enable', payload: { enabled: true } },
      { url: '/mcp-servers/x/verify', payload: {} },
      { method: 'DELETE', url: '/mcp-servers/x' },
      { url: '/nodes/node-test/commands', payload: { command: 'drain' } },
      { url: '/file-sync/scan', payload: { nodeId: 'node-test', path: '/' } },
      { url: '/chat', payload: { prompt: 'x', mcpServers: [{ command: '/bin/sh', args: ['-c', 'id'] }] } },
      { url: '/chat', payload: { prompt: 'x', toolMode: 'all' } },
      { url: '/chat', payload: { prompt: 'x', sandboxMode: 'sandbox' } },
      { url: '/chat', payload: { prompt: 'x', allowedTools: ['run_shell'] } },
      { url: '/chat', payload: { prompt: 'x', workspaceRoot: '/' } },
      { method: 'GET', url: '/projects/browse?path=/' },
      { url: '/projects/bind', payload: { workspacePath: '/' } },
      { method: 'DELETE', url: '/projects/los' },
      { url: '/projects/default', payload: { projectId: 'los' } },
      { url: '/projects/validate', payload: { workspacePath: '/' } },
    ];
    for (const request of requests) {
      const response = await app.inject({
        method: request.method ?? 'POST',
        url: request.url,
        headers: { 'x-los-auth-token': 'access-token' },
        payload: request.payload,
      });
      assert.equal(response.statusCode, 403, `${request.method ?? 'POST'} ${request.url}`);
      assert.deepEqual(response.json(), { error: 'operator token required' }, request.url);
    }
  } finally {
    setConfig(previousConfig);
    await app.close();
  }
});
