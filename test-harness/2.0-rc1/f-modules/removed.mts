// Each line must fail: the names are gone from /node in 2.0.
// @ts-expect-error
import { createImportRouter } from 'sheet-to-schema/node';
// @ts-expect-error
import { sendFailure } from 'sheet-to-schema/node';
// @ts-expect-error
import { safeFieldName } from 'sheet-to-schema/node';
// @ts-expect-error
import type { ImportBinding } from 'sheet-to-schema/node';
// @ts-expect-error
import { SERVER_FEATURES } from 'sheet-to-schema/node';
void [createImportRouter, sendFailure, safeFieldName, SERVER_FEATURES];
export type T = ImportBinding;
