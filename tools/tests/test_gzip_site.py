"""Tiny, temporary fixtures only: never gzip or rebuild the real viewer corpus."""
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_gzip_site as publisher


class GzipSiteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source" / "city-viewer"
        self.source.mkdir(parents=True)
        self.output = self.root / "published"
        self.point_names = {"data_110000.js", "data_qq_53.js"}
        self.raw_names = self.point_names | set(publisher.DERIVED_FILES)
        self.counts = {"110000": 1, "qq_53": 2, "hidden_110100": 1, "hidden_game": 1}
        self.write_metadata()
        self.fixture_bytes = {
            "index.html": b'<!doctype html><link rel="stylesheet" href="vendor/theme.css">'
                          b'<script src="asset-manifest.js"></script>'
                          b'<script src="vendor/widget.js"></script>'
                          b'<script src="grid_all.js"></script>\r\n',
            "report.html": b'<!doctype html><script src="data_meta.js"></script>\n',
            "changelog.js": '/* 公告 */\r\nwindow.CHANGELOG=[];\r\n'.encode("utf-8"),
            "data_districts.js": b'window.PANO_DISTRICTS={};\n',
            "asset-loader.js": b'window.PanoAssets={};\n',
            "asset-manifest.js": b'window.PANO_ASSET_MANIFEST=null;\n',
            # BOM / CRLF / precision / whitespace remain untouched; even bytes
            # that are not parseable JavaScript must round-trip without decoding.
            "data_110000.js": b'\xef\xbb\xbfwindow.PANO_CITY["110000"] = '
                              b'[["001", 118.123456789012345, 32.000000000000001, '
                              + '"道路", "2020-01-02", "", 0, 1, "腾讯"]];\r\n'.encode("utf-8"),
            "data_qq_53.js": bytes(range(256)) + b'\r\nno trailing newline',
            "hidden_pano.js": b'window.PANO_CITY={hidden_game:[["270130K",1,2]]};\r\n',
            "grid_all.js": b' window.PANO_GRID_ALL = {"110000": [[1, 2, 3]]};',
            "pano_search_index.js": 'window.PANO_SEARCH_INDEX={"roads":{"路":["110000"]}};'.encode("utf-8"),
            "vendor/theme.css": b'body { color: red; }\r\n',
            "vendor/widget.js": b'window.fixtureWidget=true;\n',
        }
        for name, value in self.fixture_bytes.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        self.protected_root = self.source.parent / "index.html"
        self.protected_root.write_bytes(b"protected original root index")

    def write_metadata(self):
        (self.source / "data_meta.js").write_text(
            'window.PANO_META={};\nwindow.PANO_COUNT='
            + json.dumps(self.counts, separators=(",", ":")) + ';\n', encoding="utf-8"
        )

    def build(self, **changes):
        options = {"workers": 2}
        options.update(changes)
        output = options.pop("output", self.output)
        return publisher.build_site(self.source, output, **options)

    def manifest(self, output=None):
        text = ((output or self.output) / "city-viewer" / "asset-manifest.js").read_text("utf-8")
        self.assertTrue(text.startswith(publisher.MANIFEST_PREFIX))
        self.assertTrue(text.endswith(";\n"))
        return json.loads(text[len(publisher.MANIFEST_PREFIX):-2])

    def test_round_trip_manifest_headers_totals_and_no_raw_publication(self):
        snapshot = {path.relative_to(self.source): path.read_bytes()
                    for path in self.source.rglob("*") if path.is_file()}
        report = self.build()
        manifest = self.manifest()
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["codec"], "gzip")
        self.assertEqual(set(manifest["files"]), self.raw_names)
        total_raw = total_gzip = 0
        for name in sorted(self.raw_names):
            original = (self.source / name).read_bytes()
            compressed = (self.output / "city-viewer" / (name + ".gz")).read_bytes()
            self.assertEqual(gzip.decompress(compressed), original)
            self.assertEqual(compressed[:3], b"\x1f\x8b\x08")
            self.assertEqual(compressed[3], 0)  # no FNAME / FCOMMENT / optional headers
            self.assertEqual(compressed[4:8], b"\0" * 4)  # mtime=0
            self.assertEqual(compressed[8], 2)  # maximum compression (level 9)
            self.assertEqual(compressed[9], 255)  # no platform-specific OS byte
            entry = manifest["files"][name]
            self.assertEqual(entry, {"url": name + ".gz", "bytes": len(original),
                                    "compressedBytes": len(compressed),
                                    "sha256": hashlib.sha256(original).hexdigest(),
                                    "gzipSha256": hashlib.sha256(compressed).hexdigest()})
            self.assertFalse((self.output / "city-viewer" / name).exists())
            total_raw += len(original)
            total_gzip += len(compressed)
        self.assertEqual(manifest["totals"]["files"], len(self.raw_names))
        self.assertEqual(manifest["totals"]["bytes"], total_raw)
        self.assertEqual(manifest["totals"]["compressedBytes"], total_gzip)
        self.assertEqual(manifest["totals"]["savedBytes"], total_raw - total_gzip)
        self.assertEqual(manifest["totals"], report["totals"])
        self.assertEqual(report["verifiedFiles"], len(self.raw_names))
        self.assertEqual(report["pointFiles"], 2)
        self.assertEqual(json.loads((self.output / "build-report.json").read_text("utf-8")), report)
        self.assertNotIn(str(self.root), (self.output / "build-report.json").read_text("utf-8"))
        for relative, data in snapshot.items():
            self.assertEqual((self.source / relative).read_bytes(), data)
        for name in publisher.FRONTEND_FILES + ("vendor/theme.css", "vendor/widget.js"):
            self.assertEqual((self.output / "city-viewer" / name).read_bytes(),
                             (self.source / name).read_bytes())
        self.assertEqual(self.protected_root.read_bytes(), b"protected original root index")
        self.assertEqual((self.output / "index.html").read_bytes(), publisher.REDIRECT)
        self.assertTrue((self.output / ".nojekyll").is_file())
        expected = {"index.html", "build-report.json", ".nojekyll", "city-viewer/asset-manifest.js"}
        expected |= {"city-viewer/" + name for name in report["staticFiles"]}
        expected |= {"city-viewer/" + name + ".gz" for name in self.raw_names}
        self.assertEqual({p.relative_to(self.output).as_posix() for p in self.output.rglob("*")
                          if p.is_file()}, expected)

    def test_gzip_and_manifest_are_deterministic_across_worker_counts(self):
        self.build(workers=1)
        other = self.root / "second-publication"
        self.build(output=other, workers=4)
        for name in self.raw_names | {"asset-manifest.js"}:
            suffix = "" if name == "asset-manifest.js" else ".gz"
            self.assertEqual((self.output / "city-viewer" / (name + suffix)).read_bytes(),
                             (other / "city-viewer" / (name + suffix)).read_bytes())

    def test_streaming_crosses_chunk_boundaries(self):
        data = (b"raw\x00\xff\r\n" * (publisher.CHUNK_SIZE // 7 + 11)) + b"final byte"
        (self.source / "data_qq_53.js").write_bytes(data)
        self.build()
        self.assertGreater(len(data), publisher.CHUNK_SIZE)
        self.assertEqual(gzip.decompress((self.output / "city-viewer/data_qq_53.js.gz").read_bytes()), data)

    def test_every_required_frontend_and_derived_file_is_required(self):
        for name in publisher.FRONTEND_FILES + publisher.DERIVED_FILES:
            with self.subTest(name=name):
                path = self.source / name
                data = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaisesRegex(publisher.BuildError, name.replace(".", r"\.")):
                        self.build()
                    self.assertFalse(self.output.exists())
                finally:
                    path.write_bytes(data)

    def test_missing_metadata_listed_shard_fails_without_output(self):
        (self.source / "data_110000.js").unlink()
        with self.assertRaisesRegex(publisher.BuildError, "Missing point shards.*data_110000"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_unlisted_shard_fails_without_output(self):
        (self.source / "data_stray.js").write_bytes(b"do not silently publish this")
        with self.assertRaisesRegex(publisher.BuildError, "not listed.*data_stray"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_default_count_is_derived_from_metadata_and_indexes(self):
        report = publisher.build_site(self.source, self.output)
        self.assertEqual(report["totals"]["files"], 2 + len(publisher.DERIVED_FILES))
        self.assertEqual(set(report["files"]), self.raw_names)

    def test_new_metadata_listed_shards_are_accepted_without_fixed_gate(self):
        self.counts["120000"] = 1
        self.write_metadata()
        (self.source / "data_120000.js").write_bytes(b"new original shard bytes")
        report = self.build()
        self.assertEqual(report["pointFiles"], 3)
        self.assertEqual(report["totals"]["files"], 6)
        self.assertEqual(set(report["files"]), self.raw_names | {"data_120000.js"})

    def test_optional_release_gate_rejects_wrong_count_without_output(self):
        with self.assertRaisesRegex(publisher.BuildError, "exactly 475.*found 5"):
            self.build(expected_files=475)
        self.assertFalse(self.output.exists())

    def test_optional_release_gate_accepts_exact_count(self):
        self.assertEqual(self.build(expected_files=5)["verifiedFiles"], 5)

    def test_refuses_existing_nonempty_output_even_hidden_file(self):
        self.output.mkdir()
        sentinel = self.output / ".do-not-delete"
        sentinel.write_bytes(b"keep me exactly")
        with self.assertRaisesRegex(publisher.BuildError, "Refusing to overwrite"):
            self.build()
        self.assertEqual(sentinel.read_bytes(), b"keep me exactly")
        self.assertEqual(list(self.output.iterdir()), [sentinel])

    def test_refuses_rebuilding_and_does_not_change_existing_result(self):
        self.build()
        manifest = (self.output / "city-viewer/asset-manifest.js").read_bytes()
        with self.assertRaisesRegex(publisher.BuildError, "Refusing to overwrite"):
            self.build()
        self.assertEqual((self.output / "city-viewer/asset-manifest.js").read_bytes(), manifest)

    def test_empty_existing_directory_is_accepted(self):
        self.output.mkdir()
        self.assertEqual(self.build()["verifiedFiles"], 5)

    def test_output_file_is_not_overwritten(self):
        self.output.write_bytes(b"not a directory")
        with self.assertRaisesRegex(publisher.BuildError, "Refusing to overwrite"):
            self.build()
        self.assertEqual(self.output.read_bytes(), b"not a directory")

    def test_output_cannot_overlap_source(self):
        for destination in (self.source, self.source / "dist", self.source.parent):
            with self.subTest(destination=destination):
                with self.assertRaisesRegex(publisher.BuildError, "independent"):
                    self.build(output=destination)
        self.assertFalse((self.source / "dist").exists())

    def test_validates_bounds_before_creating_output(self):
        for changes in ({"workers": 0}, {"workers": 17}, {"workers": True},
                        {"progress_interval": 0}, {"progress_interval": float("nan")},
                        {"progress_interval": float("inf")}, {"expected_files": 0},
                        {"expected_files": -1}, {"expected_files": True}, {"expected_files": 5.0}):
            with self.subTest(changes=changes):
                with self.assertRaises(publisher.BuildError):
                    self.build(**changes)
                self.assertFalse(self.output.exists())

    def test_invalid_metadata_is_rejected(self):
        for data in ('window.PANO_COUNT={"../escape":1};',
                     'window.PANO_COUNT={"110000":1,"110000":2};',
                     'window.PANO_COUNT={"110000":true};',
                     'window.PANO_COUNT={"110000":-1};',
                     'window.PANO_COUNT={"hidden_game":1};',
                     'window.PANO_COUNT={"110000":1}',
                     'window.PANO_COUNT=oops;',
                     'window.PANO_COUNT={};window.PANO_COUNT={};'):
            with self.subTest(data=data):
                (self.source / "data_meta.js").write_text(data, encoding="utf-8")
                with self.assertRaises(publisher.BuildError):
                    self.build()
                self.assertFalse(self.output.exists())

    def test_missing_local_static_reference_is_rejected(self):
        (self.source / "vendor/widget.js").unlink()
        with self.assertRaisesRegex(publisher.BuildError, "vendor/widget.js"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_traversal_static_reference_is_rejected(self):
        (self.source / "index.html").write_bytes(b'<script src="../secrets.js"></script>')
        with self.assertRaisesRegex(publisher.BuildError, "inside city-viewer"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_sha_and_byte_verification_detect_corruption(self):
        raw = self.root / "raw.js"
        compressed = self.root / "raw.js.gz"
        raw.write_bytes(b"precise bytes")
        compressed.write_bytes(gzip.compress(b"different bytes", mtime=0))
        with self.assertRaisesRegex(publisher.BuildError, "byte verification"):
            publisher._verify_gzip(raw, compressed, len(b"precise bytes"), "wrong")
        compressed.write_bytes(gzip.compress(b"precise bytes", mtime=0))
        with self.assertRaisesRegex(publisher.BuildError, "SHA-256"):
            publisher._verify_gzip(raw, compressed, len(b"precise bytes"), "wrong")
        corrupt = bytearray(compressed.read_bytes())
        corrupt[-8] ^= 1  # corrupt gzip CRC32
        compressed.write_bytes(corrupt)
        with self.assertRaises(gzip.BadGzipFile):
            publisher._verify_gzip(raw, compressed, len(b"precise bytes"), "wrong")

    def test_changed_source_is_rejected_before_compression(self):
        path = self.source / "data_110000.js"
        signature = publisher._signature(path)
        asset = publisher.Asset(path.name, signature[2], signature)
        path.write_bytes(b"changed after preflight")
        self.output.mkdir()
        with self.assertRaisesRegex(publisher.BuildError, "changed after preflight"):
            publisher._compress_asset(self.source, self.output, asset)
        self.assertFalse((self.output / (path.name + ".gz")).exists())

    def test_failed_verification_does_not_publish_success_markers(self):
        with mock.patch.object(publisher, "_verify_gzip", side_effect=publisher.BuildError("fixture failure")):
            with self.assertRaisesRegex(publisher.BuildError, "fixture failure"):
                self.build()
        self.assertFalse((self.output / "city-viewer/asset-manifest.js").exists())
        self.assertFalse((self.output / "build-report.json").exists())
        self.assertTrue(self.output.exists())  # partial output retained, never deleted
        with self.assertRaisesRegex(publisher.BuildError, "Refusing to overwrite"):
            self.build()

    def test_queue_is_bounded_and_progress_reports_verified_totals(self):
        observed = []
        real_wait = publisher.wait

        def checked_wait(pending, **options):
            observed.append(len(pending))
            return real_wait(pending, **options)

        messages = []
        with mock.patch.object(publisher, "wait", side_effect=checked_wait):
            self.build(workers=1, progress_interval=0.001, progress=messages.append)
        self.assertTrue(observed)
        self.assertLessEqual(max(observed), 2)
        self.assertIn("files=5", messages[0])
        self.assertTrue(any("gzip progress" in message for message in messages))
        self.assertIn("verifiedFiles=5", messages[-1])
        self.assertIn("savingPercent=", messages[-1])

    def test_manifest_json_is_script_safe(self):
        value = {"name": "</script>&\u2028\u2029道路"}
        text = publisher._js_json(value)
        self.assertNotIn("<", text)
        self.assertNotIn(">", text)
        self.assertNotIn("&", text)
        self.assertNotIn("\u2028", text)
        self.assertEqual(json.loads(text), value)

    def test_cli_defaults_to_metadata_inventory_without_fixed_count(self):
        arguments = ["--source", str(self.source), "--output", str(self.output), "--workers", "2"]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(publisher.main(arguments), 0)
        self.assertIn("gzip complete files=5 verifiedFiles=5", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    def test_cli_success_and_failure_use_fixture_only(self):
        arguments = ["--source", str(self.source), "--output", str(self.output),
                     "--expected-files", "5", "--workers", "2"]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(publisher.main(arguments), 0)
        self.assertIn("gzip complete files=5 verifiedFiles=5", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(publisher.main(arguments), 1)
        self.assertIn("Refusing to overwrite", stderr.getvalue())


    def test_native_header_metadata_is_removed_without_changing_payload(self):
        import struct
        import zlib
        raw = b'precise\x00\xff\r\nbytes'
        original = gzip.compress(raw, mtime=123)
        header = original[:3] + bytes([0x1e]) + original[4:10]
        header += struct.pack('<H', 4) + b'test' + b'original.js\0comment\0'
        header += struct.pack('<H', zlib.crc32(header) & 0xffff)
        native, normalized = self.root / 'native.gz', self.root / 'normalized.gz'
        native.write_bytes(header + original[10:])
        publisher._normalize_gzip_header(native, normalized)
        value = normalized.read_bytes()
        self.assertEqual(value[:10], b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff')
        self.assertEqual(gzip.decompress(value), raw)

    def test_native_bad_or_unbounded_headers_are_rejected(self):
        payloads = [b'bad', b'x' * 10,
                    b'\x1f\x8b\x08\x20' + b'\0' * 6,
                    b'\x1f\x8b\x08\x08' + b'\0' * 6 + b'x' * 65536]
        for index, data in enumerate(payloads):
            native = self.root / ('bad-%d.gz' % index)
            destination = self.root / ('result-%d.gz' % index)
            native.write_bytes(data)
            with self.assertRaises(publisher.BuildError):
                publisher._normalize_gzip_header(native, destination)
            self.assertFalse(destination.exists())

    def test_native_backend_validates_executable_and_worker_bounds(self):
        for options in [
            {'compression_backend': 'other'},
            {'compression_backend': '7zip', 'seven_zip': self.root / 'missing-7zip'},
            {'compression_backend': '7zip', 'seven_zip': sys.executable, 'workers': 5},
            {'seven_zip': sys.executable},
        ]:
            with self.subTest(options=options), self.assertRaises(publisher.BuildError):
                self.build(**options)
            self.assertFalse(self.output.exists())

    def test_native_process_failure_never_publishes_success(self):
        import subprocess
        def fail(command, **kwargs):
            kwargs['stderr'].write(b'simulated compressor failure')
            return subprocess.CompletedProcess(command, 2)
        with mock.patch('subprocess.run', side_effect=fail):
            with self.assertRaisesRegex(publisher.BuildError, '7-Zip compression failed'):
                self.build(workers=1, compression_backend='7zip', seven_zip=sys.executable)
        self.assertFalse((self.output / 'build-report.json').exists())
        self.assertFalse((self.output / 'city-viewer/asset-manifest.js').exists())
        self.assertFalse(any((self.output / 'city-viewer').glob('.gzip-*')))

    def test_native_corrupt_payload_is_rejected_after_header_normalization(self):
        import subprocess
        def corrupt(command, **kwargs):
            Path(command[-2]).write_bytes(gzip.compress(b'different bytes', mtime=123))
            return subprocess.CompletedProcess(command, 0)
        with mock.patch('subprocess.run', side_effect=corrupt):
            with self.assertRaisesRegex(publisher.BuildError, 'byte verification'):
                self.build(workers=1, compression_backend='7zip', seven_zip=sys.executable)
        self.assertFalse((self.output / 'build-report.json').exists())
        self.assertFalse(any((self.output / 'city-viewer').glob('.gzip-*')))

    def test_native_timeout_is_reported_and_scratch_is_cleaned(self):
        import subprocess
        with mock.patch('subprocess.run', side_effect=subprocess.TimeoutExpired('7zip', 600)):
            with self.assertRaisesRegex(publisher.BuildError, 'timed out'):
                self.build(workers=1, compression_backend='7zip', seven_zip=sys.executable)
        self.assertFalse((self.output / 'build-report.json').exists())
        self.assertFalse(any((self.output / 'city-viewer').glob('.gzip-*')))

    def test_installed_7zip_preserves_all_fixture_bytes_and_canonical_headers(self):
        import shutil
        executable = shutil.which('7z') or shutil.which('7zz')
        installed = Path(r'C:\Program Files\7-Zip\7z.exe')
        if not executable and installed.is_file():
            executable = str(installed)
        if not executable:
            self.skipTest('An installed 7-Zip is required for the optional native fixture')
        snapshot = {path.relative_to(self.source): path.read_bytes()
                    for path in self.source.rglob('*') if path.is_file()}
        report = self.build(workers=1, compression_backend='7zip', seven_zip=executable)
        self.assertEqual(report['compression']['backend'], '7zip')
        self.assertEqual(report['verifiedFiles'], len(self.raw_names))
        for name in self.raw_names:
            encoded = (self.output / 'city-viewer' / (name + '.gz')).read_bytes()
            self.assertEqual(encoded[:10], b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff')
            self.assertEqual(gzip.decompress(encoded), (self.source / name).read_bytes())
        self.assertEqual(snapshot, {path.relative_to(self.source): path.read_bytes()
                                    for path in self.source.rglob('*') if path.is_file()})
        self.assertFalse(any((self.output / 'city-viewer').glob('.gzip-*')))
        self.assertNotIn(str(self.root), (self.output / 'build-report.json').read_text('utf-8'))


if __name__ == "__main__":
    unittest.main()
