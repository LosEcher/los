const NOW = '2026-07-18T08:00:00.000Z';

export function workItem(id: string, withRun: boolean) {
  const goal = withRun ? 'Inspect the Web-first plan' : 'Create a bounded daily workflow task';
  return {
    id, title: goal, description: goal, goal, tenantId: 'local', projectId: 'los', status: 'backlog',
    priority: 'P2', source: 'web-work-item', attentionState: withRun ? 'approval_required' : 'none',
    nextAction: withRun ? 'review_plan' : 'start', links: [], createdAt: NOW, updatedAt: NOW,
    availableActions: withRun ? {
      approvePlan: action('Approve plan & allow execution', { runSpecId: 'run-work-e2e', planRevision: 1, contractHash: 'sha256:work-e2e-revision-1' }),
      inspectRun: action('Run evidence', { runSpecId: 'run-work-e2e' }),
      continueSession: action('Continue', { sessionId: 'session-main' }),
    } : {
      startWork: action('Start in Chat', { workItemId: id }),
    },
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

export function reviewWorkItem() {
  const item = workItem('work-e2e-review', true);
  return {
    ...item,
    title: 'Review completed Web changes',
    goal: 'Review completed Web changes',
    status: 'in_progress',
    attentionState: 'review_ready',
    nextAction: 'review_changes',
    availableActions: {
      inspectRun: action('Run evidence', { runSpecId: 'run-work-e2e' }),
      continueSession: action('Continue', { sessionId: 'session-main' }),
      reviewResult: action('Review result', { workItemId: item.id, decisions: ['accepted', 'revision_requested'] }),
    },
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

function action<Payload>(label: string, payload: Payload) {
  return { label, effect: label, scope: 'e2e', irreversible: false, payload };
}
