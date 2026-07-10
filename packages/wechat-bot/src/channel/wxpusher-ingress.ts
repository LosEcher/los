import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger, type Logger } from '@los/infra/logger';
import type { UnifiedMessage } from './types.js';
import {
  acceptWxPusherCallback,
  claimWxPusherCallback,
  completeWxPusherCallback,
  failWxPusherCallback,
  releaseProcessingWxPusherCallback,
} from '../wxpusher-callback-store.js';

const CALLBACK_PATH = '/wxpusher-callback';
const PROXY_SECRET_HEADER = 'x-los-wxpusher-proxy-secret';
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const MIN_PROXY_SECRET_BYTES = 32;
const MIN_CALLBACK_TOKEN_BYTES = 32;
const AUTHENTICATED_WXPUSHER_MESSAGE: unique symbol = Symbol('authenticated-wxpusher-message');

interface WxPusherCallbackBody {
  action: 'send_up_cmd';
  data: {
    uid: string;
    appId: number;
    time: number;
    content: string;
  };
}

export interface WxPusherIngressConfig {
  enabled?: boolean;
  expectedAppId?: number;
  operatorUids?: readonly string[];
  proxySecret?: string;
  callbackToken?: string;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
  logger?: Pick<Logger, 'warn'>;
  onMessage: (message: UnifiedMessage) => void | Promise<void>;
}

export interface WxPusherIngress {
  enabled: boolean;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

interface WxPusherAuthentication {
  source: 'wxpusher-callback';
  appId: number;
  uid: string;
  replayKey: string;
}

const authenticatedMessages = new WeakMap<UnifiedMessage, Readonly<WxPusherAuthentication>>();

export type AuthenticatedWxPusherMessage = UnifiedMessage & {
  readonly [AUTHENTICATED_WXPUSHER_MESSAGE]: WxPusherAuthentication;
};

export function authenticatedWxPusherIdentity(
  message: UnifiedMessage,
): Readonly<WxPusherAuthentication> | null {
  const authentication = authenticatedMessages.get(message);
  if (!authentication) return null;
  if (authentication.source !== 'wxpusher-callback') return null;
  if (message.metadata.source !== authentication.source) return null;
  if (message.metadata.channel !== 'weixin' || message.routing.channel !== 'weixin') return null;
  if (message.metadata.appId !== authentication.appId) return null;
  if (message.metadata.userId !== authentication.uid) return null;
  if (message.routing.recipient !== authentication.uid) return null;
  return authentication;
}

export function createWxPusherIngress(config: WxPusherIngressConfig): WxPusherIngress {
  const enabled = config.enabled === true;
  const expectedAppId = config.expectedAppId;
  const operatorUids = new Set(config.operatorUids ?? []);
  const proxySecret = config.proxySecret ?? '';
  const callbackToken = config.callbackToken ?? '';
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxFutureSkewMs = config.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = config.now ?? Date.now;
  const logger = config.logger ?? getLogger('wxpusher-ingress');

  if (enabled) {
    if (!Number.isSafeInteger(expectedAppId) || (expectedAppId ?? 0) <= 0) {
      throw new Error('WxPusher up-call requires a positive WXPUSHER_APP_ID');
    }
    if (operatorUids.size === 0) {
      throw new Error('WxPusher up-call requires WXPUSHER_OPERATOR_UIDS');
    }
    if (Buffer.byteLength(proxySecret) < MIN_PROXY_SECRET_BYTES) {
      throw new Error(`WxPusher up-call requires WXPUSHER_CALLBACK_PROXY_SECRET with at least ${MIN_PROXY_SECRET_BYTES} bytes`);
    }
    if (Buffer.byteLength(callbackToken) < MIN_CALLBACK_TOKEN_BYTES) {
      throw new Error(`WxPusher up-call requires LOS_WXPUSHER_CALLBACK_TOKEN with at least ${MIN_CALLBACK_TOKEN_BYTES} bytes`);
    }
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000) {
      throw new Error('WxPusher callback max age must be an integer of at least 1000ms');
    }
    if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 60_000) {
      throw new Error('WxPusher callback future clock skew must be between 0 and 60000ms');
    }
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 64 * 1024) {
      throw new Error('WxPusher callback body limit must be between 1024 and 65536 bytes');
    }
  }

  return {
    enabled,
    async handle(req, res) {
      const requestUrl = parseRequestUrl(req.url);
      if (requestUrl?.pathname !== CALLBACK_PATH) return false;

      if (!enabled) {
        reject(res, 404, 'disabled', logger);
        return true;
      }
      if (req.method !== 'POST') {
        reject(res, 405, 'method_not_allowed', logger);
        return true;
      }
      if (!hasExpectedCallbackToken(requestUrl, callbackToken)) {
        reject(res, 401, 'callback_token_failed', logger);
        return true;
      }
      if (!hasExpectedSecret(req, proxySecret)) {
        reject(res, 401, 'proxy_auth_failed', logger);
        return true;
      }
      if (!isJsonRequest(req)) {
        reject(res, 415, 'content_type_invalid', logger);
        return true;
      }

      const rawBody = await readBoundedBody(req, maxBodyBytes);
      if (rawBody.status === 'too_large') {
        reject(res, 413, 'body_too_large', logger);
        return true;
      }
      if (rawBody.status === 'read_error') {
        reject(res, 400, 'body_read_failed', logger);
        return true;
      }
      if (rawBody.status !== 'ok') {
        reject(res, 400, 'body_read_failed', logger);
        return true;
      }

      const body = parseCallbackBody(rawBody.value);
      if (!body) {
        reject(res, 400, 'payload_invalid', logger);
        return true;
      }
      if (body.action !== 'send_up_cmd') {
        reject(res, 422, 'action_unsupported', logger);
        return true;
      }
      if (body.data.appId !== expectedAppId) {
        reject(res, 403, 'app_id_mismatch', logger);
        return true;
      }
      if (!operatorUids.has(body.data.uid)) {
        reject(res, 403, 'operator_uid_denied', logger);
        return true;
      }

      const receivedAt = now();
      const eventTime = normalizeEpochMs(body.data.time);
      if (
        eventTime === null
        || eventTime > receivedAt + maxFutureSkewMs
        || receivedAt >= eventTime + maxAgeMs
      ) {
        reject(res, 409, 'timestamp_out_of_window', logger);
        return true;
      }
      const expiresAt = new Date(eventTime + maxAgeMs).toISOString();

      const replayKey = callbackDigest(body);
      const leaseOwner = randomUUID();
      let claimed = false;
      try {
        claimed = await claimWxPusherCallback({
          replayKey,
          leaseOwner,
          leaseMs: Math.max(maxAgeMs, 60_000),
          expiresAt,
        });
      } catch {
        reject(res, 503, 'claim_store_failed', logger);
        return true;
      }
      if (!claimed) {
        reject(res, 409, 'replay_detected', logger);
        return true;
      }

      const message = authenticateMessage({
        id: `wx-up-${replayKey.slice(0, 20)}`,
        type: 'COMMAND',
        version: '1.0',
        text: body.data.content,
        routing: {
          priority: 'NORMAL',
          recipient: body.data.uid,
          replyTo: null,
          channel: 'weixin',
        },
        metadata: {
          timestamp: new Date(eventTime).toISOString(),
          source: 'wxpusher-callback',
          channel: 'weixin',
          userId: body.data.uid,
          appId: body.data.appId,
          tags: ['up-call'],
        },
        _internal: {
          standardizedAt: new Date(receivedAt).toISOString(),
          compressed: false,
          size: Buffer.byteLength(body.data.content),
        },
      }, {
        source: 'wxpusher-callback',
        appId: body.data.appId,
        uid: body.data.uid,
        replayKey,
      });

      try {
        const accepted = await acceptWxPusherCallback(replayKey, leaseOwner, expiresAt);
        if (!accepted) throw new Error('claim ownership lost');
      } catch {
        await releaseProcessingWxPusherCallback(replayKey, leaseOwner).catch(() => undefined);
        reject(res, 503, 'claim_accept_failed', logger);
        return true;
      }

      try {
        await config.onMessage(message);
      } catch {
        await failWxPusherCallback(replayKey, 'handler_failed').catch(() => false);
        reject(res, 503, 'handler_failed', logger);
        return true;
      }

      try {
        const completed = await completeWxPusherCallback(replayKey);
        if (!completed) throw new Error('accepted claim missing');
      } catch {
        reject(res, 503, 'claim_complete_failed', logger);
        return true;
      }

      respondJson(res, 200, { ok: true });
      return true;
    },
  };
}

function parseRequestUrl(rawUrl: string | undefined): URL | null {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function hasExpectedCallbackToken(requestUrl: URL, expected: string): boolean {
  const values = requestUrl.searchParams.getAll('token');
  return values.length === 1 && secretsEqual(values[0] ?? '', expected);
}

function hasExpectedSecret(req: IncomingMessage, expected: string): boolean {
  const value = req.headers[PROXY_SECRET_HEADER];
  if (typeof value !== 'string') return false;
  return secretsEqual(value, expected);
}

function secretsEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('application/json');
}

async function readBoundedBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<{ status: 'ok'; value: string } | { status: 'too_large' | 'read_error' }> {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    req.resume();
    return { status: 'too_large' };
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        req.resume();
        return { status: 'too_large' };
      }
      chunks.push(buffer);
    }
  } catch {
    return { status: 'read_error' };
  }
  return { status: 'ok', value: Buffer.concat(chunks).toString('utf8') };
}

function parseCallbackBody(rawBody: string): WxPusherCallbackBody | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.action !== 'string' || !isRecord(value.data)) return null;
  const data = value.data;
  if (typeof data.uid !== 'string' || data.uid.length === 0 || data.uid.length > 256) return null;
  if (!Number.isSafeInteger(data.appId) || (data.appId as number) <= 0) return null;
  if (!Number.isSafeInteger(data.time) || (data.time as number) <= 0) return null;
  if (typeof data.content !== 'string' || data.content.length === 0 || data.content.length > 40_000) return null;
  return value as unknown as WxPusherCallbackBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEpochMs(value: number): number | null {
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function callbackDigest(body: WxPusherCallbackBody): string {
  return createHash('sha256')
    .update(`${body.data.appId}\0${body.data.uid}\0${body.data.time}\0${body.data.content}`)
    .digest('hex');
}

function authenticateMessage(
  message: UnifiedMessage,
  authentication: WxPusherAuthentication,
): AuthenticatedWxPusherMessage {
  authenticatedMessages.set(message, Object.freeze(authentication));
  Object.freeze(message.routing);
  if (message.metadata.tags) Object.freeze(message.metadata.tags);
  Object.freeze(message.metadata);
  Object.freeze(message._internal);
  return Object.freeze(message) as AuthenticatedWxPusherMessage;
}

function reject(
  res: ServerResponse,
  status: number,
  reason: string,
  logger: Pick<Logger, 'warn'>,
): void {
  logger.warn('WxPusher callback rejected', { reason, status });
  respondJson(res, status, { ok: false });
}

function respondJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
