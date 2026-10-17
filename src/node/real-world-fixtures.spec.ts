import fs from 'node:fs';
import path from 'node:path';
import { readSheet, runImport } from './index';
import { chunked } from './sheet.fixtures';
import { jsonSchemaAdapter, type JsonSchemaNode } from 'sheet-to-schema';

const FIXTURES_DIR = path.resolve(__dirname, '../../test/fixtures/real-world');

describe('real-world fixtures (1904 dates, unsafe integers, merged cells)', () => {
  it('case1_1904_dates: imports Mac Excel 1904 dates without 1462-day epoch drift', async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES_DIR, 'case1_1904_dates.xlsx'));
    const schema: JsonSchemaNode = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        birthDate: { type: 'string', format: 'date', title: 'BirthDate' },
        joinDate: { type: 'string', format: 'date', title: 'JoinDate' },
      },
    };
    const adapter = jsonSchemaAdapter(schema);
    const plan = {
      target: 'people',
      entries: [
        { ref: 'name', column: 0 },
        { ref: 'birthDate', column: 1 },
        { ref: 'joinDate', column: 2 },
      ],
    };

    const records: Record<string, unknown>[] = [];
    const result = await runImport({
      stream: chunked(bytes, 1024),
      plan,
      adapter,
      ctx: undefined,
      onBatch: batch => {
        records.push(...batch);
      },
    });

    expect(result.errors).toEqual([]);
    expect(records).toEqual([
      { name: 'Alice Mac', birthDate: '2026-05-15', joinDate: '1904-01-02' },
      { name: 'Bob Mac', birthDate: '1985-10-26', joinDate: '2020-03-01' },
    ]);
  });

  it('case2_numeric_identifiers: unsafe integer guard (> MAX_SAFE_INTEGER) on string targets', async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES_DIR, 'case2_numeric_identifiers.xlsx'));
    const schema: JsonSchemaNode = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        phone: { type: 'string', title: 'Phone' },
        nationalId: { type: 'string', title: 'NationalID' },
        itemCount: { type: 'number', title: 'ItemCount' },
      },
    };
    const adapter = jsonSchemaAdapter(schema);
    const plan = {
      target: 'records',
      entries: [
        { ref: 'name', column: 0 },
        { ref: 'phone', column: 1 },
        { ref: 'nationalId', column: 2 },
        { ref: 'itemCount', column: 4 },
      ],
    };

    const records: Record<string, unknown>[] = [];
    const result = await runImport({
      stream: chunked(bytes, 1024),
      plan,
      adapter,
      ctx: undefined,
      onBatch: batch => {
        records.push(...batch);
      },
    });

    // Row 2: safe numeric ID 1234567890123456 imports as string
    expect(records).toEqual([
      { name: 'Alice', phone: '9876543210', nationalId: '1234567890123456', itemCount: 42 },
    ]);

    // Row 3: 9876543210987654 > MAX_SAFE_INTEGER flags CELL_FORMAT
    expect(result.errors).toEqual([
      {
        row: 3,
        column: 2,
        ref: 'nationalId',
        code: 'CELL_FORMAT',
        message: 'too many digits to read exactly; format the column as Text in the source file',
        raw: 9876543210987654,
      },
    ]);
  });

  it('case4_complex_sheet: reads merged headers with covered cell as empty string', async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES_DIR, 'case4_complex_sheet.xlsx'));
    const sheet = await readSheet({ stream: chunked(bytes, 1024), filename: 'case4_complex_sheet.xlsx' });

    // Merged cell A1:B1 ("Customer Info"): master is A1, covered cell B1 is ''
    expect(sheet.headers).toEqual([
      'Customer Info',
      '',
      'Qty',
      'Price',
      'Total',
      'Secret',
      'Status',
      'Status',
    ]);

    // Only the first sheet ("Sales") is read. The formula column yields its cached result, the
    // hidden column F is read like any other, the covered cell's column carries its own data,
    // and the duplicate "Status" headers stay positional. The styled but empty rows 4-10 are
    // put back as blank rows by the reader.
    const rows: unknown[][] = [];
    for await (const row of sheet.rows) rows.push(row);
    expect(rows.slice(0, 2)).toEqual([
      ['Acme Corp', 'North America', 10, 25.5, 255, 'Internal discount applied', 'Pending', 'Active'],
      ['Globex', 'Europe', 4, 100, 400, 'VIP client', 'Shipped', 'Archived'],
    ]);
    expect(rows.slice(2).every(row => row.every(cell => cell === ''))).toBe(true);
  });

  it('case4_complex_sheet: imports hidden, formula and duplicate-header columns; blank rows are skipped', async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES_DIR, 'case4_complex_sheet.xlsx'));
    const schema: JsonSchemaNode = {
      type: 'object',
      properties: {
        customer: { type: 'string' },
        region: { type: 'string' },
        total: { type: 'number' },
        secret: { type: 'string' },
        status: { type: 'string' },
        lifecycle: { type: 'string' },
      },
    };
    const plan = {
      target: 'sales',
      entries: [
        { ref: 'customer', column: 0 },
        { ref: 'region', column: 1 },
        { ref: 'total', column: 4 },
        { ref: 'secret', column: 5 },
        { ref: 'status', column: 6 },
        { ref: 'lifecycle', column: 7 },
      ],
    };

    const records: Record<string, unknown>[] = [];
    const result = await runImport({
      stream: chunked(bytes, 1024),
      plan,
      adapter: jsonSchemaAdapter(schema),
      ctx: undefined,
      onBatch: batch => {
        records.push(...batch);
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(7);
    expect(records).toEqual([
      { customer: 'Acme Corp', region: 'North America', total: 255, secret: 'Internal discount applied', status: 'Pending', lifecycle: 'Active' },
      { customer: 'Globex', region: 'Europe', total: 400, secret: 'VIP client', status: 'Shipped', lifecycle: 'Archived' },
    ]);
  });
});
