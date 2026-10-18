/**
 * sheet-guards.ts — the row, column and cell bounds: the main entry's, by name.
 *
 * In the main entry since 1.1.1, where `readCsvFile` uses it too. Kept here so `/node`, `/browser`
 * and the rest of `shared/` import it as before, and get the one copy the main entry has.
 */
export { guardGrid, guardHeaders, guardRow } from 'sheet-to-schema';
