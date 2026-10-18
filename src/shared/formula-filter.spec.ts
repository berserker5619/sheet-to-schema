import { FormulaFilter, filterFormulas } from './formula-filter';

const XML =
  '<sheetData><row r="2"><c r="A2" t="b"><f>TRUE()</f><v>1</v></c>' +
  '<c r="B2" t="e"><f t="shared" ref="B2:B3" si="0">1/0</f><v>#DIV/0!</v></c>' +
  '<c r="C2"><f t="shared" si="0"/><v>3</v></c><c r="D2" t="str"><f>"a"&amp;"&lt;b"</f><v>ab</v></c>' +
  '<c r="E2"><f\r\n>A1</f><v>é😀</v></c></row></sheetData><fill/><formula>1</formula><f/>';
const EXPECTED =
  '<sheetData><row r="2"><c r="A2" t="b"><v>1</v></c>' +
  '<c r="B2" t="e"><v>#DIV/0!</v></c>' +
  '<c r="C2"><v>3</v></c><c r="D2" t="str"><v>ab</v></c>' +
  '<c r="E2"><v>é😀</v></c></row></sheetData><fill/><formula>1</formula>';

const bytes = Buffer.from(XML, 'utf8');

describe('FormulaFilter', () => {
  it('takes out every f element, start tag, body and end tag, and nothing else', () => {
    expect(Buffer.from(filterFormulas(bytes)).toString('utf8')).toBe(EXPECTED);
  });

  it('gives the same output however the bytes are chunked: every split in two, and one byte at a time', () => {
    for (let split = 0; split <= bytes.length; split++) {
      const filter = new FormulaFilter();
      const out = Buffer.concat([filter.push(bytes.subarray(0, split)), filter.push(bytes.subarray(split)), filter.end()]);
      expect([split, out.toString('utf8')]).toEqual([split, EXPECTED]);
    }
    const filter = new FormulaFilter();
    const parts: Uint8Array[] = [];
    for (const byte of bytes) parts.push(filter.push(Uint8Array.of(byte)));
    parts.push(filter.end());
    expect(Buffer.concat(parts).toString('utf8')).toBe(EXPECTED);
  });

  it('drops what is still open when the input ends inside a formula', () => {
    const filter = new FormulaFilter();
    expect(Buffer.from(filter.push(Buffer.from('<c><f>SUM(A1:</'))).toString()).toBe('<c>');
    expect(filter.end()).toHaveLength(0);
  });

  it('keeps a trailing < or <f that turns out not to be a formula', () => {
    const filter = new FormulaFilter();
    const out = Buffer.concat([filter.push(Buffer.from('<v>1</v><')), filter.push(Buffer.from('fill/><')), filter.end()]);
    expect(out.toString()).toBe('<v>1</v><fill/><');
  });
});
