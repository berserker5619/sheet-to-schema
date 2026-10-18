/**
 * limits.ts — every bound and its default: the main entry's, by name.
 *
 * In the main entry since 1.1.1, where `readCsvFile` uses it too. Kept here so `/node`, `/browser`
 * and the rest of `shared/` import it as before, and get the one copy the main entry has.
 */
export { DEFAULT_LIMITS, resolveLimits } from 'sheet-to-schema';
export type { ImportLimits } from 'sheet-to-schema';
