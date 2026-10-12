import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';
import { verifyJwt, getJwtSecret } from './auth-store.js';

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

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Executor heartbeats are a control-plane write, even when user auth is
    // disabled for local development. When a shared executor key is configured
    // it is the only credential accepted for this route.
    if (isExecutorHeartbeatPath(req.url, req.method) && config.executor.agentKey) {
      const bearer = extractBearerToken(req);
      if (bearer && bearer === config.executor.agentKey) return;
      return reply.code(401).send({ error: 'executor heartbeat authentication required' });
    }

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
      if (bearer && bearer === config.executor.agentKey) {
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
      if (opToken === config.auth.operatorToken) return;
    }

    // 2. JWT Bearer token (user login) — header only (avoid putting JWT in query logs)
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      const payload = verifyJwt(bearerToken, getJwtSecret());
      if (payload) return; // Valid JWT → authenticated
    }

    // 3. Static auth token (legacy): header, Bearer non-JWT, or query for WS/SSE
    const staticToken = extractAuthToken(req);
    if (config.auth.token && staticToken === config.auth.token) return;

    return reply.code(401).send({ error: 'unauthorized' });
  });
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
