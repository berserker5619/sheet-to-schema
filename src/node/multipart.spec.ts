/**
 * receiveUpload and readPlanField, over a real socket.
 *
 * Until 2.0 these were tested through the router. The server here is the smallest route an app
 * writes from the functions (MIGRATING-2.0's example, on plain node:http): an upload, its plan,
 * `previewSheet` or `runImport`, and `toErrorBody` for anything thrown.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import request from 'supertest';
import * as node from './index';
import { toErrorBody } from './errors';
import { resolveLimits, type ImportLimits } from './limits';
import { readPlanField, receiveUpload, safeFieldName } from './multipart';
import { previewSheet, runImport } from './run-import';
import { CSV_TEXT, EMPLOYEES, HEADERS, PLAN } from './sheet.fixtures';

/** A plan for the employee schema that names a field it does not have. */
const BROKEN_PLAN = { entity: 'employee', entries: [{ ref: 'personal.nonsense', column: 0 }] };

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

interface Options {
  limits?: Partial<ImportLimits>;
  written?: Record<string, unknown>[];
  onBatch?: (records: Record<string, unknown>[]) => Promise<void> | void;
}

/** `POST /preview` and `POST /import`, written from the functions. */
function server({ limits: overrides, written = [], onBatch }: Options = {}): Server {
  const limits = resolveLimits(overrides);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const upload = await receiveUpload(req, limits);
      if (req.url === '/preview') {
        json(res, 200, await previewSheet({ stream: upload.stream, filename: upload.filename, adapter: EMPLOYEES, limits }));
        return;
      }
      let plan: unknown;
      try {
        plan = readPlanField(upload.fields);
      } catch (error) {
        upload.stream.destroy();
        throw error;
      }
      const result = await runImport({
        stream: upload.stream,
        filename: upload.filename,
        plan,
        adapter: EMPLOYEES,
        ctx: undefined,
        limits,
        onBatch: onBatch ?? (records => void written.push(...records)),
      });
      json(res, 200, result);
    })().catch(error => {
      const { status, body } = toErrorBody(error);
      if (!res.headersSent) json(res, status, body);
    });
  });
}

describe('receiveUpload', () => {
  it('hands over the file while it is still arriving, with the fields before it', async () => {
    const written: Record<string, unknown>[] = [];
    const response = await request(server({ written }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(written.length);
    expect(written.length).toBeGreaterThan(0);
  });

  it('previews an upload', async () => {
    const response = await request(server()).post('/preview').attach('file', Buffer.from(CSV_TEXT), 'people.csv');
    expect(response.status).toBe(200);
    expect(response.body.headers).toEqual(HEADERS);
  });

  it('400s a request with no file', async () => {
    const response = await request(server()).post('/preview').field('plan', '{}');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('NO_FILE');
  });

  it('400s a body that is not multipart at all', async () => {
    const response = await request(server()).post('/preview').set('Content-Type', 'application/json').send('{}');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MALFORMED_FILE');
  });

  it('413s an upload past maxBytes without reading the whole body', async () => {
    const big = Buffer.concat([
      Buffer.from(`${HEADERS.join(',')}\r\n`),
      Buffer.from('Alice,34,2024-03-07,true,Active\r\n'.repeat(5000)),
    ]);
    const response = await request(server({ limits: { maxBytes: 1024 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', big, 'people.csv');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('TOO_LARGE');
  });

  it('413s an over-long plan field rather than failing to parse a truncated one', async () => {
    const response = await request(server({ limits: { maxFieldBytes: 32 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('TOO_LARGE');
  });

  it('refuses a second file part', async () => {
    const response = await request(server({ limits: { maxFiles: 1 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'a.csv')
      .attach('other', Buffer.from(CSV_TEXT), 'b.csv');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TOO_MANY_FILES');
  });

  it('refuses a second file part even when the parser was allowed one', async () => {
    // `maxFiles` decides when busboy gives up; this reader takes the first file and refuses a
    // second either way. Two files is a request whose author and whose reader disagree about
    // which one was imported.
    const response = await request(server({ limits: { maxFiles: 4 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'a.csv')
      .attach('other', Buffer.from(CSV_TEXT), 'b.csv');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TOO_MANY_FILES');
  });

  it('refuses a zip bomb with a limit-specific code', async () => {
    const { zipBomb } = await import('./workbook.fixtures');
    const response = await request(server({ limits: { maxUncompressedBytes: 1024 * 1024 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', await zipBomb(64 * 1024 * 1024), 'people.xlsx');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ARCHIVE_REFUSED');
  });

  it('500s when the consumer writer throws, and says nothing about why', async () => {
    const response = await request(
      server({
        onBatch: () => {
          throw new Error('ECONNREFUSED 10.0.0.4:5432');
        },
      }),
    )
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('IMPORT_FAILED');
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
    expect(response.body.error.message).toMatch(/not transactional/);
  });
});

describe('readPlanField', () => {
  it('400s a plan that is not JSON', async () => {
    const response = await request(server())
      .post('/import')
      .field('plan', 'not json')
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PLAN');
  });

  it('says so when the plan field is missing, naming the ordering it needs', async () => {
    const response = await request(server()).post('/import').attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PLAN');
    expect(response.body.error.message).toMatch(/before the file/);
  });

  it('a plan naming __proto__ cannot pollute anything', async () => {
    // The plan is attacker-supplied JSON, so `isUnsafePath` needs a test at this boundary.
    const hostile = {
      entity: 'employee',
      entries: [
        { ref: '__proto__.polluted', column: 0 },
        { ref: 'constructor.prototype.polluted', column: 1 },
        { ref: 'personal.firstName', column: 0 },
      ],
    };

    const written: Record<string, unknown>[] = [];
    const response = await request(server({ written }))
      .post('/import')
      .field('plan', JSON.stringify(hostile))
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
    expect(response.body.planProblems.some((p: { level: string }) => p.level === 'error')).toBe(true);
    expect(
      response.body.planProblems.filter((p: { code?: string }) => p.code === 'PLAN_UNSAFE_PATH').map((p: { path: string }) => p.path),
    ).toEqual(['entries[0].ref', 'entries[1].ref']);
    expect(written).toEqual([]);
  });
});

describe('multipart abuse', () => {
  it('refuses a body of a thousand tiny fields', async () => {
    let call = request(server({ limits: { maxFields: 4 } })).post('/import');
    for (let i = 0; i < 20; i++) call = call.field(`f${i}`, 'x');
    const response = await call.attach('file', Buffer.from(CSV_TEXT), 'a.csv');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('TOO_LARGE');
  });

  it('refuses a repeated part rather than quietly taking the last one', async () => {
    const response = await request(server())
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .field('plan', JSON.stringify(BROKEN_PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'people.csv');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MALFORMED_FILE');
    expect(response.body.error.message).toContain('plan');
  });

  it('sanitises the field name it puts in the refusal, because a message is a log line', () => {
    expect(safeFieldName('a b!@#c')).toBe('abc');
    expect(safeFieldName('ev\\nil')).toBe('evnil');
    expect(safeFieldName('!!!')).toBe('unnamed');
    expect(safeFieldName('x'.repeat(200))).toHaveLength(40);
  });

  it('names an over-long field rather than failing to parse a truncated one', async () => {
    const response = await request(server({ limits: { maxFieldBytes: 8 } }))
      .post('/import')
      .field('notes', 'a value that is comfortably too long')
      .attach('file', Buffer.from(CSV_TEXT), 'a.csv');

    expect(response.status).toBe(413);
    expect(response.body.error.message).toContain('notes');
  });

  it('refuses a file part whose name is past maxFieldNameBytes', async () => {
    const response = await request(server({ limits: { maxFieldNameBytes: 8 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('a-file-part-name-far-too-long', Buffer.from(CSV_TEXT), 'a.csv');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('TOO_LARGE');
  });

  it('refuses a field name past maxFieldNameBytes, naming no more of it than safeFieldName keeps', async () => {
    const name = `n${'x'.repeat(299)}`;
    const response = await request(server({ limits: { maxFieldNameBytes: 8 } }))
      .post('/import')
      .field(name, 'x')
      .attach('file', Buffer.from(CSV_TEXT), 'a.csv');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('TOO_LARGE');
    expect(response.body.error.message).toBe(`The "${safeFieldName(name)}" field is too long.`);
    expect(response.body.error.message).not.toContain(name);
  });

  it('takes names of exactly maxFieldNameBytes: "plan" and "file" are 4 bytes each', async () => {
    const response = await request(server({ limits: { maxFieldNameBytes: 4 } }))
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(CSV_TEXT), 'a.csv');
    expect(response.status).toBe(200);
  });

  it('no longer exports safeFieldName from /node (2.0)', () => {
    expect('safeFieldName' in node).toBe(false);
  });
});

describe('the guards that need a socket rather than a client', () => {
  /** Open a raw connection, send whatever is given, and report how it ended. */
  function raw(listener: Server, head: string, body: string, keepOpen: boolean, waitMs = 3000): Promise<{ closed: boolean; response: string }> {
    return new Promise((resolve, reject) => {
      listener.listen(0, () => {
        const port = (listener.address() as { port: number }).port;
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(head.replace('{host}', `127.0.0.1:${port}`));
          socket.write(body);
          if (!keepOpen) socket.end();
        });

        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => (response += chunk));
        let done = false;
        const finish = (closed: boolean): void => {
          if (done) return;
          done = true;
          socket.destroy();
          listener.close(() => resolve({ closed, response }));
          listener.closeAllConnections();
        };
        socket.on('close', () => finish(true));
        socket.on('error', () => finish(true));
        setTimeout(() => finish(false), waitMs).unref();
        listener.on('error', reject);
      });
    });
  }

  const BOUNDARY = 'xyzboundary';
  const headers = (length: number | null, path = '/preview'): string =>
    [
      `POST ${path} HTTP/1.1`,
      'Host: {host}',
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
      length === null ? 'Transfer-Encoding: chunked' : `Content-Length: ${length}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
  const partial = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nname\r\n`;

  it('drops a connection that goes quiet mid-body after idleTimeoutMs (2.0: receiveUpload enforces it)', async () => {
    // Slowloris: a client that promises a body and then sends a byte a minute holds a socket
    // for as long as it likes. The reply it wants least is the connection going away.
    const start = Date.now();
    const { closed } = await raw(server({ limits: { idleTimeoutMs: 300 } }), headers(100_000), partial, true);

    expect(closed).toBe(true);
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it('drops a connection that goes quiet before the file part has started', async () => {
    const fieldOnly = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n{}\r\n`;
    const start = Date.now();
    const { closed } = await raw(server({ limits: { idleTimeoutMs: 300 } }), headers(100_000, '/import'), fieldOnly, true);

    expect(closed).toBe(true);
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it('rejects with TIMEOUT, "The upload stalled.", when it stalls before the file', async () => {
    const seen: unknown[] = [];
    const listener = createServer((req, res) => {
      receiveUpload(req, resolveLimits({ idleTimeoutMs: 200 })).catch(error => {
        seen.push(error);
        res.end();
      });
    });
    const fieldOnly = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="plan"\r\n\r\n{}\r\n`;
    await raw(listener, headers(100_000), fieldOnly, true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'ImportError', code: 'TIMEOUT', message: 'The upload stalled.' });
  });

  it('keeps a connection that is sending, however long it takes in all', async () => {
    // One byte every 100 ms for a second, against an idle bound of 400 ms: never idle that long.
    const listener = server({ limits: { idleTimeoutMs: 400 } });
    const rows = 'name\r\n' + 'x\r\n'.repeat(10);
    const body = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\n${rows}\r\n--${BOUNDARY}--\r\n`;
    const result = await new Promise<string>((resolve, reject) => {
      listener.listen(0, () => {
        const port = (listener.address() as { port: number }).port;
        const socket = connect(port, '127.0.0.1');
        let response = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => (response += chunk));
        socket.on('close', () => listener.close(() => resolve(response)));
        socket.on('error', reject);
        socket.write(headers(Buffer.byteLength(body)).replace('{host}', `127.0.0.1:${port}`));
        let sent = 0;
        const drip = setInterval(() => {
          const step = Math.ceil(body.length / 10);
          socket.write(body.slice(sent, sent + step));
          sent += step;
          if (sent >= body.length) clearInterval(drip);
        }, 100);
      });
    });
    expect(result).toMatch(/HTTP\/1\.1 200/);
    expect(result).toContain('"rowCount":10');
  });

  it('does not count time paused behind a slow reader as idle', async () => {
    // A writer slower than the idle bound: backpressure pauses the request, and the client is
    // then waiting on the server. The import must finish.
    let batches = 0;
    const rows = 20_000;
    const csv = `${HEADERS.join(',')}\r\n` + 'Alice,34,2024-03-07,true,Active\r\n'.repeat(rows);
    const response = await request(
      server({
        limits: { idleTimeoutMs: 200, batchSize: 1000, maxBytes: 50 * 1024 * 1024 },
        onBatch: async () => {
          if (batches++ < 2) await new Promise(resolve => setTimeout(resolve, 600));
        },
      }),
    )
      .post('/import')
      .field('plan', JSON.stringify(PLAN))
      .attach('file', Buffer.from(csv), 'people.csv');

    expect(response.status).toBe(200);
    expect(response.body.rowsRead).toBe(rows);
  });

  it('400s a multipart body whose parts are malformed', async () => {
    const body = `--${BOUNDARY}\r\nnot-a-header-at-all\r\n\r\ndata\r\n--${BOUNDARY}--\r\n`;
    const { response } = await raw(server(), headers(body.length), body, false);
    expect(response).toMatch(/HTTP\/1\.1 400/);
  });

  it('leaves no timer behind on a body that finished', async () => {
    const response = await request(server({ limits: { idleTimeoutMs: 100 } })).post('/preview').attach('file', Buffer.from(CSV_TEXT), 'a.csv');
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 250));
  });
});
