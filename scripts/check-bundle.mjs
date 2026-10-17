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
 * - `/node` carries no copy of the main entry.
 * - No published typings import `express` or `@types/express`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import ts from 'typescript';

const DIST = join(process.cwd(), 'dist');
const PEERS = ['exceljs', 'busboy', 'express'];
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const isPeer = s => PEERS.some(peer => s === peer || s.startsWith(`${peer}/`));

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

const problems = [];
const report = [];

for (const name of ['index.js', 'index.mjs']) {
  const file = join(DIST, name);
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
  const file = join(DIST, name);
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
  if (/class ImportFailure\b/.test(text)) {
    problems.push(`the /node entry (${name}) carries its own copy of ImportFailure. Import the main entry as "sheet-to-schema".`);
  }
  const summary = loads.map(l => (isPeer(l.specifier) ? `${l.specifier} via ${l.how}${l.lazy ? ', lazy' : ''}` : l.specifier));
  report.push(`${name}: ${[...new Set(summary)].sort().join(', ') || 'no imports'}`);
}

const typings = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.d\.m?ts$/.test(entry.name)) typings.push(full);
  }
};
if (existsSync(DIST)) walk(DIST);
for (const file of typings) {
  const text = readFileSync(file, 'utf8');
  if (/(?:from|import\(|require\()\s*['"](?:express|@types\/express)(?:\/[^'"]*)?['"]/.test(text) || /reference types=["']express/.test(text)) {
    problems.push(`${relative(process.cwd(), file)} refers to express types. The published typings must stand without @types/express.`);
  }
}
report.push(`${typings.length} typings free of express`);

if (problems.length) {
  console.error('Bundle check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Bundle check passed (${report.join('; ')}).`);
