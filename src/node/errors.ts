/**
 * errors.ts — the server's side of `ImportError`: turning anything thrown into a response.
 *
 * The type and its codes are in `shared/import-error.ts`, which the browser reader shares.
 */
import { ImportError, type ImportErrorBody } from '../shared/import-error';

export { ImportError } from '../shared/import-error';
export type { ImportErrorBody, ImportErrorCode } from '../shared/import-error';

/**
 * Turn anything thrown into a response body.
 *
 * An `ImportError` says what it says. **Everything else becomes `INTERNAL` with a fixed
 * message** — that is the whole point, and the reason this is a function rather than a
 * `catch` block per route. A parser that throws `ENOENT: open '/srv/app/tmp/…'` must not be
 * the thing that answers the request.
 */
export function toErrorBody(error: unknown): { status: number; body: ImportErrorBody } {
  if (error instanceof ImportError) {
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

  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'The import could not be completed.' } },
  };
}
