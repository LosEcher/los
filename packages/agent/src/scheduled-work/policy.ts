import type {
  CreateScheduledWorkItemInput,
  ScheduledWorkItem,
  ScheduledWorkRunStatus,
  ScheduledWorkTrigger,
} from './types.js';

const ACTIVE_RUN_STATUSES = new Set<ScheduledWorkRunStatus>([
  'queued', 'claimed', 'running', 'awaiting_approval',
]);

export function validateScheduledTrigger(trigger: ScheduledWorkTrigger): void {
  validateTimeZone(trigger.timezone);
  if (trigger.kind === 'cron') parsePresetCron(trigger.expression);
  else if (trigger.kind === 'interval') parseIntervalMs(trigger.expression);
  else {
    const when = Date.parse(trigger.expression);
    if (!Number.isFinite(when)) throw new Error('once trigger expression must be an ISO timestamp');
  }
}

export function validateScheduledWorkItemInput(input: CreateScheduledWorkItemInput): void {
  if (!input.projectId.trim() || !input.title.trim()) throw new Error('projectId and title are required');
  validateScheduledTrigger(input.trigger);
  if (!['morning_inbox_digest', 'runtime_readiness', 'scheduled_feed_analysis'].includes(input.runTemplate.templateId)) {
    throw new Error('unsupported schedule template');
  }
  if (input.runTemplate.toolMode !== 'read-only' || input.runTemplate.editableSurfaces.length > 0) {
    throw new Error('P2 scheduled templates must be read-only with no editable surfaces');
  }
  if (input.runTemplate.templateId === 'scheduled_feed_analysis') {
    if (input.approvalPolicy !== 'preapproved_scope') {
      throw new Error('scheduled_feed_analysis requires preapproved_scope');
    }
    validateFeedAnalysisRequest(input.runTemplate.feedAnalysisRequest);
  } else if (input.runTemplate.feedAnalysisRequest) {
    throw new Error('feedAnalysisRequest is only valid for scheduled_feed_analysis');
  }
}

function validateFeedAnalysisRequest(request: ScheduledWorkItem['runTemplate']['feedAnalysisRequest']): void {
  if (!request?.sourceSystem?.trim() || !String(request.deliveryMode ?? '').trim()) {
    throw new Error('scheduled_feed_analysis requires sourceSystem and deliveryMode');
  }
  if ('sourceJobId' in request) throw new Error('scheduled sourceJobId is derived by LOS');
  const hasMaterial = Boolean(request.materialBundleRef)
    || Boolean(request.materialBundle?.items.length)
    || Boolean(request.feedObservations?.length);
  if (!hasMaterial) throw new Error('scheduled_feed_analysis requires material evidence');
  const serialized = JSON.stringify(request);
  if (/"(?:secret|token|authorization|credential|password|callbackUrl)"\s*:/i.test(serialized)) {
    throw new Error('scheduled feed analysis cannot persist credentials or callback URLs');
  }
}

export function previewScheduledOccurrences(
  trigger: ScheduledWorkTrigger,
  after: Date = new Date(),
  count = 3,
): string[] {
  validateScheduledTrigger(trigger);
  const boundedCount = Math.min(10, Math.max(1, count));
  const results: string[] = [];
  const excludedWallSlots = new Set<string>();
  let cursor = after;
  for (let index = 0; index < boundedCount; index += 1) {
    const next = nextScheduledOccurrence(trigger, cursor, excludedWallSlots);
    if (!next) break;
    results.push(next.toISOString());
    excludedWallSlots.add(wallSlotKey(next, trigger.timezone));
    cursor = next;
  }
  return results;
}

export function nextScheduledOccurrence(
  trigger: ScheduledWorkTrigger,
  after: Date,
  excludedWallSlots: Set<string> = new Set(),
): Date | null {
  validateScheduledTrigger(trigger);
  if (trigger.kind === 'once') {
    const once = new Date(trigger.expression);
    return once.getTime() > after.getTime() ? once : null;
  }
  if (trigger.kind === 'interval') {
    return new Date(after.getTime() + parseIntervalMs(trigger.expression));
  }
  const cron = parsePresetCron(trigger.expression);
  let candidate = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const max = candidate.getTime() + 35 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= max) {
    const parts = zonedParts(candidate, trigger.timezone);
    const matchesDay = cron.weekday === undefined || parts.weekday === cron.weekday;
    const key = wallSlotKey(candidate, trigger.timezone);
    if (matchesDay && parts.hour === cron.hour && parts.minute === cron.minute && !excludedWallSlots.has(key)) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error('unable to resolve next trigger within 35 days');
}

export function nextOccurrenceAfterSlot(
  trigger: ScheduledWorkTrigger,
  currentSlot: Date,
): Date | null {
  return nextScheduledOccurrence(
    trigger,
    currentSlot,
    new Set([wallSlotKey(currentSlot, trigger.timezone)]),
  );
}

export function isRunStatusActive(status: ScheduledWorkRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export function shouldSkipLateRun(
  scheduledFor: Date,
  now: Date,
  maxLatenessMs: number,
  catchUpPolicy: 'skip' | 'run_once',
): boolean {
  return catchUpPolicy === 'skip' && now.getTime() - scheduledFor.getTime() > maxLatenessMs;
}

export function parseIntervalMs(expression: string): number {
  const match = expression.trim().match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error('interval expression must use <number>m, <number>h, or <number>d');
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const value = amount * multiplier;
  if (value < 5 * 60_000 || value > 31 * 86_400_000) {
    throw new Error('interval must be between 5 minutes and 31 days');
  }
  return value;
}

function parsePresetCron(expression: string): { minute: number; hour: number; weekday?: number } {
  const match = expression.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6])$/);
  if (!match) throw new Error('cron expression must be a daily or weekly preset');
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error('cron hour or minute is out of range');
  return { minute, hour, weekday: match[3] === '*' ? undefined : Number(match[3]) };
}

function validateTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
}

function wallSlotKey(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`;
}

function zonedParts(date: Date, timezone: string): {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), weekday: weekdays[values.weekday!]!,
  };
}
