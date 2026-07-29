# 治理体系增强 — 读取时机与状态标记

**灵感**: Cindy AGENTS.md 的治理规则制定方法。

## 1. 读取时机规则

Agent 应在以下时机刷新治理文档，而非仅在 session 启动时读取一次：

| 时机 | 触发条件 | 读取内容 |
|------|----------|----------|
| **Session 启动** | 每次新 session | `AGENTS.md`, `SKILL.md`, 适用的 ADR |
| **Phase 切换** | 进入新 task phase | `contracts/`, `.los/spec/` (via `loadSpecsForFiles()`) |
| **Tool 注册前** | 每次 tool registry 构建 | `allowedTools`, tool policy |
| **Provider 切换** | Fallback 触发时 | `provider-defaults.ts`, model profile |
| **Memory compaction** | Compaction 决策前 | `memory-health-metrics.md` 阈值 |

**AP5 已覆盖**: 第2项（spec 重载）。

## 2. 状态标记

每个治理文档需包含以下显式状态标记：

```markdown
<!-- gov-status: active | deprecated | draft -->
<!-- gov-version: 1.0.0 -->
<!-- gov-last-reviewed: 2026-07-29 -->
<!-- gov-review-cadence: weekly | monthly | quarterly -->
```

| 标记 | 含义 | 行为 |
|------|------|------|
| `active` | 活跃执行中 | CI 强制执行相关规则 |
| `deprecated` | 已废弃 | CI 仅 warn，60天后移除强制 |
| `draft` | 草案阶段 | CI 不强制执行，governance sweep 纳入 review |

## 3. Governance Sweep 增强

现有 `governance-sweeper.ts` 应增加以下检查项：

- [x] 检查所有治理文档的 `gov-last-reviewed` 是否过期（超过 review-cadence）
- [ ] 检查 `lowReadRatio` (来自 `memory-health-metrics.md` P0-1)
- [ ] 检查 provider cache 命中率 (来自 `code-first-determinism.md`)
- [ ] 检查 orphan function count 是否增长（已通过 `check-wiring-topology.ts` CI 门禁）

## 4. 与 AP11 的关系

`code-first-determinism.md` 的 system prompt 门禁要求：
- 每次 prompt 变更递增 `system-prompt-version.ts`
- 变更标记 `prompt-change` 并附带影响评估
- 保留上一版本快照供 feature flag 回滚

这些规则由治理 sweep 验证，而非仅文档声明。

---

**关联文档**:
- `AGENTS.md` AP11
- `docs/governance/code-first-determinism.md`
- `docs/governance/memory-health-metrics.md`
- `docs/governance/anti-patterns.md`
