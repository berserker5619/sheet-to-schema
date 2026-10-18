# 1.1 release-candidate round

The scripts behind "Round 1" in [`docs/1.1-rc-feedback.md`](../../docs/1.1-rc-feedback.md), run
against `sheet-to-schema@next` as published on npm, never this repository's source. Nothing here
is a workspace, nothing here is published, no CI job runs it, and lint skips it. It is kept so
the round can be repeated against a later version: change what the projects install, rerun,
compare.

Every project lives in a scratch directory outside the repository, beside a `fixtures/` folder,
so npm resolves the package as a user's install would. Node 20.12 or later; the round ran on
Node 24. `VERSION` below is what is being tested (`next`, or an exact version).

## Set up

```bash
W=/path/to/scratch && mkdir -p $W/fixtures $W/ref && cd $W
F=/path/to/sheet-to-schema/test/fixtures
cp $F/real-world/*.xlsx $F/real-world/*.csv $F/parity/*.xlsx $F/parity/*.csv $F/parity/*.tsv fixtures/
cp $F/order/sample.csv fixtures/order.csv && cp $F/order/schema.json fixtures/order-schema.json
cd ref && npm init -y && npm install sheet-to-schema@$VERSION exceljs
cp /path/to/test-harness/1.1-rc2/reference.mjs . && node reference.mjs
```

`reference.mjs` writes `ref/expected.json` (what the server's `readSheet` reads from each
fixture) and `fixtures/order.xlsx` (the order fixture as a workbook).

## a, b. Browsers and bundles

```bash
mkdir $W/browser-app && cd $W/browser-app
cp -r /path/to/test-harness/1.1-rc2/a-browser/* .
mkdir -p public/fixtures && cp ../fixtures/* public/fixtures/ && rm public/fixtures/order*
npm init -y && npm pkg set type=module
npm install sheet-to-schema@$VERSION exceljs vite playwright webpack webpack-cli esbuild
npx playwright install chromium firefox webkit

npx vite build                                         # dist/
npx webpack --config webpack.config.cjs               # dist-webpack/
npx esbuild src/main.js --bundle --splitting --format=esm --platform=browser --minify --outdir=dist-esbuild
# webpack and esbuild need an index.html and the fixtures in their output folder:
#   <script src="/main.js"></script> (webpack), <script type="module" src="/main.js"></script> (esbuild)

node run-browsers.mjs dist vite                        # all three browsers
TZID=Pacific/Kiritimati node run-browsers.mjs dist vite-kiritimati
node run-browsers.mjs dist-webpack webpack chromium
node run-browsers.mjs dist-esbuild esbuild chromium
```

Each run prints the checks passed per browser and the scripts requested at load, after every
CSV, and after the workbooks; `report-<label>.json` has the detail. For bundle sizes, look for
`Worksheet name already exists` (a string only ExcelJS contains) in each output chunk.

`old-node.mjs`, run from `ref/` under an older Node (`npx -p node@20.11.0 node old-node.mjs`),
reads a CSV and a workbook through `/browser` (R1-1).

## c. Server

For each of `express@4` and `express@5`, a project with `sheet-to-schema@$VERSION exceljs busboy
express@N`, containing `check.cjs` and `check.mjs`. Both are `c-server/server-checks.body.js`
with the imports for their module system put in front (see either file); run `node check.cjs &&
node check.mjs`.

## d. Jest

A project with `sheet-to-schema@$VERSION exceljs busboy express@5 jest@30` and
`d-jest/router.test.js`; run `env -u NODE_OPTIONS node node_modules/jest/bin/jest.js --ci`.

## e. Typings

For each of `@types/express` 4, 5 and none: a project with `"type": "module"`,
`sheet-to-schema@$VERSION typescript@~5.9.3 @types/node@20` (and `express@N @types/express@N`),
and the files from `e-typings/` (`typed-express.mts` only with express). Compile with each of
`--module nodenext --moduleResolution nodenext` and `--module esnext --moduleResolution bundler`:

```bash
npx tsc --noEmit --strict --skipLibCheck false --target ES2022 --lib ES2022,DOM --esModuleInterop --types node typed-common.mts [typed-express.mts]
```
