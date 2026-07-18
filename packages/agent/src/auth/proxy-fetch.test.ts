import test from 'node:test';
import assert from 'node:assert/strict';
import { _createProxyAwareFetch } from './proxy-fetch.js';

test('proxy-aware fetch installs the configured proxy before issuing a request', async () => {
  const events: string[] = [];
  const fetchWithProxy = _createProxyAwareFetch(
    {
      createAgent: uri => {
        events.push(`create:${uri}`);
        return { uri };
      },
      setDispatcher: () => events.push('install'),
    },
    async () => {
      events.push('fetch');
      return new Response(null, { status: 204 });
    },
  );

  const response = await fetchWithProxy('https://auth.x.ai/.well-known/openid-configuration', undefined, {
    HTTPS_PROXY: 'http://127.0.0.1:6152',
    HTTP_PROXY: 'http://127.0.0.1:9999',
  });

  assert.equal(response.status, 204);
  assert.deepEqual(events, ['create:http://127.0.0.1:6152', 'install', 'fetch']);
});

test('proxy-aware fetch reuses one dispatcher and replaces it when the proxy changes', async () => {
  const installed: string[] = [];
  const fetchWithProxy = _createProxyAwareFetch(
    {
      createAgent: uri => uri,
      setDispatcher: dispatcher => installed.push(String(dispatcher)),
    },
    async () => new Response(null, { status: 204 }),
  );

  await fetchWithProxy('https://auth.x.ai', undefined, { HTTP_PROXY: 'http://proxy-a:8080' });
  await fetchWithProxy('https://auth.x.ai/token', undefined, { HTTP_PROXY: 'http://proxy-a:8080' });
  await fetchWithProxy('https://api.x.ai/v1/models', undefined, { HTTPS_PROXY: 'http://proxy-b:8080' });
  await fetchWithProxy('https://api.x.ai/v1/models', undefined, {});

  assert.deepEqual(installed, ['http://proxy-a:8080', 'http://proxy-b:8080']);
});
