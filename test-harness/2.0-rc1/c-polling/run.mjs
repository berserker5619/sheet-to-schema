// The README's polling recipe, end to end, against sheet-to-schema@next.
// usage: node run.mjs            the round (upload, preview, validate, import, cancel, crash)
//        node run.mjs crash-child <dir> <port>   used by the crash step: a server that dies mid-job
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 8).join('\n     ')}`);
  }
};

const ROWS = 60_000;
const csv = () => {
  let text = 'Order,Total\r\n';
  for (let i = 0; i < ROWS; i++) text += `O-${String(i).padStart(6, '0')},${(i % 997) + 0.5}\r\n`;
  return text;
};
const PLAN = { planVersion: 2, target: 'order', entries: [{ ref: 'orderId', column: 0 }, { ref: 'total', column: 1 }] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The recipe behind a node:http server: POST /uploads only; the rest are called directly. */
async function serve(recipe, port = 0) {
  const { toErrorBody } = await import('sheet-to-schema/node');
  const server = createServer((req, res) => {
    recipe.upload(req).then(
      body => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)),
      error => {
        const { status, body } = toErrorBody(error);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      },
    );
  });
  await new Promise(resolve => server.listen(port, resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/uploads` };
}

async function uploadTo(url, text = csv()) {
  const form = new FormData();
  form.append('file', new Blob([text]), 'orders.csv');
  const response = await fetch(url, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.uploadId;
}

async function until(recipe, jobId, onPoll = () => {}) {
  for (let i = 0; i < 3000; i++) {
    const status = recipe.status(jobId);
    onPoll(status);
    if (status.state !== 'running') return status;
    await sleep(10);
  }
  throw new Error('job never finished');
}

if (process.argv[2] === 'crash-child') {
  // A server that starts an import, then is killed by the parent mid-job.
  process.env.IMPORT_DIR = process.argv[3];
  const recipe = await import('./polling.mjs');
  globalThis.__onBatch = () => sleep(200);
  const { url } = await serve(recipe, Number(process.argv[4]));
  const id = await uploadTo(url);
  recipe.start(id, 'import', PLAN);
  console.log(`started ${id}`);
  await sleep(60_000);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 's2s-polling-'));
process.env.IMPORT_DIR = dir;
// The sweep runs hourly in the recipe; here every 300 ms. Nothing else in the recipe uses setInterval.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, _ms, ...args) => realSetInterval(fn, 300, ...args);
const recipe = await import('./polling.mjs');
globalThis.setInterval = realSetInterval;
const { server, url } = await serve(recipe);
const files = () => readdirSync(dir);

let uploadId;
await check('upload once: streamed to the private directory, named by a random id', async () => {
  uploadId = await uploadTo(url);
  assert.match(uploadId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(files(), [uploadId]);
});

await check('preview from the stored file', async () => {
  const preview = await recipe.preview(uploadId);
  assert.deepEqual(preview.headers, ['Order', 'Total']);
  assert.equal(preview.rowCount, ROWS);
  assert.equal(preview.format, 'csv');
});

await check('a validate job: done, nothing written, file kept for the import', async () => {
  const written = [];
  globalThis.__onBatch = async records => void written.push(records.length);
  const { jobId } = recipe.start(uploadId, 'validate', PLAN);
  const final = await until(recipe, jobId);
  assert.equal(final.state, 'done', JSON.stringify(final.error));
  assert.equal(final.result.imported, ROWS);
  assert.equal(final.result.failed, 0);
  assert.equal(written.length, 0, 'validate wrote batches');
  assert.ok(files().includes(uploadId));
});

await check('an import job polled to completion, progress from onProgress, file deleted after', async () => {
  const batches = [];
  globalThis.__onBatch = async records => {
    batches.push(records.length);
    await sleep(2);
  };
  const progress = [];
  const { jobId } = recipe.start(uploadId, 'import', PLAN);
  const final = await until(recipe, jobId, status => progress.push(status.progress));
  assert.equal(final.state, 'done', JSON.stringify(final.error));
  assert.equal(final.result.imported, ROWS);
  assert.equal(batches.reduce((a, b) => a + b, 0), ROWS);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], `progress went back: ${progress[i - 1]} -> ${progress[i]}`);
  const between = progress.filter(p => p > 0 && p < 1);
  assert.ok(between.length >= 3, `only ${between.length} intermediate progress values seen`);
  assert.equal(progress.at(-1), 1);
  await sleep(50);
  assert.ok(!files().includes(uploadId), 'the imported file is still on disk');
  console.log(`     ${progress.length} polls, ${new Set(progress).size} distinct progress values, ${batches.length} batches`);
});

let cancelled;
await check('cancel mid-import: ABORTED, counts, no batch cut in half', async () => {
  const id = await uploadTo(url);
  const started = [];
  const finished = [];
  let written = 0;
  globalThis.__onBatch = async records => {
    started.push(records.length);
    await sleep(40);
    written += records.length;
    finished.push(records.length);
  };
  const { jobId } = recipe.start(id, 'import', PLAN);
  while (started.length < 3) await sleep(5);
  recipe.cancel(jobId);
  const final = await until(recipe, jobId);
  cancelled = { id, final };
  assert.equal(final.state, 'cancelled', `state ${final.state}: ${JSON.stringify(final.error)}`);
  assert.equal(final.error.code, 'ABORTED');
  assert.deepEqual(started, finished, 'a batch was started and not finished');
  assert.equal(final.error.details?.imported, written, `details ${JSON.stringify(final.error.details)}, written ${written}`);
  assert.ok(final.error.details.rowsRead < ROWS);
  assert.equal(final.error.details.failed, 0);
  await sleep(100);
  assert.equal(started.length, finished.length, 'a batch started after the cancel');
  console.log(`     cancelled after ${finished.length} batches: details ${JSON.stringify(final.error.details)}, progress ${final.progress.toFixed(3)}`);
});

await check('cancel mid-import: the uploaded file is deleted', async () => {
  assert.ok(cancelled, 'no cancelled job');
  await sleep(50);
  assert.ok(!files().includes(cancelled.id), `the cancelled job's file is still on disk (${cancelled.id})`);
});

await check('a crash mid-job leaves the file; the expiry sweep removes it', async () => {
  const crashDir = mkdtempSync(join(tmpdir(), 's2s-crash-'));
  const child = spawn(process.execPath, ['run.mjs', 'crash-child', crashDir, '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => (out += chunk));
  for (let i = 0; i < 600 && !out.includes('started'); i++) await sleep(50);
  assert.ok(out.includes('started'), 'the child never started its job');
  await sleep(500);
  child.kill('SIGKILL');
  await new Promise(resolve => child.on('exit', resolve));
  const left = readdirSync(crashDir);
  assert.equal(left.length, 1, `after the crash: ${left.join(', ')}`);

  // A restarted process: the recipe's sweep over the same directory, the file 25 hours old.
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(join(crashDir, left[0]), old, old);
  const sweeper = spawn(process.execPath, ['--input-type=module', '-e', `
    process.env.IMPORT_DIR = ${JSON.stringify(crashDir)};
    const real = globalThis.setInterval;
    globalThis.setInterval = (fn, _ms, ...a) => real(fn, 200, ...a);
    await import('./polling.mjs');
    globalThis.setInterval = real;
    await new Promise(r => setTimeout(r, 1500));
  `], { stdio: 'inherit' });
  await new Promise(resolve => sweeper.on('exit', resolve));
  assert.deepEqual(readdirSync(crashDir), [], 'the sweep left the crashed upload behind');
});

await check('a fresh upload is not swept', async () => {
  const id = await uploadTo(url, 'Order,Total\r\nA,1\r\n');
  await sleep(700);
  assert.ok(files().includes(id));
});

server.close();
const failed = results.filter(r => !r.ok).length;
console.log(`polling: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
