"""Independent, small Brotli fixtures only; never build the real viewer corpus."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest import mock

from tools.tests import test_gzip_site as gzip_fixtures
import build_gzip_site as publisher

# Reuse the gzip fixture factory, NOT its tests (the original 33 run separately).
class BrotliSiteTests(unittest.TestCase):
    write_metadata = gzip_fixtures.GzipSiteTests.write_metadata
    manifest = gzip_fixtures.GzipSiteTests.manifest
    assert_legacy_archive_is_not_published = gzip_fixtures.GzipSiteTests.assert_legacy_archive_is_not_published
    assert_legacy_static_references_are_rejected = gzip_fixtures.GzipSiteTests.assert_legacy_static_references_are_rejected

    def setUp(self):
        gzip_fixtures.GzipSiteTests.setUp(self)
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("Existing Node is required for native Brotli fixtures")
        for name in publisher.BROTLI_STATIC_FILES:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture stub (not used for browser decoding)\r\n")

    def build(self, **changes):
        options = {"codec": "brotli", "node": self.node, "workers": 2}
        options.update(changes)
        output = options.pop("output", self.output)
        return publisher.build_site(self.source, output, **options)

    def compress(self, raw=b"exact bytes\r\n"):
        source = self.root / "raw.bin"
        source.write_bytes(raw)
        sig = publisher._signature(source)
        entry = publisher._compress_asset_brotli(self.root, self.root,
            publisher.Asset(source.name, sig[2], sig), node=self.node)
        # Publisher appends .br to the entire source name.
        return source, self.root / "raw.bin.br", entry

    def verify(self, source, compressed, raw):
        return publisher._verify_brotli(source, compressed, len(raw),
            hashlib.sha256(raw).hexdigest(), node=self.node)

    def no_success(self):
        self.assertFalse((self.output / "build-report.json").exists())
        self.assertFalse((self.output / "city-viewer/asset-manifest.js").exists())

    def test_roundtrip_manifest_raw_bytes_static_and_total_site_bytes(self):
        # Empty stream, BOM/CRLF/precision, every possible byte, no final newline.
        (self.source / "hidden_pano.js").write_bytes(b"")
        snapshot = {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob("*") if p.is_file()}
        report = self.build(expected_files=5)
        manifest = self.manifest()
        self.assertEqual((manifest["version"], manifest["codec"]), (2, "brotli"))
        self.assertEqual(set(manifest["files"]), self.raw_names)
        for name, entry in manifest["files"].items():
            source = self.source / name
            compressed = self.output / "city-viewer" / (name + ".br")
            raw = source.read_bytes()
            verified = self.verify(source, compressed, raw)
            self.assertEqual(entry, {"url": name + ".br", **verified})
            self.assertEqual(set(entry), {"url", "bytes", "compressedBytes", "sha256", "compressedSha256"})
            self.assertFalse((self.output / "city-viewer" / name).exists())
        self.assertEqual(report["compression"], {"backend": "node:zlib", "quality": 11,
            "lgwin": 22, "mode": "generic", "threadsPerWorker": 1})
        for name in publisher.BROTLI_STATIC_FILES:
            self.assertEqual((self.source / name).read_bytes(), (self.output / "city-viewer" / name).read_bytes())
        self.assertEqual(snapshot, {p.relative_to(self.source): p.read_bytes() for p in self.source.rglob("*") if p.is_file()})
        self.assertEqual(report["siteBytes"], sum(p.stat().st_size for p in self.output.rglob("*") if p.is_file()))
        self.assertEqual(set(report["outputFiles"]), {p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()})
        self.assertEqual(report, json.loads((self.output / "build-report.json").read_text("utf-8")))

    def test_legacy_archive_is_not_published(self):
        self.assert_legacy_archive_is_not_published()

    def test_legacy_static_references_are_rejected(self):
        self.assert_legacy_static_references_are_rejected()

    def test_more_than_one_chunk_and_binary_roundtrip(self):
        raw = bytes(range(256)) * (publisher.CHUNK_SIZE // 256 + 1025) + b"\x00\xfffinal"
        source, compressed, entry = self.compress(raw)
        self.assertGreater(len(raw), publisher.CHUNK_SIZE)
        self.assertEqual(entry["bytes"], len(raw))
        self.assertEqual(self.verify(source, compressed, raw)["sha256"], entry["sha256"])

    def test_deterministic_across_worker_counts_and_default_bounded_workers(self):
        first = self.build(workers=1)
        other = self.root / "other"
        second = publisher.build_site(self.source, other, codec="brotli", node=self.node)
        self.assertLessEqual(second["workers"], 2)
        for name in self.raw_names | {"asset-manifest.js"}:
            suffix = "" if name == "asset-manifest.js" else ".br"
            self.assertEqual((self.output / "city-viewer" / (name + suffix)).read_bytes(),
                             (other / "city-viewer" / (name + suffix)).read_bytes())

    def test_all_decoder_static_files_required_before_output(self):
        for name in publisher.BROTLI_STATIC_FILES:
            with self.subTest(name=name):
                path = self.source / name
                value = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaises(publisher.BuildError):
                        self.build()
                    self.assertFalse(self.output.exists())
                finally:
                    path.write_bytes(value)

    def test_corrupt_truncated_and_trailing_streams_rejected(self):
        raw = bytes(range(256)) * 5
        source, compressed, _ = self.compress(raw)
        value = compressed.read_bytes()
        broken = bytearray(value)
        broken[len(broken) // 2] ^= 0x80
        for data in (bytes(broken), value[:-1], value[:1], b"", value + b"trailing", value + value):
            with self.subTest(data=data[:20]):
                compressed.write_bytes(data)
                with self.assertRaises(publisher.BuildError):
                    self.verify(source, compressed, raw)

    def test_byte_and_sha_and_size_mismatch_rejected(self):
        raw = b"exact original bytes"
        source, compressed, _ = self.compress(raw)
        for size, digest in ((len(raw) + 1, hashlib.sha256(raw).hexdigest()), (len(raw), "0" * 64)):
            with self.assertRaisesRegex(publisher.BuildError, "SHA-256"):
                publisher._verify_brotli(source, compressed, size, digest, node=self.node)
        for changed in (b"wrong source", raw + b"extra", raw[:-1]):
            source.write_bytes(changed)
            with self.assertRaisesRegex(publisher.BuildError, "byte verification"):
                self.verify(source, compressed, raw)

    def test_changed_source_before_helper_rejected(self):
        path = self.source / "data_110000.js"
        sig = publisher._signature(path)
        asset = publisher.Asset(path.name, sig[2], sig)
        path.write_bytes(b"changed")
        self.output.mkdir()
        with self.assertRaisesRegex(publisher.BuildError, "changed after preflight"):
            publisher._compress_asset_brotli(self.source, self.output, asset, node=self.node)
        self.assertFalse((self.output / (path.name + ".br")).exists())

    def test_changed_input_during_compression_rejected_no_success(self):
        real_run = publisher._run_brotli
        def changed(node, arguments, parent):
            result = real_run(node, arguments, parent)
            Path(arguments[arguments.index("--source") + 1]).write_bytes(b"changed after helper")
            return result
        with mock.patch.object(publisher, "_run_brotli", side_effect=changed):
            with self.assertRaisesRegex(publisher.BuildError, "Source changed"):
                self.build(workers=1)
        self.no_success()

    def test_changed_static_source_after_copy_rejected(self):
        real = publisher._compress_asset_brotli
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            (self.source / "changelog.js").write_bytes(b"changed static source")
            return result
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=changed):
            with self.assertRaisesRegex(publisher.BuildError, "Static source/copy changed"):
                self.build(workers=1)
        self.no_success()

    def test_changed_metadata_inventory_after_compression_rejected(self):
        real = publisher._compress_asset_brotli
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            (self.source / "data_stray.js").write_bytes(b"unlisted")
            return result
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=changed):
            with self.assertRaisesRegex(publisher.BuildError, "not listed"):
                self.build(workers=1)
        self.no_success()

    def test_unexpected_output_inventory_rejected(self):
        real = publisher._compress_asset_brotli
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            (self.output / "city-viewer" / "stray.js").write_bytes(b"stray")
            return result
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=changed):
            with self.assertRaisesRegex(publisher.BuildError, "Output inventory"):
                self.build(workers=1)
        self.no_success()

    def test_compressed_asset_changed_after_verification_rejected(self):
        real = publisher._compress_asset_brotli
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            compressed = self.output / "city-viewer" / result["url"]
            value = bytearray(compressed.read_bytes())
            value[0] ^= 0x40
            compressed.write_bytes(value)
            return result
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=changed):
            with self.assertRaisesRegex(publisher.BuildError, "Compressed asset changed"):
                self.build(workers=1)
        self.no_success()

    def test_failed_helper_node_exit_and_summary_are_fail_closed(self):
        def fail(command, **kwargs):
            self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
            self.assertNotEqual(kwargs["stdout"], subprocess.PIPE)
            self.assertNotEqual(kwargs["stderr"], subprocess.PIPE)
            self.assertTrue(Path(kwargs["env"]["TMP"]).is_relative_to(self.output))
            kwargs["stderr"].write(b"fixture native exit")
            return subprocess.CompletedProcess(command, 3)
        with mock.patch("subprocess.run", side_effect=fail):
            with self.assertRaisesRegex(publisher.BuildError, "exit 3.*fixture native exit"):
                self.build(workers=1)
        self.no_success()
        self.assertFalse(list(self.output.rglob(".brotli-*")))
        with self.assertRaisesRegex(publisher.BuildError, "Refusing to overwrite"):
            self.build()

    def test_failed_verification_never_publishes_success(self):
        with mock.patch.object(publisher, "_run_brotli", side_effect=publisher.BuildError("fixture verification failure")):
            with self.assertRaisesRegex(publisher.BuildError, "verification failure"):
                self.build()
        self.no_success()

    def test_malformed_success_summary_and_timeout_rejected(self):
        for summary in (b"", b"{}", b"not JSON", b"x" * 4097,
                        b'{"bytes":true,"compressedBytes":1,"sha256":"x","compressedSha256":"x"}'):
            destination = self.root / ("bad-summary-" + hashlib.sha256(summary).hexdigest()[:8])
            def fake(command, **kwargs):
                kwargs["stdout"].write(summary)
                return subprocess.CompletedProcess(command, 0)
            with mock.patch("subprocess.run", side_effect=fake):
                with self.assertRaises(publisher.BuildError):
                    self.build(output=destination, workers=1)
            self.assertFalse((destination / "build-report.json").exists())
            self.assertFalse(list(destination.rglob(".brotli-*")))
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("node", 1800)):
            with self.assertRaisesRegex(publisher.BuildError, "timed out"):
                self.build(workers=1)
        self.no_success()
        self.assertFalse(list(self.output.rglob(".brotli-*")))

    def test_all_parameter_bounds_and_unknown_backends_preflight(self):
        for options in ({"codec": "unknown"}, {"workers": 3}, {"workers": True},
            {"brotli_quality": -1}, {"brotli_quality": 12}, {"brotli_quality": True},
            {"brotli_quality": 11.0}, {"brotli_lgwin": 9}, {"brotli_lgwin": 25},
            {"brotli_lgwin": True}, {"brotli_lgwin": 22.0}, {"compression_backend": "unknown"},
            {"compression_backend": "7zip"}, {"seven_zip": sys.executable},
            {"node": self.root / "missing-node"}, {"max_site_bytes": 0},
            {"max_site_bytes": publisher.MAX_SITE_BYTES + 1}, {"max_site_bytes": True},
            {"max_site_bytes": 1.0}, {"expected_files": 6}):
            with self.subTest(options=options), self.assertRaises(publisher.BuildError):
                self.build(**options)
            self.assertFalse(self.output.exists())

    def test_quality_window_boundaries_are_accepted(self):
        for quality, lgwin in ((0, 10), (11, 24)):
            report = self.build(output=self.root / ("q%d-w%d" % (quality, lgwin)),
                                brotli_quality=quality, brotli_lgwin=lgwin)
            self.assertEqual(report["compression"]["quality"], quality)
            self.assertEqual(report["compression"]["lgwin"], lgwin)

    def test_size_gate_does_not_publish_success_and_cannot_relax_1gb(self):
        with self.assertRaisesRegex(publisher.BuildError, "siteBytes gate"):
            self.build(max_site_bytes=1)
        self.no_success()

    def test_cli_brotli_node_command_and_progress(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        arguments = ["--source", str(self.source), "--output", str(self.output),
            "--codec", "brotli", "--node", "node", "--workers", "2",
            "--brotli-quality", "11", "--brotli-lgwin", "22", "--expected-files", "5"]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(publisher.main(arguments), 0)
        self.assertIn("brotli complete files=5 verifiedFiles=5", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(self.manifest()["version"], 2)
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(publisher.main(arguments), 1)
        self.assertIn("brotli build failed", stderr.getvalue())

    def test_helper_invalid_arguments_and_exclusive_output(self):
        for arguments in (["--mode", "unknown"], ["--mode", "compress", "--source", "x", "--output", "y", "--quality", "12"],
                          ["--mode", "compress", "--source", "x", "--output", "y", "--lgwin", "25"],
                          ["--mode", "compress", "--source", "x", "--output", "y", "--unknown", "x"],
                          ["--mode", "compress", "--source", "x", "--output", "y", "--mode", "compress"]):
            with self.assertRaises(publisher.BuildError):
                publisher._run_brotli(self.node, arguments, self.root)
        source, compressed, _ = self.compress()
        before = compressed.read_bytes()
        with self.assertRaisesRegex(publisher.BuildError, "EEXIST"):
            publisher._run_brotli(self.node, ["--mode", "compress", "--source", str(source),
                "--output", str(compressed)], self.root)
        self.assertEqual(compressed.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
