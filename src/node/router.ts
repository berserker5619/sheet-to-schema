/**
 * router.ts — the import over HTTP, for any schema.
 *
 * Four routes on a router the caller made: a template to download, a preview, a validation
 * pass and the import itself. Moved from Dynamic Entity's server with its wiring taken out.
 * Where that resolved a config per entity, this resolves an adapter and the context it wants,
 * by the name in the path. Dynamic Entity's router is this one with a config behind each name.
 *
 * **The caller passes the router in.** `express` is an optional peer, and this file is part of
 * `/node`'s one entry, so importing `express` here would make reading a CSV depend on it.
 * Not even its types are used: the router, request and response are described below by what
 * this file touches, so the published typings name nothing from `express` or `@types/express`,
 * and an Express 4 or 5 router fits them as it is.
 *
 * Every limit applies to every route, a refused request closes its body, and a failure
 * answers with a code and a message this library wrote and nothing from below it.
 */

import {
  DEFAULT_SLOTS,
  IMPORTER_VERSION,
  ImportFailure,
  PLAN_VERSIONS,
  type AdapterStamp,
  type DateOrder,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type SchemaAdapter,
} from 'sheet-to-schema';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { destroySource } from './bytes';
import { ImportError, toErrorBody } from './errors';
import { resolveLimits, type ImportLimits } from './limits';
import { receiveUpload, readPlanField } from './multipart';
import { previewSheet, runImport, type BatchInfo, type ImportRunResult, type SheetPreview } from './run-import';
import { writeTemplate, TEMPLATE_EXTENSION, TEMPLATE_MEDIA_TYPE, type TemplateFormat, type TemplateSheet } from './write-template';

/**
 * The request this router reads: a Node request with the path parameters and query string a
 * router has parsed onto it. An Express request is one. Callbacks that need more of it, such
 * as an authenticated user, annotate their parameter with their own request type, and the
 * router's options take that type.
 */
export interface ImportRequest extends IncomingMessage {
  params: Readonly<Record<string, unknown>>;
  query: Readonly<Record<string, unknown>>;
}

/** The response this router answers on: a Node response with Express's `status` and `json`. */
export interface ImportResponse extends ServerResponse {
  status(code: number): { json(body: unknown): unknown };
  json(body: unknown): unknown;
}

/** A route handler, as this router registers one. */
export type ImportHandler<TRequest extends ImportRequest = ImportRequest> = (request: TRequest, response: ImportResponse) => void;

/** The router the caller passes in: `express.Router()` is one. Only `get` and `post` are used. */
export interface ImportRouter<TRequest extends ImportRequest = ImportRequest> {
  get(path: string, handler: ImportHandler<TRequest>): unknown;
  post(path: string, handler: ImportHandler<TRequest>): unknown;
}

/** What one name in the path imports into. */
export interface ImportBinding<TMeta = unknown, TCtx = unknown> {
  adapter: SchemaAdapter<TMeta, TCtx>;
  /** Handed to the adapter's `coerce`, `finalize` and `validate` for every row of a run. */
  ctx: TCtx;
  /**
   * What kind of adapter this is, for the `adapter` stamp on every answer: `json-schema`,
   * `dynamic-entity`. A client warns when it differs from its own at the major version.
   * Default `custom`.
   */
  kind?: string;
  /**
   * The template for this binding, in place of the one made from the adapter's targets: for
   * a schema with more to say about a column than its header. `fields` is the client's
   * selection, as shape refs, or `undefined` for everything.
   */
  template?: (request: { lang: string; fields: string[] | undefined }) => TemplateSheet;
  /**
   * @internal Wire compatibility with Dynamic Entity.
   * The name the template downloads under, before `-template.csv`. Default the adapter's `id`.
   * Never taken from the request by this router; a binding that sets it answers for it.
   */
  templateName?: string;
  /**
   * @internal Wire compatibility with Dynamic Entity.
   * Fields added to a preview answer, for what this schema's clients expect beside the
   * standard ones. It may also restate `suggestion` or `slots`: a schema whose browser client
   * runs its own suggester has to be answered with that one, or the two sides would propose
   * different mappings for one file. It cannot restate the version stamps.
   */
  previewExtras?: (preview: SheetPreview) => Record<string, unknown>;
  /**
   * @internal Wire compatibility with Dynamic Entity.
   * A plan as it arrived, before it is read. For a schema whose older clients sent plans the
   * reader would refuse, such as one that never named its target. What it returns is read and
   * checked like any other plan.
   */
  plan?: (plan: unknown) => unknown;
}

/**
 * Where bindings come from.
 *
 * A map **or** a function, because a real app keeps its schemas in a database and should not
 * need a restart to add one, and because the context may depend on who is asking. Returning
 * `undefined` is how a loader says "no such name"; throwing is how it says something went wrong.
 */
export type BindingSource<TRequest extends ImportRequest = ImportRequest> =
  | Record<string, ImportBinding>
  | ((name: string, request: TRequest) => ImportBinding | undefined | Promise<ImportBinding | undefined>);

/** What the consumer does with a batch of records. Called once per batch, and awaited. */
export type OnImport<TRequest extends ImportRequest = ImportRequest> = (
  records: Record<string, unknown>[],
  context: BatchInfo & {
    /** The name in the path. */
    name: string;
    binding: ImportBinding;
    /** For a tenant id, a user, a transaction — whatever the consumer's writer needs. */
    request: TRequest;
  },
) => void | Promise<void>;

export interface ImportRouterOptions<TRequest extends ImportRequest = ImportRequest> {
  bindings: BindingSource<TRequest>;
  /**
   * Where records go.
   *
   * **It must be idempotent.** A stream that fails at row 30,000 has written 29,999 records,
   * and the client, or a proxy, or the user, will retry.
   */
  onImport: OnImport<TRequest>;
  limits?: Partial<ImportLimits>;
  /** The language adapters resolve labels in, fixed or read from the request. Default `en`. */
  lang?: string | ((request: TRequest) => string);
  /**
   * The order of a date written in digits, for every import and validation this router runs,
   * where a plan entry states none. Reported in each preview, so a client reads its sample the
   * same way. Without it, and without the entry's, a date that reads two ways fails its row.
   */
  dateOrder?: DateOrder;
  /**
   * Import and validate plans with `group` (contiguous groups), and say so on a preview
   * (`features: ["group"]`). Default `false`: a grouped plan is refused as in 1.0, and previews
   * carry no `features`. Off by default in 1.1 because Dynamic Entity 3.0 relies on the refusal.
   */
  grouping?: boolean;
  /**
   * @internal Wire compatibility with Dynamic Entity.
   * The name of the path parameter: routes are `/:<param>/template` and so on, and a writer
   * reads it from `request.params`. Default `name`.
   */
  param?: string;
  /**
   * @internal Wire compatibility with Dynamic Entity.
   * The version stamped on every answer as `engineVersion`. Default this package's.
   *
   * For a package that wraps this router and whose clients already compare `engineVersion`
   * with that package's own version: it goes on answering with its own. The `adapter` stamp
   * and `planVersions` are this router's either way.
   */
  engineVersion?: string;
  /**
   * Called for every failure this router answers with a 5xx, after the answer is chosen and
   * before it is sent, so the server can log what the client is not told (1.2). `code` is the
   * thrown error's own (`PEER_MISSING`, `IMPORT_FAILED`, …), or `INTERNAL` for anything else;
   * `peer` names the package for `PEER_MISSING`. Default: one `console.error` line with the
   * method, path, code and package, and the error. A callback that throws is ignored.
   */
  onError?: (error: unknown, report: ImportErrorReport<TRequest>) => void;
}

/** What `onError` is told about a failure the client is answered 5xx for. */
export interface ImportErrorReport<TRequest extends ImportRequest = ImportRequest> {
  request: TRequest;
  /** The status the client is answered with. */
  status: number;
  /** The error's own code, which the client may not see: `PEER_MISSING` is answered `INTERNAL`. */
  code: string;
  /** For `PEER_MISSING`, the package that is not installed. */
  peer?: string;
}

/** The code and package a failure carries, whatever the client is answered. */
function reportOf<TRequest extends ImportRequest>(error: unknown, request: TRequest, status: number): ImportErrorReport<TRequest> {
  const own = error instanceof ImportError || error instanceof ImportFailure ? error.code : 'INTERNAL';
  const details = error instanceof ImportError ? (error.details as { peer?: unknown } | undefined) : undefined;
  const peer = own === 'PEER_MISSING' && typeof details?.peer === 'string' ? details.peer : undefined;
  return { request, status, code: own, ...(peer ? { peer } : {}) };
}

/** The default `onError`: one line a server's log can be searched for, and the error itself. */
function logFailure(error: unknown, { request, status, code, peer }: ImportErrorReport): void {
  console.error(`sheet-to-schema/node: ${request.method ?? '?'} ${(request as { originalUrl?: string }).originalUrl ?? request.url ?? '?'} answered ${status}: ${code}${peer ? ` (${peer})` : ''}`, error);
}

/** A property of the map itself, never one it inherited: `constructor` is not a binding. */
function ownValue<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function readFormat(value: unknown): TemplateFormat {
  if (value === undefined || value === 'csv') return 'csv';
  if (value === 'xlsx') return 'xlsx';
  throw new ImportError('UNSUPPORTED_FORMAT', 'Supported template formats are csv and xlsx.');
}

/** `?fields=a,b` and `?fields=a&fields=b` are the same selection. */
function readFields(value: unknown): string[] | undefined {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const fields = raw.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean);
  return fields.length ? fields : undefined;
}

/**
 * The name a template is downloaded under. Built from the schema's own name, never from the
 * request, and reduced to characters that cannot break out of a `Content-Disposition` header.
 */
export function templateFilename(name: string, format: TemplateFormat): string {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '').slice(0, 64);
  return `${safe || 'import'}-template.${TEMPLATE_EXTENSION[format]}`;
}

/** The template an adapter's own targets make: every target, each array at the default slots. */
export function templateOf(adapter: SchemaAdapter, lang: string, fields: string[] | undefined): TemplateSheet {
  const arrays = adapter.targets({ slots: {}, lang }).arrays;
  const slots = Object.fromEntries(arrays.map(array => [array.ref, DEFAULT_SLOTS]));
  const chosen = fields && new Set(fields);
  const targets = adapter.targets({ slots, lang }).targets.filter(target => !chosen || chosen.has(target.shapeRef));
  return {
    sheetName: adapter.id,
    headers: targets.map(target => target.header),
    notes: targets.map(target => [target.required ? 'Required' : '', target.format ?? ''].filter(Boolean).join('. ')),
  };
}

function applyTimeouts(request: ImportRequest, response: ImportResponse, limits: ImportLimits): void {
  // The connection is closed rather than answered. A client that has stopped sending is not
  // waiting for a status code, and an attacker holding a socket open is the case being
  // answered — the reply they want least is the connection going away.
  const abandon = (message: string) => (): void => {
    request.destroy(new ImportError('TIMEOUT', message));
  };

  // `setTimeout` on a request sets it on the *socket*, which a keep-alive connection reuses
  // for whatever request comes next — so an import's thirty seconds would quietly become the
  // idle bound for every later request on that connection, including ones outside this router.
  // The previous value goes back when the response closes.
  const socket = request.socket;
  const previous = socket?.timeout;
  request.setTimeout(limits.idleTimeoutMs, abandon('The upload stalled.'));

  const total = setTimeout(abandon('The upload took too long.'), limits.totalTimeoutMs);
  // `unref` so a pending timer never holds a process open past its work.
  total.unref?.();
  response.on('close', () => {
    clearTimeout(total);
    if (socket && !socket.destroyed) socket.setTimeout(previous ?? 0);
  });
}

/**
 * What a server can do beyond the plan versions it reads, sent on a preview
 * (`ImportPreviewResponse.features`) when it is turned on. `"group"`: it imports a grouped plan,
 * listed only by a router created with `grouping: true`.
 */
export const SERVER_FEATURES: readonly string[] = Object.freeze(['group']);

/** Answer a failed request, in the one shape every failure has. */
export function sendFailure(response: ImportResponse, error: unknown): void {
  if (response.headersSent) {
    // A template that failed part-way through is already partly on the wire, and there is no
    // way to take it back. Ending the response abruptly is what tells the client the file is
    // not whole; a 200 with a truncated body would not.
    response.destroy();
    return;
  }

  // **The download's headers have to come off first.** The template route sets `Content-Type`
  // and `Content-Disposition` before it starts writing, and `res.json` only sets a content type
  // when one is *not* already there — so a failure after that point answered 413 with a JSON
  // body wearing `text/csv; charset=utf-8` and `attachment; filename="…-template.csv"`, which
  // a browser dutifully saves as the template.
  for (const header of ['Content-Type', 'Content-Disposition', 'Content-Length']) {
    response.removeHeader(header);
  }

  const { status, body } = toErrorBody(error);
  response.status(status).json(body);
}

/**
 * Add the import routes to `router`, and hand it back.
 *
 *     app.use('/import', createImportRouter(express.Router(), { bindings, onImport }));
 *
 * `GET /:name/template`, `POST /:name/preview`, `POST /:name/validate`, `POST /:name/import`,
 * with `name` whatever `options.param` calls it. It returns the router it was given, typed as
 * it was given, so `app.use` takes it as it would the router itself.
 */
export function createImportRouter<TRouter extends ImportRouter<TRequest>, TRequest extends ImportRequest = ImportRequest>(
  router: TRouter,
  options: ImportRouterOptions<TRequest>,
): TRouter {
  const limits = resolveLimits(options.limits);
  const param = options.param ?? 'name';
  const engineVersion = options.engineVersion ?? IMPORTER_VERSION;

  const languageOf = (request: TRequest): string =>
    typeof options.lang === 'function' ? options.lang(request) : options.lang ?? 'en';

  const bindingFor = async (request: TRequest): Promise<{ name: string; binding: ImportBinding }> => {
    const name = String(request.params[param] ?? '');
    const binding =
      typeof options.bindings === 'function' ? await options.bindings(name, request) : ownValue(options.bindings, name);
    // The wire code is Dynamic Entity's, kept because clients branch on it (`errors.ts`).
    if (!binding) throw new ImportError('UNKNOWN_ENTITY', 'No import is configured for that name.');
    return { name, binding };
  };

  const stampOf = (binding: ImportBinding): AdapterStamp => ({
    name: binding.kind ?? 'custom',
    version: binding.adapter.adapterVersion,
  });

  const respond = (result: ImportRunResult, written: boolean, binding: ImportBinding): ImportCommitResponse => ({
    written,
    imported: result.imported,
    skipped: result.skipped,
    failed: result.failed,
    rowsRead: result.rowsRead,
    rowsInImported: result.rowsInImported,
    errors: result.errors,
    errorCount: result.errorCount,
    truncated: result.truncated,
    warnings: result.warnings,
    warningCount: result.warningCount,
    planProblems: result.planProblems,
    engineVersion,
    adapter: stampOf(binding),
  });

  const route =
    (handler: (request: TRequest, response: ImportResponse) => Promise<void>): ImportHandler<TRequest> =>
    (request, response) => {
      applyTimeouts(request, response, limits);
      handler(request, response).catch(error => {
        const { status } = toErrorBody(error);
        if (status >= 500) {
          try {
            (options.onError ?? logFailure)(error, reportOf(error, request, status));
          } catch {
            // A logger that fails must not also cost the client its answer.
          }
        }
        sendFailure(response, error);
      });
    };

  router.get(
    `/:${param}/template`,
    route(async (request, response) => {
      const { binding } = await bindingFor(request);
      const format = readFormat(request.query['format']);
      const fields = readFields(request.query['fields']);
      const lang = languageOf(request);
      const sheet = binding.template ? binding.template({ lang, fields }) : templateOf(binding.adapter, lang, fields);

      response.setHeader('Content-Type', TEMPLATE_MEDIA_TYPE[format]);
      // Named from the schema, or by the binding, never from the path by this router.
      response.setHeader('Content-Disposition', `attachment; filename="${templateFilename(binding.templateName ?? binding.adapter.id, format)}"`);
      await writeTemplate({ sheet, format, out: response, limits });
    }),
  );

  router.post(
    `/:${param}/preview`,
    route(async (request, response) => {
      const { binding } = await bindingFor(request);
      const upload = await receiveUpload(request, limits);

      const preview = await previewSheet({
        stream: upload.stream,
        filename: upload.filename,
        adapter: binding.adapter,
        lang: languageOf(request),
        limits,
      });

      const body: ImportPreviewResponse = {
        headers: preview.headers,
        sample: preview.sample,
        suggestion: preview.suggestion,
        rowCount: preview.rowCount,
        slots: preview.slots,
        ...(preview.delimiter ? { delimiter: preview.delimiter } : {}),
        ...(options.dateOrder ? { dateOrder: options.dateOrder } : {}),
        ...binding.previewExtras?.(preview),
        // After the extras, so nothing a binding adds can restate what this server is.
        planVersions: [...PLAN_VERSIONS],
        ...(options.grouping ? { features: [...SERVER_FEATURES] } : {}),
        engineVersion,
        adapter: stampOf(binding),
      };
      response.json(body);
    }),
  );

  /**
   * The identical pipeline with no writer: every row read, every error found, nothing stored.
   *
   * This is what makes a non-transactional import liveable. A user can see every problem in
   * the file before anything at all is stored, which is the answer to "what if it fails
   * halfway" that does not require a transaction.
   */
  router.post(
    `/:${param}/validate`,
    route(async (request, response) => {
      response.json(await execute(request, false));
    }),
  );

  router.post(
    `/:${param}/import`,
    route(async (request, response) => {
      response.json(await execute(request, true));
    }),
  );

  async function execute(request: TRequest, write: boolean): Promise<ImportCommitResponse> {
    const { name, binding } = await bindingFor(request);
    const upload = await receiveUpload(request, limits);

    let plan: unknown;
    try {
      plan = readPlanField(upload.fields);
      if (binding.plan) plan = binding.plan(plan);
    } catch (error) {
      // The plan is wrong and the file is still arriving. Draining it would be reading a body
      // there is no longer any reason to read.
      destroySource(upload.stream);
      throw error;
    }

    const result = await runImport({
      stream: upload.stream,
      filename: upload.filename,
      plan,
      adapter: binding.adapter,
      ctx: binding.ctx,
      dateOrder: options.dateOrder,
      grouping: options.grouping,
      limits,
      ...(write ? { onBatch: (records, info) => options.onImport(records, { ...info, name, binding, request }) } : {}),
    });

    return respond(result, write, binding);
  }

  return router;
}
