import { createServer } from 'node:http';
import { ImportError, jsonSchemaAdapter, planForServer, SERVER_FEATURES, type ImportErrorCode, type ImportPreviewResponse } from 'sheet-to-schema';
import {
  previewSheet, readPlanField, receiveUpload, resolveLimits, runImport, templateFilename, templateOf, toErrorBody, writeTemplate,
  type ImportLimits, type ImportProgress, type ImportRunResult, type OnBatch, type RunImportOptions,
} from 'sheet-to-schema/node';
import { readSheetFile, type SheetFile } from 'sheet-to-schema/browser';

const adapter = jsonSchemaAdapter({ $id: 'p', type: 'object', properties: { name: { type: 'string' } } });
const limits: ImportLimits = resolveLimits({ idleTimeoutMs: 5000 });
const onBatch: OnBatch = async records => void records;
const onProgress = (p: ImportProgress): void => void (p.bytesRead / p.rowsRead);
const options: RunImportOptions<unknown, undefined> = { stream: Buffer.from('a'), plan: {}, adapter, ctx: undefined, onBatch, onProgress, signal: AbortSignal.timeout(1000), grouping: false };
const aborted: ImportErrorCode = 'ABORTED';
const preview: Pick<ImportPreviewResponse, 'features'> = { features: [...SERVER_FEATURES] };
void planForServer({}, preview);
void [limits, options, aborted];

// @ts-expect-error UNKNOWN_ENTITY is gone in 2.0
const gone: ImportErrorCode = 'UNKNOWN_ENTITY';
// @ts-expect-error totalTimeoutMs is gone in 2.0
const noTotal: Partial<ImportLimits> = { totalTimeoutMs: 1 };
void [gone, noTotal];

createServer(async (req, res) => {
  try {
    if (req.url === '/template') {
      res.setHeader('Content-Disposition', `attachment; filename="${templateFilename(adapter.id, 'xlsx')}"`);
      await writeTemplate({ sheet: templateOf(adapter, 'en', undefined), format: 'xlsx', out: res });
      return;
    }
    const upload = await receiveUpload(req, limits);
    if (req.url === '/preview') {
      res.end(JSON.stringify(await previewSheet({ stream: upload.stream, filename: upload.filename, adapter, limits })));
      return;
    }
    const result: ImportRunResult = await runImport({ ...options, stream: upload.stream, plan: readPlanField(upload.fields) });
    res.end(JSON.stringify(result));
  } catch (error) {
    if (error instanceof ImportError && error.code === 'ABORTED') console.log(error.details);
    const { status, body } = toErrorBody(error);
    res.writeHead(status).end(JSON.stringify(body));
  }
});

const file: Promise<SheetFile> = readSheetFile(new Blob(['a,b\n1,2']));
void file;
