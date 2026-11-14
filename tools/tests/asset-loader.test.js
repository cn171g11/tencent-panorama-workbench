const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { gzipSync, brotliCompressSync } = require('node:zlib');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { decodeWithModule } = require('../../city-viewer/brotli-worker.js');
const brotliPromise = import(new URL('../../city-viewer/vendor/brotli-wasm/brotli_wasm.mjs', pathToFileURL(__filename)).href)
  .then(async (brotli) => { await brotli.default(readFileSync(new URL('../../city-viewer/vendor/brotli-wasm/brotli_wasm_bg.wasm', pathToFileURL(__filename)))); return brotli; });
const actualBrotli = { decode: async (input, size) => decodeWithModule(await brotliPromise, input, size) };
const { createLoader } = require('../../city-viewer/asset-loader.js');

// Only fixture generation and the document stub use Node helpers. The loader
// uses Node 24's real fetch Response/Blob/Streams/Web Crypto/DecompressionStream.
const PAGE = 'https://example.test/project/city-viewer/index.html';
const SID = '12345678901234567890123';
const SOURCE = `window.PANO_CITY=window.PANO_CITY||{};window.PANO_CITY.test=[["${SID}",121.123456789012345,31.987654321098765,"高精度路", "2026-11-07",123.45678901234567,0,1,"腾讯"]];`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(source = SOURCE) {
  const raw = Buffer.from(source, 'utf8');
  const gzip = gzipSync(raw, { level: 9 });
  return { raw, gzip };
}
function entry(name, data) {
  return { url: name + '.gz', bytes: data.raw.length, compressedBytes: data.gzip.length,
    sha256: sha(data.raw), gzipSha256: sha(data.gzip) };
}
function manifestFor(files) {
  return { version: 1, codec: 'gzip', files: Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, entry(name, data)])) };
}
function brotliFixture(source = SOURCE) {
  const raw = Buffer.from(source, 'utf8');
  return { raw, brotli: brotliCompressSync(raw) };
}
function brotliManifestFor(files) {
  return { version: 2, codec: 'brotli', files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name,
    { url: name + '.br', bytes: data.raw.length, compressedBytes: data.brotli.length,
      sha256: sha(data.raw), compressedSha256: sha(data.brotli) }])) };
}
function eventBus(target) {
  const listeners = new Map();
  target.addEventListener = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  };
  target.removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
  target.dispatch = (type, event) => {
    for (const callback of [...(listeners.get(type) || [])]) callback(event);
  };
  target.listenerCount = () => [...listeners.values()].reduce((n, callbacks) => n + callbacks.size, 0);
  return target;
}
function harness(options = {}) {
  const brotliMode = options.brotli || options.manifest?.codec === 'brotli';
  const files = options.files || { 'data_test.js': brotliMode ? brotliFixture() : fixture() };
  const blobs = new Map();
  const created = [];
  const revoked = [];
  const fetchCalls = [];
  const scripts = [];
  const stubFailures = [];
  const window = eventBus({ location: { href: options.pageURL || PAGE } });
  if (!options.absentManifest) {
    window.PANO_ASSET_MANIFEST = Object.hasOwn(options, 'manifest') ? options.manifest :
      (brotliMode ? brotliManifestFor(files) : manifestFor(files));
  }
  class StubURL extends URL {
    static createObjectURL(blob) {
      const url = 'blob:https://example.test/pano-test-' + (created.length + 1);
      created.push({ url, blob });
      blobs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) {
      revoked.push(url);
      blobs.delete(url);
    }
  }
  const document = eventBus({
    baseURI: options.baseURI || options.pageURL || PAGE,
    currentScript: options.noCurrentScript ? null : { src: options.loaderURL || new URL('asset-loader.js', PAGE).href },
    createElement: (tag) => {
      assert.equal(tag, 'script');
      return { parentNode: null, src: '', onload: null, onerror: null };
    }
  });
  const context = vm.createContext({ window });
  const head = {
    children: [],
    appendChild(script) {
      scripts.push(script);
      head.children.push(script);
      script.parentNode = head;
      if (options.appendError) throw new Error('stub DOM insertion denied');
      Promise.resolve().then(async () => {
        const data = blobs.has(script.src) ? new Uint8Array(await blobs.get(script.src).arrayBuffer()) :
          files[new URL(script.src).pathname.split('/').pop()]?.raw;
        const run = () => {
          if (!data) { script.onerror?.({ target: script }); return; }
          document.currentScript = script;
          try {
            vm.runInContext(Buffer.from(data).toString('utf8'), context, { filename: script.src });
          } catch (error) {
            window.dispatch('error', { filename: options.blankErrorFilename ? '' : script.src,
              message: error.message, error, target: window });
          } finally { document.currentScript = null; }
          // Browsers may emit load even after a classic script throws.
          script.onload?.({ target: script });
        };
        if (options.execute) await options.execute(script, run, data, { window, document });
        else run();
      }).catch((error) => { stubFailures.push(error); script.onerror?.({ target: script }); });
      return script;
    },
    removeChild(script) {
      const index = head.children.indexOf(script);
      assert.notEqual(index, -1);
      head.children.splice(index, 1);
      script.parentNode = null;
    }
  };
  document.head = head;
  const environment = {
    window, document, Blob, URL: StubURL, crypto: globalThis.crypto, DecompressionStream,
    Brotli: brotliMode ? actualBrotli : undefined,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      const name = new URL(url).pathname.split('/').pop().slice(0, -3);
      const data = files[name];
      return data ? new Response(options.httpDecoded ? data.raw : (brotliMode ? data.brotli : data.gzip),
        { headers: options.headers || {} }) : new Response('', { status: 404 });
    },
    ...options.environment
  };
  const loader = createLoader(environment);
  function assertClean() {
    assert.equal(head.children.length, 0, 'scripts must be removed');
    assert.equal(window.listenerCount(), 0, 'window error listeners must be removed');
    assert.equal(document.listenerCount(), 0, 'CSP listeners must be removed');
    assert.equal(blobs.size, 0, 'all Blob URLs must be revoked');
    assert.equal(revoked.length, created.length, 'revoke each Blob URL exactly once');
    assert.equal(stubFailures.length, 0, 'stub execution must not hide unexpected failures');
  }
  return { loader, window, document, environment, context, files, fetchCalls, scripts, created, revoked, assertClean };
}

test('gzip bytes and both SHA-256 values are verified without rewriting numeric literals or 23-digit IDs', async () => {
  const hashes = [];
  const h = harness({ environment: { crypto: { subtle: { digest: async (algorithm, bytes) => {
    hashes.push(Buffer.from(bytes));
    return globalThis.crypto.subtle.digest(algorithm, bytes);
  } } } } });
  assert.equal(await h.loader.loadScript('data_test.js'), undefined);
  const data = h.files['data_test.js'];
  assert.deepEqual(hashes, [data.gzip, data.raw]);
  assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), data.raw);
  assert.equal(h.created[0].blob.type, 'text/javascript;charset=utf-8');
  const row = h.window.PANO_CITY.test[0];
  assert.equal(row.length, 9);
  assert.equal(row[0], SID);
  assert.equal(row[0].length, 23);
  assert.equal(row[1], 121.123456789012345);
  assert.equal(row[2], 31.987654321098765);
  assert.equal(row[3], '高精度路');
  assert.equal(row[5], 123.45678901234567);
  assert.equal(h.scripts[0].async, true);
  assert.deepEqual(h.fetchCalls[0].init, { mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-cache' });
  assert.equal(h.fetchCalls[0].url, new URL('data_test.js.gz', PAGE).href);
  h.assertClean();
});

test('browser IIFE exposes exactly window.PanoAssets.loadScript returning a Promise', async () => {
  const h = harness();
  Object.assign(h.window, h.environment);
  vm.runInContext(readFileSync(require.resolve('../../city-viewer/asset-loader.js'), 'utf8'), h.context);
  assert.deepEqual(Object.keys(h.window.PanoAssets), ['loadScript']);
  const promise = h.window.PanoAssets.loadScript('data_test.js');
  assert.equal(typeof promise.then, 'function');
  await promise;
  assert.equal(h.window.PANO_CITY.test[0][0], SID);
  h.assertClean();
});

test('HTTP-decoded responses skip gzip decoding and compressed size/hash but still require raw size/hash', async () => {
  const h = harness({ httpDecoded: true,
    headers: { 'Content-Encoding': 'gzip', 'Content-Length': '1' },
    environment: { DecompressionStream: undefined } });
  await h.loader.loadScript('data_test.js');
  assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), h.files['data_test.js'].raw);
  h.assertClean();
});

test('manifest present with missing or inherited entry fails closed without fetching raw data', async () => {
  for (const files of [{}, Object.create({ 'data_test.js': entry('data_test.js', fixture()) })]) {
    const h = harness({ manifest: { version: 1, codec: 'gzip', files } });
    await assert.rejects(h.loader.loadScript('data_test.js'), /清单中缺少.*不会回退/);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('invalid manifest versions, codecs and files are never treated as absent', async () => {
  for (const manifest of [false, {}, { version: 2, codec: 'gzip', files: {} },
    { version: 1, codec: 'br', files: {} }, { version: 1, codec: 'gzip', files: [] }]) {
    const h = harness({ manifest });
    await assert.rejects(h.loader.loadScript('data_test.js'), /清单格式/);
    assert.equal(h.fetchCalls.length, 0);
    h.assertClean();
  }
});

test('manifest metadata requires safe integer byte counts and complete SHA-256 fields', async () => {
  for (const override of [{ bytes: 1.25 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { bytes: -1 },
    { compressedBytes: 0 }, { compressedBytes: '80' }, { sha256: '00' }, { gzipSha256: null }, { url: '' }]) {
    const manifest = manifestFor({ 'data_test.js': fixture() });
    Object.assign(manifest.files['data_test.js'], override);
    const h = harness({ manifest });
    await assert.rejects(h.loader.loadScript('data_test.js'), /清单的大小、SHA-256 或 URL 无效/);
    assert.equal(h.fetchCalls.length, 0);
    h.assertClean();
  }
});

test('compressed byte count is exact, not rounded or taken from HTTP headers', async () => {
  const manifest = manifestFor({ 'data_test.js': fixture() });
  manifest.files['data_test.js'].compressedBytes += 1;
  const h = harness({ manifest });
  await assert.rejects(h.loader.loadScript('data_test.js'), /压缩大小与清单不一致/);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
});

test('gzip SHA mismatch rejects before decompression or execution', async () => {
  const manifest = manifestFor({ 'data_test.js': fixture() });
  manifest.files['data_test.js'].gzipSha256 = '0'.repeat(64);
  let decoders = 0;
  const h = harness({ manifest, environment: { DecompressionStream: class {
    constructor() { decoders += 1; throw new Error('must not decompress corrupt bytes'); }
  } } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /压缩文件 SHA-256 校验失败/);
  assert.equal(decoders, 0);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
});

test('both gzip and HTTP-decoded paths reject an incorrect raw SHA', async () => {
  for (const httpDecoded of [false, true]) {
    const manifest = manifestFor({ 'data_test.js': fixture() });
    manifest.files['data_test.js'].sha256 = '0'.repeat(64);
    const h = harness({ manifest, httpDecoded });
    await assert.rejects(h.loader.loadScript('data_test.js'), /原始文件 SHA-256 校验失败/);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('non-gzip bytes cannot masquerade as an HTTP-decoded response without exact raw size/hash', async () => {
  const data = fixture();
  for (const response of [data.raw.subarray(1), Buffer.alloc(data.raw.length, 0x20)]) {
    const h = harness({ fetch: async () => new Response(response) });
    await assert.rejects(h.loader.loadScript('data_test.js'), /原始大小|原始文件 SHA-256/);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('invalid gzip stream with correct compressed hash is rejected by actual DecompressionStream', async () => {
  const data = fixture();
  data.gzip = data.gzip.subarray(0, data.gzip.length - 5);
  const h = harness({ files: { 'data_test.js': data } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /gzip 解压失败/);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
});

test('gzip expansion is bounded by the original byte count and exact final size', async () => {
  for (const change of [-1, 1]) {
    const manifest = manifestFor({ 'data_test.js': fixture() });
    manifest.files['data_test.js'].bytes += change;
    const h = harness({ manifest });
    await assert.rejects(h.loader.loadScript('data_test.js'), /原始大小/);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('missing gzip/stream support produces a friendly WebView upgrade message', async () => {
  for (const environment of [{ DecompressionStream: undefined },
    { DecompressionStream: class { constructor() { throw new TypeError('gzip unsupported'); } } },
    { Blob: class { constructor() {} } }]) {
    const h = harness({ environment });
    await assert.rejects(h.loader.loadScript('data_test.js'), /浏览器\/WebView.*gzip.*更新/);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('missing or failing crypto is explicit about HTTPS/localhost and does not execute', async () => {
  for (const crypto of [undefined, {}, { subtle: { digest: async () => { throw new Error('not secure'); } } }]) {
    const h = harness({ environment: { crypto } });
    await assert.rejects(h.loader.loadScript('data_test.js'), /SHA-256.*HTTPS\/localhost.*浏览器\/WebView/);
    assert.equal(h.scripts.length, 0);
    if (!crypto?.subtle) assert.equal(h.fetchCalls.length, 0);
    h.assertClean();
  }
});

test('missing fetch, Blob URL and DOM support fail usefully rather than silently falling back', async () => {
  const noBlobURL = class extends URL {};
  // URL inherits static Blob methods on Node, so explicitly mask them.
  noBlobURL.createObjectURL = undefined;
  for (const environment of [{ fetch: undefined }, { URL: noBlobURL }, { Blob: undefined },
    { document: { baseURI: PAGE } }, { URL: undefined }]) {
    const h = harness({ environment });
    await assert.rejects(h.loader.loadScript('data_test.js'), /浏览器\/WebView|页面|脚本目录/);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('HTTP failures reject with status and never load a raw script', async () => {
  const h = harness({ fetch: async () => new Response('missing', { status: 404 }) });
  await assert.rejects(h.loader.loadScript('data_test.js'), /HTTP 404/);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
});

test('network failure removes inflight state so a subsequent request can retry', async () => {
  const data = fixture();
  let attempts = 0;
  const h = harness({ fetch: async () => {
    if (++attempts === 1) throw new TypeError('offline');
    return new Response(data.gzip);
  } });
  const first = h.loader.loadScript('data_test.js');
  await assert.rejects(first, /无法下载压缩资源/);
  const retry = h.loader.loadScript('data_test.js');
  assert.notEqual(first, retry);
  await retry;
  assert.equal(attempts, 2);
  assert.equal(h.window.PANO_CITY.test[0][0], SID);
  h.assertClean();
});

test('same filename shares one inflight Promise, fetch, decode and execution', async () => {
  const started = defer();
  const gate = defer();
  const data = fixture();
  const h = harness({ fetch: async () => { started.resolve(); await gate.promise; return new Response(data.gzip); } });
  const first = h.loader.loadScript('data_test.js');
  const second = h.loader.loadScript('data_test.js');
  assert.equal(first, second);
  await started.promise;
  assert.equal(h.fetchCalls.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(h.scripts.length, 1);
  assert.equal(h.created.length, 1);
  h.assertClean();
});

test('at most two full load pipelines run concurrently, including waiting for asynchronous script execution', async () => {
  const names = ['data_a.js', 'data_b.js', 'data_c.js', 'data_d.js', 'data_e.js'];
  const files = Object.fromEntries(names.map((name) => [name,
    fixture(`window.order=window.order||[];window.order.push('${name}');`)]));
  const started = names.map(defer);
  const network = names.map(defer);
  const inserted = names.map(defer);
  const execution = names.map(defer);
  let downloads = 0;
  let maxDownloads = 0;
  let decoders = 0;
  let maxDecoders = 0;
  class TrackedDecompressionStream {
    constructor(codec) {
      const native = new DecompressionStream(codec);
      const tracker = new TransformStream({
        start() { maxDecoders = Math.max(maxDecoders, ++decoders); },
        flush() { decoders -= 1; }
      });
      this.readable = native.readable.pipeThrough(tracker);
      this.writable = native.writable;
    }
  }
  const h = harness({ files, environment: { DecompressionStream: TrackedDecompressionStream },
    fetch: async (url) => {
      const name = new URL(url).pathname.split('/').pop().slice(0, -3);
      const index = names.indexOf(name);
      maxDownloads = Math.max(maxDownloads, ++downloads);
      started[index].resolve();
      await network[index].promise;
      downloads -= 1;
      return new Response(files[name].gzip);
    },
    execute: async (script, run, bytes) => {
      const name = /push\('([^']+)'\)/.exec(Buffer.from(bytes).toString('utf8'))[1];
      const index = names.indexOf(name);
      inserted[index].resolve();
      await execution[index].promise;
      run();
    }
  });
  const promises = names.map(h.loader.loadScript);
  try {
    await Promise.all([started[0].promise, started[1].promise]);
    assert.equal(h.fetchCalls.length, 2);
    network[0].resolve(); network[1].resolve();
    await Promise.all([inserted[0].promise, inserted[1].promise]);
    assert.equal(h.fetchCalls.length, 2, 'finished downloads still occupy slots until execution finishes');
    execution[0].resolve();
    await started[2].promise;
    assert.equal(h.fetchCalls.length, 3);
    network[2].resolve();
    await inserted[2].promise;
    execution[1].resolve();
    await started[3].promise;
    assert.equal(h.fetchCalls.length, 4);
  } finally {
    for (const gate of [...network, ...execution]) gate.resolve();
    await Promise.all(promises);
  }
  assert.equal(h.window.order.length, names.length);
  assert.ok(maxDownloads <= 2);
  assert.ok(maxDecoders <= 2);
  assert.equal(downloads, 0);
  assert.equal(decoders, 0);
  h.assertClean();
});

test('successful gzip loads are not permanently cached after city data is released', async () => {
  const h = harness();
  const first = h.loader.loadScript('data_test.js');
  await first;
  delete h.window.PANO_CITY.test;
  const second = h.loader.loadScript('data_test.js');
  assert.notEqual(first, second);
  await second;
  assert.equal(h.window.PANO_CITY.test[0][0], SID);
  assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.created.length, 2);
  h.assertClean();
});

test('absent, undefined and null source-checkout manifests use raw scripts without gzip, crypto or fetch', async () => {
  for (const options of [{ absentManifest: true }, { manifest: undefined }, { manifest: null }]) {
    const h = harness({ ...options, environment: { fetch: undefined, crypto: undefined,
      DecompressionStream: undefined, Blob: undefined } });
    await h.loader.loadScript('data_test.js');
    delete h.window.PANO_CITY.test;
    await h.loader.loadScript('data_test.js');
    assert.equal(h.window.PANO_CITY.test[0][0], SID);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.scripts.length, 2);
    assert.equal(h.scripts[0].src, new URL('data_test.js', PAGE).href);
    assert.equal(h.scripts[0].async, true);
    h.assertClean();
  }
});

test('file:// source checkout raw fallback is allowed without secure-context Web Crypto', async () => {
  const pageURL = 'file:///D:/viewer/index.html';
  const h = harness({ pageURL, noCurrentScript: true, manifest: null, environment: { crypto: undefined } });
  await h.loader.loadScript('data_test.js');
  assert.equal(h.scripts[0].src, 'file:///D:/viewer/data_test.js');
  h.assertClean();
});

test('only current-directory .js basenames are accepted', async () => {
  const h = harness();
  for (const name of ['', null, undefined, {}, ['data_test.js'], '../data_test.js',
    'x/data_test.js', 'x\\data_test.js', '/data_test.js', 'https://evil.test/a.js',
    '//evil.test/a.js', 'data_test.js?q=1', 'data_test.js#x', '%2e%2e.js', 'a.js.gz', '.js', 'data test.js']) {
    await assert.rejects(h.loader.loadScript(name), /文件名/);
  }
  assert.equal(h.fetchCalls.length, 0);
  h.assertClean();
});

test('manifest URLs cannot point to external, parent-directory, unrelated, credential or active-content URLs', async () => {
  for (const url of ['https://evil.test/data_test.js.gz', '//evil.test/data_test.js.gz',
    '../data_test.js.gz', 'data_other.js.gz', 'data_test.js', 'javascript:alert(1)',
    'data:text/javascript,alert(1)', 'https://user:password@example.test/project/city-viewer/data_test.js.gz',
    'data_test.js.gz?q=1', 'data_test.js.gz#x']) {
    const manifest = manifestFor({ 'data_test.js': fixture() });
    manifest.files['data_test.js'].url = url;
    const h = harness({ manifest });
    await assert.rejects(h.loader.loadScript('data_test.js'), /URL 必须/);
    assert.equal(h.fetchCalls.length, 0);
    h.assertClean();
  }
});

test('same-origin corresponding absolute and ./ manifest URLs are valid', async () => {
  for (const url of ['./data_test.js.gz', new URL('data_test.js.gz', PAGE).href]) {
    const manifest = manifestFor({ 'data_test.js': fixture() });
    manifest.files['data_test.js'].url = url;
    const h = harness({ manifest });
    await h.loader.loadScript('data_test.js');
    h.assertClean();
  }
});

test('base directory is captured from asset-loader currentScript, falling back to document.baseURI', async () => {
  for (const options of [{ baseURI: 'https://example.test/unrelated/' },
    { noCurrentScript: true, baseURI: PAGE }]) {
    const h = harness(options);
    // currentScript has disappeared by the time the fetch actually runs.
    h.document.currentScript = null;
    await h.loader.loadScript('data_test.js');
    assert.equal(h.fetchCalls[0].url, new URL('data_test.js.gz', PAGE).href);
    h.assertClean();
  }
});

test('off-origin final fetch responses are rejected despite apparently valid bytes', async () => {
  const data = fixture();
  const h = harness({ fetch: async () => ({ ok: true, status: 200,
    url: 'https://evil.test/data_test.js.gz', arrayBuffer: async () => data.gzip }) });
  await assert.rejects(h.loader.loadScript('data_test.js'), /响应不是同源/);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
});

test('runtime errors reject even when load is emitted afterward, clean up and allow retry', async () => {
  const data = fixture('window.attempts=(window.attempts||0)+1;if(window.attempts===1)throw new Error("first execution fails");window.success=true;');
  for (const manifest of [manifestFor({ 'data_test.js': data }), null]) {
    const h = harness({ files: { 'data_test.js': data }, manifest, blankErrorFilename: true });
    await assert.rejects(h.loader.loadScript('data_test.js'), /脚本执行失败.*first execution fails/);
    h.assertClean();
    await h.loader.loadScript('data_test.js');
    assert.equal(h.window.attempts, 2);
    assert.equal(h.window.success, true);
    h.assertClean();
  }
});

test('syntax errors cannot be misreported as a successful onload', async () => {
  const h = harness({ files: { 'data_test.js': fixture('window.PANO_CITY = ;') } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /脚本执行失败/);
  h.assertClean();
});

test('unrelated global window errors do not reject a valid asset', async () => {
  const h = harness({ execute: (script, run, bytes, { window }) => {
    window.dispatch('error', { filename: 'https://example.test/unrelated.js', message: 'unrelated' });
    run();
  } });
  await h.loader.loadScript('data_test.js');
  h.assertClean();
});

test('two executing assets do not consume each other\'s runtime exceptions', async () => {
  const files = { 'data_bad.js': fixture('throw new Error("bad asset");'),
    'data_good.js': fixture('window.good=true;') };
  const h = harness({ files });
  const results = await Promise.allSettled(Object.keys(files).map(h.loader.loadScript));
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /bad asset/);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(h.window.good, true);
  h.assertClean();
});

test('script error events explain CSP and revoke Blob URLs on failure', async () => {
  const h = harness({ execute: (script) => script.onerror?.({ target: script }) });
  await assert.rejects(h.loader.loadScript('data_test.js'), /CSP.*blob:/);
  h.assertClean();
});

test('CSP securitypolicyviolation rejects and cleans up even before script.onerror', async () => {
  const h = harness({ execute: (script, run, bytes, { document }) => {
    document.dispatch('securitypolicyviolation', { effectiveDirective: 'script-src-elem', blockedURI: 'blob' });
    script.onload?.({ target: script });
  } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /CSP 阻止.*blob:/);
  h.assertClean();
});

test('DOM insertion exceptions also remove scripts/listeners and revoke Blob URLs', async () => {
  const h = harness({ appendError: true });
  await assert.rejects(h.loader.loadScript('data_test.js'), /无法插入异步数据脚本.*CSP/);
  h.assertClean();
});

test('report-only CSP violations do not reject an otherwise valid script', async () => {
  const h = harness({ execute: (script, run, bytes, { document }) => {
    document.dispatch('securitypolicyviolation', { disposition: 'report',
      effectiveDirective: 'script-src-elem', blockedURI: 'blob' });
    run();
  } });
  await h.loader.loadScript('data_test.js');
  assert.equal(h.window.PANO_CITY.test[0][0], SID);
  h.assertClean();
});

test('Blob creation failures are friendly, remove inflight state and permit retry', async () => {
  const h = harness();
  const original = h.environment.URL.createObjectURL;
  let attempts = 0;
  h.environment.URL.createObjectURL = (blob) => {
    if (++attempts === 1) throw new TypeError('Blob URLs unavailable temporarily');
    return original(blob);
  };
  await assert.rejects(h.loader.loadScript('data_test.js'), /无法创建 Blob.*浏览器\/WebView.*CSP/);
  h.assertClean();
  await h.loader.loadScript('data_test.js');
  assert.equal(attempts, 2);
  h.assertClean();
});

test('v2 Brotli verifies compressed hash before actual shared WASM decoding and executes exact source bytes', async () => {
  const hashes = [], decoded = [];
  const h = harness({ brotli: true, environment: {
    crypto: { subtle: { digest: async (algorithm, bytes) => { hashes.push(Buffer.from(bytes)); return globalThis.crypto.subtle.digest(algorithm, bytes); } } },
    Brotli: { decode: async (bytes, size) => { decoded.push(Buffer.from(bytes)); assert.equal(hashes.length, 1); return actualBrotli.decode(bytes, size); } }
  } });
  await h.loader.loadScript('data_test.js');
  const data = h.files['data_test.js'];
  assert.deepEqual(hashes, [data.brotli, data.raw]);
  assert.deepEqual(decoded, [data.brotli]);
  assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), data.raw);
  assert.equal(h.window.PANO_CITY.test[0][0], SID);
  assert.equal(h.window.PANO_CITY.test[0][1], 121.123456789012345);
  assert.equal(h.fetchCalls[0].url, new URL('data_test.js.br', PAGE).href);
  h.assertClean();
});

test('v2 HTTP-decoded bytes require exact raw size/hash without headers and never invoke Brotli/WASM', async () => {
  for (const headers of [{}, { 'Content-Encoding': 'br', 'Content-Length': '1' }]) {
    const hashes = [];
    const h = harness({ brotli: true, httpDecoded: true, headers, environment: {
      Brotli: { decode() { assert.fail('HTTP-decoded raw bytes must not invoke WASM'); } },
      crypto: { subtle: { digest: async (algorithm, bytes) => { hashes.push(Buffer.from(bytes)); return globalThis.crypto.subtle.digest(algorithm, bytes); } } }
    } });
    await h.loader.loadScript('data_test.js');
    assert.deepEqual(hashes, [h.files['data_test.js'].raw]);
    h.assertClean();
  }
});

test('v2 Brotli size/hash classification checks compressed bytes even when raw and compressed sizes are equal', async () => {
  const data = brotliFixture('a'.repeat(10));
  assert.equal(data.raw.length, data.brotli.length);
  for (const httpDecoded of [false, true]) {
    let decodes = 0;
    const h = harness({ brotli: true, files: { 'data_test.js': data }, httpDecoded,
      execute: (script) => script.onload?.({ target: script }),
      environment: { Brotli: { decode: async (...args) => { decodes++; return actualBrotli.decode(...args); } } } });
    await h.loader.loadScript('data_test.js');
    assert.equal(decodes, httpDecoded ? 0 : 1);
    assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), data.raw);
    h.assertClean();
  }
});

test('v2 Brotli never trusts Content-Length/Encoding to skip compressed hash and rejects wrong hashes before decoder', async () => {
  const data = brotliFixture();
  const manifest = brotliManifestFor({ 'data_test.js': data });
  manifest.files['data_test.js'].compressedSha256 = '0'.repeat(64);
  let decodes = 0;
  const h = harness({ brotli: true, files: { 'data_test.js': data }, manifest,
    headers: { 'Content-Encoding': 'br', 'Content-Length': String(data.raw.length) },
    environment: { Brotli: { decode() { decodes++; assert.fail('corrupt hash cannot decode'); } } } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /压缩文件 SHA-256/);
  assert.equal(decodes, 0);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
});

test('v2 Brotli compressed and HTTP-decoded paths fail closed on invalid raw hashes or byte counts', async () => {
  for (const httpDecoded of [false, true]) {
    for (const override of [{ sha256: '0'.repeat(64) }, { bytes: 1 }, { bytes: 1000 }]) {
      const data = brotliFixture();
      const manifest = brotliManifestFor({ 'data_test.js': data });
      Object.assign(manifest.files['data_test.js'], override);
      const h = harness({ brotli: true, manifest, files: { 'data_test.js': data }, httpDecoded });
      await assert.rejects(h.loader.loadScript('data_test.js'), /SHA-256|原始大小|压缩大小/);
      assert.equal(h.scripts.length, 0);
      h.assertClean();
    }
  }
});

test('v2 correct compressed hashes still reject actual WASM corruption, truncation, trailing data and overflow', async () => {
  const valid = brotliFixture();
  for (const compressed of [Buffer.from([255, 255, 255, 255]), valid.brotli.subarray(0, -1),
    Buffer.concat([valid.brotli, Buffer.from([0])])]) {
    const data = { raw: valid.raw, brotli: compressed };
    const h = harness({ brotli: true, files: { 'data_test.js': data } });
    await assert.rejects(h.loader.loadScript('data_test.js'), /Brotli 解压失败/);
    assert.equal(h.scripts.length, 0);
    h.assertClean();
  }
});

test('v2 manifest schema strictly requires brotli, compressedSha256 and same-origin corresponding .js.br URL', async () => {
  const data = brotliFixture();
  for (const override of [{ compressedSha256: null }, { compressedSha256: 'ab' }, { compressedBytes: 0 },
    { bytes: 0x100000000 }, { compressedBytes: 0x100000000 }, { url: 'data_test.js.gz' },
    { url: '../data_test.js.br' }, { url: 'https://evil.test/data_test.js.br' }, { url: 'data_test.js.br?q=1' },
    { url: 'data_test.js.br#x' }, { url: 'https://u:p@example.test/project/city-viewer/data_test.js.br' }]) {
    const manifest = brotliManifestFor({ 'data_test.js': data });
    Object.assign(manifest.files['data_test.js'], override);
    const h = harness({ brotli: true, manifest, files: { 'data_test.js': data } });
    await assert.rejects(h.loader.loadScript('data_test.js'), /清单的大小|URL 必须/);
    assert.equal(h.fetchCalls.length, 0);
    h.assertClean();
  }
  const h = harness({ brotli: true, manifest: { version: 2, codec: 'gzip', files: {} } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /清单格式/);
  h.assertClean();
});

test('v2 unknown same-sized bytes never execute or decode and missing decoder remains explicit', async () => {
  const data = brotliFixture();
  const h = harness({ brotli: true, fetch: async () => new Response(Buffer.alloc(data.brotli.length)),
    environment: { Brotli: { decode() { assert.fail('unknown bytes'); } } } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /压缩文件 SHA-256/);
  assert.equal(h.scripts.length, 0);
  h.assertClean();
  const missing = harness({ brotli: true, environment: { Brotli: undefined } });
  await assert.rejects(missing.loader.loadScript('data_test.js'), /本地 Brotli 解码器不可用/);
  missing.assertClean();
});

test('single-read response bound cancels overlarge payloads before hash/decode, and rejects unbounded-only APIs', async () => {
  const data = brotliFixture();
  let cancelled = 0, hashes = 0, reads = 0;
  const h = harness({ brotli: true, fetch: async () => ({ ok: true, body: new ReadableStream({
    pull(controller) { reads++; controller.enqueue(Buffer.alloc(Math.max(data.raw.length, data.brotli.length) + 1)); },
    cancel() { cancelled++; }
  }) }), environment: { crypto: { subtle: { digest() { hashes++; assert.fail('oversized body cannot hash'); } } } } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /大小.*超出清单/);
  assert.equal(cancelled, 1);
  assert.ok(reads <= 2);
  assert.equal(hashes, 0);
  h.assertClean();
  const unbounded = harness({ brotli: true, fetch: async () => ({ ok: true, arrayBuffer() { assert.fail('never unbounded arrayBuffer'); } }) });
  await assert.rejects(unbounded.loader.loadScript('data_test.js'), /有界流式下载.*更新/);
  unbounded.assertClean();
});

test('v2 SHA/decode failures clear inflight state and retry, successes have no completed cache', async () => {
  const data = brotliFixture();
  let requests = 0, decodes = 0;
  const h = harness({ brotli: true, fetch: async () => new Response(++requests === 1 ? Buffer.alloc(data.brotli.length) : data.brotli),
    environment: { Brotli: { decode: async (...args) => { if (++decodes === 1) throw new Error('temporary worker failure'); return actualBrotli.decode(...args); } } } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /SHA-256/);
  await assert.rejects(h.loader.loadScript('data_test.js'), /temporary worker failure/);
  const first = h.loader.loadScript('data_test.js');
  assert.equal(first, h.loader.loadScript('data_test.js'));
  await first;
  delete h.window.PANO_CITY.test;
  const next = h.loader.loadScript('data_test.js');
  assert.notEqual(first, next);
  await next;
  assert.equal(requests, 4);
  assert.equal(decodes, 3);
  assert.equal(h.scripts.length, 2);
  h.assertClean();
});

test('v2 Brotli keeps two full pipelines including script execution, queued snapshot and inflight dedup', async () => {
  const names = ['data_a.js', 'data_b.js', 'data_c.js'];
  const data = brotliFixture('window.executions=(window.executions||0)+1;');
  const files = Object.fromEntries(names.map((name) => [name, data]));
  const inserted = names.map(defer), executeGates = names.map(defer);
  let executions = 0, decodes = 0, active = 0, maximum = 0;
  const h = harness({ brotli: true, files,
    environment: { Brotli: { decode: async (...args) => {
      maximum = Math.max(maximum, ++active); decodes++;
      try { return await actualBrotli.decode(...args); } finally { active--; }
    } } },
    execute: async (script, run) => { const index = executions++; inserted[index].resolve(); await executeGates[index].promise; run(); } });
  const promises = names.map(h.loader.loadScript);
  assert.equal(promises[2], h.loader.loadScript(names[2]));
  try {
    await Promise.all([inserted[0].promise, inserted[1].promise]);
    assert.equal(h.fetchCalls.length, 2);
    h.window.PANO_ASSET_MANIFEST = null;
    executeGates[0].resolve();
    await inserted[2].promise;
    assert.equal(h.fetchCalls.length, 3);
  } finally { executeGates.forEach((gate) => gate.resolve()); await Promise.all(promises); }
  assert.equal(decodes, 3);
  assert.ok(maximum <= 2);
  assert.equal(h.window.executions, 3);
  assert.ok(h.scripts.every((script) => script.src.startsWith('blob:')));
  h.assertClean();
});

test('empty gzip scripts and uppercase manifest hashes are accepted without altering bytes', async () => {
  for (const data of [fixture(''), fixture('\ufeff' + SOURCE + '\r\n')]) {
    const manifest = manifestFor({ 'data_test.js': data });
    manifest.files['data_test.js'].sha256 = manifest.files['data_test.js'].sha256.toUpperCase();
    manifest.files['data_test.js'].gzipSha256 = manifest.files['data_test.js'].gzipSha256.toUpperCase();
    const h = harness({ files: { 'data_test.js': data }, manifest });
    await h.loader.loadScript('data_test.js');
    assert.deepEqual(Buffer.from(await h.created[0].blob.arrayBuffer()), data.raw);
    h.assertClean();
  }
});

test('queued loads snapshot a present manifest and cannot silently switch to raw fallback', async () => {
  const names = ['data_a.js', 'data_b.js', 'data_c.js'];
  const data = fixture('window.executions=(window.executions||0)+1;');
  const files = Object.fromEntries(names.map((name) => [name, data]));
  const gate = defer();
  const started = defer();
  let requests = 0;
  const h = harness({ files, fetch: async () => {
    if (++requests === 2) started.resolve();
    await gate.promise;
    return new Response(data.gzip);
  } });
  const promises = names.map(h.loader.loadScript);
  await started.promise;
  delete h.window.PANO_ASSET_MANIFEST.files['data_c.js'];
  h.window.PANO_ASSET_MANIFEST = null;
  gate.resolve();
  await Promise.all(promises);
  assert.equal(requests, 3);
  assert.equal(h.window.executions, 3);
  assert.ok(h.scripts.every((script) => script.src.startsWith('blob:')));
  h.assertClean();
});

test('failure frees a queue slot, queued assets proceed, and the failed asset can retry', async () => {
  const names = ['data_a.js', 'data_b.js', 'data_c.js'];
  const data = fixture('window.executions=(window.executions||0)+1;');
  const files = Object.fromEntries(names.map((name) => [name, data]));
  const started = names.map(defer);
  const gates = names.map(defer);
  const attempts = [0, 0, 0];
  const h = harness({ files, fetch: async (url) => {
    const name = new URL(url).pathname.split('/').pop().slice(0, -3);
    const index = names.indexOf(name);
    attempts[index] += 1;
    started[index].resolve();
    await gates[index].promise;
    return index === 0 && attempts[0] === 1 ? new Response('', { status: 503 }) : new Response(data.gzip);
  } });
  const settled = Promise.allSettled(names.map(h.loader.loadScript));
  try {
    await Promise.all([started[0].promise, started[1].promise]);
    assert.equal(h.fetchCalls.length, 2);
    gates[0].resolve();
    await started[2].promise;
    assert.equal(h.fetchCalls.length, 3);
  } finally {
    for (const gate of gates) gate.resolve();
  }
  const results = await settled;
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /HTTP 503/);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
  await h.loader.loadScript('data_a.js');
  assert.equal(attempts[0], 2);
  assert.equal(h.window.executions, 3);
  h.assertClean();
});

test('raw fallback requests also deduplicate the inflight Promise', async () => {
  const started = defer();
  const gate = defer();
  const h = harness({ manifest: null, execute: async (script, run) => {
    started.resolve();
    await gate.promise;
    run();
  } });
  const first = h.loader.loadScript('data_test.js');
  const second = h.loader.loadScript('data_test.js');
  assert.equal(first, second);
  await started.promise;
  assert.equal(h.scripts.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  h.assertClean();
});

test('raw-script HTTP/CSP error clears inflight and retries without a completed-load cache', async () => {
  let attempts = 0;
  const h = harness({ manifest: null, execute: (script, run) => {
    if (++attempts === 1) script.onerror?.({ target: script }); else run();
  } });
  await assert.rejects(h.loader.loadScript('data_test.js'), /脚本加载或执行失败/);
  h.assertClean();
  await h.loader.loadScript('data_test.js');
  assert.equal(attempts, 2);
  assert.equal(h.window.PANO_CITY.test[0][0], SID);
  h.assertClean();
});
