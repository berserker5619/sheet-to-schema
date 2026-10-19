#!/usr/bin/env node
/**
 * The files 2.0 refuses as binary, and the one it must not (docs/2.0-spec.md, §4.2). Generated so
 * every byte is explained; `node test/fixtures/binary/generate-binary-fixtures.mjs` rewrites them.
 *
 * - image.png: a real 4×4 PNG (signature, IHDR, IDAT, IEND, valid CRCs). Its chunk lengths are
 *   big-endian, so NULs start at byte 8.
 * - document.pdf: a real one-page PDF that draws a 4×4 black image. The image's samples are raw
 *   bytes, as a scanner's PDF carries them, and black is 0x00.
 * - random.bin: 64 KB of deterministic noise (a linear congruential sequence, not starting "PK").
 * - nul-after-8k.csv: a valid UTF-8 CSV whose first NUL is past byte 8192. Read as CSV, as in 1.x.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const dir = new URL('./', import.meta.url);
const write = (name, bytes) => writeFileSync(new URL(name, dir), bytes);

// ── PNG ────────────────────────────────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = bytes => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(4, 0); // width
ihdr.writeUInt32BE(4, 4); // height
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
const scanlines = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(12).fill(0x80)])));
write(
  'image.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);

// ── PDF ────────────────────────────────────────────────────────────────────
const pixels = Buffer.alloc(4 * 4 * 3, 0x00); // black, as raw samples
const content = Buffer.from('q 72 0 0 72 72 648 cm /Im1 Do Q\n', 'latin1');
const objects = [
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
  Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>', 'latin1'),
  Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`, 'latin1'),
    pixels,
    Buffer.from('\nendstream', 'latin1'),
  ]),
  Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('endstream', 'latin1')]),
];
const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
const offsets = [];
let at = parts[0].length;
objects.forEach((body, i) => {
  offsets.push(at);
  const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
  parts.push(obj);
  at += obj.length;
});
const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
write('document.pdf', Buffer.concat(parts));

// ── Noise ──────────────────────────────────────────────────────────────────
const noise = Buffer.alloc(64 * 1024);
let seed = 20261019;
for (let i = 0; i < noise.length; i++) noise[i] = (seed = (seed * 1103515245 + 12345) % 2 ** 31) >>> 16 & 0xff;
noise[0] = 0x01;
write('random.bin', noise);

// ── A CSV with a NUL past the first 8 KB ───────────────────────────────────
let csv = 'Name,Note\r\n';
for (let i = 0; Buffer.byteLength(csv) <= 8192 + 64; i++) csv += `Row ${i},plain text\r\n`;
csv += 'Late,before\u0000after\r\n';
write('nul-after-8k.csv', Buffer.from(csv, 'utf8'));

console.log('binary fixtures written');
