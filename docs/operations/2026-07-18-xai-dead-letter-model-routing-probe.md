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
| Initial unauthenticated CLI attempt | `./bin/los compat --execute ...` without `LOS_AUTH_TOKEN` | gateway returned HTTP 401 before provider selection [E] |
| Initial unbound-workspace attempt | authenticated probe against the unregistered `los` workspace | intake returned HTTP 400 `unbound_workspace` before provider selection [E] |
| Effective xAI provider call | authenticated probe using the existing bound `pi` workspace | composer probe passed; both expected tools succeeded; effective model remained `grok-composer-2.5-fast` [E] |
| Current xAI default model | authenticated `xai:grok-4.3/read-context` probe using the same binding | passed with both expected tools successful and effective model `grok-4.3` [E] |
| Grok CLI model discovery | `grok models` | logged in through `grok.com`; available model ids were `grok-4.5` and local alias `my-model` [E] |
| Historical model through Grok CLI | `grok --single ... --model grok-composer-2.5-fast` | rejected as `unknown model id` before execution [E] |
| Current Grok runtime | bounded one-turn `grok-4.5` headless request | completed successfully; response reported effective model `grok-4.5-build` [E] |
| DeepSeek provider | authenticated probe using the same bound workspace | Flash probe passed; both expected tools succeeded; effective model remained `deepseek-v4-flash` [E] |

The first HTTP 401 came from LOS gateway authentication, not xAI. The matching
DeepSeek request and dead-letter list failed with the same response until the
CLI loaded `LOS_AUTH_TOKEN`. The next HTTP 400 came from project-owner intake.
Neither response is provider compatibility evidence. [E]

With both gates satisfied, the exact-model result was:

```text
spec:          xai:grok-composer-2.5-fast/read-context
session:       session-1784365543308
task run:      task-686f7a82-01fd-4593-bc4e-186a70db99f2
request:       req-9b1bf22d-efd3-47ac-8a93-999dae0092f5
node:          mbp-executor-1
effective:     grok-composer-2.5-fast
tools:         list_directory, read_file
tool results:  2 succeeded, 0 failed, 0 denied
tokens:        5398
verdict:       passed
```

The independent `xai:grok-4.3` result was task
`task-4ac97763-8ddc-4462-8745-0483753a107c`, session
`session-1784365915429`, with both tools successful, 5,106 total tokens, and a
passing verdict. [E]

The DeepSeek alternate result was task
`task-53a8a5cf-f485-4834-8628-a9e6dc117136`, session
`session-1784365543310`, with the same two successful tools, 5,907 total
tokens, and a passing verdict. [E]

After these probes the fresh dead-letter summary was 26 total, 16
unacknowledged, 10 acknowledged, 2 requeued, and 0 requeue-eligible. All 16
unacknowledged rows are `unrecoverable_error`; the extra row beyond the earlier
15-row baseline is a failed historical composer compatibility attempt. [E]

## Current External Contract

xAI's current public documentation uses an API key for `api.x.ai` inference
and recommends `grok-4.5` for coding:

- <https://docs.x.ai/developers/quickstart>
- <https://docs.x.ai/developers/models>
- <https://docs.x.ai/developers/rest-api-reference/inference/models>
- <https://docs.x.ai/build/overview>

The current public model page does not list `grok-composer-2.5-fast`, while the
authenticated LOS provider call completed successfully with that exact
effective model. The live provider result is the current compatibility truth;
the public page and Grok CLI catalog remain separate discovery surfaces. [E]

## Route Judgment

The three credential and execution surfaces remain separate:

1. A Grok web or CLI login is valid for the installed Grok runtime and its
   `cli-chat-proxy.grok.com` route.
2. The LOS xAI OAuth provider path currently authenticates and executes the
   historical composer model even though Grok CLI does not expose that id.
3. DeepSeek uses LOS's built-in provider loop and preserves task, session,
   tool, and compatibility evidence required for controlled recovery.

`grok-composer-2.5-fast` remains usable through the LOS xAI provider path and
is the preferred same-model route for the nine historical transport failures.
DeepSeek Flash is a verified alternate. The Grok CLI remains a usable
explicitly selected external runtime on `grok-4.5`, but it does not satisfy
dead-letter replacement provenance. Provider/model validation and malformed
argument fixtures pass; replacement work must still use new LOS runs and keep
the historical rows unacknowledged until each result is verified. [E]

## Safety Boundary

1. Preserve all 16 unacknowledged `unrecoverable_error` rows.
2. Do not invoke the existing dead-letter retry route; its contract only
   permits `lease_expired` events.
3. Do not copy Grok or browser session material into LOS or PostgreSQL.
4. Record original and effective provider/model/account provenance for every
   future replacement run.
5. A successful replacement run may support an explicit later acknowledgment;
   it does not acknowledge the historical row automatically.
