import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema, printConfigDiagnostics } from './config.js';

test('provider source metadata survives config validation and diagnostics', () => {
  const config = ConfigSchema.parse({
    server: {},
    agent: {},
    memory: {},
    executor: {},
    providers: {
      deepseek: {
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        enabled: true,
        source: 'env:DEEPSEEK_API_KEY',
      },
      anthropic: {
        enabled: false,
        source: 'claude/.claude.json',
      },
    },
  });

  assert.equal(config.providers.deepseek.source, 'env:DEEPSEEK_API_KEY');
  assert.equal(config.providers.anthropic.source, 'claude/.claude.json');

  const diagnostics = printConfigDiagnostics(config);
  assert.match(diagnostics, /deepseek\s+model=deepseek-v4-flash\s+key=yes ready=yes source=env:DEEPSEEK_API_KEY\s+\[advisory\]/);
  assert.match(diagnostics, /anthropic\s+model=\(default\)\s+key=no\s+ready=no\s+source=claude\/\.claude\.json\s+\[blocked\]/);
  assert.doesNotMatch(diagnostics, /source=manual/);
  assert.match(diagnostics, /Setup required for blocked providers/);
  assert.match(diagnostics, /set ANTHROPIC_API_KEY/);
});
