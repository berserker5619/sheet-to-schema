/**
 * sheet-format.ts — what a file is, decided by its first bytes.
 *
 * Browser-safe and shared, so the server's `readSheet` and `sheet-to-schema/browser`'s
 * `readSheetFile` refuse the same files with the same messages and read the rest the same way.
 */
import { ImportError } from './import-error';

/** The formats this package reads. Both are decided by magic bytes. */
export type SheetFormat = 'csv' | 'xlsx';

/** Enough bytes to tell a zip from text, with room for a UTF-16 BOM. */
export const MAGIC_BYTES = 8;

const ZIP = [0x50, 0x4b]; // "PK"
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0]; // a pre-2007 .xls, which is a compound file, not a zip
const UTF16_LE = [0xff, 0xfe];
const UTF16_BE = [0xfe, 0xff];

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, i) => bytes[i] === byte);

/**
 * What these bytes actually are.
 *
 * Exported because the multipart layer wants the same answer for the same reason, and because
 * a second copy of a magic-byte table is a second table to be wrong.
 */
export function detectFormat(head: Uint8Array): SheetFormat {
  if (startsWith(head, ZIP)) return 'xlsx';

  if (startsWith(head, OLE2)) {
    throw new ImportError(
      'UNSUPPORTED_FORMAT',
      'This is a pre-2007 Excel file (.xls). Save it as .xlsx or .csv and try again.',
    );
  }
  if (startsWith(head, UTF16_LE) || startsWith(head, UTF16_BE)) {
    throw new ImportError(
      'UNSUPPORTED_FORMAT',
      'This file is UTF-16 encoded. Save it as UTF-8 CSV and try again.',
    );
  }

  // Anything else is read as delimited text. A binary file that reaches here produces a sheet
  // of nonsense rather than an error, which is the right trade: refusing everything that does
  // not look like text would refuse legitimately unusual encodings too, and nonsense rows are
  // reported per row by the mapping rather than as a mysterious rejection.
  return 'csv';
}
