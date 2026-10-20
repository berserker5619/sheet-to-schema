import { readFileSync } from 'node:fs';
import { applyMapping, jsonSchemaAdapter, parseCsv } from 'sheet-to-schema';
import { previewSheet, runImport } from 'sheet-to-schema/node';
const F = new URL('../fixtures/', import.meta.url);
const adapter = jsonSchemaAdapter(JSON.parse(readFileSync(new URL('order-schema.json', F), 'utf8')));
const rows = parseCsv(readFileSync(new URL('order.csv', F), 'utf8')).rows;
for (const name of ['order.csv', 'order.xlsx']) {
  const bytes = readFileSync(new URL(name, F));
  const preview = await previewSheet({ stream: bytes, filename: name, adapter });
  const records = [];
  const result = await runImport({ stream: bytes, filename: name, plan: preview.suggestion, adapter, ctx: undefined, onBatch: b => void records.push(...b) });
  const memory = applyMapping(rows, preview.suggestion, adapter, undefined);
  const same = JSON.stringify(records) === JSON.stringify(memory.records);
  const guesses = preview.suggestion.entries.filter(e => e.ref.startsWith('items.')).map(e => e.confidence);
  console.log(`${same && preview.suggestion.group ? 'ok  ' : 'FAIL'} ${name}: group ${JSON.stringify(preview.suggestion.group)}, items entries ${JSON.stringify(guesses)}; ${rows.length} rows -> ${records.length} records (applyMapping ${memory.records.length}), ${result.errorCount} errors`);
}
