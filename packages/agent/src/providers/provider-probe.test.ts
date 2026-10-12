import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _resetProviderProbeStateForTests,
  probeProviders,
} from './provider-probe.js';
import { isProviderProbeCircuitOpen } from './provider-probe-circuit.js';

test('GET transport failure does not issue a HEAD fallback', async () => {
  _resetProviderProbeStateForTests();
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    throw new Error('ECONNREFUSED');
  };
  const results = await probeProviders(
    [{ provider: 'lmstudio-win', baseUrl: 'http://100.90.170.58:1234/v1' }],
    50,
    { fetch: fakeFetch },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'GET http://100.90.170.58:1234/v1/models');
  assert.equal(results[0]?.healthy, false);
  assert.match(results[0]?.error ?? '', /ECONNREFUSED/);
});

test('open circuit skips the next probe without fetching', async () => {
  _resetProviderProbeStateForTests();
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    throw new Error('ECONNREFUSED');
  };
  let now = 1_000_000;
  await probeProviders(
    [{ provider: 'lmstudio-win', baseUrl: 'http://127.0.0.1:1234/v1' }],
    50,
    { fetch: fakeFetch, now: () => now },
  );
  assert.equal(fetches, 1);
  assert.equal(isProviderProbeCircuitOpen('lmstudio-win', now + 1), true);

  const skipped = await probeProviders(
    [{ provider: 'lmstudio-win', baseUrl: 'http://127.0.0.1:1234/v1' }],
    50,
    { fetch: fakeFetch, now: () => now + 1 },
  );
  assert.equal(fetches, 1);
  assert.match(skipped[0]?.error ?? '', /circuit_open/);
});

test('in-flight probe is single-flight', async () => {
  _resetProviderProbeStateForTests();
  let releases!: () => void;
  const gate = new Promise<void>((resolve) => {
    releases = resolve;
  });
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    await gate;
    return new Response('{}', { status: 200 });
  };
  const first = probeProviders(
    [{ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }],
    5_000,
    { fetch: fakeFetch },
  );
  await Promise.resolve();
  const second = await probeProviders(
    [{ provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }],
    5_000,
    { fetch: fakeFetch },
  );
  assert.equal(fetches, 1);
  assert.match(second[0]?.error ?? '', /probe_in_flight/);
  releases();
  const done = await first;
  assert.equal(done[0]?.healthy, true);
});

test('HTTP 503 does not open the transport circuit', async () => {
  _resetProviderProbeStateForTests();
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return new Response('no', { status: 503 });
  };
  const now = 2_000_000;
  await probeProviders(
    [{ provider: 'packycode', baseUrl: 'https://example.test/v1' }],
    50,
    { fetch: fakeFetch, now: () => now },
  );
  assert.equal(isProviderProbeCircuitOpen('packycode', now + 1), false);
  await probeProviders(
    [{ provider: 'packycode', baseUrl: 'https://example.test/v1' }],
    50,
    { fetch: fakeFetch, now: () => now + 1 },
  );
  assert.equal(fetches, 2);
});

// 2026-10-12：探针**按协议分派**。
//
// 起因：探针原先一律打 `GET {baseUrl}/models`（OpenAI 兼容的形状）。Anthropic 协议的端点上
// 它是 **404**（实测 zenmux `{base}/models` → 404），而 404 不在原健康判据（ok|401|403）里
// ⇒ 判 `unhealthy` ⇒ `computeHealthScore` 把 probe=false 同时算成 rttScore=0 与
// availabilityScore=0 ⇒ 即使真实调用 100% 成功也只得 0.40 ⇒ **整个协议族被误路由**。
//
// 修法：Anthropic 线改探协议自己的 `{base}/v1/messages`，判据放宽为**任何 <500 = 边缘可达**
// （探针量可用性，权重 0.2；正确性由真实调用结果承担，权重 0.4）；OpenAI 线判据不变
// —— 那里 `/models` 真的存在，放宽会让填错的 baseUrl 看起来健康。
test('anthropic-wire probes use /v1/messages and treat any <500 as reachable', async () => {
  _resetProviderProbeStateForTests();
  const seen: string[] = [];
  const fakeFetch = async (input: unknown, init?: { method?: string }) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return { ok: false, status: 404 } as unknown as Response;
  };
  const results = await probeProviders(
    [{ provider: 'zenmux-anthropic-probe-test', baseUrl: 'https://zenmux.ai/api/anthropic', wire: 'anthropic' }],
    50,
    { fetch: fakeFetch },
  );
  // 探的是协议正典路径，不是 /models
  assert.equal(seen[0], 'GET https://zenmux.ai/api/anthropic/v1/messages');
  // 404 在 Anthropic 线上算"边缘可达"
  assert.equal(results[0]?.healthy, true);
  assert.equal(results[0]?.statusCode, 404);
});

test('anthropic-wire probes still treat 5xx as unhealthy', async () => {
  _resetProviderProbeStateForTests();
  const fakeFetch = async () => ({ ok: false, status: 503 }) as unknown as Response;
  const results = await probeProviders(
    [{ provider: 'zenmux-anthropic-503-test', baseUrl: 'https://zenmux.ai/api/anthropic', wire: 'anthropic' }],
    50,
    { fetch: fakeFetch },
  );
  assert.equal(results[0]?.healthy, false);
});

test('openai-wire probes keep the stricter predicate (404 is NOT reachable)', async () => {
  _resetProviderProbeStateForTests();
  const seen: string[] = [];
  const fakeFetch = async (input: unknown) => {
    seen.push(String(input));
    return { ok: false, status: 404 } as unknown as Response;
  };
  const results = await probeProviders(
    [{ provider: 'openai-wire-404-test', baseUrl: 'https://example.test/v1' }],
    50,
    { fetch: fakeFetch },
  );
  // 不给 wire ⇒ 默认 openai 兼容，路径仍是 /models
  assert.equal(seen[0], 'https://example.test/v1/models');
  assert.equal(results[0]?.healthy, false);
});
