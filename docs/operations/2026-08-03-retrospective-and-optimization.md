# 7-Day Problem Retrospective & Project Optimization Proposals (2026-08-03)

> 覆盖 2026-07-28 ~ 2026-08-03。问题与解法按主题归类;每条标注已固化
> (代码/文档)或仍为待办。

## 一、问题与解法回顾

### 1. CI / 基础设施(4 项)

| 问题 | 现象 | 解法 | 状态 |
| --- | --- | --- | --- |
| Forgejo runner 网络抖动 | node34 容器访问 npm registry 间歇 ETIMEDOUT + IPv6 ENETUNREACH,CI 连续 4 次失败 | ① workflow 级 `NODE_OPTIONS=--dns-result-order=ipv4first`(PR #161);② 空提交 retrigger;jj `--allow-backwards` 修兄弟分支 | ①已提交 ②已固化技巧 |
| pnpm 9→11 全链升级 | 设置位置迁移/allowBuilds 新名/IGNORED_BUILDS/沙箱 store 落项目根 | pnpm-workspace.yaml `allowBuilds`;CI=true;`.gitignore .pnpm-store/`;CI 镜像重建(DOCKER_CONFIG 绕过 buildx 沙箱) | 已固化(PR #149) |
| CI 镜像构建两段失败 | 本机 buildx 沙箱 EPERM;node34 网络拉 jj 失败 | 本机 `DOCKER_CONFIG=/tmp/dockerconf`;docker save/load 到 node34 | 已固化 |
| coverage baseline 刷新 | macOS sandbox 必败;baseline 过期(213→252 测试文件) | `LOS_TEST_SKIP_PATTERN`(**匹配测试名**);check 模式同需 env | 已固化(PR #147) |

### 2. 运行时 / 节点(4 项)

| 问题 | 解法 | 状态 |
| --- | --- | --- |
| 低资源 install 中断无退出码(日志止于 Recreating node_modules) | 重跑 install + 验证 tsx/cli.mjs 存在 | 经验 15 固化 |
| systemd 失败限流(Start request repeated too quickly) | `systemctl reset-failed` 再 start | 经验 16 固化 |
| draining 残留 + gateway 离线致心跳失败 | 恢复 gateway + data repair | 经验 17/18 固化 |
| 节点版本 digest 频繁变化 | 统一 rollout(pass1/pass2,deploy-to-remote.sh) | 已固化流程 |

### 3. K4 canary 执行(5 项,PR #154 已修复 2 个代码缺陷)

| 问题 | 解法 | 状态 |
| --- | --- | --- |
| 模型反复提交无效 plan(submit_run_contract 拒绝) | operator-constructed source(tools/k4-create-source.mts) | 工具固化 |
| source 缺 tenant/project → select-candidate scope 不匹配 | data repair + 复现脚本内建 tenant/project | 工具固化 |
| approve 自动 dispatch K4 candidate → 未授权 failed | handleApprove dispatch 条件加 `!executionKernel` | 代码修复+测试 |
| execute 转 running 后 assert 只接受 approved | assert 放宽 approved\|running | 代码修复+测试 |
| authorize 需 confirmCandidateRunSpecId | 按契约补字段 | 设计如此 |

### 4. jj / VCS 流程(6 项)

| 问题 | 解法 |
| --- | --- |
| split/squash 打开编辑器超时 | `jj split -m` / `jj squash -m` 非交互 |
| 短 change_id 前缀 revset 失败 | `change_id("...")` revset 语法 |
| rebase -s 起点错 → 链断裂/孤儿 commit(skip-pattern 丢失) | `jj file show` 对比各 commit 树找回 + squash 回链 |
| 空提交兄弟分支 sideways | `jj bookmark set --allow-backwards -r @` |
| PR 链式 head-behind | 每合并一个 → rebase 整链 → push → CI |
| merge 405 后 PR 被关未合并(竞态) | 重开新 PR(#160) |

### 5. 治理 / 数据(3 项)

| 问题 | 解法 | 状态 |
| --- | --- | --- |
| known-failures 接 CI 时无失败返回 FIXED=1 | `--allow-fixed`(CI 模式) | 已固化(PR #152) |
| DDL 复制漂移(governance audit 残缺建表 42703) | 对齐 @los/memory 权威 SCHEMA | 已固化(PR #146) |
| ADR 0030-0034 五对重复编号 | Status 标注 + README 映射 | 已固化(PR #153);重编号待 archive pass |
| 记忆漂移(ci-prepare.sh"丢失") | 核实 git 历史纠正 | 记忆已纠正 |

## 二、项目内容优化建议(按优先级)

### P0(高频摩擦,建议立即)

1. **SKILL.md 补充三个工作流**(本次落地):
   - CI 失败 triage:先看 check **结论**(failure)而非 pending;网络抖动识别(ETIMEDOUT/ENETUNREACH → retrigger);retrigger 标准步骤(`jj new <base> -m "docs: retrigger N"` + `jj bookmark set --allow-backwards` + push)。
   - pnpm 11 操作速查:pnpm-workspace.yaml 配置(allowBuilds);corepack 路径;沙箱内 `CI=true`;lockfile v9 零变化兼容。
   - Execution Lab 操作链:create source(工具脚本)→ experiment → select → approve → authorize → execute;以及 sample-gate ingest(工具脚本)。
2. **AGENTS.md**:命令面已一致;建议新增一行 CI 网络事实(pnpm store 缓存为待办)与"PR 合并前确认 statuses 结论"约定。改动最小。
3. **MCP 健康检查**:CBM 索引重索引(08-01 后未更新,13784 节点陈旧);gateway MCP 依赖 gateway 运行(当前在线,可加启动检查)。

### P1(收益明确,择机)

4. **known-failures 文档更新**:`--allow-fixed` 语义写入 pre-existing-failure-tracking.md(当前文档未提 CI 模式)。
5. **toolchain-matrix.md 补 herdr** 行(外部 agent 会话管理工具,evidence 不并入 los)。
6. **CLAUDE.md**:保持精简;仅补充"CI 网络抖动与 retrigger 见 SKILL.md"指针(或不动)。
7. **periodic-analysis.md**:closeout 规则已好;可加"CI 稳定性纳入 weekly check"(runner 网络/镜像/runner 列表)。

### P2(低优先)

8. rules(YAML 静态分析规则)不动;no-any/no-non-null 债务维持现状。
9. docs/README 的 ADR 编号冲突段已有;archive pass 时重编号。
10. 节点版本 rollout 后 SKILL 引用 docs/operations/2026-08-03-node-rollout.md。

## 三、本次落地

1. PR #161(ipv4first)— CI 验证中。
2. SKILL.md 更新(上述 P0-1 三个工作流)— 见随附 commit。
