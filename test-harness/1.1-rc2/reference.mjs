// The server's reading of every fixture, from the published sheet-to-schema@next: the reference
// every browser and bundle result is compared with. Dates as { $date: ISO }.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseCsv } from 'sheet-to-schema';
import { readSheet } from 'sheet-to-schema/node';

const dir = path.resolve('../fixtures');
const serial = v => (v instanceof Date ? { $date: v.toISOString() } : Array.isArray(v) ? v.map(serial) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serial(x)])) : v);
const files = fs.readdirSync(dir).filter(f => /\.(csv|tsv|xlsx)$/.test(f) && !f.startsWith('order'));
const out = {};
for (const file of files) {
  const sheet = await readSheet({ stream: [fs.readFileSync(path.join(dir, file))], filename: file });
  const rows = [];
  for await (const row of sheet.rows) rows.push(row);
  out[file] = serial({ format: sheet.format, headers: sheet.headers, rows, ...(sheet.delimiter ? { delimiter: sheet.delimiter } : {}) });
}
fs.writeFileSync('expected.json', JSON.stringify(out, null, 1));
console.log(`reference: ${files.length} fixtures`);

// The order fixture as a workbook, every cell text, for the server round (c).
const { headers, rows } = parseCsv(fs.readFileSync(path.join(dir, 'order.csv'), 'utf8'));
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Orders');
[headers, ...rows].forEach((row, i) => row.forEach((cell, c) => { if (cell !== '') ws.getCell(i + 1, c + 1).value = String(cell); }));
await wb.xlsx.writeFile(path.join(dir, 'order.xlsx'));
console.log('order.xlsx written');
