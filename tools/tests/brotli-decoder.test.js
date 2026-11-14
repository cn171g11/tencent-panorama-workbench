const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { brotliCompressSync, brotliDecompressSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { createDecoder } = require('../../city-viewer/brotli-decoder.js');
const { decodeWithModule, loadVerifiedWasm } = require('../../city-viewer/brotli-worker.js');
const WASM_URL = new URL('../../city-viewer/vendor/brotli-wasm/brotli_wasm_bg.wasm', pathToFileURL(__filename));
const wasmBytes = readFileSync(WASM_URL);
const brotliPromise = import(new URL('../../city-viewer/vendor/brotli-wasm/brotli_wasm.mjs', pathToFileURL(__filename)).href)
  .then(async (brotli) => { await brotli.default(wasmBytes); return brotli; });
const PAGE = 'https://example.test/project/city-viewer/index.html';
const environment = (Worker, extra = {}) => ({ window: { location: { href: PAGE } },
  document: { baseURI: PAGE, currentScript: { src: new URL('brotli-decoder.js', PAGE).href } },
  Worker, URL, Blob, DecompressionStream: undefined, setTimeout, clearTimeout, ...extra });

function trackedModule(brotli) {
  const stats = { streams: 0, streamFrees: 0, results: 0, resultFrees: 0, inputMaximum: 0, outputMaximum: 0 };
  return { stats, DecompressStream: class {
    constructor() { this.stream = new brotli.DecompressStream(); stats.streams++; }
    total_out() { return this.stream.total_out(); }
    free() { stats.streamFrees++; this.stream.free(); }
    decompress(input, size) {
      stats.inputMaximum = Math.max(stats.inputMaximum, input.length);
      stats.outputMaximum = Math.max(stats.outputMaximum, size);
      const result = this.stream.decompress(input, size);
      stats.results++;
      return { get input_offset() { return result.input_offset; }, get code() { return result.code; },
        get buf() { return result.buf; }, free() { stats.resultFrees++; result.free(); } };
    }
  } };
}

function workerHarness(mode = 'success') {
  const workers = [];
  class FixtureWorker {
    constructor(url, options) { this.url = url; this.options = options; this.terminated = 0; workers.push(this); }
    terminate() { this.terminated++; }
    postMessage(request, transfer) {
      this.request = request;
      assert.equal(transfer, undefined, 'caller buffer must not be detached');
      const input = new Uint8Array(request.compressed); // Model worker structured-clone isolation.
      Promise.resolve().then(async () => {
        if (mode === 'error') { this.onerror?.({ preventDefault() {} }); return; }
        if (mode === 'messageerror') { this.onmessageerror?.({}); return; }
        if (mode === 'invalid') { this.onmessage?.({ data: { raw: new Uint8Array(1) } }); return; }
        try {
          const raw = decodeWithModule(await brotliPromise, input, request.expectedSize);
          this.onmessage?.({ data: { raw } });
        } catch (error) { this.onmessage?.({ data: { error: error.message } }); }
      });
    }
  }
  return { workers, decoder: createDecoder(environment(FixtureWorker)) };
}

test('actual vendored web WASM streaming matches native Brotli across empty, UTF-8 and multi-chunk fixtures', async () => {
  const rawLarge = Buffer.alloc(512 * 1024);
  let state = 0x12345678;
  for (let i = 0; i < rawLarge.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; rawLarge[i] = state & 255; }
  for (const raw of [Buffer.alloc(0), Buffer.from('\ufeffwindow.PANO_CITY=[["12345678901234567890123",121.123456789012345,"中文"]];\r\n'),
    Buffer.alloc(300000, 0x61), rawLarge]) {
    const compressed = brotliCompressSync(raw);
    const before = Buffer.from(compressed);
    const module = trackedModule(await brotliPromise);
    const decoded = decodeWithModule(module, compressed, raw.length);
    assert.deepEqual(Buffer.from(decoded), brotliDecompressSync(compressed));
    assert.deepEqual(Buffer.from(decoded), raw);
    assert.deepEqual(compressed, before);
    assert.equal(module.stats.streams, module.stats.streamFrees);
    assert.equal(module.stats.results, module.stats.resultFrees);
    assert.ok(module.stats.inputMaximum <= 65536);
    assert.ok(module.stats.outputMaximum <= 65536);
    if (raw.length > 65536) assert.ok(module.stats.results > 1);
  }
});

test('actual WASM rejects corrupt, truncated, trailing, overflow and incorrect exact output sizes and frees resources', async () => {
  const raw = Buffer.from('真实流式解码 '.repeat(10000));
  const compressed = brotliCompressSync(raw);
  const cases = [
    [Buffer.from([0xff, 0xff, 0xff, 0xff]), raw.length, /./],
    [compressed.subarray(0, compressed.length - 1), raw.length, /截断|无进展/],
    [Buffer.concat([compressed, Buffer.from([0])]), raw.length, /尾随/],
    [compressed, raw.length - 1, /大小超出/],
    [compressed, raw.length + 1, /大小与清单不一致/]
  ];
  for (const [input, size, pattern] of cases) {
    const module = trackedModule(await brotliPromise);
    assert.throws(() => decodeWithModule(module, input, size), pattern);
    assert.equal(module.stats.streams, module.stats.streamFrees);
    assert.equal(module.stats.results, module.stats.resultFrees);
  }
});

test('stream no-progress, invalid status/offset, buffer getter and decompression exceptions are freed deterministically', () => {
  for (const mode of ['no-progress', 'code', 'offset', 'getter', 'decompress']) {
    let streamFrees = 0, resultFrees = 0;
    const module = { DecompressStream: class {
      free() { streamFrees++; }
      total_out() { return 0; }
      decompress() {
        if (mode === 'decompress') throw new Error('decode failed');
        return { input_offset: mode === 'offset' ? 2 : 0, code: mode === 'code' ? 9 : 3,
          get buf() { if (mode === 'getter') throw new Error('getter failed'); return new Uint8Array(0); },
          free() { resultFrees++; } };
      }
    } };
    assert.throws(() => decodeWithModule(module, new Uint8Array([1]), 0));
    assert.equal(streamFrees, 1);
    assert.equal(resultFrees, mode === 'decompress' ? 0 : 1);
  }
});

test('an exception after a successful stream iteration never frees the previous result twice', () => {
  let calls = 0, resultFrees = 0, streamFrees = 0;
  const module = { DecompressStream: class {
    free() { streamFrees++; }
    decompress() {
      if (++calls === 2) throw new Error('second iteration fails');
      return { input_offset: 0, code: 3, buf: new Uint8Array([1]), free() { resultFrees++; } };
    }
  } };
  assert.throws(() => decodeWithModule(module, new Uint8Array([1]), 2), /second iteration/);
  assert.equal(resultFrees, 1);
  assert.equal(streamFrees, 1);
});

test('dedicated fallback worker runs the actual shared WASM core, preserves input, and terminates on success/failure/retry', async () => {
  const h = workerHarness();
  const raw = Buffer.from('fixture '.repeat(30000));
  const compressed = brotliCompressSync(raw);
  const before = Buffer.from(compressed);
  await assert.rejects(h.decoder.decode(compressed.subarray(0, compressed.length - 1), raw.length), /截断|无进展/);
  assert.deepEqual(Buffer.from(await h.decoder.decode(compressed, raw.length)), raw);
  assert.deepEqual(compressed, before);
  assert.equal(h.workers.length, 2);
  for (const worker of h.workers) {
    assert.equal(worker.terminated, 1);
    assert.equal(worker.url, new URL('brotli-worker.js', PAGE).href);
    assert.deepEqual(worker.options, { type: 'module', name: 'pano-brotli' });
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
    assert.equal(worker.onmessageerror, null);
  }
});

test('worker startup, runtime, message-transfer, invalid response and timeout errors clean up', async () => {
  for (const mode of ['error', 'messageerror', 'invalid']) {
    const h = workerHarness(mode);
    await assert.rejects(h.decoder.decode(new Uint8Array([1]), 0), /Brotli/);
    assert.equal(h.workers[0].terminated, 1);
  }
  let terminated = 0, timeoutCallback;
  const decoder = createDecoder(environment(class { postMessage() {} terminate() { terminated++; } }, {
    setTimeout(callback) { timeoutCallback = callback; return 10; }, clearTimeout(id) { assert.equal(id, 10); }
  }));
  const pending = decoder.decode(new Uint8Array([1]), 0);
  timeoutCallback();
  await assert.rejects(pending, /超时/);
  assert.equal(terminated, 1);
  await assert.rejects(createDecoder(environment(class { constructor() { throw new Error('blocked'); } }))
    .decode(new Uint8Array([1]), 0), /CSP.*更新/);
});

test('native brotli support bypasses workers and native corruption never falls back', async () => {
  const raw = Buffer.from('native path');
  const compressed = brotliCompressSync(raw);
  const probed = [];
  const decoder = createDecoder(environment(class { constructor() { throw new Error('must not fetch WASM'); } }, {
    DecompressionStream: class {
      constructor(codec) { probed.push(codec); assert.equal(codec, 'brotli'); return new DecompressionStream(codec); }
    }
  }));
  assert.deepEqual(Buffer.from(await decoder.decode(compressed, raw.length)), raw);
  await assert.rejects(decoder.decode(compressed.subarray(0, -1), raw.length), /原生流式解压失败/);
  await assert.rejects(decoder.decode(Buffer.concat([compressed, Buffer.from([0])]), raw.length), /原生流式解压失败/);
  assert.deepEqual(probed, ['brotli', 'brotli', 'brotli']);
});

test('both native names are probed before actual fallback, while unsupported Worker and invalid inputs fail clearly', async () => {
  const h = workerHarness();
  const probes = [];
  const decoder = createDecoder(environment(h.workers.constructor, { Worker: undefined, DecompressionStream: class {
    constructor(codec) { probes.push(codec); throw new TypeError('unsupported'); }
  } }));
  await assert.rejects(decoder.decode(new Uint8Array([1]), 0), /HTTP\(S\).*更新/);
  assert.deepEqual(probes, ['brotli', 'br']);
  for (const [input, size] of [[[], 0], [new Uint8Array(0), -1], [new Uint8Array(0), 0x100000000]]) {
    await assert.rejects(h.decoder.decode(input, size), /大小无效/);
  }
});

test('browser classic bridge exposes only decode and remains completely lazy including raw file mode', () => {
  let starts = 0;
  const window = { location: { href: 'file:///D:/viewer/index.html' }, URL, Blob,
    Worker: class { constructor() { starts++; } }, setTimeout, clearTimeout };
  window.document = { baseURI: window.location.href, currentScript: { src: 'file:///D:/viewer/brotli-decoder.js' } };
  vm.runInNewContext(readFileSync(require.resolve('../../city-viewer/brotli-decoder.js'), 'utf8'), { window });
  assert.deepEqual(Object.keys(window.PanoBrotli), ['decode']);
  assert.equal(starts, 0);
});

test('fixed WASM bytes and SHA are verified with exact local fetch options before init', async () => {
  const url = new URL('vendor/brotli-wasm/brotli_wasm_bg.wasm', PAGE);
  const calls = [];
  const bytes = await loadVerifiedWasm({ crypto: globalThis.crypto, fetch: async (...args) => {
    calls.push(args); return new Response(wasmBytes);
  } }, url);
  assert.deepEqual(Buffer.from(bytes), wasmBytes);
  assert.deepEqual(calls, [[url.href, { mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-cache' }]]);
  for (const payload of [wasmBytes.subarray(0, -1), Buffer.concat([wasmBytes, Buffer.from([0])]), Buffer.alloc(wasmBytes.length)]) {
    await assert.rejects(loadVerifiedWasm({ crypto: globalThis.crypto, fetch: async () => new Response(payload) }, url), /大小|SHA-256/);
  }
  await assert.rejects(loadVerifiedWasm({ fetch: async () => ({ ok: true, url: 'https://evil.test/decoder.wasm' }) }, url), /请求失败/);
});
