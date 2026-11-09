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

Each point array uses this shape:

```text
[panoid, longitude, latitude, road, captured, heading, hasThumbnail, hasPanorama, source]
```

The viewer must keep this shape stable. Add new fields only at the end and update the viewer and the generator together.

## Regional Manifests

Regional directories such as `mohe/`, `erguna/`, and `gaochun/` use a manifest plus boundary layout:

```text
<area>/
  <area>-panoramas.json
  <area>-panoids.json
  <area>-panoids.txt
  <area>-boundary.geojson
  README.md
```

The manifest is the published metadata artifact. Raw scan state, response dumps, images, panorama assemblies, and logs are local working files.

## Route Workbench Data

Route projects keep their HTML entry point beside the route-specific JSON and GeoJSON files so GitHub Pages links remain stable. Route metadata should identify its provider, coordinate system, collection time, and source route.

## Validation Checklist

Before publishing generated metadata:

1. Parse every JSON file.
2. Check that every point has a panoid and finite coordinates.
3. Check that the viewer data count matches `data_meta.js`.
4. Rebuild `grid_all.js` when point arrays change.
5. Open the relevant viewer over HTTP and test a point, a filter, and a jump link.
