# Controlled Operator Language — Observation And Weekly Audit

**Status:** active (2026-08-11)  
**Related:** ASD-STE100-inspired STE-lite; ADR 0023 identity; AP9 / AP11  
**Code:** `packages/agent/src/language-contract.ts`,
`packages/agent/src/governance-language-audit.ts`

## Purpose

Agent identity previously carried only style adjectives
(`direct, evidence-based, precise`). That does not constrain output wording.
This surface defines:

1. **Contract** — Controlled Operator Language injected into identity prompts.
2. **Observation** — deterministic scores over recent agent outputs.
3. **Weekly job** — `language_audit` governance job that detects drift and
   opens dimension todos when thresholds fail.
4. **Cadence promotion** — start weekly; promote to monthly after clean windows.

## Contract (what agents must follow)

Source of truth: `language-contract.ts` (`LANGUAGE_CONTRACT_VERSION`).

| Level | Injection |
| --- | --- |
| `standard` / `full` | Full `## Language` block via `formatIdentityForPrompt` |
| `minimal` | One-line FINDING \| EVIDENCE \| STATUS rules |
| `none` | No language block (judge / verifier) |

Summary rules in `loop/message-builder.ts` align with the same markers so tool
mode prompts do not reintroduce “clear summary” without evidence discipline.
`SYSTEM_PROMPT_VERSION` is bumped when this prompt path changes (AP11).

## Observation surfaces

| Surface | What it stores | Use |
| --- | --- | --- |
| Identity / system prompt | Language block text | Runtime behavior |
| `language_contract_snapshots` | Weekly (or monthly) metrics + findings | Trend / promotion |
| `governance_jobs` row `language_audit` | `result_summary_json`, cadence, next_run | Ops control |
| Governance todos | Dimension todos when thresholds fail | Operator backlog |
| `session_events` `governance.job.*` | Job start/complete | Sweep ledger |

### Metrics (per window)

Computed by `scoreLanguageContract` + `aggregateLanguageScores` on samples from:

1. `run_specs.result_json->>'text'` (full final text when present)
2. `session_events` `model.response` `payload.textPreview` (bounded preview)

| Metric | Meaning |
| --- | --- |
| `evidenceMarkerRate` | Share of samples with at least one `[E]`/`[I]`/`[U]` |
| `bareCompletionClaimRate` | Share with fixed/shipped/verified/done without nearby pointer |
| `processNarrationRate` | Share with “Let me…”, “Spawning…”, etc. |
| `avgHedge` | Mean hedge-word count |
| `meanCompliance` | Mean 0–1 compliance score |

Default thresholds (job `config.thresholds`, overridable):

```json
{
  "evidenceMarkerRateMin": 0.10,
  "bareCompletionClaimRateMax": 0.15,
  "processNarrationRateMax": 0.30,
  "avgHedgeMax": 8,
  "meanComplianceMin": 0.45
}
```

Markers are new — start low, tighten after a few clean weeks of data.

## Weekly job

Seeded as:

| Field | Value |
| --- | --- |
| `jobType` | `language_audit` |
| `cadence` | `weekly` (≈6.5d threshold) |
| `dedupeKey` | `gov-job-language-audit` |
| `autoFix` | none (detection + todos only) |

Config knobs:

| Key | Default | Meaning |
| --- | --- | --- |
| `lookbackDays` | 7 | Sample window |
| `sampleLimit` | 80 | Max texts scored |
| `minTextChars` | 40 | Ignore tiny previews |
| `minSamplesForThresholds` | 8 | Below this → `insufficient_samples` info only |
| `promoteAfterCleanRuns` | 4 | Clean windows before monthly recommendation |
| `autoPromoteCadence` | false | When true, set cadence to `monthly` after clean streak |
| `promoteToCadence` | monthly | Target cadence after promotion |
| `thresholds` | see above | Rate floors/ceilings |

### Findings → todos

| Dimension | Priority | Operator action |
| --- | --- | --- |
| `missing_evidence_markers` | P2 | Tighten closeout / identity Language block |
| `bare_completion_claims` | P1 | Ban bare fixed/shipped in prompts; self-check later |
| `process_narration` | P2 | Child minimal language / maxLoops narrative waste |
| `low_compliance` | P1 | Review mean score; adjust contract or models |
| `hedge_density` | P3 | Soft style drift |
| `insufficient_samples` | P3 | Need more real traffic |
| `cadence_promotion_ready` | P3 | Switch weekly → monthly (or enable autoPromote) |

## Cadence plan

```text
Week 0–N:  cadence=weekly, lookbackDays=7
  collect snapshots; tune thresholds from real rates
After promoteAfterCleanRuns clean windows (default 4):
  finding cadence_promotion_ready (info)
  optional autoPromoteCadence=true → cadence=monthly (28d)
Later: keep monthly; raise evidenceMarkerRateMin if compliance is stable
```

Manual override:

```bash
# Inspect job
# (via governance API / DB) job_type = language_audit

# Force monthly without waiting for streak
# UPDATE governance_jobs SET cadence = 'monthly' WHERE dedupe_key = 'gov-job-language-audit';

# Re-seed missing job after deploy
# gateway/ensure path calls seedGovernanceJobs on startup
```

## Manual run / verification

```bash
# Pure scoring unit tests
pnpm --filter @los/agent exec node --import tsx --test src/language-contract.test.ts

# DB-backed audit (needs local postgres)
pnpm --filter @los/agent exec node --import tsx --test src/governance-language-audit.test.ts

# Identity prompt contains Language block
pnpm --filter @los/agent exec node --import tsx --test src/identity-loader.test.ts
```

Inspect latest snapshot:

```sql
SELECT created_at, sample_count, finding_count,
       metrics_json->>'evidenceMarkerRate' AS marker_rate,
       metrics_json->>'meanCompliance' AS compliance,
       cadence_recommendation
FROM language_contract_snapshots
ORDER BY created_at DESC
LIMIT 5;
```

## Non-goals

- Full ASD-STE100 approved dictionary in the system prompt.
- Auto-rewriting agent prose.
- Language scoring as a hard gate on `succeeded` (AP3 stays verification-based).
- Injecting language rules into self-check judge / verifier identity (level `none`).

## Residual risks

1. `model.response` only stores `textPreview` (~500 chars) — rates under-read long tails.
2. Child results in `result_json` are sparse until more paths persist text.
3. Early weeks may emit `insufficient_samples` until real traffic accumulates.
4. Auto-promote is off by default so operators control monthly switch.
