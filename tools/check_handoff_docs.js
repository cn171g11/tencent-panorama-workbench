#!/usr/bin/env node
/**
 * Verify that the local handoff notes match the data that is about to be pushed.
 *
 * The failure this prevents: data batches get committed and pushed, but AGENT.md §1 and
 * agent_history.md §1 keep showing an older version / point count, so the next person (or
 * model) starts from stale numbers.
 *
 * Four things are compared:
 *   1. page version   — city-viewer/index.html  vs  AGENT.md  vs  agent_history.md
 *   2. point total    — sum of PANO_COUNT       vs  AGENT.md  vs  agent_history.md
 *   3. changelog top  — city-viewer/changelog.js first entry must equal the page version
 *   4. recorded HEAD  — the commit named in both docs must be an ancestor of HEAD, and no
 *                       commit touching city-viewer/ may exist after it (doc-only or tool-only
 *                       commits after it are fine, otherwise every commit would invalidate itself)
 *   5. timeline order — the first versioned row of agent_history.md §3 must be the page version
 *
 * AGENT.md / agent_history.md are local-only files. When they are absent (fresh clone on
 * another machine) the check reports that it skipped instead of blocking the push.
 *
 * Usage: node tools/check_handoff_docs.js [--quiet]
 * Exit:  0 = consistent, 1 = stale handoff notes
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VIEWER = path.join(ROOT, 'city-viewer');

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const problems = [];
const notes = [];
const add = (msg) => problems.push(msg);

// ---------------------------------------------------------------- 数据源
const indexHtml = read(path.join(VIEWER, 'index.html'));
if (!indexHtml) {
  console.error('无法读取 city-viewer/index.html');
  process.exit(1);
}
const versionMatch = indexHtml.match(/<span class="ver">(v\d+\.\d+\.\d+)<\/span>/);
if (!versionMatch) {
  console.error('index.html 里找不到 <span class="ver">vX.Y.Z</span>');
  process.exit(1);
}
const pageVersion = versionMatch[1];

const metaSource = read(path.join(VIEWER, 'data_meta.js'));
if (!metaSource) {
  console.error('无法读取 city-viewer/data_meta.js');
  process.exit(1);
}
const countStart = metaSource.indexOf('window.PANO_COUNT=');
if (countStart === -1) {
  console.error('data_meta.js 里找不到 PANO_COUNT');
  process.exit(1);
}
let counts;
try {
  counts = JSON.parse(
    metaSource.slice(countStart + 'window.PANO_COUNT='.length).split(';')[0]
  );
} catch (error) {
  console.error('PANO_COUNT 解析失败: ' + error.message);
  process.exit(1);
}
const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
const totalText = total.toLocaleString('en-US');

// ---------------------------------------------------------------- changelog
const changelog = read(path.join(VIEWER, 'changelog.js'));
if (changelog) {
  const first = changelog.match(/version:\s*'(\d+\.\d+\.\d+)'/);
  if (first && 'v' + first[1] !== pageVersion) {
    add(`changelog.js 首条是 v${first[1]}，但页面版本是 ${pageVersion}`);
  }
}

// ---------------------------------------------------------------- 交接文档
const checkDoc = (file, versionPattern, totalPattern) => {
  const source = read(path.join(ROOT, file));
  if (source === null) {
    notes.push(`${file} 不存在，跳过检查（换机器后属正常）`);
    return;
  }
  const version = source.match(versionPattern);
  if (!version) {
    add(`${file} 里找不到页面版本（期望 ${pageVersion}）`);
  } else if ('v' + version[1].replace(/^v/, '') !== pageVersion) {
    add(`${file} 写的版本是 v${version[1].replace(/^v/, '')}，实际 ${pageVersion}`);
  }
  const totalHit = source.match(totalPattern);
  if (!totalHit) {
    add(`${file} 里找不到总量（期望 ${totalText}）`);
  } else if (totalHit[1].replace(/,/g, '') !== String(total)) {
    add(`${file} 写的总量是 ${totalHit[1]}，实际 ${totalText}`);
  }
};

// AGENT.md: "页面版本 **v2.26.0**" / "数据规模：**35,878,341** 点"
checkDoc('AGENT.md', /页面版本 \*\*v(\d+\.\d+\.\d+)\*\*/, /数据规模：\*\*([\d,]+)\*\*/);
// agent_history.md: 表格行 "| 页面版本 | **v2.26.0** |" / "| 街景点总数 | **35,878,341** |"
checkDoc(
  'agent_history.md',
  /\|\s*页面版本\s*\|\s*\*\*v(\d+\.\d+\.\d+)\*\*\s*\|/,
  /\|\s*街景点总数\s*\|\s*\*\*([\d,]+)\*\*\s*\|/
);

// ---------------------------------------------------------------- 记录提交与时间线顺序
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const headShort = git(['rev-parse', '--short', 'HEAD']);
const checkRecordedHead = (file, pattern) => {
  const source = read(path.join(ROOT, file));
  if (source === null) return;
  const hit = source.match(pattern);
  if (!hit) {
    add(`${file} 里找不到记录的提交哈希（期望指向最新数据提交）`);
    return;
  }
  const recorded = hit[1];
  if (git(['rev-parse', '--verify', '--quiet', recorded + '^{commit}']) === null) {
    add(`${file} 记录的提交 ${recorded} 在仓库里不存在`);
    return;
  }
  if (git(['merge-base', '--is-ancestor', recorded, 'HEAD']) === null) {
    add(`${file} 记录的提交 ${recorded} 不是 HEAD 的祖先（历史被重写？）`);
    return;
  }
  // 关键判据：记录之后不应再有改动 city-viewer/ 的提交
  const laterData = git(['rev-list', '--oneline', recorded + '..HEAD', '--', 'city-viewer/']);
  if (laterData) {
    const count = laterData.split('\n').filter(Boolean).length;
    add(`${file} 记录的提交 ${recorded} 之后还有 ${count} 个改动 city-viewer/ 的提交（最新数据提交应为 ${headShort}）`);
  }
};

if (headShort) {
  checkRecordedHead('AGENT.md', /HEAD `([0-9a-f]{7,40})`/);
  checkRecordedHead('agent_history.md', /\|\s*HEAD[^|]*\|\s*`([0-9a-f]{7,40})`/);
} else {
  notes.push('git 不可用，跳过记录提交检查');
}

// 时间线首行必须是当前页面版本
const history = read(path.join(ROOT, 'agent_history.md'));
if (history) {
  const section = history.split('## 3.')[1];
  if (!section) {
    add('agent_history.md 里找不到 §3 时间线');
  } else {
    const firstRow = section.split('\n').find((line) => /^\|\s*v\d+\.\d+\.\d+\s*\|/.test(line));
    if (!firstRow) {
      add('agent_history.md §3 时间线里没有任何版本行');
    } else {
      const version = firstRow.match(/^\|\s*(v\d+\.\d+\.\d+)\s*\|/)[1];
      if (version !== pageVersion) {
        add(`agent_history.md §3 首行是 ${version}，页面版本是 ${pageVersion}（时间线漏最新一条或顺序颠倒）`);
      }
    }
  }
}

// ---------------------------------------------------------------- 输出
const quiet = process.argv.includes('--quiet');
if (problems.length) {
  console.error('交接文档与当前数据不一致，共 ' + problems.length + ' 处：');
  for (const item of problems) console.error('  - ' + item);
  console.error('\n修好 AGENT.md §1 与 agent_history.md §1 的版本号/总量后再推送。');
  console.error(`当前实际：${pageVersion} / ${totalText} 点`);
  process.exit(1);
}
if (!quiet) {
  console.log(`PASS: ${pageVersion} / ${totalText} 点，AGENT.md 与 agent_history.md 均已同步`);
  for (const item of notes) console.log('  · ' + item);
}
