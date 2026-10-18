/**
 * Builds the generated parity fixtures: the cases the real-world files do not cover, each read
 * by the server's `readSheet` and the browser's `readSheetFile` and compared
 * (`src/browser/parity.spec.ts`, `src/browser/parity.jsdom.spec.ts`).
 *
 * The workbooks are written by ExcelJS, which stamps a timestamp into them, so their bytes
 * change on every run; the specs compare the two readers, never bytes. The text files are
 * written byte for byte from the strings below.
 *
 *   npm run regenerate:parity-fixtures
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = name => path.join(dir, name);

/** Tamil script in headers and cells, written as plain UTF-8 (openpyxl's NCR form is case5). */
async function tamilText() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('மாணவர்கள்');
  ws.addRow(['பெயர்', 'ஊர்', 'மதிப்பெண்']);
  ws.addRow(['கார்த்திக் சுந்தரம்', 'சென்னை', 91]);
  ws.addRow(['மீனா 🌸', 'மதுரை', 87]);
  ws.addRow(['ஆனந்த்', 'கோயம்புத்தூர் 🏙️', 78]);
  await wb.xlsx.writeFile(out('tamil_text.xlsx'));
}

/** One of each typed cell: numbers, booleans, dates, rich text, a hyperlink, formulas. */
async function typedCells() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Typed');
  ws.addRow(['Label', 'Number', 'Boolean', 'Date', 'DateTime', 'Rich', 'Link', 'Formula', 'Text number']);
  ws.addRow([
    'first',
    42.5,
    true,
    new Date(Date.UTC(2026, 9, 18)),
    new Date(Date.UTC(2026, 9, 18, 13, 45, 30)),
    { richText: [{ text: 'Bold ', font: { bold: true } }, { text: 'and plain' }] },
    { text: 'Example', hyperlink: 'https://example.com/' },
    { formula: 'B2*2', result: 85 },
    '00123',
  ]);
  ws.addRow([
    'second',
    -0.001,
    false,
    new Date(Date.UTC(1999, 11, 31)),
    new Date(Date.UTC(2000, 0, 1, 0, 0, 1)),
    { richText: [{ text: 'தமிழ் ' }, { text: '🎉', font: { italic: true } }] },
    { text: 'mailto', hyperlink: 'mailto:someone@example.com' },
    { formula: 'IF(C3,"yes","no")', result: 'no' },
    '1e5',
  ]);
  ws.getColumn(4).numFmt = 'yyyy-mm-dd';
  ws.getColumn(5).numFmt = 'yyyy-mm-dd hh:mm:ss';
  await wb.xlsx.writeFile(out('typed_cells.xlsx'));
}

/** Error cells, as typed values and as a formula's cached result. */
async function errorCells() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Errors');
  ws.addRow(['Name', 'Value', 'Computed']);
  ws.addRow(['missing', { error: '#N/A' }, { formula: 'VLOOKUP("x",A:A,2,FALSE)', result: { error: '#N/A' } }]);
  ws.addRow(['divide', { error: '#DIV/0!' }, { formula: '1/0', result: { error: '#DIV/0!' } }]);
  ws.addRow(['ref', { error: '#REF!' }, 7]);
  await wb.xlsx.writeFile(out('error_cells.xlsx'));
}

/** Blank rows in the middle of the data, which must keep later rows on their own numbers. */
async function blankRows() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Gaps');
  ws.getRow(1).values = ['Name', 'Qty'];
  ws.getRow(2).values = ['first', 1];
  ws.getRow(5).values = ['after two blanks', 2];
  ws.getRow(7).values = ['after one blank', 3];
  // A styled row with no values is a row in the XML: still blank.
  ws.getRow(8).getCell(1).style = { font: { bold: true } };
  ws.getRow(9).values = ['last', 4];
  await wb.xlsx.writeFile(out('blank_rows.xlsx'));
}

/**
 * Formula results of every stored type, plain and shared. The server's streaming reader reduces
 * them (a boolean to 1 or 0, an error to no result, a date-formatted number to its serial), and
 * the browser reader must reduce them the same way.
 */
async function formulaResults() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Formulas');
  ws.addRow(['Kind', 'Bool', 'Error', 'Date', 'Number', 'Text', 'No result']);
  ws.addRow([
    'first',
    { formula: 'TRUE()', result: true },
    { formula: '1/0', result: { error: '#DIV/0!' } },
    { formula: 'DATE(2026,10,18)', result: new Date(Date.UTC(2026, 9, 18)) },
    { formula: '1+1', result: 2 },
    { formula: '"a"&"b"', result: 'ab' },
    { formula: 'B2' },
  ]);
  ws.addRow([
    'shared',
    // Not `false`, and not an error: those two differ between the readers, and
    // src/browser/known-differences.spec.ts pins them instead.
    { sharedFormula: 'B2', result: true },
    { formula: 'NA()', result: { error: '#N/A' } },
    { sharedFormula: 'D2', result: new Date(Date.UTC(1999, 11, 31, 12)) },
    { sharedFormula: 'E2', result: 3.25 },
    { sharedFormula: 'F2', result: 'cd' },
    '',
  ]);
  ws.getColumn(4).numFmt = 'yyyy-mm-dd hh:mm';
  await wb.xlsx.writeFile(out('formula_results.xlsx'));
}

/** Text fixtures, byte for byte. */
const TEXT = {
  // A .tsv whose header has more commas than tabs: detection alone would pick ",".
  'header_commas.tsv': 'Name, full\tCity, State, Country\tNotes, if any\nRavi, K\tChennai, TN, IN\tnone, really\nAsha\tPune, MH, IN\t\n',
  // Short and long rows, against a three-column header.
  'ragged_rows.csv': 'A,B,C\n1\n1,2\n1,2,3\n1,2,3,4,5\n,,\n',
  // Blank lines mid-file and at the end, CRLF, which must not shift row numbers.
  'blank_lines.csv': 'Name,Qty\r\nfirst,1\r\n\r\n\r\nafter two,2\r\n\r\nafter one,3\r\n\r\n',
};

await tamilText();
await typedCells();
await errorCells();
await blankRows();
await formulaResults();
for (const [name, text] of Object.entries(TEXT)) fs.writeFileSync(out(name), text, 'utf8');
console.log('Parity fixtures written to', dir);
