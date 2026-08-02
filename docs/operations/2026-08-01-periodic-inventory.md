# Periodic Inventory — 2026-08-01(盘点 + 决策记录 + 执行结果)

> Cadence:weekly doc/source reconciliation + P0/P1 queue alignment。
> 证据标记:`[E]` 命令/代码可复现、`[I]` 推断、`[U]` 未验证。规划基准:
> `docs/governance/2026-07-16-current-p0-p1-queue.md`(07-19 版 + 07-27/07-31 addendum)。

## 1. 方法与证据来源

- 模块调查:agent 核心链 / Execution Lab / gateway / infra+memory+executor /
  外围包 / 测试+CI+治理,六路并行只读调查,全部证据带 file:line。
- AST 证据:`los scan` 13 条规则(ci-gate.sh Phase 7 error-only 门);
  `code_index` 符号 outline。
- KG 证据:CBM 知识图谱查询(13,784 节点 / 37,495 边),复杂度 >25 热点 11 个。 [E]
- 运行时:`pnpm run status` 面——gateway/executor PID 文件存在但进程 DEAD [E];
  测试 DB(`los-postgres` docker,127.0.0.1:55432)在线 [E]。

## 2. P0/P1 队列对照(07-19 版 vs 08-01 代码现状)

| Todo | 队列文档 | 08-01 现状 | 结论 |
| --- | --- | --- | --- |
| execution-observability-projection | done | 完整(5 golden fixtures) | ✅ 无行动 |
| execution-experiment-contract | done | 完整(生命周期 + configDiff 白名单) | ✅ 无行动 |
| execution-pairwise-rubric-eval | done | 完整(3 证据通道 + rubric 快照) | ✅ 无行动 |
| execution-pairwise-sample-gate | ready(主攻线) | **#131 落地**:预注册阈值/场景、不可变 refs、实时评估、9 测试 | ✅ 机制 ready;⏳ 样本生产未自动化(见 §4.1) |
| execution-optimization-analysis | P2 backlog | 仅 `optimizationAnalysisEligible` 别名 | ⏳ 保持 backlog |
| p1-context-reconstruction | backlog | #132/#136 收口(checkpoint versioning + degraded recovery) | ✅ 建议队列文档标记 done |
| p1-stale-detection | backlog | #134 收口(decay-driven auto-marking) | ✅ 建议队列文档标记 done |
| p1-perf-metrics | backlog | **#138 落地**:Prometheus metrics endpoint | ✅ 建议队列文档标记 done |
| p1-supply-chain-full | backlog | **#139 落地**:SBOM/license/freshness | ✅ 建议队列文档标记 done |
| p1-turbo-cache | ready(blocked) | 未动;resource-baseline 5/10 | ⏳ 维持 blocked |
| p1-cbm-ab-inject | backlog | 未动(in-memory 交替) | ⏳ 保持 backlog |
| pi-k4-readonly-canary | 已授权(07-31) | 执行路径全部接线,未执行 | ⏳ 待 operator 触发 |
| Flow DSL(ADR 0030) | 明确 deferral | 无实现 | ✅ 维持 deferral |

结论:07-19 队列 P1 16 项中,08-01 后 5 项代码已收口但队列文档未回写;
实质待办仅 turbo-cache / cbm-ab-inject / optimization-analysis / K4 canary 执行。

## 3. 决策记录(Decision Log)

| # | 决策 | 原因 | 后续依据 |
| --- | --- | --- | --- |
| D1 | coverage baseline 立即刷新(本批次执行) | baseline capturedAt 2026-07-22,测试文件 213→252(+39),当前 `pnpm test:coverage:baseline` 必失败;ratchet 机制休眠 | 刷新后检查 inventory 与覆盖下降;后续将 baseline 检查接入 CI 或显式声明不在 CI 强制(待 operator 定) |
| D2 | `recovery-follow-up.ts:103` AP1 例外修复(加审计事件) | 字面违反 AP1 硬约束;同类 fallback 已有 `tool_call_state.fallback_update` 审计先例 | 以 `tool_call_state.*` 前缀事件(自动 internal 分类)保持一致;修复带回归测试 |
| D3 | `ga-file-size-fix.ts`(320 行)死代码删除 | wiring-topology-baseline 标记 3 个 zero-caller orphan;全仓零引用 | 删除时同步移除 baseline 条目;gate 的 wiring/delete-safety phase 验证 |
| D4 | ci-prepare.sh / runner-health.sh 记忆纠正 | git 历史核实:2026-06-19 "CI optimization" 提交(#48)只含 ci-gate.sh 合并与缓存,从未包含这两个脚本——不是"被回滚丢失",是"从未合入" | 不重启该优化;CI 结构调整保持 blocked(turbo-cache 依赖 10/10 baseline) |
| D5 | ADR 0030–0034 五对重复编号:记录待办,不擅自改内容 | ADR 合并/归档需要 operator 裁决(哪份为主、Status 头格式);超出本轮只读治理范围 | 生成 `docs-adr-duplicate-numbers` 待办,由 operator 决策归档方案 |
| D6 | 运行时服务(gateway/executor)不自动重启 | 进程 DEAD 无异常日志;重启属运行时操作,留待 operator 需要时执行 | 本轮测试均走 TEST_DATABASE_URL(los-postgres 容器),不受影响 |
| D7 | coverage 本地刷新需跳过 macOS sandbox 已知失败:新增 `LOS_TEST_SKIP_PATTERN` env(匹配测试名,非文件路径),package-test-runner.mjs coverage lane 透传 `--test-skip-pattern`;CI 不设置该变量,覆盖收集保持完整 | macOS 上 registry.test.ts 的 sandbox-exec 测试必败(known-failure 基线),baseline 脚本无过滤,本地刷新永远失败 | 使用:`LOS_TEST_SKIP_PATTERN="executes shell commands" pnpm test:coverage:baseline:update` |
| D8 | **发现并修复真实 schema 漂移 bug**:`governance-auditors-memory.ts:137` 的 `runMemoryRetentionAudit` 用残缺 DDL(observations 缺 6 列 / memory_compactions 缺 9 列)建表。共享 schema 场景(coverage 单进程、schema 名含 RUN_ID)下若它先执行,`CREATE TABLE IF NOT EXISTS` 后续全部跳过 → session-recovery 测试 42703 失败 | 根因:DDL 复制粘贴无同步机制;CI isolated 每文件独立 schema(pid 进 schema 名)掩盖了该 bug | 修复:两处 DDL 与 @los/memory 权威 SCHEMA 对齐(列+ALTER+索引)。agent 全量 coverage 973/973 复跑通过 [E]。残余:governance 版 search_vector 为非 GENERATED 普通列,与 memory 版有渐进差异,不影响查询,待统一 |

## 4. 发现与漂移(按依赖排序的下一步)

### 4.1 依赖链:Execution Lab 收尾

```text
sample-gate 机制(#131, done)
   ↓ 依赖
自动 pairwise 样本生产(recordPairwiseRunEval 唯一调用方是手动 API)
   ↓ 依赖
optimization-analysis(P2, advisory)→ 可选 web UI(experiments/sample-gate 页面缺失)
```

下一步(建议顺序):
1. 明确样本生产策略:手动灌样操作流程文档,或 agent 自动收集器(gateway 侧
   hook 候选 run 完成事件 → 自动 pairwise 评估)。**待 operator 定策略**。
2. K4 canary 执行(已授权、路径已接线)——需 operator 提供 source run spec
   与明确触发指令。

### 4.2 治理三修(本批次执行两项,一项待 operator)

| 项 | 状态 | 依赖 |
| --- | --- | --- |
| coverage baseline 刷新 | 本批次执行(D1) | 需测试 DB 在线 ✅ |
| AP1 例外修复 | 本批次执行(D2) | 无 |
| 死代码清理 | 本批次执行(D3) | 无 |
| ADR 重复编号归档 | 待 operator(D5) | operator 裁决 |
| baseline/known-failures 接入 CI | 待 operator 决策 | 决策点:CI 强制 vs 显式本地-only 取舍 |

### 4.3 静态分析与复杂度债

- KG 热点 11 个(>25):eventPayloadSummary 36 / createWxPusherIngress 33 /
  runGaLoop 33 / ChatPage 32 / compactSession 31 / responseFor 29 /
  readRuntimeEvidenceGraph 28 / runAgent 28 / runGovernanceSweep 28 /
  registerProviderCrudRoutes 27 / setupLiveEventPush 27。 [E]
- 07-31 的 5 个 gateway 路由热点已清零 ✅;现存热点全部跨包异构,保持
  逐个独立设计,不批量重构(队列规则:full-repo file-size refactors 不做)。

## 5. 执行结果(本批次)

| 变更 | 结果 |
| --- | --- |
| coverage baseline 刷新 | `LOS_TEST_SKIP_PATTERN="executes shell commands" pnpm test:coverage:baseline:update`(D7/D8 后重跑,结果见批次收尾) |
| AP1 修复 | recovery-follow-up.ts 加 `tool_call_state.recovery_retry` 审计事件 + scheduler.test.ts 回归断言 |
| 死代码删除 | ga-file-size-fix.ts 删除 + wiring-topology-baseline.txt 移除 3 条 orphan 条目 |
| schema 漂移修复 | governance-auditors-memory.ts 两处 DDL 与 @los/memory 对齐;agent coverage 973/973 通过 [E] |
| 工具改进 | package-test-runner.mjs coverage lane 支持可选 LOS_TEST_SKIP_PATTERN(CI 无影响) |
| 记忆更新 | los-project-inventory 记忆刷新至 08-01 基线;ci-prepare 误解纠正(D4) |

## 6. 残余风险

1. **队列文档过期**:`2026-07-16-current-p0-p1-queue.md` 未回写 08-01 的 5 项
   done(context-reconstruction / stale-detection / perf-metrics / supply-chain /
   sample-gate)。回写需要 operator 确认(文档是 operator-facing 规划面)。
2. **coverage baseline 是否接 CI** 未定:ADR 0014 声称的 ratchet 当前无人执行。
3. **known-failures 基线 CI 无强制力**:`check-known-failures.sh` 仅本地 gate
   Phase 8 内联;CI gate-test 直接 `pnpm test`。 [E]
4. **运行时服务停止**:gateway/executor 未运行;`/health` 面不可用,需要时
   `pnpm start` 恢复(D6)。
5. **web 覆盖率 0、gateway 函数覆盖 56.67%**:保持诚实记录,不做无依据提升。
6. **DDL 复制漂移风险**:agent 包内 governance/session-recovery 仍以复制方式
   持有 @los/memory 的 SCHEMA(本轮已对齐,search_vector 的 GENERATED 差异
   保留);未来 memory SCHEMA 变更需同步 4 处定义——中期方案是抽公共 DDL
   常量或迁移单一来源。

## 7. Closeout

本报告 + 本批次 3 个变更(文档/修复/清理)拥有本轮全部可行动漂移;
剩余项均已命名 owner(operator)与下一步。下次盘点建议:candidate
`2026-08-08`(weekly cadence),重点:baseline 接 CI 决策、sample-gate 样本
策略、K4 canary 执行记录、ADR 归档结果。
