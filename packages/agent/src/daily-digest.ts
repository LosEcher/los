/**
 * Daily Execution Digest — read-only L1 composition of schedules + usage + quality.
 *
 * Does not invent a new ledger. Reuses scheduled_work_* rows, getUsageSummary(),
 * and the latest daily_agent_quality snapshot. Cadence recommendations are
 * heuristic operator guidance based on live run volume and failure modes.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { getDailyAgentQualityBaseline } from './daily-agent-quality/store.js';
import type { DailyAgentQualitySnapshot } from './daily-agent-quality/types.js';
import { appendSessionEvent } from './session-events.js';
import { ensureScheduledWorkStore } from './scheduled-work/schema.js';
import { getUsageSummary, type UsageSummary } from './usage-summary.js';

const log = getLogger('daily-digest');

export type DigestEvidenceClass = 'los_runtime';

export interface DailyDigestQuery {
  /** Calendar day YYYY-MM-DD in UTC. Default: yesterday UTC. */
  day?: string;
  /** Project scope for quality snapshot. Default: los. */
  projectId?: string;
  tenantId?: string;
}

export interface DigestScheduleRow {
  scheduleId: string;
  title: string;
  status: string;
  templateId: string;
  triggerKind: string;
  expression: string;
  timezone: string;
  approvalPolicy: string;
  approvalTimeoutAction: string;
  runCount: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  awaitingApproval: number;
  other: number;
  lastStatus?: string;
  lastCompletedAt?: string;
  lastSummaryReason?: string;
  /** sessionId from the most recent run (any status), if present. */
  lastSessionId?: string;
  /** sessionId from the most recent failed/cancelled/awaiting run in the day window. */
  attentionSessionId?: string;
}

export interface DigestCadenceRecommendation {
  scheduleId: string;
  title: string;
  severity: 'info' | 'warn' | 'action';
  currentExpression: string;
  recommendedExpression?: string;
  action: 'keep' | 'reduce_frequency' | 'retire_duplicate' | 'fix_approval_policy' | 'investigate';
  rationale: string;
  estimatedDailyRunsCurrent?: number;
  estimatedDailyRunsRecommended?: number;
}

export interface DailyDigest {
  evidenceClass: DigestEvidenceClass;
  day: string;
  from: string;
  to: string;
  generatedAt: string;
  schedule: {
    enabledCount: number;
    runTotals: {
      runCount: number;
      succeeded: number;
      failed: number;
      cancelled: number;
      skipped: number;
      awaitingApproval: number;
      other: number;
    };
    bySchedule: DigestScheduleRow[];
  };
  usage: UsageSummary;
  quality: {
    projectId: string;
    snapshot: DailyAgentQualitySnapshot | null;
  };
  cadenceRecommendations: DigestCadenceRecommendation[];
  highlights: string[];
}

interface ScheduleAggRow {
  schedule_id: string;
  title: string;
  status: string;
  template_id: string | null;
  trigger_kind: string | null;
  expression: string | null;
  timezone: string | null;
  approval_policy: string | null;
  approval_timeout_action: string | null;
  run_count: string;
  succeeded: string;
  failed: string;
  cancelled: string;
  skipped: string;
  awaiting_approval: string;
  other: string;
  last_status: string | null;
  last_completed_at: Date | string | null;
  last_summary: unknown;
  attention_summary: unknown;
}

function num(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function resolveDayWindow(day?: string): { day: string; from: string; to: string } {
  let dayStr = day?.trim();
  if (!dayStr) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    dayStr = yesterday.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
    throw new Error('daily digest day must be YYYY-MM-DD');
  }
  const from = `${dayStr}T00:00:00.000Z`;
  const toDate = new Date(from);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  return { day: dayStr, from, to: toDate.toISOString() };
}

function parseIntervalToMinutes(expression: string): number | null {
  const m = /^(\d+)(m|h|d)$/i.exec(expression.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === 'm') return n;
  if (unit === 'h') return n * 60;
  if (unit === 'd') return n * 24 * 60;
  return null;
}

function minutesToExpression(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function summaryReason(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object') return undefined;
  const rec = summary as Record<string, unknown>;
  for (const key of ['deniedReason', 'reason', 'error', 'message']) {
    if (typeof rec[key] === 'string' && rec[key]) return String(rec[key]);
  }
  if (typeof rec.deniedBy === 'string') return String(rec.deniedBy);
  return undefined;
}

function summarySessionId(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object') return undefined;
  const rec = summary as Record<string, unknown>;
  const sid = rec.sessionId ?? rec.session_id;
  return typeof sid === 'string' && sid.trim() ? sid.trim() : undefined;
}

/** Public web base for deep links in WeChat/digest (no trailing slash). */
export function resolveWebBaseUrl(): string {
  const raw = (
    process.env.LOS_WEB_BASE_URL
    ?? process.env.LOS_PUBLIC_URL
    ?? process.env.LOS_GATEWAY_URL
    ?? 'http://127.0.0.1:8080'
  ).trim();
  return raw.replace(/\/+$/, '');
}

export function webDeepLink(
  hash: string,
  baseUrl: string = resolveWebBaseUrl(),
): string {
  const fragment = hash.startsWith('#') ? hash : `#${hash}`;
  return `${baseUrl}/${fragment}`;
}

function buildCadenceRecommendations(rows: DigestScheduleRow[]): DigestCadenceRecommendation[] {
  const recs: DigestCadenceRecommendation[] = [];
  const titleGroups = new Map<string, DigestScheduleRow[]>();
  for (const row of rows) {
    if (row.status !== 'enabled') continue;
    const key = row.title.trim().toLowerCase();
    const list = titleGroups.get(key) ?? [];
    list.push(row);
    titleGroups.set(key, list);
  }

  for (const group of titleGroups.values()) {
    if (group.length > 1) {
      const keep = group[0]!;
      for (const dup of group.slice(1)) {
        recs.push({
          scheduleId: dup.scheduleId,
          title: dup.title,
          severity: 'action',
          currentExpression: dup.expression,
          action: 'retire_duplicate',
          rationale: `Duplicate enabled schedule title; keep ${keep.scheduleId} and retire this one.`,
        });
      }
    }
  }

  for (const row of rows) {
    if (row.status !== 'enabled') continue;
    const mins = row.triggerKind === 'interval' ? parseIntervalToMinutes(row.expression) : null;
    const daily = mins && mins > 0 ? Math.round((24 * 60) / mins) : undefined;
    const cancelHeavy = row.runCount > 0 && row.cancelled / row.runCount >= 0.5;
    const approvalTimeout = (row.lastSummaryReason ?? '').includes('approval_timeout');

    if (cancelHeavy || approvalTimeout) {
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'action',
        currentExpression: row.expression,
        action: 'fix_approval_policy',
        rationale: approvalTimeout || cancelHeavy
          ? `Runs are cancelled by approval_timeout (policy=${row.approvalPolicy}, timeoutAction=${row.approvalTimeoutAction}). Fix approval (preapproved_scope / longer timeout / timeoutAction=approve for unattended governance), not cadence.`
          : 'High cancel rate — inspect approval/concurrency policy.',
        estimatedDailyRunsCurrent: daily,
      });
      continue;
    }

    // Title-specific rules first (freshness may also use runtime_readiness template).
    if (
      /freshness|log freshness/i.test(row.title)
      && mins !== null
      && mins > 0
      && mins < 30
    ) {
      const recommended = 30;
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'warn',
        currentExpression: row.expression,
        recommendedExpression: minutesToExpression(recommended),
        action: 'reduce_frequency',
        rationale: `Log freshness at ${row.expression} (~${daily}/day). Success is near-instant; 30m is enough for ops lag detection.`,
        estimatedDailyRunsCurrent: daily,
        estimatedDailyRunsRecommended: Math.round((24 * 60) / recommended),
      });
      continue;
    }

    if (
      (row.templateId === 'runtime_readiness' || /readiness|dogfood/i.test(row.title))
      && mins !== null
      && mins > 0
      && mins < 15
    ) {
      const recommended = 15;
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'warn',
        currentExpression: row.expression,
        recommendedExpression: minutesToExpression(recommended),
        action: 'reduce_frequency',
        rationale: `Readiness probe at ${row.expression} (~${daily}/day). Zero failures observed; 15m keeps dogfood signal with ~3× fewer ticks.`,
        estimatedDailyRunsCurrent: daily,
        estimatedDailyRunsRecommended: Math.round((24 * 60) / recommended),
      });
      continue;
    }

    if (mins !== null && mins <= 5 && (daily ?? 0) >= 200) {
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'info',
        currentExpression: row.expression,
        recommendedExpression: '15m',
        action: 'reduce_frequency',
        rationale: `High-frequency interval (${row.expression}, ~${daily}/day). Consider 15m unless sub-5m lag is a hard SLO.`,
        estimatedDailyRunsCurrent: daily,
        estimatedDailyRunsRecommended: 96,
      });
    }
  }

  return recs;
}

function buildHighlights(
  schedule: DailyDigest['schedule'],
  usage: UsageSummary,
  recs: DigestCadenceRecommendation[],
): string[] {
  const lines: string[] = [];
  lines.push(
    `Schedules: ${schedule.enabledCount} enabled, ${schedule.runTotals.runCount} runs `
    + `(ok=${schedule.runTotals.succeeded} fail=${schedule.runTotals.failed} `
    + `cancel=${schedule.runTotals.cancelled}).`,
  );
  lines.push(
    `Usage: ${usage.totals.modelResponseCount} model responses, `
    + `~$${usage.totals.estimatedCostUsd.toFixed(4)}, `
    + `cache_hit_rate=${usage.totals.cacheHitRate == null ? 'n/a' : `${(usage.totals.cacheHitRate * 100).toFixed(1)}%`}.`,
  );
  const top = usage.byProviderModel[0];
  if (top) {
    lines.push(`Top model: ${top.provider}:${top.model} (n=${top.modelResponseCount}).`);
  }
  const actions = recs.filter(r => r.severity === 'action' || r.action === 'reduce_frequency');
  if (actions.length > 0) {
    lines.push(`Cadence/policy actions: ${actions.length} recommendation(s).`);
  }
  return lines;
}

export async function getDailyDigest(query: DailyDigestQuery = {}): Promise<DailyDigest> {
  const window = resolveDayWindow(query.day);
  const projectId = query.projectId?.trim() || 'los';
  const tenantId = query.tenantId?.trim() || 'local';

  await ensureScheduledWorkStore();
  const db = getDb();

  const agg = await db.query<ScheduleAggRow>(
    `WITH day_runs AS (
       SELECT *
       FROM scheduled_work_item_runs
       WHERE scheduled_for >= $1::timestamptz AND scheduled_for < $2::timestamptz
     ),
     last_run AS (
       SELECT DISTINCT ON (schedule_id)
         schedule_id, status, completed_at, result_summary_json
       FROM scheduled_work_item_runs
       ORDER BY schedule_id, scheduled_for DESC
     ),
     last_attention AS (
       SELECT DISTINCT ON (schedule_id)
         schedule_id, result_summary_json
       FROM scheduled_work_item_runs
       WHERE scheduled_for >= $1::timestamptz AND scheduled_for < $2::timestamptz
         AND status IN ('failed', 'cancelled', 'awaiting_approval')
       ORDER BY schedule_id, scheduled_for DESC
     )
     SELECT
       s.id AS schedule_id,
       s.title,
       s.status,
       s.run_template_json->>'templateId' AS template_id,
       s.trigger_json->>'kind' AS trigger_kind,
       s.trigger_json->>'expression' AS expression,
       s.trigger_json->>'timezone' AS timezone,
       s.approval_policy,
       s.approval_timeout_action,
       COUNT(r.id)::text AS run_count,
       COUNT(*) FILTER (WHERE r.status = 'succeeded')::text AS succeeded,
       COUNT(*) FILTER (WHERE r.status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE r.status = 'cancelled')::text AS cancelled,
       COUNT(*) FILTER (WHERE r.status IN ('skipped', 'no_op'))::text AS skipped,
       COUNT(*) FILTER (WHERE r.status = 'awaiting_approval')::text AS awaiting_approval,
       COUNT(*) FILTER (WHERE r.status IS NOT NULL AND r.status NOT IN (
         'succeeded','failed','cancelled','skipped','no_op','awaiting_approval'
       ))::text AS other,
       lr.status AS last_status,
       lr.completed_at AS last_completed_at,
       lr.result_summary_json AS last_summary,
       la.result_summary_json AS attention_summary
     FROM scheduled_work_items s
     LEFT JOIN day_runs r ON r.schedule_id = s.id
     LEFT JOIN last_run lr ON lr.schedule_id = s.id
     LEFT JOIN last_attention la ON la.schedule_id = s.id
     WHERE s.status IN ('enabled', 'paused')
        OR EXISTS (SELECT 1 FROM day_runs dr WHERE dr.schedule_id = s.id)
     GROUP BY s.id, s.title, s.status, s.run_template_json, s.trigger_json,
              s.approval_policy, s.approval_timeout_action,
              lr.status, lr.completed_at, lr.result_summary_json,
              la.result_summary_json
     ORDER BY COUNT(r.id) DESC, s.title ASC`,
    [window.from, window.to],
  );

  const bySchedule: DigestScheduleRow[] = agg.rows.map(row => ({
    scheduleId: row.schedule_id,
    title: row.title,
    status: row.status,
    templateId: row.template_id ?? 'unknown',
    triggerKind: row.trigger_kind ?? 'unknown',
    expression: row.expression ?? '',
    timezone: row.timezone ?? '',
    approvalPolicy: row.approval_policy ?? '',
    approvalTimeoutAction: row.approval_timeout_action ?? '',
    runCount: num(row.run_count),
    succeeded: num(row.succeeded),
    failed: num(row.failed),
    cancelled: num(row.cancelled),
    skipped: num(row.skipped),
    awaitingApproval: num(row.awaiting_approval),
    other: num(row.other),
    lastStatus: row.last_status ?? undefined,
    lastCompletedAt: row.last_completed_at
      ? (row.last_completed_at instanceof Date
        ? row.last_completed_at.toISOString()
        : String(row.last_completed_at))
      : undefined,
    lastSummaryReason: summaryReason(row.last_summary),
    lastSessionId: summarySessionId(row.last_summary),
    attentionSessionId: summarySessionId(row.attention_summary) ?? summarySessionId(row.last_summary),
  }));

  const runTotals = bySchedule.reduce(
    (acc, row) => {
      acc.runCount += row.runCount;
      acc.succeeded += row.succeeded;
      acc.failed += row.failed;
      acc.cancelled += row.cancelled;
      acc.skipped += row.skipped;
      acc.awaitingApproval += row.awaitingApproval;
      acc.other += row.other;
      return acc;
    },
    { runCount: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0, awaitingApproval: 0, other: 0 },
  );

  const enabledCount = bySchedule.filter(row => row.status === 'enabled').length;
  const usage = await getUsageSummary({ from: window.from, to: window.to });
  const qualityBaseline = await getDailyAgentQualityBaseline({
    tenantId,
    projectId,
    requiredDays: 7,
    now: new Date(window.to),
  });
  const snapshot = qualityBaseline.snapshots.find(s => s.snapshotDate === window.day)
    ?? qualityBaseline.snapshots[0]
    ?? null;

  const cadenceRecommendations = buildCadenceRecommendations(bySchedule);
  const scheduleBlock = { enabledCount, runTotals, bySchedule };

  return {
    evidenceClass: 'los_runtime',
    day: window.day,
    from: window.from,
    to: window.to,
    generatedAt: new Date().toISOString(),
    schedule: scheduleBlock,
    usage,
    quality: { projectId, snapshot },
    cadenceRecommendations,
    highlights: buildHighlights(scheduleBlock, usage, cadenceRecommendations),
  };
}

/** Human cadence label for WeChat (Chinese, no raw cron when avoidable). */
function formatCadenceZh(row: DigestScheduleRow): string {
  const expr = (row.expression || '').trim();
  if (row.triggerKind === 'interval' || /^\d+[mhd]$/i.test(expr)) {
    const m = /^(\d+)(m|h|d)$/i.exec(expr);
    if (m) {
      const n = Number(m[1]);
      const u = m[2]!.toLowerCase();
      if (u === 'm') return n === 1 ? '每分钟' : `每 ${n} 分钟`;
      if (u === 'h') return n === 1 ? '每小时' : `每 ${n} 小时`;
      if (u === 'd') return n === 1 ? '每天' : `每 ${n} 天`;
    }
  }
  if (row.triggerKind === 'cron' || expr.includes('*')) {
    // Common daily-at-hour patterns: "0 9 * * *" → 每天 09:00
    const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expr);
    if (daily) {
      const min = daily[1]!.padStart(2, '0');
      const hour = daily[2]!.padStart(2, '0');
      const tz = row.timezone ? `（${row.timezone}）` : '';
      return `每天 ${hour}:${min}${tz}`;
    }
    return expr ? `定时 ${expr}` : '定时任务';
  }
  if (row.triggerKind === 'once') return '一次性';
  return expr || row.triggerKind || '任务';
}

function statusIcon(row: DigestScheduleRow): string {
  if (row.status === 'retired' || row.status === 'paused') return '⏸';
  if (row.failed > 0) return '❌';
  if (row.cancelled > 0 || row.awaitingApproval > 0) return '⚠️';
  if (row.runCount === 0) return '·';
  return '✅';
}

function formatRunOutcomeZh(row: DigestScheduleRow): string {
  if (row.runCount === 0) return '当日未触发';
  const parts: string[] = [];
  if (row.succeeded > 0) parts.push(`成功 ${row.succeeded}`);
  if (row.failed > 0) parts.push(`失败 ${row.failed}`);
  if (row.cancelled > 0) parts.push(`取消 ${row.cancelled}`);
  if (row.skipped > 0) parts.push(`跳过 ${row.skipped}`);
  if (row.awaitingApproval > 0) parts.push(`待审批 ${row.awaitingApproval}`);
  if (row.other > 0) parts.push(`其他 ${row.other}`);
  return `共 ${row.runCount} 次 · ${parts.join(' · ')}`;
}

function shortModelName(provider: string, model: string): string {
  const m = model.replace(/^.*\//, '');
  if (provider && !m.toLowerCase().includes(provider.toLowerCase())) {
    return `${provider} / ${m}`;
  }
  return m || provider || '未知模型';
}

function actionLabelZh(action: DigestCadenceRecommendation['action']): string {
  switch (action) {
    case 'reduce_frequency': return '建议降频';
    case 'retire_duplicate': return '建议下线重复项';
    case 'fix_approval_policy': return '建议修正审批策略';
    case 'investigate': return '建议排查';
    case 'keep': return '可保持';
    default: return action;
  }
}

/**
 * Operator-facing Chinese text for WeChat / mobile push.
 * Prefer short lines, plain language, no raw API jargon.
 */
export function formatDailyDigestMessage(digest: DailyDigest): string {
  const t = digest.schedule.runTotals;
  const lines: string[] = [
    `📊 执行日报 · ${digest.day}`,
    `（UTC 自然日；北京时间约 ${digest.day} 08:00 → 次日 08:00）`,
    '',
    '【总览】',
    `启用任务 ${digest.schedule.enabledCount} 个 · 共执行 ${t.runCount} 次`,
    `成功 ${t.succeeded} · 失败 ${t.failed} · 取消 ${t.cancelled}`
      + (t.awaitingApproval > 0 ? ` · 待审批 ${t.awaitingApproval}` : '')
      + (t.skipped > 0 ? ` · 跳过 ${t.skipped}` : ''),
  ];

  const usage = digest.usage.totals;
  const top = digest.usage.byProviderModel[0];
  lines.push('', '【模型用量】');
  const cache = usage.cacheHitRate == null
    ? '缓存 n/a'
    : `缓存命中 ${(usage.cacheHitRate * 100).toFixed(0)}%`;
  lines.push(
    `调用 ${usage.modelResponseCount} 次 · 约 $${usage.estimatedCostUsd.toFixed(2)} · ${cache}`,
  );
  if (top) {
    lines.push(`主力 ${shortModelName(top.provider, top.model)}（${top.modelResponseCount} 次）`);
  }

  // Prefer enabled + anything that actually ran; drop retired zero-signal noise last.
  const rows = [...digest.schedule.bySchedule]
    .filter(row => row.runCount > 0 || row.status === 'enabled')
    .sort((a, b) => {
      const score = (r: DigestScheduleRow) =>
        (r.failed > 0 ? 1000 : 0) + (r.cancelled > 0 ? 100 : 0) + r.runCount;
      return score(b) - score(a);
    })
    .slice(0, 12);

  if (rows.length > 0) {
    lines.push('', '【任务明细】');
    for (const row of rows) {
      const state =
        row.status === 'enabled' ? ''
          : row.status === 'paused' ? '（已暂停）'
            : row.status === 'retired' ? '（已下线）'
              : `（${row.status}）`;
      lines.push(`${statusIcon(row)} ${row.title}${state}`);
      lines.push(`   ${formatCadenceZh(row)} · ${formatRunOutcomeZh(row)}`);
    }
  }

  const base = resolveWebBaseUrl();
  const attention = rows.filter(r =>
    r.status === 'enabled' && (r.failed > 0 || r.cancelled > 0 || r.awaitingApproval > 0),
  );
  if (attention.length > 0) {
    lines.push('', '【需关注】');
    for (const row of attention.slice(0, 5)) {
      const why: string[] = [];
      if (row.failed > 0) why.push(`${row.failed} 次失败`);
      if (row.cancelled > 0) why.push(`${row.cancelled} 次取消`);
      if (row.awaitingApproval > 0) why.push(`${row.awaitingApproval} 次待审批`);
      lines.push(`· ${row.title}：${why.join('、')}`);
      const sessionId = row.attentionSessionId ?? row.lastSessionId;
      if (sessionId) {
        lines.push(`  会话：${webDeepLink(`#chat?session=${encodeURIComponent(sessionId)}`, base)}`);
      }
      lines.push(`  任务：${webDeepLink(`#schedules?id=${encodeURIComponent(row.scheduleId)}`, base)}`);
    }
  }

  // Analysis-style enabled runs with session content (even when all succeeded)
  const analysisWithSession = rows.filter(r =>
    r.status === 'enabled'
    && r.runCount > 0
    && (r.templateId === 'scheduled_execution' || r.templateId === 'scheduled_feed_analysis')
    && Boolean(r.lastSessionId || r.attentionSessionId)
    && !attention.some(a => a.scheduleId === r.scheduleId),
  ).slice(0, 3);
  if (analysisWithSession.length > 0) {
    lines.push('', '【可查看执行】');
    for (const row of analysisWithSession) {
      const sessionId = row.attentionSessionId ?? row.lastSessionId!;
      lines.push(`· ${row.title}`);
      lines.push(`  ${webDeepLink(`#chat?session=${encodeURIComponent(sessionId)}`, base)}`);
    }
  }

  const recs = digest.cadenceRecommendations
    .filter(r => r.severity === 'action' || r.severity === 'warn')
    .slice(0, 4);
  if (recs.length > 0) {
    lines.push('', '【建议】');
    for (const r of recs) {
      const tip = r.recommendedExpression
        ? ` → 可改为 ${r.recommendedExpression}`
        : '';
      lines.push(`· ${actionLabelZh(r.action)}：${r.title}${tip}`);
    }
  }

  if (t.failed === 0 && t.cancelled === 0 && t.awaitingApproval === 0 && t.runCount > 0) {
    lines.push('', '状态：当日无失败/取消，整体正常。');
  }

  lines.push('', '【链接】');
  lines.push(`日报：${webDeepLink(`#usage?day=${encodeURIComponent(digest.day)}`, base)}`);
  lines.push('（手机需可访问该地址；本机请用电脑浏览器打开）');
  return lines.join('\n');
}

export interface PublishDailyDigestOptions {
  scheduleId?: string;
  runId?: string;
  /** When true, compose but skip session event (tests). Default false. */
  dryRun?: boolean;
}

/**
 * Compose (or reuse) the daily digest and emit `ops.daily_digest` for operator
 * SSE / WeChat. Does not call WeClaw directly — delivery is channel-side.
 */
export async function publishDailyDigest(
  query: DailyDigestQuery = {},
  options: PublishDailyDigestOptions = {},
): Promise<{ digest: DailyDigest; message: string; eventEmitted: boolean }> {
  const digest = await getDailyDigest(query);
  const message = formatDailyDigestMessage(digest);
  if (options.dryRun) {
    return { digest, message, eventEmitted: false };
  }
  const severity =
    digest.schedule.runTotals.failed > 0
    || digest.schedule.runTotals.cancelled > 0
    || digest.schedule.runTotals.awaitingApproval > 0
      ? 'warning'
      : 'info';
  try {
    await appendSessionEvent({
      sessionId: `ops:daily-digest:${digest.day}`,
      type: 'ops.daily_digest',
      source: 'ops',
      tenantId: query.tenantId?.trim() || 'local',
      projectId: query.projectId?.trim() || 'los',
      payload: {
        kind: 'daily_execution_digest',
        severity,
        title: `执行汇总 ${digest.day}`,
        detail: message,
        reason: message,
        day: digest.day,
        from: digest.from,
        to: digest.to,
        requiresDecision: false,
        scheduleId: options.scheduleId ?? null,
        runId: options.runId ?? null,
        enabledCount: digest.schedule.enabledCount,
        runTotals: digest.schedule.runTotals,
      },
    });
    return { digest, message, eventEmitted: true };
  } catch (err) {
    log.warn(
      `daily digest notify failed day=${digest.day}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { digest, message, eventEmitted: false };
  }
}
