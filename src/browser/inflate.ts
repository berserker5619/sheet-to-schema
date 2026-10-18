/**
 * inflate.ts — a raw-deflate entry inflated in a browser, bounded as it goes.
 *
 * `DecompressionStream` is the browser's own (and Node 20's). Inflating is where an archive's
 * real size shows, so the output is counted chunk by chunk and refused past `max` with the
 * server's message.
 */
import { concat } from '../shared/formula-filter';
import { ImportError } from '../shared/import-error';

/** A failure to write is the same failure the reader reports; it is not reported twice. */
const ignore = (): void => undefined;

export async function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot read .xlsx files: it has no DecompressionStream. Use a current browser, or save the sheet as CSV.');
  }
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
