'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EvidenceService,
  derivedReviewStatus,
  hashText,
  normalizeQuote
} = require('../../src/main/evidence/evidence-service');
const { WorkspaceService } = require('../../src/main/data/workspace-service');

const PROJECT_ID = 'e0000000-0000-4000-8000-000000000001';
const CITATION_ITEM_ID = 'e0000000-0000-4000-8000-000000000002';
const AUDIT_RESULT_ID = 'e0000000-0000-4000-8000-000000000003';
const LIBRARY_ITEM_ID = 'e0000000-0000-4000-8000-000000000004';

function fixture(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-evidence-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let tick = 0;
  let id = 100;
  const now = () => new Date(Date.parse('2026-07-16T00:00:00.000Z') + tick++ * 1000);
  const randomUUID = () => `e0000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
  const workspace = new WorkspaceService({ userDataPath, appVersion: 'm3-test', now, randomUUID });
  const evidence = new EvidenceService({ repository: workspace.repository, assetStore: workspace.assetStore, now, randomUUID });
  return { workspace, evidence };
}

async function seed(t) {
  const value = fixture(t);
  await value.workspace.bootstrapLegacy({ localStorage: {}, indexedDbLibrary: [] });
  const created = await value.workspace.repository.createProject({ projectId: PROJECT_ID, title: 'Evidence project' });
  const aggregate = await value.workspace.repository.loadProject(PROJECT_ID);
  aggregate.citationItems.push({
    schemaVersion: 1,
    id: CITATION_ITEM_ID,
    citationItemId: CITATION_ITEM_ID,
    projectId: PROJECT_ID,
    type: 'article-journal',
    title: 'Traceable PDF source',
    DOI: '10.5555/evidence',
    capturedAt: '2026-07-16T00:00:01.000Z'
  });
  const citationSaved = await value.workspace.repository.saveProject({ projectId: PROJECT_ID, baseRevision: created.revision, aggregate, source: 'evidence-fixture' });
  const asset = await value.workspace.assetStore.putBuffer({
    buffer: Buffer.from('%PDF-1.7\nsynthetic text PDF'),
    kind: 'pdf',
    mimeType: 'application/pdf',
    originalName: 'source.pdf'
  });
  return { ...value, asset, baseRevision: citationSaved.revision };
}

function selection(asset, baseRevision, overrides = {}) {
  const pageText = 'Prefix context Evidence quote for acceptance testing. Suffix context';
  return {
    projectId: PROJECT_ID,
    baseRevision,
    citationItemId: CITATION_ITEM_ID,
    assetId: asset.assetId,
    fileSha256: asset.sha256,
    title: 'Traceable PDF source',
    doi: '10.5555/evidence',
    metadataSource: 'manual',
    pageIndex: 0,
    pageLabel: 'PDF 第 1 页',
    quoteRaw: 'Evidence quote for acceptance testing.',
    pageTextSha256: hashText(pageText),
    prefix: 'Prefix context ',
    suffix: ' Suffix context',
    occurrenceIndex: 0,
    rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
    pageRotation: 0,
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    extractorName: 'pdfjs',
    extractorVersion: '3.11.174',
    transformVersion: '1',
    normalization: 'whitespace-collapse',
    ...overrides
  };
}

test('user selection creates one confirmed immutable revision and card-only edits preserve source fields', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  const created = await evidence.createEvidenceFromUserSelection(selection(asset, baseRevision, {
    note: 'Initial note', tags: ['method'], color: '#d5a623'
  }));
  assert.equal(created.durable, true);
  assert.equal(created.reviewEvent.actor, 'user');
  assert.equal(created.reviewEvent.status, 'confirmed');
  assert.equal(created.evidenceRevision.locator.rawQuoteSha256, hashText(created.evidenceRevision.locator.quoteRaw));
  const sourceBefore = structuredClone(created.evidenceRevision);

  const edited = await evidence.updateEvidenceCard({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceId: created.card.id,
    note: 'Changed note',
    tags: ['method', 'result'],
    color: '#1f7a6b',
    researchQuestionIds: []
  });
  assert.equal(edited.card.note, 'Changed note');
  const aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.deepEqual(aggregate.evidenceRevisions[0], sourceBefore);
});

test('authority fields, source mismatch and malformed user selection fail with zero revision change', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  const before = await workspace.repository.loadProject(PROJECT_ID);
  await assert.rejects(
    evidence.createEvidenceFromUserSelection(selection(asset, baseRevision, { actor: 'user', status: 'confirmed' })),
    error => error.code === 'EVIDENCE_AUTHORITY_INVALID'
  );
  await assert.rejects(
    evidence.createEvidenceFromUserSelection(selection(asset, baseRevision, { fileSha256: '0'.repeat(64) })),
    error => error.code === 'EVIDENCE_SOURCE_MISMATCH'
  );
  await assert.rejects(
    evidence.createEvidenceFromUserSelection(selection(asset, baseRevision, { quoteRaw: 'x'.repeat(2001) })),
    error => error.code === 'EVIDENCE_QUOTE_LENGTH'
  );
  const after = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(after.manifest.revision, before.manifest.revision);
  assert.equal(after.evidenceRevisions.length, 0);
  assert.equal(after.evidenceReviewEvents.length, 0);
});

test('AI proposal requires a real audit result and only one explicit user terminal review', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  await assert.rejects(
    evidence.createProposedEvidenceFromAI(selection(asset, baseRevision, { sourceAuditResultEventId: AUDIT_RESULT_ID })),
    error => error.code === 'SCHEMA_INVALID_EVIDENCE_AUDIT_SOURCE'
  );
  let aggregate = await workspace.repository.loadProject(PROJECT_ID);
  const auditRequestId = 'e0000000-0000-4000-8000-00000000000b';
  const auditSessionId = 'e0000000-0000-4000-8000-00000000000c';
  const occurredAt = '2026-07-17T00:00:00.000Z';
  aggregate.auditEvents.push({
    schemaVersion: 1,
    eventId: auditRequestId,
    projectId: PROJECT_ID,
    sessionId: auditSessionId,
    sequence: 1,
    eventType: 'ai-request',
    occurredAt,
    networkContext: {
      operation: 'grounded-qa',
      provider: { origin: 'http://127.0.0.1:11434', providerKind: 'local-ai', model: 'fixture' },
      privacyMode: 'normal',
      networkDecision: 'local'
    },
    contentRetention: 'metadata-only',
    promptTemplateVersion: 'evidence-fixture-v1',
    userPromptSha256: '1'.repeat(64),
    userPromptByteCount: 1,
    contextManifest: [],
    outbound: {
      payloadSha256: '2'.repeat(64),
      byteCount: 2,
      unicodeCodePointCount: 2,
      sentAt: occurredAt
    }
  }, {
    schemaVersion: 1,
    eventId: AUDIT_RESULT_ID,
    projectId: PROJECT_ID,
    sessionId: auditSessionId,
    sequence: 2,
    eventType: 'ai-result',
    occurredAt,
    requestEventId: auditRequestId,
    contentRetention: 'metadata-only',
    outputSha256: '3'.repeat(64),
    byteCount: 3,
    partial: false,
    responseStatus: 200
  });
  const auditSaved = await workspace.repository.saveProject({ projectId: PROJECT_ID, baseRevision, aggregate, source: 'audit-fixture' });
  const proposed = await evidence.createProposedEvidenceFromAI(selection(asset, auditSaved.revision, { sourceAuditResultEventId: AUDIT_RESULT_ID }));
  assert.equal(proposed.reviewEvent.status, 'proposed');
  const reviewed = await evidence.reviewProposedEvidenceByUser({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    evidenceRevisionId: proposed.evidenceRevision.id,
    decision: 'confirmed',
    expectedSequence: 1
  });
  assert.equal(reviewed.reviewEvent.actor, 'user');
  assert.equal(reviewed.reviewEvent.sequence, 2);
  await assert.rejects(evidence.reviewProposedEvidenceByUser({
    projectId: PROJECT_ID,
    baseRevision: reviewed.revision,
    evidenceRevisionId: proposed.evidenceRevision.id,
    decision: 'rejected',
    expectedSequence: 2
  }), error => error.code === 'EVIDENCE_REVIEW_TERMINAL');
  aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.evidenceReviewEvents.length, 2);
  assert.equal(aggregate.manifest.revision, reviewed.revision);
});

test('proposed direct quote is blocked before mutation, then confirmed evidence commits one stable linked anchor', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  let aggregate = await workspace.repository.loadProject(PROJECT_ID);
  aggregate.auditEvents.push({ eventId: AUDIT_RESULT_ID, projectId: PROJECT_ID, eventType: 'ai-result', sequence: 1 });
  const auditSaved = await workspace.repository.saveProject({ projectId: PROJECT_ID, baseRevision, aggregate, source: 'audit-fixture' });
  const proposed = await evidence.createProposedEvidenceFromAI(selection(asset, auditSaved.revision, { sourceAuditResultEventId: AUDIT_RESULT_ID }));
  await assert.rejects(evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    evidenceRevisionIds: [proposed.evidenceRevision.id],
    insertionMode: 'quote'
  }), error => error.code === 'EVIDENCE_DIRECT_QUOTE_NOT_CONFIRMED');
  aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.citationLinks.length, 0);
  assert.equal(aggregate.manifest.revision, proposed.revision);

  const reviewed = await evidence.reviewProposedEvidenceByUser({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    evidenceRevisionId: proposed.evidenceRevision.id,
    decision: 'confirmed',
    expectedSequence: 1
  });
  const prepared = await evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: reviewed.revision,
    evidenceRevisionIds: [proposed.evidenceRevision.id],
    insertionMode: 'quote'
  });
  const html = `<p>${proposed.evidenceRevision.locator.quoteDisplay}<sup data-citation-instance-id="${prepared.citationInstanceId}">[1]</sup></p>`;
  const committed = await evidence.commitEvidenceCitation({ projectId: PROJECT_ID, sessionId: prepared.sessionId, documentHtml: html });
  assert.equal(committed.durable, true);
  aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, html);
  assert.deepEqual(aggregate.citationLinks[0].items[0].evidenceRevisionIds, [proposed.evidenceRevision.id]);
  assert.equal(aggregate.citationLinks[0].items[0].sourceCitationSnapshots[0].rawQuoteSha256, proposed.evidenceRevision.locator.rawQuoteSha256);
});

test('archiving reports impact and degrades CitationLink without deleting the stable evidence foreign key', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  const created = await evidence.createEvidenceFromUserSelection(selection(asset, baseRevision));
  const prepared = await evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionIds: [created.evidenceRevision.id],
    insertionMode: 'citation-only'
  });
  const committed = await evidence.commitEvidenceCitation({
    projectId: PROJECT_ID,
    sessionId: prepared.sessionId,
    documentHtml: `<p><sup data-citation-instance-id="${prepared.citationInstanceId}">[1]</sup></p>`
  });
  const impact = await evidence.archiveEvidence({ projectId: PROJECT_ID, baseRevision: committed.revision, evidenceId: created.card.id });
  assert.deepEqual(impact, { requiresConfirmation: true, citationCount: 1 });
  const archived = await evidence.archiveEvidence({
    projectId: PROJECT_ID,
    baseRevision: committed.revision,
    evidenceId: created.card.id,
    confirmed: true
  });
  assert.equal(archived.citationCount, 1);
  const aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.evidenceCards[0].status, 'archived');
  assert.equal(aggregate.citationLinks[0].items[0].status, 'evidence-missing');
  assert.deepEqual(aggregate.citationLinks[0].items[0].evidenceRevisionIds, [created.evidenceRevision.id]);
  assert.equal(aggregate.citationLinks[0].items[0].sourceCitationSnapshots.length, 1);
});

test('normalization modes are deterministic and reject unknown transforms', () => {
  assert.equal(normalizeQuote(' A\t B \n C ', 'whitespace-collapse'), 'A B C');
  assert.equal(normalizeQuote('A \n B', 'linebreak-join'), 'A B');
  assert.equal(normalizeQuote('evi-\n dence', 'hyphen-join'), 'evidence');
  assert.throws(() => normalizeQuote('text', 'unknown'), error => error.code === 'EVIDENCE_NORMALIZATION_INVALID');
  assert.throws(() => new EvidenceService(), error => error.code === 'EVIDENCE_SERVICE_CONFIG_INVALID');
  assert.equal(derivedReviewStatus({ evidenceReviewEvents: [] }, 'missing'), null);
});

test('selection validation rejects stale revisions, missing sources, non-PDF assets and invalid anchors', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  const attachment = await workspace.assetStore.putBuffer({
    buffer: Buffer.from('synthetic attachment'),
    kind: 'attachment',
    mimeType: 'application/octet-stream',
    originalName: 'source.bin'
  });
  const cases = [
    [selection(asset, -1), 'EVIDENCE_REVISION_CONFLICT'],
    [selection(asset, baseRevision, { citationItemId: 'e0000000-0000-4000-8000-000000000099' }), 'EVIDENCE_CITATION_ITEM_MISSING'],
    [selection(asset, baseRevision, { assetId: 'e0000000-0000-4000-8000-000000000098' }), 'EVIDENCE_SOURCE_MISSING'],
    [selection(attachment, baseRevision), 'EVIDENCE_SOURCE_NOT_PDF'],
    [selection(asset, baseRevision, { normalization: 'unknown' }), 'EVIDENCE_NORMALIZATION_INVALID'],
    [selection(asset, baseRevision, { quoteRaw: '' }), 'EVIDENCE_QUOTE_LENGTH'],
    [selection(asset, baseRevision, { rects: [] }), 'EVIDENCE_RECTS_REQUIRED']
  ];
  for (const [input, code] of cases) {
    await assert.rejects(evidence.createEvidenceFromUserSelection(input), error => error.code === code, code);
  }
});

test('library-backed selection creates a project snapshot and reselecting source appends an immutable revision', async t => {
  const { workspace, asset, baseRevision } = await seed(t);
  await workspace.libraryStore.upsertItem({
    schemaVersion: 1,
    libraryItemId: LIBRARY_ITEM_ID,
    type: 'article-journal',
    title: 'Library evidence source',
    author: [{ family: 'Li', given: 'Ming' }],
    issued: { 'date-parts': [[2026]] },
    DOI: '10.5555/library-evidence',
    tags: [],
    starred: false,
    privateNote: '',
    metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
  }, { baseRevision: workspace.libraryStore.revision });
  const evidence = workspace.evidenceService();
  const created = await evidence.createEvidenceFromUserSelection(selection(asset, baseRevision, {
    citationItemId: undefined,
    libraryItemId: LIBRARY_ITEM_ID,
    pageLabel: '',
    title: '',
    doi: '',
    metadataSource: 'other',
    normalization: 'linebreak-join',
    quoteRaw: 'First line\nsecond line'
  }));
  assert.equal(created.evidenceRevision.libraryItemId, LIBRARY_ITEM_ID);
  assert.equal(created.evidenceRevision.locator.pageLabel, 'PDF 第 1 页');
  assert.equal(created.evidenceRevision.locator.quoteDisplay, 'First line second line');
  const reselected = await evidence.createEvidenceFromUserSelection(selection(asset, created.revision, {
    citationItemId: created.evidenceRevision.citationItemId,
    libraryItemId: LIBRARY_ITEM_ID,
    evidenceId: created.card.id,
    normalization: 'hyphen-join',
    quoteRaw: 'trace-\nable source'
  }));
  assert.equal(reselected.evidenceRevision.revisionNumber, 2);
  assert.equal(reselected.evidenceRevision.locator.quoteDisplay, 'traceable source');
  const aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.evidenceCards.length, 1);
  assert.equal(aggregate.evidenceRevisions.length, 2);
  assert.equal(aggregate.assetRefs.length, 1);

  const autosaved = await workspace.saveProject({
    id: PROJECT_ID,
    baseRevision: reselected.revision,
    content: '<p>正文继续编辑</p>',
    citations: []
  });
  assert.equal(autosaved.durable, true);
  const afterAutosave = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(afterAutosave.citationItems.length, 1);
  assert.equal(afterAutosave.citationItems[0].citationItemId, created.evidenceRevision.citationItemId);
  assert.equal(afterAutosave.evidenceRevisions.length, 2);
});

test('evidence list reports active, mismatch, missing and archived states with citation impact', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  const created = await evidence.createEvidenceFromUserSelection(selection(asset, baseRevision));
  const prepared = await evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionIds: [created.evidenceRevision.id],
    insertionMode: 'citation-only'
  });
  const committed = await evidence.commitEvidenceCitation({
    projectId: PROJECT_ID,
    sessionId: prepared.sessionId,
    documentHtml: `<p><sup data-citation-instance-id="${prepared.citationInstanceId}">[1]</sup></p>`
  });
  let listed = await evidence.listEvidence(PROJECT_ID);
  assert.equal(listed.items[0].effectiveStatus, 'active');
  assert.equal(listed.items[0].citationCount, 1);
  const originalGetDescriptor = workspace.assetStore.getDescriptor.bind(workspace.assetStore);
  workspace.assetStore.getDescriptor = id => ({ ...originalGetDescriptor(id), sha256: '0'.repeat(64) });
  listed = await evidence.listEvidence(PROJECT_ID);
  assert.equal(listed.items[0].effectiveStatus, 'source-mismatch');
  workspace.assetStore.getDescriptor = () => { throw new Error('missing'); };
  listed = await evidence.listEvidence(PROJECT_ID);
  assert.equal(listed.items[0].effectiveStatus, 'source-missing');
  workspace.assetStore.getDescriptor = originalGetDescriptor;
  await evidence.archiveEvidence({ projectId: PROJECT_ID, baseRevision: committed.revision, evidenceId: created.card.id, confirmed: true });
  listed = await evidence.listEvidence(PROJECT_ID);
  assert.equal(listed.items[0].effectiveStatus, 'archived');
});

test('review and citation commands fail closed for invalid authority, archived sources and stale sessions', async t => {
  const { workspace, evidence, asset, baseRevision } = await seed(t);
  const created = await evidence.createEvidenceFromUserSelection(selection(asset, baseRevision));
  await assert.rejects(evidence.reviewProposedEvidenceByUser({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionId: created.evidenceRevision.id,
    decision: 'proposed',
    expectedSequence: 1
  }), error => error.code === 'EVIDENCE_REVIEW_DECISION_INVALID');
  await assert.rejects(evidence.reviewProposedEvidenceByUser({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionId: created.evidenceRevision.id,
    decision: 'confirmed',
    expectedSequence: 1
  }), error => error.code === 'EVIDENCE_REVIEW_NOT_PROPOSED');
  await assert.rejects(evidence.updateEvidenceCard({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceId: 'e0000000-0000-4000-8000-000000000097'
  }), error => error.code === 'EVIDENCE_NOT_FOUND');
  await assert.rejects(evidence.archiveEvidence({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceId: 'e0000000-0000-4000-8000-000000000097'
  }), error => error.code === 'EVIDENCE_NOT_FOUND');
  await assert.rejects(evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionIds: [created.evidenceRevision.id],
    insertionMode: 'unknown'
  }), error => error.code === 'EVIDENCE_INSERTION_MODE_INVALID');
  await assert.rejects(evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionIds: ['e0000000-0000-4000-8000-000000000096'],
    insertionMode: 'citation-only'
  }), error => error.code === 'EVIDENCE_REVISION_NOT_FOUND');

  const prepared = await evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceRevisionIds: [created.evidenceRevision.id],
    insertionMode: 'paraphrase'
  });
  await assert.rejects(evidence.commitEvidenceCitation({
    projectId: PROJECT_ID,
    sessionId: prepared.sessionId,
    documentHtml: '<p>anchor missing</p>'
  }), error => error.code === 'EVIDENCE_CITATION_ANCHOR_MISSING');
  evidence.citationSessions.get(prepared.sessionId).expiresAt = 0;
  await assert.rejects(evidence.commitEvidenceCitation({
    projectId: PROJECT_ID,
    sessionId: prepared.sessionId,
    documentHtml: '<p>expired</p>'
  }), error => error.code === 'EVIDENCE_CITATION_SESSION_EXPIRED');

  const archived = await evidence.archiveEvidence({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    evidenceId: created.card.id,
    confirmed: true
  });
  await assert.rejects(evidence.prepareEvidenceCitation({
    projectId: PROJECT_ID,
    baseRevision: archived.revision,
    evidenceRevisionIds: [created.evidenceRevision.id],
    insertionMode: 'citation-only'
  }), error => error.code === 'EVIDENCE_ARCHIVED');
  const aggregate = await workspace.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.citationLinks.length, 0);
});
