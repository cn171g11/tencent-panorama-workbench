/* Lossless, on-demand classic-script loading. No completed-load cache: callers may
 * release PANO_CITY entries and request the same file again. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = { createLoader: factory };
  } else {
    root.PanoAssets = factory({
      window: root,
      document: root.document,
      fetch: root.fetch,
      crypto: root.crypto,
      DecompressionStream: root.DecompressionStream,
      Blob: root.Blob,
      URL: root.URL,
      Brotli: root.PanoBrotli
    });
  }
}(typeof window !== 'undefined' ? window : globalThis, function createLoader(environment) {
  'use strict';
  var env = environment || {};
  var win = env.window;
  var doc = env.document;
  var URLClass = env.URL;
  var BlobClass = env.Blob;
  var inflight = new Map();
  var queue = [];
  var active = 0;
  var baseURL;
  var baseError;
  var own = Object.prototype.hasOwnProperty;

  // Capture currentScript now, not after an asynchronous request has cleared it.
  try {
    if (typeof URLClass !== 'function') throw new Error('URL API 不可用');
    var anchor = doc && doc.currentScript && doc.currentScript.src;
    var pageURL = (doc && doc.baseURI) || (win && win.location && win.location.href);
    baseURL = new URLClass('.', new URLClass(anchor || pageURL, pageURL));
  } catch (error) {
    baseError = new Error('无法确定数据脚本目录；请更新浏览器/WebView 并通过 HTTP(S) 打开查看器。');
  }

  function fail(name, detail, cause) {
    var error = new Error('资源 ' + name + '：' + detail);
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function requireScriptDOM(name) {
    if (!doc || typeof doc.createElement !== 'function' ||
        !win || typeof win.addEventListener !== 'function' ||
        typeof win.removeEventListener !== 'function') {
      throw fail(name, '当前浏览器/WebView 不支持安全的异步脚本加载，请更新浏览器/WebView。');
    }
    var parent = doc.head || doc.body || doc.documentElement;
    if (!parent || typeof parent.appendChild !== 'function') {
      throw fail(name, '页面尚未准备好加载数据脚本。');
    }
    return parent;
  }

  function prepare(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(name)) {
      throw new Error('数据文件名必须是当前目录中的 .js 文件名，不能包含路径、外链或查询参数。');
    }
    if (baseError) throw baseError;
    requireScriptDOM(name);
    var manifest = win.PANO_ASSET_MANIFEST;
    if (manifest === undefined || manifest === null) {
      return { name: name, rawURL: new URLClass(name, baseURL).href };
    }
    var isGzip = manifest && manifest.version === 1 && manifest.codec === 'gzip';
    var isBrotli = manifest && manifest.version === 2 && manifest.codec === 'brotli';
    if ((!isGzip && !isBrotli) ||
        !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw fail(name, '压缩资源清单格式不受支持（需要 version: 1/codec: gzip 或 version: 2/codec: brotli）。');
    }
    if (!own.call(manifest.files, name)) {
      throw fail(name, '压缩资源清单中缺少此文件；为避免混用版本，不会回退到原始脚本。');
    }
    var entry = manifest.files[name];
    var compressedHash = entry && (isGzip ? entry.gzipSha256 : entry.compressedSha256);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 0xffffffff ||
        !Number.isSafeInteger(entry.compressedBytes) || entry.compressedBytes < (isGzip ? 2 : 1) || entry.compressedBytes > 0xffffffff ||
        typeof entry.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(entry.sha256) ||
        typeof compressedHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(compressedHash) ||
        typeof entry.url !== 'string' || !entry.url) {
      throw fail(name, '压缩资源清单的大小、SHA-256 或 URL 无效。');
    }
    var url;
    try { url = new URLClass(entry.url, baseURL); } catch (error) {
      throw fail(name, '压缩资源 URL 无效。', error);
    }
    var expected = new URLClass(name + (isGzip ? '.gz' : '.br'), baseURL);
    if (!/^https?:$/.test(url.protocol) || url.origin !== baseURL.origin ||
        url.pathname !== expected.pathname || url.username || url.password || url.search || url.hash) {
      throw fail(name, '压缩资源 URL 必须是同源、同目录的对应 ' + (isGzip ? '.js.gz' : '.js.br') + ' 文件。');
    }
    // Snapshot only validated metadata: queued requests cannot change to raw fallback.
    return { name: name, url: url.href, bytes: entry.bytes, compressedBytes: entry.compressedBytes,
      codec: isGzip ? 'gzip' : 'brotli', sha256: entry.sha256.toLowerCase(),
      compressedSha256: compressedHash.toLowerCase() };
  }

  function isBytes(value) {
    return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
  }

  async function hashBytes(bytes, name) {
    var digest;
    try { digest = await env.crypto.subtle.digest('SHA-256', bytes); } catch (error) {
      throw fail(name, '无法进行 SHA-256 校验；请使用 HTTPS/localhost 并更新浏览器/WebView。', error);
    }
    return Array.from(new Uint8Array(digest), function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }

  async function checkHash(bytes, expected, name, kind) {
    if (await hashBytes(bytes, name) !== expected) {
      throw fail(name, kind + ' SHA-256 校验失败，文件可能损坏或版本不一致。');
    }
  }

  async function readResponse(response, spec) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw fail(spec.name, '当前浏览器/WebView 不支持有界流式下载，请更新浏览器/WebView。');
    }
    var reader = response.body.getReader();
    var chunks = [];
    var total = 0;
    var maximum = Math.max(spec.bytes, spec.compressedBytes);
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        if (!isBytes(chunk.value) || chunk.value.byteLength > maximum - total) {
          throw fail(spec.name, '响应的原始大小或压缩大小超出清单，文件可能损坏。');
        }
        total += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
      var bytes = new Uint8Array(total);
      var offset = 0;
      chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
      chunks.length = 0;
      return bytes;
    } catch (error) {
      try { await reader.cancel(); } catch (cancelError) { /* Keep original failure. */ }
      throw error;
    } finally {
      chunks.length = 0;
      reader.releaseLock();
    }
  }

  async function decompress(bytes, spec) {
    if (spec.codec === 'brotli') {
      var brotli = env.Brotli || (win && win.PanoBrotli);
      if (!brotli || typeof brotli.decode !== 'function') {
        throw fail(spec.name, '本地 Brotli 解码器不可用，请确认 brotli-decoder.js 已加载并更新浏览器/WebView。');
      }
      try {
        var decoded = await brotli.decode(bytes, spec.bytes);
        if (!isBytes(decoded) || decoded.byteLength !== spec.bytes) {
          throw new Error('Brotli 解压后的原始大小与清单不一致。');
        }
        return decoded;
      } catch (error) { throw fail(spec.name, 'Brotli 解压失败：' + (error && error.message || '压缩文件可能损坏。'), error); }
    }
    if (typeof env.DecompressionStream !== 'function' ||
        !BlobClass.prototype || typeof BlobClass.prototype.stream !== 'function') {
      throw fail(spec.name, '当前浏览器/WebView 不支持 gzip 解压（DecompressionStream），请更新浏览器/WebView。');
    }
    var reader;
    var chunks = [];
    var total = 0;
    try {
      var decoder;
      try { decoder = new env.DecompressionStream('gzip'); } catch (error) {
        throw fail(spec.name, '当前浏览器/WebView 不支持 gzip 解压，请更新浏览器/WebView。', error);
      }
      var source = new BlobClass([bytes]).stream();
      if (!source || typeof source.pipeThrough !== 'function') {
        throw fail(spec.name, '当前浏览器/WebView 不支持流式 gzip 解压，请更新浏览器/WebView。');
      }
      reader = source.pipeThrough(decoder).getReader();
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        // Bound expansion by the exact manifest size, including malicious gzip files.
        if (total > spec.bytes) throw fail(spec.name, '解压后的原始大小超出清单，文件可能损坏。');
        chunks.push(chunk.value);
      }
      if (total !== spec.bytes) throw fail(spec.name, '解压后的原始大小与清单不一致。');
      var raw = new Uint8Array(total);
      var offset = 0;
      chunks.forEach(function (chunk) { raw.set(chunk, offset); offset += chunk.byteLength; });
      return raw;
    } catch (error) {
      if (reader) {
        try { await reader.cancel(); } catch (cancelError) { /* Preserve the original failure. */ }
      }
      if (error && /^资源 /.test(error.message)) throw error;
      throw fail(spec.name, 'gzip 解压失败，压缩文件可能损坏。', error);
    } finally {
      if (reader) reader.releaseLock();
    }
  }

  function executeScript(name, src, isBlob) {
    return new Promise(function (resolve, reject) {
      var script;
      var settled = false;
      var errorAttached = false;
      var policyAttached = false;
      var parent;
      function finish(error) {
        if (settled) return;
        settled = true;
        if (errorAttached) win.removeEventListener('error', onRuntimeError, true);
        if (policyAttached) doc.removeEventListener('securitypolicyviolation', onPolicyError, true);
        if (script) {
          script.onload = null;
          script.onerror = null;
          if (script.parentNode) script.parentNode.removeChild(script);
        }
        if (error) reject(error); else resolve();
      }
      function onRuntimeError(event) {
        // Two simultaneous scripts must not consume each other's window errors.
        if (!event || (event.filename !== src && event.target !== script && doc.currentScript !== script)) return;
        finish(fail(name, '脚本执行失败：' + (event.message || '语法或运行时错误。'), event.error));
      }
      function onPolicyError(event) {
        // Report-only policies do not block execution and must not fail a load.
        if (!event || event.disposition === 'report' ||
            !/^script-src(?:-|$)/.test(event.effectiveDirective || event.violatedDirective || '')) return;
        if (event.blockedURI === src || (isBlob && (event.blockedURI === 'blob' || event.blockedURI === 'blob:'))) {
          finish(fail(name, 'CSP 阻止数据脚本执行；' + (isBlob ?
            '压缩资源需要页面 script-src 允许 blob:。' : '请检查页面 script-src 规则。')));
        }
      }
      try {
        parent = requireScriptDOM(name);
        script = doc.createElement('script');
        script.async = true;
        script.type = 'text/javascript';
        script.charset = 'utf-8';
        script.onload = function () { finish(); };
        script.onerror = function () {
          finish(fail(name, '脚本加载或执行失败，请检查网络、脚本语法及 CSP' +
            (isBlob ? '（script-src 需要允许 blob:）。' : '。')));
        };
        win.addEventListener('error', onRuntimeError, true);
        errorAttached = true;
        if (typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function') {
          doc.addEventListener('securitypolicyviolation', onPolicyError, true);
          policyAttached = true;
        }
        script.src = src;
        parent.appendChild(script);
      } catch (error) {
        finish(fail(name, '无法插入异步数据脚本，请检查 CSP 与浏览器/WebView 支持。', error));
      }
    });
  }

  async function load(spec) {
    if (spec.rawURL) return executeScript(spec.name, spec.rawURL, false);
    if (typeof env.fetch !== 'function') {
      throw fail(spec.name, '当前浏览器/WebView 不支持 fetch，请更新浏览器/WebView。');
    }
    if (!env.crypto || !env.crypto.subtle || typeof env.crypto.subtle.digest !== 'function') {
      throw fail(spec.name, '当前浏览器/WebView 不支持 SHA-256 校验；请使用 HTTPS/localhost 并更新浏览器/WebView。');
    }
    if (typeof BlobClass !== 'function' || typeof URLClass.createObjectURL !== 'function' ||
        typeof URLClass.revokeObjectURL !== 'function') {
      throw fail(spec.name, '当前浏览器/WebView 不支持 Blob 脚本加载，请更新浏览器/WebView。');
    }
    var response;
    var received;
    try {
      // Revalidate stable filenames so a fresh manifest cannot use a stale cached payload.
      response = await env.fetch.call(win, spec.url, { mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-cache' });
      if (!response || !response.ok || response.type === 'opaque') {
        throw fail(spec.name, '压缩资源请求失败（HTTP ' + (response && response.status) + '）。');
      }
      if (response.url && response.url !== spec.url) {
        throw fail(spec.name, '压缩资源响应不是同源 URL 或不是对应的压缩文件。');
      }
      received = await readResponse(response, spec);
    } catch (error) {
      if (error && /^资源 /.test(error.message)) throw error;
      throw fail(spec.name, '无法下载压缩资源，请检查网络后重试。', error);
    }
    var raw;
    var rawHashChecked = false;
    // Brotli has no magic bytes. Classify only by exact size AND hash, never by
    // Content-Encoding/Content-Length (fetch may already have decoded the body).
    if (spec.codec === 'brotli') {
      var isCompressedSize = received.byteLength === spec.compressedBytes;
      var isRawSize = received.byteLength === spec.bytes;
      if (!isCompressedSize && !isRawSize) {
        throw fail(spec.name, '原始大小或压缩大小与清单不一致。');
      }
      var receivedHash = await hashBytes(received, spec.name);
      if (isCompressedSize && receivedHash === spec.compressedSha256) {
        raw = await decompress(received, spec);
      } else if (isRawSize && receivedHash === spec.sha256) {
        raw = received;
        rawHashChecked = true;
      } else {
        throw fail(spec.name, (isCompressedSize ? '压缩文件' : '原始文件') + ' SHA-256 校验失败，文件可能损坏或版本不一致。');
      }
    } else if (received[0] === 0x1f && received[1] === 0x8b) {
      if (received.byteLength !== spec.compressedBytes) throw fail(spec.name, '压缩大小与清单不一致。');
      await checkHash(received, spec.compressedSha256, spec.name, '压缩文件');
      raw = await decompress(received, spec);
    } else {
      raw = received;
      if (raw.byteLength !== spec.bytes) throw fail(spec.name, '原始大小与清单不一致（响应可能已被 HTTP 解压或已损坏）。');
    }
    if (!rawHashChecked) await checkHash(raw, spec.sha256, spec.name, '原始文件');
    received = null;
    // Keep exact source bytes, including numeric literals and string IDs. No
    // JSON parse/stringify, coordinate rounding, TextDecoder, eval or new Function.
    var objectURL;
    try {
      try {
        objectURL = URLClass.createObjectURL(new BlobClass([raw], { type: 'text/javascript;charset=utf-8' }));
      } catch (error) {
        throw fail(spec.name, '无法创建 Blob 数据脚本，请更新浏览器/WebView 并检查 CSP。', error);
      }
      await executeScript(spec.name, objectURL, true);
    } finally {
      if (objectURL) URLClass.revokeObjectURL(objectURL);
    }
  }

  function drain() {
    while (active < 2 && queue.length) {
      var next = queue.shift();
      active += 1;
      start(next);
    }
  }

  function start(item) {
    function finish(error) {
      inflight.delete(item.name);
      active -= 1;
      drain();
      if (error) item.reject(error); else item.resolve();
    }
    Promise.resolve().then(function () { return load(item.spec); }).then(function () {
      finish();
    }, function (error) { finish(error); });
  }

  function loadScript(rawFileName) {
    if (inflight.has(rawFileName)) return inflight.get(rawFileName);
    var spec;
    try { spec = prepare(rawFileName); } catch (error) { return Promise.reject(error); }
    var promise = new Promise(function (resolve, reject) {
      queue.push({ name: rawFileName, spec: spec, resolve: resolve, reject: reject });
    });
    inflight.set(rawFileName, promise);
    drain();
    return promise;
  }

  return { loadScript: loadScript };
}));
