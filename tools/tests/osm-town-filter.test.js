#!/usr/bin/env node
// Verifies the OSM town/park filter: two overlapping units each keep their own
// face, a point outside every unit is still reachable from the city view, and the
// non-OSM cities keep the previous single-membership behaviour.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../city-viewer/index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(inline);

function square(x0, y0, size) {
  return [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]];
}

// Town A spans 113.0-113.2, park P overlaps its east half, town B sits apart.
const townA = { code: 'osm_relation_1', name: '甲镇', unitKind: 'town', source: 'OpenStreetMap',
  crs: 'GCJ-02', relationId: 1, polys: [[square(113.0, 23.0, 0.2)]] };
const parkP = { code: 'osm_relation_2', name: '乙园区', unitKind: 'park', source: 'OpenStreetMap',
  crs: 'GCJ-02', relationId: 2, polys: [[square(113.1, 23.0, 0.2)]] };
const townB = { code: 'osm_relation_3', name: '丙镇', unitKind: 'town', source: 'OpenStreetMap',
  crs: 'GCJ-02', relationId: 3, polys: [[square(113.5, 23.0, 0.1)]] };

const entries = [
  ['s1', 113.15, 23.1, '重叠路', '', '', 0, 0, 'soso', '441900', ''],
  ['s2', 113.05, 23.1, '甲镇路', '', '', 0, 0, 'soso', '441900', ''],
  ['s3', 113.9, 23.9, '界外路', '', '', 0, 0, 'soso', '441900', ''],
];

class Element {
  constructor() { this.style = {}; this.value = ''; this.options = []; this.events = {}; this.disabled = false; }
  set innerHTML(v) { this.html = v; this.options = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.options.push(child); }
  addEventListener(n, f) { this.events[n] = f; }
  focus() {}
}
const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
const document = {
  getElementById: id => elements[id] || null,
  createElement: () => new Element(),
  querySelector: () => new Element(),
  addEventListener() {}, documentElement: { style: { setProperty() {} } },
  head: { appendChild() { throw Error('no direct script injection'); } },
};
const win = {
  PANO_CITY: {},
  PANO_META: { '441900': { name: '东莞市', province: '广东省', pref: '441900' },
               '440100': { name: '广州市', province: '广东省', pref: '440100' } },
  PANO_COUNT: { '441900': 3, '440100': 1 },
  PANO_DISTRICTS: {
    '441900': [townA, parkP, townB].map(u => Object.assign({}, u)),
    '440100': [{ code: '440103', name: '荔湾区', polys: [[square(113.1, 23.0, 0.2)]] }],
  },
  addEventListener() {},
};
win.PanoAssets = { async loadScript(name) {
  if (name === 'data_441900.js') win.PANO_CITY['441900'] = JSON.parse(JSON.stringify(entries));
  else if (name === 'data_440100.js') win.PANO_CITY['440100'] = [['g1', 113.15, 23.1, '广州路', '', '', 0, 0, 'soso', '440100', '']];
  else if (name === 'grid_all.js') win.PANO_GRID_ALL = { '441900': [[11315, 2310, 3]], '440100': [[11315, 2310, 1]] };
  else throw Error('Unexpected asset: ' + name);
} };
const exposed = inline.replace(/\}\)\(\);\s*$/,
  'window.__TEST__={state:state,els:els,assignCounties:assignCounties,computeResults:computeResults,' +
  'updateCountySelect:updateCountySelect,districtsOf:districtsOf,isOsmCity:isOsmCity,' +
  'countyMatches:countyMatches,inUnit:inUnit,loadKeys:loadKeys,parksFirst:parksFirst};})();');
assert(exposed !== inline);
const context = vm.createContext({ window: win, document, navigator: { userAgent: '' }, console, setTimeout, clearTimeout });
vm.runInContext(exposed, context);
const t = win.__TEST__;

// Unit metadata is preserved and parks sort first for automatic hit testing.
assert.equal(t.isOsmCity('441900'), true);
assert.equal(t.isOsmCity('440100'), false);
const ordered = t.parksFirst(t.districtsOf('441900'));
assert.equal(ordered[0].unitKind, 'park');
assert.equal(ordered[0].source, 'OpenStreetMap');

// Band index equals exact even-odd membership on the real polygons.
for (const unit of t.districtsOf('441900')) {
  for (const [x, y] of [[113.15, 23.1], [113.05, 23.1], [112.9, 23.1], [113.3, 23.1], [113.55, 23.05]]) {
    const exact = unit.polys.some(rings =>
      pipLocal(x, y, rings[0]) && !rings.slice(1).some(h => pipLocal(x, y, h)));
    assert.equal(t.inUnit(x, y, unit), exact, 'band index disagreed at ' + x + ',' + y);
  }
}
function pipLocal(x, y, ring) {
  let inside = false, j = ring.length - 1;
  for (let i = 0; i < ring.length; i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

// A point in the overlap belongs to both the town and the park.
const overlap = { 1: ['s1', 113.15, 23.1, '', '', '', 0, 0, 'soso', '441900', ''] };
assert.equal(t.countyMatches(overlap[1], '441900', 'osm_relation_1'), true, 'overlap point must match its town');
assert.equal(t.countyMatches(overlap[1], '441900', 'osm_relation_2'), true, 'overlap point must match the park');
assert.equal(t.countyMatches(overlap[1], '441900', 'osm_relation_3'), false);

// Selecting each unit returns its own face only.
t.state.entries = JSON.parse(JSON.stringify(entries));
t.assignCounties();
assert.equal(t.state.entries[0][10], 'osm_relation_2', 'park wins automatic assignment');
assert.equal(t.state.entries[1][10], 'osm_relation_1');
assert.equal(t.state.entries[2][10], '', 'outside every unit keeps an empty code');

// The out-of-unit point is never dropped and stays reachable city-wide.
t.els.county.value = '';
t.state.countyFilter = '';
t.els.city.value = '441900';
t.els.road.value = '';
t.els.search.value = '';
t.computeResults();
assert.equal(t.state.results.length, 3, 'city-wide view keeps every point including out-of-unit');

// Manual selection of the town includes the overlap point but not the park-only area.
t.state.countyFilter = 'osm_relation_1';
t.computeResults();
assert.deepEqual(t.state.results.map(e => e[0]).sort(), ['s1', 's2']);
t.state.countyFilter = 'osm_relation_2';
t.computeResults();
assert.deepEqual(t.state.results.map(e => e[0]), ['s1'], 'park must not inherit the town face');
t.state.countyFilter = 'osm_relation_3';
t.computeResults();
assert.equal(t.state.results.length, 0);

// Non-OSM cities keep the previous single stored code.
const gz = ['g1', 113.15, 23.1, '', '', '', 0, 0, 'soso', '440100', '440103'];
assert.equal(t.countyMatches(gz, '440100', '440103'), true);
assert.equal(t.countyMatches(gz, '440100', '440999'), false);

// Copy mentions OSM and overlap, not an official district count.
t.updateCountySelect('441900');
assert(t.els.county.title.includes('OSM'), 'label must disclose the OSM source');
assert(t.els.county.title.includes('重叠'), 'label must disclose park overlap');
const optionText = t.els.county.options.map(o => o.textContent).join('|');
assert(optionText.includes('OSM镇街/园区'), 'must not be presented as official districts');
assert(!optionText.includes('全部区县'), 'OSM cities must not use the official district wording');
t.updateCountySelect('440100');
assert.equal(t.els.county.options[0].textContent.startsWith('全部区县'), true);

console.log('PASS: OSM units keep their own faces, parks overlap towns, unassigned points stay city-wide, official districts unchanged');