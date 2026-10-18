/**
 * @jest-environment jsdom
 *
 * `readSheetFile` in a browser environment, on ExcelJS's browser build, reads exactly what the
 * server's `readSheet` reads (1.1 spec, A: "under jsdom and under Node").
 *
 * `exceljs` resolves to one module per file, so it is mocked as both of its builds at once: the
 * browser build's `Workbook` and `ValueType`, which is all `readSheetFile` touches and what a
 * bundler gives a browser app (the package's `browser` field), and the Node build's `stream`,
 * which is all the server's reader touches. Each side runs on the build it ships against.
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';

jest.mock('exceljs', () => {
  const browser = jest.requireActual('exceljs/dist/exceljs.js');
  const node = jest.requireActual('exceljs');
  return { __esModule: true, default: { Workbook: browser.Workbook, ValueType: browser.ValueType, stream: node.stream } };
});

// What jsdom leaves out and the server's reader (not the browser's) needs, under Jest only.
const globals = globalThis as Record<string, unknown>;
globals['setImmediate'] ??= (callback: () => void) => setTimeout(callback, 0);
globals['TextDecoder'] ??= NodeTextDecoder;
globals['TextEncoder'] ??= NodeTextEncoder;

import { ALL_FIXTURES, fixtureBytes, nameOf, serverGrid } from './parity.fixtures';
import { readSheetFile } from './read-sheet-file';

describe('readSheetFile reads what readSheet reads (jsdom, ExcelJS browser build)', () => {
  it('runs where a browser runs', () => {
    expect(typeof window).toBe('object');
    expect(typeof FileReader).toBe('function');
  });

  it.each(ALL_FIXTURES.map(fixture => [fixture.file] as const))('%s, as a File', async file => {
    const bytes = fixtureBytes(file);
    const expected = await serverGrid(bytes, nameOf(file));
    // A File from the page's own realm, read the way a page reads one.
    const input = new File([new Uint8Array(bytes)], nameOf(file));
    const read = await readSheetFile(input, { filename: input.name });
    // Compared as JSON-safe values: a jsdom Date and a Node Date are two realms' classes.
    expect(normalise(read)).toEqual(normalise(expected));
  });

  it('reads a Blob through FileReader where the Blob has no arrayBuffer, and reports a failed read', async () => {
    const bytes = fixtureBytes('real-world/case3_excel_utf8_bom.csv');
    const blob = new Blob([new Uint8Array(bytes)]);
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined });
    expect(normalise(await readSheetFile(blob))).toEqual(normalise(await serverGrid(bytes)));

    const failing = new Blob(['a,b']);
    Object.defineProperty(failing, 'arrayBuffer', { value: undefined });
    const readAsArrayBuffer = jest.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(function (this: FileReader) {
      Object.defineProperty(this, 'error', { value: new Error('unreadable') });
      this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
    });
    await expect(readSheetFile(failing)).rejects.toThrow('unreadable');
    readAsArrayBuffer.mockRestore();
  });

  it('keeps "Rajesh Kumar 🎉" from the openpyxl workbook intact (R3-1)', async () => {
    const read = await readSheetFile(new File([new Uint8Array(fixtureBytes('real-world/case5_non_latin.xlsx'))], 'case5.xlsx'));
    expect(read.rows.flat()).toContain('Rajesh Kumar 🎉');
  });
});

/** Dates as their instant, from whichever realm; everything else as it is. */
function normalise(value: unknown): unknown {
  if (Object.prototype.toString.call(value) === '[object Date]') return { date: (value as Date).toISOString() };
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalise(inner)]));
  return value;
}
