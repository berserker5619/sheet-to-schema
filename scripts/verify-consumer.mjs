#!/usr/bin/env node
/**
 * Install the packed tarball the way a user would, and use it from outside this repository.
 *
 * Two scratch projects:
 * - bare: no optional peers. The main entry loads as CJS and ESM, every `exports` path resolves,
 *   `/node` loads and reads a CSV, and asking it for a workbook fails with the peer message.
 * - full: exceljs, busboy and express installed. `/node` reads a real workbook and serves an
 *   upload through `createImportRouter` over HTTP.
 * Also: the packed manifest declares no runtime dependencies.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
// Under `npm run`, call npm's own CLI through node: no shell, so it also works on Windows.
const NPM = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['npm'];
const run = (cmd, args, opts = {}) => {
  const [bin, ...pre] = cmd === 'npm' ? NPM : [cmd];
  return execFileSync(bin, [...pre, ...args], { encoding: 'utf8', stdio: 'pipe', ...opts });
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 's2s-consumer-'));

try {
  console.log('→ Packing sheet-to-schema');
  const tarballs = path.join(work, 'tarballs');
  fs.mkdirSync(tarballs);
  run('npm', ['pack', ROOT, '--silent'], { cwd: tarballs });
  const packed = fs.readdirSync(tarballs).find(f => f.endsWith('.tgz'));
  if (!packed) throw new Error('npm pack produced no tarball');
  const tgz = path.join(tarballs, packed).replace(/\\/g, '/');
  console.log(`  packed: ${packed}`);

  const project = (name, extra = {}) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir);
    const dependencies = { 'sheet-to-schema': `file:${tgz}`, ...extra };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true, dependencies }, null, 2));
    console.log(`→ Installing into "${name}"`);
    run('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir });
    return dir;
  };
  const script = (dir, file, text) => {
    fs.writeFileSync(path.join(dir, file), text);
    run('node', [file], { cwd: dir, stdio: 'inherit' });
  };

  // Bare: no optional peers.
  const bare = project('bare');
  const installed = JSON.parse(fs.readFileSync(path.join(bare, 'node_modules/sheet-to-schema/package.json'), 'utf8'));
  if (installed.version !== pkg.version) throw new Error(`installed ${installed.version}, expected ${pkg.version}`);
  if (Object.keys(installed.dependencies ?? {}).length) {
    throw new Error(`the package declares runtime dependencies: ${Object.keys(installed.dependencies).join(', ')}`);
  }
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
    if (fs.existsSync(path.join(bare, 'node_modules', peer))) throw new Error(`optional peer "${peer}" was installed without being asked for`);
  }

  script(
    bare,
    'cjs.cjs',
    `
const assert = require('node:assert/strict');
const main = require('sheet-to-schema');
assert.equal(main.IMPORTER_VERSION, ${JSON.stringify(pkg.version)});
assert.equal(main.parseCsv('A,B\\n1,2').rows.length, 1);
const node = require('sheet-to-schema/node');
assert.equal(typeof node.readSheet, 'function');
assert.equal(require('sheet-to-schema/package.json').version, ${JSON.stringify(pkg.version)});
for (const id of ['sheet-to-schema', 'sheet-to-schema/node', 'sheet-to-schema/package.json']) require.resolve(id);
console.log('  CJS: main entry, /node and package.json resolve and load');
`,
  );

  script(
    bare,
    'esm.mjs',
    `
import assert from 'node:assert/strict';
import { parseCsv, IMPORTER_VERSION } from 'sheet-to-schema';
import { readSheet } from 'sheet-to-schema/node';
assert.equal(IMPORTER_VERSION, ${JSON.stringify(pkg.version)});
assert.equal(parseCsv('A,B\\n1,2').headers[1], 'B');
for (const id of ['sheet-to-schema', 'sheet-to-schema/node']) assert.ok(import.meta.resolve(id).endsWith('.mjs'), id);

const csv = await readSheet({ stream: (async function* () { yield Buffer.from('Col1,Col2\\nval1,val2'); })() });
assert.deepEqual(csv.headers, ['Col1', 'Col2']);

await assert.rejects(
  async () => {
    const sheet = await readSheet({ stream: (async function* () { yield Buffer.from('PK\\x03\\x04dummy'); })() });
    for await (const _ of sheet.rows);
  },
  e => e.message.includes('"exceljs"') && e.message.includes('optional peer dependency'),
);
console.log('  ESM: main entry and /node load; CSV reads; a workbook without exceljs fails with the peer message');
`,
  );

  // Full: every optional peer installed.
  const peers = Object.fromEntries(Object.entries(pkg.peerDependencies ?? {}));
  const full = project('full', peers);
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/real-world/case1_1904_dates.xlsx'), path.join(full, 'case1.xlsx'));
  script(
    full,
    'peers.mjs',
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { readSheet, createImportRouter } from 'sheet-to-schema/node';

const bytes = fs.readFileSync('case1.xlsx');
const sheet = await readSheet({ stream: (async function* () { yield bytes; })(), filename: 'case1.xlsx' });
assert.equal(sheet.format, 'xlsx');
assert.deepEqual(sheet.headers, ['Name', 'BirthDate', 'JoinDate']);

const adapter = jsonSchemaAdapter({
  type: 'object',
  properties: { name: { type: 'string' }, birthDate: { type: 'string', format: 'date' } },
});
const written = [];
const app = express();
app.use('/import', createImportRouter(express.Router(), {
  bindings: { people: { adapter, ctx: undefined } },
  onImport: records => { written.push(...records); },
}));
const server = app.listen(0);
try {
  const form = new FormData();
  form.append('plan', JSON.stringify({ target: 'people', entries: [{ ref: 'name', column: 0 }, { ref: 'birthDate', column: 1 }] }));
  form.append('file', new Blob([bytes]), 'case1.xlsx');
  const response = await fetch(\`http://127.0.0.1:\${server.address().port}/import/people/import\`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.imported, 2);
  assert.deepEqual(written, [
    { name: 'Alice Mac', birthDate: '2026-05-15' },
    { name: 'Bob Mac', birthDate: '1985-10-26' },
  ]);
} finally {
  server.close();
}
console.log('  peers: exceljs reads a workbook; busboy and express serve an upload through createImportRouter');
`,
  );

  console.log('Consumer verification passed.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
