# CI/CD、可观测与后续开发优先级记录

日期：2026-07-25

父 todo：`todo-los-ci-cd-observability-20260725`

## 结论

当前不应立即开始全仓结构重构，也不应让 runner、缓存和监控优化无限
阻塞产品功能。执行顺序是：

1. 完成当前 GitHub 单 root test 改动并修复 `ci-gate.sh` 的失败结果语义；
2. 迁移 GitHub required checks，确保本地 workflow 与远端 ruleset 一致；
3. 在真实 run 中收集 10 个 unique-head 样本，观测任务与产品功能并行；
4. 恢复 Execution Lab 的下一功能切片；
5. 只对数据证明存在浪费的 cache、runner 和浏览器安装路径做优化；
6. 结构治理采用触达式原则：功能变更将修改超门限模块时先拆分，否则保持
   独立 P1/P2 任务；
7. 自动 CD 在 exact SHA、不可变产物、审批、健康验证和回滚合同明确前不启用。

## 已验证现状

1. `[E]` Forgejo 是 primary CI。PR 运行 `gate-fast`、`gate-test`、
   `gate-drift` 和 `gate-web-e2e`；重任务依赖 fast gate，过期 ref run 会取消。
2. `[E]` GitHub 远端 `main` 仍运行 7 路 package/root matrix 和 retired stub。
   run `30157262347` 累计约 915 runner-seconds，wall time 约 201 秒。
3. `[E]` 本地 jj change `zzyyontnwmqo` 已把 GitHub test matrix 收敛为一次 root test，
   并增加 5 秒资源采样；该 change 尚未提交、推送或上线。
4. `[I]` 按同一 run 的阶段时长估算，新结构约消耗 393 runner-seconds，减少
   约 57%；critical coverage 串行后 wall time 可能增加约十几秒。必须由上线后
   样本验证，不能把估算写成已实现收益。
5. `[E]` GitHub ruleset `17481877` 仍要求旧 matrix contexts 和
   `gate-test (input-preprocessor)`，不能直接切换 workflow 后继续满足旧规则。
6. `[E]` `tools/ci-gate.sh` 在 `set -e` 下直接执行可能失败的测试命令，随后才
   读取 `$?`；失败时 known/new failure 分类可能不可达。它还使用固定
   `/tmp/los-test-output.txt`，没有并发隔离和自动清理。
7. `[E]` Playwright 已产生失败 trace/截图，但 CI 没有上传步骤；资源 JSON
   当前只进入 runner temp 和 GitHub job summary。
8. `[E]` 仓库 workflow 只有 CI、audit 和 canary，没有自动部署 workflow。
   当前交付仍是 operator-driven。
9. `[E]` Daily Agent 父 todo 仍为 `in_progress`，但已列子阶段均为 `done`；
   需要把功能完成和 28 天趋势收集分开表达。
10. `[E]` Execution Lab 的下一个功能任务是
    `todo-los-execution-experiment-contract`，原有三个依赖均已完成。

## 优先级和依赖

| 顺序 | Todo | 状态 | 优先级 | 前置条件 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 1 | `todo-los-ci-github-single-test-rollout` | `in_progress` | P0 | 无 | 完成当前单一 intent，避免继续堆叠工作区变更 |
| 2 | `todo-los-ci-gate-result-capture` | `ready` | P0 | 无 | 修复 gate 结果正确性；作为独立 bounded change |
| 3 | `todo-los-ci-github-ruleset-migration` | `backlog` | P0 | 1 | 远端 operator action；需要 before/after 和 exact-head canary |
| 4 | `todo-los-ci-failure-evidence-lifecycle` | `backlog` | P1 | 1 | 失败证据保留 3-7 天，成功 run 不上传大型产物 |
| 5 | `todo-los-ci-superseded-run-control` | `backlog` | P1 | 1 | 增加 concurrency/cancel，并量化重任务依赖 fast gate 的时间代价 |
| 6 | `todo-los-ci-forgejo-windows-resource-probe` | `backlog` | P1 | 1 | Windows CPU/RSS/page-file 单独建基线 |
| 7 | `todo-los-ci-resource-baseline` | `backlog` | P1 | 3 | 10 个 unique-head 后再判断 cache/runner 调优 |
| 8 | `todo-los-p1-turbo-cache` | `backlog` | P1 | 6、7 | 验证 pnpm cache 重复、Turbo key、Playwright 安装和 coverage 拆分 |
| 9 | `todo-los-p2-ci-cd-docs` | `backlog` | P1 | 2、3、4、5 | 更新为完整控制面、执行面、证据面和保留策略文档 |
| 10 | `todo-los-execution-experiment-contract` | `backlog` | P1 | 1、2 及原有依赖 | 两个本地 P0 完成后恢复的下一功能切片 |
| 11 | `todo-los-daily-agent-product-status-reconciliation` | `ready` | P1 | 无 | 校准长期 P0 父计划状态，不新增功能范围 |
| 12 | `todo-los-cd-release-contract-discovery` | `backlog` | P2 | 9 | 先调研发布合同，不自动部署 |
| 13 | `todo-los-ci-policy-alignment-research` | `backlog` | P2 | 6、7 | Node、audit、E2E required、cgroup、schema 和 store 策略 |

依赖关系：

```text
single-test-rollout ──> ruleset-migration ──> resource-baseline
        │                                          │
        ├──> failure-evidence                      ├──> turbo/cache tuning
        ├──> superseded-run-control                └──> policy research
        └──> Windows resource probe ───────────────────> turbo/cache tuning

ci-gate-result-capture ───────────────┐
single-test-rollout ──────────────────┴──> execution-experiment-contract

gate-result + ruleset + evidence + run-control ──> CI/CD docs
CI/CD docs ──> release-contract discovery
```

## 功能、结构和环境的取舍

### 功能开发

当前两个长期 P0 父计划是 Daily Agent 和 Execution Lab。Daily Agent 的已列
实现子阶段均已完成，首先需要状态核对；真正的下一功能切片是 Execution Lab 的
execution experiment contract。它只被两个短期本地 P0 阻塞，不依赖 10-run
观测窗口或自动 CD 调研。

### 结构治理

不安排全仓重构。`scheduled-task-runner.ts` 当前为 600 行，已达到阻断门限，并有
对应的 P1 file-size todo；但它不是本次 CI workflow 修改的依赖。只有后续功能需要修改该模块时，才先拆出
职责清晰的子模块并运行 scheduler focused tests；其他 file-size P2 项继续留在
治理队列。

### 环境和配套执行

环境优化分成正确性、证据和性能三层：

1. 正确性是 P0：退出码、required checks 和 exact-head 结果必须可信；
2. 失败证据和过期 run 控制是 P1，可以与功能开发并行；
3. cache、runner 容量、Chromium 安装和 coverage 并行策略必须等待观测数据；
4. Prometheus/Grafana 不作为本轮 CI 观测前置条件，先用平台时间戳和小型 JSON；
5. CD 调研不授权部署，生产变更仍需要 operator consent。

## 执行和进度规则

1. 每个 todo 保持一个 change intent；当前 `zzyyontnwmqo` 不混入
   `ci-gate.sh` 修复。
2. `ready` 表示依赖已满足且可以认领；`backlog` 表示等待依赖或调研。
3. 开始任务时改为 `in_progress` 并记录 exact change/bookmark；完成前写入检查、
   run id、artifact 或 API/DB evidence。
4. 远端 ruleset、push、PR、merge、runner 配置和部署继续单独经过 operator
   consent。
5. unique-head 观测窗口是异步任务，不占用产品功能主线；达到 10 个样本后计算
   P50/P95，20 个样本复算。
6. superseded cancellation 不计 flake；unchanged-head 无代码变更失败后通过才计
   flake。
7. Linux `null` 指标保持 `null`，不得解释为零；GitHub Linux 和 Forgejo
   Windows 数据不合并。

## 验证记录

本轮计划阶段使用以下证据：

- `pnpm run status`：gateway/executor managed、health ok；
- `pnpm run executor:status`：PostgreSQL connected，executor online、
  candidate=true、active=0；
- GitHub API：ruleset `17481877` 和 run `30157262347`；
- `pnpm check:ci-observer`：2/2 passed；
- GitHub/Forgejo workflow YAML parse：passed；
- PostgreSQL `todos`：父计划、子任务、状态和依赖已持久化；
- `jj status`：当前 CI change 未提交，未触发任何 delivery action。
