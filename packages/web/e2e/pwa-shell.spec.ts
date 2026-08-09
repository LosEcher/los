import { expect, test } from '@playwright/test';

test('PWA shell exposes manifest, theme color, icon, and service worker', async ({ page, request }) => {
  await page.goto('/');

  // HTML wiring
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#b8910e');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml');

  // Manifest contract
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({
    name: 'los console',
    short_name: 'los',
    display: 'standalone',
    start_url: '/',
    scope: '/',
    theme_color: '#b8910e',
  });
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons[0]).toMatchObject({ src: '/icon.svg', type: 'image/svg+xml' });

  // Offline shell assets
  const sw = await request.get('/sw.js');
  expect(sw.ok()).toBe(true);
  expect(await sw.text()).toContain('los-console-v1');
  const icon = await request.get('/icon.svg');
  expect(icon.ok()).toBe(true);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
});

test('mobile viewport still renders the app shell', async ({ page }) => {
  await page.addInitScript(({ auth }) => {
    localStorage.setItem('los-auth-token', auth);
  }, { auth: 'pwa-e2e-auth' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  // Phone shell: daily bottom tabs + page title (desktop brand lives in the sidebar).
  await expect(page.getByRole('navigation', { name: /daily tabs|日常标签/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Inbox|收件箱/i })).toBeVisible();
  await expect(page.locator('.mobile-tab-bar .mobile-tab', { hasText: /Work|工作台/i })).toBeVisible();
});
