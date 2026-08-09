import { expect, test, type Page } from '@playwright/test';

const AUTH_TOKEN = 'e2e-auth-token';
const OPERATOR_TOKEN = 'e2e-operator-token';
const NOW = '2026-07-18T08:00:00.000Z';

async function seedTokens(page: Page) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
}

function isAsset(pathname: string): boolean {
  return pathname === '/'
    || pathname === '/index.html'
    || pathname === '/src/main.tsx'
    || pathname.startsWith('/src/')
    || pathname.startsWith('/@')
    || pathname.startsWith('/node_modules/')
    || pathname.endsWith('.css')
    || pathname.endsWith('.js')
    || pathname.endsWith('.mjs')
    || pathname.endsWith('.ts')
    || pathname.endsWith('.tsx')
    || pathname.endsWith('.svg')
    || pathname.endsWith('.webmanifest');
}

async function json(route: Parameters<Parameters<Page['route']>[1]>[0], body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function workItem(id: string) {
  return {
    id,
    title: `Goal for ${id}`,
    description: `Goal for ${id}`,
    goal: `Goal for ${id}`,
    tenantId: 'local',
    projectId: 'los',
    status: 'backlog',
    priority: 'P2',
    source: 'web-work-item',
    attentionState: 'approval_required',
    nextAction: 'review_plan',
    links: [],
    createdAt: NOW,
    updatedAt: NOW,
    availableActions: {
      approvePlan: {
        key: 'approvePlan',
        label: 'Approve plan',
        effect: 'approve',
        enabled: true,
        payload: { runSpecId: 'run-1', planRevision: 1, contractHash: 'sha256:x' },
      },
    },
    runContractDraft: {
      mode: 'execution',
      phase: 'created',
      goal: `Goal for ${id}`,
      editableSurfaces: [],
      requiredChecks: [],
      allowedSkippedChecks: [],
      stopConditions: [],
      evidenceRequired: [],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
      toolMode: 'read-only',
    },
    evidence: {
      latestRunSpecId: 'run-1',
      verificationRequired: 1,
      verificationSucceeded: 0,
      verificationSkipped: 0,
      verificationFailed: 0,
      verificationPending: 1,
    },
    verificationRecords: [],
    changes: { hasReviewableDiff: false, workspaces: [] },
  };
}

async function mockGateway(page: Page) {
  await page.routeWebSocket('**/sessions/*/stream', socket => socket.close());
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) {
      await route.continue();
      return;
    }
    if (url.pathname === '/settings') {
      await json(route, { auth: { enabled: true }, agent: { maxLoops: 20 } });
      return;
    }
    if (url.pathname === '/health') {
      await json(route, { status: 'ok', uptime: 42 });
      return;
    }
    if (url.pathname === '/onboarding') {
      await json(route, { summary: { readyProviders: 1, totalProviders: 1 } });
      return;
    }
    if (url.pathname === '/sessions' || url.pathname === '/skills' || url.pathname === '/rules') {
      await json(route, []);
      return;
    }
    if (url.pathname === '/memory/stats') {
      await json(route, { totalObservations: 0 });
      return;
    }
    if (url.pathname === '/inbox') {
      await json(route, {
        count: 1,
        results: [{
          id: 'inbox-1',
          workItemId: 'work-deep',
          attentionState: 'approval_required',
          title: 'Needs plan approval',
          updatedAt: NOW,
        }],
      });
      return;
    }
    if (url.pathname === '/work-items' || url.pathname.startsWith('/work-items?')) {
      await json(route, { count: 1, results: [workItem('work-deep')] });
      return;
    }
    if (url.pathname === '/work-items/work-deep') {
      await json(route, workItem('work-deep'));
      return;
    }
    if (url.pathname.startsWith('/runs/')) {
      await json(route, { nodes: [] });
      return;
    }
    if (url.pathname === '/governance/jobs') {
      await json(route, { count: 0, attentionCount: 0, jobs: [] });
      return;
    }
    await json(route, { results: [], count: 0 });
  });
}

test.describe('mobile P1 shell', () => {
  test('deep-links work detail and shows inbox badge', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone shell only');
    await seedTokens(page);
    await mockGateway(page);
    await page.goto('/#work/work-deep');

    await expect(page).toHaveURL(/#work\/work-deep/);
    await expect(page.getByRole('heading', { level: 2, name: /Goal for work-deep/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /back|返回/i })).toBeVisible();
    await expect(page.locator('.work-page')).toHaveAttribute('data-mobile-pane', 'detail');

    await page.getByRole('button', { name: /back|返回/i }).click();
    await expect(page.locator('.work-page')).toHaveAttribute('data-mobile-pane', 'list');
    await expect(page.locator('.mobile-tab-bar .mobile-tab-badge')).toHaveText('1');
  });
});
