import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  ensureSchedulerDecisionLedgerStore,
  listSchedulerDecisions,
  recordSchedulerDecision,
} from './scheduler-decision-ledger.js';

/**
 * scheduler_decisions 的**读路径容错**判据。
 *
 * 背景（实测，不是假想）：库里存在**类型外**的 kind：`placement_decision`（2026-06-21，2 行）。
 * 旧的读路径对每行调 `normalizeKind`，遇到它就抛错 ⇒ **任何不带 kind 过滤的批量读整段失败**，
 * 这类行永久不可见（"查不出来"掩盖了"有一行不认识"）。
 *
 * 本文件钉死两件事：
 *   1. 读路径把类型外的行变成**可检测状态**（`kind: null` + `kindRaw`），而不是让整段读失败；
 *   2. **写路径继续拒绝**类型外的 kind —— 负向控制：读路径放宽不能顺带放松写守卫（守卫只能收紧）。
 */

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const insertedIds: string[] = [];

/** 直接写库以便绕过 recordSchedulerDecision 的校验，模拟历史脏数据 */
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

test('scheduler decisions: 类型外的 kind 变成可检测状态，而不是让整段读失败', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureSchedulerDecisionLedgerStore();
    const base = Date.now() - 30 * 60 * 1000;
    const at = (min: number) => new Date(base + min * 60 * 1000).toISOString();
    await insertRaw(`dec-unknown-${suffix}`, 'placement_decision', at(10));
    await insertRaw(`dec-known-${suffix}`, 'claim', at(11));

    // 1) 不带 kind 过滤的批量读**不能抛错**（旧实现会在这里炸），且必须把未知行带出来
    const legacy = await listSchedulerDecisions({ graphId: `graph-${suffix}`, limit: 50 });
    assert.equal(legacy.length, 2, '未知 kind 的行不能被静默跳过');
    const unknown = legacy.find(r => r.kindRaw === 'placement_decision');
    assert.ok(unknown, '类型外的行必须出现在结果里（错误即数据）');
    assert.equal(unknown.kind, null, '类型外的 kind 在类型上是 null（可检测状态）');
    assert.equal(unknown.kindRaw, 'placement_decision', '原始值必须保留（可追溯）');

    // 2) 已知 kind 照常
    assert.equal(legacy.find(r => r.kindRaw === 'claim')?.kind, 'claim');

    // 3) 负向控制：**写路径仍然拒绝**类型外的 kind
    await assert.rejects(
      () => recordSchedulerDecision({
        graphId: `graph-${suffix}`,
        kind: 'placement_decision' as never,
        reason: 'should-be-rejected',
      }),
      /kind is invalid/,
      '写路径必须继续拒绝类型外的 kind',
    );
  } finally {
    await cleanup();
    await closeDb();
  }
});
