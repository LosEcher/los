import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeChildEnv, sanitizedRuntimeEnv } from './runtime-env.js';

const BASE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/Users/someone',
  LANG: 'en_US.UTF-8',
  SHELL: '/bin/zsh',
  // provider credentials the external runtime needs
  ANTHROPIC_API_KEY: 'sk-ant',
  OPENAI_BASE_URL: 'https://example.invalid',
  DEEPSEEK_API_KEY: 'sk-ds',
  // control-plane secrets it must never see
  EXECUTOR_AGENT_KEY: 'executor-secret',
  LOS_OPERATOR_TOKEN: 'operator-secret',
  LOS_AUTH_TOKEN: 'auth-secret',
  DSH_HOME: '/Users/someone/.dsh',
  // unrelated host state
  UNRELATED_HOST_VAR: 'should-not-pass',
  // looks like a provider key but is a los secret
  LOS_API_KEY: 'los-secret',
};

test('external runtimes keep shell basics and provider credentials', () => {
  const env = sanitizedRuntimeEnv(BASE);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/someone');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(env.OPENAI_BASE_URL, 'https://example.invalid');
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-ds');
});

test('control-plane secrets never reach an external runtime', () => {
  const env = sanitizedRuntimeEnv(BASE);
  for (const key of ['EXECUTOR_AGENT_KEY', 'LOS_OPERATOR_TOKEN', 'LOS_AUTH_TOKEN', 'DSH_HOME']) {
    assert.equal(env[key], undefined, `${key} must not be forwarded`);
  }
});

test('the deny list wins over a provider-looking name', () => {
  const env = sanitizedRuntimeEnv(BASE);
  assert.equal(env.LOS_API_KEY, undefined, 'LOS_API_KEY matches a provider shape but is a los secret');
});

test('unrelated host variables are not forwarded by default', () => {
  const env = sanitizedRuntimeEnv(BASE);
  assert.equal(env.UNRELATED_HOST_VAR, undefined);
});

test('explicit caller overrides are merged on top of the sanitized base', () => {
  const env = runtimeChildEnv({ LOS_AGENT_DEBUG: '1', PATH: '/custom/bin' }, BASE);
  assert.equal(env.LOS_AGENT_DEBUG, '1');
  assert.equal(env.PATH, '/custom/bin');
  assert.equal(env.EXECUTOR_AGENT_KEY, undefined);
});
