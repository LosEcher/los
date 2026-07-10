import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

export function parseAllowedChatIds(value: string | undefined): ReadonlySet<number> {
  return parseAllowedIds(value, 'chat');
}

export function parseAllowedUserIds(value: string | undefined): ReadonlySet<number> {
  return parseAllowedIds(value, 'user');
}

function parseAllowedIds(value: string | undefined, kind: 'chat' | 'user'): ReadonlySet<number> {
  const chatIds = new Set<number>();
  for (const raw of value?.split(',') ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid Telegram ${kind} ID: ${trimmed}`);
    }
    const chatId = Number(trimmed);
    if (!Number.isSafeInteger(chatId) || chatId === 0 || (kind === 'user' && chatId < 0)) {
      throw new Error(`Invalid Telegram ${kind} ID: ${trimmed}`);
    }
    chatIds.add(chatId);
  }
  return chatIds;
}

export function validateWebhookSecret(secret: string | undefined): string {
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 32-256 characters using A-Z, a-z, 0-9, _ or -');
  }
  return secret;
}

export function validateWebhookUrl(value: string | undefined): string {
  if (!value) {
    throw new Error('TELEGRAM_WEBHOOK_URL is required in webhook mode');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL without credentials');
  }
  return value.replace(/\/$/, '');
}

export function webhookSecretMatches(
  provided: string | string[] | undefined,
  configured: string,
): boolean {
  const raw = Array.isArray(provided) ? provided[0] : provided;
  if (typeof raw !== 'string') return false;
  const actual = Buffer.from(raw);
  const expected = Buffer.from(configured);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isAllowedChat(chatId: unknown, allowedChatIds: ReadonlySet<number>): chatId is number {
  return typeof chatId === 'number' && allowedChatIds.has(chatId);
}

export function isAllowedUser(userId: unknown, allowedUserIds: ReadonlySet<number>): userId is number {
  return typeof userId === 'number' && allowedUserIds.has(userId);
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
): Promise<unknown> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
