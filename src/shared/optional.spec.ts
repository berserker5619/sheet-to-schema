/**
 * loadPeer (`shared/optional.ts`, 1.1.1): which failures mean "that package is not installed".
 *
 * Every message here is verbatim from Dynamic Entity's Step 0 check (docs/3.1-spec.md): Angular
 * 21, Vite 8 and webpack 5, in Chromium 156, Firefox 157 and WebKit 27.2. A real browser runs
 * the same cases in `scripts/check-browsers.mjs`.
 */
import { ImportError } from './import-error';
import { loadPeer } from './optional';

const INSTALL =
  'sheet-to-schema/browser needs the "exceljs" package to read .xlsx files, and it is not installed. ' +
  'It is an optional peer dependency: run `npm install exceljs`.';

const failing = (error: unknown) => loadPeer('sheet-to-schema/browser', 'exceljs', 'read .xlsx files', () => Promise.reject(error)).catch((thrown: unknown) => thrown);

const typeError = (message: string): TypeError => new TypeError(message);

describe('loadPeer: a package that is not installed', () => {
  it.each([
    ['Node, require', Object.assign(new Error("Cannot find module 'exceljs'\nRequire stack:\n- /app/x.js"), { code: 'MODULE_NOT_FOUND' })],
    ['Node, import', Object.assign(new Error("Cannot find package 'exceljs' imported from /app/x.mjs"), { code: 'ERR_MODULE_NOT_FOUND' })],
    ["webpack's IgnorePlugin", Object.assign(new Error("Cannot find module 'exceljs'"), { code: 'MODULE_NOT_FOUND' })],
    ["Vite's optional-peer stub (Vite build and dev, Angular ng serve)", new Error('Could not resolve "exceljs" imported by "sheet-to-schema". Is it installed?')],
    ['Chromium, an external bare specifier', typeError("Failed to resolve module specifier 'exceljs'")],
    ['Chromium, the static-import wording', typeError('Failed to resolve module specifier "exceljs". Relative references must start with either "/", "./", or "../".')],
    ['Firefox, an external bare specifier', typeError('The specifier “exceljs” was a bare specifier, but was not remapped to anything. Relative module specifiers must start with “./”, “../” or “/”.')],
    ['WebKit, an external bare specifier', typeError("Module name, 'exceljs' does not resolve to a valid URL.")],
  ])('%s: PEER_MISSING, naming the package, with the original as cause', async (_, cause) => {
    const failure = await failing(cause);
    expect(failure).toBeInstanceOf(ImportError);
    expect(failure).toMatchObject({ name: 'ImportError', code: 'PEER_MISSING', status: 500, message: INSTALL, details: { peer: 'exceljs' } });
    expect((failure as Error).cause).toBe(cause);
  });
});

describe('loadPeer: everything else passes through unchanged', () => {
  it.each([
    // A lazy chunk that failed to download. Vite names its chunk after the package, so the URL
    // says "exceljs"; the package is installed, and the network failed.
    ['Chromium, a chunk that failed to download', typeError('Failed to fetch dynamically imported module: http://127.0.0.1:51870/assets/exceljs.min-C8vHhlMF.js')],
    ['Firefox, a chunk that failed to download', typeError('error loading dynamically imported module: http://127.0.0.1:51870/assets/exceljs.min-C8vHhlMF.js')],
    ['WebKit, a chunk that failed to download', typeError('Importing a module script failed.')],
    ["webpack's ChunkLoadError", Object.assign(new Error('Loading chunk 974 failed.\n(error: http://127.0.0.1:59551/974.e48a0ad64f401068eefc.js)'), { name: 'ChunkLoadError', type: 'error', request: 'http://127.0.0.1:59551/974.e48a0ad64f401068eefc.js' })],
    // webpack's alias: false: the package resolved to nothing, and ExcelJS is not what failed.
    ["webpack's alias false", typeError('o.Workbook is not a constructor')],
    // Installed, but something it needs is not: telling the user to install exceljs would be wrong.
    ['a broken install', Object.assign(new Error("Cannot find module 'archiver'\nRequire stack:\n- /app/node_modules/exceljs/lib/exceljs.nodejs.js"), { code: 'MODULE_NOT_FOUND' })],
    // Another package's name in the same messages.
    ['another bare specifier (Chromium)', typeError("Failed to resolve module specifier 'exceljs-extra'")],
    ['another bare specifier (Firefox)', typeError('The specifier “jszip” was a bare specifier, but was not remapped to anything.')],
    ['another bare specifier (WebKit)', typeError("Module name, 'exceljs/lib' does not resolve to a valid URL.")],
    ['another package, by Vite', new Error('Could not resolve "busboy" imported by "sheet-to-schema". Is it installed?')],
    // The package's name inside a message, but not as the module that failed to resolve.
    ['a message that only mentions it', new Error('exceljs: Failed to resolve module specifier \'exceljs\'')],
    ['a Node code, but another message', Object.assign(new Error('Cannot find module "exceljs"'), { code: 'MODULE_NOT_FOUND' })],
    ['not an Error at all', 'a string'],
    ['null', null],
  ])('%s', async (_, error) => {
    expect(await failing(error)).toBe(error);
  });

  it('matches the package name literally, not as a pattern', async () => {
    const error = typeError("Failed to resolve module specifier 'axb'");
    const thrown = await loadPeer('sheet-to-schema/node', 'a.b', 'do it', () => Promise.reject(error)).catch((e: unknown) => e);
    expect(thrown).toBe(error);
    const missing = typeError("Failed to resolve module specifier 'a.b'");
    expect(await loadPeer('sheet-to-schema/node', 'a.b', 'do it', () => Promise.reject(missing)).catch((e: unknown) => e)).toMatchObject({ code: 'PEER_MISSING', details: { peer: 'a.b' } });
  });

  it('hands back what the import gave', async () => {
    await expect(loadPeer('sheet-to-schema/browser', 'exceljs', 'read .xlsx files', async () => 42)).resolves.toBe(42);
  });
});
