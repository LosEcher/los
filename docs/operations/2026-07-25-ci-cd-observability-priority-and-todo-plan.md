# CI/CD、可观测与后续开发优先级记录

日期：2026-07-25

父 todo：`todo-los-ci-cd-observability-20260725`

## 结论

当前不应立即开始全仓结构重构，也不应让 runner、缓存和监控优化无限
阻塞产品功能。执行顺序是：

1. 已完成 GitHub 单 root test 改动和 `ci-gate.sh` 失败结果语义修复；
2. 已迁移 GitHub required checks，并校准 ruleset 与 classic branch protection；
3. 先完成 CI/CD 文档、Todo 6 双端交付和产物生命周期的仓库同步；
4. 资源基线继续异步收集到 10 个 unique-head，不占用功能主线；
5. 文档交付后恢复 Execution Lab 的下一功能切片；
6. 只对数据证明存在浪费的 cache、runner 和浏览器安装路径做优化；
7. 结构治理采用触达式原则：功能变更将修改超门限模块时先拆分，否则保持
   独立 P1/P2 任务；
8. 自动 CD 在 exact SHA、不可变产物、审批、健康验证和回滚合同明确前不启用。

## 已验证现状

1. `[E]` Forgejo 是 primary CI。PR 运行 `gate-fast`、`gate-test`、
   `gate-drift` 和 `gate-web-e2e`；重任务依赖 fast gate，过期 ref run 会取消。
2. `[E]` 优化前 GitHub run `30157262347` 的 7 路 package/root matrix 和 retired
   stub 累计约 915 runner-seconds，wall time 约 201 秒，作为历史基线保留。
3. `[E]` Forgejo PR `#64/#65` 和 GitHub PR `#172` 已把 GitHub test matrix
   收敛为一次 root test，并增加 5 秒资源采样。exact-head GitHub run
   `30162236325` 与 Forgejo run `282` 四项全绿。
4. `[E]` GitHub Linux 当前有 5 个 unique-head 样本。五次 workflow
   分别消耗 365、397、389、380、397 runner-seconds，wall time 为 212、226、
   218、204、235 秒，root test command 为 160.261--165.729 秒，swap sampled
   peak 均为 0。第 5 个样本是 PR run `30180609399`，head 为
   `3c90fedd347907d623d41b7d1d87fe1c24f80a64`；后续 main push run
   `30180751162` 是 merge 后运行，不增加 unique-head 分母。相对 915
   runner-seconds 历史基线的暂定节省范围是 56.6%--60.1%，平均 57.9%。样本未
   达到 10 个，不发布 P95，也不据此调整 cache 或 runner 容量。
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
    container。`podman machine list` 仍显示 2048 MiB 的旧 metadata，VM 内有效值
    是 8 CPU、15 GiB memory 和 8 GiB swap；Windows `vmmemWSL` 是共享 WSL
    进程，不能作为单 job RSS。
15. `[E]` 主机空闲时一次 `podman stats --no-stream --format json` 约需 0.59 秒。
    因此 Windows probe 默认 15 秒采样并单独记录 probe wall time 和 observer
    CPU；5 秒采样会产生约 12% 的采样占空比，不作为默认值。
16. `[E]` Forgejo PR `#70` 的 exact-head run `289` 在
    `70aa3d14f2a9e324256fed3aec2ab2ac2c66da59` 上通过 jobs `942--945`，随后以
    `a14fc8751cba847b3a08825bd86ef295438dfd60` 合并。Windows probe 识别 task
    `863`，18 次采样无 unavailable，15 秒间隔占空比 6.496%；task containers
    峰值为 1,237,619,573 bytes、121.44% CPU 和 262 PIDs。共享 WSL working
    set 从 3,761,111,040 bytes 升至 5,110,759,424 bytes，job end 为
    4,553,617,408 bytes，+5 分钟为 2,913,718,272 bytes；page-file used 在
    start、peak、end 和 +5 分钟均为 65,011,712 bytes。
17. `[E]` 同一改动通过独立 GitHub mirror PR `#175`、run `30170606961`，以
    `4ec11f0e6518907cc6f206bf2ea541deba51b0ac` 合并。两端历史不共线，因此使用
    等价 patch 的独立 PR；GitHub 结果不是 Forgejo primary delivery 的前置条件。
18. `[E]` PostgreSQL todo ledger 中
    `todo-los-ci-forgejo-windows-resource-probe` 已为 `done`；6 个明确的 Windows
    raw temp 路径已验证不存在，远端 feature branches 保留且未执行删除。

## 优先级和依赖

| 顺序 | Todo | 状态 | 优先级 | 前置条件 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 1 | `todo-los-ci-github-single-test-rollout` | `done` | P0 | 无 | Forgejo PR `#64/#65`、GitHub PR `#172` 已交付 |
| 2 | `todo-los-ci-gate-result-capture` | `done` | P0 | 无 | Forgejo PR `#66` 已交付，focused 3/3 和 root gate 通过 |
| 3 | `todo-los-ci-github-ruleset-migration` | `done` | P0 | 1 | 双策略面已迁移，exact-head canary 与镜像 merge 已完成 |
| 4 | `todo-los-ci-failure-evidence-lifecycle` | `done` | P1 | 1 | GitHub failure-only 证据已交付；Forgejo 负向 canary 已记录并保持关闭 |
| 5 | `todo-los-ci-superseded-run-control` | `done` | P1 | 1 | GitHub PR `#174` 已证明 replacement run 自动取消旧 run |
| 6 | `todo-los-ci-forgejo-windows-resource-probe` | `done` | P1 | 1 | Forgejo PR `#70` / run `289` 与 GitHub PR `#175` / run `30170606961` 均已合并 |
| 7 | `todo-los-p2-ci-cd-docs` | `in_progress` | P1 | 2、3、4、5 | 当前 change 统一控制面、执行面、证据面和保留策略；双端交付后完成 |
| 8 | `todo-los-ci-resource-baseline` | `in_progress` | P1 | 3 | `5/10` unique-head；异步收集，10 个样本前不发布 P95 或调容量 |
| 9 | `todo-los-execution-experiment-contract` | `ready` | P1 | 1、2 及原有依赖 | 文档交付后的下一功能切片，不等待 10-run 窗口 |
| 10 | `todo-los-p1-turbo-cache` | `backlog` | P1 | 6、8 | 等待资源基线；验证 pnpm cache、Turbo key、Playwright 安装和 coverage 拆分 |
| 11 | `todo-los-daily-agent-product-status-reconciliation` | `ready` | P1 | 无 | 校准长期 P0 父计划状态，不新增功能范围 |
| 12 | `todo-los-cd-release-contract-discovery` | `backlog` | P2 | 7 | 先调研发布合同，不自动部署 |
| 13 | `todo-los-ci-policy-alignment-research` | `backlog` | P2 | 6、8 | Node、audit、E2E required、cgroup、schema 和 store 策略 |

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
10-run 观测窗口或自动 CD 调研。当前先完成 CI/CD 文档交付，随后恢复该功能；
资源基线继续异步推进。

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

最终 exact-head run `289` 样本中，task containers 峰值约 1.24 GB、121.44%
CPU 和 262 PIDs；共享 WSL process set 的 working set 从约 3.76 GB 升至
5.11 GB，job end 约 4.55 GB，+5 分钟约 2.91 GB。page file allocated 5 GiB，
used 在 start、peak、end 和 +5 分钟均约 65 MB；本样本没有换页压力证据。

该探针不进入每个 PR。后续仅对 `gate-test` 每第 5 个 eligible PR 采一次，原始
JSON 在汇总写入 todo/doc 后删除，不上传成功 artifact。Windows 与 GitHub Linux
样本分组统计；GitHub Linux 当前为 `5/10` unique-head，累计 10 个后才计算
P50/P95 和讨论 runner capacity，20 个样本复算。Windows exact-head 样本只能
证明采样可行，不能证明容量长期充足。

## 当前 CI 与交付时序

1. 开发者在单 intent jj change/bookmark 上运行窄检查，再运行交付所需 root gate。
2. 推送 Forgejo feature bookmark 并创建 primary PR。`gate-fast` 与 `gate-drift`
   先启动；`gate-fast` 成功后再放行 `gate-test` 和 `gate-web-e2e`。
3. 只在 exact PR head 的 `gate-fast`、`gate-test`、`gate-drift` 全绿后合并；Web
   E2E 每次执行并保留可见结果，但当前不是 required context。
4. Forgejo merge 是项目交付事实。拉取 `main@origin` 并核对 merge SHA；远端
   bookmark 删除仍需单独 operator consent。
5. 需要维护 GitHub fallback 时，将等价 patch 放入 GitHub PR。两端历史不共线时
   不直接推 `main`，也不把 GitHub run 作为 Forgejo merge 条件。
6. GitHub PR 运行四个独立 job；其 `gate-test` 只执行一次 root `pnpm test`。
   当前 Todo 9 要求双端文档一致，因此 GitHub mirror merge 后才更新 Todo 9 为
   `done`，但这不改变 Forgejo primary 的完成边界。
7. 当前没有自动部署 workflow。release contract、不可变 artifact、审批、健康检查
   和 rollback 验证完成前，CD 只表示 operator-driven delivery，不表示部署。

## 过程产物生命周期

| 类型 | 位置 | 所有者与清理触发 | 成功时 | 失败时 | 上限与保留 |
| --- | --- | --- | --- | --- | --- |
| test、coverage、drift 原始日志 | runner temp | job/runner；job 结束清理 | job 结束即释放 | collector 只取尾部 | 每个输入最多 512 KiB |
| Linux 资源 JSON | GitHub runner temp + job summary | workflow/平台；temp 随 job 清理 | summary 保留小型 JSON | 纳入失败包；未 flush 记 `unavailable` | 5 秒采样；summary 随 run 记录，不单独上传 artifact |
| Playwright trace/截图 | `packages/web/test-results/` | Web E2E job；job 结束清理 | job 结束即释放 | 在总预算内纳入失败包 | 每个 job 总包 10 MiB |
| GitHub failure artifact | GitHub Actions | workflow 创建、GitHub 到期删除 | 不创建 | `gate-test`、E2E、drift 分 job 上传 | 5 天；每包 10 MiB 内容上限 |
| Forgejo artifact canary | Forgejo server | operator 手动触发；实例策略负责到期删除 | 非常规成功产物 | 只验证 1 KiB round trip | 请求 1 天；run `286` 在 action clone 超时且 artifact 为 0，常规上传关闭 |
| Windows host 资源 JSON | Windows temp + todo/doc 汇总 | probe operator；汇总和回读后删除明确路径 | 不上传 CI artifact | 同左；失败也不保留 raw host dump | 15 秒低频 canary；job end 后 5 分钟停止；Todo 6 的 6 个 raw 路径已删除 |
| pnpm store、`.turbo`、`node_modules` | cache/runner | runner owner；仅在容量证据和批准策略下清理 | 按 cache 策略处理 | 禁止作为失败证据 | 不进入 artifact；当前没有自动 prune 合同 |
| release artifact | 尚未定义 | `todo-los-cd-release-contract-discovery` | 不生成 | 不适用 | 无自动 CD、无保留或删除承诺 |

collector 写入 `manifest.json`，对每个来源记录 `included`、`partial`、
`unavailable` 或 `cap_exceeded`。GitHub workflow 被 superseded 后如果 cleanup
step 未执行，平台的 `cancelled` conclusion 就是缺失原因；后续统计不得把它转成
零资源或测试成功。

collector 只读取 workflow 明确列出的文件，不读取环境变量；但它不是通用的内容
脱敏器，因此被采集命令不得把生产凭据或原始会话内容写入日志与 trace。checkout
或 Node setup 之前的失败无法运行仓库内 collector，仍以平台日志为唯一证据面。

## 门禁和策略回滚顺序

1. 发现 context、runner 或 workflow 回归时先停止合并，不先删除当前 required
   context，也不以 GitHub fallback 代替 Forgejo primary。
2. 在 feature bookmark 上恢复最近已验证的 workflow 行为，运行 focused check 和
   root gate，再由 Forgejo exact-head PR 发出旧/新 context。
3. exact-head 全绿后才调整 Forgejo server protection。required context 迁移采用
   “先产生、再要求、最后移除旧 context”的顺序，避免出现无法满足的门禁。
4. GitHub mirror 独立恢复等价 patch，并同时核对 ruleset `17481877` 与 classic
   branch protection；只恢复其中一个策略面会再次造成 `BLOCKED`。
5. artifact 路径有问题时先关闭新的 upload/collector step，再按平台保留期等待或
   由 operator 删除明确对象；不得清空整个 cache、runner temp 根目录或历史 run。
6. 若必须使用 Forgejo emergency bypass，由明确授权的 operator 审计执行；随后立即
   对最终 SHA 手动运行完整 workflow，并记录 bypass、canary 和恢复后的 protection。

## 执行和进度规则

1. 每个 todo 保持一个 change intent；rollout、gate result capture 和远端
   policy migration 已分别记录 change、PR、run 与 merge evidence。
2. `ready` 表示依赖已满足且可以认领；`backlog` 表示等待依赖或调研。
3. 开始任务时改为 `in_progress` 并记录 exact change/bookmark；完成前写入检查、
   run id、artifact 或 API/DB evidence。
4. 远端 ruleset、push、PR、merge、runner 配置和部署继续单独经过 operator
   consent。
5. unique-head 观测窗口是异步任务，不占用产品功能主线；当前 `5/10`，达到 10 个
   样本后计算 P50/P95，20 个样本复算。
6. superseded cancellation 不计 flake；unchanged-head 无代码变更失败后通过才计
   flake。
7. Linux `null` 指标保持 `null`，不得解释为零；GitHub Linux 和 Forgejo
   Windows 数据不合并。

## 验证记录

本轮计划与执行阶段使用以下证据：

- `pnpm run status`：gateway/executor managed、health ok；
- `pnpm run executor:status`：PostgreSQL connected，executor online、
  candidate=true、active=0；
- GitHub API：ruleset `17481877`、classic `main` protection、PR `#172/#175/#176`，
  以及 runs `30157262347`、`30162236325`、`30170606961`、`30180609399`、
  `30180751162`；最后一个是 merge 后 main push，不计入 unique-head；
- Forgejo API：PR `#64/#65/#66/#70`，runs `281/282/283/289`；run `281` 归类为 runner
  outage，不计代码 flake；
- `pnpm check:ci-observer`：6/6 passed；`pnpm check:ci-gate`：3/3 passed；
- `pnpm check:ci-evidence`：4/4 passed，覆盖精确 bundle 大小、缺失输入与 cache
  排除；
- `pnpm check`：passed；当前 `pnpm run gate`：9 phases、0 failures；
- GitHub/Forgejo workflow YAML parse：passed；
- PostgreSQL `todos`：父计划、子任务、状态和依赖已持久化；
- PostgreSQL todo ledger：Todo 1 至 Todo 6 已完成；资源基线为 `in_progress`、
  `5/10` unique-head；CI/CD 文档任务在双端交付前为 `in_progress`。
