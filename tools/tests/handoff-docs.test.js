// Tiny local Git repositories only: never change this checkout, call a remote or load point data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const checker = path.resolve(__dirname, '..', 'check_handoff_docs.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-handoff-'));
  const root = fs.realpathSync(directory);
  t.after(() => {
    // Cleanup is limited to this exact fixture directory, not a derived repo path.
    assert.equal(fs.realpathSync(directory), root);
    assert.ok(path.basename(root).startsWith('pano-handoff-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  // Hook executions may inherit the parent repository. The fixture must never
  // write into that repository's index/worktree/configuration.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS']) delete env[name];
  const write = (relative, contents) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false',
      '-c', 'core.autocrlf=false', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  write('city-viewer/index.html', '<span class="ver">v2.45.0</span>\n');
  write('city-viewer/data_meta.js', 'window.PANO_COUNT={"fixture":1};\n');
  write('city-viewer/changelog.js', "window.PANO_CHANGELOG=[{version:'2.45.0'}];\n");
  write('city-viewer/data_fixture.js', '/* small original point fixture */\n');
  write('mohe/mohe-boundary.geojson', '{"type":"FeatureCollection","features":[]}\n');
  write('tools/check_handoff_docs.js', fs.readFileSync(checker));
  git('init', '--quiet');
  git('add', '--', 'city-viewer', 'mohe', 'tools');
  git('commit', '--quiet', '-m', 'fixture data baseline');
  const recorded = git('rev-parse', '--short', 'HEAD');
  write('AGENT.md', `页面版本 **v2.45.0**\n数据规模：**1** 点\nHEAD \`${recorded}\`\n`);
  write('agent_history.md', `| 页面版本 | **v2.45.0** |\n| 街景点总数 | **1** |\n| HEAD | \`${recorded}\` |\n## 3. 历史\n| v2.45.0 | fixture |\n`);
  const check = () => {
    const result = spawnSync(process.execPath, [path.join(root, 'tools/check_handoff_docs.js')],
      { cwd: root, env, encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const commit = (relative, contents) => {
    write(relative, contents);
    git('add', '--', relative);
    git('commit', '--quiet', '-m', 'fixture change');
  };
  const baseline = check();
  assert.equal(baseline.status, 0, baseline.output);
  return { root, recorded, write, git, check, commit };
}

function assertDataChangeBlocked(result) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /还有 \d+ 个改动 city-viewer\//);
}

test('archive-only move keeps the genuine data baseline valid', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'city-viewer/legacy/tencent/mohe'), { recursive: true });
  f.git('mv', '--', 'mohe/mohe-boundary.geojson', 'city-viewer/legacy/tencent/mohe/mohe-boundary.geojson');
  f.git('commit', '--quiet', '-m', 'source-only consolidation [skip ci]');
  f.commit('city-viewer/legacy/README.md', 'Historical originals; never published.\n');
  f.commit('city-viewer/legacy/baidu/s341/old.json', '{"provider":"baidu"}\n');
  const result = f.check();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /PASS: v2\.45\.0 \/ 1 点/);
  assert.match(fs.readFileSync(path.join(f.root, 'AGENT.md'), 'utf8'), new RegExp(f.recorded));
});

for (const relative of ['city-viewer/data_fixture.js', 'city-viewer/index.html',
  'city-viewer/vendor/theme.css', 'city-viewer/legacy-extra/theme.css',
  'city-viewer/legacy.js', 'city-viewer/vendor/legacy/theme.css']) {
  test(`active or similarly named change remains blocked: ${relative}`, (t) => {
    const f = fixture(t);
    const contents = relative.endsWith('/index.html')
      ? '<span class="ver">v2.45.0</span>\n<!-- changed frontend -->\n'
      : '/* different bytes; unchanged count/version cannot hide a data commit */\n';
    f.commit(relative, contents);
    assertDataChangeBlocked(f.check());
  });
}

test('a commit mixing archived files with active data remains blocked', (t) => {
  const f = fixture(t);
  f.write('city-viewer/legacy/inventory.json', '{}\n');
  f.write('city-viewer/data_fixture.js', '/* changed active data */\n');
  f.git('add', '--', 'city-viewer/legacy/inventory.json', 'city-viewer/data_fixture.js');
  f.git('commit', '--quiet', '-m', 'mixed archive and active change');
  assertDataChangeBlocked(f.check());
});

test('moving active data into the archive remains blocked by its deletion', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'city-viewer/legacy/tencent'), { recursive: true });
  f.git('mv', '--', 'city-viewer/data_fixture.js', 'city-viewer/legacy/tencent/data_fixture.js');
  f.git('commit', '--quiet', '-m', 'active data removed');
  assertDataChangeBlocked(f.check());
});
