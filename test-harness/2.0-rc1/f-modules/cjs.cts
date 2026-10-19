const s2s = require("sheet-to-schema/node") as typeof import("sheet-to-schema/node");
import type { ImportProgress } from "sheet-to-schema/node";
const p: ImportProgress = { bytesRead: 1, rowsRead: 1 };
void [s2s.runImport, p];
