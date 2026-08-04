/**
 * @los/agent/todo-seeds-daily-gaps — Daily-usable agent gap subtask seeds (2026-07-27).
 *
 * Wave 1-2 sub-tasks. Wave 3 lives in todo-seeds-daily-gaps-wave3.ts.
 * Parent entries in audit-baseline-p1.ts and context-engineering.ts.
 *
 * Wave 1 (no upstream deps, parallel): context-reconstruction (5), deferred-tool-loading (5)
 * Wave 2 (depends on Wave 1):        compaction-hooks (6), stale-detection (5)
 */
import type { CreateTodoInput } from './todo-types.js';

export const DAILY_GAP_TODO_SEED: CreateTodoInput[] = [
  // ════════════════════════════════════════════════════════════
  // Wave 1 — context-reconstruction (5 sub-tasks)
  // parent: todo-los-p1-context-reconstruction
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-cr-protocol',
    title: '定义 checkpoint→handoff 恢复协议 contract',
    description:
      '定义 session recovery 的数据契约：checkpoint 中保存哪些状态（tool state、引用文件快照、消息游标）、\n' +
      '恢复时如何重建消息数组、恢复后的第一条系统消息格式。\n' +
      '需覆盖：正常完成恢复、部分 checkpoint 缺失、checkpoint 版本不兼容三种场景。',
    kind: 'task',
    status: 'done',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-context-reconstruction',
    dependsOnIds: [],
    dedupeKey: 'los:todo:gap-cr-protocol',
    metadata: {
      problem: '没有形式化的恢复协议，checkpoint 内容不明确，handoff 格式未定义',
      acceptance: [
        'contracts/session-recovery.yaml 定义 checkpoint schema、恢复流程、错误场景',
        'checkpoint 包含 tool state 快照、引用文件路径和哈希、最近 N 条消息的游标',
      ],
      candidateFiles: ['contracts/session-recovery.yaml'],
      closedNote: '2026-08-08: contracts/session-recovery.yaml v0.1.0 + CHECKPOINT_VERSION/isCheckpointVersionSupported in session-recovery.ts; tool-state snapshot writing tracked in todo-los-gap-cr-tool-state',
    },
  },
  {
    id: 'todo-los-gap-cr-reconstruct',
    title: '实现 reconstructSessionContext()',
    description:
      '从 session_events + stream_checkpoints + memory_compactions 中重建最后一次有效 checkpoint\n' +
      '前的完整消息数组。按 event 时间顺序组装：系统消息 → 历史对话 → 未完成的 tool call。\n' +
      '对于无法恢复的部分（tool result 已丢失），注入占位消息说明原因。',
    kind: 'task',
    status: 'done',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-context-reconstruction',
    dependsOnIds: ['todo-los-gap-cr-protocol'],
    dedupeKey: 'los:todo:gap-cr-reconstruct',
    metadata: {
      problem: '不存在 resumeSession() 或 reconstructSessionContext()，无法从事件日志重建消息',
      solution: '查询 session_events + stream checkpoints + compaction 记录 → 按时间排序 → 组装消息数组',
      acceptance: [
        '从已知 checkpoint 可重建全部历史消息',
        '丢失的 tool result 以占位消息替代',
        '重建后的消息格式兼容 provider chat() 的 messages 参数',
      ],
      candidateFiles: ['packages/agent/src/session-recovery.ts'],
      closedNote: '2026-08-08: reconstructSessionContext() in session-recovery.ts:164; tests cover message rebuild, stub for lost tool results, provider-compatible messages',
    },
  },
  {
    id: 'todo-los-gap-cr-tool-state',
    title: '在 compaction onPreCompact 钩子中保存 tool state 快照',
    description:
      '在 chat-service-hooks.ts 中接入 onPreCompact 钩子：调用 session-recovery 协议\n' +
      '保存当前 tool call 状态（未完成的 tool call、最后成功/失败的工具结果引用）、\n' +
      '引用文件的路径和内容哈希、当前消息游标位置。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-context-reconstruction',
    dependsOnIds: ['todo-los-gap-cr-reconstruct'],
    dedupeKey: 'los:todo:gap-cr-tool-state',
    metadata: {
      problem: 'compaction 当前没有保存 tool state 快照，恢复时只能猜未完成的工作',
      solution: '在 onPreCompact 钩子中写 tool state checkpoint，关联到 session recovery 记录',
      acceptance: [
        '每次 compaction 前 tool state 快照已持久化',
        '快照包含未完成 tool call 的 callId + toolName + args',
        '快照包含最近 5 个引用文件的路径和 content hash',
      ],
      candidateFiles: ['packages/gateway/src/chat-service-hooks.ts'],
    },
  },
  {
    id: 'todo-los-gap-cr-chat-recovery',
    title: 'POST /chat 恢复路径：识别中断 session → 重建上下文 → 接续执行',
    description:
      '当 POST /chat 收到已存在但未正常完成的 sessionId 时，自动触发恢复流程：\n' +
      '1. 调用 reconstructSessionContext() 重建消息数组\n' +
      '2. 注入系统消息说明恢复范围（"你正在从 checkpoint 恢复，已完成 X，未完成 Y"）\n' +
      '3. 追加新用户消息，接续 agent loop 执行\n' +
      '4. 发出 session.resumed 事件，记录恢复来源 checkpoint',
    kind: 'task',
    status: 'done',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-context-reconstruction',
    dependsOnIds: ['todo-los-gap-cr-tool-state'],
    dedupeKey: 'los:todo:gap-cr-chat-recovery',
    metadata: {
      problem: '当前 POST /chat 不支持恢复已中断 session——每次只能新开会话',
      solution: '扩展 chat-service.ts：sessionId 对应已中断 session 时走 recovery 路径',
      acceptance: [
        'GET /sessions/recoverable 返回的 session 可通过 POST /chat {sessionId} 恢复',
        '恢复后的第一条消息是系统消息描述恢复范围和完成的/未完成的工作',
        '恢复不丢失之前 session 的已完成工具调用结果',
      ],
      candidateFiles: ['packages/gateway/src/chat-service.ts'],
      closedNote: '2026-08-08: chat-resume-plan.ts/chat-resume-guard.ts/run-resume-recovery.ts (G1); implemented without waiting on cr-tool-state',
    },
  },
  {
    id: 'todo-los-gap-cr-fixture',
    title: '端到端 session recovery fixture',
    description:
      '写聚焦测试覆盖完整恢复链路：\n' +
      '1. 模拟正常会话中断（写 session events + checkpoint）\n' +
      '2. 调用 reconstructSessionContext() 验证消息完整性\n' +
      '3. 模拟恢复后的 agent loop 继续执行\n' +
      '4. 验证恢复后的工具调用成功率和上下文引用正确性',
    kind: 'task',
    status: 'done',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-context-reconstruction',
    dependsOnIds: ['todo-los-gap-cr-chat-recovery'],
    dedupeKey: 'los:todo:gap-cr-fixture',
    metadata: {
      problem: '恢复协议的正确性需要端到端验证',
      acceptance: [
        'fixture 覆盖正常恢复 + 部分缺失 + 版本不兼容三种场景',
        '恢复后的消息数量 >= 原始消息数量的 80%（允许 tool result stub 替代）',
        '测试可通过 pnpm --filter @los/agent test 运行',
      ],
      candidateFiles: ['packages/agent/src/session-recovery.test.ts'],
      closedNote: '2026-08-08: session-recovery.test.ts end-to-end fixture covers intact/partial/incompatible-version + loop continuation via initialMessages',
    },
  },

  // ════════════════════════════════════════════════════════════
  // Wave 1 — deferred-tool-loading (5 sub-tasks)
  // parent: todo-los-deferred-tool-loading
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-dt-protocol',
    title: '在 AgentConfig 中增加 deferredToolLoading 配置键',
    description:
      'AgentConfig 新增可选字段：deferredToolLoading?: { mode: "name-only" | "full"; preloadTopN?: number }。\n' +
      '默认 mode="full" 保持向后兼容。mode="name-only" 时 system prompt 只发 name + 1-line description。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-deferred-tool-loading',
    dependsOnIds: [],
    dedupeKey: 'los:todo:gap-dt-protocol',
    metadata: {
      problem: 'createDeferredRegistry 已 100% 实现但无配置入口激活',
      solution: '在 AgentConfig 中增加 deferredToolLoading 字段，默认 full 模式保持兼容',
      acceptance: ['AgentConfig.deferredToolLoading 类型定义完整', '默认 mode="full" 行为不变'],
      candidateFiles: ['packages/agent/src/loop/setup.ts'],
    },
  },
  {
    id: 'todo-los-gap-dt-wire',
    title: 'loop setup 接入 createDeferredRegistry',
    description:
      'setup.ts 第 168 行当前直接使用 createToolRegistry。在 name-only 模式下：\n' +
      'const raw = createToolRegistry({ allowedTools, policy });\n' +
      'const tools = config.deferredToolLoading?.mode === "name-only"\n' +
      '  ? createDeferredRegistry(raw, config.deferredToolLoading)\n' +
      '  : raw;\n' +
      '改动约 5 行。createDeferredRegistry 已在 packages/agent/src/tools/core/deferred-registry.ts 中完整实现。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-deferred-tool-loading',
    dependsOnIds: ['todo-los-gap-dt-protocol'],
    dedupeKey: 'los:todo:gap-dt-wire',
    metadata: {
      problem: 'deferred-registry.ts 已 100% 实现但 createDeferredRegistry 从未被调用',
      solution: 'setup.ts 约 5 行改动即可接入',
      acceptance: [
        'mode="full" 时行为与当前完全一致',
        'mode="name-only" 时 system prompt 中 tool 定义不含完整 JSON schema',
        'tool 首次调用时 lazy resolve 延迟 < 1ms（纯内存操作）',
      ],
      candidateFiles: ['packages/agent/src/loop/setup.ts'],
    },
  },
  {
    id: 'todo-los-gap-dt-loop-setup',
    title: 'system prompt 验证：确认 name-only 模式下只发送 name list',
    description:
      '验证 name-only 模式下 getDefinitions() 返回的是 name-only 版本的 ToolDef[]：\n' +
      '每个 tool 包含 name + description + parameters: { properties: {}, required: [] }。\n' +
      '已物化（已使用过的）tool 返回完整定义。\n' +
      '写 focused test 验证 10/50 tools 下 definitions 大小差异。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-deferred-tool-loading',
    dependsOnIds: ['todo-los-gap-dt-wire'],
    dedupeKey: 'los:todo:gap-dt-loop-setup',
    metadata: {
      problem: 'name-only mode 接入后需要验证 system prompt 确实变小了',
      acceptance: [
        '50 tools 时 system prompt tokens < 原始的 30%',
        '已物化的工具保留完整定义',
        'tool.catalog 事件仍然包含所有 tool 的 name',
      ],
      candidateFiles: ['packages/agent/src/loop/setup.ts', 'packages/agent/src/deferred-registry.test.ts'],
    },
  },
  {
    id: 'todo-los-gap-dt-fallback',
    title: '降级策略：tool_choice 触发未物化 schema 时暂停、resolve、重试',
    description:
      '当 provider 通过 tool_choice 选择了尚未物化的 tool 时：\n' +
      '1. 检测 tool_choice 中的 tool name 对应的 schema 是否已物化\n' +
      '2. 如果未物化，暂停当前 turn，加载完整 schema\n' +
      '3. 重新发送本 turn 的请求（含完整 schema），让 provider 正确调用\n' +
      '这是边缘情况——理论上 provider 拿到 name-only def 也能通过 name 匹配调用。\n' +
      '但这层保护防止 provider 因缺少参数 schema 而拒绝调用。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-deferred-tool-loading',
    dependsOnIds: ['todo-los-gap-dt-loop-setup'],
    dedupeKey: 'los:todo:gap-dt-fallback',
    metadata: {
      problem: 'provider 可能拒绝只有 name+description 的 tool call，需降级路径',
      acceptance: [
        '未物化 tool 被 tool_choice 选中时自动 resolve 完整 schema',
        '重试不增加额外的 user-visible turn',
        '降级路径仅触发于 tool_choice 指向未物化 tool（正常情况不应触发）',
      ],
      candidateFiles: ['packages/agent/src/loop/tool-resolver.ts'],
    },
  },
  {
    id: 'todo-los-gap-dt-measure',
    title: 'token saving 验证：10/50/100 tools 下测量 prompt token 差异',
    description:
      '写 focused test 对比 full mode vs name-only mode 下的 system prompt token 数量：\n' +
      '10 tools: 预期 savings ~50%\n' +
      '50 tools: 预期 savings ~80%\n' +
      '100 tools: 预期 savings ~90%\n' +
      '用 token-utils 的 estimateTokens 做近似计算，不需要真实 provider 调用。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-deferred-tool-loading',
    dependsOnIds: ['todo-los-gap-dt-fallback'],
    dedupeKey: 'los:todo:gap-dt-measure',
    metadata: {
      problem: '需要量化 token savings 以验证 deferred loading 的价值',
      acceptance: [
        '10 builtin tools + 40 mock MCP tools → system prompt tokens < full mode 的 30%',
        'token savings 随 tool 数量增加而增长',
        '测试可通过 pnpm --filter @los/agent test 运行',
      ],
      candidateFiles: ['packages/agent/src/deferred-registry.test.ts'],
    },
  },

  // ════════════════════════════════════════════════════════════
  // Wave 2 — compaction-hooks (6 sub-tasks)
  // parent: todo-los-compaction-hooks
  // depends: cr-tool-state (checkpoint protocol), dt-wire (name-only tool list)
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-ch-precompact-checkpoint',
    title: 'PreCompact：在 chat-service-hooks 中接入 onPreCompact 保存 checkpoint',
    description:
      'chat-service-hooks.ts 当前在会话完成和事件计数触发时调用 compactSession，\n' +
      '但不传钩子。修改：传入 onPreCompact 调用 session-recovery 的 checkpoint 写协议，\n' +
      '保存当前 tool state 快照和引用文件快照。\n' +
      '同时接入 checkpoint 流写入点（事件计数 ≥ 20 / 工具状态转换 / 10min 间隔）。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-compaction-hooks',
    dependsOnIds: ['todo-los-gap-cr-tool-state', 'todo-los-gap-dt-wire'],
    dedupeKey: 'los:todo:gap-ch-precompact-checkpoint',
    metadata: {
      problem: 'compaction 钩子机制完整但三个关键调用路径都没传钩子——chat-service-hooks、server-maintenance、stream-checkpoint 触发点',
      solution: '在 chat-service-hooks.ts 的所有 compactSession 调用处传入 onPreCompact',
      acceptance: [
        '会话完成时的 compaction 触发 onPreCompact 检查点写入',
        '事件计数触发的 checkpoint 也走同一恢复协议',
        'onPreCompact 失败不阻塞 compaction（钩子 advisory）',
      ],
      candidateFiles: ['packages/gateway/src/chat-service-hooks.ts'],
    },
  },
  {
    id: 'todo-los-gap-ch-precompact-notify',
    title: 'PreCompact：operator SSE 推送 compaction 预告',
    description:
      '在 onPreCompact 钩子中通过 operator-events-sse 推送事件：\n' +
      'operator.compaction.pre_compact，包含 sessionId、trigger（event_count/tool_state/time_interval/manual）、\n' +
      'reason（触发原因描述）、preCompactAt（时间戳）。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-compaction-hooks',
    dependsOnIds: ['todo-los-gap-ch-precompact-checkpoint'],
    dedupeKey: 'los:todo:gap-ch-precompact-notify',
    metadata: {
      problem: 'operator 无法感知 compaction 即将发生——当前完全黑盒',
      acceptance: [
        'operator SSE 收到 compaction.pre_compact 事件',
        '事件包含 sessionId/trigger/reason/preCompactAt',
        '事件在 compaction 实际执行前发出',
      ],
      candidateFiles: ['packages/gateway/src/chat-service-hooks.ts'],
    },
  },
  {
    id: 'todo-los-gap-ch-postcompact-refiles',
    title: 'PostCompact：从 compaction metadata 重建引用文件 context',
    description:
      '在 onPostCompact 钩子中：从 compaction metadata 的 symbolSummary 字段\n' +
      '提取最近 5 个引用文件路径，re-read 文件内容，生成简化的 file context\n' +
      '注入到当前 agent loop 的消息历史中。文件变更检测（hash 不同）时标注。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-compaction-hooks',
    dependsOnIds: ['todo-los-gap-ch-precompact-checkpoint'],
    dedupeKey: 'los:todo:gap-ch-postcompact-refiles',
    metadata: {
      problem: 'compaction 后 agent 丢失了之前引用的文件上下文——不知该继续编辑哪个文件',
      solution: 'PostCompact 从 compaction symbolSummary 重建文件 context 并注入消息',
      acceptance: [
        '最近 5 个引用文件在 PostCompact 后重新可访问',
        '文件内容已变更时标注 (modified since compaction)',
        '文件内容仍相同时标注 (unchanged since checkpoint)',
      ],
      candidateFiles: ['packages/memory/src/core/compaction.ts'],
    },
  },
  {
    id: 'todo-los-gap-ch-postcompact-retools',
    title: 'PostCompact：用 deferred tool name list 重新声明可用 tool',
    description:
      '在 onPostCompact 钩子中：使用 deferred-tool-loading 的 name-only 模式\n' +
      '重新声明当前可用的 tool 列表。因为 compaction 后 context window 被清空，\n' +
      '需要重新告诉 agent 有哪些工具可用，但可以轻量（name list）重新声明。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-compaction-hooks',
    dependsOnIds: ['todo-los-gap-ch-postcompact-refiles', 'todo-los-gap-dt-wire'],
    dedupeKey: 'los:todo:gap-ch-postcompact-retools',
    metadata: {
      problem: 'compaction 后 tool 定义丢失——agent 不知道该用什么工具',
      solution: '用 deferred-tool-loading 的 name-only list 在 PostCompact 后重新声明 tools',
      acceptance: [
        'PostCompact 后 tool.catalog 事件重新发出',
        '使用 name-only list 减少声明 token 开销',
        '已物化的常用 tool 保留完整定义',
      ],
      candidateFiles: ['packages/gateway/src/chat-service-hooks.ts'],
    },
  },
  {
    id: 'todo-los-gap-ch-postcompact-metrics',
    title: 'PostCompact：记录 compaction 效果指标',
    description:
      '在 onPostCompact 钩子中计算并写入 compaction 效果指标：\n' +
      'tokenSavedCount（压缩前后提示 token 差异估计）、\n' +
      'compactionRatio（压缩后 token / 压缩前 token）、\n' +
      'postCompactionFillPct（压缩后 context fill 百分比）。\n' +
      '存入 memory_compactions 表的 summary_json 字段。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-compaction-hooks',
    dependsOnIds: ['todo-los-gap-ch-postcompact-refiles'],
    dedupeKey: 'los:todo:gap-ch-postcompact-metrics',
    metadata: {
      problem: 'compaction 效果不可观测——无从判断 compaction 是否有效、是否值得触发',
      acceptance: [
        '每次 compaction 记录 tokenSavedCount / compactionRatio / postCompactionFillPct',
        '指标可通过 memory_compactions 查询',
        'compactionRatio > 0.5（至少节省 50%）时才算有效 compaction',
      ],
      candidateFiles: ['packages/memory/src/core/compaction.ts'],
    },
  },
  {
    id: 'todo-los-gap-ch-postcompact-notify',
    title: 'PostCompact：operator SSE 推送 compaction 效果摘要',
    description:
      '在 onPostCompact 钩子中推送 operator.compaction.post_compact SSE 事件：\n' +
      '含 compactionId、sessionId、metrics（tokenSaved、ratio、fill%）、\n' +
      'observationCount、proceduralCandidateCount、confidence。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-compaction-hooks',
    dependsOnIds: ['todo-los-gap-ch-postcompact-metrics'],
    dedupeKey: 'los:todo:gap-ch-postcompact-notify',
    metadata: {
      problem: 'operator 不知道 compaction 结果如何——需要了解效果才能决定是否调整策略',
      acceptance: [
        'operator SSE 收到 compaction.post_compact 事件',
        '事件含效果指标摘要（token/ratio/fill%）',
        '事件含 procedural candidate 统计（数量/置信度）',
      ],
      candidateFiles: ['packages/gateway/src/chat-service-hooks.ts'],
    },
  },

  // ════════════════════════════════════════════════════════════
  // Wave 2 — stale-detection (5 sub-tasks)
  // parent: todo-los-p1-stale-detection
  // ════════════════════════════════════════════════════════════

  {
    id: 'todo-los-gap-sd-decay-model',
    title: '定义 decay score 模型',
    description:
      '定义每条 observation 的衰减分数计算规则：\n' +
      'score = baseScore(createdAt) × recencyFactor × referenceCountFactor × toolStatusFactor\n' +
      '- createdAt 越早 → 分数越低\n' +
      '- 被引用的 observation → 加分\n' +
      '- 关联 tool call 仍处于 running 状态 → 加分（活跃）\n' +
      '- 关联 tool call 已 failed/cancelled → 减分（不值得保留）\n' +
      '分数范围 0-1，< 0.3 判定为 stale。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-stale-detection',
    dependsOnIds: [],
    dedupeKey: 'los:todo:gap-sd-decay-model',
    metadata: {
      problem: '当前 compaction 触发纯粹依赖 >1h 和 24h 定时器——不看数据是否真的"旧"了',
      solution: '四因子加权 decay 模型：时间 × 引用次数 × 工具状态 × 跨 session 证据',
      acceptance: [
        '模型定义文档化在源码注释中',
        'decay 分数范围 [0, 1]',
        '边界条件测试通过（0 观察 / 全部活跃 / 全部陈旧）',
      ],
      candidateFiles: ['packages/memory/src/core/decay.ts'],
    },
  },
  {
    id: 'todo-los-gap-sd-calculate',
    title: '实现 calculateDecayScores(sessionId)',
    description:
      'PG 查询 session 的所有 observations → 对每条计算 decay score → 返回评分列表。\n' +
      '查询附带 observation 的 metadata_json 中的引用计数和关联 tool call 状态。\n' +
      '为每个 session 计算平均 decay score 和 stale 比例。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-stale-detection',
    dependsOnIds: ['todo-los-gap-sd-decay-model'],
    dedupeKey: 'los:todo:gap-sd-calculate',
    metadata: {
      problem: '需要实现 decay score 的具体计算逻辑',
      acceptance: [
        'calculateDecayScores(sessionId) 返回每条 observation 的 decay score',
        '返回 session 级别的汇总：平均分 / stale 比例 / stale observation 列表',
        '空 session 返回 sensible default（无 stale）',
      ],
      candidateFiles: ['packages/memory/src/core/decay.ts'],
    },
  },
  {
    id: 'todo-los-gap-sd-trigger',
    title: '实现 auto-trigger 规则：按需触发 compaction',
    description:
      '基于 decay 分数的自动触发规则：\n' +
      '1. 当 session 平均 decay < 0.3 AND 新增 observations 数量 > 20 → 触发\n' +
      '2. 当 stale observation 比例 > 40% → 触发\n' +
      '3. 保留原有的 24h 定时器作为兜底（safety net）\n' +
      '所有触发记录 auto_trigger 原因到 memory_compactions.auto_trigger 字段。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-stale-detection',
    dependsOnIds: ['todo-los-gap-sd-calculate'],
    dedupeKey: 'los:todo:gap-sd-trigger',
    metadata: {
      problem: '当前的 ">1h old" 启发式太粗糙——可能压了不该压的，或者在最需要的时候没压',
      acceptance: [
        'decay < 0.3 + obs > 20 → 自动触发',
        'stale ratio > 40% → 自动触发',
        '24h 定时器保留作为 safety net',
        'auto_trigger 字段记录触发原因便于审计',
      ],
      candidateFiles: ['packages/memory/src/core/decay.ts'],
    },
  },
  {
    id: 'todo-los-gap-sd-maintenance',
    title: '接入 server-maintenance：替代粗糙启发式',
    description:
      '修改 server-maintenance.ts 的 auto-compact 逻辑：\n' +
      '当前：SELECT uncompacted sessions > 1h old → compact\n' +
      '改为：先跑 decay trigger → 对触发阈值的 session 执行 compact\n' +
      '同时保留定时器作为 safety net 和低优先级兜底。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-stale-detection',
    dependsOnIds: ['todo-los-gap-sd-trigger'],
    dedupeKey: 'los:todo:gap-sd-maintenance',
    metadata: {
      problem: 'server-maintenance.ts 的 auto-compact 逻辑需要更新为 decay-based',
      acceptance: [
        'decay-triggered compaction 替代 ">1h old" 启发式',
        '24h 定时器保留作为兜底',
        '两种触发路径的 auto_trigger 值可区分（decay vs scheduled）',
      ],
      candidateFiles: ['packages/gateway/src/server-maintenance.ts'],
    },
  },
  {
    id: 'todo-los-gap-sd-cross-session',
    title: '跨 session pattern aggregation：识别全局 decay 信号',
    description:
      '在已有的 lookupCrossSessionEvidence 基础上扩展：\n' +
      '不仅检测跨 session 的 observed pattern，还要聚合 decay 模式：\n' +
      '- 哪些类型的 observation 在不同 session 中普遍 decay 快？\n' +
      '- 是否意味着这些 observation 类型本身价值低，可以降低保留优先级？\n' +
      '结果写入 memory_compactions.observed_patterns_json。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'design-2026-07-27',
    stageId: 'daily-gaps',
    parentId: 'todo-los-p1-stale-detection',
    dependsOnIds: ['todo-los-gap-sd-maintenance'],
    dedupeKey: 'los:todo:gap-sd-cross-session',
    metadata: {
      problem: 'decay 评分只在单 session 内计算，缺乏跨 session 的全局视角',
      acceptance: [
        '跨 session 的 decay pattern 聚合到 compaction observed_patterns',
        '识别出的全局低价值 observation 类型标记在 procedural candidates 中',
        '不影响单 session 的 compaction 性能（跨 session 查询异步执行）',
      ],
      candidateFiles: ['packages/memory/src/core/compaction.ts'],
    },
  },
];
