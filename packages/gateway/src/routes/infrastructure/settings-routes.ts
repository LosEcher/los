import type { FastifyInstance } from 'fastify';
import { getConfig, setConfig, type Config } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import { requireOperator } from '../../request-context.js';

const log = getLogger('settings-routes');

export function _buildSettingsResponse(
  config: Config,
  includeSensitive: boolean,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    defaultProjectId: config.defaultProjectId,
    auth: { enabled: config.auth.enabled },
    agent: {
      defaultProvider: config.agent.defaultProvider,
      defaultModel: config.agent.defaultModel,
      maxLoops: config.agent.maxLoops,
      sandboxMode: config.agent.sandboxMode,
      identity: {
        name: config.agent.identity.name,
        level: config.agent.identity.level ?? null,
        inheritForChildren: config.agent.identity.inheritForChildren,
      },
    },
    judge: {
      provider: config.judge.provider ?? null,
      model: config.judge.model ?? null,
    },
    review: {
      enabled: config.review.enabled,
      roles: Object.fromEntries(
        Object.entries(config.review.roles).map(([name, role]) => [name, {
          provider: role.provider ?? null,
          model: role.model ?? null,
          blockingSeverity: role.blockingSeverity,
          enabled: role.enabled,
        }]),
      ),
    },
    memory: {
      ftsEnabled: config.memory.ftsEnabled,
      maxObservations: config.memory.maxObservations,
      selfReflectionEnabled: config.memory.selfReflectionEnabled,
    },
    executor: { enabled: config.executor.enabled },
    providers: Object.entries(config.providers).map(([name, provider]) => ({
      name,
      enabled: provider.enabled ?? false,
      hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
      model: provider.model ?? null,
      weight: provider.weight ?? null,
    })),
  };

  if (!includeSensitive) return response;

  response.server = {
    port: config.server.port,
    host: config.server.host,
    corsOrigin: config.server.corsOrigin,
  };
  response.agent = {
    ...(response.agent as Record<string, unknown>),
    systemPrompt: config.agent.systemPrompt ?? null,
  };
  response.judge = {
    ...(response.judge as Record<string, unknown>),
    systemPrompt: config.judge.systemPrompt ?? null,
  };
  response.review = {
    enabled: config.review.enabled,
    roles: Object.fromEntries(
      Object.entries(config.review.roles).map(([name, role]) => [name, {
        provider: role.provider ?? null,
        model: role.model ?? null,
        systemPrompt: role.systemPrompt ?? null,
        blockingSeverity: role.blockingSeverity,
        enabled: role.enabled,
      }]),
    ),
  };
  response.executor = {
    enabled: config.executor.enabled,
    nodeId: config.executor.nodeId,
    nodeUrl: config.executor.nodeUrl,
    connectModes: config.executor.connectModes,
    meshNodes: config.executor.meshNodes,
    meshNodeCount: config.executor.meshNodes.length,
  };
  return response;
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/settings', async () => _buildSettingsResponse(getConfig(), false));

  app.get('/settings/private', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    return _buildSettingsResponse(getConfig(), true);
  });

  app.patch('/settings', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }
    const current = getConfig();
    const merged = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (
        value && typeof value === 'object' && !Array.isArray(value)
        && key in merged && merged[key] && typeof merged[key] === 'object'
      ) {
        merged[key] = {
          ...(merged[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      }
    }
    setConfig(merged as Config);
    log.info('Settings updated via PATCH');
    return { ok: true };
  });
}
