# Bot Health And Recovery

## Current State

- `tools/los.sh` is the canonical local lifecycle and status entrypoint for
  gateway, executor, WeChat, and Telegram processes.
- `LOS_WECHAT_BOT_MODE` and `LOS_TELEGRAM_BOT_MODE` accept `disabled`,
  `optional`, or `required`. Both default to `disabled`.
- Managed channel startup validates required credentials and allowlists before
  spawning a process. Missing configuration never falls through to a partial
  bot process.
- `packages/wechat-bot/src/index.ts` and `packages/telegram-bot/src/index.ts` reconnect to the gateway operator SSE stream after disconnects using `SSE_RECONNECT_MS`.
- WeChat serves its process health from the existing mobile Web server at `GET /health` (`WEB_PORT`, default `8899`).
- Telegram serves process health at `GET /health` (`TELEGRAM_HEALTH_PORT`, default `3002`) in both polling and webhook modes.
- A successful HTTP response proves the bot process is serving. `ready` also
  requires the gateway event stream plus an external delivery path:
  `externalReady` for WeChat and `telegramConnected` for Telegram. WeClaw is
  health-probed; WxPusher readiness means complete outbound configuration and
  is not a side-effecting live-send probe.

## Operator Check

Configure an explicit mode, then use the unified runtime commands:

```bash
LOS_WECHAT_BOT_MODE=required
LOS_TELEGRAM_BOT_MODE=optional
pnpm start
pnpm status
```

Persist the mode in `.env` for normal use. Channel-only operations are
available through `pnpm run channels:start`, `pnpm run channels:stop`,
`pnpm run channels:restart`, and `pnpm run channels:status`.
`bash tools/check-bot-health.sh` remains a compatibility alias for the same
status implementation. Legacy `LOS_REQUIRE_WECHAT_BOT` and
`LOS_REQUIRE_TELEGRAM_BOT` values map to required/optional only when the new
mode is absent.

`required` makes start and status return non-zero when that channel is not
ready. `optional` reports the failure without making the gateway unhealthy.
`disabled` does not start the process.

## Failure Modes

1. `status=ok`, `ready=false`: the process is running but the gateway SSE stream is not live. Check `LOS_GATEWAY_URL`, `LOS_AUTH_TOKEN`, `LOS_OPERATOR_TOKEN`, gateway health, and bot logs. The bot retries after `SSE_RECONNECT_MS`.
2. Configuration preflight failed: no process was spawned. Fix the named
   missing key; for WeChat configure `WECLAW_DEFAULT_TO` or a complete
   `WXPUSHER_APP_TOKEN` plus UID/topic target, and for Telegram configure its
   token plus both chat and user allowlists.
3. Endpoint unavailable: the bot process is stopped or listening on a different port. Run `pnpm run channels:status` before restarting.
4. WeChat `weclawAvailable=false`: operator events can still reach configured fallback channels, but bidirectional WeClaw delivery is unavailable. Check `http://127.0.0.1:18011/health` and login state.
5. Telegram polling or webhook errors: the process stays alive and retries update polling or SSE consumption. Validate the bot token, allowed chat/user IDs, webhook secret, and webhook URL.

## Verification

```bash
pnpm --filter @los/wechat-bot test
pnpm --filter @los/telegram-bot test
bash tools/check-bot-health.sh
pnpm run check:channels
pnpm check
```

The check script is runtime evidence only. Package tests verify response shape and readiness transitions without requiring live Telegram or WeChat credentials.
