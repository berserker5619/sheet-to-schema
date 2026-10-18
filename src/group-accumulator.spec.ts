import { GroupAccumulator, type Group, type GroupableRow } from './group-accumulator';
import { DEFAULT_GROUP_LIMITS, resolveGroupLimits, utf8Length } from './group-limits';
import { ImportFailure } from './import-failure';

const row = (rowNumber: number, ...cells: unknown[]): GroupableRow => ({ rowNumber, cells });
const rowsOf = (groups: Group<GroupableRow>[]): number[][] => groups.map(group => group.members.map(member => member.rowNumber));

describe('GroupAccumulator', () => {
  describe('contiguous', () => {
    const contiguous = () => new GroupAccumulator<GroupableRow>({ key: [0], collect: [], contiguous: true });

    it('hands out a group when the key changes, and the open one at finish', () => {
      const accumulator = contiguous();
      expect(accumulator.push(row(2, 'A'))).toEqual([]);
      expect(accumulator.push(row(3, 'A'))).toEqual([]);
      expect(rowsOf(accumulator.push(row(4, 'B')))).toEqual([[2, 3]]);
      expect(rowsOf(accumulator.finish())).toEqual([[4]]);
      expect(accumulator.finish()).toEqual([]);
    });

    it('carries the open group across any split of the rows, which is what a batch boundary is', () => {
      const accumulator = contiguous();
      const out: number[][] = [];
      for (const [n, key] of [[2, 'A'], [3, 'A'], [4, 'A'], [5, 'B'], [6, 'C'], [7, 'C']] as const) {
        out.push(...rowsOf(accumulator.push(row(n, key))));
      }
      out.push(...rowsOf(accumulator.finish()));
      expect(out).toEqual([[2, 3, 4], [5], [6, 7]]);
    });

    it('closes the open group at a blank-key row and hands both out, the blank one on its own', () => {
      const accumulator = contiguous();
      accumulator.push(row(2, 'A'));
      const out = accumulator.push(row(3, '  '));
      expect(rowsOf(out)).toEqual([[2], [3]]);
      expect(out.map(group => group.keyless)).toEqual([false, true]);
      expect(accumulator.finish()).toEqual([]);
    });

    it('refuses a closed key that comes back, naming the key and both rows', () => {
      const accumulator = contiguous();
      accumulator.push(row(2, 'A'));
      accumulator.push(row(3, 'B'));
      let failure: unknown;
      try {
        accumulator.push(row(4, ' A '));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ImportFailure);
      expect((failure as ImportFailure).code).toBe('GROUP_NOT_CONTIGUOUS');
      expect((failure as ImportFailure).details).toEqual({ key: ['A'], rows: [2, 4] });
    });
  });

  describe('non-contiguous', () => {
    it('holds every group until finish, in order of first appearance, blank keys in place', () => {
      const accumulator = new GroupAccumulator<GroupableRow>({ key: [0], collect: [], contiguous: false });
      for (const [n, key] of [[2, 'A'], [3, 'B'], [4, ''], [5, 'A']] as const) expect(accumulator.push(row(n, key))).toEqual([]);
      expect(rowsOf(accumulator.finish())).toEqual([[2, 5], [3], [4]]);
      expect(accumulator.finish()).toEqual([]);
    });
  });
});

describe('utf8Length and resolveGroupLimits', () => {
  it('counts UTF-8 bytes, a surrogate pair as four and a lone surrogate as three', () => {
    for (const text of ['', 'abc', 'é', 'தமிழ்', '😀', 'a😀b']) expect(utf8Length(text)).toBe(Buffer.byteLength(text, 'utf8'));
    expect(utf8Length('\ud83d')).toBe(3);
    expect(utf8Length('\ude00x')).toBe(4);
  });

  it('keeps every default when given nothing', () => {
    expect(resolveGroupLimits()).toEqual(DEFAULT_GROUP_LIMITS);
    expect(resolveGroupLimits({ maxGroups: 5.5 })).toEqual({ ...DEFAULT_GROUP_LIMITS, maxGroups: 5 });
  });
});
