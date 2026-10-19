/**
 * import-error.ts — one error type, a closed set of codes, and an envelope that says nothing else.
 *
 * Browser-safe and shared: the server's readers, `sheet-to-schema/browser`'s and the main
 * entry's `readCsvFile` throw the same codes and messages for the same file. In the main entry
 * since 1.2, which `/node` and `/browser` import by name, so all three export one class. Match
 * on `code` all the same: a CommonJS and an ESM copy of the package are two classes. Turning
 * one into a response is `/node`'s (`toErrorBody` in `node/errors.ts`).
 *
 * **Information disclosure is a threat, so the envelope is the guard.** A stack trace tells an
 * attacker the library versions in use and the filesystem layout of the host; a parser's own
 * message tells them which parser. So a response carries a machine-readable `code` and a
 * message this package wrote, and nothing that came from below it. Whatever the real cause
 * was stays on the server, reachable through `cause` for the consumer's logger.
 */

import type { ImportFailureCode } from './import-failure';

/**
 * Why a request failed, in a form a client can branch on.
 *
 * Closed on purpose: a client that has to match on message text is a client that breaks when
 * the text improves.
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
  /** The `plan` field is missing, is not JSON, or does not describe this schema. */
  | 'INVALID_PLAN'
  /**
   * An upload stalled for `limits.idleTimeoutMs`, or its body ended before the file did
   * (`receiveUpload`).
   */
  | 'TIMEOUT'
  /** The consumer's `onBatch` threw. Nothing about *why* crosses the wire. */
  | 'IMPORT_FAILED'
  /**
   * `runImport`'s `signal` aborted (2.0). `details` holds `rowsRead`, `imported` and `failed` as
   * they stood when it stopped, and `cause` the signal's `reason`, so a timeout
   * (`AbortSignal.timeout`) can be told from a cancel.
   */
  | 'ABORTED'
  /**
   * The browser reader runs where a workbook cannot be read: no `DecompressionStream` with the
   * `deflate-raw` format. Raised by `sheet-to-schema/browser` only, never by the server.
   */
  | 'UNSUPPORTED_RUNTIME'
  /**
   * An optional peer the call needs is not installed (`exceljs` for a workbook, `busboy` for an
   * upload). `details.peer` names it. The file is fine; the app is missing a package.
   * `toErrorBody` answers it as `INTERNAL`, so a client is never told what the server has installed.
   */
  | 'PEER_MISSING'
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
  INVALID_PLAN: 400,
  TIMEOUT: 408,
  IMPORT_FAILED: 500,
  // "Client closed request": the caller stopped the run, so the server did not fail.
  ABORTED: 499,
  // Not an HTTP answer: only the browser reader raises it. 501 if one ever has to be chosen.
  UNSUPPORTED_RUNTIME: 501,
  PEER_MISSING: 500,
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
    /** An `ImportErrorCode`, or for a grouped import that stopped, an `ImportFailureCode`. */
    code: ImportErrorCode | ImportFailureCode;
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
