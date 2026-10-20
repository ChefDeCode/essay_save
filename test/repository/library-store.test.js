'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { durableWriteJson } = require('../../src/main/data/durable-fs');
const {
  DEFAULT_LIBRARY_RELATIVE_PATH,
  ERROR_CODES,
  LIBRARY_SCHEMA_VERSION,
  LibraryStore,
  LibraryStoreError,
  createCitationItemSnapshot,
  createEmptyLibraryEnvelope,
  libraryItemIdFromLegacySourceId,
  stableUuidV5,
  validateLibraryEnvelope
} = require('../../src/main/data/library-store');

const ITEM_A = '123e4567-e89b-42d3-a456-426614174000';
const ITEM_B = '223e4567-e89b-42d3-a456-426614174001';
const ITEM_C = '323e4567-e89b-42d3-a456-426614174002';
const COLLECTION_A = '423e4567-e89b-42d3-a456-426614174003';
const CITATION_A = '523e4567-e89b-42d3-a456-426614174004';
const PROJECT_A = '623e4567-e89b-42d3-a456-426614174005';
const BASE_TIME = Date.parse('2026-07-16T01:02:03.000Z');

function temporaryRoot(t, prefix = 'essayflow-library-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function clock(start = BASE_TIME) {
  let tick = 0;
  return () => new Date(start + tick++);
}

function item(libraryItemId, title, extra = {}) {
  return {
    libraryItemId,
    type: 'article-journal',
    title,
    author: [{ family: '张', given: '三' }],
    issued: { 'date-parts': [[2026]] },
    ...extra
  };
}

function assertCode(callback, code) {
  assert.throws(callback, error => {
    assert.equal(error instanceof LibraryStoreError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('empty store writes one durable envelope and reloads an immutable detached snapshot', async t => {
  const root = temporaryRoot(t);
  const source = item(ITEM_A, '原始标题', {
    legacySourceId: 'semantic-scholar:legacy-17',
    privateNote: '仅保存在全局文库',
    tags: ['综述']
  });
  const store = new LibraryStore(root, { now: clock() });
  assert.equal(store.revision, 0);
  assert.deepEqual(store.listItems(), []);

  const pending = store.upsertItem(source, { baseRevision: 0 });
  source.title = '调用后恶意修改';
  source.author[0].family = '篡改';
  const saved = await pending;

  assert.equal(saved.baseRevision, 0);
  assert.equal(saved.newRevision, 1);
  assert.equal(saved.acknowledgment.durable, true);
  assert.equal(saved.item.title, '原始标题');
  assert.equal(saved.item.author[0].family, '张');
  assert.equal(saved.snapshot.schemaVersion, LIBRARY_SCHEMA_VERSION);
  assert.equal(saved.snapshot.revision, 1);
  assert.equal(Object.isFrozen(saved.snapshot), true);
  assert.equal(Object.isFrozen(saved.snapshot.itemsById[ITEM_A].author[0]), true);
  assert.throws(() => { saved.snapshot.itemsById[ITEM_A].title = '不能修改'; }, TypeError);

  const filePath = path.join(root, ...DEFAULT_LIBRARY_RELATIVE_PATH.split('/'));
  assert.equal(fs.existsSync(filePath), true);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(Object.keys(onDisk.itemsById), [ITEM_A]);

  const reloaded = new LibraryStore(root, { now: clock(BASE_TIME + 100000) });
  assert.equal(reloaded.revision, 1);
  assert.equal(reloaded.getItem(ITEM_A).title, '原始标题');
  const firstRead = reloaded.readSync();
  const secondRead = reloaded.readSync();
  assert.notEqual(firstRead, secondRead);
  assert.deepEqual(firstRead, secondRead);
});

test('all writes are serialized, use root-relative durableWriteJson and update cache only after ack', async t => {
  const root = temporaryRoot(t);
  let active = 0;
  let maximumActive = 0;
  let callCount = 0;
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  let firstStarted;
  const observedFirst = new Promise(resolve => { firstStarted = resolve; });
  const writes = [];
  const writer = async (actualRoot, relativePath, envelope, options) => {
    assert.equal(actualRoot, path.resolve(root));
    assert.equal(relativePath, path.normalize(DEFAULT_LIBRARY_RELATIVE_PATH));
    assert.equal(options.label, 'library-item-upsert');
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    callCount += 1;
    writes.push(envelope.revision);
    if (callCount === 1) {
      firstStarted();
      await firstBlocked;
    }
    const acknowledgment = await durableWriteJson(actualRoot, relativePath, envelope, options);
    active -= 1;
    return acknowledgment;
  };
  const store = new LibraryStore(root, { now: clock(), durableWriteJson: writer });
  const first = store.upsertItem(item(ITEM_A, 'A'), { baseRevision: 0 });
  const second = store.upsertItem(item(ITEM_B, 'B'), { baseRevision: 1 });
  await observedFirst;
  assert.equal(store.revision, 0, 'durable ack 前不能推进内存 revision');
  assert.deepEqual(writes, [1], '第二个写入必须仍在队列中');
  releaseFirst();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.newRevision), [1, 2]);
  assert.deepEqual(writes, [1, 2]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(store.listItems().map(entry => entry.libraryItemId), [ITEM_A, ITEM_B]);
});

test('baseRevision is mandatory, stale concurrent writers fail CAS and a rejected write does not poison the queue', async t => {
  const root = temporaryRoot(t);
  const store = new LibraryStore(root, { now: clock() });
  assertCode(() => store.upsertItem(item(ITEM_A, 'A'), {}), ERROR_CODES.BASE_REVISION_REQUIRED);

  const first = store.upsertItem(item(ITEM_A, 'A'), { baseRevision: 0 });
  const stale = store.upsertItem(item(ITEM_B, 'B'), { baseRevision: 0 });
  assert.equal((await first).newRevision, 1);
  await assert.rejects(stale, error => {
    assert.equal(error.code, ERROR_CODES.REVISION_CONFLICT);
    assert.deepEqual(error.details, { baseRevision: 0, currentRevision: 1 });
    return true;
  });
  assert.equal(store.revision, 1);
  assert.equal(store.getItem(ITEM_B), null);
  assert.equal((await store.upsertItem(item(ITEM_B, 'B'), { baseRevision: 1 })).newRevision, 2);
});

test('pre-commit durable failure leaves cache and disk unchanged and later queued work can succeed', async t => {
  const root = temporaryRoot(t);
  let failNext = true;
  const writer = async (...args) => {
    if (failNext) {
      failNext = false;
      const error = new Error('synthetic no-space');
      error.code = 'ENOSPC';
      error.committed = false;
      throw error;
    }
    return durableWriteJson(...args);
  };
  const store = new LibraryStore(root, { now: clock(), durableWriteJson: writer });
  await assert.rejects(store.upsertItem(item(ITEM_A, 'A'), { baseRevision: 0 }), { code: 'ENOSPC' });
  assert.equal(store.revision, 0);
  assert.equal(store.getItem(ITEM_A), null);
  assert.equal(fs.existsSync(path.join(root, 'library', 'library.json')), false);
  const saved = await store.upsertItem(item(ITEM_B, 'B'), { baseRevision: 0 });
  assert.equal(saved.newRevision, 1);
  assert.equal(store.getItem(ITEM_B).title, 'B');
});

test('a committed-but-unacknowledged write is reloaded before any retry can overwrite it', async t => {
  const root = temporaryRoot(t);
  let loseFirstAck = true;
  const writer = async (...args) => {
    const acknowledgment = await durableWriteJson(...args);
    if (loseFirstAck) {
      loseFirstAck = false;
      const error = new Error('synthetic ack loss');
      error.committed = true;
      error.details = { committed: true };
      throw error;
    }
    return acknowledgment;
  };
  const store = new LibraryStore(root, { now: clock(), durableWriteJson: writer });
  await assert.rejects(store.upsert(item(ITEM_A, 'durably committed'), { baseRevision: 0 }), {
    message: 'synthetic ack loss'
  });
  assert.equal(store.revision, 1);
  assert.equal(store.getItem(ITEM_A).title, 'durably committed');
  await assert.rejects(store.upsert(item(ITEM_B, 'stale retry'), { baseRevision: 0 }), {
    code: ERROR_CODES.REVISION_CONFLICT
  });
  assert.equal((await store.upsert(item(ITEM_B, 'fresh retry'), { baseRevision: 1 })).newRevision, 2);
});

test('migration bulk replace accepts stable UUID mappings and collection membership in one revision', async t => {
  const root = temporaryRoot(t);
  const firstLegacyId = 'legacy-paper:中文:17';
  const secondLegacyId = 'legacy-paper:english:18';
  const firstId = libraryItemIdFromLegacySourceId(firstLegacyId);
  const secondId = libraryItemIdFromLegacySourceId(secondLegacyId);
  assert.equal(firstId, libraryItemIdFromLegacySourceId(firstLegacyId));
  assert.notEqual(firstId, secondId);
  assert.match(firstId, /^[0-9a-f-]{36}$/);
  assert.equal(stableUuidV5('7c84c3e8-9c7e-4a43-9475-e48d9ca5e447', 'same'),
    stableUuidV5('7c84c3e8-9c7e-4a43-9475-e48d9ca5e447', 'same'));
  assertCode(() => libraryItemIdFromLegacySourceId(''), ERROR_CODES.INPUT_INVALID);

  const store = new LibraryStore(root, { now: clock() });
  const result = await store.bulkReplace({
    items: [
      item(firstId, '迁移文献', { legacySourceId: firstLegacyId }),
      item(secondId, 'Migrated paper', { legacySourceId: secondLegacyId })
    ],
    collections: [{ collectionId: COLLECTION_A, name: '迁移集合', itemIds: [secondId, firstId] }]
  }, { baseRevision: 0 });
  assert.equal(result.newRevision, 1);
  assert.deepEqual(Object.keys(result.snapshot.itemsById), [firstId, secondId].sort());
  assert.deepEqual(result.snapshot.collections[0].itemIds, [firstId, secondId].sort());
  assert.equal(JSON.stringify(result.snapshot).includes('paperId'), false);
  assert.equal(validateLibraryEnvelope(result.snapshot).revision, 1);
});

test('item and collection CRUD remain one envelope and global remove cannot mutate a project citationItem snapshot', async t => {
  const root = temporaryRoot(t);
  const store = new LibraryStore(root, { now: clock() });
  await store.upsertItem(item(ITEM_A, '引用来源', {
    DOI: '10.1000/example',
    tags: ['保密标签'],
    starred: true,
    privateNote: '不进入项目引用快照'
  }), { baseRevision: 0 });
  await store.upsertItem(item(ITEM_B, '第二篇'), { baseRevision: 1 });
  const created = await store.createCollection({ collectionId: COLLECTION_A, name: '待阅读' }, { baseRevision: 2 });
  assert.deepEqual(created.collection.itemIds, []);
  await store.addItemToCollection(COLLECTION_A, ITEM_A, { baseRevision: 3 });
  await store.setCollectionItems(COLLECTION_A, [ITEM_B, ITEM_A], { baseRevision: 4 });
  const renamed = await store.renameCollection(COLLECTION_A, '重点文献', { baseRevision: 5 });
  assert.equal(renamed.collection.name, '重点文献');

  const citationItem = createCitationItemSnapshot(store.getItem(ITEM_A), {
    citationItemId: CITATION_A,
    projectId: PROJECT_A,
    capturedAt: '2026-07-16T02:00:00.000Z'
  });
  assert.equal(citationItem.libraryItemId, ITEM_A);
  assert.equal(citationItem.citationItemId, CITATION_A);
  assert.equal(citationItem.title, '引用来源');
  assert.equal(citationItem.privateNote, undefined);
  assert.equal(citationItem.tags, undefined);
  const citationBeforeRemove = JSON.stringify(citationItem);

  const removed = await store.remove(ITEM_A, { baseRevision: 6 });
  assert.equal(removed.removedItem.libraryItemId, ITEM_A);
  assert.equal(store.getItem(ITEM_A), null);
  assert.deepEqual(store.getCollection(COLLECTION_A).itemIds, [ITEM_B]);
  assert.equal(JSON.stringify(citationItem), citationBeforeRemove,
    '全局文库删除不得改变项目内不可变 citationItem 快照');
  assert.equal(Object.isFrozen(citationItem.author[0]), true);

  await store.removeItemFromCollection(COLLECTION_A, ITEM_B, { baseRevision: 7 });
  assert.deepEqual(store.getCollection(COLLECTION_A).itemIds, []);
  const deletedCollection = await store.deleteCollection(COLLECTION_A, { baseRevision: 8 });
  assert.equal(deletedCollection.removedCollection.name, '重点文献');
  assert.deepEqual(store.listCollections(), []);
});

test('export/import snapshot is detached, validated and preserves all business content', async t => {
  const firstRoot = temporaryRoot(t, 'essayflow-library-export-');
  const secondRoot = temporaryRoot(t, 'essayflow-library-import-');
  const source = new LibraryStore(firstRoot, { now: clock() });
  await source.replace({
    items: [item(ITEM_A, '往返测试', { abstract: '中英文 Unicode café' })],
    collections: [{ collectionId: COLLECTION_A, name: '往返集合', itemIds: [ITEM_A] }]
  }, { baseRevision: 0 });
  const exported = source.exportSnapshot();
  assert.equal(Object.isFrozen(exported.itemsById[ITEM_A]), true);
  assert.throws(() => { exported.collections.push({}); }, TypeError);

  const target = new LibraryStore(secondRoot, { now: clock(BASE_TIME + 500000) });
  const imported = await target.importSnapshot(exported, { baseRevision: 0 });
  assert.equal(imported.newRevision, 1);
  assert.deepEqual(imported.snapshot.itemsById, exported.itemsById);
  assert.deepEqual(imported.snapshot.collections, exported.collections);
  assert.notEqual(imported.snapshot, exported);
  assert.equal(new LibraryStore(secondRoot, { now: clock() }).getItem(ITEM_A).abstract,
    '中英文 Unicode café');
});

test('future schema opens read-only, preserves raw diagnostic export and rejects interpretation or writes', async t => {
  const root = temporaryRoot(t);
  const filePath = path.join(root, 'library', 'library.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const future = {
    schemaVersion: LIBRARY_SCHEMA_VERSION + 1,
    revision: 77,
    updatedAt: '2030-01-01T00:00:00.000Z',
    itemsById: {},
    collections: [],
    futureCapability: { enabled: true }
  };
  fs.writeFileSync(filePath, JSON.stringify(future));
  const store = new LibraryStore(root, { now: clock() });
  assert.equal(store.readOnly, true);
  assert.deepEqual(store.exportSnapshot(), future);
  assert.equal(Object.isFrozen(store.exportSnapshot().futureCapability), true);
  assertCode(() => store.listItems(), ERROR_CODES.SCHEMA_FUTURE);
  await assert.rejects(store.upsertItem(item(ITEM_A, '禁止写'), { baseRevision: 77 }), {
    code: ERROR_CODES.READ_ONLY,
    readOnly: true
  });
  assert.equal(fs.readFileSync(filePath, 'utf8'), JSON.stringify(future));
});

test('untrusted payloads reject paperId, ambiguous IDs, secrets, machine paths and prototype pollution', async t => {
  const root = temporaryRoot(t);
  const store = new LibraryStore(root, { now: clock() });
  const cases = [
    [item(ITEM_A, 'x', { paperId: 'ambiguous' }), ERROR_CODES.PAPER_ID_REJECTED],
    [{ ...item(ITEM_A, 'x'), id: ITEM_B }, ERROR_CODES.AMBIGUOUS_ID],
    [item(ITEM_A, 'x', { apiKey: 'secret-value' }), ERROR_CODES.SECRET_FIELD_REJECTED],
    [item(ITEM_A, 'x', { nested: { Authorization: 'Bearer secret-value' } }), ERROR_CODES.SECRET_FIELD_REJECTED],
    [item(ITEM_A, 'x', { URL: 'https://user:password@example.test/paper' }), ERROR_CODES.SECRET_FIELD_REJECTED],
    [item(ITEM_A, 'x', { filePath: 'asset-should-be-used' }), ERROR_CODES.ABSOLUTE_PATH_REJECTED],
    [item(ITEM_A, 'x', { attachment: 'C:\\Users\\alice\\paper.pdf' }), ERROR_CODES.ABSOLUTE_PATH_REJECTED],
    [JSON.parse(`{"libraryItemId":"${ITEM_A}","title":"x","__proto__":{"polluted":true}}`),
      ERROR_CODES.UNSAFE_KEY_REJECTED]
  ];
  for (const [payload, code] of cases) {
    await assert.rejects(Promise.resolve().then(() => store.upsertItem(payload, { baseRevision: 0 })), error => {
      assert.equal(error instanceof LibraryStoreError, true);
      assert.equal(error.code, code);
      return true;
    });
  }
  assert.equal({}.polluted, undefined);
  await assert.rejects(Promise.resolve().then(() => store.upsertItem(
    Object.assign(Object.create({ inherited: true }), item(ITEM_A, 'x')),
    { baseRevision: 0 }
  )), { code: ERROR_CODES.INPUT_INVALID });
  assert.equal(store.revision, 0);
});

test('envelope and relation validation fail closed without touching existing business data', async t => {
  const root = temporaryRoot(t);
  const store = new LibraryStore(root, { now: clock() });
  await store.upsertItem(item(ITEM_A, 'kept'), { baseRevision: 0 });
  const before = JSON.stringify(store.readSync());
  await assert.rejects(store.replace({
    items: [item(ITEM_A, 'kept')],
    collections: [{ collectionId: COLLECTION_A, name: 'bad', itemIds: [ITEM_C] }]
  }, { baseRevision: 1 }), { code: ERROR_CODES.REFERENCE_INVALID });
  assert.equal(JSON.stringify(store.readSync()), before);
  await assert.rejects(store.addItemToCollection(COLLECTION_A, ITEM_A, { baseRevision: 1 }), {
    code: ERROR_CODES.COLLECTION_NOT_FOUND
  });
  assert.equal(store.revision, 1);

  const invalid = createEmptyLibraryEnvelope('2026-07-16T00:00:00.000Z');
  const mutable = JSON.parse(JSON.stringify(invalid));
  mutable.revision = -1;
  assertCode(() => validateLibraryEnvelope(mutable), ERROR_CODES.SCHEMA_INVALID);
});
