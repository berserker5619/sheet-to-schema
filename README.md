# sheet-to-schema

Turn the rows of a spreadsheet into records that fit a schema you already have.

You describe where records go (a JSON Schema, an example record, or your own adapter). The
library suggests which column feeds which field, lets a person correct that, and then builds
one record per row, or per group of rows, reporting every cell it could not use.

- **Browser-safe core, no dependencies.** The main entry runs in a browser tab or in Node.
- **A streaming server half.** `sheet-to-schema/node` reads CSV and `.xlsx` files of any size
  with memory bounded by a batch, and serves the import over HTTP.
- **The same engine on both sides.** A file imports to the same records in the browser and
  on the server, because both run the same function over the same plan.
- **The same reader on both sides.** `sheet-to-schema/browser` reads a CSV, TSV or `.xlsx`
  file in a browser into exactly the rows the server reads from the same bytes.

> **Status: stable (1.0.0).** It is the import engine of
> [Dynamic Entity](https://github.com/berserker5619/Dynamic-Entity#readme) 3.0, extracted so it can be used without it.
> Members marked `@internal` are not covered by semver and may change in any release.

## Install

```bash
npm install sheet-to-schema
# Only for sheet-to-schema/node and /browser, and only the ones you use:
npm install exceljs   # to read or write .xlsx (on a server or in a browser)
npm install busboy    # to receive uploads
npm install express   # for the ready-made router
```

Node 20 or later for the main entry; the three packages above are optional peers, loaded the
first time they are needed. Reading a CSV needs none of them.

## Quick start

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
**warning**: the record is still imported. Grouping works in `applyMapping` and in the
streaming runner in `/node`, which gives the same records: a group that straddles a batch is
carried into the next one and written whole. The runner groups contiguous rows only (sort the
sheet by the key columns); `contiguous: false` works in `applyMapping` and is refused by the
runner, since it would hold every group to the end of the file.

Grouping is bounded: a group of more than 10,000 rows, more than 200,000 groups, or (for
contiguous groups) more than 8 MiB of group keys stops the import with an `ImportFailure`
(`GROUP_TOO_LARGE` or `TOO_MANY_GROUPS`), as does a key that comes back after its rows ended
(`GROUP_NOT_CONTIGUOUS`). Raise a limit with
`applyMapping(rows, plan, adapter, ctx, { groupLimits: { maxGroupRows: 50_000 } })`, or with the
server's `limits`. Over HTTP these answer 413 and 422.

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

## In a browser: `sheet-to-schema/browser`

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

- **A CSV needs nothing installed.** `exceljs` is loaded with `import()` the first time a
  workbook is read, so a CSV-only app never downloads it. Without it, a workbook fails with
  what to install.
- **The limits are the server's**, with its defaults: `maxBytes`, `maxRows`, `maxColumns`,
  `maxCellLength` and `maxZipEntries`, through `limits`.
- **A workbook's zip is checked by what it declares** (entry count, sizes, compression ratio)
  before ExcelJS sees it. The server also checks what each entry actually inflates to; the
  browser does not, because there the file is the user's own and only their tab is at risk.
- **The first sheet, header row 1**, as on the server.

Known limitations of the browser path:

- **It needs `DecompressionStream`** (every current browser, and Node 20) to read a workbook;
  without it, a workbook fails with a message saying so. A CSV needs nothing.
- **A broken archive may be described differently.** Both readers refuse it, but the server
  reads entries front to back and the browser reads the zip's directory, so the message for a
  damaged `.xlsx` can differ. Every well-formed workbook in the parity fixtures reads the same.

## On a server: `sheet-to-schema/node`

```ts
import express from 'express';
import { createImportRouter } from 'sheet-to-schema/node';

const app = express();
app.use(
  '/import',
  createImportRouter(express.Router(), {
    bindings: { order: { adapter, ctx: undefined, kind: 'json-schema' } },
    dateOrder: 'DMY',
    // Called once per batch, and awaited. It must be idempotent: a client will retry.
    onImport: async (records, { name }) => saveAll(name, records),
  }),
);
```

| Route | What it does |
| --- | --- |
| `GET /:name/template?format=csv\|xlsx` | A blank sheet with the right headers |
| `POST /:name/preview` | Headers, a sample, a suggested plan, and which plan versions this server reads |
| `POST /:name/validate` | The whole import with nothing written: every error, before anything is stored |
| `POST /:name/import` | The import. Multipart: the `plan` field first, then the `file` |

Without Express, call `runImport`, `previewSheet`, `writeTemplate` and `receiveUpload`
yourself; the router is a few lines over them.

The typings need nothing from `@types/express`: the router, request and response are typed by
what the router uses (`ImportRouter`, `ImportRequest`, `ImportResponse`), and an Express 4 or 5
router fits them. A callback that needs more of the request annotates it, and the options take
that type:

```ts
createImportRouter(express.Router(), {
  bindings: (name, request: express.Request & { tenant: string }) => loadBinding(request.tenant, name),
  onImport: async (records, { request }) => saveAll(request.tenant, records), // request is typed the same
});
```

Four things to know before deploying it:

1. **An import is not transactional.** A file that fails at row 30,000 has written 29,999
   records. Run `/validate` first, and make your writer idempotent. A grouped import can stop
   on a group limit or a key that comes back, after earlier groups were written; `/validate`
   runs the same pipeline and finds that first.
2. **Authentication, authorization and concurrency are yours.** The router checks none.
3. **Every limit is on by default**: bytes, rows, columns, cell size, zip expansion, group
   size and count, idle and total time. See `DEFAULT_LIMITS`; pass `limits` to change one.
4. **A client must check what the server reads.** `planForServer(plan, preview)` returns the
   plan to send to that server, or the reason not to: a server from before plan v2 would ignore
   `group` and import one record per row, and a 1.0 server reads plan v2 but refuses `group`.
   A preview lists `planVersions` and, from 1.1, `features` (`["group"]`); a missing `features`
   means the server cannot group. The 1.0 form, `planForServer(plan, preview.planVersions)`,
   still works and checks plan versions only.

## Problem codes

| Prefix | Raised when | Examples |
| --- | --- | --- |
| `PLAN_` | The plan itself is wrong. An error means no row is read. | `PLAN_UNKNOWN_REF`, `PLAN_VERSION`, `PLAN_GROUP` |
| `CELL_` | One cell could not be read. | `CELL_FORMAT`, `CELL_UNKNOWN_OPTION` |
| `RECORD_` | The record built from a row is not valid, or needs a warning. | `RECORD_REQUIRED`, `RECORD_GROUP_CONFLICT` |

`PLAN_PROBLEM_CODES`, `CELL_PROBLEM_CODES` and `RECORD_PROBLEM_CODES` list them all.

A grouped import can also stop as a whole, with an `ImportFailure` (`IMPORT_FAILURE_CODES`).
`applyMapping` and `runImport` throw it; over HTTP it is the error body's `code`:

| Code | HTTP | Raised when |
| --- | --- | --- |
| `GROUP_NOT_CONTIGUOUS` | 422 | A group's key comes back after its rows ended. `details` has the key and both rows. |
| `GROUP_TOO_LARGE` | 413 | A group has more than `maxGroupRows` rows. |
| `TOO_MANY_GROUPS` | 413 | More than `maxGroups` groups, or more than `maxGroupKeyBytes` of group keys. |

## Licence

MIT
