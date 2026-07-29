# ADR 0031: Provider Health-Aware Routing

## Status

Accepted.

## Context

The scheduler currently selects providers based on static configuration (provider + model from task metadata), with fallback chains defined in `RunSpecRequest.providerFallback`. There is no runtime health signal: a provider that is returning 503s or has high latency is treated identically to a healthy one until the fallback chain exhausts targets.

Kim K3's MoonEP (MoE Expert Parallelism) demonstrates a production pattern: dynamic load-aware routing that distributes requests across experts based on real-time load metrics. While los doesn't have MoE routing, the same principle applies at the provider level.

`provider-probe.ts` now collects RTT data. `scheduler-decision-ledger.ts` now records task outcomes per provider. Both are inputs to a health-aware routing decision.

## Decision

1. **Health score per provider** — computed from three weighted signals:
   - **RTT** (40%): Recent probe RTT from `provider-probe.ts`, exponentially smoothed
   - **Success rate** (40%): Ratio of `succeeded / total` from `getProviderRecentOutcomes()` (24h window)
   - **Availability** (20%): Whether the provider is reachable (probe `healthy` flag)

2. **Health tiers**:
   | Score | Tier | Behavior |
   |-------|------|----------|
   | ≥ 0.8 | `healthy` | Normal routing |
   | 0.5-0.8 | `degraded` | Prefer alternatives, use as fallback |
   | < 0.5 | `unhealthy` | Skip entirely, log alert |

3. **Integration points**:
   - `resolveGraphTaskProviderModelSelection()` in `provider-selection.ts`: when multiple providers match, prefer highest health score
   - `provider-fallback.ts`: skip unhealthy providers in the fallback chain
   - `scheduled-task-runner.ts`: log a `provider.health_changed` event when a provider crosses a tier boundary

4. **Health probe cadence**: Every 60s during active scheduling, every 300s when idle.

## Consequences

**Positive**: Fewer failed task runs due to unhealthy provider selection. Lower latency by preferring low-RTT providers.

**Negative**: Adds probe traffic (one cheap HTTP request per provider per minute at most).

**Risk**: Health score could oscillate. Mitigation: exponential smoothing (α=0.3) on RTT and success rate.

## References

- Kimi MoonEP load-aware routing
- `packages/agent/src/providers/provider-probe.ts`
- `packages/agent/src/scheduler-decision-ledger.ts`
- `packages/agent/src/scheduler/provider-selection.ts`
