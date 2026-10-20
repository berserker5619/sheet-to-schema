/**
 * The binary refusal (2.0; docs/2.0-spec.md, D5 and §4.2), the same from all five entry points
 * that classify input: `readSheet`, `previewSheet` and `runImport` in `/node`, `readSheetFile` in
 * `/browser`, and `readCsvFile` in the main entry. And everything 1.x read, still read exactly as
 * 1.3.0 read it (`test/fixtures/v1-grids.json`, written by 1.3.0 itself).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { readSheetFile } from './browser/read-sheet-file';
import { jsonSchemaAdapter } from './json-schema-adapter';
import { readSheet } from './node/read-sheet';
import { previewSheet, runImport } from './node/run-import';
import { readCsvFile } from './read-csv-file';
import { BINARY_MESSAGE, MAGIC_BYTES } from './sheet-format';

const FIXTURES = join(__dirname, '../test/fixtures');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const ADAPTER = jsonSchemaAdapter({ $id: 'any', type: 'object', properties: { a: { type: 'string' } } }, { version: 1 });
const PLAN = { planVersion: 2, target: 'any', schemaVersion: 1, entries: [{ ref: 'a', column: 0 }] };

type Outcome = { ok: true } | { ok: false; name: string; code: string; message: string };

async function outcome(read: () => Promise<unknown>): Promise<Outcome> {
  try {
    await read();
    return { ok: true };
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    return { ok: false, name: e.name, code: e.code, message: e.message };
  }
}

/** What each of the five entry points makes of `bytes`, read to the end. */
async function allFive(bytes: Uint8Array, filename = 'upload.csv'): Promise<Record<string, Outcome>> {
  return {
    readSheet: await outcome(async () => {
      const sheet = await readSheet({ stream: bytes, filename });
      for await (const row of sheet.rows) void row;
    }),
    previewSheet: await outcome(() => previewSheet({ stream: bytes, filename, adapter: ADAPTER })),
    runImport: await outcome(() => runImport({ stream: bytes, filename, plan: PLAN, adapter: ADAPTER, ctx: undefined })),
    readSheetFile: await outcome(() => readSheetFile(bytes, { filename })),
    readCsvFile: await outcome(() => readCsvFile(bytes, { filename })),
  };
}

const REFUSED: Outcome = { ok: false, name: 'ImportError', code: 'UNSUPPORTED_FORMAT', message: BINARY_MESSAGE };

describe('binary input is refused, identically, by all five entry points', () => {
  it.each([
    ['a PNG', 'binary/image.png'],
    ['a PDF', 'binary/document.pdf'],
    ['random bytes', 'binary/random.bin'],
  ])('%s', async (_what, file) => {
    const bytes = fixture(file);
    expect(Object.values(await allFive(bytes, file.split('/')[1]))).toEqual(Array(5).fill(REFUSED));
    // Named .csv, it is refused all the same: the bytes decide, never the name.
    expect(Object.values(await allFive(bytes, 'data.csv'))).toEqual(Array(5).fill(REFUSED));
  });

  it('refuses a NUL anywhere in the first 8 KB, and at its last byte', async () => {
    for (const at of [0, 1, 100, MAGIC_BYTES - 1]) {
      const bytes = Buffer.alloc(MAGIC_BYTES + 100, 'a');
      bytes[at] = 0;
      expect(Object.values(await allFive(bytes))).toEqual(Array(5).fill(REFUSED));
    }
  });

  it('accepts a NUL after the first 8 KB, and reads it as text, as 1.x did', async () => {
    const bytes = fixture('binary/nul-after-8k.csv');
    expect(bytes.indexOf(0)).toBeGreaterThanOrEqual(MAGIC_BYTES);
    expect(Object.values(await allFive(bytes, 'nul-after-8k.csv'))).toEqual(Array(5).fill({ ok: true }));
    const read = await readCsvFile(bytes);
    expect(read.rows.at(-1)).toEqual(['Late', 'before\u0000after']);
  });

  it('refuses a zip that is not a workbook with one code and one message from all five (rc.2)', async () => {
    const zip = new JSZip();
    zip.file('data.csv', 'Name,City\r\nAda,Chennai\r\n');
    zip.file('notes/readme.txt', 'not a workbook');
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      const bytes = await zip.generateAsync({ type: 'uint8array', compression });
      for (const name of ['archive.zip', 'archive.xlsx', 'archive.csv']) {
        expect(Object.values(await allFive(bytes, name))).toEqual(
          Array(5).fill({ ok: false, name: 'ImportError', code: 'UNSUPPORTED_FORMAT', message: 'This is a zip archive that is not an Excel workbook. Upload an .xlsx or .csv file.' }),
        );
      }
    }
  });

  it('still tells a readCsvFile caller that a real workbook is a workbook', async () => {
    const workbook = fixture('real-world/case1_1904_dates.xlsx');
    expect(await outcome(() => readCsvFile(workbook))).toEqual({
      ok: false,
      name: 'ImportError',
      code: 'UNSUPPORTED_FORMAT',
      message: 'This is an .xlsx workbook. Read it with readSheetFile from sheet-to-schema/browser, or save it as CSV.',
    });
  });

  it('still refuses .xls and UTF-16 with their own messages, which come first', async () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const utf16 = Buffer.from('﻿Name\r\nAda\r\n', 'utf16le');
    for (const [bytes, message] of [
      [xls, /pre-2007 Excel file/],
      [utf16, /UTF-16 encoded/],
    ] as const) {
      for (const result of Object.values(await allFive(bytes))) {
        expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_FORMAT', message: expect.stringMatching(message) });
      }
    }
  });
});

describe('every CSV variant 1.x accepted is still accepted', () => {
  const variants: [string, Buffer][] = [
    ['UTF-8', Buffer.from('Name,City\r\nAda,Chennai\r\n', 'utf8')],
    ['UTF-8 with a BOM', Buffer.from('﻿Name,City\r\nAda,Chennai\r\n', 'utf8')],
    ['LF line ends', Buffer.from('Name,City\nAda,Chennai\n', 'utf8')],
    ['semicolons', Buffer.from('Name;Amount\r\nAda;1,5\r\n', 'utf8')],
    ['tabs', Buffer.from('Name\tCity\r\nAda\tChennai\r\n', 'utf8')],
    ['multi-line quoted cells', Buffer.from('Name,Address\r\nAda,"12 Main St\r\nFlat 4\nChennai"\r\n', 'utf8')],
    ['non-Latin text', Buffer.from('பெயர்,நகரம்\r\nஅடா,சென்னை\r\n', 'utf8')],
    ['Latin-1 bytes', Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0d, 0x0a, 0x4a, 0x6f, 0x73, 0xe9, 0x0d, 0x0a])],
    ['an empty file', Buffer.alloc(0)],
  ];

  it.each(variants)('%s', async (_what, bytes) => {
    expect(Object.values(await allFive(bytes))).toEqual(Array(5).fill({ ok: true }));
  });
});

describe('every 1.x fixture reads exactly as 1.3.0 read it', () => {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'v1-grids.json'), 'utf8')) as {
    version: string;
    grids: Record<string, { format: string; node: unknown; browser: unknown }>;
  };
  const revive = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value), (_key, v: unknown) => (v && typeof v === 'object' && '$date' in v ? new Date((v as { $date: string }).$date) : v));

  it('was written by 1.3.0, over every CSV, TSV and .xlsx fixture there is', () => {
    expect(golden.version).toBe('1.3.0');
    const files: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        else if (/\.(csv|tsv|xlsx)$/i.test(entry.name) && prefix !== 'binary/') files.push(`${prefix}${entry.name}`);
      }
    };
    walk(FIXTURES, '');
    expect(Object.keys(golden.grids).sort()).toEqual(files.sort());
  });

  it.each(Object.keys(golden.grids))('%s', async name => {
    const bytes = fixture(name);
    const expected = golden.grids[name];

    const sheet = await readSheet({ stream: bytes, filename: name });
    const rows: unknown[][] = [];
    for await (const row of sheet.rows) rows.push(row);
    expect(sheet.format).toBe(expected.format);
    expect({ headers: sheet.headers, rows, ...(sheet.delimiter ? { delimiter: sheet.delimiter } : {}) }).toEqual(revive(expected.node));

    const browser = await readSheetFile(bytes, { filename: name });
    expect({ headers: browser.headers, rows: browser.rows, ...(browser.delimiter ? { delimiter: browser.delimiter } : {}) }).toEqual(revive(expected.browser));

    if (expected.format === 'csv') {
      const csv = await readCsvFile(bytes, { filename: name });
      expect({ headers: csv.headers, rows: csv.rows, ...(csv.delimiter ? { delimiter: csv.delimiter } : {}) }).toEqual(revive(expected.browser));
    }
  });

  it('imports and previews each one without a refusal', async () => {
    for (const name of Object.keys(golden.grids)) {
      const bytes = fixture(name);
      await expect(previewSheet({ stream: bytes, filename: name, adapter: ADAPTER })).resolves.toBeDefined();
      await expect(runImport({ stream: bytes, filename: name, plan: PLAN, adapter: ADAPTER, ctx: undefined })).resolves.toBeDefined();
    }
  });
});
