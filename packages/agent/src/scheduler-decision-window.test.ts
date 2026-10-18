import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { ensureSchedulerDecisionLedgerStore } from './scheduler-decision-ledger.js';
import { listSchedulerDecisionWindow } from './scheduler-decision-window.js';

/**
 * 有界时间窗倒序读的判据。
 *
 * 背景（实测）：旧的 `listSchedulerDecisions` 是 `ORDER BY created_at ASC` + limit≤500，
 * 实测只能覆盖 2026-06-15 的约 4 小时窗口，**最近的 2267 行结构性不可达** ⇒
 * "最近发生了什么"在这张调度台账上问不出来。窗口读就是为这个缺口建的。
 *
 * 四条判据，每条对应一个会静默出错的实现方式：
 *   1. 倒序（最新在前）—— 正序实现只会给出"最早的 500 行"。
 *   2. 窗口生效 —— 窗口外的行不得混入。
 *   3. 截断可观测，且 `matched` 是**真值**（不随 limit 变）—— 否则你无法知道还有多少没看到。
 *   4. `kinds: []` = 明确不取任何行 —— 空数组被当成"全部"是最危险的默认值。
 */

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const insertedIds: string[] = [];

async function insertRaw(id: string, kind: string, createdAt: string): Promise<void> {
  insertedIds.push(id);
  await getDb().query(
    `INSERT INTO scheduler_decisions (id, graph_id, kind, reason, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `graph-${suffix}`, kind, `test:${suffix}`, createdAt],
  );
}

async function cleanup(): Promise<void> {
  for (const id of insertedIds) {
    await getDb().query('DELETE FROM scheduler_decisions WHERE id = $1', [id]);
  }
  insertedIds.length = 0;
}

test('scheduler decision window: 倒序、有界、截断可观测', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureSchedulerDecisionLedgerStore();
    const base = Date.now() - 60 * 60 * 1000; // 1 小时前起
    const at = (min: number) => new Date(base + min * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i += 1) {
      await insertRaw(`dec-win-${suffix}-${i}`, 'executor_selection', at(i + 10));
    }
    // 窗口外（更早）
    await insertRaw(`dec-out-${suffix}`, 'executor_selection', new Date(base - 6 * 60 * 60 * 1000).toISOString());
    const since = at(5);

    const all = await listSchedulerDecisionWindow({ since, limit: 50 });
    assert.equal(all.matched, 5, '窗口内只应命中 5 条（窗口外那条不算）');
    assert.equal(all.truncated, false);
    assert.equal(all.rows.length, 5);
    const times = all.rows.map(r => r.createdAt);
    assert.deepEqual(times, [...times].sort().reverse(), '必须是倒序（最新在前）');

    const capped = await listSchedulerDecisionWindow({ since, limit: 2 });
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.truncated, true, '被截断必须可观测');
    assert.equal(capped.matched, 5, 'matched 必须不受 limit 影响（来自分组普查）');

    const none = await listSchedulerDecisionWindow({ since, kinds: [] });
    assert.equal(none.rows.length, 0, '空白名单 = 不取任何行，不是"全部"');
    assert.equal(none.matched, 0);

    assert.equal((await listSchedulerDecisionWindow({ since, kinds: ['executor_selection'] })).matched, 5);
    assert.equal((await listSchedulerDecisionWindow({ since, kinds: ['claim'] })).matched, 0);
  } finally {
    await cleanup();
    await closeDb();
  }
});
