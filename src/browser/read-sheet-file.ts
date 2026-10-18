/**
 * read-sheet-file.ts — a whole CSV, TSV or `.xlsx` file in, the server's grid out (1.1 spec, A).
 *
 * The server's `readSheet` streams; a browser already holds the file, so this reads it in one
 * pass. Everything that decides *what* the grid is comes from the same code the server runs:
 *
 * - the format, from the first bytes (`shared/sheet-format.ts`), never from the name;
 * - CSV: the main entry's reader and delimiter detection, fed the whole text at once, decoded
 *   the server's way (UTF-8, not fatal, byte-order mark dropped);
 * - `.xlsx`: the same parts picked from the archive and repacked the same way
 *   (`shared/zip.ts`), then each cell through the same rules (`shared/xlsx-cells.ts`);
 * - the limits, their defaults, the row checks and the error codes and messages
 *   (`shared/limits.ts`, `shared/sheet-guards.ts`, `shared/import-error.ts`).
 *
 * The one difference is the parser's entry point. The server uses ExcelJS's streaming
 * `WorkbookReader`, which only its Node build has; a browser build has `Workbook.xlsx.load`.
 * Two things make `load` read what the streaming reader reads:
 *
 * - it is told to ignore every worksheet node but `sheetData`, as the streaming reader does.
 *   Merges, hyperlinks and the rest are never applied (a merged range's covered cells stay
 *   empty, a hyperlink cell stays its text), and a part never parsed cannot be hostile;
 * - a formula's cached result is reduced the way the streaming reader reduces it
 *   (`streamedResult`).
 */
import type ExcelJSModule from 'exceljs';
import { cellText, completeFirstLine, createCsvReader, detectDelimiter, type CsvDelimiter, type SheetGrid } from 'sheet-to-schema';
import { ImportError } from '../shared/import-error';
import { resolveLimits, type ImportLimits } from '../shared/limits';
import { loadPeer } from '../shared/optional';
import { guardHeaders, guardRow } from '../shared/sheet-guards';
import { detectFormat, MAGIC_BYTES } from '../shared/sheet-format';
import { rowCells } from '../shared/xlsx-cells';
import { pickFromDirectory } from '../shared/zip';

/** The limits a browser read enforces. Each one left out is the server's default. */
export type BrowserLimits = Pick<ImportLimits, 'maxBytes' | 'maxRows' | 'maxColumns' | 'maxCellLength' | 'maxZipEntries'>;

export interface ReadSheetFileOptions {
  /**
   * The file's name. A delimiter hint only, as on the server: once the bytes have said the file
   * is text, a name ending in `.tsv` means tab. It never decides the format.
   */
  filename?: string;
  limits?: Partial<BrowserLimits>;
}

/** What `readSheetFile` reads: the grid, what the bytes turned out to be, and a CSV's separator. */
export interface SheetFile extends SheetGrid {
  format: 'csv' | 'xlsx';
  /** The separator a CSV turned out to use; pass it to `decimalMarkFor`. Absent for a workbook. */
  delimiter?: CsvDelimiter;
}

/** What a file can arrive as: a `File` or other `Blob`, or its bytes. */
export type SheetFileInput = Blob | ArrayBuffer | Uint8Array;

type ExcelJS = typeof ExcelJSModule;

/** Loaded on the first workbook, never for a CSV: a CSV-only app never downloads it. */
const loadExcel = (): Promise<ExcelJS> =>
  loadPeer('sheet-to-schema/browser', 'exceljs', 'read .xlsx files', async () => (await import('exceljs')).default);

/**
 * Read a CSV, TSV or `.xlsx` file into exactly the grid the server's `readSheet` reads from the
 * same bytes: the same headers, the same rows with the same typed cells, the same separator,
 * and the same refusals with the same codes and messages.
 *
 * @throws ImportError `TOO_LARGE`, `SHEET_TOO_LARGE`, `UNSUPPORTED_FORMAT`, `MALFORMED_FILE`,
 *   `ARCHIVE_REFUSED`, as the server would. A workbook read without `exceljs` installed throws a
 *   plain `Error` saying what to install.
 */
export async function readSheetFile(input: SheetFileInput, options: ReadSheetFileOptions = {}): Promise<SheetFile> {
  const limits = resolveLimits(options.limits);
  const bytes = await bytesOf(input, limits.maxBytes);
  const format = detectFormat(bytes.subarray(0, MAGIC_BYTES));
  if (format === 'xlsx') return { format, ...(await xlsxGrid(bytes, limits)) };
  return csvGrid(bytes, limits, /\.tsv$/i.test(options.filename ?? '') ? '\t' : undefined);
}

/**
 * Read an `.xlsx` file by the server's rules, for a caller that already knows the format.
 *
 * @throws ImportError `UNSUPPORTED_FORMAT` for anything that is not a zip, and whatever
 *   `readSheetFile` throws for a workbook.
 */
export async function readXlsx(input: SheetFileInput, options: Omit<ReadSheetFileOptions, 'filename'> = {}): Promise<SheetGrid> {
  const limits = resolveLimits(options.limits);
  const bytes = await bytesOf(input, limits.maxBytes);
  if (detectFormat(bytes.subarray(0, MAGIC_BYTES)) !== 'xlsx') {
    throw new ImportError('UNSUPPORTED_FORMAT', 'This is not an .xlsx workbook. Read a CSV with readSheetFile.');
  }
  return xlsxGrid(bytes, limits);
}

// ─── Bytes ────────────────────────────────────────────────────────────────────────────────

const tooLarge = (maxBytes: number): never => {
  throw new ImportError('TOO_LARGE', `The file is larger than the ${maxBytes} byte limit.`);
};

/**
 * The input's bytes, refusing past `maxBytes` before reading a `Blob` at all.
 *
 * Told apart by shape, not `instanceof`: a typed array or a `Blob` from another realm (an
 * iframe, a test environment) fails `instanceof` and is still one.
 */
async function bytesOf(input: SheetFileInput, maxBytes: number): Promise<Uint8Array> {
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
  throw new TypeError('readSheetFile reads a Blob (such as a File), an ArrayBuffer or a Uint8Array.');
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

// ─── CSV ──────────────────────────────────────────────────────────────────────────────────

/** The server's `csvRows`, given the whole file as its one chunk. */
function csvGrid(bytes: Uint8Array, limits: ImportLimits, forced: CsvDelimiter | undefined): SheetFile {
  // Not `fatal`, as on the server: one bad byte is one U+FFFD in one cell the importer can
  // report on, not a reason to refuse the file.
  const text = new TextDecoder('utf-8').decode(bytes);
  const line = completeFirstLine(text);
  if (line === null && text.length > limits.maxCellLength * limits.maxColumns + limits.maxColumns) {
    throw new ImportError('SHEET_TOO_LARGE', 'The header row is longer than any row may be.');
  }
  const delimiter = forced ?? detectDelimiter(line ?? text);
  const reader = createCsvReader({ delimiter });
  const { headers, rows } = guardGrid([...reader.push(text), ...reader.end()], limits);
  return { format: 'csv', headers, rows, delimiter };
}

/** Header row through `cellText`, then every data row through the server's checks, in order. */
function guardGrid(raw: Iterable<unknown[]>, limits: ImportLimits): SheetGrid {
  const iterator = raw[Symbol.iterator]();
  const first = iterator.next();
  const headers = first.done ? [] : first.value.map(cellText);
  guardHeaders(headers, limits);
  const rows: unknown[][] = [];
  for (let next = iterator.next(); !next.done; next = iterator.next()) rows.push(guardRow(next.value, rows.length + 1, headers.length, limits));
  return { headers, rows };
}

// ─── xlsx ─────────────────────────────────────────────────────────────────────────────────

/**
 * The archive is checked by its directory and cut down to the server's parts before ExcelJS is
 * even loaded, so an over-limit zip never reaches it.
 */
async function xlsxGrid(bytes: Uint8Array, limits: ImportLimits): Promise<SheetGrid> {
  const archive = pickFromDirectory(bytes, limits);
  const Excel = await loadExcel();
  const workbook = new Excel.Workbook();
  try {
    await workbook.xlsx.load(archive as unknown as Parameters<typeof workbook.xlsx.load>[0], { ignoreNodes: IGNORED_NODES } as object);
  } catch (error) {
    // What the parser says about itself is not for the caller to show, as on the server.
    throw new ImportError('MALFORMED_FILE', 'This is not a readable workbook.', { cause: error });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount === 0) {
    // As on the server: a sheet with not one row is not a file anyone meant to import, and
    // "imported 0 rows" is the wrong thing to say about it.
    throw new ImportError('MALFORMED_FILE', 'This workbook has no readable rows.');
  }
  return guardGrid(sheetRows(sheet, workbook.properties.date1904 === true, limits), limits);
}

/** Every worksheet node `load` would parse but the server's streaming reader does not. */
const IGNORED_NODES = [
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'autoFilter', 'mergeCells', 'rowBreaks',
  'hyperlinks', 'pageMargins', 'dataValidations', 'pageSetup', 'headerFooter', 'printOptions', 'picture',
  'drawing', 'sheetProtection', 'tableParts', 'conditionalFormatting', 'extLst',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A formula cell's value as the server's streaming reader produces it.
 *
 * That reader keeps a formula's cached result as text when Excel stored it as text, and
 * otherwise as `parseFloat` of the stored text, applying no style. So a cached boolean is `1`
 * or `0`, an error is no result (an empty cell), and a date-formatted result is its serial
 * number, where `load` would give `true`, `{ error }` and a `Date`. Mirrored, not fixed: the
 * server's result is the reference, and changing both sides is a decision of its own.
 */
function streamedResult(value: unknown, date1904: boolean): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const cell = value as Record<string, unknown>;
  if (!('formula' in cell || 'sharedFormula' in cell)) return value;
  const result = cell['result'];
  if (typeof result === 'boolean') return { ...cell, result: result ? 1 : 0 };
  if (result instanceof Date) return { ...cell, result: result.getTime() / DAY_MS + (date1904 ? 24107 : 25569) };
  if (result !== null && typeof result === 'object') return { ...cell, result: undefined };
  return value;
}

/**
 * The server's `xlsxRows` over a loaded worksheet: every row from 1, a gap filled with blank
 * rows so later rows keep their numbers, a row past `maxRows` refused before its gap is made.
 */
function* sheetRows(sheet: ExcelJSModule.Worksheet, date1904: boolean, limits: ImportLimits): Generator<unknown[]> {
  let expected = 1;
  for (let number = 1; number <= sheet.rowCount; number++) {
    const row = sheet.findRow(number);
    if (!row) continue;
    if (number - 1 > limits.maxRows) {
      throw new ImportError('SHEET_TOO_LARGE', `The sheet has more than ${limits.maxRows} rows.`);
    }
    while (expected < number) {
      yield [];
      expected++;
    }
    const values: unknown[] = [];
    row.eachCell((cell, column) => {
      values[column] = streamedResult(cell.value, date1904);
    });
    yield rowCells(values);
    expected = number + 1;
  }
}
