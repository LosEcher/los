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
