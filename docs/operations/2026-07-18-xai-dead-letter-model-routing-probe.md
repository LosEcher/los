# xAI Dead-Letter Model Routing Probe

Date: 2026-07-18

## Scope

This probe determines whether the historical
`xai:grok-composer-2.5-fast` target remains callable and whether an existing
device login can be reused without copying credentials. It does not
acknowledge, requeue, replay, or mutate any dead-letter record.

No access token, refresh token, API key, cookie, account identifier, raw auth
snapshot, or model response transcript was written to this record.

## Runtime Evidence

| Surface | Command or source | Result |
| --- | --- | --- |
| LOS runtime | `pnpm run status`; `pnpm run executor:status`; gateway `/health` | gateway `8080` and executor `8090` healthy; executor online and idle [E] |
| LOS xAI credential status | `./bin/los auth xai status` | local OAuth entry reported logged in with an unexpired bearer token [E] |
| Effective xAI provider call | `./bin/los compat --execute --target xai:grok-composer-2.5-fast --probe read-context ...` | HTTP 401 `unauthorized`; no passing compatibility evidence [E] |
| Grok CLI model discovery | `grok models` | logged in through `grok.com`; available model ids were `grok-4.5` and local alias `my-model` [E] |
| Historical model through Grok CLI | `grok --single ... --model grok-composer-2.5-fast` | rejected as `unknown model id` before execution [E] |
| Current Grok runtime | bounded one-turn `grok-4.5` headless request | completed successfully; response reported effective model `grok-4.5-build` [E] |
| DeepSeek provider | `./bin/los provider list --json` | `deepseek-v4-flash` ready with one passing persisted read-context compatibility record [E] |

The LOS OAuth token metadata named the expected xAI issuer and included
`api:access`, but the public inference endpoint still returned HTTP 401. Token
presence, JWT expiry, and discovery readiness therefore remain insufficient as
credential verification. [E]

## Current External Contract

xAI's current public documentation uses an API key for `api.x.ai` inference
and recommends `grok-4.5` for coding:

- <https://docs.x.ai/developers/quickstart>
- <https://docs.x.ai/developers/models>
- <https://docs.x.ai/developers/rest-api-reference/inference/models>
- <https://docs.x.ai/build/overview>

The current public model page does not list `grok-composer-2.5-fast`. The
authenticated `GET /v1/models` contract is API-key scoped, so the failed OAuth
request cannot establish the account's public API model entitlement. [E]

## Route Judgment

The three credential and execution surfaces remain separate:

1. A Grok web or CLI login is valid for the installed Grok runtime and its
   `cli-chat-proxy.grok.com` route.
2. A public xAI API call uses `api.x.ai` and the documented credential is an
   API key. The current LOS OAuth record did not authenticate that route.
3. DeepSeek uses LOS's built-in provider loop and preserves task, session,
   tool, and compatibility evidence required for controlled recovery.

`grok-composer-2.5-fast` is retired from the current recovery path. The Grok
CLI remains a usable explicitly selected external runtime on `grok-4.5`, but it
does not satisfy dead-letter replay provenance. Recovery should use a new LOS
run with an explicitly selected verified provider/model, initially DeepSeek,
after the matching provider/model validation and malformed-argument fixtures
pass. [E]

## Safety Boundary

1. Preserve all 15 unacknowledged `unrecoverable_error` rows.
2. Do not invoke the existing dead-letter retry route; its contract only
   permits `lease_expired` events.
3. Do not copy Grok or browser session material into LOS or PostgreSQL.
4. Record original and effective provider/model/account provenance for every
   future replacement run.
5. A successful replacement run may support an explicit later acknowledgment;
   it does not acknowledge the historical row automatically.
