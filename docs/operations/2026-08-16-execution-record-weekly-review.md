# 执行记录周复盘：数据源与精确查询（2026-08-16 定稿）

配套 `docs/governance/periodic-analysis.md` 的
"Execution-Record Driven Review (weekly)" 章节。本文档固化数据源清单、
精确 SQL 与判定口径，由 2026-08-16 全面盘点实证校准。

## 数据源清单

| 表 | 记录内容 | 周复盘用途 |
| --- | --- | --- |
| `provider_call_telemetry` | provider 调用（model/status/duration/usage/error） | provider 可用性、零调用、错误率 |
| `scheduler_decisions` | 调度决策账本（claim/recover/selection） | 调度异常、租约重试 |
| `governance_jobs` | 21 个 GA job 的 cadence/status/circuit/failures | 治理循环健康 |
| `dead_letter_events` | 死信（lease_expired/unrecoverable，含 resolution） | 新死信归因 |
| `executor_nodes` | 节点注册（status/capacity/verified/heartbeat） | 节点生命周期（offline→retired） |
| `fleet_watch_state` / `fleet_host_check_state` | 节点资源水位与主机健康 | 容量告警（daily digest 已推送） |
| `run_evals` / `pairwise_*` | 模型/内核对比评估 | 评估 backlog 进展 |
| `session_events` | 事件账本（message.delta 为最大体积） | 体积治理（event_retention job 已调优） |

## 精确查询（本机 PostgreSQL，端口 55432）

```bash
export $(grep -E '^(DATABASE_URL|TEST_DATABASE_URL)=' .env | head -2)
PSQL="psql $DATABASE_URL -tAc"
```

**1. 治理 job 健康**（escalated/paused/circuit 优先关注）：
```sql
select job_type, cadence, status, circuit_state, consecutive_failures, last_run_at
from governance_jobs order by job_type;
```

**2. provider 近 7 天调用与错误**：
```sql
select provider, count(*),
       count(*) filter (where error is not null) as errs
from provider_call_telemetry
where created_at > now() - interval '7 days'
group by provider order by 2 desc;
```

**3. 新死信（本周）**：
```sql
select reason, count(*) from dead_letter_events
where created_at > now() - interval '7 days' group by reason;
```

**4. 节点生命周期**（retired 检查）：
```sql
select node_id, node_kind, status, updated_at::date
from executor_nodes order by status, node_id;
```

**5. 事件体积趋势**（session_events 瘦身后的基线参考）：
```sql
select count(*) from session_events;
-- 2026-08-16 清理后基线：72,269 行 / 80MB（清理前 468,002 行 / 557MB）
```

## 判定口径（2026-08-16 实证校准）

1. **Provider "ready but unused"**：adversarial_review 的 7 天窗口会漏报
   （2026-08-15 finding 报 packycode 零调用，但 8-16 复查其 7 天窗口内
   有 10 次调用）。周复盘用 14 天窗口复核后再决定 discovery 保留/退役。
2. **Node retired**：`status='retired'` 由网关维护循环在 offline 超 30 天
   后自动标记（2026-08-16 起）。周复盘确认无重新上线迹象后可删注册行
   （删除前查 `node_commands`/`task_runs`/`session_events` 引用，先例：
   oracle-t/localnode34 零引用删除）。
3. **绝对量内存告警**：`memory_available_abs` 信号（标准节点 <512MB
   warning / <256MB critical；轻节点 total≤2GB 用 256MB 阈值）。轻节点
   （oracle-executor 954MB）的 444MB 空闲属健康状态，不触发。
4. **死信**：67 条（2026-08-16 时点）全部已确认；周复盘只关注新增
   未确认（resolution 为空且 ack 未置）的死信。

## 复盘产出规则

- 每个发现必须转成 owned item：doc / ADR / test / todo / provider-gate 变更
- 复盘记录写入 `docs/operations/<date>-execution-record-weekly-review.md`，
  证据标记沿用 [E]/[I] 约定
- 无发现也要记录 "no action with evidence"，避免无主观察堆积
