import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createDashboard } from '../server.mjs';

async function run(t, options) {
  const server = createDashboard(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path, init) => fetch(base + path, init);
}

test('serves dashboard assets, a health check and safe validation errors', async t => {
  const request = await run(t, { instance: 'web01' });
  const health = await request('/health');
  assert.equal(health.headers.get('x-served-by'), 'web01');
  assert.deepEqual(await health.json(), { status: 'ok', instance: 'web01' });
  assert.match(await (await request('/')).text(), /Investigation history/);
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/styles.css')).status, 200);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/api/lookup?ip=example.org')).status, 400);
  assert.equal((await request('/api/lookup?ip=8.8.8.8&days=366')).status, 400);
  assert.equal((await request('/api/lookup?ip=8.8.8.8')).status, 503);
  assert.equal((await request('/api/lookup', { method: 'POST' })).status, 405);
});

test('sends credentials upstream only, coalesces requests and caches normalized IPv6', async t => {
  let calls = 0;
  let upstream;
  const request = await run(t, {
    apiKey: 'test-secret', dailyLimit: 1,
    async fetchUpstream(url, options) {
      calls++;
      upstream = { url, options };
      await new Promise(resolve => setTimeout(resolve, 50));
      return Response.json({ data: {
        ipAddress: '2001:4860:4860:0:0:0:0:8888', isPublic: true, abuseConfidenceScore: 25,
        totalReports: 3, isp: 'Example', reports: ['excluded'],
      } });
    },
  });
  const path = '/api/lookup?ip=2001%3A4860%3A4860%3A%3A8888&days=7';
  const [first, second] = await Promise.all([request(path), request(path)]);
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(result.score, 25);
  assert.equal(result.reports, 3);
  assert.equal(result.days, 7);
  assert.deepEqual(await second.json(), result);
  assert.equal((await request(path)).status, 200);
  assert.equal(calls, 1);
  assert.equal(upstream.options.headers.Key, 'test-secret');
  assert.equal(upstream.url.searchParams.get('ipAddress'), '2001:4860:4860::8888');
  assert.ok(!upstream.url.href.includes('test-secret'));
  assert.ok(!JSON.stringify(result).includes('test-secret'));
  assert.equal((await request('/api/lookup?ip=8.8.8.8')).status, 429);
});

test('handles rejected credentials, provider throttling, malformed data and downtime', async t => {
  let response;
  let calls = 0;
  const request = await run(t, { apiKey: 'test-secret', async fetchUpstream() {
    calls++;
    if (response instanceof Error) throw response;
    return response;
  } });
  const path = '/api/lookup?ip=8.8.8.8';
  for (const [upstream, status, message] of [
    [new Response(null, { status: 401 }), 503, /credentials/],
    [new Response('bad JSON'), 502, /invalid JSON/],
    [Response.json({ data: {} }), 502, /invalid response/],
    [Response.json({ data: { ipAddress: '8.8.8.8', isPublic: false, abuseConfidenceScore: 0, totalReports: 0 } }), 422, /public IP/],
    [new Error('private upstream detail'), 502, /Unable to reach/],
    [new Response(null, { status: 429, headers: { 'Retry-After': '60' } }), 429, /rate limiting/],
  ]) {
    response = upstream;
    const result = await request(path);
    assert.equal(result.status, status);
    assert.match((await result.json()).error, message);
  }
  assert.equal((await request(path)).status, 429);
  assert.equal(calls, 6);
});
