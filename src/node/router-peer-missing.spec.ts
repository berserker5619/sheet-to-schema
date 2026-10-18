/**
 * The router without `exceljs` installed (1.2): the client is answered `INTERNAL`, as in 1.1,
 * and the server is told `PEER_MISSING` and which package, through `onError` or its default log.
 *
 * The mock stands for the package not being there: it fails the way Node fails. It is in a file
 * of its own because a module mock covers the whole file.
 */
import express from 'express';
import JSZip from 'jszip';
import request from 'supertest';
import { createImportRouter, type ImportErrorReport, type ImportRouterOptions } from './router';
import { CSV_TEXT, EMPLOYEES } from './sheet.fixtures';

jest.mock('exceljs', () => {
  throw Object.assign(new Error("Cannot find module 'exceljs' from 'src/node/xlsx-source.ts'"), { code: 'MODULE_NOT_FOUND' });
});

const INTERNAL = { error: { code: 'INTERNAL', message: 'The import could not be completed.' } };

/** The smallest archive the zip guard takes for a workbook, built without exceljs. */
async function workbookBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function app(overrides: Partial<ImportRouterOptions> = {}): express.Express {
  const server = express();
  server.use('/import', createImportRouter(express.Router(), { bindings: { employee: { adapter: EMPLOYEES, ctx: undefined } }, onImport: () => undefined, ...overrides }));
  return server;
}

describe('a server without exceljs', () => {
  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  it('answers a workbook preview INTERNAL, and tells onError PEER_MISSING and the package', async () => {
    const reports: [unknown, ImportErrorReport][] = [];
    const response = await request(app({ onError: (error, report) => reports.push([error, report]) }))
      .post('/import/employee/preview')
      .attach('file', await workbookBytes(), 'people.xlsx');

    expect(response.status).toBe(500);
    expect(response.body).toEqual(INTERNAL);
    expect(reports).toHaveLength(1);
    const [error, report] = reports[0];
    expect(report).toMatchObject({ status: 500, code: 'PEER_MISSING', peer: 'exceljs' });
    expect(report.request.url).toBe('/employee/preview');
    expect(error).toMatchObject({ code: 'PEER_MISSING', details: { peer: 'exceljs' } });
    // Given to onError, the default logger is not used.
    expect(logged).not.toHaveBeenCalled();
  });

  it('logs the code and the package by default, with the error', async () => {
    const response = await request(app()).post('/import/employee/preview').attach('file', await workbookBytes(), 'people.xlsx');

    expect(response.status).toBe(500);
    expect(response.body).toEqual(INTERNAL);
    expect(logged).toHaveBeenCalledTimes(1);
    const [line, error] = logged.mock.calls[0];
    expect(line).toBe('sheet-to-schema/node: POST /import/employee/preview answered 500: PEER_MISSING (exceljs)');
    expect(error).toMatchObject({ code: 'PEER_MISSING', message: expect.stringContaining('npm install exceljs') });
  });

  it('does the same for an xlsx template, which needs exceljs to be written', async () => {
    const reports: ImportErrorReport[] = [];
    const response = await request(app({ onError: (_, report) => reports.push(report) })).get('/import/employee/template?format=xlsx');

    expect(response.status).toBe(500);
    expect(response.body).toEqual(INTERNAL);
    expect(reports.map(({ code, peer }) => ({ code, peer }))).toEqual([{ code: 'PEER_MISSING', peer: 'exceljs' }]);
  });

  it('still answers the client when onError throws', async () => {
    const response = await request(
      app({
        onError: () => {
          throw new Error('the logger is down');
        },
      }),
    )
      .post('/import/employee/preview')
      .attach('file', await workbookBytes(), 'people.xlsx');

    expect(response.status).toBe(500);
    expect(response.body).toEqual(INTERNAL);
  });

  it('reports a failure that is not an ImportError as INTERNAL, with no package', async () => {
    const reports: ImportErrorReport[] = [];
    const bindings = () => {
      throw new Error('the bindings store is down');
    };
    const response = await request(app({ bindings, onError: (_, report) => reports.push(report) })).get('/import/employee/template');

    expect(response.status).toBe(500);
    expect(reports.map(({ status, code, peer }) => ({ status, code, peer }))).toEqual([{ status: 500, code: 'INTERNAL', peer: undefined }]);
  });

  it('reports an onImport that threw by its own code, IMPORT_FAILED', async () => {
    const reports: ImportErrorReport[] = [];
    const plan = { entity: 'employee', entries: [{ ref: 'personal.firstName', column: 0 }] };
    const onImport = () => {
      throw new Error('the database is down');
    };
    const response = await request(app({ onImport, onError: (_, report) => reports.push(report) }))
      .post('/import/employee/import')
      .field('plan', JSON.stringify(plan))
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(500);
    expect(reports.map(({ code }) => code)).toEqual(['IMPORT_FAILED']);
    // The default logger prints nothing when onError is given, and the line format names no package.
    expect(logged).not.toHaveBeenCalled();
  });

  it('tells nobody about a failure the client is answered 4xx for: the client was told', async () => {
    const reports: ImportErrorReport[] = [];
    const response = await request(app({ onError: (_, report) => reports.push(report) })).get('/import/nobody/template');

    expect(response.status).toBe(404);
    expect(reports).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('still reads a CSV, which never needed it', async () => {
    const response = await request(app()).post('/import/employee/preview').attach('file', Buffer.from(CSV_TEXT), 'people.csv');
    expect(response.status).toBe(200);
    expect(logged).not.toHaveBeenCalled();
  });
});
