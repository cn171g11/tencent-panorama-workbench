#!/usr/bin/env python3
"""Build an independent, byte-preserving gzip site.

The default compressor uses only the Python standard library; the optional 7zip
backend uses an already-installed executable for bounded Deflate optimization.
The source viewer is never rewritten. Point shards and derived indexes are streamed
as maximum-level standard gzip, with an empty filename and mtime=0; every output is then compared
chunk-for-chunk against its original. Existing nonempty output directories are
always refused, including after a failed build. Choose a new --output to retry.
"""
from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass
import gzip
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Callable
from urllib.parse import unquote, urlsplit

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_FILES = (
    "index.html", "report.html", "changelog.js", "data_meta.js",
    "data_districts.js", "asset-loader.js", "pano.html",
)
DERIVED_FILES = ("hidden_pano.js", "grid_all.js", "pano_search_index.js")
CHUNK_SIZE = 1024 * 1024
MAX_WORKERS = 16
DEFAULT_WORKERS = min(4, os.cpu_count() or 1)
MANIFEST_PREFIX = "window.PANO_ASSET_MANIFEST="
REDIRECT = b'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3;url=city-viewer/">
<title>tencent-panorama-workbench</title></head>
<body><h1>tencent-panorama-workbench</h1>
<a id="viewer" href="city-viewer/">Open tencent-panorama-workbench</a>
<script>
(function () {
  var target = new URL('city-viewer/', window.location.href);
  target.search = window.location.search;
  target.hash = window.location.hash;
  document.getElementById('viewer').href = target.href;
  window.location.replace(target.href);
}());
</script></body></html>
'''


class BuildError(ValueError):
    """An unsafe or incomplete publication input/output."""


@dataclass(frozen=True)
class Asset:
    name: str
    size: int
    signature: tuple[int, int, int, int]


def _signature(path: Path) -> tuple[int, int, int, int]:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def _require_file(source: Path, name: str) -> Path:
    path = source / name
    if path.is_symlink() or not path.is_file():
        raise BuildError(f"Required source file is missing or not a regular file: {name}")
    if not path.resolve().is_relative_to(source):
        raise BuildError(f"Source file escapes the viewer directory: {name}")
    return path


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise BuildError(f"Duplicate metadata key: {key}")
        result[key] = value
    return result


def _point_names(source: Path) -> set[str]:
    # Parse ONLY the small metadata object. No point/index JavaScript is parsed,
    # decoded, evaluated, normalized, or reserialized anywhere in this builder.
    text = _require_file(source, "data_meta.js").read_text(encoding="utf-8-sig")
    matches = list(re.finditer(r"\bwindow\.PANO_COUNT\s*=\s*", text))
    if len(matches) != 1:
        raise BuildError("data_meta.js must contain exactly one window.PANO_COUNT assignment")
    try:
        counts, end = json.JSONDecoder(object_pairs_hook=_unique_object).raw_decode(
            text, matches[0].end()
        )
    except json.JSONDecodeError as error:
        raise BuildError("data_meta.js contains an invalid PANO_COUNT JSON object") from error
    if not text[end:].lstrip().startswith(";") or not isinstance(counts, dict):
        raise BuildError("data_meta.js PANO_COUNT must be a semicolon-terminated object")
    names = set()
    for key, count in counts.items():
        if not re.fullmatch(r"[A-Za-z0-9_]+", key):
            raise BuildError("PANO_COUNT contains an unsafe collection key")
        if type(count) is not int or count < 0:
            raise BuildError(f"Invalid PANO_COUNT value for {key}")
        if key == "hidden" or key.startswith("hidden_"):
            continue
        names.add(f"data_{key}.js")
    if not names:
        raise BuildError("PANO_COUNT does not list any point shards")
    actual = {path.name for path in source.glob("data_*.js")
              if path.name not in ("data_meta.js", "data_districts.js")}
    missing, extra = sorted(names - actual), sorted(actual - names)
    if missing:
        raise BuildError("Missing point shards listed in PANO_COUNT: " + ", ".join(missing))
    if extra:
        raise BuildError("Point shards not listed in PANO_COUNT: " + ", ".join(extra))
    return names


class _StaticReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.urls.append(values["src"])
        elif tag == "link" and values.get("href"):
            self.urls.append(values["href"])


def _static_names(source: Path, raw_names: set[str]) -> list[str]:
    names = set(FRONTEND_FILES)
    names.update(path.relative_to(source).as_posix() for path in source.rglob("*.css"))
    # Preserve locally linked CSS / scripts (including vendor scripts), but never
    # accidentally publish a compressed data asset's raw JavaScript counterpart.
    for page in ("index.html", "report.html"):
        parser = _StaticReferences()
        parser.feed(_require_file(source, page).read_text(encoding="utf-8-sig"))
        for value in parser.urls:
            parts = urlsplit(value)
            if parts.scheme or parts.netloc or not parts.path:
                continue
            relative = unquote(parts.path)
            path = Path(relative)
            if relative.startswith(("/", "\\")) or "\\" in relative or ".." in path.parts:
                raise BuildError(f"Local static reference must stay inside city-viewer: {page}")
            name = path.as_posix()
            if name not in raw_names and name != "asset-manifest.js":
                names.add(name)
    for name in sorted(names):
        _require_file(source, name)
    return sorted(names)


def _preflight(source: Path, output: Path) -> tuple[list[Asset], list[str], int]:
    if not source.is_dir():
        raise BuildError("The source viewer directory does not exist")
    if source == output or output.is_relative_to(source) or source.is_relative_to(output):
        raise BuildError("Output must be independent of the source viewer directory")
    if output.exists():
        if not output.is_dir() or any(output.iterdir()):
            raise BuildError("Refusing to overwrite an existing nonempty output; choose a new --output")
    for name in FRONTEND_FILES + DERIVED_FILES:
        _require_file(source, name)
    point_names = _point_names(source)
    raw_names = point_names | set(DERIVED_FILES)
    assets = []
    for name in sorted(raw_names):
        path = _require_file(source, name)
        signature = _signature(path)
        assets.append(Asset(name, signature[2], signature))
    return assets, _static_names(source, raw_names), len(point_names)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_gzip(source: Path, compressed: Path, expected_bytes: int, expected_hash: str) -> None:
    digest = hashlib.sha256()
    byte_count = 0
    with source.open("rb") as original, gzip.open(compressed, "rb") as restored:
        while True:
            raw = original.read(CHUNK_SIZE)
            decoded = restored.read(CHUNK_SIZE)
            if raw != decoded:
                raise BuildError(f"Gzip byte verification failed: {source.name}")
            if not raw:
                break
            byte_count += len(raw)
            digest.update(raw)
    if byte_count != expected_bytes or digest.hexdigest() != expected_hash:
        raise BuildError(f"Gzip size/SHA-256 verification failed: {source.name}")


def _normalize_gzip_header(source: Path, destination: Path) -> None:
    with source.open("rb") as native:
        def exact(size: int) -> bytes:
            value = native.read(size)
            if len(value) != size:
                raise BuildError("Truncated native gzip header")
            return value
        header = exact(10)
        if header[:3] != b"\x1f\x8b\x08" or header[3] & 0xe0:
            raise BuildError("Invalid native gzip header")
        flags = header[3]
        if flags & 4:
            exact(int.from_bytes(exact(2), "little"))
        for flag in (8, 16):
            if flags & flag:
                for _ in range(65536):
                    if exact(1) == b"\0":
                        break
                else:
                    raise BuildError("Native gzip header exceeds the bound")
        if flags & 2:
            exact(2)
        with destination.open("xb") as output:
            output.write(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff")
            for chunk in iter(lambda: native.read(CHUNK_SIZE), b""):
                output.write(chunk)


def _compress_asset(source: Path, destination: Path, asset: Asset, *,
                    backend: str = "python", seven_zip: str | None = None) -> dict:
    if backend == "python":
        return _compress_asset_python(source, destination, asset)
    if backend != "7zip" or not seven_zip:
        raise BuildError("A 7-Zip executable is required for the native gzip backend")
    import shutil
    import subprocess
    import tempfile
    original = source / asset.name
    compressed = destination / (asset.name + ".gz")
    if _signature(original) != asset.signature:
        raise BuildError(f"Source changed after preflight: {asset.name}")
    parent = destination.resolve()
    scratch = Path(tempfile.mkdtemp(prefix=".gzip-", dir=parent)).resolve()
    if scratch.parent != parent or not scratch.name.startswith(".gzip-"):
        raise BuildError("Unexpected native gzip scratch path")
    try:
        native, errors = scratch / "native.gz", scratch / "stderr.txt"
        with errors.open("wb") as stderr:
            try:
                result = subprocess.run([str(seven_zip), "a", "-tgzip", "-mx=9", "-mfb=128",
                    "-mpass=3", "-mmt=1", "-y", str(native), str(original)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=stderr, timeout=600)
            except subprocess.TimeoutExpired as error:
                raise BuildError(f"7-Zip compression timed out: {asset.name}") from error
        if result.returncode:
            detail = errors.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
            raise BuildError(f"7-Zip compression failed: {asset.name} (exit {result.returncode}) {detail}")
        _normalize_gzip_header(native, compressed)
    finally:
        if scratch.is_symlink() or scratch.resolve() != scratch or scratch.parent != parent:
            raise BuildError("Native gzip scratch path changed; refusing cleanup")
        shutil.rmtree(scratch)
    raw_hash = _hash_file(original)
    if _signature(original) != asset.signature:
        raise BuildError(f"Source changed during compression: {asset.name}")
    _verify_gzip(original, compressed, asset.size, raw_hash)
    if _signature(original) != asset.signature:
        raise BuildError(f"Source changed during verification: {asset.name}")
    return {"url": asset.name + ".gz", "bytes": asset.size,
            "compressedBytes": compressed.stat().st_size, "sha256": raw_hash,
            "gzipSha256": _hash_file(compressed)}


def _compress_asset_python(source: Path, destination: Path, asset: Asset) -> dict:
    original = source / asset.name
    compressed = destination / (asset.name + ".gz")
    if _signature(original) != asset.signature:
        raise BuildError(f"Source changed after preflight: {asset.name}")
    digest = hashlib.sha256()
    byte_count = 0
    with original.open("rb") as raw, compressed.open("xb") as output:
        # GzipFile (rather than gzip.compress) sets OS=255 portably in Python 3.12
        # and omits FNAME when filename=''. Streaming bounds memory per worker.
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9,
                           fileobj=output, mtime=0) as encoder:
            for chunk in iter(lambda: raw.read(CHUNK_SIZE), b""):
                digest.update(chunk)
                byte_count += len(chunk)
                encoder.write(chunk)
    raw_hash = digest.hexdigest()
    if byte_count != asset.size or _signature(original) != asset.signature:
        raise BuildError(f"Source changed during compression: {asset.name}")
    _verify_gzip(original, compressed, byte_count, raw_hash)
    if _signature(original) != asset.signature:
        raise BuildError(f"Source changed during verification: {asset.name}")
    return {"url": asset.name + ".gz", "bytes": byte_count,
            "compressedBytes": compressed.stat().st_size, "sha256": raw_hash,
            "gzipSha256": _hash_file(compressed)}


def _js_json(value: object) -> str:
    # Escape HTML delimiters and line separators even when metadata includes
    # unusual names. The manifest remains compact JSON and safe in script tags.
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))


def build_site(source: Path | str = REPOSITORY_ROOT / "city-viewer",
               output: Path | str = REPOSITORY_ROOT / "dist" / "pages", *,
               workers: int = DEFAULT_WORKERS, progress_interval: float = 5.0,
               expected_files: int | None = None,
               progress: Callable[[str], None] | None = None,
               compression_backend: str = "python", seven_zip: Path | str | None = None) -> dict:
    """Build from the metadata inventory, with an optional fixed-count release gate."""
    import shutil
    if compression_backend not in ("python", "7zip"):
        raise BuildError("compression_backend must be python or 7zip")
    native_executable = None
    if compression_backend == "7zip":
        executable = str(seven_zip) if seven_zip is not None else shutil.which("7z") or shutil.which("7zz")
        if not executable or not Path(executable).is_file():
            raise BuildError("7-Zip executable is unavailable; provide --seven-zip")
        native_executable = str(Path(executable).resolve())
        if type(workers) is int and workers > 4:
            raise BuildError("Native gzip compression supports at most 4 bounded workers")
    elif seven_zip is not None:
        raise BuildError("--seven-zip requires the 7zip compression backend")
    if type(workers) is not int or not 1 <= workers <= MAX_WORKERS:
        raise BuildError(f"workers must be between 1 and {MAX_WORKERS}")
    if expected_files is not None and (type(expected_files) is not int or expected_files < 1):
        raise BuildError("expected_files must be a positive integer when supplied")
    if not 0 < progress_interval < float("inf"):
        raise BuildError("progress_interval must be a finite positive number")
    source_path, output_path = Path(source), Path(output)
    if source_path.is_symlink() or output_path.is_symlink():
        raise BuildError("Source/output directory symlinks are not accepted")
    source_path, output_path = source_path.resolve(), output_path.resolve()
    assets, static_names, point_count = _preflight(source_path, output_path)
    if expected_files is not None and len(assets) != expected_files:
        raise BuildError(f"Expected exactly {expected_files} gzip assets, found {len(assets)}")
    started = time.monotonic()
    source_bytes = sum(asset.size for asset in assets)
    if progress:
        progress(f"gzip start files={len(assets)} pointFiles={point_count} "
                 f"bytes={source_bytes} workers={workers} level=9")
    output_path.mkdir(parents=True, exist_ok=True)
    viewer_output = output_path / "city-viewer"
    viewer_output.mkdir()  # exclusive: do not merge a racing or previous build
    for name in static_names:
        target = viewer_output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with (source_path / name).open("rb") as raw, target.open("xb") as copied:
            for chunk in iter(lambda: raw.read(CHUNK_SIZE), b""):
                copied.write(chunk)

    files = {}
    completed_bytes = compressed_bytes = 0
    last_progress = started
    asset_iterator = iter(assets)
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="gzip") as executor:
        pending = {}

        def submit_next() -> bool:
            asset = next(asset_iterator, None)
            if asset is None:
                return False
            pending[executor.submit(_compress_asset, source_path, viewer_output, asset,
                backend=compression_backend, seven_zip=native_executable)] = asset
            return True

        # Bound queued work too: never submit the full repository at once.
        for _ in range(min(len(assets), workers * 2)):
            submit_next()
        try:
            while pending:
                done, _ = wait(pending, timeout=progress_interval, return_when=FIRST_COMPLETED)
                for future in done:
                    asset = pending.pop(future)
                    entry = future.result()
                    files[asset.name] = entry
                    completed_bytes += entry["bytes"]
                    compressed_bytes += entry["compressedBytes"]
                    submit_next()
                now = time.monotonic()
                if progress and (now - last_progress >= progress_interval or not pending):
                    progress(f"gzip progress files={len(files)}/{len(assets)} "
                             f"bytes={completed_bytes}/{source_bytes} compressedBytes={compressed_bytes} "
                             f"seconds={now - started:.1f}")
                    last_progress = now
        except BaseException:
            for future in pending:
                future.cancel()
            raise

    if set(files) != {asset.name for asset in assets}:
        raise BuildError("Manifest inventory does not exactly match the source asset inventory")
    files = dict(sorted(files.items()))
    totals = {"files": len(files), "bytes": completed_bytes,
              "compressedBytes": compressed_bytes, "savedBytes": completed_bytes - compressed_bytes,
              "savingPercent": round((1 - compressed_bytes / completed_bytes) * 100, 4)
              if completed_bytes else 0.0}
    manifest = {"version": 1, "codec": "gzip", "files": files, "totals": totals}
    report = {**manifest, "pointFiles": point_count, "verifiedFiles": len(files),
              "compression": {"level": 9, "mtime": 0, "filename": ""},
              "workers": workers, "seconds": round(time.monotonic() - started, 3),
              "staticFiles": static_names}
    if compression_backend == "7zip":
        report["compression"].update({"backend": "7zip", "fastBytes": 128,
                                      "passes": 3, "threadsPerWorker": 1})
    # Publish success markers only after every gzip has passed byte/SHA checks.
    with (viewer_output / "asset-manifest.js").open("x", encoding="utf-8", newline="\n") as file:
        file.write(MANIFEST_PREFIX + _js_json(manifest) + ";\n")
    with (output_path / "build-report.json").open("x", encoding="utf-8", newline="\n") as file:
        file.write(_js_json(report) + "\n")
    with (output_path / "index.html").open("xb") as file:
        file.write(REDIRECT)
    with (output_path / ".nojekyll").open("xb"):
        pass
    if progress:
        progress(f"gzip complete files={len(files)} verifiedFiles={len(files)} "
                 f"bytes={completed_bytes} compressedBytes={compressed_bytes} "
                 f"savingPercent={totals['savingPercent']:.4f} seconds={report['seconds']:.3f}")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=REPOSITORY_ROOT / "city-viewer",
                        help="source viewer directory (default: repository city-viewer)")
    parser.add_argument("--output", type=Path, default=REPOSITORY_ROOT / "dist" / "pages",
                        help="new or empty output directory (default: repository dist/pages)")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                        help=f"bounded compression threads, 1..{MAX_WORKERS} (default: {DEFAULT_WORKERS})")
    parser.add_argument("--compression-backend", choices=("python", "7zip"), default="python",
                        help="standard gzip compressor; 7zip uses bounded Deflate optimization")
    parser.add_argument("--seven-zip", type=Path, default=None,
                        help="existing 7-Zip executable (otherwise resolve 7z/7zz from PATH)")
    parser.add_argument("--expected-files", type=int, default=None,
                        help="optional exact asset count release gate (default: derive from PANO_COUNT + 3 derived files)")
    parser.add_argument("--progress-interval", type=float, default=5.0,
                        help="progress interval in seconds (default: 5)")
    args = parser.parse_args(argv)
    try:
        build_site(args.source, args.output, workers=args.workers,
                   progress_interval=args.progress_interval, expected_files=args.expected_files,
                   progress=lambda message: print(message, flush=True),
                    compression_backend=args.compression_backend, seven_zip=args.seven_zip)
    except (BuildError, OSError, EOFError) as error:
        print(f"gzip build failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
