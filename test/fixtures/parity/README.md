# Parity fixtures

Generated cases for the browser reader's parity with the server (docs/1.1-spec.md, feature A),
read by both readers in `src/browser/parity.spec.ts`, `parity.jsdom.spec.ts` and
`records-parity.spec.ts`:

- `tamil_text.xlsx`: Tamil script and emoji as plain UTF-8 (openpyxl's form is
  `real-world/case5_non_latin.xlsx`).
- `typed_cells.xlsx`: numbers, booleans, a date, a date-time, rich text, hyperlinks, formulas.
- `error_cells.xlsx`: error cells, typed and as a formula's cached result.
- `blank_rows.xlsx`: blank rows mid-sheet, and a styled row with no values.
- `formula_results.xlsx`: formula results of each stored type, plain and shared.
- `header_commas.tsv`: a TSV whose header has more commas than tabs.
- `ragged_rows.csv`: rows shorter and longer than the header.
- `blank_lines.csv`: blank lines mid-file and at the end, CRLF.

## Regeneration

```bash
npm run regenerate:parity-fixtures
```

ExcelJS stamps a timestamp into each workbook, so their bytes change on every run; the specs
compare the two readers, never bytes. The text files are written byte for byte.
