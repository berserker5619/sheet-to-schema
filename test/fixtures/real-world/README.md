# Real-world fixtures

Files for the cases a synthetic sheet tends to miss. `src/node/real-world-fixtures.spec.ts`
reads the first three workbooks through `sheet-to-schema/node`, and the browser parity specs
(`src/browser/*parity*.spec.ts`) read every file here through both readers.

- `case1_1904_dates.xlsx`: a Mac Excel workbook on the 1904 date system (`date1904="1"`).
  Dates before 1970 and modern dates must not drift by 1462 days.
- `case2_numeric_identifiers.xlsx`: numeric cells (`<c t="n">`) holding phone numbers, postal
  codes, a safe 16-digit ID and one past `Number.MAX_SAFE_INTEGER`, mapped to string fields.
  The unsafe one is reported as `CELL_FORMAT`.
- `case4_complex_sheet.xlsx`: a merged header range (`A1:B1`), a hidden column (`F`), formula
  cells (`Total`), duplicate header names (`Status`), a second sheet (`Instructions`) and
  trailing empty styled rows.

Copied byte for byte from Dynamic Entity (checked by sha256 when copied), and never
regenerated here: `.gitattributes` marks the CSVs binary so line endings and byte-order marks
survive a checkout.

- `case5_non_latin.xlsx`: Tamil and emoji written by openpyxl 3.1.5, which stores every
  non-ASCII character as a numeric character reference. "Rajesh Kumar 🎉" is the cell SheetJS
  truncated (R3-1). From `packages/core/test-fixtures/`.
- `case3_excel_utf8_bom.csv`: Excel's "CSV UTF-8", with a byte-order mark and CRLF.
- `case3_excel_semicolon.csv`: Excel in a decimal-comma locale: `;` between fields, `12,50`.
- `case3_google_sheets.csv`: a Google Sheets export with a multi-line quoted cell and escaped
  quotes.
- `case5_non_latin.csv`: Tamil and emoji as UTF-8 text.

The four CSVs are Round 2's originals, from `test-harness/rc-round3/files/`.

The first three workbooks are also in Dynamic Entity (`packages/core/test-fixtures`), whose own
specs read them through its adapter.

## Regeneration

```bash
npm run regenerate:fixtures
```

This needs `exceljs` (a devDependency). ExcelJS stamps a timestamp into the workbook, so the
bytes change on every run; the specs assert contents, never bytes.
