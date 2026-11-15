#!/usr/bin/env node
// Real Edge acceptance of gzip or Brotli publication. Historical filename retained for compatibility.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
function arg(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const sourceRoot = path.resolve(arg('--source', 'city-viewer'));
const html = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8');
const sourceVersion = html.match(/<span class="ver">(v\d+\.\d+\.\d+)<\/span>/)?.[1];
if (!sourceVersion) throw Error('Missing viewer version');
const meta = fs.readFileSync(path.join(sourceRoot, 'data_meta.js'), 'utf8');
const countMarker = 'window.PANO_COUNT=';
const offset = meta.indexOf(countMarker);
if (offset < 0) throw Error('Missing PANO_COUNT');
const counts = JSON.parse(meta.slice(offset + countMarker.length).split(';')[0]);
const expectedVersion = arg('--expected-version', sourceVersion);
const expectedTotal = Number(arg('--expected-total', Object.values(counts).reduce((a, b) => a + b, 0)));
const expectedFiles = Number(arg('--expected-files', Object.keys(counts).filter(k => k !== 'hidden' && !k.startsWith('hidden_')).length + 3));
const expectedCodec = arg('--expected-codec', null);
if (expectedCodec && !['gzip', 'brotli'].includes(expectedCodec)) throw Error('Unknown expected codec');
const siteRoot = arg('--site-root', null), liveUrl = arg('--url', null);
if (Boolean(siteRoot) === Boolean(liveUrl)) throw Error('Choose --site-root or --url');
const edge = arg('--browser', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const vendorRoot = path.resolve(arg('--vendor-root', 'dist/browser-vendor'));
const resultRoot = path.resolve(arg('--result-dir', 'dist/browser-check'));
if (fs.existsSync(resultRoot)) throw Error('Choose a new result directory; never overwrite previous evidence');
fs.mkdirSync(resultRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(resultRoot, 'profile-'));
const samplePath = arg('--target-sample', null);
let target, targetCollection;
if (samplePath) {
  const sample = JSON.parse(fs.readFileSync(path.resolve(samplePath), 'utf8'));
  target = sample.row;
  targetCollection = sample.collection || sample.pref;
  assert(Array.isArray(target) && typeof target[0] === 'string' && Number.isFinite(target[1]) && Number.isFinite(target[2]));
  assert(/^[A-Za-z0-9_]+$/.test(targetCollection));
} else {
  const source = fs.readFileSync(path.join(sourceRoot, 'data_532600.js'), 'utf8');
  const marker = 'window.PANO_CITY["532600"]=';
  target = JSON.parse(source.slice(source.indexOf(marker) + marker.length).trim().replace(/;\s*$/, ''))[0];
  targetCollection = '532600';
}
const initialWidth = Number(arg('--initial-width', 1280));
const startupCity = arg('--startup-city', targetCollection);
assert(Number.isSafeInteger(initialWidth) && initialWidth >= 320 && initialWidth <= 2560, 'Invalid initial viewport width');
assert(/^[A-Za-z0-9_]+$/.test(startupCity), 'Invalid startup city');
const forceWorker = args.includes('--force-brotli-worker');
let server, browser, ws, nextId = 1;
const pending = new Map(), requests = [], exceptions = [], localRequests = [], responses = [];
const report = { targetSid: target[0], targetCollection, checks: {}, viewports: [], forcedBrotliWorker: forceWorker };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await fn()) return; await delay(250); }
  throw Error('Timed out waiting for browser state');
}
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 120000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function main() {
  let pageURL = liveUrl;
  if (siteRoot) {
    const root = path.resolve(siteRoot);
    server = http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        localRequests.push(pathname);
        let file;
        if (pathname.startsWith('/test-vendor/')) file = path.join(vendorRoot, path.basename(pathname));
        else {
          file = path.resolve(root, '.' + pathname);
          if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); res.end(); return; }
          if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' :
          file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.gz') ? 'application/gzip' :
          file.endsWith('.br') ? 'application/octet-stream' : /\.(?:js|mjs)$/.test(file) ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        if (file === path.join(root, 'city-viewer', 'index.html')) {
          const text = fs.readFileSync(file, 'utf8').replace('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', '/test-vendor/leaflet.js')
            .replace('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', '/test-vendor/leaflet.css');
          res.end(text);
        } else fs.createReadStream(file).pipe(res);
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    pageURL = 'http://127.0.0.1:' + server.address().port + '/city-viewer/';
  }
  report.url = pageURL;
  browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  browser.on('error', e => { report.spawnError = e.message; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile), 30000);
  const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const tab = pages.find(p => p.type === 'page'); assert(tab);
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', e => {
    const x = JSON.parse(e.data);
    if (x.id) {
      const p = pending.get(x.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(x.id); if (x.error) p.reject(Error(x.error.message)); else p.resolve(x.result || {});
    } else if (x.method === 'Network.requestWillBeSent') requests.push(x.params.request.url);
    else if (x.method === 'Runtime.exceptionThrown') exceptions.push(x.params.exceptionDetails.exception?.description || x.params.exceptionDetails.text);
    else if (x.method === 'Network.responseReceived') {
      const response = x.params.response;
      if (/\/(?:index\.html|asset-loader\.js|brotli-(?:decoder|worker)\.js)$|\.(?:mjs|wasm|br)(?:\?|$)/.test(response.url)) {
        const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
        responses.push({ url: response.url, status: response.status, mimeType: response.mimeType,
          contentType: headers['content-type'] || null, csp: headers['content-security-policy'] || null,
          contentEncoding: headers['content-encoding'] || null });
      }
    }
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*is.autonavi.com*', '*map.gtimg.com*', '*dbankcdn.cn*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: initialWidth, height: 720, deviceScaleFactor: 1, mobile: initialWidth <= 680 });
  // Test-only instrumentation: preserve the real map, record native codec support and worker lifetime.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function(){
    var value;Object.defineProperty(window,'L',{configurable:true,get:function(){return value;},set:function(v){value=v;if(v&&typeof v.map==='function'){var old=v.map;v.map=function(){var m=old.apply(this,arguments);window.__ASSET_TEST_MAP__=m;return m;};}}});
    window.__ASSET_CSP_VIOLATIONS__=[];document.addEventListener('securitypolicyviolation',function(e){window.__ASSET_CSP_VIOLATIONS__.push({directive:e.effectiveDirective,blockedURI:e.blockedURI,disposition:e.disposition});});
    var original=window.DecompressionStream,support={};['gzip','brotli','br'].forEach(function(c){try{new original(c);support[c]=true;}catch(e){support[c]=false;}});window.__ASSET_NATIVE_CODECS__=support;
    ${forceWorker ? "window.DecompressionStream=function(c){if(c==='brotli'||c==='br')throw new TypeError('Test forces local Brotli worker');return new original(c);};" : ''}
    var NativeWorker=window.Worker,stats={created:0,terminated:0,active:0,maxActive:0,urls:[]};window.__ASSET_WORKERS__=stats;
    if(NativeWorker)window.Worker=function(url,options){var w=new NativeWorker(url,options),closed=false;stats.created++;stats.active++;stats.maxActive=Math.max(stats.maxActive,stats.active);stats.urls.push(String(url));var end=w.terminate;w.terminate=function(){if(!closed){closed=true;stats.terminated++;stats.active--;}return end.call(w);};return w;};
  })();` });
  const streetRequests = () => requests.filter(u => /\/(?:data_(?!meta|districts)[A-Za-z0-9_]+|hidden_pano|grid_all|pano_search_index)\.js(?:\.(?:gz|br))?(?:\?|$)/.test(u));
  await send('Page.navigate', { url: pageURL });
  await until(() => evaluate(`Boolean(window.__ASSET_TEST_MAP__&&document.getElementById('startGate')&&getComputedStyle(document.getElementById('startGate')).display!=='none'&&document.getElementById('search').disabled)`));
  await delay(500);
  report.checks.initial = await evaluate(`({version:document.querySelector('.ver').textContent,total:Object.values(window.PANO_COUNT).reduce((a,b)=>a+b,0),files:Object.keys(window.PANO_ASSET_MANIFEST.files).length,codec:window.PANO_ASSET_MANIFEST.codec,manifestVersion:window.PANO_ASSET_MANIFEST.version,searchDisabled:document.getElementById('search').disabled,province:document.getElementById('provinceSelect').value,loadDisabled:document.getElementById('startNationBtn').disabled,loadedPointCollections:Object.keys(window.PANO_CITY||{}).length,gridLoaded:Boolean(window.PANO_GRID_ALL),searchIndexLoaded:Boolean(window.PANO_SEARCH_INDEX),workerCount:window.__ASSET_WORKERS__.created})`);
  assert.equal(report.checks.initial.version, expectedVersion); assert.equal(report.checks.initial.total, expectedTotal);
  assert.equal(report.checks.initial.province, ''); assert.equal(report.checks.initial.loadDisabled, true);
  assert.equal(report.checks.initial.loadedPointCollections, 0); assert.equal(report.checks.initial.gridLoaded, false);
  assert.equal(report.checks.initial.searchIndexLoaded, false); assert.equal(report.checks.initial.workerCount, 0);
  assert.equal(streetRequests().length, 0, 'Opening the page requested street data');
  report.checks.initial.dialog = await evaluate(`(function(){var r=document.getElementById('startGate').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()`);
  assert(report.checks.initial.dialog.left >= 0 && report.checks.initial.dialog.right <= initialWidth && report.checks.initial.dialog.top >= 0 && report.checks.initial.dialog.bottom <= 720, 'Startup dialog overflows the viewport');
  await evaluate(`(function(){var p=document.getElementById('provinceSelect');p.value='全国';p.dispatchEvent(new Event('change'));})()`);
  assert.equal(streetRequests().length, 0, 'Choosing the national view requested data before confirmation');
  const startupProvince = await evaluate(`window.PANO_META[${JSON.stringify(startupCity)}].province`);
  await evaluate(`(function(){var p=document.getElementById('provinceSelect');p.value=${JSON.stringify(startupProvince)};p.dispatchEvent(new Event('change'));var c=document.getElementById('citySelect');c.value=${JSON.stringify(startupCity)};c.dispatchEvent(new Event('change'));})()`);
  await delay(250);
  assert.equal(streetRequests().length, 0, 'Preparing a province/city requested street data before confirmation');
  report.checks.initial.streetRequests = []; report.checks.initial.selectionStreetRequests = [];
  await evaluate(`document.getElementById('startNationBtn').click()`);
  await until(() => evaluate(`!document.getElementById('search').disabled&&getComputedStyle(document.getElementById('startGate')).display==='none'&&document.getElementById('stats').textContent.includes('点')`));
  report.checks.boot = await evaluate(`({version:document.querySelector('.ver').textContent,total:Object.values(window.PANO_COUNT).reduce((a,b)=>a+b,0),files:Object.keys(window.PANO_ASSET_MANIFEST.files).length,codec:window.PANO_ASSET_MANIFEST.codec,manifestVersion:window.PANO_ASSET_MANIFEST.version,searchIndexLoaded:Boolean(window.PANO_SEARCH_INDEX),loadedPointCollections:Object.keys(window.PANO_CITY||{}).length,province:document.getElementById('provinceSelect').value,city:document.getElementById('citySelect').value,stats:document.getElementById('stats').textContent})`);
  const codec = report.checks.boot.codec, suffix = codec === 'brotli' ? '.br' : '.gz';
  if (expectedCodec) assert.equal(codec, expectedCodec);
  assert.equal(report.checks.boot.manifestVersion, codec === 'brotli' ? 2 : 1);
  assert.equal(report.checks.boot.version, expectedVersion); assert.equal(report.checks.boot.total, expectedTotal);
  assert.equal(report.checks.boot.files, expectedFiles); assert.equal(report.checks.boot.searchIndexLoaded, false);
  assert.equal(report.checks.boot.loadedPointCollections, 0); assert.equal(report.checks.boot.city, startupCity);
  assert.deepEqual(streetRequests().map(u => new URL(u).pathname.split('/').pop()), ['grid_all.js' + suffix], 'Confirmation must request only the overview grid');
  await evaluate(`(function(){var p=document.getElementById('provinceSelect');p.value=window.PANO_META.hidden_game.province;p.dispatchEvent(new Event('change'));var c=document.getElementById('citySelect');c.value='hidden_game';c.dispatchEvent(new Event('change'));var d=document.getElementById('dispMode');d.value='points';d.dispatchEvent(new Event('change'));})()`);
  await until(() => evaluate(`Object.values(window.__ASSET_TEST_MAP__._layers).some(l=>l._hits&&l._hits.length===15)`));
  assert.equal(await evaluate('window.PANO_CITY.hidden_game.length'), 15);
  report.checks.game = await evaluate(`(function(){var l=Object.values(window.__ASSET_TEST_MAP__._layers).find(l=>l._hits&&l._hits.length===15);return {points:l._hits.length,redFlags:l._hits.filter(p=>p[3]).length};})()`);
  assert.equal(report.checks.game.redFlags, 15);
  async function query(q, note) {
    await evaluate(`(function(){var e=document.getElementById('search');e.value=${JSON.stringify(q)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    try {
      await until(() => evaluate(`document.getElementById('stats').textContent.includes('搜索命中 1 条')&&document.getElementById('stats').textContent.includes(${JSON.stringify(note)})`), 240000);
    } catch (error) {
      report.checks.queryFailure = await evaluate(`({query:${JSON.stringify(q)},input:document.getElementById('search').value,stats:document.getElementById('stats').textContent,loading:document.getElementById('loadingData').textContent,headerCss:document.documentElement.style.getPropertyValue('--header-h'),headerHeight:document.querySelector('header').offsetHeight,workers:window.__ASSET_WORKERS__})`);
      report.checks.runtimeExceptions = exceptions; report.checks.requestsAtFailure = requests;
      throw error;
    }
  }
  await query(target[0], 'panoid 搜索');
  const positions = await evaluate(`(function(){var l=Object.values(window.__ASSET_TEST_MAP__._layers).find(l=>l._hits&&l._hits.length===1);return l?l._hits[0].slice(0,2):null;})()`);
  assert(positions); assert.equal(positions[0], target[2]); assert.equal(positions[1], target[1]);
  const expectedHidden = targetCollection === 'hidden' || targetCollection.startsWith('hidden_');
  const targetMarker = await evaluate(`(function(){var l=Object.values(window.__ASSET_TEST_MAP__._layers).find(l=>l._hits&&l._hits.length===1);return l?{red:l._hits[0][3],coordinates:l._hits[0].slice(0,2)}:null;})()`);
  assert(targetMarker); assert.equal(Boolean(targetMarker.red), expectedHidden, 'New sample hidden/regular marker classification changed');
  await evaluate(`void window.__ASSET_TEST_MAP__.fire('click',{latlng:window.L.latLng(${target[2]},${target[1]})})`);
  assert(await evaluate(`document.querySelector('.pv-meta .pid').textContent===${JSON.stringify(target[0])}`));
  report.checks.panoid = { sid: target[0], collection: targetCollection, coordinates: positions, exactNumericValues: true, expectedHidden, redFlag: Boolean(targetMarker.red) };
  const positionQuery = '@1-23:' + target[0] + '&@16-20:' + target[0].slice(15, 20);
  await query(positionQuery, 'panoid 定位'); report.checks.positionQuery = { query: positionQuery, exactSid: target[0], indexedIntersection: true };
  for (const width of [560, 705, 1280, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
    try {
      await until(() => evaluate(`Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--header-h'))-document.querySelector('header').offsetHeight)<1`), 10000);
    } catch (error) {
      report.checks.viewportFailure = await evaluate(`({requestedWidth:${width},width:innerWidth,headerCss:document.documentElement.style.getPropertyValue('--header-h'),headerHeight:document.querySelector('header').offsetHeight,stats:document.getElementById('stats').textContent,search:document.getElementById('search').value})`);
      throw error;
    }
    const box = await evaluate(`(function(){var r=document.getElementById('search').getBoundingClientRect();return {width:innerWidth,inputLeft:r.left,inputRight:r.right,inputWidth:r.width,headerHeight:document.querySelector('header').offsetHeight};})()`);
    assert(box.inputWidth > 100 && box.inputLeft >= 0 && box.inputRight <= width + 1); report.viewports.push(box);
    if (width === 560 || width === 1280) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(resultRoot, 'viewer-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    }
  }
  const compressed = requests.filter(u => /\.js\.(?:gz|br)(?:\?|$)/.test(u));
  const rawLarge = requests.filter(u => /\/(?:data_(?!meta|districts)[A-Za-z0-9_]+|hidden_pano|grid_all|pano_search_index)\.js(?:\?|$)/.test(u));
  const targetAsset = targetCollection === 'hidden' || targetCollection.startsWith('hidden_') ? 'hidden_pano.js' : 'data_' + targetCollection + '.js';
  assert(compressed.some(u => u.includes('pano_search_index.js' + suffix))); assert(compressed.some(u => u.includes(targetAsset + suffix)));
  assert.equal(rawLarge.length, 0); assert.equal(exceptions.length, 0, exceptions.join('\n'));
  report.checks.nativeCodecs = await evaluate('window.__ASSET_NATIVE_CODECS__');
  report.checks.workerLifecycle = await evaluate('window.__ASSET_WORKERS__');
  if (codec === 'brotli' && forceWorker) {
    assert(report.checks.workerLifecycle.created >= 3, 'Forced WASM decoding was not exercised');
    assert.equal(report.checks.workerLifecycle.active, 0); assert.equal(report.checks.workerLifecycle.created, report.checks.workerLifecycle.terminated);
    assert(report.checks.workerLifecycle.maxActive <= 2);
  }
  report.checks.compressedRequests = compressed.map(u => new URL(u).pathname);
  report.checks.gzipRequests = compressed.filter(u => u.includes('.gz')).map(u => new URL(u).pathname);
  report.checks.brotliRequests = compressed.filter(u => u.includes('.br')).map(u => new URL(u).pathname);
  report.checks.rawLargeRequests = rawLarge; report.checks.runtimeExceptions = exceptions; report.localRequests = localRequests;
  report.checks.responseHeaders = responses;
  report.checks.cspViolations = await evaluate('window.__ASSET_CSP_VIOLATIONS__ || []');
  assert.equal(report.checks.cspViolations.length, 0, 'Observed browser CSP violations');
  report.passed = true;
  fs.writeFileSync(path.join(resultRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, url: pageURL, version: expectedVersion, total: expectedTotal, files: expectedFiles,
    codec, query: target[0], compressedRequests: compressed.length, forcedBrotliWorker: forceWorker, report: path.join(resultRoot, 'report.json') }));
}
main().catch(error => { report.error = error.stack; report.passed = false; fs.writeFileSync(path.join(resultRoot, 'report.json'), JSON.stringify(report, null, 2)); console.error(error); process.exitCode = 1; })
  .finally(async () => { for (const p of pending.values()) clearTimeout(p.timer); if (ws) ws.close(); if (browser) browser.kill(); if (server) await new Promise(r => server.close(r)); });
