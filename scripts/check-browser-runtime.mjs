#!/usr/bin/env node
/**
 * Read a CSV and a workbook through the built `/browser` entry on the Node that runs this.
 *
 * - Without flags, the runtime must have `DecompressionStream` with "deflate-raw", and both read.
 * - With `--expect-unsupported` (CI runs it on Node 20.11), the runtime must lack the format, the
 *   CSV must still read, and the workbook must be refused with UNSUPPORTED_RUNTIME naming the
 *   minimum versions (R1-1 in docs/1.1-rc-feedback.md). A runtime that has the format would make
 *   that half prove nothing, so it fails the check.
 *
 * Imports the package by its own name, so what is run is `dist`, as a consumer runs it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSheetFile } from 'sheet-to-schema/browser';

const expectUnsupported = process.argv.includes('--expect-unsupported');
let supported = true;
try {
  new DecompressionStream('deflate-raw');
} catch {
  supported = false;
}
assert.equal(supported, !expectUnsupported, `Node ${process.version} ${supported ? 'has' : 'lacks'} DecompressionStream "deflate-raw", which this check ${expectUnsupported ? 'needs it to lack' : 'needs'}.`);

const csv = await readSheetFile(readFileSync('test/fixtures/real-world/case3_excel_semicolon.csv'), { filename: 'case3_excel_semicolon.csv' });
assert.deepEqual([csv.format, csv.delimiter, csv.headers], ['csv', ';', ['Product', 'Price', 'Rating']]);

const workbook = readFileSync('test/fixtures/real-world/case1_1904_dates.xlsx');
if (expectUnsupported) {
  const failure = await readSheetFile(workbook).catch(error => error);
  assert.equal(failure?.code, 'UNSUPPORTED_RUNTIME', `expected UNSUPPORTED_RUNTIME, got ${failure?.code ?? 'a sheet'}: ${failure?.message ?? ''}`);
  for (const minimum of ['Node 20.12+', 'Chrome or Edge 103+', 'Firefox 113+', 'Safari 16.4+']) assert.ok(failure.message.includes(minimum), minimum);
  console.log(`Node ${process.version}: no "deflate-raw"; a CSV reads through /browser, and a workbook is refused with UNSUPPORTED_RUNTIME.`);
} else {
  const sheet = await readSheetFile(workbook);
  assert.deepEqual(sheet.headers, ['Name', 'BirthDate', 'JoinDate']);
  console.log(`Node ${process.version}: "deflate-raw" present; a CSV and a workbook read through /browser.`);
}
