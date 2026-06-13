import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeStatusConstraintReport } from './governance-status-constraints.js';

test('summarizeStatusConstraintReport separates missing, dirty, and ready-to-validate constraints', () => {
  const summary = summarizeStatusConstraintReport({
    generatedAt: '2026-06-13T00:00:00.000Z',
    constraints: [
      {
        tableName: 'task_runs',
        constraintName: 'task_runs_status_chk',
        tableExists: true,
        constraintExists: true,
        validated: false,
        invalidRowCount: 0,
        legalStatuses: ['queued'],
        readyToValidate: true,
      },
      {
        tableName: 'run_specs',
        constraintName: 'run_specs_status_chk',
        tableExists: true,
        constraintExists: false,
        validated: false,
        invalidRowCount: 2,
        legalStatuses: ['created'],
        readyToValidate: false,
      },
      {
        tableName: 'missing_table',
        constraintName: 'missing_chk',
        tableExists: false,
        constraintExists: false,
        validated: false,
        invalidRowCount: 0,
        legalStatuses: [],
        readyToValidate: false,
      },
    ],
  });

  assert.deepEqual(summary, {
    missingTables: 1,
    missingConstraints: 1,
    unvalidatedConstraints: 1,
    invalidRows: 2,
    readyToValidate: 1,
  });
});
