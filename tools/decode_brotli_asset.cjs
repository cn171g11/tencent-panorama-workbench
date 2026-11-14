#!/usr/bin/env node
'use strict';
// Validate/decode one downloaded Brotli stream with size/hash bounds; no whole-file buffers.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {createBrotliDecompress}=require('node:zlib');
const CHUNK=64*1024;
function args(argv){
  const out={};
  for(let i=0;i<argv.length;i+=2){
    const key=argv[i];if(!['--input','--output','--bytes','--compressed-bytes','--sha256','--compressed-sha256'].includes(key)||out[key]!==undefined||argv[i+1]===undefined)throw Error('Invalid decode argument');
    out[key]=argv[i+1];
  }
  for(const key of ['--input','--output'])if(!out[key])throw Error('Missing path');
  for(const key of ['--bytes','--compressed-bytes']){if(!/^(0|[1-9][0-9]*)$/.test(out[key]||'')||!Number.isSafeInteger(Number(out[key])))throw Error('Invalid size');out[key]=Number(out[key]);}
  for(const key of ['--sha256','--compressed-sha256'])if(!/^[a-f0-9]{64}$/.test(out[key]||''))throw Error('Invalid hash');
  return out;
}
async function decode(o){
  const initial=fs.statSync(o['--input']);if(!initial.isFile()||initial.size!==o['--compressed-bytes'])throw Error('Input compressed size mismatch');
  const compressedHash=crypto.createHash('sha256');let encoded=0;
  const rawHash=crypto.createHash('sha256');let raw=0;
  const decoder=createBrotliDecompress({chunkSize:CHUNK,highWaterMark:CHUNK});
  await pipeline(fs.createReadStream(o['--input'],{highWaterMark:CHUNK}),new Transform({transform(chunk,enc,done){
    encoded+=chunk.length;if(encoded>o['--compressed-bytes'])return done(Error('Compressed input overflow'));compressedHash.update(chunk);done(null,chunk);
  }}),decoder,new Transform({transform(chunk,enc,done){
    raw+=chunk.length;if(raw>o['--bytes'])return done(Error('Decompressed output overflow'));rawHash.update(chunk);done(null,chunk);
  }}),fs.createWriteStream(o['--output'],{flags:'wx',highWaterMark:CHUNK}));
  if(raw!==o['--bytes']||encoded!==o['--compressed-bytes']||decoder.bytesWritten!==encoded)throw Error('Incomplete or trailing Brotli stream');
  const restored=rawHash.digest('hex'),compressed=compressedHash.digest('hex');
  if(restored!==o['--sha256']||compressed!==o['--compressed-sha256'])throw Error('Raw or compressed hash mismatch');
  const final=fs.statSync(o['--input']);if(final.size!==initial.size||final.mtimeMs!==initial.mtimeMs)throw Error('Downloaded compressed file changed during verification');
  return {passed:true,bytes:raw,compressedBytes:encoded,sha256:restored,compressedSha256:compressed};
}
if(require.main===module)Promise.resolve().then(()=>args(process.argv.slice(2))).then(decode).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={args,decode};
