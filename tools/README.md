# Tools

## Service Quota

`https://sv.map.qq.com/sv` accepts at most **16.7 points/s** (about 1,000 requests per minute) per
calling address. Exceeding it answers `HTTP 500` with an empty body and `Cost: 0` from
`tRPC-Gateway`, and the address stays refused for a while afterwards.

Every audit or scan must stay below that ceiling. `audit_gap_scan_mobility.mjs` enforces it with a
shared token bucket: bursts of 6, a working rate that starts at 8/s, steps up on success and is
capped at 16.7/s, and backs off when the gateway refuses.

## `city-scan/`

Legacy Python pipeline for regional Tencent Street View metadata collection.

- `bfs.py`: resumable boundary-filtered BFS collection.
- `thumbs.py`: thumbnail download.
- `panorama_batch.py`: level-0 tile download and panorama assembly.
- `assemble.py`: manifest and panoid list generation.
- `build_viewer_data.py`: conversion to viewer data scripts.

The scripts were written for completed historical scans. They keep historical defaults for compatibility, but support local path overrides:

```powershell
$env:PANO_SCAN_BASE = 'D:\pano\mohe'
$env:PANO_SCAN_ROOT = 'D:\pano'
$env:PANO_VIEWER_DIR = 'D:\pano\viewer'
```

Before using them for a new area, verify the request throttle for the current service behavior. Historical scan boundaries and READMEs now live in the [Tencent legacy archive](<../city-viewer/legacy/tencent/>), not root-level regional directories. That archive is read-only reference material: old README file lists and interrupted scans do not authorize new collection, and newly generated outputs must stay outside it. Use the current merge/validation process for any separately authorized import; do not recreate the deleted regional point layers.

## `g212-scan.mjs`

Samples G212 from OSM route geometry and Tencent metadata endpoints.

```powershell
node tools/g212-scan.mjs <key-file> [output-json] [spacing-meters] [radius-meters]
node tools/g212-scan.mjs <key-file> --route-only
```

The key file is read locally. The script logs only a short fingerprint and never prints the key value. Keep key files outside the repository.

The former G212 browser workbench was retired during the [root-directory cleanup](<../docs/repository-cleanup-20261115.md>); this CLI is retained. The original [G212 OSM geometry](<../city-viewer/legacy/tencent/g212/g212-osm-route.geojson>) is source-only evidence, not a scanner output directory. This script writes its default route file relative to the working directory: run new, separately authorized scans from an external local directory and set output paths explicitly; never run it in the archive or use cleanup as permission to query endpoints.

## General Rules

1. Treat downloaded media, raw state, logs, and partial output as local artifacts.
2. Keep public metadata schemas stable because the viewers consume them directly.
3. Validate generated JSON before copying it into a published viewer directory.
4. Keep credentials in local configuration or environment variables.
