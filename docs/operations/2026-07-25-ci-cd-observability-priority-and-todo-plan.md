# CI/CD、可观测与后续开发优先级记录

日期：2026-07-25

父 todo：`todo-los-ci-cd-observability-20260725`

## 结论

当前不应立即开始全仓结构重构，也不应让 runner、缓存和监控优化无限
阻塞产品功能。执行顺序是：

1. 已完成 GitHub 单 root test 改动和 `ci-gate.sh` 失败结果语义修复；
2. 已迁移 GitHub required checks，并校准 ruleset 与 classic branch protection；
3. 在真实 run 中收集 10 个 unique-head 样本，观测任务与产品功能并行；
4. 恢复 Execution Lab 的下一功能切片；
5. 只对数据证明存在浪费的 cache、runner 和浏览器安装路径做优化；
6. 结构治理采用触达式原则：功能变更将修改超门限模块时先拆分，否则保持
   独立 P1/P2 任务；
7. 自动 CD 在 exact SHA、不可变产物、审批、健康验证和回滚合同明确前不启用。

## 已验证现状

1. `[E]` Forgejo 是 primary CI。PR 运行 `gate-fast`、`gate-test`、
   `gate-drift` 和 `gate-web-e2e`；重任务依赖 fast gate，过期 ref run 会取消。
2. `[E]` 优化前 GitHub run `30157262347` 的 7 路 package/root matrix 和 retired
   stub 累计约 915 runner-seconds，wall time 约 201 秒，作为历史基线保留。
3. `[E]` Forgejo PR `#64/#65` 和 GitHub PR `#172` 已把 GitHub test matrix
   收敛为一次 root test，并增加 5 秒资源采样。exact-head GitHub run
   `30162236325` 与 Forgejo run `282` 四项全绿。
4. `[I]` GitHub run `30162236325` 的四个 job 约为 365 runner-seconds，较历史
   基线减少约 60%；wall time 约 215 秒。当前只有一个 unique-head 样本，且
   runner、cache 和依赖状态未归一化，不能把该比例当作稳定收益。
5. `[E]` GitHub ruleset `17481877` 与 classic `main` branch protection 现在都只
   要求 `gate-fast`、`gate-test`、`gate-drift`。两处曾同时保留旧 contexts；只改
   ruleset 后 PR `#172` 仍为 `BLOCKED`，两处迁移后变为 `CLEAN` 并合并。
6. `[E]` `tools/ci-gate.sh` 已在 Forgejo PR `#66` 修复退出码捕获，改用
   `mktemp` 与 `EXIT` 清理，并通过 success、known failure、new failure 三条
   focused 回归路径。旧固定临时日志已删除。
7. `[E]` GitHub workflow 已为 test、critical coverage、Playwright 和 migration
   drift 增加失败日志采集；每个失败包上限 10 MiB、日志单项上限 512 KiB、
   保留 5 天，成功 job 不上传 retained artifact。
8. `[E]` 仓库 workflow 只有 CI、audit 和 canary，没有自动部署 workflow。
   当前交付仍是 operator-driven。
9. `[E]` Daily Agent 父 todo 仍为 `in_progress`，但已列子阶段均为 `done`；
   需要把功能完成和 28 天趋势收集分开表达。
10. `[E]` Execution Lab 的下一个功能任务是
    `todo-los-execution-experiment-contract`，全部五个依赖均已完成，todo 已从
    `backlog` 转为 `ready`。
11. `[E]` Forgejo run-artifact 读 API 返回 HTTP 200，但当前账号读取 user/org
    artifact quota 均为 HTTP 404。常规 Forgejo CI 暂不上传失败包；手动 1 KiB
    upload/download canary 尚待远端执行。

## 优先级和依赖

| 顺序 | Todo | 状态 | 优先级 | 前置条件 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 1 | `todo-los-ci-github-single-test-rollout` | `done` | P0 | 无 | Forgejo PR `#64/#65`、GitHub PR `#172` 已交付 |
| 2 | `todo-los-ci-gate-result-capture` | `done` | P0 | 无 | Forgejo PR `#66` 已交付，focused 3/3 和 root gate 通过 |
| 3 | `todo-los-ci-github-ruleset-migration` | `done` | P0 | 1 | 双策略面已迁移，exact-head canary 与镜像 merge 已完成 |
| 4 | `todo-los-ci-failure-evidence-lifecycle` | `in_progress` | P1 | 1 | GitHub 接入待 exact-head 验证；Forgejo canary 和 quota gap 待记录 |
| 5 | `todo-los-ci-superseded-run-control` | `backlog` | P1 | 1 | 增加 concurrency/cancel，并量化重任务依赖 fast gate 的时间代价 |
| 6 | `todo-los-ci-forgejo-windows-resource-probe` | `backlog` | P1 | 1 | Windows CPU/RSS/page-file 单独建基线 |
| 7 | `todo-los-ci-resource-baseline` | `backlog` | P1 | 3 | 10 个 unique-head 后再判断 cache/runner 调优 |
| 8 | `todo-los-p1-turbo-cache` | `backlog` | P1 | 6、7 | 验证 pnpm cache 重复、Turbo key、Playwright 安装和 coverage 拆分 |
| 9 | `todo-los-p2-ci-cd-docs` | `backlog` | P1 | 2、3、4、5 | 更新为完整控制面、执行面、证据面和保留策略文档 |
| 10 | `todo-los-execution-experiment-contract` | `ready` | P1 | 1、2 及原有依赖 | 依赖均完成，可恢复的下一功能切片 |
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
execution experiment contract。它原先依赖的两个短期本地 P0 已完成，不依赖
10-run 观测窗口或自动 CD 调研，可以在失败证据和资源观测任务异步推进时恢复
功能开发。

### 结构治理

不安排全仓重构。`scheduled-task-runner.ts` 当前为 600 行，已达到阻断门限，并有
对应的 P1 file-size todo；但它不是本次 CI workflow 修改的依赖。只有后续功能需要修改该模块时，才先拆出
职责清晰的子模块并运行 scheduler focused tests；其他 file-size P2 项继续留在
治理队列。

### 环境和配套执行

环境优化分成正确性、证据和性能三层：

1. 正确性 P0 已完成：退出码、required checks 和 exact-head 结果已有回归与
   远端证据，后续变更仍必须维持这些门禁；
2. 失败证据和过期 run 控制是 P1，可以与功能开发并行；
3. cache、runner 容量、Chromium 安装和 coverage 并行策略必须等待观测数据；
4. Prometheus/Grafana 不作为本轮 CI 观测前置条件，先用平台时间戳和小型 JSON；
5. CD 调研不授权部署，生产变更仍需要 operator consent。

## 过程产物生命周期

| 类型 | 位置/所有者 | 成功时 | 失败时 | 上限与保留 |
| --- | --- | --- | --- | --- |
| test、coverage、drift 原始日志 | runner temp | job 结束即释放 | collector 只取尾部 | 每个输入最多 512 KiB |
| Linux 资源 JSON | GitHub runner temp + job summary | summary 保留小型 JSON | 纳入失败包；未 flush 记 `unavailable` | 5 秒采样，不伪造缺失值 |
| Playwright trace/截图 | `packages/web/test-results/` | job 结束即释放 | 在总预算内纳入失败包 | 每个 job 总包 10 MiB |
| GitHub failure artifact | GitHub Actions | 不创建 | `gate-test`、E2E、drift 分 job 上传 | 5 天；每包 10 MiB 内容上限 |
| Forgejo artifact canary | Forgejo server | 仅手动运行 | 验证 1 KiB round trip | 请求保留 1 天；常规上传关闭 |
| pnpm store、`.turbo`、`node_modules` | cache/runner | 按 cache 策略处理 | 禁止作为失败证据 | 不进入 artifact |

collector 写入 `manifest.json`，对每个来源记录 `included`、`partial`、
`unavailable` 或 `cap_exceeded`。GitHub workflow 被 superseded 后如果 cleanup
step 未执行，平台的 `cancelled` conclusion 就是缺失原因；后续统计不得把它转成
零资源或测试成功。

collector 只读取 workflow 明确列出的文件，不读取环境变量；但它不是通用的内容
脱敏器，因此被采集命令不得把生产凭据或原始会话内容写入日志与 trace。checkout
或 Node setup 之前的失败无法运行仓库内 collector，仍以平台日志为唯一证据面。

## 执行和进度规则

1. 每个 todo 保持一个 change intent；rollout、gate result capture 和远端
   policy migration 已分别记录 change、PR、run 与 merge evidence。
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

本轮计划与执行阶段使用以下证据：

- `pnpm run status`：gateway/executor managed、health ok；
- `pnpm run executor:status`：PostgreSQL connected，executor online、
  candidate=true、active=0；
- GitHub API：ruleset `17481877`、classic `main` protection、PR `#172`，以及
  runs `30157262347`、`30162236325`；
- Forgejo API：PR `#64/#65/#66`，runs `281/282/283`；run `281` 归类为 runner
  outage，不计代码 flake；
- `pnpm check:ci-observer`：2/2 passed；`pnpm check:ci-gate`：3/3 passed；
- `pnpm check:ci-evidence`：4/4 passed，覆盖精确 bundle 大小、缺失输入与 cache
  排除；
- `pnpm check`：passed；`pnpm run gate`：9 phases、0 failures、197 秒；
- GitHub/Forgejo workflow YAML parse：passed；
- PostgreSQL `todos`：父计划、子任务、状态和依赖已持久化；
- PostgreSQL todo ledger：Todo 1、Todo 2、Todo 3 均已完成并记录交付证据。
