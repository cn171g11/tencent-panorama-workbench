#!/usr/bin/env node
// G212 street view batch scanner.
//
// Usage:
//   node tools/g212-scan.mjs <key-file> [output-json] [spacing-meters] [radius-meters]
//   node tools/g212-scan.mjs <key-file> --route-only   # refresh g212-osm-route.geojson only
//
// The key file is read locally; the key itself is never printed. Only SHA256
// fingerprints appear in logs, so run logs are safe to share.

import { readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const OVERPASS_ENDPOINT = "https://api.fairwaymapper.com/api/interpreter";
const TENCENT_LOOKUP_URL = "https://sv.map.qq.com/xf";
const TENCENT_DETAIL_URL = "https://sv.map.qq.com/sv";
const USER_AGENT = "tencent-panorama-workbench/g212/1.0";
const QUERY_TIMEOUT_SECONDS = 120;
const G212_QUERY = `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}];(way["ref"~"(^|;)G212(;|$)"](18,73,54,135);rel["route"="road"]["ref"~"G212"];way(r););out geom tags;`;
const EARTH_RADIUS_METERS = 6378245;
const GCJ_AXIS_OFFSET = 0.006693421622965943;
const PI = Math.PI;
const LOOKUP_CONCURRENCY = 3;
const EXPAND_CONCURRENCY = 2;
const REQUEST_SPACING_MS = 80;
const PROGRESS_INTERVAL = 250;
const SCENE_FILTER_RADIUS_METERS = 500;
const MAX_CONSECUTIVE_FAILURES = 20;
const FAILURE_BACKOFF_MS = 10000;
const ROUTE_OUTPUT_FILE = "g212-osm-route.geojson";

const isRouteOnly = process.argv.includes("--route-only");
// Flags must not shift positional arguments, so parse only non-flag arguments.
const positionalArgs = process.argv.slice(2).filter(argument => !argument.startsWith("--"));
const keyFilePath = positionalArgs[0];
const outputFilePath = positionalArgs[1] || "g212-tencent-panoramas.json";
const sampleSpacingMeters = Number(positionalArgs[2] || 400);
const lookupRadiusMeters = Number(positionalArgs[3] || 250);
const logFilePath = `${outputFilePath}.log`;

if (!keyFilePath) {
  console.error("Usage: node tools/g212-scan.mjs <key-file> [output-json] [spacing-meters] [radius-meters]");
  process.exit(1);
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function log(message) {
  const line = `[g212-scan] ${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFile(logFilePath, `${line}\n`).catch(() => {});
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function toRadians(degrees) { return degrees * PI / 180; }

function transformLatitude(latitude, longitude) {
  const offsetX = longitude - 105;
  const offsetY = latitude - 35;
  let offset = -100 + 2 * offsetX + 3 * offsetY + .2 * offsetY ** 2 + .1 * offsetX * offsetY;
  offset += .2 * Math.sqrt(Math.abs(offsetX));
  offset += (20 * Math.sin(6 * offsetX * PI) + 20 * Math.sin(2 * offsetX * PI)) * 2 / 3;
  offset += (20 * Math.sin(offsetY * PI) + 40 * Math.sin(offsetY * PI / 3)) * 2 / 3;
  offset += (160 * Math.sin(offsetY * PI / 12) + 320 * Math.sin(offsetY * PI / 30)) * 2 / 3;
  return offset;
}

function transformLongitude(latitude, longitude) {
  const offsetX = longitude - 105;
  const offsetY = latitude - 35;
  let offset = 300 + offsetX + 2 * offsetY + .1 * offsetX ** 2 + .1 * offsetX * offsetY;
  offset += .2 * Math.sqrt(Math.abs(offsetX));
  offset += (20 * Math.sin(6 * offsetX * PI) + 20 * Math.sin(2 * offsetX * PI)) * 2 / 3;
  offset += (20 * Math.sin(offsetX * PI) + 40 * Math.sin(offsetX * PI / 3)) * 2 / 3;
  offset += (150.0 * Math.sin(offsetX * PI / 12) + 300 * Math.sin(offsetX * PI / 30)) * 2 / 3;
  return offset;
}

function convertWgs84ToGcj02(latitude, longitude) {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < .8293 || latitude > 55.8271) return { lat: latitude, lon: longitude };
  const latitudeRadians = toRadians(latitude);
  const magic = 1 - GCJ_AXIS_OFFSET * Math.sin(latitudeRadians) ** 2;
  const rootMagic = Math.sqrt(magic);
  const latitudeOffset = transformLatitude(latitude, longitude) * 180 / (EARTH_RADIUS_METERS * (1 - GCJ_AXIS_OFFSET) / (magic * rootMagic) * PI);
  const longitudeOffset = transformLongitude(latitude, longitude) * 180 / (EARTH_RADIUS_METERS / rootMagic * Math.cos(latitudeRadians) * PI);
  return { lat: latitude + latitudeOffset, lon: longitude + longitudeOffset };
}

function convertMercatorToLatLng(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) return null;
  const longitude = x / 20037508.34 * 180;
  const latitude = (2 * Math.atan(Math.exp(y / 20037508.34 * PI)) - PI / 2) * 180 / PI;
  return { lat: latitude, lon: longitude };
}

function distanceMeters(firstPoint, secondPoint) {
  const latitudeRadians = toRadians((firstPoint.lat + secondPoint.lat) / 2);
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos(latitudeRadians);
  return Math.hypot((secondPoint.lat - firstPoint.lat) * latitudeScale, (secondPoint.lon - firstPoint.lon) * longitudeScale);
}

function interpolatePoint(firstPoint, secondPoint, ratio) {
  return { lat: firstPoint.lat + (secondPoint.lat - firstPoint.lat) * ratio, lon: firstPoint.lon + (secondPoint.lon - firstPoint.lon) * ratio };
}

function sampleWay(way, spacingMeters) {
  const samples = [];
  let distanceToNextSample = spacingMeters;
  for (let index = 1; index < way.geometry.length; index += 1) {
    const previousPoint = way.geometry[index - 1];
    const currentPoint = way.geometry[index];
    const segmentDistance = distanceMeters(previousPoint, currentPoint);
    while (segmentDistance > 0 && distanceToNextSample <= segmentDistance) {
      const samplePoint = interpolatePoint(previousPoint, currentPoint, distanceToNextSample / segmentDistance);
      samples.push({ lat: samplePoint.lat, lon: samplePoint.lon, wayId: way.id, streetName: way.tags?.name || way.tags?.ref || "G212" });
      distanceToNextSample += spacingMeters;
    }
    distanceToNextSample -= segmentDistance;
  }
  return samples;
}

function createSamples(routeWays, spacingMeters) {
  const samples = routeWays.flatMap(way => sampleWay(way, spacingMeters));
  const uniqueSamples = new Map();
  samples.forEach(sample => uniqueSamples.set(`${sample.lat.toFixed(4)}:${sample.lon.toFixed(4)}`, sample));
  return [...uniqueSamples.values()];
}

async function fetchTencentJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const responseBytes = await response.arrayBuffer();
  return JSON.parse(new TextDecoder("gbk").decode(responseBytes));
}

async function probeApiKey(keyFilePath) {
  const content = await readFile(keyFilePath, "utf8");
  const candidates = [...new Set([...content.matchAll(/[A-Za-z0-9_\-]{20,}/g)].map(match => match[0]))];
  for (const candidate of candidates) {
    try {
      const response = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${candidate}`, "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: "[out:json][timeout:10];node(1);out;" }),
      });
      if (response.ok) {
        log(`api key accepted: fingerprint=${fingerprint(candidate)}`);
        return candidate;
      }
    } catch {
      // try next candidate
    }
    await sleep(200);
  }
  throw new Error("no working API key found in key file");
}

async function fetchRouteWays(apiKey) {
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: G212_QUERY }),
  });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json();
  if (!Array.isArray(payload.elements)) throw new Error("Overpass payload has no elements");
  return payload.elements.filter(element => Array.isArray(element.geometry) && element.geometry.length > 1);
}

function buildRouteGeojson(routeWays) {
  return {
    type: "FeatureCollection",
    name: "g212-osm-route",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features: routeWays.map(way => ({
      type: "Feature",
      properties: { osmWayId: way.id, ref: way.tags?.ref, name: way.tags?.name },
      geometry: {
        type: "LineString",
        coordinates: way.geometry.map(point => [Number(point.lon.toFixed(6)), Number(point.lat.toFixed(6))]),
      },
    })),
  };
}

function normalizeLookupRecord(sample, detail) {
  if (!detail || !detail.svid) return null;
  const nativePoint = convertMercatorToLatLng(Number(detail.x), Number(detail.y));
  if (!nativePoint) return null;
  return {
    provider: "tencent",
    streetViewId: String(detail.svid),
    latitude: nativePoint.lat,
    longitude: nativePoint.lon,
    nativeLatitude: nativePoint.lat,
    nativeLongitude: nativePoint.lon,
    coordinateSystem: "GCJ-02",
    heading: Number(detail.heading) || 0,
    streetName: detail.road_name || sample.streetName || "G212",
    roadId: sample.wayId,
    source: "Tencent /xf",
    sampleLatitude: sample.lat,
    sampleLongitude: sample.lon,
    type: "hit",
  };
}

async function lookupSample(sample, radiusMeters) {
  const gcjPoint = convertWgs84ToGcj02(sample.lat, sample.lon);
  const searchParams = new URLSearchParams({ lat: gcjPoint.lat.toFixed(6), lng: gcjPoint.lon.toFixed(6), r: String(radiusMeters), output: "json" });
  const payload = await fetchTencentJson(`${TENCENT_LOOKUP_URL}?${searchParams}`);
  return normalizeLookupRecord(sample, payload?.detail);
}

async function runPool(items, worker, concurrency, onProgress) {
  const results = new Array(items.length).fill(null);
  let nextIndex = 0;
  let completed = 0;
  async function consumeQueue() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = await worker(items[currentIndex]);
      } catch {
        results[currentIndex] = null;
      }
      completed += 1;
      onProgress(completed, items.length);
      await sleep(REQUEST_SPACING_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consumeQueue));
  return results;
}

function createLookupWorker(radiusMeters, failureState) {
  return async sample => {
    try {
      const record = await lookupSample(sample, radiusMeters);
      failureState.consecutiveFailures = 0;
      return record;
    } catch (error) {
      failureState.consecutiveFailures += 1;
      if (failureState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`too many consecutive failures (${failureState.consecutiveFailures}), backing off ${FAILURE_BACKOFF_MS}ms`);
        failureState.consecutiveFailures = 0;
        await sleep(FAILURE_BACKOFF_MS);
      }
      throw error;
    }
  };
}

async function expandHit(hit) {
  const payload = await fetchTencentJson(`${TENCENT_DETAIL_URL}?svid=${encodeURIComponent(hit.streetViewId)}&output=json`);
  const scenes = Array.isArray(payload?.detail?.all_scenes) ? payload.detail.all_scenes : [];
  const parentPoint = { lat: hit.nativeLatitude, lon: hit.nativeLongitude };
  return scenes
    .map(scene => {
      const nativePoint = convertMercatorToLatLng(Number(scene.x), Number(scene.y));
      if (!nativePoint || !scene.svid) return null;
      return {
        provider: "tencent",
        streetViewId: String(scene.svid),
        latitude: nativePoint.lat,
        longitude: nativePoint.lon,
        nativeLatitude: nativePoint.lat,
        nativeLongitude: nativePoint.lon,
        coordinateSystem: "GCJ-02",
        heading: hit.heading || 0,
        streetName: hit.streetName,
        roadId: hit.roadId,
        source: "Tencent /sv all_scenes",
        type: "scene",
      };
    })
    .filter(scene => scene && distanceMeters(parentPoint, { lat: scene.latitude, lon: scene.longitude }) <= SCENE_FILTER_RADIUS_METERS);
}

function deduplicateRecords(hitRecords, sceneRecords) {
  const recordsById = new Map();
  sceneRecords.forEach(record => recordsById.set(record.streetViewId, record));
  hitRecords.forEach(record => recordsById.set(record.streetViewId, record));
  return [...recordsById.values()].sort((first, second) => first.latitude - second.latitude || first.longitude - second.longitude);
}

function buildOutputPayload(hitRecords, sceneRecords, routeWays, sampleCount) {
  return {
    schemaVersion: "1.0.0",
    provider: "tencent",
    area: "G212 兰龙线 (兰州—龙邦)",
    coordinateSystem: { native: "GCJ-02", route: "WGS84 from OSM, converted to GCJ-02 for Tencent queries" },
    viewer: { jumpUrlTemplate: "https://qq-map.netlify.app/#base=roadmap&cov=all&center={lat},{lng}&zoom=17&pano={svid}&heading={heading}&pitch=0&svz=0" },
    collection: {
      sampleSpacingMeters,
      lookupRadiusMeters,
      sceneFilterRadiusMeters: SCENE_FILTER_RADIUS_METERS,
      routeWayCount: routeWays.length,
      sampleCount,
      hitCount: hitRecords.length,
      sceneCount: sceneRecords.length,
      collectedAt: new Date().toISOString(),
      source: "FairwayMapper Overpass mirror + Tencent street view endpoints used by qq-map.netlify.app",
    },
    records: deduplicateRecords(hitRecords, sceneRecords),
  };
}

async function main() {
  const startedAt = Date.now();
  const apiKey = await probeApiKey(keyFilePath);

  log("fetching G212 route from Overpass...");
  const routeWays = await fetchRouteWays(apiKey);
  await writeFile(ROUTE_OUTPUT_FILE, JSON.stringify(buildRouteGeojson(routeWays)));
  log(`route ways=${routeWays.length} saved=${ROUTE_OUTPUT_FILE}`);

  if (isRouteOnly) {
    log(`route-only mode finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return;
  }

  const samples = createSamples(routeWays, sampleSpacingMeters);
  log(`samples=${samples.length} spacing=${sampleSpacingMeters}m radius=${lookupRadiusMeters}m`);

  log("looking up Tencent street views...");
  const failureState = { consecutiveFailures: 0 };
  const lookupResults = await runPool(samples, createLookupWorker(lookupRadiusMeters, failureState), LOOKUP_CONCURRENCY, (completed, total) => {
    if (completed % PROGRESS_INTERVAL === 0 || completed === total) log(`lookup ${completed}/${total}`);
  });
  const hitRecords = [...new Map(lookupResults.filter(Boolean).map(record => [record.streetViewId, record])).values()];
  log(`lookup done: hits=${hitRecords.length}`);

  await writeFile(`${outputFilePath}.partial.json`, JSON.stringify(buildOutputPayload(hitRecords, [], routeWays, samples.length), null, 2));

  log("expanding nearby scenes via /sv...");
  const sceneResults = await runPool(hitRecords, expandHit, EXPAND_CONCURRENCY, (completed, total) => {
    if (completed % 25 === 0 || completed === total) log(`expand ${completed}/${total}`);
  });
  const sceneRecords = sceneResults.flatMap(result => result || []);
  log(`expand done: scenes=${sceneRecords.length}`);

  const outputPayload = buildOutputPayload(hitRecords, sceneRecords, routeWays, samples.length);
  await writeFile(outputFilePath, JSON.stringify(outputPayload, null, 2));
  await rm(`${outputFilePath}.partial.json`, { force: true }).catch(() => {});
  log(`finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: records=${outputPayload.records.length} output=${outputFilePath}`);
}

main().catch(error => {
  log(`FAILED: ${error.message}`);
  process.exit(1);
});
