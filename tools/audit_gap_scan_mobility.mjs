#!/usr/bin/env node
/*
 * Audit gap-scan candidates with the navigation-v1 mobility rule.
 *
 * Every candidate is checked against https://sv.map.qq.com/sv?svid=<id>&output=json.
 * Only panoramas whose metadata exposes no adjacent frame (roads / vpoints / all_scenes)
 * are immobile, and therefore hidden. Anything that can be entered from a neighbour is a
 * regular street panorama and must not enter the hidden collection.
 *
 * Results are appended to a JSONL cache so an interrupted run resumes without re-querying.
 *
 * Usage:
 *   node tools/audit_gap_scan_mobility.mjs --in a.json b.json --out tools/data/gap-scan-verification.json
 *   node tools/audit_gap_scan_mobility.mjs --in a.json --out out.json --proxy http://127.0.0.1:7897
 *
 * A proxy is only needed when the direct address is rate limited; verdicts are identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RULE_VERSION, inspectPanorama } = require('./pano-mobility.js');

const ENDPOINT = 'https://sv.map.qq.com/sv?svid=%s&output=json';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 20000;

/* Hard quota of the sv gateway: 16.7 points/s (about 1,000 requests per minute).
 * Going above it gets the calling address refused with HTTP 500 (tRPC-Gateway, Cost: 0)
 * for a while, so every request has to take a token from one shared bucket and the
 * working rate never exceeds the ceiling. The run starts below the limit, steps up on
 * success and backs off on refusal. */
const RATE_QUOTA = 16.7;
const RATE_SAFETY = 0.8; // a rolling one-minute window counts slightly differently than per second
const RATE_CEILING = Number((RATE_QUOTA * RATE_SAFETY).toFixed(1));
const RATE_START = 8;
const RATE_FLOOR = 4;
const BURST_TOKENS = 6;
const rate = { current: RATE_START };
const bucket = { tokens: BURST_TOKENS, refilledAt: Date.now() };

let proxyUrl = null;
let alternate = false;
let requestCounter = 0;

/* A refused address stays refused for a while, so each route gets its own circuit
 * breaker instead of one global cooldown: a blocked route is skipped until its window
 * expires and the other route keeps working. */
const ROUTE_PENALTY_MS = 30000;
const ROUTE_PENALTY_MAX_MS = 120000;
const routes = {
  direct: { blockedUntil: 0, penaltyMs: ROUTE_PENALTY_MS },
  proxy: { blockedUntil: 0, penaltyMs: ROUTE_PENALTY_MS },
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function takeToken() {
  for (;;) {
    const now = Date.now();
    const refill = ((now - bucket.refilledAt) / 1000) * rate.current;
    bucket.tokens = Math.min(BURST_TOKENS, bucket.tokens + refill);
    bucket.refilledAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await sleep(Math.max(20, Math.ceil(((1 - bucket.tokens) / rate.current) * 1000)));
  }
}

function availableRoutes() {
  const now = Date.now();
  const list = [];
  if (now >= routes.direct.blockedUntil) list.push('direct');
  if (proxyUrl && now >= routes.proxy.blockedUntil) list.push('proxy');
  return list;
}

async function waitForRoute() {
  for (;;) {
    const list = availableRoutes();
    if (list.length) return list[requestCounter++ % list.length];
    const soonest = Math.min(routes.direct.blockedUntil, proxyUrl ? routes.proxy.blockedUntil : Infinity);
    await sleep(Math.max(1000, soonest - Date.now()));
  }
}

function blockRoute(name) {
  const route = routes[name];
  route.blockedUntil = Date.now() + route.penaltyMs;
  route.penaltyMs = Math.min(ROUTE_PENALTY_MAX_MS, route.penaltyMs * 2);
  rate.current = Math.max(RATE_FLOOR, Number((rate.current * 0.6).toFixed(1)));
}

function forgiveRoute(name) {
  routes[name].penaltyMs = ROUTE_PENALTY_MS;
  rate.current = Math.min(RATE_CEILING, Number((rate.current + 0.5).toFixed(1)));
}

function parseArguments(argv) {
  const options = { inputs: [], out: null, concurrency: DEFAULT_CONCURRENCY, retries: DEFAULT_RETRIES };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--in') {
      index += 1;
      while (index < argv.length && !argv[index].startsWith('--')) options.inputs.push(argv[index++]);
      index -= 1;
    } else if (flag === '--out') {
      options.out = argv[++index];
    } else if (flag === '--concurrency') {
      options.concurrency = Number(argv[++index]);
    } else if (flag === '--retries') {
      options.retries = Number(argv[++index]);
    } else if (flag === '--proxy') {
      options.proxy = argv[++index];
    } else if (flag === '--alternate') {
      options.alternate = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!options.inputs.length) throw new Error('--in is required');
  if (!options.out) throw new Error('--out is required');
  return options;
}

function readRecords(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const records = Array.isArray(payload) ? payload : payload.points || payload.records || [];
  return records.map((record) => ({
    sid: String(record.sid || record.svid || record.panoid || record.id || ''),
    record,
  }));
}

function loadCache(cachePath) {
  const cache = new Map();
  if (!fs.existsSync(cachePath)) return cache;
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.sid) cache.set(entry.sid, entry);
    } catch {
      // A torn final line from an interrupted run is simply ignored.
    }
  }
  return cache;
}

async function requestPanorama(sid, retries) {
  const url = ENDPOINT.replace('%s', encodeURIComponent(sid));
  let lastError = null;
  const maxAttempts = Math.max(2, retries + 2);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const route = await waitForRoute();
    try {
      await takeToken();
      const payload = route === 'proxy' ? await fetchThroughProxy(url) : await fetchDirect(url);
      forgiveRoute(route);
      return payload;
    } catch (error) {
      lastError = error;
      blockRoute(route);
    }
  }
  throw lastError;
}

const USER_AGENT = 'Mozilla/5.0 tencent-panorama-workbench mobility audit';

async function fetchDirect(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://map.qq.com/' },
  });
  if (!response.ok) throw new Error(`http-${response.status}`);
  return response.json();
}

/* The sv gateway blocks the direct address after a burst, so the audit can be tunnelled
 * through the machine's own HTTP proxy. One CONNECT tunnel per request keeps the code
 * dependency free and matches the direct path's failure semantics. */
function openTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port || 80), proxy.hostname);
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error('proxy-timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.removeListener('data', onData);
        const status = buffer.slice(0, buffer.indexOf('\r\n'));
        if (!status.includes(' 200')) return fail(new Error(`proxy-connect:${status}`));
        const secure = tls.connect({ socket, servername: host });
        secure.once('secureConnect', () => resolve(secure));
        secure.once('error', fail);
      };
      socket.on('data', onData);
    });
  });
}

async function fetchThroughProxy(url) {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  const socket = await openTunnel(proxy, target.hostname, target.port || 443);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('request-timeout'));
    }, REQUEST_TIMEOUT_MS);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      if (split === -1) return reject(new Error('malformed-response'));
      const status = raw.slice(0, raw.indexOf('\r\n'));
      if (!status.includes(' 200')) return reject(new Error(`http-${(status.split(' ')[1] || '000')}`));
      let body = raw.slice(split + 4);
      if (/transfer-encoding:\s*chunked/i.test(raw.slice(0, split))) body = dechunk(body);
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('bad-json'));
      }
    });
    socket.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\n`
      + `User-Agent: ${USER_AGENT}\r\nReferer: https://map.qq.com/\r\nAccept: */*\r\n`
      + 'Connection: close\r\n\r\n');
  });
}

function dechunk(body) {
  let output = '';
  let index = 0;
  while (index < body.length) {
    const lineEnd = body.indexOf('\r\n', index);
    if (lineEnd === -1) break;
    const size = parseInt(body.slice(index, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    output += body.slice(lineEnd + 2, lineEnd + 2 + size);
    index = lineEnd + 2 + size + 2;
  }
  return output;
}

function sha256OfFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  proxyUrl = options.proxy || process.env.PW_PROXY || null;
  alternate = Boolean(options.alternate);
  const seen = new Map();
  for (const file of options.inputs) {
    for (const { sid, record } of readRecords(file)) {
      if (!sid || seen.has(sid)) continue;
      seen.set(sid, { sid, record });
    }
  }

  const cachePath = `${options.out}.jsonl`;
  const cache = loadCache(cachePath);
  // Cached request failures are retried; settled verdicts are reused.
  const pending = [...seen.values()].filter(({ sid }) => {
    const cached = cache.get(sid);
    return !cached || cached.status === 'error';
  });
  process.stderr.write(
    `candidates=${seen.size} settled=${seen.size - pending.length} pending=${pending.length} concurrency=${options.concurrency}\n`,
  );

  const stream = fs.createWriteStream(cachePath, { flags: 'a' });
  let cursor = 0;
  let completed = 0;
  const startedAt = Date.now();

  async function worker() {
    while (cursor < pending.length) {
      const { sid } = pending[cursor++];
      let verification;
      try {
        verification = inspectPanorama(sid, await requestPanorama(sid, options.retries));
        verification.checkedAt = new Date().toISOString();
      } catch (error) {
        verification = {
          sid,
          ruleVersion: RULE_VERSION,
          status: 'error',
          isValid: false,
          canMove: false,
          movementCount: 0,
          movementIds: [],
          reason: `request-failed:${error?.message || error}`,
          checkedAt: new Date().toISOString(),
        };
      }
      cache.set(sid, verification);
      stream.write(`${JSON.stringify(verification)}\n`);
      completed += 1;
      if (completed % 250 === 0 || completed === pending.length) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const blocked = ['direct', 'proxy']
          .filter((name) => name === 'direct' || proxyUrl)
          .filter((name) => Date.now() < routes[name].blockedUntil);
        process.stderr.write(
          `progress=${completed}/${pending.length} rate=${(completed / elapsed).toFixed(1)}/s budget=${rate.current}/s `
          + `blocked=${blocked.join('|') || '-'} elapsed=${elapsed.toFixed(0)}s\n`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  await new Promise((resolve) => stream.end(resolve));

  const records = {};
  const counts = { hidden: 0, regular: 0, invalid: 0, error: 0 };
  for (const { sid } of seen.values()) {
    const verification = cache.get(sid);
    if (!verification) continue;
    records[sid] = verification;
    counts[verification.status] = (counts[verification.status] || 0) + 1;
  }

  const payload = {
    description: 'navigation-v1 mobility audit for gap-scan candidates; hidden = no adjacent frame, regular = movable',
    ruleVersion: RULE_VERSION,
    auditedAt: new Date().toISOString(),
    source_sha256: sha256OfFiles(options.inputs),
    sources: options.inputs.map((file) => path.basename(file)),
    counts,
    records,
  };
  fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  process.stderr.write(`wrote ${options.out} records=${Object.keys(records).length} ${JSON.stringify(counts)}\n`);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
