import { expect, test, type Page } from '@playwright/test';

const AUTH_TOKEN = 'e2e-auth-token';
const OPERATOR_TOKEN = 'e2e-operator-token';
const NOW = '2026-07-21T08:00:00.000Z';

test('language switcher toggles the shell between EN and 中文 and persists', async ({ page }) => {
  await seedTokens(page);
  await mockGateway(page);
  await page.goto('/#inbox');

  // Fresh storage → English default (browser locale en-US in CI)
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Switch to Chinese
  await page.getByRole('button', { name: '中文' }).click();
  await expect(page.getByRole('heading', { name: '收件箱' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.nav-item', { hasText: '工作台' })).toBeVisible();
  await expect(page.locator('.nav-item', { hasText: '对话' })).toBeVisible();
  // tt()-driven content (module-level translation) must flip in the same render
  await expect(page.getByText('42秒')).toBeVisible();

  // Choice persists across reload
  await page.reload();
  await expect(page.getByRole('heading', { name: '收件箱' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  // Switch back to English
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

async function seedTokens(page: Page) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
}

async function mockGateway(page: Page) {
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseFor(url.pathname)) });
  });
}

function responseFor(path: string): unknown {
  if (path === '/settings') return { auth: { enabled: true }, agent: { maxLoops: 20 } };
  if (path === '/health') return { status: 'ok', uptime: 42 };
  if (path === '/onboarding') return { providers: [{ name: 'mock', provider: 'mock', defaultModel: 'mock-1', readiness: { ready: true } }] };
  if (path === '/projects') return { projects: [] };
  if (path === '/sessions') return [];
  if (path === '/memory/stats') return { totalObservations: 0 };
  if (path === '/skills' || path === '/rules' || path === '/todos') return [];
  if (path === '/nodes') return [];
  if (path === '/services') return [{ serviceId: 'gateway-e2e', readiness: { ready: true } }];
  if (path === '/communication/accounts') return { channels: [{ id: 'web', status: 'live', live: true, accountCount: 0 }] };
  if (path === '/inbox') return { count: 0, results: [] };
  if (path === '/work-items') return { count: 0, results: [] };
  return { createdAt: NOW, updatedAt: NOW };
}

function isAsset(path: string): boolean {
  return path === '/' || path === '/src/main.tsx' || path.startsWith('/src/') || path.startsWith('/node_modules/') || path.startsWith('/@') || path.endsWith('.css');
}
