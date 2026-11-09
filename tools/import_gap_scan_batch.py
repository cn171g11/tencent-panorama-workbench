"""Import audited gap-scan candidates into the viewer collections.

Audit result decides the destination:

  * immobile (``status=hidden``, ``canMove=false``, ``movementCount=0``) -> ``hidden_<adcode>``
  * movable (``status=regular``)                                        -> ``qq_<province>``
  * ``invalid`` / ``error``                                             -> dropped, reported

Points already present in a city layer or in any collection are never written twice.
Prefecture assignment uses DataV GeoAtlas polygons (GCJ-02, same datum as panorama coordinates).
"""
import argparse
import json
import math
from pathlib import Path

GRID_RESOLUTION = 0.004
HIDDEN_MARKER = "腾讯隐藏"
REGULAR_MARKER = "腾讯常规"
HIDDEN_SUFFIX = "·隐藏街景"
REGULAR_NAME = "腾讯常规街景"
NEAREST_LIMIT_KM = 120


def read_assignment(source, name):
    marker = "window.%s=" % name
    start = source.index(marker) + len(marker)
    return json.JSONDecoder().raw_decode(source, start)


def assignment_bounds(source, name):
    marker = "window.%s=" % name
    start = source.index(marker) + len(marker)
    _, end = json.JSONDecoder().raw_decode(source, start)
    return start, end


def entry_identifier(record):
    return str(record.get("sid") or record.get("svid") or record.get("panoid") or record.get("id") or "")


def captured_from_id(identifier):
    import datetime
    if len(identifier) != 23 or not identifier.isdigit():
        return ""
    try:
        captured = datetime.datetime.strptime(identifier[8:20], "%y%m%d%H%M%S")
    except ValueError:
        return ""
    return captured.strftime("%Y-%m-%d %H:%M")


def build_entry(record, marker):
    identifier = entry_identifier(record)
    direction = record.get("dir")
    return [identifier, float(record["lng"]), float(record["lat"]),
            record.get("roadName") or record.get("addr") or "",
            captured_from_id(identifier), "" if direction is None else str(direction),
            0, 0, marker]


def grid_of(entries):
    cells = {}
    for entry in entries:
        key = (math.floor(entry[1] / GRID_RESOLUTION), math.floor(entry[2] / GRID_RESOLUTION))
        cells[key] = cells.get(key, 0) + 1
    return [[cell[0], cell[1], count] for cell, count in cells.items()]


# ---------------------------------------------------------------- boundaries
def in_ring(lng, lat, ring):
    inside = False
    j = len(ring) - 1
    for i, point in enumerate(ring):
        xi, yi = point[0], point[1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            if lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def contains(item, lng, lat):
    for polygon in item["polygons"]:
        if not in_ring(lng, lat, polygon[0]):
            continue
        if any(in_ring(lng, lat, hole) for hole in polygon[1:]):
            continue
        return True
    return False


def segment_km(lng, lat, a, b):
    kx, ky = 111.0 * math.cos(math.radians(lat)), 111.0
    ax, ay = (a[0] - lng) * kx, (a[1] - lat) * ky
    bx, by = (b[0] - lng) * kx, (b[1] - lat) * ky
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(ax, ay)
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx, ay + t * dy)


def load_prefectures(boundaries, province_codes):
    country = json.loads((boundaries / "country.json").read_text(encoding="utf-8"))
    provinces = {str(f["properties"]["adcode"]): f for f in country["features"]
                 if f["properties"].get("level") == "province"}
    items = []
    for code in province_codes:
        feature = provinces.get(code)
        if feature is None:
            raise ValueError("Province boundary missing: %s" % code)
        province = feature["properties"]["name"]
        data = json.loads((boundaries / ("%s.json" % code)).read_text(encoding="utf-8"))
        for child in data["features"]:
            properties = child["properties"]
            if not properties.get("name"):
                continue
            geometry = child["geometry"]
            polygons = (geometry["coordinates"] if geometry["type"] == "MultiPolygon"
                        else [geometry["coordinates"]] if geometry["type"] == "Polygon" else [])
            if not polygons:
                continue
            lngs = [pt[0] for poly in polygons for ring in poly for pt in ring]
            lats = [pt[1] for poly in polygons for ring in poly for pt in ring]
            items.append({"adcode": str(properties["adcode"]), "name": properties["name"],
                          "province": province, "province_code": code,
                          "bbox": (min(lngs), min(lats), max(lngs), max(lats)), "polygons": polygons})
    return items


def locate(items, lng, lat):
    for item in items:
        box = item["bbox"]
        if box[0] <= lng <= box[2] and box[1] <= lat <= box[3] and contains(item, lng, lat):
            return item, "polygon"
    best, best_distance = None, NEAREST_LIMIT_KM
    for item in items:
        box = item["bbox"]
        dx = max(box[0] - lng, 0, lng - box[2]) * 111.0 * math.cos(math.radians(lat))
        dy = max(box[1] - lat, 0, lat - box[3]) * 111.0
        if math.hypot(dx, dy) > best_distance:
            continue
        for polygon in item["polygons"]:
            for ring in polygon:
                for index in range(len(ring) - 1):
                    distance = segment_km(lng, lat, ring[index], ring[index + 1])
                    if distance < best_distance:
                        best_distance, best = distance, item
    return (best, "nearest") if best else (None, "none")


# ---------------------------------------------------------------- viewer state
def load_hidden_collections(viewer):
    source = (viewer / "hidden_pano.js").read_text(encoding="utf-8")
    collections = {}
    cursor = 0
    marker = 'window.PANO_CITY["'
    while True:
        start = source.find(marker, cursor)
        if start == -1:
            break
        name_end = source.index('"]=', start)
        key = source[start + len(marker):name_end]
        entries, value_end = json.JSONDecoder().raw_decode(source, name_end + 3)
        collections[key] = entries
        cursor = value_end
    return collections


def load_meta(viewer):
    source = (viewer / "data_meta.js").read_text(encoding="utf-8")
    meta = read_assignment(source, "PANO_META")[0]
    counts = read_assignment(source, "PANO_COUNT")[0]
    return source, meta, counts


def shard_keys(viewer, prefix):
    keys = []
    for path in sorted(viewer.glob("data_%s*.js" % prefix)):
        source = path.read_text(encoding="utf-8")
        match = source.find('window.PANO_CITY["')
        if match == -1:
            continue
        name_end = source.index('"]=', match)
        keys.append((source[match + len('window.PANO_CITY["'):name_end], path))
    return keys


def load_entries(path):
    source = path.read_text(encoding="utf-8")
    match = source.find('window.PANO_CITY["')
    name_end = source.index('"]=', match)
    key = source[match + len('window.PANO_CITY["'):name_end]
    entries, _ = json.JSONDecoder().raw_decode(source, name_end + 3)
    return key, entries


def collect_existing_ids(viewer, adcodes, province_keys, candidate_ids=None, proof_path=None):
    import hashlib
    from stream_pano_rows import iter_pano_rows

    viewer = Path(viewer)
    paths = sorted(path for path in viewer.glob("data_*.js")
                   if path.name not in ("data_meta.js", "data_districts.js"))
    paths.append(viewer / "hidden_pano.js")
    wanted = set(candidate_ids) if candidate_ids is not None else None
    if proof_path is not None:
        proof = json.loads(Path(proof_path).read_text(encoding="utf-8"))
        if wanted is None or any(not isinstance(sid, str) or "\n" in sid or "\r" in sid for sid in wanted):
            raise ValueError("Exclusion proof requires an exact candidate SID set")
        sid_hash = hashlib.sha256(("\n".join(sorted(wanted)) + "\n").encode("utf-8")).hexdigest()
        if proof.get("version") != 1 or Path(proof.get("viewer", "")).resolve() != viewer.resolve():
            raise ValueError("Exclusion proof belongs to a different viewer")
        if proof.get("candidateCount") != len(wanted) or proof.get("candidateSidSha256") != sid_hash:
            raise ValueError("Exclusion proof candidate set changed")
        meta_bytes = (viewer / "data_meta.js").read_bytes()
        if hashlib.sha256(meta_bytes).hexdigest() != proof.get("metaSha256"):
            raise ValueError("Exclusion proof metadata changed")
        if sum(load_meta(viewer)[2].values()) != proof.get("baselineTotal"):
            raise ValueError("Exclusion proof baseline total changed")
        sources = proof.get("pointSources", {})
        if set(sources) != {path.name for path in paths}:
            raise ValueError("Exclusion proof source inventory changed")
        for path in paths:
            with path.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != sources[path.name]:
                raise ValueError("Exclusion proof point source changed: " + path.name)
        return {}
    if wanted is not None:
        ids = {}
        for path in paths:
            for key, raw, entry in iter_pano_rows(path):
                sid = str(entry[0])
                if sid in wanted:
                    ids[sid] = key
        return ids
    ids = {}
    for code in adcodes:
        for key, path in shard_keys(viewer, code):
            for entry in load_entries(path)[1]:
                ids[str(entry[0])] = key
    for key in province_keys:
        path = viewer / ("data_%s.js" % key)
        if path.is_file():
            for entry in load_entries(path)[1]:
                ids[str(entry[0])] = key
    for key, entries in load_hidden_collections(viewer).items():
        for entry in entries:
            ids[str(entry[0])] = key
    return ids


# ---------------------------------------------------------------- writing
def write_hidden_collections(viewer, collections, meta_updates):
    order = sorted([key for key in collections if key.startswith("hidden_")])
    tail = sorted([key for key in collections if not key.startswith("hidden_")])
    parts = [
        "window.PANO_META=window.PANO_META||{};window.PANO_COUNT=window.PANO_COUNT||{};\n",
        "window.PANO_GRID_ALL=window.PANO_GRID_ALL||{};window.PANO_CITY=window.PANO_CITY||{};\n",
    ]
    for key in order + tail:
        entries = collections[key]
        parts.append('window.PANO_META["%s"]=%s;\n'
                     % (key, json.dumps(meta_updates[key], ensure_ascii=False, separators=(",", ":"))))
        parts.append('window.PANO_COUNT["%s"]=%d;\n' % (key, len(entries)))
        parts.append('window.PANO_GRID_ALL["%s"]=%s;\n'
                     % (key, json.dumps(grid_of(entries), separators=(",", ":"))))
        parts.append('window.PANO_CITY["%s"]=%s;\n'
                     % (key, json.dumps(entries, ensure_ascii=False, separators=(",", ":"))))
    payload = "".join(parts).rstrip("\n")
    (viewer / "hidden_pano.js").write_text(payload, encoding="utf-8", newline="\n")


def write_regular_shard(viewer, key, entries):
    payload = ('window.PANO_CITY=window.PANO_CITY||{};window.PANO_CITY["%s"]=%s;\n'
               % (key, json.dumps(entries, ensure_ascii=False, separators=(",", ":"))))
    (viewer / ("data_%s.js" % key)).write_text(payload, encoding="utf-8", newline="\n")


def update_meta_file(viewer, meta, counts):
    path = viewer / "data_meta.js"
    source = path.read_text(encoding="utf-8")
    meta_start, meta_end = assignment_bounds(source, "PANO_META")
    counts_start, counts_end = assignment_bounds(source, "PANO_COUNT")
    updated = (source[:meta_start] + json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
               + source[meta_end:counts_start] + json.dumps(counts, ensure_ascii=False, separators=(",", ":"))
               + source[counts_end:])
    path.write_text(updated, encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, nargs="+", required=True)
    parser.add_argument("--verification", type=Path, required=True)
    parser.add_argument("--boundaries", type=Path, required=True)
    parser.add_argument("--provinces", nargs="+", required=True,
                        help="province codes without the 0000 suffix, e.g. 23 34 44")
    parser.add_argument("--adcodes", nargs="+", default=[],
                        help="city layer adcodes to check for duplicates")
    parser.add_argument("--viewer", type=Path, default=Path("city-viewer"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--existing-proof", type=Path,
                        help="reuse an already-filtered candidate snapshot after checking every source SHA")
    args = parser.parse_args()

    records = {}
    for path in args.inputs:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for record in payload if isinstance(payload, list) else payload["points"]:
            identifier = entry_identifier(record)
            if identifier:
                records.setdefault(identifier, record)

    verification = json.loads(args.verification.read_text(encoding="utf-8"))
    reviewed = verification["records"]

    source_meta, meta, counts = load_meta(args.viewer)
    hidden = load_hidden_collections(args.viewer)
    hidden_meta = {key: meta.get(key) for key in hidden}
    for key in hidden:
        if hidden_meta[key] is None:
            hidden_meta[key] = {"name": key, "province": key, "pref": key}

    province_codes = sorted({code + "0000" for code in args.provinces})
    prefectures = load_prefectures(args.boundaries, province_codes)

    existing = collect_existing_ids(args.viewer, args.adcodes,
                                    ["qq_" + code for code in args.provinces],
                                    candidate_ids=records, proof_path=args.existing_proof)

    stats = {"candidates": len(records), "hidden": 0, "regular": 0, "invalid": 0, "error": 0,
             "already_present": 0, "imported_hidden": 0, "imported_regular": 0, "no_prefecture": 0}
    hidden_additions = {}
    regular_additions = {}
    skipped = {"invalid": [], "error": [], "already_present": [], "no_prefecture": []}

    for identifier, record in records.items():
        review = reviewed.get(identifier)
        status = review.get("status") if review else "missing"
        if status == "hidden" and review.get("isValid") and review.get("canMove") is False \
                and review.get("movementCount") == 0:
            stats["hidden"] += 1
            if identifier in existing:
                stats["already_present"] += 1
                skipped["already_present"].append(identifier)
                continue
            item, method = locate(prefectures, float(record["lng"]), float(record["lat"]))
            if item is None:
                stats["no_prefecture"] += 1
                skipped["no_prefecture"].append(identifier)
                continue
            key = "hidden_" + item["adcode"]
            hidden_additions.setdefault(key, {"item": item, "records": []})["records"].append(record)
            stats["imported_hidden"] += 1
        elif status == "regular":
            stats["regular"] += 1
            if identifier in existing:
                stats["already_present"] += 1
                skipped["already_present"].append(identifier)
                continue
            item, method = locate(prefectures, float(record["lng"]), float(record["lat"]))
            if item is None:
                stats["no_prefecture"] += 1
                skipped["no_prefecture"].append(identifier)
                continue
            key = "qq_" + item["province_code"][:2]
            additions = regular_additions.setdefault(key, {"item": item, "records": [], "cities": {}})
            additions["records"].append(record)
            city = additions["cities"].setdefault(item["adcode"],
                {"city": item["name"], "province": item["province"], "added": 0})
            city["added"] += 1
            stats["imported_regular"] += 1
        else:
            category = status if status in ("invalid", "error") else "invalid"
            stats[category] += 1
            skipped["invalid" if category == "invalid" else "error"].append(identifier)

    report = {"stats": stats, "hidden_collections": {}, "regular_collections": {}}

    for key, payload in sorted(hidden_additions.items()):
        item = payload["item"]
        entries = hidden.get(key)
        if entries is None:
            entries = []
            hidden_meta[key] = {"name": item["name"] + HIDDEN_SUFFIX, "province": item["province"], "pref": key}
        additions = [build_entry(record, HIDDEN_MARKER) for record in payload["records"]]
        known = {str(entry[0]) for entry in entries}
        fresh = [entry for entry in additions if str(entry[0]) not in known]
        hidden[key] = sorted(entries + fresh, key=lambda entry: str(entry[0]))
        meta[key] = hidden_meta[key]
        counts[key] = len(hidden[key])
        report["hidden_collections"][key] = {"city": item["name"], "province": item["province"],
                                             "added": len(fresh), "total": len(hidden[key]),
                                             "adcode_match": item["adcode"] == key.split("_", 1)[1]}

    for key, payload in sorted(regular_additions.items()):
        item = payload["item"]
        path = args.viewer / ("data_%s.js" % key)
        existing_entries = load_entries(path)[1] if path.is_file() else []
        additions = [build_entry(record, REGULAR_MARKER) for record in payload["records"]]
        known = {str(entry[0]) for entry in existing_entries}
        fresh = [entry for entry in additions if str(entry[0]) not in known]
        entries = sorted(existing_entries + fresh, key=lambda entry: str(entry[0]))
        meta_entry = meta.get(key) or {"name": REGULAR_NAME + "·" + item["province"],
                                       "province": item["province"], "pref": key}
        meta[key] = meta_entry
        counts[key] = len(entries)
        if len(fresh) != len(payload["records"]):
            raise ValueError("Regular additions changed after global exclusion: " + key)
        report["regular_collections"][key] = {"province": item["province"], "added": len(fresh),
                                              "total": len(entries), "cities": payload["cities"]}
        if not args.dry_run:
            write_regular_shard(args.viewer, key, entries)

    if not args.dry_run:
        write_hidden_collections(args.viewer, hidden, hidden_meta)
        update_meta_file(args.viewer, meta, counts)

    report["skipped_samples"] = {name: values[:8] for name, values in skipped.items() if values}
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
