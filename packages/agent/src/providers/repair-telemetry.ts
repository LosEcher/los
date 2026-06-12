/**
 * In-memory counters for provider repair events.
 *
 * Tracks orphan args, split tool call merges, phantom calls, and other
 * provider-specific streaming quirks. Exposed via GET /diagnostics/provider-health
 * for monitoring and alerting.
 */

const counters = new Map<string, number>();

export function incrementRepairCounter(provider: string, key: string): void {
  const fullKey = `${provider}:${key}`;
  counters.set(fullKey, (counters.get(fullKey) ?? 0) + 1);
}

export function getRepairCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}
