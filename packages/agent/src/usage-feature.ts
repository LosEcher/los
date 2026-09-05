/**
 * Feature attribution for usage/cost measurement (roadmap R6 / R-LOS-01).
 *
 * Labels which product surface a model call belongs to, so the usage cube can
 * answer "how much does the channel/memory/eval surface cost" — the data
 * prerequisite for paid-tier design. Values are additive: new surfaces add
 * labels, they do not rewrite history (unspecified covers pre-R6 calls).
 *
 * Guard（R-LOS-01 验收）：新增调用点未登记 purpose 必须可见——
 * normalizeUsageFeature 默认 warn（生产不阻断），opts.fail 时抛错（测试/门禁），
 * 未知值一律归一为 'unspecified' 而非原样透传。
 */

import { getLogger } from '@los/infra/logger';

const log = getLogger('usage-feature');

export type UsageFeature =
  | 'chat'        // interactive /chat (Web console, API, OpenAI-compatible route)
  | 'scheduler'   // scheduled tasks (daily/weekly/interval/once, governance jobs)
  | 'eval'        // evaluation runs (pairwise, scenario economics, quality snapshots)
  | 'channel'     // messaging channels (telegram, wechat)
  | 'subagent'    // spawn_agent children of a governed run
  | 'self-check'  // goal self-check / verification-review model calls
  | 'unspecified'; // default: pre-R6 calls or unattributed paths

export const USAGE_FEATURES: readonly UsageFeature[] = [
  'chat',
  'scheduler',
  'eval',
  'channel',
  'subagent',
  'self-check',
  'unspecified',
];

export function normalizeUsageFeature(
  value: unknown,
  opts: { fail?: boolean } = {},
): UsageFeature {
  if (typeof value === 'string' && (USAGE_FEATURES as readonly string[]).includes(value)) {
    return value as UsageFeature;
  }
  const message =
    `Unknown usage purpose ${JSON.stringify(value ?? null)} — register it in ` +
    `@los/agent/usage-feature (USAGE_FEATURES) or fix the typo`;
  if (opts.fail) throw new Error(message);
  log.warn(message);
  return 'unspecified';
}
