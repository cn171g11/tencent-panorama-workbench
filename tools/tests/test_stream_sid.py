import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
from stream_pano_rows import iter_pano_rows

spec = importlib.util.spec_from_file_location('disk_sid_checker', TOOLS / 'check_viewer_sid_unique.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
GAMES = json.loads((TOOLS / 'data/tencent-game-exceptions.json').read_text(encoding='utf-8'))['panoramaIds']


class ChunkedStream(io.StringIO):
    def read(self, size=-1):
        return super().read(min(size, 7) if size >= 0 else 7)


class StreamSidTests(unittest.TestCase):
    def test_chunked_reader_preserves_raw_rows_and_empty_collections(self):
        raw = '["p1",112.123456789012345,37.5,"路 ] , \\"名\\"","",0,0,0,"soso"]'
        # Use JSON to supply a road containing delimiters and escaped quotes.
        raw = '["p1",112.123456789012345,37.5,' + json.dumps('路 ] , "名"', ensure_ascii=False) + ',"",0,0,0,"soso"]'
        source = 'window.PANO_CITY["empty"]=[];window.PANO_CITY["140100"]= [' + raw + '];'
        keys = []
        rows = list(iter_pano_rows(ChunkedStream(source), keys.append))
        self.assertEqual(keys, ['empty', '140100'])
        self.assertEqual(rows[0][1], raw)
        self.assertEqual(rows[0][2], json.loads(raw))

    def fixture(self, directory, duplicate=False):
        root = Path(directory)
        rows = [[sid, 112.0, 37.0, '', '', '', 0, 0, '腾讯隐藏'] for sid in GAMES]
        sid = GAMES[0] if duplicate else 'regular'
        row = [sid, 112.12345678901234, 37.0, '', '', '', 0, 0]
        (root / 'data_meta.js').write_text('window.PANO_COUNT=' + json.dumps({'140100': 1, 'hidden_game': 15}) + ';', encoding='utf-8')
        (root / 'data_140100.js').write_text('window.PANO_CITY["140100"]=' + json.dumps([row]) + ';', encoding='utf-8')
        (root / 'hidden_pano.js').write_text('window.PANO_CITY["hidden_game"]=' + json.dumps(rows) + ';', encoding='utf-8')
        return root

    def test_disk_result_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as cache:
            root = self.fixture(directory)
            originals = {path.name: path.read_bytes() for path in root.iterdir()}
            with contextlib.redirect_stdout(io.StringIO()):
                result = checker.check(root, disk_directory=cache)
            self.assertEqual(result['sidMode'], 'disk-256')
            self.assertEqual(result['uniqueSid'], 16)
            self.assertEqual(result['duplicateExtra'], 0)
            self.assertEqual(list(Path(cache).iterdir()), [])
            self.assertEqual(originals, {path.name: path.read_bytes() for path in root.iterdir()})

    def test_disk_duplicates_still_fail(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as cache:
            root = self.fixture(directory, duplicate=True)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'Duplicate SIDs'):
                checker.check(root, disk_directory=cache)
            self.assertEqual(list(Path(cache).iterdir()), [])

    def test_unterminated_array_is_not_silently_skipped(self):
        with self.assertRaisesRegex(ValueError, 'Unterminated collection'):
            list(iter_pano_rows(ChunkedStream('window.PANO_CITY["broken"]=[')))


if __name__ == '__main__':
    unittest.main()
