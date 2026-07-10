# Local Auth Token Lookup And Rotation

## Scope

This procedure covers the local Gateway access token `LOS_AUTH_TOKEN`. It does not rotate provider API keys, `EXECUTOR_AGENT_KEY`, bot platform tokens, or `LOS_OPERATOR_TOKEN` unless their own evidence shows exposure.

The 2026-07-10 incident required rotating only `LOS_AUTH_TOKEN`:

- the token was short and appeared in the Gateway log;
- the same value was configured in `~/.weclaw/config.json` at `agents.los.api_key`;
- `LOS_OPERATOR_TOKEN` was already a separate 64-character value and did not appear in the inspected logs.

## Configuration Lookup Order

Backend config resolves values in this order, highest priority first:

1. CLI flags or the current process environment;
2. the nearest `.env` file from the working directory;
3. `~/.los/config.yaml`;
4. `/etc/los/config.yaml`;
5. built-in defaults.

`tools/los.sh` explicitly loads the project `.env` before starting Gateway and Executor. CLI and bot processes may also inherit shell environment variables, so they must be restarted after rotation.

## Safe Lookup

From the repository root, run:

```bash
pnpm run auth:locate
```

The command prints only:

- the active project `.env` path;
- token length and a 12-character SHA-256 fingerprint;
- whether `~/.weclaw/config.json` matches the project token;
- counts of sensitive header fields and configured-token occurrences in the local Gateway log.

It never prints the token value. Do not use `cat .env`, `rg LOS_AUTH_TOKEN .env`, shell tracing, or commands that place the token directly in command arguments.

For additional source discovery, inspect names and paths without values:

```bash
rg -n "LOS_AUTH_TOKEN|LOS_OPERATOR_TOKEN" packages tools .env.example
find ~/.los ~/.weclaw -maxdepth 2 -type f -print 2>/dev/null
```

## Automatic Rotation

Run:

```bash
pnpm run auth:rotate
pnpm restart
```

`auth:rotate` performs these operations without printing the token:

1. generates a 32-byte random token encoded as 64 hexadecimal characters;
2. atomically replaces `LOS_AUTH_TOKEN` in the project `.env` and sets the file mode to `0600`;
3. updates `~/.weclaw/config.json` only when `agents.los.api_key` matched the old token;
4. replaces the old token and sensitive header values in `.los-runtime/gateway.log` with `[REDACTED_ROTATED]`;
5. prints the new token length and fingerprint for comparison.

Restart separately managed clients such as `@los/wechat-bot` and `@los/telegram-bot` after the Gateway restart. A running process keeps the old environment value even after `.env` changes.

## Verification

```bash
pnpm run auth:locate
pnpm run status
```

Then verify both sides of the access gate:

1. an unauthenticated protected request returns `401`;
2. a request using the freshly loaded `.env` token succeeds;
3. WeClaw or another configured client can still call `/v1/chat/completions`;
4. new Gateway log entries contain no raw `authorization`, cookie, or los token values.

`LOS_OPERATOR_TOKEN` must remain separate from `LOS_AUTH_TOKEN`. Rotate it only when it was exposed or shared, then restart every operator client that sends `x-los-operator-token`.

## 2026-07-10 Execution Record

- `LOS_AUTH_TOKEN` changed from 14 characters to a generated 64-character value.
- Project `.env` and `~/.weclaw/config.json` were synchronized with no token printed.
- Ten historical `authorization` header values were sanitized from the local Gateway log.
- `LOS_OPERATOR_TOKEN` was not rotated because it was already separate, 64 characters long, and absent from the inspected logs.
- Gateway, Executor, WeChat bot, and WeClaw were restarted.
- Protected API verification returned `401` without a token, `200` with the new token, and `401` with an invalid token.
- OpenAI-compatible command routing returned a valid completion with the new bearer token.
- Post-rotation inspection reported zero sensitive headers and zero configured-token occurrences in the Gateway log.
