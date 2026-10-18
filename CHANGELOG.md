# Changelog

All notable changes to `sheet-to-schema`.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Members marked `@internal` are not covered by semver and may change in any release.

---

## [1.1.0-rc.1]

The first release candidate of 1.1 (docs/1.1-spec.md): a browser file reader that matches the
server's, grouping in the streaming runner, and formula results read as their typed values.
Every change is an addition except the formula fix and the group limits now enforced by
`applyMapping`, both listed below. Published to `next`; `latest` stays 1.0.0.

### Added

- `sheet-to-schema/browser`: `readSheetFile` reads a CSV, TSV or `.xlsx` file (a `File`,
  `Blob`, `ArrayBuffer` or `Uint8Array`) into exactly the grid the server's `readSheet` reads
  from the same bytes, with the server's limits, error codes and messages; `readXlsx` does the
  same for a workbook. `exceljs` stays an optional peer, loaded only when a workbook is read.
  The server and browser readers share their format sniffing, zip part selection, cell rules,
  limits and row checks, so they agree by construction.
- Preview responses carry `features` (`["group"]` from this release; `SERVER_FEATURES` in
  `/node`). Older clients ignore it.
- `planForServer(plan, preview)`: given the preview (or `{ planVersions, features }`), it also
  refuses a grouped plan (`refused: ['group']`) for a server whose preview does not list
  `"group"`, which includes every 1.0 server. `planForServer(plan, planVersions)` is unchanged.
- `startMapping`, `MappingSession` and `MappingBatch` in the main entry, `@internal`: the
  batch-fed form of `applyMapping` that `runImport` runs on.
- `GroupLimits` and `DEFAULT_GROUP_LIMITS` in the main entry: `maxGroupRows` (10,000),
  `maxGroups` (200,000) and `maxGroupKeyBytes` (8 MiB), and an `applyMapping` option,
  `groupLimits`, to override them.

### Changed

- `runImport` and the router group rows. A contiguous grouped plan, which 1.0 refused with
  `INVALID_PLAN` (`PLAN_GROUP`), now imports, with the same records, errors, warnings and counts
  as `applyMapping`; a group that straddles a batch is carried into the next and handed to
  `onBatch` whole. Nobody could depend on the refusal usefully, so it is treated as a feature;
  the 1.0 tests that asserted the refusal were updated to assert the import. `contiguous: false`
  is still refused, and `GROUPING_NOT_STREAMED` now says so.
- `ImportLimits` includes the group limits, with the same defaults, enforced while streaming.
  A run past one, or with a closed key that comes back, throws the engine's `ImportFailure`;
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
