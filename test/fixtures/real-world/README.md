# Real-world fixtures

Workbooks for the cases a synthetic sheet tends to miss. `src/node/real-world-fixtures.spec.ts`
reads all three through `sheet-to-schema/node`.

- `case1_1904_dates.xlsx`: a Mac Excel workbook on the 1904 date system (`date1904="1"`).
  Dates before 1970 and modern dates must not drift by 1462 days.
- `case2_numeric_identifiers.xlsx`: numeric cells (`<c t="n">`) holding phone numbers, postal
  codes, a safe 16-digit ID and one past `Number.MAX_SAFE_INTEGER`, mapped to string fields.
  The unsafe one is reported as `CELL_FORMAT`.
- `case4_complex_sheet.xlsx`: a merged header range (`A1:B1`), a hidden column (`F`), formula
  cells (`Total`), duplicate header names (`Status`), a second sheet (`Instructions`) and
  trailing empty styled rows.

The same three files are also in Dynamic Entity (`packages/core/test-fixtures`), whose own
specs read them through its adapter.

## Regeneration

```bash
npm run regenerate:fixtures
```

This needs `exceljs` (a devDependency). ExcelJS stamps a timestamp into the workbook, so the
bytes change on every run; the specs assert contents, never bytes.
