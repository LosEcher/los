---
date: 2026-06-07
change: session-recovery-discovery
surface: gateway, session-recovery
impact: Gateway now exposes GET /sessions/recoverable to list sessions with incomplete runs that can be resumed, closing the observability gap for cross-gateway failover.
---

## Evidence

- Source: `packages/gateway/src/chat-session-helpers.ts` adds
  `findRecoverableSessions` which scans run specs for failed/cancelled/blocked
  runs, loads their sessions, and returns last checkpoint info, message/turn
  counts, and recent event IDs.
- API: `GET /sessions/recoverable?limit=N` returns a list of recoverable
  sessions with hint text directing operators to use `POST /chat` with the
  session ID to resume, and `GET /sessions/:id/events/stream` to replay missed
  events.
- Validation: `pnpm check`, `./tools/check-contracts.sh`, gateway tests (18/18).
- Remaining risk: auto-detection of gateway failure and automatic session
  handoff remain future work. This endpoint gives operators and automation the
  visibility needed to initiate manual recovery.
