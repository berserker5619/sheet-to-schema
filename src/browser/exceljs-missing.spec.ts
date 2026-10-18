/**
 * `/browser` without `exceljs` installed (1.1 spec, A), and the zip pre-checks that run before
 * ExcelJS is ever asked for.
 *
 * The mock stands for the package not being there and counts every attempt to load it. It is in
 * a file of its own because a module mock covers the whole file.
 */
import JSZip from 'jszip';

let mockLoads = 0;
jest.mock('exceljs', () => {
  mockLoads++;
  throw Object.assign(new Error("Cannot find module 'exceljs' from 'src/browser/read-sheet-file.ts'"), { code: 'MODULE_NOT_FOUND' });
});

/** The smallest archive that passes the pre-checks for a workbook, built without exceljs. */
async function workbookBytes(extra: (zip: JSZip) => void = () => undefined): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  extra(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('sheet-to-schema/browser without exceljs', () => {
  it('loads nothing when the entry is imported', async () => {
    const entry = await import('./index');
    expect(typeof entry.readSheetFile).toBe('function');
    expect(mockLoads).toBe(0);
  });

  it('reads a CSV, and still has not tried to load exceljs', async () => {
    const { readSheetFile } = await import('./index');
    const sheet = await readSheetFile(Buffer.from('a,b\n1,2\n'));
    expect(sheet).toEqual({ format: 'csv', headers: ['a', 'b'], rows: [['1', '2']], delimiter: ',' });
    expect(mockLoads).toBe(0);
  });

  it('refuses an archive with too many entries before trying to load exceljs', async () => {
    const { readSheetFile } = await import('./index');
    const bytes = await workbookBytes(zip => {
      for (let i = 0; i < 20; i++) zip.file(`xl/media/image${i}.png`, 'x');
    });
    const failure = await readSheetFile(bytes, { limits: { maxZipEntries: 10 } }).catch(error => error);
    expect(failure).toMatchObject({ code: 'ARCHIVE_REFUSED', message: 'The workbook has more than 10 entries.' });
    expect(mockLoads).toBe(0);
  });

  it('refuses an entry whose declared ratio is past the limit before trying to load exceljs', async () => {
    const { readSheetFile } = await import('./index');
    // A megabyte of zeros deflates about a thousand to one; the directory says so.
    const bytes = await workbookBytes(zip => zip.file('xl/sharedStrings.xml', '0'.repeat(1024 * 1024)));
    const failure = await readSheetFile(bytes).catch(error => error);
    expect(failure).toMatchObject({ code: 'ARCHIVE_REFUSED', message: 'An entry in the workbook inflates more than 200 times — refusing it.' });
    expect(mockLoads).toBe(0);
  });

  it('says which package to install for a workbook, and that it is optional', async () => {
    const { readSheetFile } = await import('./index');
    const failure = await readSheetFile(await workbookBytes()).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'sheet-to-schema/browser needs the "exceljs" package to read .xlsx files, and it is not installed. ' +
        'It is an optional peer dependency: run `npm install exceljs`.',
    );
    // Its own code (1.2): the file is fine, the app is missing a package.
    const { ImportError } = await import('./index');
    expect(failure).toBeInstanceOf(ImportError);
    expect(failure).toMatchObject({ code: 'PEER_MISSING', details: { peer: 'exceljs' } });
    expect(mockLoads).toBeGreaterThan(0);
  });
});
