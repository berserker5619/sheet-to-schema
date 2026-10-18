/**
 * xlsx-cells.ts — what one ExcelJS cell value becomes in the grid.
 *
 * Browser-safe and shared, so the server's streaming reader and `sheet-to-schema/browser`'s
 * reader turn the same cell into the same value by construction, not by agreement.
 */

/**
 * Turn one exceljs cell value into the value a record should be built from.
 *
 * A formula cell yields its **result**, never its formula: a sheet someone uploaded may
 * contain anything, and importing the text `=SUM(A1:A9)` into a field is importing a string
 * the user never saw. An error cell yields its error text, which fails coercion loudly rather
 * than importing as blank.
 */
export function cellValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return raw;
  if (typeof raw !== 'object') return raw;

  const cell = raw as Record<string, unknown>;
  if (Array.isArray(cell['richText'])) {
    return (cell['richText'] as { text?: unknown }[]).map(part => String(part?.text ?? '')).join('');
  }
  if ('formula' in cell || 'sharedFormula' in cell) return cellValue(cell['result']);
  if ('error' in cell) return String(cell['error']);
  if ('text' in cell) return String(cell['text']);
  return '';
}

/** `row.values` is one-based with a hole at index 0, and sparse wherever a cell was empty. */
export function rowCells(values: unknown): unknown[] {
  if (!Array.isArray(values)) return [];
  const out: unknown[] = [];
  for (let i = 1; i < values.length; i++) out.push(cellValue(values[i]));
  return out;
}
