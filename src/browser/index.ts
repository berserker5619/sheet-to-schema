// sheet-to-schema/browser: read a CSV, TSV or .xlsx file in a browser into exactly the grid the
// server's `readSheet` reads from the same bytes (docs/1.1-spec.md, feature A).
//
// Browser-safe; also runs in Node. A CSV reads anywhere; a workbook needs `DecompressionStream`
// with "deflate-raw": Node 20.12+, Chrome and Edge 103+, Firefox 113+, Safari 16.4+ (browsers by
// MDN browser-compat-data 8.1.6, Node tested), and elsewhere fails with UNSUPPORTED_RUNTIME.
// No Node built-ins, and `exceljs` (an optional peer) is loaded only when a workbook is read, so
// a CSV-only app never downloads it. Code here imports the main entry by its package name, as
// `/node` does, so this bundle holds no second copy of the engine.

export { readSheetFile, readXlsx } from './read-sheet-file';
export type { BrowserLimits, ReadSheetFileOptions, SheetFile, SheetFileInput } from './read-sheet-file';

// What a refusal is: the main entry's class (1.2). Match on `code` all the same: a CommonJS
// and an ESM copy of the package are two classes.
export { ImportError } from '../shared/import-error';
export type { ImportErrorCode } from '../shared/import-error';
