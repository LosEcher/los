/**
 * exec-obs-scrubber.d.mts — 类型声明（exec-obs-scrubber.mjs 的 TS 面）
 * 与 packages/web/src/api/types-sessions.ts 的投影形状对应。
 */

/** 一个 turn 的证据（ExecutionTurnWaterfall 的简化形状，只消费 eventIds/count） */
export interface TurnEvidence {
  durationMs?: number;
  count?: number;
  eventIds?: number[];
}

export interface TurnLike {
  turn: number;
  modelWait?: TurnEvidence;
  toolWait?: TurnEvidence;
  retries?: TurnEvidence;
  errors?: TurnEvidence;
  denied?: TurnEvidence;
  tokens?: TurnEvidence;
}

export interface FailureFacetLike {
  category: string;
  code: string;
  message: string | null;
  eventIds: number[];
  verificationRecordIds: string[];
}

export interface ProjectionLike {
  waterfall?: TurnLike[];
  failureFacets?: FailureFacetLike[];
}

export interface EventIndex {
  floor: number;
  len: number;
  spans: Array<{ turn: number; min: number | null; max: number | null; count: number }>;
}

export interface FailureMarker {
  category: string;
  code: string;
  message: string | null;
  eventIds: number[];
  position: number | null;
}

export interface ScrubberProjection {
  index: EventIndex;
  sparkline: number[];
  failureMarkers: FailureMarker[];
  totals: { turns: number; retries: number; errors: number; denied: number };
}

export const DEFAULT_COLUMNS: number;
export const SPARKLINE_LEVELS: number;

export function collectTurnEventIds(turn: TurnLike): number[];
export function buildEventIndex(waterfall?: TurnLike[]): EventIndex;
export function eventPosition(eventId: number, index: EventIndex): number | null;
export function buildSparkline(waterfall?: TurnLike[], columns?: number): number[];
export function buildFailureMarkers(projection?: ProjectionLike): FailureMarker[];
export function buildScrubberProjection(
  projection?: ProjectionLike,
  columns?: number,
): ScrubberProjection;
