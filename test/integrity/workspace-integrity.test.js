'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AssetStore } = require('../../src/main/data/asset-store');
const { semanticHash } = require('../../src/main/data/canonical');
const { ProjectRepository } = require('../../src/main/data/repository');
const { createEmptyProjectAggregate } = require('../../src/main/data/schema');
const { verifyWorkspace } = require('../../scripts/verify-data');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetStore = new AssetStore(path.join(root, 'assets'));
  const repository = new ProjectRepository({ rootPath: root, assetStore });
  return { root, assetStore, repository };
}

test('deep verifier accepts one complete commit and reachable checksummed asset', async t => {
  const { root, assetStore, repository } = fixture(t);
  const projectId = '10000000-0000-4000-8000-000000000001';
  const asset = await assetStore.putBuffer({
    buffer: Buffer.from('synthetic-pdf'),
    kind: 'pdf',
    mimeType: 'application/pdf',
    originalName: 'fixture.pdf'
  });
  const aggregate = createEmptyProjectAggregate({
    projectId,
    title: 'Integrity fixture',
    html: '<h1>Integrity fixture</h1><p>Body</p>',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  aggregate.assetRefs.push({ id: asset.assetId, assetId: asset.assetId, projectId });
  await repository.createProject({ projectId, aggregate });

  const report = verifyWorkspace({ profile: root, deep: true });
  assert.equal(report.passed, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.errors, 0);
  assert.equal(report.counts.projects, 1);
  assert.equal(report.counts.assets, 1);
});

test('verifier reports mixed HEAD, unreachable assets, checksum and secret leaks', async t => {
  const { root, assetStore, repository } = fixture(t);
  const projectId = '20000000-0000-4000-8000-000000000002';
  const unreachable = await assetStore.putBuffer({ buffer: Buffer.from('orphan') });
  const aggregate = createEmptyProjectAggregate({
    projectId,
    title: 'Corrupt fixture',
    html: '<p>Body</p>',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  await repository.createProject({ projectId, aggregate });

  const blobPath = assetStore.blobPath(unreachable.sha256);
  fs.writeFileSync(blobPath, 'changed');
  fs.mkdirSync(path.join(root, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'settings', 'leak.json'), JSON.stringify({ apiKey: 'sk-secretfixture123' }));
  const headPath = path.join(root, 'projects', projectId, 'HEAD.json');
  const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
  head.envelopeHash = '0'.repeat(64);
  fs.writeFileSync(headPath, JSON.stringify(head));

  const report = verifyWorkspace({ profile: root, deep: true });
  assert.equal(report.passed, false);
  assert.ok(report.metrics.mixedCommits >= 1);
  assert.ok(report.metrics.unreachableAssetsAfterGc >= 1);
  assert.ok(report.metrics.checksumMismatch >= 1);
  assert.ok(report.metrics.secretLeaks >= 1);
});

test('verifier detects unconfirmed direct quotations and dangling citation items', async t => {
  const { root, repository } = fixture(t);
  const projectId = '30000000-0000-4000-8000-000000000003';
  const citationItemId = '30000000-0000-4000-8000-000000000004';
  const linkId = '30000000-0000-4000-8000-000000000005';
  const revisionId = '30000000-0000-4000-8000-000000000006';
  const reviewId = '30000000-0000-4000-8000-000000000007';
  const entryId = '30000000-0000-4000-8000-000000000008';
  const evidenceId = '30000000-0000-4000-8000-000000000009';
  const assetId = '30000000-0000-4000-8000-000000000010';
  const auditResultId = '30000000-0000-4000-8000-000000000011';
  const auditRequestId = '30000000-0000-4000-8000-000000000012';
  const auditSessionId = '30000000-0000-4000-8000-000000000013';
  const createdAt = '2026-07-16T00:00:00.000Z';
  const quoteText = 'Quote';
  const quoteHash = semanticHash(quoteText);
  const fileHash = 'a'.repeat(64);
  const aggregate = createEmptyProjectAggregate({
    projectId,
    title: 'Relationship fixture',
    html: '<p>Quote</p>',
    createdAt
  });
  aggregate.citationItems.push({
    schemaVersion: 1,
    id: citationItemId,
    citationItemId,
    projectId,
    type: 'article-journal',
    title: 'Relationship fixture source',
    capturedAt: createdAt
  });
  aggregate.evidenceRevisions.push({
    schemaVersion: 1,
    id: revisionId,
    evidenceId,
    revisionNumber: 1,
    citationItemId,
    sourceSnapshot: {
      assetId,
      fileSha256: fileHash,
      title: 'Relationship fixture source',
      metadataSource: 'manual'
    },
    locator: {
      pageIndex: 0,
      pageLabel: 'PDF 第 1 页',
      quoteRaw: quoteText,
      quoteDisplay: quoteText,
      rawQuoteSha256: quoteHash,
      displayQuoteSha256: quoteHash,
      pageTextSha256: quoteHash,
      prefix: '',
      suffix: '',
      occurrenceIndex: 0,
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
      pageRotation: 0,
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      extractorName: 'pdfjs',
      extractorVersion: '3.11.174',
      transformVersion: '1',
      normalization: 'whitespace-collapse',
      extraction: 'pdf-text'
    },
    createdBy: 'ai',
    createdAt
  });
  aggregate.evidenceCards.push({
    schemaVersion: 1,
    id: evidenceId,
    projectId,
    currentRevisionId: revisionId,
    note: '',
    tags: [],
    color: '#d5a623',
    researchQuestionIds: [],
    status: 'active',
    createdAt,
    updatedAt: createdAt
  });
  aggregate.auditEvents.push({
    schemaVersion: 1,
    eventId: auditRequestId,
    projectId,
    sessionId: auditSessionId,
    sequence: 1,
    eventType: 'ai-request',
    occurredAt: createdAt,
    networkContext: {
      operation: 'grounded-qa',
      provider: { origin: 'http://127.0.0.1:11434', providerKind: 'local-ai', model: 'integrity-fixture' },
      privacyMode: 'normal',
      networkDecision: 'local'
    },
    contentRetention: 'metadata-only',
    promptTemplateVersion: 'integrity-fixture-v1',
    userPromptSha256: 'b'.repeat(64),
    userPromptByteCount: 1,
    contextManifest: [],
    outbound: {
      payloadSha256: 'c'.repeat(64),
      byteCount: 1,
      unicodeCodePointCount: 1,
      sentAt: createdAt
    }
  }, {
    schemaVersion: 1,
    eventId: auditResultId,
    projectId,
    sessionId: auditSessionId,
    sequence: 2,
    eventType: 'ai-result',
    occurredAt: createdAt,
    requestEventId: auditRequestId,
    contentRetention: 'metadata-only',
    outputSha256: 'd'.repeat(64),
    byteCount: 1,
    partial: false,
    responseStatus: 200
  });
  aggregate.evidenceReviewEvents.push({
    schemaVersion: 1,
    id: reviewId,
    projectId,
    evidenceId,
    evidenceRevisionId: revisionId,
    sequence: 1,
    previousReviewEventId: null,
    actor: 'ai',
    status: 'proposed',
    sourceAuditResultEventId: auditResultId,
    createdAt
  });
  aggregate.citationLinks.push({
    schemaVersion: 1,
    id: linkId,
    projectId,
    insertionMode: 'paraphrase',
    items: [{
      citationItemEntryId: entryId,
      citationItemId,
      evidenceRevisionIds: [revisionId],
      sourceCitationSnapshots: [{
        citationItemId,
        title: 'Relationship fixture source',
        assetId,
        fileSha256: fileHash,
        pageIndex: 0,
        pageLabel: 'PDF 第 1 页',
        rawQuoteSha256: quoteHash,
        quoteText,
        capturedAt: createdAt
      }],
      locator: '1',
      label: 'page',
      suppressAuthor: false,
      order: 0,
      status: 'active'
    }],
    createdAt,
    updatedAt: createdAt
  });
  await repository.createProject({ projectId, aggregate });

  const headPath = path.join(root, 'projects', projectId, 'HEAD.json');
  const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
  const commitName = `${String(head.revision).padStart(12, '0')}-${head.commitId}.json`;
  const commitPath = path.join(root, 'projects', projectId, 'commits', commitName);
  const envelope = JSON.parse(fs.readFileSync(commitPath, 'utf8'));
  envelope.aggregate.citationItems = [];
  envelope.aggregate.citationLinks[0].insertionMode = 'quote';
  envelope.aggregateHash = semanticHash(envelope.aggregate);
  head.envelopeHash = semanticHash(envelope);
  fs.writeFileSync(commitPath, JSON.stringify(envelope, null, 2));
  fs.writeFileSync(headPath, JSON.stringify(head, null, 2));

  const report = verifyWorkspace({ profile: root, deep: false });
  assert.equal(report.metrics.schemaErrors, 1);
  assert.equal(report.metrics.unexpectedDanglingCitations, 1);
  assert.equal(report.metrics.unconfirmedQuoteInsertions, 1);
});
