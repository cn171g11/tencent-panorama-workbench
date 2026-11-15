"""Tiny municipal-report publication gate fixtures, no real point corpus."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_gzip_site as publisher

class MunicipalPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.meta = {'310000': {'province': '上海市'}, 'qq_31': {'province': '上海市'}, 'hidden_310101': {'province': '上海市'}}
        self.counts = {'310000': 2, 'qq_31': 1, 'hidden_310101': 1}
        text = 'window.PANO_META=' + json.dumps(self.meta, ensure_ascii=False) + ';\nwindow.PANO_COUNT=' + json.dumps(self.counts) + ';'
        (self.root / 'data_meta.js').write_text(text, encoding='utf-8')
        self.files = {name: {'bytes': 100, 'sha256': 'a'*64} for name in ('data_310000.js', 'data_qq_31.js', 'hidden_pano.js')}
        self.artifact = {'version': 1, 'policy': 'datav-gcj02-polygon-covers-lowest-code-residual-v1',
                         'metaSha256': hashlib.sha256((self.root / 'data_meta.js').read_bytes()).hexdigest(),
                         'sources': copy.deepcopy(self.files), 'municipalities': {}}
        for code in ('110000', '120000', '310000', '500000'):
            regular, hidden = (3, 1) if code == '310000' else (0, 0)
            self.artifact['municipalities'][code] = {'sourceCounts': dict(self.counts) if code == '310000' else {},
                'districts': [{'code': code[:2]+'0101', 'name': '区', 'regular': regular, 'hidden': hidden, 'total': regular+hidden}],
                'unassigned': {'regular': 0, 'hidden': 0, 'total': 0}, 'regular': regular, 'hidden': hidden, 'total': regular+hidden}
        self.write()
    def write(self):
        (self.root / 'municipality-report.js').write_text('window.PANO_MUNICIPAL_REPORT='+json.dumps(self.artifact,ensure_ascii=False)+';\n',encoding='utf-8')
    def check(self):
        publisher._validate_municipality_report(self.root, self.files)
    def test_current_source_hash_bytes_counts_and_conservation_are_accepted(self):
        self.check()
    def test_same_count_coordinate_change_fails_sha_gate(self):
        self.files['data_310000.js']['sha256']='b'*64
        with self.assertRaisesRegex(publisher.BuildError, 'SHA/bytes'):
            self.check()
    def test_metadata_change_without_count_change_is_stale(self):
        with (self.root / 'data_meta.js').open('a',encoding='utf-8') as f:
            f.write('\n')
        with self.assertRaisesRegex(publisher.BuildError, 'stale for current metadata'):
            self.check()
    def test_count_change_and_district_sum_mismatch_fail(self):
        self.artifact['municipalities']['310000']['sourceCounts']['qq_31']=2
        self.write()
        with self.assertRaisesRegex(publisher.BuildError, 'source counts'):
            self.check()
        self.artifact['municipalities']['310000']['sourceCounts']['qq_31']=1
        self.artifact['municipalities']['310000']['districts'][0]['regular']=2
        self.artifact['municipalities']['310000']['districts'][0]['total']=3
        self.write()
        with self.assertRaisesRegex(publisher.BuildError, 'conserve'):
            self.check()
    def test_legacy_site_without_municipal_report_remains_supported(self):
        target=(self.root / 'municipality-report.js').resolve()
        self.assertEqual(target.parent,self.root.resolve())
        target.unlink()
        self.check()

if __name__=='__main__':
    unittest.main()
