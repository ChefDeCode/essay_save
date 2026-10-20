'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');
const {
  ARCHIVE_SCHEMA_VERSION,
  ERROR_CODES,
  PACKAGE_KINDS,
  ArchiveService,
  assertNoSecretFields,
  collectUuidStrings,
  normalizeLibraryPayload,
  remapDeep,
  sourceBuffer
} = require('../../src/main/data/archive-service');
const { AssetStore } = require('../../src/main/data/asset-store');
const { semanticHash } = require('../../src/main/data/canonical');
const { ProjectRepository } = require('../../src/main/data/repository');
const { SettingsStore } = require('../../src/main/data/settings-store');

function temporaryDirectory(t, label = 'essayflow-archive-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function monotonicClock(start = '2026-07-16T08:00:00.000Z') {
  let epoch = Date.parse(start);
  return () => new Date(epoch++);
}

function uuid() {
  return crypto.randomUUID();
}

function clone(value) {
  return structuredClone(value);
}

class MemoryLibraryStore {
  constructor(payload = null, options = {}) {
    this.payload = normalizeLibraryPayload(payload);
    this.failImport = options.failImport === true;
    this.importCalls = [];
  }

  exportForBackup() {
    return clone(this.payload);
  }

  importFromBackup(payload, options = {}) {
    this.importCalls.push(clone(options));
    if (this.failImport && options.replaceAll !== true) throw new Error('injected library failure');
    const incoming = normalizeLibraryPayload(payload);
    if (options.replaceAll) {
      this.payload = incoming;
      return { replaced: true };
    }
    const merged = clone(this.payload);
    for (const [id, item] of Object.entries(incoming.libraryItemsById)) {
      const action = options.actions?.[id] || (merged.libraryItemsById[id] ? 'overwrite' : 'create');
      if (action === 'skip') continue;
      merged.libraryItemsById[id] = clone(item);
    }
    merged.collections = clone(incoming.collections);
    this.payload = normalizeLibraryPayload(merged);
    return { imported: Object.keys(incoming.libraryItemsById).length };
  }
}

function createWorkspace(t, label, options = {}) {
  const root = temporaryDirectory(t, `${label}-`);
  const repositoryRoot = path.join(root, 'workspace');
  const assetRoot = path.join(root, 'assets');
  const settingsRoot = path.join(root, 'settings');
  const now = options.now || monotonicClock();
  const assetStore = new AssetStore(assetRoot, { now });
  const repository = new ProjectRepository({ rootPath: repositoryRoot, assetStore, now });
  const settingsStore = new SettingsStore(settingsRoot);
  const libraryStore = options.libraryStore || new MemoryLibraryStore();
  const service = new ArchiveService({
    repository,
    assetStore,
    settingsStore,
    libraryStore,
    workspaceId: options.workspaceId || uuid(),
    productVersion: '1.1.0-test',
    now,
    stagingRoot: path.join(root, 'staging'),
    availableDiskBytes: 20 * 1024 * 1024 * 1024,
    faultInjector: options.faultInjector
  });
  return { root, repositoryRoot, assetRoot, settingsRoot, repository, assetStore, settingsStore, libraryStore, service };
}

async function seedFullProject(workspace, options = {}) {
  const asset = await workspace.assetStore.putBuffer({
    buffer: Buffer.from('%PDF-1.7\nsynthetic archive fixture'),
    mimeType: 'application/pdf',
    kind: 'pdf',
    originalName: 'evidence.pdf'
  });
  const projectId = options.projectId || uuid();
  const libraryItemId = options.libraryItemId || uuid();
  workspace.libraryStore.payload = normalizeLibraryPayload({
    schemaVersion: 1,
    libraryItemsById: {
      [libraryItemId]: { id: libraryItemId, title: 'Archive paper', doi: '10.1000/archive' }
    },
    collections: []
  });
  const created = await workspace.repository.createProject({
    projectId,
    title: '完整项目包',
    author: '测试者',
    html: '<p>initial</p>'
  });
  const aggregate = await workspace.repository.loadProject(projectId);
  const citationItemId = uuid();
  const citationLinkId = uuid();
  const evidenceId = uuid();
  const evidenceRevisionId = uuid();
  const reviewEventId = uuid();
  const threadId = uuid();
  const groundedAnswerId = uuid();
  const reviewIssueId = uuid();
  const auditEventId = uuid();
  const auditBlobId = uuid();
  const paperStateId = uuid();
  const matrixId = uuid();
  const capturedAt = aggregate.manifest.updatedAt;
  const quoteText = 'synthetic archive quote';
  const quoteHash = crypto.createHash('sha256').update(quoteText).digest('hex');
  const pageTextHash = crypto.createHash('sha256').update(`Context before ${quoteText} context after`).digest('hex');
  aggregate.document.html = `<h1>完整项目包</h1><p data-citation-instance-id="${citationLinkId}">正文 [1]</p>`;
  aggregate.citationItems.push({
    schemaVersion: 1,
    id: citationItemId,
    citationItemId,
    projectId,
    libraryItemId,
    type: 'article-journal',
    title: 'Archive paper',
    capturedAt
  });
  aggregate.citationLinks.push({
    schemaVersion: 1,
    id: citationLinkId,
    projectId,
    insertionMode: 'quote',
    items: [{
      citationItemEntryId: uuid(),
      citationItemId,
      evidenceRevisionIds: [evidenceRevisionId],
      sourceCitationSnapshots: [{
        citationItemId,
        title: 'Archive paper',
        assetId: asset.assetId,
        fileSha256: asset.sha256,
        pageIndex: 0,
        pageLabel: 'PDF 第 1 页',
        rawQuoteSha256: quoteHash,
        quoteText,
        capturedAt
      }],
      locator: '1',
      label: 'page',
      suppressAuthor: false,
      order: 0,
      status: 'active'
    }],
    createdAt: capturedAt,
    updatedAt: capturedAt
  });
  aggregate.evidenceCards.push({
    schemaVersion: 1,
    id: evidenceId,
    projectId,
    currentRevisionId: evidenceRevisionId,
    note: 'Archive evidence note',
    tags: ['fixture'],
    color: '#d5a623',
    researchQuestionIds: [],
    status: 'active',
    createdAt: capturedAt,
    updatedAt: capturedAt
  });
  aggregate.evidenceRevisions.push({
    schemaVersion: 1,
    id: evidenceRevisionId,
    evidenceId,
    revisionNumber: 1,
    citationItemId,
    libraryItemId,
    sourceSnapshot: {
      assetId: asset.assetId,
      fileSha256: asset.sha256,
      title: 'Archive paper',
      doi: '10.1000/archive',
      metadataSource: 'manual'
    },
    locator: {
      pageIndex: 0,
      pageLabel: 'PDF 第 1 页',
      quoteRaw: quoteText,
      quoteDisplay: quoteText,
      rawQuoteSha256: quoteHash,
      displayQuoteSha256: quoteHash,
      pageTextSha256: pageTextHash,
      prefix: 'Context before',
      suffix: 'context after',
      occurrenceIndex: 0,
      rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.05 }],
      pageRotation: 0,
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      extractorName: 'pdfjs',
      extractorVersion: '3.11.174',
      transformVersion: '1',
      normalization: 'whitespace-collapse',
      extraction: 'pdf-text'
    },
    createdBy: 'user',
    createdAt: capturedAt
  });
  aggregate.evidenceReviewEvents.push({
    schemaVersion: 1,
    id: reviewEventId,
    projectId,
    evidenceId,
    evidenceRevisionId,
    sequence: 1,
    previousReviewEventId: null,
    status: 'confirmed',
    actor: 'user',
    createdAt: capturedAt
  });
  aggregate.aiThreads.push({ id: threadId, projectId, title: 'Thread' });
  aggregate.groundedAnswers.push({ id: groundedAnswerId, projectId, threadId, evidenceRevisionId });
  aggregate.reviewIssues.push({ id: reviewIssueId, projectId, citationLinkId });
  aggregate.auditEvents.push({ eventId: auditEventId, projectId, eventType: 'ai-result', sequence: 1 });
  aggregate.auditContentBlobs.push({ blobId: auditBlobId, projectId, ownerEventId: auditEventId, content: 'retained' });
  aggregate.projectPaperStates.push({
    schemaVersion: 1,
    id: paperStateId,
    projectId,
    citationItemId,
    screeningStatus: 'included',
    readingStatus: 'read',
    projectNotes: '',
    createdAt: capturedAt,
    updatedAt: capturedAt
  });
  const matrixColumnId = uuid();
  const matrixRowId = uuid();
  aggregate.reviewMatrices.push({
    schemaVersion: 1,
    id: matrixId,
    projectId,
    name: '归档矩阵',
    columns: [{ id: matrixColumnId, key: 'author', label: '作者', order: 0, userDefined: false }],
    rows: [{
      id: matrixRowId,
      citationItemId,
      taskStatus: 'completed',
      attempt: 0,
      cells: {
        [matrixColumnId]: {
          schemaVersion: 1,
          id: uuid(),
          columnId: matrixColumnId,
          citationItemId,
          value: 'Test Author',
          origin: 'user',
          reviewStatus: 'confirmed',
          userEdited: false,
          basis: 'manual',
          sourceRefs: [],
          createdAt: capturedAt,
          updatedAt: capturedAt
        }
      },
      createdAt: capturedAt,
      updatedAt: capturedAt
    }],
    createdAt: capturedAt,
    updatedAt: capturedAt
  });
  aggregate.assetRefs.push({ assetId: asset.assetId, sha256: asset.sha256 });
  const saved = await workspace.repository.saveProject({
    projectId,
    baseRevision: created.revision,
    aggregate,
    source: 'archive-fixture'
  });
  const checkpoint = await workspace.repository.createCheckpoint({
    projectId,
    baseRevision: saved.revision,
    source: 'manual',
    manual: true
  });
  return {
    projectId,
    libraryItemId,
    asset,
    ids: {
      citationItemId,
      citationLinkId,
      evidenceId,
      evidenceRevisionId,
      reviewEventId,
      threadId,
      groundedAnswerId,
      reviewIssueId,
      auditEventId,
      auditBlobId,
      paperStateId,
      matrixId,
      versionId: checkpoint.version.id
    },
    aggregate: await workspace.repository.loadProject(projectId)
  };
}

async function rewriteZip(buffer, mutate, options = {}) {
  const zip = await JSZip.loadAsync(buffer);
  await mutate(zip);
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: options.compression || 'STORE',
    platform: options.platform || 'UNIX'
  });
}

test('single project package round-trips aggregate, history, audit, library and asset hashes', async t => {
  const source = createWorkspace(t, 'archive-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  assert.equal(exported.kind, PACKAGE_KINDS.PROJECT);
  assert.equal(exported.manifest.schemaVersion, ARCHIVE_SCHEMA_VERSION);
  assert.equal(exported.manifest.counts.projects, 1);
  assert.equal(exported.manifest.counts.libraryItems, 1);
  assert.equal(exported.manifest.counts.assets, 1);
  assert.equal(exported.manifest.projects[0].versions.length, 1);
  assert.equal(exported.manifest.optionalMissingAssets.length, 0);

  const target = createWorkspace(t, 'archive-target');
  const preflight = await target.service.inspectArchive(exported.buffer);
  assert.equal(preflight.status, 'ready');
  assert.equal(preflight.commitAllowed, true);
  assert.equal(preflight.projectCount, 1);
  assert.equal(preflight.libraryCount, 1);
  assert.equal(preflight.resourceCount, 1);
  assert.equal(preflight.conflicts.length, 0);
  const imported = await target.service.importArchive(preflight.inspectionId, { strategy: 'keep-both' });
  assert.equal(imported.status, 'imported');
  assert.equal(imported.businessWritesPerformed, true);
  assert.equal(imported.projectCount, 1);

  const restored = await target.repository.loadProject(fixture.projectId);
  assert.equal(semanticHash(restored), semanticHash(fixture.aggregate));
  assert.equal(restored.document.html, fixture.aggregate.document.html);
  assert.equal(restored.auditEvents.length, 1);
  assert.equal(restored.auditContentBlobs[0].content, 'retained');
  assert.deepEqual(await target.repository.listVersions(fixture.projectId), await source.repository.listVersions(fixture.projectId));
  assert.deepEqual(target.assetStore.getDescriptor(fixture.asset.assetId), fixture.asset);
  assert.equal(target.assetStore.readBuffer(fixture.asset.assetId).buffer.toString(), '%PDF-1.7\nsynthetic archive fixture');
  assert.equal(target.libraryStore.payload.libraryItemsById[fixture.libraryItemId].title, 'Archive paper');
});

test('workspace backup includes exportable settings, excludes credentials and can omit optional blobs', async t => {
  const source = createWorkspace(t, 'backup-source');
  const fixture = await seedFullProject(source);
  await source.settingsStore.replace({
    theme: 'dark',
    defaultReferenceStyle: 'GB/T 7714',
    providerId: 'custom',
    providerOrigin: 'https://example.test',
    model: 'fixture-model',
    featureToggles: { aiSearch: true }
  });
  const targetPath = path.join(source.root, 'out', 'workspace.essayflow');
  const exported = await source.service.exportWorkspace({ includeAssets: false, targetPath });
  assert.equal(exported.kind, PACKAGE_KINDS.WORKSPACE);
  assert.equal(fs.readFileSync(targetPath).equals(exported.buffer), true);
  assert.equal(exported.manifest.settings.credentialStatus, 'needs-reentry');
  assert.deepEqual(exported.manifest.optionalMissingAssets.map(item => item.assetId), [fixture.asset.assetId]);
  const archiveText = exported.buffer.toString('latin1').toLowerCase();
  assert.equal(archiveText.includes('authorization'), false);
  assert.equal(archiveText.includes('api_key'), false);

  const target = createWorkspace(t, 'backup-target');
  const inspected = await target.service.inspectArchive(targetPath);
  assert.equal(inspected.optionalMissingAssets.length, 1);
  await target.service.importArchive(inspected.inspectionId, { strategy: 'overwrite' });
  assert.equal((await target.repository.loadProject(fixture.projectId)).document.html, fixture.aggregate.document.html);
  assert.equal(target.settingsStore.readSync().theme, 'dark');
  assert.equal(target.settingsStore.readSync().providerId, 'custom');
  assert.equal(target.assetStore.getDescriptor(fixture.asset.assetId).sha256, fixture.asset.sha256);
  assert.throws(() => target.assetStore.readBuffer(fixture.asset.assetId), /缺失/);
});

test('cancel after preflight performs zero business writes and releases no partial project', async t => {
  const source = createWorkspace(t, 'cancel-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const target = createWorkspace(t, 'cancel-target');
  const inspected = await target.service.inspectArchive(exported.buffer);
  const canceled = target.service.cancelImport(inspected.inspectionId, '用户取消');
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.businessWritesPerformed, false);
  const result = await target.service.importArchive(inspected.inspectionId);
  assert.equal(result.status, 'canceled');
  assert.equal(result.businessWritesPerformed, false);
  assert.deepEqual(await target.repository.listProjects({ includeTrashed: true }), []);
  assert.deepEqual(target.assetStore.listDescriptors(), []);
  assert.deepEqual(target.libraryStore.payload.libraryItemsById, {});
  assert.equal(target.service.discardInspection(inspected.inspectionId), true);
});

test('AbortSignal cancellation during staging never reaches the business stores', async t => {
  const source = createWorkspace(t, 'abort-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const target = createWorkspace(t, 'abort-target');
  const inspected = await target.service.inspectArchive(exported.buffer);
  const controller = new AbortController();
  controller.abort();
  const result = await target.service.importArchive(inspected.inspectionId, { signal: controller.signal });
  assert.equal(result.status, 'canceled');
  assert.equal(result.businessWritesPerformed, false);
  assert.equal((await target.repository.listProjects()).length, 0);
});

test('keep-both deeply remaps project IDs, all internal UUIDs, foreign keys and embedded HTML IDs', async t => {
  const source = createWorkspace(t, 'remap-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const target = createWorkspace(t, 'remap-target');
  await target.repository.createProject({ projectId: fixture.projectId, title: 'existing conflict' });
  target.libraryStore.payload = normalizeLibraryPayload({
    schemaVersion: 1,
    libraryItemsById: {
      [fixture.libraryItemId]: { id: fixture.libraryItemId, title: 'different existing item' }
    },
    collections: []
  });
  const inspected = await target.service.inspectArchive(exported.buffer);
  assert.deepEqual(inspected.conflicts.map(item => item.type).sort(), ['library', 'project']);
  const imported = await target.service.importArchive(inspected.inspectionId, { strategy: 'keep-both' });
  const remap = imported.remaps[0];
  assert.notEqual(remap.targetProjectId, fixture.projectId);
  assert.equal(Object.keys(remap.idMap).length > 10, true);
  for (const id of Object.values(fixture.ids)) {
    assert.notEqual(remap.idMap[id], undefined, `missing internal remap for ${id}`);
  }
  assert.equal(remap.idMap[fixture.asset.assetId], undefined, 'content-addressed asset IDs must remain stable');

  const restored = await target.repository.loadProject(remap.targetProjectId);
  assert.equal(restored.manifest.projectId, remap.targetProjectId);
  assert.ok(restored.document.html.includes(remap.idMap[fixture.ids.citationLinkId]));
  assert.equal(restored.document.html.includes(fixture.ids.citationLinkId), false);
  assert.equal(restored.citationLinks[0].items[0].citationItemId, remap.idMap[fixture.ids.citationItemId]);
  assert.equal(restored.evidenceCards[0].currentRevisionId, remap.idMap[fixture.ids.evidenceRevisionId]);
  assert.equal(restored.evidenceRevisions[0].sourceSnapshot.assetId, fixture.asset.assetId);
  assert.notEqual(restored.citationItems[0].libraryItemId, fixture.libraryItemId);
  assert.equal(target.libraryStore.payload.libraryItemsById[restored.citationItems[0].libraryItemId].title, 'Archive paper');
  assert.equal((await target.repository.listProjects()).length, 2);
});

test('skip leaves an existing conflict unchanged while overwrite replaces it as a new local revision', async t => {
  const source = createWorkspace(t, 'strategy-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);

  const skipped = createWorkspace(t, 'strategy-skip');
  await skipped.repository.createProject({ projectId: fixture.projectId, title: 'keep me', html: '<p>old</p>' });
  let inspected = await skipped.service.inspectArchive(exported.buffer);
  const skipResult = await skipped.service.importArchive(inspected.inspectionId, { strategy: 'skip' });
  assert.equal(skipResult.projectCount, 0);
  assert.equal(skipResult.businessWritesPerformed, false);
  assert.equal((await skipped.repository.loadProject(fixture.projectId)).document.html, '<p>old</p>');
  assert.equal(skipped.assetStore.listDescriptors().length, 0);
  assert.equal(Object.keys(skipped.libraryStore.payload.libraryItemsById).length, 0);

  const overwritten = createWorkspace(t, 'strategy-overwrite');
  await overwritten.repository.createProject({ projectId: fixture.projectId, title: 'replace me', html: '<p>old</p>' });
  inspected = await overwritten.service.inspectArchive(exported.buffer);
  await overwritten.service.importArchive(inspected.inspectionId, { strategy: 'overwrite' });
  const aggregate = await overwritten.repository.loadProject(fixture.projectId);
  assert.equal(aggregate.document.html, fixture.aggregate.document.html);
  assert.equal(aggregate.manifest.revision, 1);
});

test('an existing content-identical asset is reused even when descriptive metadata differs', async t => {
  const source = createWorkspace(t, 'asset-reuse-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const target = createWorkspace(t, 'asset-reuse-target');
  const existing = await target.assetStore.putBuffer({
    buffer: Buffer.from('%PDF-1.7\nsynthetic archive fixture'),
    mimeType: 'application/octet-stream',
    kind: 'attachment',
    originalName: 'different-name.bin'
  });
  assert.equal(existing.assetId, fixture.asset.assetId);
  assert.notDeepEqual(existing, fixture.asset);
  const inspected = await target.service.inspectArchive(exported.buffer);
  await target.service.importArchive(inspected.inspectionId);
  assert.equal((await target.repository.loadProject(fixture.projectId)).assetRefs[0].assetId, existing.assetId);
  assert.deepEqual(target.assetStore.getDescriptor(existing.assetId), existing);
});

test('a failure after project commit restores project, library, settings and asset stores', async t => {
  const source = createWorkspace(t, 'rollback-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportWorkspace();
  const failingLibrary = new MemoryLibraryStore(null, { failImport: true });
  const target = createWorkspace(t, 'rollback-target', { libraryStore: failingLibrary });
  const initialSettings = await target.settingsStore.exportForBackup();
  const inspected = await target.service.inspectArchive(exported.buffer);
  await assert.rejects(
    target.service.importArchive(inspected.inspectionId, { strategy: 'overwrite' }),
    error => error.code === ERROR_CODES.COMMIT_FAILED && error.details.rolledBack === true
  );
  assert.deepEqual(await target.repository.listProjects({ includeTrashed: true }), []);
  assert.deepEqual(target.assetStore.listDescriptors(), []);
  assert.deepEqual(await target.settingsStore.exportForBackup(), initialSettings);
  assert.deepEqual(target.libraryStore.payload.libraryItemsById, {});
  assert.equal(fs.existsSync(path.join(target.repositoryRoot, 'projects', fixture.projectId)), false);
});

test('checksum mismatch fails in staging before any business write', async t => {
  const source = createWorkspace(t, 'checksum-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const aggregatePath = exported.manifest.projects[0].aggregatePath;
  const tampered = await rewriteZip(exported.buffer, async zip => {
    const aggregate = JSON.parse(await zip.file(aggregatePath).async('string'));
    aggregate.document.html = '<p>tampered without checksum update</p>';
    zip.file(aggregatePath, JSON.stringify(aggregate));
  });
  const target = createWorkspace(t, 'checksum-target');
  const inspected = await target.service.inspectArchive(tampered);
  await assert.rejects(
    target.service.importArchive(inspected.inspectionId),
    error => error.code === ERROR_CODES.CHECKSUM_MISMATCH
  );
  assert.equal((await target.repository.listProjects()).length, 0);
  assert.equal(target.assetStore.listDescriptors().length, 0);
});

test('future archive schema is inspectable but read-only', async t => {
  const source = createWorkspace(t, 'future-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const future = await rewriteZip(exported.buffer, async zip => {
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    manifest.schemaVersion = 99;
    zip.file('manifest.json', JSON.stringify(manifest));
  });
  const target = createWorkspace(t, 'future-target');
  const inspected = await target.service.inspectArchive(future);
  assert.equal(inspected.status, 'read-only');
  assert.equal(inspected.readOnly, true);
  assert.equal(inspected.commitAllowed, false);
  await assert.rejects(
    target.service.importArchive(inspected.inspectionId),
    error => error.code === ERROR_CODES.IMPORT_READ_ONLY && error.readOnly
  );
  assert.equal((await target.repository.listProjects()).length, 0);
});

test('ZIP traversal, Unix symlink and compression bomb metadata are rejected before staging', async t => {
  const target = createWorkspace(t, 'malicious-target');

  const traversalZip = new JSZip();
  traversalZip.file('manifest.json', '{}');
  traversalZip.file('../escape.json', 'owned');
  const traversal = await traversalZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  await assert.rejects(target.service.inspectArchive(traversal), error =>
    ['ARCHIVE_PATH_TRAVERSAL', ERROR_CODES.ZIP_INVALID].includes(error.code));

  const symlinkZip = new JSZip();
  symlinkZip.file('manifest.json', '{}');
  symlinkZip.file('link', 'target', { unixPermissions: 0o120777 });
  const symlink = await symlinkZip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' });
  await assert.rejects(target.service.inspectArchive(symlink), error => error.code === 'ARCHIVE_LINK_ENTRY');

  const bombZip = new JSZip();
  bombZip.file('manifest.json', '{}');
  bombZip.file('bomb.bin', Buffer.alloc(2 * 1024 * 1024, 65));
  const bomb = await bombZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await assert.rejects(target.service.inspectArchive(bomb), error => error.code === 'ARCHIVE_COMPRESSION_RATIO_EXCEEDED');
  assert.equal((await target.repository.listProjects()).length, 0);
});

test('undeclared files, bad disk estimate and invalid manifest hash fail closed', async t => {
  const source = createWorkspace(t, 'closed-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const target = createWorkspace(t, 'closed-target');

  const undeclared = await rewriteZip(exported.buffer, async zip => zip.file('extra.txt', 'not declared'));
  await assert.rejects(target.service.inspectArchive(undeclared), error => error.code === ERROR_CODES.UNDECLARED_ENTRY);

  await assert.rejects(
    target.service.inspectArchive(exported.buffer, { availableDiskBytes: 1 }),
    error => error.code === 'ARCHIVE_DISK_SPACE_INSUFFICIENT'
  );

  const badManifest = await rewriteZip(exported.buffer, async zip => {
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    manifest.productVersion = 'changed-without-payload-hash';
    manifest.packageVersion = manifest.productVersion;
    zip.file('manifest.json', JSON.stringify(manifest));
  });
  await assert.rejects(target.service.inspectArchive(badManifest), error => error.code === ERROR_CODES.CHECKSUM_MISMATCH);
});

test('secret guard, source guard and pure remap helpers reject unsafe values', async t => {
  assert.throws(() => assertNoSecretFields({ nested: { apiKey: 'secret' } }), error =>
    error.code === ERROR_CODES.SECRET_DETECTED && error.details.path === '$.nested.apiKey');
  assert.doesNotThrow(() => assertNoSecretFields({ credentialStatus: 'needs-reentry' }));
  assert.throws(() => normalizeLibraryPayload({ schemaVersion: 1, libraryItemsById: [], collections: [] }), /libraryItemsById/);
  assert.throws(() => normalizeLibraryPayload({ schemaVersion: 2, libraryItemsById: {}, collections: [] }), error => error.readOnly);

  const first = uuid();
  const second = uuid();
  const value = { [first]: { id: first, html: `<span data-id="${first}">${first}</span>` } };
  assert.deepEqual([...collectUuidStrings(value)], [first]);
  const mapped = remapDeep(value, new Map([[first, second]]));
  assert.equal(mapped[second].id, second);
  assert.equal(mapped[second].html.includes(first), false);
  assert.equal(mapped[second].html.match(new RegExp(second, 'g')).length, 2);

  assert.throws(() => sourceBuffer(null), /Buffer/);
  const directory = temporaryDirectory(t, 'archive-source-guard-');
  assert.throws(() => sourceBuffer(directory), error => error.code === ERROR_CODES.SOURCE_UNSAFE);
  const regular = path.join(directory, 'archive.bin');
  fs.writeFileSync(regular, 'zip-ish');
  assert.equal(sourceBuffer(regular).toString(), 'zip-ish');
});

test('inspection lifecycle rejects unknown IDs and invalid conflict strategies', async t => {
  const source = createWorkspace(t, 'lifecycle-source');
  const fixture = await seedFullProject(source);
  const exported = await source.service.exportProject(fixture.projectId);
  const target = createWorkspace(t, 'lifecycle-target');
  const missing = uuid();
  assert.throws(() => target.service.cancelImport(missing), error => error.code === ERROR_CODES.INSPECTION_NOT_FOUND);
  const inspected = await target.service.inspectArchive(exported.buffer);
  await assert.rejects(
    target.service.importArchive(inspected.inspectionId, { strategy: 'merge-magically' }),
    error => error.code === ERROR_CODES.CONFLICT_STRATEGY_INVALID
  );
  assert.equal((await target.repository.listProjects()).length, 0);
  assert.equal(target.service.discardInspection(inspected.inspectionId), true);
  assert.equal(target.service.discardInspection(inspected.inspectionId), false);
});
