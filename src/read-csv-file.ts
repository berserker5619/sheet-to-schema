/**
 * read-csv-file.ts — a whole CSV or TSV file in, the server's grid out, from the main entry.
 *
 * The CSV half of `sheet-to-schema/browser`'s `readSheetFile`, for an app that reads no
 * workbooks. Nothing it imports can reach `exceljs`, so it bundles where `exceljs` is not
 * installed. `/browser` cannot: Angular's `ng build` and webpack fail on its `import('exceljs')`
 * even when no workbook is ever read (Dynamic Entity docs/3.1-spec.md, Step 0).
 *
 * Same bytes, same answer: `readSheetFile` reads a CSV with `bytesOf` and `csvGrid` from here,
 * and the format sniffing, limits and row checks are the ones the server's `readSheet` runs,
 * with the same codes and messages. The server streams; a caller here already holds the file,
 * so it reads in one pass, decoded the server's way (UTF-8, not fatal, byte-order mark dropped).
 */
import { completeFirstLine, createCsvReader, detectDelimiter, type CsvDelimiter, type SheetGrid } from './csv';
import { ImportError } from './import-error';
import { resolveLimits, type ImportLimits } from './limits';
import { guardGrid } from './sheet-guards';
import { detectFormat, MAGIC_BYTES } from './sheet-format';

/** What a file can arrive as: a `File` or other `Blob`, or its bytes. */
export type SheetFileInput = Blob | ArrayBuffer | Uint8Array;

/** A CSV read whole: the grid, and the separator it turned out to use. */
export interface CsvFile extends SheetGrid {
  format: 'csv';
  /** Pass it to `decimalMarkFor`, as the server does. */
  delimiter: CsvDelimiter;
}

/** The limits a CSV read enforces. Each one left out is the server's default. */
export type CsvFileLimits = Pick<ImportLimits, 'maxBytes' | 'maxRows' | 'maxColumns' | 'maxCellLength'>;

export interface ReadCsvFileOptions {
  /**
   * The file's name. A delimiter hint only, as on the server: once the bytes have said the file
   * is text, a name ending in `.tsv` means tab. It never decides the format.
   */
  filename?: string;
  limits?: Partial<CsvFileLimits>;
}

/**
 * Read a CSV or TSV file into exactly the grid the server's `readSheet` reads from the same
 * bytes: the same headers, the same rows, and the separator, to pass to `decimalMarkFor`.
 *
 * @throws ImportError `TOO_LARGE` and `SHEET_TOO_LARGE`, as the server would; `UNSUPPORTED_FORMAT`
 *   for a pre-2007 `.xls` or a UTF-16 file, with the server's messages, and for an `.xlsx` (or
 *   any other zip), which `readSheetFile` from `sheet-to-schema/browser` reads.
 */
export async function readCsvFile(input: SheetFileInput, options: ReadCsvFileOptions = {}): Promise<CsvFile> {
  const limits = resolveLimits(options.limits);
  const bytes = await bytesOf(input, limits.maxBytes, 'readCsvFile');
  if (detectFormat(bytes.subarray(0, MAGIC_BYTES)) === 'xlsx') {
    throw new ImportError(
      'UNSUPPORTED_FORMAT',
      'This is an .xlsx workbook. Read it with readSheetFile from sheet-to-schema/browser, or save it as CSV.',
    );
  }
  return csvGrid(bytes, limits, options.filename);
}

const tooLarge = (maxBytes: number): never => {
  throw new ImportError('TOO_LARGE', `The file is larger than the ${maxBytes} byte limit.`);
};

/**
 * The input's bytes, refusing past `maxBytes` before reading a `Blob` at all. `reader` names
 * the function a wrong input was given to. `@internal`: `/browser` reads with it.
 *
 * Told apart by shape, not `instanceof`: a typed array or a `Blob` from another realm (an
 * iframe, a test environment) fails `instanceof` and is still one.
 */
export async function bytesOf(input: SheetFileInput, maxBytes: number, reader: string): Promise<Uint8Array> {
  if (ArrayBuffer.isView(input)) {
    if (input.byteLength > maxBytes) tooLarge(maxBytes);
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') {
    const buffer = input as ArrayBuffer;
    if (buffer.byteLength > maxBytes) tooLarge(maxBytes);
    return new Uint8Array(buffer);
  }
  const blob = input as Blob;
  if (blob !== null && typeof blob === 'object' && typeof blob.size === 'number' && typeof blob.slice === 'function') {
    if (blob.size > maxBytes) tooLarge(maxBytes);
    return new Uint8Array(await blobBuffer(blob));
  }
  throw new TypeError(`${reader} reads a Blob (such as a File), an ArrayBuffer or a Uint8Array.`);
}

/** `Blob.arrayBuffer`, or `FileReader` where a browser or test environment lacks it. */
function blobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * The server's `csvRows`, given the whole file as its one chunk. A `filename` ending in `.tsv`
 * means tab. `@internal`: `/browser` reads a CSV with it.
 */
export function csvGrid(bytes: Uint8Array, limits: CsvFileLimits, filename?: string): CsvFile {
  // Not `fatal`, as on the server: one bad byte is one U+FFFD in one cell the importer can
  // report on, not a reason to refuse the file.
  const text = new TextDecoder('utf-8').decode(bytes);
  const line = completeFirstLine(text);
  if (line === null && text.length > limits.maxCellLength * limits.maxColumns + limits.maxColumns) {
    throw new ImportError('SHEET_TOO_LARGE', 'The header row is longer than any row may be.');
  }
  const delimiter = /\.tsv$/i.test(filename ?? '') ? '\t' : detectDelimiter(line ?? text);
  const reader = createCsvReader({ delimiter });
  const { headers, rows } = guardGrid([...reader.push(text), ...reader.end()], limits);
  return { format: 'csv', headers, rows, delimiter };
}
