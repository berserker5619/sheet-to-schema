# 2.0 release-candidate round 1

The scripts behind Round 1 in [`docs/2.0-rc-feedback.md`](../../docs/2.0-rc-feedback.md), run against
`sheet-to-schema@next` as published on npm, never this repository's source. As with
[`1.1-rc2`](../1.1-rc2/README.md), nothing here is a workspace, published, or run by CI, and lint
skips it. Every project lives in a scratch directory outside the repository.

## Set up

Do the 1.1 harness's "Set up" (fixtures and `ref/`, with `VERSION=next`). Then, in `$W`:

```bash
cp /path/to/test-harness/2.0-rc1/drive.mjs /path/to/test-harness/2.0-rc1/serve-and-drive.sh .
```

## a. MIGRATING-2.0's Express example, verbatim, on Express 4 and 5

```bash
git -C /path/to/sheet-to-schema show v2.0.0-rc.1:MIGRATING-2.0.md | tr -d '\r' \
  | awk '/compiled: express-example/{f=1;next} f&&/^```ts/{c=1;next} c&&/^```/{exit} c{print}' > express-example.ts
for v in 4 5; do
  mkdir a-express$v && cd a-express$v && npm init -y && npm pkg set type=module
  npm install sheet-to-schema@next busboy exceljs express@$v @types/express@$v typescript @types/node@20 esbuild
  cp ../express-example.ts app.ts                    # tsc strict, skipLibCheck off and on: 0 errors
  npx esbuild app.ts --format=esm --platform=node --outfile=app.mjs
  bash ../serve-and-drive.sh . app.mjs 380$v /import/people express$v && cd ..
done
```

`drive.mjs` posts preview, validate and import with a CSV and an `.xlsx`, then a bad plan, no
plan, a PNG named `.csv`, and no file.

## b. The same routes on plain node:http

`b-http/server.mjs`, installed with `sheet-to-schema@next busboy exceljs`, driven the same way.

## c. The polling recipe

The recipe from the README at the tag, saved as `polling.verbatim.ts`; `polling.ts` is that with
one line changed: the stub `upsertOrders` body calls `globalThis.__onBatch`, so the harness can
watch and slow batches. Build it with esbuild to `polling.mjs`, then `node run.mjs`. The recipe's
hourly sweep is run every 300 ms (and 200 ms in the restarted process) by patching `setInterval`
before the module loads, and the crashed upload is aged with `utimes`.

## d. Grouping by default

`d-grouping/run.mjs`, from `$W/d-grouping`, reads `../fixtures/order.*`; `roundtrip.mjs` (rc.2) sends the preview's suggestion back unchanged.

## e. Binary files

`e-binary/run.mjs` over `files/`: a PNG from `C:\Windows\SystemApps` renamed `.csv`, a JPEG
wallpaper renamed `.xlsx`, W3C's `dummy.pdf`, and a zip of a CSV made by `Compress-Archive`.

## f. Modules and typings

`f-modules`: `node cjs.cjs`, `node esm.mjs`, `NODE_OPTIONS= npx jest --ci`, and `tsc` over
`typed.mts`, `removed.mts` (and `cjs.cts` under TypeScript 5.9), strict, `skipLibCheck` off.

## g. Browsers

The 1.1 harness's `a-browser`, built with Vite, `run-browsers.mjs` in three browsers and under
`TZID=Pacific/Kiritimati`, `run-old-runtime.mjs`, and `g-browser/binary.mjs` with
`photo.csv` and `report.pdf` added to `public/fixtures`.
