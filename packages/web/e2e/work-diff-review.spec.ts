import { expect, test, type Page } from '@playwright/test';

const AUTH_TOKEN = 'work-diff-auth';
const OPERATOR_TOKEN = 'work-diff-operator';
const NOW = '2026-07-26T16:00:00.000Z';

const BIG_FILE_LINES = Array.from({ length: 70 }, (_, i) => ` unchanged line ${i}`);

const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,3 @@',
  ' keep this line',
  '-old-a',
  '-old-b',
  '+new-a',
  '+new-b',
  '+new-c',
  ' tail',
  'diff --git a/src/big.ts b/src/big.ts',
  '--- a/src/big.ts',
  '+++ b/src/big.ts',
  '@@ -1,70 +1,70 @@',
  ...BIG_FILE_LINES,
].join('\n');

test('Work diff review renders line-level unified view and side-by-side switch', async ({ page }) => {
  await seedTokens(page);
  await mockGateway(page);
  await page.goto('/#work/work-diff-e2e');

  await expect(page.getByRole('heading', { name: 'Diff review item' })).toBeVisible();
  await page.getByRole('button', { name: 'View diff' }).click();

  // unified view: file header, line numbers, colored rows
  await expect(page.getByText('src/a.ts', { exact: true })).toBeVisible();
  await page.getByText('src/a.ts', { exact: true }).click(); // expand file details
  await expect(page.getByText('keep this line', { exact: true })).toBeVisible();
  await expect(page.getByText('new-c', { exact: true })).toBeVisible();
  const aFile = page.locator('.diff-file').filter({ hasText: 'src/a.ts' });
  expect(await aFile.locator('.diff-line-row.diff-add').count()).toBe(3);
  expect(await aFile.locator('.diff-line-row.diff-del').count()).toBe(2);
  expect(await aFile.locator('.diff-line-num').count()).toBeGreaterThan(10);

  // side-by-side: replacement block aligned on the same row
  await page.getByRole('button', { name: 'Side-by-side' }).click();
  await expect(aFile.locator('.diff-side-row')).toHaveCount(9);
  const paired = aFile.locator('.diff-side-row').nth(5);
  await expect(paired.locator('.diff-del .diff-line-text')).toHaveText('old-a');
  await expect(paired.locator('.diff-add .diff-line-text')).toHaveText('new-a');
  const third = aFile.locator('.diff-side-row').nth(6);
  await expect(third.locator('.diff-del .diff-line-text')).toHaveText('old-b');
  await expect(third.locator('.diff-add .diff-line-text')).toHaveText('new-b');

  // switch back to unified keeps rendering
  await page.getByRole('button', { name: 'Unified' }).click();
  await expect(aFile.locator('.diff-line-row')).toHaveCount(11);
});

test('Work diff review collapses large files and expands on demand', async ({ page }) => {
  await seedTokens(page);
  await mockGateway(page);
  await page.goto('/#work/work-diff-e2e');

  await page.getByRole('button', { name: 'View diff' }).click();
  await page.getByText('src/big.ts', { exact: true }).click();

  const moreButton = page.getByRole('button', { name: /more lines/ });
  await expect(moreButton).toBeVisible();
  await expect(page.getByText('unchanged line 69', { exact: true })).not.toBeVisible();

  await moreButton.click();
  await expect(page.getByText('unchanged line 69', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /more lines/ })).toHaveCount(0);
});

async function mockGateway(page: Page) {
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) {
      await route.continue();
      return;
    }
    if (request.headers()['x-los-auth-token'] !== AUTH_TOKEN) return json(route, { error: 'unauthorized' }, 401);
    if (url.pathname === '/work-items') return json(route, { count: 1, results: [reviewItem()] });
    if (url.pathname === '/work-items/work-diff-e2e') return json(route, reviewItem());
    if (url.pathname === '/runs/run-diff/inspect') return json(route, { nodes: [] });
    if (url.pathname === '/managed-workspaces/ws-1/diff') return json(route, { diff: SAMPLE_DIFF });
    return json(route, {});
  });
}

function reviewItem() {
  return {
    id: 'work-diff-e2e', title: 'Diff review item', description: 'Diff review item', goal: 'Diff review item',
    tenantId: 'local', projectId: 'los', status: 'in_progress', priority: 'P0', source: 'web-work-item',
    attentionState: 'review_ready', nextAction: 'review_result',
    links: [], verificationRecords: [],
    changes: {
      hasReviewableDiff: true,
      workspaces: [{ workspaceId: 'ws-1', status: 'dirty', baseRevision: 'base-abc', backupArtifactId: 'artifact-1' }],
    },
    runContractDraft: {
      mode: 'execution', phase: 'verification_succeeded', goal: 'Diff review item',
      editableSurfaces: ['src'], requiredChecks: [], allowedSkippedChecks: [],
      stopConditions: [], evidenceRequired: [], externalEvidenceAllowed: [], rawEvidenceProhibited: [],
      toolMode: 'project-write', planRevision: 1,
    },
    evidence: {
      latestRunSpecId: 'run-diff', latestSessionId: 'session-diff', runSpecStatus: 'succeeded', taskRunStatus: 'succeeded',
      verificationRequired: 0, verificationSucceeded: 0, verificationSkipped: 0,
      verificationFailed: 0, verificationPending: 0,
    },
    availableActions: {
      reviewResult: { label: 'Accept result', effect: 'Review decision', scope: 'e2e', irreversible: false, payload: {} },
    },
    createdAt: NOW, updatedAt: NOW,
  };
}

async function seedTokens(page: Page) {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
}

function isAsset(path: string): boolean {
  return path === '/' || path === '/src/main.tsx' || path.startsWith('/src/') || path.startsWith('/node_modules/') || path.startsWith('/@') || path.endsWith('.css');
}

async function json(
  route: Parameters<Page['route']>[1] extends (route: infer Route) => unknown ? Route : never,
  body: unknown,
  status = 200,
) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
