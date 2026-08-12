# Channel Session Companion (2026-08-12)

## Goal

Treat Telegram / WeChat as a **mobile companion to a live los session**, not a
second agent: push decisions, verification failures, success, and worker asks;
bind to one session when desired; map actions to existing operator APIs.

## Live entry

- Web chat: `http://localhost:8080/#chat` (or `http://127.0.0.1:8080/#chat`)
- Gateway static UI is built from `packages/web/dist` (rebuild + restart required
  after UI changes).

## Event set (shared classifier)

`@los/agent/operator-companion-events` classifies `session.event` types:

| Type family | Kind | IM action |
| --- | --- | --- |
| `worker.ask` | needs_decision | Push question + options; answer on Web Chat or IM |
| `awaiting_approval` / plan ready | needs_decision | `#approve-phase` / `#verify-run` |
| `run.operator_attention_required`, `session.blocked`, recovery | needs_decision | Steering / approve |
| `run.verification_failed` | needs_decision | Investigate + re-verify |
| `run.succeeded` / task succeeded | success (info) | FYI, no decision |
| `tool.denied` | already_denied | FYI |
| `tool.warned` | info | FYI |

## WeChat bind flow

1. Ensure channel is running: `pnpm run channels:restart` (or `status` shows wechat ready).
2. From Web Chat, copy `sessionId`.
3. Send to WeChat:

```text
#bind-session <sessionId>
#bound-session
#unbind-session
```

Env overrides:

- `LOS_CHANNEL_BOUND_SESSION_ID` — force pin without command
- `LOS_CHANNEL_BIND_FILE` — bind state path (default `.los-runtime/wechat-bound-session.json`)

When bound, only that session is pushed (ops/governance still allowed).

## Telegram

Telegram bot uses the same classifier. Enable by configuring the bot token and
allowed chats (see package README / env). Inline buttons still map to
`POST /sessions/:id/operator-events` (approve / deny / escalate).

## Smoke checklist

1. Gateway + wechat healthy.
2. Start a chat on `#chat`; note session id.
3. `#bind-session <id>` on WeChat → confirmation.
4. Trigger attention (plan approve / tool deny / worker.ask) → IM delivery.
5. `#approve-phase <runId>` or Web approve still works.
6. Hard-refresh Web after UI builds (`Cmd+Shift+R`).
