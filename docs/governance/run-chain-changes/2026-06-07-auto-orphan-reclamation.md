---
date: 2026-06-07
change: auto-orphan-reclamation
surface: gateway, session-recovery
impact: Each gateway now runs a background orphan reaper (30s interval) that detects stale gateways via heartbeat expiry and auto-claims their non-terminal run specs.
---

## Evidence

- Source: `packages/gateway/src/chat-session-helpers.ts` adds
  `reclaimOrphanedRuns(gatewayServiceId)` which scans `service_instances` for
  gateways with heartbeats older than 60s, finds their orphaned run specs with
  non-terminal status, and claims them for the current gateway.
- Source: `packages/gateway/src/server.ts` starts the reaper on a 30s interval
  during gateway startup, logging claimed run counts and any errors.
- Validation: `pnpm check`, `./tools/check-contracts.sh`, gateway tests
  (18/18).
- Remaining risk: end-to-end validation requires a multi-gateway test
  environment with simulated gateway crash. The reaper only reclaims runs from
  gateways whose heartbeat is stale but service still shows as 'online'
  (avoiding reclaiming from explicitly drained/offline gateways).
