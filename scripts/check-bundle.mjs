#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const NODE_ONLY = ['exceljs', 'busboy', 'express'];
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const found = new Set();
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
  ]) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return { text, specifiers: [...found] };
}

const problems = [];
const report = [];

// Main entry: browser safe, zero runtime dependencies
for (const name of ['index.js', 'index.mjs']) {
  const file = join(DIST, name);
  if (!existsSync(file)) {
    problems.push(`${name} is missing: run build first.`);
    continue;
  }
  const { specifiers } = importsOf(file);
  const forbidden = specifiers.filter(s => BUILTINS.has(s) || NODE_ONLY.some(lib => s === lib || s.startsWith(`${lib}/`)));
  for (const specifier of forbidden) problems.push(`the main entry (${name}) imports "${specifier}". It must run in a browser.`);
  for (const specifier of specifiers.filter(s => !forbidden.includes(s))) {
    problems.push(`the main entry (${name}) imports "${specifier}". It must have zero runtime dependencies.`);
  }
  report.push(`${name}: ${specifiers.length} imports`);
}

// /node entry: Node built-ins, optional peers, and main entry by name only
for (const name of ['node/index.js', 'node/index.mjs']) {
  const file = join(DIST, name);
  if (!existsSync(file)) {
    problems.push(`${name} is missing: run build first.`);
    continue;
  }
  const { text, specifiers } = importsOf(file);
  const allowed = s => BUILTINS.has(s) || s === 'sheet-to-schema' || NODE_ONLY.some(lib => s === lib || s.startsWith(`${lib}/`));
  for (const specifier of specifiers.filter(s => !allowed(s))) {
    problems.push(`the /node entry (${name}) imports "${specifier}", which is neither Node, an optional peer, nor the main entry.`);
  }
  if (name.endsWith('.mjs')) {
    for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (NODE_ONLY.some(lib => match[1] === lib || match[1].startsWith(`${lib}/`))) {
        problems.push(`the /node entry (${name}) statically imports "${match[1]}". Optional peers must be loaded with loadOptional.`);
      }
    }
  }
  if (/class ImportFailure\b/.test(text)) {
    problems.push(`the /node entry (${name}) carries its own copy of ImportFailure. Import the main entry as "sheet-to-schema".`);
  }
  report.push(`${name}: ${specifiers.sort().join(', ') || 'no imports'}`);
}

if (problems.length) {
  console.error('Bundle check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Bundle check passed (${report.join('; ')}).`);
