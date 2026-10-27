import { getDb } from '@los/infra/db';
import {
  ensureSchedulerDecisionLedgerStore,
  rowToRecord,
  type SchedulerDecisionKind,
  type SchedulerDecisionRecord,
  type SchedulerDecisionRow,
} from './scheduler-decision-ledger.js';

/**
 * 有界时间窗内的倒序读 —— 给"最近发生了什么"这类问题用。
 *
 * 为什么需要它（不是"再写一个查询"）：`listSchedulerDecisions` 是 `ORDER BY created_at ASC`
 * 且 limit 上限 500，实测只能取到 2026-06-15 的约 4 小时窗口，**最近的 2267 行结构性不可达**。
 * 判据面的读路径不能建立在一个"永远看不到最近"的函数上。
 *
 * 三条与旧函数**刻意的**差异（每条都对应一个失败模式）：
 *   1. `since` **必填**：没有窗口就是全表扫描，资源守卫不允许（类型层强制，不是文档约定）。
 *   2. 倒序 + 时间窗：窗口本身是界，所以条数上限可以放宽到 2000（旧函数的 500 上限保留不动）。
 *   3. 被截断必须**可观测**：返回 `truncated`，而不是安静地少给几行。
 *
 * 为什么单独成文件（而不是挤在 ledger 里）：结构门禁对"超过 500 行的新大文件"是阻断，
 * 而 ledger 加上这段就会越过 500 行。窗口读是**另一种查询语义**（有界倒序 vs 无界正序），
 * 拆开既过门禁也把两种语义分开，不会误用。
 */

export interface ListSchedulerDecisionWindowOptions {
  /** 窗口下界（含）。必填。 */
  since: string | Date;
  /** 窗口上界（含）。默认 = 现在。 */
  until?: string | Date;
  /**
   * 已知 kind 的白名单；省略/`null` = 全部（**含类型外的行**，因为"未识别"不是一种可白名单化的 kind）。
   * 传空数组 = 明确不取任何行（不解释成"全部"——那是最危险的默认值）。
   */
  kinds?: readonly SchedulerDecisionKind[] | null;
  /** 条数上限，默认 500、上限 2000。 */
  limit?: number;
}

export interface SchedulerDecisionWindow {
  rows: SchedulerDecisionRecord[];
  /** true ⇒ 命中上限被截断（窗口内还有更多行）。调用方必须把它显示出来或据此扩窗。 */
  truncated: boolean;
  /** 实际使用的窗口（回给调用方做追溯；与请求值可能因规范化不同）。 */
  window: { since: string; until: string };
  /** 窗口内的 kind 普查，用于发现类型外的历史值（不受 `limit` 影响）。 */
  kindCensus: Record<string, number>;
  /** 窗口内**真实的**总行数（来自分组普查，不受 `limit` 影响 ⇒ 截断时仍准确）。 */
  matched: number;
}

/**
 * 实现要点：
 *   · 两次查询：一次分组普查（真实总数与 kind 分布），一次取行（带上限）。
 *     为什么要普查而不是"多取一行判断截断"：普查让 `matched` 与 `kindCensus` **不受上限影响**，
 *     于是"被截断了多少"是可算的，而不是只能说一声"可能还有"。
 *   · `kinds` 白名单为空数组 ⇒ 明确不取任何行（不解释成"全部"，那是最危险的默认值）；
 *     省略/`null` 才是全部。
 */
export async function listSchedulerDecisionWindow(
  options: ListSchedulerDecisionWindowOptions,
): Promise<SchedulerDecisionWindow> {
  await ensureSchedulerDecisionLedgerStore();
  const since = toIso(options.since);
  const until = toIso(options.until ?? new Date());
  const limit = normalizeWindowLimit(options.limit);
  const kinds = options.kinds ?? null;
  if (Array.isArray(kinds) && kinds.length === 0) {
    return { rows: [], truncated: false, window: { since, until }, kindCensus: {}, matched: 0 };
  }

  const params: unknown[] = [since, until];
  const kindClause = kinds ? ` AND kind = ANY($${params.push([...kinds])})` : '';
  const census = await getDb().query<{ kind: string; n: number }>(
    `
    SELECT kind, COUNT(*)::int AS n
    FROM scheduler_decisions
    WHERE created_at >= $1 AND created_at <= $2${kindClause}
    GROUP BY kind
    ORDER BY n DESC, kind ASC
  `,
    params,
  );
  const kindCensus: Record<string, number> = {};
  let matched = 0;
  for (const row of census.rows) {
    kindCensus[row.kind] = Number(row.n);
    matched += Number(row.n);
  }

  const rowParams: unknown[] = [since, until];
  const rowKindClause = kinds ? ` AND kind = ANY($${rowParams.push([...kinds])})` : '';
  rowParams.push(limit);
  const rows = await getDb().query<SchedulerDecisionRow>(
    `
    SELECT *
    FROM scheduler_decisions
    WHERE created_at >= $1 AND created_at <= $2${rowKindClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${rowParams.length}
  `,
    rowParams,
  );

  const records = rows.rows.map(rowToRecord);
  return {
    rows: records,
    truncated: matched > records.length,
    window: { since, until },
    kindCensus,
    matched,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 窗口读的上限比通用读松（窗口本身是界），但仍必须有上限。 */
function normalizeWindowLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 500;
  return Math.max(1, Math.min(2000, Math.floor(value)));
}
