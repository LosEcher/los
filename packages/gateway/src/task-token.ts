/**
 * 任务级短时令牌（C.2 第一步：mint / verify）。
 *
 * 设计意图见 `dsfolder/LOS-CAPABILITY-ENFORCEMENT-AND-TRACE-EQUIVALENCE-DESIGN-2026-10-18.md` §C：
 * 执行器不再把**共享** `EXECUTOR_AGENT_KEY` 交给被派生的 agent，而是由网关为**某一个
 * task run** 签一段短时令牌，令牌自带 `taskRunId` + `leaseVersion` 边界。
 *
 * 契约（刻意保持最小、可离线验证）：
 *
 *   lst1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, "lst1.<payload>"))>
 *   payload = {"tid":"<taskRunId>","lv":<leaseVersion>,"exp":<unix-seconds>}
 *
 * 三条判据：
 *   · **只对签发时的 task run 有效** —— `tid` 与路径不一致即拒（C2 的 scope 一半）；
 *   · **只对签发时的 lease 代次有效** —— `lv` 进入 heartbeat 的 SQL fence，
 *     换代后旧令牌自然失效（C2 的另一半，由 `heartbeatTaskRun` 保证）；
 *   · **过期即拒，且不回退到共享密钥** —— handler 里没有"验不过就放行"的分支（C1）。
 *
 * 为什么把版本写进签名输入：将来要改 payload 形状时可以并存 `lst2`，而不是靠"解析失败
 * 就试试旧格式"的兼容分支——那种分支会让"过期/伪造"与"旧格式"不可区分。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const TASK_TOKEN_VERSION = 'lst1';
const TASK_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
const TASK_TOKEN_MIN_TTL_SECONDS = 60;
const TASK_TOKEN_MAX_TTL_SECONDS = 60 * 60;

export interface TaskTokenClaims {
  taskRunId: string;
  leaseVersion: number;
  /** Unix epoch seconds. */
  expiresAt: number;
}

export type TaskTokenFailure =
  | 'not_configured'
  | 'malformed'
  | 'unsupported_version'
  | 'bad_signature'
  | 'expired';

export type TaskTokenVerification =
  | { ok: true; claims: TaskTokenClaims }
  | { ok: false; reason: TaskTokenFailure };

export interface MintTaskTokenInput {
  taskRunId: string;
  leaseVersion: number;
  secret: string;
  /** Defaults to 1 hour; clamped to [60s, 1h]. */
  ttlSeconds?: number;
  /** Injection point for tests (unix seconds). */
  now?: number;
}

export interface MintedTaskToken {
  token: string;
  claims: TaskTokenClaims;
}

export function mintTaskToken(input: MintTaskTokenInput): MintedTaskToken {
  const taskRunId = input.taskRunId.trim();
  if (!taskRunId) throw new Error('taskRunId is required');
  if (!Number.isInteger(input.leaseVersion) || input.leaseVersion < 0) {
    throw new Error('leaseVersion must be a non-negative integer');
  }
  if (!input.secret) throw new Error('task token secret is not configured');

  const ttl = clampTtl(input.ttlSeconds);
  const now = input.now ?? nowSeconds();
  const claims: TaskTokenClaims = {
    taskRunId,
    leaseVersion: input.leaseVersion,
    expiresAt: now + ttl,
  };
  const payload = Buffer.from(
    JSON.stringify({ tid: claims.taskRunId, lv: claims.leaseVersion, exp: claims.expiresAt }),
    'utf8',
  ).toString('base64url');
  const signingInput = `${TASK_TOKEN_VERSION}.${payload}`;
  const signature = sign(signingInput, input.secret);
  return { token: `${signingInput}.${signature}`, claims };
}

export function verifyTaskToken(
  token: string | undefined,
  secret: string | undefined,
  opts: { now?: number } = {},
): TaskTokenVerification {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!token) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, payload, signature] = parts;
  if (version !== TASK_TOKEN_VERSION) return { ok: false, reason: 'unsupported_version' };
  if (!payload || !signature) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(sign(signatureInput(version, payload), secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  // Length check first: `timingSafeEqual` throws on length mismatch.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const claims = decodeClaims(payload);
  if (!claims) return { ok: false, reason: 'malformed' };

  const now = opts.now ?? nowSeconds();
  if (claims.expiresAt <= now) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}

/** `exp` 是秒；同一秒内签出的令牌可重复验证（幂等，便于测试与重试）。 */
export function taskTokenExpiresAtIso(expiresAt: number): string {
  return new Date(expiresAt * 1000).toISOString();
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

function signatureInput(version: string, payload: string): string {
  return `${version}.${payload}`;
}

function decodeClaims(payload: string): TaskTokenClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { tid, lv, exp } = parsed as { tid?: unknown; lv?: unknown; exp?: unknown };
  if (typeof tid !== 'string' || !tid.trim()) return null;
  if (typeof lv !== 'number' || !Number.isInteger(lv) || lv < 0) return null;
  if (typeof exp !== 'number' || !Number.isInteger(exp)) return null;
  return { taskRunId: tid, leaseVersion: lv, expiresAt: exp };
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return TASK_TOKEN_DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds)) return TASK_TOKEN_DEFAULT_TTL_SECONDS;
  return Math.min(
    TASK_TOKEN_MAX_TTL_SECONDS,
    Math.max(TASK_TOKEN_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
