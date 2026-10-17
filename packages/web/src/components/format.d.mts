/** `format.mjs` 的类型声明。逻辑在 .mjs（可被 `node --test` 直测），类型在这里。 */

export type FormatLang = 'en' | 'zh';

/** los 执行节点的真实状态取值（见 `src/api/types-executor-nodes.ts:9`）。 */
export type NodeStatus = 'online' | 'draining' | 'offline';

/** `statusReason` 的输入：只要求它可能用到的字段，便于从节点对象直接传入。 */
export type StatusReasonInput = {
  status?: string;
  blockers?: string[];
  warnings?: string[];
  rolloutState?: string;
  lastHeartbeatAt?: number | string | null;
};

export function setFormatLang(next: string): void;
export function getFormatLang(): FormatLang;

export function ago(ts: number | Date | null | undefined, nowMs?: number): string;
export function elapsed(fromMs: number | null | undefined, nowMs?: number): string;
export function duration(secs: number | null | undefined): string;
export function uptime(secs: number | null | undefined): string;

export function num(value: number | null | undefined): string;
export function tokens(value: number | null | undefined): string;
export function usd(value: number | null | undefined): string;
export function decimals(value: number | null | undefined, digits: number): string;
export function bytes(n: number | null | undefined): string;
export function pct(fraction: number | null | undefined): string;
export function fraction(used: number | null | undefined, total: number | null | undefined): number | null;

export const DISK_LOW_FREE_RATIO: number;
export function diskLow(freeBytes: number | null | undefined, totalBytes: number | null | undefined): boolean;

export const NODE_STATUSES: readonly NodeStatus[];
export function statusWord(status: string | null | undefined): string;
export function statusReason(node: StatusReasonInput | null | undefined, nowMs?: number): string;
