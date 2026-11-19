"""Opt-in reuse fixtures: only tiny temporary sites, never the real corpus."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

# Support both repository-root package imports and unittest discovery.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.tests import test_brotli_site as brotli_fixtures
from tools.tests import test_gzip_site as gzip_fixtures
import build_gzip_site as publisher


class BrotliReuseTests(unittest.TestCase):
    write_metadata = gzip_fixtures.GzipSiteTests.write_metadata
    manifest = gzip_fixtures.GzipSiteTests.manifest

    def setUp(self):
        brotli_fixtures.BrotliSiteTests.setUp(self)
        self.cache = self.root / "cache"
        self.cache_report = self.build(output=self.cache)

    def build(self, **changes):
        options = {"codec": "brotli", "node": self.node, "workers": 1}
        options.update(changes)
        output = options.pop("output", self.output)
        return publisher.build_site(self.source, output, **options)

    def reuse(self, **changes):
        options = {"reuse_site": self.cache}
        options.update(changes)
        return self.build(**options)

    def no_success(self, output=None):
        output = output or self.output
        for name in ("build-report.json", "city-viewer/asset-manifest.js", "index.html", ".nojekyll"):
            self.assertFalse((output / name).exists(), name)

    def snapshot(self, root):
        return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}

    def rewrite_cache_report(self, report):
        """Make internally consistent malicious reports to exercise decode gates."""
        manifest = {key: report[key] for key in ("version", "codec", "files", "totals")}
        (self.cache / "city-viewer/asset-manifest.js").write_bytes(
            (publisher.MANIFEST_PREFIX + publisher._js_json(manifest) + ";\n").encode("utf-8"))
        report_path = self.cache / "build-report.json"
        other_bytes = sum(p.stat().st_size for p in self.cache.rglob("*")
                          if p.is_file() and p != report_path)
        while True:
            data = (publisher._js_json(report) + "\n").encode("utf-8")
            size = other_bytes + len(data)
            if report["siteBytes"] == size:
                break
            report["siteBytes"] = size
        report_path.write_bytes(data)

    def test_unchanged_hit_copies_independent_files_and_verifies_every_asset(self):
        before = self.snapshot(self.cache)
        messages = []
        real_verify = publisher._verify_brotli
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=AssertionError("must reuse")), \
                mock.patch.object(publisher, "_verify_brotli", wraps=real_verify) as verify:
            report = self.reuse(progress=messages.append)
        self.assertEqual(verify.call_count, len(self.raw_names))
        self.assertEqual(report["files"], self.cache_report["files"])
        self.assertEqual(self.snapshot(self.cache), before)
        self.assertEqual(sum("reuse hit" in m for m in messages), len(self.raw_names))
        for name in self.raw_names:
            cache = self.cache / "city-viewer" / (name + ".br")
            output = self.output / "city-viewer" / (name + ".br")
            self.assertEqual(output.read_bytes(), cache.read_bytes())
            self.assertFalse(os.path.samefile(cache, output))
            self.assertEqual(output.stat().st_nlink, 1)
        self.assertEqual(report["siteBytes"], sum(p.stat().st_size for p in self.output.rglob("*") if p.is_file()))

    def test_changed_raw_only_recompresses_changed_asset(self):
        changed = "data_110000.js"
        (self.source / changed).write_bytes(b"different exact raw bytes\x00\xff\r\n")
        messages = []
        with mock.patch.object(publisher, "_compress_asset_brotli", wraps=publisher._compress_asset_brotli) as compress:
            report = self.reuse(progress=messages.append)
        self.assertEqual(compress.call_count, 1)
        self.assertEqual(compress.call_args.args[2].name, changed)
        self.assertNotEqual(report["files"][changed]["sha256"], self.cache_report["files"][changed]["sha256"])
        self.assertEqual(sum("reuse hit" in m for m in messages), len(self.raw_names) - 1)
        self.assertTrue(any("reuse miss asset=" + changed in m for m in messages))

    def test_two_bounded_workers_verify_hits_and_empty_stream(self):
        (self.source / "hidden_pano.js").write_bytes(b"")
        cache = self.root / "empty-cache"
        self.build(output=cache)
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=AssertionError("must reuse")):
            report = self.reuse(reuse_site=cache, workers=2)
        self.assertEqual(report["workers"], 2)
        self.assertEqual(report["files"]["hidden_pano.js"]["bytes"], 0)

    def test_source_drift_on_miss_with_preserved_signature_is_rejected(self):
        path = self.source / "data_110000.js"
        path.write_bytes(b"first changed raw")
        real = publisher._compress_asset_brotli
        def drift(*args, **kwargs):
            if args[2].name == path.name:
                stat = path.stat()
                path.write_bytes(b"other changed raw")
                os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
            return real(*args, **kwargs)
        with mock.patch.object(publisher, "_compress_asset_brotli", side_effect=drift):
            with self.assertRaisesRegex(publisher.BuildError, "Source changed during reuse miss compression"):
                self.reuse()
        self.no_success()

    def test_exclusive_copy_never_overwrites_racing_output(self):
        real = publisher._reuse_asset_brotli
        sentinel = b"keep racing file bytes"
        def race(*args, **kwargs):
            target = args[1] / (args[2].name + ".br")
            target.write_bytes(sentinel)
            return real(*args, **kwargs)
        with mock.patch.object(publisher, "_reuse_asset_brotli", side_effect=race):
            with self.assertRaisesRegex(publisher.BuildError, "Reuse cache asset rejected"):
                self.reuse()
        self.assertEqual((self.output / "city-viewer/data_110000.js.br").read_bytes(), sentinel)
        self.no_success()

    def test_missing_and_invalid_report_rejected_before_output(self):
        original = (self.cache / "build-report.json").read_bytes()
        for data in (None, b"not JSON", b"[]", b'{"version":2,"version":2}'):
            with self.subTest(data=data):
                path = self.cache / "build-report.json"
                if data is None:
                    path.unlink()
                else:
                    path.write_bytes(data)
                with self.assertRaises(publisher.BuildError):
                    self.reuse()
                self.assertFalse(self.output.exists())
                path.write_bytes(original)

    def test_wrong_parameters_codec_and_unverified_report_rejected(self):
        for options in ({"brotli_quality": 10}, {"brotli_lgwin": 21}, {"codec": "gzip", "node": None}):
            with self.subTest(options=options), self.assertRaisesRegex(publisher.BuildError, "compression parameters|requires the brotli"):
                self.reuse(**options)
            self.assertFalse(self.output.exists())
        for key, value in (("verifiedFiles", 0), ("verifiedFiles", True), ("version", 1),
                           ("compression", {"backend": "node:zlib", "quality": True, "lgwin": 22,
                                            "mode": "generic", "threadsPerWorker": 1})):
            report = json.loads(json.dumps(self.cache_report))
            report[key] = value
            self.rewrite_cache_report(report)
            with self.subTest(key=key), self.assertRaises(publisher.BuildError):
                self.reuse()
            self.assertFalse(self.output.exists())

    def test_corrupt_compressed_cache_is_explicitly_rejected_with_log(self):
        path = self.cache / "city-viewer/data_110000.js.br"
        value = bytearray(path.read_bytes())
        value[0] ^= 0x40
        path.write_bytes(value)
        messages = []
        with self.assertRaisesRegex(publisher.BuildError, "Reuse cache asset rejected.*SHA-256"):
            self.reuse(progress=messages.append)
        self.assertTrue(any("reuse rejected asset=data_110000.js" in m for m in messages))
        self.no_success()

    def test_trailing_stream_rejected_even_when_cache_hash_size_and_report_match(self):
        path = self.cache / "city-viewer/data_110000.js.br"
        path.write_bytes(path.read_bytes() + b"trailing fixture garbage")
        report = json.loads(json.dumps(self.cache_report))
        entry = report["files"]["data_110000.js"]
        delta = path.stat().st_size - entry["compressedBytes"]
        entry["compressedBytes"] = path.stat().st_size
        entry["compressedSha256"] = publisher._hash_file(path)
        report["totals"]["compressedBytes"] += delta
        report["totals"]["savedBytes"] -= delta
        report["totals"]["savingPercent"] = round(
            (1 - report["totals"]["compressedBytes"] / report["totals"]["bytes"]) * 100, 4)
        self.rewrite_cache_report(report)
        messages = []
        with self.assertRaisesRegex(publisher.BuildError, "trailing bytes|incomplete compressed stream"):
            self.reuse(progress=messages.append)
        self.assertTrue(any("reuse rejected" in m for m in messages))
        self.no_success()

    def test_report_drift_same_size_and_preserved_mtime_rejected(self):
        real = publisher._verify_brotli
        changed = False
        def drift(*args, **kwargs):
            nonlocal changed
            result = real(*args, **kwargs)
            if not changed:
                changed = True
                path = self.cache / "build-report.json"
                stat = path.stat()
                data = path.read_bytes()
                self.assertIn(b'"workers":1', data)
                path.write_bytes(data.replace(b'"workers":1', b'"workers":2'))
                os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
            return result
        with mock.patch.object(publisher, "_verify_brotli", side_effect=drift):
            with self.assertRaisesRegex(publisher.BuildError, "build report changed"):
                self.reuse()
        self.no_success()

    def test_cache_drift_after_verify_is_rejected(self):
        real = publisher._verify_brotli
        def drift(*args, **kwargs):
            result = real(*args, **kwargs)
            cached = self.cache / "city-viewer" / Path(args[1]).name
            cached.write_bytes(cached.read_bytes() + b"cache drift")
            return result
        with mock.patch.object(publisher, "_verify_brotli", side_effect=drift):
            with self.assertRaisesRegex(publisher.BuildError, "changed during reuse verification"):
                self.reuse()
        self.no_success()

    def test_source_drift_after_verification_rejected(self):
        real = publisher._verify_brotli
        def drift(*args, **kwargs):
            result = real(*args, **kwargs)
            Path(args[0]).write_bytes(b"changed source during reuse")
            return result
        with mock.patch.object(publisher, "_verify_brotli", side_effect=drift):
            with self.assertRaisesRegex(publisher.BuildError, "changed during reuse verification"):
                self.reuse()
        self.no_success()

    def test_source_drift_during_candidate_hash_is_rejected(self):
        real_hash = publisher._hash_file
        changed = False
        def drift(path):
            nonlocal changed
            result = real_hash(path)
            if not changed and Path(path) == self.source / "data_110000.js":
                changed = True
                Path(path).write_bytes(b"changed source during candidate hash")
            return result
        with mock.patch.object(publisher, "_hash_file", side_effect=drift):
            with self.assertRaisesRegex(publisher.BuildError, "Source changed during reuse candidate hashing"):
                self.reuse()
        self.no_success()

    def test_reuse_still_checks_output_inventory_static_and_size_gates(self):
        real = publisher._reuse_asset_brotli
        for kind in ("inventory", "static", "compressed", "cap"):
            output = self.root / ("failure-" + kind)
            def changed(*args, **kwargs):
                result = real(*args, **kwargs)
                if kind == "inventory":
                    (output / "city-viewer/stray.js").write_bytes(b"stray")
                elif kind == "static":
                    (output / "city-viewer/changelog.js").write_bytes(b"changed static")
                elif kind == "compressed":
                    (output / "city-viewer" / result["url"]).write_bytes(b"changed compressed")
                return result
            with self.subTest(kind=kind), mock.patch.object(publisher, "_reuse_asset_brotli", side_effect=changed):
                with self.assertRaises(publisher.BuildError):
                    self.reuse(output=output, max_site_bytes=1 if kind == "cap" else publisher.MAX_SITE_BYTES)
            self.no_success(output)

    def test_overlap_alias_and_symlink_cache_are_rejected(self):
        for cache, output in ((self.source, self.output), (self.cache, self.cache / "new"),
                              (self.cache, self.cache.parent), (self.cache, self.cache),
                              (self.source.parent, self.output)):
            with self.subTest(cache=cache, output=output), self.assertRaisesRegex(publisher.BuildError, "independent"):
                self.reuse(reuse_site=cache, output=output)
        linked = self.cache / "city-viewer/data_110000.js.br"
        saved = linked.read_bytes()
        linked.unlink()
        os.link(self.cache / "city-viewer/data_qq_53.js.br", linked)
        with self.assertRaisesRegex(publisher.BuildError, "aliases"):
            self.reuse()
        linked.unlink()
        linked.write_bytes(saved)
        alias = self.root / "cache-alias"
        try:
            alias.symlink_to(self.cache, target_is_directory=True)
        except OSError:
            return  # Hardlink alias coverage above remains mandatory on Windows.
        with self.assertRaisesRegex(publisher.BuildError, "symlinks/junctions"):
            self.reuse(reuse_site=alias)
        self.assertFalse(self.output.exists())

    def test_source_file_alias_is_rejected_before_output(self):
        path = self.source / "data_110000.js"
        alias = self.root / "raw-alias.js"
        os.link(path, alias)
        with self.assertRaisesRegex(publisher.BuildError, "source file aliases"):
            self.reuse()
        self.assertFalse(self.output.exists())

    def test_reuse_keeps_municipality_report_validation_gate(self):
        (self.source / "municipality-report.js").write_bytes(b"malformed municipality fixture")
        with self.assertRaisesRegex(publisher.BuildError, "Municipal report assignment is malformed"):
            self.reuse()
        self.no_success()

    def test_cache_output_inventory_and_manifest_must_be_successful(self):
        for name in (".nojekyll", "city-viewer/asset-manifest.js", "city-viewer/changelog.js"):
            path = self.cache / name
            data = path.read_bytes()
            path.unlink()
            with self.subTest(name=name), self.assertRaises(publisher.BuildError):
                self.reuse()
            self.assertFalse(self.output.exists())
            path.write_bytes(data)
        (self.cache / "city-viewer/asset-manifest.js").write_bytes(b"fake manifest")
        # The size gate may reject before the exact manifest gate: both fail closed.
        with self.assertRaises(publisher.BuildError):
            self.reuse()
        self.assertFalse(self.output.exists())

    def test_cli_explicit_reuse_and_no_cache_output_bytes_unchanged(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        arguments = ["--source", str(self.source), "--output", str(self.output),
                     "--codec", "brotli", "--node", self.node, "--workers", "1",
                     "--reuse-site", str(self.cache)]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(publisher.main(arguments), 0)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(stdout.getvalue().count("reuse hit asset="), len(self.raw_names))
        first, second, reused = self.root / "plain-one", self.root / "plain-two", self.root / "reused"
        with mock.patch.object(publisher.time, "monotonic", return_value=10.0):
            self.build(output=first)
            self.build(output=second, reuse_site=None)
            self.reuse(output=reused)
        self.assertEqual(self.snapshot(first), self.snapshot(second))
        self.assertEqual(self.snapshot(first), self.snapshot(reused))
        self.assertNotIn("reuse", json.loads((first / "build-report.json").read_text("utf-8")))


if __name__ == "__main__":
    unittest.main()
