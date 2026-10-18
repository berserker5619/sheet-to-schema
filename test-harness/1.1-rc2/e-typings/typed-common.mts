// Round (e): what 1.1 adds, as a strict TypeScript consumer sees it. No express here.
import {
  DEFAULT_GROUP_LIMITS,
  decimalMarkFor,
  planForServer,
  type GroupLimits,
  type ImportPreviewResponse,
  type PlanForServer,
  type ServerCapabilities,
} from 'sheet-to-schema';
import { ImportError, readSheetFile, readXlsx, type BrowserLimits, type ImportErrorCode, type ReadSheetFileOptions, type SheetFile, type SheetFileInput } from 'sheet-to-schema/browser';
import {
  createImportRouter,
  GROUPING_NOT_STREAMED,
  NON_CONTIGUOUS_NOT_STREAMED,
  runImport,
  SERVER_FEATURES,
  type ImportLimits,
  type ImportRouter,
  type ImportRouterOptions,
  type RunImportOptions,
} from 'sheet-to-schema/node';

// The browser entry.
export async function read(file: File): Promise<{ sheet: SheetFile; decimal: '.' | ',' }> {
  const limits: Partial<BrowserLimits> = { maxRows: 1000, maxZipEntries: 64 };
  const options: ReadSheetFileOptions = { filename: file.name, limits };
  const sheet = await readSheetFile(file, options);
  const format: 'csv' | 'xlsx' = sheet.format;
  void format;
  return { sheet, decimal: decimalMarkFor(sheet.delimiter) };
}
export async function readBytes(input: SheetFileInput): Promise<string[]> {
  try {
    return (await readXlsx(input, { limits: { maxBytes: 1024 } })).headers;
  } catch (error) {
    if (error instanceof ImportError) {
      const code: ImportErrorCode = error.code;
      return [code, error.message];
    }
    throw error;
  }
}
// @ts-expect-error the browser's limits are the five the spec names, not the server's
export const tooMany: Partial<BrowserLimits> = { idleTimeoutMs: 1 };

// The grouping option, limits and capability check.
export const groupLimits: GroupLimits = { ...DEFAULT_GROUP_LIMITS, maxGroupRows: 50_000 };
export const serverLimits: Partial<ImportLimits> = { maxGroups: 10, batchSize: 100 };
export function decide(plan: unknown, preview: ImportPreviewResponse): PlanForServer {
  const features: string[] | undefined = preview.features;
  const capabilities: ServerCapabilities = { planVersions: preview.planVersions, features };
  const byPreview = planForServer(plan, preview);
  const byVersions = planForServer(plan, preview.planVersions);
  return byPreview.refused ? byPreview : planForServer(plan, capabilities).plan ? byVersions : byPreview;
}
export const run = (options: Omit<RunImportOptions, 'grouping'>) => runImport({ ...options, grouping: true });
export const messages: string[] = [GROUPING_NOT_STREAMED, NON_CONTIGUOUS_NOT_STREAMED, ...SERVER_FEATURES];
// @ts-expect-error grouping is a boolean
export const wrong: Partial<RunImportOptions> = { grouping: 'yes' };

/**
 * A router with grouping on, over any router shaped like express's, so this file needs no express
 * types. Generic, as `createImportRouter` is, so an express router comes back an express router.
 */
export function mount<TRouter extends ImportRouter>(router: TRouter, options: Omit<ImportRouterOptions, 'grouping'>): TRouter {
  return createImportRouter(router, { ...options, grouping: true });
}
