# Bot Health And Recovery

## Current State

- `packages/wechat-bot/src/index.ts` and `packages/telegram-bot/src/index.ts` reconnect to the gateway operator SSE stream after disconnects using `SSE_RECONNECT_MS`.
- WeChat serves its process health from the existing mobile Web server at `GET /health` (`WEB_PORT`, default `8899`).
- Telegram serves process health at `GET /health` (`TELEGRAM_HEALTH_PORT`, default `3002`) in both polling and webhook modes.
- A successful HTTP response proves the bot process is serving. The `ready` and `sseConnected` fields separately report whether the gateway event stream is live.

## Operator Check

Run:

```bash
bash tools/check-bot-health.sh
```

The script sources the local `.env`, checks WeChat by default, and treats Telegram as optional unless `LOS_REQUIRE_TELEGRAM_BOT=1` is set. Override endpoints with `WECHAT_BOT_HEALTH_URL` or `TELEGRAM_BOT_HEALTH_URL`.

## Failure Modes

1. `status=ok`, `ready=false`: the process is running but the gateway SSE stream is not live. Check `LOS_GATEWAY_URL`, `LOS_AUTH_TOKEN`, `LOS_OPERATOR_TOKEN`, gateway health, and bot logs. The bot retries after `SSE_RECONNECT_MS`.
2. Endpoint unavailable: the bot process is stopped, failed during configuration validation, or is listening on a different port. Check the configured port and process manager before restarting.
3. WeChat `weclawAvailable=false`: operator events can still reach configured fallback channels, but bidirectional WeClaw delivery is unavailable. Check `http://127.0.0.1:18011/health` and login state.
4. Telegram polling or webhook errors: the process stays alive and retries update polling or SSE consumption. Validate the bot token, allowed chat/user IDs, webhook secret, and webhook URL.

## Verification

```bash
pnpm --filter @los/wechat-bot test
pnpm --filter @los/telegram-bot test
bash tools/check-bot-health.sh
pnpm check
```

The check script is runtime evidence only. Package tests verify response shape and readiness transitions without requiring live Telegram or WeChat credentials.
