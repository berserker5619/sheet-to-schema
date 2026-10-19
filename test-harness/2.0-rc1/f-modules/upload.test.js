const { createServer } = require('node:http');
const fs = require('node:fs');
const { jsonSchemaAdapter } = require('sheet-to-schema');
const { readPlanField, readSheet, receiveUpload, resolveLimits, runImport, toErrorBody } = require('sheet-to-schema/node');

const adapter = jsonSchemaAdapter({ $id: 'p', type: 'object', properties: { name: { type: 'string' } } });
const plan = { planVersion: 2, target: 'p', entries: [{ ref: 'name', column: 0 }] };

test('reads a workbook', async () => {
  const sheet = await readSheet({ stream: fs.readFileSync(__dirname + '/case1_1904_dates.xlsx'), filename: 'x.xlsx' });
  expect(sheet.headers).toEqual(['Name', 'BirthDate', 'JoinDate']);
});

test('receives an upload and imports it; a cancelled run rejects ABORTED with counts', async () => {
  const written = [];
  const server = createServer(async (req, res) => {
    try {
      const upload = await receiveUpload(req, resolveLimits({ batchSize: 100 }));
      const controller = new AbortController();
      const result = await runImport({
        stream: upload.stream, plan: readPlanField(upload.fields), adapter, ctx: undefined, limits: { batchSize: 100 },
        signal: req.url === '/cancel' ? controller.signal : undefined,
        onBatch: async records => { written.push(records.length); if (req.url === '/cancel' && written.length === 2) controller.abort(); },
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      const { status, body } = toErrorBody(error);
      res.writeHead(status).end(JSON.stringify(body));
    }
  }).listen(0);
  try {
    let csv = 'Name\r\n'; for (let i = 0; i < 1000; i++) csv += `P${i}\r\n`;
    const post = async path => {
      const form = new FormData();
      form.append('plan', JSON.stringify(plan));
      form.append('file', new Blob([csv]), 'p.csv');
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: form });
      return { status: response.status, body: await response.json() };
    };
    const ok = await post('/');
    expect(ok.status).toBe(200);
    expect(ok.body.imported).toBe(1000);
    written.length = 0;
    const cancelled = await post('/cancel');
    expect(cancelled.status).toBe(499);
    expect(cancelled.body.error.code).toBe('ABORTED');
    expect(cancelled.body.error.details).toEqual({ rowsRead: 200, imported: 200, failed: 0 });
    expect(written).toEqual([100, 100]);
  } finally {
    server.close();
  }
});
