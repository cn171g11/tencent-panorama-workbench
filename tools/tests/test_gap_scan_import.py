import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('gap_import', TOOLS / 'import_gap_scan_batch.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class GapImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='pano-gap-proof-')
        self.root = Path(self.directory.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith('pano-gap-proof-'))
        self.write('data_meta.js', 'window.PANO_META=' + json.dumps({
            '350100': {'name': '福州市', 'province': '福建省', 'pref': '350100'},
            'hidden_350100': {'name': '福州市·隐藏街景', 'province': '福建省', 'pref': 'hidden_350100'}
        }, ensure_ascii=False) + ';window.PANO_COUNT={"350100":1,"hidden_350100":1};')
        self.write('data_350100.js', 'window.PANO_CITY["350100"]=[["old-city",112.123456789012345,37,"","","",0,0]];')
        self.write('hidden_pano.js', 'window.PANO_CITY["hidden_350100"]=[["old-hidden",118,25,"","","",0,0,"腾讯隐藏"]];')

    def tearDown(self):
        self.assertEqual(Path(self.directory.name).resolve(), self.root)
        self.directory.cleanup()

    def write(self, name, value):
        (self.root / name).write_text(value, encoding='utf-8')

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def proof(self, candidates=('fresh',)):
        sources = ['data_350100.js', 'hidden_pano.js']
        payload = {'version': 1, 'viewer': str(self.root), 'baselineTotal': 2,
                   'candidateCount': len(candidates),
                   'candidateSidSha256': hashlib.sha256(('\n'.join(sorted(candidates)) + '\n').encode()).hexdigest(),
                   'metaSha256': self.sha(self.root / 'data_meta.js'),
                   'pointSources': {name: self.sha(self.root / name) for name in sources}}
        path = self.root / 'proof.json'
        path.write_text(json.dumps(payload), encoding='utf-8')
        return path

    def collect(self, candidates=('fresh',), proof=None):
        return importer.collect_existing_ids(self.root, [], [], candidate_ids=candidates, proof_path=proof)

    def test_global_candidate_exclusion_covers_unlisted_city_and_hidden_legacy(self):
        result = self.collect(('old-city', 'old-hidden', 'fresh'))
        self.assertEqual(result, {'old-city': '350100', 'old-hidden': 'hidden_350100'})

    def test_unchanged_snapshot_reuses_exclusion(self):
        self.assertEqual(self.collect(proof=self.proof()), {})

    def test_empty_candidate_snapshot_is_supported(self):
        self.assertEqual(self.collect((), self.proof(())), {})

    def test_changed_candidate_sid_set_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'candidate set changed'):
            self.collect(('different',), self.proof())

    def test_changed_metadata_is_rejected(self):
        proof = self.proof()
        self.write('data_meta.js', (self.root / 'data_meta.js').read_text(encoding='utf-8') + '\n')
        with self.assertRaisesRegex(ValueError, 'metadata changed'):
            self.collect(proof=proof)

    def test_changed_hidden_bytes_are_rejected(self):
        proof = self.proof()
        self.write('hidden_pano.js', (self.root / 'hidden_pano.js').read_text(encoding='utf-8') + '\n')
        with self.assertRaisesRegex(ValueError, 'point source changed'):
            self.collect(proof=proof)

    def test_added_point_source_is_rejected(self):
        proof = self.proof()
        self.write('data_350200.js', 'window.PANO_CITY["350200"]=[];')
        with self.assertRaisesRegex(ValueError, 'source inventory changed'):
            self.collect(proof=proof)

    def test_removed_point_source_is_rejected(self):
        proof = self.proof()
        target = self.root / 'data_350100.js'
        self.assertEqual(target.resolve().parent, self.root)
        target.unlink()
        with self.assertRaisesRegex(ValueError, 'source inventory changed'):
            self.collect(proof=proof)

    def test_other_viewer_and_ambiguous_sid_are_rejected(self):
        proof = self.proof()
        payload = json.loads(proof.read_text(encoding='utf-8'))
        payload['viewer'] = str(self.root / 'different-viewer')
        proof.write_text(json.dumps(payload), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'different viewer'):
            self.collect(proof=proof)
        with self.assertRaisesRegex(ValueError, 'exact candidate SID set'):
            self.collect(('bad\nsid',), self.proof())

    def test_regular_report_contains_exact_city_additions_and_dry_run_preserves_sources(self):
        records = [
            {'sid': 'fresh-fuzhou', 'lng': 118.5, 'lat': 25.5, 'roadName': '原路名'},
            {'sid': 'fresh-xiamen', 'lng': 120.5, 'lat': 25.5, 'roadName': '另一条路'},
        ]
        self.write('inputs.json', json.dumps(records, ensure_ascii=False))
        self.write('verification.json', json.dumps({'records': {
            entry['sid']: {'status': 'regular', 'isValid': True, 'canMove': True, 'movementCount': 1}
            for entry in records
        }}))
        boundaries = self.root / 'boundaries'
        boundaries.mkdir()
        (boundaries / 'country.json').write_text(json.dumps({'features': [
            {'properties': {'adcode': 350000, 'name': '福建省', 'level': 'province'}}
        ]}, ensure_ascii=False), encoding='utf-8')
        features = []
        for code, name, west in [(350100, '福州市', 118), (350200, '厦门市', 120)]:
            features.append({'properties': {'adcode': code, 'name': name}, 'geometry': {
                'type': 'Polygon', 'coordinates': [[[west, 25], [west + 1, 25], [west + 1, 26], [west, 26], [west, 25]]]
            }})
        (boundaries / '350000.json').write_text(json.dumps({'features': features}, ensure_ascii=False), encoding='utf-8')
        originals = {name: (self.root / name).read_bytes()
                     for name in ['data_350100.js', 'data_meta.js', 'hidden_pano.js']}
        argv = ['gap-import', '--inputs', str(self.root / 'inputs.json'),
                '--verification', str(self.root / 'verification.json'), '--boundaries', str(boundaries),
                '--provinces', '35', '--viewer', str(self.root), '--dry-run']
        output = io.StringIO()
        with patch.object(sys, 'argv', argv), contextlib.redirect_stdout(output):
            importer.main()
        report = json.loads(output.getvalue())
        regular = report['regular_collections']['qq_35']
        self.assertEqual(regular['added'], 2)
        self.assertEqual(regular['cities']['350100'], {'city': '福州市', 'province': '福建省', 'added': 1})
        self.assertEqual(regular['cities']['350200'], {'city': '厦门市', 'province': '福建省', 'added': 1})
        self.assertEqual(originals, {name: (self.root / name).read_bytes() for name in originals})


if __name__ == '__main__':
    unittest.main()
