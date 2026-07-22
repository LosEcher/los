# Pi Kernel Shadow Scenario Corpus Baseline

- Date: 2026-07-22
- Scope: K3 preregistration and current persisted-evidence report
- Candidate: Pi `0.81.1`, execution-kernel protocol `0.1.0`
- Corpus: `1.0.0`
- Rubric: `pi-shadow-readonly-v1`

## Observed

`pnpm --filter @los/agent scenario:pi-shadow` read the existing
`kernel.shadow.compared` events without executing either kernel or calling a
provider. The report returned `collecting` `[E]`.

| Scenario | Evidence class | Required | Passing | Failing |
| --- | --- | ---: | ---: | ---: |
| `PKS01-no-tool` | deterministic | 1 | 0 | 0 |
| `PKS01-no-tool` | live provider | 3 | 0 | 0 |
| `PKS02-read-only-tool` | deterministic | 1 | 0 | 0 |
| `PKS02-read-only-tool` | live provider | 3 | 0 | 0 |
| `PKS03-policy-denial` | deterministic | 3 | 0 | 0 |
| `PKS04-provider-failure` | deterministic | 3 | 0 | 0 |
| `PKS05-interruption` | deterministic | 3 | 0 | 0 |

The report observed zero qualifying records and ignored one record `[E]`. The
ignored record is the earlier live no-tool smoke. It contains exact kernel
identity and output hashes, but it predates corpus preregistration and therefore
has no scenario version, rubric revision, or fixed assertions.

## Judgment

The corpus and aggregation mechanism are implemented, but K3 evidence
collection is not complete. The old smoke remains valid feasibility evidence;
it is not promotion evidence. `ready_for_k4_policy_review` requires all 17
fixed observations to pass for the exact candidate and protocol version with no
failing observation in any required cell.

Even a ready report cannot register Pi or start a canary. K4 still requires a
separate operator decision, persisted candidate run spec, operator-visible
rollback, and formal pairwise records through
`los.execution-pairwise-eval`.
