# Node & Toolchain Inventory — 2026-08-03(全节点盘点)

> 盘点工具:`tools/node-audit.sh`(+ `tools/node-audit-remote.sh`),只读 SSH 批量
> 采集。覆盖 8 个节点:本机 mbp + 7 个 Tailscale 节点。证据:[E] 为
> 2026-08-03 12:30 UTC 实际审计输出(`.los-runtime/audit-logs/20260803-123014/`)。
> 前序基线:`docs/operations/2026-08-02-node-toolchain-audit.md`(仅 3 执行节点)。
> 死网关防护设计见 §9(2026-08-03 落地)。
> 采集。覆盖 8 个节点:本机 mbp + 7 个 Tailscale 节点。证据:[E] 为
> 2026-08-03 12:30 UTC 实际审计输出(`.los-runtime/audit-logs/20260803-123014/`)。
> 前序基线:`docs/operations/2026-08-02-node-toolchain-audit.md`(仅 3 执行节点)。

## 0. 节点连通性修正(相对 08-02 审计)

08-02 文档将 vultr / hh-hstorage2 / tencent-sin / node34-ssh 记为 **offline**。
本次实测([E],Tailscale 在线 + SSH 可达):

| 节点 | 08-02 记录 | 08-03 实测 | SSH 别名 |
| --- | --- | --- | --- |
| vultr (100.93.104.96) | offline | **在线**(Ubuntu 24.04) | `vultr-r-t` |
| hh-hstorage2 (100.86.24.22) | offline(07-31 起) | **在线**(Ubuntu 22.04) | `hh-sgp1-r-t` |
| tencent-sin (100.93.220.9) | offline | **在线**(OpenCloudOS 9.4) | `tencent-sin-t` |
| node34-ssh / localnode34 (192.168.31.34) | offline | **不可达**(LAN 虚拟机,当前未开) | `localnode34` |

结论:三个"offline"远程节点实际一直在线,只是未运行 los executor;
需将节点状态口径从"registry 心跳"改为"Tailscale 可达性 + 服务状态"双维度。

## 1. 节点总览

| 节点 | 系统 | RAM | 磁盘 | los executor | 角色(当前) |
| --- | --- | --- | --- | --- | --- |
| mbp-executor-1 (local) | macOS 26.5.2 | 32G | 51% | ✅ :8090 v0.1.0+bae1687dd3e32 | 主执行节点 + gateway |
| oracle-executor (100.103.147.128) | Ubuntu 24.04 | 954M | 43% | ✅ :8091 v0.1.0+bae1687dd3e32 | 执行节点(heavy 关) |
| node34-executor-1 (100.68.106.96) | Ubuntu 22.04 | 9.7G | 73% | ✅ :8090 v0.1.0+bae1687dd3e32 | 执行节点 + Forgejo + 1Panel 全家桶 |
| vultr (100.93.104.96) | Ubuntu 24.04 | 955M | 67% | ❌ 已停用(原 crash-loop) | proxy_egress + mesh gateway + DERP |
| hh-hstorage2 (100.86.24.22) | Ubuntu 22.04 | 957M | 44% | ❌ 未部署 | storage + ssh relay |
| tencent-sin (100.93.220.9) | OpenCloudOS 9.4 | 3.6G | 73% | ❌ 已停用(原死网关) | vpsagent control-plane 备份 + mesh gateway |
| nas-t (100.68.149.52) | Linux 3.10(Synology) | 1.9G | 70% | ❌ 不适用 | 存储 |
| glkvm / MiWiFi (100.87.222.30) | Buildroot(路由器) | 750M | 18% | ❌ 不适用 | mesh 出口/路由 |

## 2. herdr 安装状态(核心问题)

| 节点 | herdr | 版本 | 配置 |
| --- | --- | --- | --- |
| mbp(local) | ✅ | 0.7.5 | `~/.config/herdr/config.toml`(08-02 生成) |
| oracle / node34 / vultr / hh / tencent-sin / nas / glkvm | ❌ **全部 MISSING** | — | — |

结论:herdr **仅本机安装**。远程 7 节点均未安装。herdr 定位为
"人工/外部 agent 会话管理"工具(08-02 审计结论:可选增强,不接入 los 运行时);
若需在远程节点上管理外部 agent 会话(如通过 SSH 操作 herdr),需逐节点安装:
`curl -fsSL https://herdr.dev/install.sh | sh`(root 环境装到 `/usr/local/bin`)。

## 3. 工具链版本对比(全节点)

| 工具 | mbp | oracle | node34 | vultr | hh | tencent-sin | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| node | v24.14.0 | v22.22.3 | v24.16.0 | v22.22.3 | **MISSING** | v22.20.0 | hh 需装(存储节点也常用) |
| pnpm | 10.24.0(自升级 11.6.0 异常) | 11.6.0 | 11.6.0 | 11.6.0 | **MISSING** | 10.34.3 | mbp 与 CI(11.6)漂移;hh 缺 |
| npm | 11.9.0 | 10.9.8 | 11.13.0 | 10.9.8 | **MISSING** | 10.9.3 | OK |
| git | 2.50.1 | 2.43.0 | 2.54.0(已修) | 2.43.0 | 2.34.1 | 2.43.7 | hh 旧 |
| jj | 0.39.0 | **MISSING** | **MISSING** | **MISSING** | **MISSING** | **MISSING** | 远程全缺(08-02 已知) |
| docker | 29.4.0+compose | 29.1.3(daemon 不可达) | 27.5.0+compose | 29.5.0 | 29.5.0 | 28.0.1 | node34 27.x 可升 |
| bun | 1.2.17 | MISSING | MISSING | MISSING | MISSING | MISSING | 可选 |
| go | 1.25.7 | MISSING | MISSING | 1.22.2 | MISSING | 1.25.8 | 远程执行 Go 构建才需 |
| rustc | 1.97.0 | MISSING | MISSING | 1.93.0 | 1.67.1 | MISSING | 远程执行 Rust 构建才需 |
| python3 | 3.9.6(系统) | 3.12.3 | 3.10.12 | 3.12.3 | 3.10.12 | 3.11.6 | OK |
| rg | 15.1.0 | 14.1.0(已补) | 13.0.0 | **MISSING** | **MISSING** | 14.1.0 | vultr/hh 缺 |
| jq | 1.7.1 | 1.7 | 1.6 | 1.7 | 1.6 | jq- | OK(tencent-sin 版本输出异常) |
| tmux | 3.6a | 3.4(已补) | 3.2a | 3.4 | 3.2a | 3.4 | 可选 |
| tailscale | 1.98.10 | 1.98.8 | 1.98.8 | 1.98.8 | 1.98.8 | 1.98.8 | 全齐(glkvm 1.98.10) |
| sing-box | 1.13.14 | MISSING | 1.12.22 | 1.12.12 | MISSING | 1.13.14 | 仅网关节点需要 |

**相对 08-02 已改善**:oracle 补了 rg/tmux;node34 git 2.34.1→2.54.0。
**仍未满足**(08-02 必要项遗留):oracle docker compose 插件;node34 jj/rg 15。

## 4. 服务与软件清单(每节点)

### vultr(资源紧张 955M)
- 运行:1panel、cloudflared、derper(Tailscale DERP!)、docker、postgresql@16、sing-box(:2080 SOCKS5)、sshd(:23452)
- ⚠️ **los-executor crash-loop**:GATEWAY_URL=`http://100.75.41.120:8080`(该 IP 已不存在于 Tailscale),心跳超时 → 每 5s 重启,累计 **56196 次**。空耗 CPU/日志。
- docker 无容器;.env 无 LOS_VERSION stamp(旧部署)。

### hh-hstorage2(存储节点)
- 运行:tailscaled、docker、sshd(:23452)、postgresql(127.0.0.1:5432)
- 无 /opt/los、无 node/pnpm/npm —— 无任何 los 运行痕迹,纯存储。

### tencent-sin(control-plane 备份)
- 运行:1panel-agent/core、cloudflared-vpsagent-control、nginx、docker(3 容器:vpsagent-control-plane-lb/haproxy、deploy-redis、deploy-postgres)、sing-box(:2080)、sshd(:23452)
- ⚠️ los-executor 心跳失败:`GATEWAY_URL=http://100.75.41.120:8080` 死网关,持续 timeout(06-17 起运行,health 返回 `0.1.0` 无 hash —— 旧版无 stamp)。

### node34(1Panel 全家桶,15 容器)
- forgejo(8080)、rustdesk、subconverter、caddy-surge、uptime-kuma、calligraph-tts、bitwarden、memos、obsidian-livesync、bytebase、it-tools、redis、redis-commander、mysql
- 08-02 记录的 3 个闲置 runner 容器(forgejo-runner/lot2extension-runner/forgejo-runner-cantool)**已不在** docker ps 列表 —— 已清理或迁移(待确认)。

### nas / glkvm
- nas:Synology(无 node/python 3.8),仅 sshd :23452 + postgres。不适合跑工具链。
- glkvm:小米路由器 armv7l,仅 tailscale + python3.12。mesh 出口用。

## 5. 发现的问题清单(按严重度)

| # | 严重度 | 问题 | 节点 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | 🔴 高 | los-executor crash-loop(56196 次重启) | vultr | 停用服务(`systemctl disable --now los-executor`)或修复 GATEWAY_URL 后重新接入 |
| P1 | 🔴 高 | los-executor 心跳失败 1.5 个月,指向死网关 100.75.41.120 | tencent-sin | 同上;若 vpsagent 控制平面已迁走,停用 los 残留 |
| P2 | 🟡 中 | herdr 仅本机,远程全缺 | 全部远程 | 按需安装(见 §2) |
| P2 | 🟡 中 | 本机 pnpm 10.24.0 与 CI/los packageManager 11.6.0 漂移;standalone 自升级报 EPERM(沙箱写权限) | mbp | `pnpm self-update` 或 `npm i -g pnpm@11.6.0`(需真实终端) |
| P2 | 🟡 中 | jj 远程全缺 | oracle/node34/vultr/hh/tencent-sin | 执行 jj 工作流前安装 0.39.0(与 CI 镜像一致) |
| P2 | 🟡 中 | node34 docker 27.5 / git 2.54 已修但 rg 13.0 旧、缺 jq 1.7 | node34 | 按需升级 |
| P3 | 🟢 低 | vultr/hh 缺 rg(搜索依赖) | vultr/hh | `apt install ripgrep` |
| P3 | 🟢 低 | hh 缺 node/pnpm/npm(存储节点若跑脚本需要) | hh | 按需 |
| P3 | 🟢 低 | nas/glkvm 无工具链 | — | 维持存储/路由角色,不部署 |
| P3 | 🟢 低 | node34 磁盘 73%(135G/196G) | node34 | 1Panel 容器瘦身评估 |
| 信息 | — | 08-02 "闲置 runner 容器"已消失 | node34 | 确认是否预期清理 |

## 6. 周期性盘点机制(后续如何做)

### 6.1 命令

```bash
# 全部节点(默认)
bash tools/node-audit.sh
# 指定节点
bash tools/node-audit.sh vultr-r-t hh-sgp1-r-t
# 仅本机
bash tools/node-audit.sh --local
```

输出:每节点一份完整报告
`.los-runtime/audit-logs/<时间戳>/<节点>.txt` + stdout 一行摘要。

### 6.2 建议 cadence(与 08-01 periodic-inventory 周会合并;手动周盘,已定)

- **每周**(与 `docs/operations/2026-08-01-periodic-inventory.md` 同批):
  1. `bash tools/node-audit.sh` 全量盘点
  2. diff 上一轮 `<ts>` 目录:工具版本变化、新增/消失服务、disk% 增长
  3. 核对 `pnpm run status` / `curl 127.0.0.1:8090/health` 三执行节点版本一致性
- **每月**:工具链升级(apt upgrade / pnpm self-update)+ 清理 audit 旧目录
- **事件驱动**:任何节点 los executor 部署/rollout 前后各跑一次

> 2026-08-03 operator 决策:不接 launchd/cron 自动化,手动周盘即可。

### 6.3 检查项(与脚本字段一一对应)

1. herdr 版本与配置(config.toml 存在性)
2. 工具链:node/pnpm/git/jj/docker/go/rust/rg/jq/tmux/tailscale/sing-box 版本
3. los 运行时:/opt/los 存在性、.env 版本 stamp、systemd 服务状态、health 端点
4. 监听端口:2080(sing-box)/23452(sshd)/8080/8090/8091/5432
5. docker 容器清单
6. 资源:RAM/swap/disk
7. apt/brew outdated 快照

### 6.4 自动化(可选,待 operator 定)

- 本机 launchd(每周一 09:00)跑 `node-audit.sh`,输出到
  `.los-runtime/audit-logs/`(已 gitignore?)——如纳入版本控制需评估。
- 或由 los 自身的 governance sweep 周期任务调用(当前无此 hook,列为 backlog)。

## 7. 本轮执行记录

- ✅ 新建 `tools/node-audit.sh` + `tools/node-audit-remote.sh`(只读,幂等)
- ✅ 8 节点全量盘点(证据:`.los-runtime/audit-logs/20260803-123014/`)
- ✅ 本报告(§1–§5 数据全部 [E])
- ✅ P1 修复(operator 决策 2026-08-03):vultr + tencent-sin 的僵尸
  los-executor 已 `systemctl disable --now` 停用,进程确认清零 [E];
  两节点继续保留 mesh 角色(vultr: DERP + sing-box + sshd;tencent-sin:
  vpsagent control-plane + sing-box),los-executor 不启用,恢复方式:
  `systemctl enable --now los-executor`(需先修 GATEWAY_URL)
- ✅ herdr 远程安装:operator 决策暂不装,保持本机唯一
- ✅ 周期性盘点:手动周盘,脚本入库(与 08-01 periodic-inventory 同批)
- ⏳ pnpm 本机升级 11.6.0 待 operator 在真实终端执行

## 8. 残余风险

1. ~~vultr crash-loop 持续空耗~~ ✅ 已停用(08-03)。
2. ~~tencent-sin los-executor 空耗~~ ✅ 已停用(08-03)。
3. 本机 pnpm 10.24.0 与 CI 11.6.0 漂移:修复需在非沙箱终端执行
   (`pnpm self-update` 或 `npm i -g pnpm@11.6.0`);本会话 EPERM 是环境限制非真实故障。
4. node34 磁盘 73% 且容器多,若继续增长需瘦身。
5. vultr 的 DERP 服务若停用需确认 Tailscale 网络无其他节点依赖(derper 对外服务)。
6. 若未来 reactivate vultr/tencent-sin 的 los-executor,需先修 .env GATEWAY_URL
   指向新网关(100.112.77.123:8080)并补 LOS_VERSION stamp。

## 9. 死网关 crash-loop 防护(2026-08-03 落地)

### 9.1 根因(三层叠加)

vultr 56196 次重启是三个缺陷叠加,缺一不可:

1. **应用代码(旧版)**:启动路径上同步 `await heartbeatNode()`(index.ts:81),
   网关不可达 → 异常 → `process.exit(1)`。当前 main 已改为
   `void reportHeartbeat()`(fire-and-forget),心跳失败不再杀死进程。
2. **systemd unit(旧版)**:`Restart=always` + `RestartSec=5` 且无显式
   rate limit。systemd 默认 `StartLimitIntervalSec=10s/Burst=5` 的窗口(10s)
   小于失败周期(心跳超时 10s + 重启延迟 5s ≈ 15s),**默认限流永远不触发**。
   新版 unit 的 `StartLimitIntervalSec=300 StartLimitBurst=5` 覆盖 15s 周期
   (300s 内约 20 次失败 >> 5),第 6 次失败后 systemd 停止重启进入 `failed`。
3. **配置漂移**:`.env` 的 `GATEWAY_URL` 指向已下线旧网关,部署/盘点均无校验。

### 9.2 防护矩阵(已落地)

| 层 | 防护 | 状态 |
| --- | --- | --- |
| systemd | `StartLimitIntervalSec=300 StartLimitBurst=5`(旧节点 unit 无) | ✅ 新 unit 内置;旧节点若 reactivate 需先同步 unit |
| 应用 | 心跳不阻塞启动(fire-and-forget) | ✅ main 已有 |
| 应用 | **心跳失败指数退避**:`baseIntervalMs=10s, backoffFactor=3, maxBackoffMs=15m`;连续失败间隔 10s→30s→90s→…→15m 封顶,恢复后回 10s | ✅ 2026-08-03 落地(`executor-heartbeat-reporter.ts` + 自调度,5 个单测 30/30 通过) |
| 部署 | `deploy-to-remote.sh verify` 增加 GATEWAY_URL 可达性检查(curl gateway /health),不可达 WARN 并给修复指引 | ✅ 2026-08-03 落地 |
| 盘点 | `node-audit-remote.sh` 增加 GATEWAY_URL 解析 + 可达性探测,报告标注 `UNREACHABLE (heartbeats will fail)` | ✅ 2026-08-03 落地(实测 node34 显示 reachable) |
| 流程 | 网关迁移时必须同步所有节点 .env GATEWAY_URL | 📋 checklist(见 rollout 文档) |

### 9.3 未落地(评估后跳过/待定)

- **RestartSteps 指数退避**(systemd 253+):oracle/vultr 是 255 支持,但
  node34 是 249 不支持,unit 无法统一;StartLimit 已提供足够防护,跳过。
- **degraded 状态暴露**:心跳失败后 /health 与 registry 标 degraded 并降权,
  需 scheduler 侧配合,列为 backlog。


