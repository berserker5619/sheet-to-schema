/**
 * zip.ts — which parts of an `.xlsx` an import reads, and the archive that holds only those.
 *
 * Browser-safe and shared. The server's `guardZip` walks the upload entry by entry, inflating to
 * measure; the browser's reader reads the central directory instead (it holds the whole file,
 * and inflating is ExcelJS's job there). Both keep the **same parts** by the same rules and
 * repack them the same way, so ExcelJS on either side parses the same archive.
 *
 * What the browser checks here is what the directory *declares*: entry count, sizes, ratio. A
 * file can lie about those, and only inflating would catch it; that check stays on the server,
 * where the file is someone else's. In a browser the file is the user's own, and only their tab
 * is at risk.
 */
import { ImportError } from './import-error';

/** `PK\x03\x04` — the start of a local file header. */
export const LOCAL_HEADER = 0x04034b50;
/** `PK\x01\x02` — a central directory record. */
export const CENTRAL_HEADER = 0x02014b50;
/** `PK\x05\x06` — the end-of-central-directory record. */
export const END_OF_CENTRAL = 0x06054b50;
/** Bytes in a local file header before the name. */
export const HEADER_SIZE = 30;
/** Bytes in a central directory record before the name. */
const CENTRAL_SIZE = 46;
/** Bytes in the end-of-central-directory record, without its comment. */
const END_SIZE = 22;
/** Bit 3 of the general-purpose flags: sizes follow the data rather than preceding it. */
export const HAS_DATA_DESCRIPTOR = 0x08;
/** A size of exactly this means "see the zip64 extra field", which is a size we do not trust. */
export const ZIP64_SENTINEL = 0xffffffff;

export const STORED = 0;
export const DEFLATED = 8;

/** An entry under this many inflated bytes is never refused for its ratio: its header dominates. */
export const RATIO_FLOOR = 64 * 1024;

/**
 * The parts an import reads, in the order exceljs must meet them.
 *
 * Relationships, the workbook and the shared strings before any worksheet — that ordering is
 * what keeps exceljs's streaming reader off its deferral path. Everything not named here, and
 * every worksheet but the lowest-numbered, is dropped.
 */
export const WANTED = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/_rels/workbook.xml.rels',
  'xl/workbook.xml',
  'xl/styles.xml',
  'xl/sharedStrings.xml',
];

const WORKSHEET = /^xl\/worksheets\/sheet(\d+)\.xml$/;

/**
 * The number in `sheetN.xml`, or `null` for anything that is not a worksheet.
 *
 * **Which worksheet an import reads is never decided by byte order.** A user means the first
 * *tab*, and an archive may list `sheet2.xml` before `sheet1.xml`.
 *
 * The lowest number is not *quite* tab order either: the real order lives in `workbook.xml`'s
 * `<sheets>` and the relationship map, which this does not parse. It is a great deal closer
 * than byte order, and it is the same number exceljs matches a worksheet by.
 */
export function sheetNumber(name: string): number | null {
  const match = WORKSHEET.exec(name);
  return match ? Number(match[1]) : null;
}

export const refuse = (message: string): never => {
  throw new ImportError('ARCHIVE_REFUSED', message);
};

/** One part of the rebuilt archive: its data exactly as it was, still compressed. */
export interface PackedEntry {
  name: string;
  method: number;
  data: Uint8Array;
  inflated: number;
  crc: number;
}

/**
 * The tracker both sides use to decide what to keep, entry by entry in archive order: the
 * wanted parts (first copy of each) and the lowest-numbered worksheet.
 */
export class PartPicker<E> {
  readonly kept = new Map<string, E>();
  /** The lowest-numbered worksheet kept so far, which is the one an import reads. */
  sheet: { name: string; number: number } | null = null;

  /** Whether to keep `name`. A worksheet that supersedes the kept one releases it first. */
  wants(name: string): { keep: boolean; released?: E } {
    const number = sheetNumber(name);
    if (number === null) return { keep: WANTED.includes(name) && !this.kept.has(name) };
    if (this.sheet !== null && number >= this.sheet.number) return { keep: false };
    const released = this.sheet ? this.kept.get(this.sheet.name) : undefined;
    if (this.sheet) this.kept.delete(this.sheet.name);
    this.sheet = null;
    return { keep: true, released };
  }

  keep(name: string, entry: E): void {
    this.kept.set(name, entry);
    const number = sheetNumber(name);
    if (number !== null) this.sheet = { name, number };
  }

  /**
   * The kept parts in the order the parser must meet them, or the refusal for an archive with
   * no worksheet.
   */
  ordered(): E[] {
    if (!this.sheet) {
      // Any zip starts `PK`, so a `.docx` or a plain archive reaches here too. Without a workbook
      // part it is not a broken workbook but a different kind of file, and saying so is what
      // tells the user to export the right thing rather than to repair this one.
      if (!this.kept.has('xl/workbook.xml')) {
        throw new ImportError(
          'UNSUPPORTED_FORMAT',
          'This is a zip archive that is not an Excel workbook. Upload an .xlsx or .csv file.',
        );
      }
      throw new ImportError('MALFORMED_FILE', 'This workbook has no worksheet.');
    }
    return [...WANTED, this.sheet.name].map(name => this.kept.get(name)).filter((entry): entry is E => entry !== undefined);
  }
}

/** Repack the kept entries as a zip, in the order given. Entry data is copied, never inflated. */
export function repack(entries: readonly PackedEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const names = entries.map(entry => encoder.encode(entry.name));
  const localSize = entries.reduce((sum, entry, i) => sum + HEADER_SIZE + names[i].length + entry.data.length, 0);
  const directorySize = entries.reduce((sum, _entry, i) => sum + CENTRAL_SIZE + names[i].length, 0);
  const out = new Uint8Array(localSize + directorySize + END_SIZE);
  const view = new DataView(out.buffer);

  let at = 0;
  const offsets: number[] = [];
  entries.forEach((entry, i) => {
    offsets.push(at);
    view.setUint32(at, LOCAL_HEADER, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, 0, true); // flags: sizes are right here, so no data descriptor
    view.setUint16(at + 8, entry.method, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.inflated, true);
    view.setUint16(at + 26, names[i].length, true);
    out.set(names[i], at + HEADER_SIZE);
    out.set(entry.data, at + HEADER_SIZE + names[i].length);
    at += HEADER_SIZE + names[i].length + entry.data.length;
  });

  const directoryStart = at;
  entries.forEach((entry, i) => {
    view.setUint32(at, CENTRAL_HEADER, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 10, entry.method, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.data.length, true);
    view.setUint32(at + 24, entry.inflated, true);
    view.setUint16(at + 28, names[i].length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + CENTRAL_SIZE);
    at += CENTRAL_SIZE + names[i].length;
  });

  view.setUint32(at, END_OF_CENTRAL, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - directoryStart, true);
  view.setUint32(at + 16, directoryStart, true);
  return out;
}

/** The bounds the directory is checked against. */
export interface DirectoryLimits {
  maxZipEntries: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

const malformed = (): never => {
  throw new ImportError('MALFORMED_FILE', 'The workbook could not be read.');
};

/**
 * Check a whole archive by its central directory, and return the parts an import reads,
 * repacked exactly as the server repacks them. Nothing is inflated.
 *
 * Refused with the server's codes and messages: too many entries, a declared total past
 * `maxUncompressedBytes`, a declared ratio past `maxCompressionRatio`, an unsupported method, a
 * stored entry without a declared size. A directory that cannot be read is `MALFORMED_FILE`.
 */
export function pickFromDirectory(bytes: Uint8Array, limits: DirectoryLimits): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);

  // The end record is the last thing in the file, followed by a comment of up to 64 KB.
  let end = -1;
  for (let at = bytes.length - END_SIZE; at >= Math.max(0, bytes.length - END_SIZE - 0xffff); at--) {
    if (u32(at) === END_OF_CENTRAL) {
      end = at;
      break;
    }
  }
  if (end < 0) return malformed();

  const count = u16(end + 10);
  const directoryLength = u32(end + 12);
  const directoryStart = u32(end + 16);
  if (count === 0xffff || directoryStart === ZIP64_SENTINEL) return refuse('The workbook uses zip64, which is not supported.');
  if (count > limits.maxZipEntries) return refuse(`The workbook has more than ${limits.maxZipEntries} entries.`);
  if (directoryStart + directoryLength > end) return malformed();

  const decoder = new TextDecoder('utf-8');
  const picker = new PartPicker<PackedEntry>();
  let total = 0;
  let at = directoryStart;

  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > end || u32(at) !== CENTRAL_HEADER) return malformed();
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressed = u32(at + 20);
    const inflated = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const localOffset = u32(at + 42);
    if (at + CENTRAL_SIZE + nameLength > end) return malformed();
    const name = decoder.decode(bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength));
    at += CENTRAL_SIZE + nameLength + extraLength + commentLength;

    if (compressed === ZIP64_SENTINEL || inflated === ZIP64_SENTINEL) {
      return refuse('The workbook uses zip64, which is not supported.');
    }
    if (method === STORED && (flags & HAS_DATA_DESCRIPTOR) !== 0) {
      return refuse(`Entry "${name}" is stored without a declared size.`);
    }
    if (method !== STORED && method !== DEFLATED) {
      return refuse(`Entry "${name}" uses compression method ${method}, which is not supported.`);
    }
    total += inflated;
    if (total > limits.maxUncompressedBytes) {
      return refuse(`The workbook inflates to more than the ${limits.maxUncompressedBytes} byte limit.`);
    }
    if (inflated > RATIO_FLOOR && inflated / Math.max(compressed, 1) > limits.maxCompressionRatio) {
      return refuse(`An entry in the workbook inflates more than ${limits.maxCompressionRatio} times — refusing it.`);
    }

    if (!picker.wants(name).keep) continue;
    if (localOffset + HEADER_SIZE > bytes.length || u32(localOffset) !== LOCAL_HEADER) return malformed();
    const start = localOffset + HEADER_SIZE + u16(localOffset + 26) + u16(localOffset + 28);
    if (start + compressed > bytes.length) return malformed();
    picker.keep(name, { name, method, data: bytes.subarray(start, start + compressed), inflated, crc });
  }

  return repack(picker.ordered());
}
