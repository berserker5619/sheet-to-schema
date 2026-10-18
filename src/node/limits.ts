/**
 * limits.ts — `/node`'s limits are the shared ones, so the browser reader enforces the same
 * bounds with the same defaults. See `shared/limits.ts`.
 */
export { DEFAULT_LIMITS, resolveLimits } from '../shared/limits';
export type { ImportLimits } from '../shared/limits';
