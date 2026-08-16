# Recovery Drills — 故障注入恢复演练（Roadmap R3）

> 日期：2026-08-16
> 实现：`packages/gateway/src/recovery-experiment.ts`（5 类场景 × 注入 → 生产恢复路径 → 结构化断言）
> 契约/追踪：`docs/governance/2026-08-16-product-roadmap.md` R3；todo `todo-los-rm-fault-injection`
> 背景指标：2026-08-16 SLO 实测 30 天恢复率仅 7.1%（56 次 attempt>1 只成功 4 次）——本演练是恢复机制的可重放证据面

## 运行命令（可重复，证据即输出）

```bash
pnpm --filter @los/gateway exec node --import tsx --test src/recovery-experiment.test.ts
```

每个场景独立成测试：注入故障 → 走生产恢复路径（lease reaper / dispatch 恢复扫描器 / outbox 发布器 / 远程 circuit / session 账本重放）→ 断言恢复行为 → 清理。**任何场景都不得绕过 AP1（transitionExecutionState）或 AP3（canMarkSucceeded）**：注入与恢复全部调用生产组件，测试只提供数据与断言。

## 场景清单与断言（2026-08-16 实测 6/6 通过）

| 场景 | 注入方式 | 恢复路径 | 关键断言 |
| --- | --- | --- | --- |
| `lease_expired` | running task_run，lease 已过期 60s（模拟网关崩溃） | `reapExpiredExecutionLeases`（advisory lock + 状态机迁移） | 任务被回收（status≠running）；dead_letter_events 落一条租约过期记录 |
| `process_terminated` | plan_approved run_spec，无任何 task attempt（批准后进程死亡） | `recoverApprovedRunDispatches`（协调锁 + 同一派发入口） | 锁获取成功；run 重新派发（mock dispatch 收到 runSpecId） |
| `sse_interrupted` | 3 条会话事件追加后"流中断" | 从持久化 `session_events` 账本重读 | 全部事件可重放、顺序一致、无重复（追加日志=回放结构性免费） |
| `db_unavailable` | outbox 积压一条记录（模拟 DB 故障期事件入队） | `publishExecutionOutboxBatch`（claim→publish→mark） | 积压记录被投递（sessionEventId 匹配） |
| `executor_disconnected` | 远程节点失败上报（circuit 打开） | `remote-executor-circuit`（backoff 窗口 + 成功重置） | 注入后 circuit open；backoff 窗口内保持 open；成功心跳后 reset |

## 证据示例（真实输出，2026-08-16）

```
✔ recovery drill: lease_expired reaps the task and writes a dead letter (107ms)
✔ recovery drill: process_terminated re-dispatches the approved run (18ms)
✔ recovery drill: sse_interrupted replays the persisted ledger without loss (12ms)
✔ recovery drill: db_unavailable drains the backlogged outbox after recovery (13ms)
✔ recovery drill: executor_disconnected opens the circuit until a success resets it (2ms)
✔ recovery drill: every scenario in the catalog is runnable (0.5ms)
pass 6 / fail 0
```

## 边界与后续

- 演练证明"恢复机制可重放"，**不证明生产恢复健康**：SLO 报表（R2）的 7.1% 恢复率仍是真问题，R3 后续应在真实恢复路径上加 `recovery_experiments` 结构化记录（当前证据=测试输出 + 本文档），并对照 SLO 恢复率追踪。
- 未覆盖：跨网关 failover 演练（execution-reliability.test.ts 已有双网关测试可作对照）、SSE 中断后 WS 游标续传（stream-lease 测试覆盖部分）。
- 变更恢复机制代码后必须重跑本演练（回归门）。
