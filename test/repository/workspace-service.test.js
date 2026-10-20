'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspaceService } = require('../../src/main/data/workspace-service');

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

function fixture(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-workspace-service-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let tick = 0;
  const service = new WorkspaceService({
    userDataPath,
    appVersion: '1.1.0-test',
    safeStorage: createSafeStorage(),
    now: () => new Date(Date.parse('2026-07-16T00:00:00.000Z') + tick++ * 1000)
  });
  return { userDataPath, service };
}

const projectId = 'a0000000-0000-4000-8000-000000000001';

test('bootstrap, renderer DTO save and load keep document, meta and citations in one revision', async t => {
  const { userDataPath, service } = fixture(t);
  const bootstrap = await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  assert.equal(bootstrap.migration.migrated, true);
  assert.equal((await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] })).migration.migrationId,
    bootstrap.migration.migrationId);

  const created = await service.saveProject({
    id: projectId,
    baseRevision: -1,
    title: '聚合写入',
    content: '<h1>聚合写入</h1><p>正文</p>',
    meta: { author: '作者', course: '课程', referenceStyle: 'APA' },
    citations: [{
      paperId: 'legacy-paper-a',
      number: 1,
      paper: { id: 'legacy-paper-a', title: 'Traceable source', doi: '10.1000/example', authors: ['A'] }
    }]
  });
  assert.equal(created.success, true);
  assert.equal(created.durable, true);
  assert.equal(created.journalState, 'COMPLETE');
  assert.equal(created.revision, 0);

  const loaded = await service.loadProject(projectId);
  assert.equal(loaded.content, '<h1>聚合写入</h1><p>正文</p>');
  assert.equal(loaded.meta.author, '作者');
  assert.equal(loaded.meta.course, '课程');
  assert.equal(loaded.citations.length, 1);
  assert.equal(loaded.citations[0].paperId, 'legacy-paper-a');
  assert.equal(loaded.aggregate.manifest.revision, loaded.revision);
  assert.equal(loaded.aggregate.citationItems[0].projectId, projectId);
  assert.equal(loaded.aggregate.citationLinks[0].projectId, projectId);
  assert.equal(fs.existsSync(path.join(userDataPath, 'projects', `${projectId}.html`)), false);

  const saved = await service.saveProject({
    id: projectId,
    baseRevision: 0,
    content: '<h1>聚合写入</h1><p>新正文</p>',
    meta: { ...loaded.meta, title: '新标题' },
    citations: loaded.citations
  });
  assert.equal(saved.revision, 1);
  const reloaded = await service.loadProject(projectId);
  assert.equal(reloaded.meta.title, '新标题');
  assert.match(reloaded.content, /新正文/);
  assert.equal(reloaded.citations[0].paper.title, 'Traceable source');
  await assert.rejects(service.saveProject({
    id: projectId,
    baseRevision: 0,
    content: '<p>stale</p>',
    citations: []
  }), error => error.code === 'WORKSPACE_REVISION_CONFLICT');
});

test('project rename is durable, revision checked and preserves the aggregate', async t => {
  const { service } = fixture(t);
  await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  const created = await service.saveProject({
    id: projectId,
    baseRevision: -1,
    title: '重命名前',
    content: '<h1>正文中的独立标题</h1><p>不可丢失的正文</p>',
    meta: { author: '作者', referenceStyle: 'MLA' },
    citations: [{
      paperId: 'rename-paper',
      number: 1,
      paper: { id: 'rename-paper', title: '保留的引用', authors: ['A'] }
    }]
  });

  const renamed = await service.renameProject({
    projectId,
    baseRevision: created.revision,
    title: '  重命名后  '
  });
  assert.equal(renamed.success, true);
  assert.equal(renamed.durable, true);
  assert.equal(renamed.title, '重命名后');
  assert.equal(renamed.revision, created.revision + 1);

  const loaded = await service.loadProject(projectId);
  assert.equal(loaded.meta.title, '重命名后');
  assert.match(loaded.content, /正文中的独立标题/);
  assert.match(loaded.content, /不可丢失的正文/);
  assert.equal(loaded.citations[0].paper.title, '保留的引用');
  await assert.rejects(
    service.renameProject({ projectId, baseRevision: created.revision, title: '过期写入' }),
    error => error.code === 'ERR_REPOSITORY_REVISION_CONFLICT'
  );
  await assert.rejects(
    service.renameProject({ projectId, baseRevision: renamed.revision, title: '   ' }),
    error => error.code === 'WORKSPACE_INVALID_ARGUMENT'
  );
});

test('library, settings, credentials and assets use their managed stores', async t => {
  const { userDataPath, service } = fixture(t);
  await service.bootstrapLegacy({
    localStorage: {
      essay_theme: 'dark',
      essay_default_reference_style: 'GB/T'
    },
    indexedDbLibrary: []
  });
  assert.equal(service.readSettings().theme, 'dark');
  assert.equal(service.readSettings().defaultReferenceStyle, 'GB/T');

  const baseLibraryRevision = service.librarySnapshot().revision;
  const library = await service.replaceLibrary({
    baseRevision: baseLibraryRevision,
    items: [{ id: 'paper-legacy', title: '文库记录', authors: ['王明'], doi: '10.1000/library' }]
  });
  assert.equal(library.revision, baseLibraryRevision + 1);
  assert.equal(library.items[0].id, 'paper-legacy');
  assert.equal(service.librarySnapshot().items[0].title, '文库记录');

  const credential = await service.setCredential('custom', 'sk-synthetic-only');
  assert.equal(credential.credentialStatus, 'configured');
  assert.equal(service.credentialStatus('custom'), 'configured');
  const settingsText = fs.readFileSync(path.join(userDataPath, 'workspace', 'settings', 'exportable-settings.json'), 'utf8');
  assert.equal(settingsText.includes('sk-synthetic-only'), false);
  const credentialText = fs.readFileSync(path.join(userDataPath, 'secure', 'credentials', 'provider-credentials.json'), 'utf8');
  assert.equal(credentialText.includes('sk-synthetic-only'), false);

  const asset = await service.putAsset({
    base64: Buffer.from('managed bytes').toString('base64'),
    kind: 'attachment',
    mimeType: 'text/plain',
    originalName: 'managed.txt'
  });
  assert.equal(service.readAsset(asset.assetId).buffer.toString(), 'managed bytes');
});

test('renderer library replacement preserves an existing standard-import UUID', async t => {
  const { service } = fixture(t);
  await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  const libraryItemId = 'b0000000-0000-4000-8000-000000000099';
  await service.libraryStore.upsertItem({
    libraryItemId,
    type: 'article-journal',
    title: 'Imported identity',
    author: [{ literal: '研究机构' }],
    issued: { 'date-parts': [[2026]] },
    metadataProvenance: { source: 'imported', originalFormat: 'csl-json' }
  }, { baseRevision: service.libraryStore.revision });
  const snapshot = service.librarySnapshot();
  await service.replaceLibrary({ baseRevision: snapshot.revision, items: snapshot.items, collections: snapshot.collections });
  assert.equal(service.libraryStore.listItems()[0].libraryItemId, libraryItemId);
});

test('versions, archive round-trip preflight and trash delegate to the repository boundary', async t => {
  const { service } = fixture(t);
  await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  await service.saveProject({
    id: projectId,
    baseRevision: -1,
    content: '<h1>History</h1><p>v1</p>',
    title: 'History',
    citations: []
  });
  const checkpoint = await service.createCheckpoint({
    projectId,
    baseRevision: 0,
    source: 'manual-checkpoint',
    manual: true
  });
  assert.equal(checkpoint.created, true);
  const versions = await service.listVersions(projectId);
  assert.equal(versions.length, 1);
  const preview = await service.previewVersion(projectId, versions[0].id);
  assert.equal(preview.projectId, projectId);

  const exported = await service.archiveService().exportProject(projectId);
  assert.ok(Buffer.isBuffer(exported.buffer));
  const inspected = await service.archiveService().inspectArchive(exported.buffer);
  assert.equal(inspected.projectCount, 1);
  service.archiveService().discardInspection(inspected.inspectionId);

  const impact = await service.trashImpact(projectId);
  assert.equal(impact.projectId, projectId);
  await service.moveToTrash({ projectId, baseRevision: checkpoint.revision });
  assert.equal((await service.listTrash()).length, 1);
  await service.restoreFromTrash({ projectId, baseRevision: checkpoint.revision + 1 });
  assert.equal((await service.listProjects()).length, 1);
});

test('modern citation clusters persist stable instances, item order and locators atomically', async t => {
  const { service } = fixture(t);
  await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  const linkId = 'b0000000-0000-4000-8000-000000000001';
  const itemA = 'b0000000-0000-4000-8000-000000000002';
  const itemB = 'b0000000-0000-4000-8000-000000000003';
  const created = await service.saveProject({
    id: projectId,
    baseRevision: -1,
    content: `<p>正文 <sup data-citation-instance-id="${linkId}">(Wang, 2025)</sup></p>`,
    citations: [{
      citationInstanceId: linkId,
      insertionMode: 'citation-only',
      items: [
        {
          citationItemEntryId: 'b0000000-0000-4000-8000-000000000004',
          citationItemId: itemA,
          paper: { title: '中文文献', authors: '王伟', published: '2025', doi: '10.5555/modern-a' },
          locator: '12',
          label: 'page',
          prefix: '参见 ',
          order: 0
        },
        {
          citationItemEntryId: 'b0000000-0000-4000-8000-000000000005',
          citationItemId: itemB,
          paper: { title: 'English source', author: [{ family: 'Smith', given: 'Alice' }], year: 2024 },
          suppressAuthor: true,
          order: 1
        }
      ]
    }]
  });
  assert.equal(created.revision, 0);
  const loaded = await service.loadProject(projectId);
  assert.equal(loaded.citations[0].citationInstanceId, linkId);
  assert.equal(loaded.citations[0].items[0].locator, '12');
  assert.equal(loaded.citations[0].items[0].label, 'page');
  assert.equal(loaded.citations[0].items[1].suppressAuthor, true);
  assert.equal(loaded.aggregate.citationItems.length, 2);
  assert.deepEqual(loaded.aggregate.citationItems[0].author, [{ literal: '王伟' }]);

  const reversed = JSON.parse(JSON.stringify(loaded.citations));
  reversed[0].items.reverse().forEach((entry, order) => { entry.order = order; });
  const saved = await service.saveProject({
    id: projectId,
    baseRevision: loaded.revision,
    content: loaded.content,
    meta: loaded.meta,
    citations: reversed
  });
  assert.equal(saved.revision, 1);
  const reloaded = await service.loadProject(projectId);
  assert.equal(reloaded.citations[0].citationInstanceId, linkId);
  assert.equal(reloaded.citations[0].items[0].citationItemId, itemB);
  assert.equal(reloaded.citations[0].items[1].citationItemId, itemA);
  assert.equal(reloaded.citations[0].items[1].locator, '12');
});

test('modern citation validation rejects duplicate instances and invalid locator labels', async t => {
  const { service } = fixture(t);
  await service.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  const item = { citationItemId: 'c0000000-0000-4000-8000-000000000001', paper: { title: 'A' } };
  const cluster = { citationInstanceId: 'c0000000-0000-4000-8000-000000000002', items: [item] };
  await assert.rejects(service.saveProject({ id: projectId, baseRevision: -1, content: '<p>A</p>', citations: [cluster, cluster] }), /重复/);
  await assert.rejects(service.saveProject({
    id: projectId,
    baseRevision: -1,
    content: '<p>A</p>',
    citations: [{ ...cluster, items: [{ ...item, locator: '2' }] }]
  }), /locator/);
});
