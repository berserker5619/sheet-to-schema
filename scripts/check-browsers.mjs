#!/usr/bin/env node
/**
 * The built package in Chromium, Firefox and WebKit, bundled the ways Dynamic Entity's Step 0
 * check found apps bundle it (docs/3.1-spec.md there), and what each read does (1.2).
 *
 * - `readCsvFile` from the main entry, bundled with `exceljs` unresolvable: it builds, a CSV
 *   reads, and a workbook is refused with UNSUPPORTED_FORMAT.
 * - `/browser` with `exceljs` external, so the browser resolves the bare specifier itself and
 *   fails with its own TypeError: a workbook is PEER_MISSING, with that TypeError as `cause`.
 * - `/browser` with `exceljs` replaced by Vite's optional-peer stub (reproduced verbatim; Vite
 *   writes it for a peer that is not installed): PEER_MISSING.
 * - `/browser` with `exceljs` installed: a workbook reads. Then with its chunk failing to
 *   download: the browser's TypeError passes through, and is not PEER_MISSING.
 *
 * webpack's ChunkLoadError is covered by `src/shared/optional.spec.ts`.
 * Needs `npx playwright install chromium firefox webkit`. Run after `npm run build`.
 */
/* global document, window -- the two callbacks page.waitForFunction and page.evaluate run in the page. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const CSV = readFileSync(join(ROOT, 'test/fixtures/real-world/case3_excel_semicolon.csv'));
const XLSX = readFileSync(join(ROOT, 'test/fixtures/real-world/case1_1904_dates.xlsx'));
const VITE_STUB = 'var e={};throw Error(`Could not resolve "exceljs" imported by "sheet-to-schema". Is it installed?`);export{e as default};\n';

/** Each browser's own words for a bare specifier nothing maps, as Step 0 recorded them. */
const BARE = {
  chromium: "Failed to resolve module specifier 'exceljs'",
  firefox: 'The specifier “exceljs” was a bare specifier, but was not remapped to anything. Relative module specifiers must start with “./”, “../” or “/”.',
  webkit: "Module name, 'exceljs' does not resolve to a valid URL.",
};
/** And for a lazy chunk that did not download. */
const CHUNK = {
  chromium: /^Failed to fetch dynamically imported module: http:\/\/127\.0\.0\.1:\d+\/chunk-\w+\.js$/,
  firefox: /^error loading dynamically imported module: http:\/\/127\.0\.0\.1:\d+\/chunk-\w+\.js$/,
  webkit: /^Importing a module script failed\.$/,
};

const PAGE = reader => `
${reader}
const describe = error => ({ name: error?.name, message: String(error?.message ?? error), code: error?.code, details: error?.details,
  cause: error?.cause && { name: error.cause.name, message: String(error.cause.message ?? error.cause) } });
const read = async (name, bytes) => {
  try {
    const sheet = await readFile(new File([bytes], name), { filename: name });
    return { ok: true, format: sheet.format, delimiter: sheet.delimiter, headers: sheet.headers };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
};
window.probe = async () => {
  const fetchBytes = async name => new Uint8Array(await (await fetch('/' + name)).arrayBuffer());
  return { csv: await read('data.csv', await fetchBytes('data.csv')), xlsx: await read('data.xlsx', await fetchBytes('data.xlsx')) };
};
document.title = 'ready';
`;

const MAIN = "import { readCsvFile as readFile } from 'sheet-to-schema';";
const BROWSER = "import { readSheetFile as readFile } from 'sheet-to-schema/browser';";

const notInstalled = {
  name: 'exceljs-not-installed',
  setup(build) {
    build.onResolve({ filter: /^exceljs(?:\/|$)/ }, args => ({ errors: [{ text: `Could not resolve "${args.path}" (exceljs is not installed)` }] }));
  },
};

/** Bundle `source` into a served folder of its own, as a consumer's bundler would. */
async function bundle(work, label, source, options = {}) {
  const dir = join(work, label);
  const entry = join(work, `${label}.mjs`);
  writeFileSync(entry, source);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    outdir: dir,
    entryNames: 'main',
    chunkNames: 'chunk-[hash]',
    logLevel: 'silent',
    alias: { 'sheet-to-schema/browser': join(DIST, 'browser/index.mjs'), 'sheet-to-schema': join(DIST, 'index.mjs'), ...options.alias },
    nodePaths: [join(ROOT, 'node_modules')],
    external: options.external ?? [],
    plugins: options.plugins ?? [],
  });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>loading</title><script type="module" src="/main.js"></script>');
  writeFileSync(join(dir, 'data.csv'), CSV);
  writeFileSync(join(dir, 'data.xlsx'), XLSX);
  return dir;
}

function serve(dir) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const file = pathname === '/' ? 'index.html' : pathname;
    try {
      const body = readFileSync(join(dir, file));
      res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript' }[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Open `dir` in `browser`, optionally failing every script requested after load, and probe. */
async function probe(browser, dir, { blockLazy = false } = {}) {
  const server = await serve(dir);
  const page = await browser.newPage();
  let loaded = false;
  await page.route('**/*', route => (loaded && blockLazy && route.request().resourceType() === 'script' ? route.abort('failed') : route.continue()));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.title === 'ready');
    loaded = true;
    return await page.evaluate(() => window.probe());
  } finally {
    await page.close();
    server.close();
  }
}

const CSV_READ = { ok: true, format: 'csv', delimiter: ';', headers: ['Product', 'Price', 'Rating'] };
const INSTALL =
  'sheet-to-schema/browser needs the "exceljs" package to read .xlsx files, and it is not installed. ' +
  'It is an optional peer dependency: run `npm install exceljs`.';

const work = mkdtempSync(join(tmpdir(), 's2s-browsers-'));
let failed = false;
try {
  writeFileSync(join(work, 'exceljs-vite-stub.js'), VITE_STUB);
  const builds = {
    csvOnly: await bundle(work, 'csv-only', PAGE(MAIN), { plugins: [notInstalled] }),
    external: await bundle(work, 'external', PAGE(BROWSER), { external: ['exceljs'] }),
    viteStub: await bundle(work, 'vite-stub', PAGE(BROWSER), { alias: { exceljs: join(work, 'exceljs-vite-stub.js') } }),
    installed: await bundle(work, 'installed', PAGE(BROWSER)),
  };

  for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch();
    const cases = [
      ['readCsvFile, exceljs not installed', builds.csvOnly, {}, r => {
        assert.deepEqual(r.csv, CSV_READ);
        assert.equal(r.xlsx.error.code, 'UNSUPPORTED_FORMAT');
      }],
      ['/browser, exceljs external', builds.external, {}, r => {
        assert.deepEqual(r.csv, CSV_READ);
        assert.deepEqual([r.xlsx.error.code, r.xlsx.error.message, r.xlsx.error.details], ['PEER_MISSING', INSTALL, { peer: 'exceljs' }]);
        assert.deepEqual(r.xlsx.error.cause, { name: 'TypeError', message: BARE[name] });
      }],
      ["/browser, Vite's stub", builds.viteStub, {}, r => {
        assert.deepEqual(r.csv, CSV_READ);
        assert.deepEqual([r.xlsx.error.code, r.xlsx.error.details], ['PEER_MISSING', { peer: 'exceljs' }]);
      }],
      ['/browser, exceljs installed', builds.installed, {}, r => {
        assert.deepEqual(r.csv, CSV_READ);
        assert.deepEqual([r.xlsx.ok, r.xlsx.format], [true, 'xlsx']);
      }],
      ['/browser, its chunk fails to download', builds.installed, { blockLazy: true }, r => {
        assert.equal(r.xlsx.error.name, 'TypeError');
        assert.equal(r.xlsx.error.code, undefined, 'a failed download is not PEER_MISSING');
        assert.match(r.xlsx.error.message, CHUNK[name]);
      }],
    ];
    for (const [what, dir, options, check] of cases) {
      const result = await probe(browser, dir, options);
      try {
        check(result);
        console.log(`${name} ${browser.version()}: ${what}: ok`);
      } catch (error) {
        failed = true;
        console.error(`${name} ${browser.version()}: ${what}: FAILED\n  ${error.message.split('\n').join('\n  ')}\n  read: ${JSON.stringify(result)}`);
      }
    }
    await browser.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('Browser check passed.');
