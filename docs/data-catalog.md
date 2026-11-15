# tencent-panorama-workbench · Data Catalog

## City Viewer Data

The national viewer consumes JavaScript data files from `city-viewer/`.

| File | Role |
|---|---|
| `data_meta.js` | Names, province grouping, prefecture grouping, and point counts |
| `data_districts.js` | County boundary polygons used by the county selector |
| `grid_all.js` | Pre-aggregated cells used by overview and density rendering |
| `data_<adcode>.js` | Point arrays loaded on demand for a city or region |
| `index.html` | Viewer application |
| [asset-manifest.js](<../city-viewer/asset-manifest.js>) | Null for raw checkout; Brotli v2 compressed/original sizes and SHA-256 in publication, legacy gzip v1 remains supported |
| [asset-loader.js](<../city-viewer/asset-loader.js>) | Same-origin verified compressed loading, bounded decode and retry |
| [brotli-decoder.js](<../city-viewer/brotli-decoder.js>) / [brotli-worker.js](<../city-viewer/brotli-worker.js>) | Lazy native-or-local-WASM Brotli decode; source point JSON bytes are unchanged |

Each point array uses this shape:

```text
[panoid, longitude, latitude, road, captured, heading, hasThumbnail, hasPanorama, source]
```

The viewer must keep this shape stable. Add new fields only at the end and update the viewer and the generator together.

## Historical Regional and Route Sources

The source-only [legacy archive](<../city-viewer/legacy/>) replaces the former root-level regional/route directories. It contains **27 unchanged originals (29,448,064 bytes)**, not another copy of the active viewer point arrays:

| Archive | Current content | Interpretation |
|---|---|---|
| [Tencent regions](<../city-viewer/legacy/tencent/>) — mohe, xinlin, erguna, gaochun, jgdaq, tahe, huma | Seven boundary GeoJSON files and seven historical READMEs | Original scan boundaries/provenance; historical READMEs are not current manifests or outstanding scan tasks |
| [Tencent routes](<../city-viewer/legacy/tencent/>) — g101, g102, g103, g106, g212, g312, lishui-panorama | Six OSM route GeoJSON files and six Tencent street-view-lines GeoJSON files | Line geometry and road/route attributes, not panorama point arrays; G212 has only OSM geometry, Lishui has only Tencent lines |
| [Baidu S341](<../city-viewer/legacy/baidu/s341/s341-baidu-panoramas.json>) | One JSON with 1,718 panorama records, embedded OSM route data and 493 historical error records | Baidu source; coordinates described as WGS84 converted via BD09LL from BD09MC, not Tencent SID/coordinate metadata |

The [inventory](<../city-viewer/legacy/inventory.json>) records exact paths, sizes and hashes, including eight retired workbench HTML files and one retired preview PNG. No archived file is loaded by the national viewer or included in its Brotli publication, totals, search or grid.

Completed legacy Tencent point merges are documented in the [2026-11-03 report](<gansu-heilongjiang-import-20261103.md#L27-L40>). The 2026-11-15 cleanup does not rerun SID membership checks or claim every historical scan source is verified. Old panorama/panoid lists referenced in regional READMEs were removed previously and are not present in the archive.

**Source caveat:** the [Xinlin-named boundary](<../city-viewer/legacy/tencent/xinlin/xinlin-boundary.geojson>) has properties identifying Mohe County / 232723 / 2017, conflicting with the [historical Xinlin README](<../city-viewer/legacy/tencent/xinlin/README.md>). It is retained unchanged for investigation, not adopted as a current Xinlin boundary. Other retained regional coordinates are also not byte-equivalent to the current viewer's district polygons; do not delete them as duplicates or substitute them automatically.

See [cleanup scope and rollback](<repository-cleanup-20261115.md>) for the full classification. Raw scan states, response dumps, downloaded images and logs remain local working files, not archive or publication inputs.

## Validation Checklist

Before publishing generated metadata:

1. Parse every JSON file.
2. Check that every point has a panoid and finite coordinates.
3. Check that the viewer data count matches `data_meta.js`.
4. Rebuild `grid_all.js` when point arrays change.
5. Open the relevant viewer over HTTP and test a point, a filter, and a jump link.
