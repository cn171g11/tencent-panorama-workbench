#!/usr/bin/env python3
"""Build an independent, byte-preserving gzip/v1 or Brotli/v2 site.

The default compressor uses only the Python standard library; the optional 7zip
backend uses an already-installed executable for bounded Deflate optimization.
Brotli uses an existing Node executable and native zlib streaming (quality 11,
window 22, at most two workers), with strict decode/byte/SHA verification.
The source viewer is never rewritten. Point shards and derived indexes are streamed
as raw bytes, never decoded or normalized. Existing nonempty output directories
are always refused, including after a failed build. Choose a new --output to retry.
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
# Historical originals are source-only, never part of the Pages artifact.
ARCHIVE_DIRECTORY = "legacy"
FRONTEND_FILES = (
    "index.html", "report.html", "changelog.js", "data_meta.js",
    "data_districts.js", "asset-loader.js", "pano.html",
)
DERIVED_FILES = ("hidden_pano.js", "grid_all.js", "pano_search_index.js")
CHUNK_SIZE = 1024 * 1024
MAX_WORKERS = 16
MAX_BROTLI_WORKERS = 2
MAX_SITE_BYTES = 1_000_000_000
DEFAULT_WORKERS = min(4, os.cpu_count() or 1)
BROTLI_STATIC_FILES = (
    "brotli-decoder.js", "brotli-worker.js",
    "vendor/brotli-wasm/brotli_wasm.mjs", "vendor/brotli-wasm/brotli_wasm_bg.wasm",
    "vendor/brotli-wasm/LICENSE", "vendor/brotli-wasm/NOTICE.md",
)
BROTLI_HELPER = Path(__file__).with_name("brotli_asset_codec.cjs")
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


def _is_archive_path(path: Path) -> bool:
    return bool(path.parts) and path.parts[0] == ARCHIVE_DIRECTORY


def _static_names(source: Path, raw_names: set[str], codec: str = "gzip") -> list[str]:
    names = set(FRONTEND_FILES)
    if codec == "brotli":
        names.update(BROTLI_STATIC_FILES)
    names.update(path.relative_to(source).as_posix() for path in source.rglob("*.css")
                 if not _is_archive_path(path.relative_to(source)))
    # Keep the existing discovery rule (index/report) and resulting publication
    # bytes. Every published HTML page is also checked so pano.html cannot pull
    # source-only archived scripts/styles into an active page.
    for page in (name for name in FRONTEND_FILES if name.endswith(".html")):
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
            if _is_archive_path(path):
                raise BuildError(f"Local static reference targets source-only legacy archive: {page}: {value}")
            name = path.as_posix()
            if page in ("index.html", "report.html") and name not in raw_names and name != "asset-manifest.js":
                names.add(name)
    for name in sorted(names):
        _require_file(source, name)
    return sorted(names)


def _preflight(source: Path, output: Path, codec: str = "gzip") -> tuple[list[Asset], list[str], int]:
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
    return assets, _static_names(source, raw_names, codec), len(point_names)


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


def _resolve_node(node: Path | str | None) -> str:
    import shutil
    executable = shutil.which(str(node)) if node is not None else shutil.which("node")
    if not executable and node is not None and Path(node).is_file():
        executable = str(node)
    if not executable or not Path(executable).is_file():
        raise BuildError("Node executable is unavailable; provide --node")
    if not BROTLI_HELPER.is_file() or BROTLI_HELPER.is_symlink():
        raise BuildError("Native Brotli helper is unavailable")
    return str(Path(executable).resolve())


def _run_brotli(node: str, arguments: list[str], scratch_parent: Path) -> dict:
    import shutil
    import subprocess
    import tempfile
    parent = scratch_parent.resolve()
    scratch = Path(tempfile.mkdtemp(prefix=".brotli-", dir=parent)).resolve()
    if scratch.parent != parent or not scratch.name.startswith(".brotli-"):
        raise BuildError("Unexpected Brotli scratch path")
    try:
        summary, errors = scratch / "summary.json", scratch / "stderr.txt"
        # Real file descriptors (never subprocess.PIPE) work in confined Windows
        # runtimes too. All scratch lives beside the independent output on D/CI.
        environment = dict(os.environ)
        for key in ("TEMP", "TMP", "TMPDIR"):
            environment[key] = str(scratch)
        with summary.open("xb") as stdout, errors.open("xb") as stderr:
            try:
                result = subprocess.run([node, str(BROTLI_HELPER), *arguments],
                    stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    env=environment, timeout=1800)
            except subprocess.TimeoutExpired as error:
                raise BuildError("Brotli helper timed out") from error
        if result.returncode:
            detail = errors.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
            raise BuildError(f"Brotli helper failed (exit {result.returncode}): {detail}")
        if summary.stat().st_size > 4096:
            raise BuildError("Brotli helper summary exceeds bound")
        try:
            entry = json.loads(summary.read_text("utf-8"), object_pairs_hook=_unique_object)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise BuildError("Invalid Brotli helper summary") from error
        expected = {"bytes", "compressedBytes", "sha256", "compressedSha256"}
        if not isinstance(entry, dict) or set(entry) != expected:
            raise BuildError("Invalid Brotli helper summary fields")
        if any(type(entry[key]) is not int or not 0 <= entry[key] <= 2**53 - 1
               for key in ("bytes", "compressedBytes")):
            raise BuildError("Invalid Brotli helper summary sizes")
        if any(not isinstance(entry[key], str) or not re.fullmatch("[a-f0-9]{64}", entry[key])
               for key in ("sha256", "compressedSha256")):
            raise BuildError("Invalid Brotli helper SHA-256")
        return entry
    finally:
        if scratch.is_symlink() or scratch.resolve() != scratch or scratch.parent != parent:
            raise BuildError("Brotli scratch path changed; refusing cleanup")
        shutil.rmtree(scratch)


def _verify_brotli(source: Path, compressed: Path, expected_bytes: int,
                   expected_hash: str, *, node: Path | str | None = None) -> dict:
    return _run_brotli(_resolve_node(node), ["--mode", "verify", "--source", str(source),
        "--output", str(compressed), "--bytes", str(expected_bytes), "--sha256", expected_hash],
        compressed.parent)


def _compress_asset_brotli(source: Path, destination: Path, asset: Asset, *,
                           node: str, quality: int = 11, lgwin: int = 22) -> dict:
    original = source / asset.name
    compressed = destination / (asset.name + ".br")
    if _signature(original) != asset.signature:
        raise BuildError(f"Source changed after preflight: {asset.name}")
    entry = _run_brotli(node, ["--mode", "compress", "--source", str(original),
        "--output", str(compressed), "--quality", str(quality), "--lgwin", str(lgwin)], destination)
    if _signature(original) != asset.signature or entry["bytes"] != asset.size:
        raise BuildError(f"Source changed during compression/verification: {asset.name}")
    if (compressed.is_symlink() or not compressed.is_file()
            or compressed.stat().st_size != entry["compressedBytes"]
            or _hash_file(compressed) != entry["compressedSha256"]):
        raise BuildError(f"Brotli compressed size/SHA-256 verification failed: {asset.name}")
    return {"url": asset.name + ".br", **entry}


def _js_json(value: object) -> str:
    # Escape HTML delimiters and line separators even when metadata includes
    # unusual names. The manifest remains compact JSON and safe in script tags.
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))


def build_site(source: Path | str = REPOSITORY_ROOT / "city-viewer",
               output: Path | str = REPOSITORY_ROOT / "dist" / "pages", *,
               workers: int | None = None, progress_interval: float = 5.0,
               expected_files: int | None = None,
               progress: Callable[[str], None] | None = None,
               compression_backend: str = "python", seven_zip: Path | str | None = None,
               codec: str = "gzip", node: Path | str | None = None,
               brotli_quality: int = 11, brotli_lgwin: int = 22,
               max_site_bytes: int = MAX_SITE_BYTES) -> dict:
    """Build a byte-preserving site; gzip/v1 remains the default API."""
    import shutil
    if codec not in ("gzip", "brotli"):
        raise BuildError("codec must be gzip or brotli")
    if workers is None:
        workers = min(DEFAULT_WORKERS, MAX_BROTLI_WORKERS) if codec == "brotli" else DEFAULT_WORKERS
    if type(brotli_quality) is not int or not 0 <= brotli_quality <= 11:
        raise BuildError("brotli_quality must be between 0 and 11")
    if type(brotli_lgwin) is not int or not 10 <= brotli_lgwin <= 24:
        raise BuildError("brotli_lgwin must be between 10 and 24")
    if type(max_site_bytes) is not int or not 1 <= max_site_bytes <= MAX_SITE_BYTES:
        raise BuildError(f"max_site_bytes must be between 1 and {MAX_SITE_BYTES}; cannot relax 1GB gate")
    node_executable = None
    if codec == "brotli":
        if compression_backend != "python" or seven_zip is not None:
            raise BuildError("Brotli uses only the native Node backend")
        if type(workers) is int and workers > MAX_BROTLI_WORKERS:
            raise BuildError("Brotli compression supports at most 2 bounded workers")
        node_executable = _resolve_node(node)
    elif node is not None:
        raise BuildError("--node requires the brotli codec")
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
    assets, static_names, point_count = _preflight(source_path, output_path, codec)
    if expected_files is not None and len(assets) != expected_files:
        raise BuildError(f"Expected exactly {expected_files} {codec} assets, found {len(assets)}")
    # Snapshot the metadata inventory and static source signatures before copying.
    inventory_signature = _signature(source_path / "data_meta.js")
    static_signatures = {name: _signature(source_path / name) for name in static_names}
    started = time.monotonic()
    source_bytes = sum(asset.size for asset in assets)
    if progress:
        parameters = f"quality={brotli_quality} lgwin={brotli_lgwin}" if codec == "brotli" else "level=9"
        progress(f"{codec} start files={len(assets)} pointFiles={point_count} "
                 f"bytes={source_bytes} workers={workers} {parameters}")
    output_path.mkdir(parents=True, exist_ok=True)
    viewer_output = output_path / "city-viewer"
    viewer_output.mkdir()  # exclusive: do not merge a racing or previous build
    static_hashes = {}
    for name in static_names:
        original = _require_file(source_path, name)
        if _signature(original) != static_signatures[name]:
            raise BuildError(f"Static source changed after preflight: {name}")
        target = viewer_output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with original.open("rb") as raw, target.open("xb") as copied:
            for chunk in iter(lambda: raw.read(CHUNK_SIZE), b""):
                digest.update(chunk)
                copied.write(chunk)
        static_hashes[name] = digest.hexdigest()
        if (_signature(original) != static_signatures[name]
                or _hash_file(target) != static_hashes[name]):
            raise BuildError(f"Static source/copy changed during copying: {name}")

    files = {}
    completed_bytes = compressed_bytes = 0
    last_progress = started
    asset_iterator = iter(assets)
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix=codec) as executor:
        pending = {}

        def submit_next() -> bool:
            asset = next(asset_iterator, None)
            if asset is None:
                return False
            if codec == "brotli":
                future = executor.submit(_compress_asset_brotli, source_path, viewer_output, asset,
                    node=node_executable, quality=brotli_quality, lgwin=brotli_lgwin)
            else:
                future = executor.submit(_compress_asset, source_path, viewer_output, asset,
                    backend=compression_backend, seven_zip=native_executable)
            pending[future] = asset
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
                    progress(f"{codec} progress files={len(files)}/{len(assets)} "
                             f"bytes={completed_bytes}/{source_bytes} compressedBytes={compressed_bytes} "
                             f"seconds={now - started:.1f}")
                    last_progress = now
        except BaseException:
            for future in pending:
                future.cancel()
            raise

    if set(files) != {asset.name for asset in assets}:
        raise BuildError("Manifest inventory does not exactly match the source asset inventory")
    if (_signature(source_path / "data_meta.js") != inventory_signature
            or _point_names(source_path) | set(DERIVED_FILES) != set(files)
            or _static_names(source_path, set(files), codec) != static_names):
        raise BuildError("Source metadata/static inventory changed during build")
    for asset in assets:
        original = _require_file(source_path, asset.name)
        if (_signature(original) != asset.signature
                or _hash_file(original) != files[asset.name]["sha256"]
                or _signature(original) != asset.signature):
            raise BuildError(f"Source changed before publication: {asset.name}")
        compressed = _require_file(viewer_output, files[asset.name]["url"])
        compressed_hash = "compressedSha256" if codec == "brotli" else "gzipSha256"
        if (compressed.stat().st_size != files[asset.name]["compressedBytes"]
                or _hash_file(compressed) != files[asset.name][compressed_hash]):
            raise BuildError(f"Compressed asset changed before publication: {asset.name}")
    for name in static_names:
        original = _require_file(source_path, name)
        if (_signature(original) != static_signatures[name]
                or _hash_file(original) != static_hashes[name]
                or _hash_file(viewer_output / name) != static_hashes[name]):
            raise BuildError(f"Static source/copy changed before publication: {name}")
    files = dict(sorted(files.items()))
    totals = {"files": len(files), "bytes": completed_bytes,
              "compressedBytes": compressed_bytes, "savedBytes": completed_bytes - compressed_bytes,
              "savingPercent": round((1 - compressed_bytes / completed_bytes) * 100, 4)
              if completed_bytes else 0.0}
    manifest = {"version": 2 if codec == "brotli" else 1, "codec": codec, "files": files, "totals": totals}
    compression = ({"backend": "node:zlib", "quality": brotli_quality, "lgwin": brotli_lgwin,
                    "mode": "generic", "threadsPerWorker": 1}
                   if codec == "brotli" else {"level": 9, "mtime": 0, "filename": ""})
    report = {**manifest, "pointFiles": point_count, "verifiedFiles": len(files),
              "compression": compression,
              "workers": workers, "seconds": round(time.monotonic() - started, 3),
              "staticFiles": static_names}
    if compression_backend == "7zip":
        report["compression"].update({"backend": "7zip", "fastBytes": 128,
                                      "passes": 3, "threadsPerWorker": 1})
    expected_output = {"city-viewer/" + name for name in static_names}
    expected_output.update("city-viewer/" + entry["url"] for entry in files.values())
    actual_output = {path.relative_to(output_path).as_posix() for path in output_path.rglob("*")
                     if path.is_file()}
    if actual_output != expected_output or any(path.is_symlink() for path in output_path.rglob("*")):
        raise BuildError("Output inventory does not exactly match expected files")
    success_files = {"city-viewer/asset-manifest.js", "build-report.json", "index.html", ".nojekyll"}
    report["outputFiles"] = sorted(expected_output | success_files)
    manifest_bytes = (MANIFEST_PREFIX + _js_json(manifest) + ";\n").encode("utf-8")
    existing_bytes = sum(path.stat().st_size for path in output_path.rglob("*") if path.is_file())
    report["siteBytes"] = 0
    # Report contains its own size, so find the tiny decimal-length fixed point.
    while True:
        report_bytes = (_js_json(report) + "\n").encode("utf-8")
        site_bytes = existing_bytes + len(manifest_bytes) + len(report_bytes) + len(REDIRECT)
        if report["siteBytes"] == site_bytes:
            break
        report["siteBytes"] = site_bytes
    if site_bytes > max_site_bytes:
        raise BuildError(f"Site size {site_bytes} exceeds siteBytes gate {max_site_bytes} (1GB maximum)")
    # Publish success markers only after every byte/SHA, inventory and size gate.
    with (viewer_output / "asset-manifest.js").open("xb") as file:
        file.write(manifest_bytes)
    with (output_path / "build-report.json").open("xb") as file:
        file.write(report_bytes)
    with (output_path / "index.html").open("xb") as file:
        file.write(REDIRECT)
    with (output_path / ".nojekyll").open("xb"):
        pass
    if progress:
        progress(f"{codec} complete files={len(files)} verifiedFiles={len(files)} "
                 f"bytes={completed_bytes} compressedBytes={compressed_bytes} "
                 f"savingPercent={totals['savingPercent']:.4f} seconds={report['seconds']:.3f}")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=REPOSITORY_ROOT / "city-viewer",
                        help="source viewer directory (default: repository city-viewer)")
    parser.add_argument("--output", type=Path, default=REPOSITORY_ROOT / "dist" / "pages",
                        help="new or empty output directory (default: repository dist/pages)")
    parser.add_argument("--workers", type=int, default=None,
                        help=f"bounded workers 1..{MAX_WORKERS}, Brotli at most 2 (default: gzip {DEFAULT_WORKERS}, Brotli 2)")
    parser.add_argument("--codec", choices=("gzip", "brotli"), default="gzip",
                        help="gzip/v1 compatibility default or Brotli/v2 native streaming compression")
    parser.add_argument("--node", default=None,
                        help="existing Node executable or PATH command (otherwise node from PATH)")
    parser.add_argument("--brotli-quality", type=int, default=11,
                        help="Brotli quality 0..11 (default: 11)")
    parser.add_argument("--brotli-lgwin", type=int, default=22,
                        help="Brotli window 10..24 (default: 22)")
    parser.add_argument("--max-site-bytes", type=int, default=MAX_SITE_BYTES,
                        help="strict total publication gate; at most 1000000000 bytes")
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
                    compression_backend=args.compression_backend, seven_zip=args.seven_zip,
                    codec=args.codec, node=args.node, brotli_quality=args.brotli_quality,
                    brotli_lgwin=args.brotli_lgwin, max_site_bytes=args.max_site_bytes)
    except (BuildError, OSError, EOFError) as error:
        print(f"{args.codec} build failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
