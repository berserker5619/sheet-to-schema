# sheet-to-schema

A backend import engine for Node. It streams CSV and `.xlsx` files of any size, matches their
columns to the schema you already have, validates every row, groups rows into records, and runs
large imports as background jobs a client polls. It is a set of functions: **preview** a file,
**validate** it, **import** it. Your app owns the routes, the storage, the jobs and the queues.

- **Streaming.** `sheet-to-schema/node` reads a file a batch at a time, so memory is bounded by
  the batch, not the file. A run can be cancelled (`signal`) and reports its progress
  (`onProgress`).
- **Column matching.** You describe where records go: a JSON Schema, an example record, or your
  own adapter. The engine suggests which column feeds which field, for a person to correct.
- **Validation.** Every cell and every record is checked against the schema, and every problem
  is reported with the spreadsheet row the user sees. Validating is an import that writes nothing.
- **Grouping.** Rows that repeat a key become one record with its items collected.
- **Background imports with polling.** The recipe below uploads once, then validates and imports
  as jobs with progress and cancel, for files too large to import inside one request.

> **Status: stable (2.0).** Coming from 1.x: read
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
`readCsvFile`. The browser readers are described near the end, under
[Reading files in the browser](#reading-files-in-the-browser-maintained-no-new-features).

## Server quick start

Three calls on a file, here read from disk. On a server the file comes from an upload; the
[recipe](#recipe-background-imports-with-polling) below shows that.

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

**A group in a suggestion is always a guess.** When the rows repeat an id-like key, the
suggestion carries `group` (one record per key, collecting the array that varies) and marks the
entries it collects `confidence: 'guess'`. The plan has no confidence of its own for the group,
so a UI should always present `suggestion.group` for the person to confirm or remove: the same
file read as one record per row is a different import.

`previewSheet` and `runImport` take a Node stream, a `Buffer`, or any iterable of bytes, and
never hold the file: memory is bounded by `limits.batchSize`. The format is decided by the
bytes, never by the name.

### The functions

The app owns its routes, storage and jobs, and calls these from them.

| Function | What it does |
| --- | --- |
| `receiveUpload(request, limits)` | One file and the fields before it out of a multipart request, streamed |
| `readPlanField(fields)` | The JSON `plan` field, refused with `INVALID_PLAN` when missing or not JSON |
| `previewSheet({ stream, adapter })` | Headers, a sample, a row count and a suggested plan, made from the first rows as in a browser, so it proposes a group where the rows settle one |
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
4. **Progress** is `bytesRead / size`, from `onProgress`. The bar is approximate: `bytesRead`
   counts what the reader has pulled from the file, read-ahead included, so it runs a little
   ahead of the rows and moves in steps of the stream's chunks. Show `rowsRead` beside it; that
   is the exact count.
5. **Cancel** with an `AbortController`. The batch being written finishes, and no new batch
   starts.
6. **`onBatch` is safe to repeat.** A job that failed or was cancelled part-way is run again, so
   it upserts by a key rather than inserting.
7. **Clean up.** A validation that finishes keeps the file, with or without row errors: the
   user may fix nothing and import the valid rows anyway, and the import reads that file. Every
   other end deletes it, in a `finally`: an import that finishes, a cancel, a failure. The
   hourly sweep removes abandoned files, uploads validated and never imported or left behind by
   a crash, once they are past their expiry.

**To let a user retry** a cancelled or failed import without uploading again, keep the file on
purpose: skip `forget` for that outcome and let `expiresAt` bound how long it waits, so the
sweep still removes it. Do it deliberately, and tell the user how long their file is kept.

**On Windows**, the modes below (`0o700`, `0o600`) are ignored: Node creates the files readable
by any account that can read the folder. Give the recipe a dedicated folder whose permissions
(its ACL) admit only the account the server runs as.

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
// (On Windows the modes are ignored; restrict the folder's ACL instead.)
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
  /** 0 to 1: bytes read over the file's size. Approximate: it includes the reader's read-ahead. */
  progress: number;
  /** Rows read so far: the exact count, to show beside the bar. */
  rowsRead: number;
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
  const job: Job = { id: randomUUID(), kind, state: 'running', progress: 0, rowsRead: 0, controller: new AbortController() };
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
    onProgress: ({ bytesRead, rowsRead }) => {
      job.progress = stored.size ? bytesRead / stored.size : 1;
      job.rowsRead = rowsRead;
    },
  })
    .then(
      result => {
        Object.assign(job, { state: 'done', progress: 1, rowsRead: result.rowsRead, result });
      },
      (error: unknown) => {
        const { body } = toErrorBody(error);
        Object.assign(job, { state: body.error.code === 'ABORTED' ? 'cancelled' : 'failed', error: body.error });
      },
    )
    .finally(() => {
      // A validation that finished keeps the file, row errors or not: the user may import anyway,
      // and the import reads it. Any other end deletes it: an import that finished, a cancel, a
      // failure. The user's data is kept no longer than it is used; the sweep takes the rest.
      if (!(kind === 'validate' && job.state === 'done')) void forget(stored.id);
    });
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

## Plans

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

### Three ways a sheet holds a list

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

### Dates are never guessed

`2026-09-05` is read as written. `05/09/2026` could be 5 September or 9 May, so it is an
error unless something states the order: an entry's `dateOrder`, or the run's
(`applyMapping(rows, plan, adapter, ctx, { dateOrder: 'DMY' })`). The entry wins. Pass a
sample of rows to `suggestMapping(headers, adapter, { sample })` and it states the order for a
column whose values settle it (a `31/08/2026` can only be day first).

### Applying a plan in memory: `applyMapping`

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
| `UNSUPPORTED_RUNTIME` | (browser only) | `sheet-to-schema/browser` is asked to read a workbook where there is no `DecompressionStream` with `deflate-raw` (see [Reading files in the browser](#reading-files-in-the-browser-maintained-no-new-features) for versions). A CSV is not affected. |
| `PEER_MISSING` | (answered as `INTERNAL`, 500) | An optional peer the call needs is not installed: `exceljs` for a workbook, `busboy` for an upload. `details.peer` names it. A server's client is told only `INTERNAL`. |
| `GROUP_NOT_CONTIGUOUS` | 422 | A group's key comes back after its rows ended. `details` has the key and both rows. |
| `GROUP_TOO_LARGE` | 413 | A group has more than `maxGroupRows` rows. |
| `TOO_MANY_GROUPS` | 413 | More than `maxGroups` groups, or more than `maxGroupKeyBytes` of group keys. |

## Limits

Every limit has a finite default and is enforced while the file streams, never after it has
been read. Pass `limits` (a partial `ImportLimits`) to `receiveUpload`, `previewSheet`,
`runImport` or the readers to change one; `resolveLimits` fills in the rest, and ignores a value
that is not a positive finite number. `DEFAULT_LIMITS` holds them all.

| Limit | Default | Bounds | Enforced by |
| --- | --- | --- | --- |
| `maxBytes` | 10 MiB | the upload or file | every reader, `receiveUpload` |
| `maxFields`, `maxFieldBytes`, `maxFieldNameBytes`, `maxFiles` | 16, 1 MiB, 200 B, 1 | multipart fields and files | `receiveUpload` |
| `idleTimeoutMs` | 30 s | an upload that stops sending | `receiveUpload` |
| `maxRows`, `maxColumns`, `maxCellLength` | 200,000, 512, 32,768 | the sheet | every reader |
| `maxUncompressedBytes`, `maxCompressionRatio`, `maxZipEntries` | 200 MiB, 200, 512 | an `.xlsx`'s zip | the workbook readers |
| `batchSize` | 500 | rows held and handed to `onBatch` at a time | `runImport` |
| `maxReportedErrors` | 200 | errors and warnings retained (counts stay exact) | `runImport` |
| `sampleRows` | 5 | rows in a preview's `sample` | `previewSheet` |
| `maxGroupRows`, `maxGroups`, `maxGroupKeyBytes` | 10,000, 200,000, 8 MiB | grouping | `runImport`, `applyMapping` |

A whole run has no time limit of its own: bound it with `signal: AbortSignal.timeout(ms)`.

Known limitations of reading a file:

- **Binary is recognised by a NUL byte in the first 8 KB.** That catches images, executables
  and most PDFs, but a file with no NUL byte in its first 8 KB, such as some PDFs whose
  opening objects are all text, is still read as CSV, into rows of nonsense that the mapping
  then reports cell by cell. Check a file's type yourself first if that matters to you.
- **The first sheet, header row 1.** A workbook's other sheets, and rows above the header, are
  not read.

## Reading files in the browser (maintained, no new features)

The readers below are maintained, with fixes, and get no new features: new work goes to the
server side. They read a file in a browser tab into exactly the grid `readSheet` reads on the
server from the same bytes, with the same refusals, codes and messages.

**CSV only: `readCsvFile`, from the main entry.** Nothing in its module graph asks for
`exceljs`, so an app that never installed it builds:

```ts
import { applyMapping, decimalMarkFor, readCsvFile } from 'sheet-to-schema';

const sheet = await readCsvFile(file, { filename: file.name });
const result = applyMapping(sheet.rows, plan, adapter, undefined, { decimal: decimalMarkFor(sheet.delimiter) });
```

**CSV and `.xlsx`: `readSheetFile` from `sheet-to-schema/browser`** (`readXlsx` for a file
known to be a workbook):

```ts
import { readSheetFile } from 'sheet-to-schema/browser';

const sheet = await readSheetFile(file, { filename: file.name });
```

- **`exceljs` must be installed for a bundled app to build**, even one that never reads a
  workbook: it is loaded with `import()` on the first workbook, but Angular's `ng build` and
  webpack still resolve it. Without it, a workbook read fails with `PEER_MISSING`; an app that
  reads only CSV uses `readCsvFile`.
- **A workbook needs `DecompressionStream` with `deflate-raw`**: Chrome and Edge 103, Firefox
  113, Safari 16.4, Node 20.12. Elsewhere a workbook fails with `UNSUPPORTED_RUNTIME`; a CSV
  still reads.
- **The limits are the server's** (`maxBytes`, `maxRows`, `maxColumns`, `maxCellLength`,
  `maxZipEntries`). A workbook's zip is checked by what it declares; only the server also
  checks what each entry inflates to.

## Licence

MIT
