// The built app in each browser with DecompressionStream made to reject "deflate-raw", as
// Chrome and Edge 80-102 do: a CSV must read, a workbook must be refused with UNSUPPORTED_RUNTIME.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const dist = path.resolve('dist');
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dist, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, resolve));
for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await type.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const Real = globalThis.DecompressionStream;
    globalThis.DecompressionStream = class extends Real {
      constructor(format) {
        if (format === 'deflate-raw') throw new TypeError(`Unsupported compression format: '${format}'`);
        super(format);
      }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  const csv = await page.evaluate(() => window.readFixture('case3_excel_semicolon.csv'));
  const xlsx = await page.evaluate(() => window.readFixture('case1_1904_dates.xlsx'));
  const ok = csv.ok && csv.value.delimiter === ';' && !xlsx.ok && xlsx.code === 'UNSUPPORTED_RUNTIME' && /Node 20\.12\+.*Chrome or Edge 103\+.*Firefox 113\+.*Safari 16\.4\+/.test(xlsx.message);
  console.log(`${name} ${browser.version()}: CSV ${csv.ok ? 'read' : 'FAILED'}; workbook ${xlsx.ok ? 'READ (unexpected)' : xlsx.code}; ${ok ? 'pass' : 'FAIL'}`);
  await browser.close();
}
server.close();
