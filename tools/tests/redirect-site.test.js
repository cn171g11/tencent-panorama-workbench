const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const tools = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(tools, 'templates/legacy-redirect.html'), 'utf8');
const publisher = fs.readFileSync(path.join(tools, 'build_gzip_site.py'), 'utf8');
const rootHtml = publisher.match(/REDIRECT = b'''([\s\S]*?)'''/)[1];
const newBase = 'https://cn171g11.github.io/tencent-panorama-workbench/';

function execute(page, url, delayed) {
  const location = new URL(url);
  const link = {};
  const canonical = {};
  const replacements = [];
  const timers = [];
  const window = {
    location: {
      href: location.href, pathname: location.pathname,
      search: location.search, hash: location.hash,
      replace(value) { replacements.push(value); },
    },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
  };
  const context = { URL, window, document: {
    getElementById() { return link; },
    querySelector() { return canonical; },
  } };
  const code = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(code, context, { timeout: 1000 });
  if (delayed) {
    assert.equal(replacements.length, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 2000);
    timers[0].fn();
  }
  assert.equal(replacements.length, 1);
  assert.equal(link.href, replacements[0]);
  return { target: replacements[0], canonical: canonical.href };
}

for (const [suffix, expected] of [
  ['', 'city-viewer/'],
  ['index.html', 'city-viewer/'],
  ['city-viewer/', 'city-viewer/'],
  ['city-viewer/index.html', 'city-viewer/index.html'],
  ['city-viewer/report.html', 'city-viewer/report.html'],
  ['city-viewer/data_110000.js.gz', 'city-viewer/data_110000.js.gz'],
  ['g101/', 'city-viewer/'],
  ['s341/index.html', 'city-viewer/'],
  ['city-viewer/../../other/', 'city-viewer/'],
]) {
  test(`old route ${suffix || '/'} preserves query/hash and stays on the new site`, () => {
    const result = execute(html, 'https://cn171g11.github.io/panorama-workbench/' + suffix + '?q=%E5%8C%97%E4%BA%AC&sid=001#map', true);
    assert.equal(result.target, newBase + expected + '?q=%E5%8C%97%E4%BA%AC&sid=001#map');
    assert.equal(result.canonical, newBase + expected);
  });
}

test('migration contains a visible brand, manual link and no-JS fallback', () => {
  assert.match(html, /<h1>tencent-panorama-workbench<\/h1>/);
  assert.match(html, /http-equiv="refresh" content="3;url=https:\/\/cn171g11.github.io\/tencent-panorama-workbench\/city-viewer\//);
  assert.match(html, /id="destination" href="https:\/\/cn171g11.github.io\/tencent-panorama-workbench\/city-viewer\//);
  assert.match(html, /noindex,follow/);
});

for (const route of [newBase, newBase + 'index.html', 'http://127.0.0.1:8000/']) {
  test(`new root ${route} preserves query/hash`, () => {
    const result = execute(rootHtml, route + '?sid=001#point', false);
    assert.equal(result.target, new URL('city-viewer/', route).href + '?sid=001#point');
    assert.match(rootHtml, /<title>tencent-panorama-workbench<\/title>/);
  });
}
