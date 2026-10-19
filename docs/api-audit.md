# API audit for 2.0

Step 1 of the 2.0 plan. Read-only: no code changed. Every export of the three entries as of
1.3.0, who uses it, and whether it stays in 2.0.

**How usage was found.** Exports are listed by the TypeScript checker from `src/index.ts`,
`src/node/index.ts` and `src/browser/index.ts` (types included). Dynamic Entity usage comes from
parsing every `import`/`export … from 'sheet-to-schema…'` in that repository (main @ 3.1.0,
all packages, scripts and test harnesses; `dist` and `node_modules` excluded), per entry and by
name. "DE <package>" means a non-test source file; "DE tests only" means only specs, fixtures,
scripts or harnesses. "README" is a whole-word match in README.md (it holds the recipes).
"internals" means a non-test file of this package other than the barrels and the defining file;
"tests" means a spec or fixture here.

**The rule applied (D1).** Remove `createImportRouter`, its @internal hooks and the `express`
peer; remove an HTTP-only helper when nothing outside the router uses it. Everything else is
kept: 2.0 is not a general clean-up.

## Decisions (approved 2026-10-19)

1. `ImportLimits.idleTimeoutMs` stays, enforced by `receiveUpload` itself (a stalled upload), with
   a test. `totalTimeoutMs` is removed; MIGRATING-2.0 shows `signal: AbortSignal.timeout(ms)` on
   `runImport` instead. No limit may remain that nothing enforces.
2. `readPlanField` stays.
3. `templateOf` and `templateFilename` move to `write-template.ts`.
4. `toErrorBody`, the wire types and `planForServer` stay.
5. `SERVER_FEATURES` stays, moved to the main entry next to `planForServer`: a capability
   vocabulary, not HTTP.

## Removal list (approved)

| Export | Entry | Why | An outside user migrates to | Dynamic Entity 4.0 must |
| --- | --- | --- | --- | --- |
| `createImportRouter` | /node | D1. Routes belong to the app. | Write the routes: `receiveUpload` + `previewSheet` / `runImport` (MIGRATING-2.0 has a worked Express example). | `packages/server/src/express.ts` builds its own routes from the functions; its `createImportRouter` stays DE's own API. |
| `ImportRouterOptions` | /node | D1. Options of the removed router, including the @internal `param` and `engineVersion`. | Nothing; each option becomes an argument or a line in the app's own route (`limits`, `dateOrder`, `grouping` go to `previewSheet`/`runImport`; `lang` to `adapter.targets`). | Stop passing `param: 'entity'` and `engineVersion: CORE_VERSION`; its routes read `req.params.entity` and stamp `CORE_VERSION` themselves. |
| `ImportBinding` | /node | D1. The router's per-name configuration, including the @internal `templateName`, `previewExtras` and `plan`. | The app looks up its adapter and context however it likes and passes them to `previewSheet` / `runImport`. | Replace the binding with a local type. `templateName` → its own `templateFilename(config.entity, …)` call; `previewExtras` → spread `suggestionFor(…)` into its own preview answer; `plan` → call `planForConfig` before `runImport`. |
| `BindingSource` | /node | D1. Router type. | None needed. | Nothing (not imported). |
| `OnImport` | /node | D1. Router callback type. | `OnBatch` (`runImport`'s `onBatch`), which receives the same records and `BatchInfo`. | Nothing (not imported from here). |
| `ImportHandler` | /node | D1. Router type. | The framework's own handler type. | Nothing (not imported). |
| `ImportRouter` | /node | D1. Structural type of the router the caller passed in. | The framework's own router type. | `express.ts` imports it as `RouteTable`; use `express.Router` instead. |
| `ImportRequest` | /node | D1. Structural request type for the router. `receiveUpload` takes a plain `IncomingMessage`. | `IncomingMessage` or the framework's request type. | `express.ts` imports and re-exports it; define it locally (or use `express.Request`) and keep the re-export DE's own. |
| `ImportResponse` | /node | D1. Structural response type for the router. | The framework's response type. | `express.ts` re-exports it; define it locally or use `express.Response`. |
| `ImportErrorReport` | /node | D1. Argument of the router's `onError`. | The app logs in its own `catch`; `toErrorBody(error).status >= 500` is the same condition. | Nothing (not imported). |
| `sendFailure` | /node | HTTP-only: writes an Express-shaped response (`status().json()`, `removeHeader`, `headersSent`). Used only by the router; DE re-exports it from its router module. | `const { status, body } = toErrorBody(error); res.status(status).json(body);`. | `express.ts` re-exports it as public API: keep that export by moving its body (about 15 lines) into DE. |
| `safeFieldName` | /node | HTTP-only (multipart field names in messages). Used inside `receiveUpload` only; stays there unexported. | Nothing: `receiveUpload` still sanitises names in its messages. | `packages/server/src/multipart.ts` re-exports it for `express.spec.ts` only; drop the re-export and that test. |

### Members and package metadata removed with the router

| What | Why | An outside user migrates to | Dynamic Entity 4.0 must |
| --- | --- | --- | --- |
| `ImportRouterOptions.param`, `.engineVersion` (@internal) | D1, with the type. | n/a (internal). | See `ImportRouterOptions` above. |
| `ImportBinding.templateName`, `.previewExtras`, `.plan` (@internal) | D1, with the type. | n/a (internal). | See `ImportBinding` above. |
| `ImportLimits.totalTimeoutMs` and its `DEFAULT_LIMITS` entry | Only the router enforced it (`applyTimeouts`). No limit may remain that nothing enforces. | `runImport({ …, signal: AbortSignal.timeout(ms) })` (D2); MIGRATING-2.0 shows it. `resolveLimits` ignores unknown keys, so an old override still runs; TypeScript flags it in an object literal. | Drop it from `packages/server/README.md`'s limits table and the `express.spec.ts` test that sets it; bound its own routes with `AbortSignal.timeout`. |
| `express` optional peer (`peerDependencies`, `peerDependenciesMeta`) | D1. | Nothing: the package never imported it. | Nothing: DE server depends on `express` itself. |
| `@types/express` devDependency | Only the router tests use it. `express` and `supertest` stay as devDependencies only if step 7's HTTP test of the MIGRATING example runs under Jest; the consumer check installs its own. | n/a | n/a |

**`ImportLimits.idleTimeoutMs` stays and becomes `receiveUpload`'s own** (approved): it abandons a
request body that sends nothing for that long with `TIMEOUT`, with a test. Until 2.0 only the
router enforced it. The `TIMEOUT` code stays: `receiveUpload` throws it for a stalled body and
for one that ends early.

After 2.0 every field of `ImportLimits` is enforced by a function the package exports.

## Kept although HTTP-adjacent (approved)

| Export | Why it stays |
| --- | --- |
| `templateOf` | Not HTTP: an adapter's targets as a `TemplateSheet`. The only way to get the router's default template without the router. Approved: moves from router.ts to write-template.ts. |
| `templateFilename` | A pure string function that makes a schema name safe for `Content-Disposition`; any app serving a template needs it, and DE re-exports it publicly. Approved: moves to write-template.ts. |
| `readPlanField` | Approved to keep: `receiveUpload`'s companion (the plan field must precede the file, and it says so), with the two `INVALID_PLAN` errors an app would otherwise rewrite. |
| `SERVER_FEATURES` | Approved to keep, moved to the main entry next to `planForServer`: the capability vocabulary `planForServer` reads (`features`), not HTTP. `/node` no longer exports it. |
| `toErrorBody` | Any error as `{ status, body }` with internals hidden (`INTERNAL`). Not tied to a framework; every app-owned route needs it. DE server uses it. |
| `ImportPreviewResponse` | Wire type used by DE core and read by `planForServer` (`planVersions`, `features`). Docs updated to say an app's preview route may answer with it. |
| `ImportCommitResponse` | Wire type used by DE core; maps 1:1 from `ImportRunResult`. |
| `ImportErrorResponse` | Wire type used by DE core; the `toErrorBody` body. |
| `AdapterStamp` | Wire type. Plain data, no HTTP; DE core's client/server contract uses it. Its docs lose router references. |
| `planForServer` | Plan-version negotiation, not HTTP; DE core and ngx use it in production. |
| `loadOptional` | Not HTTP; how `/node` loads its peers lazily. Nothing outside uses it; out of D1's scope (a candidate for @internal later, not a 2.0 removal). |

## Every export

R = remove in 2.0, K = keep. Types are marked *type*. @internal exports are marked.

### `sheet-to-schema` (114)

| Export | Kind | Used by | 2.0 | Reasoning |
| --- | --- | --- | --- | --- |
| `GroupSpec` | *interface* | internals | K | Part of the mapping plan, the package's central data type. |
| `ListOptions` | *interface* | internals | K | Part of the mapping plan, the package's central data type. |
| `MappingEntry` | *interface* | DE core; internals | K | Part of the mapping plan, the package's central data type. |
| `MappingPlan` | *interface* | DE core; README; internals; tests | K | Part of the mapping plan, the package's central data type. |
| `MatchConfidence` | *type* | internals | K | Part of the mapping plan, the package's central data type. |
| `NormalizedPlan` | *interface* | DE core; internals; tests | K | Part of the mapping plan, the package's central data type. |
| `PlanProblem` | *interface* | DE core; internals; tests | K | Part of the mapping plan, the package's central data type. |
| `PlanProblemReason` | *type* | nobody (appears in signatures only) | K | Part of the mapping plan, the package's central data type. |
| `PLAN_PROBLEM_CODES` | const | DE core; README; tests | K | Problem codes an app matches on. |
| `PlanProblemCode` | *type* | DE core; internals | K | Problem codes an app matches on. |
| `readPlan` | function | DE core; README; internals; tests | K | Reading and checking a plan. |
| `ReadPlanOptions` | *interface* | DE core | K | Reading and checking a plan. |
| `ReadPlanResult` | *interface* | DE core | K | Reading and checking a plan. |
| `planForServer` | function | DE core, ngx-dynamic-entity; README; internals; tests | K | Plan-version negotiation, not HTTP; DE core and ngx use it in production. |
| `v2OnlyFields` | function | DE core; internals; tests | K | Used by `planForServer` and DE core. |
| `PlanForServer` | *type* | DE core | K | Return type of `planForServer`. |
| `ServerCapabilities` | *interface* | DE ngx-dynamic-entity | K | Parameter type of `planForServer`; DE ngx uses it. |
| `UNSAFE_PATH_KEYS` | const | only its own module | K | Guards record paths against prototype pollution; adapter authors use it. |
| `isUnsafePath` | function | internals; tests | K | Guards record paths against prototype pollution; adapter authors use it. |
| `CELL_PROBLEM_CODES` | const | README | K | Problem codes an app matches on. |
| `RECORD_PROBLEM_CODES` | const | README | K | Problem codes an app matches on. |
| `CellProblemCode` | *type* | internals | K | Problem codes an app matches on. |
| `RecordProblemCode` | *type* | internals | K | Problem codes an app matches on. |
| `RowProblemCode` | *type* | DE core; internals | K | Problem codes an app matches on. |
| `CellOptions` | *interface* | internals | K | The adapter contract every schema implements. |
| `CoerceOutcome` | *type* | DE core; internals | K | The adapter contract every schema implements. |
| `ImportTarget` | *interface* | DE core; internals; tests | K | The adapter contract every schema implements. |
| `RecordProblem` | *interface* | DE core; internals; tests | K | The adapter contract every schema implements. |
| `SchemaAdapter` | *interface* | DE core; README; internals; tests | K | The adapter contract every schema implements. |
| `TargetArray` | *interface* | DE core; internals; tests | K | The adapter contract every schema implements. |
| `TargetOptions` | *interface* | tests only | K | The adapter contract every schema implements. |
| `TargetSet` | *interface* | DE core; internals; tests | K | The adapter contract every schema implements. |
| `ValueKind` | *type* | internals; tests | K | The adapter contract every schema implements. |
| `MAX_SLOTS` | const | internals; tests | K | Slot planning for repeating fields; part of matching. |
| `planSlots` | function | internals; tests | K | Slot planning for repeating fields; part of matching. |
| `shapeOf` | function | internals; tests | K | Slot planning for repeating fields; part of matching. |
| `slotOf` | function | internals; tests | K | Slot planning for repeating fields; part of matching. |
| `validatePlan` | function | internals; tests | K | Validation, a 2.0 core function. |
| `DEFAULT_LIST_SEPARATOR` | const | only its own module | K | Coercion, used by adapters. |
| `coerceValue` | function | internals; tests | K | Coercion, used by adapters. |
| `CoerceValueOptions` | *interface* | nobody (appears in signatures only) | K | Coercion, used by adapters. |
| `cellText` | function | DE core; internals; tests | K | How a cell becomes text; shared by every reader. |
| `DATE_ORDERS` | const | internals | K | Date order, never guessed; part of validating. |
| `inferDateOrder` | function | internals | K | Date order, never guessed; part of validating. |
| `DateOrder` | *type* | internals | K | Date order, never guessed; part of validating. |
| `applyMapping` | function | DE core; README; internals; tests | K | Applying a plan, the in-memory import. |
| `preparePlan` | function | DE core; internals; tests | K | Applying a plan, the in-memory import. |
| `startMapping` (@internal) | function | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `ApplyMappingOptions` | *interface* | tests only | K | Applying a plan, the in-memory import. |
| `MappingBatch` (@internal) | *interface* | nobody (appears in signatures only) | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `MappingSession` (@internal) | *interface* | nobody (appears in signatures only) | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `PreparedPlan` | *interface* | nobody (appears in signatures only) | K | Applying a plan, the in-memory import. |
| `validateRecord` | function | internals; tests | K | Validation, a 2.0 core function. |
| `ImportResult` | *interface* | DE tests only; internals; tests | K | Result types of the functions. |
| `ImportRowError` | *interface* | DE tests only; internals; tests | K | Result types of the functions. |
| `IMPORT_FAILURE_CODES` | const | README; tests | K | Whole-import failures from the engine. |
| `ImportFailure` | class | DE ngx-dynamic-entity; README; internals; tests | K | Whole-import failures from the engine. |
| `DEFAULT_GROUP_LIMITS` | const | internals; tests | K | Grouping limits, enforced by the functions. |
| `GroupLimits` | *interface* | internals | K | Grouping limits, enforced by the functions. |
| `DEFAULT_SLOTS` | const | internals; tests | K | Matching: suggesting a mapping. |
| `slotsFor` | function | DE tests only; internals; tests | K | Matching: suggesting a mapping. |
| `suggestMapping` | function | DE core; README; internals; tests | K | Matching: suggesting a mapping. |
| `SuggestOptions` | *interface* | nobody (appears in signatures only) | K | Matching: suggesting a mapping. |
| `matchSlot` | function | internals; tests | K | Matching: the header grammar. |
| `normalizeHeader` | function | internals | K | Matching: the header grammar. |
| `slotPatterns` | function | tests only | K | Matching: the header grammar. |
| `SlotNames` | *interface* | nobody (appears in signatures only) | K | Matching: the header grammar. |
| `ImportFailureCode` | *type* | internals | K | Whole-import failures from the engine. |
| `ImportFailureDetails` | *interface* | nobody (appears in signatures only) | K | Whole-import failures from the engine. |
| `jsonSchemaAdapter` | function | DE tests only; README; tests | K | A shipped adapter. |
| `JsonSchemaAdapterOptions` | *interface* | nobody (appears in signatures only) | K | A shipped adapter. |
| `JsonSchemaMeta` | *type* | nobody (appears in signatures only) | K | A shipped adapter. |
| `JsonSchemaNode` | *interface* | tests only | K | A shipped adapter. |
| `exampleJsonAdapter` | function | README; tests | K | A shipped adapter. |
| `ExampleJsonAdapterOptions` | *interface* | nobody (appears in signatures only) | K | A shipped adapter. |
| `ExampleJsonMeta` | *interface* | nobody (appears in signatures only) | K | A shipped adapter. |
| `completeFirstLine` | function | DE core; internals; tests | K | Reading and streaming CSV. |
| `createCsvReader` | function | DE core; internals; tests | K | Reading and streaming CSV. |
| `decimalMarkFor` | function | DE core; README; internals; tests | K | Reading and streaming CSV. |
| `detectDelimiter` | function | DE core; internals; tests | K | Reading and streaming CSV. |
| `escapeFormula` | function | DE core; internals; tests | K | Reading and streaming CSV. |
| `padRow` | function | DE core; internals; tests | K | Reading and streaming CSV. |
| `parseCsv` | function | DE core; README; internals; tests | K | Reading and streaming CSV. |
| `toCsv` | function | DE core; internals; tests | K | Reading and streaming CSV. |
| `CsvDelimiter` | *type* | DE core; internals; tests | K | Reading and streaming CSV. |
| `CsvReader` | *interface* | DE core; internals | K | Reading and streaming CSV. |
| `CsvReaderOptions` | *interface* | DE core | K | Reading and streaming CSV. |
| `SheetData` | *interface* | DE core | K | Reading and streaming CSV. |
| `SheetGrid` | *interface* | DE core; internals | K | Reading and streaming CSV. |
| `readCsvFile` | function | DE ngx-dynamic-entity; README; internals; tests | K | Core; gains the binary refusal (D5). |
| `CsvFile` | *interface* | nobody (appears in signatures only) | K | Reading a CSV file in any runtime. |
| `CsvFileLimits` | *type* | nobody (appears in signatures only) | K | Reading a CSV file in any runtime. |
| `ReadCsvFileOptions` | *interface* | nobody (appears in signatures only) | K | Reading a CSV file in any runtime. |
| `SheetFileInput` | *type* | internals | K | Reading a CSV file in any runtime. |
| `ImportError` | class | README; internals; tests | K | The one refusal class across all entries; gains code `ABORTED`. |
| `ImportErrorBody` | *interface* | internals | K | Shape `toErrorBody` returns. |
| `ImportErrorCode` | *type* | internals; tests | K | Gains `ABORTED`. |
| `bytesOf` (@internal) | function | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `csvGrid` (@internal) | function | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `detectFormat` (@internal) | function | internals; tests | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `MAGIC_BYTES` (@internal) | const | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `SheetFormat` | *type* | internals | K | Input classification; D5 changes it. |
| `guardGrid` (@internal) | function | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `guardHeaders` (@internal) | function | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `guardRow` (@internal) | function | internals | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `DEFAULT_LIMITS` | const | README; internals; tests | K | Limits are enforced by the functions. Loses `totalTimeoutMs`; `idleTimeoutMs` becomes `receiveUpload`'s. |
| `resolveLimits` | function | internals; tests | K | Limits are enforced by the functions. |
| `ImportLimits` | *interface* | internals | K | Kept; loses `totalTimeoutMs` (see "Members"). |
| `AdapterStamp` | *interface* | DE core; internals | K | Wire type. Plain data, no HTTP; DE core's client/server contract uses it. Its docs lose router references. |
| `ImportCommitResponse` | *interface* | DE core; internals | K | Wire type used by DE core; maps 1:1 from `ImportRunResult`. |
| `ImportErrorResponse` | *interface* | DE core | K | Wire type used by DE core; the `toErrorBody` body. |
| `ImportPreviewResponse` | *interface* | DE core; internals | K | Wire type used by DE core and read by `planForServer` (`planVersions`, `features`). Docs updated to say an app's preview route may answer with it. |
| `IMPORTER_VERSION` | const | internals; tests | K | Version stamps. |
| `PLAN_VERSIONS` | const | internals; tests | K | Version stamps. |

### `sheet-to-schema/node` (56)

| Export | Kind | Used by | 2.0 | Reasoning |
| --- | --- | --- | --- | --- |
| `loadOptional` | function | internals; tests | K | Not HTTP; how `/node` loads its peers lazily. Nothing outside uses it; out of D1's scope (a candidate for @internal later, not a 2.0 removal). |
| `DEFAULT_LIMITS` | const | DE server; README; internals; tests | K | Limits are enforced by the functions. Loses `totalTimeoutMs`; `idleTimeoutMs` becomes `receiveUpload`'s. |
| `resolveLimits` | function | DE server; internals; tests | K | Limits are enforced by the functions. |
| `ImportLimits` | *interface* | DE server; internals | K | Kept; loses `totalTimeoutMs` (see "Members"). |
| `ImportError` | class | DE server; README; internals; tests | K | The one refusal class across all entries; gains code `ABORTED`. |
| `toErrorBody` | function | DE server; internals; tests | K | Any error as `{ status, body }` with internals hidden (`INTERNAL`). Not tied to a framework; every app-owned route needs it. DE server uses it. |
| `ImportErrorBody` | *interface* | DE server; internals | K | Shape `toErrorBody` returns. |
| `ImportErrorCode` | *type* | DE server; internals; tests | K | Gains `ABORTED`. |
| `destroySource` | function | DE server; internals; tests | K | Byte-stream helpers used by the readers and by DE server. |
| `limitBytes` | function | DE server; internals; tests | K | Byte-stream helpers used by the readers and by DE server. |
| `peek` | function | DE server; internals; tests | K | Byte-stream helpers used by the readers and by DE server. |
| `toByteStream` | function | DE server; internals; tests | K | Byte-stream helpers used by the readers and by DE server. |
| `ByteSource` | *type* | DE server; internals | K | Byte-stream helpers used by the readers and by DE server. |
| `guardZip` | function | DE server; internals; tests | K | Zip-bomb guard for workbooks. |
| `cellValue` | function | DE server; internals; tests | K | Workbook cell values. |
| `xlsxRows` | function | DE server; internals | K | Streaming workbook rows. |
| `detectFormat` (@internal) | function | DE server; internals; tests | K | @internal export shared between entries so there is one copy; not a public API, kept for that reason. |
| `guardRows` | function | DE server; internals; tests | K | Reading a sheet in Node. |
| `readSheet` | function | DE server; README; internals; tests | K | Core of 2.0; gains the binary refusal (D5). |
| `ReadSheetOptions` | *interface* | DE server; tests | K | Reading a sheet in Node. |
| `SheetFormat` | *type* | DE server; internals | K | Input classification; D5 changes it. |
| `SheetSource` | *interface* | DE server | K | Reading a sheet in Node. |
| `TEMPLATE_EXTENSION` | const | DE server; internals | K | Writing a template. |
| `TEMPLATE_MEDIA_TYPE` | const | DE server; internals; tests | K | Writing a template. |
| `writeTemplate` | function | DE server; README; internals; tests | K | Function; the template half of the package. |
| `TemplateFormat` | *type* | DE server; internals; tests | K | Writing a template. |
| `TemplateSheet` | *interface* | DE server; internals; tests | K | Writing a template. |
| `WriteTemplateOptions` | *interface* | nobody (appears in signatures only) | K | Writing a template. |
| `GROUPING_NOT_STREAMED` | const | tests only | K | Still the message for `grouping: false` with a grouped plan (D4 keeps that option). |
| `NON_CONTIGUOUS_NOT_STREAMED` | const | tests only | K | Still the message for `contiguous: false` (D4). |
| `previewSheet` | function | DE server; README; internals; tests | K | Core of 2.0; gains the binary refusal (D5). |
| `runImport` | function | DE server; README; internals; tests | K | Core of 2.0; gains `signal` and `onProgress` (D2, D3) and grouping on by default (D4). |
| `BatchInfo` | *interface* | DE server; internals; tests | K | Streaming import and preview, the core of 2.0. |
| `ImportRunResult` | *interface* | internals | K | Streaming import and preview, the core of 2.0. |
| `OnBatch` | *type* | DE server; tests | K | Streaming import and preview, the core of 2.0. |
| `PreviewSheetOptions` | *interface* | nobody (appears in signatures only) | K | Streaming import and preview, the core of 2.0. |
| `RunImportOptions` | *interface* | nobody (appears in signatures only) | K | Streaming import and preview, the core of 2.0. |
| `SheetPreview` | *interface* | internals | K | Streaming import and preview, the core of 2.0. |
| `readPlanField` | function | internals | K | Approved to keep: `receiveUpload`'s companion (the plan field must precede the file, and it says so), with the two `INVALID_PLAN` errors an app would otherwise rewrite. |
| `receiveUpload` | function | README; internals | K | Kept by the brief: the upload half of every server pattern, including the polling recipe. |
| `safeFieldName` | function | DE server; tests | **R** | HTTP-only (multipart field names in messages). Used inside `receiveUpload` only; stays there unexported. |
| `Upload` | *interface* | internals; tests | K | Return type of `receiveUpload`. |
| `createImportRouter` | function | DE server; README; tests | **R** | D1. Routes belong to the app. |
| `sendFailure` | function | DE server; tests | **R** | HTTP-only: writes an Express-shaped response (`status().json()`, `removeHeader`, `headersSent`). Used only by the router; DE re-exports it from its router module. |
| `SERVER_FEATURES` | const | only its own module | K | Approved to keep, moved to the main entry next to `planForServer`: the capability vocabulary `planForServer` reads (`features`), not HTTP. `/node` no longer exports it. |
| `templateFilename` | function | DE server; tests | K | A pure string function that makes a schema name safe for `Content-Disposition`; any app serving a template needs it, and DE re-exports it publicly. Approved: moves to write-template.ts. |
| `templateOf` | function | tests only | K | Not HTTP: an adapter's targets as a `TemplateSheet`. The only way to get the router's default template without the router. Approved: moves from router.ts to write-template.ts. |
| `BindingSource` | *type* | nobody (appears in signatures only) | **R** | D1. Router type. |
| `ImportBinding` | *interface* | DE server; tests | **R** | D1. The router's per-name configuration, including the @internal `templateName`, `previewExtras` and `plan`. |
| `ImportErrorReport` | *interface* | tests only | **R** | D1. Argument of the router's `onError`. |
| `ImportHandler` | *type* | nobody (appears in signatures only) | **R** | D1. Router type. |
| `ImportRequest` | *interface* | DE server; README | **R** | D1. Structural request type for the router. `receiveUpload` takes a plain `IncomingMessage`. |
| `ImportResponse` | *interface* | DE server; README | **R** | D1. Structural response type for the router. |
| `ImportRouter` | *interface* | DE server; README | **R** | D1. Structural type of the router the caller passed in. |
| `ImportRouterOptions` | *interface* | tests only | **R** | D1. Options of the removed router, including the @internal `param` and `engineVersion`. |
| `OnImport` | *type* | tests only | **R** | D1. Router callback type. |

### `sheet-to-schema/browser` (8)

| Export | Kind | Used by | 2.0 | Reasoning |
| --- | --- | --- | --- | --- |
| `readSheetFile` | function | DE ngx-dynamic-entity; README; internals; tests | K | Core; gains the binary refusal (D5). |
| `readXlsx` | function | README; tests | K | Reading a file in a browser. |
| `BrowserLimits` | *type* | tests only | K | Reading a file in a browser. |
| `ReadSheetFileOptions` | *interface* | nobody (appears in signatures only) | K | Reading a file in a browser. |
| `SheetFile` | *interface* | nobody (appears in signatures only) | K | Reading a file in a browser. |
| `SheetFileInput` | *type* | internals | K | Reading a CSV file in any runtime. |
| `ImportError` | class | README; internals; tests | K | The one refusal class across all entries; gains code `ABORTED`. |
| `ImportErrorCode` | *type* | internals; tests | K | Gains `ABORTED`. |

### @internal members of exported types

| Member | Owner | 2.0 |
| --- | --- | --- |
| `templateName` | `ImportBinding` | **R** (with its type) |
| `previewExtras` | `ImportBinding` | **R** (with its type) |
| `plan` | `ImportBinding` | **R** (with its type) |
| `param` | `ImportRouterOptions` | **R** (with its type) |
| `engineVersion` | `ImportRouterOptions` | **R** (with its type) |

## Dynamic Entity 4.0, in one list

Everything DE imports from `sheet-to-schema/node` in production that 2.0 removes is in
`packages/server/src/express.ts` and `multipart.ts`:
`createImportRouter`, `sendFailure`, `ImportBinding`, `ImportRequest`, `ImportResponse`,
`ImportRouter`, and `safeFieldName` (re-export, test use only), plus the @internal hooks
`param`, `engineVersion`, `templateName`, `previewExtras` and `plan`. DE core, ngx-dynamic-entity
and the xlsx entry use nothing on the removal list. `templateFilename` stays, so DE's re-export
of it is unchanged.

DE 4.0 writes its four routes from `receiveUpload`, `previewSheet`, `runImport`, `writeTemplate`,
`templateFilename` and `toErrorBody`, keeping its own wire (`engineVersion` = core's, `entity`
param, suggestion extras) and its `createImportRouter` name. It must also pass
`grouping: false` wherever it relies on the 1.x refusal (D4), and expect `UNSUPPORTED_FORMAT` for
binary files that used to be read as CSV (D5).
