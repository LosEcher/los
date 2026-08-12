/**
 * Operator channel companion event classification.
 *
 * Shared by WeChat / Telegram bots so mobile surfaces wake on the same
 * durable attention set: approval, verification failure, success, worker ask.
 */

export type CompanionAlertKind = 'needs_decision' | 'already_denied' | 'info' | 'success';

export type CompanionEventClassification = {
  shouldNotify: boolean;
  kind: CompanionAlertKind;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  dedupeSuffix?: string;
};

export type CompanionSessionEvent = {
  type?: string;
  sessionId?: string;
  toolName?: string;
  payload?: Record<string, unknown>;
};

const SUCCESS_TYPES = new Set([
  'run.succeeded',
  'task.succeeded',
  'execution:succeeded',
]);

const VERIFICATION_FAIL_TYPES = new Set([
  'run.verification_failed',
  'verification.failed',
  'run.verify.failed',
]);

/**
 * Classify a gateway session.event payload for channel push.
 * Returns shouldNotify=false for noise that must stay out of IM.
 */
export function classifyCompanionSessionEvent(
  event: CompanionSessionEvent,
): CompanionEventClassification {
  const type = String(event.type ?? '');
  const payload = event.payload ?? {};

  if (type === 'tool.denied' || payload.allowed === false) {
    return {
      shouldNotify: true,
      kind: 'already_denied',
      title: '工具已拒绝',
      severity: 'info',
    };
  }

  if (type === 'worker.ask') {
    return {
      shouldNotify: true,
      kind: 'needs_decision',
      title: 'Worker 需要你的决策',
      severity: 'warning',
      dedupeSuffix: `ask:${String(payload.messageId ?? payload.question ?? 'q')}`,
    };
  }

  if (
    type === 'awaiting_approval'
    || type === 'run.awaiting_approval'
    || type === 'run.plan_ready'
  ) {
    return {
      shouldNotify: true,
      kind: 'needs_decision',
      title: '计划待审批',
      severity: 'warning',
    };
  }

  if (
    type === 'run.operator_attention_required'
    || type === 'operator_attention'
    || type === 'session.blocked'
    || type === 'run.recovery_required'
    || type === 'scheduled_work.denied'
    || (type === 'execution:transition' && payload.to === 'operator_attention')
  ) {
    return {
      shouldNotify: true,
      kind: 'needs_decision',
      title: '等待你审批',
      severity: payload.severity === 'critical' ? 'critical' : 'warning',
    };
  }

  if (VERIFICATION_FAIL_TYPES.has(type) || payload.verificationStatus === 'failed') {
    return {
      shouldNotify: true,
      kind: 'needs_decision',
      title: '验证失败',
      severity: 'critical',
    };
  }

  if (SUCCESS_TYPES.has(type) || (type === 'execution:transition' && payload.to === 'succeeded')) {
    return {
      shouldNotify: true,
      kind: 'success',
      title: '运行成功',
      severity: 'info',
    };
  }

  if (type === 'tool.warned') {
    return {
      shouldNotify: true,
      kind: 'info',
      title: '风险提示｜任务已继续',
      severity: 'warning',
    };
  }

  if (type === 'session.error') {
    return {
      shouldNotify: true,
      kind: 'needs_decision',
      title: '会话错误',
      severity: 'critical',
    };
  }

  if (
    type === 'governance.job.escalated'
    || type === 'governance.job.progress'
    || type === 'governance.bootstrap.findings'
    || type === 'governance.sweep.digest'
    || type === 'ops.daily_digest'
    || type === 'ops.fleet_attention'
  ) {
    return {
      shouldNotify: true,
      kind: type.endsWith('escalated') ? 'needs_decision' : 'info',
      title: type.startsWith('ops.') ? '运维通知' : '治理通知',
      severity: type.endsWith('escalated') ? 'warning' : 'info',
    };
  }

  return { shouldNotify: false, kind: 'info', title: type || 'event', severity: 'info' };
}

/** Optional session pin: when set, only this session (or empty global ops) is pushed. */
export function shouldDeliverToBoundSession(
  boundSessionId: string | undefined,
  eventSessionId: string | undefined,
  options?: { allowGlobalOps?: boolean; eventType?: string },
): boolean {
  if (!boundSessionId) return true;
  if (eventSessionId && eventSessionId === boundSessionId) return true;
  if (options?.allowGlobalOps && options.eventType?.startsWith('ops.')) return true;
  if (options?.allowGlobalOps && options.eventType?.startsWith('governance.')) return true;
  return false;
}

export function formatWorkerAskReason(payload: Record<string, unknown>): string {
  const question = typeof payload.question === 'string' ? payload.question : '需要决策';
  const options = Array.isArray(payload.options)
    ? payload.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (options.length === 0) return question;
  return `${question}\n选项: ${options.join(' / ')}`;
}
