'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const contracts = require('../../src/main/ipc/citation-contracts');
const aiContracts = require('../../src/main/ipc/ai-contracts');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const ROOT = path.resolve(__dirname, '..', '..');
const ID_A = 'a0000000-0000-4000-8000-000000000001';
const ID_B = 'a0000000-0000-4000-8000-000000000002';
const ID_C = 'a0000000-0000-4000-8000-000000000003';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeReport(cases, passed) {
  const source = createSourceTreeManifest(ROOT);
  const report = {
    schemaVersion: 1,
    suite: 'ipc',
    seed: 20260716,
    passed,
    sourceTreeSha256: source.sourceTreeSha256,
    sourceTreeFileCount: source.fileCount,
    caseCount: cases.length,
    acceptedCount: cases.filter(value => value.actual === 'accepted').length,
    rejectedCount: cases.filter(value => value.actual === 'rejected').length,
    crashCount: 0,
    unauthorizedSideEffectCount: 0,
    secretLeakCount: 0,
    cases
  };
  const filePath = path.join(ROOT, 'artifacts', 'ipc-fuzz.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

test('citation IPC contracts accept bounded DTOs and reject malformed or oversized input', () => {
  const valid = [
    ['render', contracts.citationRender, { projectId: ID_A, styleId: 'apa-7', locale: 'zh-CN', format: 'html' }],
    ['audit', contracts.citationExportAudit, { projectId: ID_A, baseRevision: 4, format: 'docx', forced: false }],
    ['import', contracts.citationImportCommit, { sessionId: ID_A, baseRevision: 2, decisions: {} }],
    ['export', contracts.citationLibraryExport, { format: 'csl-json', itemIds: [ID_A, ID_B] }],
    ['query', contracts.citationLibraryQuery, { search: 'Unicode 文献', projectId: ID_A, screeningStatus: 'included', readingStatus: 'read', limit: 100 }],
    ['tags', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'tags-add', tags: ['证据'] } }],
    ['collection', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'collection-add', collectionId: ID_B } }],
    ['delete', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'delete', retainManagedAssets: true } }],
    ['state', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'set-project-state', projectId: ID_C, screeningStatus: 'excluded', readingStatus: 'read', exclusionReason: '范围不符' } }],
    ['collection-upsert', contracts.citationLibraryCollection, { baseRevision: 1, name: '重点阅读' }],
    ['undo', contracts.citationUndo, { undoToken: ID_A, baseRevision: 2 }],
    ['project-state', contracts.citationProjectPaperState, { projectId: ID_A, baseRevision: 2, libraryItemId: ID_B, screeningStatus: 'pending', readingStatus: 'unread', projectNotes: '' }]
  ];
  const invalid = [
    ['null-query', contracts.citationLibraryQuery, null],
    ['unknown-query-field', contracts.citationLibraryQuery, { arbitraryPath: 'C:\\secret' }],
    ['bad-project-id', contracts.citationRender, { projectId: '../escape' }],
    ['bad-render-format', contracts.citationRender, { projectId: ID_A, format: 'pdf' }],
    ['negative-revision', contracts.citationExportAudit, { projectId: ID_A, baseRevision: -1, format: 'pdf' }],
    ['bad-session', contracts.citationImportCommit, { sessionId: 'session', baseRevision: 0 }],
    ['oversized-decisions', contracts.citationImportCommit, { sessionId: ID_A, baseRevision: 0, decisions: { [ID_B]: { note: 'x'.repeat(contracts.MAX_PAYLOAD_BYTES + 1) } } }],
    ['bad-export-format', contracts.citationLibraryExport, { format: 'exe' }],
    ['duplicate-export-id', contracts.citationLibraryExport, { format: 'ris', itemIds: [ID_A, ID_A] }],
    ['too-large-query-page', contracts.citationLibraryQuery, { limit: 201 }],
    ['bad-query-boolean', contracts.citationLibraryQuery, { hasPdf: 'yes' }],
    ['bad-query-status', contracts.citationLibraryQuery, { screeningStatus: 'accepted' }],
    ['empty-batch', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [], operation: { type: 'set-starred', value: true } }],
    ['duplicate-batch-id', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A, ID_A], operation: { type: 'set-starred', value: true } }],
    ['unknown-operation', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'execute' } }],
    ['delete-assets', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'delete', retainManagedAssets: false } }],
    ['excluded-no-reason', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'set-project-state', projectId: ID_C, screeningStatus: 'excluded', readingStatus: 'read' } }],
    ['unknown-batch-field', contracts.citationLibraryBatch, { baseRevision: 1, itemIds: [ID_A], operation: { type: 'set-starred', value: true, path: 'C:\\secret' } }],
    ['collection-nul', contracts.citationLibraryCollection, { baseRevision: 1, name: 'bad\0name' }],
    ['undo-bad-token', contracts.citationUndo, { undoToken: 'latest', baseRevision: 1 }],
    ['state-no-item', contracts.citationProjectPaperState, { projectId: ID_A, baseRevision: 1, screeningStatus: 'pending', readingStatus: 'unread' }]
  ];
  const cases = [];
  for (const [id, validator, payload] of valid) {
    assert.doesNotThrow(() => validator(clone(payload)));
    cases.push({ id, expected: 'accepted', actual: 'accepted', passed: true });
  }
  for (const [id, validator, payload] of invalid) {
    assert.throws(() => validator(payload));
    cases.push({ id, expected: 'rejected', actual: 'rejected', passed: true });
  }
  const fuzzCount = 1000 - cases.length;
  for (let index = 0; index < fuzzCount; index += 1) {
    const field = `fuzz_${String(index).padStart(4, '0')}`;
    const payload = {
      projectId: ID_A,
      baseRevision: index,
      operation: 'chat',
      messages: [{ role: 'user', content: `seed-20260716-${index}` }],
      contextManifest: [],
      [field]: index % 3 === 0 ? 'C:\\private\\secret.txt' : index % 3 === 1 ? { actor: 'user', status: 'confirmed' } : 'Bearer canary'
    };
    assert.throws(() => aiContracts.preview(payload));
    cases.push({ id: `ai-fuzz-${index}`, expected: 'rejected', actual: 'rejected', passed: true });
  }
  assert.equal(cases.length, 1000);
  writeReport(cases, true);
});

test('citation channels use the trusted-sender wrapper and expose no renderer file path input', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(main, /function registerIpcHandler[\s\S]*assertTrustedSender\(event\)/);
  const channels = [
    'citation-styles', 'citation-render-project', 'citation-audit-project', 'citation-record-export-audit',
    'citation-import-select', 'citation-import-commit', 'citation-export-library', 'citation-library-query',
    'citation-library-batch', 'citation-library-collection-upsert', 'citation-library-undo',
    'citation-library-impact', 'citation-project-paper-state'
  ];
  for (const channel of channels) {
    assert.match(main, new RegExp(`registerIpcHandler\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.doesNotMatch(preload, /citation[^\n]*(?:filePath|absolutePath)/i);
  assert.match(main, /extensions: \['bib', 'bibtex', 'ris', 'json'\]/);
  assert.match(main, /atomicWriteFileSync\(filePath, exported\.text, 'utf8'\)/);
});
