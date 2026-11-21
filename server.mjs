import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/styles.css', 'styles.css', 'text/css'],
].map(async ([path, file, type]) => [
  path, { type, body: await readFile(new URL('./public/' + file, import.meta.url)) },
])));
const minute = 60_000;
const day = 24 * 60 * minute;

class LookupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeIP(ip) {
  const version = isIP(ip);
  if (!version || ip.includes('%')) return null;
  return version === 6 ? new URL('http://[' + ip + ']').hostname.slice(1, -1) : ip;
}

function parseResult(data, ip, days) {
  if (!data || typeof data.ipAddress !== 'string' || normalizeIP(data.ipAddress) !== ip ||
      typeof data.isPublic !== 'boolean' || !Number.isInteger(data.abuseConfidenceScore) ||
      data.abuseConfidenceScore < 0 || data.abuseConfidenceScore > 100 ||
      !Number.isSafeInteger(data.totalReports) || data.totalReports < 0) {
    throw new LookupError(502, 'AbuseIPDB returned an invalid response. Try again later.');
  }
  if (!data.isPublic) throw new LookupError(422, 'Use a public IP address for a reputation lookup.');
  const fields = ['countryCode', 'isp', 'domain', 'usageType', 'lastReportedAt'];
  const metadata = Object.fromEntries(fields.map(key => [
    key, typeof data[key] === 'string' ? data[key].slice(0, 300) : null,
  ]));
  return {
    ip, days, ...metadata, score: data.abuseConfidenceScore,
    reports: data.totalReports, checkedAt: new Date().toISOString(), source: 'AbuseIPDB',
  };
}

export function createDashboard({
  apiKey = '', instance = 'local', dailyLimit = 400, fetchUpstream = fetch,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let windowStart = Date.now();
  let attempts = 0;
  let pausedUntil = 0;

  async function lookup(ip, days) {
    const key = ip + '/' + days;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached?.expires > now) return cached.result;
    if (pending.has(key)) return pending.get(key);
    if (!apiKey) throw new LookupError(503, 'Live lookups are unavailable. Ask the operator to configure AbuseIPDB or load a sample.');
    if (now - windowStart >= day) {
      windowStart = now;
      attempts = 0;
    }
    if (now < pausedUntil || attempts >= dailyLimit || pending.size >= 8) {
      throw new LookupError(429, 'The lookup limit has been reached. Try again later.');
    }
    attempts++;
    const request = (async () => {
      const url = new URL('https://api.abuseipdb.com/api/v2/check');
      url.search = new URLSearchParams({ ipAddress: ip, maxAgeInDays: days });
      const signal = AbortSignal.timeout(7_000);
      let result;
      try {
        const response = await fetchUpstream(url, {
          headers: { Accept: 'application/json', Key: apiKey }, signal, redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const retry = response.headers.get('retry-after');
            const milliseconds = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            pausedUntil = Date.now() + (milliseconds > 0 && Number.isFinite(milliseconds) ? milliseconds : minute);
            throw new LookupError(429, 'AbuseIPDB is rate limiting requests. Try again later.');
          }
          if ([401, 403].includes(response.status)) {
            throw new LookupError(503, 'AbuseIPDB rejected the server credentials. Contact the operator.');
          }
          if (response.status === 422) throw new LookupError(422, 'AbuseIPDB could not check this IP. Try a different public address.');
          throw new LookupError(502, 'AbuseIPDB is temporarily unavailable. Try again later.');
        }
        result = parseResult((await response.json())?.data, ip, days);
      } catch (error) {
        if (error instanceof LookupError) throw error;
        if (signal.aborted) throw new LookupError(504, 'AbuseIPDB took too long to respond. Try again.');
        if (error instanceof SyntaxError) throw new LookupError(502, 'AbuseIPDB returned invalid JSON. Try again later.');
        throw new LookupError(502, 'Unable to reach AbuseIPDB. Try again later.');
      }
      cache.delete(key);
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { result, expires: Date.now() + 10 * minute });
      return result;
    })();
    pending.set(key, request);
    try {
      return await request;
    } finally {
      pending.delete(key);
    }
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Served-By', instance);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new LookupError(405, 'Use GET for this endpoint.');
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return send(200, { status: 'ok', instance });
      if (url.pathname === '/api/lookup') {
        const ip = normalizeIP(url.searchParams.get('ip')?.trim() ?? '');
        const days = url.searchParams.get('days') ?? '30';
        if (!ip) throw new LookupError(400, 'Enter a valid IPv4 or IPv6 address without a port or prefix.');
        if (!['7', '30', '90'].includes(days)) throw new LookupError(400, 'Choose a 7, 30, or 90 day report window.');
        return send(200, await lookup(ip, Number(days)));
      }
      const asset = assets.get(url.pathname);
      if (asset) return send(200, asset.body, asset.type);
      throw new LookupError(404, 'This endpoint does not exist.');
    } catch (error) {
      if (error instanceof LookupError) return send(error.status, { error: error.message });
      return send(500, { error: 'The server could not complete the request.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const instance = process.env.INSTANCE_ID || 'local';
  const dailyLimit = Number(process.env.DAILY_LOOKUP_LIMIT || 400);
  if (!/^[\w.-]{1,40}$/.test(instance) || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
    throw new Error('Set a valid INSTANCE_ID and a positive integer DAILY_LOOKUP_LIMIT.');
  }
  createDashboard({ apiKey: process.env.ABUSEIPDB_API_KEY?.trim(), instance, dailyLimit })
    .listen(port, host, () => console.log('Dashboard listening on http://' + host + ':' + port));
}
