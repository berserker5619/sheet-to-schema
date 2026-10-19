# Contributing to sheet-to-schema

Thanks for contributing!

## Development setup

1. Clone the repository:
   ```bash
   git clone https://github.com/berserker5619/sheet-to-schema.git
   cd sheet-to-schema
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Build the package:
   ```bash
   npm run build
   ```
4. Run the test suite:
   ```bash
   npm test
   ```

## Verification gates

Before submitting a pull request, ensure all gates pass:
- `npm run lint` (TypeScript compile + ESLint + control characters check + no relative links in the published README + the release dist-tag dry run)
- `npm run build` (tsup compile to CJS/ESM + DTS)
- `npm run check:bundle` (verifies entry point boundaries)
- `npm run check:package` (manifest and version parity)
- `npm run test` (Jest unit and acceptance tests)
- `npm run test:coverage` (enforces coverage thresholds)
- `npm run check:timezones` (tests dates in 6 distinct UTC offsets)
- `npm run check:consumer` (packs and installs tarball in scratch app)
- `npm run check:browser-runtime` (reads a CSV and a workbook through `/browser` on this Node;
  CI also runs it on Node 20.11 with `--expect-unsupported`)
- `npm run check:browsers` (the built package in Chromium, Firefox and WebKit: `readCsvFile`
  with `exceljs` not installed, and `/browser` with it external, stubbed, installed, and with its
  chunk failing to download; needs `npx playwright install chromium firefox webkit` once)

## Releases and dist-tags

A `v*` tag runs `.github/workflows/release.yml` from the tagged commit, and
`scripts/release-publish.mjs` chooses the dist-tag from the version:

| Tag | Published under | Also moves |
| --- | --- | --- |
| `v1.*` (from the `1.x` branch) | `release-1.x` | nothing; `latest` and `next` belong to 2.x |
| `v2+` prerelease, e.g. `v2.0.0-rc.1` | `next` | `latest`, only if it is itself a prerelease |
| `v2+` stable, e.g. `v2.0.0` | `latest` | `next`, if it points at an older version |

`npm run check:release` (part of `npm run lint`) proves this against a fake registry.

### Cutting a 1.x patch

1.x is maintained for Dynamic Entity 3.x on the `1.x` branch, cut from `v1.3.0`.

1. Branch from `1.x` (`git switch -c fix/1.3.1 origin/1.x`) and make the fix there, with a
   test. If the same bug exists in 2.x, fix it on `main` separately; the lines do not merge.
2. Bump the version (`npm version 1.3.1 --no-git-tag-version`) and add a `1.3.1` section to
   `CHANGELOG.md` on the `1.x` branch.
3. Run every gate above, then merge to `1.x` through a pull request and wait for CI to pass.
4. Tag the merge commit on `1.x` (`git tag v1.3.1 && git push origin v1.3.1`). The release
   publishes it under `release-1.x`; check with `npm view sheet-to-schema dist-tags` that
   `latest` and `next` did not move.

Users of 1.x install it with `npm install sheet-to-schema@release-1.x` or a `^1.3.0` range.

## Working with Dynamic Entity

Dynamic Entity depends on this package from npm, and its daily drift workflow tests it against
`sheet-to-schema@latest` and `@next`. To run the same check against a local change before it is
published:

```bash
npm run build && npm pack
# In a Dynamic Entity checkout, pin the tarball for every workspace, then run its suites:
npm pkg set overrides.sheet-to-schema=file:/path/to/sheet-to-schema-<version>.tgz
npm install
npm ls sheet-to-schema   # must show a single version
npm test
```

Don't commit those changes to Dynamic Entity.
