/* Lazy Brotli bridge: loading this classic script does not fetch/compile WASM.
 * Only compressed Brotli loads need a decoder; raw source checkouts stay untouched. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = { createDecoder: factory };
  } else {
    root.PanoBrotli = factory({ window: root, document: root.document, URL: root.URL,
      Worker: root.Worker, Blob: root.Blob, DecompressionStream: root.DecompressionStream,
      setTimeout: root.setTimeout.bind(root), clearTimeout: root.clearTimeout.bind(root) });
  }
}(typeof window !== 'undefined' ? window : globalThis, function createDecoder(environment) {
  'use strict';
  var env = environment || {};
  var win = env.window;
  var doc = env.document;
  var workerURL;
  try {
    var page = (doc && doc.baseURI) || (win && win.location && win.location.href);
    var script = doc && doc.currentScript && doc.currentScript.src;
    var base = new env.URL(script || page, page);
    var url = new env.URL('brotli-worker.js', base);
    var pageURL = new env.URL(page);
    if (!/^https?:$/.test(url.protocol) || url.origin !== pageURL.origin || url.username || url.password) {
      throw new Error('同源 HTTP(S) worker URL 不可用');
    }
    workerURL = url.href;
  } catch (error) { /* Raw mode never needs this URL. Fail only on decode. */ }

  function isBytes(value) {
    return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
  }

  async function nativeDecode(input, expectedSize, decoder) {
    var reader;
    try {
      var raw = new Uint8Array(expectedSize);
      var total = 0;
      reader = new env.Blob([input]).stream().pipeThrough(decoder).getReader();
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        if (!isBytes(chunk.value) || chunk.value.byteLength > expectedSize - total) {
          throw new Error('Brotli 解压后的原始大小超出清单。');
        }
        raw.set(chunk.value, total);
        total += chunk.value.byteLength;
      }
      if (total !== expectedSize) throw new Error('Brotli 解压后的原始大小与清单不一致。');
      return raw;
    } catch (error) {
      if (reader) {
        try { await reader.cancel(); } catch (cancelError) { /* Keep original failure. */ }
      }
      throw new Error('Brotli 原生流式解压失败：' + (error && error.message ? error.message : String(error)));
    } finally {
      if (reader) reader.releaseLock();
    }
  }

  function workerDecode(input, expectedSize) {
    return new Promise(function (resolve, reject) {
      if (!workerURL || typeof env.Worker !== 'function') {
        reject(new Error('当前浏览器/WebView 不支持本地 Brotli module Worker 解压；请通过 HTTP(S) 打开并更新浏览器/WebView。'));
        return;
      }
      var worker;
      var timer;
      var settled = false;
      function finish(error, raw) {
        if (settled) return;
        settled = true;
        if (timer !== undefined) env.clearTimeout(timer);
        if (worker) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate(); // Release the dedicated WASM instance and memory on every exit.
        }
        if (error) reject(error); else resolve(raw);
      }
      try {
        worker = new env.Worker(workerURL, { type: 'module', name: 'pano-brotli' });
        worker.onmessage = function (event) {
          var data = event && event.data;
          if (!data || typeof data.error === 'string') {
            finish(new Error(data && data.error || 'Brotli worker 返回无效响应。'));
          } else if (!isBytes(data.raw) || data.raw.byteLength !== expectedSize) {
            finish(new Error('Brotli worker 原始大小与清单不一致。'));
          } else { finish(null, data.raw); }
        };
        worker.onerror = function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          finish(new Error('本地 Brotli Worker/WASM 加载或解压失败；请检查同源资源、CSP worker-src/wasm-unsafe-eval 并更新浏览器/WebView。'));
        };
        worker.onmessageerror = function () { finish(new Error('Brotli worker 数据传输失败。')); };
        if (typeof env.setTimeout === 'function' && typeof env.clearTimeout === 'function') {
          timer = env.setTimeout(function () { finish(new Error('Brotli worker 解压超时，请重试或更新浏览器/WebView。')); }, 120000);
        }
        // Structured clone preserves the caller's buffer; never detach or mutate
        // externally received bytes. The worker transfers the sole final output back.
        worker.postMessage({ compressed: input, expectedSize: expectedSize });
      } catch (error) {
        finish(new Error('无法启动本地 Brotli module Worker；请检查 CSP 并更新浏览器/WebView。'));
      }
    });
  }

  function decode(input, expectedSize) {
    if (!isBytes(input) || input.byteLength > 0xffffffff ||
        !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 0xffffffff) {
      return Promise.reject(new Error('Brotli 输入或预期输出大小无效。'));
    }
    // Probe lazily: standard/future implementations may use 'brotli', while
    // others may accept 'br'. Never retry corrupt native data through a fallback.
    var native;
    if (typeof env.DecompressionStream === 'function' && typeof env.Blob === 'function' &&
        env.Blob.prototype && typeof env.Blob.prototype.stream === 'function') {
      try { native = new env.DecompressionStream('brotli'); } catch (error) {
        try { native = new env.DecompressionStream('br'); } catch (unsupported) { /* Use local WASM. */ }
      }
    }
    if (native) return nativeDecode(input, expectedSize, native);
    return workerDecode(input, expectedSize);
  }

  return { decode: decode };
}));
