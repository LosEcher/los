# ADR 0004: Web Console Framework Choice And Iterative Dashboard Plan

## Status

Proposed.

## Observation

I reviewed four external projects against the current `los` surface:

1. `assistant-ui` is a React component/runtime library for chat UX. It provides thread, composer, tool, data-renderer, and remote-thread abstractions, but not the admin/data console itself.
2. `9router` is a Next.js dashboard for provider routing, quota, usage, logs, and skills. Its strength is dense ops-style navigation and large provider/catalog tables.
3. `hermes-web-ui` is a Vue 3 management console with clear page separation for chat, history, logs, skills, memory, profiles, models, usage, and settings.
4. `DeepSeek-Reasonix` is a terminal-first agent runtime with a React/Vite dashboard that emphasizes session history, context inspection, rules, memory, plans, and event replay.

Current `los` state is narrower:

1. `packages/gateway/src/server.ts` exposes `/chat`, `/memory`, `/sessions`, `/sessions/:id/events`, `/sessions/:id/observability`, `/tasks`, and `/health`.
2. `packages/gateway/src/index.html` is still a single static chat page with only memory/session/health shortcuts.
3. There is no first-class web surface yet for providers, skills, rules, nodes, or logs.

## Inference

The useful split is:

1. `assistant-ui` for the chat surface and message/thread primitives.
2. `hermes-web-ui` for console IA: left navigation, page-level separation, search/filter controls, and dense admin panels.
3. `9router` for provider/catalog/usage/log table patterns.
4. `Reasonix` for context inspection patterns: session sidebar, timeline, rules/memory panels, and cross-linked event detail.

The repo should not copy `9router` or `hermes-web-ui` wholesale. `los` already has a Fastify backend and should keep that as the API source of truth; the frontend should be a separate presentation layer over those endpoints.

## Judgment

Use a React-based web app for `los`, but keep the backend in `packages/gateway`.

Recommended stack:

1. React + TypeScript
2. Vite for the web bundle
3. TanStack Router for page layout and deep links
4. TanStack Query for server-state and polling/SSE-derived refresh
5. `assistant-ui` only for the chat center panel and thread rendering
6. A small component system with dense table, split-pane, tabs, filters, and drawers for console pages

Avoid using Next.js as the primary shell for `los` unless SSR or route-level server rendering becomes a hard requirement. The current gateway is already the server boundary, so adding a second application server would increase operational surface without solving the immediate design problem.

## Information Architecture

Proposed first-class pages:

1. `Chat`
2. `Sessions`
3. `Session Detail`
4. `Providers`
5. `Skills`
6. `Rules`
7. `Memory`
8. `Nodes`
9. `Logs`
10. `Tasks`
11. `Settings`

Suggested truth surfaces:

1. `chat` = current prompt, stream, tool calls, turn history
2. `session` = persisted run, replay, observability, and event timeline
3. `skill` = skill definition, source, scope, and usage
4. `rule` = policy text, enforcement scope, and attachment to runs
5. `memory` = observations, tags, source, session linkage
6. `provider` = configured provider endpoint, discovery source, model, health, and cost/routing metadata
7. `executor node` = mesh runtime node, status, capacity, and task ownership
8. `logs` = server/runtime files and structured filters

## Terms

Use these labels consistently in UI copy, route names, and data model fields:

1. `executor node` = a mesh participant that can execute agent tasks, sandbox work, or remote worktree actions. This is the only thing meant by `nodes`.
2. `provider endpoint` = a callable model backend or provider route. This can be API-key based, OAuth based, local model server based, or proxy based.
3. `provider account` = the credential-bearing identity behind a provider endpoint, when a provider supports more than one account or login source.
4. `provider model` = a concrete model identifier exposed by a provider endpoint.
5. `session` = one logical agent run with persisted turns and events.
6. `task` = a schedulable execution wrapper around a session.
7. `memory observation` = one persisted memory item, note, or extracted fact.
8. `skill` = one reusable instruction or tool bundle surfaced to the agent.
9. `rule` = one policy object that constrains behavior or approvals.
10. `log source` = one selected runtime log file or stream.

Recommended display fields by entity:

1. `chat`: prompt, active session, selected provider endpoint, tool mode, current turn, streaming state.
2. `session`: session id, title, status, provider endpoint, model, workspace root, turn count, token usage, start/end time, trace id, dedupe key.
3. `provider endpoint`: provider name, account/source, model list, base URL or origin, auth type, health, rate/cost hints, discovery source, active status.
4. `executor node`: node id, host label, role, status, queue depth, active tasks, mesh links, last heartbeat, version, capacity.
5. `skill`: skill name, category, run mode, source path/url, version hash, usage count, last used time, pinned state.
6. `rule`: rule name, scope, severity, enforcement mode, status, last changed time, attachments to sessions or tasks.
7. `memory`: title, summary, kind, tags, source, session linkage, created/updated time, search relevance.
8. `logs`: file name, source, level, timestamp, logger, message, request id, session id, task id.
9. `tasks`: task id, session id, trace id, dedupe key, status, timeout, retry policy, provider endpoint, executor node.
10. `settings`: profile, model defaults, provider defaults, auth state, data retention, feature flags.

## Iteration Plan

### Phase 1: Shell And Navigation

1. Replace the static HTML landing page with a real console shell.
2. Add left navigation, top utility bar, and a main content area.
3. Keep the current chat page as the default landing surface.
4. Expose the already existing session and memory routes through the new shell.

### Phase 2: Chat And Session Detail

1. Use `assistant-ui` in the chat pane.
2. Render session timeline, turns, and SSE events in a split detail view.
3. Add cross-links from session rows to `/sessions/:id`.
4. Add a raw event inspector and an observability summary panel.

### Phase 3: Console Pages For Managed Data

1. Build `Providers`, `Skills`, `Rules`, and `Memory` pages as list/detail pages.
2. Add table filters, search, and scoped detail drawers.
3. Keep edits narrow and explicit; avoid turning every page into a free-form editor.

## Read/Write Split

Initial release should bias read-only unless the write path already exists and has clear persistence rules.

Read-only in phase 1:

1. `Sessions` and `Session Detail`
2. `Logs`
3. `Nodes`
4. `Tasks`
5. `Rules` if rules are imported from config or source files
6. `Skills` if skills are file-backed and not yet edited through the app

Read/write in phase 1 only if the backend already owns the write path:

1. `Chat`
2. `Memory`
3. `Settings`
4. `Providers` if provider lifecycle changes are already supported by stable APIs

Recommended write policy by area:

1. `Chat` = write prompt, cancel run, retry run, switch tool mode.
2. `Memory` = add, edit, delete observations.
3. `Settings` = change defaults, profile scope, feature flags, and display preferences.
4. `Providers` = read-only first; later allow enable/disable, credential binding, model selection, and endpoint edit.
5. `Skills` = read-only first; later allow pin/unpin, source refresh, and local edits only if a source-of-truth path exists.
6. `Rules` = read-only first; later allow rule editing only when rule storage and evaluation are explicit.
7. `Nodes` = read-only first; later allow maintenance actions such as drain, disable, or restart only if the mesh layer supports them.
8. `Logs` = read-only.
9. `Sessions` = read-only, except admin actions like delete/export/import if those are separately confirmed.
10. `Tasks` = read-only, except cancel/retry if scheduler semantics are already stable.

### Phase 4: Nodes, Logs, And Cross-Linking

1. Add `Nodes` as an operational page for runtime/executor instances.
2. Add `Logs` with file selection, level filters, keyword search, and source tags.
3. Cross-link nodes, tasks, sessions, and logs so operators can move by evidence, not by guesswork.

### Phase 5: Polish And Guardrails

1. Add saved filters and deep links for common views.
2. Add permission gating for write actions.
3. Add empty, loading, and error states for every entity type.
4. Add pagination or virtualization before large tables become slow.

## Placement

1. Backend endpoints stay in `packages/gateway`.
2. Event and persistence shape stay in `packages/agent` and `packages/memory`.
3. The web shell should live beside the gateway or as a dedicated web package, but not as a second backend.

## Remaining Verification

1. Decide whether `rules` are read-only policy views or editable policy artifacts.
2. Decide the first page ordering for the shell after `Chat`.

## Update 2026-06-02: Chat And Provider Configuration Boundary

### Observation

Current implementation after the React console pass:

1. `packages/web/src/chat-page.tsx` owns active run state: prompt, selected session, provider/model override, model settings, tool mode, max loops, timeout, stream rows, and cancel. These are run choices and are rendered near the chat composer, not as provider configuration.
2. `packages/web/src/pages.tsx` owns the `Providers` page and already reads `/onboarding` plus `/providers/models`.
3. `packages/infra/src/config.ts` is the current provider configuration source. It supports `providers.<name>.apiKey`, `baseUrl`, `model`, `enabled`, and `weight`, with discovery from `.env`, process env, `~/.los/config.yaml`, `/etc/los/config.yaml`, and tool/account scanners.
4. No stable backend write API exists yet for editing provider credentials or endpoint config from the web UI.

### Inference

The UI should keep two separate contracts:

1. `Chat` is a run launcher. It may choose a provider endpoint, model, execution directory, tool/skill mode, and per-request model settings for the next `/chat` call.
2. `Providers` is the configuration and discovery surface. API key, base URL, enabled state, default model, and provider health belong here.

If Chat accepts raw API keys or base URLs directly, it mixes a per-run override with credential lifecycle and makes it harder to audit which configuration produced a session. Provider credentials should stay server-side and should not be stored in browser local state.

### Judgment

1. Add an explicit `New Chat` action to Chat. Clearing stream output is not enough because it does not clear the selected `sessionId`.
2. Keep provider/model selectors in Chat as run controls, but render them as a compact toolbar or pill controls near the input composer with execution directory and tool/skill mode. Do not promote them back into a separate card or right inspector.
3. Move API key/base URL setup guidance to Providers.
4. Do not add web-based provider save until the backend owns a stable write contract for user config, redaction, validation, and reload semantics.
5. Use a provider configuration workspace that generates `.env` and `~/.los/config.yaml` snippets as the first step.

### Remaining Work

1. Design `GET /providers/config` and `PUT /providers/config/:name` before enabling in-browser saves.
2. Add a `POST /providers/:name/probe` route that checks model listing or a minimal authenticated provider endpoint without starting a paid chat run.
3. Decide whether config writes target `~/.los/config.yaml`, a los-managed profile store, or both.
4. Add redaction tests so API keys never appear in `/providers/models`, `/onboarding`, logs, session events, or browser-visible errors.

### Page Boundary Verification

1. `packages/web/src/ui-boundary.test.mjs` is the current lightweight guard for this boundary. It checks source-level ownership instead of relying only on screenshot review.
2. The test must fail if Chat moves API key, base URL, default model, or provider settings fields back into `ChatPage`.
3. The test must fail if Chat's right inspector becomes a configuration surface again instead of `Run Evidence`.
4. The test must fail if Provider setup fields disappear from `ProviderConfigWorkspace`.
5. Visual verification still uses the running Vite page and desktop/mobile screenshots to catch spacing, wrapping, and overlap issues that source-level tests cannot see.
6. The reference shape is compact input-bar controls like Hermes `ChatInput` and Open WebUI `MessageInput`, not a stacked settings panel.
