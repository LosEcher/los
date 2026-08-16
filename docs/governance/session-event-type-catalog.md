# Session Event Type Catalog

**目的**: 标准化 los session 事件类型，作为 `session_events.type` 的权威参考。
**灵感**: Deer Workflow 的标准化事件协议。

> **权威来源（2026-08-16 起）**: 类型注册表在
> `packages/agent/src/event-types.ts`（`SESSION_EVENT_TYPE_GROUPS` 精确类型 +
> `SESSION_EVENT_TYPE_PREFIXES` 前缀族），`appendSessionEvent`/`appendSessionEvents`
> 写入时经 `assertSessionEventType` 校验（默认告警，`failOnUnknownType` 时抛错）。
> 本文档的域划分与完整类型列表与注册表保持一致；新增事件类型必须在注册表登记
> （catalog 规则：PR 标记 `event-protocol-change`）。

## 命名约定

事件类型遵循 `domain.action` 命名约定，用 `.` 分隔域和动作：

| 域 | 含义 |
|-----|------|
| `run` | RunSpec 生命周期事件 |
| `task` | TaskRun 生命周期事件 |
| `session` | Session 生命周期事件 |
| `context` | 上下文窗口相关事件 |
| `provider` | Provider 路由/fallback 事件 |
| `verification` | 验证记录事件 |
| `kernel` | 执行内核事件 |
| `hook` | Lifecycle hook 事件 |
| `operator` | 操作员控制事件 |
| `runtime` | 外部 agent CLI 运行事件 |

## 完整类型列表

### Run 域 (`run.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `run.created` | RunSpec 创建 | `run-phase-transitions.ts` |
| `run.plan_approved` | 计划已批准 | `run-spec-plans.ts` |
| `run.plan_revised` | 计划已修订 | `run-spec-plans.ts` |
| `run.recovery_required` | 需要恢复 | `scheduled-task-runner.ts` |
| `run.recovery_cancelled` | 恢复已取消 | `tool-call-recovery.ts` |
| `run.operator_attention_required` | 需要操作员关注 | `tool-call-recovery.ts` |
| `run.blocked` | 运行被阻塞 | `scheduled-task-runner.ts` |

### Task 域 (`task.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `task.created` | TaskRun 创建 | `scheduler.ts` |
| `task.running` | 任务运行中 | `scheduled-task-runner.ts` |
| `task.succeeded` | 任务成功 | `scheduled-task-terminal.ts` |
| `task.failed` | 任务失败 | `scheduled-task-terminal.ts` |
| `task.cancelled` | 任务取消 | `scheduled-task-terminal.ts` |
| `task.blocked` | 任务阻塞 | `scheduled-task-terminal.ts` |
| `task.recovery_followup_queued` | 恢复跟进已入队 | `recovery-follow-up.ts` |

### Context 域 (`context.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `context.fill.warn` | 填充率 60% 警告 | `agent-lifecycle.ts` |
| `context.fill.checkpoint` | 填充率 75% 检查点 | `agent-lifecycle.ts` |
| `context.fill.critical` | 填充率 85% 紧急 | `agent-lifecycle.ts` |

### Provider 域 (`provider.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `provider.fallback.selected` | Fallback 选中 | `scheduled-task-runner.ts` |
| `provider.fallback.triggered` | Fallback 触发 | `providers/fallback.ts` |

### Verification 域 (`verification.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `verification.running` | 验证执行中 | `verification-records.ts` |
| `verification.succeeded` | 验证成功 | `verification-records.ts` |
| `verification.failed` | 验证失败 | `verification-records.ts` |

### Kernel 域 (`kernel.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `kernel.started` | 内核启动 | `execution-kernel.ts` |
| `kernel.finished` | 内核完成 | `execution-kernel.ts` |

### Runtime 域 (`runtime.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `runtime.started` | 外部运行时请求已接受 | `runtime-task.ts` |
| `runtime.process` | 外部子进程已生成 | `runtime-task.ts` |
| `runtime.output` | 有界、脱敏输出及字节摘要 | `runtime-task.ts` |
| `runtime.completed` | 子进程正常结束，包括非零退出 | `runtime-task.ts` |
| `runtime.error` | 适配器或生成进程失败 | `runtime-task.ts` |
| `runtime.cancelled` | 调用方断连或 AbortSignal 取消 | `runtime-task.ts` |

外部运行时事件以 `external-runtime:<kind>` 作为 source，持久层只保留
生命周期字段和最多 2000 字符的脱敏输出摘要；原始 prompt、stderr、环境变量、
鉴权材料和完整 transcript 不进入 `session_events`。

### Hook 域 (`hook.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `hook.succeeded` | Hook 执行成功 | `lifecycle-hooks.ts` |
| `hook.failed` | Hook 执行失败 | `lifecycle-hooks.ts` |

### Operator 域 (`operator.*`)
| 类型 | 描述 | 来源 |
|------|------|------|
| `operator.steering` | 操作员转向指令 | `operator-control.ts` |
| `operator.followup` | 操作员跟进指令 | `operator-control.ts` |

## Print Mode

事件序列化时有两种模式：

| Mode | 描述 | 使用场景 |
|------|------|----------|
| `compact` | 仅 type + 摘要 payload | 日志、webhook、notification |
| `full` | type + 完整 payload + 元数据 | session replay、evidence、audit |

API 端点 `GET /sessions/:id/events` 通过查询参数 `?mode=compact|full` 切换。

## 治理

- 新增事件类型前必须在此 catalog 中注册
- 事件类型变更需在 PR 中标记 `event-protocol-change`
- 废弃的事件类型保留但不新增发射点，60 天后移除
