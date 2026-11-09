const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forEachPanoRow } = require('../stream_pano_rows.js');

function fixture(source, action) {
  const root = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, 'pano-stream-'));
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), root);
  assert.ok(path.basename(resolved).startsWith('pano-stream-'));
  const file = path.join(resolved, 'fixture.js');
  fs.writeFileSync(file, source, 'utf8');
  try { action(file); }
  finally {
    assert.equal(fs.realpathSync(directory), resolved);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test('stream preserves flat legacy rows, Unicode and delimiters', () => {
  const row = ['sid', 112.12345678901234, 37.12345678901234, '路 ] , "名"', '', '', 0, 0];
  fixture('window.PANO_CITY["140100"]=' + JSON.stringify([row]) + ';', file => {
    const entries = [];
    assert.equal(forEachPanoRow(file, (key, value) => entries.push([key, value])), 1);
    assert.deepEqual(entries, [['140100', row]]);
  });
});

test('stream handles a row crossing chunk boundaries', () => {
  const row = ['sid', 112, 37, '中文'.repeat(40000), '', '', 0, 0, 'soso'];
  fixture('window.PANO_CITY["140100"]=' + JSON.stringify([row]) + ';', file => {
    forEachPanoRow(file, (key, value) => assert.deepEqual(value, row));
  });
});

test('stream recognizes empty and multiple hidden collections', () => {
  fixture('window.PANO_CITY["empty"]=[];window.PANO_CITY["hidden_game"]=[["game",1,2,"","","",0,0,"腾讯隐藏"]];', file => {
    const keys = [];
    assert.equal(forEachPanoRow(file, () => {}, key => keys.push(key)), 1);
    assert.deepEqual(keys, ['empty', 'hidden_game']);
  });
});

test('incomplete collection fails instead of disappearing', () => {
  fixture('window.PANO_CITY["broken"]=[', file => {
    assert.throws(() => forEachPanoRow(file, () => {}), /Unterminated collection/);
  });
});

test('half a long numeric literal at the chunk edge is scanned once', () => {
  const longitude = '112.' + '1234567890'.repeat(100);
  const header = 'window.PANO_CITY["140100"]=[';
  const row = '["30111018141016114722300",' + longitude + ',37,"","","",0,0,"soso"]';
  const padding = 65536 - header.length - row.indexOf(longitude) - 100;
  let checked = 0;
  fixture(' '.repeat(padding) + header + row + '];', file => {
    assert.equal(forEachPanoRow(file, (key, value) => {
      assert.equal(key, '140100');
      assert.equal(value[0], '30111018141016114722300');
      assert.ok(Object.is(value[1], Number(longitude)));
      checked++;
    }), 1);
  });
  assert.equal(checked, 1);
});

test('string escape state survives a chunk ending at a backslash', () => {
  const row = ['sid', 112, 37, 'left\\"tail ] , 名', '', '', 0, 0, 'soso'];
  const header = 'window.PANO_CITY["140100"]=[';
  const raw = JSON.stringify(row);
  const escape = raw.indexOf('\\\\');
  assert.ok(escape > 0);
  const padding = 65536 - Buffer.byteLength(header) - Buffer.byteLength(raw.slice(0, escape + 1));
  fixture(' '.repeat(padding) + header + raw + '];', file => {
    assert.equal(forEachPanoRow(file, (key, value) => assert.deepEqual(value, row)), 1);
  });
});

test('appended nested JSON values do not end a row early', () => {
  const row = ['sid', -0, 37.12345678901234, 'road', '', '', 0, 0, 'soso',
    { tags: ['a ] {', { text: 'comma, quote" and slash\\' }] }];
  fixture('window.PANO_CITY["140100"]=' + JSON.stringify([row]) + ';', file => {
    assert.equal(forEachPanoRow(file, (key, value) => assert.deepEqual(value, JSON.parse(JSON.stringify(row)))), 1);
  });
});

test('unterminated numeric and string rows fail without backtracking', () => {
  for (const row of ['["sid",112.' + '1234567890'.repeat(100), '["sid",112,37,"unfinished']) {
    fixture('window.PANO_CITY["broken"]=[' + row, file => {
      assert.throws(() => forEachPanoRow(file, () => {}), /Invalid panorama row/);
    });
  }
});

test('oversized rows fail before decoding an unbounded value', () => {
  const row = ['sid', 112, 37, 'x'.repeat(1048576), '', '', 0, 0, 'soso'];
  fixture('window.PANO_CITY["broken"]=' + JSON.stringify([row]) + ';', file => {
    assert.throws(() => forEachPanoRow(file, () => {}), /oversized panorama row/);
  });
});

test('malformed balanced JSON is never delivered to the visitor', () => {
  for (const row of ['[1,]', '[1,,2]', '[1,undefined]', '[{"x":1]]']) {
    fixture('window.PANO_CITY["broken"]=[' + row + '];', file => {
      let visited = false;
      assert.throws(() => forEachPanoRow(file, () => { visited = true; }), /Invalid panorama row/);
      assert.equal(visited, false);
    });
  }
});

test('a missing separator fails instead of merging two rows', () => {
  fixture('window.PANO_CITY["broken"]=[["a",1,2]["b",3,4]];', file => {
    assert.throws(() => forEachPanoRow(file, () => {}), /Expected row separator/);
  });
});

test('150000 short rows are visited without accumulating a shard array', () => {
  const count = 150000;
  const row = '["30111018141016114722300",112.12345678901234,37,"","","",0,0,"soso"]';
  const source = 'window.PANO_CITY["140100"]=[' + (row + ',').repeat(count - 1) + row + '];';
  let visited = 0;
  fixture(source, file => {
    assert.equal(forEachPanoRow(file, (key, value) => {
      assert.equal(value[0], '30111018141016114722300');
      assert.ok(Object.is(value[1], 112.12345678901234));
      visited++;
    }), count);
  });
  assert.equal(visited, count);
});
