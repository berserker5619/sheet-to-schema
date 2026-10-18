/**
 * `pickFromDirectory`: the browser's pre-check of an archive by its central directory, and the
 * parts it keeps. Forged directories stand for files that lie about themselves.
 */
import JSZip from 'jszip';
import { CENTRAL_HEADER, END_OF_CENTRAL, pickFromDirectory, repack, sheetNumber, WANTED } from './zip';

const LIMITS = { maxZipEntries: 512, maxUncompressedBytes: 200 * 1024 * 1024, maxCompressionRatio: 200 };

async function archive(files: Record<string, string>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE'): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: 'uint8array', compression });
}

const WORKBOOK = {
  '[Content_Types].xml': '<Types/>',
  'docProps/app.xml': '<Properties/>',
  'xl/workbook.xml': '<workbook/>',
  'xl/styles.xml': '<styleSheet/>',
  'xl/worksheets/sheet3.xml': '<worksheet>three</worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet>two</worksheet>',
  'xl/theme/theme1.xml': '<theme/>',
};

/** Offsets of each central record, so a test can forge one field. */
function centralRecords(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== END_OF_CENTRAL) end--;
  const out: number[] = [];
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    out.push(at);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

const forge = (bytes: Uint8Array, at: number, width: 16 | 32, value: number): Uint8Array => {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  if (width === 16) view.setUint16(at, value, true);
  else view.setUint32(at, value, true);
  return copy;
};

const refusalOf = (bytes: Uint8Array, limits = LIMITS): { code?: string; message: string } => {
  try {
    pickFromDirectory(bytes, limits);
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('pickFromDirectory', () => {
  it('keeps the wanted parts and the lowest-numbered sheet, in the parser\'s order, data untouched', async () => {
    const kept = await JSZip.loadAsync(pickFromDirectory(await archive(WORKBOOK), LIMITS));
    expect(Object.keys(kept.files)).toEqual(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet2.xml']);
    expect(await kept.file('xl/worksheets/sheet2.xml')!.async('string')).toBe('<worksheet>two</worksheet>');
  });

  it('reads stored entries as well as deflated ones, and an archive with a comment', async () => {
    const zip = new JSZip();
    for (const [name, text] of Object.entries(WORKBOOK)) zip.file(name, text);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE', comment: 'made by a test' });
    const kept = await JSZip.loadAsync(pickFromDirectory(bytes, LIMITS));
    expect(await kept.file('xl/workbook.xml')!.async('string')).toBe('<workbook/>');
  });

  it('refuses past maxZipEntries by the directory\'s count', async () => {
    expect(refusalOf(await archive(WORKBOOK), { ...LIMITS, maxZipEntries: 3 })).toEqual({ code: 'ARCHIVE_REFUSED', message: 'The workbook has more than 3 entries.' });
  });

  it('refuses a declared total past maxUncompressedBytes', async () => {
    const bytes = await archive(WORKBOOK);
    const [first] = centralRecords(bytes);
    expect(refusalOf(forge(bytes, first + 24, 32, 300 * 1024 * 1024))).toEqual({
      code: 'ARCHIVE_REFUSED',
      message: `The workbook inflates to more than the ${200 * 1024 * 1024} byte limit.`,
    });
  });

  it('refuses zip64, by the end record or by an entry', async () => {
    const bytes = await archive(WORKBOOK);
    const [first] = centralRecords(bytes);
    expect(refusalOf(forge(bytes, first + 20, 32, 0xffffffff)).message).toBe('The workbook uses zip64, which is not supported.');
    const end = bytes.length - 22;
    expect(refusalOf(forge(bytes, end + 10, 16, 0xffff)).message).toBe('The workbook uses zip64, which is not supported.');
  });

  it('refuses an unsupported method and a stored entry without a declared size, as the server does', async () => {
    const bytes = await archive(WORKBOOK, 'STORE');
    const [first] = centralRecords(bytes);
    expect(refusalOf(forge(bytes, first + 10, 16, 12))).toEqual({ code: 'ARCHIVE_REFUSED', message: 'Entry "[Content_Types].xml" uses compression method 12, which is not supported.' });
    expect(refusalOf(forge(bytes, first + 8, 16, 0x08))).toEqual({ code: 'ARCHIVE_REFUSED', message: 'Entry "[Content_Types].xml" is stored without a declared size.' });
  });

  it('calls a directory it cannot follow malformed', async () => {
    const bytes = await archive(WORKBOOK);
    const records = centralRecords(bytes);
    const malformed = { code: 'MALFORMED_FILE', message: 'The workbook could not be read.' };
    // No end record at all.
    expect(refusalOf(bytes.subarray(0, bytes.length - 22))).toEqual(malformed);
    // A record that is not one.
    expect(refusalOf(forge(bytes, records[1], 32, 0))).toEqual(malformed);
    // A kept entry whose local header is not where the directory says.
    expect(refusalOf(forge(bytes, records[0] + 42, 32, 5))).toEqual(malformed);
    // An entry whose data runs past the end of the file.
    expect(refusalOf(forge(bytes, records[0] + 20, 32, bytes.length))).toEqual(malformed);
    // A directory that claims to run past the end record.
    const end = bytes.length - 22;
    expect(refusalOf(forge(bytes, end + 12, 32, bytes.length))).toEqual(malformed);
    // A record whose name runs past the end record.
    expect(refusalOf(forge(bytes, records[records.length - 1] + 28, 16, 0xfff0))).toEqual(malformed);
    // A local header offset past the end of the file.
    expect(refusalOf(forge(bytes, records[0] + 42, 32, bytes.length))).toEqual(malformed);
    expect(CENTRAL_HEADER).toBe(0x02014b50);
  });

  it('tells a workbook without a sheet from a zip that is no workbook', async () => {
    const noSheet = Object.fromEntries(Object.entries(WORKBOOK).filter(([name]) => sheetNumber(name) === null));
    expect(refusalOf(await archive(noSheet))).toEqual({ code: 'MALFORMED_FILE', message: 'This workbook has no worksheet.' });
    expect(refusalOf(await archive({ 'word/document.xml': '<w/>' })).code).toBe('UNSUPPORTED_FORMAT');
  });
});

describe('repack and sheetNumber', () => {
  it('writes an archive JSZip reads back, entry for entry', async () => {
    const bytes = repack([]);
    expect(Object.keys((await JSZip.loadAsync(bytes)).files)).toEqual([]);
  });

  it('numbers only worksheets', () => {
    expect(sheetNumber('xl/worksheets/sheet12.xml')).toBe(12);
    expect(sheetNumber('xl/worksheets/_rels/sheet1.xml.rels')).toBeNull();
    expect(WANTED[0]).toBe('[Content_Types].xml');
  });
});
