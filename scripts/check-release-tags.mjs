#!/usr/bin/env node
/**
 * Dry run of the release workflow's tag selection: runs scripts/release-publish.mjs against a
 * fake npm for v1.x, v2 prereleases and v2 stable, and checks which dist-tags each one publishes
 * under and moves. Also checks that release.yml's publish step runs that script, so the code
 * proven here is the code that publishes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { release } from './release-publish.mjs';

/** A fake npm over a registry of `{ versions, tags }`, recording every call. */
function fakeNpm(registry, version) {
  const calls = [];
  const npm = args => {
    calls.push(args.join(' '));
    const [cmd, target, field] = args;
    if (cmd === 'view' && field === 'version') {
      const v = target.slice(target.lastIndexOf('@') + 1);
      return { ok: registry.versions.includes(v), stdout: v };
    }
    if (cmd === 'view' && field.startsWith('dist-tags.')) {
      const t = registry.tags[field.slice('dist-tags.'.length)];
      return { ok: true, stdout: t ? `${t}\n` : '' };
    }
    if (cmd === 'publish') {
      registry.versions.push(version);
      registry.tags[args[args.indexOf('--tag') + 1]] = version;
      return { ok: true, stdout: '' };
    }
    if (cmd === 'dist-tag' && target === 'add') {
      const [, , spec, tag] = args;
      registry.tags[tag] = spec.slice(spec.lastIndexOf('@') + 1);
      return { ok: true, stdout: '' };
    }
    throw new Error(`fake npm: unexpected call: npm ${args.join(' ')}`);
  };
  return { npm, calls };
}

function run(version, tags, versions = Object.values(tags)) {
  const registry = { versions: [...versions], tags: { ...tags } };
  const { npm, calls } = fakeNpm(registry, version);
  release({ version, npm, log: () => {}, warn: () => {} });
  const published = calls.find(c => c.startsWith('publish '));
  return {
    publishedUnder: published ? /--tag (\S+)/.exec(published)[1] : null,
    moved: calls.filter(c => c.startsWith('dist-tag add')).map(c => c.split(' ').pop()),
    tags: registry.tags,
  };
}

const cases = [
  {
    name: 'v1.3.1 while latest and next are 1.3.0: latest is an older 1.x, so it moves; next does not',
    version: '1.3.1',
    tags: { latest: '1.3.0', next: '1.3.0' },
    expect: { publishedUnder: 'release-1.x', moved: ['latest'], tags: { latest: '1.3.1', next: '1.3.0', 'release-1.x': '1.3.1' } },
  },
  {
    name: 'v1.3.2 while latest is 1.3.1 and next a 2.0 prerelease: latest moves, next stays',
    version: '1.3.2',
    tags: { latest: '1.3.1', next: '2.0.0-rc.1', 'release-1.x': '1.3.1' },
    expect: { publishedUnder: 'release-1.x', moved: ['latest'], tags: { latest: '1.3.2', next: '2.0.0-rc.1', 'release-1.x': '1.3.2' } },
  },
  {
    name: 'v1.3.2 while latest is 2.0.0: latest and next stay',
    version: '1.3.2',
    tags: { latest: '2.0.0', next: '2.0.0', 'release-1.x': '1.3.1' },
    expect: { publishedUnder: 'release-1.x', moved: [], tags: { latest: '2.0.0', next: '2.0.0', 'release-1.x': '1.3.2' } },
  },
  {
    name: 'v1.3.1 while latest is already 1.3.2: not older, so it stays',
    version: '1.3.1',
    tags: { latest: '1.3.2', next: '2.0.0-rc.1' },
    expect: { publishedUnder: 'release-1.x', moved: [], tags: { latest: '1.3.2', next: '2.0.0-rc.1', 'release-1.x': '1.3.1' } },
  },
  {
    name: 'v1.3.1 after 2.0.0 is latest and a 2.1 prerelease is next',
    version: '1.3.1',
    tags: { latest: '2.0.0', next: '2.1.0-rc.1', 'release-1.x': '1.3.0' },
    expect: { publishedUnder: 'release-1.x', moved: [], tags: { latest: '2.0.0', next: '2.1.0-rc.1', 'release-1.x': '1.3.1' } },
  },
  {
    name: 'v2.0.0-rc.1 while latest is 1.3.0',
    version: '2.0.0-rc.1',
    tags: { latest: '1.3.0', next: '1.3.0' },
    expect: { publishedUnder: 'next', moved: [], tags: { latest: '1.3.0', next: '2.0.0-rc.1' } },
  },
  {
    name: 'v2.0.0 after 2.0.0-rc.1',
    version: '2.0.0',
    tags: { latest: '1.3.0', next: '2.0.0-rc.1', 'release-1.x': '1.3.1' },
    expect: { publishedUnder: 'latest', moved: ['next'], tags: { latest: '2.0.0', next: '2.0.0', 'release-1.x': '1.3.1' } },
  },
  {
    name: 'v2.0.0 when next is already a newer prerelease',
    version: '2.0.0',
    tags: { latest: '1.3.0', next: '2.1.0-rc.1' },
    expect: { publishedUnder: 'latest', moved: [], tags: { latest: '2.0.0', next: '2.1.0-rc.1' } },
  },
];

let failed = 0;
for (const c of cases) {
  const got = run(c.version, c.tags);
  try {
    assert.deepEqual(got, c.expect);
    console.log(`ok   v${c.version}: ${c.name} → publish under ${got.publishedUnder}, move [${got.moved.join(', ')}]`);
  } catch (e) {
    failed++;
    console.error(`FAIL v${c.version}: ${c.name}\n${e.message}`);
  }
}

// Already published: nothing is published or moved.
{
  const got = run('2.0.0', { latest: '2.0.0', next: '1.3.0' }, ['1.3.0', '2.0.0']);
  if (got.publishedUnder !== null || got.moved.length) {
    failed++;
    console.error('FAIL an already-published version must be skipped');
  } else console.log('ok   an already-published version is skipped');
}

// The workflow's publish step must run this script and contain no tag logic of its own.
{
  const yml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const step = /- name: Publish sheet-to-schema\n([\s\S]*?)(?=\n {6}- name:|\n*$)/.exec(yml)?.[1] ?? '';
  const problems = [];
  if (!/run: node scripts\/release-publish\.mjs\s*$/m.test(step)) problems.push('does not run node scripts/release-publish.mjs');
  if (/npm (publish|dist-tag)/.test(step)) problems.push('calls npm publish or npm dist-tag itself');
  if (/npm (publish|dist-tag)/.test(yml.replace(/npm publish --dry-run|npm pack --dry-run/g, ''))) {
    problems.push('publishes or moves dist-tags outside the publish step');
  }
  if (problems.length) {
    failed++;
    console.error(`FAIL release.yml's publish step ${problems.join('; ')}`);
  } else console.log('ok   release.yml publishes through scripts/release-publish.mjs only');
}

if (failed) {
  console.error(`\n${failed} release tag check(s) failed.`);
  process.exit(1);
}
