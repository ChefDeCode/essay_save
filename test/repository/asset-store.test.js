'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AssetStore,
  assetIdFromSha256,
  collectAssetIds,
  sanitizeAssetName,
  sha256Buffer,
  validateDescriptor
} = require('../../src/main/data/asset-store');

function createStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new AssetStore(root, options) };
}

test('content hash derives a stable UUID and sanitizes portable names', () => {
  const hash = sha256Buffer(Buffer.from('same bytes'));
  assert.match(assetIdFromSha256(hash), /^[0-9a-f-]{36}$/);
  assert.equal(assetIdFromSha256(hash), assetIdFromSha256(hash));
  assert.equal(sanitizeAssetName('..\\bad:name?.pdf'), 'bad_name_.pdf');
  assert.throws(() => assetIdFromSha256('bad'), /SHA-256/);
});

test('puts immutable deduplicated assets and verifies managed reads', async t => {
  let tick = 0;
  const { store } = createStore(t, { now: () => new Date(1_700_000_000_000 + tick++) });
  const input = { buffer: Buffer.from('%PDF-synthetic'), mimeType: 'application/pdf', kind: 'pdf', originalName: 'paper.pdf' };
  const first = await store.putBuffer(input);
  const second = await store.putBuffer({ ...input, originalName: 'renamed.pdf' });
  assert.deepEqual(second, first);
  assert.equal(store.listDescriptors().length, 1);
  assert.equal(store.readBuffer(first.assetId).buffer.toString(), '%PDF-synthetic');
  assert.equal(store.managedUrl(first.assetId), `essayflow-asset://asset/${first.assetId}`);
  assert.equal((await store.verifyAll()).ok, true);
});

test('imports files, detects tampering and rejects unsafe input', async t => {
  const { root, store } = createStore(t, { maxAssetBytes: 20 });
  const source = path.join(root, 'source.bin');
  fs.writeFileSync(source, 'legacy');
  const descriptor = await store.importFile(source, { kind: 'image', mimeType: 'image/png' });
  assert.equal(descriptor.originalName, 'source.bin');
  fs.writeFileSync(store.blobPath(descriptor.sha256), 'tampered');
  assert.throws(() => store.readBuffer(descriptor.assetId), /校验失败/);
  const report = await store.verifyAll();
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'ASSET_CHECKSUM_MISMATCH');
  await assert.rejects(store.putBuffer({ buffer: Buffer.alloc(21) }), /超过/);
  await assert.rejects(store.putBuffer({ buffer: 'not-buffer' }), /Buffer/);
  assert.throws(() => store.getDescriptor(cryptoRandomUuid()), /不存在/);
});

test('future and corrupt descriptors fail closed', async t => {
  const { store } = createStore(t);
  const descriptor = await store.putBuffer({ buffer: Buffer.from('asset') });
  const recordPath = store.recordPath(descriptor.assetId);
  fs.writeFileSync(recordPath, '{');
  assert.throws(() => store.getDescriptor(descriptor.assetId), error => error.code === 'ASSET_DESCRIPTOR_CORRUPT');
  fs.writeFileSync(recordPath, JSON.stringify({ ...descriptor, schemaVersion: 99 }));
  assert.throws(() => store.getDescriptor(descriptor.assetId), error => error.code === 'ASSET_SCHEMA_FUTURE' && error.details.readOnly);
  assert.throws(() => validateDescriptor([]), /不是对象/);
});

test('GC removes only unreachable descriptors and blobs', async t => {
  const { store } = createStore(t);
  const keep = await store.putBuffer({ buffer: Buffer.from('keep') });
  const remove = await store.putBuffer({ buffer: Buffer.from('remove') });
  const dryRun = await store.garbageCollect([keep.assetId], { dryRun: true });
  assert.deepEqual(dryRun.deleted, [remove.assetId]);
  assert.equal(store.listDescriptors().length, 2);
  const result = await store.garbageCollect([keep.assetId]);
  assert.deepEqual(result.retained, [keep.assetId]);
  assert.equal(store.listDescriptors().length, 1);
  assert.equal(fs.existsSync(store.blobPath(remove.sha256)), false);
  assert.equal(store.readBuffer(keep.assetId).buffer.toString(), 'keep');
});

test('collectAssetIds traverses aggregate/history/trash graphs without loops', async t => {
  const { store } = createStore(t);
  const first = await store.putBuffer({ buffer: Buffer.from('one') });
  const second = await store.putBuffer({ buffer: Buffer.from('two') });
  const graph = { assetRefs: [{ assetId: first.assetId }], versions: [{ snapshot: { assetId: second.assetId } }] };
  graph.self = graph;
  assert.deepEqual([...collectAssetIds(graph)].sort(), [first.assetId, second.assetId].sort());
});

function cryptoRandomUuid() {
  return '00000000-0000-4000-8000-000000000000';
}
