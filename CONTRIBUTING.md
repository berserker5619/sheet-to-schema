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
- `npm run lint` (TypeScript compile + ESLint + control characters check + no relative links in the published README)
- `npm run build` (tsup compile to CJS/ESM + DTS)
- `npm run check:bundle` (verifies entry point boundaries)
- `npm run check:package` (manifest and version parity)
- `npm run test` (Jest unit and acceptance tests)
- `npm run test:coverage` (enforces coverage thresholds)
- `npm run check:timezones` (tests dates in 6 distinct UTC offsets)
- `npm run check:consumer` (packs and installs tarball in scratch app)
- `npm run check:browser-runtime` (reads a CSV and a workbook through `/browser` on this Node;
  CI also runs it on Node 20.11 with `--expect-unsupported`)

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
