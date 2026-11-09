#!/usr/bin/env python3
"""Validate exact PANO_CITY inventories and SID uniqueness without rewriting data."""
import argparse
import gc
import json
from pathlib import Path
import os
import sys
import re
import tempfile
import zlib
from contextlib import ExitStack

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stream_pano_rows import iter_pano_rows


def check(viewer, *, fast_exit=False, disk_directory=None):
    gc.disable()
    viewer = Path(viewer)
    decoder = json.JSONDecoder()
    meta_source = (viewer / 'data_meta.js').read_text(encoding='utf-8')
    marker = 'window.PANO_COUNT='
    counts, _ = decoder.raw_decode(meta_source, meta_source.index(marker) + len(marker))
    collections = {}
    game_ids = set()
    registered_games = set(json.loads((Path(__file__).resolve().parent / 'data/tencent-game-exceptions.json').read_text(encoding='utf-8'))['panoramaIds'])
    duplicate_count, samples, total, unique_count = 0, [], 0, 0
    paths = sorted(p for p in viewer.glob('data_*.js') if p.name not in ('data_meta.js', 'data_districts.js'))
    paths.append(viewer / 'hidden_pano.js')
    use_disk = disk_directory is not None or sum(counts.values()) >= 1000000
    with ExitStack() as stack:
        buckets, bucket_paths, seen = [], [], set()
        if use_disk:
            if disk_directory is not None:
                Path(disk_directory).mkdir(parents=True, exist_ok=True)
            directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='pano-sid-', dir=disk_directory)))
            bucket_paths = [directory / ('%02x.ids' % index) for index in range(256)]
            buckets = [stack.enter_context(path.open('wb', buffering=65536)) for path in bucket_paths]
        for number, path in enumerate(paths, 1):
            found = False
            def collection(key):
                nonlocal found
                if key in collections:
                    raise ValueError('Duplicate PANO_CITY assignment: ' + key)
                found = True
                collections[key] = 0
            for key, raw, row in iter_pano_rows(path, collection):
                if not isinstance(row, list) or len(row) not in (8, 9) or not isinstance(row[0], str) or not row[0] or '\n' in row[0] or '\r' in row[0]:
                    raise ValueError('Invalid panorama row in ' + key)
                collections[key] += 1
                total += 1
                sid = row[0]
                if key == 'hidden_game':
                    game_ids.add(sid)
                if use_disk:
                    data = sid.encode('utf-8')
                    buckets[zlib.crc32(data) & 255].write(data + b'\n')
                elif sid in seen:
                    duplicate_count += 1
                    if len(samples) < 8:
                        samples.append([sid, key])
                else:
                    seen.add(sid)
            if not found:
                raise ValueError('Point source has no PANO_CITY assignment: ' + path.name)
            if number % 50 == 0:
                print('SID progress files=%d/%d records=%d' % (number, len(paths), total), flush=True)
        for key, count in collections.items():
            if counts.get(key) != count:
                raise ValueError('Collection/count mismatch: ' + key)
        if set(collections) != set(counts) or total != sum(counts.values()):
            raise ValueError('Point inventory does not match all PANO_COUNT keys')
        if game_ids != registered_games:
            raise ValueError('Registered game SID inventory is missing or altered')
        if use_disk:
            for bucket in buckets:
                bucket.close()
            for index, path in enumerate(bucket_paths):
                with path.open('rb') as stream:
                    identifiers = sorted(stream.read().splitlines())
                previous = None
                for sid in identifiers:
                    if sid == previous:
                        duplicate_count += 1
                        if len(samples) < 8:
                            samples.append([sid.decode('utf-8'), 'disk-bucket-%02x' % index])
                    else:
                        unique_count += 1
                    previous = sid
                del identifiers
        else:
            unique_count = len(seen)
    result = {'collections': len(collections), 'records': total, 'uniqueSid': unique_count,
              'duplicateExtra': duplicate_count, 'gamePoints': len(game_ids),
              'sidMode': 'disk-256' if use_disk else 'memory'}
    print(json.dumps(result), flush=True)
    if duplicate_count:
        raise ValueError('Duplicate SIDs: ' + json.dumps(samples))
    if fast_exit:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--viewer', type=Path, default=Path(__file__).resolve().parents[1] / 'city-viewer')
    parser.add_argument('--disk-backed', type=Path, help='directory for bounded-memory SID partitions')
    args = parser.parse_args()
    check(args.viewer, fast_exit=True, disk_directory=args.disk_backed)
