#!/usr/bin/env node
/**
 * Prove each rule of `check-bundle.mjs` by breaking it: copy `dist`, plant one violation, and
 * require the check to name it. A rule that a planted violation does not trip is a rule that
 * guards nothing, and passes forever.
 *
 * Run after `check-bundle.mjs` on a clean build, by `npm run check:bundle`.
 */
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle } from './check-bundle.mjs';

const DIST = join(process.cwd(), 'dist');

const prepend = (file, text) => dist => writeFileSync(join(dist, file), text + readFileSync(join(dist, file), 'utf8'));
const append = (file, text) => dist => appendFileSync(join(dist, file), text);
const replace = (file, from, to) => dist => {
  const before = readFileSync(join(dist, file), 'utf8');
  if (!before.includes(from)) throw new Error(`self-test: ${file} has no ${from} to replace; the plant is stale`);
  writeFileSync(join(dist, file), before.split(from).join(to));
};

/** [what is broken, how to break it, what the check must say]. */
const PLANTS = [
  ['the main entry imports a Node built-in', prepend('index.mjs', 'import "node:fs";\n'), /the main entry \(index\.mjs\) loads "node:fs"/],
  ['the main entry requires a package', prepend('index.js', 'require("left-pad");\n'), /the main entry \(index\.js\) loads "left-pad".*zero runtime dependencies/],
  ['/node loads a peer at module scope', prepend('node/index.mjs', 'import "busboy";\n'), /\/node entry \(node\/index\.mjs\) loads the optional peer "busboy" at module scope/],
  ['/node carries a copy of the engine', append('node/index.mjs', '\nclass ImportFailure {}\n'), /\/node entry \(node\/index\.mjs\) carries its own copy of ImportFailure/],
  ['/browser imports exceljs statically', prepend('browser/index.mjs', 'import "exceljs";\n'), /\/browser entry \(browser\/index\.mjs\) loads "exceljs" at module scope/],
  ['/browser requires exceljs at module scope (CommonJS)', prepend('browser/index.js', 'require("exceljs");\n'), /\/browser entry \(browser\/index\.js\) loads "exceljs" at module scope/],
  ['/browser imports a Node built-in', prepend('browser/index.mjs', 'import "node:fs";\n'), /\/browser entry \(browser\/index\.mjs\) loads the Node built-in "node:fs"/],
  ['/browser loads another package', prepend('browser/index.mjs', 'import "busboy";\n'), /\/browser entry \(browser\/index\.mjs\) loads "busboy", which is neither exceljs nor the main entry/],
  ['/browser carries a copy of the engine', append('browser/index.mjs', '\nclass ImportFailure {}\n'), /\/browser entry \(browser\/index\.mjs\) carries its own copy of ImportFailure/],
  ['a CSV-only app downloads ExcelJS up front', prepend('browser/index.mjs', 'import "exceljs";\n'), /CSV-only browser app bundled from \/browser carries ExcelJS in the code it loads up front/],
  ['a CSV-only app cannot bundle for a browser', prepend('browser/index.mjs', 'import "node:fs";\n'), /CSV-only browser app does not bundle from \/browser/],
  ['the workbook path is not reachable, so the CSV check would prove nothing', replace('browser/index.mjs', "import('exceljs')", 'Promise.resolve({})'), /has no ExcelJS chunk at all/],
  ['published typings refer to express', append('browser/index.d.ts', '\nimport type { Router } from "express";\n'), /browser[\\/]index\.d\.ts refers to express types/],
];

const clean = await checkBundle(DIST);
if (clean.problems.length) {
  console.error('Bundle self-test: the unmodified build already fails the check; run check-bundle.mjs first.');
  process.exit(1);
}

const failures = [];
for (const [what, plant, expected] of PLANTS) {
  const copy = mkdtempSync(join(tmpdir(), 's2s-bundle-plant-'));
  try {
    cpSync(DIST, copy, { recursive: true });
    plant(copy);
    const { problems } = await checkBundle(copy);
    if (!problems.some(problem => expected.test(problem))) {
      failures.push(`${what}: not caught. The check said: ${problems.length ? problems.join(' | ') : 'nothing'}`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('Bundle self-test failed: a planted violation went unnoticed.\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Bundle self-test passed: ${PLANTS.length} planted violations, each caught.`);
