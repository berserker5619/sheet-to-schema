// Round (a), and the lazy-load half of (b): the built app in Chromium, Firefox and WebKit.
// Usage: node run-browsers.mjs <dist dir> [label]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';

const dist = path.resolve(process.argv[2] ?? 'dist');
const label = process.argv[3] ?? 'vite';
const browsers = (process.argv[4] ?? 'chromium,firefox,webkit').split(',');
const expected = JSON.parse(fs.readFileSync(path.resolve('../ref/expected.json'), 'utf8'));
const fixtures = Object.keys(expected);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xlsx': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dist, url === '/' ? 'index.html' : url);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const report = { label, browsers: {} };
for (const name of browsers) {
  const type = { chromium, firefox, webkit }[name];
  const browser = await type.launch();
  const page = await browser.newPage(process.env.TZID ? { timezoneId: process.env.TZID } : {});
  const scripts = [];
  page.on('request', request => {
    if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
  });
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  const result = { version: browser.version(), capabilities: await page.evaluate(() => window.capabilities()), failures: [], passed: 0 };
  result.scriptsAtLoad = [...scripts];

  // CSVs first, so the scripts fetched before any workbook is read are what a CSV-only user loads.
  const ordered = [...fixtures.filter(f => !f.endsWith('.xlsx')), ...fixtures.filter(f => f.endsWith('.xlsx'))];
  for (const fixture of ordered) {
    if (fixture.endsWith('.xlsx') && !result.scriptsAfterCsv) result.scriptsAfterCsv = [...scripts];
    const read = await page.evaluate(f => window.readFixture(f), fixture);
    if (read.ok && isDeepStrictEqual(read.value, expected[fixture])) result.passed++;
    else result.failures.push({ fixture, via: 'readSheetFile', read: read.ok ? 'grid differs' : `${read.code}: ${read.message}`, ...(read.ok ? { got: read.value, want: expected[fixture] } : {}) });
    if (fixture.endsWith('.xlsx')) {
      const viaXlsx = await page.evaluate(f => window.readXlsxFixture(f), fixture);
      const want = { headers: expected[fixture].headers, rows: expected[fixture].rows };
      if (viaXlsx.ok && isDeepStrictEqual(viaXlsx.value, want)) result.passed++;
      else result.failures.push({ fixture, via: 'readXlsx', read: viaXlsx.ok ? 'grid differs' : `${viaXlsx.code}: ${viaXlsx.message}` });
    }
  }
  result.scriptsAtEnd = [...scripts];
  result.checks = ordered.length + fixtures.filter(f => f.endsWith('.xlsx')).length;
  report.browsers[name] = result;
  await browser.close();
  console.log(`${label} ${name} ${result.version}: ${result.passed}/${result.checks} passed; deflate-raw ${result.capabilities.deflateRaw}`);
  for (const failure of result.failures) console.log(`  FAIL ${failure.fixture} (${failure.via}): ${failure.read}`);
  console.log(`  scripts at load: ${result.scriptsAtLoad.join(', ')}`);
  console.log(`  scripts after all CSVs: ${result.scriptsAfterCsv.join(', ')}`);
  console.log(`  scripts after workbooks: ${result.scriptsAtEnd.join(', ')}`);
}
server.close();
fs.writeFileSync(`report-${label}.json`, JSON.stringify(report, null, 1));
