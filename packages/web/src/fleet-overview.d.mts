/** `fleet-overview.mjs` 的类型声明。逻辑在 .mjs（可被 node --test 直测）。 */

export const SUMMARY_MAX_PARTS: number;

export type FleetCounts = { total?: number; healthy?: number; attention?: number };
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function buildSummaryParts(counts: FleetCounts | undefined, t: Translate): string[];
export function capAttention(ids: string[] | undefined | null, limit?: number): { shown: string[]; overflow: number };
