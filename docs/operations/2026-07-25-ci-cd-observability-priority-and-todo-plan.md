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
    artifact quota 均为 HTTP 404。手动 1 KiB canary run `286` 在上传前 clone
    `forgejo/upload-artifact@v4` 超时，job `933` 于 301 秒失败且 artifact 为 0；
    常规 Forgejo CI 继续关闭失败包上传。
12. `[E]` GitHub run `30167769845` 是 superseded-run 浪费样本：fast、drift、
    Web E2E 已完成，root test 已执行 92 秒后取消。该 run 不计为 flake。
13. `[E]` GitHub PR `#174` 的 replacement run `30168665660` 启动后，旧 run
    `30168647767` 自动变为 `cancelled`；旧 run 约消耗 159 runner-seconds，且
    root test 尚未开始。replacement run 四项全绿并以
    `d1e710ad6621f7e3d13b580dd36ae315c29a2be2` 合并。
14. `[E]` Forgejo runner host 是 Windows，job runtime 是 Linux/amd64 Podman
    container。`podman machine inspect` 返回单元素数组，当前 machine 配置为
    8 CPU、2048 MiB；Windows `vmmemWSL` 是共享 WSL 进程，不能作为单 job RSS。
15. `[E]` 主机空闲时一次 `podman stats --no-stream --format json` 约需 0.59 秒。
    因此 Windows probe 默认 15 秒采样并单独记录 probe wall time 和 observer
    CPU；5 秒采样会产生约 12% 的采样占空比，不作为默认值。
16. `[E]` Forgejo PR `#70` 的 run `288` / job `939` 在 head
    `5fee1097c0cffb9506b48c727e332a89e78f820f` 全绿。Windows probe 识别 task
    `859`，覆盖约 240 秒的 `gate-test` 和结束后 300 秒；18 次采样无
    unavailable，平均 probe 0.99 秒、15 秒间隔占空比 6.60%，observer 自身
    累计 CPU 4.98 秒。

## 优先级和依赖

| 顺序 | Todo | 状态 | 优先级 | 前置条件 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 1 | `todo-los-ci-github-single-test-rollout` | `done` | P0 | 无 | Forgejo PR `#64/#65`、GitHub PR `#172` 已交付 |
| 2 | `todo-los-ci-gate-result-capture` | `done` | P0 | 无 | Forgejo PR `#66` 已交付，focused 3/3 和 root gate 通过 |
| 3 | `todo-los-ci-github-ruleset-migration` | `done` | P0 | 1 | 双策略面已迁移，exact-head canary 与镜像 merge 已完成 |
| 4 | `todo-los-ci-failure-evidence-lifecycle` | `done` | P1 | 1 | GitHub failure-only 证据已交付；Forgejo 负向 canary 已记录并保持关闭 |
| 5 | `todo-los-ci-superseded-run-control` | `done` | P1 | 1 | GitHub PR `#174` 已证明 replacement run 自动取消旧 run |
| 6 | `todo-los-ci-forgejo-windows-resource-probe` | `in_progress` | P1 | 1 | PR `#70` run `288` 已完成 canary，等待当前 head CI 与合并证据 |
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

## Forgejo Windows 资源观测合同

`tools/observe-windows-runner-resources.ps1` 只从 Windows host 手动运行，等待
`FORGEJO-ACTIONS-TASK-<id>...JOB-gate-test` 容器出现和退出。输出保持三个层次：

1. `windowsHost`：物理内存和 page-file start、sampled peak、end、+5 分钟；
2. `podmanVmHostProcesses`：`vmmemWSL`、`wslservice`、`wslhost`、`wslrelay`
   的共享进程集合，不宣称是单 job RSS；
3. `podmanTaskContainers`：同一 Forgejo task 的 job 和 service containers 聚合，
   用于单次 run 的 CPU、memory 和 PIDs 近似值。

run `288` 样本中，task containers 峰值约 1.32 GB、101.7% CPU 和 269 PIDs；
共享 WSL process set 的 working set 从约 4.00 GB 升至 4.65 GB，job end 约
4.07 GB，+5 分钟约 2.88 GB。page file allocated 5 GiB，used 在 start、peak、
end 和 +5 分钟均约 62 MiB；本样本没有换页压力证据。

该探针不进入每个 PR。后续仅对 `gate-test` 每第 5 个 eligible PR 采一次，原始
JSON 在汇总写入 todo/doc 后删除，不上传成功 artifact。Windows 与 GitHub Linux
样本分组统计；累计 10 个 unique-head 后才计算 P50/P95 和讨论 runner capacity，
20 个样本复算。当前单样本只能证明采样可行，不能证明容量长期充足。

## 过程产物生命周期

| 类型 | 位置/所有者 | 成功时 | 失败时 | 上限与保留 |
| --- | --- | --- | --- | --- |
| test、coverage、drift 原始日志 | runner temp | job 结束即释放 | collector 只取尾部 | 每个输入最多 512 KiB |
| Linux 资源 JSON | GitHub runner temp + job summary | summary 保留小型 JSON | 纳入失败包；未 flush 记 `unavailable` | 5 秒采样，不伪造缺失值 |
| Playwright trace/截图 | `packages/web/test-results/` | job 结束即释放 | 在总预算内纳入失败包 | 每个 job 总包 10 MiB |
| GitHub failure artifact | GitHub Actions | 不创建 | `gate-test`、E2E、drift 分 job 上传 | 5 天；每包 10 MiB 内容上限 |
| Forgejo artifact canary | Forgejo server | 仅手动运行 | 验证 1 KiB round trip | 请求保留 1 天；常规上传关闭 |
| Windows host 资源 JSON | Windows temp + todo/doc 汇总 | 汇总后删除 raw JSON | 不上传 CI artifact | 15 秒低频 canary；job end 后 5 分钟停止 |
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
- `pnpm check:ci-observer`：6/6 passed；`pnpm check:ci-gate`：3/3 passed；
- `pnpm check:ci-evidence`：4/4 passed，覆盖精确 bundle 大小、缺失输入与 cache
  排除；
- `pnpm check`：passed；当前 `pnpm run gate`：9 phases、0 failures；
- GitHub/Forgejo workflow YAML parse：passed；
- PostgreSQL `todos`：父计划、子任务、状态和依赖已持久化；
- PostgreSQL todo ledger：Todo 1 至 Todo 5 已完成；Todo 6 保持 `in_progress`，
  Windows host canary 证据将在 delivery 阶段写入后回读。
