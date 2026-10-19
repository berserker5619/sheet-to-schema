#!/usr/bin/env node
/**
 * 2.0 removed the router (docs/2.0-spec.md, D1). Nothing the package ships or documents may
 * mention it again: no source file (code, comment or spec), no published typing, the README and
 * the manifest name neither `createImportRouter` nor `express`. CHANGELOG.md and MIGRATING-2.0.md
 * are where the removal is recorded, and are the only exceptions; docs/ holds dated specs and is
 * not shipped.
 *
 * A self-test plants a mention in each kind of file scanned and requires it to be found, so a
 * scan that silently stopped reading a kind of file fails here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const FORBIDDEN = /createImportRouter|\bexpress\b/i;

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

/** Every file that must not mention the router, by kind. `dist` is checked once built. */
function targets() {
  return {
    source: walk(join(ROOT, 'src'), p => p.endsWith('.ts')),
    typings: walk(join(ROOT, 'dist'), p => p.endsWith('.d.ts') || p.endsWith('.d.mts')),
    readme: [join(ROOT, 'README.md')],
    manifest: [join(ROOT, 'package.json')],
  };
}

/** `[file, line number, line]` for every mention in `files`, read through `read`. */
export function mentions(files, read = file => readFileSync(file, 'utf8')) {
  const found = [];
  for (const file of files) {
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (FORBIDDEN.test(line)) found.push([file, i + 1, line.trim()]);
      });
  }
  return found;
}

const kinds = targets();
if (!kinds.typings.length) {
  console.error('check-removed-api: no typings in dist. Run `npm run build` first.');
  process.exit(1);
}

// Self-test: one planted mention per kind, read from memory, must each be found.
for (const [kind, files] of Object.entries(kinds)) {
  const planted = files[0];
  const found = mentions([planted], () => `// fine\nimport { createImportRouter } from 'sheet-to-schema/node';\nconst app = Express();\n`);
  if (found.length !== 2) {
    console.error(`check-removed-api self-test: a mention planted in ${kind} (${relative(ROOT, planted)}) was not found.`);
    process.exit(1);
  }
}

const found = Object.values(kinds).flatMap(files => mentions(files));
if (found.length) {
  console.error('Removed in 2.0, and mentioned again (only CHANGELOG.md and MIGRATING-2.0.md may):');
  for (const [file, line, text] of found) console.error(`  ${relative(ROOT, file)}:${line}: ${text}`);
  process.exit(1);
}
const counts = Object.entries(kinds).map(([kind, files]) => `${files.length} ${kind}`).join(', ');
console.log(`No mention of createImportRouter or express in ${counts} (self-test: 4 planted mentions found).`);
