const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Tiny in-memory fixtures only: never evaluate nationwide shards or the WASM loader.
const html = fs.readFileSync(path.resolve(__dirname, '../../city-viewer/index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const exposed = inline.replace(/\}\)\(\);\s*$/, `window.__TEST__={state,els,startSelectedView,loadOverviewData,selectProvince,selectCity,loadKeys,loadCityScript,runGlobalSearch,restoreSearchView,computeResults,renderMapPoints,applyZoomLod,applyDispMode,keysWithPref};})();`);
assert.notEqual(exposed, inline, 'Viewer IIFE must expose the test seam');
new vm.Script(exposed);

const ID_A = '30111018141016121817800';
const ID_B = '30111018141016121837900';
const ID_H = '30111018141016121857600';
const ID_GAME = '270130K01407010SCENE001';
const rows = [
  [ID_A, 106.12345678901234, 29.12345678901234, 'G219', '2014-10-16 12:18', '', 0, 0, '腾讯常规', '500000', '500101'],
  [ID_B, 106.2, 29.2, '路B', '2015-01-01', '', 0, 0, '腾讯常规', '500000', '500102'],
  [ID_H, 106.3, 29.3, '隐藏路', '2014-10-16', '', 0, 0, '腾讯隐藏', 'hidden_500000'],
  [ID_GAME, 0, 0, '', '', '', 0, 0, '腾讯隐藏', 'hidden_game'],
];
const clone = value => JSON.parse(JSON.stringify(value));
const validGrid = () => ({ '500000': [[26500, 7300, 2]], hidden_500000: [[26575, 7325, 1]], hidden_game: [[0, 0, 1]]});
const originalRows = JSON.stringify(rows);
const decode = value => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this._value = '';
    this._options = [];
    this.events = {};
    this.disabled = false;
    this.offsetHeight = 52;
    this.textContent = '';
    this.classList = { add() {}, remove() {} };
  }
  get value() { return this._value; }
  set value(value) {
    value = String(value);
    this._value = this.tagName === 'SELECT' && !this._options.some(option => option.value === value) ? '' : value;
  }
  get options() { return this._options; }
  get innerHTML() { return this._html || ''; }
  set innerHTML(value) {
    this._html = value;
    this._options = [];
    this._value = '';
    for (const match of value.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
      const option = new Element('option');
      option.value = decode(/\bvalue="([^"]*)"/.exec(match[1])?.[1] || '');
      option.textContent = decode(match[2]);
      option.disabled = /\bdisabled\b/.test(match[1]);
      this.appendChild(option);
    }
  }
  appendChild(child) {
    this._options.push(child);
    if (this.tagName === 'SELECT' && this._options.length === 1) this._value = child.value;
    return child;
  }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  focus() { this.focused = true; }
  emit(name, event = {}, bypassDisabled = false) {
    if (this.disabled && !bypassDisabled) return;
    let result;
    if (this['on' + name]) result = this['on' + name]({ target: this, ...event});
    for (const callback of this.events[name] || []) result = callback({ target: this, ...event});
    return result;
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no;});
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture(options = {}) {
  const elements = {};
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    const display = /\bstyle="[^"]*display:([^;" ]+)/.exec(match[2]);
    if (display) element.style.display = display[1];
    elements[match[3]] = element;
  }
  const calls = [], directRequests = [], timers = new Map(), mapEvents = {}, renders = [];
  let nextTimer = 0;
  const windowEvents = {};
  const map = {
    zoom: 3, center: { lat: 36, lng: 110 }, views: [],
    on(names, callback) { for (const name of names.split(' ')) (mapEvents[name] ||= []).push(callback); return this; },
    emit(name, event = {}) { for (const callback of mapEvents[name] || []) callback(event); },
    getZoom() { return this.zoom; },
    setZoom(zoom) { this.zoom = zoom; return this; },
    getCenter() { return this.center; },
    setView(center, zoom) {
      this.center = { lat: center[0], lng: center[1] }; this.zoom = zoom; this.views.push({ center, zoom});
      if (options.syncZoomOnFit) this.emit('zoomend');
      return this;
    },
    fitBounds(bounds) {
      this.lastBounds = bounds;
      if (options.syncZoomOnFit) { this.zoom = 18; this.emit('zoomend'); }
      return this;
    },
    invalidateSize() { this.invalidations = (this.invalidations || 0) + 1; },
  };
  const L = {
    Layer: { extend(definition) {
      class Layer {
        constructor() { definition.initialize.call(this); }
        addTo(target) { this._map = target; return this; }
      }
      Object.assign(Layer.prototype, definition);
      for (const method of ['setData', 'setDensity', 'setCells']) {
        const original = Layer.prototype[method];
        Layer.prototype[method] = function (...args) { renders.push({ method, args}); return original.apply(this, args); };
      }
      return Layer;
    } },
    map() { return map; },
    tileLayer() { return { addTo() { return this; }, bringToBack() {}, remove() {} }; },
  };
  const header=new Element('header'),cssProperties={};
  const document = {
    getElementById: id => elements[id] || null,
    createElement: tag => new Element(tag),
    querySelector: () => header,
    addEventListener() {},
    documentElement: { style: { setProperty(name,value) {cssProperties[name]=value;} } },
    head: { appendChild() { directRequests.push('script'); throw Error('Direct asset injection is forbidden'); } },
  };
  const window = {
    L, document, navigator: { userAgent: '' },
    PANO_CITY: {},
    PANO_META: {
      '500000': { name: '重庆市', province: '重庆市', pref: '500000' },
      hidden_500000: { name: '重庆·隐藏', province: '重庆市', pref: 'hidden_500000' },
      hidden_game: { name: '剑灵', province: '腾讯游戏街景', pref: 'hidden_game' },
    },
    PANO_COUNT: { '500000': 2, hidden_500000: 1, hidden_game: 1 },
    addEventListener(name, callback) { (windowEvents[name] ||= []).push(callback); },
  };
  function installAsset(name) {
    if (name === 'grid_all.js') window.PANO_GRID_ALL = validGrid();
    else if (name === 'data_500000.js') window.PANO_CITY['500000'] = clone(rows.slice(0, 2));
    else if (name === 'hidden_pano.js') {
      window.PANO_CITY.hidden_500000 = [clone(rows[2])];
      window.PANO_CITY.hidden_game = [clone(rows[3])];
    } else if (name === 'pano_search_index.js') window.PANO_SEARCH_INDEX = {
      prefix: { '3011': ['500000', 'hidden_500000'], '2701': ['hidden_game'] },
      seg1620: { SCENE: ['hidden_game'] },
      roads: { g219: ['500000'], '路b': ['500000'], '隐藏路': ['hidden_500000'] },
      dates: { '2014-10-16 12:18': ['500000'], '2014-10-16': ['hidden_500000'], '2015-01-01': ['500000'] },
    };
    else throw Error('Unexpected fixture asset: ' + name);
  }
  if (options.configure) options.configure(window);
  const loader = { async loadScript(name) {
    calls.push(name);
    if (options.load) return options.load(name, { window, installAsset});
    installAsset(name);
  } };
  const resizeObservers=[];
  if(options.resizeObserver) window.ResizeObserver=class {
    constructor(callback){this.callback=callback;resizeObservers.push(this);}
    observe(target){this.target=target;}
  };
  if (!options.missingLoader) window.PanoAssets = loader;
  const setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay}); return id; };
  const clearTimeout = id => timers.delete(id);
  const requestAnimationFrame = callback => setTimeout(callback, 0);
  Object.assign(window, { setTimeout, clearTimeout, requestAnimationFrame});
  const context = vm.createContext({
    window, document, navigator: window.navigator, L, console,
    setTimeout, clearTimeout, requestAnimationFrame,
    fetch() { directRequests.push('fetch'); throw Error('Direct fetch is forbidden'); },
 });
  vm.runInContext(exposed, context, { filename: 'viewer-inline.js'});
  const api = window.__TEST__;
  function select(province, city = '') {
    elements.provinceSelect.value = province;
    elements.provinceSelect.emit('change');
    if (city) { elements.citySelect.value = city; elements.citySelect.emit('change'); }
  }
  function runTimers() {
    const pending = [...timers.values()]; timers.clear();
    for (const timer of pending) timer.callback();
  }
  return { elements, calls, directRequests, timers, map, window, windowEvents, renders, api, select, loader, installAsset, runTimers,header,cssProperties,resizeObservers };
}

function municipalFixture(code) {
  const names = { '110000': '北京市', '120000': '天津市', '310000': '上海市', '500000': '重庆市' };
  const province = names[code], root = 'hidden_' + code;
  const districtA = 'hidden_' + code.slice(0, 2) + '0101';
  const districtB = 'hidden_' + code.slice(0, 2) + '0104';
  const hiddenRows = {
    [root]: [['CITY' + code, 121.1, 31.1, '市级旧点', '', '', 0, 0, '腾讯隐藏']],
    [districtA]: [['AREA' + code, 121.2, 31.2, '区A', '', '', 0, 0, '腾讯隐藏']],
    [districtB]: [['AREA2' + code, 121.3, 31.3, '区B', '', '', 0, 0, '腾讯隐藏'],
      ['AREA3' + code, 121.4, 31.4, '区B', '', '', 0, 0, '腾讯隐藏']],
  };
  const h = fixture({
    configure(window) {
      window.PANO_META[code] = { name: province, province, pref: code };
      window.PANO_COUNT[code] = 1;
      for (const [key, entries] of Object.entries(hiddenRows)) {
        window.PANO_META[key] = { name: (key === root ? province : key === districtA ? '区A' : '区B') + '·隐藏街景', province, pref: key };
        window.PANO_COUNT[key] = entries.length;
      }
      window.PANO_META['hidden_' + code.slice(0, 2) + '0001'] = { name: '其他省份近名', province: '其他', pref: 'hidden_' + code.slice(0, 2) + '0001' };
      window.PANO_COUNT['hidden_' + code.slice(0, 2) + '0001'] = 1;
    },
    load(name, { window, installAsset }) {
      installAsset(name);
      if (name === 'grid_all.js') {
        window.PANO_GRID_ALL[code] = [[30250, 7750, 1]];
        for (const [key, entries] of Object.entries(hiddenRows)) {
          window.PANO_GRID_ALL[key] = entries.map(entry => [Math.floor(entry[1] / 0.004), Math.floor(entry[2] / 0.004), 1]);
        }
        window.PANO_GRID_ALL['hidden_' + code.slice(0, 2) + '0001'] = [[25000, 7000, 1]];
      } else if (name === 'hidden_pano.js') {
        for (const [key, entries] of Object.entries(hiddenRows)) window.PANO_CITY[key] = clone(entries);
        window.PANO_CITY['hidden_' + code.slice(0, 2) + '0001'] = [['OTHER' + code, 100, 28, '', '', '', 0, 0, '腾讯隐藏']];
      }
    },
  });
  return { h, province, root, districtA, districtB, hiddenRows };
}

for (const code of ['110000', '120000', '310000', '500000']) {
  test('municipal city-wide hidden selector includes every district once: ' + code, async () => {
    const { h, province, root, districtA, districtB, hiddenRows } = municipalFixture(code);
    h.select(province, root);
    assert.deepEqual(h.calls, [], 'Preparing the aggregate must remain metadata-only');
    assert.deepEqual(Array.from(h.api.keysWithPref(root, h.api.state.provinceKeys)).sort(), Object.keys(hiddenRows).sort());
    assert.match(h.elements.citySelect.options.find(option => option.value === root).textContent, /全部隐藏/);
    await h.api.startSelectedView();
    assert.equal(h.api.state.overviewTotal, 4, 'City-wide overview must include root + both district collections');
    assert.equal(h.api.state.overviewAllHidden, true);
    assert.deepEqual(h.calls, ['grid_all.js']);
    h.elements.dispMode.value = 'points'; h.elements.dispMode.emit('change'); await flush();
    const expected = Object.values(hiddenRows).flat().map(row => row[0]).sort();
    assert.deepEqual(Array.from(h.api.state.results, row => row[0]).sort(), expected);
    assert.equal(new Set(h.api.state.results.map(row => row[0])).size, 4);
    assert.equal(h.renders.at(-1).args[1].filter(point => point[3]).length, 4);
    assert.ok(!h.calls.some(name => name.startsWith('data_')), 'Hidden aggregate must not download regular shards');
    for (const district of [districtA, districtB]) {
      h.elements.citySelect.value = district; h.elements.citySelect.emit('change'); await flush();
      assert.deepEqual(Array.from(h.api.state.results, row => row[0]), hiddenRows[district].map(row => row[0]));
    }
    h.elements.citySelect.value = root; h.elements.citySelect.emit('change'); await flush();
    h.elements.roadFilter.value = '区B'; h.api.computeResults();
    assert.deepEqual(Array.from(h.api.state.results, row => row[0]), hiddenRows[districtB].map(row => row[0]));
    h.api.renderMapPoints();
    assert.equal(h.renders.at(-1).args[0].length, 4, 'Filtered base layer must retain the entire selected hidden scope');
    assert.equal(h.renders.at(-1).args[1].length, 2);
    assert.equal(h.api.state.results.some(row => row[9] === 'hidden_game'), false);
  });
}

function assertIdle(h) {
  assert.equal(h.api.state.started, false);
  assert.equal(h.api.state.startLoading, false);
  assert.equal(h.api.state.mode, 'idle');
  assert.equal(h.api.state.entries.length, 0);
  assert.equal(h.api.state.results.length, 0);
  assert.equal(h.api.state.overviewCells.length, 0);
  assert.equal(h.elements.search.disabled, true);
  assert.equal(h.elements.dispMode.disabled, true);
  assert.equal(h.api.state.initializingView, false);
  assert.equal(h.elements.startGate.style.display, 'block');
}
function assertRetryControls(h) {
  assertIdle(h);
  assert.equal(h.elements.provinceSelect.disabled, false);
  assert.equal(h.elements.citySelect.disabled, h.api.state.province === '全国');
  assert.equal(h.elements.startPickBtn.disabled, false);
  assert.equal(h.elements.startNationBtn.disabled, false);
  assert.equal(h.elements.loadingData.style.display, 'none');
  assert.match(h.elements.sgSub.textContent, /加载失败/);
}

test('header resize observer synchronizes late wrapping without loading street data',async()=>{
 const h=fixture({resizeObserver:true});assert.equal(h.resizeObservers.length,1);assert.equal(h.resizeObservers[0].target,h.header);
 assert.equal(h.cssProperties['--header-h'],'52px');h.header.offsetHeight=172;h.resizeObservers[0].callback();
 assert.equal(h.cssProperties['--header-h'],'172px');assert(h.map.invalidations>0);await flush();assert.deepEqual(h.calls,[]);assertIdle(h);
});

test('boot remains empty after microtasks and never requests panorama assets', async () => {
  const h = fixture();
  assertIdle(h);
  assert.equal(h.elements.provinceSelect.value, '');
  assert.match(h.elements.provinceSelect.options[0].textContent, /请选择视图/);
  assert.equal(h.elements.startNationBtn.disabled, true);
  assert.equal(h.elements.citySelect.disabled, true);
  assert.equal(h.timers.size, 0, 'Boot must not schedule asynchronous asset loading');
  await flush(); h.runTimers();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.directRequests, []);
  assert.equal(h.window.PANO_GRID_ALL, undefined);
  assert.equal(h.window.PANO_SEARCH_INDEX, undefined);
  assert.deepEqual(h.window.PANO_CITY, {});
});

test('map pan/zoom/click, resize, basemap and display controls do not load idle assets', async () => {
  const h = fixture();
  h.map.zoom = 18;
  for (const name of ['move', 'zoomend', 'click', 'mousemove', 'mouseout', 'popupclose']) h.map.emit(name, { latlng: { lat: 29.2, lng: 106.2 }});
  for (const callback of h.windowEvents.resize || []) callback();
  h.elements.basemapSelect.value = 'osmStandard'; h.elements.basemapSelect.emit('change');
  h.elements.dispMode.value = 'points'; h.elements.dispMode.emit('change', {}, true);
  h.elements.dispMode.value = 'density'; h.elements.dispMode.emit('change', {}, true);
  assert.equal(h.api.state.dispMode, 'density');
  assert.equal(h.elements.dispMode.value, 'density', 'Disabled display events must restore the prepared mode');
  h.elements.roadFilter.emit('change'); h.elements.countySelect.emit('change');
  h.runTimers(); await flush();
  assertIdle(h);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.directRequests, []);
});

test('preparing national, province and city views uses metadata only and keeps the gate visible', async () => {
  const h = fixture();
  h.select('全国');
  assert.equal(h.api.state.province, '全国'); assert.equal(h.elements.citySelect.disabled, true);
  h.select('重庆市', '500000');
  assert.equal(h.api.state.province, '重庆市'); assert.equal(h.api.state.cityFilter, '500000');
  assert.equal(h.elements.citySelect.disabled, false);
  assert.equal(h.elements.startNationBtn.disabled, false);
  assert.match(h.elements.sgSub.textContent, /重庆市/);
  h.elements.startPickBtn.emit('click'); assert.equal(h.elements.provinceSelect.focused, true);
  await flush(); assertIdle(h); assert.deepEqual(h.calls, []);
});

for (const selection of ['', '不存在的省份']) {
 test('empty/invalid DOM selection cannot confirm: ' + JSON.stringify(selection), async () => {
    const h = fixture(); h.select(selection);
    assert.equal(h.elements.provinceSelect.value, '');
    assert.equal(h.elements.startNationBtn.disabled, true);
    h.elements.startNationBtn.emit('click');
    await h.api.startSelectedView(); await flush();
    assertIdle(h); assert.deepEqual(h.calls, []);
 });
 }

for (const [province, city, expectedMode, expectedTotal] of [
  ['全国', '', 'overview', 3], ['重庆市', '', 'overview', 3], ['重庆市', '500000', 'city', 2],
  ['重庆市', 'hidden_500000', 'city', 1], ['腾讯游戏街景', 'hidden_game', 'city', 1],
 ]) {
 test('explicit confirmation loads only grid for ' + province + (city ? '/' + city : ''), async () => {
    const h = fixture(); h.select(province, city);
    await h.elements.startNationBtn.emit('click');
    assert.equal(h.api.state.started, true); assert.equal(h.api.state.startLoading, false);
    assert.equal(h.api.state.mode, expectedMode); assert.equal(h.api.state.overviewTotal, expectedTotal);
    assert.equal(h.api.state.cityFilter, city);
    assert.equal(h.elements.search.disabled, false); assert.equal(h.elements.dispMode.disabled, false);
    assert.equal(h.elements.startGate.style.display, 'none');
    assert.equal(h.elements.loadingData.style.display, 'none');
    assert.deepEqual(h.calls, ['grid_all.js']); assert.deepEqual(h.window.PANO_CITY, {});
    assert.equal(h.window.PANO_SEARCH_INDEX, undefined);
    await h.api.startSelectedView(); assert.deepEqual(h.calls, ['grid_all.js']);
 });
 }

test('initial fit/zoom events cannot promote the confirmed grid into raw city loading', async () => {
  const h = fixture({ syncZoomOnFit: true}); h.select('重庆市', '500000');
  await h.api.startSelectedView(); await flush();
  assert.equal(h.api.state.started, true); assert.equal(h.api.state.initializingView, false);
  assert.equal(h.api.state.mode, 'city'); assert.deepEqual(h.calls, ['grid_all.js']);
  h.map.zoom = 18; h.map.emit('zoomend'); await flush();
  assert.equal(h.api.state.mode, 'detail');
  assert.deepEqual(h.calls, ['grid_all.js', 'data_500000.js'], 'Later deliberate zoom must retain lazy detail loading');
});

test('pending confirmation is single-flight and blocks selection/search changes', async () => {
  const pending = deferred();
  const h = fixture({ load: async (name, { installAsset }) => { await pending.promise; installAsset(name); }});
  h.select('重庆市', '500000');
  const start = h.api.startSelectedView();
  assert.equal(h.api.state.startLoading, true);
  for (const id of ['provinceSelect', 'citySelect', 'startNationBtn', 'startPickBtn', 'search', 'dispMode']) assert.equal(h.elements[id].disabled, true, id);
  assert.equal(h.api.startSelectedView(), undefined);
  h.elements.startNationBtn.emit('click', {}, true);
  h.elements.provinceSelect.value = '腾讯游戏街景'; h.elements.provinceSelect.emit('change', {}, true);
  h.elements.citySelect.value = 'hidden_500000'; h.elements.citySelect.emit('change', {}, true);
  h.elements.startPickBtn.emit('click', {}, true);
  h.elements.search.value = ID_A; h.elements.search.emit('input', {}, true);
  await h.api.runGlobalSearch(ID_A);
  assert.equal(h.api.state.province, '重庆市'); assert.equal(h.api.state.cityFilter, '500000');
  assert.equal(h.elements.provinceSelect.focused, undefined);
  const firstGrid = h.api.loadOverviewData();
  assert.equal(h.api.loadOverviewData(), firstGrid, 'Concurrent grid requests must share a promise');
  await flush(); assert.deepEqual(h.calls, ['grid_all.js']);
  pending.resolve(); await start;
  assert.equal(h.api.state.started, true); assert.equal(h.api.state.cityFilter, '500000');
  assert.equal(h.elements.provinceSelect.value, '重庆市'); assert.equal(h.elements.citySelect.value, '500000');
  assert.deepEqual(h.calls, ['grid_all.js']);
});

test('missing loader restores controls and supports retry without reloading the page', async () => {
  const h = fixture({ missingLoader: true}); h.select('重庆市', '500000');
  await h.api.startSelectedView(); assertRetryControls(h); assert.deepEqual(h.calls, []);
  h.window.PanoAssets = h.loader;
  await h.api.startSelectedView(); assert.equal(h.api.state.started, true); assert.deepEqual(h.calls, ['grid_all.js']);
});

test('rejected grid restores controls, stays idle and requests a fresh grid on retry', async () => {
  let failed = true;
  const h = fixture({ load: async (name, { installAsset }) => { if (failed) throw Error('fixture network/integrity failure'); installAsset(name); }});
  h.select('全国'); await h.api.startSelectedView(); assertRetryControls(h);
  assert.match(h.elements.sgSub.textContent, /fixture network\/integrity failure/);
  failed = false; await h.api.startSelectedView();
  assert.equal(h.api.state.started, true); assert.equal(h.elements.search.disabled, false);
  assert.deepEqual(h.calls, ['grid_all.js', 'grid_all.js']);
});

for (const [name, grid] of [
  ['missing', undefined], ['null', null], ['empty object', {}], ['non-object', 'broken'],
  ['top-level array', [[26500, 7300, 2]]], ['missing hidden shard', { '500000': [[26500, 7300, 2]] }],
  ['non-array shard', { ...validGrid(), '500000': 'broken' }],
  ['missing count', { ...validGrid(), '500000': [[26500, 7300]] }],
  ['nonfinite coordinate', { ...validGrid(), '500000': [[NaN, 7300, 2]] }],
  ['nonnumeric coordinate', { ...validGrid(), '500000': [[null, 7300, 2]] }],
  ['noninteger coordinate', { ...validGrid(), '500000': [[26500.5, 7300, 2]] }],
  ['nonpositive count', { ...validGrid(), '500000': [[26500, 7300, 0]] }],
  ['count mismatch', { ...validGrid(), '500000': [[26500, 7300, 1]] }],
 ]) {
 test('invalid grid (' + name + ') fails closed and permits retry', async () => {
    let failed = true;
    const h = fixture({ load: async (asset, { window, installAsset }) => {
      if (failed) window.PANO_GRID_ALL = grid; else installAsset(asset);
    }});
    h.select('重庆市', '500000'); await h.api.startSelectedView();
    assertRetryControls(h);
    failed = false; await h.api.startSelectedView();
    assert.equal(h.api.state.started, true); assert.equal(h.api.state.mode, 'city');
    assert.deepEqual(h.calls, ['grid_all.js', 'grid_all.js']);
 });
 }

test('idle direct search and input events cannot bypass explicit confirmation', async () => {
  const h = fixture();
  for (const query of [ID_A, '@16-20:SCENE', '隐藏路', '29.2,106.2']) {
    h.elements.search.value = query; h.elements.search.emit('input', {}, true);
    await h.api.runGlobalSearch(query);
  }
  h.runTimers(); await flush();
  assertIdle(h); assert.deepEqual(h.calls, []); assert.equal(h.api.state.searchIndexPromise, null);
});

test('regular, hidden and game city scripts remain lazy and validate the requested key', async () => {
  const h = fixture(); h.select('全国'); await h.api.startSelectedView();
  await h.api.loadCityScript('500000'); assert.deepEqual(h.calls, ['grid_all.js', 'data_500000.js']);
  await h.api.loadCityScript('500000'); assert.equal(h.calls.length, 2);
  await h.api.loadCityScript('hidden_500000'); await h.api.loadCityScript('hidden_game');
  assert.deepEqual(h.calls, ['grid_all.js', 'data_500000.js', 'hidden_pano.js']);
  assert.equal(h.window.PANO_CITY['500000'][0][0], ID_A, 'Shared hidden script must preserve regular data');
  assert.equal(h.window.PANO_CITY.hidden_game[0][0], ID_GAME);
  await assert.rejects(h.api.loadCityScript('hidden_missing'), /hidden_pano\.js.*hidden_missing/);
  assert.equal(h.calls.at(-1), 'hidden_pano.js'); assert.ok(!h.calls.includes('data_hidden_missing.js'));
});

test('successful regular/hidden asset execution without the requested array is rejected', async () => {
  const h = fixture({ load: async (name, { installAsset }) => { if (name === 'grid_all.js') installAsset(name); }});
  h.select('全国'); await h.api.startSelectedView();
  await assert.rejects(h.api.loadCityScript('500000'), /data_500000\.js.*500000/);
  await assert.rejects(h.api.loadCityScript('hidden_game'), /hidden_pano\.js.*hidden_game/);
});

test('post-confirmation searches retain panoid/@/CJK/date/game and release/reload behavior', async () => {
  const h = fixture(); h.select('全国'); await h.api.startSelectedView();
  for (const [query, expected] of [
    [ID_A, [ID_A]], ['@1-23:' + ID_A, [ID_A]], ['Ｇ２１９', [ID_A]],
    ['路B', [ID_B]], ['隐藏路', [ID_H]], ['2014-10', [ID_A, ID_H]], ['@16-20:SCENE', [ID_GAME]],
  ]) {
    await h.api.runGlobalSearch(query);
    assert.deepEqual(Array.from(h.api.state.results, row => row[0]), expected, query);
  }
  const beforeMiss = h.calls.length;
  await h.api.runGlobalSearch('不存在的中文道路');
  assert.equal(h.api.state.results.length, 0); assert.equal(h.calls.length, beforeMiss);
  assert.equal(h.calls.filter(name => name === 'pano_search_index.js').length, 1);
  assert.ok(h.calls.filter(name => name === 'data_500000.js').length > 1, 'Released regular arrays must reload');
  assert.equal(h.window.PANO_CITY['500000'], undefined);
  await h.api.runGlobalSearch('@wrong'); assert.match(h.elements.stats.textContent, /写法有误/);
  h.api.restoreSearchView(); assert.equal(h.api.state.mode, 'overview'); assert.equal(h.api.state.searchActive, false);
  assert.equal(JSON.stringify(rows), originalRows, 'Fixture source fields must remain intact');
});

test('coordinate sorting, county/road/city filters and hidden/game markers are unchanged', async () => {
  const h = fixture(); h.select('重庆市'); await h.api.startSelectedView();
  h.api.state.entries = clone(rows); h.api.state.mode = 'detail'; h.api.state.dispMode = 'points';
  h.elements.search.value = '29.12345678901234,106.12345678901234'; h.api.computeResults();
  assert.equal(h.api.state.distMode, true); assert.equal(h.api.state.results[0].e[0], ID_A);
  h.elements.search.value = ''; h.elements.citySelect.value = '500000'; h.api.computeResults(); assert.equal(h.api.state.results.length, 2);
  h.elements.roadFilter.innerHTML = '<option value=""></option><option value="G219">G219</option>';
  h.elements.roadFilter.value = 'G219'; h.api.computeResults(); assert.equal(h.api.state.results.length, 1);
  h.api.state.countyFilter = '500102'; h.api.computeResults(); assert.equal(h.api.state.results.length, 0);
  h.api.state.countyFilter = ''; h.elements.citySelect.value = ''; h.elements.roadFilter.value = '';
  h.api.computeResults(); h.api.renderMapPoints();
  const hits = h.renders.at(-1).args[1]; assert.equal(hits.filter(point => point[3]).length, 2);
  await h.api.runGlobalSearch('29.12345678901234,106.12345678901234');
  assert.equal(h.api.state.results[0][0], ID_A);
  assert.equal(JSON.stringify(rows), originalRows);
});

test('overlapping searches share an unloaded hidden shard without losing the newest results', async () => {
  const pending = deferred(); let hiddenPromise;
  const h = fixture({ load: (name, { installAsset }) => {
    if (name === 'hidden_pano.js') return hiddenPromise ||= pending.promise.then(() => installAsset(name));
    installAsset(name); return Promise.resolve();
  }});
  h.select('全国'); await h.api.startSelectedView();
  const first = h.api.runGlobalSearch('隐藏路'); await flush();
  assert.equal(h.calls.filter(name => name === 'hidden_pano.js').length, 1);
  const second = h.api.runGlobalSearch('隐藏路'); await flush();
  assert.equal(h.calls.filter(name => name === 'hidden_pano.js').length, 2, 'Both scans must overlap on the shared loader promise');
  pending.resolve(); await Promise.all([first, second]);
  assert.equal(h.api.state.searchActive, true);
  assert.deepEqual(Array.from(h.api.state.results, row => row[0]), [ID_H]);
  assert.ok(!h.elements.stats.textContent.includes('搜索失败'));
});

for (const action of ['clear input', 'province change', 'city change']) {
  test('pending hidden search is cancelled immediately by ' + action, async () => {
    const pending = deferred();
    const h = fixture({ load: async (name, { installAsset }) => {
      if (name === 'hidden_pano.js') await pending.promise;
      installAsset(name);
    }});
    h.select('重庆市'); await h.api.startSelectedView();
    h.elements.search.value = '隐藏路';
    const search = h.api.runGlobalSearch('隐藏路'); await flush();
    assert.equal(h.api.state.searchActive, false, 'Search is pending, not yet displaying results');
    const token = h.api.state.searchToken;
    if (action === 'clear input') { h.elements.search.value = ''; h.elements.search.emit('input'); }
    else if (action === 'province change') h.select('腾讯游戏街景');
    else { h.elements.citySelect.value = '500000'; h.elements.citySelect.emit('change'); }
    assert.ok(h.api.state.searchToken > token, 'Cancellation must happen before asset completion');
    const stats = h.elements.stats.textContent;
    pending.resolve(); await search;
    assert.equal(h.api.state.searchActive, false); assert.equal(h.api.state.results.length, 0);
    assert.equal(h.api.state.mode, action === 'city change' ? 'city' : 'overview');
    assert.equal(h.elements.stats.textContent, stats, 'A cancelled scan must not overwrite scope status');
    assert.equal(h.elements.loadingData.style.display, 'none');
 });
}

test('coordinate input immediately cancels a pending hidden search and removes its overlay', async () => {
  for (const city of ['', '500000']) {
    const pending = deferred();
    const h = fixture({ load: async (name, { installAsset }) => {
      if (name === 'hidden_pano.js') await pending.promise;
      installAsset(name);
    } });
    h.select('重庆市', city); await h.api.startSelectedView();
    h.elements.search.value = '隐藏路';
    const search = h.api.runGlobalSearch('隐藏路'); await flush();
    assert.equal(h.elements.loadingData.style.display, 'block');
    const token = h.api.state.searchToken;
    h.elements.search.value = '29.2,106.2'; h.elements.search.emit('input');
    assert.ok(h.api.state.searchToken > token);
    assert.equal(h.elements.loadingData.style.display, 'none', 'Coordinate guard must clear the cancelled search overlay immediately');
    assert.match(h.elements.mapHint.textContent, /坐标搜索请先选择城市或省份/);
    const stats = h.elements.stats.textContent;
    pending.resolve(); await search;
    assert.equal(h.api.state.mode, city ? 'city' : 'overview');
    assert.equal(h.api.state.searchActive, false); assert.equal(h.api.state.results.length, 0);
    assert.equal(h.elements.loadingData.style.display, 'none');
    assert.equal(h.elements.stats.textContent, stats);
  }
});

test('selecting all counties cancels pending city detail and clears loading/confirmation overlays', async () => {
  for (const gated of [false, true]) {
    const pending = deferred();
    const h = fixture({ load: async (name, { installAsset }) => {
      if (name === 'data_500000.js') await pending.promise;
      installAsset(name);
    } });
    h.select('重庆市', '500000'); await h.api.startSelectedView();
    h.elements.countySelect.innerHTML = '<option value="">全部区县</option><option value="500101">万州区</option>';
    if (gated) h.window.PANO_COUNT['500000'] = 300000;
    h.elements.countySelect.value = '500101'; h.elements.countySelect.emit('change');
    await flush();
    if (gated) {
      assert.equal(h.elements.nationGate.style.display, 'block'); assert.equal(typeof h.api.state.gateRun, 'function');
    } else assert.equal(h.elements.loadingData.style.display, 'block');
    const token = h.api.state.viewToken;
    h.elements.countySelect.value = ''; h.elements.countySelect.emit('change');
    assert.ok(h.api.state.viewToken > token);
    assert.equal(h.api.state.mode, 'city'); assert.equal(h.api.state.countyFilter, '');
    assert.equal(h.elements.loadingData.style.display, 'none', 'Returning to the city grid must immediately hide cancelled detail loading');
    assert.equal(h.elements.nationGate.style.display, 'none'); assert.equal(h.api.state.gateRun, null);
    pending.resolve(); await flush();
    assert.equal(h.api.state.mode, 'city'); assert.equal(h.api.state.entries.length, 0);
    assert.equal(h.elements.loadingData.style.display, 'none');
    assert.deepEqual(h.calls, gated ? ['grid_all.js'] : ['grid_all.js', 'data_500000.js']);
  }
});

test('out-of-order regular/hidden city loads cannot overwrite the newest selected view', async () => {
  const regular = deferred(), hidden = deferred(); const completed = [];
  const h = fixture({ load: async (name, { installAsset }) => {
    if (name === 'data_500000.js') await regular.promise;
    if (name === 'hidden_pano.js') await hidden.promise;
    installAsset(name);
  }});
  h.select('重庆市'); await h.api.startSelectedView();
  const first = h.api.loadKeys(['500000'], '500000', () => completed.push('regular'));
  const second = h.api.loadKeys(['hidden_500000'], 'hidden_500000', () => completed.push('hidden'));
  hidden.resolve(); await second;
  assert.equal(h.api.state.cityFilter, 'hidden_500000'); assert.equal(h.api.state.entries[0][0], ID_H);
  regular.resolve(); await first;
  assert.equal(h.api.state.cityFilter, 'hidden_500000');
  assert.deepEqual(Array.from(h.api.state.entries, row => row[0]), [ID_H]);
  assert.deepEqual(completed, ['hidden']);
});

test('scope change cancels a pending raw city load before it can replace the overview', async () => {
  const pending = deferred(); let completed = false;
  const h = fixture({ load: async (name, { installAsset }) => {
    if (name === 'data_500000.js') await pending.promise;
    installAsset(name);
  }});
  h.select('重庆市'); await h.api.startSelectedView();
  const load = h.api.loadKeys(['500000'], '500000', () => { completed = true; });
  h.select('腾讯游戏街景');
  pending.resolve(); await load;
  assert.equal(h.api.state.province, '腾讯游戏街景'); assert.equal(h.api.state.mode, 'overview');
  assert.equal(h.api.state.entries.length, 0); assert.equal(completed, false);
});

test('post-confirmation city data and search index failures remain retryable', async () => {
  let failure = '';
  const h = fixture({ load: async (name, { installAsset }) => { if (name === failure) throw Error('fixture integrity failure'); installAsset(name); }});
  h.select('全国'); await h.api.startSelectedView();
  failure = 'pano_search_index.js'; await h.api.runGlobalSearch(ID_A);
  assert.match(h.elements.stats.textContent, /搜索失败/); assert.equal(h.api.state.searchIndexPromise, null);
  failure = 'data_500000.js'; await h.api.runGlobalSearch(ID_A); assert.match(h.elements.stats.textContent, /搜索失败/);
  failure = ''; await h.api.runGlobalSearch(ID_A); assert.equal(h.api.state.results[0][0], ID_A);
  assert.equal(h.calls.filter(name => name === 'pano_search_index.js').length, 2);
});
