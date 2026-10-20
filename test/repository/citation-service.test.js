'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CitationService } = require('../../src/main/citation/citation-service');
const { WorkspaceService } = require('../../src/main/data/workspace-service');

const PROJECT_ID = 'd0000000-0000-4000-8000-000000000001';
const LIBRARY_ID = 'd0000000-0000-4000-8000-000000000002';
const CITATION_ITEM_ID = 'd0000000-0000-4000-8000-000000000003';
const LINK_ID = 'd0000000-0000-4000-8000-000000000004';

function fixture(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-citation-service-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let tick = 0;
  let uuidCounter = 100;
  const now = () => new Date(Date.parse('2026-07-16T00:00:00.000Z') + tick++ * 1000);
  const randomUUID = () => `d0000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
  const workspace = new WorkspaceService({ userDataPath, appVersion: 'm2-test', now, randomUUID });
  const citation = new CitationService({ repository: workspace.repository, libraryStore: workspace.libraryStore, now, randomUUID });
  return { workspace, citation };
}

async function seedLibrary(workspace) {
  await workspace.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  const timestamp = '2026-07-16T00:00:10.000Z';
  await workspace.libraryStore.upsertItem({
    schemaVersion: 1,
    libraryItemId: LIBRARY_ID,
    type: 'article-journal',
    title: 'Local manual title',
    author: [{ family: 'Wang', given: 'Wei' }],
    issued: { 'date-parts': [[2025]] },
    DOI: '10.5555/import',
    tags: ['local'],
    starred: false,
    privateNote: 'local note',
    metadataProvenance: { source: 'manual', importedAt: timestamp, originalFormat: 'manual', fields: { title: 'manual' } }
  }, { baseRevision: workspace.libraryStore.revision });
}

test('import plan exposes manual conflicts and commit requires an explicit field choice', async t => {
  const { workspace, citation } = fixture(t);
  await seedLibrary(workspace);
  const planned = citation.planImport(JSON.stringify([{
    id: 'incoming',
    type: 'article-journal',
    title: 'Incoming title',
    author: [{ family: 'Wang', given: 'Wei' }],
    issued: { 'date-parts': [[2025]] },
    DOI: '10.5555/import',
    abstract: 'New abstract'
  }]), 'csl-json');
  assert.equal(planned.matches.length, 1);
  assert.equal(planned.matches[0].reason, 'doi');
  assert.ok(planned.matches[0].conflicts.some(conflict => conflict.field === 'title' && conflict.requiresUserChoice));
  await assert.rejects(citation.commitImport({ sessionId: planned.sessionId, baseRevision: workspace.libraryStore.revision }), error => error.code === 'CITATION_IMPORT_CONFLICT_UNRESOLVED');
  const committed = await citation.commitImport({
    sessionId: planned.sessionId,
    baseRevision: workspace.libraryStore.revision,
    decisions: { [planned.matches[0].incomingItemId]: { fields: { title: 'existing' } } }
  });
  assert.equal(committed.durable, true);
  const item = workspace.libraryStore.getItem(LIBRARY_ID);
  assert.equal(item.title, 'Local manual title');
  assert.equal(item.abstract, 'New abstract');
});

test('library query, fixed format export, batch organization and undo share one durable store', async t => {
  const { workspace, citation } = fixture(t);
  await seedLibrary(workspace);
  const collection = await workspace.libraryStore.createCollection('重点阅读', { baseRevision: workspace.libraryStore.revision });
  const query = await citation.queryLibrary({ search: 'wang 10.5555/import', year: 2025, type: 'article-journal', limit: 50 });
  assert.equal(query.total, 1);
  assert.ok(query.elapsedMs >= 0);
  const exported = citation.exportLibrary('csl-json', [LIBRARY_ID]);
  assert.equal(exported.itemCount, 1);
  assert.equal(JSON.parse(exported.text)[0].id, LIBRARY_ID);

  let batch = await citation.applyLibraryBatch({
    baseRevision: workspace.libraryStore.revision,
    itemIds: [LIBRARY_ID],
    operation: { type: 'tags-add', tags: ['evidence', 'local'] }
  });
  assert.deepEqual(workspace.libraryStore.getItem(LIBRARY_ID).tags, ['evidence', 'local']);
  await citation.undoLibraryBatch({ undoToken: batch.undoToken, baseRevision: workspace.libraryStore.revision });
  assert.deepEqual(workspace.libraryStore.getItem(LIBRARY_ID).tags, ['local']);

  batch = await citation.applyLibraryBatch({
    baseRevision: workspace.libraryStore.revision,
    itemIds: [LIBRARY_ID],
    operation: { type: 'collection-add', collectionId: collection.collection.collectionId }
  });
  assert.deepEqual(workspace.libraryStore.getCollection(collection.collection.collectionId).itemIds, [LIBRARY_ID]);
  await citation.applyLibraryBatch({
    baseRevision: workspace.libraryStore.revision,
    itemIds: [LIBRARY_ID],
    operation: { type: 'set-starred', value: true }
  });
  assert.equal(workspace.libraryStore.getItem(LIBRARY_ID).starred, true);
  await assert.rejects(citation.undoLibraryBatch({ undoToken: batch.undoToken, baseRevision: workspace.libraryStore.revision }), error => error.code === 'CITATION_LIBRARY_REVISION_CONFLICT');
});

test('project rendering, audit, impact and ProjectPaperState use persisted CitationLinks', async t => {
  const { workspace, citation } = fixture(t);
  await seedLibrary(workspace);
  await workspace.saveProject({
    id: PROJECT_ID,
    baseRevision: -1,
    title: 'Citation project',
    content: `<p>Text <sup data-citation-instance-id="${LINK_ID}">[1]</sup></p>`,
    citations: [{
      citationInstanceId: LINK_ID,
      items: [{
        citationItemEntryId: 'd0000000-0000-4000-8000-000000000005',
        citationItemId: CITATION_ITEM_ID,
        libraryItemId: LIBRARY_ID,
        paper: workspace.libraryStore.getItem(LIBRARY_ID),
        locator: '5',
        label: 'page',
        order: 0
      }]
    }]
  });
  const rendered = await citation.renderProject(PROJECT_ID, { styleId: 'apa-7', format: 'text' });
  assert.match(rendered.citations[0].body, /Wang/);
  assert.match(rendered.citations[0].body, /p\. 5/);
  const audit = await citation.auditProject(PROJECT_ID);
  assert.equal(audit.ok, true);
  assert.ok(audit.issues.some(issue => issue.code === 'RETRACTION_STATUS_NOT_CHECKED'));
  const impact = await citation.citationImpact([LIBRARY_ID]);
  assert.equal(impact.citationCount, 1);
  const stateResult = await citation.updateProjectPaperState({
    projectId: PROJECT_ID,
    baseRevision: 0,
    libraryItemId: LIBRARY_ID,
    screeningStatus: 'included',
    readingStatus: 'reading',
    projectNotes: 'Read next'
  });
  assert.equal(stateResult.durable, true);
  const loaded = await workspace.loadProject(PROJECT_ID);
  assert.equal(loaded.aggregate.projectPaperStates[0].readingStatus, 'reading');
  assert.equal(loaded.aggregate.projectPaperStates[0].citationItemId, CITATION_ITEM_ID);
  await assert.rejects(citation.updateProjectPaperState({
    projectId: PROJECT_ID,
    baseRevision: stateResult.revision,
    libraryItemId: LIBRARY_ID,
    screeningStatus: 'excluded',
    readingStatus: 'read'
  }), error => error.code === 'PROJECT_PAPER_EXCLUSION_REASON_REQUIRED');
});

test('project-state batch creates an uncited snapshot, filters it and restores it with one undo', async t => {
  const { workspace, citation } = fixture(t);
  await seedLibrary(workspace);
  await workspace.saveProject({ id: PROJECT_ID, baseRevision: -1, title: 'Screening project', content: '<p>Draft</p>', citations: [] });
  const batch = await citation.applyLibraryBatch({
    baseRevision: 0,
    itemIds: [LIBRARY_ID],
    operation: {
      type: 'set-project-state',
      projectId: PROJECT_ID,
      screeningStatus: 'excluded',
      exclusionReason: 'Wrong population',
      readingStatus: 'read'
    }
  });
  assert.equal(batch.scope, 'project');
  assert.equal(batch.durable, true);
  const filtered = await citation.queryLibrary({ projectId: PROJECT_ID, screeningStatus: 'excluded', readingStatus: 'read' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].isCited, false);
  assert.equal(filtered.items[0].projectPaperState.exclusionReason, 'Wrong population');
  const aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.citationItems.length, 1);
  assert.equal(aggregate.projectPaperStates.length, 1);

  const undone = await citation.undoLibraryBatch({ undoToken: batch.undoToken, baseRevision: batch.revision });
  assert.equal(undone.scope, 'project');
  const restored = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(restored.citationItems.length, 0);
  assert.equal(restored.projectPaperStates.length, 0);
});

test('collection creation returns the durable revision and current collection snapshot', async t => {
  const { workspace, citation } = fixture(t);
  await seedLibrary(workspace);
  const created = await citation.upsertLibraryCollection({ baseRevision: workspace.libraryStore.revision, name: '待复核' });
  assert.equal(created.durable, true);
  assert.equal(created.collection.name, '待复核');
  assert.equal(created.collections.length, 1);
  assert.equal(created.revision, workspace.libraryStore.revision);
});
