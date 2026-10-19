# sheet-to-schema

Turn the rows of a spreadsheet into records that fit a schema you already have.

You describe where records go (a JSON Schema, an example record, or your own adapter). The
library suggests which column feeds which field, lets a person correct that, and then builds
one record per row, or per group of rows, reporting every cell it could not use.

It is a set of functions: **preview** a file, **validate** it, **import** it. It reads, matches,
validates and streams. Your app owns the routes, the storage, the jobs and the queues.

- **Browser-safe core, no dependencies.** The main entry runs in a browser tab or in Node.
- **A streaming server half.** `sheet-to-schema/node` reads CSV and `.xlsx` files of any size
  with memory bounded by a batch, can be cancelled and reports its progress.
- **The same engine on both sides.** A file imports to the same records in the browser and
  on the server, because both run the same function over the same plan.
- **The same reader on both sides.** `sheet-to-schema/browser` reads a CSV, TSV or `.xlsx`
  file in a browser into exactly the rows the server reads from the same bytes.

> **Status: 2.0 release candidate.** Coming from 1.x: read
> [MIGRATING-2.0.md](https://github.com/berserker5619/sheet-to-schema/blob/main/MIGRATING-2.0.md).
> It is the import engine of [Dynamic Entity](https://github.com/berserker5619/Dynamic-Entity#readme),
> extracted so it can be used without it; Dynamic Entity 3.x stays on the 1.x line, which is
> published under the `release-1.x` dist-tag. Members marked `@internal` are not covered by
> semver and may change in any release.

## Install

```bash
npm install sheet-to-schema
# Only for sheet-to-schema/node and /browser, and only the ones you use:
npm install exceljs   # to read or write .xlsx (on a server or in a browser)
npm install busboy    # to receive uploads
```

Node 20 or later for the main entry; the two packages above are optional peers, loaded the
first time they are needed. Reading a CSV needs none of them, through the main entry's
`readCsvFile`. **`sheet-to-schema/browser` needs `exceljs` installed for a bundled app to
build**, even one that never reads a workbook: see the browser section.

## Preview, validate, import

Three calls on a file, here read from disk. On a server the file comes from an upload; the
recipe [Background imports with polling](#recipe-background-imports-with-polling) shows that.

<!-- compiled: functions -->
```ts
import { readFile } from 'node:fs/promises';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { previewSheet, runImport } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({
  $id: 'order',
  type: 'object',
  required: ['orderId'],
  properties: { orderId: { type: 'string', title: 'Order' }, total: { type: 'number', title: 'Total' } },
});
const file = await readFile('orders.csv');

// 1. Preview: headers, a sample, a row count, and a suggested plan for a person to check.
const preview = await previewSheet({ stream: file, filename: 'orders.csv', adapter });
const plan = preview.suggestion; // as the person corrected it on your mapping screen

// 2. Validate: the whole pipeline, nothing written. Every error, before anything is stored.
const check = await runImport({ stream: file, filename: 'orders.csv', plan, adapter, ctx: undefined });
console.log(`${check.failed} of ${check.rowsRead} rows fail`, check.errors);

// 3. Import: the same pipeline, each batch handed to you and awaited.
if (check.failed === 0) {
  await runImport({
    stream: file,
    filename: 'orders.csv',
    plan,
    adapter,
    ctx: undefined,
    // It must be safe to repeat: an import that stops part-way is run again. Upsert by a key.
    onBatch: async records => {
      for (const order of records) await upsertOrder(order);
    },
  });
}

declare function upsertOrder(order: Record<string, unknown>): Promise<void>;
```

`previewSheet` and `runImport` take a Node stream, a `Buffer`, or any iterable of bytes, and
never hold the file: memory is bounded by `limits.batchSize`. The format is decided by the
bytes, never by the name.

## In memory, anywhere: `applyMapping`

The same engine on rows you already hold, in a browser or in Node:

```ts
import { applyMapping, jsonSchemaAdapter, parseCsv, suggestMapping } from 'sheet-to-schema';

const adapter = jsonSchemaAdapter({
  $id: 'order',
  type: 'object',
  required: ['orderId'],
  properties: {
    orderId: { type: 'string', title: 'Order' },
    placed: { type: 'string', format: 'date', title: 'Placed' },
    tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
    items: {
      type: 'array',
      title: 'Item',
      items: {
        type: 'object',
        properties: { sku: { type: 'string', title: 'SKU' }, qty: { type: 'integer', title: 'Qty' } },
      },
    },
  },
});

const sheet = parseCsv(
  'Order,Placed,Item 1 SKU,Item 1 Qty,Item 2 SKU,Item 2 Qty\n' +
    'A-1,2026-09-05,PEN,2,INK,1\n' +
    'A-2,2026-09-06,PAD,x,,\n',
);

// 1. A suggestion, for a person to check. Anything inferred is tagged `confidence: 'guess'`.
const plan = suggestMapping(sheet.headers, adapter);

// 2. Rows in, records out. The fourth argument is whatever context your adapter wants.
const result = applyMapping(sheet.rows, plan, adapter, undefined);

result.records;
// [{ orderId: 'A-1', placed: '2026-09-05', items: [{ sku: 'PEN', qty: 2 }, { sku: 'INK', qty: 1 }] }]
result.errors;
// [{ row: 3, ref: 'items.0.qty', column: 3, code: 'CELL_FORMAT', message: '"x" is not a number', raw: 'x' }]
```

A row that fails is collected, not thrown, and its record is left out. `row` is the number
the user sees in their spreadsheet: the header is row 1.

## The mapping plan

A plan is plain JSON, so it can be stored, sent to a server, and applied again next month.

```ts
interface MappingPlan {
  planVersion: 2;
  target: string;            // the adapter's id
  schemaVersion?: number;    // the adapter's version when the plan was written
  sourceHeaders?: string[];
  entries: {
    ref: string;             // where the value goes: 'placed', 'items.0.sku'
    column?: number;         // which sheet column, from 0 …
    constant?: unknown;      // … or one value for every row
    split?: string;          // a separator, for a list written in one cell
    dateOrder?: 'DMY' | 'MDY' | 'YMD';
  }[];
  lists?: Record<string, { compact?: boolean }>;
  group?: { key: number[]; collect: string[]; contiguous?: boolean };
}
```

`readPlan` reads a plan from anywhere, including the older v1 shape (`entity`,
`configVersion`), and returns it normalised with every problem it found. Problems carry a
stable `code`; compare that, never the message.

## Three ways a sheet holds a list

**Numbered columns.** `Item 1 SKU`, `Item 2 SKU`: one slot per pair of columns, as in the
quick start. Refs carry the slot: `items.0.sku`, `items.1.sku`. Empty slots are dropped and
the rest renumbered, unless `lists: { items: { compact: false } }`.

**One cell, split.** `rush; gift` in a `Tags` column becomes `['rush', 'gift']`. The default
separator is `;`. An entry's `split` states another.

**One row per item, grouped.** The order repeats on every row and each row carries one item:

```ts
const sheet = parseCsv('Order,Placed,SKU,Qty\nA-1,05/09/2026,PEN,2\nA-1,06/09/2026,INK,1\nA-2,06/09/2026,PAD,4\n');

const plan = {
  planVersion: 2,
  target: 'order',
  entries: [
    { ref: 'orderId', column: 0 },
    { ref: 'placed', column: 1, dateOrder: 'DMY' },
    { ref: 'items.sku', column: 2 }, // no slot: one item per row
    { ref: 'items.qty', column: 3 },
  ],
  group: { key: [0], collect: ['items'] },
};

const result = applyMapping(sheet.rows, plan, adapter, undefined);
result.records;
// [{ orderId: 'A-1', placed: '2026-09-05', items: [{ sku: 'PEN', qty: 2 }, { sku: 'INK', qty: 1 }] },
//  { orderId: 'A-2', placed: '2026-09-06', items: [{ sku: 'PAD', qty: 4 }] }]
result.warnings;
// [{ row: 2, rows: [2, 3], ref: 'placed', code: 'RECORD_GROUP_CONFLICT', message: 'Rows disagree on placed; kept row 2.', raw: '2026-09-06' }]
```

Rows of a group that disagree on a parent field keep the first row's value and raise a
**warning**: the record is still imported. A problem inside one collected item, such as
`items.2.sku` being required, names that item's own row (from 1.3); a problem with the record
as a whole names the group's first row and carries all its rows in `rows`. Grouping works in `applyMapping`, and on the server
`runImport` groups by default from 2.0, giving the same records as `applyMapping` (a group that
straddles a batch is carried into the next one and written whole). With `grouping: false` a
grouped plan is refused, as 1.x did by default. The runner groups
contiguous rows only (sort the sheet by the key columns); `contiguous: false` works in
`applyMapping` and is refused by the runner, since it would hold every group to the end of the
file.

Grouping is bounded: a group of more than 10,000 rows, more than 200,000 groups, or (for
contiguous groups) more than 8 MiB of group keys stops the import with an `ImportFailure`
(`GROUP_TOO_LARGE` or `TOO_MANY_GROUPS`), as does a key that comes back after its rows ended
(`GROUP_NOT_CONTIGUOUS`). Raise a limit with
`applyMapping(rows, plan, adapter, ctx, { groupLimits: { maxGroupRows: 50_000 } })`, or with the
server's `limits`. `toErrorBody` answers these 413 and 422.

## Dates are never guessed

`2026-09-05` is read as written. `05/09/2026` could be 5 September or 9 May, so it is an
error unless something states the order: an entry's `dateOrder`, or the run's
(`applyMapping(rows, plan, adapter, ctx, { dateOrder: 'DMY' })`). The entry wins. Pass a
sample of rows to `suggestMapping(headers, adapter, { sample })` and it states the order for a
column whose values settle it (a `31/08/2026` can only be day first).

## Adapters

An adapter is the one thing that knows your schema. Two ship with the package:

| Adapter | Use it when |
| --- | --- |
| `jsonSchemaAdapter(schema, options?)` | You have a JSON Schema. Types, formats, `enum`, `required`, nested objects, and arrays of objects or of scalars. |
| `exampleJsonAdapter(sample, options?)` | You have one example record and no schema. Types are inferred from its values. |

For anything else, implement `SchemaAdapter`: `id`, `adapterVersion`, and
`targets({ slots, lang })`, which lists every place a value can go. Optional hooks let it read
its own cells (`coerce`), finish a record (`finalize`) and check one (`validate`). That is how
Dynamic Entity's form configs run on this engine.

## In a browser

**CSV only: `readCsvFile`, from the main entry.** It reads a CSV or TSV file exactly as
`readSheetFile` below does, with nothing in its module graph that asks for `exceljs`, so an app
that never installed it builds:

```ts
import { applyMapping, decimalMarkFor, readCsvFile } from 'sheet-to-schema';

const sheet = await readCsvFile(file, { filename: file.name });
const result = applyMapping(sheet.rows, plan, adapter, undefined, { decimal: decimalMarkFor(sheet.delimiter) });
```

The format is still decided by the bytes: an `.xlsx` (or any zip), a pre-2007 `.xls`, a
UTF-16 file and a binary file are refused with `UNSUPPORTED_FORMAT`, with the server's messages
for the last three.

**CSV and `.xlsx`: `sheet-to-schema/browser`.**

```ts
import { applyMapping, decimalMarkFor } from 'sheet-to-schema';
import { readSheetFile } from 'sheet-to-schema/browser';

// `file` from an <input type="file">: a CSV, a TSV or an .xlsx, decided by its bytes.
const sheet = await readSheetFile(file, { filename: file.name });
const result = applyMapping(sheet.rows, plan, adapter, undefined, { decimal: decimalMarkFor(sheet.delimiter) });
```

`readSheetFile` returns the grid the server's `readSheet` reads from the same file: the same
headers, the same rows with the same typed cells (a date cell is a `Date`, a formula is its
cached result), the same separator, and the same refusals, with the server's error codes and
messages. Pass `sheet.delimiter` to `decimalMarkFor`, as the server does, so a semicolon file
reads `1,5` as 1.5 on both sides. `readXlsx` is the same for a caller that already knows the
file is a workbook.

- **Install `exceljs` to build with it.** It is loaded with `import()` the first time a
  workbook is read, so a CSV-only user never downloads it, but a bundler still resolves that
  `import()` when it builds. Without `exceljs` installed, checked in October 2026 (Dynamic
  Entity's 3.1 spec, Step 0):

  | Bundler | Builds? | Reading a workbook |
  | --- | --- | --- |
  | Angular 21 `ng build` | No: `Could not resolve "exceljs"` | — |
  | Angular 21 `ng serve` | Yes | `PEER_MISSING` |
  | Vite 8 (build and dev) | Yes | `PEER_MISSING` |
  | webpack 5 | No: `Can't resolve 'exceljs'` | — |
  | Any of them with `exceljs` marked external | Yes | `PEER_MISSING` (from 1.2.0; the browser's `TypeError` is its `cause`) |

  A CSV read through `/browser` works wherever the app builds. An app that reads only CSV and
  does not install `exceljs` uses `readCsvFile`.
- **A missing `exceljs` is `PEER_MISSING`** (an `ImportError`, from 1.2.0), with
  `details.peer` and what to install. A workbook chunk that failed to download is not: the
  browser's own error (a `TypeError`, or webpack's `ChunkLoadError`) passes through as it is.
- **The limits are the server's**, with its defaults: `maxBytes`, `maxRows`, `maxColumns`,
  `maxCellLength` and `maxZipEntries`, through `limits`.
- **A workbook's zip is checked by what it declares** (entry count, sizes, compression ratio)
  before ExcelJS sees it. The server also checks what each entry actually inflates to; the
  browser does not, because there the file is the user's own and only their tab is at risk.
- **The first sheet, header row 1**, as on the server.

Known limitations of reading a file, everywhere:

- **Binary is recognised by a NUL byte in the first 8 KB.** That catches images, executables
  and most PDFs, but a file with no NUL byte in its first 8 KB, such as some PDFs whose
  opening objects are all text, is still read as CSV, into rows of nonsense that the mapping
  then reports cell by cell. Check a file's type yourself first if that matters to you.

Known limitations of the browser path:

- **A workbook needs `DecompressionStream` with the `deflate-raw` format.** A CSV needs
  nothing.

  | Runtime | Reads a workbook from |
  | --- | --- |
  | Chrome, Edge (desktop and Android) | 103 |
  | Firefox (desktop and Android) | 113 |
  | Safari (macOS and iOS) | 16.4 |
  | Node | 20.12 |

  The browser versions are MDN browser-compat-data 8.1.6's for `deflate-raw`; Node 20.12 is
  tested (20.11 lacks it). On an older runtime a workbook fails with `UNSUPPORTED_RUNTIME`,
  saying which versions can read one; a CSV still reads. `/node` and the main entry still need
  only Node 20.
- **A broken archive may be described differently.** Both readers refuse it, but the server
  reads entries front to back and the browser reads the zip's directory, so the message for a
  damaged `.xlsx` can differ. Every well-formed workbook in the parity fixtures reads the same.

## On a server: `sheet-to-schema/node`

Functions, not routes: the app owns its routes, storage and jobs, and calls these from them.

| Function | What it does |
| --- | --- |
| `receiveUpload(request, limits)` | One file and the fields before it out of a multipart request, streamed |
| `readPlanField(fields)` | The JSON `plan` field, refused with `INVALID_PLAN` when missing or not JSON |
| `previewSheet({ stream, adapter })` | Headers, a sample, a row count and a suggested plan |
| `runImport({ stream, plan, adapter, ctx, onBatch })` | The import, a batch at a time; without `onBatch`, a validation that writes nothing |
| `writeTemplate({ sheet, format, out })`, `templateOf`, `templateFilename` | A blank sheet with the right headers |
| `toErrorBody(error)` | Anything thrown as a status and a body that says nothing about internals |

`runImport` also takes:

- **`signal`**, an `AbortSignal`. Aborted, the run stops reading at once and starts no new batch;
  an `onBatch` already running is waited for, never cut off. It then rejects with `ABORTED`, its
  `details` the counts so far. `signal: AbortSignal.timeout(10 * 60_000)` bounds a run's time.
- **`onProgress`**, told `{ bytesRead, rowsRead }` after each batch and at the end, when
  `bytesRead` is the file's size: `bytesRead / size` is a progress bar. Never awaited; a callback
  that throws does not affect the import.
- **`grouping`**, `true` by default: a plan with a contiguous `group` streams. `false` refuses one.

A request that holds a large import open will be cut off by something on the way; the recipe
below does it in the background instead.

Four things to know before deploying it:

1. **An import is not transactional.** A file that fails at row 30,000 has written 29,999
   records. Validate first (`runImport` without `onBatch`), and make your writer idempotent. A
   grouped import can stop on a group limit or a key that comes back, after earlier groups were
   written; validating runs the same pipeline and finds that first.
2. **Authentication, authorization and concurrency are yours.** The functions check none.
3. **Every limit is on by default**: bytes, rows, columns, cell size, zip expansion, group
   size and count, and how long an upload may stall (`receiveUpload`). See `DEFAULT_LIMITS`;
   pass `limits` to change one.
4. **A client must check what the server reads.** `planForServer(plan, preview)` returns the
   plan to send to that server, or the reason not to: a server from before plan v2 would ignore
   `group` and import one record per row, and a 1.0 server reads plan v2 but refuses `group`.
   A server's preview lists `planVersions` and `features` (`SERVER_FEATURES`, `["group"]`, when
   it groups); a missing `features` means the server will not group. The 1.0 form,
   `planForServer(plan, preview.planVersions)`, still works and checks plan versions only.

## Recipe: background imports with polling

The recommended way to import a large file on a server. Upload it once, then preview, validate
and import it from your own storage, as jobs a client polls.

**Why poll.** A 200,000-row import that writes to a database takes minutes. Something between
the browser and your server, such as a load balancer, a proxy or a platform router, commonly
cuts a request off after 30 to 100 seconds. If the import runs inside that request, the client
sees a failure while the server is still writing. The client cannot tell how far it got, and
when it retries it imports the same rows again. With polling, each request is short and the
import is a job: it runs as long as it needs, reports its progress, and can be cancelled.

The pieces, all in the code below:

1. **Upload once.** `receiveUpload` streams the file to private storage your app owns: not
   web-served, named by a random id (never by the client's filename), and given an expiry.
2. **Preview** with `previewSheet`, reading the stored file.
3. **Validate and import as background jobs** with `runImport` over the stored file. Validation
   is the same pipeline with an `onBatch` that writes nothing.
4. **Progress** is `bytesRead / size`, from `onProgress`.
5. **Cancel** with an `AbortController`. The batch being written finishes, and no new batch
   starts.
6. **`onBatch` is safe to repeat.** A job that failed or was cancelled part-way is run again, so
   it upserts by a key rather than inserting.
7. **Clean up.** The file is deleted after the import, and an hourly sweep deletes anything past
   its expiry: uploads nobody imported, or files left behind by a crash.

Wire each exported function to a route of your own, behind your authentication:
`POST /uploads` → `upload`, `GET /uploads/:id/preview` → `preview`,
`POST /uploads/:id/validate` and `/import` → `start`, `GET /jobs/:id` → `status`,
`DELETE /jobs/:id` → `cancel`. Answer a failure with `toErrorBody(error)`.

<!-- compiled: polling -->
```ts
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImportError, jsonSchemaAdapter } from 'sheet-to-schema';
import { previewSheet, receiveUpload, resolveLimits, runImport, toErrorBody, type ImportRunResult } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({
  $id: 'order',
  type: 'object',
  required: ['orderId'],
  properties: { orderId: { type: 'string', title: 'Order' }, total: { type: 'number', title: 'Total' } },
});
const limits = resolveLimits({ maxBytes: 200 * 1024 * 1024, maxRows: 2_000_000 });

// Private storage: outside anything a web server serves, readable by this process only.
const UPLOADS = process.env.IMPORT_DIR ?? '/var/lib/myapp/imports';
const TTL_MS = 24 * 60 * 60 * 1000;

interface Stored {
  id: string;
  path: string;
  filename: string;
  size: number;
  expiresAt: number;
}

interface Job {
  id: string;
  kind: 'validate' | 'import';
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** 0 to 1: bytes read over the file's size. */
  progress: number;
  result?: ImportRunResult;
  error?: { code: string; message: string };
  controller: AbortController;
}

// In memory to keep the recipe short. In production, rows in your database, so that a status
// survives a restart and any instance can answer a poll.
const uploads = new Map<string, Stored>();
const jobs = new Map<string, Job>();

/** POST /uploads: the file, once, streamed to disk. Answers with an id as soon as it is stored. */
export async function upload(request: IncomingMessage): Promise<{ uploadId: string }> {
  const { stream, filename } = await receiveUpload(request, limits);
  await mkdir(UPLOADS, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const path = join(UPLOADS, id);
  try {
    // receiveUpload enforces limits.maxBytes and idleTimeoutMs as the bytes arrive.
    await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  uploads.set(id, { id, path, filename, size: (await stat(path)).size, expiresAt: Date.now() + TTL_MS });
  return { uploadId: id };
}

/** GET /uploads/:id/preview: headers, a sample, a row count and a suggested plan. */
export async function preview(uploadId: string) {
  const stored = storedFile(uploadId);
  return previewSheet({ stream: createReadStream(stored.path), filename: stored.filename, adapter, limits });
}

/** POST /uploads/:id/validate or /import, with the plan: starts a job and answers at once. */
export function start(uploadId: string, kind: Job['kind'], plan: unknown): { jobId: string } {
  const stored = storedFile(uploadId);
  const job: Job = { id: randomUUID(), kind, state: 'running', progress: 0, controller: new AbortController() };
  jobs.set(job.id, job);

  runImport({
    stream: createReadStream(stored.path),
    filename: stored.filename,
    plan,
    adapter,
    ctx: undefined,
    limits,
    signal: job.controller.signal,
    // Validation is the same pipeline with an onBatch that writes nothing.
    onBatch: kind === 'import' ? upsertOrders : () => {},
    onProgress: ({ bytesRead }) => {
      job.progress = stored.size ? bytesRead / stored.size : 1;
    },
  }).then(
    result => {
      Object.assign(job, { state: 'done', progress: 1, result });
      // Imported: the file has done its job. A validated file stays for the import.
      if (kind === 'import') void forget(stored.id);
    },
    (error: unknown) => {
      const { body } = toErrorBody(error);
      Object.assign(job, { state: body.error.code === 'ABORTED' ? 'cancelled' : 'failed', error: body.error });
    },
  );
  return { jobId: job.id };
}

/** GET /jobs/:id: what the client polls, every second or two, until `state` is not `running`. */
export function status(jobId: string): Omit<Job, 'controller'> {
  const { controller: _controller, ...visible } = jobFor(jobId);
  return visible;
}

/** DELETE /jobs/:id: cancel. Rows already written stay written; run the import again to finish. */
export function cancel(jobId: string): void {
  jobFor(jobId).controller.abort();
}

/**
 * Where records go. **Safe to repeat**: a job that stopped part-way is run again from the top,
 * so every write is an upsert on a key the file carries.
 */
async function upsertOrders(records: Record<string, unknown>[]): Promise<void> {
  // For example: INSERT … ON CONFLICT (order_id) DO UPDATE SET total = EXCLUDED.total
  void records;
}

function storedFile(uploadId: string): Stored {
  const stored = uploads.get(uploadId);
  if (!stored || stored.expiresAt < Date.now()) throw new ImportError('NO_FILE', 'No such upload, or it has expired.');
  return stored;
}

function jobFor(jobId: string): Job {
  const job = jobs.get(jobId);
  if (!job) throw new ImportError('NO_FILE', 'No such job.');
  return job;
}

async function forget(uploadId: string): Promise<void> {
  const stored = uploads.get(uploadId);
  uploads.delete(uploadId);
  if (stored) await rm(stored.path, { force: true });
}

// The sweep: by the files' own age, so it also finds what a crash left behind.
setInterval(async () => {
  const names = await readdir(UPLOADS).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(UPLOADS, name);
    const { mtimeMs } = await stat(path);
    if (Date.now() - mtimeMs > TTL_MS) await forget(name).then(() => rm(path, { force: true }));
  }
}, 60 * 60 * 1000).unref();
```

A job still running when its file expires keeps reading it: on Linux and macOS, deleting a file
does not close a stream that has it open. Set the expiry well beyond your longest import.

## Problem codes

| Prefix | Raised when | Examples |
| --- | --- | --- |
| `PLAN_` | The plan itself is wrong. An error means no row is read. | `PLAN_UNKNOWN_REF`, `PLAN_VERSION`, `PLAN_GROUP` |
| `CELL_` | One cell could not be read. | `CELL_FORMAT`, `CELL_UNKNOWN_OPTION` |
| `RECORD_` | The record built from a row is not valid, or needs a warning. | `RECORD_REQUIRED`, `RECORD_GROUP_CONFLICT` |

`PLAN_PROBLEM_CODES`, `CELL_PROBLEM_CODES` and `RECORD_PROBLEM_CODES` list them all. A
server's `PLAN_GROUP` refusal of a valid grouped plan also carries a `reason` (from 1.2.0):
`grouping-disabled` (`runImport` was called with `grouping: false`) or `non-contiguous`
(`group.contiguous: false`, which the server never streams). Compare `reason`, never the
message.

A grouped import can also stop as a whole, with an `ImportFailure` (`IMPORT_FAILURE_CODES`).
`applyMapping` and `runImport` throw it; in `toErrorBody`'s body it is the `code`. And the
readers can refuse to read a file at all, or a run can be stopped, with an `ImportError` (the
main entry exports it from 1.2.0, for `readCsvFile`). Each code has the HTTP status
`toErrorBody` answers with; among them:

| Code | HTTP | Raised when |
| --- | --- | --- |
| `UNSUPPORTED_FORMAT` | 415 | The bytes are not a CSV or an `.xlsx`: a pre-2007 `.xls`, UTF-16 text, or (from 2.0) binary, meaning a NUL byte in the first 8 KB, as in an image or most PDFs. |
| `ABORTED` | 499 | `runImport`'s `signal` aborted (2.0). `details` has `rowsRead`, `imported` and `failed`; `cause` is the signal's reason. |
| `TIMEOUT` | 408 | `receiveUpload`: the upload sent nothing for `limits.idleTimeoutMs`, or ended before the file did. |
| `UNSUPPORTED_RUNTIME` | (browser only) | `sheet-to-schema/browser` is asked to read a workbook where there is no `DecompressionStream` with `deflate-raw` (see the browser section for versions). A CSV is not affected. |
| `PEER_MISSING` | (answered as `INTERNAL`, 500) | An optional peer the call needs is not installed: `exceljs` for a workbook, `busboy` for an upload. `details.peer` names it. A server's client is told only `INTERNAL`. |
| `GROUP_NOT_CONTIGUOUS` | 422 | A group's key comes back after its rows ended. `details` has the key and both rows. |
| `GROUP_TOO_LARGE` | 413 | A group has more than `maxGroupRows` rows. |
| `TOO_MANY_GROUPS` | 413 | More than `maxGroups` groups, or more than `maxGroupKeyBytes` of group keys. |

## Licence

MIT
