# 代码优先确定性治理清单

**灵感来源**: Cindy maker-core 的确定性治理实践（system prompt 门禁、热路径约束、prompt 缓存率监控）。

**核心原则**: 任何可能影响 agent 行为的非确定性来源必须在代码中显式治理——不是事后审计，而是编译/测试时门禁。

## 1. Prompt 路径缓存率评估

### 为什么重要
Provider 的 prompt prefix cache 命中率直接影响延迟和成本。当 system prompt 或 tool definitions 发生变更时，cache 被整体失效，所有后续请求退回完整推理。

### 检查清单
- [ ] 每次 system prompt 变更后评估：变更了多少 token？是否在 cache 边界内？
- [ ] 每次 tool definition 变更后评估：tool 数量和描述长度变化？
- [ ] Provider 切换时评估：新 provider 的 prefix cache 行为和原 provider 的兼容性？
- [ ] 每个 session 的第一次请求：prefix cache 是否有效命中？

### 度量位置
- `packages/agent/src/context-monitor.ts` — 上下文窗口填充率（影响 cache 压力）
- `packages/agent/src/providers/index.ts` — 流式响应中的 usage 信息
- Provider 侧日志中的 `cached_tokens` 字段

## 2. System Prompt 门禁

### 为什么重要
System prompt 是 agent 行为的最高优先级指令。未经门禁的 system prompt 变更可能导致 agent 行为不可预测地偏移。

### 门禁规则
- **变更审批**: 任何 `packages/agent/src/system-prompt.ts` 或 `identity-loader.ts` 的变更必须在 PR 中显式标记 "prompt-change"，并附带行为影响评估。
- **回归测试**: System prompt 变更需要至少一个 focused harness 测试（验证关键行为路径未退化）。
- **版本标记**: 每次 prompt 变更递增 `agent/src/system-prompt-version.ts` 中的版本号。
- **回滚路径**: 保留上一版本的 prompt 快照，允许通过 feature flag 回滚。

### 度量位置
- `packages/agent/src/system-prompt.ts`
- `packages/agent/src/identity-loader.ts`
- `docs/adr/0023-agent-identity-decision-framework.md`

## 3. 热路径性能约束

### 为什么重要
agent loop 的每次迭代都有严格的延迟预算。热路径上的非必要操作直接增加用户感知延迟。

### 约束规则
- **per-turn 延迟预算**: 每次 agent turn 的额外开销（非 LLM 推理部分）< 50ms p95。
- **禁止热路径同步 I/O**: tool call 序列化/反序列化、状态转换验证、事件写入均为异步。
- **禁止热路径重复计算**: context fill 百分比、token 计数需带缓存，不重复扫描 message 数组。
- **DB 查询上限**: 每次 turn 的 DB round-trip ≤ 3（不包括 tool call 自己的查询）。

### 度量位置
- `packages/agent/src/loop.ts` — 主循环路径
- `packages/agent/src/los-tool-broker.ts` — tool call 分发路径
- `packages/agent/src/execution-store.ts` — 状态转换路径

## 4. 治理执行

### CI 门禁
- `pnpm check` 包含 wiring topology 检查（确保无孤立函数）
- `pnpm test` 包含 focused harness 测试
- 新增模块超过 400 行触发警告，超过 600 行阻断

### 定期审计
- 每周 governance sweep 检查 prompt 变更频率和影响范围
- 每月 provider cache 命中率回顾
- 每季度热路径性能回归测试

---

**关联文档**:
- `AGENTS.md` AP11 — 确定性治理门禁（索引）
- `docs/governance/anti-patterns.md` AP10 — 实现但未接线（Orphan Function）
- `docs/governance/memory-health-metrics.md` — Memory 健康指标
