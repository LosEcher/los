import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClientPath } from './client-path.js';

test('resolveClientPath uses the caller cwd by default', () => {
  const original = process.env.LOS_CLIENT_CWD;
  const cwd = process.cwd();
  delete process.env.LOS_CLIENT_CWD;
  process.chdir('/tmp');

  try {
    assert.equal(resolveClientPath('workspace'), `${process.cwd()}/workspace`);
  } finally {
    process.chdir(cwd);
    if (original === undefined) {
      delete process.env.LOS_CLIENT_CWD;
    } else {
      process.env.LOS_CLIENT_CWD = original;
    }
  }
});

test('resolveClientPath honors LOS_CLIENT_CWD', () => {
  const original = process.env.LOS_CLIENT_CWD;
  process.env.LOS_CLIENT_CWD = '/var/tmp/los-client';

  try {
    assert.equal(resolveClientPath('.'), '/var/tmp/los-client');
    assert.equal(resolveClientPath('nested/file.md'), '/var/tmp/los-client/nested/file.md');
  } finally {
    if (original === undefined) {
      delete process.env.LOS_CLIENT_CWD;
    } else {
      process.env.LOS_CLIENT_CWD = original;
    }
  }
});
