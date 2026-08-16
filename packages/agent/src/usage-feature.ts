/**
 * Feature attribution for usage/cost measurement (roadmap R6).
 *
 * Labels which product surface a model call belongs to, so the usage cube can
 * answer "how much does the channel/memory/eval surface cost" — the data
 * prerequisite for paid-tier design. Values are additive: new surfaces add
 * labels, they do not rewrite history (unspecified covers pre-R6 calls).
 */

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

export function normalizeUsageFeature(value: unknown): UsageFeature {
  if (typeof value === 'string' && (USAGE_FEATURES as readonly string[]).includes(value)) {
    return value as UsageFeature;
  }
  return 'unspecified';
}
