// format.mjs 的断言式测试（B1 验收）。跑法：`node --test 'src/**/*.test.mjs'`。
//
// 这些断言就是**规格**：V1 新鲜度成词、V2 缺值 '—'（真 0 不混同）、
// 以及三个"冻结基线"——B1 是重构，**不得**改变既有显示口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setFormatLang,
  getFormatLang,
  ago,
  elapsed,
  uptime,
  duration,
  num,
  tokens,
  usd,
  bytes,
  pct,
  fraction,
  diskLow,
  DISK_LOW_FREE_RATIO,
  statusWord,
  statusReason,
  NODE_STATUSES,
} from './format.mjs';

const NOW = 1_700_000_000_000; // 固定基准，避免测试依赖真实时钟
const zh = () => setFormatLang('zh');
const en = () => setFormatLang('en');

// ── V1：新鲜度是"词"，不是时间戳 ──────────────────────────────
test('V1 ago：缺值渲染成"从未"，不是空串', () => {
  zh();
  assert.equal(ago(null), '从未');
  assert.equal(ago(undefined), '从未');
  en();
  assert.equal(ago(null), 'never');
});

test('V1 ago：10 秒内是"刚刚"，不显示 "0 秒前"', () => {
  zh();
  assert.equal(ago(NOW - 3_000, NOW), '刚刚');
  assert.equal(ago(NOW - 9_000, NOW), '刚刚');
});

test('V1 ago：未来时间夹到 0，绝不出现负时长（负向控制）', () => {
  zh();
  // 若不夹，这个断言会因为 "−3600 秒前" 而失败
  assert.equal(ago(NOW + 3_600_000, NOW), '刚刚');
  const out = ago(NOW + 86_400_000, NOW);
  assert.ok(!out.includes('-'), `未来时间不得出现负号，实得 ${out}`);
  assert.ok(!out.includes('−'), '未来时间不得出现 Unicode 负号');
});

test('V1 ago：分钟/小时/天按档位给词，不渲染 ISO 串', () => {
  zh();
  assert.equal(ago(NOW - 90_000, NOW), '1 分钟前');
  assert.equal(ago(NOW - 3 * 3600_000, NOW), '3 小时前');
  assert.equal(ago(NOW - 5 * 86_400_000, NOW), '5 天前');
  en();
  assert.equal(ago(NOW - 90_000, NOW), '1m ago');
  assert.ok(!ago(NOW - 90_000, NOW).includes('T'), '不得渲染 ISO 串');
});

test('V1 elapsed：运行中耗时形如 4m 07s', () => {
  assert.equal(elapsed(NOW - 247_000, NOW), '4m 07s');
  assert.equal(elapsed(NOW - 5_000, NOW), '5s');
});

test('V1 elapsed：起点在未来时必须夹到 0s（这是夹取的**唯一可观察处**）', () => {
  // 这条是刻意放在 elapsed 上的：ago() 的"未来"有**两道互相冗余的防线**
  // （Math.max(0,…) 夹取 + `secs < 10` 提前返回），单改任何一道都观察不到，
  // 所以"夹取"这条契约由 elapsed 负责证伪。
  assert.equal(elapsed(NOW + 5_000, NOW), '0s');
  assert.ok(!elapsed(NOW + 5_000, NOW).includes('-'), '不得出现负时长');
});

test('V1 uptime：天/小时两段', () => {
  zh();
  assert.equal(uptime(12 * 86400 + 4 * 3600), '12 天 4 小时');
  en();
  assert.equal(uptime(12 * 86400 + 4 * 3600), '12d 4h');
});

test('V1 duration：给秒数出人话', () => {
  zh();
  assert.equal(duration(90), '1 分钟');
  en();
  assert.equal(duration(90), '1m');
});

// ── V2：缺值 '—'，真 0 必须是 0 ───────────────────────────────
test('V2 缺值一律 "—"（五个数值格式化函数一致）', () => {
  assert.equal(bytes(null), '—');
  assert.equal(pct(null), '—');
  assert.equal(num(null), '—');
  assert.equal(tokens(null), '—');
  assert.equal(usd(null), '—');
  assert.equal(num(undefined), '—');
  assert.equal(tokens(Number.NaN), '—');
});

test('V2 / D6 fraction：总量为 0 或缺失 ⇒ null，不是 0（负向控制）', () => {
  // 若直接算 used/total，这里会得到 NaN 或 0，从而把"拿不到"画成"0%"
  assert.equal(fraction(0, 0), null);
  assert.equal(fraction(10, 0), null);
  assert.equal(fraction(null, 100), null);
  assert.equal(fraction(10, null), null);
  assert.equal(fraction(50, 200), 0.25);
});

test('V2 真 0 必须渲染成 0，不得混同缺值', () => {
  assert.equal(pct(0), '0%');
  assert.equal(bytes(0), '0 B');
  assert.equal(num(0), '0');
  assert.equal(tokens(0), '0');
});

// ── 冻结基线：B1 不得改变既有显示口径（与 muxin 取值故意不同）────
test('冻结基线 tokens：34.6k / 1.3M（不是 muxin 的 35K）', () => {
  assert.equal(tokens(34_600), '34.6k');
  assert.equal(tokens(1_250_000), '1.3M');
  assert.equal(tokens(999), '999');
});

test('冻结基线 usd：有效位随量级、无千分位（不是 muxin 的 $1,235）', () => {
  assert.equal(usd(0.4234), '$0.423');
  assert.equal(usd(1.5), '$1.50');
  assert.equal(usd(1234.6), '$1235');
});

test('冻结基线 num：千分位', () => {
  assert.equal(num(0), '0');
  assert.equal(num(1234), '1,234');
  assert.equal(num(1_234_567), '1,234,567');
});

test('bytes：1024 进制，两位有效', () => {
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(1_500_000), '1.4 MB');
});

// ── D6：阈值只在一处 ─────────────────────────────────────────
test('diskLow：阈值是导出常量 + 拿不到比例时不得判为"低"（负向控制）', () => {
  assert.equal(DISK_LOW_FREE_RATIO, 0.1);
  assert.equal(diskLow(5, 100), true);
  assert.equal(diskLow(50, 100), false);
  // 拿不到总量 ⇒ 不能谎报"磁盘低"
  assert.equal(diskLow(5, 0), false);
  assert.equal(diskLow(null, 100), false);
  assert.equal(pct(0.376), '38%');
});

// ── D5：状态词表封闭集 + 未知兜底 + 短/长两密度 ────────────────
test('D5 词表来自本仓真实模型：online / draining / offline 三值', () => {
  assert.deepEqual([...NODE_STATUSES], ['online', 'draining', 'offline']);
});

test('D5 statusWord：短词', () => {
  zh();
  assert.equal(statusWord('online'), '在线');
  assert.equal(statusWord('draining'), '排空中');
  assert.equal(statusWord('offline'), '离线');
  en();
  assert.equal(statusWord('online'), 'online');
});

test('D5 statusWord：未知状态必须落到默认词，不得回显原值（负向控制）', () => {
  zh();
  assert.equal(statusWord('__nope__'), '未知');
  assert.equal(statusWord(null), '未知');
  assert.equal(statusWord(''), '未知');
});

test('D5 statusReason：长因给原因 + 何时见过', () => {
  zh();
  assert.equal(statusReason({ status: 'offline', lastHeartbeatAt: NOW - 90_000 }, NOW), '离线 · 最后心跳 1 分钟前');
  assert.equal(statusReason({ status: 'offline', lastHeartbeatAt: null }, NOW), '离线 · 从未上报心跳');
  assert.equal(statusReason({ status: 'draining' }, NOW), '排空中 · 不再接新任务');
  assert.equal(statusReason({ status: 'online', rolloutState: 'idle' }, NOW), '在线');
});

test('D5 statusReason：blockers 优先于状态词（有阻碍就说阻碍）', () => {
  zh();
  assert.equal(statusReason({ status: 'online', blockers: ['workspace 缺失'] }, NOW), 'workspace 缺失');
  assert.equal(statusReason({ status: 'offline', blockers: ['磁盘不足'] }, NOW), '磁盘不足');
});

test('D5 statusReason：未知状态不得把原始对象/JSON 渲染进界面（负向控制）', () => {
  zh();
  const out = statusReason({ status: 'weird' }, NOW);
  assert.ok(out.includes('未知'), `应包含"未知"，实得 ${out}`);
  assert.ok(!out.includes('{'), '不得渲染原始对象');
  assert.ok(!out.includes('object'), '不得渲染 Object 字符串');
});

// ── 语言：非法值兜底 ─────────────────────────────────────────
test('setFormatLang：非法语言兜底到 en，不抛', () => {
  setFormatLang('fr');
  assert.equal(getFormatLang(), 'en');
  setFormatLang('zh');
  assert.equal(getFormatLang(), 'zh');
  setFormatLang('en');
});
