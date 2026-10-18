/**
 * sheet-guards.ts — the row, column and cell bounds, checked one row at a time.
 *
 * Browser-safe and shared: the server's `guardRows` checks each streamed row with these, and
 * the browser reader checks each row of the file it holds, so both refuse the same sheet at the
 * same row with the same message.
 */
import { padRow } from 'sheet-to-schema';
import { ImportError } from './import-error';
import type { ImportLimits } from './limits';

type SheetLimits = Pick<ImportLimits, 'maxRows' | 'maxColumns' | 'maxCellLength'>;

/** The header row, checked once it is read: its width is every later row's. */
export function guardHeaders(headers: readonly string[], limits: SheetLimits): void {
  if (headers.length > limits.maxColumns) {
    throw new ImportError('SHEET_TOO_LARGE', `The sheet has more than ${limits.maxColumns} columns.`);
  }
}

/**
 * Check data row number `seen` (1 for the row after the header) and pad it to `width`.
 *
 * Padding matches `parseCsv`, through the same `padRow` the main entry exports, so a file
 * imported on a server and the same file imported in a browser produce the same rows.
 */
export function guardRow(row: unknown[], seen: number, width: number, limits: SheetLimits): unknown[] {
  if (seen > limits.maxRows) {
    throw new ImportError('SHEET_TOO_LARGE', `The sheet has more than ${limits.maxRows} rows.`);
  }
  if (row.length > limits.maxColumns) {
    throw new ImportError('SHEET_TOO_LARGE', `Row ${seen + 1} has more than ${limits.maxColumns} columns.`);
  }
  for (const cell of row) {
    if (typeof cell === 'string' && cell.length > limits.maxCellLength) {
      throw new ImportError('SHEET_TOO_LARGE', `A cell in row ${seen + 1} is longer than ${limits.maxCellLength} characters.`);
    }
  }
  return padRow(row, width);
}
