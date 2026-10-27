import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { querySqlite } from './dsh-session-catalog.js';

/**
 * 回归：`querySqlite` 的 **输出缓冲悬崖**。
 *
 * 事故（2026-10-11）：pain 投影那条 `SELECT session_id, ts, text …` 的 JSON 输出
 * 实测 **67.8 MiB**，刚好越过 `execFileAsync` 的 `maxBuffer` 默认 64 MiB ⇒ 抛
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` ⇒ 被 `catch` 判成"读不到" ⇒ 投影**永久**
 * 报 `pain: status=degraded`，而 detail 写的是"session-index.db unavailable or
 * unreadable"（假话：同刻 catalog 的 0.12 MiB 查询成功）。这条悬崖是静默的：
 * 事件正文只增不减，越过阈值那天开始，pain 表就再也不刷新，且没有任何红灯指向真因。
 *
 * 因此这里钉住两件事，且**必须同时存在**（只有正向就证明不了悬崖，只有负向就
 * 证明不了修复）：
 *   N1 负向控制：默认 maxBuffer 下，同样这条查询**仍然是 null**（不是空数组、不抛）；
 *   P1 修复：显式放大 maxBuffer 后，同一份数据能完整读出来。
 */
const HAS_SQLITE3 = (() => {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// 每行 350,000 字符 × 220 行 ≈ 77 MB JSON 输出（> 64 MiB，且留出 escaping 余量）。
const ROWS = 220;
const CHARS_PER_ROW = 350_000;

function makeBigDb(dir: string): string {
  const db = join(dir, 'big.db');
  // hex(zeroblob(n)) 给 2n 个 hex 字符，replace 掉 '00' 后每个字节换成 1 个 'x'。
  const sql = `
    CREATE TABLE t(session_id TEXT, ts INTEGER, text TEXT);
    INSERT INTO t(session_id, ts, text)
      SELECT 's-' || i, i, replace(hex(zeroblob(${CHARS_PER_ROW})), '00', 'x')
      FROM (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${ROWS}) SELECT i FROM c);
  `;
  execFileSync('sqlite3', [db, sql]);
  return db;
}

test('dsh-sqlite-buffer N1: 输出越过默认 maxBuffer 时被判成 null（不是空结果、不抛）', { skip: !HAS_SQLITE3 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sqlite-buffer-'));
  try {
    const dbPath = makeBigDb(dir);
    const rows = await querySqlite<{ session_id: string }>(
      'SELECT session_id, ts, text FROM t;',
      { dbPath },
    );
    assert.equal(rows, null, '默认 64 MiB 下必须复现"读不到 ⇒ null"，否则这条悬崖就不存在，测试已失效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh-sqlite-buffer P1: 显式放大 maxBuffer 后同一份数据可完整读出', { skip: !HAS_SQLITE3 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sqlite-buffer-'));
  try {
    const dbPath = makeBigDb(dir);
    const rows = await querySqlite<{ session_id: string; text: string }>(
      'SELECT session_id, ts, text FROM t;',
      { dbPath, maxBuffer: 256 * 1024 * 1024 },
    );
    assert.ok(rows, '放大 maxBuffer 后不得再判成 degraded（pain 投影的修复就落在这里）');
    assert.equal(rows.length, ROWS);
    assert.equal(rows[0].text.length, CHARS_PER_ROW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
