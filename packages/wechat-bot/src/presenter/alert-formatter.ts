/**
 * @los/wechat-bot/presenter — Event → Channel message formatting.
 *
 * Translates los operator_attention events into UnifiedMessage objects
 * suitable for delivery across weixin, web, and telegram channels.
 *
 * Inspired by lsclaw's channel-message-presenter.mjs pattern:
 * channel-specific outbound/inbound transforms with a shared normalization layer.
 */

import { randomUUID } from 'node:crypto';
import {
  MessageType,
  MessagePriority,
  type UnifiedMessage,
  type MessageMedia,
  type MessageAction,
  type ChannelKind,
} from '../channel/types.js';

export type OperatorAlertKind =
  | 'needs_decision'   // operator must act (persisted approval request)
  | 'already_denied'   // tool already denied — informational only
  | 'info';            // advisory notice (e.g. tool.warned) — no action

export interface OperatorAlert {
  sessionId: string;
  type: string;
  toolName?: string;
  reason?: string;
  severity: 'critical' | 'warning' | 'info';
  /** How the bot should phrase the alert (needs action vs FYI). */
  kind?: OperatorAlertKind;
  /**
   * Action-driven title. When absent the channel formatter derives it from
   * `kind`: needs_decision → "等待你审批", already_denied → "工具已拒绝",
   * info → "风险提示，任务继续". Severity only controls the icon/color.
   */
  title?: string;
  callId?: string;
  warnings?: string[];
  flaggedFiles?: string[];
  /** Optional run_spec id for RunContract IM commands (#approve-phase / #verify-run). */
  runSpecId?: string;
  /** Optional task_run id (fallback hint when runSpecId is absent). */
  taskRunId?: string;
  /** Attached media (screenshots, output files, etc.) */
  media?: Array<{ type: 'image' | 'file'; url: string; fileName?: string }>;
}

const KIND_TITLES: Record<OperatorAlertKind, string> = {
  needs_decision: '等待你审批',
  already_denied: '工具已拒绝',
  info: '风险提示，任务继续',
};

/** True when the alert carries a pending operator decision and may offer approval commands. */
export function alertRequiresDecision(alert: Pick<OperatorAlert, 'kind'>): boolean {
  return (alert.kind ?? 'needs_decision') === 'needs_decision';
}

export function alertTitle(alert: Pick<OperatorAlert, 'kind' | 'title'>): string {
  return alert.title ?? KIND_TITLES[alert.kind ?? 'needs_decision'];
}

/**
 * Build a unified message from an operator alert.
 * The message is channel-agnostic; each channel transforms it for delivery.
 */
export function buildAlertMessage(
  alert: OperatorAlert,
  options: {
    targetChannel: ChannelKind;
    gatewayUrl: string;
    callbackUrl?: string;
  },
): UnifiedMessage {
  const severityMap: Record<string, 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW'> = {
    critical: 'CRITICAL',
    warning: 'HIGH',
    info: 'NORMAL',
  };

  const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
  const tool = alert.toolName ? ` \`${alert.toolName}\`` : '';
  const kind = alert.kind ?? 'needs_decision';
  const title = alertTitle(alert);
  const actionable = alertRequiresDecision(alert);

  let text = `${icon} ${title}${tool}`;
  if (alert.reason) {
    text += `\n${alert.reason}`;
  }
  if (kind === 'already_denied') {
    text += '\n策略已自动拒绝，不会执行。';
  }
  if (kind === 'info') {
    text += '\n任务已继续执行，本条无需回复。';
  }
  if (alert.warnings?.length) {
    text += '\n';
    for (const w of alert.warnings.slice(0, 3)) {
      text += `\n⚠ ${w}`;
    }
  }
  if (alert.flaggedFiles?.length) {
    text += `\n\n📁 ${alert.flaggedFiles.slice(0, 5).join(', ')}`;
  }

  // Build media list
  const mediaList: MessageMedia[] | undefined = alert.media?.map(m => ({
    type: m.type,
    url: m.url,
    fileName: m.fileName,
  }));

  // Approve/deny actions only for actionable alerts; everything else gets a
  // read-only Status action so the operator can inspect without acting.
  const actions: MessageAction[] = actionable
    ? [
        { text: '✅ Approve', value: 'approve', type: 'primary' },
        { text: '❌ Deny', value: 'deny', type: 'danger' },
        { text: '↗ Escalate', value: 'escalate', type: 'default' },
      ]
    : [{ text: '📊 Status', value: 'status', type: 'default' }];

  return {
    id: `alert-${randomUUID()}`,
    type: MessageType.CARD,
    version: '1.0',
    text,
    summary: `[${alert.severity.toUpperCase()}] Agent: ${alert.toolName ?? alert.type}`,
    media: mediaList?.[0],
    mediaList,
    actions,
    routing: {
      priority: severityMap[alert.severity] as 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
      recipient: null,
      replyTo: null,
      channel: options.targetChannel,
    },
    metadata: {
      timestamp: new Date().toISOString(),
      source: 'los-operator-attention',
      channel: options.targetChannel,
      sessionId: alert.sessionId,
      taskRunId: alert.callId,
      tags: ['operator_attention', alert.severity],
    },
    _internal: {
      standardizedAt: new Date().toISOString(),
      compressed: false,
      size: 0,
    },
  };
}

/**
 * Build a session completion notification message.
 */
export function buildCompletionMessage(
  sessionId: string,
  status: string,
  result: { text?: string; turns?: number; tokens?: number },
  options: { targetChannel: ChannelKind },
): UnifiedMessage {
  const ok = status === 'completed';
  const icon = ok ? '✅' : '❌';

  let text = `${icon} Session ${sessionId.slice(0, 8)}... ${status}`;
  if (result.turns !== undefined) text += `\nTurns: ${result.turns}`;
  if (result.tokens !== undefined) text += `\nTokens: ${result.tokens.toLocaleString()}`;
  if (result.text) text += `\n\n${result.text.slice(0, 500)}`;

  return {
    id: `complete-${randomUUID()}`,
    type: MessageType.TEXT,
    version: '1.0',
    text,
    summary: `Session ${sessionId.slice(0, 8)} ${status}`,
    routing: {
      priority: ok ? 'LOW' : 'HIGH',
      recipient: null,
      replyTo: null,
      channel: options.targetChannel,
    },
    metadata: {
      timestamp: new Date().toISOString(),
      source: 'los-session-complete',
      channel: options.targetChannel,
      sessionId,
    },
    _internal: {
      standardizedAt: new Date().toISOString(),
      compressed: false,
      size: 0,
    },
  };
}

/**
 * Build a media attachment notification (screenshot, output file, etc.)
 */
export function buildMediaMessage(
  text: string,
  mediaItems: Array<{ type: 'image' | 'video' | 'file' | 'audio'; url: string; fileName?: string; size?: number }>,
  options: { targetChannel: ChannelKind; sessionId?: string },
): UnifiedMessage {
  const mediaList: MessageMedia[] = mediaItems.map(m => ({
    type: m.type,
    url: m.url,
    fileName: m.fileName,
    size: m.size,
  }));

  return {
    id: `media-${randomUUID()}`,
    type: mediaItems[0]?.type === 'image' ? 'IMAGE' : 'FILE',
    version: '1.0',
    text,
    media: mediaList[0],
    mediaList: mediaList.length > 1 ? mediaList : undefined,
    routing: {
      priority: 'NORMAL',
      recipient: null,
      replyTo: null,
      channel: options.targetChannel,
    },
    metadata: {
      timestamp: new Date().toISOString(),
      source: 'los-media',
      channel: options.targetChannel,
      sessionId: options.sessionId,
    },
    _internal: {
      standardizedAt: new Date().toISOString(),
      compressed: false,
      size: 0,
    },
  };
}
