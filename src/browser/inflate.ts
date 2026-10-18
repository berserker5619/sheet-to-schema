/**
 * inflate.ts — a raw-deflate entry inflated in a browser, bounded as it goes.
 *
 * `DecompressionStream` is the runtime's own, and its `deflate-raw` format is what a zip entry
 * is: Node 20.12+, Chrome and Edge 103+, Firefox 113+, Safari 16.4+. Inflating is where an
 * archive's real size shows, so the output is counted chunk by chunk and refused past `max` with
 * the server's message.
 */
import { concat } from '../shared/formula-filter';
import { ImportError } from '../shared/import-error';

/** What a runtime without `deflate-raw` is told, with the versions that have it. */
export const UNSUPPORTED_RUNTIME_MESSAGE =
  'Reading .xlsx files needs DecompressionStream with the "deflate-raw" format, which this runtime does not have. ' +
  'Use Node 20.12+, Chrome or Edge 103+, Firefox 113+ or Safari 16.4+, or save the sheet as CSV.';

/**
 * Refuse, before reading a workbook, a runtime that cannot inflate one.
 *
 * The format is what is checked, not only the class: Node 20.0 to 20.11 and Chrome 80 to 102 have
 * `DecompressionStream` and reject `"deflate-raw"` from its constructor, which escaped as a raw
 * `TypeError` in 1.1.0-rc.2 (R1-1 in docs/1.1-rc-feedback.md).
 */
export function assertDeflateRaw(): void {
  try {
    new DecompressionStream('deflate-raw');
  } catch (cause) {
    throw new ImportError('UNSUPPORTED_RUNTIME', UNSUPPORTED_RUNTIME_MESSAGE, { cause });
  }
}

/** A failure to write is the same failure the reader reports; it is not reported twice. */
const ignore = (): void => undefined;

export async function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  assertDeflateRaw();
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // Not awaited: the reader below drains what the writer pushes, and awaiting first would wait
  // on a stream nothing is reading. A failure to inflate surfaces through the reader.
  void writer
    .write(data as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(ignore);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.length;
      if (size > max) {
        await reader.cancel();
        throw new ImportError('ARCHIVE_REFUSED', `The workbook inflates to more than the ${max} byte limit.`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('MALFORMED_FILE', 'This is not a readable workbook.', { cause: error });
  }
  return concat(chunks);
}
