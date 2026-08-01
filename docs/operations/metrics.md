# Metrics Endpoint

`GET /metrics` on the gateway exposes persisted execution evidence in the
[Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format).

No external collector is required; scrape the endpoint directly or point a
Prometheus instance at it. Labels are stable — treat them as part of the
observability contract.

## Metrics

| Metric | Type | Labels | Source |
| --- | --- | --- | --- |
| `los_task_runs_total` | counter | `status` | `task_runs.status` |
| `los_task_run_duration_milliseconds` | gauge | `status`, `quantile` (`avg`/`max`) | `task_runs.started_at` → `completed_at` |
| `los_run_evals_total` | counter | `success` | `run_evals.success` |
| `los_tool_errors_total` | counter | — | `run_evals.tool_error_count` |
| `los_model_cost_total` | counter | — | `run_evals.model_cost` |
| `los_provider_calls_total` | counter | `provider` | `provider_call_telemetry` |
| `los_provider_errors_total` | counter | `provider` | `provider_call_telemetry.status >= 400` |
| `los_provider_duration_milliseconds` | gauge | `provider` | `provider_call_telemetry.duration_ms` |
| `los_cache_hit_tokens_total` | counter | — | execution-projection eval rows (`summary_json.cacheHitTokens`) |
| `los_cache_miss_tokens_total` | counter | — | execution-projection eval rows (`summary_json.cacheMissTokens`) |

## Trend verification

- Provider latency trends: `rate(los_provider_duration_milliseconds[1h])` or a
  direct range query over the gauge.
- Cache hit ratio: `los_cache_hit_tokens_total / (los_cache_hit_tokens_total + los_cache_miss_tokens_total)`.
- Task success: `sum(los_task_runs_total{status="succeeded"}) / sum(los_task_runs_total)`.

All queries aggregate persisted PostgreSQL evidence, so they remain valid
across gateway restarts (unlike in-process counters).

## Implementation

- `packages/infra/src/metrics.ts` — Prometheus rendering (no external dependency)
- `packages/gateway/src/routes/infrastructure/metrics-routes.ts` — `/metrics` route
