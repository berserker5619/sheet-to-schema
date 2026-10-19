/**
 * Formula results (1.1 spec, A4): a formula cell is the typed cell its cached result is, on the
 * server and in the browser alike. A date-formatted result is a `Date`, a cached boolean a
 * boolean, a cached error its error text, a cached `0` or `false` itself. 1.0's server read
 * them as a serial number, `1`/`0`, an empty cell; ExcelJS's `Workbook.xlsx.load` dropped a
 * cached `0` or `false`. Both readers now take the formula out before parsing
 * (`shared/formula-filter.ts`).
 */
import ExcelJS from 'exceljs';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { runImport } from '../node/run-import';
import { fixtureBytes, serverGrid } from './parity.fixtures';
import { readSheetFile } from './read-sheet-file';

const utc = (iso: string) => new Date(iso);

/** What `formula_results.xlsx` holds, read by either reader. */
const EXPECTED_ROWS = [
  ['plain', true, '#DIV/0!', utc('2026-10-18T00:00:00Z'), 2, 'ab', ''],
  ['shared', false, '#DIV/0!', utc('1999-12-31T12:00:00Z'), 3.25, 'cd', ''],
  ['plain false', false, '#N/A', utc('2026-10-19T00:00:00Z'), 0, '', ''],
];

describe('formula results are their cached values, typed', () => {
  const bytes = fixtureBytes('parity/formula_results.xlsx');

  it('on the server', async () => {
    expect((await serverGrid(bytes)).rows).toEqual(EXPECTED_ROWS);
  });

  it('in the browser', async () => {
    expect((await readSheetFile(bytes)).rows).toEqual(EXPECTED_ROWS);
  });

  it('through runImport, into typed fields', async () => {
    const adapter = jsonSchemaAdapter(
      {
        $id: 'results',
        type: 'object',
        properties: {
          kind: { type: 'string' },
          flag: { type: 'boolean' },
          problem: { type: 'string' },
          on: { type: 'string', format: 'date' },
          amount: { type: 'number' },
        },
      },
      { version: 1 },
    );
    const plan = { planVersion: 2, target: 'results', schemaVersion: 1, entries: ['kind', 'flag', 'problem', 'on', 'amount'].map((ref, column) => ({ ref, column })) };
    const written: Record<string, unknown>[] = [];
    const result = await runImport({
      stream: bytes,
      filename: 'formula_results.xlsx',
      plan,
      adapter,
      ctx: undefined,
      onBatch: records => void written.push(...records),
    });
    expect(result.errors).toEqual([]);
    expect(written).toEqual([
      { kind: 'plain', flag: true, problem: '#DIV/0!', on: '2026-10-18', amount: 2 },
      { kind: 'shared', flag: false, problem: '#DIV/0!', on: '1999-12-31', amount: 3.25 },
      { kind: 'plain false', flag: false, problem: '#N/A', on: '2026-10-19', amount: 0 },
    ]);
  });

  it('reads a shared formula\'s cached false and cached error the same on both sides (two differences before A4)', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Shared');
    sheet.addRow(['Bool', 'Error']);
    sheet.addRow([{ formula: 'TRUE()', result: true }, { formula: '1/0', result: { error: '#DIV/0!' } }]);
    sheet.addRow([{ sharedFormula: 'A2', result: false }, { sharedFormula: 'B2', result: { error: '#DIV/0!' } }]);
    const shared = Buffer.from(await workbook.xlsx.writeBuffer());
    const expected = [[true, '#DIV/0!'], [false, '#DIV/0!']];
    expect((await serverGrid(shared)).rows).toEqual(expected);
    expect((await readSheetFile(shared)).rows).toEqual(expected);
  });
});
