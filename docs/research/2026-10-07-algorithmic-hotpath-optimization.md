# los 算法热点优化设计

**状态**：设计（未实现）
**日期**：2026-10-07
**来源**：`dsfolder/MATH-TO-CODE-OPTIMIZATION-RESEARCH-2026-10-07.md`（OpenAI math 合集 372 族 → 7 项目映射）
**方法**：skill `algorithmic-hotpath-audit`；决策纪律 `~/.claude/rules/algorithmic-hotpath-discipline.md`
**调研范围**：只读。`CONFIRMED` = 读过代码并给出 file:line；`INFERRED` = 已标注。

---

## 0. 结论

los 有三处结构性问题，且都不属于"参数没调好"：

| 优先级 | 位置 | 问题形态 | 目标 |
|---|---|---|---|
| P0 | `packages/agent/src/providers/provider-policy.ts:125-155` | 贪心排序，无配额/并发/限流感知；健康度是**点估计** | 受约束分配 + 区间估计 + 令牌桶 |
| P0 | `packages/agent/src/governance-jobs-crud.ts:283-305` 等 | 有 EDF 认领但**周期漂移**、无公平性、无老化 | EDF 锚定 + DRR + 集合化认领 |
| P0 | `packages/gateway/src/chat-service-hooks.ts:85-93` + `event-log/file-backend.ts:48-113` | 每 token 3–6 次同步 FS + 每次 poll 读全文件 | 批/采样 + 游标 tail read |
| P1 | `packages/gateway/src/routes/infrastructure/metrics-routes.ts:48-160` 等 | 无时间窗全表聚合、JSONB join 谓词 | rollup + 扫描线 + 索引 |
| P1 | `packages/agent/src/scheduler/executor-client.ts:81-101` | 每次派发加载全部节点行（含 JSONB） | 快照缓存 + best-fit/一致性哈希 |

**已有一处正确实现，应作为模板扩散**：`packages/agent/src/governance-jobs-crud.ts:243-280` 的 `claimNextDueJob` = `ORDER BY next_run_at ASC NULLS LAST ... FOR UPDATE SKIP LOCKED`，是真正的 EDF + 安全认领。问题不在这个模式，而在其他地方没用它。

---

## 1. P0：provider 选择 → 受约束分配

### 1.1 现状（CONFIRMED）

`packages/agent/src/providers/provider-policy.ts:125-155`：

```ts
candidates = [...candidates].sort((a, b) => {
  ...
  if (isHealthierThan(scoreA, scoreB)) return -1;
  if (isHealthierThan(scoreB, scoreA)) return 1;
  const healthDiff = Math.abs(scoreA.score - scoreB.score);
  if (healthDiff <= 0.05 && costData && costData.size > 0) { ... }
  return scoreB.score - scoreA.score;
```

- 贪心排序，O(T log T)/请求；**无并发/配额/限流感知**。
- 健康度是 0.4/0.4/0.2 的**点估计**加权和（`provider-health.ts:155`），带 3 任务信任爬坡（`:100`），**无 EWMA、无置信区间**。
- `0.05` 阈值是**拍出来的**，没有统计依据——违反规则 `algorithmic-hotpath-discipline` §1。
- 调用点 `scheduler/provider-selection.ts:34-40` 做 `Promise.all(uniqueProviders.map(getProviderRecentOutcomes))` ⇒ **每个 provider 一次 24h SQL 聚合**。
- `provider-compat-evidence.ts:176` 是**无时间窗、无 LIMIT 的全表 `DISTINCT ON`**；`provider-policy.ts:134` 每目标 `evidence.find(...)` ⇒ O(T·E)。
- `scheduler-decision-ledger.ts:234, 269-276` 过滤 `kind+provider+24h` 并聚合 JSONB `metadata_json->>'durationMs'`；索引只有 `(graph_id|task_id|kind|session_id, created_at)`，**没有 `(provider, created_at)`**；`LIMIT` 在 `GROUP BY` 之后。
- **配额系统完全不存在**：61 个迁移里没有任何 quota/budget 列（ADR 0030 明确说 account-scoped quota history 仍待做）。`gateway/src/rate-limit.ts:26-63` 只是内存态 per-IP 固定窗口。provider 429/403 只被分类为"跳静态 fallback 链下一项"（`provider-fallback.ts:184-200`），**无 per-provider 令牌桶、无冷却、无熔断**。

### 1.2 改造（按依赖顺序）

1. **消除每请求 O(#providers) 聚合**：维护 per-provider 的 EWMA + Beta 后验（成功/失败计数），O(1) 更新、O(1) 读取。不要每请求扫 24h 历史。
2. **健康度用区间**（Beta 后验分位数）替代点估计；选择规则从 argmax 改 **Thompson 采样**或 UCB，天然处理信任爬坡与探索。落地后 `0.05` 这类魔数被区间估计取代。
3. **per-provider 令牌桶 + 熔断 + decorrelated jitter 冷却**。
4. **配额分配用 max-min 公平份额 / WFQ**，为关键作业保留配额。
5. `provider-compat-evidence` 加 latest-per-key 物化视图 / 部分唯一索引；内存侧用 `provider:model` 哈希表替代 `evidence.find`。

### 1.3 前置与风险

- **前置（必须先确认）**：生产是否设置 `providerModelTargets`。若未设置，`provider-compat-evidence.ts:176` 与 per-provider `Promise.all` 就是**死路径**，优先级应下调。
- **风险**：中。路由决策直接影响成本与成功率 ⇒ **影子模式**（影子决策 + 对比现有策略实际结果）后再切换。
- **可复用**：`packages/gateway/src/routes/streaming/stream-backoff.ts:52-70` 已是正确的指数 + full jitter 退避，直接复用。

---

## 2. P0：治理与任务调度

### 2.1 现状（CONFIRMED）

| 位置 | 现状 | 问题 |
|---|---|---|
| `governance-jobs-crud.ts:243-280` | `ORDER BY next_run_at ASC NULLS LAST ... FOR UPDATE SKIP LOCKED` | **正确**（EDF + 安全认领）—— 保持 |
| `governance-jobs-types.ts:190-194` | `computeNextRunAt` 以 **now** 为锚 | **周期漂移**，无追赶 |
| `governance-jobs-crud.ts:283-305` | 加载 ≤100 活跃行后在 JS 里 filter `next_run_at <= now()` | 索引 `idx_gov_jobs_next_run` **未被用上**；每 sweep 调两次 |
| `ga-circuit-breaker.ts:18-25` | 固定阈值 + 硬编码 24h HALF_OPEN | 无退避/抖动 |
| `scheduled-work/store.ts:190-247` | 一个事务内循环 ≤50 次**单行认领** + per-schedule `COUNT(*)` | 无公平性（一个 5 分钟 schedule 可霸占整个 tick）；无集合化认领 |
| `dead-letter-governance.ts:29-42` | 逐事件重入队（N+1 查询 + 动态 import） | 无退避 |
| `agent-task-graph.ts:224` | `claimReadyAgentTasks` 只按 `priority ASC, created_at ASC` | **`deadline_at` 列已存在**（`claim-decision.ts:68` 记录它）却**不做 EDF** |
| `agent-task-editable-surfaces.ts:16-25` | `selectedSurfaces.some(...)` 线性扫描 | 区间图/冲突打包被当线性扫描 |
| `task-runs/recovery.ts:19` | `SELECT * FROM task_runs WHERE status IN (...) AND lease_expires_at < now()` **无 LIMIT**，再逐行迁移+更新 | 积压时 O(N) 往返 |

### 2.2 改造

1. `computeNextRunAt` 以**上一个计划槽位**为锚 + 有界追赶（周期性实时调度的标准做法）。
2. `listDueGovernanceJobs` 用上已有索引：`WHERE next_run_at <= now()` 下推到 SQL。
3. `scheduled-work` 改**集合化批量认领** + 跨 schedule 的 **DRR / WFQ** 公平分享（天然防饿死）。
4. `claimReadyAgentTasks` 启用 **EDF**（`deadline_at` 已在 schema）。
5. 熔断改指数退避 + decorrelated jitter。
6. DLQ 批量认领 + 退避调度的重入队队列。
7. `recovery.ts` 改 `UPDATE ... RETURNING` 分批。
8. 可编辑面互斥改区间图 / 路径前缀 trie。

### 2.3 风险

中低。EDF 会改变执行顺序（可能影响长任务资源占用）⇒ 需要公平性指标可观测（见 §4）。

---

## 3. P0：流式路径写放大与 SSE 扇出

### 3.1 现状（CONFIRMED）

| 位置 | 现状 | 代价 |
|---|---|---|
| `gateway/src/chat-service-hooks.ts:85-93` | **每个 model delta** 都 `await persistStreamCheckpoint(...)`（回调在 `agent/src/loop.ts:256-258` 每次 token 被 await） | 每 token 一次检查点；**与 ADR 0015 §4 矛盾**（该 ADR 说 replay 需要时才存） |
| `agent/src/stream-checkpoints.ts:97-125` → `agent/src/event-log/file-backend.ts:48-84` | `readIndex()`（`readFileSync`）+ `appendFileSync` + `writeIndex()`（`writeFileSync`） | 每次 append **3 次同步 FS**；有 `runSpecId` 时 2 条流 ⇒ **每 token 约 6 次**，inline 在 token 路径 |
| `file-backend.ts:86-113` | `readFileSync(logPath)` 全文件 + 逐行 `JSON.parse` + filter | **每次 poll O(文件大小)** |
| `sse-routes.ts:224, 251, 290` | `for (const [cid, lc] of liveClients)` 遍历**所有**在线客户端，每个匹配者各发一次 `listSessionEventsSince` | **无 `sessionId → clients` 索引**；3 条投递路径（EventBus ×2 + PG NOTIFY）可能把同一查询做 3 次 |
| `sse-routes.ts:174-196` | 每客户端 1 秒 `setInterval` 轮询 | 叠加在 push 之上 |
| `sse-routes.ts:60-64, 231-239` | `reply.raw.write(...)` 返回值被忽略 | **无背压** |
| `executor-client.ts:396-408` | `buffer += decoder.decode(value); buffer.split(/\r?\n/)` | 长行二次复杂度；不向 executor 施加背压 |

### 3.2 改造

1. delta 持久化改**批/采样**：turn 边界写一次，replay 需求显式 opt-in（回到 ADR 0015 §4 的原始意图）。这直接消掉系统里**最高频的写**。
2. `file-backend` 改异步缓冲 writer + 内存 id 计数器；读取用**按流字节偏移游标 + tail read**。
3. SSE 加 `Map<sessionId, Set<client>>`；合并为单一投递路径；推送行本身而不是重查。
4. 尊重 `write()` 返回 false + `drain`；每客户端有界队列 + drop-oldest。
5. `executor-client` 改增量行扫描器（索引游标）。

### 3.3 风险

中。replay 语义与背压策略影响断线重连行为 ⇒ 需要专门回归（可借鉴 `stream-backoff.ts` 的设计思路）。

---

## 4. P1：可观测性查询与索引

### 4.1 现状（CONFIRMED）

| 位置 | 现状 | 复杂度 |
|---|---|---|
| `metrics-routes.ts:48-160` | 每次 scrape **5 个无时间窗全表聚合**（`task_runs` GROUP BY status、`run_evals` ×3、`provider_call_telemetry` GROUP BY provider） | O(全历史)/scrape |
| `agent/src/usage-summary.ts:170-215` | 扫整个 ≤90 天窗口的 `session_events` 并抽 `(payload_json->'cost'->>'totalCostUsd')`；`:260` 再来一次 `COUNT(DISTINCT)`；`buildFeatureRows:305-330` 对每行 telemetry 做 LATERAL join | **`session_events` 无 `(type, created_at)` 复合索引**（`003_session_events.sql:25-36`） |
| `agent/src/metrics-activity.ts:160-190` | `generate_series × session_events` 的 LEFT JOIN，**join 谓词含 JSONB 表达式** | O(buckets × events)，不可索引 |
| `gateway/src/routes/data/trace-routes.ts:220, 235, 277, 291` | 每次 poll 重读 `listSessionEvents(id, 10000)` 并重新投影整个会话 | O(10k 事件 + 全量投影)/poll |
| `agent/src/daily-digest.ts:322-333` | `last_run` CTE = `DISTINCT ON (schedule_id) ... ORDER BY schedule_id, scheduled_for DESC`，**无时间界** | 扫全部历史 run |
| `agent/src/governance-auditors-event-retention.ts:33-56` | 在**最大的表**上按 `payload_json->>'archived_at' IS NULL` 做 COUNT/扫描 | 顺序扫描 |
| `agent/src/governance-auditors-performance.ts:19-55` | 从 `provider_call_telemetry` 取 `latency_ms, cost, is_error, prompt_tokens, completion_tokens` | **这些列都不存在**（`016_provider_evidence.sql:49-67` 是 `duration_ms, status, usage_json`；`latency_ms` 属于 `run_evals`，`019:25`）⇒ 异常在 `:58-60` 被吞 ⇒ **los 唯一的性能审计静默返回空** |

### 4.2 改造

1. **先修 `governance-auditors-performance.ts` 的列名**——这是唯一能自身暴露"性能审计坏了"的地方。**优先级高于所有优化。**
2. 成本/用量改**增量预聚合 rollup**（物化视图或 Prometheus 计数器），删掉 JSONB 全窗口扫描。
3. `metrics-activity` 改**扫描线**：把每个事件的 `[start, start+duration]` 当区间，排序后单趟扫过桶 ⇒ O(n log n)，替代 `generate_series × events`。
4. 补索引：`session_events(type, created_at)`、`scheduler_decisions(provider, kind, created_at)`、活跃 `scheduled_work_item_runs(schedule_id)` 的部分索引、`provider_compat_evidence` 的 latest-per-key 视图。
5. `/metrics` 改时间分桶 rollup + p50/p95 直方图（当前只有 avg/max）。
6. trace replay 改**带水位/检查点的增量投影**。
7. `governance-auditors-event-retention` 把 `archived_at` 提升为真实列 + 部分索引。

---

## 5. P1：节点放置与探测预算

### 5.1 现状（CONFIRMED）

- `agent/src/scheduler/executor-client.ts:81-101` + `executor-nodes.ts:441-467`：`listExecutorNodes(100)` 后 `sortExecutorCandidates`，**比较器里每次重算 `Object.keys(a.capacity).length`**；每次派发加载**全部**节点行（含 JSONB）；能力过滤 O(N×R)；容量只当二值阻塞 ⇒ 贪心 first-fit。
- `executor-client.ts:54-61`：另一分支**重复**做一次全量加载。
- `gateway/src/node-auto-probe.ts:65-76`：`nodes.filter(isAutoProbeEligible).sort(by lastHeartbeatAt).slice(0, maxPerTick=2)` ⇒ 120s tick、每 tick 2 个探测，"最新心跳优先"。

### 5.2 改造

1. 节点选择改**资源向量上的 best-fit / least-loaded**；亲和性用一致性哈希；缓存节点快照。
2. 比较器预计算 `capacity` 维度数。
3. 探测调度改**陈旧度 EDF** 或跨 host/region 的 **DRR**，在探测预算内轮转。

---

## 6. 不要动（已正确）

- `stream-backoff.ts:52-70`：指数 + full jitter 退避
- `executor-nodes.ts:302-319`：`markStaleExecutorNodesOffline` 集合化 UPDATE
- `idempotency.ts:32-42`：唯一索引
- `session-events.ts:283`：`appendSessionEvents` 批量写
- `fleet-resources.ts:150`：带滞回阈值
- `governance-jobs-crud.ts:243-280`：EDF + `FOR UPDATE SKIP LOCKED` 认领

---

## 7. 验证与验收

### 7.1 前置

- 确认生产是否设置 `providerModelTargets`（决定 §1 的优先级）。
- 确认关键表行数（`session_events`、`provider_call_telemetry`、`scheduled_work_item_runs`）——全表扫描的**绝对**成本取决于此。
- 新增基准/影子对比能力：路由策略切换前必须有影子模式。

### 7.2 现有可用的观测面

- `chat-service-hooks-storm.test.ts:19-25`：正确性风暴测试（断言 200 次工具转换 ≤6 个 compaction pair）——**不是延迟基准**。
- `tools/stress-agent-parallel.sh`：测试套件稳定性，不是运行时性能。
- `tools/observe-command-resources.mjs`：CI 作业 RSS/CPU。
- **无路由/调度/SSE 的负载测试或延迟预算。**

### 7.3 验收口径

| 改造 | 量化口径 |
|---|---|
| 路由 | 每请求 SQL 次数（当前 O(#providers)）、429 率、成本/成功率对比（影子模式） |
| 治理调度 | 周期漂移量、跨 schedule 的 tick 份额分布、tick 内往返次数（当前 4×50） |
| 流式 | 每 token 同步 FS 次数（当前 3–6）、每 turn 检查点数、write() 背压触发率 |
| 可观测性 | `/metrics` scrape 耗时、`/metrics/activity` 计划行数、trace poll 投影行数 |
| 索引 | 4 个新索引的 `EXPLAIN (ANALYZE, BUFFERS)` 前后对比 |

---

## 8. 拒绝清单（来自 math 合集的负面结果）

| 想法 | 为什么不做 | 来源 |
|---|---|---|
| 用更强的 SDP/半定松弛优化路由/分配 | 完美匹配多面体任何精确 SDP 提升都是指数规模 | 结果 126 |
| 期望在常数因子内最优解决配额打包 | 配置 LP 间隙**无界**，且任意固定**加性**常数内近似 NP-hard | 结果 118 |
| 用 k-server 的 `O(log²(k+1))` 直接实现在线负载均衡 | 竞争比是**在线**界，且"附加移动常数是实例相关，可能极大"；只作设计原则 | 结果 110 |
| 把 `2^-310` 的 prophet inequality 竞争比当可实现采样策略 | 无实用值；只贡献"单样本足够"的定性结论 | 结果 111 |
| 用 mean-payoff 博弈拟多项式算法重写治理调度器 | 仅在状态空间可控时可用；当前状态数未论证 | 结果 104 |

---

## 9. 参考

- 完整映射报告：`dsfolder/MATH-TO-CODE-OPTIMIZATION-RESEARCH-2026-10-07.md`
- 审计方法：skill `algorithmic-hotpath-audit`
- 决策纪律：`~/.claude/rules/algorithmic-hotpath-discipline.md`
- 运行时真源：`docs/operations/`、`docs/adr/0030-*`（配额）、`docs/adr/0015-*`（流式检查点）
