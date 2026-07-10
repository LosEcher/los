# Telegram Ingress Security

## Required configuration

- `TELEGRAM_ALLOWED_CHAT_IDS`: comma-separated `callback_query.message.chat.id` values.
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated `callback_query.from.id` values for operators.
- `TELEGRAM_WEBHOOK_URL`: public HTTPS base URL forwarded to the bot's loopback listener.
- `TELEGRAM_WEBHOOK_SECRET`: 32-256 characters from the Telegram-supported character set.

Both chat and user must match. A member of an allowed group cannot execute an
operator action unless their individual user ID is also allowed.

To locate configured values without printing secrets, run:

```bash
rg -n '^(TELEGRAM_ALLOWED_CHAT_IDS|TELEGRAM_ALLOWED_USER_IDS|TELEGRAM_WEBHOOK_URL|TELEGRAM_WEBHOOK_PORT)=' .env
```

Obtain IDs from a trusted Telegram update: use `callback_query.message.chat.id`
for the chat and `callback_query.from.id` for the individual operator. Do not
derive operator identity from a message body field or display name.

## Secret generation and rotation

Generate a 256-bit webhook secret:

```bash
openssl rand -hex 32
```

Replace `TELEGRAM_WEBHOOK_SECRET` in the bot's environment and restart the bot.
Startup calls Telegram `setWebhook` with the new `secret_token`; requests using
the old `X-Telegram-Bot-Api-Secret-Token` are rejected immediately. Confirm the
bot is listening only on `127.0.0.1` behind the HTTPS reverse proxy.

Never log the secret, bot token, request headers, or complete update payloads.

## Replay behavior

Webhook and polling updates share an in-process atomic replay guard keyed by
both `update_id` and `callback_query.id`. Polling first calls `deleteWebhook`
with `drop_pending_updates=false`, then uses one awaited loop so requests cannot
overlap.

Callback data contains only a short random token. PostgreSQL stores the token,
target action, expiry, processing lease, and consumed state. The handler claims
the full decision group atomically and marks every approve, deny, and escalate
token for that alert as processing. All allowed chats receive tokens from the
same group, so opposite decisions cannot execute concurrently. The gateway
`x-idempotency-key` is derived from the persisted decision group, not an
individual token; if the bot crashes after the gateway accepts a decision but
before PostgreSQL records consumption, an opposite retry reuses the same key
and is rejected as a body mismatch. Successful consumption invalidates the
entire group. Pending groups survive bot restarts; an abandoned processing
claim can be reclaimed after its lease expires. Tokens and consumed records
expire after seven days and are pruned when new actions are registered.

The bot forwards verified `callback_query.from.id` as `x-user-id` for audit
metadata only. It never sends `actor` in the request body. The gateway derives
the event actor from its authenticated principal, not from Telegram headers or
body fields.
