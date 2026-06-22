/**
 * Provider CRUD routes — config-level provider management.
 * Extracted from provider-routes.ts to keep each file under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import { discoverAll } from '@los/infra/discovery';
import { getConfig, setConfig } from '@los/infra/config';
import {
  asRecord,
  normalizeOptionalString,
  normalizeOptionalNonNegativeInteger,
} from '../server-helpers.js';

export function registerProviderCrudRoutes(app: FastifyInstance): void {
  app.post('/providers', async (req, reply) => {
    const body = asRecord(req.body);
    const name = (typeof body.name === 'string' ? body.name.trim() : '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) {
      return reply.status(422).send({ error: 'name is required and must contain at least one alphanumeric character' });
    }
    const config = getConfig();
    if (config.providers[name]) {
      return reply.status(409).send({ error: `Provider "${name}" already exists` });
    }
    const provider: Record<string, unknown> = { enabled: true, weight: 100, source: 'manual' };
    if (body.apiKey !== undefined) provider.apiKey = normalizeOptionalString(body.apiKey);
    if (body.baseUrl !== undefined) provider.baseUrl = normalizeOptionalString(body.baseUrl);
    if (body.model !== undefined) provider.model = normalizeOptionalString(body.model);
    if (typeof body.enabled === 'boolean') provider.enabled = body.enabled;
    if (body.weight !== undefined) provider.weight = normalizeOptionalNonNegativeInteger(body.weight);
    if (body.apiShape !== undefined) provider.apiShape = normalizeOptionalString(body.apiShape);
    config.providers[name] = provider as typeof config.providers[string];
    setConfig(config);
    return reply.status(201).send({ ok: true, provider: { name, ...config.providers[name] } });
  });

  app.patch('/providers/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = asRecord(req.body);
    const config = getConfig();
    if (!config.providers[name]) {
      return reply.status(404).send({ error: `Provider "${name}" not found in config` });
    }
    const updates: Record<string, unknown> = {};
    if (body.model !== undefined) updates.model = normalizeOptionalString(body.model);
    if (body.apiKey !== undefined) updates.apiKey = normalizeOptionalString(body.apiKey);
    if (body.baseUrl !== undefined) updates.baseUrl = normalizeOptionalString(body.baseUrl);
    if (body.weight !== undefined) updates.weight = normalizeOptionalNonNegativeInteger(body.weight);
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;

    config.providers[name] = { ...config.providers[name], ...updates };
    setConfig(config);
    return { ok: true, provider: { name, ...config.providers[name] } };
  });

  app.delete('/providers/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const config = getConfig();
    if (!config.providers[name]) {
      return reply.status(404).send({ error: `Provider "${name}" not found in config` });
    }
    delete config.providers[name];
    setConfig(config);
    return { ok: true, removed: name };
  });

  app.get('/providers/models', async (req) => {
    const query = req.query as { provider?: string; model?: string; q?: string };
    const providerFilter = normalizeOptionalString(query.provider);
    const modelFilter = normalizeOptionalString(query.model);
    const search = normalizeOptionalString(query.q);
    const config = getConfig();
    const modelSet = new Map<string, {
      provider: string; model: string; source: string; enabled: boolean;
      hasApiKey: boolean; baseUrl?: string | null;
    }>();
    const discoveryReport = await discoverAll().catch(() => ({ providers: [] }));
    for (const dp of discoveryReport.providers) {
      if (!dp.available) continue;
      const key = `${dp.name}::${dp.defaultModel ?? '*'}`;
      if (modelSet.has(key)) continue;
      modelSet.set(key, {
        provider: dp.name, model: dp.defaultModel ?? 'unknown', source: dp.source ?? 'discovery',
        enabled: true, hasApiKey: false, baseUrl: null,
      });
    }
    for (const [name, p] of Object.entries(config.providers)) {
      const model = p.model ?? 'default';
      const key = `${name}::${model}`;
      modelSet.set(key, {
        provider: name, model,
        source: p.source ?? 'config', enabled: p.enabled ?? false,
        hasApiKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
        baseUrl: p.baseUrl ?? null,
      });
    }
    let results = [...modelSet.values()];
    if (providerFilter) results = results.filter(r => r.provider === providerFilter);
    if (modelFilter) results = results.filter(r => r.model === modelFilter);
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(r => r.provider.toLowerCase().includes(s) || r.model.toLowerCase().includes(s));
    }
    const providers = [...results.reduce((map, item) => {
      const existing = map.get(item.provider);
      const modelInfo = { id: item.model };
      if (existing) {
        if (!existing.models.some(m => m.id === item.model)) existing.models.push(modelInfo);
        existing.count = existing.models.length;
        existing.ok = existing.ok || item.enabled;
        existing.enabled = existing.enabled || item.enabled;
        existing.hasApiKey = existing.hasApiKey || item.hasApiKey;
        existing.source = existing.source ?? item.source;
        existing.baseUrl = existing.baseUrl ?? item.baseUrl ?? null;
        return map;
      }
      map.set(item.provider, {
        provider: item.provider, ok: item.enabled, enabled: item.enabled,
        hasApiKey: item.hasApiKey, source: item.source, model: item.model,
        baseUrl: item.baseUrl ?? null, count: 1, models: [modelInfo],
      });
      return map;
    }, new Map<string, {
      provider: string; ok: boolean; enabled: boolean; hasApiKey: boolean;
      source: string; model: string; baseUrl: string | null; count: number;
      models: Array<{ id: string }>;
    }>()).values()];

    return { provider: providerFilter ?? null, count: results.length, models: results, providers };
  });
}
