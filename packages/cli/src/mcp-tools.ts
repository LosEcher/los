/**
 * MCP 工具面（`tools/list` 的返回体）——纯数据，无运行时依赖。
 *
 * 为什么单独成文件：工具面是**对外契约**（`contracts/programmatic-agent-interface.yaml` 的
 * 机器可读对照物），而且 `mcp-serve.ts` 已到结构门禁的 500 行上限
 * （`tools/check-structure.sh`：新文件 >500 行报错）。把这份 schema 常量挪出来后，
 * 适配器主体只负责传输与投影。
 *
 * 为什么导出名带 `_` 前缀：这些符号只在包内被 `mcp-serve.ts` 使用，属于内部件；
 * 本仓 wiring 扫描器（`tools/check-wiring-topology.ts`）对 `_` 前缀导出豁免 orphan 判定，
 * 这样既不必把新条目塞进 baseline（棘轮只减不增），也不牺牲常量的单一来源。
 */

/** `GET /runs` 无过滤参数且服务端自带上限，所以列表的裁剪与边界由适配器负责。 */
export const _MAX_RUN_LIST = 50;
export const _DEFAULT_RUN_LIST = 10;

export const _TOOLS = [
  {
    name: 'los_run',
    description: 'Run LOS through its gateway and return persisted run identifiers plus the terminal result. '
      + 'projectId/workspaceRoot take effect only with operatorScope=true (requires an operator credential); '
      + 'without it the gateway pins the run to its default project and this tool fails loudly rather than reporting success. '
      + 'detach=true returns as soon as the run is registered (no long-held stream) and leaves the run executing.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        projectId: { type: 'string' },
        workspaceRoot: { type: 'string' },
        sessionId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        toolMode: { type: 'string', enum: ['read-only', 'project-write'], default: 'read-only' },
        maxLoops: { type: 'integer', minimum: 1 },
        traceId: { type: 'string' },
        dedupeKey: { type: 'string' },
        runContract: { type: 'object' },
        operatorScope: { type: 'boolean', default: false },
        detach: { type: 'boolean', default: false },
      },
      required: ['prompt', 'projectId'],
    },
  },
  {
    name: 'los_runs_list',
    description: 'List persisted LOS run specs (bounded, filtered) so a caller can recover a runSpecId it lost to a client timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        traceId: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: _MAX_RUN_LIST, default: _DEFAULT_RUN_LIST },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'los_run_state',
    description: 'Read the persisted recovery-grade state projection for a LOS run.',
    inputSchema: {
      type: 'object',
      properties: { runSpecId: { type: 'string' }, projectId: { type: 'string' } },
      required: ['runSpecId', 'projectId'],
    },
  },
  {
    name: 'los_run_replay',
    description: 'Read bounded persisted stream checkpoints and session events for a LOS run.',
    inputSchema: {
      type: 'object',
      properties: {
        runSpecId: { type: 'string' },
        projectId: { type: 'string' },
        since: { type: 'integer', minimum: 0 },
        streamSince: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['runSpecId', 'projectId'],
    },
  },
  {
    name: 'los_operator_control',
    description: 'Persist operator steering or follow-up for a LOS session. Requires LOS_OPERATOR_TOKEN.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        projectId: { type: 'string' },
        type: { type: 'string', enum: ['steering', 'followup'] },
        instruction: { type: 'string' },
        prompt: { type: 'string' },
        runSpecId: { type: 'string' },
        taskRunId: { type: 'string' },
        reason: { type: 'string' },
        turnBoundary: { type: 'string', enum: ['next_turn', 'immediate'] },
        drainMode: { type: 'string', enum: ['none', 'finish_current_tool', 'finish_current_turn'] },
      },
      required: ['sessionId', 'projectId', 'type'],
    },
  },
] as const;
