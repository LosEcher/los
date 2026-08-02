# Node & Toolchain Audit — 2026-08-02

> 证据:`executor_nodes`/`service_instances` DB rows [E]、executor `/health` [E]、
> SSH 直连探测 [E]、本机 brew/git 版本 [E]。规划基准不变:
> `docs/governance/2026-07-16-current-p0-p1-queue.md`(08-02 addendum 已回写)。

## 1. 节点状态与版本

### los 执行节点(executor_nodes,7 行)

| 节点 | host | 状态 | los 版本 | 能力 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `mbp-executor-1` | Echers-Mbp.local | **offline**(进程 DEAD) | 0.1.0+ba05812d43bb | 全量(含 heavy_task_safe、file_sync 双文件夹) | 本地 Mac;`pnpm start` 可恢复 |
| `oracle-executor` | instance-20260219-1708 (Ubuntu 24.04) | **online** | 0.1.0+b8b754692f2df | 全量但 `heavy_task_safe:false`、**无 file_sync_folders** | 2 核 / 954MB RAM(资源紧张) |
| `node34-executor-1` | z-Standard-PC-Q35-ICH9-2009 (Ubuntu 22.04) | **online** | 0.1.0+b8b754692f2df | 全量 + file_sync(/opt/los-executor) | 与 Forgejo 同机(100.68.106.96) |
| `hh-hstorage2` | HStorage2 | offline(07-31 起) | — | storage_reference + remote_ssh | 存储引用节点 |
| `node34-ssh` | localnode34 | offline | — | lan_vm + remote_ssh | — |
| `tencent-sin` | tencent-sin | offline | — | proxy_egress + control_plane_backup | — |
| `vultr` | vultr | offline | — | proxy_egress + primary_mesh_gateway | — |

**版本判断**:远程两个执行节点 hash `b8b75469` 与本地 `ba05812d` 均不在当前
main 历史中(本地 main = a5f318e7,#144–#147 之后)——**两个远程节点与本地
主节点都落后于 main**,需通过 rollout(`rollout_state`/`target_version` 机制,
见 `docs/operations/2026-07-12-node-version-rollout.md`)或重新部署更新。
oracle 另缺 file_sync 文件夹配置(与 node34/mbp 不一致),影响跨节点文件同步。

### 服务与 CI

- `service_instances`:当前无生产 gateway 行(本地 gateway 进程 DEAD);
  残留 13+ 行 `eval-e02-*` 测试 gateway(offline)与 `test-gateway-*`,属历史
  测试残留,可清理。
- Forgejo CI runner:`win-los-canary`(v12.13.2,labels win-ci/win-ci-jj/
  win-ci-playwright)在线 idle——08-02 四个 PR 全绿即由其执行 [E]。
- node34 上有 3 个**闲置 runner 容器**(forgejo-runner/lot2extension-runner/
  forgejo-runner-cantool,均 v12.12.0,标签 ubuntu-jj/ubuntu-playwright/
  lot2extension,07-25 后无任务)——与当前 ci.yml 的 win-ci 标签不匹配,
  属历史/其他仓库 runner,可评估停用省资源。

## 2. 工具链版本对比(执行节点)

| 工具 | 本机 mbp-executor-1 | oracle-executor | node34-executor-1 | 判断 |
| --- | --- | --- | --- | --- |
| node | v24.14.0 | v22.22.3 | v24.16.0 | 本机/节点34 一致(24 LTS);oracle 落后到 22(且其 954MB RAM 制约) |
| pnpm | **9.0.0(旧)** | 11.6.0 | 11.6.0 | 本机需升到 11.x(与 CI/远程一致,`corepack`/`pnpm i -g`) |
| npm | 11.9.0 | 10.9.8 | 11.13.0 | OK |
| git | 2.50.1 | 2.43.0 | **2.34.1(旧)** | node34 建议升 2.39+(Ubuntu 22.04 PPA/git-core) |
| jj | 0.39.0 | **未装** | **未装** | 两个远程节点缺 jj——若远程要跑 jj 工作流(agent 执行 jj 操作)需装 0.39.0 与 CI 镜像一致 |
| docker | 29.4.0 + compose v5.1.2 | 29.1.3(**缺 compose 插件**) | 27.5.0 + compose v2.32.4 | oracle 缺 compose 插件;node34 27.x 可升 29.x |
| bun | 1.2.17 | 未装 | 未装 | 可选;herdr/部分工具链需要 |
| go | 1.25.7 | **未装** | **未装** | 远程缺——若节点执行 Go 构建(如 herdr 源码、工具)需装 |
| rustc/cargo | 1.97.0 | 1.93.1 | **未装** | node34 缺;若执行 Rust 构建需装 |
| python3 | 3.9.6(系统)+brew 3.13/3.14 | 3.12.3 | 3.10.12 | 本机 python3 指向 Xcode 旧版,建议 `brew link python@3.13` 或显式调用;node34 3.10 旧 |
| make/gcc | 3.81 / clang 21 | 4.3 / gcc 13 | 4.3 / gcc 11 | OK |
| rg | 15.1.0 | **未装** | 13.0.0 | oracle 缺 rg(搜索依赖);node34 可升 15.x |
| jq | 1.7.1 | 1.7 | **未装?** | node34 建议补 jq |
| tmux | 3.6a | 未装 | 未装 | 远程执行会话持久化可选 |
| watchman | 2025.11.10 | — | — | 本机 OK |
| curl/wget/zsh | OK | OK | OK | — |

本机 brew outdated 共 **137 个包**(abseil/autoconf/automake/bash/caddy/cmake/
python 系等)——属常规漂移,按需分批升级,不与本项目强绑定。

## 3. 候选工具链评估

| 工具 | 是什么 | 对 los 的价值 | 结论 |
| --- | --- | --- | --- |
| **herdr** (herdr.dev) | agent 多路复用器:单终端管理多个 coding agent(Claude Code/Codex/OpenCode/Pi 等),每个 agent 独立 PTY、服务端保活、SSH/手机可重连、JSON socket API、150+ 插件 | 对**人工/外部 agent 会话管理**有用:与 los 的 executor 节点概念互补但不冲突——los 管理自己的调度/证据,herdr 管理外部 agent 的终端生命周期。los 的 operator 可用它统一盯多个外部 agent 会话 | **推荐本机安装(可选增强)**,`curl -fsSL https://herdr.dev/install.sh | sh`;不接入 los 运行时(遵循 toolchain-matrix.md:外部工具证据不并入 los) |
| forgejo-runner 清理 | node34 三个闲置 runner 容器 | 释放 node34 内存/磁盘(73% 磁盘) | 建议停用(需确认无其他仓库依赖 lot2extension/cantool 标签) |
| pnpm 11 | 本机 9.0.0 → 11.x | 与 CI 镜像/远程一致,避免 lockfile/行为差异 | 建议立即升级 |
| jj 0.39 | 两个远程节点缺 | 远程执行节点若参与 jj 工作流(closeout/PR)必备 | 按需安装(与 CI 镜像 jj0.39.0 一致) |
| go/rust/rg/jq | 远程节点缺 | agent 在远程节点执行构建/搜索/JSON 处理时必需 | oracle/node34 补装(小体积) |
| los 节点版本 | 远程落后 main | rollout 机制已存在 | 待 operator 定更新窗口 |

## 4. 必要 vs 可选

**必要(影响执行正确性)**:
1. 本机 pnpm 9 → 11(版本漂移,CI 是 11)
2. los 远程节点版本更新到 main(mbp/oracle/node34 三节点;含 oracle 补
   file_sync_folders 配置)
3. node34 git 2.34.1 → 2.39+(git 2.34 有已知安全问题,且旧)
4. oracle 补 docker-compose 插件(其 docker 29 无 compose)

**推荐(增强/一致)**:本机 herdr;node34 补 rg 15/jq;oracle 补 rg;
远程节点按需补 go/rust/jj/tmux;brew 137 个 outdated 按需分批。

**可选/不紧急**:node34 docker 27→29;node34 python 3.10→3.12;
清理 service_instances 测试残留行;node34 闲置 runner 容器停用评估。

## 5. 残余风险

1. oracle-executor 仅 954MB RAM + 2 核——`heavy_task_safe:false` 已反映,
   重任务不应调度到 oracle;升级工具链需注意内存预算。
2. 远程节点版本 hash 不在本地历史中,更新时需重新构建/分发而非 git 快进;
   建议走 `deploy/` 与 rollout 机制并记录 target_version。
3. node34 磁盘 73% 使用(196G 用 134G)——1panel/其他服务占大头,停用
   闲置 runner 前先确认归属。
