// 2.0 extra: the real PNG (named .csv) and PDF, read by readSheetFile in each browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
const dist = path.resolve('dist');
const types = { '.js': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
let bad = 0;
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'ready');
  for (const f of ['photo.csv', 'report.pdf']) {
    const r = await page.evaluate(n => window.readFixture(n), f);
    const ok = !r.ok && r.code === 'UNSUPPORTED_FORMAT' && /binary data/.test(r.message);
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${engine.name()} ${f}: ${r.ok ? 'READ' : `${r.code}: ${r.message}`}`);
  }
  await browser.close();
}
server.close();
process.exit(bad ? 1 : 0);
