# Memory 数据生命周期设计

审计发现的问题不是孤立的 bug，而是**数据生命周期缺少自动化闭环**。以下是根因分析和改进方案。

---

## 一、当前架构的三个结构性问题

### 问题 1：两套建表机制互相竞争，`procedural_candidates` 漏网

```
网关启动
  ├─ migrateDir() → 读 10 个 .sql → 写入 schema_migrations
  │   └─ 当前状态：schema_migrations 为空 → 迁移 runner 未生效
  │       （路径解析失败或 SQL 执行错误被静默吞掉）
  │
  └─ ensure*Store() 逐个调用
      ├─ ensureMemoryStore()           → observations ✅
      ├─ ensureMemoryCompactionStore()  → memory_compactions ✅
      └─ ensureProceduralCandidateStore() → 没被调用！❌
          └─ 只在 compaction/retrieval 内部懒加载
             但 compaction 无人触发 → 表永远不创建
```

**根因**：`procedural_candidates` 的 DDL 只在两处：migration 006（未生效）+ DDL 常量（懒加载未触发）。其他表有 eager 的 `ensure*Store()` 兜底，这个表没有。

### 问题 2：测试数据跑在生产库

```
DATABASE_URL  = postgres://.../los        ← 网关/运行时用
TEST_DATABASE_URL = postgres://.../los_test ← 设计给测试用

但实际：los 库有 381 条测试数据
        los_test 库只有 21 条
```

db.ts 的安全检查存在（检测非 test 库名时拒绝），但 `LOS_ALLOW_LIVE_TEST_DB=1` 绕过了它。测试有效地在生产库上运行。

### 问题 3：写后即忘——生命周期没有自动化

当前 memory 数据流：

```
写入 (API/agent)
  └─ observations 表
       ├─ 分类？ ❌ 全部 kind=note
       ├─ 压缩？ ❌ 必须手动 POST /memory/compact
       ├─ 归档？ ❌ retention policy 从未被调用
       └─ 清理？ ❌ 同上
```

四个阶段全部断裂：

| 阶段 | 代码存在？ | 被触发？ | 触发方式 |
|---|---|---|---|
| **分类** (note→fact/rule/decision) | ❌ 无 | — | — |
| **压缩** (session→pattern→candidate) | ✅ | ❌ | 手动 API/CLI |
| **归档** (90d/30d → archived=true) | ✅ | ❌ | 无触发 |
| **清理** (180d → DELETE) | ✅ | ❌ | 无触发 |

---

## 二、改进方案

### 2.1 统一建表：消灭双轨制

**当前问题**：`migrateDir()` + `ensure*Store()` 两套机制，互相不知道对方的状态。

**方案**：选择一种，废弃另一种。

**推荐：保留 `ensure*Store()`，废弃 `migrateDir()`**

理由：
- `ensure*Store()` 已经在 20+ 张表上工作正常
- 每个模块自治，迁移和代码一起演进
- 不依赖文件系统路径解析
- 修复只需一步：在 gateway 启动时 eager 调用 `ensureProceduralCandidateStore()`

**具体改动**：

```typescript
// server.ts — 在所有 ensure*Store() 调用后增加：
await ensureProceduralCandidateStore();  // 新增：eager 创建
```

同时删除 `migrateDir()` 调用和 migration SQL 文件（或标记为 deprecated），消除混淆。

### 2.2 测试隔离：关闭 `LOS_ALLOW_LIVE_TEST_DB` 后门

**当前问题**：`LOS_ALLOW_LIVE_TEST_DB=1` 允许测试直接跑在生产库上。

**方案**：两处改动

1. **CI 强制执行** — `.github/workflows/ci.yml` 已经设置 `TEST_DATABASE_URL=los_test`，但本地开发没有
2. **本地开发** — 添加 `package.json` test script 显式设置 `TEST_DATABASE_URL`，移除 `LOS_ALLOW_LIVE_TEST_DB` 的使用
3. **测试清理** — test-setup.ts 在测试结束后清理自己创建的数据，而不是只 drop 一个表

```json
// package.json
"scripts": {
  "test": "TEST_DATABASE_URL=postgres://los:los@127.0.0.1:5432/los_test vitest"
}
```

### 2.3 生命周期自动化：四阶段闭环

```
写入 ──→ 分类 ──→ 压缩 ──→ 归档 ──→ 清理
 API      自动     自动      自动      自动
 agent    (新)    scheduler  scheduler  scheduler
```

#### 阶段 1：写入（已有 ✅）
`POST /memory` 和 agent 工具调用 → `addObservation()`
- 增加：`maxObservations` 上限检查（当前未强制）

#### 阶段 2：分类（新增 🆕）
observation 写入后，根据元数据自动分类：
- 有 `session_id` + `kind=note` → 可能升级为 `fact`（如果被多个 session 引用）
- 来自 compaction → `rule` 候选
- 来自 operator → `decision`

**实现**：在 compaction pipeline 中增加分类步骤，或作为 `POST /memory` 的后处理。

#### 阶段 3：压缩（已有但需自动触发）

**当前**：必须手动 `POST /memory/compact`。

**改进**：两个触发点
1. **Session 关闭时** — `session_events` 中收到 `session_closed` 事件 → 自动触发 compaction
2. **定时兜底** — scheduler 每 6 小时扫描有 observations 但无 compaction 的 session，自动压缩

#### 阶段 4：归档 + 清理（已有但需接线）

**当前**：`applyRetentionPolicy()` 实现了完整的 90/30/180 天策略，但从未被调用。

**改进**：
- Scheduler 每天凌晨运行一次 `applyRetentionPolicy()`
- 增加 `POST /memory/retention` 路由用于手动触发
- 增加 `los memory retention --dry-run` CLI 预览

### 2.4 完整性检查：接入 scheduler

`checkMemoryIntegrity()` 有 5 项检查，每天跑一次：
1. Compaction 合法性
2. Candidate 状态一致性
3. 孤儿 compaction
4. 搜索向量新鲜度
5. Observation/compaction 比率

失败时写入 `governance_jobs` 表（已有该基础设施）。

---

## 三、优先级和依赖

```
P0 (立即)
├─ ensureProceduralCandidateStore() 加入 gateway 启动 ✅
├─ 清空 los 库的 381 条测试数据
└─ 移除/关闭 LOS_ALLOW_LIVE_TEST_DB

P1 (本周)
├─ Scheduler: 每日 retention policy
├─ addObservation: maxObservations 上限
└─ Session 关闭 → 自动 compaction

P2 (下周)
├─ Scheduler: 每日 integrity check
├─ Compaction 中增加分类步骤
└─ los memory retention --dry-run CLI

P3 (后续)
└─ retention + integrity 测试覆盖
```

---

## 四、数据清理计划

当前 `los` 库的 381 条测试数据 + 62 条 compaction：

```sql
-- 预览
SELECT 'observations', count(*) FROM observations
UNION ALL
SELECT 'compactions', count(*) FROM memory_compactions;

-- 清理（确认后执行）
DELETE FROM memory_compactions;
DELETE FROM observations;
```

之后 `los_test` 库继续作为测试目标，`los` 库只保留生产数据。
