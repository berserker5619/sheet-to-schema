// Grouping on by default (D4): the order fixture imports grouped through runImport with no
// grouping option, as a CSV and as a workbook, and matches applyMapping; grouping: false refuses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMapping, jsonSchemaAdapter, parseCsv, suggestMapping } from 'sheet-to-schema';
import { previewSheet, runImport } from 'sheet-to-schema/node';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(true);
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 8).join('\n     ')}`);
  }
};

const F = new URL('../fixtures/', import.meta.url);
const csvText = readFileSync(new URL('order.csv', F), 'utf8');
const xlsx = readFileSync(new URL('order.xlsx', F));
const adapter = jsonSchemaAdapter(JSON.parse(readFileSync(new URL('order-schema.json', F), 'utf8')));
const sheet = parseCsv(csvText);
const plan = suggestMapping(sheet.headers, adapter, { sample: sheet.rows, dateOrder: 'DMY' });
const memory = applyMapping(sheet.rows, plan, adapter, undefined, { dateOrder: 'DMY' });
const json = value => JSON.parse(JSON.stringify(value));

await check('the suggestion proposes a group (the fixture is one row per item)', () => {
  assert.ok(plan.group, JSON.stringify(plan).slice(0, 300));
  assert.ok(memory.records.length < sheet.rows.length, `${memory.records.length} records from ${sheet.rows.length} rows`);
});

for (const [kind, stream, filename] of [['CSV', Buffer.from(csvText), 'order.csv'], ['xlsx', xlsx, 'order.xlsx']]) {
  await check(`${kind}: runImport with no grouping option groups, as applyMapping does`, async () => {
    const records = [];
    const result = await runImport({ stream, filename, plan, adapter, ctx: undefined, dateOrder: 'DMY', onBatch: batch => void records.push(...batch) });
    assert.equal(result.imported, memory.records.length);
    assert.deepEqual(json(records), json(memory.records));
    assert.deepEqual(json(result.errors), json(memory.errors));
    assert.deepEqual(json(result.warnings), json(memory.warnings));
  });
  await check(`${kind}: grouping: false restores the refusal (INVALID_PLAN, PLAN_GROUP, grouping-disabled)`, async () => {
    const records = [];
    const error = await runImport({ stream, filename, plan, adapter, ctx: undefined, grouping: false, onBatch: batch => void records.push(...batch) }).then(
      () => null,
      e => e,
    );
    assert.ok(error, 'did not refuse');
    assert.equal(error.code, 'INVALID_PLAN');
    assert.deepEqual(error.details.filter(p => p.code === 'PLAN_GROUP').map(p => p.reason), ['grouping-disabled']);
    assert.equal(records.length, 0);
  });
  await check(`${kind}: contiguous: false is still refused by default (non-contiguous)`, async () => {
    const error = await runImport({ stream, filename, plan: { ...plan, group: { ...plan.group, contiguous: false } }, adapter, ctx: undefined }).then(
      () => null,
      e => e,
    );
    assert.equal(error?.code, 'INVALID_PLAN');
    assert.deepEqual(error.details.filter(p => p.code === 'PLAN_GROUP').map(p => p.reason), ['non-contiguous']);
  });
}

await check('previewSheet suggests from headers alone: no group in a preview (as documented)', async () => {
  const preview = await previewSheet({ stream: Buffer.from(csvText), filename: 'order.csv', adapter });
  assert.equal(preview.suggestion.group, undefined);
});

const failed = results.filter(ok => !ok).length;
console.log(`grouping: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
