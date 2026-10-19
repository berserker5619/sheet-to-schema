/**
 * run-import.ts — a file in, records out, with memory bounded by `batchSize` and not by the file.
 *
 * Moved from Dynamic Entity's server, with the config taken out: it takes a `SchemaAdapter`
 * and the context that adapter wants, and runs the main entry's `applyMapping` over each batch.
 * So a row is read by the same engine here and in a browser, and the two cannot disagree
 * about what a file produces.
 *
 * What this adds to the engine is what a file too large to hold needs:
 * - rows are pulled a batch at a time, and the next batch is not pulled until `onBatch` has
 *   finished with this one, which is the backpressure;
 * - errors are counted exactly and retained up to `maxReportedErrors`, since a file where
 *   every row fails is otherwise as large as the file;
 * - the plan is checked before a single row is read.
 *
 * **Grouping streams** (docs/1.1-spec.md, B), on by default from 2.0 (docs/2.0-spec.md, D4).
 * `grouping: false` refuses a plan with `group` before a row is read, exactly as 1.0 refused it
 * and as 1.x did by default. On, rows go through the main entry's mapping session,
 * the one `applyMapping` runs on, so a grouped file gives the same records here as in memory.
 * A group that straddles a batch boundary is carried into the next batch and handed to
 * `onBatch` whole. Peak memory is the batch, the open group and the closed keys, each bounded
 * (`batchSize`, `maxGroupRows`, `maxGroups` and `maxGroupKeyBytes`); past one, or when a closed
 * key comes back, the run stops with the engine's `ImportFailure`. Non-contiguous grouping
 * would hold every group to the end, so it is refused before a row is read either way.
 *
 * **A run can be stopped, and watched** (2.0; docs/2.0-spec.md, §2.1). `signal` stops reading at
 * once and starts no new batch, but never interrupts an `onBatch` that is running: a batch half
 * written is the one outcome worse than a batch not written. `onProgress` is told the bytes and
 * rows read after each batch, for a job that reports `bytesRead / size`.
 */

import {
  cellText,
  decimalMarkFor,
  preparePlan,
  slotsFor,
  startMapping,
  suggestMapping,
  type CsvDelimiter,
  type DateOrder,
  type ImportRowError,
  type MappingPlan,
  type PlanProblem,
  type SchemaAdapter,
} from 'sheet-to-schema';
import { destroySource, toByteStream, type ByteSource } from './bytes';
import { ImportError } from './errors';
import { resolveLimits, type ImportLimits } from './limits';
import { readSheet, type SheetFormat } from './read-sheet';

/** Where a batch sits in the user's spreadsheet, for a consumer that logs or reports progress. */
export interface BatchInfo {
  /** Zero-based batch number. */
  index: number;
  /**
   * Spreadsheet row number of the first row this batch's records were built from: the batch's
   * first row, or where a group carried into it began.
   */
  firstRow: number;
  /** Records handed over before this batch, so `imported + records.length` is the running total. */
  imported: number;
}

/**
 * Write a batch of records.
 *
 * **It is awaited, and that is load-bearing.** A consumer writing to a database is slower than
 * a parser reading a file; not awaiting would turn bounded memory into an unbounded queue of
 * pending writes, the exact failure this exists to avoid, reached from the other direction.
 *
 * **It must be idempotent.** A stream that fails at row 30,000 has already written 29,999
 * records, and an HTTP client, or a proxy, or a user, will retry.
 */
export type OnBatch = (records: Record<string, unknown>[], info: BatchInfo) => void | Promise<void>;

/** How far a run has got, for `onProgress`. */
export interface ImportProgress {
  /** Bytes consumed from the input so far. The input's size once the run has finished. */
  bytesRead: number;
  /** Data rows read so far. The result's `rowsRead` once the run has finished. */
  rowsRead: number;
}

export interface RunImportOptions<TMeta = unknown, TCtx = unknown> {
  stream: ByteSource;
  /** Display only, and a delimiter hint. The format is decided by the file's first bytes, never by its name. */
  filename?: string;
  /** A plan as it arrived: v1 or v2, read and checked here before any row is. */
  plan: unknown;
  adapter: SchemaAdapter<TMeta, TCtx>;
  /** Handed to the adapter's `coerce`, `finalize` and `validate` for every row of the run. */
  ctx: TCtx;
  /**
   * The decimal mark in number cells. Defaults to `,` for a CSV that uses `;` between fields,
   * because that is what Excel writes in exactly those locales, and `.` otherwise.
   */
  decimal?: '.' | ',';
  /**
   * The order of a date written in digits, for every plan entry that states none of its own.
   * With neither, a date that reads two ways fails its row: it is never guessed.
   */
  dateOrder?: DateOrder;
  /** Omit to validate without writing: the identical pipeline, every error, nothing stored. */
  onBatch?: OnBatch;
  /**
   * Import a plan with `group` (contiguous groups only). Default `true` from 2.0 (it was `false`
   * in 1.x). `false` refuses such a plan with `INVALID_PLAN` carrying `PLAN_GROUP` (reason
   * `grouping-disabled`) and `GROUPING_NOT_STREAMED`, as 1.x did by default. `contiguous: false`
   * is refused either way (reason `non-contiguous`).
   */
  grouping?: boolean;
  limits?: Partial<ImportLimits>;
  /**
   * Stops the run (2.0). Already aborted: nothing is read. Aborted during the run: reading stops
   * at once and no new batch starts; an `onBatch` already running is waited for, never
   * interrupted. Either way the source is destroyed and the run rejects with `ImportError`
   * `ABORTED`, whose `details` are the counts so far (`rowsRead`, `imported`, `failed`) and whose
   * `cause` is the signal's `reason`. Bound a run's time with `AbortSignal.timeout(ms)`.
   */
  signal?: AbortSignal;
  /**
   * Told the bytes and rows read so far (2.0): at most once per batch, after its `onBatch` has
   * settled, and once when the run finishes, when `bytesRead` is the input's size and `rowsRead`
   * the result's. Values never decrease. Never awaited; anything it throws or rejects with is
   * ignored and does not affect the run. A plan refused before a row is read reports nothing.
   */
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportRunResult {
  /**
   * Records the run produced, and therefore, when `onBatch` was supplied, how many were
   * handed over to be written. The records themselves are deliberately not here: returning
   * fifty thousand of them would undo the streaming this whole file is for.
   */
  imported: number;
  /** Rows that held no values at all. A blank line is not an error and is not a record. */
  skipped: number;
  /**
   * Rows that produced at least one error, counted exactly, **not** derived from `errors`,
   * which is capped: the distinct rows in it say how many fitted in the cap, not how many failed.
   */
  failed: number;
  /** Sheet rows the imported records came from. `rowsInImported + skipped + failed === rowsRead`. */
  rowsInImported: number;
  /** A **sample**, capped at `limits.maxReportedErrors`. `errorCount` is the true total. */
  errors: ImportRowError[];
  /** Every problem found, whether or not it was retained. */
  errorCount: number;
  /** `errors` is shorter than `errorCount`. */
  truncated: boolean;
  /** A sample of the warnings, capped like `errors`. A record with a warning was imported. */
  warnings: ImportRowError[];
  /** Every warning found, whether or not it was retained. */
  warningCount: number;
  /** What is wrong with the plan itself. An `error` here means no row was read at all. */
  planProblems: PlanProblem[];
  /** Data rows read from the sheet, blank ones included. */
  rowsRead: number;
  /**
   * What the file turned out to be, **absent when no byte of it was ever read**. A plan
   * refused before the stream is touched has nothing to report here, and a guessed field is
   * worse than a missing one: it is indistinguishable from a measured one.
   */
  format?: SheetFormat;
}

/** What a server tells a client whose plan groups rows, when it runs with `grouping: false` (1.0's refusal). */
export const GROUPING_NOT_STREAMED =
  'This server version does not group rows into records yet. The browser import does: import this file there, or remove "group" from the plan.';

/**
 * What a server with grouping on tells a client whose plan groups rows that are not together
 * (`group.contiguous: false`). Holding every group to the end of the file is not bounded by a
 * batch, so the streaming runner does not; the in-memory engine does.
 */
export const NON_CONTIGUOUS_NOT_STREAMED =
  'This server groups rows only when each group\'s rows are together. Sort the sheet by the key columns and set "contiguous" to true, or import this file in the browser, which can gather them.';

/** Counts the bytes a source gives up as they are pulled, for `onProgress`. */
async function* counting(source: ByteSource, count: (bytes: number) => void): AsyncGenerator<Uint8Array> {
  for await (const chunk of toByteStream(source)) {
    count(chunk.byteLength);
    yield chunk;
  }
}

/** The rejection for a run its signal stopped. */
function abortedWith(signal: AbortSignal, counts: { rowsRead: number; imported: number; failed: number }): ImportError {
  return new ImportError('ABORTED', 'The import was cancelled.', { cause: signal.reason, details: counts });
}

export async function runImport<TMeta, TCtx>(options: RunImportOptions<TMeta, TCtx>): Promise<ImportRunResult> {
  const limits = resolveLimits(options.limits);
  const { adapter, ctx, onBatch, signal, onProgress } = options;

  if (signal?.aborted) {
    // Not a byte read. The source is still open, and an undrained socket is a leaked handle.
    destroySource(options.stream);
    throw abortedWith(signal, { rowsRead: 0, imported: 0, failed: 0 });
  }

  // The plan is checked before a single row is read. A plan naming a field the schema does
  // not have is wrong about every row, so discovering it at row 30,000 of a file that has
  // already written 29,999 records is the worst available moment.
  const prepared = preparePlan(options.plan, adapter);
  if (!prepared.plan) {
    // Nothing was read, so nothing needs unwinding, but the request body is still open, and
    // an undrained socket is a leaked handle.
    destroySource(options.stream);
    return {
      imported: 0,
      skipped: 0,
      failed: 0,
      rowsInImported: 0,
      errors: [],
      errorCount: 0,
      truncated: false,
      warnings: [],
      warningCount: 0,
      planProblems: prepared.problems,
      rowsRead: 0,
    };
  }

  const grouping = options.grouping ?? true;
  if (prepared.plan.group && (!grouping || !prepared.plan.group.contiguous)) {
    // Refused, not ignored: a runner that ignored `group` would import one record per row and
    // report success (spec §4, "Talking to an older server"), and one that ignored
    // `contiguous: false` would fail at the first key that comes back, after writing everything
    // before it.
    destroySource(options.stream);
    const message = grouping ? NON_CONTIGUOUS_NOT_STREAMED : GROUPING_NOT_STREAMED;
    const reason = grouping ? 'non-contiguous' : 'grouping-disabled';
    const problem: PlanProblem = { level: 'error', code: 'PLAN_GROUP', path: 'group', message, reason };
    throw new ImportError('INVALID_PLAN', message, { details: [...prepared.problems, problem] });
  }

  // One listener for the whole run, never a race per row: a reaction attached to a long-lived
  // promise for every pull is never released (see `xlsx-source.ts`). Destroying the source is
  // what stops a read that is waiting on it; the flag is what every row and batch checks.
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    destroySource(options.stream);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let bytesRead = 0;
  const source = onProgress ? counting(options.stream, bytes => (bytesRead += bytes)) : options.stream;

  let sheet: Awaited<ReturnType<typeof readSheet>>;
  try {
    sheet = await readSheet({ stream: source, filename: options.filename, limits });
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    destroySource(options.stream);
    throw aborted && signal ? abortedWith(signal, { rowsRead: 0, imported: 0, failed: 0 }) : error;
  }

  const decimal = options.decimal ?? decimalMarkFor(sheet.delimiter);
  const session = startMapping(prepared.plan, adapter, ctx, {
    decimal,
    dateOrder: options.dateOrder,
    groupLimits: { maxGroupRows: limits.maxGroupRows, maxGroups: limits.maxGroups, maxGroupKeyBytes: limits.maxGroupKeyBytes },
  });
  const errors: ImportRowError[] = [];
  const warnings: ImportRowError[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let rowsInImported = 0;
  let rowsRead = 0;
  let batchIndex = 0;

  /** Never awaited, and nothing it does reaches the run. */
  const report = (): void => {
    if (!onProgress) return;
    try {
      const returned = onProgress({ bytesRead, rowsRead }) as unknown;
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
        (returned as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // A progress callback that fails is the caller's to notice; the import goes on.
    }
  };
  const stopped = (): ImportError => abortedWith(signal as AbortSignal, { rowsRead, imported, failed });

  let batch: unknown[][] = [];
  /** The spreadsheet row number of `batch[0]`. The header is row 1. */
  let firstRow = 2;

  /** Retained, not accumulated: a file where every row fails is as many objects as the file has rows. */
  const retain = (kept: ImportRowError[], found: readonly ImportRowError[]): void => {
    for (const problem of found) {
      if (kept.length >= limits.maxReportedErrors) break;
      kept.push(problem);
    }
  };

  /** Map one batch, or at the end of the file what is still held, and hand its records over. */
  const flush = async (last: boolean): Promise<void> => {
    if (!batch.length && !last) return;
    const rows = batch;
    batch = [];

    // A record handed over now may have begun in an earlier batch: its group was carried here.
    const builtFrom = Math.min(firstRow, session.openFrom() ?? firstRow);
    const pushed = rows.length ? session.push(rows, firstRow) : null;
    const ended = last ? session.finish() : null;
    const result = {
      records: [...(pushed?.records ?? []), ...(ended?.records ?? [])],
      errors: [...(pushed?.errors ?? []), ...(ended?.errors ?? [])],
      warnings: [...(pushed?.warnings ?? []), ...(ended?.warnings ?? [])],
      skipped: (pushed?.skipped ?? 0) + (ended?.skipped ?? 0),
      failed: (pushed?.failed ?? 0) + (ended?.failed ?? 0),
      rowsInImported: (pushed?.rowsInImported ?? 0) + (ended?.rowsInImported ?? 0),
    };

    skipped += result.skipped;
    errorCount += result.errors.length;
    warningCount += result.warnings.length;
    // Rows, not problems: one row failing two checks is one row to go and fix. A group's rows
    // are counted with its record, in the batch that finished it, so the counts add up exactly.
    failed += result.failed;
    rowsInImported += result.rowsInImported;
    retain(errors, result.errors);
    retain(warnings, result.warnings);

    if (result.records.length && onBatch) {
      const info: BatchInfo = { index: batchIndex, firstRow: builtFrom, imported };
      try {
        // Awaited before the next batch is pulled. This is the backpressure.
        await onBatch(result.records, info);
      } catch (cause) {
        throw new ImportError(
          'IMPORT_FAILED',
          'The import stopped partway through. Rows before the failure may already have ' +
            'been written — this import is not transactional.',
          { cause },
        );
      }
    }

    imported += result.records.length;
    firstRow += rows.length;
    if (rows.length || result.records.length) batchIndex++;
  };

  try {
    for await (const row of sheet.rows) {
      if (aborted) break;
      rowsRead++;
      batch.push(row as unknown[]);
      if (batch.length >= limits.batchSize) {
        await flush(false);
        // The batch that was running has finished; no new one starts.
        if (aborted) break;
        report();
      }
    }
    if (aborted) throw stopped();
    await flush(true);
    if (aborted) throw stopped();
  } catch (error) {
    // A failure anywhere — a limit, a malformed file, the consumer's own writer — leaves the
    // request body half-read. Destroying it is what stops a hostile uploader from holding a
    // socket open after the guard that refused them has already fired.
    destroySource(options.stream);
    // An abort makes the read it interrupted fail, and that is the abort's doing. A writer that
    // failed is not: that is the more important fact, and is reported as itself.
    const own = error instanceof ImportError && (error.code === 'IMPORT_FAILED' || error.code === 'ABORTED');
    throw aborted && !own ? stopped() : error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  report();

  return {
    imported,
    skipped,
    failed,
    rowsInImported,
    errors,
    errorCount,
    truncated: errorCount > errors.length,
    warnings,
    warningCount,
    planProblems: prepared.problems,
    rowsRead,
    format: sheet.format,
  };
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export interface PreviewSheetOptions<TMeta = unknown, TCtx = unknown> {
  stream: ByteSource;
  filename?: string;
  adapter: SchemaAdapter<TMeta, TCtx>;
  /** The language the adapter resolves its labels in, for the suggestion. */
  lang?: string;
  limits?: Partial<ImportLimits>;
}

/** What a first look at an uploaded file yields. */
export interface SheetPreview {
  headers: string[];
  /** The first few rows as text, for the mapping screen to show under each column. */
  sample: string[][];
  /** Every inferred match is tagged `guess`. */
  suggestion: MappingPlan;
  /** Data rows in the file, which the whole stream is read to count. */
  rowCount: number;
  format: SheetFormat;
  /** The field separator a CSV uses. Absent for a workbook. */
  delimiter?: CsvDelimiter;
  /** Slots of each array the suggestion was sized for, by array ref (`slotsFor`). */
  slots: Record<string, number>;
}

/**
 * Headers, a sample, and a suggested mapping.
 *
 * The whole file is read, because `rowCount` is a number the user is shown before they commit
 * and "about this many" is not a useful thing to tell someone about their own data. Reading it
 * also means every limit applies to a preview exactly as it applies to an import: a preview
 * endpoint that skipped them would be the cheapest way in.
 *
 * The suggestion is made from the headers alone, which is what a browser makes of them. It is
 * not given the sample rows, with which it would propose a group (spec §8): a group is the
 * user's to confirm on the mapping screen, and a preview is not that screen.
 */
export async function previewSheet<TMeta, TCtx>(options: PreviewSheetOptions<TMeta, TCtx>): Promise<SheetPreview> {
  const limits = resolveLimits(options.limits);
  const sheet = await readSheet({ stream: options.stream, filename: options.filename, limits });

  const sample: string[][] = [];
  let rowCount = 0;

  try {
    for await (const row of sheet.rows) {
      rowCount++;
      if (sample.length < limits.sampleRows) sample.push(row.map(cellText));
    }
  } catch (error) {
    destroySource(options.stream);
    throw error;
  }

  return {
    headers: sheet.headers,
    sample,
    rowCount,
    suggestion: suggestMapping(sheet.headers, options.adapter, { lang: options.lang }),
    format: sheet.format,
    ...(sheet.delimiter ? { delimiter: sheet.delimiter } : {}),
    slots: slotsFor(sheet.headers, options.adapter, undefined, { lang: options.lang }),
  };
}
