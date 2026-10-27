/**
 * Provider CRUD routes — config-level provider management.
 * Extracted from provider-routes.ts to keep each file under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import { describeProviderReadiness, discoverAll, scanGrokAccount, type GrokAccountCandidate } from '@los/infra/discovery';
import { getConfig, setConfig } from '@los/infra/config';
import {
  createProviderAccount,
  listProviderAccounts,
  loadProviderAccount,
  setProviderAccountState,
  type CreateProviderAccountInput,
  type ProviderAccountRecord,
  type SetProviderAccountStateInput,
} from '@los/infra/provider-accounts';
import {
  asRecord,
  normalizeOptionalString,
  normalizeOptionalNonNegativeInteger,
} from '../server-helpers.js';
import { requireOperator } from '../../request-context.js';

const GROK_ACCOUNT_ID = 'xai-grok-default';
const GROK_SECRET_REF = 'external:grok/default';

export interface ProviderAccountRouteDependencies {
  scanGrokAccount: () => GrokAccountCandidate;
  listProviderAccounts: () => Promise<ProviderAccountRecord[]>;
  loadProviderAccount: (id: string) => Promise<ProviderAccountRecord | null>;
  createProviderAccount: (input: CreateProviderAccountInput) => Promise<ProviderAccountRecord>;
  setProviderAccountState: (input: SetProviderAccountStateInput) => Promise<ProviderAccountRecord>;
}

const DEFAULT_ACCOUNT_DEPENDENCIES: ProviderAccountRouteDependencies = {
  scanGrokAccount,
  listProviderAccounts: () => listProviderAccounts(),
  loadProviderAccount,
  createProviderAccount,
  setProviderAccountState,
};

export function registerProviderCrudRoutes(
  app: FastifyInstance,
  accountDeps: ProviderAccountRouteDependencies = DEFAULT_ACCOUNT_DEPENDENCIES,
): void {
  app.get('/providers/accounts', async () => ({
    accounts: (await accountDeps.listProviderAccounts()).map(sanitizeProviderAccount),
  }));

  app.get('/providers/accounts/discovery', async () => ({
    grok: accountDeps.scanGrokAccount(),
  }));

  app.post('/providers/accounts/grok', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const candidate = accountDeps.scanGrokAccount();
    if (!candidate.available) {
      return reply.status(404).send({
        error: 'grok_login_unavailable',
        reason: candidate.reason,
      });
    }

    const existing = await accountDeps.loadProviderAccount(GROK_ACCOUNT_ID);
    if (existing && !isGrokAccount(existing)) {
      return reply.status(409).send({
        error: 'provider_account_conflict',
        message: `${GROK_ACCOUNT_ID} is already bound to a different credential reference`,
      });
    }

    const account = existing
      ? await accountDeps.setProviderAccountState({
          id: existing.id,
          expectedCredentialGeneration: existing.credentialGeneration,
          state: 'active',
          verifiedAt: null,
        })
      : await accountDeps.createProviderAccount({
          id: GROK_ACCOUNT_ID,
          provider: 'xai',
          authMode: 'external_ref',
          displayLabel: 'Grok CLI login',
          secretRef: GROK_SECRET_REF,
          state: 'active',
          secretScope: 'external_backend',
        });

    return reply.status(existing ? 200 : 201).send({ account: sanitizeProviderAccount(account) });
  });

  app.post('/providers', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
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
    return reply.status(201).send({ ok: true, provider: toPublicProvider(name, config.providers[name]) });
  });

  app.patch('/providers/:name', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
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
    return { ok: true, provider: toPublicProvider(name, config.providers[name]) };
  });

  app.delete('/providers/:name', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
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
      hasApiKey: boolean; baseUrl?: string | null; unavailableReason?: string | null;
    }>();
    const discoveryReport = await discoverAll().catch(() => ({ providers: [] }));
    for (const dp of discoveryReport.providers) {
      if (!dp.available) continue;
      const key = `${dp.name}::${dp.defaultModel ?? '*'}`;
      if (modelSet.has(key)) continue;
      // 发现的条目**不一定可调用**，此前这里硬编码 `enabled:true, hasApiKey:false,
      // baseUrl:null` ⇒ 响应把"发现了但没有凭据/端点"的路由报成可用。
      // 2026-10-12 实测（packycode）：codex 的 `~/.codex/auth.json` 走 OAuth
      // （`auth_mode:"chatgpt"` + tokens，los 拿不到 API key），该条目被报成
      // `enabled:true / hasApiKey:false / baseUrl:null`；而同一 provider 的
      // cc-switch/grokbuild 条目是真能用的。两个条目混在一个 `models[]` 里，
      // 消费方无法区分，且 per-provider 健康探针会在两者之间摇摆
      // （`GET {baseUrl}/models`，baseUrl 为 null 时连 URL 都构造不出）。
      // 如实标注：`ready` 已经区分 api_key 与 oauth（readiness.ts:55）。
      const readiness = describeProviderReadiness(dp);
      modelSet.set(key, {
        provider: dp.name, model: dp.defaultModel ?? 'unknown', source: dp.source ?? 'discovery',
        enabled: readiness.ready,
        hasApiKey: typeof dp.apiKey === 'string' && dp.apiKey.length > 0,
        baseUrl: dp.baseUrl ?? null,
        unavailableReason: readiness.ready ? null : readiness.blocker,
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
      // 每个 entry 自带可调用性。聚合层用 OR（下面那几行）是有意的——一个 provider
      // 只要**有一条**路由可用就算可用；但 `models[]` 必须逐条如实，否则消费方
      // 看不到"这条路由为什么不可用"（packycode 的 codex 条目就是这种）。
      const modelInfo = {
        id: item.model, enabled: item.enabled, hasApiKey: item.hasApiKey,
        baseUrl: item.baseUrl ?? null, unavailableReason: item.unavailableReason ?? null,
      };
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
      models: Array<{ id: string; enabled: boolean; hasApiKey: boolean; baseUrl: string | null; unavailableReason: string | null }>;
    }>()).values()];

    return { provider: providerFilter ?? null, count: results.length, models: results, providers };
  });
}

function isGrokAccount(account: ProviderAccountRecord): boolean {
  return account.provider === 'xai'
    && account.authMode === 'external_ref'
    && account.secretRef === GROK_SECRET_REF
    && account.secretScope === 'external_backend'
    && account.nodeId === undefined;
}

function sanitizeProviderAccount(account: ProviderAccountRecord): Omit<ProviderAccountRecord, 'secretRef'> {
  const { secretRef: _secretRef, ...summary } = account;
  return summary;
}

function toPublicProvider(name: string, provider: { apiKey?: string } & Record<string, unknown>): Record<string, unknown> {
  const { apiKey, ...rest } = provider;
  return {
    name,
    ...rest,
    hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
  };
}
