#!/usr/bin/env node
/**
 * Install the packed tarball the way a user would, and use it from outside this repository.
 *
 * Scratch projects:
 * - bare: no optional peers. The main entry loads as CJS and ESM, every `exports` path resolves,
 *   `/browser` reads a CSV from both and asks for exceljs only when given a workbook,
 *   `/node` reads a CSV from both CJS and ESM, and asking it for a workbook fails with the peer
 *   message.
 * - full: exceljs, busboy and express installed. `/node` reads a real workbook and serves an
 *   upload through `createImportRouter` over HTTP.
 * - jest: a CommonJS Jest project, with no Node flags, that requires `/node`, reads a workbook
 *   and receives an upload. A dynamic `import()` in the CommonJS build fails exactly here.
 * - types-express4, types-express5: the published typings compile, with `skipLibCheck` off,
 *   against each major of `@types/express`, used the way the README shows.
 * Also: the packed manifest declares no runtime dependencies.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

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
  // Without the caller's NODE_OPTIONS: the Jest project must pass with no Node flags at all.
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;

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
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/real-world/case1_1904_dates.xlsx'), path.join(bare, 'case1.xlsx'));

  script(
    bare,
    'cjs.cjs',
    `
const assert = require('node:assert/strict');
const main = require('sheet-to-schema');
assert.equal(main.IMPORTER_VERSION, ${JSON.stringify(pkg.version)});
assert.equal(main.parseCsv('A,B\\n1,2').rows.length, 1);
const node = require('sheet-to-schema/node');
assert.equal(require('sheet-to-schema/package.json').version, ${JSON.stringify(pkg.version)});
for (const id of ['sheet-to-schema', 'sheet-to-schema/node', 'sheet-to-schema/browser', 'sheet-to-schema/package.json']) require.resolve(id);
const browser = require('sheet-to-schema/browser');

(async () => {
  const csv = await node.readSheet({ stream: (async function* () { yield Buffer.from('Col1,Col2\\nval1,val2'); })() });
  assert.equal(csv.format, 'csv');
  assert.deepEqual(csv.headers, ['Col1', 'Col2']);
  const rows = [];
  for await (const row of csv.rows) rows.push(row);
  assert.deepEqual(rows, [['val1', 'val2']]);

  const read = await browser.readSheetFile(Buffer.from('Col1;Col2\\n1,5;x'));
  assert.deepEqual(read, { format: 'csv', headers: ['Col1', 'Col2'], rows: [['1,5', 'x']], delimiter: ';' });
  await assert.rejects(
    browser.readSheetFile(require('node:fs').readFileSync('case1.xlsx')),
    e => e.message.startsWith('sheet-to-schema/browser needs the "exceljs" package') && e.message.includes('optional peer dependency'),
  );
  console.log('  CJS: main entry, /node, /browser and package.json resolve and load; CSV reads with no peers');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
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
for (const id of ['sheet-to-schema', 'sheet-to-schema/node', 'sheet-to-schema/browser']) assert.ok(import.meta.resolve(id).endsWith('.mjs'), id);

const csv = await readSheet({ stream: (async function* () { yield Buffer.from('Col1,Col2\\nval1,val2'); })() });
assert.deepEqual(csv.headers, ['Col1', 'Col2']);
const rows = [];
for await (const row of csv.rows) rows.push(row);
assert.deepEqual(rows, [['val1', 'val2']]);

await assert.rejects(
  async () => {
    const sheet = await readSheet({ stream: (async function* () { yield Buffer.from('PK\\x03\\x04dummy'); })() });
    for await (const _ of sheet.rows);
  },
  e => e.message.includes('"exceljs"') && e.message.includes('optional peer dependency'),
);
const { readSheetFile } = await import('sheet-to-schema/browser');
assert.equal((await readSheetFile(new Blob(['a\\tb\\n1\\t2']), { filename: 'x.tsv' })).delimiter, '\\t');
const { readFileSync } = await import('node:fs');
await assert.rejects(readSheetFile(readFileSync('case1.xlsx')), e => e.message.includes('"exceljs"'));
console.log('  ESM: main entry, /node and /browser load; CSV reads; a workbook without exceljs fails with the peer message');
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

  // A browser app, bundled from the installed package as a consumer's bundler would: `exceljs`
  // resolves to its browser build and is split into a chunk of its own. The bundle then reads a
  // CSV and a workbook.
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/real-world/case3_excel_semicolon.csv'), path.join(full, 'semicolon.csv'));
  fs.writeFileSync(
    path.join(full, 'app.mjs'),
    "import { readSheetFile } from 'sheet-to-schema/browser';\nexport const read = (file, filename) => readSheetFile(file, { filename });\n",
  );
  const bundled = await esbuild.build({
    absWorkingDir: full,
    entryPoints: ['app.mjs'],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    outdir: 'bundle',
    outExtension: { '.js': '.mjs' },
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(bundled.metafile.inputs);
  if (!inputs.some(input => /node_modules[\\/]exceljs[\\/]dist[\\/]/.test(input))) throw new Error('the browser bundle did not use exceljs\'s browser build');
  if (inputs.some(input => /node_modules[\\/]sheet-to-schema[\\/]dist[\\/]node[\\/]/.test(input))) throw new Error('the browser bundle pulled in sheet-to-schema/node');
  script(
    full,
    'browser-bundle.mjs',
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { read } from './bundle/app.mjs';

const csv = await read(new Blob([fs.readFileSync('semicolon.csv')]), 'semicolon.csv');
assert.equal(csv.format, 'csv');
assert.equal(csv.delimiter, ';');
assert.deepEqual(csv.headers, ['Product', 'Price', 'Rating']);

const xlsx = await read(new Blob([fs.readFileSync('case1.xlsx')]), 'case1.xlsx');
assert.equal(xlsx.format, 'xlsx');
assert.deepEqual(xlsx.headers, ['Name', 'BirthDate', 'JoinDate']);
assert.equal(xlsx.rows[0][1].toISOString(), '2026-05-15T00:00:00.000Z');
console.log('  browser bundle: built from the installed package, exceljs split out; reads a CSV and an .xlsx through readSheetFile');
`,
  );

  // Jest: CommonJS, no transform, no Node flags.
  const jest = project('jest', { ...peers, jest: pkg.devDependencies.jest });
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/real-world/case1_1904_dates.xlsx'), path.join(jest, 'case1.xlsx'));
  fs.writeFileSync(
    path.join(jest, 'node.test.js'),
    `
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { jsonSchemaAdapter } = require('sheet-to-schema');
const { readSheet, createImportRouter } = require('sheet-to-schema/node');

const bytes = fs.readFileSync(path.join(__dirname, 'case1.xlsx'));

test('reads a workbook', async () => {
  const sheet = await readSheet({ stream: (async function* () { yield bytes; })(), filename: 'case1.xlsx' });
  expect(sheet.format).toBe('xlsx');
  expect(sheet.headers).toEqual(['Name', 'BirthDate', 'JoinDate']);
});

test('receives an upload through createImportRouter', async () => {
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
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/import/people/import', { method: 'POST', body: form });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.imported).toBe(2);
    expect(written).toEqual([
      { name: 'Alice Mac', birthDate: '2026-05-15' },
      { name: 'Bob Mac', birthDate: '1985-10-26' },
    ]);
  } finally {
    server.close();
  }
});
`,
  );
  run(process.execPath, [path.join(jest, 'node_modules/jest/bin/jest.js'), '--ci'], { cwd: jest, env: cleanEnv, stdio: 'inherit' });
  console.log('  Jest: CommonJS, no Node flags; /node reads a workbook and receives an upload');

  // The typings against each major of @types/express, with skipLibCheck off so the package's
  // own .d.ts files are checked too.
  for (const major of [4, 5]) {
    const dir = project(`types-express${major}`, {
      typescript: pkg.devDependencies.typescript,
      '@types/node': pkg.devDependencies['@types/node'],
      '@types/express': `^${major}`,
    });
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          types: ['node'],
        },
        files: ['app.ts'],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'app.ts'),
      `
import express from 'express';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { createImportRouter, sendFailure, type ImportBinding, type ImportRequest } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({ type: 'object', properties: { name: { type: 'string' } } });
const people: ImportBinding = { adapter, ctx: undefined };
const app = express();

// As the README shows: the router goes straight to app.use.
app.use('/import', createImportRouter(express.Router(), { bindings: { people }, onImport: async () => {} }));

// A callback that wants the whole Express request annotates it, and the options take that type.
interface WithTenant extends express.Request {
  tenant?: string;
}
const tenantRouter: express.Router = createImportRouter(express.Router(), {
  bindings: (name: string, request: WithTenant) => (request.tenant && name === 'people' ? people : undefined),
  onImport: (records, { request }) => {
    const tenant: string | undefined = request.tenant;
    void [records, tenant];
  },
  lang: request => String(request.query['lang'] ?? 'en'),
});
app.use('/tenant', tenantRouter);

// The README's form: an intersection, read again in onImport.
declare function saveAll(tenant: string, records: Record<string, unknown>[]): Promise<void>;
app.use(
  '/readme',
  createImportRouter(express.Router(), {
    bindings: (name, request: express.Request & { tenant: string }) => (request.tenant ? people : undefined),
    onImport: async (records, { request }) => saveAll(request.tenant, records),
  }),
);

// An Express response is a response this package can answer on.
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  sendFailure(response, error);
});

// Nothing Express-specific is needed to describe a request.
const contentType = (request: ImportRequest): string | undefined => request.headers['content-type'];
void contentType;
`,
    );
    run(process.execPath, [path.join(dir, 'node_modules/typescript/bin/tsc'), '-p', '.'], { cwd: dir, stdio: 'inherit' });
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules/@types/express/package.json'), 'utf8')).version;
    console.log(`  typings: compile against @types/express@${version} with skipLibCheck off`);
  }

  console.log('Consumer verification passed.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
