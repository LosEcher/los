/**
 * dsh-session-injection.ts — 上下文注入开销投影（P1 L1-2，表 `dsh_context_injection`）。
 *
 * 从 `dsh-session-catalog.ts` 拆出以守住模块尺寸门禁（`tools/check-structure.sh`
 * 拦 >500 行）。判据标记取自**实测措辞**，不猜；各带 `*_MARKER_VERSION`
 * 使措辞版本变更后的计数可分辨。
 */
import { withDbClient } from '@los/infra/db';
import {
  PAIN_PATTERNS,
  PAIN_PATTERN_VERSION,
  ensureDshSessionCatalogStore,
  matchPainPattern,
  querySqlite,
} from './dsh-session-catalog.js';
import { resolveSessionCwds, type AliasMap } from './session-path-resolver.js';

// ─────────────────────────────────────────────────────────────
// 注入标记的判据（取自实测措辞，不猜）
// ─────────────────────────────────────────────────────────────
/** runtime context 注入标记：实测 `Current runtime context. This snapshot supersedes…`。 */
export const RUNTIME_CONTEXT_MARKER = 'Current runtime context.';
/** skill catalog 注入标记：实测 `The following skills are available …`。 */
export const SKILL_CATALOG_MARKER = 'The following skills are available';

export const INJECTION_MARKER_VERSION = 'v1';

/**
 * 投影 `dsh_session_pain`：跨项目重复痛点。
 *
 * **不接收 `since`**（与 `dsh_context_injection` 不同）：pain 表按
 * `(project_key, pattern_key, pattern_version)` 主键，**全历史累计**才是它的语义
 * （"这个痛点反复出现"）；按窗口切会丢掉复发信息。要窗口视图请按 `first_seen`/`last_seen` 过滤。
 *
 * 判据是 `PAIN_PATTERNS` 的固定正则族；`pattern_version` 随行落库，
 * 使"同一 key 在不同规则版本下的计数"可分辨（不变量 T3）。
 */
export async function projectSessionPain(opts: {
  aliasMap: AliasMap | null;
  currentRoot: string;
  now?: Date;
}): Promise<{ status: 'ok' | 'degraded' | 'no-alias-map'; rows: number; asOf: string; detail?: string; durationMs: number }> {
  const started = Date.now();
  await ensureDshSessionCatalogStore();
  const asOf = (opts.now ?? new Date()).toISOString();

  // 一次扫描：只取有 text 的事件（44k/598k），带 session_id 以便归项目
  const events = await querySqlite<{ session_id: string; ts: number; text: string }>(`
    SELECT session_id, ts, text FROM events WHERE text IS NOT NULL AND text <> '';
  `);
  if (events === null) {
    return {
      status: 'degraded', rows: 0, asOf, durationMs: Date.now() - started,
      detail: 'session-index.db unavailable or unreadable — pain projection NOT refreshed (this is not "no pain patterns")',
    };
  }
  const sessions = await querySqlite<{ id: string; cwd: string }>('SELECT id, cwd FROM sessions;') ?? [];
  const bySession = new Map(sessions.map((s) => [s.id, s.cwd]));
  const resolved = resolveSessionCwds(sessions.map((s) => s.cwd), {
    currentRoot: opts.currentRoot, aliasMap: opts.aliasMap,
  });
  const projectOf = new Map<string, string>();
  for (let i = 0; i < sessions.length; i++) {
    const res = resolved.results[i]!;
    projectOf.set(sessions[i]!.id, res.target ?? bySession.get(sessions[i]!.id) ?? '(unknown)');
  }

  // 聚合：project_key × pattern_key → occurrences / sessions / first / last
  const agg = new Map<string, { occ: number; sessions: Set<string>; first: number; last: number }>();
  for (const e of events) {
    const hits = matchPainPattern(e.text);
    if (!hits.length) continue;
    const project = projectOf.get(e.session_id) ?? '(unknown)';
    for (const key of hits) {
      const k = `${project}\u0000${key}`;
      const cur = agg.get(k) ?? { occ: 0, sessions: new Set<string>(), first: e.ts, last: e.ts };
      cur.occ += 1;
      cur.sessions.add(e.session_id);
      if (e.ts < cur.first) cur.first = e.ts;
      if (e.ts > cur.last) cur.last = e.ts;
      agg.set(k, cur);
    }
  }

  let rows = 0;
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const [k, v] of agg) {
        const [project, pattern] = k.split('\u0000') as [string, string];
        await client.query(
          `INSERT INTO dsh_session_pain
             (project_key, pattern_key, pattern_version, occurrences, sessions, first_seen, last_seen, as_of)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (project_key, pattern_key, pattern_version) DO UPDATE SET
             occurrences = EXCLUDED.occurrences, sessions = EXCLUDED.sessions,
             first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen, as_of = EXCLUDED.as_of`,
          [project, pattern, PAIN_PATTERN_VERSION, v.occ, v.sessions.size,
            new Date(v.first).toISOString(), new Date(v.last).toISOString(), asOf],
        );
        rows++;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  });

  return {
    status: opts.aliasMap ? 'ok' : 'no-alias-map',
    rows, asOf, durationMs: Date.now() - started,
    detail: opts.aliasMap ? undefined : 'alias map missing — projects fall back to raw cwd (kept, not dropped)',
  };
}

/**
 * 投影 `dsh_context_injection`：按（天 × 项目）统计注入次数与 assistant 输出长度。
 *
 * **必须有 `since`**（与 pain 相反）：它是**按天**的表，全历史会把所有历史天都重写一遍，
 * 且"当天的注入量"只在有限窗口内有意义。默认 14 天（与日报口径一致）。
 */
export async function projectContextInjection(opts: {
  aliasMap: AliasMap | null;
  currentRoot: string;
  sinceMs: number;
  now?: Date;
}): Promise<{ status: 'ok' | 'degraded' | 'no-alias-map'; rows: number; asOf: string; durationMs: number; detail?: string }> {
  const started = Date.now();
  await ensureDshSessionCatalogStore();
  const asOf = (opts.now ?? new Date()).toISOString();

  const rows = await querySqlite<{ session_id: string; ts: number; kind: string; text: string }>(`
    SELECT session_id, ts, kind, text FROM events
    WHERE ts >= ${Math.floor(opts.sinceMs)}
      AND text IS NOT NULL AND text <> ''
      AND (text LIKE '%${RUNTIME_CONTEXT_MARKER}%' OR text LIKE '%${SKILL_CATALOG_MARKER}%'
           OR kind = 'assistant/message');
  `);
  if (rows === null) {
    return { status: 'degraded', rows: 0, asOf, durationMs: Date.now() - started,
      detail: 'session-index.db unavailable — injection projection NOT refreshed (this is not "zero injections")' };
  }
  const sessions = await querySqlite<{ id: string; cwd: string }>('SELECT id, cwd FROM sessions;') ?? [];
  const resolved = resolveSessionCwds(sessions.map((s) => s.cwd), {
    currentRoot: opts.currentRoot, aliasMap: opts.aliasMap,
  });
  const projectOf = new Map<string, string>();
  for (let i = 0; i < sessions.length; i++) projectOf.set(sessions[i]!.id, resolved.results[i]!.target ?? sessions[i]!.cwd);

  const agg = new Map<string, { rt: number; sk: number; chars: number[] }>();
  for (const e of rows) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const project = projectOf.get(e.session_id) ?? '(unknown)';
    const k = `${day}\u0000${project}`;
    const cur = agg.get(k) ?? { rt: 0, sk: 0, chars: [] };
    if (e.text.includes(RUNTIME_CONTEXT_MARKER)) cur.rt += 1;
    if (e.text.includes(SKILL_CATALOG_MARKER)) cur.sk += 1;
    if (e.kind === 'assistant/message') cur.chars.push(e.text.length);
    agg.set(k, cur);
  }

  let written = 0;
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const [k, v] of agg) {
        const [day, project] = k.split('\u0000') as [string, string];
        const avg = v.chars.length ? Math.round(v.chars.reduce((a, b) => a + b, 0) / v.chars.length) : null;
        const max = v.chars.length ? Math.max(...v.chars) : null;
        await client.query(
          `INSERT INTO dsh_context_injection
             (day, project_key, runtime_context_injections, skill_catalog_injections,
              avg_assistant_chars, max_assistant_chars, as_of)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (day, project_key) DO UPDATE SET
             runtime_context_injections = EXCLUDED.runtime_context_injections,
             skill_catalog_injections = EXCLUDED.skill_catalog_injections,
             avg_assistant_chars = EXCLUDED.avg_assistant_chars,
             max_assistant_chars = EXCLUDED.max_assistant_chars, as_of = EXCLUDED.as_of`,
          [day, project, v.rt, v.sk, avg, max, asOf],
        );
        written++;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
  });

  return { status: opts.aliasMap ? 'ok' : 'no-alias-map', rows: written, asOf, durationMs: Date.now() - started };
}
