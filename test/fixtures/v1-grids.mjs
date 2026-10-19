#!/usr/bin/env node
/**
 * Writes `v1-grids.json`: what sheet-to-schema 1.3.0 read from every CSV, TSV and .xlsx fixture
 * here, through `/node`'s `readSheet` and `/browser`'s `readSheetFile`. 2.0's binary refusal
 * (docs/2.0-spec.md, §4.2) must not change a byte of it; `src/binary-refusal.spec.ts` compares.
 *
 * Run from a checkout of v1.3.0 that has been built, pointing at this repository's fixtures:
 *
 *     git worktree add ../s2s-v1 v1.3.0 && cd ../s2s-v1 && npm ci && npm run build
 *     node <this repo>/test/fixtures/v1-grids.mjs <this repo>/test/fixtures
 *
 * Dates are written as `{ "$date": "<ISO>" }` so the JSON round-trips them.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';

const fixtures = process.argv[2];
if (!fixtures) {
  console.error('usage: node v1-grids.mjs <fixtures dir>   (run from a built v1.3.0 checkout)');
  process.exit(2);
}
const require = createRequire(join(process.cwd(), 'package.json'));
const { version } = require('./package.json');
const { readSheet } = require('./dist/node/index.js');
const { readSheetFile } = require('./dist/browser/index.js');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(csv|tsv|xlsx)$/i.test(name)) files.push(path);
  }
})(fixtures);

const plain = value => (value instanceof Date ? { $date: value.toISOString() } : value);
const grid = sheet => ({ headers: sheet.headers, rows: sheet.rows.map(row => row.map(plain)), ...(sheet.delimiter ? { delimiter: sheet.delimiter } : {}) });

const out = { version, grids: {} };
for (const file of files) {
  const bytes = readFileSync(file);
  const name = relative(fixtures, file).split(sep).join('/');
  const sheet = await readSheet({ stream: bytes, filename: name });
  const rows = [];
  for await (const row of sheet.rows) rows.push(row);
  out.grids[name] = {
    format: sheet.format,
    node: grid({ ...sheet, rows }),
    browser: grid(await readSheetFile(bytes, { filename: name })),
  };
}
writeFileSync(join(fixtures, 'v1-grids.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`v1-grids.json: ${files.length} fixtures read by sheet-to-schema ${version}`);
