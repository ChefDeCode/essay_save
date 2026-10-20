'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const contracts = require('../../src/main/ipc/evidence-contracts');

const ROOT = path.resolve(__dirname, '..', '..');
const ID_A = 'b0000000-0000-4000-8000-000000000001';
const ID_B = 'b0000000-0000-4000-8000-000000000002';
const ID_C = 'b0000000-0000-4000-8000-000000000003';

function selection(extra = {}) {
  return {
    projectId: ID_A,
    baseRevision: 2,
    libraryItemId: ID_B,
    assetId: ID_C,
    fileSha256: 'a'.repeat(64),
    title: 'Evidence source',
    metadataSource: 'manual',
    pageIndex: 0,
    pageLabel: 'PDF 第 1 页',
    quoteRaw: 'Selected evidence',
    pageTextSha256: 'b'.repeat(64),
    prefix: 'Before',
    suffix: 'After',
    occurrenceIndex: 0,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
    pageRotation: 0,
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    extractorName: 'pdfjs',
    extractorVersion: '3.11.174',
    transformVersion: '1',
    normalization: 'whitespace-collapse',
    ...extra
  };
}

test('evidence IPC accepts bounded semantic commands', () => {
  assert.doesNotThrow(() => contracts.userSelection(selection()));
  assert.doesNotThrow(() => contracts.aiSelection(selection({ sourceAuditResultEventId: ID_C })));
  assert.doesNotThrow(() => contracts.review({ projectId: ID_A, baseRevision: 3, evidenceRevisionId: ID_B, decision: 'confirmed', expectedSequence: 1 }));
  assert.doesNotThrow(() => contracts.update({ projectId: ID_A, baseRevision: 3, evidenceId: ID_B, note: '', tags: ['method'], color: '#d5a623' }));
  assert.doesNotThrow(() => contracts.archive({ projectId: ID_A, baseRevision: 3, evidenceId: ID_B, confirmed: true }));
  assert.doesNotThrow(() => contracts.prepareCitation({ projectId: ID_A, baseRevision: 3, insertionMode: 'quote', evidenceRevisionIds: [ID_B] }));
  assert.doesNotThrow(() => contracts.commitCitation({ projectId: ID_A, sessionId: ID_B, documentHtml: `<p data-citation-instance-id="${ID_C}">[1]</p>` }));
  assert.doesNotThrow(() => contracts.managedPdfLocator('file:///C:/managed/paper.pdf'));
});

test('evidence IPC rejects authority injection, malformed anchors and oversized input', () => {
  const invalid = [
    () => contracts.userSelection(selection({ actor: 'user', status: 'confirmed' })),
    () => contracts.userSelection(selection({ arbitraryPath: 'C:\\secret.pdf' })),
    () => contracts.userSelection(selection({ quoteRaw: 'x'.repeat(2001) })),
    () => contracts.userSelection(selection({ rects: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }] })),
    () => contracts.userSelection(selection({ pageRotation: 45 })),
    () => contracts.userSelection(selection({ fileSha256: 'A'.repeat(64) })),
    () => contracts.userSelection(selection({ pageTextSha256: 'B'.repeat(64) })),
    () => contracts.aiSelection(selection()),
    () => contracts.review({ projectId: ID_A, baseRevision: 3, evidenceRevisionId: ID_B, decision: 'proposed', expectedSequence: 1 }),
    () => contracts.update({ projectId: ID_A, baseRevision: 3, evidenceId: ID_B, quoteRaw: 'mutate source' }),
    () => contracts.archive({ projectId: ID_A, baseRevision: 3, evidenceId: ID_B, confirmed: 'yes' }),
    () => contracts.prepareCitation({ projectId: ID_A, baseRevision: 3, insertionMode: 'quote', evidenceRevisionIds: [ID_B, ID_B] }),
    () => contracts.commitCitation({ projectId: ID_A, sessionId: ID_B, documentHtml: 'x'.repeat(contracts.MAX_PAYLOAD_BYTES + 1) }),
    () => contracts.managedPdfLocator('bad\0path.pdf')
  ];
  invalid.forEach(validate => assert.throws(validate));
});

test('all evidence channels use trusted handlers and preload exposes no general review append or file writer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const channels = [
    'evidence-import-managed-pdf', 'evidence-list', 'evidence-read-pdf', 'evidence-create-user', 'evidence-create-ai-proposal',
    'evidence-review-user', 'evidence-update-card', 'evidence-archive', 'evidence-prepare-citation',
    'evidence-commit-citation'
  ];
  for (const channel of channels) {
    assert.match(main, new RegExp(`registerIpcHandler\\('${channel}'`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`));
  }
  assert.doesNotMatch(preload, /appendEvidenceReviewEvent|writeEvidenceFile|deleteEvidenceRevision/);
  assert.match(main, /assertExistingFileInside\(pathFromFileUrlOrPath\(locator\), \[localPdfDir, downloadPdfDir, tempPdfDir\], '\.pdf'\)/);
});
