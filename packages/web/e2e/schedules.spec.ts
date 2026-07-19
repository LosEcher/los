import { expect, test, type Page, type Request } from '@playwright/test';

const AUTH_TOKEN = 'e2e-auth-token';
const OPERATOR_TOKEN = 'e2e-operator-token';
const NOW = '2026-07-18T08:00:00.000Z';

type RequestRecord = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
};

test('creates and operates a bounded schedule with preview and history', async ({ page }, testInfo) => {
  await seedTokens(page);
  const records = await mockSchedulesGateway(page);
  await page.goto('/#schedules');

  await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Runtime readiness check' })).toBeVisible();
  await page.getByRole('button', { name: 'New schedule' }).click();
  await page.getByLabel('Title').fill('Daily operator inbox');
  await page.getByLabel('Template').selectOption('morning_inbox_digest');
  await page.getByLabel('Preset').selectOption('daily');
  await page.getByLabel('Time', { exact: true }).fill('08:45');
  await page.getByLabel('Timezone', { exact: true }).fill('Asia/Shanghai');
  await expect(page.locator('.schedule-preview strong')).toHaveCount(3);
  await page.getByRole('button', { name: 'Create schedule' }).click();

  await expect.poll(() => records.some(record => record.path === '/scheduled-work-items' && record.method === 'POST')).toBe(true);
  const create = records.find(record => record.path === '/scheduled-work-items' && record.method === 'POST')!;
  expect(create.headers['x-los-operator-token']).toBe(OPERATOR_TOKEN);
  expect(create.body).toMatchObject({
    title: 'Daily operator inbox', templateId: 'morning_inbox_digest',
    trigger: { kind: 'cron', expression: '45 8 * * *', timezone: 'Asia/Shanghai' },
    approvalPolicy: 'read_only_auto', concurrencyPolicy: 'skip', catchUpPolicy: 'skip',
  });

  await expect(page.getByRole('heading', { name: 'Daily operator inbox' })).toBeVisible();
  await expect(page.getByText('Run history')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect.poll(() => records.some(record => record.path === '/scheduled-work-items/schedule-created' && record.method === 'PATCH')).toBe(true);
  await expect.poll(() => records.some(record => record.path === '/scheduled-work-items/schedule-created/trigger')).toBe(true);
  const pause = records.find(record => record.path === '/scheduled-work-items/schedule-created' && record.method === 'PATCH')!;
  expect(pause.body).toEqual({ status: 'paused' });
  await assertViewportIsOperable(page, page.getByRole('button', { name: 'Run now' }));
  await page.screenshot({ path: testInfo.outputPath('schedules.png'), fullPage: true });
});

async function seedTokens(page: Page) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
}

async function mockSchedulesGateway(page: Page): Promise<RequestRecord[]> {
  const records: RequestRecord[] = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) return route.continue();
    records.push(requestRecord(request, url));
    if (url.pathname === '/settings') return json(route, { auth: { enabled: true }, agent: { maxLoops: 20 } });
    if (url.pathname === '/health') return json(route, { status: 'ok', uptime: 42 });
    if (request.headers()['x-los-auth-token'] !== AUTH_TOKEN) return json(route, { error: 'unauthorized' }, 401);
    if (isOperatorWrite(request) && request.headers()['x-los-operator-token'] !== OPERATOR_TOKEN) return json(route, { error: 'forbidden' }, 403);
    return json(route, responseFor(url.pathname, request.method()));
  });
  return records;
}

function responseFor(path: string, method: string): unknown {
  if (path === '/scheduled-work-items/preview') return { trigger: scheduleItem().trigger, occurrences: ['2026-07-20T00:45:00.000Z', '2026-07-21T00:45:00.000Z', '2026-07-22T00:45:00.000Z'] };
  if (path === '/scheduled-work-items' && method === 'POST') return { schedule: scheduleItem('schedule-created', 'Daily operator inbox'), occurrences: ['2026-07-20T00:45:00.000Z'] };
  if (path === '/scheduled-work-items') return { count: 1, results: [scheduleItem()] };
  if (path === '/scheduled-work-items/schedule-created' && method === 'PATCH') return { ...scheduleItem('schedule-created', 'Daily operator inbox'), status: 'paused' };
  if (path === '/scheduled-work-items/schedule-created') return { schedule: scheduleItem('schedule-created', 'Daily operator inbox'), runs: [scheduleRun('schedule-created')] };
  if (path === '/scheduled-work-items/schedule-e2e') return { schedule: scheduleItem(), runs: [scheduleRun()] };
  if (path.endsWith('/trigger')) return scheduleRun(path.split('/')[2] ?? 'schedule-e2e');
  if (path === '/sessions' || path === '/skills' || path === '/rules') return [];
  if (path === '/memory/stats') return { totalObservations: 0 };
  return {};
}

function scheduleItem(id = 'schedule-e2e', title = 'Runtime readiness check') {
  return {
    id, tenantId: 'local', projectId: 'los', title, status: 'enabled',
    trigger: { kind: 'cron', expression: '30 8 * * *', timezone: 'Asia/Shanghai' },
    runTemplate: {
      templateId: title === 'Runtime readiness check' ? 'runtime_readiness' : 'morning_inbox_digest',
      mode: title === 'Runtime readiness check' ? 'governance' : 'audit',
      goalTemplate: 'Inspect persisted LOS runtime readiness without calling a provider.',
      editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'read_only_auto', concurrencyPolicy: 'skip', catchUpPolicy: 'skip',
    maxConcurrentRuns: 1, maxLatenessMs: 3600000, maxAttempts: 2, failureThreshold: 3,
    nextRunAt: '2026-07-20T00:30:00.000Z', circuitState: 'closed',
    consecutiveFailures: 0, consecutiveNoOps: 0, revision: 1, createdAt: NOW, updatedAt: NOW,
  };
}

function scheduleRun(scheduleId = 'schedule-e2e') {
  return {
    id: `schedule-run-${scheduleId}`, scheduleId, scheduledFor: NOW, triggerKind: 'manual',
    status: 'succeeded', attemptCount: 1, maxAttempts: 2, workItemId: 'work-scheduled-e2e',
    resultSummary: { unavailable: 1 }, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
  };
}

function requestRecord(request: Request, url: URL): RequestRecord {
  let body: Record<string, unknown> | undefined;
  try { body = request.postDataJSON() as Record<string, unknown>; } catch { /* no JSON body */ }
  return { path: url.pathname, method: request.method(), headers: request.headers(), body };
}

function isAsset(path: string): boolean {
  return path === '/' || path.startsWith('/src/') || path.startsWith('/node_modules/') || path.startsWith('/@') || path.endsWith('.css');
}

function isOperatorWrite(request: Request): boolean {
  return request.method() === 'POST' || request.method() === 'PATCH';
}

async function json(route: Parameters<Page['route']>[1] extends (route: infer R) => unknown ? R : never, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function assertViewportIsOperable(page: Page, control: ReturnType<Page['locator']>) {
  const viewport = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(viewport.scroll).toBeLessThanOrEqual(viewport.client + 1);
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
}
