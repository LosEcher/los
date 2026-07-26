/**
 * @los/agent/scheduler - Stable scheduler facade.
 *
 * Graph orchestration and scheduled task execution live in focused internal
 * modules. Keep this public surface limited to exports used by callers.
 */

export { cancelScheduledTask } from './scheduler/abort-registry.js';
export { runAgentTaskGraphSerial } from './scheduler/graph-runner.js';
export { runScheduledAgentTask } from './scheduler/scheduled-task-runner.js';
export { persistScheduledToolCallState } from './scheduler/tool-call-state-persistence.js';
export type {
  AgentTaskGraphStageOutput,
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
  ScheduledAgentTaskInput,
  ScheduledAgentTaskResult,
  ScheduledExecutorConfig,
  ScheduledTaskEvent,
  ScheduledTaskEventType,
} from './scheduler/types.js';
