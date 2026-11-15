#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../city-viewer/index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
assert(html.includes('id="search"'), 'Search UI not restored');
assert(html.includes('src="asset-manifest.js"') && html.includes('src="asset-loader.js"'));
assert(!/<script src="(?:grid_all|hidden_pano|pano_search_index)\.js"/.test(html));
new vm.Script(inline);

class Element {
  constructor() { this.style = {}; this.value = ''; this.options = []; this.offsetHeight = 52; this.events = {}; this.disabled = false; }
  set innerHTML(v) { this.html = v; this.options = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.options.push(child); }
  addEventListener(name, fn) { this.events[name] = fn; }
  focus() { this.focused = true; }
}
const idA = '30111018141016121817800', idB = '30111018141016121837900';
const idH = '30111018141016121857600';
const originals = [
  [idA, 106.12345678901234, 29.12345678901234, 'G219', '2014-10-16 12:18', '', 0, 0, '腾讯常规', '500000', '500101'],
  [idB, 106.2, 29.2, '路B', '2015-01-01', '', 0, 0, '腾讯常规', '500000', '500102'],
  [idH, 106.3, 29.3, '隐藏路', '2014-10-16', '', 0, 0, '腾讯隐藏', 'hidden_500000'],
  ['270130K01407010SCENE001', 0, 0, '', '', '', 0, 0, '腾讯隐藏', 'hidden_game'],
];
const clone = value => JSON.parse(JSON.stringify(value));
const before = JSON.stringify(originals);
const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
let failure = '', calls = [], renders = [];
const document = {
  getElementById: id => elements[id] || null,
  createElement: () => new Element(), querySelector: () => new Element(),
  addEventListener() {}, documentElement: { style: { setProperty() {} } },
  head: { appendChild() { throw Error('Large scripts must use PanoAssets loader'); } },
};
const win = {
  PANO_CITY: {},
  PANO_META: {
    '500000': { name: '重庆市', province: '重庆市', pref: '500000' },
    hidden_500000: { name: '重庆·隐藏', province: '重庆市', pref: 'hidden_500000' },
    hidden_game: { name: '剑灵', province: '腾讯游戏街景', pref: 'hidden_game' },
  },
  PANO_COUNT: { '500000': 2, hidden_500000: 1, hidden_game: 1 },
  addEventListener() {},
};
win.PanoAssets = { async loadScript(name) {
  calls.push(name);
  if (name === failure) throw Error('fixture integrity failure');
  if (name === 'grid_all.js') {
    win.PANO_GRID_ALL = { '500000': [[26500,7300,2]], hidden_500000: [[26500,7300,1]], hidden_game: [[0,0,1]] };
  } else if (name === 'hidden_pano.js') {
    win.PANO_CITY.hidden_500000 = [clone(originals[2])];
    win.PANO_CITY.hidden_game = [clone(originals[3])];
  } else if (name === 'data_500000.js') {
    win.PANO_CITY['500000'] = clone(originals.slice(0,2));
  } else if (name === 'pano_search_index.js') {
    win.PANO_SEARCH_INDEX = {
      prefix: { '3011': ['500000','hidden_500000'], '2701': ['hidden_game'] },
      seg1620: { SCENE: ['hidden_game'] },
      roads: { g219: ['500000'], '路b': ['500000'], '隐藏路': ['hidden_500000'] },
      dates: { '2014-10-16 12:18': ['500000'], '2014-10-16': ['hidden_500000'], '2015-01-01': ['500000'] },
    };
  } else throw Error('Unexpected fixture asset: '+name);
} };
const exposed = inline.replace(/\}\)\(\);\s*$/, `window.__TEST__={state:state,els:els,startSelectedView:startSelectedView,selectProvince:selectProvince,selectCity:selectCity,loadCityScript:loadCityScript,loadSearchIndex:loadSearchIndex,runGlobalSearch:runGlobalSearch,restoreSearchView:restoreSearchView,computeResults:computeResults,isHiddenEntry:isHiddenEntry,renderMapPoints:renderMapPoints,setRenderContext:function(m,p){map=m;pointLayer=p;}};})();`);
assert(exposed !== inline);
const context = vm.createContext({ window:win,document,navigator:{userAgent:''},console,setTimeout,clearTimeout });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
(async function(){
  vm.runInContext(exposed,context);
  const t=win.__TEST__;
  assert.equal(elements.search.disabled,true,'Search must wait for explicit view confirmation');
  assert.equal(t.state.started,false);
  assert.equal(t.state.mode,'idle');
  assert.equal(elements.provinceSelect.value,'');
  assert.equal(elements.startNationBtn.disabled,true);
  assert.equal(elements.startGate.style.display,'block');
  await turn();
  await t.runGlobalSearch(idA);
  assert.deepEqual(calls,[],'Idle boot and guarded queries must not request panorama assets');
  t.selectProvince('重庆市'); t.selectCity('500000');
  assert.equal(t.state.cityFilter,'500000');
  assert.deepEqual(calls,[],'Preparing province/city selection must use metadata only');
  t.selectProvince('全国');
  await t.startSelectedView();
  assert.equal(t.state.started,true);
  assert.equal(elements.search.disabled,false);
  assert(elements.stats.textContent.includes('3 点'));
  assert(elements.provinceSelect.innerHTML.includes('腾讯游戏街景'));
  assert.deepEqual(calls,['grid_all.js'],'Explicit confirmation must load only the grid, not hidden/raw/search data');
  await t.runGlobalSearch(idA);
  assert.equal(t.state.results.length,1); assert.equal(t.state.results[0][0],idA);
  assert(!win.PANO_CITY['500000'],'Search should release newly loaded point arrays');
  const cityLoads=calls.filter(n=>n==='data_500000.js').length;
  await t.runGlobalSearch('@1-23:'+idA);
  assert.equal(t.state.results.length,1); assert.equal(t.state.results[0][0],idA);
  assert(calls.filter(n=>n==='data_500000.js').length>cityLoads,'Released cities must be reloadable');
  await t.runGlobalSearch('Ｇ２１９');
  assert.equal(t.state.results.length,1); assert.equal(t.state.results[0][0],idA);
  await t.runGlobalSearch('隐藏路');
  assert.equal(t.state.results.length,1); assert.equal(t.state.results[0][0],idH);
  const cjkCalls=calls.length;
  await t.runGlobalSearch('不存在的中文道路');
  assert.equal(t.state.results.length,0);
  assert.equal(calls.length,cjkCalls,'CJK index miss must not scan every city');
  await t.runGlobalSearch('路B');
  assert.equal(t.state.results.length,1); assert.equal(t.state.results[0][0],idB);
  await t.runGlobalSearch('2014-10');
  assert.equal(t.state.results.length,2);
  await t.runGlobalSearch('@16-20:SCENE');
  assert.equal(t.state.results.length,1); assert.equal(t.state.results[0][9],'hidden_game');
  assert.equal(calls.filter(n=>n==='pano_search_index.js').length,1,'Search index should be reused');
  await t.runGlobalSearch('@wrong');
  assert(elements.stats.textContent.includes('写法有误'));
  t.restoreSearchView();
  assert.equal(t.state.searchActive,false); assert.equal(t.state.mode,'overview');

  t.state.entries=clone(originals); t.state.mode='detail'; t.state.searchActive=false;
  elements.search.value='29.12345678901234,106.12345678901234';
  elements.citySelect.value=''; elements.roadFilter.value=''; t.state.countyFilter='';
  t.computeResults();
  assert(t.state.distMode); assert.equal(t.state.results[0].e[0],idA);
  elements.search.value=''; elements.citySelect.value='500000'; t.computeResults(); assert.equal(t.state.results.length,2);
  elements.roadFilter.value='G219'; t.computeResults(); assert.equal(t.state.results.length,1);
  t.state.countyFilter='500102'; t.computeResults(); assert.equal(t.state.results.length,0);

  failure='data_500000.js'; delete win.PANO_CITY['500000'];
  await t.runGlobalSearch(idA);
  assert(elements.stats.textContent.includes('搜索失败:'),'Failed data must not produce incomplete success');
  failure=''; await t.runGlobalSearch(idA); assert.equal(t.state.results[0][0],idA);
  t.state.searchActive=false; t.state.mode='detail'; t.state.dispMode='points';
  t.state.entries=clone(originals); t.state.countyFilter=''; elements.search.value='';
  elements.citySelect.value=''; elements.roadFilter.value=''; t.computeResults();
  t.setRenderContext({invalidateSize(){}}, {setData(base,hits){renders.push(hits);}});
  t.renderMapPoints(); assert.equal(renders.at(-1).filter(p=>p[3]).length,2,'Hidden/game markers lost');
  assert.equal(JSON.stringify(originals),before,'Fixture source was mutated');
  console.log('PASS: idle boot/no panorama requests, metadata-only selection, explicit grid-only confirmation, lazy panoid/@/CJK/road/date/coordinate queries, city/county filters, error/retry, hidden/game markers');
})().catch(error=>{console.error(error);process.exitCode=1;});
