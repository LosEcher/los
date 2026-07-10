# IM Run Approval Smoke — 2026-07-10

- **date**: 2026-07-10
- **purpose**: los self-bootstrap IM path for RunContract plan approval
- **trust**: only rows marked `[E]` are verified evidence; agent narrative elsewhere is not a ledger

## What this smoke proves

| Step | Evidence | Confidence |
|------|----------|------------|
| Inject planning run + `run.operator_attention_required` | `tools/smoke-im-inject-attention.ts` output + DB session_events | `[E]` |
| WeChat alert delivered | wechat-bot log `[weclaw] sent ok session=…` | `[E]` |
| Multi-turn `#approve-phase` short path (Bearer + last user turn) | `POST /v1/chat/completions` reply `planning → plan_approved` | `[E]` |
| Live WeChat `#approve-phase` | operator paste → Chinese reply with full runId | `[E]` |
| `#verify-run` with empty requiredChecks | reply `检查项: 共 0 … 结论: succeeded` | `[E]` — **empty verify, not product QA** |

## Representative IDs (re-run after optimize)

| Role | Id |
|------|-----|
| Human WeChat approve | `run-smoke-im-19f4a87d4b1` / `session-smoke-im-19f4a87d4b1` |
| API multi-turn approve | `run-smoke-im-19f4a87ba02` |

## Operator note: approve ≠ verify

1. **`#approve-phase <runId>`** — RunContract phase `planning → plan_approved`.
2. **`#verify-run <runId>`** — runs `verification_records` / requiredChecks.
   - Smoke inject uses `requiredChecks: []` → **0 checks, status succeeded**.
   - That is **not** “implementation verified” and not AP3 completion evidence.
3. Paste **one command per message**. Trailing `#…` on the same line was previously absorbed into `reason`; resolver now strips it.

## Commands (one line each)

```
#approve-phase run-smoke-im-19f4a87d4b1
#verify-run run-smoke-im-19f4a87d4b1
#status session-smoke-im-19f4a87d4b1
```

## Prerequisites

- gateway + wechat-bot running
- `WECLAW_DEFAULT_TO` set (from `~/.weclaw/accounts/*-im-bot.json` `ilink_user_id`)
- `LOS_AUTH_TOKEN` / `LOS_OPERATOR_TOKEN` for bot SSE + API

## Not claimed

- Session-level `#approve` / tool.denied as a real consent gate for L2 tools (auto-deny under maxRisk L1)
- Multi-agent orchestration
- Resume after long idle (not covered this run)
