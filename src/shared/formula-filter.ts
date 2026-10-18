/**
 * formula-filter.ts — worksheet XML with its formulas taken out, so each formula cell is read as
 * the typed cell its cached result is.
 *
 * Browser-safe and shared: the server filters the worksheet as it rebuilds the archive
 * (`node/strip-formulas.ts`), the browser before ExcelJS loads it, so both parse the same XML.
 *
 * Why: with its `<f>` in place, ExcelJS's streaming reader keeps a cached result as text when
 * Excel stored it as text and otherwise as `parseFloat` of it, unstyled (a `TRUE` read as `1`,
 * an error as nothing, a date as its serial), and `Workbook.xlsx.load` drops a cached `0` or
 * `false`. Without it, both read the cell by their ordinary path: `t="b"` a boolean, `t="e"` its
 * error text, a number in a date format a `Date`, `0` as `0`. An import reads a formula's result
 * and never its formula, so taking the formula out loses nothing it uses.
 *
 * Works on bytes: the markup is ASCII, and no byte of a multi-byte UTF-8 character is below
 * 0x80. Formula text cannot hold a `<` (XML escapes it), so `</f>` ends the body.
 */

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const F = 0x66;
const END_TAG = [LT, SLASH, F, GT];
/** What may follow `<f` in an `f` element's tag: `<f>`, `<f/>`, `<f t="shared" …>`. */
const AFTER_NAME = new Set([GT, SLASH, 0x20, 0x09, 0x0d, 0x0a]);

const enum State {
  Outside,
  StartTag,
  Body,
}

/** Removes every `<f …>…</f>` and `<f …/>` from a stream of XML bytes, across any chunking. */
export class FormulaFilter {
  private state = State.Outside;
  private carry: Uint8Array = new Uint8Array(0);
  /** The last byte of the start tag seen so far, to tell `<f …/>` from `<f …>`. */
  private previous = 0;

  /** The next chunk in; what of it is certain to be kept out. */
  push(chunk: Uint8Array): Uint8Array {
    const bytes = this.carry.length ? concat([this.carry, chunk]) : chunk;
    this.carry = new Uint8Array(0);
    const out: Uint8Array[] = [];
    let i = 0;

    while (i < bytes.length) {
      if (this.state === State.Outside) {
        const start = i;
        let j = i;
        let entered = false;
        for (; j < bytes.length; j++) {
          if (bytes[j] !== LT) continue;
          if (j + 2 >= bytes.length) break; // `<` or `<f` at the very end: the next chunk decides.
          if (bytes[j + 1] === F && AFTER_NAME.has(bytes[j + 2])) {
            out.push(bytes.subarray(start, j));
            this.state = State.StartTag;
            this.previous = 0;
            i = j + 2;
            entered = true;
            break;
          }
        }
        if (entered) continue;
        out.push(bytes.subarray(start, j));
        this.carry = bytes.slice(j);
        i = bytes.length;
      } else if (this.state === State.StartTag) {
        const end = bytes.indexOf(GT, i);
        if (end < 0) {
          this.previous = bytes[bytes.length - 1];
          break;
        }
        const before = end > i ? bytes[end - 1] : this.previous;
        this.state = before === SLASH ? State.Outside : State.Body;
        i = end + 1;
      } else {
        const end = indexOfTag(bytes, i);
        if (end < 0) {
          // The formula text is dropped; keep only a tail that could be the start of `</f>`.
          let keep = 0;
          for (let k = Math.min(3, bytes.length - i); k > 0 && !keep; k--) {
            if (END_TAG.slice(0, k).every((byte, n) => bytes[bytes.length - k + n] === byte)) keep = k;
          }
          this.carry = bytes.slice(bytes.length - keep);
          break;
        }
        this.state = State.Outside;
        i = end + END_TAG.length;
      }
    }
    return concat(out);
  }

  /** No more input: whatever was held back to see what came next. */
  end(): Uint8Array {
    const rest = this.state === State.Outside ? this.carry : new Uint8Array(0);
    this.carry = new Uint8Array(0);
    return rest;
  }
}

function indexOfTag(bytes: Uint8Array, from: number): number {
  for (let at = bytes.indexOf(LT, from); at >= 0 && at + 3 < bytes.length; at = bytes.indexOf(LT, at + 1)) {
    if (bytes[at + 1] === SLASH && bytes[at + 2] === F && bytes[at + 3] === GT) return at;
  }
  return -1;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Filter a whole worksheet held in memory. */
export function filterFormulas(xml: Uint8Array): Uint8Array {
  const filter = new FormulaFilter();
  return concat([filter.push(xml), filter.end()]);
}
