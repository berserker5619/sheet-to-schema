/**
 * guard-zip.ts — open the archive ourselves, and hand the parser only what it should see.
 *
 * An `.xlsx` is a zip, and a zip is the one upload format where the bytes on the wire say
 * nothing about the work they cause. Ten kilobytes can inflate to ten gigabytes. `maxBytes`
 * bounds what arrives and is therefore the wrong guard entirely for this.
 *
 * **Why the archive is rebuilt rather than passed through.** Two reasons, and the second was a
 * surprise:
 *
 * 1. exceljs inflates internally and reports nothing while it does, so a limit applied to its
 *    output is applied after the memory it was protecting has been spent. The inflated size is
 *    knowable early only here, so this inflates every entry to *measure* it and refuses at the
 *    byte that crosses a bound.
 * 2. **exceljs's streaming reader loses entries when a worksheet precedes the shared strings.**
 *    It defers such a worksheet to a temp file, and the archive's entry stream then ends at
 *    that entry — `xl/workbook.xml`, which exceljs's own writer puts *last*, never arrives,
 *    and the reader throws `Cannot read properties of undefined (reading 'sheets')`. Verified
 *    by replicating its parse loop: sixteen entries became eight, on two runs out of three.
 *    Reordering the archive so the strings, the relationships and the workbook all precede the
 *    worksheet avoids the deferral entirely — thirty-two runs, no failures, chunked and whole.
 *
 * Rebuilding also means the parser sees **only the parts an import needs**. The theme, the
 * document properties, the drawings, the printer settings and every worksheet after the first
 * are dropped rather than parsed, and a part that is never parsed cannot be hostile.
 *
 * What this costs is the retained archive, held **compressed** and therefore bounded by
 * `maxBytes` — ten megabytes by default, against a fifty-thousand-row workbook's few. Entry
 * data is re-packed exactly as it arrived; nothing is inflated into memory to be kept.
 */

import zlib from 'node:zlib';
import { ImportError } from './errors';
import type { ImportLimits } from './limits';
import { stripWorksheet } from './strip-formulas';
import {
  CENTRAL_HEADER,
  DEFLATED,
  HAS_DATA_DESCRIPTOR,
  HEADER_SIZE,
  LOCAL_HEADER,
  PartPicker,
  RATIO_FLOOR,
  refuse,
  crc32,
  repack,
  STORED,
  ZIP64_SENTINEL,
} from '../shared/zip';

/** `PK\x07\x08` — the optional signature on a data descriptor. */
const DATA_DESCRIPTOR = 0x08074b50;
/** How much is handed to the inflater at once. Bounds the push-back after a stream ends. */
const SLICE = 64 * 1024;

/** The largest size a non-zip64 header can hold. */
const ZIP32_MAX = 0xffffffff;

// ─── Reading ──────────────────────────────────────────────────────────────────────────────

interface Entry {
  name: string;
  method: number;
  /** The entry's data exactly as it arrived, still compressed. */
  data: Buffer;
  inflated: number;
  crc: number;
}

/**
 * A pull-reader over the incoming bytes.
 *
 * `pushBack` exists for one case: a deflate stream that ends part-way through the slice last
 * handed to the inflater. The tail of that slice belongs to the data descriptor and has to be
 * read again as structure rather than as data.
 */
class ZipScanner {
  private buffer: Buffer = Buffer.alloc(0);
  private eof = false;

  constructor(private readonly iterator: AsyncIterator<Uint8Array>) {}

  get available(): number {
    return this.buffer.length;
  }

  /** Pull until at least `n` bytes are buffered. False means the stream ended first. */
  async need(n: number): Promise<boolean> {
    while (this.buffer.length < n && !this.eof) {
      const next = await this.iterator.next();
      if (next.done) {
        this.eof = true;
        break;
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    }
    return this.buffer.length >= n;
  }

  peek(n: number): Buffer {
    return this.buffer.subarray(0, Math.min(n, this.buffer.length));
  }

  take(n: number): Buffer {
    const chunk = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return chunk;
  }

  pushBack(bytes: Buffer): void {
    if (bytes.length) this.buffer = Buffer.concat([bytes, this.buffer]);
  }
}

/**
 * Resolve when the inflater has processed this chunk, or reject if it could not.
 *
 * The `error` listener is not belt and braces. When zlib rejects the data outright — which is
 * what happens the moment an entry claims to be deflated and is not — it emits `error` and
 * **never calls the write callback**, so a promise built only on that callback never settles.
 * Verified: a sixteen-byte entry of plain text hung a sixty-second test instead of failing it.
 */
function writeChunk(inflater: zlib.InflateRaw, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      inflater.removeListener('error', onError);
      reject(error);
    };
    inflater.once('error', onError);
    inflater.write(chunk, error => {
      inflater.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Give the event loop a turn, so `data` and `end` handlers run before the next decision. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

interface Budget {
  /** Inflated bytes across the whole archive so far. */
  total: number;
  /** Retained compressed bytes so far. */
  retained: number;
  /** Entries seen so far. */
  entries: number;
}

/**
 * Read one deflated entry, measuring what it inflates to and keeping its bytes if wanted.
 *
 * `declared` is the compressed length when the header gave one, and `null` when it did not —
 * a streaming writer (exceljs's own included) writes the sizes *after* the data and leaves the
 * header's at zero, and a hostile file would do exactly the same on purpose. Neither path
 * trusts a declared size for the accounting: the numbers checked are the bytes that came out.
 */
async function readDeflated(
  scanner: ZipScanner,
  budget: Budget,
  limits: ImportLimits,
  name: string,
  declared: number | null,
  keep: boolean,
): Promise<{ data: Buffer; inflated: number; crc: number }> {
  /**
   * Retention counted as it grows, not once the entry is complete.
   *
   * Checking afterwards is too late: by then the memory the limit protects has been spent.
   * `limitBytes` caps the stream upstream too, but this guard must not depend on that.
   */
  const retain = (slice: Buffer): void => {
    budget.retained += slice.length;
    if (budget.retained > limits.maxBytes) {
      refuse(`The workbook is larger than the ${limits.maxBytes} byte limit.`);
    }
  };
  const inflater = zlib.createInflateRaw();
  const kept: Buffer[] = [];
  let produced = 0;
  let consumed = 0;
  let crc = 0;
  let ended = false;
  let failure: Error | null = null;
  let breach: ImportError | null = null;

  /** Both bounds, checked on every chunk that comes out rather than on the entry's total. */
  const check = (): ImportError | null => {
    if (produced > limits.maxUncompressedBytes || budget.total + produced > limits.maxUncompressedBytes) {
      return new ImportError(
        'ARCHIVE_REFUSED',
        `The workbook inflates to more than the ${limits.maxUncompressedBytes} byte limit.`,
      );
    }
    // Measured against what has actually been read, so an unfinished entry cannot hide behind
    // a ratio that would only be computed at the end. The floor keeps a tiny entry, where the
    // deflate header alone dominates, from tripping it.
    if (produced > RATIO_FLOOR && produced / Math.max(consumed, 1) > limits.maxCompressionRatio) {
      return new ImportError(
        'ARCHIVE_REFUSED',
        `An entry in the workbook inflates more than ${limits.maxCompressionRatio} times — refusing it.`,
      );
    }
    return null;
  };

  inflater.on('data', chunk => {
    produced += chunk.length;
    crc = crc32(crc, chunk);
    if (!breach) breach = check();
  });
  inflater.on('end', () => {
    ended = true;
  });
  inflater.on('error', error => {
    failure = error as Error;
  });

  try {
    for (;;) {
      const remaining = declared === null ? Number.POSITIVE_INFINITY : declared - consumed;
      if (remaining <= 0) break;
      if (ended || failure || breach) break;

      if (!(await scanner.need(1))) refuse(`The workbook ends part-way through "${name}".`);

      const slice = Buffer.from(scanner.take(Math.min(SLICE, remaining, scanner.available)));
      // Counted *before* the write, because the inflater emits while the write is awaited and
      // the ratio check runs in that handler. Counting after left `consumed` at zero for the
      // whole of the first slice, so every entry over 64 KB looked like an infinite ratio —
      // a guard that refused a perfectly ordinary fifty-thousand-row workbook.
      consumed += slice.length;
      await writeChunk(inflater, slice);
      if (keep) {
        retain(slice);
        kept.push(slice);
      }
      await settle();

      if (ended && declared === null) {
        // `bytesWritten` is the input the engine actually consumed, which is exactly the
        // length of the deflate stream. Anything past it belongs to the data descriptor.
        const overshoot = consumed - inflater.bytesWritten;
        if (overshoot > 0) {
          scanner.pushBack(slice.subarray(slice.length - overshoot));
          consumed -= overshoot;
          if (keep) {
            kept[kept.length - 1] = slice.subarray(0, slice.length - overshoot);
            budget.retained -= overshoot;
          }
        }
      }
    }

    // A declared length longer than the deflate stream: the rest of the region is still this
    // entry's, so it is consumed rather than re-parsed. Guessing where the next header starts
    // is how a scanner desynchronises.
    while (declared !== null && consumed < declared && !breach) {
      if (!(await scanner.need(1))) refuse(`The workbook ends part-way through "${name}".`);
      const slice = Buffer.from(scanner.take(Math.min(declared - consumed, SLICE, scanner.available)));
      consumed += slice.length;
      if (keep) {
        retain(slice);
        kept.push(slice);
      }
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    // zlib's own complaint, which names zlib. What a response carries instead is this.
    throw new ImportError('MALFORMED_FILE', 'The workbook could not be read.', { cause: error });
  } finally {
    inflater.destroy();
  }

  if (breach) throw breach;
  if (failure) {
    throw new ImportError('MALFORMED_FILE', 'The workbook could not be read.', { cause: failure });
  }

  budget.total += produced;
  return { data: keep ? Buffer.concat(kept) : Buffer.alloc(0), inflated: produced, crc };
}

/** Consume a stored entry, which inflates to exactly itself. */
async function readStored(
  scanner: ZipScanner,
  budget: Budget,
  limits: ImportLimits,
  name: string,
  size: number,
  keep: boolean,
): Promise<{ data: Buffer; inflated: number; crc: number }> {
  const kept: Buffer[] = [];
  let crc = 0;
  let left = size;

  while (left > 0) {
    if (!(await scanner.need(1))) refuse(`The workbook ends part-way through "${name}".`);
    const slice = Buffer.from(scanner.take(Math.min(left, SLICE, scanner.available)));
    crc = crc32(crc, slice);
    if (keep) {
      // Counted as it grows, for the reason given in `readDeflated`.
      budget.retained += slice.length;
      if (budget.retained > limits.maxBytes) {
        refuse(`The workbook is larger than the ${limits.maxBytes} byte limit.`);
      }
      kept.push(slice);
    }
    left -= slice.length;
    budget.total += slice.length;
    if (budget.total > limits.maxUncompressedBytes) {
      refuse(`The workbook inflates to more than the ${limits.maxUncompressedBytes} byte limit.`);
    }
  }

  return { data: keep ? Buffer.concat(kept) : Buffer.alloc(0), inflated: size, crc };
}

/** Consume the data descriptor that follows an entry whose header declared no sizes. */
async function skipDescriptor(scanner: ZipScanner): Promise<void> {
  if (!(await scanner.need(4))) return;
  const signed = scanner.peek(4).readUInt32LE(0) === DATA_DESCRIPTOR;
  const base = signed ? 4 : 0;

  // crc32 plus two sizes, four bytes each — or eight each under zip64. What follows the
  // descriptor is the thing that says which, so both lengths are tried in order.
  for (const width of [base + 12, base + 20]) {
    if (!(await scanner.need(width + 4))) break;
    const next = scanner.peek(width + 4).readUInt32LE(width);
    if (next === LOCAL_HEADER || next === CENTRAL_HEADER) {
      scanner.take(width);
      return;
    }
  }

  if (await scanner.need(base + 12)) scanner.take(base + 12);
}

/**
 * Walk an archive under every archive-shaped bound, and return the parts an import needs.
 *
 * Parsing stops at the first thing that is not a local file header — the central directory —
 * because nothing after the last entry inflates and there is nothing there to guard.
 */
export async function guardZip(
  source: AsyncIterable<Uint8Array>,
  limits: ImportLimits,
): Promise<Buffer> {
  const scanner = new ZipScanner(source[Symbol.asyncIterator]());
  const budget: Budget = { total: 0, retained: 0, entries: 0 };
  /** The wanted parts and the lowest-numbered worksheet seen so far: the ones an import reads. */
  const picker = new PartPicker<Entry>();

  for (;;) {
    if (!(await scanner.need(4))) break;
    if (scanner.peek(4).readUInt32LE(0) !== LOCAL_HEADER) break;

    if (!(await scanner.need(HEADER_SIZE))) {
      refuse('The workbook ends part-way through an entry header.');
    }

    const header = Buffer.from(scanner.peek(HEADER_SIZE));
    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    const declaredCompressed = header.readUInt32LE(18);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);

    if (++budget.entries > limits.maxZipEntries) {
      refuse(`The workbook has more than ${limits.maxZipEntries} entries.`);
    }

    if (!(await scanner.need(HEADER_SIZE + nameLength + extraLength))) {
      refuse('The workbook ends part-way through an entry header.');
    }
    const name = scanner.peek(HEADER_SIZE + nameLength).subarray(HEADER_SIZE).toString('utf8');
    scanner.take(HEADER_SIZE + nameLength + extraLength);

    // One worksheet and no other: a mapping plan addresses one sheet's columns, and carrying
    // the rest would be holding data nothing reads. Which one is decided by `sheetNumber`
    // rather than by the order the archive happens to list them in — see that function.
    const { keep, released } = picker.wants(name);

    // The superseded sheet goes **before** the new one is read, not after. Releasing it
    // afterwards means holding two at once at the moment of changeover, which makes the
    // retention bound depend on the order the archive lists its sheets in: the same workbook
    // sails through ascending and is refused descending.
    if (released) budget.retained -= released.data.length;

    const streamed = (flags & HAS_DATA_DESCRIPTOR) !== 0 || declaredCompressed === ZIP64_SENTINEL;
    let read: { data: Buffer; inflated: number; crc: number };

    if (method === STORED) {
      if (streamed) {
        // A stored entry whose length is written only afterwards cannot be found the end of
        // without seeking, and seeking is what streaming means not doing. No real writer
        // produces one; a file that does is either broken or trying something.
        refuse(`Entry "${name}" is stored without a declared size.`);
      }
      read = await readStored(scanner, budget, limits, name, declaredCompressed, keep);
    } else if (method === DEFLATED) {
      read = await readDeflated(
        scanner,
        budget,
        limits,
        name,
        streamed ? null : declaredCompressed,
        keep,
      );
      if (streamed) await skipDescriptor(scanner);
    } else {
      return refuse(`Entry "${name}" uses compression method ${method}, which is not supported.`);
    }

    if (keep) {
      // The rebuilt archive is written without zip64, so a size a 32-bit header cannot hold
      // would be silently truncated. `maxUncompressedBytes` keeps this out of reach at its
      // default; it is a consumer-settable limit, so the ceiling is checked rather than assumed.
      if (read.data.length > ZIP32_MAX || read.inflated > ZIP32_MAX) {
        refuse(`Entry "${name}" is too large to repack without zip64.`);
      }
      picker.keep(name, { name, method, data: read.data, inflated: read.inflated, crc: read.crc });
    }
  }

  // The worksheet without its formulas, so each formula cell reads as its cached result's type
  // (`strip-formulas.ts`). Rebuilt here, once the sheet is known, and counted against the same
  // retention bound as what it replaces.
  const sheet = picker.sheet ? picker.kept.get(picker.sheet.name) : undefined;
  if (sheet) {
    const stripped = await stripWorksheet(sheet);
    budget.retained += stripped.data.length - sheet.data.length;
    if (budget.retained > limits.maxBytes) refuse(`The workbook is larger than the ${limits.maxBytes} byte limit.`);
    picker.kept.set(sheet.name, { ...sheet, ...stripped });
  }

  const archive = repack(picker.ordered());
  return Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
}
