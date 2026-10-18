/**
 * optional.ts — loading a package this one only needs for some of what an entry does.
 *
 * `exceljs` reads and writes workbooks and `busboy` reads a multipart upload. Neither is
 * needed to read a CSV, so both are optional peer dependencies and are loaded when first used,
 * by `/node` and, for `exceljs`, by `/browser`. When one is missing, the failure has to say so:
 * Node's own "Cannot find module" names a file deep inside this package and not what to do.
 */
import { ImportError } from './import-error';

/** Node's two spellings of "that package is not installed", for `require` and for `import`. */
const MISSING = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

const quoted = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a bundled app's `import(name)` fails with when the package was never installed, verbatim
 * from the Step 0 check in Dynamic Entity's docs/3.1-spec.md. Each names the package as the
 * module asked for, in quotes, at the start of the message:
 *
 * - Vite's stub for an unresolved optional peer (Vite's build and dev server, Angular's
 *   `ng serve`): `Error: Could not resolve "exceljs" imported by "sheet-to-schema". Is it installed?`
 * - an app that marked the package external, so the browser resolves the bare specifier:
 *   Chromium `TypeError: Failed to resolve module specifier 'exceljs'`, Firefox
 *   `TypeError: The specifier “exceljs” was a bare specifier, but was not remapped to anything. …`,
 *   WebKit `TypeError: Module name, 'exceljs' does not resolve to a valid URL.`
 *
 * A lazy chunk that failed to download is not one of these, even when its file is named
 * `exceljs.min-….js`: Chromium and Firefox put the chunk's URL after "dynamically imported
 * module:", WebKit says only "Importing a module script failed.", and webpack throws a
 * `ChunkLoadError`. Those pass through: the package is installed, and the network failed.
 */
function bundlerMissing(name: string): RegExp[] {
  const n = quoted(name);
  return [
    new RegExp(`^Could not resolve "${n}" imported by "`),
    new RegExp(`^Failed to resolve module specifier ['"]${n}['"]`),
    new RegExp(`^The specifier [“"]${n}[”"] was a bare specifier`),
    new RegExp(`^Module name, ['"]${n}['"] does not resolve to a valid URL`),
  ];
}

/** Whether `error` says the package `name` itself is absent, not something inside it. */
function isMissing(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = String(message);
  if (MISSING.has(String(code))) return text.includes(`'${name}'`);
  return bundlerMissing(name).some(pattern => pattern.test(text));
}

/**
 * Load an optional peer dependency for `entry`, or fail with what to install and why.
 *
 * `load` is the import itself, written at the call site so a bundler can see it. A missing
 * package is `ImportError` `PEER_MISSING`, with `details.peer` and the original as `cause`.
 * Any other failure, such as a broken install of the package or a chunk that failed to
 * download, is rethrown as it is.
 */
export async function loadPeer<T>(entry: string, name: string, neededTo: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isMissing(error, name)) throw error;
    throw new ImportError(
      'PEER_MISSING',
      `${entry} needs the "${name}" package to ${neededTo}, and it is not installed. ` +
        `It is an optional peer dependency: run \`npm install ${name}\`.`,
      { cause: error, details: { peer: name } },
    );
  }
}
