/**
 * Refusals and limits (1.1 spec, A): `readSheetFile` refuses what the server refuses, with the
 * server's code and message, and reads what the server reads where the server does not refuse.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { failureOf, serverGrid } from './parity.fixtures';
import { readSheet } from '../node/read-sheet';
import { readSheetFile, readXlsx, type BrowserLimits } from './read-sheet-file';

/** What the server says about `bytes` under `limits`, read to the end. */
async function serverFailure(bytes: Uint8Array, limits: Partial<BrowserLimits> = {}, filename?: string) {
  return failureOf(async () => {
    const sheet = await readSheet({ stream: [Buffer.from(bytes)], limits, filename });
    for await (const _row of sheet.rows) void _row;
  });
}

const browserFailure = (bytes: Uint8Array, limits: Partial<BrowserLimits> = {}, filename?: string) =>
  failureOf(() => readSheetFile(bytes, { limits, filename }));

async function workbookOf(rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('S');
  rows.forEach((row, i) => (sheet.getRow(i + 1).values = row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const CSV = Buffer.from('a,b,c\n1,2,3\n4,5,6\n7,8,9\n');

describe('limits: the server\'s codes and messages', () => {
  const cases: [string, Partial<BrowserLimits>][] = [
    ['maxBytes', { maxBytes: 10 }],
    ['maxRows', { maxRows: 2 }],
    ['maxColumns (the header)', { maxColumns: 2 }],
    ['maxCellLength', { maxCellLength: 3 }],
  ];

  it.each(cases)('CSV past %s', async (_name, limits) => {
    const bytes = _name === 'maxCellLength' ? Buffer.from('a,b\n1,toolong\n') : CSV;
    const expected = await serverFailure(bytes, limits);
    expect(expected.code).toMatch(/TOO_LARGE/);
    expect(await browserFailure(bytes, limits)).toEqual(expected);
  });

  it.each(cases)('xlsx past %s', async (_name, limits) => {
    const bytes = await workbookOf(_name === 'maxCellLength' ? [['a', 'b'], ['1', 'toolong']] : [['a', 'b', 'c'], [1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    const expected = await serverFailure(bytes, limits);
    expect(expected.code).toMatch(/TOO_LARGE/);
    expect(await browserFailure(bytes, limits)).toEqual(expected);
  });

  it('refuses a data row wider than maxColumns, naming its row', async () => {
    const bytes = Buffer.from('a,b\n1,2\n1,2,3\n');
    const expected = await serverFailure(bytes, { maxColumns: 2 });
    expect(expected.message).toBe('Row 3 has more than 2 columns.');
    expect(await browserFailure(bytes, { maxColumns: 2 })).toEqual(expected);
  });

  it('refuses a workbook row far past maxRows before making its gap', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.getRow(1).values = ['a'];
    sheet.getRow(500).values = ['far'];
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const expected = await serverFailure(bytes, { maxRows: 10 });
    expect(expected).toEqual({ code: 'SHEET_TOO_LARGE', message: 'The sheet has more than 10 rows.' });
    expect(await browserFailure(bytes, { maxRows: 10 })).toEqual(expected);
  });

  it('refuses a Blob past maxBytes by its size, before reading it', async () => {
    const blob = new Blob([CSV]);
    Object.defineProperty(blob, 'arrayBuffer', { value: () => Promise.reject(new Error('read')) });
    expect(await failureOf(() => readSheetFile(blob, { limits: { maxBytes: 10 } }))).toEqual(await serverFailure(CSV, { maxBytes: 10 }));
  });

  it('refuses an ArrayBuffer past maxBytes', async () => {
    const buffer = CSV.buffer.slice(CSV.byteOffset, CSV.byteOffset + CSV.byteLength) as ArrayBuffer;
    expect((await failureOf(() => readSheetFile(buffer, { limits: { maxBytes: 10 } }))).code).toBe('TOO_LARGE');
  });

  it('refuses a header line longer than any row may be, when the file has no line break', async () => {
    const bytes = Buffer.from('x'.repeat(40));
    const limits = { maxCellLength: 4, maxColumns: 4 };
    const expected = await serverFailure(bytes, limits);
    expect(expected).toEqual({ code: 'SHEET_TOO_LARGE', message: 'The header row is longer than any row may be.' });
    expect(await browserFailure(bytes, limits)).toEqual(expected);
  });

  it('keeps every default for a limit it is not given', async () => {
    expect((await readSheetFile(CSV, { limits: {} })).rows).toHaveLength(3);
  });
});

describe('formats: refused as the server refuses, read as the server reads', () => {
  it('refuses UTF-16 text', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n1,2\n', 'utf16le')]);
    const expected = await serverFailure(bytes);
    expect(expected.code).toBe('UNSUPPORTED_FORMAT');
    expect(await browserFailure(bytes)).toEqual(expected);
  });

  it('refuses a legacy .xls', async () => {
    const bytes = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const expected = await serverFailure(bytes);
    expect(expected.code).toBe('UNSUPPORTED_FORMAT');
    expect(await browserFailure(bytes)).toEqual(expected);
  });

  it('refuses a .docx: a zip that is not a workbook', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const expected = await serverFailure(bytes);
    expect(expected).toEqual({ code: 'UNSUPPORTED_FORMAT', message: 'This is a zip archive that is not an Excel workbook. Upload an .xlsx or .csv file.' });
    expect(await browserFailure(bytes)).toEqual(expected);
  });

  it('reads a random binary that is not a zip as CSV, into exactly the server\'s grid', async () => {
    // Deterministic noise: a linear congruential sequence, not starting with "PK".
    const bytes = new Uint8Array(4096);
    let seed = 12345;
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed = (seed * 1103515245 + 12345) % 2 ** 31) & 0xff;
    bytes[0] = 0x01;
    const read = await readSheetFile(bytes);
    expect(read.format).toBe('csv');
    expect(read).toEqual(await serverGrid(bytes));
  });

  it('reads an empty file as the server does: no headers and no rows', async () => {
    expect(await readSheetFile(new Uint8Array(0))).toEqual(await serverGrid(new Uint8Array(0)));
  });

  it('says a workbook with a sheet and no rows has no readable rows, as the server does', async () => {
    const bytes = await workbookOf([]);
    const expected = await serverFailure(bytes);
    expect(expected).toEqual({ code: 'MALFORMED_FILE', message: 'This workbook has no readable rows.' });
    expect(await browserFailure(bytes)).toEqual(expected);
  });

  it('calls a workbook whose sheet XML the parser rejects unreadable', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="S" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>&undefined;</v></c></row></sheetData></worksheet>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(await browserFailure(bytes)).toEqual({ code: 'MALFORMED_FILE', message: 'This is not a readable workbook.' });
  });

  it('readXlsx refuses text, which only readSheetFile reads', async () => {
    expect(await failureOf(() => readXlsx(CSV))).toEqual({
      code: 'UNSUPPORTED_FORMAT',
      message: 'This is not an .xlsx workbook. Read a CSV with readSheetFile.',
    });
    expect((await failureOf(() => readXlsx(Buffer.from([0xff, 0xfe, 0x61, 0x00])))).message).toMatch(/UTF-16/);
  });

  it('refuses an input that is not a file or bytes', async () => {
    const failure = await failureOf(() => readSheetFile('a,b' as unknown as Blob));
    expect(failure).toEqual({ code: undefined, message: 'readSheetFile reads a Blob (such as a File), an ArrayBuffer or a Uint8Array.' });
  });
});
