import { expect, test, type Page } from '@playwright/test';

const AUTH_TOKEN = 'e2e-auth-token';
const OPERATOR_TOKEN = 'e2e-operator-token';

async function seedTokens(page: Page) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
}

async function mockMinimalGateway(page: Page) {
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
    if (url.pathname === '/sessions') {
      await json(route, []);
      return;
    }
    if (url.pathname === '/inbox') {
      await json(route, { results: [], count: 0 });
      return;
    }
    if (url.pathname === '/work-items' || url.pathname.startsWith('/work-items/')) {
      await json(route, { results: [], count: 0 });
      return;
    }
    if (url.pathname === '/scheduled-work-items' || url.pathname.startsWith('/scheduled-work-items')) {
      await json(route, { results: [], count: 0 });
      return;
    }
    if (url.pathname === '/skills' || url.pathname === '/rules') {
      await json(route, []);
      return;
    }
    if (url.pathname === '/memory/stats') {
      await json(route, { totalObservations: 0 });
      return;
    }
    if (url.pathname === '/governance/jobs') {
      await json(route, { count: 0, attentionCount: 0, jobs: [] });
      return;
    }
    // Prefer empty list shapes over `{}` so pages that read `.results` do not throw.
    await json(route, { results: [], count: 0 });
  });
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

test.describe('mobile daily shell', () => {
  test('shows bottom daily tabs and parks schedules under More', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'phone shell only');
    await seedTokens(page);
    await mockMinimalGateway(page);
    await page.goto('/#inbox');

    const tabs = page.getByRole('navigation', { name: /daily tabs|日常标签/i });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('button', { name: /inbox|收件箱/i })).toBeVisible();
    await expect(tabs.getByRole('button', { name: /work|工作台/i })).toBeVisible();
    await expect(tabs.getByRole('button', { name: /chat|对话/i })).toBeVisible();
    await expect(tabs.getByRole('button', { name: /more|更多/i })).toBeVisible();

    // Desktop horizontal sidebar nav is gone on phone.
    await expect(page.locator('.desktop-sidebar')).toBeHidden();

    await tabs.getByRole('button', { name: /work|工作台/i }).click();
    await expect(page).toHaveURL(/#work$/);

    await tabs.getByRole('button', { name: /more|更多/i }).click();
    const sheet = page.getByRole('dialog', { name: /more pages|更多页面/i });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: /schedules|定时任务/i }).click();
    await expect(page).toHaveURL(/#schedules$/);
    await expect(sheet).toBeHidden();

    // More tab stays active while on a non-daily page.
    await expect(tabs.getByRole('button', { name: /more|更多/i })).toHaveAttribute('data-active', 'true');
  });
});
