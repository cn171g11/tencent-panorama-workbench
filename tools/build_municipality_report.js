#!/usr/bin/env node
/* Derive exact report-only district counts without changing any point source.
 * Only collections owned by the four municipalities are counted. Outside points
 * remain explicit residuals; no nearest, coordinate conversion, or grid estimates.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { forEachPanoRow } = require('./stream_pano_rows.js');
const MUNICIPALITIES = { '110000': '北京市', '120000': '天津市', '310000': '上海市', '500000': '重庆市' };
const POLICY = 'datav-gcj02-polygon-covers-lowest-code-residual-v1';
const EPSILON = 1e-10;
const CELL = 0.02;

function sha(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try { for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function signature(file) { const st = fs.statSync(file); return [st.size, st.mtimeMs, st.ctimeMs].join(':'); }
function assignment(text, name) {
  const marker = 'window.' + name + '=', start = text.indexOf(marker);
  if (start < 0) throw Error('Missing ' + name);
  const value = text.slice(start + marker.length), end = value.indexOf(';');
  return JSON.parse(end < 0 ? value : value.slice(0, end));
}
function boxesOverlap(a, b) { return a[0] <= b[2] + EPSILON && a[2] >= b[0] - EPSILON && a[1] <= b[3] + EPSILON && a[3] >= b[1] - EPSILON; }
function pointOnSegment(x, y, a, b) {
  if (x < Math.min(a[0], b[0]) - EPSILON || x > Math.max(a[0], b[0]) + EPSILON || y < Math.min(a[1], b[1]) - EPSILON || y > Math.max(a[1], b[1]) + EPSILON) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return Math.abs((x - a[0]) * dy - (y - a[1]) * dx) <= EPSILON * Math.max(Math.abs(dx) + Math.abs(dy), EPSILON);
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (pointOnSegment(x, y, a, b)) return 2;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : 0;
}
function contains(district, x, y) {
  for (const rings of district.polygons) {
    if (!inRing(x, y, rings[0])) continue;
    // Hole interiors are excluded, their boundary belongs to the polygon boundary.
    if (!rings.slice(1).some(ring => inRing(x, y, ring) === 1)) return true;
  }
  return false;
}
function districtsFromGeoJSON(data, municipality) {
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) throw Error('Missing district features: ' + municipality);
  const seen = new Set();
  return data.features.map(feature => {
    const properties = feature.properties || {}, code = String(properties.adcode || '');
    if (!/^\d{6}$/.test(code) || code.slice(0, 2) !== municipality.slice(0, 2) || seen.has(code) || properties.level !== 'district' || String(properties.parent?.adcode) !== municipality || !properties.name) throw Error('Invalid/duplicate district: ' + code);
    seen.add(code);
    const geometry = feature.geometry || {};
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
    if (!Array.isArray(polygons) || !polygons.length) throw Error('Invalid district geometry: ' + code);
    const bbox = [Infinity, Infinity, -Infinity, -Infinity], edgeBoxes = [];
    for (const rings of polygons) {
      if (!Array.isArray(rings) || !rings.length) throw Error('Missing polygon rings: ' + code);
      for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 4) throw Error('Invalid ring: ' + code);
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], next = ring[(i + 1) % ring.length];
          if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) throw Error('Invalid boundary coordinate: ' + code);
          bbox[0] = Math.min(bbox[0], p[0]); bbox[1] = Math.min(bbox[1], p[1]); bbox[2] = Math.max(bbox[2], p[0]); bbox[3] = Math.max(bbox[3], p[1]);
          edgeBoxes.push([Math.min(p[0], next[0]), Math.min(p[1], next[1]), Math.max(p[0], next[0]), Math.max(p[1], next[1])]);
        }
        const first = ring[0], last = ring.at(-1);
        if (first[0] !== last[0] || first[1] !== last[1]) throw Error('Unclosed ring: ' + code);
      }
    }
    return { code, name: properties.name, polygons, bbox, edgeBoxes };
  }).sort((a, b) => a.code.localeCompare(b.code));
}
function createLocator(districts, maxCache = 16384) {
  if (!Number.isSafeInteger(maxCache) || maxCache < 0) throw Error('Invalid cache limit');
  const cache = new Map(), stats = { interiorHits: 0, exactChecks: 0, cells: 0 };
  function exact(candidates, x, y) { for (const d of candidates) if (x >= d.bbox[0] - EPSILON && x <= d.bbox[2] + EPSILON && y >= d.bbox[1] - EPSILON && y <= d.bbox[3] + EPSILON && contains(d, x, y)) return d.code; return ''; }
  return {
    stats,
    locate(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90 || (x === 0 && y === 0)) throw Error('Invalid panorama coordinate');
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), key = cx + ',' + cy;
      let cell = maxCache ? cache.get(key) : null;
      if (!cell) {
        const box = [cx * CELL - EPSILON, cy * CELL - EPSILON, (cx + 1) * CELL + EPSILON, (cy + 1) * CELL + EPSILON];
        const candidates = districts.filter(d => boxesOverlap(d.bbox, box));
        // This is a topology proof, not a grid-center estimate: no ring segment
        // intersects this closed cell, so membership is constant throughout it.
        const touchesBoundary = candidates.some(d => d.edgeBoxes.some(edge => boxesOverlap(edge, box)));
        cell = { candidates, interior: !touchesBoundary, code: touchesBoundary ? '' : exact(candidates, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2) };
        stats.cells++;
        if (maxCache) { if (cache.size >= maxCache) cache.delete(cache.keys().next().value); cache.set(key, cell); }
      }
      if (cell.interior) { stats.interiorHits++; return cell.code; }
      stats.exactChecks++; return exact(cell.candidates, x, y);
    },
  };
}
function selectedCollections(meta, counts) {
  const selected = {};
  for (const [key, item] of Object.entries(meta)) {
    const code = Object.keys(MUNICIPALITIES).find(code => item.province === MUNICIPALITIES[code]);
    if (!code || item.virtual) continue;
    if (!/^[A-Za-z0-9_]+$/.test(key) || key === 'hidden_game' || !Number.isSafeInteger(counts[key]) || counts[key] < 0) throw Error('Invalid selected collection: ' + key);
    selected[key] = { municipality: code, hidden: key === 'hidden' || key.startsWith('hidden_'), count: counts[key] };
  }
  return selected;
}
function geometryHash() {
  return crypto.createHash('sha256').update([POLICY, EPSILON, CELL, boxesOverlap, pointOnSegment, inRing, contains, districtsFromGeoJSON, createLocator].map(String).join('\n')).digest('hex');
}
function copyJSONL(source, destinationFD, expectedRows) {
  const fd = fs.openSync(source, 'r'), chunk = Buffer.allocUnsafe(65536);
  let lines = 0, bytes = 0, last = -1;
  try {
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null); if (!n) break;
      for (let i = 0; i < n; i++) if (chunk[i] === 10) lines++;
      fs.writeSync(destinationFD, chunk, 0, n); bytes += n; last = chunk[n - 1];
    }
  } finally { fs.closeSync(fd); }
  if (lines !== expectedRows || (bytes && last !== 10)) throw Error('Residual sidecar count/termination mismatch');
}
function emptyContribution() { return { districts: {}, unassigned: { regular: 0, hidden: 0 }, regular: 0, hidden: 0 }; }
function build({ viewer, boundaries, output, evidence, cacheFile = null }) {
  viewer = path.resolve(viewer); boundaries = path.resolve(boundaries); output = path.resolve(output); evidence = path.resolve(evidence);
  if (fs.existsSync(evidence)) throw Error('Choose a new evidence file');
  const metaText = fs.readFileSync(path.join(viewer, 'data_meta.js'), 'utf8');
  const meta = assignment(metaText, 'PANO_META'), counts = assignment(metaText, 'PANO_COUNT');
  const metaHash = sha(path.join(viewer, 'data_meta.js')), selected = selectedCollections(meta, counts);
  const districts = {}, boundaryHashes = {}, locators = {};
  for (const code of Object.keys(MUNICIPALITIES)) {
    const file = path.join(boundaries, code + '.json');
    boundaryHashes[code] = sha(file);
    districts[code] = districtsFromGeoJSON(JSON.parse(fs.readFileSync(file, 'utf8')), code);
    locators[code] = createLocator(districts[code]);
  }
  const municipalities = {};
  for (const code of Object.keys(MUNICIPALITIES)) {
    municipalities[code] = { name: MUNICIPALITIES[code], sourceCounts: {}, districts: districts[code].map(d => ({ code: d.code, name: d.name, regular: 0, hidden: 0, total: 0 })), unassigned: { regular: 0, hidden: 0, total: 0 }, regular: 0, hidden: 0, total: 0 };
  }
  const files = new Map();
  for (const [key, info] of Object.entries(selected)) {
    municipalities[info.municipality].sourceCounts[key] = info.count;
    const name = info.hidden ? 'hidden_pano.js' : 'data_' + key + '.js';
    if (!files.has(name)) files.set(name, {});
    files.get(name)[key] = info.count;
  }
  const previous = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
  const cache = { version: 2, policy: POLICY, geometrySha256: geometryHash(), files: {} }, sources = {}, fileFacts = [];
  const residualFile = evidence.replace(/\.json$/i, '') + '-unassigned.jsonl';
  if (fs.existsSync(residualFile)) throw Error('Residual evidence already exists');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const residualFD = fs.openSync(residualFile, 'wx');
  let scanned = 0, reused = 0;
  try {
    for (const [name, selectedCounts] of files) {
      const file = path.join(viewer, name), before = signature(file), hash = sha(file);
      const municipalitiesInFile = [...new Set(Object.keys(selectedCounts).map(key => selected[key].municipality))].sort();
      const boundariesInFile = Object.fromEntries(municipalitiesInFile.map(code => [code, boundaryHashes[code]]));
      const old = previous?.version === 2 && previous.policy === POLICY && previous.geometrySha256 === cache.geometrySha256 ? previous.files?.[name] : null;
      let same = Boolean(old && old.sha256 === hash && JSON.stringify(old.sourceCounts) === JSON.stringify(selectedCounts) && JSON.stringify(old.boundaryHashes) === JSON.stringify(boundariesInFile));
      if (same && (!old.residualSidecar || !fs.existsSync(old.residualSidecar.path) || sha(old.residualSidecar.path) !== old.residualSidecar.sha256)) same = false;
      let contributions, actual = {}, rows = 0, residualCount = 0, residualSidecar;
      if (same) {
        contributions = old.contributions; actual = old.actualCounts; rows = old.rows; residualCount = old.residualCount; residualSidecar = old.residualSidecar; reused++;
      } else {
        contributions = Object.fromEntries(municipalitiesInFile.map(code => [code, emptyContribution()]));
        const sidecar = residualFile + '.' + name + '.jsonl', sideFD = fs.openSync(sidecar, 'wx');
        try { forEachPanoRow(file, (key, row) => {
          if (!Object.hasOwn(selectedCounts, key)) return;
          const info = selected[key], kind = info.hidden ? 'hidden' : 'regular', bucket = contributions[info.municipality];
          if (!Array.isArray(row) || row.length < 8 || typeof row[0] !== 'string') throw Error('Invalid point row: ' + key);
          actual[key] = (actual[key] || 0) + 1; rows++;
          const district = locators[info.municipality].locate(row[1], row[2]);
          bucket[kind]++;
          if (district) (bucket.districts[district] ||= { regular: 0, hidden: 0 })[kind]++;
          else {
            bucket.unassigned[kind]++;
            residualCount++;
            fs.writeSync(sideFD, JSON.stringify({ collection: key, municipality: info.municipality, sid: row[0], lng: row[1], lat: row[2], kind, reason: 'outside-frozen-district-polygons' }) + '\n');
          }
        }, key => {
          if (Object.hasOwn(selectedCounts, key)) { if (Object.hasOwn(actual, key)) throw Error('Duplicate point assignment: ' + key); actual[key] = 0; }
          else if (name !== 'hidden_pano.js') throw Error('Unselected point collection in a selected file: ' + key);
        }); } finally { fs.closeSync(sideFD); }
        residualSidecar = { path: sidecar, sha256: sha(sidecar) };
        if (sha(file) !== hash) throw Error('Point source changed while scanning: ' + name);
        scanned++;
      }
      if (signature(file) !== before || JSON.stringify(Object.fromEntries(Object.keys(selectedCounts).map(k => [k, actual[k]]))) !== JSON.stringify(selectedCounts)) throw Error('Source signature/count mismatch: ' + name);
      sources[name] = { bytes: fs.statSync(file).size, sha256: hash };
      cache.files[name] = { ...sources[name], boundaryHashes: boundariesInFile, sourceCounts: selectedCounts, actualCounts: actual, contributions, residualSidecar, residualCount, rows };
      for (const code of municipalitiesInFile) {
        const into = municipalities[code], from = contributions[code];
        for (const kind of ['regular', 'hidden']) {
          into[kind] += from[kind]; into.unassigned[kind] += from.unassigned[kind];
          for (const district of into.districts) district[kind] += from.districts[district.code]?.[kind] || 0;
        }
      }
      copyJSONL(residualSidecar.path, residualFD, residualCount);
      fileFacts.push({ file: name, rows, reused: Boolean(same), residuals: residualCount, ...sources[name] });
      console.log(JSON.stringify({ municipalityReportFile: name, rows, reused: Boolean(same), residuals: residualCount }));
    }
  } finally { fs.closeSync(residualFD); }
  for (const code of Object.keys(MUNICIPALITIES)) {
    const m = municipalities[code];
    for (const d of m.districts) d.total = d.regular + d.hidden;
    m.unassigned.total = m.unassigned.regular + m.unassigned.hidden; m.total = m.regular + m.hidden;
    for (const kind of ['regular', 'hidden']) {
      const expected = Object.entries(m.sourceCounts).filter(([key]) => selected[key].hidden === (kind === 'hidden')).reduce((s, [, n]) => s + n, 0);
      if (m[kind] !== expected || m.districts.reduce((s, d) => s + d[kind], m.unassigned[kind]) !== expected) throw Error('District conservation failure: ' + code + '/' + kind);
    }
    if (sha(path.join(boundaries, code + '.json')) !== boundaryHashes[code]) throw Error('Boundary changed during counting');
  }
  if (sha(path.join(viewer, 'data_meta.js')) !== metaHash) throw Error('Metadata changed during counting');
  for (const [name, facts] of Object.entries(sources)) if (sha(path.join(viewer, name)) !== facts.sha256) throw Error('Frozen source changed before report write: ' + name);
  const artifact = { version: 1, policy: POLICY, metaSha256: metaHash, boundaryHashes, sources, municipalities };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = output + '.tmp'; if (fs.existsSync(temp)) throw Error('Unexpected report temp');
  fs.writeFileSync(temp, 'window.PANO_MUNICIPAL_REPORT=' + JSON.stringify(artifact) + ';\n', { flag: 'wx' });
  fs.renameSync(temp, output);
  if (cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); }
  const proof = { passed: true, policy: POLICY, sourceCollections: Object.keys(selected).length, selectedRows: Object.values(municipalities).reduce((s, m) => s + m.total, 0), scannedFiles: scanned, reusedFiles: reused, sourceFiles: fileFacts, boundaryHashes, geometryStats: Object.fromEntries(Object.entries(locators).map(([code, locator]) => [code, locator.stats])), municipalities, reportSha256: sha(output), reportBytes: fs.statSync(output).size, unassignedFile: residualFile };
  fs.writeFileSync(evidence, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ passed: true, output, evidence, scanned, reused, rows: proof.selectedRows, bytes: proof.reportBytes }));
  return artifact;
}
function main() {
  const args = process.argv.slice(2), get = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  if (!get('--boundaries') || !get('--evidence')) throw Error('Required: --boundaries PATH --evidence NEW.json');
  build({ viewer: get('--viewer', path.resolve(__dirname, '../city-viewer')), boundaries: get('--boundaries'), output: get('--output', path.resolve(__dirname, '../city-viewer/municipality-report.js')), evidence: get('--evidence'), cacheFile: get('--cache', null) });
}
if (require.main === module) main();
module.exports = { MUNICIPALITIES, POLICY, assignment, sha, geometryHash, districtsFromGeoJSON, contains, createLocator, selectedCollections, build };
