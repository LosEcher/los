import { expect, test, type Page, type Request } from '@playwright/test';

const AUTH_TOKEN = 'e2e-auth-token';
const OPERATOR_TOKEN = 'e2e-operator-token';
const NOW = '2026-07-21T08:00:00.000Z';

type RequestRecord = {
  path: string;
  method: string;
  body?: Record<string, unknown>;
};

test('project-write Chat creates one Work Item before streaming and reuses it', async ({ page }) => {
  await seedTokens(page);
  const records = await mockGateway(page);
  await page.goto('/#chat');

  const prompt = page.getByPlaceholder('Ask los to inspect or prepare a bounded change... (/ for commands)');
  await prompt.fill('Add a bounded Web-first regression test');
  const firstResponse = page.waitForResponse(isCompletedChatResponse);
  await page.getByRole('button', { name: 'send' }).click();
  await (await firstResponse).finished();
  await expect(prompt).toBeEnabled();

  const firstCreateIndex = records.findIndex(record => record.path === '/work-items' && record.method === 'POST');
  const firstChatIndex = records.findIndex(record => record.path === '/chat' && record.method === 'POST');
  expect(firstCreateIndex).toBeGreaterThanOrEqual(0);
  expect(firstChatIndex).toBeGreaterThan(firstCreateIndex);

  const create = records[firstCreateIndex]!;
  expect(create.body).toMatchObject({
    projectId: 'los',
    goal: 'Add a bounded Web-first regression test',
    mode: 'execution',
    toolMode: 'project-write',
  });
  const firstChat = records[firstChatIndex]!;
  expect(firstChat.body).toMatchObject({
    prompt: 'Add a bounded Web-first regression test',
    toolMode: 'project-write',
    todoId: 'work-chat-e2e',
    runContract: { mode: 'execution', phase: 'created', toolMode: 'project-write' },
  });

  await prompt.fill('Continue on the same bounded goal');
  const secondResponse = page.waitForResponse(isCompletedChatResponse);
  await page.getByRole('button', { name: 'send' }).click();
  await (await secondResponse).finished();
  await expect.poll(() => records.filter(record => record.path === '/chat' && record.method === 'POST').length).toBe(2);
  await expect(prompt).toBeEnabled();
  expect(records.filter(record => record.path === '/work-items' && record.method === 'POST')).toHaveLength(1);
  const secondChat = records.filter(record => record.path === '/chat' && record.method === 'POST')[1]!;
  expect(secondChat.body?.todoId).toBe('work-chat-e2e');

  await page.getByRole('button', { name: 'new chat' }).click();
  await page.getByRole('button', { name: 'confirm new?' }).click();
  await page.getByLabel('tools / skills').selectOption('read-only');
  await prompt.fill('Explain the current architecture without changing files');
  const readOnlyResponse = page.waitForResponse(isCompletedChatResponse);
  await page.getByRole('button', { name: 'send' }).click();
  await (await readOnlyResponse).finished();
  await expect.poll(() => records.filter(record => record.path === '/chat' && record.method === 'POST').length).toBe(3);
  expect(records.filter(record => record.path === '/work-items' && record.method === 'POST')).toHaveLength(1);
  const readOnlyChat = records.filter(record => record.path === '/chat' && record.method === 'POST')[2]!;
  expect(readOnlyChat.body).toMatchObject({
    prompt: 'Explain the current architecture without changing files',
    toolMode: 'read-only',
  });
  expect(readOnlyChat.body?.todoId).toBeUndefined();
  expect(readOnlyChat.body?.runContract).toBeUndefined();
});

async function seedTokens(page: Page) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
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
    if (url.pathname === '/chat' && request.method() === 'POST') {
      await route.continue({ url: 'http://127.0.0.1:4180/chat' });
      return;
    }
    if (url.pathname === '/work-items' && request.method() === 'POST') {
      await json(route, workItem(record.body));
      return;
    }
    await json(route, responseFor(url.pathname));
  });
  return records;
}

function requestRecord(request: Request, url: URL): RequestRecord {
  let body: Record<string, unknown> | undefined;
  try { body = request.postDataJSON() as Record<string, unknown>; } catch { /* no JSON body */ }
  return { path: url.pathname, method: request.method(), body };
}

function responseFor(path: string): unknown {
  if (path === '/settings') return { auth: { enabled: true }, agent: { maxLoops: 20 } };
  if (path === '/health') return { status: 'ok', uptime: 42 };
  if (path === '/providers/models') return { provider: null, count: 1, providers: [{ provider: 'mock', ok: true, model: 'mock-1', models: [{ id: 'mock-1' }] }] };
  if (path === '/providers/accounts') return { accounts: [] };
  if (path === '/providers/accounts/discovery') return { grok: { available: false } };
  if (path === '/workspace') return { workspaceRoot: '/workspace/los', cwd: '/workspace/los' };
  if (path === '/projects') return { projects: [] };
  if (path === '/sessions') return [];
  if (path === '/sessions/session-e2e') return { id: 'session-e2e', createdAt: NOW, updatedAt: NOW, messages: [], turns: [], metadata: { toolMode: 'project-write' } };
  if (path === '/sessions/session-e2e/trace') return { sessionId: 'session-e2e', messageCount: 0, turnCount: 0, messages: [] };
  if (path === '/sessions/session-e2e/observability') return {
    sessionId: 'session-e2e', eventCount: 0, turnCount: 0, firstEventAt: null, lastEventAt: null,
    totalUsage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 },
    cache: { status: 'empty', hitRate: 0, keys: [] }, tools: { status: 'idle', count: 0, names: [] }, models: { status: 'idle', count: 0, names: [] },
  };
  if (path === '/sessions/session-e2e/events') return { sessionId: 'session-e2e', count: 0, events: [] };
  if (path === '/onboarding') return { providers: [{ name: 'mock', provider: 'mock', defaultModel: 'mock-1', readiness: { ready: true } }] };
  if (path === '/services') return [{ serviceId: 'gateway-e2e', readiness: { ready: true } }];
  if (path === '/nodes') return [];
  if (path === '/communication/accounts') return { channels: [{ id: 'web', status: 'live', live: true, accountCount: 0 }] };
  if (path === '/memory/stats') return { totalObservations: 0 };
  if (path === '/skills' || path === '/rules' || path === '/todos') return [];
  return {};
}

function workItem(input: Record<string, unknown> | undefined) {
  const goal = String(input?.goal ?? 'Web coding task');
  return {
    id: 'work-chat-e2e', title: goal, description: goal, goal, tenantId: 'local', projectId: 'los',
    status: 'backlog', priority: 'P2', source: 'web-work-item', attentionState: 'none', nextAction: 'start',
    links: [], createdAt: NOW, updatedAt: NOW, verificationRecords: [], changes: { hasReviewableDiff: false, workspaces: [] },
    runContractDraft: {
      mode: 'execution', phase: 'created', goal, editableSurfaces: input?.editableSurfaces ?? [], nonGoals: [],
      requiredChecks: [], allowedSkippedChecks: [], stopConditions: [], evidenceRequired: [],
      externalEvidenceAllowed: [], rawEvidenceProhibited: [], toolMode: 'project-write',
    },
    evidence: {
      verificationRequired: 0, verificationSucceeded: 0, verificationSkipped: 0,
      verificationFailed: 0, verificationPending: 0,
    },
  };
}

function isAsset(path: string): boolean {
  return path === '/' || path === '/src/main.tsx' || path.startsWith('/src/') || path.startsWith('/node_modules/') || path.startsWith('/@') || path.endsWith('.css');
}

function isCompletedChatResponse(response: { url(): string; request(): Request; status(): number }): boolean {
  return new URL(response.url()).pathname === '/chat'
    && response.request().method() === 'POST'
    && response.status() === 200;
}

async function json(route: Parameters<Page['route']>[1] extends (route: infer R) => unknown ? R : never, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}
