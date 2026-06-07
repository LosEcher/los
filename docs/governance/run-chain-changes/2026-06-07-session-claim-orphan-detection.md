---
date: 2026-06-07
change: session-claim-orphan-detection
surface: gateway, session-recovery, run-specs
impact: Run specs now track gateway ownership via gateway_id. Recoverable sessions show gateway liveness. Orphaned runs can be claimed by another gateway via POST /runs/:id/claim.
---

## Evidence

- Source: `packages/agent/src/run-specs.ts` adds `gateway_id` column to
  `run_specs` and `claimRunSpec(runSpecId, gatewayId)` for ownership transfer.
- Source: `packages/gateway/src/chat-route.ts` auto-populates `gatewayId` from
  the gateway's service identity when creating run specs.
- Source: `packages/gateway/src/chat-session-helpers.ts` includes
  `gatewayId` and `gatewayOnline` status in each incomplete run spec within
  recoverable session output, using `loadServiceInstance` for liveness checks.
- API: `GET /sessions/recoverable` now shows gateway ownership and online
  status. `POST /runs/:id/claim` transfers ownership to the calling gateway.
- Validation: `pnpm check`, `./tools/check-contracts.sh`, gateway tests
  (18/18), agent tests (103/103).
- Remaining risk: automatic orphan detection and reclamation without operator
  intervention, multi-gateway end-to-end failover test.
