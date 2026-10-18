/**
 * The parity fixtures and the server's reading of them, shared by the Node and jsdom parity
 * specs. Every file is read by the server's `readSheet`, the reference, and compared with
 * what `readSheetFile` reads from the same bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSheet } from '../node/read-sheet';

const ROOT = path.resolve(__dirname, '../../test/fixtures');

export interface ParityFixture {
  /** Where it is under test/fixtures, and the name both readers are given. */
  file: string;
  format: 'csv' | 'xlsx';
}

export const XLSX_FIXTURES: ParityFixture[] = [
  'real-world/case1_1904_dates.xlsx',
  'real-world/case2_numeric_identifiers.xlsx',
  'real-world/case4_complex_sheet.xlsx',
  'real-world/case5_non_latin.xlsx',
  'parity/tamil_text.xlsx',
  'parity/typed_cells.xlsx',
  'parity/error_cells.xlsx',
  'parity/blank_rows.xlsx',
  'parity/formula_results.xlsx',
].map(file => ({ file, format: 'xlsx' }));

export const CSV_FIXTURES: ParityFixture[] = [
  'real-world/case3_excel_utf8_bom.csv',
  'real-world/case3_excel_semicolon.csv',
  'real-world/case3_google_sheets.csv',
  'real-world/case5_non_latin.csv',
  'parity/header_commas.tsv',
  'parity/ragged_rows.csv',
  'parity/blank_lines.csv',
].map(file => ({ file, format: 'csv' }));

export const ALL_FIXTURES = [...XLSX_FIXTURES, ...CSV_FIXTURES];

export function fixtureBytes(file: string): Buffer {
  return fs.readFileSync(path.join(ROOT, file));
}

export const nameOf = (file: string): string => path.basename(file);

/** What the server reads from `bytes`: the reference every browser read is compared with. */
export async function serverGrid(bytes: Uint8Array, filename?: string): Promise<{
  format: 'csv' | 'xlsx';
  headers: string[];
  rows: unknown[][];
  delimiter?: string;
}> {
  // One chunk in an array, not the bare bytes: under jsdom a Node Buffer is not an instance of
  // the page's Uint8Array, which `readSheet`'s shape check would otherwise trip on.
  const sheet = await readSheet({ stream: [Buffer.from(bytes)], filename });
  const rows: unknown[][] = [];
  for await (const row of sheet.rows) rows.push(row);
  return { format: sheet.format, headers: sheet.headers, rows, ...(sheet.delimiter ? { delimiter: sheet.delimiter } : {}) };
}

/** The same failure, as a client can see it: its code and message. */
export async function failureOf(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run();
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error('expected a failure');
}
