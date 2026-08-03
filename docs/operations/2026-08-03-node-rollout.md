# Node Version Rollout — 2026-08-03

> 将三个执行节点更新到当前 main 部署 digest。前置:`docs/operations/2026-07-12-node-version-rollout.md`
> (07-12 部署的 14 个经验全部沿用)。规划基准不变。

## 目标版本与节点现状

| 节点 | 当前版本(registry) | 部署方式 | 目标 |
| --- | --- | --- | --- |
| `mbp-executor-1`(本地) | 0.1.0+ba05812d43bb(进程 DEAD) | `tools/los.sh` + launchd | 当前 main digest |
| `oracle-executor`(100.103.147.128) | 0.1.0+b8b754692f2df | systemd `/opt/los`,root SSH | 当前 main digest |
| `node34-executor-1`(100.68.106.96) | 0.1.0+b8b754692f2df | systemd `/opt/los`,root SSH | 当前 main digest |

版本 = `los.sh build-version`(deployable runtime content digest,与
`distribution-version.ts` 一致;文档/生成物变更不引起版本抖动——07-12 经验 11)。

## 方案设计

### 顺序与理由

1. **node34**(同机 Forgejo + CI runner,变更影响面最大但资源充足,先验证全流程)
2. **oracle**(954MB 低资源,`--low-resource` 安装;唯一 `heavy_task_safe:false` 节点)
3. **mbp**(本地,launchd;最后做,避免本地开发中断)

每节点独立可回滚;三节点全部完成后统一验证 registry。

### 每节点步骤(deploy-to-remote.sh 分阶段)

```bash
# 1. 预检(资源/磁盘/PSI)
deploy-to-remote.sh <node> preflight
# 2. 备份当前代码(回滚锚点;node_modules 不备份,install 可重建)
ssh <node> 'tar czf /tmp/los-pre-rollout-$(date +%Y%m%d).tgz --exclude node_modules --exclude dist -C /opt los'
# 3. 同步代码(tar pipe,无远程 VCS)
deploy-to-remote.sh <node> sync
# 4. 安装依赖(oracle 用 --low-resource;CI=true 已在脚本内)
deploy-to-remote.sh <node> install [--low-resource]
# 5. 重启服务(不动 systemd 单元,仅 restart)
deploy-to-remote.sh <node> restart
# 6. 验证(health + 版本 + DB 注册;30s 重试窗口)
deploy-to-remote.sh <node> verify
```

### 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| sync 覆盖导致不可恢复 | 步骤 2 备份 tar(排除 node_modules/dist);回滚 = 解包 + `install` + `restart` |
| pnpm install 中断(非交互) | 脚本已 `CI=true`;oracle 用 `--low-resource`(07-12 经验 4/5) |
| 重启后 DB 初始化慢导致 health 误判 | verify 内置 90s 宽限 + 30s 重试(07-12 经验 6) |
| 版本 stamp 与 registry 不一致 | 以 `/health` 返回版本 + `executor_nodes.version` 双核对 |
| oracle 端口 8091(非 8090) | verify 自动读远程 `.env` EXECUTOR_PORT(07-12 经验 7) |
| 部署期间任务调度 | 三节点 `activeTaskCount=0`(空闲);逐个重启,心跳窗口 <60s |

### 验证矩阵(全部 [E])

1. `/health` → `version` 等于本地 `los.sh build-version` 输出
2. `executor_nodes` 行:`version` 更新、`last_heartbeat_at` 新鲜、`status=online`
3. systemd `active` + `NRestarts=0`
4. 本地 `pnpm run status` / `curl 127.0.0.1:8090/health`(mbp)
5. 与 gateway 的连通性:oracle/node34 心跳经 `GATEWAY_URL`(或直连 DB)

## 执行记录

批次执行于 2026-08-03(目标版本 `0.1.0+b9145adf11af8` = `los.sh build-version`)。

| 节点 | 顺序 | 过程 | 结果 [E] |
| --- | --- | --- | --- |
| node34-executor-1 | 1 | preflight → 备份(158MB tar)→ sync → install → restart → verify | health ok,version b9145adf11af8,registry online 心跳新鲜,`NRestarts=0` |
| oracle-executor | 2 | preflight → 备份(158MB)→ sync → install --low-resource | **首次 install 中断**(日志止于 "Recreating /opt/los/node_modules",低资源 OOM/中断;deploy 脚本误报 complete);手工重跑 install(`NODE_OPTIONS=--max-old-space-size=256`)后 tsx 就位 |
| oracle-executor | 2b | restart → **systemd 限流**(先前失败计数 "Start request repeated too quickly") | `systemctl reset-failed` + `start` 后 active;health 30s 内恢复(低资源 tsx 启动慢,重试至 40s) |
| oracle-executor | 2c | registry 状态 **draining 残留**(旧进程停机心跳 + 新进程 online 心跳不传 status 不覆盖) | 手动 `UPDATE executor_nodes SET status='online'`(data repair);后续心跳保持 |
| mbp-executor-1 | 3 | 本地:stop → start(gateway + executor;代码已 main) | gateway 8080 health ok;executor 8090 health ok,version b9145adf11af8,registry online |

最终 registry(全部 [E]):

| node_id | status | version | last_heartbeat_at |
| --- | --- | --- | --- |
| mbp-executor-1 | online | 0.1.0+b9145adf11af8 | 18:26:22 UTC |
| node34-executor-1 | online | 0.1.0+b9145adf11af8 | 18:26:28 UTC |
| oracle-executor | online | 0.1.0+b9145adf11af8 | 18:26:25 UTC |

### 本轮新经验(补充 07-12 文档)

15. **低资源 install 中断无退出码错误**:pnpm 11 重建 node_modules 时低内存
    中断,日志止于 "Recreating .../node_modules",deploy 脚本仍报 complete。
    缓解:install 后必须验证关键包存在(`packages/executor/node_modules/tsx/dist/cli.mjs`)。
16. **systemd 限流陷阱**:多次失败重启后 `Start request repeated too quickly`,
    即使根因已修复也拒绝启动——`systemctl reset-failed` 后再 start。
17. **draining 残留**:executor 正常 online 心跳不携带 status(设计),停机时的
    draining 心跳会残留 registry;gateway 离线时新进程心跳失败无法覆盖。
    恢复 gateway 后需手动 data repair(或心跳语义支持显式 online 覆盖)。
18. **gateway 是心跳链路的必要组件**:oracle/node34 的 `GATEWAY_URL` 指向本地
    tailscale IP(100.112.77.123:8080);gateway 离线期间远程心跳失败。
    本次 rollout 顺带恢复了本地 gateway/executor 运行时(此前进程 DEAD)。

## 完成后收尾

- ✅ 本文档执行记录 + registry 版本核对(上表)
- ✅ 旧版本 hash(ba05812d43bb / b8b754692f2df)归档:均为历史部署 digest,
  已被 b9145adf11af8 取代
- 后续:离线 4 节点(hh-hstorage2/node34-ssh/tencent-sin/vultr)不部署,仅
  reactivate 时更新(07-12 Follow-Up 不变)

### 2026-08-03 second pass (version unification)

After PR #154–#158 the deployable digest moved to `0.1.0+bae1687dd3e32`; all
three executors were re-rolled out to the new digest (same procedure, no new
issues — install completed first try on oracle, gateway heartbeat chain was
up so no draining residue).

| node_id | status | version | heartbeat |
| --- | --- | --- | --- |
| mbp-executor-1 | online | 0.1.0+bae1687dd3e32 | 01:07:43 UTC |
| node34-executor-1 | online | 0.1.0+bae1687dd3e32 | 01:07:49 UTC |
| oracle-executor | online | 0.1.0+bae1687dd3e32 | 01:07:52 UTC |

Lesson 19: when the gateway heartbeat chain is up, re-rollouts are clean —
the draining-residue issue (lesson 17) only appeared because the gateway was
down during the first pass.
