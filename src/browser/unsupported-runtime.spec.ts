/**
 * A runtime with `DecompressionStream` but not its `deflate-raw` format (Node 20.0 to 20.11,
 * Chrome and Edge 80 to 102): a CSV reads, and a workbook is refused with UNSUPPORTED_RUNTIME
 * naming the versions that can read one, before the file or ExcelJS is touched (R1-1 in
 * docs/1.1-rc-feedback.md; 1.1.0-rc.2 let the constructor's TypeError escape).
 */
import { fixtureBytes } from './parity.fixtures';
import { readSheetFile, readXlsx } from './read-sheet-file';

/** What Node 20.11 does: the class is there, the format is not. */
class OldDecompressionStream {
  constructor(format: string) {
    if (format === 'deflate-raw') throw Object.assign(new TypeError(`The argument 'format' is invalid. Received '${format}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  }
}

describe('a runtime without deflate-raw', () => {
  const globals = globalThis as { DecompressionStream?: unknown };
  const saved = globals.DecompressionStream;
  beforeEach(() => {
    globals.DecompressionStream = OldDecompressionStream;
  });
  afterEach(() => {
    globals.DecompressionStream = saved;
  });

  it('still reads a CSV', async () => {
    const sheet = await readSheetFile(fixtureBytes('real-world/case3_excel_semicolon.csv'), { filename: 'case3_excel_semicolon.csv' });
    expect(sheet).toMatchObject({ format: 'csv', delimiter: ';', headers: ['Product', 'Price', 'Rating'] });
  });

  it.each([
    ['readSheetFile', (bytes: Buffer) => readSheetFile(bytes)],
    ['readXlsx', (bytes: Buffer) => readXlsx(bytes)],
  ])('%s refuses a workbook with UNSUPPORTED_RUNTIME, naming the minimum versions', async (_name, read) => {
    const failure = await read(fixtureBytes('real-world/case1_1904_dates.xlsx')).catch(error => error);
    expect(failure).toMatchObject({ name: 'ImportError', code: 'UNSUPPORTED_RUNTIME' });
    for (const minimum of ['Node 20.12+', 'Chrome or Edge 103+', 'Firefox 113+', 'Safari 16.4+']) expect((failure as Error).message).toContain(minimum);
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('ERR_INVALID_ARG_VALUE');
  });

  it('refuses before looking at the archive: a broken zip gets the same answer', async () => {
    const failure = await readSheetFile(Buffer.from('PK\x03\x04 not really a zip')).catch(error => error);
    expect(failure).toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
  });
});
