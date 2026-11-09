"""Migration publication uses tiny fixtures, never the panorama corpus."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_redirect_site as publisher


class RedirectSiteTests(unittest.TestCase):
    def test_publishes_only_migration_pages_and_no_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "site"
            names = publisher.build_redirect_site(output)
            self.assertEqual(len(names), 20)
            self.assertIn("404.html", names)
            self.assertIn("city-viewer/report.html", names)
            self.assertIn("g101/index.html", names)
            self.assertEqual(set(names), {p.relative_to(output).as_posix()
                                         for p in output.rglob("*") if p.is_file()})
            for name in names:
                if name.endswith(".html"):
                    self.assertEqual((output / name).read_bytes(), publisher.TEMPLATE.read_bytes())
            self.assertLess(sum(p.stat().st_size for p in output.rglob("*") if p.is_file()), 100000)

    def test_refuses_nonempty_output_without_changing_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            sentinel = output / "keep"
            sentinel.write_bytes(b"protected")
            with self.assertRaisesRegex(ValueError, "nonempty"):
                publisher.build_redirect_site(output)
            self.assertEqual(sentinel.read_bytes(), b"protected")
            self.assertEqual(list(output.iterdir()), [sentinel])

    def test_accepts_empty_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(len(publisher.build_redirect_site(Path(temporary))), 20)


if __name__ == "__main__":
    unittest.main()
