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
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        enabled: true,
        source: 'env:DEEPSEEK_API_KEY',
      },
      packycode: {
        apiKey: 'packy-key',
        baseUrl: 'https://www.packyapi.com/v1',
        model: 'gpt-5.5',
        enabled: true,
        source: 'codex/auth.json',
      },
    },
  });

  assert.equal(config.providers.deepseek.source, 'env:DEEPSEEK_API_KEY');
  assert.equal(config.providers.packycode.source, 'codex/auth.json');

  const diagnostics = printConfigDiagnostics(config);
  assert.match(diagnostics, /deepseek\s+model=deepseek-v4-flash\s+key=yes ready=yes source=env:DEEPSEEK_API_KEY\s+\[advisory\]/);
  assert.match(diagnostics, /packycode\s+model=gpt-5\.5\s+key=yes ready=yes source=codex\/auth\.json\s+\[advisory\]/);
  assert.doesNotMatch(diagnostics, /source=manual/);
  assert.doesNotMatch(diagnostics, /Setup required for blocked providers/);
  assert.doesNotMatch(diagnostics, /set ANTHROPIC_API_KEY/);
});
