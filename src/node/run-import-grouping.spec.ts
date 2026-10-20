/**
 * Grouping in the streaming runner (docs/1.1-spec.md, B): `runImport` gives exactly what
 * `applyMapping` gives for the same rows, at any batch size, fed any way, from a CSV or an
 * `.xlsx`; an open group is carried across a batch boundary and never handed over in part; the
 * limits stop the run with the engine's own failure; and memory stays bounded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { applyMapping, ImportFailure, jsonSchemaAdapter, parseCsv, suggestMapping, type ImportResult, type SchemaAdapter } from 'sheet-to-schema';
import { previewSheet, runImport, type BatchInfo } from './run-import';
import { chunked, collectedHeap } from './sheet.fixtures';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The orders of `grouping.spec.ts`, as a JSON Schema: a required id, an email, and collected
 * items with a required SKU and a whole-number quantity. (`/node` reaches the main entry by
 * name only, so the main entry's test adapter is not imported here.)
 */
const ORDERS_SCHEMA = {
  $id: 'orders',
  type: 'object',
  required: ['orderId'],
  properties: {
    orderId: { type: 'string' },
    customer: { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
    items: { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } } } },
  },
} as const;
const ordersAdapter = (overrides: Partial<SchemaAdapter<unknown, unknown>> = {}): SchemaAdapter<unknown, unknown> => ({
  ...(jsonSchemaAdapter(ORDERS_SCHEMA as never, { version: 1 }) as SchemaAdapter<unknown, unknown>),
  ...overrides,
});

/** Columns: 0 order id, 1 customer email, 2 sku, 3 qty. Grouped by column 0, collecting items. */
const ORDER_PLAN = (group: Record<string, unknown> = {}) => ({
  planVersion: 2,
  target: 'orders',
  entries: [
    { ref: 'orderId', column: 0 },
    { ref: 'customer.email', column: 1 },
    { ref: 'items.sku', column: 2 },
    { ref: 'items.qty', column: 3 },
  ],
  group: { key: [0], collect: ['items'], ...group },
});
const HEADER = ['orderId', 'email', 'sku', 'qty'];

/** The grouping cases of `grouping.spec.ts` that complete, as sheets. */
const GROUPING_FIXTURES: Record<string, string[][]> = {
  'four contiguous keys': [
    ['A', 'a@example.com', 'S1', '1'], ['A', '', 'S2', '2'], ['B', 'b@example.com', 'S3', '1'],
    ['C', 'c@example.com', 'S4', '1'], ['C', '', 'S5', '3'], ['C', '', 'S6', '1'], ['D', 'd@example.com', 'S7', '2'],
  ],
  'a parent field that disagrees': [['A', 'a@example.com', 'S1', '1'], ['A', 'a@example.com', 'S2', '1'], ['A', 'other@example.com', 'S3', '1']],
  'several values that disagree': [
    ['A', 'a@example.com', 'S1', '1'], ['A', 'other@example.com', 'S2', '1'], ['A', 'third@example.com', 'S3', '1'], ['A', 'other@example.com', 'S4', '1'],
  ],
  'a blank first value filled later': [['A', '', 'S1', '1'], ['A', 'a@example.com', 'S2', '1'], ['A', 'other@example.com', 'S3', '1']],
  'blank keys, each its own record': [['A', '', 'S1', '1'], ['', '', 'S2', '1'], ['', '', 'S3', '1'], ['B', '', 'S4', '1']],
  'a failed row fails its record': [['A', '', 'S1', '1'], ['A', '', 'S2', 'two'], ['B', '', 'S3', '1'], ['B', 'not-an-email', 'S4', '1']],
  'identical and all-blank items': [['A', '', 'S1', '1'], ['A', '', 'S1', '1'], ['A', 'a@example.com', '', '']],
  'a blank row inside a group': [['A', '', 'S1', '1'], ['', '', '', ''], ['A', '', 'S2', '1'], ['', '', '', ''], ['B', '', 'S3', '1']],
  // 1.3: an item's own problem names its row, also when a group straddles a batch.
  'an item problem on its own row': [['A', '', 'S1', '1'], ['A', '', 'S2', '2'], ['A', '', '', '3'], ['B', '', '', '1'], ['B', '', 'S5', '1']],
  'a blank item row between two items': [['A', '', 'S1', '1'], ['A', '', '', ''], ['A', '', '', '3'], ['B', 'b@example.com', 'S4', '1']],
};

const csvOf = (rows: string[][], header = HEADER): string =>
  [header, ...rows].map(row => row.map(cell => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\r\n') + '\r\n';

/** The same sheet as a workbook, every cell text, so both formats carry identical rows. */
async function xlsxOf(text: string): Promise<Buffer> {
  const { headers, rows } = parseCsv(text);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  [headers, ...rows].forEach((row, i) => {
    row.forEach((cell, column) => {
      if (cell !== '') sheet.getCell(i + 1, column + 1).value = String(cell);
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const ORDER_DIR = join(__dirname, '../../test/fixtures/order');
const orderText = readFileSync(join(ORDER_DIR, 'sample.csv'), 'utf8');
const orderAdapter = jsonSchemaAdapter(JSON.parse(readFileSync(join(ORDER_DIR, 'schema.json'), 'utf8')), { id: 'order' });
const orderSheet = parseCsv(orderText);
const orderPlan = suggestMapping(orderSheet.headers, orderAdapter, { sample: orderSheet.rows });

interface Case {
  name: string;
  text: string;
  plan: unknown;
  adapter: SchemaAdapter<unknown, unknown>;
}
const CASES: Case[] = [
  { name: 'the order fixture', text: orderText, plan: orderPlan, adapter: orderAdapter as SchemaAdapter<unknown, unknown> },
  ...Object.entries(GROUPING_FIXTURES).map(([name, rows]) => ({ name, text: csvOf(rows), plan: ORDER_PLAN(), adapter: ordersAdapter() as SchemaAdapter<unknown, unknown> })),
];

/** A run of `runImport`, with what `onBatch` saw. */
async function streamed(source: string | Buffer, plan: unknown, adapter: SchemaAdapter<unknown, unknown>, batchSize: number, byteAtATime = true) {
  const records: Record<string, unknown>[] = [];
  const batches: { records: Record<string, unknown>[]; info: BatchInfo }[] = [];
  const result = await runImport({
    grouping: true,
    stream: chunked(source, byteAtATime ? 1 : 64 * 1024),
    plan,
    adapter,
    ctx: undefined,
    limits: { batchSize },
    onBatch: (batch, info) => {
      batches.push({ records: batch, info });
      records.push(...batch);
    },
  });
  return { records, batches, result };
}

/** What the run reports, side by side with what `applyMapping` returns, field for field. */
function comparable(records: Record<string, unknown>[], result: { errors: unknown[]; warnings?: unknown[]; imported?: number; skipped: number; failed?: number; rowsRead?: number; rowsInImported?: number }) {
  return {
    records,
    errors: result.errors,
    warnings: result.warnings ?? [],
    imported: result.imported,
    skipped: result.skipped,
    failed: result.failed,
    rowsRead: result.rowsRead,
    rowsInImported: result.rowsInImported,
  };
}

const inMemory = (c: Case): ImportResult => applyMapping(parseCsv(c.text).rows, c.plan, c.adapter, undefined);

// ─── Parity ───────────────────────────────────────────────────────────────────

describe('the order fixture: a preview\'s suggestion, sent back unchanged, imports grouped (2.0 rc.2)', () => {
  it('as CSV and as a workbook, giving what applyMapping gives with the same plan', async () => {
    for (const [stream, filename] of [[Buffer.from(orderText), 'order.csv'], [await xlsxOf(orderText), 'order.xlsx']] as const) {
      const preview = await previewSheet({ stream, filename, adapter: orderAdapter });
      expect(preview.suggestion.group?.key).toEqual([0]);
      expect(preview.suggestion.group?.collect).toContain('items');

      const records: Record<string, unknown>[] = [];
      const result = await runImport({ stream, filename, plan: preview.suggestion, adapter: orderAdapter, ctx: undefined, onBatch: batch => void records.push(...batch) });
      const memory = applyMapping(orderSheet.rows, preview.suggestion, orderAdapter, undefined);
      expect(result.rowsRead).toBe(orderSheet.rows.length);
      expect(records.length).toBe(memory.records.length);
      expect(records.length).toBeLessThan(orderSheet.rows.length);
      expect(JSON.parse(JSON.stringify(records))).toEqual(JSON.parse(JSON.stringify(memory.records)));
      expect(result.errorCount).toBe(memory.errors.length);
      // One record per order, its items gathered.
      expect(records.every(record => Array.isArray(record['items']))).toBe(true);
    }
  });
});

describe('grouping is on by default (2.0, D4)', () => {
  const orders = jsonSchemaAdapter({
    $id: 'order',
    type: 'object',
    properties: { orderId: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } } },
  });
  const plan = {
    planVersion: 2,
    target: 'order',
    entries: [{ ref: 'orderId', column: 0 }, { ref: 'items.sku', column: 1 }],
    group: { key: [0], collect: ['items'] },
  };
  const sheet = 'orderId,sku\r\nA,S1\r\nA,S2\r\nB,S3\r\n';

  it('groups a contiguous plan when runImport is given no grouping option', async () => {
    const records: Record<string, unknown>[] = [];
    const result = await runImport({ stream: chunked(sheet), plan, adapter: orders, ctx: undefined, onBatch: batch => void records.push(...batch) });
    expect(records).toEqual([
      { orderId: 'A', items: [{ sku: 'S1' }, { sku: 'S2' }] },
      { orderId: 'B', items: [{ sku: 'S3' }] },
    ]);
    expect(result).toMatchObject({ imported: 2, rowsRead: 3, rowsInImported: 3, failed: 0 });
  });

  it('gives what grouping: true gives', async () => {
    const byDefault = await runImport({ stream: chunked(sheet), plan, adapter: orders, ctx: undefined });
    const explicit = await runImport({ stream: chunked(sheet), plan, adapter: orders, ctx: undefined, grouping: true });
    expect(byDefault).toEqual(explicit);
  });

  it('still refuses contiguous: false by default, with reason non-contiguous', async () => {
    const failure = await runImport({ stream: chunked(sheet), plan: { ...plan, group: { ...plan.group, contiguous: false } }, adapter: orders, ctx: undefined }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'INVALID_PLAN', details: [expect.objectContaining({ code: 'PLAN_GROUP', reason: 'non-contiguous' })] });
  });
});

describe('runImport groups exactly as applyMapping does', () => {
  it('reads the order fixture with a grouped plan, so the parity below is about grouping', () => {
    expect(orderPlan.group?.key).toEqual([0]);
    expect(inMemory(CASES[0]).records.length).toBeGreaterThan(0);
  });

  describe.each(CASES.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const expected = inMemory(c);

    it.each([1, 2, 3, 500])('as CSV, one byte at a time, batchSize %i', async batchSize => {
      const { records, result } = await streamed(c.text, c.plan, c.adapter, batchSize);
      expect(comparable(records, result)).toEqual(comparable(expected.records, expected));
      expect(result.rowsInImported + result.skipped + result.failed).toBe(result.rowsRead);
    });

    it.each([1, 2, 3, 500])('as .xlsx, one byte at a time, batchSize %i', async batchSize => {
      const { records, result } = await streamed(await xlsxOf(c.text), c.plan, c.adapter, batchSize);
      expect(comparable(records, result)).toEqual(comparable(expected.records, expected));
      expect(result.rowsInImported + result.skipped + result.failed).toBe(result.rowsRead);
    });
  });

  it('names the item rows the 1.3 fixtures are about, so the parity above is about them', () => {
    const named = (name: string) => inMemory(CASES.find(c => c.name === name) as Case).errors.map(({ row, rows, ref }) => ({ row, rows, ref }));
    expect(named('an item problem on its own row')).toEqual([
      { row: 4, rows: [4], ref: 'items.2.sku' },
      { row: 5, rows: [5], ref: 'items.0.sku' },
    ]);
    expect(named('a blank item row between two items')).toEqual([{ row: 4, rows: [4], ref: 'items.1.sku' }]);
  });

  it('gives identical results for the order fixture as CSV and as .xlsx', async () => {
    const csv = await streamed(orderText, orderPlan, CASES[0].adapter, 3, false);
    const xlsx = await streamed(await xlsxOf(orderText), orderPlan, CASES[0].adapter, 3, false);
    const { format: csvFormat, ...csvResult } = csv.result;
    const { format: xlsxFormat, ...xlsxResult } = xlsx.result;
    expect([csvFormat, xlsxFormat]).toEqual(['csv', 'xlsx']);
    expect(xlsx.records).toEqual(csv.records);
    expect(xlsxResult).toEqual(csvResult);
  });
});

// ─── Batches ──────────────────────────────────────────────────────────────────

describe('a group that straddles a batch boundary', () => {
  const rows = [['A', '', 'S1', '1'], ['A', '', 'S2', '1'], ['A', '', 'S3', '1'], ['B', '', 'S4', '1'], ['B', '', 'S5', '1'], ['B', '', 'S6', '1'], ['C', '', 'S7', '1']];

  it('is one record, and onBatch never receives part of a group', async () => {
    const { batches } = await streamed(csvOf(rows), ORDER_PLAN(), ordersAdapter() as SchemaAdapter<unknown, unknown>, 2);
    const handed = batches.flatMap(batch => batch.records.map(record => [record['orderId'], (record['items'] as unknown[]).length]));
    expect(handed).toEqual([['A', 3], ['B', 3], ['C', 1]]);
  });

  it('says where the records of a batch were built from, which is where a carried group began', async () => {
    const { batches } = await streamed(csvOf(rows), ORDER_PLAN(), ordersAdapter() as SchemaAdapter<unknown, unknown>, 2);
    // Rows 2-3 finish nothing; rows 4-5 finish A (rows 2-4); rows 6-7 finish nothing; row 8,
    // the last batch, finishes B (rows 5-7) and, at the end of the file, C (row 8).
    expect(batches.map(batch => [batch.records.map(record => record['orderId']), batch.info.firstRow])).toEqual([
      [['A'], 2],
      [['B', 'C'], 5],
    ]);
    expect(batches.map(batch => batch.info.imported)).toEqual([0, 1]);
  });
});

// ─── Failures ─────────────────────────────────────────────────────────────────

describe('what stops a grouped run', () => {
  const adapter = () => ordersAdapter() as SchemaAdapter<unknown, unknown>;
  const keys = (...ids: string[]) => csvOf(ids.map(id => [id, '', 'S', '1']));

  /** The failure `runImport` throws, and the one `applyMapping` throws for the same rows. */
  async function bothFailures(text: string, limits: Record<string, number> = {}, onBatch?: (records: Record<string, unknown>[]) => void) {
    const streamedFailure = await runImport({ grouping: true, stream: chunked(text), plan: ORDER_PLAN(), adapter: adapter(), ctx: undefined, limits: { batchSize: 1, ...limits }, onBatch }).catch(error => error);
    let inMemoryFailure: unknown;
    try {
      applyMapping(parseCsv(text).rows, ORDER_PLAN(), adapter(), undefined, { groupLimits: limits });
    } catch (error) {
      inMemoryFailure = error;
    }
    return { streamedFailure, inMemoryFailure };
  }

  const cases: [string, string, Record<string, number>, string][] = [
    ['a closed key that comes back', keys('A', 'B', 'A'), {}, 'GROUP_NOT_CONTIGUOUS'],
    ['a group past maxGroupRows', keys('A', 'A', 'A'), { maxGroupRows: 2 }, 'GROUP_TOO_LARGE'],
    ['more groups than maxGroups', keys('A', 'B', 'C'), { maxGroups: 2 }, 'TOO_MANY_GROUPS'],
    ['closed keys past maxGroupKeyBytes', keys('A', 'B', 'C'), { maxGroupKeyBytes: 12 }, 'TOO_MANY_GROUPS'],
  ];

  it.each(cases)('%s: the engine\'s own ImportFailure, the same as applyMapping throws', async (_name, text, limits, code) => {
    const { streamedFailure, inMemoryFailure } = await bothFailures(text, limits);
    expect(streamedFailure).toBeInstanceOf(ImportFailure);
    expect((streamedFailure as ImportFailure).code).toBe(code);
    expect(inMemoryFailure).toBeInstanceOf(ImportFailure);
    expect({ code: (streamedFailure as ImportFailure).code, message: (streamedFailure as Error).message, details: (streamedFailure as ImportFailure).details }).toEqual({
      code: (inMemoryFailure as ImportFailure).code,
      message: (inMemoryFailure as Error).message,
      details: (inMemoryFailure as ImportFailure).details,
    });
  });

  it('names the key and both rows when a closed key comes back', async () => {
    const { streamedFailure } = await bothFailures(keys('A', 'B', 'A'));
    expect((streamedFailure as ImportFailure).details).toEqual({ key: ['A'], rows: [2, 4] });
  });

  it.each(cases)('%s: a run without onBatch (what /validate runs) stops the same way, having written nothing', async (_name, text, limits, code) => {
    const failure = await runImport({ grouping: true, stream: chunked(text), plan: ORDER_PLAN(), adapter: adapter(), ctx: undefined, limits: { batchSize: 1, ...limits } }).catch(error => error);
    expect(failure).toMatchObject({ code });
  });

  it('may already have written earlier batches when it stops: imports are not transactional', async () => {
    const written: unknown[] = [];
    const { streamedFailure } = await bothFailures(keys('A', 'B', 'A'), {}, records => void written.push(...records));
    expect((streamedFailure as ImportFailure).code).toBe('GROUP_NOT_CONTIGUOUS');
    expect(written.map(record => (record as { orderId: string }).orderId)).toEqual(['A']);
  });
});

// ─── Memory ───────────────────────────────────────────────────────────────────

describe('memory while grouping is bounded by the batch and the open group', () => {
  const ROWS = 50_000;
  const PER_GROUP = 5;

  /** 50,000 rows in groups of five, with a wide first cell so a run that held them would show. */
  async function* groupedCsv(): AsyncGenerator<Uint8Array> {
    yield Buffer.from(`${HEADER.join(',')}\r\n`);
    let buffer = '';
    for (let i = 0; i < ROWS; i++) {
      const id = String(Math.floor(i / PER_GROUP)).padStart(12, '0');
      buffer += `${id},${'x'.repeat(150)}@example.com,SKU-${i},1\r\n`;
      if (buffer.length >= 256 * 1024) {
        yield Buffer.from(buffer);
        buffer = '';
      }
    }
    if (buffer) yield Buffer.from(buffer);
  }

  /** Peak retained heap over the run, collected before each reading. */
  async function peakHeap(onRecords: (records: Record<string, unknown>[]) => void = () => undefined): Promise<{ peak: number; imported: number }> {
    const before = collectedHeap();
    let peak = 0;
    let batches = 0;
    // Validation off: the email column is deliberately wide, and what is measured is grouping.
    const result = await runImport({
    grouping: true,
      stream: groupedCsv(),
      plan: ORDER_PLAN(),
      adapter: ordersAdapter({ validate: () => [] }) as SchemaAdapter<unknown, unknown>,
      ctx: undefined,
      limits: { batchSize: 500, maxBytes: 32 * 1024 * 1024 },
      onBatch: records => {
        onRecords(records);
        if (batches++ % 10 === 0) peak = Math.max(peak, collectedHeap() - before);
      },
    });
    return { peak, imported: result.imported };
  }

  /**
   * About 1.5 times what a run holds: measured at 7.1-7.2 MB on Node 24 (the batch, the open
   * group, ten thousand closed keys) for a file of about 9 MB. A run that keeps the ten thousand
   * records it hands over measures 14.7 MB, past it.
   */
  const BOUND = 11 * 1024 * 1024;

  it('stays under the bound for 50,000 rows in groups of five', async () => {
    const { peak, imported } = await peakHeap();
    expect(imported).toBe(ROWS / PER_GROUP);
    expect(peak).toBeLessThan(BOUND);
  });

  it('is a bound a leak breaks: a run that keeps every record it hands over goes past it', async () => {
    const leaked: Record<string, unknown>[] = [];
    const { peak } = await peakHeap(records => void leaked.push(...records));
    expect(leaked).toHaveLength(ROWS / PER_GROUP);
    expect(peak).toBeGreaterThan(BOUND);
  });
});
