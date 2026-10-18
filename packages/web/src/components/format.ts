// 再导出层：`format.mjs` 是可测实现，这里保持既有 import 路径与名字不变。
// 既有名（formatNumber / formatTokenCount / formatUsd）语义与实现**未变**，
// 只是改成别名指向 .mjs，所以调用方零改动。

export {
  setFormatLang,
  getFormatLang,
  ago,
  elapsed,
  duration,
  uptime,
  num,
  num as formatNumber,
  tokens,
  tokens as formatTokenCount,
  usd,
  usd as formatUsd,
  bytes,
  decimals,
  pct,
  fraction,
  diskLow,
  DISK_LOW_FREE_RATIO,
  NODE_STATUSES,
  statusWord,
  statusReason,
} from './format.mjs';

export type {
  FormatLang,
  NodeStatus,
  StatusReasonInput,
} from './format.mjs';
