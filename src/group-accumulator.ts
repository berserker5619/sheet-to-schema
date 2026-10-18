/**
 * group-accumulator.ts — rows in one at a time, finished groups out (spec §5; 1.1 spec, B).
 *
 * The one implementation of grouping. `applyMapping` feeds it every row of a sheet; the
 * streaming `runImport` feeds it batch by batch and carries the open group across a batch
 * boundary. Because both use this, a grouped import gives the same records either way by
 * construction.
 *
 * A key is the tuple of trimmed `cellText` at the key columns, compared as a tuple, so
 * `["a|b", "c"]` and `["a", "b|c"]` are two keys. A row whose key cells are all blank is its
 * own group and never merged.
 *
 * - **Contiguous** (the default): a group is a run of adjacent rows. A key change closes the
 *   open group and hands it out; a blank-key row closes it too. A key that comes back after
 *   its run closed fails the whole import, naming the key and both rows. Only the closed keys
 *   are kept, never their rows.
 * - **Non-contiguous**: rows of one key gather wherever they are, in sheet order, and every
 *   group is held until `finish`, in the order it first appeared.
 *
 * @internal Not exported from the package; its shape may change in any release.
 */
import { cellText } from './cell-text';
import { ImportFailure } from './import-failure';
import type { GroupSpec } from './plan.types';

/** What the accumulator needs of a row: its sheet row number and its cells. */
export interface GroupableRow {
  rowNumber: number;
  cells: readonly unknown[];
}

/** The rows of one record. A keyless group is a row with a blank key, imported on its own. */
export interface Group<R extends GroupableRow> {
  keyless: boolean;
  members: R[];
}

export class GroupAccumulator<R extends GroupableRow> {
  /** Non-contiguous: every group so far, in order of first appearance, and each by key. */
  private readonly all: Group<R>[] = [];
  private readonly open = new Map<string, Group<R>>();
  /** Contiguous: each closed key, with the last row of its run. */
  private readonly closed = new Map<string, number>();
  private current: { key: string; group: Group<R> } | null = null;

  constructor(private readonly group: Required<GroupSpec>) {}

  /** Take the next row, in sheet order. Returns the groups this row finished, oldest first. */
  push(row: R): Group<R>[] {
    const tuple = this.group.key.map(column => cellText(row.cells[column]).trim());
    if (tuple.every(part => part === '')) {
      const alone: Group<R> = { keyless: true, members: [row] };
      if (!this.group.contiguous) {
        this.all.push(alone);
        return [];
      }
      return [...this.close(), alone];
    }
    const key = JSON.stringify(tuple);

    if (!this.group.contiguous) {
      const existing = this.open.get(key);
      if (existing) existing.members.push(row);
      else {
        const fresh: Group<R> = { keyless: false, members: [row] };
        this.open.set(key, fresh);
        this.all.push(fresh);
      }
      return [];
    }

    if (this.current?.key === key) {
      this.current.group.members.push(row);
      return [];
    }
    const finished = this.close();
    const lastRow = this.closed.get(key);
    if (lastRow !== undefined) {
      throw new ImportFailure(
        'GROUP_NOT_CONTIGUOUS',
        `The rows for group ${tuple.join(' / ')} are not together: the group ended at row ${lastRow} and starts again at row ${row.rowNumber}. Sort the sheet by the key columns.`,
        { key: tuple, rows: [lastRow, row.rowNumber] },
      );
    }
    this.current = { key, group: { keyless: false, members: [row] } };
    return finished;
  }

  /** No more rows: the groups still held, oldest first. */
  finish(): Group<R>[] {
    if (!this.group.contiguous) return this.all.splice(0);
    return this.close();
  }

  /** Close the open run, if there is one, and hand it out. */
  private close(): Group<R>[] {
    const current = this.current;
    if (!current) return [];
    this.current = null;
    this.closed.set(current.key, current.group.members[current.group.members.length - 1].rowNumber);
    return [current.group];
  }
}
