// Binary refusal with real files, through the five entry points that classify input.
import { readFileSync } from 'node:fs';
import { jsonSchemaAdapter, readCsvFile } from 'sheet-to-schema';
import { readSheetFile } from 'sheet-to-schema/browser';
import { previewSheet, readSheet, runImport } from 'sheet-to-schema/node';

const adapter = jsonSchemaAdapter({ $id: 'any', type: 'object', properties: { a: { type: 'string' } } });
const plan = { planVersion: 2, target: 'any', entries: [{ ref: 'a', column: 0 }] };

const outcome = async read => {
  try {
    await read();
    return 'READ (no error)';
  } catch (e) {
    return `${e.code ?? e.name}: ${e.message}`;
  }
};

const cases = [
  ['a real PNG renamed .csv', 'files/photo.csv', 'photo.csv'],
  ['a real JPEG renamed .xlsx', 'files/wallpaper.xlsx', 'wallpaper.xlsx'],
  ['a real PDF', 'files/report.pdf', 'report.pdf'],
  ['the same PDF renamed .csv', 'files/report.pdf', 'report.csv'],
  ['a .zip that is not a workbook', 'files/archive.zip', 'archive.zip'],
  ['the same .zip renamed .xlsx', 'files/archive.zip', 'archive.xlsx'],
];

let inconsistent = 0;
for (const [what, path, filename] of cases) {
  const bytes = readFileSync(path);
  const got = {
    readSheet: await outcome(async () => {
      const sheet = await readSheet({ stream: bytes, filename });
      for await (const row of sheet.rows) void row;
    }),
    previewSheet: await outcome(() => previewSheet({ stream: bytes, filename, adapter })),
    runImport: await outcome(() => runImport({ stream: bytes, filename, plan, adapter, ctx: undefined })),
    readSheetFile: await outcome(() => readSheetFile(bytes, { filename })),
    readCsvFile: await outcome(() => readCsvFile(bytes, { filename })),
  };
  const distinct = new Set(Object.values(got));
  if (distinct.size > 1) inconsistent++;
  console.log(`\n${distinct.size === 1 ? 'SAME' : 'DIFFERENT'}  ${what} (${filename}, ${bytes.length} bytes)`);
  for (const [entry, result] of Object.entries(got)) console.log(`  ${entry.padEnd(13)} ${result}`);
}
console.log(`\n${cases.length - inconsistent}/${cases.length} cases give the same error from all five entry points`);
