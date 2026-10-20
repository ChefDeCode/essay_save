'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CanonicalizationError,
  canonicalBytes,
  canonicalStringify,
  canonicalize,
  cloneCanonical,
  semanticDigest,
  semanticHash
} = require('../../src/main/data/canonical');
const {
  FUTURE_COLLECTION_FIELDS,
  PROJECT_COLLECTION_FIELDS,
  SCHEMA_VERSION,
  SchemaValidationError,
  createEmptyProjectAggregate,
  createEmptyWorkspace,
  isPlainObject,
  isStableUuid,
  isUtcTimestamp,
  normalizeProjectAggregate,
  normalizeWorkspace,
  validateProjectAggregate,
  validateWorkspace
} = require('../../src/main/data/schema');
const {
  DurableFsError,
  ERROR_CODES,
  FAULT_STAGES,
  durableWriteFile,
  durableWriteJson,
  fsyncDirectory,
  normalizeRelativePath,
  resolveContainedPath
} = require('../../src/main/data/durable-fs');

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const WORKSPACE_ID = '223e4567-e89b-42d3-a456-426614174001';
const ITEM_ID = '323e4567-e89b-42d3-a456-426614174002';
const SECOND_ITEM_ID = '423e4567-e89b-42d3-a456-426614174003';
const THIRD_ITEM_ID = '523e4567-e89b-42d3-a456-426614174004';
const CREATED_AT = '2026-07-16T01:02:03.004Z';

function temporaryDirectory(t, prefix = 'essayflow-primitives-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validProject(overrides = {}) {
  return createEmptyProjectAggregate({
    projectId: PROJECT_ID,
    createdAt: CREATED_AT,
    ...overrides
  });
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertSchemaError(callback, code, pathPrefix) {
  assert.throws(callback, error => {
    assert.equal(error instanceof SchemaValidationError, true);
    assert.equal(error.code, code);
    if (pathPrefix) assert.equal(error.path.startsWith(pathPrefix), true, error.path);
    return true;
  });
}

test('canonical JSON normalizes UTF-8 text, LF, NFC, keys, negative zero and preserves null', () => {
  const first = {};
  first.z = 'Cafe\u0301\r\nline\rfinal';
  first.a = null;
  first.number = -0;
  const second = { number: 0, a: null, z: 'Caf\u00e9\nline\nfinal' };

  const serialized = canonicalStringify(first);
  assert.equal(serialized, '{"a":null,"number":0,"z":"Café\\nline\\nfinal"}\n');
  assert.equal(serialized, canonicalStringify(second));
  assert.equal(canonicalBytes(first).equals(Buffer.from(serialized, 'utf8')), true);
  assert.equal(semanticHash({ value: null }), semanticHash({ value: null }));
  assert.notEqual(semanticHash({ value: null }), semanticHash({}));
});

test('declared unordered collections sort by stable ID while ordinary arrays preserve order', () => {
  const first = {
    citationItems: [
      { citationItemId: SECOND_ITEM_ID, title: 'second' },
      { citationItemId: ITEM_ID, title: 'first' }
    ],
    ordered: ['b', 'a']
  };
  const second = {
    ordered: ['b', 'a'],
    citationItems: [...first.citationItems].reverse()
  };
  const normalized = canonicalize(first);
  assert.deepEqual(normalized.citationItems.map(item => item.citationItemId), [ITEM_ID, SECOND_ITEM_ID]);
  assert.deepEqual(normalized.ordered, ['b', 'a']);
  assert.equal(semanticHash(first), semanticHash(second));
  assert.notEqual(semanticHash(first), semanticHash({ ...second, ordered: ['a', 'b'] }));
});

test('custom unordered paths and stable ID resolver are deterministic', () => {
  const input = {
    groups: [{
      members: [{ key: 'z', value: 2 }, { key: 'a', value: 1 }]
    }]
  };
  const options = {
    useDefaultUnorderedArrays: false,
    unorderedArrayPaths: ['groups.*.members'],
    stableId(item) {
      return item.key;
    }
  };
  assert.deepEqual(canonicalize(input, options).groups[0].members.map(item => item.key), ['a', 'z']);
  assert.deepEqual(canonicalize({ items: [{ id: 'b' }, { id: 'a' }] }, {
    useDefaultUnorderedArrays: false,
    unorderedArrayPaths: new Set(['items'])
  }).items.map(item => item.id), ['a', 'b']);
});

test('semantic hash omits only declared volatile and machine fields', () => {
  const first = {
    id: PROJECT_ID,
    generatedAt: '2026-01-01T00:00:00.000Z',
    absolutePath: 'C:\\one',
    runtimeLogs: ['one'],
    createdAt: CREATED_AT,
    nested: { machinePath: 'C:\\machine', title: 'stable' }
  };
  const second = copy(first);
  second.generatedAt = '2030-01-01T00:00:00.000Z';
  second.absolutePath = 'D:\\two';
  second.runtimeLogs = ['two'];
  second.nested.machinePath = '/other';
  assert.equal(semanticHash(first), semanticHash(second));
  second.createdAt = '2027-01-01T00:00:00.000Z';
  assert.notEqual(semanticHash(first), semanticHash(second));

  const explicit = { payload: { transient: 1, stable: 2 } };
  assert.equal(
    semanticHash(explicit, { excludedPaths: ['payload.transient'] }),
    semanticHash({ payload: { transient: 9, stable: 2 } }, { excludedPaths: ['payload.transient'] })
  );
  assert.notEqual(
    semanticHash(first),
    semanticHash(second, { useDefaultSemanticExclusions: false })
  );
});

test('semantic digest and canonical clone are independent and self-consistent', () => {
  const source = { b: { text: 'x' }, a: 1 };
  const cloned = cloneCanonical(source);
  cloned.b.text = 'changed';
  assert.equal(source.b.text, 'x');
  const digest = semanticDigest(source);
  assert.equal(digest.byteLength, Buffer.byteLength(digest.canonical));
  assert.equal(digest.sha256, crypto.createHash('sha256').update(digest.canonical).digest('hex'));
  assert.equal(Object.isFrozen(digest), true);
});

test('canonicalizer rejects ambiguous or non-JSON values with stable codes', async t => {
  const cases = [
    [{ value: undefined }, 'CANONICAL_UNSUPPORTED_VALUE'],
    [{ value: NaN }, 'CANONICAL_NON_FINITE_NUMBER'],
    [{ value: Infinity }, 'CANONICAL_NON_FINITE_NUMBER'],
    [{ value: 1n }, 'CANONICAL_UNSUPPORTED_VALUE'],
    [{ value: new Date(CREATED_AT) }, 'CANONICAL_NON_PLAIN_OBJECT'],
    [{ citationItems: [{ title: 'missing id' }] }, 'CANONICAL_STABLE_ID_REQUIRED'],
    [{ citationItems: [{ id: ITEM_ID }, { id: ITEM_ID }] }, 'CANONICAL_DUPLICATE_STABLE_ID']
  ];
  for (const [value, code] of cases) {
    await t.test(code, () => {
      assert.throws(() => canonicalize(value), error => {
        assert.equal(error instanceof CanonicalizationError, true);
        assert.equal(error.code, code);
        return true;
      });
    });
  }

  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalize(circular), { code: 'CANONICAL_CYCLE' });
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalize(sparse), { code: 'CANONICAL_SPARSE_ARRAY' });
  const symbolKey = { normal: true };
  symbolKey[Symbol('hidden')] = true;
  assert.throws(() => canonicalize(symbolKey), { code: 'CANONICAL_SYMBOL_KEY' });

  const collision = { '\u00e9': 1, 'e\u0301': 2 };
  assert.throws(() => canonicalize(collision), { code: 'CANONICAL_NORMALIZED_KEY_COLLISION' });
  assert.throws(() => canonicalize({}, { unorderedArrayPaths: 'items' }), { code: 'CANONICAL_INVALID_OPTIONS' });
  assert.throws(() => canonicalize({}, { excludedKeys: 'field' }), { code: 'CANONICAL_INVALID_OPTIONS' });
  assert.throws(() => canonicalize({}, { unorderedArrayPaths: [''] }), { code: 'CANONICAL_INVALID_PATH_DECLARATION' });
});

test('ProjectAggregate factory includes every declared collection and canonical HTML document', () => {
  const project = validProject({
    title: 'Cafe\u0301',
    html: '<p>line 1\r\nline 2</p>',
    revision: 0
  });
  assert.equal(project.schemaVersion, SCHEMA_VERSION);
  assert.equal(project.manifest.title, 'Café');
  assert.equal(project.manifest.revision, 0);
  assert.deepEqual(project.document, {
    canonicalFormat: 'html',
    html: '<p>line 1\nline 2</p>'
  });
  assert.deepEqual(Object.keys(project).filter(key => Array.isArray(project[key])), [...PROJECT_COLLECTION_FIELDS].sort());
  for (const field of PROJECT_COLLECTION_FIELDS) assert.deepEqual(project[field], []);
  validateProjectAggregate(project);
});

test('ProjectAggregate accepts version metadata and normalizes stable collections', () => {
  const project = validProject({ derivedDelta: { ops: [{ insert: 'text\n' }] } });
  project.citationItems.push(
    { id: SECOND_ITEM_ID, schemaVersion: 1, title: 'second' },
    { id: ITEM_ID, schemaVersion: 1, title: 'first' }
  );
  project.assetRefs.push({ assetId: THIRD_ITEM_ID, schemaVersion: 1 });
  project.versions.push({
    id: '623e4567-e89b-42d3-a456-426614174005',
    snapshotHash: 'a'.repeat(64),
    createdAt: '2026-07-16T02:00:00Z',
    source: 'manual-checkpoint',
    manual: true,
    summary: { wordCount: 12 }
  });
  validateProjectAggregate(project);
  const normalized = normalizeProjectAggregate(project);
  assert.deepEqual(normalized.citationItems.map(item => item.id), [ITEM_ID, SECOND_ITEM_ID]);
  assert.notEqual(normalized, project);
});

test('ProjectAggregate enforces modern CitationLink and ProjectPaperState contracts', () => {
  const project = validProject();
  project.citationItems.push({
    schemaVersion: 1,
    id: ITEM_ID,
    citationItemId: ITEM_ID,
    projectId: PROJECT_ID,
    libraryItemId: SECOND_ITEM_ID,
    type: 'article-journal',
    title: 'Structured citation',
    author: [{ family: 'Wang', given: 'Wei' }],
    capturedAt: CREATED_AT
  });
  project.citationLinks.push({
    schemaVersion: 1,
    id: THIRD_ITEM_ID,
    projectId: PROJECT_ID,
    insertionMode: 'citation-only',
    items: [{
      citationItemEntryId: '623e4567-e89b-42d3-a456-426614174005',
      citationItemId: ITEM_ID,
      evidenceRevisionIds: [],
      sourceCitationSnapshots: [],
      suppressAuthor: false,
      order: 0,
      status: 'active'
    }],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  });
  project.projectPaperStates.push({
    schemaVersion: 1,
    id: '723e4567-e89b-42d3-a456-426614174006',
    projectId: PROJECT_ID,
    citationItemId: ITEM_ID,
    screeningStatus: 'included',
    readingStatus: 'reading',
    projectNotes: '',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  });
  validateProjectAggregate(project);

  const badLocator = copy(project);
  badLocator.citationLinks[0].items[0].locator = '12';
  assertSchemaError(() => validateProjectAggregate(badLocator), 'SCHEMA_INVALID_CITATION_LOCATOR', '$.citationLinks');
  const dangling = copy(project);
  dangling.citationLinks[0].items[0].citationItemId = WORKSPACE_ID;
  assertSchemaError(() => validateProjectAggregate(dangling), 'SCHEMA_DANGLING_CITATION_ITEM', '$.citationLinks');
  const invalidState = copy(project);
  invalidState.projectPaperStates[0].screeningStatus = 'excluded';
  assertSchemaError(() => validateProjectAggregate(invalidState), 'SCHEMA_INVALID_STRING', '$.projectPaperStates');
});

test('ProjectAggregate rejects future schemas as a read-only condition', () => {
  const future = validProject();
  future.schemaVersion = 2;
  assert.throws(() => validateProjectAggregate(future), error => {
    assert.equal(error.code, 'SCHEMA_FUTURE_VERSION_READ_ONLY');
    assert.equal(error.readOnly, true);
    assert.equal(error.details.supportedVersion, 1);
    assert.equal(error.details.actualVersion, 2);
    return true;
  });
  const legacy = validProject();
  legacy.schemaVersion = 0;
  assertSchemaError(() => validateProjectAggregate(legacy), 'SCHEMA_UNSUPPORTED_VERSION', '$.schemaVersion');
  const invalid = validProject();
  invalid.schemaVersion = '1';
  assertSchemaError(() => validateProjectAggregate(invalid), 'SCHEMA_INVALID_VERSION', '$.schemaVersion');
});

test('ProjectAggregate validates required fields, exact shape and document contract', async t => {
  const cases = [
    ['not object', null, 'SCHEMA_EXPECTED_OBJECT'],
    ['missing', (() => { const value = validProject(); delete value.document; return value; })(), 'SCHEMA_REQUIRED_FIELD_MISSING'],
    ['unknown', { ...validProject(), surprise: true }, 'SCHEMA_UNKNOWN_FIELD'],
    ['manifest object', (() => { const value = validProject(); value.manifest = []; return value; })(), 'SCHEMA_EXPECTED_OBJECT'],
    ['canonical format', (() => { const value = validProject(); value.document.canonicalFormat = 'delta'; return value; })(), 'SCHEMA_INVALID_CANONICAL_FORMAT'],
    ['html', (() => { const value = validProject(); value.document.html = null; return value; })(), 'SCHEMA_INVALID_STRING'],
    ['delta', (() => { const value = validProject(); value.document.derivedDelta = []; return value; })(), 'SCHEMA_INVALID_DERIVED_DELTA'],
    ['array', (() => { const value = validProject(); value.citationLinks = {}; return value; })(), 'SCHEMA_EXPECTED_ARRAY']
  ];
  for (const [name, value, code] of cases) {
    await t.test(name, () => assertSchemaError(() => validateProjectAggregate(value), code));
  }
  const permissive = { ...validProject(), extension: true };
  validateProjectAggregate(permissive, { allowUnknownFields: true });
});

test('ProjectAggregate strongly validates IDs, timestamps, revision and manifest values', async t => {
  const mutations = [
    ['uuid', project => { project.manifest.projectId = 'not-a-uuid'; }, 'SCHEMA_INVALID_UUID'],
    ['title', project => { project.manifest.title = null; }, 'SCHEMA_INVALID_STRING'],
    ['wordLimit', project => { project.manifest.wordLimit = -1; }, 'SCHEMA_INVALID_NON_NEGATIVE_INTEGER'],
    ['style', project => { project.manifest.referenceStyle = ''; }, 'SCHEMA_INVALID_STRING'],
    ['privacy', project => { project.manifest.privacyMode = 'secret'; }, 'SCHEMA_INVALID_PRIVACY_MODE'],
    ['timestamp', project => { project.manifest.createdAt = '2026-02-30T00:00:00Z'; }, 'SCHEMA_INVALID_UTC_TIMESTAMP'],
    ['timestamp order', project => { project.manifest.updatedAt = '2025-01-01T00:00:00Z'; }, 'SCHEMA_TIMESTAMP_REGRESSION'],
    ['revision', project => { project.manifest.revision = 1.5; }, 'SCHEMA_INVALID_NON_NEGATIVE_INTEGER']
  ];
  for (const [name, mutate, code] of mutations) {
    await t.test(name, () => {
      const project = validProject();
      mutate(project);
      assertSchemaError(() => validateProjectAggregate(project), code);
    });
  }
  assert.equal(isStableUuid(PROJECT_ID), true);
  assert.equal(isStableUuid('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(isUtcTimestamp('2026-07-16T01:02:03Z'), true);
  assert.equal(isUtcTimestamp('2026-07-16 01:02:03Z'), false);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
});

test('ProjectAggregate enforces collection IDs, ownership, versions and future-empty mode', async t => {
  const failures = [
    ['missing id', project => project.citationItems.push({ title: 'x' }), 'SCHEMA_INVALID_UUID'],
    ['duplicate id', project => {
      project.citationItems.push({ id: ITEM_ID });
      project.citationLinks.push({ id: ITEM_ID });
    }, 'SCHEMA_DUPLICATE_ID'],
    ['project mismatch', project => project.citationLinks.push({ id: ITEM_ID, projectId: WORKSPACE_ID }), 'SCHEMA_PROJECT_ID_MISMATCH'],
    ['future item schema', project => project.citationItems.push({ id: ITEM_ID, schemaVersion: 2 }), 'SCHEMA_FUTURE_VERSION_READ_ONLY'],
    ['ambiguous item id', project => project.citationItems.push({ id: ITEM_ID, citationItemId: SECOND_ITEM_ID }), 'SCHEMA_AMBIGUOUS_ID'],
    ['version hash', project => project.versions.push({
      id: ITEM_ID, snapshotHash: 'A'.repeat(64), createdAt: CREATED_AT,
      source: 'manual', manual: true, summary: {}
    }), 'SCHEMA_INVALID_SHA256'],
    ['version boolean', project => project.versions.push({
      id: ITEM_ID, snapshotHash: 'a'.repeat(64), createdAt: CREATED_AT,
      source: 'manual', manual: 'yes', summary: {}
    }), 'SCHEMA_INVALID_BOOLEAN']
  ];
  for (const [name, mutate, code] of failures) {
    await t.test(name, () => {
      const project = validProject();
      mutate(project);
      assertSchemaError(() => validateProjectAggregate(project), code);
    });
  }
  const project = validProject();
  project.evidenceCards.push({ id: ITEM_ID, projectId: PROJECT_ID });
  assertSchemaError(
    () => validateProjectAggregate(project, { requireEmptyFutureCollections: true }),
    'SCHEMA_FUTURE_COLLECTION_NOT_EMPTY'
  );
  assert.equal(FUTURE_COLLECTION_FIELDS.includes('evidenceCards'), true);
});

test('Workspace factory validates manifest and populated project/library/asset maps', () => {
  const workspace = createEmptyWorkspace({
    workspaceId: WORKSPACE_ID,
    appVersion: '1.1.0',
    createdAt: CREATED_AT
  });
  workspace.projectsById[PROJECT_ID] = validProject();
  workspace.libraryItemsById[ITEM_ID] = { id: ITEM_ID, schemaVersion: 1, title: 'Library item' };
  workspace.collections.push({ id: SECOND_ITEM_ID, schemaVersion: 1, name: 'Inbox' });
  workspace.assetStore.assetsById[THIRD_ITEM_ID] = { assetId: THIRD_ITEM_ID, schemaVersion: 1, sha256: 'b'.repeat(64) };
  workspace.exportableSettings.theme = 'dark';
  assert.equal(validateWorkspace(workspace), workspace);
  const normalized = normalizeWorkspace(workspace);
  assert.notEqual(normalized, workspace);
  assert.equal(normalized.workspaceManifest.workspaceId, WORKSPACE_ID);
});

test('Workspace rejects map mismatches, duplicate collections and invalid nested envelopes', async t => {
  const base = () => createEmptyWorkspace({ workspaceId: WORKSPACE_ID, appVersion: '1.1.0', createdAt: CREATED_AT });
  const cases = [
    ['project key', workspace => { workspace.projectsById[ITEM_ID] = validProject(); }, 'SCHEMA_MAP_KEY_ID_MISMATCH'],
    ['library key', workspace => { workspace.libraryItemsById[ITEM_ID] = { id: SECOND_ITEM_ID }; }, 'SCHEMA_MAP_KEY_ID_MISMATCH'],
    ['asset key', workspace => { workspace.assetStore.assetsById[ITEM_ID] = { assetId: SECOND_ITEM_ID }; }, 'SCHEMA_MAP_KEY_ID_MISMATCH'],
    ['duplicate collection', workspace => {
      workspace.collections.push({ id: ITEM_ID }, { collectionId: ITEM_ID });
    }, 'SCHEMA_DUPLICATE_ID'],
    ['collection future', workspace => { workspace.collections.push({ id: ITEM_ID, schemaVersion: 9 }); }, 'SCHEMA_FUTURE_VERSION_READ_ONLY'],
    ['manifest order', workspace => { workspace.workspaceManifest.updatedAt = '2020-01-01T00:00:00Z'; }, 'SCHEMA_TIMESTAMP_REGRESSION'],
    ['asset store', workspace => { workspace.assetStore = []; }, 'SCHEMA_EXPECTED_OBJECT']
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const workspace = base();
      mutate(workspace);
      assertSchemaError(() => validateWorkspace(workspace), code);
    });
  }
  const missingNestedVersion = base();
  missingNestedVersion.libraryItemsById[ITEM_ID] = { id: ITEM_ID };
  assertSchemaError(
    () => validateWorkspace(missingNestedVersion, { requireNestedSchemaVersions: true }),
    'SCHEMA_REQUIRED_FIELD_MISSING'
  );
});

test('contained path resolver accepts portable relative paths and rejects escapes', () => {
  const root = path.resolve('repository-root');
  assert.equal(resolveContainedPath(root, 'projects/item.json'), path.join(root, 'projects', 'item.json'));
  assert.equal(normalizeRelativePath('a\\b.json'), path.join('a', 'b.json'));
  for (const invalid of [
    '../escape',
    'a/../escape',
    '/absolute',
    'C:\\absolute.json',
    'C:drive-relative',
    'a//b',
    'a/./b',
    'CON',
    'file:stream',
    'trailing.',
    'trailing '
  ]) {
    assert.throws(() => resolveContainedPath(root, invalid), error => {
      assert.equal(error instanceof DurableFsError, true);
      assert.equal([ERROR_CODES.PATH_ESCAPE, ERROR_CODES.INVALID_PATH].includes(error.code), true);
      return true;
    });
  }
  assert.throws(() => resolveContainedPath('', 'file'), { code: ERROR_CODES.INVALID_PATH });
  assert.throws(() => resolveContainedPath(root, ''), { code: ERROR_CODES.INVALID_PATH });
});

test('durable write fsyncs, closes and atomically replaces before ack', async t => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, 'state.json'), 'old');
  const stages = [];
  const result = await durableWriteFile(root, 'state.json', 'new-content', {
    label: 'manifest',
    tempNameFactory: () => '.deterministic.tmp',
    faultInjector(stage, context) {
      stages.push(stage);
      assert.equal(context.label, 'manifest');
    }
  });
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), 'new-content');
  assert.equal(result.durable, true);
  assert.equal(result.byteLength, Buffer.byteLength('new-content'));
  assert.equal(result.sha256, crypto.createHash('sha256').update('new-content').digest('hex'));
  assert.equal(['filesystem-flushed', 'process-crash'].includes(result.durability), true);
  assert.equal(fs.existsSync(path.join(root, '.deterministic.tmp')), false);
  assert.deepEqual(stages, [
    FAULT_STAGES.BEFORE_TEMP_OPEN,
    FAULT_STAGES.AFTER_TEMP_OPEN,
    FAULT_STAGES.BEFORE_TEMP_WRITE,
    FAULT_STAGES.AFTER_TEMP_WRITE,
    FAULT_STAGES.BEFORE_TEMP_FSYNC,
    FAULT_STAGES.AFTER_TEMP_FSYNC,
    FAULT_STAGES.BEFORE_TEMP_CLOSE,
    FAULT_STAGES.AFTER_TEMP_CLOSE,
    FAULT_STAGES.BEFORE_ATOMIC_REPLACE,
    FAULT_STAGES.AFTER_ATOMIC_REPLACE,
    FAULT_STAGES.BEFORE_DIRECTORY_FSYNC,
    FAULT_STAGES.AFTER_DIRECTORY_FSYNC,
    FAULT_STAGES.BEFORE_DURABLE_ACK,
    FAULT_STAGES.DURABLE_ACK
  ]);
});

test('durable JSON uses canonical UTF-8 bytes and supports Uint8Array payloads', async t => {
  const root = temporaryDirectory(t);
  const jsonResult = await durableWriteJson(root, 'nested/value.json', { z: 'e\u0301\r\n', a: null });
  const expected = '{"a":null,"z":"é\\n"}\n';
  assert.equal(fs.readFileSync(path.join(root, 'nested', 'value.json'), 'utf8'), expected);
  assert.equal(jsonResult.byteLength, Buffer.byteLength(expected));
  await durableWriteFile(root, 'bytes.bin', new Uint8Array([1, 2, 3]));
  assert.deepEqual([...fs.readFileSync(path.join(root, 'bytes.bin'))], [1, 2, 3]);
  await assert.rejects(durableWriteFile(root, 'invalid.bin', { invalid: true }), {
    code: ERROR_CODES.INVALID_DATA
  });
});

test('all pre-commit fault points preserve the previous file and clean temporary data', async t => {
  const preCommitStages = [
    FAULT_STAGES.BEFORE_TEMP_OPEN,
    FAULT_STAGES.AFTER_TEMP_OPEN,
    FAULT_STAGES.BEFORE_TEMP_WRITE,
    FAULT_STAGES.AFTER_TEMP_WRITE,
    FAULT_STAGES.BEFORE_TEMP_FSYNC,
    FAULT_STAGES.AFTER_TEMP_FSYNC,
    FAULT_STAGES.BEFORE_TEMP_CLOSE,
    FAULT_STAGES.AFTER_TEMP_CLOSE,
    FAULT_STAGES.BEFORE_ATOMIC_REPLACE
  ];
  for (const injectedStage of preCommitStages) {
    await t.test(injectedStage, async t => {
      const root = temporaryDirectory(t, 'essayflow-precommit-');
      const target = path.join(root, 'state.bin');
      fs.writeFileSync(target, 'revision-n');
      await assert.rejects(durableWriteFile(root, 'state.bin', 'revision-n-plus-one', {
        tempNameFactory: () => '.fault.tmp',
        faultInjector(stage) {
          if (stage === injectedStage) return true;
          return false;
        }
      }), error => {
        assert.equal(error.code, ERROR_CODES.FAULT_INJECTED);
        assert.equal(error.committed, false);
        assert.equal(error.details.commitState, 'not-committed');
        return true;
      });
      assert.equal(fs.readFileSync(target, 'utf8'), 'revision-n');
      assert.equal(fs.existsSync(path.join(root, '.fault.tmp')), false);
    });
  }
});

test('post-commit fault points report committed-not-acknowledged and leave a complete new file', async t => {
  const postCommitStages = [
    FAULT_STAGES.AFTER_ATOMIC_REPLACE,
    FAULT_STAGES.BEFORE_DIRECTORY_FSYNC,
    FAULT_STAGES.AFTER_DIRECTORY_FSYNC,
    FAULT_STAGES.BEFORE_DURABLE_ACK,
    FAULT_STAGES.DURABLE_ACK
  ];
  for (const injectedStage of postCommitStages) {
    await t.test(injectedStage, async t => {
      const root = temporaryDirectory(t, 'essayflow-postcommit-');
      const target = path.join(root, 'state.bin');
      fs.writeFileSync(target, 'revision-n');
      await assert.rejects(durableWriteFile(root, 'state.bin', 'revision-n-plus-one', {
        tempNameFactory: () => '.fault.tmp',
        faultInjector(stage) {
          return stage === injectedStage;
        }
      }), error => {
        assert.equal(error.code, ERROR_CODES.FAULT_INJECTED);
        assert.equal(error.committed, true);
        assert.equal(error.details.commitState, 'committed-not-acknowledged');
        return true;
      });
      assert.equal(fs.readFileSync(target, 'utf8'), 'revision-n-plus-one');
      assert.equal(fs.existsSync(path.join(root, '.fault.tmp')), false);
    });
  }
});

test('OS and stage failures map to stable durable error codes', async t => {
  const cases = [
    ['ENOSPC', ERROR_CODES.NO_SPACE],
    ['EACCES', ERROR_CODES.ACCESS_DENIED],
    ['EBUSY', ERROR_CODES.FILE_LOCKED]
  ];
  for (const [osCode, stableCode] of cases) {
    const root = temporaryDirectory(t, `essayflow-${osCode.toLowerCase()}-`);
    await assert.rejects(durableWriteFile(root, 'state', 'new', {
      faultInjector(stage) {
        if (stage === FAULT_STAGES.BEFORE_TEMP_WRITE) {
          const error = new Error(osCode);
          error.code = osCode;
          throw error;
        }
      }
    }), error => {
      assert.equal(error.code, stableCode);
      assert.equal(error.details.osCode, osCode);
      return true;
    });
  }

  const root = temporaryDirectory(t, 'essayflow-stage-code-');
  await assert.rejects(durableWriteFile(root, 'state', 'new', {
    faultInjector(stage) {
      if (stage === FAULT_STAGES.BEFORE_TEMP_CLOSE) throw new Error('close failed');
    }
  }), { code: ERROR_CODES.TEMP_CLOSE_FAILED });

  const noSpaceIo = {
    async mkdir() {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    }
  };
  await assert.rejects(durableWriteFile(path.join(root, 'new-root'), 'state', 'new', { io: noSpaceIo }), {
    code: ERROR_CODES.NO_SPACE
  });
});

test('temporary file collisions never delete a pre-existing file', async t => {
  const root = temporaryDirectory(t);
  const collision = path.join(root, '.collision.tmp');
  fs.writeFileSync(collision, 'owned-by-another-writer');
  await assert.rejects(durableWriteFile(root, 'target', 'new', {
    tempNameFactory: () => '.collision.tmp'
  }), { code: ERROR_CODES.TEMP_OPEN_FAILED });
  assert.equal(fs.readFileSync(collision, 'utf8'), 'owned-by-another-writer');
  assert.equal(fs.existsSync(path.join(root, 'target')), false);
  await assert.rejects(durableWriteFile(root, 'target', 'new', {
    tempNameFactory: () => '../escape.tmp'
  }), { code: ERROR_CODES.INVALID_PATH });
  await assert.rejects(durableWriteFile(root, 'target', 'new', {
    tempNameFactory: () => 'target'
  }), { code: ERROR_CODES.PATH_ESCAPE });
  await assert.rejects(durableWriteFile(root, 'target', 'new', {
    tempNameFactory: () => 'CON'
  }), { code: ERROR_CODES.INVALID_PATH });
});

test('directory fsync reports unsupported platforms but does not hide hard failures', async () => {
  const unsupportedIo = {
    async open() {
      const error = new Error('directory handles unsupported');
      error.code = 'EISDIR';
      throw error;
    }
  };
  assert.deepEqual(await fsyncDirectory('ignored', { io: unsupportedIo }), {
    synced: false,
    supported: false,
    osCode: 'EISDIR'
  });
  await assert.rejects(fsyncDirectory('ignored', {
    io: unsupportedIo,
    allowUnsupported: false
  }), { code: 'EISDIR' });
  const permissionIo = {
    async open() {
      const error = new Error('permission denied');
      error.code = 'EPERM';
      error.syscall = 'open';
      throw error;
    }
  };
  await assert.rejects(fsyncDirectory('ignored', { io: permissionIo, platform: 'win32' }), { code: 'EPERM' });

  let closed = false;
  const supportedIo = {
    async open() {
      return {
        async sync() {},
        async close() { closed = true; }
      };
    }
  };
  assert.deepEqual(await fsyncDirectory('ignored', { io: supportedIo }), {
    synced: true,
    supported: true,
    osCode: null
  });
  assert.equal(closed, true);
});

test('durable writer rejects directories and symlink/junction escapes', async t => {
  const root = temporaryDirectory(t);
  fs.mkdirSync(path.join(root, 'target-directory'));
  await assert.rejects(durableWriteFile(root, 'target-directory', 'new'), {
    code: ERROR_CODES.TARGET_NOT_FILE
  });
  fs.writeFileSync(path.join(root, 'parent-file'), 'not a directory');
  await assert.rejects(durableWriteFile(root, 'parent-file/child', 'new'), {
    code: ERROR_CODES.NOT_DIRECTORY
  });

  const outside = temporaryDirectory(t, 'essayflow-outside-');
  const link = path.join(root, 'escape-link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic(`Symlink/junction creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(durableWriteFile(root, 'escape-link/file', 'new'), {
    code: ERROR_CODES.SYMBOLIC_LINK
  });
  assert.equal(fs.existsSync(path.join(outside, 'file')), false);
});
