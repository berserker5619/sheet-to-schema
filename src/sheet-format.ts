/**
 * sheet-format.ts — what a file is, decided by its first bytes.
 *
 * Browser-safe and shared, so the server's `readSheet`, `sheet-to-schema/browser`'s
 * `readSheetFile` and `readCsvFile` refuse the same files with the same messages and read the
 * rest the same way. In the main entry (`@internal`) since 1.2, because `readCsvFile` is.
 */
import { ImportError } from './import-error';

/** The formats this package reads. Both are decided by magic bytes. */
export type SheetFormat = 'csv' | 'xlsx';

/**
 * The bytes a file is classified by: its signatures, and from 2.0 whether text is what follows
 * (a NUL in the first 8 KB is binary). A file shorter than this is classified whole. @internal
 */
export const MAGIC_BYTES = 8 * 1024;

const ZIP = [0x50, 0x4b]; // "PK"
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0]; // a pre-2007 .xls, which is a compound file, not a zip
const UTF16_LE = [0xff, 0xfe];
const UTF16_BE = [0xfe, 0xff];

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  signature.every((byte, i) => bytes[i] === byte);

/** Said for every file refused as binary, by every reader, so all five say the same thing. */
export const BINARY_MESSAGE = 'This file is not a spreadsheet: it holds binary data. Save it as .xlsx or as UTF-8 CSV and try again.';

/**
 * What these bytes actually are, from the first `MAGIC_BYTES` of a file (docs/2.0-spec.md, §4.2):
 *
 * 1. `PK` is a zip, so a workbook;
 * 2. the OLE2 signature is a pre-2007 `.xls`, refused;
 * 3. a UTF-16 byte-order mark is UTF-16 text, refused;
 * 4. a NUL byte anywhere in them is binary, refused (2.0);
 * 5. anything else is CSV.
 *
 * Exported because the multipart layer wants the same answer for the same reason, and because
 * a second copy of a magic-byte table is a second table to be wrong.
 *
 * @internal
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

  // A NUL is binary. UTF-8 text holds one only to encode U+0000, which no spreadsheet program
  // writes into a cell, and every legacy single-byte encoding a CSV arrives in has none either.
  // So this refuses an image, a PDF or an executable without refusing any text 1.x read: the
  // rule is the presence of one byte, never a guess at how much of a file "looks like" text.
  // Only the first `MAGIC_BYTES` are looked at; a NUL after them is read as text, as in 1.x.
  const end = Math.min(head.length, MAGIC_BYTES);
  for (let i = 0; i < end; i++) {
    if (head[i] === 0) throw new ImportError('UNSUPPORTED_FORMAT', BINARY_MESSAGE);
  }

  return 'csv';
}
