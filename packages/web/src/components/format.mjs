// ── format.mjs — 全站唯一的格式化点（2026-10-17，B1）─────────────
//
// 为什么是 .mjs 而不是 .ts：
//   `packages/web` 的测试是 `node --test 'src/**/*.test.mjs'`，**测不了 .ts**。
//   仓内已有同样的成套先例：`diff-parse.mjs`+`.d.mts`、`exec-obs-scrubber.mjs`+`.d.mts`、
//   `nodes-registry-filter.mjs`、`plan-annotate.mjs`、`pages/fleet-topology-layout.mjs`、
//   `pages/topology-fold.mjs`。本文件沿用该形态：逻辑在 .mjs（可被 node --test 直测），
//   类型在 .d.mts，`components/format.ts` 只做再导出以保持既有 import 不破。
//
// ⚠️ **B1 只做重构，不改变任何显示行为**（B2 才是替换调用点）。
//   因此下面三个"冻结基线"与 muxin 的取值**故意不同**，改它们等于改界面：
//     tokens(34600)    === '34.6k'      （muxin 是 '35K'）
//     tokens(1250000)  === '1.3M'       （浮点后 toFixed(1)）
//     usd(1234.6)      === '$1235'      （**无千分位**；muxin 是 '$1,235'）
//   若要改成 muxin 口径，必须单独提一次"显示口径变更"并做前后对照，不能在 B2 里顺手改。
//
// 语言：`i18n/index.tsx` 已有"模块级 activeLang 供非 hook helper 本地化"的约定，
//   这里对齐它：`setFormatLang` 由 I18nProvider 调用，默认 'en'（与 i18n 的默认一致）。
//   ⚠️ 本文件**不得 import `.tsx`**，否则 node --test 无法解析。

// ── V2：缺值一律 '—'。真 0 必须渲染成 0，不得混同 ─────────────────
const DASH = '—';

let lang = 'en';

/** 由 I18nProvider 调用；格式化的语言跟随全站语言。 */
export function setFormatLang(next) {
  lang = next === 'zh' ? 'zh' : 'en';
}

export function getFormatLang() {
  return lang;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── V1：新鲜度渲染成"词"，不渲染裸时间戳；未来时间夹到 0 ───────────
/**
 * 相对时间。
 * @param {number|Date|null|undefined} ts 毫秒时间戳或 Date
 * @param {number} [nowMs] 便于测试注入
 */
export function ago(ts, nowMs = Date.now()) {
  if (ts == null) return lang === 'zh' ? '从未' : 'never';
  const t = ts instanceof Date ? ts.getTime() : ts;
  if (!isNum(t)) return lang === 'zh' ? '从未' : 'never';
  // 未来时间一律夹到 0：不得出现 "-3 秒前"（时钟回拨/时区错配都会撞到）
  const secs = Math.max(0, Math.floor((nowMs - t) / 1000));
  // ⚠️ 这里的 `secs >= 0` 是**故意显式的**：夹取已经保证它成立，但写出来才让
  //    "未来时间不得落到下面的分段函数"这条契约可被读出来（也让夹取成为唯一的防线）。
  if (secs >= 0 && secs < 10) return lang === 'zh' ? '刚刚' : 'just now';
  return lang === 'zh' ? `${relativeZh(secs)}前` : `${relativeEn(secs)} ago`;
}

function relativeZh(secs) {
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时`;
  return `${Math.floor(secs / 86400)} 天`;
}

function relativeEn(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** 运行中耗时，形如 "4m 07s"。 */
export function elapsed(fromMs, nowMs = Date.now()) {
  if (!isNum(fromMs)) return DASH;
  const secs = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** 时长人话（给定秒数）。 */
export function duration(secs) {
  if (!isNum(secs)) return DASH;
  const s = Math.max(0, Math.floor(secs));
  return lang === 'zh' ? relativeZh(s) : relativeEn(s);
}

/** 运行时长，形如 "12 天 4 小时" / "12d 4h"。 */
export function uptime(secs) {
  if (!isNum(secs)) return DASH;
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return lang === 'zh' ? `${s} 秒` : `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d > 0) return lang === 'zh' ? `${d} 天 ${h} 小时` : `${d}d ${h}h`;
  const m = Math.floor((s % 3600) / 60);
  return lang === 'zh' ? `${h} 小时 ${m} 分` : `${h}h ${m}m`;
}

// ── 数值：千分位、紧凑、货币（**冻结既有口径**）───────────────────
const SP = ' ';

/** 千分位整数；null ⇒ '—'。 */
export function num(value) {
  if (value == null || Number.isNaN(value)) return DASH;
  return Number(value).toLocaleString('en-US');
}

/**
 * 紧凑计数（token 数）。**冻结既有口径**：`34.6k` / `1.3M`（小写 k、一位小数）。
 * 与 muxin 的 `35K` **不同**，改它等于改界面。
 */
export function tokens(value) {
  if (value == null || Number.isNaN(value)) return DASH;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * 美元金额。**冻结既有口径**：有效位随量级变化，且**无千分位**（`$1235`）。
 * 与 muxin 的 `$1,235` **不同**，改它等于改界面。
 */
export function usd(value) {
  if (value == null || Number.isNaN(value)) return DASH;
  const digits = value >= 100 ? 0 : value >= 1 ? 2 : 3;
  return `$${value.toFixed(digits)}`;
}

/**
 * 定点小数（N 位）。null ⇒ '—'。
 *
 * **不改变任何既有显示**（等价 `x.toFixed(n)`），只是把"保留几位"收进单一实现点，
 * 并获得 V2 的缺值语义。真正该用语义函数（bytes/pct/usd/tokens）的地方不要用它。
 */
export function decimals(value, digits) {
  if (value == null || Number.isNaN(value)) return DASH;
  const d = Math.max(0, Math.min(10, Math.trunc(digits)));
  return Number(value).toFixed(d);
}

/** 字节。null ⇒ '—'；0 ⇒ '0 B'（真 0 不是缺值）。 */
export function bytes(n) {
  if (n == null || Number.isNaN(n)) return DASH;
  const v = Math.max(0, Number(n));
  if (v < 1024) return `${v}${SP}B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)}${SP}${units[i]}`;
}

/** 比例 → 百分比字符串；null/非法 ⇒ '—'。真 0 ⇒ '0%'。 */
export function pct(fraction) {
  if (fraction == null || Number.isNaN(fraction)) return DASH;
  return `${Math.round(Number(fraction) * 100)}%`;
}

/**
 * 已用比例（0..1）。**总量为 0 或缺失 ⇒ null，不是 0**
 * （"拿不到"和"一点没用"必须可区分，这是 V2 的核心）。
 */
export function fraction(used, total) {
  if (!isNum(used) || !isNum(total) || total <= 0) return null;
  const f = used / total;
  if (!Number.isFinite(f)) return null;
  return Math.min(1, Math.max(0, f));
}

/** 磁盘是否偏低。**阈值只出现在这一处**（改阈值只改这里）。 */
export const DISK_LOW_FREE_RATIO = 0.1;

export function diskLow(freeBytes, totalBytes) {
  const f = fraction(freeBytes, totalBytes);
  if (f == null) return false;
  return f < DISK_LOW_FREE_RATIO;
}

// ── D5：状态词表（封闭集 + 未知兜底 + 短/长两密度）─────────────────
//
// ⚠️ 词表必须来自**本仓真实模型**，不得照搬参考实现：
//    `src/api/types-executor-nodes.ts:9` 的真实取值是
//    `status: 'online' | 'draining' | 'offline'` —— 没有 powered-off/stopped/installing。
//    muxin 的 6 词是**它自己的领域**，硬塞进来会得到永不出现的分支。
export const NODE_STATUSES = /** @type {const} */ (['online', 'draining', 'offline']);

const STATUS_WORD = {
  zh: { online: '在线', draining: '排空中', offline: '离线', __unknown: '未知' },
  en: { online: 'online', draining: 'draining', offline: 'offline', __unknown: 'unknown' },
};

/** 短词（表格/侧栏用）。未知状态必须落到默认词，不得回显原始值。 */
export function statusWord(status) {
  const table = STATUS_WORD[lang] ?? STATUS_WORD.en;
  return table[status] ?? table.__unknown;
}

/**
 * 长因（卡片/详情用）：给一句"为什么 + 何时见过"。
 * @param {{status?: string, blockers?: string[], warnings?: string[],
 *          rolloutState?: string, lastHeartbeatAt?: number|string|null}} node
 */
export function statusReason(node, nowMs = Date.now()) {
  const n = node ?? {};
  const zh = lang === 'zh';
  const blockers = Array.isArray(n.blockers) ? n.blockers.filter(Boolean) : [];
  if (blockers.length > 0) return blockers[0];

  switch (n.status) {
    case 'online':
      return n.rolloutState && n.rolloutState !== 'idle'
        ? (zh ? `在线 · 发布中（${n.rolloutState}）` : `online · rolling out (${n.rolloutState})`)
        : (zh ? '在线' : 'online');
    case 'draining':
      return zh ? '排空中 · 不再接新任务' : 'draining · takes no new work';
    case 'offline': {
      const seen = toMs(n.lastHeartbeatAt);
      if (seen == null) return zh ? '离线 · 从未上报心跳' : 'offline · never reported a heartbeat';
      return zh ? `离线 · 最后心跳 ${ago(seen, nowMs)}` : `offline · last heartbeat ${ago(seen, nowMs)}`;
    }
    default:
      return zh ? `未知状态（${statusWord(n.status)}）` : `unknown state (${statusWord(n.status)})`;
  }
}

function toMs(v) {
  if (v == null) return null;
  if (isNum(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
