// The MIGRATING-2.0 routes on plain node:http: no framework, written from the README's function table.
import { createServer } from 'node:http';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { previewSheet, readPlanField, receiveUpload, resolveLimits, runImport, toErrorBody } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({ $id: 'people', type: 'object', properties: { name: { type: 'string' }, born: { type: 'string', format: 'date' } } });
const limits = resolveLimits({ maxBytes: 20 * 1024 * 1024 });
const save = async records => void records;

const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

async function handle(req) {
  const route = new URL(req.url, 'http://x').pathname;
  if (req.method !== 'POST') return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such route.' } } };
  if (route === '/import/people/preview') {
    const { stream, filename } = await receiveUpload(req, limits);
    return { status: 200, body: await previewSheet({ stream, filename, adapter, limits }) };
  }
  const write = route === '/import/people/import';
  if (!write && route !== '/import/people/validate') return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such route.' } } };
  const { stream, filename, fields } = await receiveUpload(req, limits);
  let plan;
  try {
    plan = readPlanField(fields);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const result = await runImport({ stream, filename, plan, adapter, ctx: undefined, limits, signal: AbortSignal.timeout(10 * 60_000), onBatch: write ? save : undefined });
  return { status: 200, body: { ...result, written: write } };
}

createServer((req, res) => {
  handle(req).then(
    ({ status, body }) => json(res, status, body),
    error => {
      const { status, body } = toErrorBody(error);
      if (status >= 500) console.error(error);
      json(res, status, body);
    },
  );
}).listen(Number(process.env.PORT) || 3000);
