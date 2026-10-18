/**
 * import-error.ts — what the server's readers and the browser reader throw: the main entry's `ImportError`, by name.
 *
 * In the main entry since 1.1.1, where `readCsvFile` uses it too. Kept here so `/node`, `/browser`
 * and the rest of `shared/` import it as before, and get the one copy the main entry has.
 */
export { ImportError } from 'sheet-to-schema';
export type { ImportErrorBody, ImportErrorCode } from 'sheet-to-schema';
