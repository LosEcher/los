# 集群滚动发布：现状缺陷与推荐设计

Date: 2026-10-07
缘起：2026-10-06 一晚做了 4 次全集群滚动，每次都在不同地方出问题。本文把证据整理成设计结论。
一句话：**不要在编排层做「步骤」，要在节点上做「收敛」。** 我写的是命令序列，正确范式是
面向期望状态的 reconcile —— 两者的差别正好是每一次事故的形态。

## 1. 今晚的实际做法（反面教材）

四个手写脚本（`/tmp/converge-all.sh`、`converge2.sh`、`rollout-all.sh`、`roll2.sh`），
逐平台内联分支，promote 不等待不复核，失败继续往下推，target_version 手工 UPDATE。
问题不在于"脚本写得糙"，而在于**范式选错了**：用命令序列去操作一份固定节点清单。

## 2. 七个缺陷（每条都有当晚证据）

| # | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| 1 | 成功判据是「命令跑完」而非「节点收敛」 | tencent-sin 半截树导致执行器崩溃掉线；vultr「树到了但 `.env` 没盖章」 | 假成功，故障延后发现 |
| 2 | 同一件事两套实现（仓库工具 vs /tmp 脚本） | 我给 `deploy-to-remote.sh` 修完 locale 与摘要断言，/tmp 脚本仍带着旧逻辑 | 必然漂移，修一处不修另一处 |
| 3 | 平台分支内联在编排器里 | Windows/macOS 的手写 heredoc：别名密钥陷阱、`.env` 重复追加 | 加一种节点就要改编排器；最易错的代码藏在最不可评审的地方 |
| 4 | **不 drain 就重启** | 今晚 8 台恰好都 idle 才没出事 | 有在飞任务时会直接中断（纯属运气） |
| 5 | promote 不等待、不复核 | tencent-sin 的 promote 静默返回空，注册表留在 offline，我事后手动补 | 节点"滚完了但不接活" |
| 6 | 失败继续往下推（非 fail-fast） | 一处 DB 故障后我把 8 台全滚一遍，留下混合版本 | 一次故障放大成全集群不确定状态 |
| 7 | 无锁 / 无计划 / 无状态 / 无报告 | 我确实并发跑了两个滚动（converge 与修复循环撞在一起）；进度只能读 stdout 猜；`target_version` 手工 UPDATE 我还写错过一次 | 不可重入、不可审计、不可并行 |

## 3. 推荐设计：reconciler，不是脚本

三条原则：

1. **状态从节点读，不从本地进度文件读** —— 期望态 = `(digest, target_version)`；实际态 =
   `/health.version` + 注册表 `version/status` + 磁盘 digest。四者可观测，所以进度是可推导的，
   不需要"我走到第几步了"这种脆弱记忆。
2. **每一步的成功判据是节点上的可观测事实**，不是命令的退出码。
3. **幂等 + 可重入**：任何时刻中断，重跑都应从当前实际态继续，而不是从头再来一遍。

### 编排器：`tools/los-fleet-rollout.sh`（仓库内、随摘要一起下发）

```text
--plan                 只打印计划（每台：当前 digest、目标、需要的动作、能力前置），不改任何东西
--canary               先滚 1 台并等待 ≥2 个心跳周期，通过后再放行
--batch-size N         每批 N 台，批间停顿
--resume               从当前实际态继续（默认行为，--resume 只是显式化）
--node <id>            只处理一台
--continue-on-error    默认 **fail-fast**：任一台失败即中止整波，保留剩余节点不动
```

每节点的固定步骤（顺序不可调换）：

```text
preflight   网关健康 + DB 可用；不满足直接拒绝开跑（今晚就是控制面半死时还在推）
drain       置 draining，等 activeTaskCount=0（超预算则跳过该节点而不是硬重启）
sync        upload-then-extract：scp → 双侧 sha256 → 节点本地解包（**不要 tar 管道**）
install     按需 pnpm install
activate    daemon-reload + restart（systemd / launchd / Windows 服务）
verify      digest == 目标 且 /health.version == 目标 且 端口在听 且 GATEWAY_URL 可达 且 注册表可见
promote     promote 后**复核仍为 online**，否则重试/报错
record      写 target_version（只有走到这里才写）
```

### 平台驱动与编排解耦

```text
tools/deploy-drivers/linux-systemd     tools/deploy-drivers/macos-launchd
tools/deploy-drivers/windows-service
```

编排器只按平台派发"activate/verify"两步，不再内联任何 heredoc。新增节点类型 = 新增一个驱动文件。

### 运行纪律

- **一把锁**（`flock`），阻止并发滚动（今晚真的撞过一次）
- **JSON 运行报告**（每台：目标/实际/动作/结果/耗时/失败原因），任一失败则非零退出
- 报告交给 `los-fleet-consistency.sh` 与治理日报，让"滚没滚完"变成**可查询事实**

## 4. 落地清单（按性价比排序）

1. **把 upload-then-extract 做进 `deploy-to-remote.sh`**（`LOS_DEPLOY_SYNC_MODE=upload`，默认
   upload）。今晚所有半截树都出自 `cat tar | ssh … 'tar xzf -'` 这条管道，而 scp + 双侧 sha256
   在两个沙箱/多平台实测里从未失败过。**改一处收益最大。**
2. **把 /tmp 编排脚本搬进仓库**，改成 reconcile + `--plan` + fail-fast + 锁 + JSON 报告。
3. **平台驱动脚本化**，编排器不再内联 heredoc。
4. **canary 强制化**：第一台单独滚 + 等 ≥2 个心跳周期；这也是金丝雀（vultr）今晚两次救场的
   原因 —— 它先暴露了 locale 误删与 promote 复核失效。
5. **禁止手工 UPDATE `target_version`**：它必须由 rollout 写；否则"声明目标"与"实际目标"会分叉
   （我写错过一次，制造了一次假不一致）。
6. **preflight 拒绝在控制面不健康时开跑**：网关/DB 不健康时，rollout 既无法 verify 也无法 promote，
   硬推只会制造混合状态。

## 5. 与「DSH 管理 / los 执行」的关系

编排器本身属于**执行面**（要访问节点、要跑 ssh），因此放在 los 仓库里随摘要下发；
**触发与看板属于管理面**（DSH：发起一波、看 JSON 报告、决定是否继续下一批）。
换句话说：`--plan` 由人/DSH 看，滚动由工具做，结论回落到 los 的账本（target_version + 日报）。
