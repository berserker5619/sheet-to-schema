#!/usr/bin/env node
/**
 * The release workflow's publish step: `node scripts/release-publish.mjs` publishes the version in
 * package.json and moves dist-tags. Kept here rather than inline in release.yml so that
 * scripts/check-release-tags.mjs can run the same code against a fake npm.
 *
 * - 1.x (`v1.*` tags, cut from the `1.x` branch): published under `release-1.x`. `latest` moves to
 *   it only while `latest` is itself an older 1.x (until 2.0.0 is stable, a 1.x patch is what a
 *   plain `npm install` should get); once `latest` is 2.x it is left alone. `next` never moves.
 * - 2.x and later, prerelease: published under `next`. `latest` is advanced only when it is
 *   itself a prerelease.
 * - 2.x and later, stable: published under `latest`; `next` is advanced when it points at an
 *   older version, so `npm install sheet-to-schema@next` never installs something older.
 * - A version already on the registry is skipped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compare } from './semver-lt.mjs';

const NAME = 'sheet-to-schema';
export const LEGACY_TAG = 'release-1.x';

/** Which dist-tag a version is published under. */
export function publishTag(version) {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  if (!Number.isInteger(major)) throw new Error(`not a semantic version: "${version}"`);
  if (major <= 1) return LEGACY_TAG;
  return version.includes('-') ? 'next' : 'latest';
}

/**
 * Publishes `version` through `npm`, a function taking npm's arguments and returning
 * `{ ok, stdout }`. `log` and `warn` receive the workflow's messages.
 */
export function release({ version, npm, log = console.log, warn = m => console.log(`::warning::${m}`) }) {
  if (npm(['view', `${NAME}@${version}`, 'version']).ok) {
    log(`${NAME}@${version} is already published — skipping.`);
    return;
  }
  const tag = publishTag(version);
  const published = npm(['publish', '--access', 'public', '--tag', tag, '--provenance', '--loglevel', 'verbose']);
  if (!published.ok) throw new Error(`npm publish failed for ${NAME}@${version}`);
  log(`Published ${NAME}@${version} under ${tag}.`);

  const current = t => {
    const r = npm(['view', NAME, `dist-tags.${t}`]);
    return r.ok ? r.stdout.trim() : '';
  };
  const move = t => {
    log(`Advancing ${t} to ${version}.`);
    if (!npm(['dist-tag', 'add', `${NAME}@${version}`, t]).ok) {
      warn(`Could not update '${t}' dist-tag via trusted publishing (OIDC token may lack dist-tag permissions).`);
      warn(`To update manually, run: npm dist-tag add ${NAME}@${version} ${t}`);
    }
  };

  if (tag === LEGACY_TAG) {
    const latest = current('latest');
    const major = Number(/^v?(\d+)\./.exec(latest)?.[1]);
    if (major === 1 && compare(latest, version) < 0) move('latest');
    else log(`A 1.x release: latest (${latest || 'none'}) is not an older 1.x, so latest and next are left alone.`);
  } else if (tag === 'next') {
    const latest = current('latest');
    if (latest.includes('-')) move('latest');
    else log(`latest (${latest || 'none'}) is stable — leaving it.`);
  } else {
    const next = current('next');
    if (next && compare(next, version) < 0) move('next');
    else log(`next (${next || 'none'}) is not older than ${version} — leaving it.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  // `npm view` output is read; everything else streams to the job log.
  const npm = args => {
    const stdio = ['ignore', args[0] === 'view' ? 'pipe' : 'inherit', 'inherit'];
    try {
      return { ok: true, stdout: execFileSync('npm', args, { encoding: 'utf8', stdio }) ?? '' };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
  release({ version, npm });
}
