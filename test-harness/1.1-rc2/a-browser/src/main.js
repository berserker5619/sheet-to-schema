// The browser half of round (a): read a fixture the way a page reads a user's file.
import { readSheetFile, readXlsx } from 'sheet-to-schema/browser';

const serial = v => (v instanceof Date ? { $date: v.toISOString() } : Array.isArray(v) ? v.map(serial) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serial(x)])) : v);

async function fileOf(name) {
  const blob = await (await fetch(`/fixtures/${name}`)).blob();
  return new File([blob], name);
}
const attempt = async run => {
  try {
    return { ok: true, value: serial(await run()) };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
};

window.readFixture = async name => {
  const file = await fileOf(name);
  return attempt(() => readSheetFile(file, { filename: file.name }));
};
window.readXlsxFixture = async name => attempt(async () => readXlsx(await fileOf(name)));
window.capabilities = () => {
  let deflateRaw = false;
  try {
    new DecompressionStream('deflate-raw');
    deflateRaw = true;
  } catch { /* unsupported */ }
  return { decompressionStream: typeof DecompressionStream, deflateRaw, userAgent: navigator.userAgent };
};
document.getElementById('status').textContent = 'ready';
