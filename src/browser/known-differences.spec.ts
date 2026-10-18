/**
 * Where `readSheetFile` and the server's `readSheet` still read a workbook differently, pinned so
 * that a fix to either side shows up here rather than nowhere.
 *
 * Both are cached results of a *shared* formula (a formula Excel stores once and reuses down a
 * column), and both come from the parsers, not from this package:
 *
 * - a shared formula's cached `false`: ExcelJS's `Workbook.xlsx.load` drops it, so the browser
 *   reads an empty cell; the server's streaming reader reads `0`, as it reads any cached boolean;
 * - a shared formula's cached error: the server's streaming reader reads `NaN` (`parseFloat` of
 *   the error text), where it reads a plain formula's cached error as an empty cell; the browser
 *   reads an empty cell for both.
 *
 * Whether to change the server's formula results is the owner's call (docs/1.1-spec.md, revision
 * log); until then the server is the reference and these two stay as they are.
 */
import ExcelJS from 'exceljs';
import { serverGrid } from './parity.fixtures';
import { readSheetFile } from './read-sheet-file';

async function sharedFormulas(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Shared');
  sheet.addRow(['Bool', 'Error']);
  sheet.addRow([{ formula: 'TRUE()', result: true }, { formula: '1/0', result: { error: '#DIV/0!' } }]);
  sheet.addRow([{ sharedFormula: 'A2', result: false }, { sharedFormula: 'B2', result: { error: '#DIV/0!' } }]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('known differences between the readers', () => {
  it('reads a shared formula\'s cached false and cached error differently, and nothing else in the sheet', async () => {
    const bytes = await sharedFormulas();
    const server = await serverGrid(bytes);
    const browser = await readSheetFile(bytes);

    expect(server.rows[0]).toEqual([1, '']);
    expect(browser.rows[0]).toEqual([1, '']);

    expect(server.rows[1]).toEqual([0, NaN]);
    expect(browser.rows[1]).toEqual(['', '']);
  });
});
