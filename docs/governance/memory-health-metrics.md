# Memory 健康指标

**为什么需要**: Cindy #205 Memory 审计揭示了 "写多读少、零召回" 的经典反模式。los memory 系统需要运行时健康指标来检测和预防这一问题。

## 核心指标

### 1. 读写比例 (Read/Write Ratio)

**计算方式**: `recentReads24h / recentWrites24h`（24 小时滑动窗口）。

| 比例 | 状态 | 含义 |
|------|------|------|
| >= 0.5 | 健康 | Memory 被积极使用，写入与召回平衡 |
| 0.1 - 0.5 | 关注 | 写入偏多，可能需要 audit |
| < 0.1 | 告警 | `lowReadRatio = true`，写多读少的典型反模式 |

**告警阈值**: 最近 24h 写入超过 10 条且读操作不足写入的 10%。

### 2. 24h 滑动窗口

**实现**: `packages/memory/src/core/store.ts:getStats()` 中的两个 SQL 查询：
- `recentWrites24h`: `COUNT(*) WHERE created_at > now() - interval '24 hours'`
- `recentReads24h`: `COUNT(*) WHERE updated_at > now() - interval '24 hours' AND created_at < updated_at`

**注意**: `recentReads24h` 使用 `updated_at > created_at` 作为"被读取过"的近似。因为 `searchObservations` 和 `getObservation` 不修改行，真正的读取计数需要通过 PostgreSQL 的 `pg_stat_user_tables.seq_scan` 或应用层计数器来精确获取。当前近似值足以检测读写失衡。

### 3. 总量上限

**配置**: `config.memory.maxObservations`（默认值在 `packages/infra/src/config.ts`）。

**行为**: `addObservation` 在插入前检查总量，超过上限时抛出错误。调用方应处理此错误并触发 compaction 或手动清理。

## 防御措施

### Dedupe Key 格式校验

**函数**: `validateDedupeKey(key: string)` in `packages/memory/src/core/store.ts`

**规则**:
- 长度: 1-128 字符
- 允许字符: `a-z A-Z 0-9 : _ - .`
- 禁止前导/尾随空白

**使用场景**: `upsertObservation` 在写入前校验 `dedupeKey`，防止无效 key 写入 JSONB 后无法匹配。

### 幂等写入 (Upsert)

**函数**: `upsertObservation(obs, { dedupeKey? })` in `store.ts`

**语义**:
- 提供 `dedupeKey` 时：查找已有记录 → 更新 tags/content/summary → 返回更新后的 observation
- 不提供 `dedupeKey` 时：与 `addObservation` 行为一致（纯 INSERT）
- 更新时合并 tags（无重复），替换 content 和 summary

**设计注意**: 当前实现使用 check-then-insert/update（非原子）。未来迁移应添加 `dedupe_key TEXT UNIQUE` 列并使用 `ON CONFLICT ... DO UPDATE`。

## 监控集成

### API 端点

`GET /memory/stats` 返回 `MemoryStats` JSON：
```json
{
  "totalObservations": 150,
  "byKind": { "note": 100, "fact": 50 },
  "bySource": { "user": 30, "agent": 120 },
  "byScope": { "session": 80, "project": 50, "global": 20 },
  "byLayer": { "working": 40, "procedural": 60, "episodic": 50 },
  "archived": 5,
  "recentWrites24h": 45,
  "recentReads24h": 3,
  "lowReadRatio": true
}
```

### Web UI

`packages/web/src/pages/memory-page.tsx` 使用 `MemoryStats` 渲染统计面板。当 `lowReadRatio = true` 时显示告警。

### 治理集成

Governance sweep 应检查 `lowReadRatio`，当持续告警时触发 memory audit（检查哪些 observation 从未被检索过，决定是否归档或清理）。

---

**关联文档**:
- `docs/governance/code-first-determinism.md` — 代码确定性治理
- `docs/governance/anti-patterns.md` AP10 — 实现但未接线
- `docs/governance/memory-lifecycle-design.md` — Memory 生命周期设计
