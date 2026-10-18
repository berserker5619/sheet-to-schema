#!/usr/bin/env node
/**
 * Hold the built entries to their boundaries, by parsing them rather than matching text: a
 * pattern cannot tell `require` at module scope from `require` inside a function, and missed
 * esbuild's `__require` shim entirely.
 *
 * - Main entry (`index.js`, `index.mjs`): imports nothing at all. It runs in a browser and has
 *   no runtime dependencies.
 * - `/node`: Node built-ins, the main entry by name, and the optional peers. A peer is only
 *   ever loaded inside the function that needs it, never at module scope, so a consumer
 *   without it can still read a CSV. In the CommonJS build it is loaded with `require` (or
 *   esbuild's `__require`), and there is no `import()` at all: Jest's module sandbox cannot run
 *   one without --experimental-vm-modules. In the ESM build it is loaded with `import()`.
 * - `/node` carries no copy of the main entry: no class of its own named `ImportFailure` or
 *   `ImportError`. Nor does `/browser`.
 * - `/browser`: the main entry by name, and `exceljs` only inside the function that reads a
 *   workbook (`require` in CommonJS, `import()` in ESM). No Node built-ins, no other peer, and
 *   no copy of the main entry.
 * - A CSV-only app bundled for a browser from `/browser` (esbuild, code splitting on) carries no
 *   ExcelJS in the code it loads up front: ExcelJS is a separate chunk, fetched on first workbook.
 * - A CSV-only app bundled from the main entry's `readCsvFile` builds where `exceljs` cannot be
 *   resolved at all, as in an app that never installed it (1.1.1): nothing in its module graph
 *   asks for `exceljs` or reaches `/browser`. Angular's `ng build` and webpack fail on `/browser`
 *   there (Dynamic Entity docs/3.1-spec.md, Step 0).
 * - No published typings import `express` or `@types/express`.
 *
 * `scripts/check-bundle-selftest.mjs` proves each rule by planting a violation in a copy of
 * `dist` and requiring this check to name it. `CHECK_BUNDLE_DIST` points this at that copy.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import ts from 'typescript';

const ROOT = process.cwd();
const PEERS = ['exceljs', 'busboy', 'express'];
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
/** Classes only the main entry defines; `/node` and `/browser` import them by name. ImportError since 1.1.1. */
const ENGINE_CLASSES = [
  { name: 'ImportFailure', pattern: /class ImportFailure\b/ },
  { name: 'ImportError', pattern: /class ImportError\b/ },
];
const isPeer =s => PEERS.some(peer => s === peer || s.startsWith(`${peer}/`));

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function insideFunction(node) {
  for (let at = node.parent; at; at = at.parent) if (FUNCTION_KINDS.has(at.kind)) return true;
  return false;
}

/** Every module this file loads, how, and whether at module scope. */
function loadsOf(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const loads = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      loads.push({ specifier: node.moduleSpecifier.text, how: 'static import', lazy: false });
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      const specifier = node.arguments[0].text;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        loads.push({ specifier, how: 'import()', lazy: insideFunction(node) });
      } else if (ts.isIdentifier(node.expression) && ['require', '__require'].includes(node.expression.text)) {
        loads.push({ specifier, how: `${node.expression.text}()`, lazy: insideFunction(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { text, loads };
}

/** Every problem with the built entries in `dist`, and a one-line report of what each loads. */
export async function checkBundle(dist) {
  const problems = [];
  const report = [];

  for (const name of ['index.js', 'index.mjs']) {
    const file = join(dist, name);
    if (!existsSync(file)) {
      problems.push(`${name} is missing: run build first.`);
      continue;
    }
    const { loads } = loadsOf(file);
    for (const load of loads) {
      const why = BUILTINS.has(load.specifier) || isPeer(load.specifier) ? 'It must run in a browser.' : 'It must have zero runtime dependencies.';
      problems.push(`the main entry (${name}) loads "${load.specifier}" with ${load.how}. ${why}`);
    }
    report.push(`${name}: ${loads.length} imports`);
  }

  for (const [name, format] of [['node/index.js', 'cjs'], ['node/index.mjs', 'esm']]) {
    const file = join(dist, name);
    if (!existsSync(file)) {
      problems.push(`${name} is missing: run build first.`);
      continue;
    }
    const { text, loads } = loadsOf(file);
    for (const load of loads) {
      const { specifier, how, lazy } = load;
      if (format === 'cjs' && how === 'import()') {
        problems.push(`the CommonJS /node entry (${name}) has import("${specifier}"). Jest cannot run a dynamic import in CommonJS; load it with require.`);
        continue;
      }
      if (isPeer(specifier)) {
        const expected = format === 'cjs' ? ['require()', '__require()'] : ['import()'];
        if (!lazy) problems.push(`the /node entry (${name}) loads the optional peer "${specifier}" at module scope (${how}). Load it inside the function that needs it.`);
        else if (!expected.includes(how)) problems.push(`the /node entry (${name}) loads the optional peer "${specifier}" with ${how}; the ${format} build should use ${expected.join(' or ')}.`);
      } else if (!BUILTINS.has(specifier) && specifier !== 'sheet-to-schema') {
        problems.push(`the /node entry (${name}) loads "${specifier}", which is neither Node, an optional peer, nor the main entry.`);
      }
    }
    for (const engine of ENGINE_CLASSES) {
      if (engine.pattern.test(text)) problems.push(`the /node entry (${name}) carries its own copy of ${engine.name}. Import the main entry as "sheet-to-schema".`);
    }
    const summary = loads.map(l => (isPeer(l.specifier) ? `${l.specifier} via ${l.how}${l.lazy ? ', lazy' : ''}` : l.specifier));
    report.push(`${name}: ${[...new Set(summary)].sort().join(', ') || 'no imports'}`);
  }

  for (const [name, format] of [['browser/index.js', 'cjs'], ['browser/index.mjs', 'esm']]) {
    const file = join(dist, name);
    if (!existsSync(file)) {
      problems.push(`${name} is missing: run build first.`);
      continue;
    }
    const { text, loads } = loadsOf(file);
    for (const { specifier, how, lazy } of loads) {
      if (BUILTINS.has(specifier)) {
        problems.push(`the /browser entry (${name}) loads the Node built-in "${specifier}". It must run in a browser.`);
      } else if (specifier === 'exceljs') {
        const expected = format === 'cjs' ? ['require()', '__require()'] : ['import()'];
        if (!lazy) problems.push(`the /browser entry (${name}) loads "exceljs" at module scope (${how}). A CSV-only app must never download it: load it inside the function that reads a workbook.`);
        else if (!expected.includes(how)) problems.push(`the /browser entry (${name}) loads "exceljs" with ${how}; the ${format} build should use ${expected.join(' or ')}.`);
      } else if (specifier !== 'sheet-to-schema') {
        problems.push(`the /browser entry (${name}) loads "${specifier}", which is neither exceljs nor the main entry.`);
      }
    }
    for (const engine of ENGINE_CLASSES) {
      if (engine.pattern.test(text)) problems.push(`the /browser entry (${name}) carries its own copy of ${engine.name}. Import the main entry as "sheet-to-schema".`);
    }
    const summary = loads.map(l => (l.specifier === 'exceljs' ? `exceljs via ${l.how}${l.lazy ? ', lazy' : ''}` : l.specifier));
    report.push(`${name}: ${[...new Set(summary)].sort().join(', ') || 'no imports'}`);
  }

  if (existsSync(join(dist, 'browser/index.mjs')) && existsSync(join(dist, 'index.mjs'))) {
    report.push(await checkCsvOnlyBundle(dist, problems));
  }
  if (existsSync(join(dist, 'index.mjs'))) report.push(await checkReadCsvFileBundle(dist, problems));

  const typings = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.d\.m?ts$/.test(entry.name)) typings.push(full);
    }
  };
  if (existsSync(dist)) walk(dist);
  for (const file of typings) {
    const text = readFileSync(file, 'utf8');
    if (/(?:from|import\(|require\()\s*['"](?:express|@types\/express)(?:\/[^'"]*)?['"]/.test(text) || /reference types=["']express/.test(text)) {
      problems.push(`${relative(ROOT, file)} refers to express types. The published typings must stand without @types/express.`);
    }
  }
  report.push(`${typings.length} typings free of express`);

  return { problems, report };
}

/**
 * Bundle a CSV-only browser app from `/browser`, as a consumer's bundler would (esbuild,
 * `platform: 'browser'`, so `exceljs` resolves to its browser build), and check that the code it
 * loads up front holds no ExcelJS. ExcelJS must be in a chunk of its own, or the check proves
 * nothing.
 */
async function checkCsvOnlyBundle(dist, problems) {
  const work = mkdtempSync(join(tmpdir(), 's2s-csv-bundle-'));
  try {
    const entry = join(work, 'app.mjs');
    writeFileSync(entry, "import { readSheetFile } from 'sheet-to-schema/browser';\nexport const read = file => readSheetFile(file, { filename: file.name });\n");
    let result;
    try {
      result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        splitting: true,
        format: 'esm',
        platform: 'browser',
        outdir: join(work, 'out'),
        write: false,
        metafile: true,
        logLevel: 'silent',
        alias: { 'sheet-to-schema/browser': join(dist, 'browser/index.mjs'), 'sheet-to-schema': join(dist, 'index.mjs') },
        nodePaths: [join(ROOT, 'node_modules')],
      });
    } catch (error) {
      const why = (error.errors ?? []).map(e => e.text).join('; ') || error.message;
      problems.push(`a CSV-only browser app does not bundle from /browser: ${why}`);
      return 'CSV-only browser bundle: failed';
    }
    const byPath = result.metafile.outputs;
    const outputs = Object.values(byPath);
    const isExcel = input => /node_modules[\\/]exceljs[\\/]/.test(input);
    const startPath = Object.keys(byPath).find(path => byPath[path].entryPoint);
    // Up front is the entry and every chunk it imports statically, transitively: with splitting,
    // a module both halves use lands in a shared chunk the entry loads before anything runs.
    const loaded = new Set();
    const pending = startPath ? [startPath] : [];
    while (pending.length) {
      const path = pending.pop();
      if (loaded.has(path) || !byPath[path]) continue;
      loaded.add(path);
      for (const { path: next, kind } of byPath[path].imports) if (kind === 'import-statement') pending.push(next);
    }
    const upFront = [...loaded].flatMap(path => Object.keys(byPath[path].inputs)).filter(isExcel);
    const anywhere = outputs.some(output => Object.keys(output.inputs).some(isExcel));
    const start = startPath ? { bytes: [...loaded].reduce((sum, path) => sum + byPath[path].bytes, 0) } : undefined;
    if (upFront.length) {
      problems.push(`a CSV-only browser app bundled from /browser carries ExcelJS in the code it loads up front (${upFront[0]}). It must be a chunk fetched on the first workbook.`);
    } else if (!anywhere) {
      problems.push('a CSV-only browser app bundled from /browser has no ExcelJS chunk at all, so this check proves nothing: the workbook path is not reachable.');
    }
    return `CSV-only browser bundle: ${((start?.bytes ?? 0) / 1024).toFixed(1)} KB up front, ExcelJS in a lazy chunk`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Bundle a CSV-only browser app from the main entry's `readCsvFile` with `exceljs` made
 * unresolvable, as it is in an app that never installed it. The build must succeed: anything in
 * its module graph that asks for `exceljs`, `/browser` included, fails it.
 */
async function checkReadCsvFileBundle(dist, problems) {
  const work = mkdtempSync(join(tmpdir(), 's2s-csv-main-bundle-'));
  const notInstalled = {
    name: 'exceljs-not-installed',
    setup(build) {
      build.onResolve({ filter: /^exceljs(?:\/|$)/ }, args => ({ errors: [{ text: `Could not resolve "${args.path}" (exceljs is not installed)` }] }));
    },
  };
  try {
    const entry = join(work, 'app.mjs');
    writeFileSync(entry, "import { readCsvFile } from 'sheet-to-schema';\nexport const read = file => readCsvFile(file, { filename: file.name });\n");
    let result;
    try {
      result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        splitting: true,
        format: 'esm',
        platform: 'browser',
        outdir: join(work, 'out'),
        write: false,
        metafile: true,
        logLevel: 'silent',
        plugins: [notInstalled],
        alias: { 'sheet-to-schema': join(dist, 'index.mjs') },
      });
    } catch (error) {
      const why = (error.errors ?? []).map(e => e.text).join('; ') || error.message;
      problems.push(`a CSV-only app bundled from the main entry's readCsvFile does not build without exceljs: ${why}`);
      return 'readCsvFile bundle without exceljs: failed';
    }
    const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
    return `readCsvFile bundle without exceljs: ${(bytes / 1024).toFixed(1)} KB, ${Object.keys(result.metafile.outputs).length} file(s)`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, report } = await checkBundle(process.env.CHECK_BUNDLE_DIST ?? join(ROOT, 'dist'));
  if (problems.length) {
    console.error('Bundle check failed:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Bundle check passed (${report.join('; ')}).`);
}
