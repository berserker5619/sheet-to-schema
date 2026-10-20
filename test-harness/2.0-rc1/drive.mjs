// Drives preview, validate and import over HTTP against a server with the MIGRATING-2.0 routes.
// usage: node drive.mjs <base url, e.g. http://127.0.0.1:3000/import/people> <label>
// Exits non-zero on any failed check; prints one line per check either way.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('./ref/package.json', import.meta.url)));
const ExcelJS = require('exceljs');

const [base, label] = process.argv.slice(2);
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${label}: ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${label}: ${name}\n     ${error.message.split('\n').slice(0, 6).join('\n     ')}`);
  }
};

const csv = 'Name,Born\r\nAda,1815-12-10\r\nAlan,1912-06-23\r\nGrace,not a date\r\n';
const book = new ExcelJS.Workbook();
const sheet = book.addWorksheet('People');
sheet.addRow(['Name', 'Born']);
sheet.addRow(['Ada', new Date(Date.UTC(1815, 11, 10))]);
sheet.addRow(['Alan', new Date(Date.UTC(1912, 5, 23))]);
sheet.addRow(['Grace', 'not a date']);
const xlsx = Buffer.from(await book.xlsx.writeBuffer());
const plan = JSON.stringify({ planVersion: 2, target: 'people', entries: [{ ref: 'name', column: 0 }, { ref: 'born', column: 1 }] });

async function post(route, file, filename, { withPlan = true, planText = plan } = {}) {
  const form = new FormData();
  if (withPlan) form.append('plan', planText);
  form.append('file', new Blob([file]), filename);
  const response = await fetch(`${base}/${route}`, { method: 'POST', body: form });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

for (const [kind, file, filename] of [['CSV', csv, 'people.csv'], ['xlsx', xlsx, 'people.xlsx']]) {
  await check(`${kind} preview`, async () => {
    const { status, body } = await post('preview', file, filename, { withPlan: false });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.headers, ['Name', 'Born']);
    assert.equal(body.rowCount, 3);
    assert.equal(body.format, kind === 'CSV' ? 'csv' : 'xlsx');
    assert.ok(Array.isArray(body.suggestion?.entries));
  });
  await check(`${kind} validate`, async () => {
    const { status, body } = await post('validate', file, filename);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.written, false);
    assert.equal(body.imported, 2);
    assert.equal(body.failed, 1);
    assert.equal(body.errors[0]?.row, 4);
  });
  await check(`${kind} import`, async () => {
    const { status, body } = await post('import', file, filename);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.written, true);
    assert.equal(body.imported, 2);
    assert.equal(body.rowsRead, 3);
  });
}
await check('preview round trip: the preview\'s suggestion, sent back unchanged, validates and imports', async () => {
  const preview = await post('preview', csv, 'people.csv', { withPlan: false });
  assert.equal(preview.status, 200);
  const roundTrip = JSON.stringify(preview.body.suggestion);
  const validate = await post('validate', csv, 'people.csv', { planText: roundTrip });
  assert.equal(validate.status, 200, JSON.stringify(validate.body));
  assert.equal(validate.body.imported, 2);
  const imported = await post('import', xlsx, 'people.xlsx', { planText: roundTrip });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.written, true);
  assert.equal(imported.body.imported, 2);
  assert.deepEqual(imported.body.planProblems.filter(p => p.level === 'error'), []);
});
await check('a plan that is not JSON: 400 INVALID_PLAN', async () => {
  const { status, body } = await post('import', csv, 'people.csv', { planText: 'not json' });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.error.code, 'INVALID_PLAN');
});
await check('no plan field: 400 INVALID_PLAN naming the order', async () => {
  const { status, body } = await post('import', csv, 'people.csv', { withPlan: false });
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error.message, /before the file/);
});
await check('a PNG named .csv: 415 UNSUPPORTED_FORMAT', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const { status, body } = await post('preview', png, 'people.csv', { withPlan: false });
  assert.equal(status, 415, JSON.stringify(body));
  assert.equal(body.error.code, 'UNSUPPORTED_FORMAT');
});
await check('no file: 400 NO_FILE', async () => {
  const form = new FormData();
  form.append('plan', plan);
  const response = await fetch(`${base}/import`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error.code, 'NO_FILE');
});
await check('the server is still up afterwards', async () => {
  const { status } = await post('preview', csv, 'people.csv', { withPlan: false });
  assert.equal(status, 200);
});
const failed = results.filter(r => !r.ok).length;
console.log(`${label}: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
