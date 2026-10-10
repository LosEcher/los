/**
 * dsh-session-catalog.ts — DSH 会话的**只读跨项目投射**（P1 L1-2）。
 *
 * 依据：`docs/architecture/2026-10-08-p1-cross-project-observability.md` L1-2。
 *
 * ## 只读边界（这是本模块最重要的性质）
 * 数据源是 DSH 的 `~/.dsh/storages/session-index.db`（SQLite，~274MB）。
 * 本模块**只读**它，**绝不写 DSH 侧任何文件** —— 投射落在 los 自己的 Postgres 里。
 *
 * ## 三张表
 * | 表 | 粒度 |
 * | --- | --- |
 * | `dsh_session_catalog` | 每 session 一行 |
 * | `dsh_session_pain` | 每（项目 × 模式）一行 |
 * | `dsh_context_injection` | 每（天 × 项目）一行 |
 *
 * ## 降级（负向控制的核心）
 * SQLite 缺失/不可读时**返回 `degraded` 状态并给空结果**，**不抛异常**、也不假装
 * "没有会话" —— 这两者的区别与路径解析器同一条纪律：
 * **"没读到" ≠ "没有"**。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb, withDbClient } from '@los/infra/db';
import { resolveSessionCwds, type AliasMap } from './session-path-resolver.js';

const execFileAsync = promisify(execFile);

export const DSH_SESSION_INDEX_DB = join(homedir(), '.dsh', 'storages', 'session-index.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dsh_session_catalog (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  project_key TEXT NOT NULL,
  path_state TEXT NOT NULL,          -- current | resolved | unknown
  path_reason TEXT,                  -- unknown 时的原因（no-map | unmapped）
  created_at TIMESTAMPTZ NOT NULL,
  last_event_at TIMESTAMPTZ,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  llm_requests INTEGER NOT NULL DEFAULT 0,
  interrupted_turns INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT,
  as_of TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dsh_session_catalog_project
  ON dsh_session_catalog(project_key, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_dsh_session_catalog_state
  ON dsh_session_catalog(path_state);

CREATE TABLE IF NOT EXISTS dsh_session_pain (
  project_key TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  pattern_version TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  as_of TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_key, pattern_key, pattern_version)
);

CREATE TABLE IF NOT EXISTS dsh_context_injection (
  day DATE NOT NULL,
  project_key TEXT NOT NULL,
  runtime_context_injections INTEGER NOT NULL DEFAULT 0,
  skill_catalog_injections INTEGER NOT NULL DEFAULT 0,
  avg_assistant_chars INTEGER,
  max_assistant_chars INTEGER,
  as_of TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (day, project_key)
);
`;

let ensured = false;
export async function ensureDshSessionCatalogStore(): Promise<void> {
  if (ensured) return;
  await getDb().exec(SCHEMA);
  ensured = true;
}

/**
 * pain 模式的判据族。**必须机械化**（否则会退化成主观标签）：
 * 从 `events.text` 用固定正则匹配，命中即计数；`version` 随行落库，
 * 使"同一 pattern_key 在不同规则版本下的计数"可分辨。
 */
export const PAIN_PATTERNS = [
  { key: 'sandbox_denied_outside_workspace', re: /sandbox.*denied|operation not permitted|denied under .* mode/i },
  { key: 'denial_misread_as_dedup', re: /dedup:true|inFlight/i, also: /denied|permission/i },
  { key: 'ssh_controlmaster_denied', re: /cm-|ControlMaster/i, also: /denied|not permitted/i },
  { key: 'pss_blocked_gate_false_red', re: /\bps\b/i, also: /blocked|denied/i },
  { key: 'context_compaction', re: /automatically generated checkpoint condensing/i },
  { key: 'timeout', re: /timed out|timeout after/i },
] as const;

export const PAIN_PATTERN_VERSION = 'v1';

/** 命中判据（纯函数，便于自检）：`also` 存在时要求同段共现。 */
export function matchPainPattern(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const p of PAIN_PATTERNS) {
    if (!p.re.test(text)) continue;
    if ('also' in p && p.also && !p.also.test(text)) continue;
    hits.push(p.key);
  }
  return hits;
}

/** 只读查询 SQLite。**不加 `-readonly`**（缺 `-shm` 的 WAL 库会以 (14) 失败）。 */
export async function querySqlite<T>(sql: string): Promise<T[] | null> {
  if (!existsSync(DSH_SESSION_INDEX_DB)) return null;
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', DSH_SESSION_INDEX_DB, sql], {
      maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    });
    const trimmed = stdout.trim();
    return trimmed ? (JSON.parse(trimmed) as T[]) : [];
  } catch {
    return null;   // 读不到 ⇒ null（**不是**空结果）
  }
}

export interface CatalogProjectionResult {
  status: 'ok' | 'degraded' | 'no-alias-map';
  sessions: number;
  byState: Record<string, number>;
  asOf: string;
  detail?: string;
}

interface SessionRow {
  id: string; cwd: string; created_at: number | null;
  last_event_at: number | null; tool_calls: number; llm_requests: number;
  interrupted_turns: number;
}

/**
 * 投影 `dsh_session_catalog`（P1 L1-2 的核心表，也是 B3.3 出口判据依赖的那张）。
 *
 * `aliasMap` 为 `null` 表示**别名表缺失** ⇒ 全部历史会话降级为 `unknown`，
 * 但**仍然写入**（保留证据），而不是跳过。
 */
export async function projectSessionCatalog(opts: {
  aliasMap: AliasMap | null;
  currentRoot: string;
  now?: Date;
}): Promise<CatalogProjectionResult> {
  await ensureDshSessionCatalogStore();
  const asOf = (opts.now ?? new Date()).toISOString();

  // **用一次 GROUP BY 聚合，而不是每 session 4 个相关子查询**。
  // 实测：相关子查询版本在 1,100 session × 598k events 上要 **91 秒** ——
  // 对"每天跑"的投射不可接受。聚合版本走一次 events 扫描。
  const rows = await querySqlite<SessionRow>(`
    WITH agg AS (
      SELECT session_id,
             max(ts) AS last_event_at,
             sum(CASE WHEN kind = 'tool/call' THEN 1 ELSE 0 END) AS tool_calls,
             sum(CASE WHEN kind = 'request/header' THEN 1 ELSE 0 END) AS llm_requests,
             sum(CASE WHEN kind = 'turn/start' THEN 1 ELSE 0 END) AS t_start,
             sum(CASE WHEN kind = 'turn/end' THEN 1 ELSE 0 END) AS t_end
      FROM events GROUP BY session_id
    )
    SELECT s.id AS id, s.cwd AS cwd, s.created_at AS created_at,
           a.last_event_at AS last_event_at,
           COALESCE(a.tool_calls, 0) AS tool_calls,
           COALESCE(a.llm_requests, 0) AS llm_requests,
           COALESCE(a.t_start, 0) - COALESCE(a.t_end, 0) AS interrupted_turns
    FROM sessions s LEFT JOIN agg a ON a.session_id = s.id;
  `);

  if (rows === null) {
    // ★ 降级：**明示**读不到，不假装没有会话
    return {
      status: 'degraded', sessions: 0, byState: {}, asOf,
      detail: 'session-index.db unavailable or unreadable — catalog NOT refreshed (this is not "no sessions")',
    };
  }

  const resolved = resolveSessionCwds(rows.map(r => r.cwd), {
    currentRoot: opts.currentRoot,
    aliasMap: opts.aliasMap,
  });

  let inserted = 0;
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM dsh_session_catalog');
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const res = resolved.results[i]!;
        const projectKey = res.target ?? r.cwd;
        await client.query(
        `INSERT INTO dsh_session_catalog
           (session_id, cwd, project_key, path_state, path_reason, created_at,
            last_event_at, tool_calls, llm_requests, interrupted_turns, duration_ms, as_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (session_id) DO UPDATE SET
           project_key = EXCLUDED.project_key, path_state = EXCLUDED.path_state,
           path_reason = EXCLUDED.path_reason, last_event_at = EXCLUDED.last_event_at,
           tool_calls = EXCLUDED.tool_calls, llm_requests = EXCLUDED.llm_requests,
           interrupted_turns = EXCLUDED.interrupted_turns, duration_ms = EXCLUDED.duration_ms,
           as_of = EXCLUDED.as_of`,
        [
          r.id, r.cwd, projectKey, res.state, res.reason,
          r.created_at ? new Date(r.created_at).toISOString() : asOf,
          r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
          r.tool_calls ?? 0, r.llm_requests ?? 0, Math.max(0, r.interrupted_turns ?? 0),
          r.created_at && r.last_event_at ? r.last_event_at - r.created_at : null,
          asOf,
        ],
      );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });

  return {
    status: opts.aliasMap ? 'ok' : 'no-alias-map',
    sessions: inserted,
    byState: resolved.byState,
    asOf,
    detail: opts.aliasMap ? undefined
      : 'alias map missing — historical sessions are recorded as path_state=unknown (kept, not dropped)',
  };
}
