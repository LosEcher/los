/**
 * Chinese WeChat formatting for daily execution digest.
 */
import type {
  DailyDigest,
  DigestCadenceRecommendation,
  DigestScheduleRow,
} from './daily-digest.js';

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

  // Ops sections composed into highlights (fleet D1 + providers D3).
  const opsLines = (digest.highlights ?? []).filter((h) =>
    /^(Fleet:|  |Providers:|Ops attention:|provider |runtime |default agent:)/.test(h)
    || h.startsWith('Fleet:')
    || h.startsWith('Providers:')
    || h.startsWith('Ops attention:'),
  );
  if (opsLines.length > 0) {
    lines.push('', '【舰队 / Provider】');
    for (const h of opsLines.slice(0, 14)) {
      lines.push(h.startsWith('  ') ? h : `· ${h}`);
    }
  }

  lines.push('', '【链接】');
  lines.push(`日报：${webDeepLink(`#usage?day=${encodeURIComponent(digest.day)}`, base)}`);
  lines.push('（手机需可访问该地址；本机请用电脑浏览器打开）');
  return lines.join('\n');
}


