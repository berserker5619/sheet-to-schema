/**
 * `readSheetFile` under Node reads exactly what the server's `readSheet` reads, for every
 * parity fixture (1.1 spec, A: xlsx parity, CSV parity, R3-1).
 */
import { ALL_FIXTURES, CSV_FIXTURES, fixtureBytes, nameOf, serverGrid, XLSX_FIXTURES } from './parity.fixtures';
import { readSheetFile, readXlsx } from './read-sheet-file';

describe('readSheetFile reads what readSheet reads (Node)', () => {
  it.each(ALL_FIXTURES.map(fixture => [fixture.file, fixture.format] as const))('%s', async (file, format) => {
    const bytes = fixtureBytes(file);
    const expected = await serverGrid(bytes, nameOf(file));
    const read = await readSheetFile(bytes, { filename: nameOf(file) });
    expect(expected.format).toBe(format);
    expect(read).toEqual(expected);
  });

  it('covers a separator of each kind, the way the server detects or is told it', async () => {
    const delimiters = await Promise.all(CSV_FIXTURES.map(async ({ file }) => (await readSheetFile(fixtureBytes(file), { filename: nameOf(file) })).delimiter));
    expect(new Set(delimiters)).toEqual(new Set([',', ';', '\t']));
  });

  it('reads the .tsv as tabs by its name, though its header has more commas than tabs', async () => {
    const bytes = fixtureBytes('parity/header_commas.tsv');
    expect((await readSheetFile(bytes, { filename: 'header_commas.tsv' })).delimiter).toBe('\t');
    // Without the name, detection reads the same bytes as commas, as the server does.
    const unnamed = await readSheetFile(bytes);
    expect(unnamed.delimiter).toBe(',');
    expect(unnamed).toEqual(await serverGrid(bytes));
  });

  it('keeps "Rajesh Kumar 🎉" from the openpyxl workbook intact (R3-1)', async () => {
    const read = await readSheetFile(fixtureBytes('real-world/case5_non_latin.xlsx'));
    expect(read.rows.flat()).toContain('Rajesh Kumar 🎉');
  });

  it('reads the same grid from a Blob, an ArrayBuffer and a Uint8Array', async () => {
    const bytes = fixtureBytes('real-world/case4_complex_sheet.xlsx');
    const fromBytes = await readSheetFile(bytes);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await readSheetFile(copy)).toEqual(fromBytes);
    expect(await readSheetFile(new Blob([copy]))).toEqual(fromBytes);
  });

  it('readXlsx reads the grid without the format, for a caller that knows it is a workbook', async () => {
    for (const { file } of XLSX_FIXTURES) {
      const { headers, rows } = await readSheetFile(fixtureBytes(file));
      expect(await readXlsx(fixtureBytes(file))).toEqual({ headers, rows });
    }
  });
});
