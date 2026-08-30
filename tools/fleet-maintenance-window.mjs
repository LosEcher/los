import { createHash } from 'node:crypto';

const DURATION_UNITS = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export function parseDurationMs(raw) {
  const match = /^(\d+)(m|h|d)$/.exec(String(raw || '').trim());
  if (!match) throw new Error('duration must use <number>m, <number>h, or <number>d');
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('duration must be positive');
  return amount * DURATION_UNITS[match[2]];
}

export function maintenanceWindowId(window) {
  return createHash('sha256')
    .update(`${window.start}\0${window.end}`)
    .digest('hex')
    .slice(0, 12);
}

export function appendMaintenanceWindow(windows, nextWindow, nowMs = Date.now()) {
  const retained = windows
    .filter((window) => Number.isFinite(Date.parse(window.start)) && Date.parse(window.end) >= nowMs)
    .map((window) => ({ start: window.start, end: window.end }));
  if (!retained.some((window) => window.start === nextWindow.start && window.end === nextWindow.end)) {
    retained.push({ start: nextWindow.start, end: nextWindow.end });
  }
  return retained.sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

export function removeMaintenanceWindow(windows, windowId) {
  const retained = windows.filter((window) => maintenanceWindowId(window) !== windowId);
  return { windows: retained, removed: retained.length !== windows.length };
}

export function pruneExpiredMaintenanceWindows(windows, nowMs = Date.now()) {
  return windows.filter((window) => Date.parse(window.end) >= nowMs);
}
