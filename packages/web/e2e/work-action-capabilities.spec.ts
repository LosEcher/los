import { expect, test, type Page } from '@playwright/test';

const AUTH_TOKEN = 'work-capability-auth';
const OPERATOR_TOKEN = 'work-capability-operator';
const NOW = '2026-07-26T16:00:00.000Z';

test('Work reloads revised approval capabilities and hides unavailable actions', async ({ page }) => {
  await seedTokens(page);
  let planRevision = 1;
  let approved = false;
  const approvalBodies: Array<Record<string, unknown>> = [];

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) {
      await route.continue();
      return;
    }
    if (url.pathname === '/settings') return json(route, { auth: { enabled: true }, agent: {} });
    if (url.pathname === '/health') return json(route, { status: 'ok' });
    if (request.headers()['x-los-auth-token'] !== AUTH_TOKEN) return json(route, { error: 'unauthorized' }, 401);
    if (url.pathname === '/work-items') {
      return json(route, { count: 2, results: [approvalItem(planRevision, approved), failedItem()] });
    }
    if (url.pathname === '/work-items/work-capability') return json(route, approvalItem(planRevision, approved));
    if (url.pathname === '/work-items/work-failed') return json(route, failedItem());
    if (url.pathname === '/runs/run-capability/inspect') {
      return json(route, { nodes: [{ kind: 'run_spec', record: { runContract: approvalContract(planRevision, approved) } }] });
    }
    if (url.pathname === '/runs/run-failed/inspect') {
      return json(route, { nodes: [{ kind: 'run_spec', record: { runContract: failedItem().runContractDraft } }] });
    }
    if (url.pathname === '/runs/run-capability/approve' && request.method() === 'POST') {
      if (request.headers()['x-los-operator-token'] !== OPERATOR_TOKEN) return json(route, { error: 'forbidden' }, 403);
      const body = request.postDataJSON() as Record<string, unknown>;
      approvalBodies.push(body);
      if (approvalBodies.length === 1) {
        planRevision = 2;
        return json(route, {
          error: 'approval_capability_stale',
          message: 'The plan changed after this approval action was issued. Reload Work and review the current revision.',
        }, 409);
      }
      approved = true;
      return json(route, { runSpecId: 'run-capability', phase: 'plan_approved' });
    }
    return json(route, {});
  });

  await page.goto('/#work');
  await expect(page.getByRole('heading', { name: 'Capability approval item' })).toBeVisible();
  await page.getByLabel('Approval reason').fill('reviewed revision one');
  await page.getByRole('button', { name: 'Approve plan' }).click();

  await expect(page.getByText('409 Conflict')).toBeVisible();
  await expect(page.getByText('revision 2', { exact: true })).toBeVisible();
  expect(approvalBodies[0]).toMatchObject({
    runSpecId: 'run-capability',
    planRevision: 1,
    contractHash: 'sha256:work-capability-1',
  });

  await page.getByLabel('Approval reason').fill('reviewed revision two');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect.poll(() => approvalBodies.length).toBe(2);
  expect(approvalBodies[1]).toMatchObject({
    runSpecId: 'run-capability',
    planRevision: 2,
    contractHash: 'sha256:work-capability-2',
  });
  await expect(page.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Capability approval item' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);

  await page.getByRole('button', { name: /Failed planning item/ }).click();
  await expect(page.getByRole('heading', { name: 'Failed planning item' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
  await expect(page.getByLabel('Approval reason')).toHaveCount(0);
});

function approvalItem(revision: number, approved: boolean) {
  const contract = approvalContract(revision, approved);
  return {
    ...baseItem('work-capability', 'Capability approval item'),
    attentionState: approved ? 'running' : 'approval_required',
    nextAction: approved ? 'inspect_run' : 'review_plan',
    runContractDraft: contract,
    availableActions: {
      ...(!approved ? {
        approvePlan: action('Approve plan & allow execution', {
          runSpecId: 'run-capability', planRevision: revision, contractHash: `sha256:work-capability-${revision}`,
        }),
      } : {}),
      inspectRun: action('Run evidence', { runSpecId: 'run-capability' }),
      continueSession: action('Continue', { sessionId: 'session-capability' }),
    },
    evidence: {
      latestRunSpecId: 'run-capability', latestSessionId: 'session-capability',
      runSpecStatus: approved ? 'running' : 'created', taskRunStatus: approved ? 'running' : 'blocked',
      verificationRequired: 1, verificationSucceeded: 0, verificationSkipped: 0,
      verificationFailed: 0, verificationPending: 1,
    },
  };
}

function failedItem() {
  return {
    ...baseItem('work-failed', 'Failed planning item'),
    attentionState: 'recovery_required',
    nextAction: 'review_plan',
    runContractDraft: { ...approvalContract(1, false), goal: 'Failed planning item' },
    availableActions: {
      inspectRun: action('Run evidence', { runSpecId: 'run-failed' }),
      continueSession: action('Continue', { sessionId: 'session-failed' }),
    },
    evidence: {
      latestRunSpecId: 'run-failed', latestSessionId: 'session-failed', runSpecStatus: 'failed', taskRunStatus: 'failed',
      verificationRequired: 1, verificationSucceeded: 0, verificationSkipped: 0,
      verificationFailed: 0, verificationPending: 1,
    },
  };
}

function approvalContract(revision: number, approved: boolean) {
  return {
    mode: 'execution', phase: approved ? 'executing' : 'planning', goal: 'Capability approval item',
    editableSurfaces: ['packages/web/src/pages'], requiredChecks: ['pnpm --filter @los/web test'],
    allowedSkippedChecks: [], stopConditions: [], evidenceRequired: [], externalEvidenceAllowed: [], rawEvidenceProhibited: [],
    toolMode: 'project-write', planRevision: revision,
    plan: [{ id: 'step-1', title: `Persist revision ${revision}`, description: 'Keep the approval bound to this revision.', dependsOnIds: [], editableSurfaces: ['packages/web/src/pages'], completionCriteria: 'The current revision is approved.' }],
  };
}

function baseItem(id: string, title: string) {
  return {
    id, title, description: title, goal: title, tenantId: 'local', projectId: 'los', status: 'in_progress',
    priority: 'P0', source: 'web-work-item', links: [], verificationRecords: [],
    changes: { hasReviewableDiff: false, workspaces: [] }, createdAt: NOW, updatedAt: NOW,
  };
}

function action<Payload>(label: string, payload: Payload) {
  return { label, effect: label, scope: 'e2e', irreversible: false, payload };
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
