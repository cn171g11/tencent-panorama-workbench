#!/usr/bin/env node
'use strict';

// Native Brotli only: bounded streams, no packages or whole-file buffers.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');
const CHUNK = 64 * 1024;

function argumentsOf(argv) {
  const result = {};
  const allowed = new Set(['mode', 'source', 'output', 'quality', 'lgwin', 'bytes', 'sha256']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!allowed.has(key) || result[key] !== undefined || argv[i + 1] === undefined) {
      throw new Error('Invalid or duplicate helper argument');
    }
    result[key] = argv[i + 1];
  }
  if (!['compress', 'verify'].includes(result.mode) || !result.source || !result.output) {
    throw new Error('mode, source and output are required');
  }
  result.quality = integer(result.quality ?? '11', 0, 11, 'quality');
  result.lgwin = integer(result.lgwin ?? '22', 10, 24, 'lgwin');
  if (result.mode === 'verify') {
    result.bytes = integer(result.bytes, 0, Number.MAX_SAFE_INTEGER, 'bytes');
    if (!/^[a-f0-9]{64}$/.test(result.sha256 || '')) throw new Error('Invalid expected SHA-256');
  }
  return result;
}
function integer(value, min, max, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(value || '')) throw new Error(`Invalid ${name}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}
async function signature(path) {
  const s = await fsp.lstat(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Only regular files are allowed');
  return [s.dev, s.ino, s.size, s.mtimeNs].map(String).join(':');
}
function meter() {
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  const stream = new Transform({ highWaterMark: CHUNK, transform(chunk, encoding, callback) {
    bytes += chunk.length;
    digest.update(chunk);
    callback(null, chunk);
  } });
  return { stream, result: () => ({ bytes, sha256: digest.digest('hex') }) };
}
async function verify(source, compressed, expectedBytes, expectedHash) {
  const sourceBefore = await signature(source);
  const compressedBefore = await signature(compressed);
  const original = await fsp.open(source, 'r');
  const compressedMeter = meter();
  const decodedHash = crypto.createHash('sha256');
  const decoder = zlib.createBrotliDecompress({ chunkSize: CHUNK, highWaterMark: CHUNK });
  let bytes = 0;
  const compare = new Writable({ highWaterMark: CHUNK, write(chunk, encoding, callback) {
    (async () => {
      if (chunk.length > CHUNK) throw new Error('Decoder exceeded chunk bound');
      const raw = Buffer.allocUnsafe(chunk.length);
      let received = 0;
      while (received < raw.length) {
        const read = await original.read(raw, received, raw.length - received, null);
        if (!read.bytesRead) throw new Error('Brotli byte verification failed (source ended)');
        received += read.bytesRead;
      }
      if (!raw.equals(chunk)) throw new Error('Brotli byte verification failed');
      bytes += chunk.length;
      decodedHash.update(raw);
    })().then(() => callback(), callback);
  } });
  try {
    await pipeline(fs.createReadStream(compressed, { highWaterMark: CHUNK }),
      compressedMeter.stream, decoder, compare);
    const extra = Buffer.allocUnsafe(1);
    if ((await original.read(extra, 0, 1, null)).bytesRead) throw new Error('Brotli byte verification failed (decoded ended)');
  } finally {
    await original.close();
  }
  const encoded = compressedMeter.result();
  const sha256 = decodedHash.digest('hex');
  if (decoder.bytesWritten !== encoded.bytes || BigInt(encoded.bytes) !== (await fsp.stat(compressed, { bigint: true })).size) {
    throw new Error('Brotli trailing bytes or incomplete compressed stream');
  }
  if (bytes !== expectedBytes || sha256 !== expectedHash) throw new Error('Brotli size/SHA-256 verification failed');
  if (sourceBefore !== await signature(source) || compressedBefore !== await signature(compressed)) {
    throw new Error('Source/compressed file changed during verification');
  }
  return { bytes, compressedBytes: encoded.bytes, sha256, compressedSha256: encoded.sha256 };
}
async function run(options) {
  const sourceBefore = await signature(options.source);
  if (options.mode === 'verify') return verify(options.source, options.output, options.bytes, options.sha256);
  const rawMeter = meter();
  const compressedMeter = meter();
  await pipeline(fs.createReadStream(options.source, { highWaterMark: CHUNK }), rawMeter.stream,
    zlib.createBrotliCompress({ chunkSize: CHUNK, highWaterMark: CHUNK, params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: options.quality,
      [zlib.constants.BROTLI_PARAM_LGWIN]: options.lgwin,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
    } }), compressedMeter.stream, fs.createWriteStream(options.output, { flags: 'wx', highWaterMark: CHUNK }));
  const raw = rawMeter.result();
  const encoded = compressedMeter.result();
  if (sourceBefore !== await signature(options.source)) throw new Error('Source changed during compression');
  const result = await verify(options.source, options.output, raw.bytes, raw.sha256);
  if (encoded.bytes !== result.compressedBytes || encoded.sha256 !== result.compressedSha256) {
    throw new Error('Compressed file changed after compression');
  }
  if (sourceBefore !== await signature(options.source)) throw new Error('Source changed after verification');
  return result;
}

if (require.main === module) {
  Promise.resolve().then(() => argumentsOf(process.argv.slice(2))).then(run).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    process.stderr.write(`Brotli helper failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
module.exports = { argumentsOf, run, verify, CHUNK };
