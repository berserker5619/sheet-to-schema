/**
 * strip-formulas.ts — the server's worksheet without its formulas (`shared/formula-filter.ts`
 * says why), rebuilt as the archive is.
 *
 * Streamed: the sheet is inflated, filtered and deflated again chunk by chunk, so what is held
 * is the recompressed sheet, as before, and never the inflated one.
 */
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { FormulaFilter } from '../shared/formula-filter';
import { crc32 } from '../shared/zip';

/** The shared filter as a stream stage. */
export class FormulaStripper extends Transform {
  private readonly formulas = new FormulaFilter();

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    done(null, this.formulas.push(chunk));
  }

  override _flush(done: TransformCallback): void {
    done(null, this.formulas.end());
  }
}

/** Counts and checksums what passes, for the rebuilt entry's header. */
class Measure extends Transform {
  size = 0;
  crc = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.size += chunk.length;
    this.crc = crc32(this.crc, chunk);
    done(null, chunk);
  }
}

/**
 * The worksheet entry rebuilt without formulas: inflated (when it was deflated), filtered, and
 * deflated again, with the size and checksum of what it now holds.
 */
export async function stripWorksheet(entry: { method: number; data: Uint8Array }): Promise<{ method: number; data: Buffer; inflated: number; crc: number }> {
  const measure = new Measure();
  const compressed: Buffer[] = [];
  const stages: NodeJS.ReadWriteStream[] = entry.method === 0 ? [] : [zlib.createInflateRaw()];
  await pipeline(
    Readable.from([Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)]),
    ...(stages as [NodeJS.ReadWriteStream]),
    new FormulaStripper(),
    measure,
    zlib.createDeflateRaw(),
    async function collect(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) compressed.push(chunk);
    },
  );
  return { method: 8, data: Buffer.concat(compressed), inflated: measure.size, crc: measure.crc };
}
