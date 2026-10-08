/**
 * dsh-session-summary.ts — 跨项目事实面只读汇总（契约 `los.cross-project-summary`）。
 *
 * 从 `dsh-session-catalog.ts` 拆出以守住模块尺寸门禁。只查询已投影的三张表，
 * **不在请求期**读 DSH 的 SQLite（那是离线投影器的职责）。
 */
import { getDb } from '@los/infra/db';
import {
  ensureDshSessionCatalogStore,
  PAIN_PATTERN_VERSION,
} from './dsh-session-catalog.js';
import { INJECTION_MARKER_VERSION } from './dsh-session-injection.js';

// ─────────────────────────────────────────────────────────────
// 只读汇总（供 los 网关 /cross-project/summary；契约见
// contracts/cross-project-summary.yaml）
// ─────────────────────────────────────────────────────────────

export interface CrossProjectSummary {
  evidenceClass: 'los_projection';
  asOf: string | null;
  degraded: { isDegraded: boolean; reasons: string[] };
  catalog: {
    sessions: number;
    byState: { current: number; resolved: number; unknown: number };
    projects: Array<{
      projectKey: string; sessions: number; toolCalls: number;
      interruptedTurns: number; lastEventAt: string | null;
    }>;
    lastEventAt: string | null;
  };
  pain: {
    patternVersion: string;
    totalSessions: number;
    patterns: Array<{
      patternKey: string; sessions: number; occurrences: number;
      firstSeen: string | null; lastSeen: string | null;
    }>;
  };
  injection: {
    markerVersion: string;
    days: number;
    runtimeContextInjections: number;
    skillCatalogInjections: number;
    daily: Array<{
      day: string; runtimeContextInjections: number; skillCatalogInjections: number;
      avgAssistantChars: number | null; maxAssistantChars: number | null;
    }>;
  };
}

/**
 * 跨项目事实面（**只读**，纯查询已投影的表；不碰 DSH 的 SQLite）。
 *
 * ## 为什么 `degraded` 是**独立通道**而不是"空结果"
 * 三张表都可能是"投影从未跑过" ⇒ 直接返回 0/空数组会被读者当成
 * "确实没有会话/没有痛点"—— 那是错的，且正是本项目反复登记的反模式
 * （对照 verify-gate 的"全 na 算 pass"）。所以：
 *   - 表为空 ⇒ `degraded.isDegraded = true` 且 reasons 说明是哪张表
 *   - `asOf` 为 `null` 而不是 `now()`（不假装新鲜）
 * 消费方（dashboards widget）**必须**把 degraded 渲染成显式状态。
 */
export async function getCrossProjectSummary(opts: {
  painLimit?: number;
  injectionDays?: number;
} = {}): Promise<CrossProjectSummary> {
  await ensureDshSessionCatalogStore();
  const painLimit = Math.min(50, Math.max(1, Math.trunc(opts.painLimit ?? 10)));
  const injectionDays = Math.min(90, Math.max(1, Math.trunc(opts.injectionDays ?? 14)));
  const db = getDb();
  const reasons: string[] = [];

  const catalogAgg = await db.query<{
    sessions: string; current: string; resolved: string; unknown: string; last_event_at: string | null;
  }>(`SELECT count(*) AS sessions,
             count(*) FILTER (WHERE path_state = 'current')  AS current,
             count(*) FILTER (WHERE path_state = 'resolved') AS resolved,
             count(*) FILTER (WHERE path_state = 'unknown')  AS unknown,
             max(last_event_at) AS last_event_at
        FROM dsh_session_catalog`);
  const ca = catalogAgg.rows[0]!;
  const sessions = Number(ca.sessions);
  if (sessions === 0) reasons.push('dsh_session_catalog is empty — run `pnpm project:dsh-sessions`');

  const projects = await db.query<{
    project_key: string; sessions: string; tool_calls: string;
    interrupted_turns: string; last_event_at: string | null;
  }>(`SELECT project_key,
             count(*) AS sessions,
             COALESCE(sum(tool_calls), 0) AS tool_calls,
             COALESCE(sum(interrupted_turns), 0) AS interrupted_turns,
             max(last_event_at) AS last_event_at
        FROM dsh_session_catalog
       GROUP BY project_key
       ORDER BY max(last_event_at) DESC NULLS LAST
       LIMIT 100`);

  const painAgg = await db.query<{
    pattern_key: string; sessions: string; occurrences: string;
    first_seen: string | null; last_seen: string | null;
  }>(`SELECT pattern_key,
             COALESCE(sum(sessions), 0) AS sessions,
             COALESCE(sum(occurrences), 0) AS occurrences,
             min(first_seen) AS first_seen, max(last_seen) AS last_seen
        FROM dsh_session_pain
       WHERE pattern_version = $1
       GROUP BY pattern_key
       ORDER BY sessions DESC
       LIMIT $2`, [PAIN_PATTERN_VERSION, painLimit]);
  if (painAgg.rows.length === 0) reasons.push('dsh_session_pain is empty — run `pnpm project:dsh-sessions`');

  const injAgg = await db.query<{
    rt: string; sk: string; last_as_of: string | null;
  }>(`SELECT COALESCE(sum(runtime_context_injections), 0) AS rt,
             COALESCE(sum(skill_catalog_injections), 0) AS sk,
             max(as_of) AS last_as_of
        FROM dsh_context_injection
       WHERE day >= (CURRENT_DATE - ($1::int - 1))`, [injectionDays]);
  const ia = injAgg.rows[0]!;
  if (Number(ia.rt) === 0 && Number(ia.sk) === 0) {
    reasons.push('dsh_context_injection is empty for the requested window — run `pnpm project:dsh-sessions`');
  }

  const daily = await db.query<{
    day: string; rt: string; sk: string; avg_c: number | null; max_c: number | null;
  }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day,
             runtime_context_injections AS rt, skill_catalog_injections AS sk,
             avg_assistant_chars AS avg_c, max_assistant_chars AS max_c
        FROM dsh_context_injection
       WHERE day >= (CURRENT_DATE - ($1::int - 1))
       ORDER BY day ASC`, [injectionDays]);

  const asOf = ca.last_event_at ?? ia.last_as_of ?? null;
  const totalPainSessions = painAgg.rows.reduce((n, r) => n + Number(r.sessions), 0);

  return {
    evidenceClass: 'los_projection',
    asOf,
    degraded: { isDegraded: reasons.length > 0, reasons },
    catalog: {
      sessions,
      byState: {
        current: Number(ca.current), resolved: Number(ca.resolved), unknown: Number(ca.unknown),
      },
      projects: projects.rows.map((r) => ({
        projectKey: r.project_key,
        sessions: Number(r.sessions),
        toolCalls: Number(r.tool_calls),
        interruptedTurns: Number(r.interrupted_turns),
        lastEventAt: r.last_event_at,
      })),
      lastEventAt: ca.last_event_at,
    },
    pain: {
      patternVersion: PAIN_PATTERN_VERSION,
      totalSessions: totalPainSessions,
      patterns: painAgg.rows.map((r) => ({
        patternKey: r.pattern_key,
        sessions: Number(r.sessions),
        occurrences: Number(r.occurrences),
        firstSeen: r.first_seen, lastSeen: r.last_seen,
      })),
    },
    injection: {
      markerVersion: INJECTION_MARKER_VERSION,
      days: injectionDays,
      runtimeContextInjections: Number(ia.rt),
      skillCatalogInjections: Number(ia.sk),
      daily: daily.rows.map((r) => ({
        day: r.day,
        runtimeContextInjections: Number(r.rt),
        skillCatalogInjections: Number(r.sk),
        avgAssistantChars: r.avg_c === null ? null : Number(r.avg_c),
        maxAssistantChars: r.max_c === null ? null : Number(r.max_c),
      })),
    },
  };
}
