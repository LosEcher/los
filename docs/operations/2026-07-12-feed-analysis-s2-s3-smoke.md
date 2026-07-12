# Feed Analysis S2/S3 Cross-Repository Smoke

Date: 2026-07-12  
Runtime: local LOS gateway/executor + lot2extension Docker backend + DeepSeek

## Scope

This smoke verifies persisted runtime behavior for the LOS-owned portion of the
lot2extension feed-analysis integration. It does not verify extension UI,
editor insertion, or publishing behavior.

## Runtime Evidence

- LOS gateway `127.0.0.1:8080`: healthy and ready.
- LOS executor `127.0.0.1:8090`: healthy, `mbp-executor-1` online.
- lot2extension backend `127.0.0.1:8086`: `/health` returned `200`.
- Provider/model: `deepseek` / `deepseek-v4-flash`.

## Successful Dispatches

| Scenario | lot2 job | LOS dispatch | Workflow | Result |
| --- | ---: | --- | --- | --- |
| `evidence_batch` | 36 | `fa-3d18119a-86fd-41b7-a3d3-0155610e6ea7` | `lot2.batch-summary@1.0.0` | completed, one `content_brief`, result available |
| `research_topic` | 37 | `fa-fd72c6d0-411b-482e-8851-9869d3c3b892` | `lot2.research-topic@1.0.0` | completed, digest + brief + three platform drafts, result available |

S3 callback sequence was:

```text
accepted -> queued -> processing -> planner -> analyst -> synthesis -> writer -> verifier -> completed
```

All four S2 callback deliveries and all nine S3 callback deliveries returned
HTTP `200` on the first attempt. LOS and lot2extension persisted the same
terminal status, snapshot identity, result availability, and artifact set.

## Provider Contract Finding

The first runtime attempt exposed two provider-shape deviations:

1. S2 returned the requested `content_brief` plus unsupported `insight` and
   `agreement_matrix` artifacts.
2. S3 combined X, Zhihu, and Xiaohongshu drafts into one `platform_draft`
   without a scalar platform.

LOS now gives an exact artifact allowlist and per-platform shape, discards
unrequested provider extensions with a warning, and preserves only contract
artifacts. The successful jobs above ran after that fix.

## Evidence Boundary

The initial S3 result showed workspace-derived warnings even though the
dispatch supplied locked evidence and did not authorize external research.
The research graph now sends `allowedTools: []` for every stage and explicitly
instructs stages to use only locked material and prior stage output. The focused
executor harness verifies all five requests carry the empty allowlist.

External retrieval remains intentionally unavailable until a dedicated tool
policy and provider compatibility harness are approved.

## Callback Dead-Letter Replay

The operator replay API successfully moved five historical callback deliveries
for lot2 jobs 25 and 26 back to `pending` without changing their immutable event
IDs. lot2extension returned HTTP `500` for every replayed historical event, so
LOS retried them to the configured attempt limit and returned all five to
`dead_letter`. Current callback totals are 49 delivered and 5 dead-lettered.

This proves LOS replay, lease, retry, and re-dead-letter behavior. Clearing the
five historical entries requires lot2extension to accept or explicitly
acknowledge those stale events; LOS must not mark them delivered without a 2xx
response.

## Checks

```text
feed-analysis-integration.test.ts: 6 passed
research_deep focused tool-boundary test: passed
pnpm check: passed
./tools/check-contracts.sh: passed
```

The full `pnpm run gate` was not rerun in this smoke. Its previous test phase
was blocked by the unrelated executor file-sync heartbeat timestamp test.
