import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema, printConfigDiagnostics } from './config.js';

test('provider source metadata survives config validation and diagnostics', () => {
  const config = ConfigSchema.parse({
    server: {},
    agent: {},
    memory: {},
    executor: {},
    auth: {},
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
  assert.equal(config.memory.persistChatDefault, true, 'chat should default to episodic observation write');

  const diagnostics = printConfigDiagnostics(config);
  assert.match(diagnostics, /deepseek\s+model=deepseek-v4-flash\s+key=yes ready=yes source=env:DEEPSEEK_API_KEY\s+\[advisory\]/);
  assert.match(diagnostics, /packycode\s+model=gpt-5\.5\s+key=yes ready=yes source=codex\/auth\.json\s+\[advisory\]/);
  assert.doesNotMatch(diagnostics, /source=manual/);
  assert.doesNotMatch(diagnostics, /Setup required for blocked providers/);
  assert.doesNotMatch(diagnostics, /set ANTHROPIC_API_KEY/);
});

test('feed-analysis integration config has bounded defaults and validates callback profiles', () => {
  const config = ConfigSchema.parse({
    server: {}, agent: {}, memory: {}, executor: {}, auth: {}, providers: {},
    integrations: {
      feedAnalysis: {
        serviceToken: 'fixture-token',
        materialHosts: ['materials.example.com'],
        callbackProfiles: {
          lot2: {
            url: 'https://backend.example.com/api/integrations/los/feed-analysis/events',
            secret: 'fixture-callback-secret-at-least-32-bytes',
          },
        },
      },
    },
  });

  assert.equal(config.integrations.feedAnalysis.maxInlineBytes, 1024 * 1024);
  assert.equal(config.integrations.feedAnalysis.maxItems, 500);
  assert.equal(config.integrations.feedAnalysis.callbackProfiles.lot2?.maxAttempts, 8);
  assert.deepEqual(config.integrations.feedAnalysis.materialHosts, ['materials.example.com']);
});

test('runtime versions default to the release and allow executor-specific builds', () => {
  const defaultConfig = ConfigSchema.parse({
    server: {}, agent: {}, memory: {}, executor: {}, auth: {}, providers: {},
  });
  const versionedConfig = ConfigSchema.parse({
    server: { version: '0.1.0+b123456789abc' },
    agent: {}, memory: {}, executor: { version: '0.1.0+boracle123456' }, auth: {}, providers: {},
  });

  assert.equal(defaultConfig.server.version, undefined);
  assert.equal(defaultConfig.executor.version, undefined);
  assert.equal(defaultConfig.executor.shutdownGraceMs, 120_000);
  assert.equal(versionedConfig.server.version, '0.1.0+b123456789abc');
  assert.equal(versionedConfig.executor.version, '0.1.0+boracle123456');
});
