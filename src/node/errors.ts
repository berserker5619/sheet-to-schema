/**
 * errors.ts — the server's side of `ImportError`: turning anything thrown into a response.
 *
 * The type and its codes are the main entry's (`import-error.ts`), which the browser readers share.
 */
import { ImportFailure, type ImportFailureCode } from 'sheet-to-schema';
import { ImportError, type ImportErrorBody } from '../shared/import-error';

export { ImportError } from '../shared/import-error';
export type { ImportErrorBody, ImportErrorCode } from '../shared/import-error';

/**
 * What a whole-import failure answers with (spec §9): a group that comes back is the file's
 * shape, 422; a group or a key set too large to hold is a size, 413.
 */
const FAILURE_STATUS: Record<ImportFailureCode, number> = {
  GROUP_NOT_CONTIGUOUS: 422,
  GROUP_TOO_LARGE: 413,
  TOO_MANY_GROUPS: 413,
};

/**
 * Turn anything thrown into a response body.
 *
 * An `ImportError` says what it says. **Everything else becomes `INTERNAL` with a fixed
 * message** — that is the whole point, and the reason this is a function rather than a
 * `catch` block per route. A parser that throws `ENOENT: open '/srv/app/tmp/…'` must not be
 * the thing that answers the request.
 */
export function toErrorBody(error: unknown): { status: number; body: ImportErrorBody } {
  // A package the server lacks is the server's to fix, and which packages it has installed is
  // not the client's to know: as in 1.1.0, when this was a plain `Error`, it answers `INTERNAL`.
  if (error instanceof ImportError && error.code !== 'PEER_MISSING') {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  if (error instanceof ImportFailure) {
    // The engine's own failure, from the main entry by name, so the same class `applyMapping`
    // throws. Its message and details (the key and the rows) are this package's words about the
    // caller's own file.
    return {
      status: FAILURE_STATUS[error.code] ?? 500,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }

  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'The import could not be completed.' } },
  };
}
