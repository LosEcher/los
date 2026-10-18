import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';
import { verifyJwt, getJwtSecret } from './auth-store.js';
import { getLogger } from '@los/infra/logger';

// 与本仓其它网关模块同一约定（`[tag]` 前缀才会落进 .los-runtime/gateway.log）。
// 为什么不用 app.log / req.log：2026-10-15 实测那两条路径的告警**没有落进日志文件**，
// 而「窗口开着」必须可被日志证明 —— 否则轮换窗口就成了不可审计的状态。
const log = getLogger('auth');

/**
 * 「这条请求是靠轮换窗口的上一把值通过的」标记。
 *
 * 为什么需要它（2026-10-15 实测踩到）：诊断"到底哪台节点还在用旧 key"时，
 * 我最初把 WARN 打在 `onRequest` 里 —— 那个阶段**body 还没解析**，于是心跳的
 * `nodeId` 拿不到，日志只能写「有人用旧值」，指认不了是谁，只能逐台做故障注入。
 * 现在 `onRequest` 只打标记，真正的 WARN 由 `preHandler`（body 已解析）发出。
 * 用 WeakMap 而不是挂在 `req` 上：不动 Fastify 的类型，且请求结束即可回收。
 */
interface RotationMark { label: string; credentialFingerprint?: string }
const rotationMarks = new WeakMap<FastifyRequest, RotationMark>();

/**
 * Paths that never require auth.
 * PWA shell assets are fetched by the browser without app headers, so they must
 * stay public even when LOS_AUTH_ENABLED=true (same class as / and /assets/).
 */
const EXACT_PUBLIC_PATHS = new Set([
  '/',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/icon.svg',
  '/sw.js',
]);
const PREFIX_PUBLIC_PATHS = ['/health', '/onboarding', '/api/integrations', '/assets/', '/auth/login', '/auth/register', '/auth/status'];

/** Paths that are public only for specific HTTP methods. */
const METHOD_PUBLIC_PATHS: Record<string, Set<string>> = {
  '/settings': new Set(['GET', 'HEAD', 'OPTIONS']),
};

export interface AuthMiddlewareOptions {
  config: Config;
}

export default async function authMiddleware(
  app: FastifyInstance,
  opts: AuthMiddlewareOptions,
): Promise<void> {
  const { config } = opts;

  // 凭据轮换窗口（2026-10-15）：接受"当前值 **或** 上一把"，使轮换零停机。
  // 契约与用法见 runbooks/credential-rotation-3-secrets-2026-10-15.md §2；
  // 窗口的**唯一**开关是这三个环境变量，不设即无窗口。
  // ⚠️ 三条纪律（负向控制见 auth-middleware.test.ts）：
  //   ① PREVIOUS **不能单独授权** —— 主键缺失时一律 401（否则它就变成第二把永久后门）；
  //   ② 每次走到 PREVIOUS 都告警，窗口开着这件事必须可被日志证明；
  //   ③ 启动时若有窗口，WARN 一次，让人知道"现在有两把有效"。
  const previous = rotationPreviousTokens();
  const openWindows = Object.entries(previous).filter(([, v]) => v).map(([k]) => k);
  if (openWindows.length) {
    log.warn(`credential rotation window OPEN — accepted previous tokens: ${openWindows.join(', ')}; unset to close`);
  }
  const accept = (
    req: FastifyRequest,
    candidate: string | undefined,
    current: string | undefined,
    prev: string | undefined,
    label: string,
  ): boolean => {
    if (!_tokenAccepted(candidate, current, prev)) return false;
    if (prev && candidate === prev) {
      // 只打标记，真正的告警留给 preHandler（那时 body 已解析，能拿到 nodeId）。
      // 实测：心跳不带 x-los-node-id，nodeId 只在 body 里，而 onRequest 早于 body 解析。
      rotationMarks.set(req, {
        label,
        credentialFingerprint: fingerprintNodeCredential(req),
      });
    }
    return true;
  };

  // 轮换窗口的**可指认**告警：此时 body 已解析，能写出是哪台节点。
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const mark = rotationMarks.get(req);
    if (!mark) return;
    rotationMarks.delete(req);
    const body = req.body as Record<string, unknown> | undefined;
    const nodeId = body?.nodeId ?? body?.node_id ?? body?.id;
    const who = [
      nodeId ? `node=${String(nodeId)}` : undefined,
      mark.credentialFingerprint ? `credential_fp=${mark.credentialFingerprint}` : undefined,
    ].filter(Boolean).join(' ');
    log.warn(`${mark.label} accepted on ${req.url}${who ? ` (${who})` : ''} (rotation window open)`);
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Executor heartbeats are a control-plane write, even when user auth is
    // disabled for local development. When a shared executor key is configured
    // it is the only credential accepted for this route.
    if (isExecutorHeartbeatPath(req.url, req.method) && config.executor.agentKey) {
      const bearer = extractBearerToken(req);
      if (accept(req, bearer, config.executor.agentKey, previous.executor, 'EXECUTOR_AGENT_KEY_PREVIOUS')) return;
      return reply.code(401).send({ error: 'executor heartbeat authentication required' });
    }

    // Task-token-authenticated endpoint (C.2): the handler verifies
    // `x-los-task-token` itself and must do so with auth both on and off.
    // Skip only the generic auth chain here — never the handler's own check,
    // which is the single source of truth for expiry/scope (no shared-key fallback).
    if (_isTaskHeartbeatPath(req.url, req.method)) return;

    // Executor model route (2026-10-11): an executor may reach the OpenAI-compatible
    // surface with the key it **already has** for the dispatch channel, so a remote
    // node needs no provider credential of its own — the gateway holds them and
    // forwards the completion upstream with its own credentials.
    //
    // 与 heartbeat 分支的两处刻意不同：
    //  - **不匹配时不 401，而是继续走正常鉴权链**：同一条路径上还有浏览器/DSH 用
    //    `LOS_AUTH_TOKEN` 的调用方，把这条分支写成"唯一凭据"会把它们全部打断。
    //  - **作用域只有 `/v1/`**：实测 `/v1` 下只有 `GET /v1/models` 与
    //    `POST /v1/chat/completions`（见 route-admission-inventory），因此这把密钥
    //    不会因为本改动而多解锁任何别的路径。负向控制由 auth-middleware.test.ts 守。
    if (_isExecutorModelPath(req.url) && config.executor.agentKey) {
      const bearer = extractBearerToken(req);
      if (accept(req, bearer, config.executor.agentKey, previous.executor, 'EXECUTOR_AGENT_KEY_PREVIOUS')) {
        const nodeId = req.headers['x-los-node-id'];
        req.log?.info?.({
          nodeId: Array.isArray(nodeId) ? nodeId[0] : nodeId,
          path: req.url,
        }, 'executor model route authorized');
        return;
      }
    }

    if (!config.auth.enabled) return;

    if (isPublicPath(req.url, req.method)) return;

    // 1. Operator token (strongest auth path): header or query (browser WS/SSE)
    if (config.auth.operatorToken) {
      const opToken = extractOperatorToken(req);
      if (accept(req, opToken, config.auth.operatorToken, previous.operator, 'LOS_OPERATOR_TOKEN_PREVIOUS')) return;
    }

    // 2. JWT Bearer token (user login) — header only (avoid putting JWT in query logs)
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      const payload = verifyJwt(bearerToken, getJwtSecret());
      if (payload) return; // Valid JWT → authenticated
    }

    // 3. Static auth token (legacy): header, Bearer non-JWT, or query for WS/SSE
    const staticToken = extractAuthToken(req);
    if (accept(req, staticToken, config.auth.token, previous.auth, 'LOS_AUTH_TOKEN_PREVIOUS')) return;

    return reply.code(401).send({ error: 'unauthorized' });
  });
}

/**
 * 轮换窗口的判定：候选值等于**当前值**，或在窗口内等于**上一把**。
 *
 * ⚠️ `current` 缺失（未配置）时一律 false —— PREVIOUS **不能单独授权**。
 * 这条不是风格：若允许"只给 PREVIOUS"，这个机制就从"轮换窗口"退化成"第二把永久后门"，
 * 而后者在审计上等价于把密钥长期翻倍。负向控制写在 auth-middleware.test.ts。
 */
export function _tokenAccepted(
  candidate: string | undefined,
  current: string | undefined,
  previous: string | undefined,
): boolean {
  if (!candidate || !current) return false;
  if (candidate === current) return true;
  return Boolean(previous) && candidate === previous;
}

/**
 * `x-los-node-credential` 的指纹（sha256 前 8 位十六进制）。
 * **只打指纹不打值**：它是每台节点一份的凭据，写进日志就等于又造一处明文面。
 * 用途只有一个 —— 当 body 里没有 nodeId 时，仍能把"是谁"缩小到一台。
 */
function fingerprintNodeCredential(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-los-node-credential'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return createHash('sha256').update(value.trim()).digest('hex').slice(0, 8);
}

/** 轮换窗口用的上一把值（只从环境读；不设即无窗口）。 */
function rotationPreviousTokens(): { auth?: string; operator?: string; executor?: string } {
  const pick = (key: string): string | undefined => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  return {
    auth: pick('LOS_AUTH_TOKEN_PREVIOUS'),
    operator: pick('LOS_OPERATOR_TOKEN_PREVIOUS'),
    executor: pick('EXECUTOR_AGENT_KEY_PREVIOUS'),
  };
}

/** Extract Bearer token from Authorization header (JWT). */
function extractBearerToken(req: FastifyRequest): string | undefined {
  const authorization = req.headers.authorization;
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authValue !== 'string') return undefined;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/** Resolve auth token from los header, Bearer scheme, or query (browser WS/SSE). */
function extractAuthToken(req: FastifyRequest): string | undefined {
  const headerToken = req.headers['x-los-auth-token'];
  const fromHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();

  // Only treat as static token if it doesn't look like a JWT (3 dot-separated parts)
  const bearer = extractBearerToken(req);
  if (bearer && !bearer.includes('.')) return bearer;

  // Browser WebSocket / EventSource cannot set custom headers — accept query tokens.
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.access_token ?? query?.token;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();

  return undefined;
}

function extractOperatorToken(req: FastifyRequest): string | undefined {
  const headerToken = req.headers['x-los-operator-token'];
  const fromHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();

  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.operator_token;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();

  return undefined;
}

function isPublicPath(url: string | undefined, method: string): boolean {
  if (!url) return false;
  const path = url.split('?')[0] || url;
  if (EXACT_PUBLIC_PATHS.has(path)) return true;
  const methods = METHOD_PUBLIC_PATHS[path];
  if (methods && methods.has(method)) return true;
  if (PREFIX_PUBLIC_PATHS.some(p => path.startsWith(p))) return true;
  return false;
}

function isExecutorHeartbeatPath(url: string | undefined, method: string): boolean {
  if (method !== 'POST' || !url) return false;
  return (url.split('?')[0] || url) === '/nodes/heartbeat';
}

/**
 * `POST /tasks/:id/heartbeat` — 任务令牌自证端点。
 *
 * 与 `/nodes/heartbeat` 的区别：那条用**共享** agent key，这条用**单个 task run** 的
 * 短时令牌，且验证发生在 handler（`task-routes.ts`）而不是中间件——因为中间件跑在
 * body/params 解析之前，拿不到 `:id` 与令牌 claim 做绑定比对。
 */
export function _isTaskHeartbeatPath(url: string | undefined, method: string): boolean {
  if (method !== 'POST' || !url) return false;
  return /^\/tasks\/[^/]+\/heartbeat$/.test(url.split('?')[0] || url);
}

/**
 * Executor-reachable model surface: exactly the OpenAI-compatible routes.
 *
 * 收窄到这两条而不是整个 `/v1/` 前缀：路由面是会长的，前缀匹配会在**将来**某个
 * 新 `/v1/...` 路由出现时静默扩大这把密钥的作用域。负向控制（这把密钥打不开
 * `/runs`、`/sessions`、`/chat`）写在 `auth-middleware.test.ts`。
 */
export function _isExecutorModelPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0] || url;
  return path === '/v1/models' || path === '/v1/chat/completions';
}
