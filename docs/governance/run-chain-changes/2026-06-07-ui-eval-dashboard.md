---
date: 2026-06-07
change: ui-eval-dashboard
surface: ui, web
impact: A read-only evals dashboard page renders eval summary groups, failover scope breakdowns, and baseline/candidate comparison deltas in the web console.
---

## Evidence

- Source: `packages/web/src/evals-page.tsx` adds a new evals dashboard page
  with summary and compare views.
- Summary view renders count, success rate, failure count, avg latency, avg
  retries, tool errors, and model cost cards plus grouped tables for failure
  class, failover scope, verification status, and provider/model.
- Compare view accepts baseline and candidate time windows and renders delta
  cards with directional indicators (improved / worsened).
- Navigation: `packages/web/src/App.tsx` adds the Evals page under a new
  "Quality" section via hash routing (`#evals`).
- Validation: `pnpm --filter @los/web check` passes; `pnpm check` passes;
  `./tools/check-contracts.sh` passes.
- Remaining risk: the dashboard is read-only; it does not record evals, trigger
  verification reruns, or drive runtime replay from eval data.
