/**
 * Provider model sync routes — pull the remote model catalog for a provider
 * through its OpenAI-compatible `/models` endpoint, then optionally apply a
 * model to the provider config.
 *
 * Credentials resolve in this order:
 *   1. `config.providers[name].apiKey` (explicit key)
 *   2. OAuth resolver for `xai` (Grok subscription) and `kimi` (Kimi Code
 *      subscription) when `authMode === 'oauth'`
 */
import type { FastifyInstance } from 'fastify';
import { resolveKimiCodeCredential, resolveXaiOAuthCredential } from '@los/agent';
import { getConfig, setConfig } from '@los/infra/config';
import { requireProviderDefaults } from '@los/infra/provider-defaults';
import { fetchWithConfiguredProxy } from '@los/agent/auth/proxy-fetch';
import { asRecord, normalizeOptionalString } from '../server-helpers.js';
import { requireOperator } from '../../request-context.js';

export interface ProviderModelSyncDependencies {
  fetchJson: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>;
  resolveOAuthCredential: (provider: string) => Promise<{ apiKey: string; baseUrl: string }>;
}

const DEFAULT_SYNC_DEPENDENCIES: ProviderModelSyncDependencies = {
  fetchJson: async (url, init) => {
    const response = await fetchWithConfiguredProxy(url, init);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  },
  resolveOAuthCredential: (provider) => {
    if (provider === 'xai') return resolveXaiOAuthCredential();
    if (provider === 'kimi') return resolveKimiCodeCredential();
    throw new Error(`Provider '${provider}' has no OAuth credential resolver.`);
  },
};

export function registerProviderModelSyncRoutes(
  app: FastifyInstance,
  deps: ProviderModelSyncDependencies = DEFAULT_SYNC_DEPENDENCIES,
): void {
  app.post('/providers/:name/models/sync', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;

    const { name } = req.params as { name: string };
    const reqBody = asRecord(req.body);
    const applyModel = normalizeOptionalString(reqBody?.applyModel);

    const config = getConfig();
    const providerConfig = config.providers[name];
    if (!providerConfig || !providerConfig.enabled) {
      return reply.status(404).send({
        error: `Provider "${name}" not found or disabled in config`,
      });
    }

    // Resolve credential: explicit apiKey wins; OAuth class falls back to the
    // per-provider subscription resolver.
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    if (typeof providerConfig.apiKey === 'string' && providerConfig.apiKey.length > 0) {
      apiKey = providerConfig.apiKey;
    } else if ((providerConfig as Record<string, unknown>).authMode === 'oauth') {
      try {
        const credential = await deps.resolveOAuthCredential(name);
        apiKey = credential.apiKey;
        baseUrl = credential.baseUrl;
      } catch (error) {
        return reply.status(502).send({
          error: `oauth_credential_unavailable`,
          detail: (error as Error).message,
        });
      }
    }
    if (!apiKey) {
      return reply.status(400).send({
        error: `Provider "${name}" has no API key and no supported OAuth credential.`,
      });
    }

    const effectiveBaseUrl = baseUrl
      ?? providerConfig.baseUrl
      ?? requireProviderDefaults(name)?.baseUrl;
    if (!effectiveBaseUrl) {
      return reply.status(400).send({
        error: `Provider "${name}" has no baseUrl configured.`,
      });
    }
    const modelsUrl = `${effectiveBaseUrl.replace(/\/+$/, '')}/models`;

    const { status, body } = await deps.fetchJson(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (status !== 200 || !body || typeof body !== 'object') {
      return reply.status(status >= 500 ? 502 : 400).send({
        error: `remote_models_fetch_failed`,
        status,
        detail: typeof body === 'object' && body !== null
          ? JSON.stringify(body).slice(0, 500)
          : null,
      });
    }

    const data = (body as { data?: unknown }).data;
    const modelIds = Array.isArray(data)
      ? data
          .map(item => (item && typeof item === 'object' && 'id' in item
            ? String((item as { id: unknown }).id)
            : null))
          .filter((id): id is string => !!id && id.length > 0)
      : [];

    let applied = false;
    let appliedModel: string | undefined;
    if (applyModel) {
      if (!modelIds.includes(applyModel)) {
        return reply.status(422).send({
          error: `model_not_in_catalog`,
          model: applyModel,
          available: modelIds,
        });
      }
      config.providers[name] = {
        ...providerConfig,
        model: applyModel,
      };
      setConfig(config);
      applied = true;
      appliedModel = applyModel;
    }

    return {
      provider: name,
      baseUrl: effectiveBaseUrl,
      count: modelIds.length,
      models: modelIds.map(id => ({ id })),
      applied,
      appliedModel: appliedModel ?? null,
    };
  });
}
