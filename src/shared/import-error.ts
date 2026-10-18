/**
 * import-error.ts — one error type, a closed set of codes, and an envelope that says nothing else.
 *
 * Browser-safe and shared: the server's readers and `sheet-to-schema/browser`'s throw the same
 * codes and messages for the same file. Each of those entries bundles its own copy, so match
 * on `code`, not on `instanceof` across entries. Turning one into a response is `/node`'s
 * (`toErrorBody` in `node/errors.ts`).
 *
 * **Information disclosure is a threat, so the envelope is the guard.** A stack trace tells an
 * attacker the library versions in use and the filesystem layout of the host; a parser's own
 * message tells them which parser. So a response carries a machine-readable `code` and a
 * message this package wrote, and nothing that came from below it. Whatever the real cause
 * was stays on the server, reachable through `cause` for the consumer's logger.
 */

/**
 * Why a request failed, in a form a client can branch on.
 *
 * Closed on purpose: a client that has to match on message text is a client that breaks when
 * the text improves, and the wire shape is shared with every client of the router.
 */
export type ImportErrorCode =
  /** No file part in the multipart body. */
  | 'NO_FILE'
  /** More file parts than `limits.maxFiles`. */
  | 'TOO_MANY_FILES'
  /** The body exceeded `limits.maxBytes`, or a field exceeded its own bound. */
  | 'TOO_LARGE'
  /** The bytes are not a format this package reads. Decided by content, not by filename. */
  | 'UNSUPPORTED_FORMAT'
  /** The bytes claim a format and are not valid in it. */
  | 'MALFORMED_FILE'
  /** A zip that inflates out of proportion to its size, or has too many entries. */
  | 'ARCHIVE_REFUSED'
  /** Rows, columns or one cell past the configured bound. */
  | 'SHEET_TOO_LARGE'
  /**
   * No adapter is registered under the requested name. Dynamic Entity's name for it, kept
   * because it is on the wire: renaming a code breaks every client that branches on it.
   */
  | 'UNKNOWN_ENTITY'
  /** The `plan` field is missing, is not JSON, or does not describe this schema. */
  | 'INVALID_PLAN'
  /** The request took longer than `limits.totalTimeoutMs`, or stalled past the idle bound. */
  | 'TIMEOUT'
  /** The consumer's `onImport` threw. Nothing about *why* crosses the wire. */
  | 'IMPORT_FAILED'
  /** Anything else. Deliberately the least informative code there is. */
  | 'INTERNAL';

/** The HTTP status each code answers with. Kept here so a route never has to decide. */
const STATUS: Record<ImportErrorCode, number> = {
  NO_FILE: 400,
  TOO_MANY_FILES: 400,
  TOO_LARGE: 413,
  UNSUPPORTED_FORMAT: 415,
  MALFORMED_FILE: 400,
  ARCHIVE_REFUSED: 400,
  SHEET_TOO_LARGE: 413,
  UNKNOWN_ENTITY: 404,
  INVALID_PLAN: 400,
  TIMEOUT: 408,
  IMPORT_FAILED: 500,
  INTERNAL: 500,
};

/**
 * What a failing route sends.
 *
 * `details` is present only for `INVALID_PLAN`, and carries the plan's own problems. Those
 * describe the client's own plan against a schema the client already has, so they disclose
 * nothing the caller did not send.
 */
export interface ImportErrorBody {
  error: {
    code: ImportErrorCode;
    message: string;
    details?: unknown;
  };
}

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ImportErrorCode, message: string, options: { cause?: unknown; details?: unknown } = {}) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.details = options.details;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}
