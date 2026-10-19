# Migrating to sheet-to-schema 2.0

2.0 makes sheet-to-schema a set of functions. It reads, matches, validates and streams. Your app
owns the routes, the storage, the jobs and the queues. Everything that does that work in 1.x is
still here. What is gone is the router built on top of it.

Most apps change one of these things:

1. [You used `createImportRouter`](#replacing-createimportrouter): write the routes from the
   functions. A complete Express example follows.
2. [You import grouped plans on the server](#grouping-is-on-by-default), or rely on their
   refusal.
3. [You accepted any file as CSV](#binary-files-are-refused).
4. [You import one of the removed names](#removed-exports).

Staying on 1.x is fine: `npm install sheet-to-schema@release-1.x`, or keep a `^1.3.0` range. The
1.x line receives fixes on the `1.x` branch. Dynamic Entity 3.x stays on it.

## Replacing `createImportRouter`

The router was four routes over `receiveUpload`, `previewSheet`, `runImport` and
`writeTemplate`. Here are three of them in Express, complete. The template route follows below.

<!-- compiled: express-example -->
```ts
import express from 'express';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { previewSheet, readPlanField, receiveUpload, resolveLimits, runImport, toErrorBody } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({ $id: 'people', type: 'object', properties: { name: { type: 'string' }, born: { type: 'string', format: 'date' } } });
const limits = resolveLimits({ maxBytes: 20 * 1024 * 1024 });
// Where records go. It must be safe to repeat: a client retries an import that stopped part-way.
const save = async (records: Record<string, unknown>[]): Promise<void> => void records;

// An async handler, answered with its result, or with toErrorBody for anything thrown.
const route = (handler: (req: express.Request) => Promise<unknown>): express.RequestHandler => (req, res) => {
  handler(req).then(body => res.json(body), (error: unknown) => {
    const { status, body } = toErrorBody(error);
    if (status >= 500) console.error(error); // what the router's onError was for
    res.status(status).json(body);
  });
};

const app = express();
app.post('/import/people/preview', route(async req => {
  const { stream, filename } = await receiveUpload(req, limits);
  return previewSheet({ stream, filename, adapter, limits });
}));
for (const write of [false, true]) {
  app.post(`/import/people/${write ? 'import' : 'validate'}`, route(async req => {
    const { stream, filename, fields } = await receiveUpload(req, limits);
    const plan = (() => { try { return readPlanField(fields); } catch (error) { stream.destroy(); throw error; } })();
    const signal = AbortSignal.timeout(10 * 60_000); // was limits.totalTimeoutMs
    return { ...(await runImport({ stream, filename, plan, adapter, ctx: undefined, limits, signal, onBatch: write ? save : undefined })), written: write };
  }));
}
app.listen(Number(process.env.PORT) || 3000);
```

The client is unchanged. The multipart body still carries the `plan` field first, then the
`file`. For a large file, request timeouts are the next thing you will meet. The README's recipe
[Background imports with polling](https://github.com/berserker5619/sheet-to-schema#recipe-background-imports-with-polling)
runs the same calls as jobs.

**The template route**, if you served one:

<!-- compiled: template-route -->
```ts
import express from 'express';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { TEMPLATE_MEDIA_TYPE, templateFilename, templateOf, toErrorBody, writeTemplate } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({ $id: 'people', type: 'object', properties: { name: { type: 'string' } } });
const app = express();

app.get('/import/people/template', (req, res) => {
  const format = req.query['format'] === 'xlsx' ? 'xlsx' : 'csv';
  res.setHeader('Content-Type', TEMPLATE_MEDIA_TYPE[format]);
  // Named from the schema, never from the request, and safe in a header.
  res.setHeader('Content-Disposition', `attachment; filename="${templateFilename(adapter.id, format)}"`);
  writeTemplate({ sheet: templateOf(adapter, 'en', undefined), format, out: res }).catch((error: unknown) => {
    // Part of the file may already be sent; ending the connection is what tells the client.
    if (res.headersSent) res.destroy();
    else res.status(toErrorBody(error).status).json(toErrorBody(error).body);
  });
});
```

What each router option became:

| 1.x option | In 2.0 |
| --- | --- |
| `bindings` | Your own lookup of an adapter and its context, by whatever your route says |
| `onImport(records, { name, binding, request })` | `runImport`'s `onBatch(records, info)`; close over the request yourself |
| `limits` | `resolveLimits(...)`, passed to `receiveUpload`, `previewSheet` and `runImport` |
| `limits.idleTimeoutMs` | Unchanged. `receiveUpload` now enforces it itself |
| `limits.totalTimeoutMs` | Removed. Use `runImport({ ..., signal: AbortSignal.timeout(ms) })` |
| `lang` | `previewSheet({ lang })`, `templateOf(adapter, lang, fields)` |
| `dateOrder` | `runImport({ dateOrder })`. Add it to your preview answer if your client reads it |
| `grouping` | `runImport({ grouping })`, `true` by default now. Send `features: SERVER_FEATURES` on a preview so `planForServer` lets a client send grouped plans |
| `onError` | Your own `catch`: `toErrorBody(error).status >= 500` is the same condition |
| The `engineVersion`, `adapter` and `planVersions` stamps | Add them to your answers if your clients compare them (`IMPORTER_VERSION`, `PLAN_VERSIONS`) |

`express` is no longer a peer dependency. The package never imported it. Install it in your
app if your app uses it.

## Grouping is on by default

`runImport` streams a plan with `group` (contiguous groups) unless you pass `grouping: false`.
In 1.x it refused such a plan unless you passed `grouping: true`.

- **You passed `grouping: true`:** nothing changes. You can drop the option.
- **You relied on the refusal:** pass `grouping: false`. The refusal is the same as before:
  `INVALID_PLAN` with a `PLAN_GROUP` problem whose `reason` is `grouping-disabled`.
- `group.contiguous: false` is still refused, either way, with `reason: 'non-contiguous'`.

## Binary files are refused

1.x read any file that was not a zip, an `.xls` or UTF-16 as CSV, so an image or a PDF became a
sheet of nonsense rows. 2.0 refuses a file with a NUL byte in its first 8 KB with
`UNSUPPORTED_FORMAT` and the message
`This file is not a spreadsheet: it holds binary data. Save it as .xlsx or as UTF-8 CSV and try again.`
`readSheet`, `previewSheet`, `runImport`, `readSheetFile` and `readCsvFile` all refuse it the
same way.

Every CSV 1.x read still reads, byte for byte: UTF-8 with or without a BOM, comma, semicolon and
tab separators, and quoted cells over several lines. UTF-8 text has no NUL bytes. A NUL after the
first 8 KB is read as text, as before.

## Removed exports

From `sheet-to-schema/node`:

| Removed | Use instead |
| --- | --- |
| `createImportRouter` | Your routes, from the functions (above) |
| `ImportRouterOptions` | The functions' own options |
| `ImportBinding`, `BindingSource` | Your own lookup of an adapter and its context |
| `OnImport` | `OnBatch` |
| `ImportRouter`, `ImportHandler`, `ImportRequest`, `ImportResponse` | Your framework's types. `receiveUpload` takes a Node `IncomingMessage` |
| `ImportErrorReport` | Your own `catch` |
| `sendFailure` | `const { status, body } = toErrorBody(error); res.status(status).json(body)`, or `res.destroy()` once headers are sent |
| `safeFieldName` | Nothing. `receiveUpload` still uses it for its own messages |
| `SERVER_FEATURES` | The same constant, from the main entry: `import { SERVER_FEATURES } from 'sheet-to-schema'` |
| `ImportLimits.totalTimeoutMs` | `signal: AbortSignal.timeout(ms)` on `runImport` |

The @internal router hooks (`param`, `engineVersion`, `templateName`, `previewExtras`, `plan`)
went with the router.

## New in 2.0

- `runImport({ signal })`. Aborted, the run stops reading and starts no new batch. An `onBatch`
  already running is waited for. The run then rejects with the new code `ABORTED` (status 499),
  and its `details` are `{ rowsRead, imported, failed }`.
- `runImport({ onProgress })` is told `{ bytesRead, rowsRead }` after each batch and at the end.
- `receiveUpload` enforces `limits.idleTimeoutMs`.

The package itself no longer raises `UNKNOWN_ENTITY`. It stays in `ImportErrorCode` for routes
that use it.
