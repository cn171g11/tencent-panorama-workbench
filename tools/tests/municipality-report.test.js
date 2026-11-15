const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { districtsFromGeoJSON, createLocator, contains, selectedCollections, build } = require('../build_municipality_report.js');
const ring = (x0, y0, x1, y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
const feature = (code, coords, type = 'Polygon') => ({ type: 'Feature', properties: { adcode: Number(code), name: code + '区', parent: { adcode: Number(code.slice(0,2) + '0000') }, level: 'district' }, geometry: { type, coordinates: coords } });
const geo = features => ({ type: 'FeatureCollection', features });
function smallDistricts() {
  return districtsFromGeoJSON(geo([
    feature('310102', [ring(122,30,123,31)]),
    feature('310101', [ring(121,30,122,31), ring(121.3,30.3,121.5,30.5)]),
    feature('310103', [[ring(121,32,121.5,32.5)], [ring(124,32,124.5,32.5)]], 'MultiPolygon'),
  ]), '310000');
}

test('exact polygons exclude hole interior and retain all MultiPolygon islands', () => {
  const ds = smallDistricts(), l = createLocator(ds);
  assert.equal(l.locate(121.1,30.1), '310101');
  assert.equal(l.locate(121.4,30.4), '');
  assert.equal(l.locate(121.3,30.4), '310101', 'Hole edge belongs to polygon boundary');
  assert.equal(l.locate(121.2,32.2), '310103');
  assert.equal(l.locate(124.2,32.2), '310103');
  assert.equal(l.locate(120.99,30.5), '', 'No nearest-neighbor assignment');
});

test('shared segment and vertices select lowest code independent of boundary order', () => {
  const ds = smallDistricts(), l = createLocator(ds);
  for (const [x,y] of [[122,30.5],[122,30],[122,31]]) assert.equal(l.locate(x,y), '310101');
  for (const [x,y] of [[122.0000001,30.5],[122.2,30.9]]) assert.equal(l.locate(x,y), '310102');
});

test('bounded cell optimization is identical to exact covers over edges, holes and thin islands', () => {
  const ds = smallDistricts();
  const narrow = districtsFromGeoJSON(geo([feature('310104', [ring(120.011,30.011,120.019,30.019)])]), '310000');
  const all = [...ds, ...narrow].sort((a,b)=>a.code.localeCompare(b.code));
  const fast = createLocator(all, 16);
  const exact = (x,y) => all.find(d => contains(d,x,y))?.code || '';
  for (let x=120; x<=124.6; x+=0.0317) for(let y=29.9;y<=32.6;y+=0.0273) assert.equal(fast.locate(x,y), exact(x,y), [x,y].join(','));
  for(const [x,y] of [[120.015,30.015],[120.01,30.01],[121.3,30.4],[122,30.5],[121.5,30.5],[124.5,32.5],[121.02-1e-12,30.02+1e-12]]) assert.equal(fast.locate(x,y),exact(x,y));
  assert(fast.stats.interiorHits > 0); assert(fast.stats.exactChecks > 0);
});

test('invalid boundaries and panorama coordinates fail closed', () => {
  assert.throws(()=>districtsFromGeoJSON(geo([]),'310000'), /Missing/);
  assert.throws(()=>districtsFromGeoJSON(geo([feature('310101',[ring(121,30,122,31)]),feature('310101',[ring(121,30,122,31)])]),'310000'),/duplicate/);
  const bad=feature('310101',[ring(121,30,122,31)]);bad.geometry.coordinates[0].pop();
  assert.throws(()=>districtsFromGeoJSON(geo([bad]),'310000'),/Unclosed/);
  for(const coordinates of [[0,0],[NaN,30],[121,Infinity],['121',30],[181,30]])assert.throws(()=>createLocator(smallDistricts()).locate(...coordinates),/Invalid panorama/);
});

function dataset(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'municipality-report-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const viewer=path.join(root,'viewer'),boundaries=path.join(root,'boundaries');fs.mkdirSync(viewer);fs.mkdirSync(boundaries);
  for(const code of ['110000','120000','310000','500000']){
    const ds=[feature(code.slice(0,2)+'0101',[ring(121,30,122,31)]),feature(code.slice(0,2)+'0102',[ring(122,30,123,31)])];
    fs.writeFileSync(path.join(boundaries,code+'.json'),JSON.stringify(geo(ds)));
  }
  const meta={
    '310000':{name:'上海市',province:'上海市',pref:'310000'},
    '310000_2':{name:'上海市',province:'上海市',pref:'310000'},
    qq_31:{name:'腾讯常规街景',province:'上海市',pref:'qq_31'},
    hidden_310000:{name:'上海市·隐藏街景',province:'上海市',pref:'hidden_310000'},
    hidden_310101:{name:'区A·隐藏街景',province:'上海市',pref:'hidden_310101'},
    '320100':{name:'南京市',province:'江苏省',pref:'320100'},
    hidden_game:{name:'game',province:'腾讯游戏街景',pref:'hidden_game'},
  };
  const counts={'310000':2,'310000_2':1,qq_31:1,hidden_310000:1,hidden_310101:1,'320100':999,hidden_game:15};
  const row=(sid,x,y,source='腾讯常规')=>[sid,x,y,'路]名\\"','','',0,0,source];
  const writeRows=(name,data)=>fs.writeFileSync(path.join(viewer,name),Object.entries(data).map(([key,rows])=>'window.PANO_CITY['+JSON.stringify(key)+']='+JSON.stringify(rows)+';').join('\r\n'));
  writeRows('data_310000.js',{'310000':[row('00001',121.12345678901234,30.1),row('A2',122.1,30.1)]});
  writeRows('data_310000_2.js',{'310000_2':[row('B1',122.2,30.2).slice(0,8)]});
  writeRows('data_qq_31.js',{qq_31:[row('QQ1',124,30.2)]});
  writeRows('hidden_pano.js',{hidden_310000:[row('HROOT',121.1,30.1,'腾讯隐藏')],hidden_310101:[row('HWRONG',122.1,30.1,'腾讯隐藏')],hidden_game:[row('GAME',0,0,'腾讯隐藏')]});
  const setMeta=()=>fs.writeFileSync(path.join(viewer,'data_meta.js'),'window.PANO_META='+JSON.stringify(meta)+';\nwindow.PANO_COUNT='+JSON.stringify(counts)+';');setMeta();
  return{root,viewer,boundaries,meta,counts,setMeta,writeRows,row};
}

test('selected sources include all municipal shards, qq, old and district hidden, but no game or neighbor',t=>{
  const d=dataset(t);assert.deepEqual(Object.keys(selectedCollections(d.meta,d.counts)),['310000','310000_2','qq_31','hidden_310000','hidden_310101']);
});

test('streamed report conserves regular and hidden separately and preserves every source byte',t=>{
  const d=dataset(t), before=Object.fromEntries(fs.readdirSync(d.viewer).map(n=>[n,fs.readFileSync(path.join(d.viewer,n)).toString('hex')]));
  const out=path.join(d.root,'report.js'), evidence=path.join(d.root,'proof.json');
  const report=build({...d,output:out,evidence,cacheFile:path.join(d.root,'cache.json')});
  const m=report.municipalities['310000'];assert.equal(m.regular,4);assert.equal(m.hidden,2);assert.equal(m.total,6);
  assert.deepEqual(m.districts.map(({code,regular,hidden})=>({code,regular,hidden})),[{code:'310101',regular:1,hidden:1},{code:'310102',regular:2,hidden:1}]);
  assert.deepEqual(m.unassigned,{regular:1,hidden:0,total:1});
  for(const[name,hex]of Object.entries(before))assert.equal(fs.readFileSync(path.join(d.viewer,name)).toString('hex'),hex);
  assert.equal(Object.keys(report.sources).length,4);assert.equal(fs.existsSync(path.join(d.viewer,'data_320100.js')),false,'Unselected neighbor must never be opened');
  const residual=JSON.parse(fs.readFileSync(path.join(d.root,'proof-unassigned.jsonl'),'utf8').trim());assert.equal(residual.sid,'QQ1');assert.equal(residual.lng,124);
});

test('cache reuses only same point bytes, exact selected counts and boundary hashes',t=>{
  const d=dataset(t), cacheFile=path.join(d.root,'cache.json');
  const call=n=>build({...d,output:path.join(d.root,'report'+n+'.js'),evidence:path.join(d.root,'proof'+n+'.json'),cacheFile});
  const first=call(1), second=call(2);assert.deepEqual(first,second);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.root,'proof2.json'))).reusedFiles,4);
  d.writeRows('data_qq_31.js',{qq_31:[d.row('QQ1',121.8,30.2)]});
  const third=call(3);assert.equal(third.municipalities['310000'].unassigned.total,0);
  const p3=JSON.parse(fs.readFileSync(path.join(d.root,'proof3.json')));assert.equal(p3.reusedFiles,3);assert.equal(p3.scannedFiles,1);
  const boundary=path.join(d.boundaries,'310000.json');fs.appendFileSync(boundary,' ');
  call(4);assert.equal(JSON.parse(fs.readFileSync(path.join(d.root,'proof4.json'))).scannedFiles,4);
});

test('source count mismatch and duplicate assignment cannot produce output',t=>{
  for(const duplicate of [false,true]){
    const d=dataset(t);const out=path.join(d.root,'report.js');
    if(duplicate)fs.appendFileSync(path.join(d.viewer,'data_qq_31.js'),'window.PANO_CITY["qq_31"]=[];');
    else{d.counts.qq_31=2;d.setMeta();}
    assert.throws(()=>build({...d,output:out,evidence:path.join(d.root,'proof.json')}),/count mismatch|Duplicate point/);
    assert.equal(fs.existsSync(out),false);
  }
});
