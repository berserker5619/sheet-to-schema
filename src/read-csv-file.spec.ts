/**
 * `readCsvFile` (1.2): the CSV half of `/browser`'s `readSheetFile`, from the main entry, with
 * nothing that can reach `exceljs`.
 *
 * The mock stands for `exceljs` not being installed, and counts every attempt to load it: none
 * may happen, whatever is read. It is in a file of its own because a module mock covers the
 * whole file.
 */
import JSZip from 'jszip';
import { CSV_FIXTURES, fixtureBytes, nameOf, serverGrid, XLSX_FIXTURES } from './browser/parity.fixtures';
import { readSheetFile } from './browser/read-sheet-file';
import { ImportError, readCsvFile } from './index';

let mockLoads = 0;
jest.mock('exceljs', () => {
  mockLoads++;
  throw Object.assign(new Error("Cannot find module 'exceljs' from 'src/read-csv-file.ts'"), { code: 'MODULE_NOT_FOUND' });
});

const failureOf = (read: Promise<unknown>): Promise<ImportError> => read.then(() => { throw new Error('it read'); }, (error: ImportError) => error);

afterEach(() => expect(mockLoads).toBe(0));

describe('readCsvFile reads what readSheet and readSheetFile read', () => {
  it.each(CSV_FIXTURES.map(fixture => [fixture.file] as const))('%s', async file => {
    const bytes = fixtureBytes(file);
    const read = await readCsvFile(bytes, { filename: nameOf(file) });
    expect(read).toEqual(await serverGrid(bytes, nameOf(file)));
    expect(read).toEqual(await readSheetFile(bytes, { filename: nameOf(file) }));
  });

  it('returns the separator, for decimalMarkFor, and reads a .tsv as tabs by its name only', async () => {
    expect((await readCsvFile(fixtureBytes('real-world/case3_excel_semicolon.csv'))).delimiter).toBe(';');
    const tsv = fixtureBytes('parity/header_commas.tsv');
    expect((await readCsvFile(tsv, { filename: 'header_commas.tsv' })).delimiter).toBe('\t');
    expect((await readCsvFile(tsv)).delimiter).toBe(',');
  });

  it('decides the format by the bytes, not the name: a CSV named .xlsx is read', async () => {
    const read = await readCsvFile(new TextEncoder().encode('a;b\n1;2\n'), { filename: 'export.xlsx' });
    expect(read).toEqual({ format: 'csv', headers: ['a', 'b'], rows: [['1', '2']], delimiter: ';' });
  });

  it('reads the same grid from a Blob, an ArrayBuffer and a Uint8Array', async () => {
    const bytes = fixtureBytes('real-world/case3_excel_semicolon.csv');
    const fromBytes = await readCsvFile(bytes);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await readCsvFile(copy)).toEqual(fromBytes);
    expect(await readCsvFile(new Blob([copy]))).toEqual(fromBytes);
  });

  it('reads a Blob without arrayBuffer through FileReader', async () => {
    const original = Blob.prototype.arrayBuffer;
    class FakeReader {
      result: ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      readAsArrayBuffer(blob: Blob) {
        void original.call(blob).then(buffer => {
          this.result = buffer;
          this.onload?.();
        });
      }
    }
    const blob = new Blob(['a,b\n1,2\n']);
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined });
    (globalThis as { FileReader?: unknown }).FileReader = FakeReader;
    try {
      expect((await readCsvFile(blob)).rows).toEqual([['1', '2']]);
    } finally {
      delete (globalThis as { FileReader?: unknown }).FileReader;
    }
  });
});

describe('readCsvFile refuses what it does not read, with the same codes and messages', () => {
  it('refuses an .xlsx by its bytes, whatever its name, saying where workbooks are read', async () => {
    for (const { file } of XLSX_FIXTURES.slice(0, 2)) {
      const failure = await failureOf(readCsvFile(fixtureBytes(file), { filename: 'data.csv' }));
      expect(failure).toBeInstanceOf(ImportError);
      expect(failure).toMatchObject({
        code: 'UNSUPPORTED_FORMAT',
        message: 'This is an .xlsx workbook. Read it with readSheetFile from sheet-to-schema/browser, or save it as CSV.',
      });
    }
  });

  it('refuses any other zip the same way, before anything could load exceljs', async () => {
    const zip = await new JSZip().file('word/document.xml', '<w/>').generateAsync({ type: 'uint8array' });
    await expect(readCsvFile(zip, { filename: 'letter.docx' })).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it.each([
    ['a pre-2007 .xls', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ['UTF-16 LE', Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00])],
    ['UTF-16 BE', Uint8Array.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x2c, 0x00, 0x62])],
  ])('refuses %s exactly as readSheetFile does', async (_, bytes) => {
    const failure = await failureOf(readCsvFile(bytes));
    const expected = await failureOf(readSheetFile(bytes));
    expect(failure).toBeInstanceOf(ImportError);
    expect({ code: failure.code, message: failure.message }).toEqual({ code: 'UNSUPPORTED_FORMAT', message: expected.message });
  });

  it("enforces the server's limits, with its messages", async () => {
    const csv = new TextEncoder().encode('a,b\n1,2\n3,4\n');
    await expect(readCsvFile(csv, { limits: { maxBytes: 4 } })).rejects.toMatchObject({ code: 'TOO_LARGE', message: 'The file is larger than the 4 byte limit.' });
    await expect(readCsvFile(new Blob([csv]), { limits: { maxBytes: 4 } })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(readCsvFile(csv.buffer as ArrayBuffer, { limits: { maxBytes: 4 } })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(readCsvFile(csv, { limits: { maxRows: 1 } })).rejects.toMatchObject({ code: 'SHEET_TOO_LARGE', message: 'The sheet has more than 1 rows.' });
    await expect(readCsvFile(csv, { limits: { maxColumns: 1 } })).rejects.toMatchObject({ code: 'SHEET_TOO_LARGE' });
    const longHeader = new TextEncoder().encode('x'.repeat(40));
    await expect(readCsvFile(longHeader, { limits: { maxCellLength: 4, maxColumns: 2 } })).rejects.toMatchObject({
      code: 'SHEET_TOO_LARGE',
      message: 'The header row is longer than any row may be.',
    });
  });

  it('refuses something that is not a file with a TypeError naming itself', async () => {
    await expect(readCsvFile('a,b' as unknown as Blob)).rejects.toThrow(new TypeError('readCsvFile reads a Blob (such as a File), an ArrayBuffer or a Uint8Array.'));
  });
});
