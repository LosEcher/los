/** Short lease for claim/queue handoff before execution starts. */
function defaultScheduledWorkClaimLeaseMs(): number {
  return 60_000;
}

/**
 * Execution lease for long agent work. The 60s claim default was reclaimed by
 * the tick reaper mid-flight, causing a second execute to hit
 * `schedule-exec-${run.id}` dedupe and mark the run failed while the first
 * task still succeeded (2026-08-09 network-observe/surge).
 */
export function defaultScheduledWorkExecutionLeaseMs(): number {
  return 30 * 60_000;
}

/** How often executeScheduledWorkRun renews the execution lease. */
export function scheduledWorkExecutionHeartbeatMs(): number {
  return 60_000;
}

export function claimLeaseExpiry(now: Date, leaseMs?: number): Date {
  return new Date(now.getTime() + (leaseMs ?? defaultScheduledWorkClaimLeaseMs()));
}
