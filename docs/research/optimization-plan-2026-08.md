# los 优化任务设计 2026-08（调研 + 双评审整合）

> 输入：`docs/research/competitive-snapshot-2026-08.md`（竞品调研 sweep #3）
> 评审：第一评审（Reasonix 主会话分析）+ 第二评审（独立子代理，只读核对实现）
> 外部 CLI 评审尝试：codex 0.146.1 exec 因环境限制失败（`failed to initialize in-process app-server client: Operation not permitted`，Reasonix bash 沙箱无 app-server）；grok 0.2.118 headless 失败（`Device not configured`，无 tty）。**建议在正常终端重跑**：`codex exec "评审 docs/research/competitive-snapshot-2026-08.md..."`（codex review 子命令亦可）。本设计基于两轮 Reasonix 侧评审。

## 零、执行状态（2026-08-08 收尾）

P0 四项已全部交付合入（08-08 批次），DB todo 已回写 done：

| # | 任务 | 合入 commit | todo |
|---|---|---|---|
| 4 | self-check schema 契约（D4） | `1494df0d`（自举三断点批次） | `todo-los-structural-D4-output-contract` ✅ |
| 1 | 沙箱 native 后端 deny 化 | `115ba34c` | `todo-los-opt-sandbox-native-deny` ✅ |
| 3 | compaction 失败补偿 | `2dd8a5a9` | `todo-los-opt-compaction-retry` ✅ |
| 2 | 按 kind 衰减 + refCount 保护 | `e84c9f94` | `todo-los-opt-decay-kind-ref` ✅ |

验证：self-check 45/45、shell-sandbox 10/10、server-maintenance 3/3、decay 21/21 全绿。剩余 P1 四项（memory 写入门禁 → shell env 最小化 → 沙箱绕过回归测试 → graph fail-fast）按本节原顺序执行；其中 shell env 最小化 + 沙箱回归测试已随 `92aa3585`（shell env 最小化+sentinel+沙箱有效性回归测试）合入，待核对 todo 状态。

## 一、snapshot 8 项候选的评审修正

| 候选项 | 评审结论 | 修正后定位 |
|---|---|---|
| memory 防御 checklist | 攻击面真实存在：三路注入（agent 自写 self-reflection / gateway 公开 API 直写 memory-routes / compaction 摘要自动落库）+ FTS 检索竞争。威胁模型 = 被攻破的 agent/供应链消息（非 query-only） | ✅ 保留，优先级上调（写入门禁+投毒标记） |
| 远程 sandbox 凭据 sentinel | env 泄漏面确认：execFile 三处继承 process.env；los 无 proxy 架构，egress 替换不成立 → 降级为 **env 白名单 + 敏感变量 sentinel 替换 + 输出脱敏** | ✅ 保留（降级版） |
| L1 门禁回归测试集 | **认知修正**：los 无命令 parser（run_shell 整串透传 bash -lc），Claude 绕过清单针对 parser 不适用 → 转化为**沙箱有效性回归测试**（绕过形态在各后端确实被限制）+ native deny 化 | 🔄 重新定义 |
| agent-graph fail-fast | 部分存在：graph-control 仅人工整体取消；兄弟失败只 block 下游不取消 running 兄弟 | ✅ 保留（M） |
| 按 kind 衰减率 | 差距很小：aggregateCrossSessionDecay 已按 kind 聚合，缺 kind 因子接入 decayScore + refCount≥1 保护 | ✅ 保留（S） |
| K3 v2 引擎对齐 | 外部依赖型，无法代码验证 | ⏸ 标注（M） |
| compaction 失败回退 | compaction 无 LLM（deterministic），模型退役重试不适用；真实缺口 = compactSession 失败仅 log.warn 无补偿 | 🔄 重定义为失败补偿（S） |
| ARC ID 可寻址归档 | 大部分已覆盖（semantic-eviction 已有 PersistentLocation 五类引用）；缺"免重执行恢复" | ✅ 保留（M，后续） |

## 二、独立发现（评审新增，snapshot 未覆盖）

1. **self-check 无 schema 契约**：手工 JSON 解析 + 解析失败静默降级 goalMet=false（假阴性）。每任务必跑，价值高。= 已有 `todo-los-structural-D4-output-contract`
2. **native 后端 warn+照跑**（shell-sandbox.ts:143-167）：Claude 是 macOS 回退 deny——应改 deny（可配置 allow-native）
3. **decay stale 判定无引用保护**：refCount≥1 的观察也被 stale 判定（base 0.1×0.3×0.7×0.8 必低于阈值）→ 误归档有引用价值的观察

## 三、优化任务清单（整合，按优先级）

### P0（S 级，可立即执行）
1. **native 后端 deny 化** | `packages/agent/src/tools/external/shell-sandbox.ts` | 无沙箱时拒绝执行（config `allowNativeShell` 可放行）；测试断言 | 依赖：无
2. **按 kind 衰减 + refCount 保护** | `packages/memory/src/core/decay.ts` | DecayObservation 加 kind；cross-session decayRate 接入评分；stale 判定保护 refCount≥1；默认行为不变 | 依赖：无
3. **compaction 失败补偿** | `packages/gateway/src/server-maintenance.ts` | compactSession 失败计数 + 退避重试 + warn 告警 | 依赖：无
4. **self-check schema 契约** | `contracts/self-check-output.yaml` + `packages/agent/src/self-check.ts` | 集中校验函数（无新依赖）；失败不再静默降级（保留容错路径）；= todo-los-structural-D4 | 依赖：无

### P1（M 级，本周-下周）
5. **memory 写入门禁 + 投毒标记** | `packages/memory/src/core/store.ts` + `packages/memory/src/core/compaction.ts` + `packages/gateway/src/routes/data/memory-routes.ts` | 来源白名单 + 长度/结构约束；投毒标签保留可归因（MutMem"不删除+标签"思路）；gateway 端点过门禁 | 依赖：无
6. **shell env 最小化 + sentinel** | `packages/agent/src/tools/external/shell-sandbox.ts` + `packages/agent/src/tools/core/registry.ts` | 三后端 env 白名单（PATH/HOME/LC_*）；敏感变量 sentinel 替换；结果输出脱敏（测试断言无凭据） | 依赖：无
7. **沙箱绕过回归测试集** | `packages/agent/src/tools/external/shell-sandbox.test.ts` | tabs/Unicode/zsh `[[ ]]`/子 shell 形态在各后端验证限制效果 | 依赖：1（native deny 后测试语义才成立）
8. **graph 分支失败取消兄弟** | `packages/agent/src/scheduler/graph-task-runner.ts` + `packages/agent/src/agent-task-graph.ts` | worker failed 后取消 running 兄弟（保留 maxAttempts 重试）；事件可观测 | 依赖：无

### P2（设计/后续）
9. **ARC 免重执行恢复**（semantic-eviction 归档 → 按 ID 恢复上下文）| 中
10. **K3 适配 v2 引擎语义**（kimi-code 0.33 转正）| 中，外部依赖
11. **sandbox 凭据 egress 替换完整版**（需 proxy 架构）| 大，设计先行

## 四、执行建议

- P0 四项可合并为一个"安全小批量"PR（每项 <100 行 + 测试，同包或邻包）
- P1 每项独立 PR（跨包按 gate 流程）
- 顺序：4（D4 契约）→ 1 → 3 → 2 → 5 → 6 → 7 → 8
