/**
 * runImport's `signal` and `onProgress` (2.0; docs/2.0-spec.md §2.1, D2 and D3), for a CSV and a
 * workbook, with grouping on and off.
 */
import { Readable } from 'node:stream';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { ImportError } from './errors';
import { runImport, type ImportProgress, type ImportRunResult, type RunImportOptions } from './run-import';
import { workbookOf } from './workbook.fixtures';

const ORDERS = jsonSchemaAdapter(
  {
    $id: 'orders',
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      sku: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } },
    },
  },
  { version: 1 },
);

const HEADERS = ['Order', 'SKU'];
/** 300 rows: orders of three rows each, so a group is always contiguous. */
const ROWS = Array.from({ length: 300 }, (_, i) => [`O${Math.floor(i / 3)}`, `S${i}`]);
const BATCH = 40;

const FLAT = { planVersion: 2, target: 'orders', schemaVersion: 1, entries: [{ ref: 'orderId', column: 0 }, { ref: 'sku', column: 1 }] };
const GROUPED = {
  planVersion: 2,
  target: 'orders',
  schemaVersion: 1,
  entries: [{ ref: 'orderId', column: 0 }, { ref: 'items.sku', column: 1 }],
  group: { key: [0], collect: ['items'] },
};

interface Case {
  format: 'csv' | 'xlsx';
  grouping: boolean;
  bytes: () => Promise<Buffer>;
}

const csvBytes = async (): Promise<Buffer> => Buffer.from([HEADERS, ...ROWS].map(row => row.join(',')).join('\r\n') + '\r\n');
const xlsxBytes = async (): Promise<Buffer> => workbookOf(HEADERS, ROWS);

const CASES: Case[] = [
  { format: 'csv', grouping: false, bytes: csvBytes },
  { format: 'csv', grouping: true, bytes: csvBytes },
  { format: 'xlsx', grouping: false, bytes: xlsxBytes },
  { format: 'xlsx', grouping: true, bytes: xlsxBytes },
];

/**
 * A Node stream over `bytes` in small chunks, that counts what was read from it. `stallAfter`
 * stops supplying bytes after that many, without ending: a client that has gone quiet.
 */
function source(bytes: Buffer, { chunk = 512, stallAfter }: { chunk?: number; stallAfter?: number } = {}) {
  let at = 0;
  let reads = 0;
  const stream = new Readable({
    read() {
      reads++;
      if (stallAfter !== undefined && at >= stallAfter) return;
      if (at >= bytes.length) {
        this.push(null);
        return;
      }
      this.push(bytes.subarray(at, at + chunk));
      at += chunk;
    },
  });
  return { stream, reads: () => reads, sent: () => Math.min(at, bytes.length) };
}

function optionsFor(c: Case, stream: Readable, extra: Partial<RunImportOptions<unknown, undefined>> = {}): RunImportOptions<unknown, undefined> {
  return {
    stream,
    filename: `orders.${c.format}`,
    plan: c.grouping ? GROUPED : FLAT,
    adapter: ORDERS,
    ctx: undefined,
    grouping: c.grouping,
    limits: { batchSize: BATCH },
    ...extra,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ImportError> {
  try {
    await promise;
  } catch (error) {
    return error as ImportError;
  }
  throw new Error('expected the run to reject');
}

const records = (c: Case): number => (c.grouping ? ROWS.length / 3 : ROWS.length);

describe.each(CASES)('runImport, $format, grouping $grouping', c => {
  let bytes: Buffer;
  let baseline: ImportRunResult;
  beforeAll(async () => {
    bytes = await c.bytes();
    baseline = await runImport(optionsFor(c, source(bytes).stream, { onBatch: () => undefined }));
    expect(baseline.imported).toBe(records(c));
    expect(baseline.rowsRead).toBe(ROWS.length);
  });

  describe('signal (D2)', () => {
    it('aborted before the start: nothing is read, the stream is destroyed, ABORTED with zero counts', async () => {
      const { stream, reads } = source(bytes);
      const controller = new AbortController();
      controller.abort();
      const batches: unknown[] = [];

      const error = await rejection(runImport(optionsFor(c, stream, { signal: controller.signal, onBatch: records => void batches.push(records) })));

      expect(error).toBeInstanceOf(ImportError);
      expect(error).toMatchObject({ code: 'ABORTED', message: 'The import was cancelled.', details: { rowsRead: 0, imported: 0, failed: 0 } });
      expect(error.status).toBe(499);
      expect(reads()).toBe(0);
      expect(batches).toEqual([]);
      expect(stream.destroyed).toBe(true);
    });

    it('aborted mid-file: stops reading, starts no new batch, destroys the stream, and counts what it did', async () => {
      const { stream, sent } = source(bytes);
      const controller = new AbortController();
      let imported = 0;
      let calls = 0;
      // Aborted by the source itself, part-way through the bytes.
      stream.on('data', () => {
        if (sent() >= bytes.length / 2) controller.abort();
      });

      const error = await rejection(
        runImport(
          optionsFor(c, stream, {
            signal: controller.signal,
            onBatch: records => {
              calls++;
              imported += records.length;
            },
          }),
        ),
      );

      expect(error.code).toBe('ABORTED');
      const details = error.details as { rowsRead: number; imported: number; failed: number };
      expect(details.imported).toBe(imported);
      expect(details.rowsRead).toBeLessThan(ROWS.length);
      expect(details.failed).toBe(0);
      expect(imported).toBeLessThan(records(c));
      expect(stream.destroyed).toBe(true);
      // No batch after the abort: nothing more is handed over once it has rejected.
      const after = calls;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(calls).toBe(after);
    });

    it('aborted during onBatch: that batch completes, no further one starts, and no progress follows', async () => {
      const { stream } = source(bytes);
      const controller = new AbortController();
      const started: number[] = [];
      const finished: number[] = [];
      const progress: ImportProgress[] = [];
      let written = 0;

      const error = await rejection(
        runImport(
          optionsFor(c, stream, {
            signal: controller.signal,
            onProgress: p => void progress.push(p),
            onBatch: async (records, info) => {
              started.push(info.index);
              if (info.index === 1) controller.abort();
              // Still writing well after the abort: it must be waited for, not cut off.
              await new Promise(resolve => setTimeout(resolve, 30));
              written += records.length;
              finished.push(info.index);
            },
          }),
        ),
      );

      expect(error.code).toBe('ABORTED');
      expect(started).toEqual([0, 1]);
      expect(finished).toEqual([0, 1]);
      // Told about batch 0 only: batch 1 finished after the abort, and the run is over.
      expect(progress).toHaveLength(1);
      expect((error.details as { imported: number }).imported).toBe(written);
      expect(stream.destroyed).toBe(true);
    });

    it('aborted after the end: no effect', async () => {
      const { stream } = source(bytes);
      const controller = new AbortController();
      const result = await runImport(optionsFor(c, stream, { signal: controller.signal, onBatch: () => undefined }));
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(result).toEqual(baseline);
      expect(stream.destroyed).toBe(true);
    });

    it('abandons a read waiting on a stalled source at once, with the signal\'s reason as the cause', async () => {
      const { stream } = source(bytes, { stallAfter: Math.floor(bytes.length / 2) });
      const started = Date.now();

      const error = await rejection(runImport(optionsFor(c, stream, { signal: AbortSignal.timeout(150), onBatch: () => undefined })));

      expect(error.code).toBe('ABORTED');
      expect((error as { cause?: { name?: string } }).cause?.name).toBe('TimeoutError');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(stream.destroyed).toBe(true);
    });

    it('reports a writer that failed as IMPORT_FAILED, even with an abort pending', async () => {
      const controller = new AbortController();
      const { stream } = source(bytes);
      const error = await rejection(
        runImport(
          optionsFor(c, stream, {
            signal: controller.signal,
            onBatch: () => {
              controller.abort();
              throw new Error('the database went away');
            },
          }),
        ),
      );
      expect(error.code).toBe('IMPORT_FAILED');
      expect(stream.destroyed).toBe(true);
    });

    it('validates with a signal too (no onBatch)', async () => {
      const controller = new AbortController();
      const { stream } = source(bytes);
      const result = await runImport(optionsFor(c, stream, { signal: controller.signal }));
      expect(result.imported).toBe(records(c));
    });
  });

  describe('onProgress (D3)', () => {
    it('never decreases, is called at most once per batch plus once at the end, and ends at the file size and rowsRead', async () => {
      const calls: ImportProgress[] = [];
      let batches = 0;
      const result = await runImport(
        optionsFor(c, source(bytes).stream, {
          onBatch: () => void batches++,
          onProgress: progress => void calls.push({ ...progress }),
        }),
      );

      expect(calls.length).toBeGreaterThan(1);
      expect(calls.length).toBeLessThanOrEqual(batches + 1);
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i].bytesRead).toBeGreaterThanOrEqual(calls[i - 1].bytesRead);
        expect(calls[i].rowsRead).toBeGreaterThanOrEqual(calls[i - 1].rowsRead);
      }
      expect(calls.at(-1)).toEqual({ bytesRead: bytes.length, rowsRead: result.rowsRead });
    });

    it('ignores a callback that throws, or returns a promise that rejects', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown): void => void unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
        const throwing = await runImport(
          optionsFor(c, source(bytes).stream, {
            onBatch: () => undefined,
            onProgress: () => {
              throw new Error('progress broke');
            },
          }),
        );
        const rejecting = await runImport(
          optionsFor(c, source(bytes).stream, {
            onBatch: () => undefined,
            onProgress: (async () => {
              throw new Error('progress broke later');
            }) as unknown as (progress: ImportProgress) => void,
          }),
        );
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(throwing).toEqual(baseline);
        expect(rejecting).toEqual(baseline);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });

    it('is not awaited', async () => {
      let settled = 0;
      const result = await runImport(
        optionsFor(c, source(bytes).stream, {
          onBatch: () => undefined,
          onProgress: (() => new Promise(() => undefined).then(() => settled++)) as unknown as (progress: ImportProgress) => void,
        }),
      );
      expect(result).toEqual(baseline);
      expect(settled).toBe(0);
    });
  });

  it('parity: a run with signal and onProgress returns what a run without them does, and writes the same records', async () => {
    const plain: Record<string, unknown>[] = [];
    const watched: Record<string, unknown>[] = [];
    const without = await runImport(optionsFor(c, source(bytes).stream, { onBatch: records => void plain.push(...records) }));
    const withBoth = await runImport(
      optionsFor(c, source(bytes).stream, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onBatch: records => void watched.push(...records),
      }),
    );
    expect(withBoth).toEqual(without);
    expect(watched).toEqual(plain);
  });
});

describe('runImport signal and onProgress with nothing to read', () => {
  it('reports no progress for a plan refused before a row is read', async () => {
    const calls: ImportProgress[] = [];
    const result = await runImport({
      stream: Buffer.from('Order,SKU\r\nO1,S1\r\n'),
      plan: { planVersion: 2, target: 'orders', schemaVersion: 1, entries: [{ ref: 'nope', column: 0 }] },
      adapter: ORDERS,
      ctx: undefined,
      onProgress: progress => void calls.push(progress),
    });
    expect(result.planProblems.some(problem => problem.level === 'error')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('removes its abort listener when the run ends', async () => {
    const controller = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (add as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (remove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof signal.removeEventListener;

    await runImport({ stream: Buffer.from('Order,SKU\r\nO1,S1\r\n'), plan: FLAT, adapter: ORDERS, ctx: undefined, signal });
    expect(added).toEqual(['abort']);
    expect(removed).toEqual(['abort']);
  });
});
