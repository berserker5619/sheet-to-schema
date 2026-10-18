import { deflateRawSync } from 'node:zlib';
import { inflate, UNSUPPORTED_RUNTIME_MESSAGE } from './inflate';

describe('inflate', () => {
  it('inflates raw deflate, chunk by chunk', async () => {
    const text = 'x'.repeat(200_000) + 'end';
    expect(Buffer.from(await inflate(deflateRawSync(text), 1_000_000)).toString()).toBe(text);
  });

  it('refuses past the bound as it inflates, with the server\'s message', async () => {
    const failure = await inflate(deflateRawSync(Buffer.alloc(100_000)), 1_000).catch(error => error);
    expect(failure).toMatchObject({ code: 'ARCHIVE_REFUSED', message: 'The workbook inflates to more than the 1000 byte limit.' });
  });

  it('calls data that is not deflate unreadable', async () => {
    const failure = await inflate(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01]), 1_000).catch(error => error);
    expect(failure).toMatchObject({ code: 'MALFORMED_FILE', message: 'This is not a readable workbook.' });
  });

  it('refuses with UNSUPPORTED_RUNTIME where there is no DecompressionStream at all', async () => {
    const globals = globalThis as { DecompressionStream?: unknown };
    const saved = globals.DecompressionStream;
    delete globals.DecompressionStream;
    try {
      await expect(inflate(deflateRawSync('a'), 10)).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME', message: UNSUPPORTED_RUNTIME_MESSAGE });
    } finally {
      globals.DecompressionStream = saved;
    }
  });
});
