# Changelog

All notable changes to `sheet-to-schema`.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Members marked `@internal` are not covered by semver and may change in any release.

---

## [2.0.0]

sheet-to-schema becomes a set of functions: it reads, matches, validates and streams, and the
app owns routes, storage, jobs and queues. The recommended server pattern is background imports
with polling (README, "Recipe: background imports with polling"). Upgrading is covered in
[MIGRATING-2.0.md](MIGRATING-2.0.md), and the decisions in [docs/2.0-spec.md](docs/2.0-spec.md). First published as
2.0.0-rc.1 under `next`. Dynamic Entity 3.x stays on 1.x, which is now published from the `1.x`
branch under the `release-1.x` dist-tag.

### Removed

- **`createImportRouter`**, with `ImportRouterOptions` and its @internal `param` and
  `engineVersion`, `ImportBinding` and its @internal `templateName`, `previewExtras` and `plan`,
  `BindingSource`, `OnImport`, `ImportHandler`, `ImportRouter`, `ImportRequest`,
  `ImportResponse` and `ImportErrorReport`. Write the routes from the functions; MIGRATING-2.0.md
  has a complete Express example.
- **`sendFailure`**: `toErrorBody(error)`, then answer with its `status` and `body`.
- **`safeFieldName`** from `/node`'s exports. `receiveUpload` still uses it.
- **`ImportLimits.totalTimeoutMs`**: only the router enforced it. Bound a run with
  `runImport({ signal: AbortSignal.timeout(ms) })`.
- **The `express` optional peer dependency.** The package never imported it.
- `SERVER_FEATURES` is no longer exported from `/node`. It moved to the main entry.
- **The `UNKNOWN_ENTITY` error code.** Only the router raised it. A route of your own that needs
  "no such name" answers its own 404.

### Added

- **`runImport({ signal })`.** Aborted, the run stops reading at once and starts no new batch.
  An `onBatch` already running is waited for, never interrupted. The source is destroyed. The run
  rejects with `ImportError` `ABORTED`, a new code with status 499, whose `details` are
  `{ rowsRead, imported, failed }` and whose `cause` is the signal's reason. Already aborted:
  nothing is read.
- **`runImport({ onProgress })`**, told `{ bytesRead, rowsRead }` at most once per batch and at
  the end, when `bytesRead` is the input's size. Never awaited. Anything it throws or rejects
  with is ignored. Type `ImportProgress`.
- **`receiveUpload` enforces `limits.idleTimeoutMs`.** A body that sends nothing for that long
  while it is read fails with `TIMEOUT` ("The upload stalled.") and the connection is closed.
  Time paused behind a slow reader does not count.
- `SERVER_FEATURES` in the main entry, next to `planForServer`.
- `templateOf` and `templateFilename` stay in `/node`, now beside `writeTemplate`, for an app
  serving its own template route.

### Changed

- **`runImport` groups by default** (`grouping` defaults to `true`). `grouping: false` keeps
  1.x's refusal (`reason: 'grouping-disabled'`). `contiguous: false` is refused either way.
- **Binary input is refused.** A file with a NUL byte in its first 8 KB, such as an image, a PDF
  or an executable, is refused with `UNSUPPORTED_FORMAT` ("This file is not a spreadsheet: it
  holds binary data. ...") by `readSheet`, `previewSheet`, `runImport`, `readSheetFile` and
  `readCsvFile`, all alike. In 1.x it was read as CSV. Every CSV and workbook 1.x read still
  reads exactly as 1.3.0 read it, which is checked against grids 1.3.0 itself wrote.
  Classification now looks at up to 8 KB before the first row (it was 8 bytes).
- **`receiveUpload` enforces `limits.maxFieldNameBytes`** on every part, refusing a longer name
  with `TOO_LARGE`. busboy applies its `fieldNameSize` to urlencoded bodies only, so 1.x
  accepted any part name in a multipart upload, as 1.3.0 still does.

---

## [1.3.0]

Found by Dynamic Entity's 3.1 tests (B1, its docs/3.1-spec.md): in a grouped record, a
problem inside one collected item was reported on the group's first row, carrying every row of
the group. In a 40-row order, the user had to find the bad item themselves. The code is
identical to 1.3.0-rc.1, which Dynamic Entity's drift check passed on `next`; only the version
and the docs changed.

### Changed

- **Grouped item problems now report the item's row.** A record-level problem whose `ref` is
  inside a collected item (`<collect>.<i>`, or deeper, such as `items.2.sku` being required) has
  `row` set to the sheet row that item came from, and `rows: [that row]`. Before, it was the
  group's first row and all its rows. This holds with blank item rows in the group, which take
  no index, and for an array collected at a nested ref (`order.items.1.sku`). It holds in
  `applyMapping` and in `runImport` at every batch size.
- A problem with the record as a whole is unchanged: the group's first row, with all its rows.
  That includes one about the array itself (`items`), a ref with no index or an index past the
  items, and `''`. Cell problems are unchanged.
- It is a minor release, because a client that read `rows` as "the group" for an item problem
  now sees one row. Three 1.2 tests pinned the old rows and are updated to the new ones.
  Everything else passes unchanged.

---

## [1.2.0]

What Dynamic Entity's 3.1 Step 0 check found about bundled apps without `exceljs` installed
(its docs/3.1-spec.md). `sheet-to-schema/browser` does not build there under Angular's
`ng build` or webpack, though it does under Vite and `ng serve`. And where an app did build, a
workbook failed with the bundler's or the browser's own error, not "install exceljs". It is a
minor release because it adds API. **Every 1.1.0 test passes**, with two exceptions: tests that
pinned a missing peer as a plain `Error` with no code, and four `PLAN_GROUP` expectations that
now include `reason`. The code is identical to 1.2.0-rc.1, which Dynamic Entity's drift check
passed on `next`; only the version and the docs changed.

### Added

- `readCsvFile(input, { filename?, limits? })` in the main entry: the CSV half of
  `readSheetFile`, for an app that reads no workbooks. It reads a CSV or TSV file (a `File`,
  `Blob`, `ArrayBuffer` or `Uint8Array`) into the grid the server reads, with `delimiter`. The
  format is decided by the bytes, and an `.xlsx`, `.xls` or UTF-16 file is refused with
  `UNSUPPORTED_FORMAT`. Nothing in its module graph asks for `exceljs`, so an app without it
  builds: `npm run check:bundle` bundles it with `exceljs` unresolvable, and a CSV-only Angular
  21 app runs `ng build` without it installed.
- `ImportError` and `ImportErrorCode` (and `ImportErrorBody`) in the main entry. `/node` and
  `/browser` now re-export the main entry's class instead of each bundling a copy.
- `ImportError` code `PEER_MISSING`, with `details.peer`, for an optional peer that is not
  installed.
- `PlanProblem.reason`: a server's `PLAN_GROUP` refusal of a valid grouped plan says which
  refusal it is, `grouping-disabled` or `non-contiguous`, so a client need not match the
  message. The code stays `PLAN_GROUP`. `PlanProblemReason` is the type.
- `onError(error, { request, status, code, peer })` on `createImportRouter`: called for every
  failure the router answers with a 5xx, with the error's own code, which the client may not
  see, and for `PEER_MISSING` the package. `ImportErrorReport` is its type. Without it, the
  router logs one `console.error` line, such as
  `sheet-to-schema/node: POST /import/order/preview answered 500: PEER_MISSING (exceljs)`, with
  the error. In 1.1 such a failure was answered and logged nowhere. A 4xx is not reported, since
  the client was told.
- `npm run check:browsers` (and a CI job): the built package in Chromium, Firefox and WebKit,
  bundled the ways Step 0 found apps bundle it.
- `@internal`, in the main entry, so `/node` and `/browser` share one copy:
  - `bytesOf` and `csvGrid`;
  - `detectFormat`, `MAGIC_BYTES` and `SheetFormat`;
  - `guardHeaders`, `guardRow` and `guardGrid`;
  - `DEFAULT_LIMITS`, `resolveLimits` and `ImportLimits`. Import these from `/node`, as before.

### Changed

- A missing `exceljs` (or `busboy`) is now `ImportError` `PEER_MISSING`, not a plain `Error`.
  The message, the `cause` and the `instanceof Error` check are unchanged. Over HTTP it still
  answers `INTERNAL` (500), as before: what a server has installed is not its client's to know.
- In a bundled app, `PEER_MISSING` is also recognised from:
  - Vite's stub for an unresolved optional peer;
  - Chromium's, Firefox's and WebKit's errors for a bare `exceljs` specifier, as in an app that
    marks it external.

  It is recognised only where `exceljs` is the module that failed to resolve. A lazy chunk that
  failed to download (a `TypeError` naming the chunk's URL, which Vite names `exceljs.min-…js`;
  WebKit's "Importing a module script failed."; webpack's `ChunkLoadError`) passes through as it
  is: the package is installed, and the network failed.
- README: the claim that a CSV needs nothing installed is corrected. `/browser` needs `exceljs`
  installed for a bundled app to build. A CSV-only app uses `readCsvFile`.

---

## [1.1.0]

A browser file reader that reads exactly what the server reads, grouping in the streaming
runner (opt-in), and formula results read as their typed values (docs/1.1-spec.md). The code is
identical to 1.1.0-rc.3; only the version and the docs changed. **Every 1.0 test passes
unchanged.** The release candidates were tested from npm in fresh projects
(docs/1.1-rc-feedback.md): Chromium, Firefox and WebKit; Vite, webpack and esbuild; express 4
and 5, CommonJS and ESM; a CommonJS Jest suite with no Node flags; TypeScript strict on
`@types/express` 4, 5 and none; and Dynamic Entity 3.0's own suites.

Two changes are not additions, both listed below: formula results (a fix), and the group limits
`applyMapping` now enforces.

### Added

- `sheet-to-schema/browser`: `readSheetFile` reads a CSV, TSV or `.xlsx` file (a `File`,
  `Blob`, `ArrayBuffer` or `Uint8Array`) into exactly the grid the server's `readSheet` reads
  from the same bytes, with the server's limits, error codes and messages; `readXlsx` does the
  same for a workbook. `exceljs` stays an optional peer, loaded only when a workbook is read.
  A workbook needs `DecompressionStream` with `deflate-raw` (Chrome and Edge 103, Firefox 113,
  Safari 16.4, Node 20.12); elsewhere it is refused with a new `ImportError` code,
  `UNSUPPORTED_RUNTIME`, naming those versions. A CSV reads anywhere. `/node` and `engines`
  (Node 20) are unchanged.
  The server and browser readers share their format sniffing, zip part selection, cell rules,
  limits and row checks, so they agree by construction.
- `grouping` option on `runImport` and `createImportRouter`: server-side grouping is opt-in.
  With `grouping: true`, a contiguous grouped plan imports with the same records, errors,
  warnings and counts as `applyMapping`, and a group that straddles a batch is carried into the
  next and handed to `onBatch` whole. Without it (the default) a grouped plan is refused exactly
  as in 1.0. `contiguous: false` is refused either way, with `NON_CONTIGUOUS_NOT_STREAMED`.
- Preview responses carry `features` (`["group"]`, `SERVER_FEATURES` in `/node`) when the
  router was created with `grouping: true`. Older clients ignore it.
- `planForServer(plan, preview)`: given the preview (or `{ planVersions, features }`), it also
  refuses a grouped plan (`refused: ['group']`) for a server whose preview does not list
  `"group"`, which includes every 1.0 server. `planForServer(plan, planVersions)` is unchanged.
- `startMapping`, `MappingSession` and `MappingBatch` in the main entry, `@internal`: the
  batch-fed form of `applyMapping` that `runImport` runs on.
- `GroupLimits` and `DEFAULT_GROUP_LIMITS` in the main entry: `maxGroupRows` (10,000),
  `maxGroups` (200,000) and `maxGroupKeyBytes` (8 MiB), and an `applyMapping` option,
  `groupLimits`, to override them.

### Changed

- `ImportLimits` includes the group limits, with the same defaults, enforced while streaming
  when grouping is on. A run past one, or with a closed key that comes back, throws the engine's
  `ImportFailure`;
  the router answers it with 413 (`GROUP_TOO_LARGE`, `TOO_MANY_GROUPS`) or 422
  (`GROUP_NOT_CONTIGUOUS`), carrying the key and rows. These three codes can now appear in
  HTTP error bodies: `ImportErrorBody.error.code` may be one of them.
- `BatchInfo.firstRow`, for a grouped import, is the first row the batch's records were built
  from: where a group carried into the batch from the one before began. Without grouping it is
  the batch's first row, as in 1.0.
- `applyMapping` enforces the group limits: `maxGroupRows` and `maxGroups` in both grouping
  modes, `maxGroupKeyBytes` for contiguous groups. A grouped sheet past a default throws an
  `ImportFailure` (`GROUP_TOO_LARGE` or `TOO_MANY_GROUPS`) where 1.0 imported it; pass
  `groupLimits` to raise the limit.

### Fixed

- Formula results on the server. 1.0 read a formula's cached result as ExcelJS's streaming
  reader reduced it: a date-formatted result as its serial number, a cached boolean as `1` or
  `0`, a cached error as an empty cell. A formula cell is now the typed cell its cached result
  is: a `Date` (by the same rule as a typed date cell), a boolean, the error text (`#N/A`). The
  browser reader reads them the same way, including a cached `0` or `false`, which ExcelJS's
  `Workbook.xlsx.load` would drop. Both take the formulas out of the worksheet before parsing;
  an import never reads a formula itself.

---

## [1.1.0-rc.3]

The third release candidate of 1.1. As rc.2, with the one finding of rc.2's test round fixed
(docs/1.1-rc-feedback.md, R1-1 and R1-2). **Every 1.0 test passes unchanged.** Published to
`next`; `latest` stays 1.0.0.

- Fixed: reading a workbook through `/browser` on a runtime that has `DecompressionStream` but
  not its `deflate-raw` format (Node 20.0 to 20.11, Chrome and Edge 80 to 102) threw the
  constructor's raw `TypeError`. It now throws `ImportError` with a new code,
  `UNSUPPORTED_RUNTIME`, naming the versions that can read a workbook; a CSV still reads.
- Added: the minimum versions for reading a workbook in the browser path, in the README and
  the `/browser` entry: Chrome and Edge 103, Firefox 113, Safari 16.4, Node 20.12. `/node` and
  `engines` (Node 20) are unchanged.
- CI runs the browser reader on Node 20.11, where it must read a CSV and refuse a workbook with
  `UNSUPPORTED_RUNTIME` (`npm run check:browser-runtime`).

The full notes are under 1.1.0.

---

## [1.1.0-rc.2]

The second release candidate of 1.1 (docs/1.1-spec.md): a browser file reader that matches the
server's, grouping in the streaming runner (opt-in), and formula results read as their typed
values. Every change is an addition except the formula fix and the group limits now enforced by
`applyMapping`. **Every 1.0 test passes unchanged.** Published to `next`;
`latest` stays 1.0.0.

Since rc.1: server-side grouping is opt-in (`grouping: true`). rc.1 grouped by default, and
Dynamic Entity 3.0, which relies on the 1.0 refusal, failed against it.

The full notes are under 1.1.0.

---

## [1.1.0-rc.1]

Superseded by rc.2. As rc.2, except that `runImport` and the router grouped rows by default:
a grouped plan that 1.0 refused imported, every preview listed `features: ["group"]`, and the
1.0 tests that asserted the refusal had been changed to assert the import.

---

## [1.0.0]

The first stable release. The code is identical to 1.0.0-rc.3; only the version changed.
From here the package follows Semantic Versioning: a breaking change to anything not marked
`@internal` waits for 2.0.0.

- Tested before release against the published 1.0.0-rc.3 from fresh projects: one copy when
  installed beside `@dynamic-entity/core`; CommonJS and ESM; a CommonJS Jest suite with no Node
  flags; Express 4 and 5; TypeScript strict on `@types/express` 4 and 5 with `skipLibCheck` off.
- Known limit, outside this package: in the browser, the SheetJS `.xlsx` reader loses
  characters above U+FFFF (most emoji) when a workbook stores them as numeric character
  references, as openpyxl does. The server reader (`sheet-to-schema/node`, over exceljs) reads
  them correctly. An official browser `.xlsx` parser is planned for 1.1.

## [1.0.0-rc.3]

- **Moved to standalone repository**: `sheet-to-schema` is now developed in its own repository at [berserker5619/sheet-to-schema](https://github.com/berserker5619/sheet-to-schema). Development history prior to Phase 1 lives in the [Dynamic Entity repository](https://github.com/berserker5619/Dynamic-Entity).
- **Minimum Node runtime**: Raised `engines.node` to `>=20`.
- **Standalone test & fixture suites**: Real-world fixtures (Mac Excel 1904 dates, numeric identifiers past 2^53, complex sheet with merged cells and formulas) copied with automated validation suite.
- **Fix: `sheet-to-schema/node` under Jest.** The CommonJS build now loads the optional peers (`exceljs`, `busboy`) with `require`, still lazily inside the function that needs them. It used a real `import()`, which Jest's module sandbox cannot run without `--experimental-vm-modules`, so any CommonJS Jest suite that read a workbook or received an upload failed. The ESM build still uses `import()`.
- **Typings: no dependency on `@types/express`.** `createImportRouter` takes any router with `get` and `post` (`ImportRouter`) and returns it typed as given; requests and responses are `ImportRequest` and `ImportResponse`, built on Node's `IncomingMessage` and `ServerResponse`. The published `.d.ts` no longer imports from `express`, so a project with `@types/express` 4 and 5 both installed (or neither) compiles. `BindingSource`, `OnImport` and `ImportRouterOptions` take the request type as a parameter, defaulting to `ImportRequest`; a callback that reads more than that, such as `request.user`, annotates its parameter (`(name, request: express.Request) => ...`) and the options take that type. `sendFailure` takes an `ImportResponse`, which an Express response is.

## [1.0.0-rc.2]

- **Unsafe integer guard**: When a numeric cell's absolute value exceeds `Number.MAX_SAFE_INTEGER` and its target is a string kind, generic adapters report `CELL_FORMAT`: `"too many digits to read exactly; format the column as Text in the source file"`. Numeric target fields are unchanged.
- **Merged ranges contract**: Covered cells of a merged range are `''` (as the streaming server reader emits).

## [1.0.0-rc.1]

The first release candidate. The package is the spreadsheet-import engine of
[Dynamic Entity](https://github.com/berserker5619/Dynamic-Entity#readme), extracted so it can be used with any schema. Dynamic Entity
3.0 runs on it, and is the proof that it holds: the same files import to the same records as
Dynamic Entity 2.5.0 produced.

### The main entry, `sheet-to-schema`
Browser-safe, with no runtime dependencies.
- **Mapping plan v2**, as plain JSON: `target`, `schemaVersion`, entries with a `column` or
  a `constant`, a per-entry `split` and `dateOrder`, per-array `lists` options, and `group`.
  `readPlan` reads v2 and the older v1 shape, and normalises both.
- **`applyMapping`**: rows in, records out, with every problem collected and coded. Lists
  three ways: numbered columns, one cell split, and one row per item grouped by a key.
  Rows of a group that disagree raise a warning and keep the first row's value.
- **`suggestMapping`** and `slotsFor`: a suggested plan from the headers, sized per array,
  and from a sample of rows the order a date column is written in.
- **Dates are never guessed.** A date that reads two ways is an error unless the plan entry
  or the run states its order.
- **Adapters**: `jsonSchemaAdapter`, `exampleJsonAdapter`, and the `SchemaAdapter` contract
  for your own, with `coerce`, `finalize` and `validate` hooks.
- **`validatePlan`** and `preparePlan`, with thirteen `PLAN_` codes; `CELL_` and `RECORD_`
  codes on every row problem.
- **`planForServer`** and `v2OnlyFields`: what a client may send to a server that reads only
  v1 plans, or why it must not.
- **CSV**: `parseCsv`, `createCsvReader`, `toCsv`, delimiter detection, formula escaping.
- The wire types a client and a server share, and `IMPORTER_VERSION` / `PLAN_VERSIONS`.

### The server entry, `sheet-to-schema/node`
Needs Node. `exceljs`, `busboy` and `express` are optional peers, loaded when first needed.
- **`readSheet`**: CSV or `.xlsx`, streamed, decided by the file's bytes and held to every
  limit, with a zip guard in front of the workbook reader.
- **`runImport`** and `previewSheet` over an adapter: memory bounded by the batch, the next
  batch not read until the last is written, errors counted exactly and sampled.
- **`createImportRouter`**: template, preview, validate and import routes on a router you
  pass in, with an adapter per name. Every answer is stamped with the engine version, the
  adapter and the plan versions the server reads.
- **`writeTemplate`**, `receiveUpload`, the limits and the one error envelope.

### Not in this release
- The mapper cannot build grouped plans yet.
- The streaming runner does not group rows: servers refuse them (`PLAN_GROUP`, Phase 3). `applyMapping` groups.
- The wizard shows no warnings yet.
- A header row other than row 1.
