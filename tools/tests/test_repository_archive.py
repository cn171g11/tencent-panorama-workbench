"""Lightweight archive integrity checks; never parse/rebuild the national point corpus."""
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "city-viewer" / "legacy"
DIRECTORIES = {
    "erguna", "g101", "g102", "g103", "g106", "g212", "g312", "gaochun",
    "huma", "jgdaq", "lishui-panorama", "mohe", "s341", "tahe", "xinlin",
}
RETIRED = {f"{name}/index.html" for name in
           ("g101", "g102", "g103", "g106", "g212", "g312", "lishui-panorama", "s341")}
RETIRED.add("s341/s341-workbench-preview.png")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class RepositoryArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory = json.loads((ARCHIVE / "inventory.json").read_text("utf-8"))
        cls.entries = cls.inventory["files"]

    def test_inventory_is_complete_unique_and_confined(self):
        self.assertEqual(self.inventory["schemaVersion"], 1)
        self.assertEqual(self.inventory["sourceCommit"], "03de8f0936612bb8ccaa06836eab7d033d755393")
        self.assertEqual(set(self.inventory["retiredRootDirectories"]), DIRECTORIES)
        self.assertEqual(len(self.entries), 36)
        self.assertEqual(len({entry["originalPath"] for entry in self.entries}), 36)
        targets = []
        for entry in self.entries:
            with self.subTest(original=entry["originalPath"]):
                original = Path(entry["originalPath"])
                self.assertFalse(original.is_absolute())
                self.assertNotIn("..", original.parts)
                self.assertIn(original.parts[0], DIRECTORIES)
                self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
                self.assertRegex(entry["gitBlob"], r"^[0-9a-f]{40}$")
                self.assertIn(entry["action"], ("archive", "retire"))
                provider = "baidu" if original.parts[0] == "s341" else "tencent"
                self.assertEqual(entry["provider"], provider)
                if entry["action"] == "archive":
                    expected = f"city-viewer/legacy/{provider}/{original.as_posix()}"
                    self.assertEqual(entry["path"], expected)
                    self.assertTrue((ROOT / entry["path"]).resolve().is_relative_to(ARCHIVE.resolve()))
                    targets.append(entry["path"])
                else:
                    self.assertIsNone(entry["path"])
                    self.assertIn(entry["originalPath"], RETIRED)
        self.assertEqual(len(targets), len(set(targets)))
        self.assertEqual(len(targets), 27)
        self.assertEqual({e["originalPath"] for e in self.entries if e["action"] == "retire"}, RETIRED)

    def test_every_archived_file_retains_exact_bytes_and_git_blob(self):
        for entry in self.entries:
            if entry["action"] != "archive":
                continue
            with self.subTest(path=entry["path"]):
                path = ROOT / entry["path"]
                self.assertFalse(path.is_symlink())
                self.assertTrue(path.is_file())
                self.assertEqual(path.stat().st_size, entry["bytes"])
                self.assertEqual(sha256(path), entry["sha256"])
                blob = hashlib.sha1(f"blob {entry['bytes']}\0".encode("ascii"))
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        blob.update(chunk)
                self.assertEqual(blob.hexdigest(), entry["gitBlob"])

    def test_totals_match_exact_files(self):
        archived = [entry for entry in self.entries if entry["action"] == "archive"]
        retired = [entry for entry in self.entries if entry["action"] == "retire"]
        self.assertEqual(self.inventory["totals"], {
            "sourceFiles": 36, "sourceBytes": 29868469,
            "archivedFiles": 27, "archivedBytes": 29448064,
            "retiredFiles": 9, "retiredBytes": 420405,
        })
        self.assertEqual(sum(entry["bytes"] for entry in archived), 29448064)
        self.assertEqual(sum(entry["bytes"] for entry in retired), 420405)
        self.assertEqual(sum(entry["bytes"] for entry in self.entries), 29868469)

    def test_archive_has_no_unlisted_files_or_retired_pages(self):
        expected = {entry["path"] for entry in self.entries if entry["action"] == "archive"}
        expected |= {"city-viewer/legacy/README.md", "city-viewer/legacy/inventory.json"}
        actual = {p.relative_to(ROOT).as_posix() for p in ARCHIVE.rglob("*") if p.is_file()}
        self.assertEqual(actual, expected)
        for name in DIRECTORIES:
            self.assertFalse((ROOT / name).exists(), f"Legacy root directory returned: {name}")
        self.assertFalse(any(path.suffix in (".html", ".js", ".css") for path in ARCHIVE.rglob("*")))

    def test_provider_isolation_and_valid_historical_metadata(self):
        json_files = [ROOT / entry["path"] for entry in self.entries
                      if entry["action"] == "archive" and entry["path"].endswith((".json", ".geojson"))]
        self.assertEqual(len(json_files), 20)
        baidu = [entry for entry in self.entries if entry["action"] == "archive" and entry["provider"] == "baidu"]
        self.assertEqual([e["path"] for e in baidu],
                         ["city-viewer/legacy/baidu/s341/s341-baidu-panoramas.json"])
        for path in json_files:
            with self.subTest(path=path):
                value = json.loads(path.read_bytes())
                if path.suffix == ".geojson":
                    self.assertEqual(value["type"], "FeatureCollection")
        text = (ROOT / "city-viewer/data_meta.js").read_text("utf-8")
        counts = json.JSONDecoder().raw_decode(text.split("window.PANO_COUNT=", 1)[1])[0]
        self.assertFalse(any(key in DIRECTORIES or key.startswith(("legacy", "baidu")) for key in counts))
        self.assertNotIn("legacy/", text)
        self.assertIn("city-viewer/", (ROOT / "index.html").read_text("utf-8"))

    def test_mislabeled_xinlin_boundary_is_preserved_and_flagged_not_corrected(self):
        boundary = json.loads((ARCHIVE / "tencent/xinlin/xinlin-boundary.geojson").read_bytes())
        properties = [feature.get("properties", {}) for feature in boundary["features"]]
        self.assertTrue(any(value.get("eng_name") == "Mohe" for value in properties))
        notes = (ARCHIVE / "README.md").read_text("utf-8")
        self.assertIn("漠河县", notes)
        self.assertIn("不将其当作现行新林边界", notes)


if __name__ == "__main__":
    unittest.main()
