// Generated from los.run-stream@0.3.0 by tools/contract-codegen.ts. Do not edit.

export const RUN_STREAM_CONTRACT = "los.run-stream";
export const RUN_STREAM_VERSION = "0.3.0";
export const RUN_STREAM_EVENT_TYPES = [
  "session",
  "session.resumed",
  "session.resume_state",
  "session.started",
  "session.branched",
  "session.branch_created",
  "session.blocked",
  "operator.steering",
  "operator.followup",
  "operator.control.consumed",
  "coordinator.intake_resolved",
  "coordinator.intake_blocked",
  "coordinator.context_policy_selected",
  "coordinator.resume_plan_selected",
  "run.resume_dispatch_suppressed",
  "task",
  "task.created",
  "task.deduplicated",
  "task.running",
  "task.blocked",
  "task.cancelled",
  "task.succeeded",
  "task.failed",
  "task.recovery_followup_queued",
  "model.delta",
  "model.response",
  "provider.fallback.selected",
  "provider.fallback.exhausted",
  "tool.planned",
  "tool.approved",
  "tool.denied",
  "tool.call",
  "tool.call.upsert",
  "tool.result",
  "turn",
  "done",
  "error",
  "cancelled",
  "deduplicated",
  "blocked"
] as const;
export const RUN_STREAM_SSE_EVENTS = [
  "session.live",
  "session.ready",
  "session.event",
  "session.completed"
] as const;

export type RunStreamEventType = typeof RUN_STREAM_EVENT_TYPES[number];
export type RunStreamSseEventType = typeof RUN_STREAM_SSE_EVENTS[number];
export type RunStreamWireEventType = RunStreamEventType | RunStreamSseEventType;
