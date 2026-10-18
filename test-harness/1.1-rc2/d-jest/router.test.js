const fs = require('node:fs'); const path = require('node:path'); // Jest's expect, not node:assert: what fetch parses is built in Node's realm, not the test sandbox's, and node:assert's strict deep-equality compares prototypes.
const assert = { equal: (a, b) => expect(a).toBe(b), deepEqual: (a, b) => expect(a).toEqual(b) }; const express = require('express');
const { applyMapping, jsonSchemaAdapter, parseCsv, planForServer, suggestMapping } = require('sheet-to-schema');
const { createImportRouter, GROUPING_NOT_STREAMED } = require('sheet-to-schema/node');
// Round (c): the order fixture over HTTP, against createImportRouter with grouping on and off.
// Shared by the CommonJS and ESM scripts and the Jest test; `fs`, `path`, `express`, `assert`
// and the package's exports are in scope.

async function roundC(fixtures, log = console.log) {
  const csvText = fs.readFileSync(path.join(fixtures, 'order.csv'), 'utf8');
  const csv = Buffer.from(csvText);
  const xlsx = fs.readFileSync(path.join(fixtures, 'order.xlsx'));
  const adapter = jsonSchemaAdapter(JSON.parse(fs.readFileSync(path.join(fixtures, 'order-schema.json'), 'utf8')), { id: 'order' });
  const sheet = parseCsv(csvText);
  const plan = suggestMapping(sheet.headers, adapter, { sample: sheet.rows });
  assert.deepEqual(plan.group && plan.group.key, [0], 'the suggested plan groups by Order ID');
  const inMemory = applyMapping(sheet.rows, plan, adapter, undefined);

  const start = grouping => {
    const written = [];
    const app = express();
    app.use('/import', createImportRouter(express.Router(), {
      bindings: { order: { adapter, ctx: undefined, kind: 'json-schema' } },
      ...(grouping ? { grouping: true } : {}),
      onImport: records => { written.push(...records); },
    }));
    const server = app.listen(0);
    return { written, server, url: route => `http://127.0.0.1:${server.address().port}/import/order/${route}` };
  };
  const post = async (url, file, name, withPlan = plan) => {
    const form = new FormData();
    if (withPlan) form.append('plan', JSON.stringify(withPlan));
    form.append('file', new Blob([file]), name);
    const response = await fetch(url, { method: 'POST', body: form });
    return { status: response.status, body: await response.json() };
  };

  const on = start(true);
  const off = start(false);
  try {
    // Previews and planForServer.
    const previewOn = await post(on.url('preview'), csv, 'order.csv', null);
    const previewOff = await post(off.url('preview'), csv, 'order.csv', null);
    assert.equal(previewOn.status, 200);
    assert.deepEqual(previewOn.body.features, ['group']);
    assert.equal('features' in previewOff.body, false, 'a server with grouping off lists no features');
    assert.deepEqual(planForServer(plan, previewOn.body), { plan });
    assert.deepEqual(planForServer(plan, previewOff.body), { refused: ['group'] });
    log('    preview: features ["group"] with grouping on, none with it off; planForServer sends to one and refuses the other');

    // /validate writes nothing and reports what applyMapping finds.
    const validated = await post(on.url('validate'), csv, 'order.csv');
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.equal(validated.body.written, false);
    assert.deepEqual(on.written, []);
    for (const key of ['imported', 'skipped', 'failed', 'rowsRead', 'rowsInImported']) assert.equal(validated.body[key], inMemory[key], key);
    assert.deepEqual(JSON.parse(JSON.stringify(validated.body.errors)), JSON.parse(JSON.stringify(inMemory.errors)));
    assert.deepEqual(JSON.parse(JSON.stringify(validated.body.warnings)), JSON.parse(JSON.stringify(inMemory.warnings)));
    log(`    /validate: written false, nothing stored; ${validated.body.imported} records, ${validated.body.failed} failed rows, ${validated.body.errorCount} errors, ${validated.body.warningCount} warnings, as applyMapping`);

    // /import, as CSV and as .xlsx: the same records as applyMapping.
    for (const [name, bytes] of [['order.csv', csv], ['order.xlsx', xlsx]]) {
      on.written.length = 0;
      const imported = await post(on.url('import'), bytes, name);
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.deepEqual(JSON.parse(JSON.stringify(on.written)), JSON.parse(JSON.stringify(inMemory.records)), name);
      assert.equal(imported.body.rowsInImported + imported.body.skipped + imported.body.failed, imported.body.rowsRead);
    }
    log(`    /import: the order fixture as CSV and as .xlsx writes the same ${inMemory.records.length} records as applyMapping`);

    // A closed key that comes back: NF-1001's second row moved to the end.
    const lines = csvText.trim().split(/\r?\n/);
    const reordered = [lines[0], lines[1], ...lines.slice(3), lines[2]].join('\r\n') + '\r\n';
    const scattered = await post(on.url('validate'), Buffer.from(reordered), 'order.csv');
    assert.equal(scattered.status, 422);
    assert.equal(scattered.body.error.code, 'GROUP_NOT_CONTIGUOUS');
    assert.deepEqual(scattered.body.error.details, { key: ['NF-1001'], rows: [2, 8] });
    log('    a closed key that comes back: 422 GROUP_NOT_CONTIGUOUS, key NF-1001, rows 2 and 8');

    // Grouping off: refused as in 1.0, nothing written.
    for (const route of ['validate', 'import']) {
      const refused = await post(off.url(route), csv, 'order.csv');
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, 'INVALID_PLAN');
      assert.equal(refused.body.error.message, GROUPING_NOT_STREAMED);
      assert.equal(refused.body.error.details.at(-1).code, 'PLAN_GROUP');
    }
    assert.deepEqual(off.written, []);
    log('    grouping off: /validate and /import refuse with INVALID_PLAN carrying PLAN_GROUP, 1.0\'s message, nothing written');
  } finally {
    on.server.close();
    off.server.close();
  }
}
test('round (c) against the router, grouping on and off', async () => { const lines = []; await roundC(path.resolve(__dirname, '../fixtures'), line => lines.push(line)); expect(lines).toHaveLength(5); }, 60000);
