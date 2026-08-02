# Sample-Gate Sample Production Strategy — 2026-08-04

> 决策与操作流程。规划关联:`todo-los-execution-pairwise-sample-gate`(#131 机制
> 已落地)、`todo-los-execution-optimization-analysis`(P2,资格由 gate 解锁)。

## 策略决策

| 维度 | 决策 | 理由 |
| --- | --- | --- |
| 样本来源 | 每个 execution experiment 的 source(baseline)+ candidate 对 | 契约强制 pair 匹配实验 source/candidate(`validateExperimentPair`),来源天然受控 |
| 证据通道 | **deterministic 为主**(自动提取),human/judge 可后补 | 自动可重复;sample-gate 只要求 ≥1 通道;人工补充经 `POST /run-evals/pairwise` |
| 生产方式 | **半自动脚本** `tools/pairwise-sample-ingest.mts`(幂等重跑) | 全自动收集器需 scheduler 变更(谨慎推迟);脚本即操作流程,可进 CI/定时 |
| 归类 | pair `summary.scenarioId` 匹配 gate scenario | gate 评估按 scenario 覆盖计数 |
| 自动化边界 | 不自动注册 gate 阈值(operator 决策面) | 正式 gate 由 operator 按真实样本量注册 |

## 操作流程

```bash
# 1) 为实验生成 pairwise 样本(从 DB 提取 kernel/token/loop 证据)
./packages/gateway/node_modules/.bin/tsx tools/pairwise-sample-ingest.mts \
  --experiment <experimentId> --scenario <scenarioId> [--verdict baseline|candidate|tie|inconclusive]

# 2) (可选)让 baseline 也真实执行:gateway 的 run-resume-recovery 会自动 dispatch
#    plan_approved 且未执行的 source run(2026-08-03 已验证:source 被 LOS kernel
#    执行并产生 kernel 证据)——或经 POST /runs/:id/approve 流程显式调度。

# 3) 注册 gate(契约:scenarios 需 label;refs 需 experimentId+runSpecId)
curl -X POST http://127.0.0.1:8080/pairwise-sample-gates \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<gate-id>","minimumPairs":N,"scenarios":[{"id":"<s>","label":"<l>","requiredPairs":M}],
       "baselineRef":{"experimentId":"<e>","runSpecId":"<baseline-run>"},
       "candidateRef":{"experimentId":"<e>","runSpecId":"<candidate-run>"},
       "rubricRef":{"id":"rubric-k4-kernel-planning","revision":"v1"}}'

# 4) 评估
curl -X POST http://127.0.0.1:8080/pairwise-sample-gates/<gate-id>/evaluate \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{}'
```

## 首个真实样本(2026-08-04 验证)

| 项 | 值 |
| --- | --- |
| Experiment | `experiment-k4-canary-20260803d`(pi@0.81.1+los.3 planning) |
| Baseline(LOS kernel) | `run-k4-source-1785704633832` — 1 轮,221 completion tokens,textLength 267(kernel 证据由 run-resume-recovery 自动 dispatch 产生) |
| Candidate(Pi kernel) | `run-experiment-k4-canary-20260803d-candidate` — 1 轮,287 completion tokens,textLength 364 |
| Verdict | **tie**(deterministic 对比 20:20) |
| Demo gate | `sample-gate-k4-20260803`(minimumPairs=1)→ **passed**,`optimizationAnalysisEligible=true` |

## 后续

1. 正式 gate:等更多实验对(如 inspection disposition canary、或新实验)后由
   operator 注册真实阈值;demo gate 仅验证管道。
2. human/judge 通道补充:对关键 pair 经 `POST /run-evals/pairwise` 增补
   (contract 校验 criterionScores 引用 rubric criteria)。
3. 自动化评估(候选 run 完成后自动 ingest)作为可选增强,需 scheduler 变更
   + harness,推迟到正式 gate 阈值确认后。
