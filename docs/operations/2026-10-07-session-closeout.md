# los 执行面：夜间工作交接（2026-10-06/07）

## 1. 当前状态（一句话）

**8/8 executor 在线且落在同一修订 `0.1.0+bca2863af4194`；网关 ready；治理面全清**
（异常 0 / 待审批 0 / 死信 0 / 治理 todo 0 / 网络 all_clear / 桥接 ok）。
本夜共 19 个提交在 `main`，新增 3 个常驻守护，los 侧定时任务 8 启用 + 1 暂停（E3 模板）。

| 面 | 状态 |
| --- | --- |
| executor | 8 online，8 落在声明目标，版本种类 1 |
| 网关 / DB | `ready=true`；Postgres 正常 |
| 治理 | `治理异常=0 待审批=0 死信=0 治理todo=0 fleet漂移=0` |
| 常驻守护 | `com.los.daemon`(running)、`los.network-observe-bridge`(2h)、`los.fleet-snapshot`(6h)——后两者 `state=notrunning` 属 StartInterval 正常语义 |
| DSH 调度 | 11 个 job（其中 1 个待修，见 §4） |

## 2. 交付清单（按主题，附验证方式）

### A. 恢复执行能力
| 提交 | 内容 | 验证 |
| --- | --- | --- |
| `14e19807` | 客户端 tools 转发并进主线 | 机械探针：带 `tools` → 400 `tool_forward_unavailable`；不带 → agent loop 正常 |

### B. los 执行面（边界实测 + 首个被执行的任务）
| 提交 | 内容 |
| --- | --- |
| `46df8dee` | 首个 los 执行的确定性检查（fleet consistency）+ 四轮尝试钉死 L1/L2 与沙箱边界 |
| `681aca61` | 采集端挂载到**两个沙箱之外**（launchd）；判读任务加 STALENESS GATE |
| `c7b707e4` | 采集脚本自证写入落地（防"报成功但没写"） |
| `a043a2b9` | E3「los 产出改动 / 外部 runner 验收」作业模板 |

### C. 缺口修复（P0 全清）
| 提交 | 缺口 | 验证 |
| --- | --- | --- |
| `8ea266a5` | **P0-1** 维护窗口进入候选过滤（此前只抑制告警） | DB 型测试：窗口内拒派单、清除后立即恢复 |
| `1d930fc6` | **P0-2** verify 后自动 promote（版本校验 + 复核 online） | vultr 实测 `auto-promote verified` |
| `df47f14e` | **P0-3** promote 校验版本 | los 产出改动、外部 runner 全套 857/857 |
| `ff65a325` | **P0-5** `resourceClass` 计算并暴露 | 真机：oracle 954MB/vultr 956MB → constrained 警告首次触发 |
| `8855fc9a` | **P0-6** `target_version` 变成可自动关闭的 todo | 造漂移→出 todo→收敛→自动 done（真实漂移触发过 3 次） |
| `050a5f5a` | **P0-7** sync 校验远端收敛（+ 只读 `digest`） | vultr 实测 MISMATCH exit 1 |

### D. 韧性（一次真实事故 ×3 处根因）
| 提交 | 内容 |
| --- | --- |
| `a377f9a0` | pg 中断不再杀进程（client 级 error handler）+ systemd 不限流 + 失败恢复 online |

事故复盘：2026-10-06 23:48 Postgres `57P01 admin_shutdown` → 网关与 6 台执行器同时崩溃、
systemd 放弃后无人拉起、注册表判 offline → 全集群容量归零，靠手工逐台 `reset-failed` 恢复。
`db.ts` 的修复用独立连接 `pg_terminate_backend` 做了真实复现（进程存活 + 自动重连）。

### E. 滚动发布工程
| 提交 | 内容 |
| --- | --- |
| `8acc6d7a` | 滚动设计评审（七个缺陷逐条附证据）+ 落地 upload-then-extract 为默认传输 |
| `08ac9035` | **编排器** `tools/los-fleet-rollout.sh`（reconcile + plan/canary/fail-fast/锁/报告） |
| `ede22cef` | Windows 驱动 + macOS chown 修复 + 失败恢复 online |
| `2bc4400d` | 可移植盖章（BSD sed → awk） |
| `45d3d1ff` | 摘要口径收窄：网关侧工具不再逼出全集群滚动 |

编排器首次实战把 8 台全部接管（Windows 驱动一次通过；m3pro 的两个 macOS 专属坑也修掉）。

### F. 文档
- `docs/architecture/2026-10-06-architecture-boundaries-and-gaps.md`（架构/边界/缺口清单，P0 已全部标记完成）
- `docs/architecture/2026-10-06-los-execution-surface-and-task-routing.md`（E1/E2/E3 与任务路由）
- `docs/operations/2026-10-07-fleet-rollout-design.md`（滚动设计评审）
- `docs/governance/2026-10-06-job-template-los-code-change.md`（E3 作业模板）

## 3. 本轮沉淀的设计原则（比单个修复更值钱）

1. **编排层不做"步骤"，在节点上做"收敛"** —— 状态从节点读，不从本地进度文件读。
2. **排除清单优于包含清单**：两个方向的失败代价不对称（多一次滚动 vs 静默不更新）。
3. **下发摘要只覆盖节点实际执行的内容**：网关侧工具不该让全集群的收敛声明失效。
4. **每步的成功判据必须是可观测事实**（摘要一致、注册表 online），不是命令退出码。
5. **run 失败 ≠ 产物无用**：self-check 因缺交付物判 failed，但改动本身可用。
6. **往 DB / 命令塞长文本一律用带引号 heredoc 或 `--stdin`**（反引号会被命令替换；本夜踩了 3 次）。
7. **可移植性优先于简洁**：`sed -i`/`chown los:los` 在 BSD/macOS 上直接崩，而崩溃点常在"内容已成功"之后。

## 4. 已知问题（非阻塞，但有账）

| 问题 | 影响 | 处置 |
| --- | --- | --- |
| `bash: line 6: : No such file or directory` | sync 路径上的空命令噪音，不影响收敛 | 待查（工具 sync 内的某处空变量展开） |
| macOS `could not copy systemd unit (may need root)` | 预期（macOS 无 systemd） | 可加平台判断消除 |
| Windows 无 stale-file 剪枝 | 节点侧旧文件会累积 | 驱动补剪枝（用 `tar.exe -tzf` + 比对） |
| E3 外部 runner 仍人工执行三步 | 代码改造类任务无法全自动 | 接成 DSH 调度的一步 |
| **DSH `job-440be80b` 每周验证 job 失败** | `failed` 与 `exit=0` 并存，真因是 `feishu-push` 找不到 `.sent`（投递记账缺失） | **唯一遗留功能项**，属 DSH 侧 |

## 5. 剩余工作（按优先级）

1. **DSH 投递记账修复**（`~/.dsh/storages/feishu-push` 的 `.sent` 记账）+ 给 DSH 侧加"产物校验"防假成功
2. 滚动设计 §4 剩余：`--batch-size`、把 Linux/macOS 也拆成 `deploy-drivers/*`、canary 强制化
3. 摘要口径继续收窄：先做"节点到底执行了什么"的审计，再决定 CI/observe/node-probes 是否排除
4. P1 清单（能力画像多维化、幂等键原语、工具三态审计、22 个零引用契约接线或标注……）

## 6. 运维速查

```bash
# 看状态
bash tools/los-fleet-consistency.sh          # 集群一致性（进程==账本==声明目标）
bash tools/los-governance-daily.sh           # 治理日报（含 fleet 漂移 todo）

# 滚动发布（目标默认取本机 build-version）
bash tools/los-fleet-rollout.sh --plan       # 只读计划，先看再动
bash tools/los-fleet-rollout.sh --canary     # 先 1 台，通过后停下等人确认
bash tools/los-fleet-rollout.sh              # 滚全部（默认 fail-fast）
bash tools/los-fleet-rollout.sh --node <id>  # 单台

# 单节点工具（Linux/systemd）
LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=<alias> bash tools/deploy-to-remote.sh <node> sync|install|restart|verify|digest
# Windows
bash tools/deploy-drivers/windows-service.sh sync|activate|verify <alias> C:/los <target>

# 节点掉线（本轮事故的标准恢复）
ssh <alias> 'systemctl reset-failed los-executor && systemctl start los-executor'
# Windows: Restart-Service los-executor -Force

# 半截树：**不要重启该节点**，重跑 sync（upload 模式会自证 sha256 后再解包）
```

**注意**：每个节点的 `target_version` 由 rollout 写入，**不要手工 UPDATE** —— 那正是 P0-6 漂移检查的判据。
