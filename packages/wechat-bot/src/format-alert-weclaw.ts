/**
 * WeClaw-oriented alert text formatting (keeps index.ts under module-size gate).
 */
import { alertTitle, type OperatorAlert } from './presenter/alert-formatter.js';

export function formatAlertForWeclaw(alert: OperatorAlert): string {
  // Pre-formatted daily digest body — send as-is (already includes title + rows).
  if (alert.type === 'ops.daily_digest' && alert.reason?.trim()) {
    return alert.reason.trim();
  }
  if (alert.type === 'ops.fleet_attention' && alert.reason?.trim()) {
    return alert.reason.trim();
  }

  const kind = alert.kind ?? 'needs_decision';
  const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
  const sid = alert.sessionId;
  const runId = alert.runSpecId ?? alert.taskRunId;
  const title = alertTitle(alert);

  const lines: string[] = [`${icon} ${title}`];
  if (alert.toolName) lines.push(`操作: ${alert.toolName}`);
  if (alert.reason) lines.push(`原因: ${alert.reason}`);
  if (alert.warnings?.length) {
    for (const w of alert.warnings.slice(0, 3)) lines.push(`注意: ${w}`);
  }
  if (alert.flaggedFiles?.length) {
    lines.push(`文件: ${alert.flaggedFiles.slice(0, 3).join(', ')}`);
  }
  if (kind === 'already_denied') {
    lines.push('说明: 策略已自动拒绝，不会执行。');
  }
  if (kind === 'info') {
    lines.push('说明: 任务已继续执行，本条无需回复。');
  }
  lines.push('');
  const isGovernance = String(alert.type ?? '').startsWith('governance.');
  if (isGovernance) {
    lines.push('说明: 打开 Web → Ops → 治理 查看并操作（暂停/恢复/立即运行）。');
  } else {
    lines.push(`Session: ${sid}`);
    if (runId) lines.push(`Run: ${runId}`);
  }
  lines.push('');
  // Approval commands only for actionable run alerts; informational notices must
  // not advertise #approve-phase/#verify-run. Governance uses the Web ops page.
  if (kind === 'needs_decision' && runId && !isGovernance) {
    lines.push('【计划审批】每次只发一行（不要连粘）:');
    lines.push(`#approve-phase ${runId}`);
    lines.push(`#verify-run ${runId}`);
    lines.push('');
    lines.push('说明: #approve-phase 只批计划；#verify-run 跑 requiredChecks（空则空跑 succeeded）。');
  }
  if (alert.type === 'worker.ask' && runId && typeof (alert as { messageId?: string }).messageId === 'string') {
    // messageId is optional on OperatorAlert; when present, operators can answer via Web.
    lines.push('说明: 请在 Web Chat 选项卡回复，或继续用会话命令。');
  }
  if (!isGovernance) {
    lines.push('【会话级】每次只发一行:');
    lines.push(`#status ${sid}`);
    lines.push(`#bind-session ${sid}`);
    lines.push('#unbind-session');
  }
  return lines.join('\n');
}
