import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Compile-free pure helpers reimplemented for node:test (source is TS via Vite).
// Keep in sync with nav-config.ts — structural contract only.

const MOBILE_TAB_IDS = ['inbox', 'work', 'chat'];
const DAILY_IDS = ['inbox', 'work', 'schedules', 'chat'];

function isMobileTabPage(id) {
  return MOBILE_TAB_IDS.includes(id);
}

function isMoreShellPage(id) {
  return !isMobileTabPage(id);
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseHash(rawHash) {
  const raw = String(rawHash || '').replace(/^#/, '').trim();
  if (!raw) return { page: 'inbox' };
  const workPath = raw.match(/^work\/([^/?#]+)\/?$/);
  if (workPath?.[1]) return { page: 'work', workItemId: safeDecode(workPath[1]) };
  const [pathPart, query = ''] = raw.split('?');
  const path = pathPart || 'inbox';
  const params = new URLSearchParams(query);
  const known = new Set([...DAILY_IDS, 'sessions', 'todos', 'tasks', 'settings', 'onboarding']);
  const page = known.has(path) ? path : 'inbox';
  const workItemId = params.get('id')?.trim() || undefined;
  const sessionId = params.get('session')?.trim() || undefined;
  if (page === 'work' && workItemId) return { page, workItemId };
  if (page === 'inbox' && workItemId) return { page, workItemId };
  if (page === 'chat' && sessionId) return { page, sessionId: safeDecode(sessionId) };
  return { page };
}

function buildHash(route) {
  if (route.page === 'work' && route.workItemId) return `work/${encodeURIComponent(route.workItemId)}`;
  if (route.page === 'chat' && route.sessionId) return `chat?session=${encodeURIComponent(route.sessionId)}`;
  if (route.page === 'inbox' && route.workItemId) return `inbox?id=${encodeURIComponent(route.workItemId)}`;
  return route.page;
}

describe('mobile daily shell nav contract', () => {
  it('keeps three primary phone tabs and parks schedules in More', () => {
    assert.deepEqual(MOBILE_TAB_IDS, ['inbox', 'work', 'chat']);
    assert.equal(isMobileTabPage('schedules'), false);
    assert.equal(isMoreShellPage('schedules'), true);
    assert.equal(isMoreShellPage('providers'), true);
    assert.equal(isMoreShellPage('tasks'), true);
    for (const id of MOBILE_TAB_IDS) {
      assert.equal(isMobileTabPage(id), true);
      assert.equal(isMoreShellPage(id), false);
    }
  });

  it('keeps desktop daily path as four decision surfaces', () => {
    assert.deepEqual(DAILY_IDS, ['inbox', 'work', 'schedules', 'chat']);
  });

  it('parses and builds work/session deep links', () => {
    assert.deepEqual(parseHash('#work/work-abc'), { page: 'work', workItemId: 'work-abc' });
    assert.deepEqual(parseHash('#work?id=work-abc'), { page: 'work', workItemId: 'work-abc' });
    assert.deepEqual(parseHash('#inbox?id=work-abc'), { page: 'inbox', workItemId: 'work-abc' });
    assert.deepEqual(parseHash('#chat?session=s1'), { page: 'chat', sessionId: 's1' });
    assert.equal(buildHash({ page: 'work', workItemId: 'work-abc' }), 'work/work-abc');
    assert.equal(buildHash({ page: 'chat', sessionId: 's1' }), 'chat?session=s1');
    assert.equal(buildHash({ page: 'inbox' }), 'inbox');
  });
});
