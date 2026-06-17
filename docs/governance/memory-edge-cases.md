# Memory 边界场景分析

分析 `compactSession` 在各种边界场景下的行为和缺失处理。

---

## 场景分类

### 一、短 Session（0-1 条 observation）

| 场景 | 当前行为 | 问题 | 建议 |
|---|---|---|---|
| **0 observation** | `observationCount=0`，跳过分类 UPDATE。compaction 仍写入，confidence=0，evidenceCount=0-2 | 产生空 compaction 记录，无价值但占用存储。`session.completed` 事件仍然触发 → 自动压缩照样跑 | `compactSession` 入口加 early return：`if observationCount === 0 && taskRunCount === 0` → 返回 null，不写入 `memory_compactions` |
| **1 observation, 无 task/无 eval** | `observationCount=1, taskRunCount=0, evalCount=0, confidence=0`。写入一条空 compaction | 同上，无模式可检测，但会标记 `compacted=true`（阻止未来重新压缩） | 同上：`observationCount <= 1 && taskRunCount === 0 && evalCount === 0` → 跳过，但仍标记 observation 为 compacted（避免死循环重试） |
| **只有 task_runs 没有 observation** | `observationCount=0, taskRunCount>0`。检测 failover 模式（来自 evals），但 evals 可能也为 0 | 如果 evals 也为 0，完全是空压缩 | early return 条件应覆盖：三者全为 0 才跳过。有 task 没 obs 仍有意义（记录执行模式） |

**推荐实现**：

```typescript
// 在 compactSession 开头，数据收集之后、写入之前
const totalActivity = observationCount + taskRunCount + evalCount;
if (totalActivity === 0) {
  return null; // 完全空 session，不压缩
}
// 仅标记 observation 为 compacted（即使跳过压缩）
if (observationCount > 0 && totalActivity <= 1) {
  await markObservationsCompacted(sessionId, null); // compactionId = null 表示跳过了
  return null;
}
```

---

### 二、超长 Session（100+ turns）

| 场景 | 当前行为 | 问题 | 建议 |
|---|---|---|---|
| **大量 observation（>1000 条）** | UPDATE 批量标记 `compacted=true` 走全表扫描 `WHERE session_id=$1`。索引 `idx_obs_session` 存在，无性能问题 | 但如果 session 有 >10000 条 obs，单个 UPDATE 可能锁表较久 | 分批 UPDATE：`LIMIT 500` 循环，每次提交后释放锁 |
| **触发 `maxObservations` 上限** | `addObservation` 在插入时检查总数上限。长 session 中后期可能因其他 session 的写入导致拒绝 | 拒绝错误抛到 agent loop → session.error → 不触发 compaction | `maxObservations` 应支持 `session` scope 的宽松：当前 session 已写入的 observation 不计数在内。或改为：超限时仅 warn，不拒绝 |
| **压缩耗时过长** | 数据收集是 3 个并行 COUNT 查询 + 1 个跨 session 查询 + UPDATE。复杂度 O(1)+O(cross_sessions) | 跨 session 查询 `lookupCrossSessionEvidence` 对每个 pattern kind 做一次查询，当前只有 `executor_failover` 一种，无问题。未来 pattern 种类增多时需关注 | 当 patternKinds > 10 时改为单次查询：`WHERE observed_patterns_json @> ANY(ARRAY[...])` |

---

### 三、边界场景

#### 3.1 Session 错误/崩溃（无 `session.completed`）

**当前行为**：`session.error` 事件触发 → `chat-route-persist.ts` 写入 event + transition `run_spec` to `failed`。但 **不触发 `session.completed`** → 自动压缩不会运行 → 该 session 的 observation 永远不会被压缩/分类。

**建议**：
- 在 `chat-route-persist.ts` 的 `session.error` 处理中也触发压缩（和 `session.completed` 一样）
- 或在 `chat-service.ts` 的 `onSessionEvent` 中也监听 `session.error`
- 每日 retention 兜底：扫描超过 24h 无 compaction 的 session，强制压缩

```typescript
// chat-service.ts onSessionEvent 补充
if (event.type === 'session.error' || event.type === 'session.completed') {
  import('@los/memory').then(({ compactSession }) =>
    compactSession({ sessionId: sid, runSpecId }).catch(() => undefined)
  ).catch(() => undefined);
}
```

#### 3.2 重复压缩（同一 session 被压缩多次）

**当前行为**：`compactSession` 不检查是否已有 compaction → 可产生多条重复记录。分类 UPDATE 会重复执行（幂等，但浪费）。

**建议**：
- 入口加去重检查：查询 `memory_compactions WHERE session_id=$1 LIMIT 1`
- 若已存在 → 跳过（或返回已有记录）
- 可选：对已有 compaction 的 session 允许重新压缩（`force: true` 参数），用于模式更新

```typescript
// compactSession 开头
const existing = await db.query<{ id: string }>(
  `SELECT id FROM memory_compactions WHERE session_id = $1 LIMIT 1`, [sessionId]
);
if (existing.rows[0] && !input.force) {
  return getCompaction(existing.rows[0].id);
}
```

#### 3.3 并发压缩同一 session

**当前行为**：无锁保护 → 可能产生两条 compaction 记录，分类 UPDATE 竞态。

**建议**：使用 PostgreSQL advisory lock：
```typescript
await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`compact_${sessionId}`]);
```
事务级锁，COMMIT 时自动释放，不阻塞其他 session 的压缩。

#### 3.4 闲置 Session（创建后长时间无活动）

**当前行为**：session 创建 (`session.started`) 但无 `session.completed`（用户关闭了浏览器）。Observation 可能已写入。

**建议**：
- 每日 retention 扫描：超过 24h 无 compaction 且无活动的 session → 强制压缩
- 心跳机制判断 session 是否 "alive"：检查 `session_events` 的最后事件时间
- 避免：不要对活跃 session 提前压缩（observation 可能还在增加）

#### 3.5 跨日 Session（spans midnight）

**当前行为**：retention policy 按 `created_at` 判断，不受跨日影响。无问题。

#### 3.6 Observation 包含特殊/超大内容

**当前行为**：`search_vector` 是 `GENERATED ALWAYS STORED`，内容再大也会被索引。无显式大小限制。

**建议**：
- `addObservation` 检查 `content.length > 100_000` → 截断或拒绝（防止单条撑爆 FTS 索引）
- `summary` 同理，限制 `max(length)=10000`

#### 3.7 Session 无 `session_id` 的 Observation（孤儿）

**当前行为**：`addObservation` 中 `sessionId` 是可选的。孤儿 observation 永远不会被压缩。

**建议**：
- 孤儿 observation 在 retention policy 中 180 天硬删除（已实现 ✅）
- 可选：定期将同 `tenant_id/project_id` 的孤儿归入一个虚拟 session 压缩

#### 3.8 Archived Observation 仍在 Session 中

**当前行为**：压缩查询 `WHERE session_id=$1` 不排除 archived。已被 retention 归档的 observation 仍参与计数。

**建议**：压缩时排除 `archived=true` 的 observation（已在 retention 中处理过的）：
```sql
SELECT COUNT(*) FROM observations 
WHERE session_id = $1 
  AND coalesce(metadata_json->>'archived', 'false') = 'false'
```

---

## 优先级建议

| 优先级 | 修复 | 场景 |
|---|---|---|
| **P0** | 去重检查：不重复压缩同一 session | 3.2 |
| **P0** | `session.error` 也触发压缩 | 3.1 |
| **P1** | 空 session early return（0 observation + 0 task） | 一 |
| **P1** | 并发锁（advisory lock） | 3.3 |
| **P1** | 排除 archived observation | 3.8 |
| **P2** | 闲置 session 兜底压缩（24h+ 无 compaction） | 3.4 |
| **P2** | content/summary 大小限制 | 3.6 |
| **P3** | 大 session 分批 UPDATE | 二 |

---

## 实现后的完整状态机

```
Session 生命周期
  │
  ├─ session.started ──→ observation 写入
  │     │
  │     ├─ session.completed ──→ compactSession() [自动]
  │     │     ├─ 去重检查（已有 compaction？）
  │     │     ├─ advisory lock（防并发）
  │     │     ├─ 空 session？→ early return
  │     │     ├─ 排除 archived obs
  │     │     ├─ 分类：note→fact（跨 session 证据）
  │     │     └─ 写入 compaction + candidates
  │     │
  │     ├─ session.error ──→ compactSession() [自动，同 completed]
  │     │
  │     └─ 无事件（闲置/崩溃）──→ 24h 兜底扫描
  │
  └─ 每日定时 ──→ retention policy（90/30/180d）
        └─ integrity check（5 项）
```
