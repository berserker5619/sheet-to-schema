/**
 * Grouping (spec §5) through applyMapping (`apply-mapping.ts`, over `GroupAccumulator`, and
 * `buildGroup`), against the test adapter's collected `items`. Codes, rows and refs only; never
 * message text.
 *
 * The group limits (`maxGroupRows`, `maxGroups`, `maxGroupKeyBytes`) are enforced here by
 * default since 1.1 (1.1 spec, B), and by the streaming runner with the same failures.
 */
import { ordersAdapter } from './adapter.fixtures';
import type { RecordProblem } from './adapter.types';
import { applyMapping, type ApplyMappingOptions } from './apply-mapping';
import { DEFAULT_GROUP_LIMITS } from './group-limits';
import { ImportFailure } from './import-failure';
import { jsonSchemaAdapter } from './json-schema-adapter';
import type { ImportResult } from './result.types';

const ctx = { calls: [] as string[] };
/** Columns: 0 order id, 1 customer email, 2 sku, 3 qty. Grouped by column 0, collecting items. */
const plan = (group: Record<string, unknown> = {}) => ({
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
const run = (rows: unknown[][], p: unknown = plan(), adapter = ordersAdapter()) => applyMapping(rows, p, adapter, ctx);
const reconciles = (r: ImportResult) => (r.rowsInImported ?? 0) + r.skipped + (r.failed ?? 0) === r.rowsRead;

describe('grouping (§5)', () => {
  it('turns 7 order rows with 4 distinct contiguous keys into 4 records, items in sheet order', () => {
    const result = run([
      ['A', 'a@example.com', 'S1', '1'],
      ['A', '', 'S2', '2'],
      ['B', 'b@example.com', 'S3', '1'],
      ['C', 'c@example.com', 'S4', '1'],
      ['C', '', 'S5', '3'],
      ['C', '', 'S6', '1'],
      ['D', 'd@example.com', 'S7', '2'],
    ]);
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([
      { orderId: 'A', customer: { email: 'a@example.com' }, items: [{ sku: 'S1', qty: 1 }, { sku: 'S2', qty: 2 }] },
      { orderId: 'B', customer: { email: 'b@example.com' }, items: [{ sku: 'S3', qty: 1 }] },
      {
        orderId: 'C',
        customer: { email: 'c@example.com' },
        items: [{ sku: 'S4', qty: 1 }, { sku: 'S5', qty: 3 }, { sku: 'S6', qty: 1 }],
      },
      { orderId: 'D', customer: { email: 'd@example.com' }, items: [{ sku: 'S7', qty: 2 }] },
    ]);
    expect(result).toMatchObject({ rowsRead: 7, imported: 4, rowsInImported: 7, skipped: 0, failed: 0 });
    expect(reconciles(result)).toBe(true);
  });

  it('keeps the first row on a parent-field disagreement, warning with the kept row and the row that disagreed', () => {
    const result = run([
      ['A', 'a@example.com', 'S1', '1'],
      ['A', 'a@example.com', 'S2', '1'],
      ['A', 'other@example.com', 'S3', '1'],
    ]);
    expect(result.errors).toEqual([]);
    // Row 3 agrees, so it is not on the warning.
    expect(result.warnings).toEqual([
      expect.objectContaining({ row: 2, rows: [2, 4], ref: 'customer.email', code: 'RECORD_GROUP_CONFLICT', raw: 'other@example.com' }),
    ]);
    expect(result.warnings?.[0].message).toContain('row 2');
    expect(result.records[0]['customer']).toEqual({ email: 'a@example.com' });
    expect(result).toMatchObject({ imported: 1, failed: 0 });
  });

  it('warns once for each value that disagrees, with every row that carries it', () => {
    const result = run([
      ['A', 'a@example.com', 'S1', '1'],
      ['A', 'other@example.com', 'S2', '1'],
      ['A', 'third@example.com', 'S3', '1'],
      ['A', 'other@example.com', 'S4', '1'],
    ]);
    expect(result.warnings?.map(({ row, rows, ref, code, raw }) => ({ row, rows, ref, code, raw }))).toEqual([
      { row: 2, rows: [2, 3, 5], ref: 'customer.email', code: 'RECORD_GROUP_CONFLICT', raw: 'other@example.com' },
      { row: 2, rows: [2, 4], ref: 'customer.email', code: 'RECORD_GROUP_CONFLICT', raw: 'third@example.com' },
    ]);
    expect(result.records[0]['customer']).toEqual({ email: 'a@example.com' });
  });

  it('names the row the value was kept from, which is not the first row when that row left the field blank', () => {
    const result = run([
      ['A', '', 'S1', '1'],
      ['A', 'a@example.com', 'S2', '1'],
      ['A', 'other@example.com', 'S3', '1'],
    ]);
    expect(result.warnings).toEqual([expect.objectContaining({ row: 3, rows: [3, 4], ref: 'customer.email', code: 'RECORD_GROUP_CONFLICT' })]);
    expect(result.warnings?.[0].message).toContain('row 3');
  });

  it('fills a parent field the first row left blank from a later row: nothing disagrees', () => {
    const result = run([
      ['A', '', 'S1', '1'],
      ['A', 'a@example.com', 'S2', '1'],
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.records[0]['customer']).toEqual({ email: 'a@example.com' });
  });

  it('fails the import when a closed key comes back, naming both rows', () => {
    const rows = [
      ['A', '', 'S1', '1'],
      ['B', '', 'S2', '1'],
      ['A', '', 'S3', '1'],
    ];
    expect(() => run(rows)).toThrow(ImportFailure);
    try {
      run(rows);
    } catch (failure) {
      expect((failure as ImportFailure).code).toBe('GROUP_NOT_CONTIGUOUS');
      expect((failure as ImportFailure).details).toEqual({ key: ['A'], rows: [2, 4] });
    }
  });

  it('gathers rows of one key wherever they are with contiguous: false, in order of first appearance', () => {
    const result = run(
      [
        ['A', '', 'S1', '1'],
        ['B', '', 'S2', '1'],
        ['A', '', 'S3', '1'],
      ],
      plan({ contiguous: false }),
    );
    expect(result.records.map(r => [r['orderId'], (r['items'] as { sku: string }[]).map(i => i.sku)])).toEqual([
      ['A', ['S1', 'S3']],
      ['B', ['S2']],
    ]);
    expect(result).toMatchObject({ rowsInImported: 3, imported: 2 });
    expect(reconciles(result)).toBe(true);
  });

  it('compares a key as a tuple, so values that would collide when joined stay apart', () => {
    const p = plan({ key: [0, 1] });
    const result = run(
      [
        ['a|b', 'c', 'S1', '1'],
        ['a', 'b|c', 'S2', '1'],
      ],
      p,
      ordersAdapter({ validate: () => [] }),
    );
    expect(result.records).toHaveLength(2);
  });

  it('keys a typed cell by its cellText, so a date cell and its ISO text group together', () => {
    const p = plan({ key: [1] });
    const result = run(
      [
        ['A', new Date(Date.UTC(2024, 2, 7)), 'S1', '1'],
        ['A', '2024-03-07', 'S2', '1'],
      ],
      p,
      ordersAdapter({ validate: () => [] }),
    );
    expect(result.records).toHaveLength(1);
  });

  it('imports a row with a blank key as its own record, with a RECORD_GROUP_NO_KEY warning', () => {
    const result = run([
      ['A', '', 'S1', '1'],
      ['', '', 'S2', '1'],
      ['', '', 'S3', '1'],
    ], plan(), ordersAdapter({ validate: () => [] }));
    expect(result.records).toHaveLength(3);
    expect(result.warnings).toEqual([
      expect.objectContaining({ row: 3, rows: [3], ref: '', code: 'RECORD_GROUP_NO_KEY' }),
      expect.objectContaining({ row: 4, rows: [4], ref: '', code: 'RECORD_GROUP_NO_KEY' }),
    ]);
  });

  it('closes an open group at a blank-key row, so the same key after it is not contiguous', () => {
    expect(() =>
      run([
        ['A', '', 'S1', '1'],
        ['', '', 'S2', '1'],
        ['A', '', 'S3', '1'],
      ]),
    ).toThrow(ImportFailure);
  });

  it('fails the whole record when one of its rows fails, counting every row of it', () => {
    const result = run([
      ['A', '', 'S1', '1'],
      ['A', '', 'S2', 'two'],
      ['B', '', 'S3', '1'],
    ]);
    expect(result.records.map(r => r['orderId'])).toEqual(['B']);
    // The error names the row its cell is on; the count is still every row of the record.
    expect(result.errors).toEqual([expect.objectContaining({ row: 3, rows: [3], ref: 'items.qty', column: 3, code: 'CELL_FORMAT' })]);
    expect(result).toMatchObject({ failed: 2, rowsInImported: 1, imported: 1 });
    expect(reconciles(result)).toBe(true);
  });

  describe('problems of a grouped record', () => {
    /** Columns: 0 order id, 1 placed (a date), 2 sku, 3 qty. */
    const dated = {
      planVersion: 2,
      target: 'orders',
      entries: [
        { ref: 'orderId', column: 0 },
        { ref: 'placed', column: 1 },
        { ref: 'items.sku', column: 2 },
        { ref: 'items.qty', column: 3 },
      ],
      group: { key: [0], collect: ['items'] },
    };
    const problems = (result: ImportResult) => result.errors.map(({ row, rows, ref, code }) => ({ row, rows, ref, code }));

    it('reports a parent cell that fails on every row of the record once, with those rows', () => {
      const result = run([['A', '31/09/2026', 'S1', '1'], ['A', '31/09/2026', 'S2', '1'], ['A', '31/09/2026', 'S3', '1']], dated);
      expect(problems(result)).toEqual([{ row: 2, rows: [2, 3, 4], ref: 'placed', code: 'CELL_FORMAT' }]);
      expect(result.errors[0]).toMatchObject({ column: 1, raw: '31/09/2026' });
      expect(result).toMatchObject({ failed: 3, imported: 0 });
    });

    it('keeps two problems apart when their messages differ, each on its own row', () => {
      const result = run([['A', 'never', 'S1', '1'], ['A', '2026-09-05', 'S2', '1'], ['A', 'soon', 'S3', '1']], dated);
      expect(problems(result)).toEqual([
        { row: 2, rows: [2], ref: 'placed', code: 'CELL_FORMAT' },
        { row: 4, rows: [4], ref: 'placed', code: 'CELL_FORMAT' },
      ]);
    });

    it("merges the same item-cell failure on two rows, and reports an item's own problem on its row (1.3)", () => {
      const result = run([['A', '', 'S1', 'one'], ['A', '', 'S2', 'one'], ['A', '', '', '2']], dated);
      expect(problems(result)).toEqual([
        { row: 2, rows: [2, 3], ref: 'items.qty', code: 'CELL_FORMAT' },
        // The third row's item has a qty and no sku at all. 1.2 put it on every row of the group.
        { row: 4, rows: [4], ref: 'items.2.sku', code: 'RECORD_REQUIRED' },
      ]);
    });

    it('does not also call an item field required when its own cell could not be read', () => {
      const adapter = ordersAdapter({
        coerce: (target, raw) => (target.shapeRef === 'items.sku' && raw === 'BAD' ? { error: 'unreadable', code: 'CELL_FORMAT' } : null),
      });
      const result = run([['A', '', 'S1', '1'], ['A', '', 'BAD', '2'], ['A', '', '', '3']], dated, adapter);
      expect(problems(result)).toEqual([
        { row: 3, rows: [3], ref: 'items.sku', code: 'CELL_FORMAT' },
        // Row 4 said nothing in its sku cell, which is what required means.
        { row: 4, rows: [4], ref: 'items.2.sku', code: 'RECORD_REQUIRED' },
      ]);
    });

    it('does not call a parent field required when its cell could not be read on any row', () => {
      const adapter = ordersAdapter({
        coerce: (target, raw) => (target.ref === 'placed' && raw === 'BAD' ? { error: 'unreadable', code: 'CELL_FORMAT' } : null),
        targets: options => {
          const set = ordersAdapter().targets(options);
          return { ...set, targets: set.targets.map(t => (t.ref === 'placed' ? { ...t, required: true } : t)) };
        },
      });
      expect(problems(run([['A', 'BAD', 'S1', '1'], ['A', '', 'S2', '1']], dated, adapter))).toEqual([{ row: 2, rows: [2], ref: 'placed', code: 'CELL_FORMAT' }]);
      expect(problems(run([['B', '', 'S1', '1']], dated, adapter))).toEqual([{ row: 2, rows: [2], ref: 'placed', code: 'RECORD_REQUIRED' }]);
    });
  });

  it('appends identical items as two items, and drops an all-blank one', () => {
    const result = run([
      ['A', '', 'S1', '1'],
      ['A', '', 'S1', '1'],
      ['A', 'a@example.com', '', ''],
    ]);
    expect(result.records[0]['items']).toEqual([{ sku: 'S1', qty: 1 }, { sku: 'S1', qty: 1 }]);
  });

  it('does not let a blank row between two rows of a group split it', () => {
    const result = run([
      ['A', '', 'S1', '1'],
      ['', '', '', ''],
      ['A', '', 'S2', '1'],
    ]);
    expect(result.records).toHaveLength(1);
    expect(result).toMatchObject({ skipped: 1, rowsInImported: 2 });
    expect(reconciles(result)).toBe(true);
  });

  it('compares a numbered-column array as a whole, by the parent-field rule', () => {
    const p = {
      planVersion: 2,
      target: 'orders',
      entries: [
        { ref: 'orderId', column: 0 },
        { ref: 'phones.0.number', column: 1 },
        { ref: 'items.sku', column: 2 },
      ],
      group: { key: [0], collect: ['items'] },
    };
    const result = run(
      [
        ['A', '+44 20 7946 0000', 'S1'],
        ['A', '+44 20 7946 0001', 'S2'],
      ],
      p,
    );
    expect(result.records[0]['phones']).toEqual([{ number: '+44 20 7946 0000' }]);
    expect(result.warnings).toEqual([expect.objectContaining({ row: 2, rows: [2, 3], ref: 'phones', code: 'RECORD_GROUP_CONFLICT' })]);
  });

  it('finalizes and validates each group once, after its last row', () => {
    const seen: number[] = [];
    const adapter = ordersAdapter({
      finalize: record => record,
      validate: (record): RecordProblem[] => {
        seen.push((record['items'] as unknown[]).length);
        return [];
      },
    });
    run(
      [
        ['A', '', 'S1', '1'],
        ['A', '', 'S2', '1'],
        ['B', '', 'S3', '1'],
      ],
      plan(),
      adapter,
    );
    expect(seen).toEqual([2, 1]);
  });

  it('validates collected items per item that exists', () => {
    const result = run([
      ['A', '', '', '2'],
      ['A', '', 'S2', '1'],
    ]);
    // On the row the item came from (1.3), not on every row of the group.
    expect(result.errors).toEqual([expect.objectContaining({ ref: 'items.0.sku', code: 'RECORD_REQUIRED', row: 2, rows: [2] })]);
  });

  describe('which row a problem of a grouped record names (1.3)', () => {
    const rowsOf = (result: ImportResult) => result.errors.map(({ row, rows, ref, code }) => ({ row, rows, ref, code }));
    /** An adapter whose validate reports exactly `refs`, so each kind of ref can be asked about. */
    const reporting = (...refs: string[]) =>
      ordersAdapter({ validate: () => refs.map(ref => ({ ref, code: 'RECORD_RULE' as const, message: `about ${ref}` })) });

    it('names the true row of an item that comes after a blank item row', () => {
      // Row 3 has the key and nothing else: no item, and no index. The second item is row 4's.
      const result = run([['A', '', 'S1', '1'], ['A', '', '', ''], ['A', '', '', '3']]);
      expect(rowsOf(result)).toEqual([{ row: 4, rows: [4], ref: 'items.1.sku', code: 'RECORD_REQUIRED' }]);
    });

    it('names the true row after a blank sheet row inside the group', () => {
      const result = run([['A', '', 'S1', '1'], ['', '', '', ''], ['A', '', '', '3']]);
      expect(rowsOf(result)).toEqual([{ row: 4, rows: [4], ref: 'items.1.sku', code: 'RECORD_REQUIRED' }]);
    });

    it("names each item's own row, deeper refs too, and keeps a record problem on every row", () => {
      const result = run([['A', '', 'S1', '1'], ['A', '', 'S2', '2'], ['A', '', 'S3', '3']], plan(), reporting('items.2.sku', 'items.0', 'items.1.dims.width', 'customer.email', 'items', ''));
      expect(rowsOf(result)).toEqual([
        { row: 4, rows: [4], ref: 'items.2.sku', code: 'RECORD_RULE' },
        { row: 2, rows: [2], ref: 'items.0', code: 'RECORD_RULE' },
        { row: 3, rows: [3], ref: 'items.1.dims.width', code: 'RECORD_RULE' },
        // The record, the array as a whole, and no ref at all: the group's first row and all its rows.
        { row: 2, rows: [2, 3, 4], ref: 'customer.email', code: 'RECORD_RULE' },
        { row: 2, rows: [2, 3, 4], ref: 'items', code: 'RECORD_RULE' },
        { row: 2, rows: [2, 3, 4], ref: '', code: 'RECORD_RULE' },
      ]);
    });

    it('keeps a ref that only looks like an item on every row: no index, an index past the items, another array', () => {
      const result = run([['A', '', 'S1', '1'], ['A', '', 'S2', '2']], plan(), reporting('items.first.sku', 'items.7.sku', 'itemsCount', 'phones.0.number'));
      expect(rowsOf(result).map(({ ref, rows }) => [ref, rows])).toEqual([
        ['items.first.sku', [2, 3]],
        ['items.7.sku', [2, 3]],
        ['itemsCount', [2, 3]],
        ['phones.0.number', [2, 3]],
      ]);
    });

    it('names the item row of an array collected at a nested ref', () => {
      const nested = jsonSchemaAdapter({
        $id: 'orders',
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          order: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, qty: { type: 'integer' } } } } } },
        },
      } as never);
      const p = {
        planVersion: 2,
        target: 'orders',
        entries: [{ ref: 'orderId', column: 0 }, { ref: 'order.items.sku', column: 2 }, { ref: 'order.items.qty', column: 3 }],
        group: { key: [0], collect: ['order.items'] },
      };
      const result = applyMapping([['A', '', 'S1', '1'], ['A', '', '', ''], ['A', '', '', '2']], p, nested, undefined);
      expect(result.planProblems).toEqual([]);
      expect(rowsOf(result)).toEqual([{ row: 4, rows: [4], ref: 'order.items.1.sku', code: 'RECORD_REQUIRED' }]);
    });

    it('leaves an ungrouped record as it was: its one row, and no rows', () => {
      const ungrouped = { planVersion: 2, target: 'orders', entries: [{ ref: 'orderId', column: 0 }, { ref: 'customer.email', column: 1 }] };
      const result = applyMapping([['', 'a@example.com']], ungrouped, ordersAdapter(), ctx);
      expect(result.errors.map(({ row, rows, ref }) => ({ row, rows, ref }))).toEqual([{ row: 2, rows: undefined, ref: 'orderId' }]);
    });
  });
});

describe('group limits (1.1 spec, B)', () => {
  const failureOf = (rows: unknown[][], p: unknown, options: ApplyMappingOptions): ImportFailure => {
    try {
      applyMapping(rows, p, ordersAdapter(), ctx, options);
    } catch (failure) {
      expect(failure).toBeInstanceOf(ImportFailure);
      return failure as ImportFailure;
    }
    throw new Error('expected an ImportFailure');
  };
  const keys = (...ids: string[]) => ids.map(id => [id, '', 'S', '1']);

  it('defaults to 10,000 rows, 200,000 groups and 8 MiB of closed keys', () => {
    expect(DEFAULT_GROUP_LIMITS).toEqual({ maxGroupRows: 10_000, maxGroups: 200_000, maxGroupKeyBytes: 8 * 1024 * 1024 });
  });

  describe.each([true, false])('contiguous: %s', contiguous => {
    it('fails a group past maxGroupRows with GROUP_TOO_LARGE, naming its first row and the row past the limit', () => {
      const failure = failureOf(keys('A', 'A', 'A'), plan({ contiguous }), { groupLimits: { maxGroupRows: 2 } });
      expect(failure.code).toBe('GROUP_TOO_LARGE');
      expect(failure.details).toEqual({ key: ['A'], rows: [2, 4] });
      expect(run(keys('A', 'A'), plan({ contiguous })).imported).toBe(1);
      expect(applyMapping(keys('A', 'A'), plan({ contiguous }), ordersAdapter(), ctx, { groupLimits: { maxGroupRows: 2 } }).imported).toBe(1);
    });

    it('fails past maxGroups with TOO_MANY_GROUPS, and takes exactly maxGroups', () => {
      const failure = failureOf(keys('A', 'B', 'C'), plan({ contiguous }), { groupLimits: { maxGroups: 2 } });
      expect(failure.code).toBe('TOO_MANY_GROUPS');
      expect(failure.details.key).toEqual(['C']);
      expect(applyMapping(keys('A', 'B'), plan({ contiguous }), ordersAdapter(), ctx, { groupLimits: { maxGroups: 2 } }).imported).toBe(2);
    });

    it('does not count blank-key rows as groups', () => {
      const result = applyMapping(keys('A', '', '', 'B'), plan({ contiguous }), ordersAdapter(), ctx, { groupLimits: { maxGroups: 2 } });
      // Four records; the two keyless ones fail the adapter's required orderId, which is not a limit.
      expect(result).toMatchObject({ imported: 2, failed: 2, rowsRead: 4 });
    });
  });

  it('fails closed keys past maxGroupKeyBytes with TOO_MANY_GROUPS though their count is under maxGroups, counting UTF-8 bytes', () => {
    // Each key is held as its JSON tuple: ["é"] is 6 bytes in UTF-8, ["😀"] is 8.
    const failure = failureOf(keys('é', '😀', 'x'), plan(), { groupLimits: { maxGroupKeyBytes: 13 } });
    expect(failure.code).toBe('TOO_MANY_GROUPS');
    expect(failure.details).toEqual({ key: ['😀'], rows: [3] });
    expect(applyMapping(keys('é', '😀'), plan(), ordersAdapter(), ctx, { groupLimits: { maxGroupKeyBytes: 14 } }).imported).toBe(2);
  });

  it('does not apply maxGroupKeyBytes with contiguous: false, which holds the whole sheet anyway', () => {
    const result = applyMapping(keys('é', '😀', 'x'), plan({ contiguous: false }), ordersAdapter(), ctx, { groupLimits: { maxGroupKeyBytes: 1 } });
    expect(result.imported).toBe(3);
  });

  it('falls back to the default for an override that is not a positive number', () => {
    for (const maxGroupRows of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(applyMapping(keys('A', 'A', 'A'), plan(), ordersAdapter(), ctx, { groupLimits: { maxGroupRows } }).imported).toBe(1);
    }
    expect(failureOf(keys('A', 'A', 'A'), plan(), { groupLimits: { maxGroupRows: 2.9 } }).code).toBe('GROUP_TOO_LARGE');
  });

  it('stops before any record is finalized, as a contiguity failure does', () => {
    const calls: string[] = [];
    const adapter = ordersAdapter();
    const finalize = adapter.finalize;
    adapter.finalize = (record, c) => {
      calls.push(String(record['orderId']));
      return finalize ? finalize(record, c) : record;
    };
    expect(() => applyMapping(keys('A', 'B', 'B', 'B'), plan(), adapter, ctx, { groupLimits: { maxGroupRows: 2 } })).toThrow(ImportFailure);
    expect(calls).toEqual([]);
  });
});
