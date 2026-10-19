// The importer's browser entry. No runtime dependencies, and nothing from Dynamic Entity
// (docs/import-phase1-spec.md, "Package boundaries").

// ─── Plan v2 ────────────────────────────────────────────────────────────────
export type {
  GroupSpec,
  ListOptions,
  MappingEntry,
  MappingPlan,
  MatchConfidence,
  NormalizedPlan,
  PlanProblem,
  PlanProblemReason,
} from './plan.types';
export { PLAN_PROBLEM_CODES } from './problem-codes';
export type { PlanProblemCode } from './problem-codes';
export { readPlan } from './read-plan';
export type { ReadPlanOptions, ReadPlanResult } from './read-plan';
export { planForServer, SERVER_FEATURES, v2OnlyFields } from './plan-for-server';
export type { PlanForServer, ServerCapabilities } from './plan-for-server';
export { UNSAFE_PATH_KEYS, isUnsafePath } from './safe-path';
export { CELL_PROBLEM_CODES, RECORD_PROBLEM_CODES } from './problem-codes';
export type { CellProblemCode, RecordProblemCode, RowProblemCode } from './problem-codes';

// ─── Schema adapters ────────────────────────────────────────────────────────
export type {
  CellOptions,
  CoerceOutcome,
  ImportTarget,
  RecordProblem,
  SchemaAdapter,
  TargetArray,
  TargetOptions,
  TargetSet,
  ValueKind,
} from './adapter.types';
export { MAX_SLOTS, planSlots, shapeOf, slotOf } from './plan-slots';
export { validatePlan } from './validate-plan';

// ─── Coercion ───────────────────────────────────────────────────────────────
export { DEFAULT_LIST_SEPARATOR, coerceValue } from './coerce';
export type { CoerceValueOptions } from './coerce';
export { cellText } from './cell-text';
export { DATE_ORDERS, inferDateOrder } from './date-order';
export type { DateOrder } from './date-order';

// ─── Applying a plan ────────────────────────────────────────────────────────
export { applyMapping, preparePlan, startMapping } from './apply-mapping';
export type { ApplyMappingOptions, MappingBatch, MappingSession, PreparedPlan } from './apply-mapping';
export { validateRecord } from './validate-record';
export type { ImportResult, ImportRowError } from './result.types';
export { IMPORT_FAILURE_CODES, ImportFailure } from './import-failure';
export { DEFAULT_GROUP_LIMITS } from './group-limits';
export type { GroupLimits } from './group-limits';

// ─── Suggesting a mapping ───────────────────────────────────────────────────
export { DEFAULT_SLOTS, slotsFor, suggestMapping } from './suggest';
export type { SuggestOptions } from './suggest';
export { matchSlot, normalizeHeader, slotPatterns } from './header-grammar';
export type { SlotNames } from './header-grammar';
export type { ImportFailureCode, ImportFailureDetails } from './import-failure';

// ─── Adapters ───────────────────────────────────────────────────────────────
export { jsonSchemaAdapter } from './json-schema-adapter';
export type { JsonSchemaAdapterOptions, JsonSchemaMeta, JsonSchemaNode } from './json-schema-adapter';
export { exampleJsonAdapter } from './example-json-adapter';
export type { ExampleJsonAdapterOptions, ExampleJsonMeta } from './example-json-adapter';

// ─── CSV ────────────────────────────────────────────────────────────────────
export { completeFirstLine, createCsvReader, decimalMarkFor, detectDelimiter, escapeFormula, padRow, parseCsv, toCsv } from './csv';
export type { CsvDelimiter, CsvReader, CsvReaderOptions, SheetData, SheetGrid } from './csv';

// ─── Reading a file ─────────────────────────────────────────────────────────
// A CSV or TSV file read whole, with nothing that can reach exceljs (1.2), and what it, the
// server's readers and /browser's refuse with: one class, which /node and /browser re-export.
export { readCsvFile } from './read-csv-file';
export type { CsvFile, CsvFileLimits, ReadCsvFileOptions, SheetFileInput } from './read-csv-file';
export { ImportError } from './import-error';
export type { ImportErrorBody, ImportErrorCode } from './import-error';
// @internal: what /node and /browser read with, here so there is one copy of each.
export { bytesOf, csvGrid } from './read-csv-file';
export { detectFormat, MAGIC_BYTES } from './sheet-format';
export type { SheetFormat } from './sheet-format';
export { guardGrid, guardHeaders, guardRow } from './sheet-guards';
export { DEFAULT_LIMITS, resolveLimits } from './limits';
export type { ImportLimits } from './limits';

// ─── The wire ───────────────────────────────────────────────────────────────
export type { AdapterStamp, ImportCommitResponse, ImportErrorResponse, ImportPreviewResponse } from './wire.types';

// ─── Versions ───────────────────────────────────────────────────────────────
export { IMPORTER_VERSION, PLAN_VERSIONS } from './version';
