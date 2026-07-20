# xAI Dead-Letter Model Routing Probe

Date: 2026-07-18

## Scope

This probe determines whether the historical
`xai:grok-composer-2.5-fast` target remains callable, whether an existing
device login can be reused without copying credentials, and whether a new
representative replacement run can complete against the bound `los` workspace.
It does not acknowledge, requeue, replay, or mutate any dead-letter record.

No access token, refresh token, API key, cookie, external account identifier,
raw auth snapshot, or model response transcript was written to this record.

## Runtime Evidence

| Surface | Command or source | Result |
| --- | --- | --- |
| LOS runtime | `pnpm run status`; `pnpm run executor:status`; gateway `/health` | gateway `8080` and executor `8090` healthy; executor online and idle [E] |
| LOS xAI credential status | `./bin/los auth xai status` | local OAuth entry reported logged in with an unexpired bearer token [E] |
| Initial unauthenticated CLI attempt | `./bin/los compat --execute ...` without `LOS_AUTH_TOKEN` | gateway returned HTTP 401 before provider selection [E] |
| Initial unbound-workspace attempt | authenticated probe against the unregistered `los` workspace | intake returned HTTP 400 `unbound_workspace` before provider selection [E] |
| Workspace binding | `POST /projects/bind`, then `GET /projects` | `los` bound to `/Users/echerlos/projects/los-workspace/projects/los`; `defaultProjectId` remained `null` [E] |
| Composer compatibility call | authenticated probe using the existing bound `pi` workspace | request and LOS model profile remained `grok-composer-2.5-fast`; both expected tools succeeded; every provider response identified model `grok-4.5` [E] |
| Current xAI default model | authenticated `xai:grok-4.3/read-context` probe using the same binding | passed with both expected tools successful and effective model `grok-4.3` [E] |
| Provider account metadata | `GET /providers/accounts`; source inspection | `xai-grok-default` is active/verified metadata for the separate Grok CLI runtime; the built-in xAI provider loop resolves credentials from the LOS OAuth store and does not persist a `providerAccountId` for this run [E] |
| Grok CLI model discovery | `grok models` | logged in through `grok.com`; available model ids were `grok-4.5` and local alias `my-model` [E] |
| Historical model through Grok CLI | `grok --single ... --model grok-composer-2.5-fast` | rejected as `unknown model id` before execution [E] |
| Current Grok runtime | bounded one-turn `grok-4.5` headless request | completed successfully; response reported effective model `grok-4.5-build` [E] |
| DeepSeek provider | authenticated probe using the same bound workspace | Flash probe passed; both expected tools succeeded; effective model remained `deepseek-v4-flash` [E] |

The first HTTP 401 came from LOS gateway authentication, not xAI. The matching
DeepSeek request and dead-letter list failed with the same response until the
CLI loaded `LOS_AUTH_TOKEN`. The next HTTP 400 came from project-owner intake.
Neither response is provider compatibility evidence. [E]

With both gates satisfied, the composer-request result was:

```text
spec:          xai:grok-composer-2.5-fast/read-context
session:       session-1784365543308
task run:      task-686f7a82-01fd-4593-bc4e-186a70db99f2
request:       req-9b1bf22d-efd3-47ac-8a93-999dae0092f5
node:          mbp-executor-1
requested:     grok-composer-2.5-fast
LOS profile:   grok-composer-2.5-fast
response:      grok-4.5
tools:         list_directory, read_file
tool results:  2 succeeded, 0 failed, 0 denied
tokens:        5349
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

## Representative Replacement

The representative source was dead letter
`dlq-ab9ce4f8-632e-4152-9339-3b899d978844`, source task
`task-3710c5ef-4cd0-4936-a846-ed8323f1ae41`, whose original error was
`fetch failed`. Both attempts used new trace and dedupe identifiers. Neither
attempt invoked the dead-letter retry, acknowledgment, or replay routes. [E]

The first bounded replacement was task
`task-a1ac248c-043c-4127-8bf1-d027df191a8a`, session
`session-1784368626328`, run spec
`run-session-1784368626328-1784368626329`. The task and run spec reached
`succeeded`, but 3 of 69 read-only tool calls failed because `find_in_code`
received a directory rather than a supported source file. The recovery
projection therefore remained `operator_attention`. The run used 406,537
tokens and reported USD 0.41271. It is retained as diagnostic evidence, not as
the clean replacement result. [E]

The narrowed replacement v2 was task
`task-ac8b6838-b817-49ad-a709-4abdc7fe1b5a`, session
`session-1784368943359`, run spec
`run-session-1784368943359-1784368943360`. It completed in two turns with all
three `read_file` calls successful, no failed or denied tool call, 12,057 total
tokens, and reported USD 0.013344. The task and run spec are `succeeded`; the
run-state action is `none`, recovery status is `clean`, and no verification
record was required. LOS recorded the requested/profile model as
`grok-composer-2.5-fast`; both provider responses identified `grok-4.5`. [E]

The first replacement's persisted observation triggered the then-current
60-second `MEMORY.md` debounce. It created a repository-root file through
`process.cwd()` and mixed observations from more than one project, despite the
run using `toolMode=read-only`. The generated file was removed. The bounded
fix removes the implicit `addObservation()` file-sync path; explicit
`POST /memory/sync-md`, which receives `workspaceRoot` and an optional
`projectId`, remains the only creation path. The focused `@los/memory` suite
passed 74/74 after the change. [E]

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

The current public model page does not list `grok-composer-2.5-fast`. The
authenticated LOS provider accepted that request/profile identifier, while its
response events identified `grok-4.5`. The live response model is the effective
provider evidence; LOS profile selection, the public page, and Grok CLI catalog
remain separate discovery surfaces. [E]

## Route Judgment

The three credential and execution surfaces remain separate:

1. A Grok web or CLI login is valid for the installed Grok runtime and its
   `cli-chat-proxy.grok.com` route.
2. The LOS xAI OAuth provider path accepts the historical composer identifier
   as an explicit request/profile alias, while provider responses identify the
   executed model as `grok-4.5`.
3. DeepSeek uses LOS's built-in provider loop and preserves task, session,
   tool, and compatibility evidence required for controlled recovery.

`grok-composer-2.5-fast` remains usable through the LOS xAI provider path and
preserves the historical requested-model provenance, but it is not evidence of
an exact backend composer execution. DeepSeek Flash is a verified alternate.
The Grok CLI remains a usable explicitly selected external runtime on
`grok-4.5`, but it does not satisfy LOS dead-letter replacement provenance.
Provider/model validation and malformed argument fixtures pass; replacement
work must still use new LOS runs and keep the historical rows unacknowledged
until each result is verified. [E]

## Safety Boundary

1. Preserve all 16 unacknowledged `unrecoverable_error` rows.
2. Do not invoke the existing dead-letter retry route; its contract only
   permits `lease_expired` events.
3. Do not copy Grok or browser session material into LOS or PostgreSQL.
4. Record original and effective provider/model/account provenance for every
   future replacement run.
5. A successful replacement run may support an explicit later acknowledgment;
   it does not acknowledge the historical row automatically.
