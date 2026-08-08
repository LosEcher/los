import { expect, test, type Route } from '@playwright/test';

test('pairwise page loads filters, detail inspector, channels, and operator-gated recording', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('los-auth-token', 'e2e-auth-token');
    localStorage.setItem('los-operator-token', 'wrong-operator-token');
  });
  const requests: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || url.pathname.startsWith('/src/') || url.pathname.startsWith('/node_modules/') || url.pathname.startsWith('/@') || url.pathname.endsWith('.css') || url.pathname === '/') {
      await route.continue(); return;
    }
    requests.push({ path: url.pathname, method: request.method(), headers: request.headers() });
    if (url.pathname === '/settings') return json(route, { auth: { enabled: true } });
    if (url.pathname === '/health') return json(route, { status: 'ok', uptime: 8 });
    if (url.pathname === '/sessions') return json(route, []);
    if (url.pathname === '/memory/stats' || url.pathname === '/skills' || url.pathname === '/rules') return json(route, []);
    if (url.pathname === '/run-evals/pairwise' && request.method() === 'GET') return json(route, {
      count: 1,
      evals: [{
        id: 'pair-eval-1',
        pairId: 'pair-1',
        experimentId: 'exp-1',
        baselineRunSpecId: 'run-base',
        candidateRunSpecId: 'run-candidate',
        sessionId: 'session-pair-1',
        rubricRevision: 'r1',
        rubricSnapshot: {
          id: 'default',
          revision: 'r1',
          criteria: [{ id: 'overall', label: 'Overall', maxScore: 5 }],
        },
        pairwiseVerdict: 'candidate',
        human: { source: 'operator:test', verdict: 'candidate', criterionScores: [{ criterionId: 'overall', score: 4 }] },
        judge: { source: 'judge:v1', verdict: 'candidate' },
        deterministic: { source: 'verification-records', verificationStatus: 'succeeded', verdict: 'baseline' },
        provider: 'openai',
        model: 'gpt-test',
        summary: { scenarioId: 'planning' },
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    });
    if (url.pathname === '/run-evals/pairwise' && request.method() === 'POST') return json(route, { error: 'forbidden' }, 403);
    if (url.pathname === '/runs' || url.pathname.startsWith('/runs/')) return json(route, []);
    return json(route, []);
  });

  await page.goto('/#pairwise');
  await expect(page.getByRole('heading', { name: 'Pairwise' })).toBeVisible();
  const detail = page.getByLabel('Pairwise evaluation detail');
  await expect(detail.getByText('pair-1')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Pair detail' })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Evidence channels' })).toBeVisible();
  await expect(detail.getByText('Channel verdicts disagree', { exact: false })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Open run' }).first()).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Open session' })).toBeVisible();
  await expect(detail.getByText('succeeded').first()).toBeVisible();
  await expect(detail.getByText('overall').first()).toBeVisible();
  await page.getByPlaceholder('Experiment ID...').fill('exp-1');
  await expect.poll(() => requests.some(request => request.path === '/run-evals/pairwise' && request.method === 'GET')).toBe(true);
  await page.getByRole('button', { name: 'Record pair' }).click();
  await page.getByLabel('experimentId').fill('exp-1');
  await page.getByLabel('baselineRunSpecId').fill('run-base');
  await page.getByLabel('candidateRunSpecId').fill('run-candidate');
  await page.getByRole('button', { name: 'Submit evidence' }).click();
  await expect(page.getByText(/Operator authentication required/)).toBeVisible();
});

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
