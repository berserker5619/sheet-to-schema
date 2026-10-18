/**
 * group-limits.ts — the three bounds on grouping (phase1 §5; 1.1 spec, B).
 *
 * In the main entry so the engine and the server share one definition: `applyMapping` enforces
 * them by default, and the server's `ImportLimits` includes them. Past one, the whole import
 * stops with an `ImportFailure` (`GROUP_TOO_LARGE` or `TOO_MANY_GROUPS`).
 */

export interface GroupLimits {
  /** Rows in one group. A larger group fails with `GROUP_TOO_LARGE`. */
  maxGroupRows: number;
  /**
   * Distinct group keys in the sheet: the closed keys in contiguous mode, every key in
   * non-contiguous mode. More fail with `TOO_MANY_GROUPS`.
   */
  maxGroups: number;
  /**
   * Total UTF-8 bytes of the closed keys, contiguous mode only. A count alone does not bound
   * memory: 200,000 keys of a few long cells can reach hundreds of megabytes. More fail with
   * `TOO_MANY_GROUPS`. Non-contiguous mode holds the whole sheet anyway, so it is not applied.
   */
  maxGroupKeyBytes: number;
}

export const DEFAULT_GROUP_LIMITS: Readonly<GroupLimits> = Object.freeze({
  maxGroupRows: 10_000,
  maxGroups: 200_000,
  maxGroupKeyBytes: 8 * 1024 * 1024,
});

/**
 * Fill in what a caller left out, by the server's rule for limits: a non-finite or non-positive
 * override falls back to the default instead of turning the limit off.
 */
export function resolveGroupLimits(overrides?: Partial<GroupLimits>): GroupLimits {
  const out: GroupLimits = { ...DEFAULT_GROUP_LIMITS };
  for (const key of Object.keys(out) as (keyof GroupLimits)[]) {
    const value = overrides?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = Math.floor(value);
  }
  return out;
}

/** UTF-8 length without encoding: what a key costs to hold, counted the same in every runtime. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
