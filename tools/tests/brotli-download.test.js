const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {test}=require('node:test');
const {decode,args}=require('../decode_brotli_asset.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t,raw){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brotli-asset-fixture-'));
  t.after(()=>{assert(path.basename(root).startsWith('brotli-asset-fixture-'));fs.rmSync(root,{recursive:true,force:true});});
  const encoded=zlib.brotliCompressSync(raw),input=path.join(root,'source.br'),output=path.join(root,'decoded.bin');
  fs.writeFileSync(input,encoded);
  return {root,input,output,encoded,options:{'--input':input,'--output':output,'--bytes':raw.length,'--compressed-bytes':encoded.length,'--sha256':hash(raw),'--compressed-sha256':hash(encoded)}};
}
test('downloaded Brotli decoder preserves empty, binary and precision bytes exactly',async t=>{
  for(const raw of [Buffer.alloc(0),Buffer.from('\ufeff["001",123.123456789012345,"路"]\r\n'),Buffer.alloc(200000,0x7f)]){
    const f=fixture(t,raw),result=await decode(f.options);
    assert.equal(result.passed,true);assert.deepEqual(fs.readFileSync(f.output),raw);
  }
});
test('downloaded Brotli decoder rejects bad hash, wrong size and pre-existing output',async t=>{
  const raw=Buffer.from('exact data'),f=fixture(t,raw);
  await assert.rejects(decode({...f.options,'--sha256':'0'.repeat(64)}),/hash mismatch/);
  const g=fixture(t,raw);await assert.rejects(decode({...g.options,'--bytes':raw.length-1}),/overflow/);
  const h=fixture(t,raw);fs.writeFileSync(h.output,'keep');await assert.rejects(decode(h.options),/EEXIST/);assert.equal(fs.readFileSync(h.output,'utf8'),'keep');
});
test('downloaded Brotli decoder rejects truncation, corruption and concatenated trailing streams',async t=>{
  const raw=Buffer.from('test repeated test'.repeat(200));
  for(const mutate of [b=>b.subarray(0,-1),b=>Buffer.concat([b,Buffer.from([0])]),b=>Buffer.concat([b,b]),b=>Buffer.alloc(b.length,0xff)]){
    const f=fixture(t,raw),bad=mutate(f.encoded);fs.writeFileSync(f.input,bad);
    await assert.rejects(decode({...f.options,'--compressed-bytes':bad.length,'--compressed-sha256':hash(bad)}));
  }
});
test('downloaded Brotli decoder checks path, size and hash arguments',()=>{
  assert.throws(()=>args(['--input','a','--unknown','x']),/Invalid/);
  assert.throws(()=>args(['--input','a','--output','b','--bytes','-1']),/Invalid/);
  const o=args(['--input','a','--output','b','--bytes','0','--compressed-bytes','1','--sha256','0'.repeat(64),'--compressed-sha256','f'.repeat(64)]);
  assert.equal(o['--bytes'],0);
});
