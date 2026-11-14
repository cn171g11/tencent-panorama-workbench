/* Dedicated local module-worker. The same bounded core is exported for Node
 * fixtures; no one-shot decoder or asset-source text conversion is used. */
(function (root) {
  'use strict';
  var CHUNK_SIZE = 64 * 1024;
  var MAX_SIZE = 0xffffffff;

  function validate(input, expectedSize) {
    if (!(input instanceof Uint8Array) || input.byteLength > MAX_SIZE ||
        !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_SIZE) {
      throw new Error('Brotli 输入或预期输出大小无效。');
    }
  }

  function decodeWithModule(brotli, input, expectedSize) {
    validate(input, expectedSize);
    if (!brotli || typeof brotli.DecompressStream !== 'function') {
      throw new Error('本地 Brotli WASM 流式 API 不可用。');
    }
    // Only the exact approved output is allocated. Input and WASM output buffers
    // are limited to 64 KiB, even when one compressed chunk expands enormously.
    var output = new Uint8Array(expectedSize);
    var stream;
    var offset = 0;
    var total = 0;
    var steps = 0;
    try {
      stream = new brotli.DecompressStream();
      while (true) {
        if (++steps > input.byteLength + expectedSize + 2) {
          throw new Error('Brotli 解压迭代次数超出有界限制。');
        }
        var end = Math.min(input.byteLength, offset + CHUNK_SIZE);
        var result = null;
        try {
          var limit = Math.min(CHUNK_SIZE, expectedSize - total + 1);
          result = stream.decompress(input.subarray(offset, end), limit);
          var consumed = result.input_offset;
          var chunk = result.buf; // Upstream getter returns an owned copy.
          var code = result.code;
          if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > end - offset ||
              !(chunk instanceof Uint8Array) || chunk.byteLength > limit) {
            throw new Error('Brotli 流式解码返回无效的输入/输出偏移。');
          }
          offset += consumed;
          if (chunk.byteLength > expectedSize - total) {
            throw new Error('Brotli 解压后的原始大小超出清单。');
          }
          output.set(chunk, total);
          total += chunk.byteLength;
          if (code === 1) {
            if (offset !== input.byteLength) throw new Error('Brotli 压缩流存在未消费的尾随字节。');
            if (total !== expectedSize || stream.total_out() !== total) {
              throw new Error('Brotli 解压后的原始大小与清单不一致。');
            }
            return output;
          }
          if (code !== 2 && code !== 3) throw new Error('Brotli 流式解码状态无效。');
          if (consumed === 0 && chunk.byteLength === 0) throw new Error('Brotli 解压无进展，压缩流可能截断或损坏。');
          if (code === 2) {
            if (offset !== end) throw new Error('Brotli 需要更多输入但未消费当前输入。');
            if (offset === input.byteLength) throw new Error('Brotli 压缩流截断，需要更多输入。');
          }
        } finally {
          if (result) result.free();
        }
      }
    } finally {
      if (stream) stream.free();
    }
  }

  var WASM_BYTES = 1056860;
  var WASM_SHA256 = '9ef0a025046bf7d87b7cdb8eac3f73a5c8fea2f1adb848cc9768345573fcd8a9';

  async function loadVerifiedWasm(environment, wasmURL) {
    var response = await environment.fetch(wasmURL.href, {
      mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-cache'
    });
    if (!response || !response.ok || response.type === 'opaque' ||
        (response.url && response.url !== wasmURL.href) || !response.body ||
        typeof response.body.getReader !== 'function') {
      throw new Error('本地 Brotli WASM 请求失败或响应 URL/流式 API 无效。');
    }
    var bytes = new Uint8Array(WASM_BYTES);
    var offset = 0;
    var reader = response.body.getReader();
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > WASM_BYTES - offset) {
          throw new Error('本地 Brotli WASM 大小超出固定版本。');
        }
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
      if (offset !== WASM_BYTES) throw new Error('本地 Brotli WASM 大小与固定版本不一致。');
      var digest = await environment.crypto.subtle.digest('SHA-256', bytes);
      var hash = Array.from(new Uint8Array(digest), function (value) {
        return value.toString(16).padStart(2, '0');
      }).join('');
      if (hash !== WASM_SHA256) throw new Error('本地 Brotli WASM SHA-256 与固定版本不一致。');
      return bytes;
    } catch (error) {
      try { await reader.cancel(); } catch (cancelError) { /* Keep original error. */ }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { decodeWithModule: decodeWithModule, loadVerifiedWasm: loadVerifiedWasm };
    return;
  }

  // One request per dedicated worker: the parent always terminates the worker,
  // releasing the WASM instance/memory rather than retaining a large high-water mark.
  var started = false;
  root.onmessage = async function (event) {
    if (started) return;
    started = true;
    try {
      var request = event.data;
      validate(request && request.compressed, request && request.expectedSize);
      var moduleURL = new URL('./vendor/brotli-wasm/brotli_wasm.mjs', root.location.href);
      var wasmURL = new URL('./vendor/brotli-wasm/brotli_wasm_bg.wasm', root.location.href);
      if (!/^https?:$/.test(moduleURL.protocol) || moduleURL.origin !== root.location.origin) {
        throw new Error('Brotli WASM 必须通过 HTTP(S) 从查看器同源加载。');
      }
      var brotli = await import(moduleURL.href);
      var wasmBytes = await loadVerifiedWasm(root, wasmURL);
      await brotli.default(wasmBytes);
      wasmBytes = null;
      var raw = decodeWithModule(brotli, request.compressed, request.expectedSize);
      root.postMessage({ raw: raw }, [raw.buffer]);
    } catch (error) {
      root.postMessage({ error: 'Brotli 解压失败：' + (error && error.message ? error.message : String(error)) });
    }
  };
}(typeof globalThis !== 'undefined' ? globalThis : self));
