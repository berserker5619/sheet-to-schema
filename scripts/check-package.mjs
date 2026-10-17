#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const versionTs = readFileSync(join(ROOT, 'src/version.ts'), 'utf8');

const problems = [];
const EXPECTED_REPO = 'git+https://github.com/berserker5619/sheet-to-schema.git';

if (pkg.repository?.url !== EXPECTED_REPO) {
  problems.push(`repository.url must be "${EXPECTED_REPO}", was "${pkg.repository?.url}"`);
}
if (pkg.repository?.directory) {
  problems.push(`repository.directory must not be set for standalone repository, was "${pkg.repository.directory}"`);
}

const match = /export const IMPORTER_VERSION = '([^']+)';/.exec(versionTs);
if (!match || match[1] !== pkg.version) {
  problems.push(`src/version.ts IMPORTER_VERSION ("${match?.[1]}") does not match package.json version ("${pkg.version}")`);
}

if (pkg.engines?.node !== '>=20') {
  problems.push(`engines.node must be ">=20", was "${pkg.engines?.node}"`);
}

for (const exp of ['.', './node']) {
  const entry = pkg.exports[exp];
  for (const [key, rel] of Object.entries(entry)) {
    if (!existsSync(join(ROOT, rel))) {
      problems.push(`exports["${exp}"].${key} points to missing file "${rel}"`);
    }
  }
}

if (problems.length) {
  console.error('Package validation failed:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Package validation passed.');
