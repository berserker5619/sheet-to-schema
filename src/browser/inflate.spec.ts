import { deflateRawSync } from 'node:zlib';
import { inflate } from './inflate';

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

  it('says so where there is no DecompressionStream', async () => {
    const globals = globalThis as { DecompressionStream?: unknown };
    const saved = globals.DecompressionStream;
    delete globals.DecompressionStream;
    try {
      await expect(inflate(deflateRawSync('a'), 10)).rejects.toThrow('it has no DecompressionStream');
    } finally {
      globals.DecompressionStream = saved;
    }
  });
});
