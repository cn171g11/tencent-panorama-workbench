# tencent-panorama-workbench · Repository Layout

The repository has four layers. Keeping them separate makes it easier to find a published artifact, reproduce a scan, or update a single route without touching unrelated data.

## Published Site

The committed `city-viewer/` retains raw metadata/data scripts. The actual Pages artifact is an independent `dist/pages` containing small frontend/metadata, verified `.js.br` assets and a v2 Brotli manifest; no duplicate raw/gzip point files. The browser loader still accepts legacy gzip/v1 artifacts. See [Brotli publication](<brotli-publication-20261115.md>).

The publication also ships [brotli-decoder.js](<../city-viewer/brotli-decoder.js>), [brotli-worker.js](<../city-viewer/brotli-worker.js>) and the pinned local [WebAssembly/third-party license](<../city-viewer/vendor/brotli-wasm/NOTICE.md>). Decoder resources are loaded only when Brotli data need decoding; raw source-checkout mode keeps a null asset manifest.

- [Root entry](<../index.html>): redirect to the [national viewer](<../city-viewer/index.html>), keeping the Pages root working.
- [City viewer](<../city-viewer/>): active browser application and its top-level metadata/data scripts.

The current publication ships the national viewer and root redirect, not the former regional/route workbenches. The separate old-address migration site remains unchanged; its [redirect builder](<../tools/build_redirect_site.py>) still lists the historical URL paths independently of the source archive.

## Historical Research Archive

The 15 former root-level research directories were consolidated under [city-viewer/legacy](<../city-viewer/legacy/>). This is **source-only archival material, not a browser-loadable collection or a Pages publication input**.

- [Tencent archive](<../city-viewer/legacy/tencent/>): seven regions' original boundary GeoJSON and historical READMEs, plus OSM route geometry and Tencent street-view lines for G101/G102/G103/G106/G212/G312 and Nanjing Lishui. Lishui is Tencent data; G212 has OSM geometry but no retained Tencent-lines file.
- [Baidu S341 archive](<../city-viewer/legacy/baidu/s341/>): one independent Baidu panorama JSON, never added to Tencent metadata, counts, search or grids.
- [Inventory](<../city-viewer/legacy/inventory.json>): exact former/current paths, byte sizes and hashes for 27 retained originals and 9 retired UI/preview files. Retired workbench code remains recoverable from Git history; it is not re-published.

The regional READMEs are historical evidence, not current directory manifests or instructions to resume scans. Their removed panorama/panoid lists are not restored. The [Xinlin boundary](<../city-viewer/legacy/tencent/xinlin/xinlin-boundary.geojson>) labels itself as Mohe County / 232723 / 2017 and conflicts with its historical README; preserve the original bytes and do not treat the filename as current administrative authority. See the [cleanup rationale and rollback scope](<repository-cleanup-20261115.md>).

Raw BFS state, downloaded images, tiles, logs and private local edits remain outside this archive. Do not add archived files to the viewer's active scripts or publication manifest.

## Tools

- [Regional scan tools](<../tools/city-scan/>): historical Python pipeline for regional scans and manifest generation; local inputs/outputs stay separate from the archive.
- [G212 scanner](<../tools/g212-scan.mjs>): historical route sampler and metadata collector, retained independently of the retired browser workbench.

The tool scripts currently use local input/output paths for historical reproducibility. New scripts should accept paths through command-line arguments or environment variables and must never contain credentials.

## Documentation

- `README.md`: user-facing project overview and published entry points.
- `docs/repository-layout.md`: this structure guide.
- `docs/operations.md`: local development, scan output, and Git synchronization workflow.

## Generated Data Policy

Keep small, stable metadata required by the published site in Git. Keep raw state, logs, downloaded media, temporary files, and local exports outside Git. If a generated artifact is required by a page, document its source and regeneration command before adding it.
