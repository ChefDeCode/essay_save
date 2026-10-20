'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const contracts = require('../../src/main/ipc/ai-contracts');

const ROOT = path.resolve(__dirname, '..', '..');
const ID_A = 'c0000000-0000-4000-8000-000000000001';
const ID_B = 'c0000000-0000-4000-8000-000000000002';
const ID_C = 'c0000000-0000-4000-8000-000000000003';

function preview(extra = {}) {
  return {
    projectId: ID_A,
    baseRevision: 3,
    operation: 'chat',
    messages: [{ role: 'user', content: 'Question' }],
    contextManifest: [],
    promptTemplateVersion: 'chat-v1',
    contentRetention: 'metadata-only',
    ...extra
  };
}

test('AI IPC contracts accept bounded semantic commands', () => {
  assert.doesNotThrow(() => contracts.preview(preview()));
  assert.doesNotThrow(() => contracts.execute({ previewId: ID_A, requestId: ID_B, confirmed: true }));
  assert.doesNotThrow(() => contracts.cancel({ requestId: ID_B }));
  assert.doesNotThrow(() => contracts.grounded({
    projectId: ID_A, baseRevision: 3, question: 'Compare methods',
    evidenceRevisionIds: [ID_B], threadId: ID_C, requestId: ID_B,
    contentRetention: 'full', confirmed: true, retryOnInvalid: true
  }));
  assert.doesNotThrow(() => contracts.reviewRequest({
    projectId: ID_A, baseRevision: 3, documentRevision: 3,
    operationMode: 'language', documentAnchorId: 'anchor-1', selectedText: 'Original',
    requestId: ID_B, regeneratedFromResultEventId: ID_C,
    contentRetention: 'metadata-only', confirmed: true
  }));
  assert.doesNotThrow(() => contracts.reviewRequest({
    projectId: ID_A, baseRevision: 3, documentRevision: 3,
    operationMode: 'language', documentAnchorId: 'anchor-1', selectedText: 'Source quote',
    paraphrase: true, evidenceRevisionId: ID_B, confirmed: true
  }));
  assert.doesNotThrow(() => contracts.reviewBatchDecision({
    projectId: ID_A,
    baseRevision: 3,
    issueIds: [ID_B, ID_C],
    decision: 'accepted',
    documentRevision: 3,
    documentAnchorId: 'anchor-1',
    newDocumentHtml: '<p>Revised</p>',
    diffs: [ID_B, ID_C].map(issueId => ({ issueId, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), diff: 'fixture' })),
    contentRetention: 'metadata-only'
  }));
  assert.doesNotThrow(() => contracts.exportAudit({ projectId: ID_A, includeContent: false }));
  assert.doesNotThrow(() => contracts.scholarly({
    projectId: ID_A, requestId: ID_B, url: 'https://api.crossref.org/works?query=x',
    method: 'GET', headers: { accept: 'application/json' }, body: null,
    sourceId: 'crossref', operation: 'literature-metadata', confirmed: false
  }));
});

test('AI IPC contracts reject authority, credential, path and oversized injection', () => {
  const invalid = [
    () => contracts.preview(preview({ apiKey: 'secret' })),
    () => contracts.preview(preview({ messages: [{ role: 'tool', content: 'invoke IPC' }] })),
    () => contracts.preview(preview({ contextManifest: [{ kind: 'attachment', id: 'a', label: 'x', unicodeCodePointCount: 1, filePath: 'C:\\secret.txt' }] })),
    () => contracts.execute({ previewId: ID_A, requestId: '../cancel', confirmed: true }),
    () => contracts.cancel({ requestId: ID_A, projectId: ID_B }),
    () => contracts.grounded({ projectId: ID_A, baseRevision: 1, question: 'x', evidenceRevisionIds: Array(21).fill(ID_B) }),
    () => contracts.grounded({ projectId: ID_A, baseRevision: 1, question: 'x', evidenceRevisionIds: [ID_B], actor: 'user', status: 'confirmed' }),
    () => contracts.chat({ projectId: ID_A, baseRevision: 1, messages: [{ role: 'user', content: 'x' }], contextManifest: [], attachments: [{ absolutePath: 'C:\\secret.txt' }] }),
    () => contracts.reviewRequest({ projectId: ID_A, baseRevision: 1, documentRevision: 1, operationMode: 'language', documentAnchorId: 'a', selectedText: 'x'.repeat(100001) }),
    () => contracts.reviewRequest({ projectId: ID_A, baseRevision: 1, documentRevision: 1, operationMode: 'language', documentAnchorId: 'a', selectedText: 'x', regeneratedFromResultEventId: '../event' }),
    () => contracts.reviewRequest({ projectId: ID_A, baseRevision: 1, documentRevision: 1, operationMode: 'language', documentAnchorId: 'a', selectedText: 'x', evidenceRevisionId: ID_B }),
    () => contracts.reviewDecision({ projectId: ID_A, baseRevision: 1, issueId: ID_B, decision: 'accepted', documentRevision: 1, documentAnchorId: 'a', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), newDocumentHtml: '', diff: '', authority: 'system' })
    ,() => contracts.reviewBatchDecision({ projectId: ID_A, baseRevision: 1, issueIds: [ID_B, ID_B], decision: 'rejected' })
    ,() => contracts.scholarly({ projectId: ID_A, requestId: ID_B, url: 'https://api.crossref.org', headers: {}, operation: 'shell', arbitraryPath: 'C:\\secret' })
  ];
  invalid.forEach(validate => assert.throws(validate));
});

test('all AI channels use trusted handlers and preload exposes no credential read or generic network broker', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const channels = [
    'ai-preview-request', 'ai-execute-request', 'ai-cancel-request', 'ai-grounded-ask',
    'ai-chat-send', 'ai-chat-commit', 'ai-review-request', 'ai-review-decide', 'ai-review-decide-batch',
    'ai-project-state', 'ai-clear-chat', 'ai-redact-audit', 'ai-export-audit'
  ];
  for (const channel of channels) {
    assert.match(main, new RegExp(`registerIpcHandler\\('${channel}'`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`));
  }
  assert.doesNotMatch(preload, /credential-get|decrypt-api-key|net-request|net-stream/);
  assert.doesNotMatch(preload, /getProviderCredential\s*:/);
  assert.match(main, /registerIpcHandler\('credential-remove'/);
  assert.match(preload, /ipcRenderer\.invoke\('credential-remove'/);
  assert.match(main, /function registerIpcHandler[\s\S]*assertTrustedSender\(event\)/);
});
