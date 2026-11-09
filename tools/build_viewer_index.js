#!/usr/bin/env node
/*
 * Rebuild the nationwide grid; --with-search also generates the source index
 * consumed by the gzip-only publication build (the derived index is not committed).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { forEachPanoRow } = require('./stream_pano_rows.js');

const VIEWER_ROOT = path.resolve(__dirname, "..", "city-viewer");
const GRID_RESOLUTION = 0.004;
const SEGMENT_START = 15;
const SEGMENT_END = 20;
const PREFIX_LENGTH = 4;

function loadScript(context, fileName) {
  const source = fs.readFileSync(path.join(VIEWER_ROOT, fileName), "utf8");
  vm.runInContext(source, context, { filename: fileName });
}

function parseCityFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const match = source.match(/PANO_CITY\[(.+?)\]=(\[.*\]);\s*$/s);
  if (!match) return null;
  return { key: JSON.parse(match[1]), entries: JSON.parse(match[2]) };
}

function normalizeRoadName(value) {
  return String(value || "")
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function addToIndex(index, value, key) {
  if (!value) return;
  const existing = index[value];
  if (existing) existing.add(key);
  else index[value] = new Set([key]);
}

function serializeIndex(index) {
  const sortedKeys = Object.keys(index).sort();
  const output = {};
  for (const value of sortedKeys) output[value] = Array.from(index[value]).sort();
  return output;
}

function addEntryToStats(stats, key, entry) {
  const panoramaId = String(entry[0]);
  const longitude = Number(entry[1]);
  const latitude = Number(entry[2]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;

  const cellX = Math.floor(longitude / GRID_RESOLUTION);
  const cellY = Math.floor(latitude / GRID_RESOLUTION);
  const cellKey = `${cellX},${cellY}`;
  const cells = stats.grid[key] || (stats.grid[key] = new Map());
  cells.set(cellKey, (cells.get(cellKey) || 0) + 1);

  if (!stats.withSearch) return;
  if (panoramaId.length >= PREFIX_LENGTH) {
    addToIndex(stats.prefix, panoramaId.slice(0, PREFIX_LENGTH).toUpperCase(), key);
  }
  if (panoramaId.length >= SEGMENT_END) {
    addToIndex(stats.segments, panoramaId.slice(SEGMENT_START, SEGMENT_END).toUpperCase(), key);
  }
  addToIndex(stats.roads, normalizeRoadName(entry[3]), key);
  addToIndex(stats.dates, String(entry[4] || "").trim(), key);
}

function collectCityFiles() {
  return fs
    .readdirSync(VIEWER_ROOT)
    .filter((fileName) => /^data_.*\.js$/.test(fileName))
    .filter((fileName) => fileName !== "data_meta.js" && fileName !== "data_districts.js")
    .map((fileName) => path.join(VIEWER_ROOT, fileName));
}

function buildStats(withSearch = false) {
  const stats = { grid: {}, withSearch, prefix: {}, segments: {}, roads: {}, dates: {} };
  let totalEntries = 0;
  const files = collectCityFiles();
  let completedFiles = 0;
  for (const filePath of files) {
    forEachPanoRow(filePath, (key, entry) => {
      addEntryToStats(stats, key, entry);
      totalEntries++;
    }, (key) => { stats.grid[key] = stats.grid[key] || new Map(); });
    if (++completedFiles % 50 === 0) {
      const memory = process.memoryUsage();
      console.log(`index_progress files=${completedFiles}/${files.length} entries=${totalEntries} heap_mb=${(memory.heapUsed / 1048576).toFixed(1)} rss_mb=${(memory.rss / 1048576).toFixed(1)}`);
    }
  }
  forEachPanoRow(path.join(VIEWER_ROOT, 'hidden_pano.js'), (key, entry) => {
    if (key === 'hidden' || key.startsWith('hidden_')) {
      addEntryToStats(stats, key, entry);
      totalEntries++;
    }
  }, (key) => {
    if (key === 'hidden' || key.startsWith('hidden_')) stats.grid[key] = stats.grid[key] || new Map();
  });
  return { stats, totalEntries };
}

function writeGrid(stats) {
  const output = {};
  for (const key of Object.keys(stats.grid)) {
    const cells = [];
    for (const [cellKey, count] of stats.grid[key]) {
      const [cellX, cellY] = cellKey.split(",").map(Number);
      cells.push([cellX, cellY, count]);
    }
    output[key] = cells;
  }
  const payload = `window.PANO_GRID_ALL=${JSON.stringify(output)};`;
  fs.writeFileSync(path.join(VIEWER_ROOT, "grid_all.js"), payload, "utf8");
  synchronizeHiddenGrid(output);
  return { keys: Object.keys(output).length, cells: Object.values(output).reduce((sum, list) => sum + list.length, 0), bytes: Buffer.byteLength(payload) };
}

function synchronizeHiddenGrid(output) {
  const filePath = path.join(VIEWER_ROOT, "hidden_pano.js");
  const found = new Set();
  const source = fs.readFileSync(filePath, "utf8").replace(
    /(window\.PANO_GRID_ALL\[("[^"\\]+")\]=)\[[^;]*\];/g,
    (match, marker, quotedKey) => {
      const key = JSON.parse(quotedKey);
      if (key !== 'hidden' && !key.startsWith('hidden_')) return match;
      if (!output[key]) throw new Error('Hidden grid is missing from index: ' + key);
      found.add(key);
      return marker + JSON.stringify(output[key]) + ';';
    }
  );
  for (const key of Object.keys(output)) {
    if ((key === 'hidden' || key.startsWith('hidden_')) && !found.has(key)) {
      throw new Error('Hidden grid assignment is missing: ' + key);
    }
  }
  fs.writeFileSync(filePath, source, 'utf8');
}

function writeSearchIndex(stats) {
  const filePath = path.join(VIEWER_ROOT, 'pano_search_index.js');
  const descriptor = fs.openSync(filePath, 'w');
  let pending = '';
  function append(value) {
    pending += value;
    if (pending.length >= 65536) { fs.writeSync(descriptor, pending, null, 'utf8'); pending = ''; }
  }
  try {
    append('window.PANO_SEARCH_INDEX={');
    const groups = [['prefix', stats.prefix], ['seg1620', stats.segments], ['roads', stats.roads], ['dates', stats.dates]];
    groups.forEach(([name, index], group) => {
      if (group) append(',');
      append(JSON.stringify(name) + ':{');
      Object.keys(index).sort().forEach((value, number) => {
        if (number) append(',');
        append(JSON.stringify(value) + ':' + JSON.stringify(Array.from(index[value]).sort()));
      });
      append('}');
    });
    append('};');
    if (pending) fs.writeSync(descriptor, pending, null, 'utf8');
  } finally { fs.closeSync(descriptor); }
  return {
    prefixes: Object.keys(stats.prefix).length,
    segments: Object.keys(stats.segments).length,
    roads: Object.keys(stats.roads).length,
    bytes: fs.statSync(filePath).size,
  };
}

function main() {
  const startedAt = Date.now();
  const withSearch = process.argv.includes('--with-search');
  const { stats, totalEntries } = buildStats(withSearch);
  const grid = writeGrid(stats);
  stats.grid = {};
  if (typeof global.gc === 'function') global.gc();
  const index = withSearch ? writeSearchIndex(stats) : null;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `entries=${totalEntries} grid_keys=${grid.keys} grid_cells=${grid.cells} grid_mb=${(grid.bytes / 1048576).toFixed(2)}`
  );
  if (index) {
    console.log(
      `prefixes=${index.prefixes} segments=${index.segments} roads=${index.roads} search_mb=${(index.bytes / 1048576).toFixed(2)} seconds=${seconds}`
    );
  } else {
    console.log(`search=disabled seconds=${seconds}`);
  }
}

if (require.main === module) main();
module.exports = { addEntryToStats, buildStats, writeGrid, writeSearchIndex };
