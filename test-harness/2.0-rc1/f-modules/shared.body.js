// Runs in CJS and ESM alike, given main and node.
async function body(main, node, label) {
  const assert = require_assert();
  const adapter = main.jsonSchemaAdapter({ $id: 'p', type: 'object', properties: { name: { type: 'string' } } });
  const plan = { planVersion: 2, target: 'p', entries: [{ ref: 'name', column: 0 }] };
  let csv = 'Name\r\n'; for (let i = 0; i < 2000; i++) csv += `P${i}\r\n`;
  const progress = [];
  const result = await node.runImport({ stream: Buffer.from(csv), plan, adapter, ctx: undefined, limits: { batchSize: 300 }, onProgress: p => progress.push(p), signal: new AbortController().signal, onBatch: () => {} });
  assert.equal(result.imported, 2000);
  assert.deepEqual(progress.at(-1), { bytesRead: Buffer.byteLength(csv), rowsRead: 2000 });
  const c = new AbortController(); c.abort();
  await assert.rejects(node.runImport({ stream: Buffer.from(csv), plan, adapter, ctx: undefined, signal: c.signal }), e => e.code === 'ABORTED' && e.status === 499);
  await assert.rejects(main.readCsvFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])), e => e.code === 'UNSUPPORTED_FORMAT' && /binary data/.test(e.message));
  assert.deepEqual([...main.SERVER_FEATURES], ['group']);
  assert.equal(main.IMPORTER_VERSION, '2.0.0-rc.1');
  for (const gone of ['createImportRouter', 'sendFailure', 'safeFieldName', 'SERVER_FEATURES']) assert.equal(gone in node, false, `/node still exports ${gone}`);
  assert.equal(typeof node.templateOf, 'function');
  assert.equal(typeof node.templateFilename, 'function');
  const sheet = await node.readSheet({ stream: require_fs().readFileSync('case1_1904_dates.xlsx'), filename: 'x.xlsx' });
  assert.equal(sheet.format, 'xlsx');
  console.log(`  ${label}: runImport with signal and onProgress, ABORTED, binary refusal, SERVER_FEATURES in main, removed exports gone, workbook read`);
}
