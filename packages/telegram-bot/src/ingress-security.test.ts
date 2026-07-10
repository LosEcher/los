import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  isAllowedChat,
  parseAllowedChatIds,
  parseAllowedUserIds,
  readJsonBody,
  RequestBodyTooLargeError,
  validateWebhookSecret,
  validateWebhookUrl,
  webhookSecretMatches,
} from './ingress-security.js';

test('parseAllowedChatIds accepts a fixed comma-separated allowlist', () => {
  const chatIds = parseAllowedChatIds('123, -100456,123');
  assert.deepEqual([...chatIds], [123, -100456]);
  assert.equal(isAllowedChat(123, chatIds), true);
  assert.equal(isAllowedChat(999, chatIds), false);
  assert.equal(isAllowedChat('123', chatIds), false);
});

test('parseAllowedUserIds accepts only preconfigured numeric user IDs', () => {
  assert.deepEqual([...parseAllowedUserIds('42,84')], [42, 84]);
  assert.throws(() => parseAllowedUserIds('operator-name'), /Invalid Telegram user ID/);
  assert.throws(() => parseAllowedUserIds('-42'), /Invalid Telegram user ID/);
});

test('parseAllowedChatIds rejects malformed and unsafe IDs', () => {
  assert.throws(() => parseAllowedChatIds('123,chat-name'), /Invalid Telegram chat ID/);
  assert.throws(() => parseAllowedChatIds('0'), /Invalid Telegram chat ID/);
  assert.throws(() => parseAllowedChatIds('9007199254740992'), /Invalid Telegram chat ID/);
});

test('webhook secret validation and comparison reject missing or mismatched values', () => {
  const secret = validateWebhookSecret('telegram_webhook_secret_1234567890');
  assert.equal(webhookSecretMatches('telegram_webhook_secret_1234567890', secret), true);
  assert.equal(webhookSecretMatches('telegram_webhook_secret_1234567891', secret), false);
  assert.equal(webhookSecretMatches(undefined, secret), false);
  assert.throws(() => validateWebhookSecret('contains spaces'), /TELEGRAM_WEBHOOK_SECRET/);
  assert.throws(() => validateWebhookSecret('short-secret'), /32-256/);
});

test('webhook URL validation requires an HTTPS URL without embedded credentials', () => {
  assert.equal(validateWebhookUrl('https://telegram.example.com/'), 'https://telegram.example.com');
  assert.throws(() => validateWebhookUrl(undefined), /TELEGRAM_WEBHOOK_URL/);
  assert.throws(() => validateWebhookUrl('http://telegram.example.com'), /HTTPS URL/);
  assert.throws(() => validateWebhookUrl('https://user:pass@telegram.example.com'), /without credentials/);
});

test('readJsonBody parses bounded bodies and rejects declared or streamed overflow', async () => {
  const valid = requestFrom([Buffer.from('{"ok":true}')]);
  assert.deepEqual(await readJsonBody(valid, 32), { ok: true });

  const declaredOverflow = requestFrom([], { 'content-length': '33' });
  await assert.rejects(readJsonBody(declaredOverflow, 32), RequestBodyTooLargeError);

  const streamedOverflow = requestFrom([Buffer.alloc(33)]);
  await assert.rejects(readJsonBody(streamedOverflow, 32), RequestBodyTooLargeError);
});

test('production entrypoint wires ingress hardening without dynamic chat authorization', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const webhookSource = readFileSync(new URL('./telegram-webhook.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /authorizedChats\.add\(/);
  assert.match(source, /createTelegramWebhookHandler\(\{ secret: WEBHOOK_SECRET!/);
  assert.match(webhookSource, /webhookSecretMatches\(request\.headers\['x-telegram-bot-api-secret-token'\]/);
  assert.match(source, /startTelegramWebhook\(\{/);
  assert.match(source, /host:\s*WEBHOOK_BIND_HOST/);
  assert.match(source, /secret:\s*WEBHOOK_SECRET!/);
});

function requestFrom(
  chunks: Buffer[],
  headers: Record<string, string> = {},
): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers }) as unknown as IncomingMessage;
}
