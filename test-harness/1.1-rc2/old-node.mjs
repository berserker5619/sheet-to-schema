import fs from 'node:fs';
import { readSheetFile } from 'sheet-to-schema/browser';
for (const f of ['case3_excel_semicolon.csv', 'case1_1904_dates.xlsx']) {
  try {
    const s = await readSheetFile(fs.readFileSync(`../fixtures/${f}`), { filename: f });
    console.log(process.version, f, 'OK', s.headers.join('|'));
  } catch (e) {
    console.log(process.version, f, 'FAILED', e.constructor.name, e.code ?? '', e.message);
  }
}
