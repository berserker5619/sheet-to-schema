// sheet-to-schema/browser: read a CSV, TSV or .xlsx file in a browser into exactly the grid the
// server's `readSheet` reads from the same bytes (docs/1.1-spec.md, feature A).
//
// Browser-safe; also runs in Node 20+. No Node built-ins, and `exceljs` (an optional peer) is
// loaded only when a workbook is read, so a CSV-only app never downloads it. Code here imports
// the main entry by its package name, as `/node` does, so this bundle holds no second copy of
// the engine.

export { readSheetFile, readXlsx } from './read-sheet-file';
export type { BrowserLimits, ReadSheetFileOptions, SheetFile, SheetFileInput } from './read-sheet-file';

// What a refusal is. Match on `code`: `/node` bundles its own copy of the class.
export { ImportError } from '../shared/import-error';
export type { ImportErrorCode } from '../shared/import-error';
