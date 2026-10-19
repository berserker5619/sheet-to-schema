/**
 * Records parity (1.1 spec, A): every parity fixture through `readSheetFile` + `applyMapping`,
 * with the decimal mark from the returned separator, gives the same records, errors, warnings
 * and counts as the same file streamed through the server's `runImport`.
 *
 * Each fixture gets a schema with one field per column, typed from what the server reads there:
 * a column of numbers (or number text, so a semicolon file's `12,50` is exercised) is a number,
 * a column of booleans a boolean, a column of dates a date, anything else a string. Typing is
 * what makes coercion, and therefore the decimal mark and typed cells, part of the comparison.
 */
import { applyMapping, decimalMarkFor, jsonSchemaAdapter, type JsonSchemaNode } from 'sheet-to-schema';
import { runImport } from '../node/run-import';
import { ALL_FIXTURES, fixtureBytes, nameOf, serverGrid } from './parity.fixtures';
import { readSheetFile } from './read-sheet-file';

const NUMBER_TEXT = /^-?[\d.,]+$/;

/** The JSON Schema type a column reads as, from every non-blank cell the server read there. */
function columnSchema(cells: unknown[]): JsonSchemaNode {
  const filled = cells.filter(cell => cell !== '' && cell !== null && cell !== undefined);
  if (filled.length && filled.every(cell => cell instanceof Date)) return { type: 'string', format: 'date' };
  if (filled.length && filled.every(cell => typeof cell === 'boolean')) return { type: 'boolean' };
  if (filled.length && filled.every(cell => typeof cell === 'number' || (typeof cell === 'string' && NUMBER_TEXT.test(cell)))) return { type: 'number' };
  return { type: 'string' };
}

async function bindingFor(file: string) {
  const grid = await serverGrid(fixtureBytes(file), nameOf(file));
  const width = Math.max(grid.headers.length, ...grid.rows.map(row => row.length));
  const properties: Record<string, JsonSchemaNode> = {};
  for (let column = 0; column < width; column++) properties[`c${column}`] = columnSchema(grid.rows.map(row => row[column]));
  const adapter = jsonSchemaAdapter({ $id: 'fixture', type: 'object', properties }, { version: 1 });
  const plan = { planVersion: 2, target: 'fixture', schemaVersion: 1, entries: Object.keys(properties).map((ref, column) => ({ ref, column })) };
  return { adapter, plan };
}

/** Records and problems as JSON keeps them, so a `Date` and its text compare alike. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('records parity: readSheetFile + applyMapping and runImport on the server agree', () => {
  it.each(ALL_FIXTURES.map(fixture => [fixture.file] as const))('%s', async file => {
    const { adapter, plan } = await bindingFor(file);
    const bytes = fixtureBytes(file);

    const sheet = await readSheetFile(bytes, { filename: nameOf(file) });
    const client = applyMapping(sheet.rows, plan, adapter, undefined, { decimal: decimalMarkFor(sheet.delimiter) });

    const written: Record<string, unknown>[] = [];
    const server = await runImport({
      stream: bytes,
      filename: nameOf(file),
      plan,
      adapter,
      ctx: undefined,
      onBatch: records => void written.push(...records),
    });

    expect(client.planProblems.filter(problem => problem.level === 'error')).toEqual([]);
    expect(wire(written)).toEqual(wire(client.records));
    expect(wire(server.errors)).toEqual(wire(client.errors));
    expect(wire(server.warnings)).toEqual(wire(client.warnings));
    expect(server).toMatchObject({
      imported: client.imported,
      skipped: client.skipped,
      failed: client.failed,
      rowsRead: client.rowsRead,
      rowsInImported: client.rowsInImported,
    });
  });

  it('reads the semicolon file\'s decimal commas as numbers on both sides', async () => {
    const file = 'real-world/case3_excel_semicolon.csv';
    const { adapter, plan } = await bindingFor(file);
    const sheet = await readSheetFile(fixtureBytes(file), { filename: nameOf(file) });
    const { records } = applyMapping(sheet.rows, plan, adapter, undefined, { decimal: decimalMarkFor(sheet.delimiter) });
    expect(records[0]).toMatchObject({ c1: 12.5, c2: 4.8 });
  });
});
