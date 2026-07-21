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
async function seedTokens(page: Page, operatorToken = OPERATOR_TOKEN) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: operatorToken });
}
async function mockGateway(page: Page): Promise<RequestRecord[]> {
  const records: RequestRecord[] = [];
  await page.routeWebSocket('**/sessions/*/stream', socket => socket.close());
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) {
      await route.continue();
      return;
    }

    const record = requestRecord(request, url);
    records.push(record);
    if (url.pathname === '/settings' || url.pathname === '/health') {
      await json(route, url.pathname === '/settings'
        ? { auth: { enabled: true }, agent: { maxLoops: 20 } }
        : { status: 'ok', uptime: 42 });
      return;
    }
    if (request.headers()['x-los-auth-token'] !== AUTH_TOKEN) {
      await json(route, { error: 'unauthorized' }, 401);
      return;
    }
    if (requiresOperator(url.pathname) && request.headers()['x-los-operator-token'] !== OPERATOR_TOKEN) {
      await json(route, { error: 'forbidden' }, 403);
      return;
    }
    if (url.pathname === '/chat' && request.method() === 'POST') {
      await route.continue({ url: 'http://127.0.0.1:4180/chat' });
      return;
    }
    await json(route, responseFor(url.pathname, url.search, request.method()));
  });
  return records;
}
test('stores auth tokens and restores protected data after reload', async ({ page }) => {
  const records = await mockGateway(page);
  await page.goto('/#sessions');

  await expect(page.getByPlaceholder('Auth token…')).toBeVisible();
  await page.getByPlaceholder('Auth token…').fill(AUTH_TOKEN);
  await page.getByPlaceholder('Operator token (steering)…').fill(OPERATOR_TOKEN);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('los-auth-token'))).toBe(AUTH_TOKEN);
  await page.reload();

  await expect(page.getByRole('button', { name: /session-main/ })).toBeVisible();
  expect(records.some(r => r.path === '/sessions' && !r.headers['x-los-auth-token'])).toBe(true);
  expect(records.some(r => r.path === '/sessions' && r.headers['x-los-auth-token'] === AUTH_TOKEN)).toBe(true);
  await assertViewportIsOperable(page, [
    page.getByRole('button', { name: /session-main/ }),
    page.getByPlaceholder('filter sessions'),
  ]);
});

test('runs chat, recovers operator 403, and cancels an active task', async ({ page }) => {
  await seedTokens(page, 'wrong-operator-token');
  const records = await mockGateway(page);
  await page.goto('/#chat');

  const prompt = page.getByPlaceholder('Ask los to inspect or prepare a bounded change... (/ for commands)');
  await prompt.fill('exercise operator approval');
  await page.getByRole('button', { name: 'send' }).click();
  await expect(page.getByText('write_file')).toBeVisible();

  const approval = page.locator('.approval-card').getByRole('button', { name: 'Approve' });
  await approval.click();
  await expect(page.getByText(/Operator authentication required/)).toBeVisible();
  await page.evaluate(token => localStorage.setItem('los-operator-token', token), OPERATOR_TOKEN);
  await approval.click();
  await expect.poll(() => records.filter(r => r.path.endsWith('/operator-events')).length).toBe(2);
  const steering = records.filter(r => r.path.endsWith('/operator-events')).at(-1)!;
  expect(steering.headers['x-los-operator-token']).toBe(OPERATOR_TOKEN);
  expect(steering.body?.type).toBe('steering');
  expect(steering.body?.instruction).toBe('approve');

  await prompt.fill('keep running until cancelled');
  await page.getByRole('button', { name: 'send' }).click();
  const cancel = page.getByRole('button', { name: 'cancel' });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByRole('heading', { name: 'Cancel this run?' })).toBeVisible();
  await assertNoOverlap(
    page.getByRole('button', { name: 'Cancel run' }),
    page.getByRole('button', { name: 'Keep running' }),
  );
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByText('Run cancelled by operator')).toBeVisible();
  await expect.poll(() => records.some(r => r.path === '/tasks/task-e2e/cancel')).toBe(true);
  const cancelCall = records.find(r => r.path === '/tasks/task-e2e/cancel')!;
  expect(cancelCall.body?.reason).toBe('cancelled_from_web_console');
  await expect(page.getByRole('button', { name: 'send' })).toBeVisible();
  await assertViewportIsOperable(page, [prompt]);
});
test('shows run action errors and retries approve and recovery with operator auth', async ({ page }) => {
  await seedTokens(page, 'wrong-operator-token');
  const records = await mockGateway(page);
  await page.goto('/#run-specs');

  await page.getByText('run-e2e-0001').click();
  await page.getByRole('button', { name: 'Approve / Reject' }).click();
  const reason = page.getByPlaceholder('Reason (optional) — sent as operator reason');
  await reason.fill('reviewed in browser e2e');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByText(/Approve: AuthError: Operator authentication required/)).toBeVisible();

  await page.evaluate(token => localStorage.setItem('los-operator-token', token), OPERATOR_TOKEN);
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByRole('button', { name: 'Approve / Reject' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve / Reject' }).click();
  await page.getByRole('button', { name: 'Reject / cancel' }).click();

  await expect.poll(() => records.some(r => r.path === '/runs/run-e2e-0001/recover')).toBe(true);
  const approve = records.find(r => r.path === '/runs/run-e2e-0001/approve' && r.headers['x-los-operator-token'] === OPERATOR_TOKEN)!;
  const recover = records.find(r => r.path === '/runs/run-e2e-0001/recover')!;
  expect(approve.body).toEqual({ actor: 'web-console', reason: 'reviewed in browser e2e' });
  expect(recover.body).toMatchObject({ actor: 'web-console', apply: true, intent: 'cancel' });
  await assertViewportIsOperable(page, [page.getByRole('button', { name: 'Approve / Reject' }), page.getByRole('button', { name: 'Verify' })]);
});

test('continues a session and sends a branch as a new chat', async ({ page }) => {
  await seedTokens(page);
  const records = await mockGateway(page);
  await page.goto('/#sessions');

  await page.getByRole('button', { name: /session-main/ }).click();
  await page.getByRole('button', { name: 'continue' }).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(page.getByText('session-main', { exact: true }).first()).toBeVisible();

  await page.goto('/#sessions');
  await page.getByRole('button', { name: /session-main/ }).click();
  await page.getByRole('button', { name: 'branch' }).click();
  await expect(page.getByText(/Branching from session-main/)).toBeVisible();
  const prompt = page.getByPlaceholder('Ask los to inspect or prepare a bounded change... (/ for commands)');
  await prompt.fill('branch with a different approach');
  await page.getByRole('button', { name: 'send' }).click();

  await expect.poll(() => records.some(r => r.path === '/chat' && r.body?.branchFrom === 'session-main')).toBe(true);
  const branch = records.find(r => r.path === '/chat' && r.body?.branchFrom === 'session-main')!;
  expect(branch.body?.sessionId).toBeUndefined();
  await expect(page.getByRole('button', { name: 'send' })).toBeVisible();
  await assertViewportIsOperable(page, [prompt]);
});

test('shows setup gaps and routes each operator to the owning surface', async ({ page }) => {
  await seedTokens(page);
  const records = await mockGateway(page);
  await page.goto('/#setup');

  await expect(page.getByRole('heading', { name: 'Runtime Setup' })).toBeVisible();
  await expect(page.locator('.setup-list').getByText('Gateway', { exact: true })).toBeVisible();
  await expect(page.getByText(/compatibility evidence is still required/)).toBeVisible();
  await expect(page.getByText(/Provider discovery and compatibility evidence are separate checks/)).toBeVisible();
  await expect(page.getByText('No project is bound.')).toBeVisible();
  await expect(page.getByText(/Hermes not detected/)).toBeVisible();

  const readinessPaths = ['/health', '/settings', '/onboarding', '/workspace', '/projects', '/services', '/nodes', '/communication/accounts'];
  const initialReadinessRequests = records.filter(record => readinessPaths.includes(record.path)).length;
  await page.getByRole('button', { name: 'Refresh setup status' }).click();
  await expect.poll(() => records.filter(record => readinessPaths.includes(record.path)).length)
    .toBe(initialReadinessRequests + readinessPaths.length);

  const providers = page.getByRole('button', { name: 'Review Providers' });
  await expect(providers).toBeEnabled();
  await providers.click();
  await expect(page).toHaveURL(/#providers$/);
  await page.goto('/#setup');
  await assertViewportIsOperable(page, [
    page.getByRole('button', { name: 'Refresh setup status' }),
    page.getByRole('button', { name: 'Bind Project' }),
  ]);
});

test('uses Inbox and Work for plan review and structured creation', async ({ page }, testInfo) => {
  await seedTokens(page);
  const records = await mockGateway(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Review the structured plan')).toBeVisible();
  await page.getByRole('button', { name: 'Review plan' }).click();
  await expect(page).toHaveURL(/#work$/);
  await expect(page.getByRole('heading', { name: 'Inspect the Web-first plan' })).toBeVisible();
  await expect(page.getByText('Persist the structured contract')).toBeVisible();

  await page.getByLabel('Approval reason').fill('scope and checks reviewed in Work');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect.poll(() => records.some(record => record.path === '/runs/run-work-e2e/approve')).toBe(true);
  const approval = records.find(record => record.path === '/runs/run-work-e2e/approve')!;
  expect(approval.body).toEqual({ actor: 'web-console', reason: 'scope and checks reviewed in Work' });

  await page.getByRole('button', { name: /Review completed Web changes/ }).click();
  await expect(page.getByRole('heading', { name: 'Verification and changes' })).toBeVisible();
  await expect(page.getByText('web focused tests')).toBeVisible();
  await expect(page.getByText('14 tests passed')).toBeVisible();
  await expect(page.getByText('artifact-diff-web-e2e')).toBeVisible();
  await page.getByLabel('Decision reason').fill('required verification and diff backup reviewed');
  await page.getByRole('button', { name: 'Accept result' }).click();
  await expect.poll(() => records.some(record => record.path === '/work-items/work-e2e-review/result-decision')).toBe(true);
  const resultDecision = records.find(record => record.path === '/work-items/work-e2e-review/result-decision')!;
  expect(resultDecision.headers['x-los-operator-token']).toBe(OPERATOR_TOKEN);
  expect(resultDecision.body).toEqual({
    decision: 'accepted',
    reason: 'required verification and diff backup reviewed',
    closeoutReport: { dirtyPaths: [], checks: ['web focused tests'] },
  });

  await page.getByRole('button', { name: 'New work' }).click();
  await page.getByLabel('Goal', { exact: true }).fill('Create a bounded daily workflow task');
  await page.getByLabel('Editable surfaces').fill('packages/web/src/pages');
  await page.getByLabel('Required checks').fill('pnpm --filter @los/web test');
  await page.getByLabel('Stop conditions').fill('scope expands');
  await page.getByLabel('Evidence required').fill('focused test output');
  await page.getByRole('button', { name: 'Create work' }).click();
  await expect.poll(() => records.some(record => record.path === '/work-items' && record.method === 'POST')).toBe(true);
  const create = records.find(record => record.path === '/work-items' && record.method === 'POST')!;
  expect(create.body).toMatchObject({
    goal: 'Create a bounded daily workflow task',
    mode: 'execution',
    toolMode: 'project-write',
    editableSurfaces: ['packages/web/src/pages'],
    requiredChecks: ['pnpm --filter @los/web test'],
    stopConditions: ['scope expands'],
    evidenceRequired: ['focused test output'],
  });
  await expect(page.getByRole('heading', { name: 'Create a bounded daily workflow task' })).toBeVisible();
  await assertViewportIsOperable(page, [page.getByRole('button', { name: 'Start in Chat' })]);
  await page.screenshot({ path: testInfo.outputPath('web-first.png'), fullPage: true });
});

function requestRecord(request: Request, url: URL): RequestRecord {
  let body: Record<string, unknown> | undefined;
  try { body = request.postDataJSON() as Record<string, unknown>; } catch { /* no JSON body */ }
  return { path: url.pathname, method: request.method(), headers: request.headers(), body };
}

function isAsset(path: string): boolean {
  return path === '/' || path === '/src/main.tsx' || path.startsWith('/src/') || path.startsWith('/node_modules/') || path.startsWith('/@') || path.endsWith('.css');
}
function requiresOperator(path: string): boolean {
  return path.endsWith('/operator-events')
    || /\/runs\/[^/]+\/(approve|recover|verify)$/.test(path)
    || /\/work-items\/[^/]+\/result-decision$/.test(path);
}

function responseFor(path: string, search: string, method: string): unknown {
  if (path === '/inbox') return { count: 1, results: [inboxEntry()] };
  if (path === '/work-items' && method === 'POST') return workItem('work-e2e-created', false);
  if (path === '/work-items') return { count: 2, results: [workItem('work-e2e-1', true), reviewWorkItem()] };
  if (path === '/work-items/work-e2e-created') return workItem('work-e2e-created', false);
  if (path === '/work-items/work-e2e-1') return workItem('work-e2e-1', true);
  if (path === '/work-items/work-e2e-review') return reviewWorkItem();
  if (path === '/work-items/work-e2e-review/result-decision') return reviewWorkItem();
  if (path === '/runs/run-work-e2e/inspect') return {
    nodes: [{ kind: 'run_spec', record: { runContract: { ...workItem('work-e2e-1', true).runContractDraft, phase: 'planning', plan: [{ id: 'step-1', title: 'Persist the structured contract' }] } } }],
  };
  if (path === '/sessions') return [sessionSummary()];
  if (path === '/sessions/session-main' || path === '/sessions/session-e2e') return sessionDetail(path.slice('/sessions/'.length));
  if (path.endsWith('/trace')) return { sessionId: path.split('/')[2], messageCount: 0, turnCount: 0, messages: [] };
  if (path.endsWith('/observability')) return observability(path.split('/')[2] ?? 'session-main');
  if (path.endsWith('/events')) return { sessionId: path.split('/')[2], count: 0, events: [] };
  if (path.endsWith('/verification')) return { count: 0, records: [] };
  if (path === '/runs') return [runSpec()];
  if (path === '/runs/run-e2e-0001/state') return { phase: 'awaiting_approval', action: 'approve_plan', taskCount: 1, verificationCount: 0, verifierStatus: 'pending', approvalStatus: 'required', blockers: [] };
  if (path.startsWith('/runs/') || path.startsWith('/tasks/')) return { ok: true };
  if (path === '/onboarding') return { providers: [{ name: 'mock', provider: 'mock', defaultModel: 'mock-1', readiness: { ready: true } }] };
  if (path === '/providers/models') return { provider: null, count: 1, providers: [{ provider: 'mock', ok: true, model: 'mock-1', models: [{ id: 'mock-1' }] }] };
  if (path === '/providers/accounts') return { accounts: [] };
  if (path === '/providers/accounts/discovery') return { grok: { available: false } };
  if (path === '/workspace') return { workspaceRoot: '/workspace/los', cwd: '/workspace/los' };
  if (path === '/projects') return { projects: [] };
  if (path === '/services') return [{ serviceId: 'gateway-e2e', readiness: { ready: true } }];
  if (path === '/nodes') return [];
  if (path === '/communication/accounts') return { channels: [{ id: 'web', status: 'live', live: true, accountCount: 0 }], weixin: { accounts: [], weclawInstalled: false } };
  if (path === '/memory/stats') return { totalObservations: 0 };
  if (path === '/skills' || path === '/rules' || path === '/todos') return [];
  if (method === 'POST') return { ok: true };
  return search ? [] : {};
}

function sessionSummary() {
  return { id: 'session-main', createdAt: NOW, updatedAt: NOW, metadata: { provider: 'mock', model: 'mock-1', toolMode: 'project-write', workspaceRoot: '/workspace/los' } };
}

function sessionDetail(id: string) {
  return { ...sessionSummary(), id, messages: [], turns: [] };
}

function observability(sessionId: string) {
  return {
    sessionId, eventCount: 0, turnCount: 0, firstEventAt: null, lastEventAt: null,
    totalUsage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 },
    cache: { status: 'empty', hitRate: 0, keys: [] }, tools: { status: 'idle', count: 0, names: [] }, models: { status: 'idle', count: 0, names: [] },
  };
}

function runSpec() {
  return { id: 'run-e2e-0001', sessionId: 'session-main', status: 'pending', prompt: 'bounded operator action', provider: 'mock', model: 'mock-1', createdAt: NOW, updatedAt: NOW };
}

function inboxEntry() {
  return {
    id: 'work-item-work-e2e-1', sourceKind: 'work_item', workItemId: 'work-e2e-1',
    title: 'Review the structured plan', projectId: 'los', sessionId: 'session-main',
    runSpecId: 'run-work-e2e', attentionState: 'approval_required', nextAction: 'review_plan', updatedAt: NOW,
  };
}

function workItem(id: string, withRun: boolean) {
  const goal = withRun ? 'Inspect the Web-first plan' : 'Create a bounded daily workflow task';
  return {
    id, title: goal, description: goal, goal, tenantId: 'local', projectId: 'los', status: 'backlog',
    priority: 'P2', source: 'web-work-item', attentionState: withRun ? 'approval_required' : 'none',
    nextAction: withRun ? 'review_plan' : 'start', links: [], createdAt: NOW, updatedAt: NOW,
    runContractDraft: {
      mode: 'execution', phase: 'created', goal, editableSurfaces: ['packages/web/src/pages'],
      requiredChecks: ['pnpm --filter @los/web test'], allowedSkippedChecks: [], stopConditions: ['scope expands'],
      evidenceRequired: ['focused test output'], externalEvidenceAllowed: [], rawEvidenceProhibited: [], toolMode: 'read-only',
    },
    evidence: {
      latestRunSpecId: withRun ? 'run-work-e2e' : undefined, latestSessionId: withRun ? 'session-main' : undefined,
      runSpecStatus: withRun ? 'created' : undefined, verificationRequired: 1, verificationSucceeded: 0,
      verificationSkipped: 0, verificationFailed: 0, verificationPending: 1,
    },
    verificationRecords: [],
    changes: { hasReviewableDiff: false, workspaces: [] },
  };
}

function reviewWorkItem() {
  const item = workItem('work-e2e-review', true);
  return {
    ...item,
    title: 'Review completed Web changes',
    goal: 'Review completed Web changes',
    status: 'in_progress',
    attentionState: 'review_ready',
    nextAction: 'review_changes',
    evidence: {
      ...item.evidence,
      runSpecStatus: 'succeeded',
      verificationSucceeded: 1,
      verificationPending: 0,
    },
    verificationRecords: [{
      id: 'verification-web-e2e', checkName: 'web focused tests', kind: 'command', status: 'succeeded', required: true,
      command: 'pnpm --filter @los/web test', outputSummary: '14 tests passed', updatedAt: NOW, completedAt: NOW,
    }],
    changes: {
      hasReviewableDiff: true,
      workspaces: [{
        workspaceId: 'workspace-web-e2e', status: 'backup_ready', baseRevision: '91df23c4',
        backupArtifactId: 'artifact-diff-web-e2e', updatedAt: NOW,
      }],
    },
  };
}

async function json(route: Parameters<Page['route']>[1] extends (route: infer R) => unknown ? R : never, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function assertViewportIsOperable(page: Page, controls: ReturnType<Page['locator']>[]) {
  const viewport = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(viewport.scroll).toBeLessThanOrEqual(viewport.client + 1);
  for (const control of controls) {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);
  }
}

async function assertNoOverlap(a: ReturnType<Page['locator']>, b: ReturnType<Page['locator']>) {
  const [one, two] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  expect(one).not.toBeNull();
  expect(two).not.toBeNull();
  const overlap = Math.min(one!.x + one!.width, two!.x + two!.width) > Math.max(one!.x, two!.x)
    && Math.min(one!.y + one!.height, two!.y + two!.height) > Math.max(one!.y, two!.y);
  expect(overlap).toBe(false);
}
