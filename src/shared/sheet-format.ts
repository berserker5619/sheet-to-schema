/**
 * sheet-format.ts — what a file is, by its first bytes: the main entry's, by name.
 *
 * In the main entry since 1.2, where `readCsvFile` uses it too. Kept here so `/node`, `/browser`
 * and the rest of `shared/` import it as before, and get the one copy the main entry has.
 */
export { detectFormat, MAGIC_BYTES } from 'sheet-to-schema';
export type { SheetFormat } from 'sheet-to-schema';
