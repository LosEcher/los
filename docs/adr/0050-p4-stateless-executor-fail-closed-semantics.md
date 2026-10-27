# ADR 0050: P4 Stateless Executor Semantics — Accept Fail-Closed, Keep `none` As Canary

- **Status**: Accepted（2026-10-18）
- **Date**: 2026-10-18
- **依据**: `docs/architecture/2026-10-18-executor-db-mode-and-state-ownership.md` 的 P4 close decision；`docs/architecture/2026-10-18-task-token-heartbeat-and-stateless-executor.md` 的 B1–B4；2026-10-18 的 live 证据（见 `docs/operations/2026-10-18-p4-fail-closed-evidence.md`）
- **范围**: 远端无 DB executor（`EXECUTOR_DB_MODE=none`）在 gateway 重启/租约丢失/审批缺失时的语义。**不涉及** 控制面 DB 模式、调度放置、provider 路由、存储保留策略。

---

## Context

P4 的验收有两条分支：证明任务能跨 gateway 重启存活，或显式接受 fail-closed。P4 实际走的是后者：

- 正常 no-DB 调度任务成功，node34 `eventBacklog=0`、`spoolBacklog=0`；
- 长任务执行期间重启 gateway，任务被 reaper 判为 failed；running scheduled runs = 0（scheduled run 的收敛证据含手工/回填，见 evidence §3.3，不当作自动 sweep 的证明）；
- 无审批通道的 headless 审批发出 `tool.approval_required`，但默认 `warn` 仍执行；只有 `block` 才拒绝。这是未关闭缺口，不是 fail-closed 证据。

未证明的是“任务跨 gateway 重启成功”。gateway 启动观测到几十秒到几分钟，而 scheduled lease 是 300s 预算，不是保证。因此 `none` 不能提升为远端默认。

这个结论此前写在架构文档的 “Next required work 1” 里，仍是**待决**状态。待决状态有实际代价：部署面、runbook 和 reviewer 会反复问“到底要不要做 restart-survival 专项”，而每次回答都要重新推导一遍证据。本 ADR 把语义定死，并把“什么情况下可以改”写成可验收的清单。

---

## Decision

### 1. 接受 fail-closed 作为 P4 的最终语义

`EXECUTOR_DB_MODE=none` 在 gateway 缺失/重启/租约丢失时**不保证任务继续**。任务失败的路径必须是显式、可观测的。

本 ADR 的“fail-closed”范围**仅限 lease/重启/租约失效**。审批默认 warn、succeeded + stuck scheduled run、run_spec block 异常被吞是**未关闭缺口**，不属于已接受的 fail-closed；它们必须在提升 `none` 前关闭。下表区分“已实现的 fail-closed 路径”与“仍是缺口的路径”；不要把后者写成已关闭：

| 情况 | 必须的结果 | 实现锚点 |
| --- | --- | --- |
| task lease 过期 / gateway 重启后租约失效 | task_run 进入 failed；写 dead letter（`lease_expired`）；**尝试**收敛关联 scheduled run（失败仅 warn）；**尝试**把 run_spec 置 blocked（异常被吞，30 分钟 stale sweep 仅兜底） | `packages/gateway/src/execution-lease-reaper.ts:44`（reap）、`:51`（dead letter）、`:58`（scheduled convergence）、`:66-72`（run_spec block + swallow） |
| task 已 failed/cancelled/blocked 但 scheduled run 仍 running/claimed | 独立 orphan sweep 把 scheduled run 收敛为 failed；**succeeded 的卡住 run 不在扫描范围**（见下） | `packages/gateway/src/execution-lease-reaper.ts:18`、`:25-26`（扫描范围） |
| 显式完成 | `POST /tasks/:id/complete` **尝试**收敛 linked scheduled run；transition 失败被吞成 `scheduledWarning` 且仍返回 200，**不是硬保证** | `packages/gateway/src/routes/orchestration/task-complete-routes.ts:78-101`（transition 在 `:83`） |
| 无审批通道的 headless 审批 | **默认 warn**：发出 `tool.approval_required` 后 handler 仍执行；只有 `LOS_TOOL_APPROVAL_ENFORCEMENT=block` 才拒绝（`tool.denied`，`reasonCode=tool_approval_required`）。当前 fleet 未设置 block ⇒ **不是 fail-closed**，列为提升门槛与待办 | `packages/agent/src/los-tool-broker.ts:219-243`；测试 `packages/agent/src/los-tool-broker-approval.test.ts:50`（warn 执行）、`:75`（block 拒绝） |
| 权限/租约错误（401/403/409/503） | task token 路径立即 abort，不回落 DB | `packages/executor/src/lease-fencing.ts:67-70`；`docs/architecture/2026-10-18-task-token-heartbeat-and-stateless-executor.md` §3.3 |

**不是**可接受的结果：静默重试成另一个 task、把 failed 当 succeeded、scheduled run 永久 running、headless 审批被当成已批准、或“gateway 重启后任务继续跑”在没有证据时被写成默认行为。

**三个已登记缺口（B2 已关闭，保留记录）**：

1. **（B2 前）审批默认是 warn，不是 fail-closed**：`tool.approval_required` 是记录，不是拒绝；只有 `block` 才拒绝。**Closed 2026-10-19 (B2)**：stateless executor 由 `executionMode=stateless` 强制 `block`，handler 不运行；interactive/local 与 remote DB-mode executor 仍是 warn-by-default（后者也 headless，但本轮未改）。见 `docs/operations/2026-10-19-b2-approval-and-convergence-hardening.md`。
2. **（B2 前）succeeded + stuck scheduled run**：显式完成吞掉 convergence 异常；orphan sweep 只扫 failed/cancelled/blocked。**Closed 2026-10-19 (B2)**：sweep 覆盖 succeeded/claimed、加 active-task 与 run-lease 守卫、latest-attempt 选择，按 task 终态收敛到 succeeded/failed 并记录 schedule outcome；completion 失败返回 `scheduledConvergencePending`。completion route 也在 run transition 后记录 schedule outcome 并创建 circuit-open recovery work item；succeeded result work item 仍由正常 runner 创建（backstop 不伪造结果）。见同一 evidence doc。
3. **（B2 前）run_spec block 异常被吞**：reaper 的 `transitionExecutionState` 失败只被 `.catch(() => undefined)` 吞掉。**Closed 2026-10-19 (B2)**：失败现在写 `log.warn`，30 分钟 stale sweep 仍是兜底但不再静默。

### 2. `none` 保持 canary，不是远端默认

- 远端默认仍是 `EXECUTOR_DB_MODE=required`（控制面/文件同步节点）。
- `none` 只用于显式声明、已通过部署门禁的节点；当前唯一在跑的 canary 是 `node34-executor-1`。
- 任何文档、脚本、面板不得把 `none` 描述成“默认”“已提升”“已完成去 DB 化”。
- 回滚路径固定为 `/opt/los/.env.p3-backup` + 重启 `los-executor`（见 runbook）。

### 3. 提升 `none` 的条件（全部满足才可重新评审）

这不是排期，而是**证据门槛**。任一条不满足，`none` 都不得成为默认：

1. **受控重启存活**：在可重复专项里，长任务跨 gateway 重启后仍成功，或有显式 task-level resume 协议（带 fencing）；连续 **20/20** 次，故障注入至少覆盖 gateway kill、gateway 网络分区、executor 重启三类。
2. **有界启动预算**：实测 gateway 冷启动上界（**≥20 次样本，给出 p50/p95/max**），并证明上界小于 lease/续租预算；否则必须有 lease 延长或任务级检查点。
3. **事件缺口可检测**：event sink 有全局序列/缺口检测；health 暴露 `eventBacklog`/`spoolBacklog` 之外的可判定缺口计数（**20 次重启演练中缺口计数为 0**，或缺口能被明确归因并补回）。
4. **恰好一次收敛**：重启/重试下 task、scheduled run、run_spec 的终态只写一次；旧 lease/旧 token 的写回被拒绝；扩展到 succeeded 的 orphan sweep 并覆盖 convergence 异常。
5. **部署门禁覆盖全 fleet**：所有节点显式声明 `EXECUTOR_DB_MODE`，`deploy-to-remote.sh preflight/verify/mode` 全绿，回滚演练通过。
6. **headless/stateless 审批已强制**：stateless executor 由 `executionMode=stateless` 强制 `block`（已实现并有测试）；仍需部署断言，确保 `EXECUTOR_DB_MODE=none` 的节点实际运行该版本。

达到**全部六条**后，由新的 ADR 取代本 ADR；不得只改文档措辞。

### 4. 运维含义

- 重启 gateway 前，先看是否有 no-DB 任务在跑；有则接受“该任务会 failed”，或等它结束。
- 重启后检查 `scheduled_work_item_runs` 无 running/claimed 残留，并确认相关 run 的 error 是 fail-closed 原因（lease expired / orphaned terminal），不是空错误。
- 部署门禁（`tools/deploy-to-remote.sh`）继续作为 `none` 的 fail-closed 前置条件；它不替代本 ADR 的语义。

---

## Consequences

**Positive**

- P4 不再处于“待决”：review、部署和 on-call 有一个明确的失败语义。
- 不会为了“看起来完成了去 DB 化”而把未证明的 restart-survival 写成默认。
- 提升条件是可机械验收的，而不是“再讨论一次”。

**Negative / 代价**

- `none` 的可用性上限就是 fail-closed：gateway 重启会损失在跑任务。这是有意的取舍。
- 远端 fleet 仍以 DB 模式为主，无法立刻享受“无 DB 凭据”的全部运维收益。
- 需要持续维护 canary 与默认的措辞边界；任何“顺手把 none 设成默认”的改动都必须被拒绝。

**Risk / 缓解**

- 风险：fail-closed 被误读成“任务可以静默丢失”。缓解：reaper/dead letter/scheduled convergence 的 live 证据与测试锚点写进本 ADR 与 evidence doc；空错误或永久 running 视为缺陷。
- 风险：canary 长期不提升变成永久例外。缓解：提升条件与重新评估触发条件明确；下一批若做 restart-survival，直接对照 §3。

---

## 重新评估的触发条件

出现任一情况时必须重新评审本 ADR：

1. gateway 冷启动上界被实测并稳定小于 lease 预算（有 ≥20 次样本）。
2. 实现 task-level checkpoint/resume 且带 fencing，旧执行者不能写回。
3. event sink 具备全局序列/缺口检测并接入 health。
4. 调度器改变 lease 续租策略（例如可配置的 lease 延长）或引入任务级重试语义。
5. `EXECUTOR_DB_MODE=none` 被要求用于第二个生产节点。

---

## References

- `docs/architecture/2026-10-18-executor-db-mode-and-state-ownership.md`
- `docs/architecture/2026-10-18-task-token-heartbeat-and-stateless-executor.md`
- `docs/operations/node-deployment-runbook.md`
- `docs/operations/2026-10-18-p4-fail-closed-evidence.md`
- `docs/adr/0047-tool-project-and-provider-boundary-ownership.md`（R3 真相优先级与"可机械检查"原则）
