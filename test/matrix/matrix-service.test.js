'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const { TrustedAiService } = require('../../src/main/ai/trusted-ai-service');
const { AssetStore } = require('../../src/main/data/asset-store');
const { EvidenceService } = require('../../src/main/evidence/evidence-service');
const { ProjectRepository } = require('../../src/main/data/repository');
const { createEmptyProjectAggregate, validateProjectAggregate } = require('../../src/main/data/schema');
const { MatrixService, normalizeSource, parseModelContent } = require('../../src/main/matrix/matrix-service');
const { buildRows, csv, exportCsvZip, exportXlsx, safeText, worksheet } = require('../../src/main/matrix/matrix-export');

const PROJECT_ID = 'b5000000-0000-4000-8000-000000000001';

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 17, 10, 0, tick++));
}

function citationId(index) {
  return `b5000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`;
}

function responseJson() {
  return JSON.stringify({ cells: [
    { columnKey: 'method', value: '随机对照试验', pageLabel: '2', quote: 'The study used a randomized controlled trial.' },
    { columnKey: 'sample', value: '120 名参与者', pageLabel: '3', quote: 'The sample included 120 participants.' },
    { columnKey: 'conclusions', value: '干预改善主要结局', pageLabel: '5', quote: 'The intervention improved the primary outcome.' }
  ], reviewStatus: 'confirmed', actor: 'user' });
}

async function fixture(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'essayflow-m5-matrix-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const now = fixedClock();
  const assetStore = new AssetStore(path.join(root, 'assets'), { now });
  const repository = new ProjectRepository({ rootPath: root, assetStore, now });
  await repository.initialize();
  const timestamp = now().toISOString();
  const aggregate = createEmptyProjectAggregate({
    projectId: PROJECT_ID, title: 'M5 matrix fixture', createdAt: timestamp, updatedAt: timestamp,
    privacyMode: options.privacyMode || 'normal'
  });
  for (let index = 0; index < (options.paperCount || 10); index += 1) {
    const id = citationId(index);
    aggregate.citationItems.push({
      schemaVersion: 1, id, citationItemId: id, projectId: PROJECT_ID,
      type: 'article-journal', title: `候选文献 ${index + 1}`,
      author: [{ family: `Author${index + 1}`, given: 'Test' }],
      issued: { 'date-parts': [[2020 + index]] }, DOI: `10.5555/matrix.${index + 1}`
    });
    aggregate.projectPaperStates.push({
      schemaVersion: 1, id: crypto.randomUUID(), projectId: PROJECT_ID, citationItemId: id,
      screeningStatus: 'included', readingStatus: index % 2 ? 'read' : 'to-read', projectNotes: '',
      createdAt: timestamp, updatedAt: timestamp
    });
  }
  const created = await repository.createProject({ projectId: PROJECT_ID, aggregate });
  const asset = await assetStore.putBuffer({
    buffer: Buffer.from('%PDF-1.7\nM5 deterministic synthetic source'), kind: 'pdf', mimeType: 'application/pdf', originalName: 'm5.pdf'
  });
  const captured = [];
  const trustedAi = new TrustedAiService({
    repository,
    settingsStore: { readSync: () => ({ providerId: 'm5-provider', providerOrigin: options.providerOrigin || 'https://provider.example', model: 'm5-fixture' }) },
    secretStore: { getCredential: () => 'm5-secret' },
    transport: async request => {
      captured.push(request);
      if (options.transport) return options.transport(request, captured.length);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: responseJson() } }] }) };
    },
    now,
    sessionId: 'b5000000-0000-4000-8000-000000000099'
  });
  const service = new MatrixService({ repository, assetStore, trustedAiService: trustedAi, now });
  const createdMatrix = await service.create({ projectId: PROJECT_ID, baseRevision: created.revision, name: '系统综述矩阵' });
  return { root, now, assetStore, repository, trustedAi, service, matrix: createdMatrix.matrix, revision: createdMatrix.revision, asset, captured };
}

function pages() {
  return [
    { pageIndex: 1, pageLabel: '2', text: 'Methods. The study used a randomized controlled trial. End.' },
    { pageIndex: 2, pageLabel: '3', text: 'Participants. The sample included 120 participants. End.' },
    { pageIndex: 4, pageLabel: '5', text: 'Results. The intervention improved the primary outcome. End.' }
  ];
}

test('default matrix persists included candidates and supports protected manual cells plus column CRUD', async t => {
  const value = await fixture(t);
  assert.equal(value.matrix.columns.length, 10);
  assert.deepEqual(value.matrix.columns.map(column => column.label), [
    '作者', '年份', '研究问题', '方法', '样本', '变量', '结论', '局限', '与本研究关系', '证据摘录'
  ]);
  assert.equal(value.matrix.rows.length, 10);
  const firstPaperRow = value.matrix.rows.find(row => row.citationItemId === citationId(0));
  assert.equal(firstPaperRow.cells[value.matrix.columns[0].id].value, 'Author1, Test');
  assert.equal(firstPaperRow.cells[value.matrix.columns[1].id].value, '2020');

  const added = await value.service.addColumn({
    projectId: PROJECT_ID, baseRevision: value.revision, matrixId: value.matrix.id, label: '自定义评价'
  });
  assert.equal(added.column.userDefined, true);
  let listed = await value.service.list(PROJECT_ID);
  const custom = listed.matrices[0].columns.at(-1);
  const reverse = [...listed.matrices[0].columns].reverse().map(column => column.id);
  const reordered = await value.service.reorderColumns({
    projectId: PROJECT_ID, baseRevision: listed.revision, matrixId: value.matrix.id, columnIds: reverse
  });
  assert.equal(reordered.columns[0].id, custom.id);
  listed = await value.service.list(PROJECT_ID);
  const edited = await value.service.updateCell({
    projectId: PROJECT_ID, baseRevision: listed.revision, matrixId: value.matrix.id,
    rowId: listed.matrices[0].rows[0].id, columnId: custom.id, value: '=SUM(A1:A2)\n用户换行'
  });
  assert.equal(edited.cell.userEdited, true);
  assert.equal(edited.cell.origin, 'user');
  assert.equal(edited.cell.reviewStatus, 'confirmed');
  listed = await value.service.list(PROJECT_ID);
  await value.service.deleteColumn({
    projectId: PROJECT_ID, baseRevision: listed.revision, matrixId: value.matrix.id, columnId: custom.id
  });
  listed = await value.service.list(PROJECT_ID);
  assert.equal(listed.matrices[0].columns.some(column => column.id === custom.id), false);

  await assert.rejects(value.service.updateCell({
    projectId: PROJECT_ID, baseRevision: listed.revision, matrixId: value.matrix.id,
    rowId: listed.matrices[0].rows[0].id, columnId: listed.matrices[0].columns[0].id,
    value: 'bad', origin: 'ai'
  }), error => error.code === 'MATRIX_AUTHORITY_INVALID');
});

test('ten-paper batch keeps user edits, creates proposed PDF evidence, leaves abstracts draft and isolates corrupt failure', async t => {
  const value = await fixture(t);
  let state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const method = matrix.columns.find(column => column.key === 'method');
  const protectedEdit = await value.service.updateCell({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id,
    rowId: matrix.rows[0].id, columnId: method.id, value: '用户核对的方法'
  });
  state = await value.service.list(PROJECT_ID);
  const sourcesByCitationId = {};
  state.matrices[0].rows.forEach((row, index) => {
    sourcesByCitationId[row.citationItemId] = index < 7
      ? { type: 'pdf', assetId: value.asset.assetId, fileSha256: value.asset.sha256, pages: pages() }
      : index < 9 ? { type: 'abstract', abstract: `Abstract-only finding ${index}` }
        : { type: 'corrupt', reason: '损坏 PDF fixture' };
  });
  const preview = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id,
    rowIds: state.matrices[0].rows.map(row => row.id), sourcesByCitationId, overwriteColumnIds: []
  });
  assert.equal(preview.papers.length, 10);
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.papers.filter(paper => paper.sourceType === 'abstract').length, 2);
  assert.equal(preview.pageCount, 21);
  assert.ok(preview.totalOutboundCodePointCount > 0);
  const completed = await value.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  assert.equal(completed.outcomes.filter(item => item.status === 'completed').length, 9);
  assert.equal(completed.outcomes.filter(item => item.status === 'failed').length, 1);
  assert.equal(value.captured.length, 9);

  state = await value.service.list(PROJECT_ID);
  const result = state.matrices[0];
  assert.equal(result.rows[0].cells[method.id].value, protectedEdit.cell.value);
  assert.equal(result.rows[0].cells[method.id].userEdited, true);
  const pdfCell = result.rows[1].cells[method.id];
  assert.equal(pdfCell.origin, 'ai');
  assert.equal(pdfCell.reviewStatus, 'draft');
  assert.equal(pdfCell.citationItemId, result.rows[1].citationItemId);
  assert.equal(pdfCell.sourceRefs.length, 1);
  const abstractCell = result.rows[7].cells[method.id];
  assert.equal(abstractCell.basis, 'abstract-only');
  assert.equal(abstractCell.reviewStatus, 'draft');
  assert.equal(abstractCell.sourceRefs.length, 0);
  assert.match(abstractCell.abstractSnapshotSha256, /^[0-9a-f]{64}$/);
  assert.equal(abstractCell.abstractSnapshotText, 'Abstract-only finding 7');
  assert.equal(result.rows[9].taskStatus, 'failed');
  assert.equal(result.rows[9].failureReason, '损坏 PDF fixture');

  const aggregate = await value.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.evidenceRevisions.every(revision => revision.createdBy === 'ai'), true);
  assert.equal(aggregate.evidenceReviewEvents.every(event => event.actor === 'ai' && event.status === 'proposed'), true);
  assert.equal(aggregate.auditEvents.filter(event => event.eventType === 'ai-request' && event.networkContext.operation === 'matrix-extraction').length, 9);
  validateProjectAggregate(aggregate);
  const evidenceZip = await value.service.export({ projectId: PROJECT_ID, matrixId: matrix.id, format: 'csv' });
  const evidenceFiles = await JSZip.loadAsync(evidenceZip.buffer);
  const evidenceSources = await evidenceFiles.file('sources.csv').async('string');
  assert.match(evidenceSources, /EvidenceRevision ID/);
  assert.match(evidenceSources, /单元格 ID/);
  assert.match(evidenceSources, /随机对照试验/);

  const reviewed = await value.service.reviewCell({
    projectId: PROJECT_ID, baseRevision: aggregate.manifest.revision, matrixId: matrix.id,
    rowId: result.rows[1].id, columnId: method.id, decision: 'confirmed'
  });
  assert.equal(reviewed.cell.reviewedBy, 'user');
  assert.equal(reviewed.cell.reviewStatus, 'confirmed');
  const afterReview = await value.service.list(PROJECT_ID);
  await assert.rejects(value.service.reviewCell({
    projectId: PROJECT_ID, baseRevision: afterReview.revision, matrixId: matrix.id,
    rowId: result.rows[7].id, columnId: method.id, decision: 'confirmed'
  }), error => error.code === 'MATRIX_ABSTRACT_CONFIRM_FORBIDDEN');
});

test('CSV ZIP and XLSX preserve Unicode, newlines, sources and escape spreadsheet formulas without active content', async t => {
  const value = await fixture(t);
  let state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const relation = matrix.columns.find(column => column.key === 'relation');
  await value.service.updateCell({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id,
    rowId: matrix.rows[0].id, columnId: relation.id, value: '=HYPERLINK("https://bad.example")\n中文第二行'
  });
  state = await value.service.list(PROJECT_ID);
  const exportedCsv = await value.service.export({ projectId: PROJECT_ID, matrixId: matrix.id, format: 'csv' });
  const csvZip = await JSZip.loadAsync(exportedCsv.buffer);
  assert.deepEqual(Object.keys(csvZip.files).sort(), ['matrix.csv', 'sources.csv']);
  const matrixCsv = await csvZip.file('matrix.csv').async('string');
  assert.match(matrixCsv, /'=HYPERLINK/);
  assert.match(matrixCsv, /中文第二行/);
  assert.match(await csvZip.file('sources.csv').async('string'), /Sources|矩阵|系统综述矩阵/u);

  const exportedXlsx = await value.service.export({ projectId: PROJECT_ID, matrixId: matrix.id, format: 'xlsx' });
  const xlsx = await JSZip.loadAsync(exportedXlsx.buffer);
  assert.ok(xlsx.file('xl/worksheets/sheet1.xml'));
  assert.ok(xlsx.file('xl/worksheets/sheet2.xml'));
  assert.equal(Object.keys(xlsx.files).some(name => /vbaProject|externalLinks|macros/i.test(name)), false);
  const sheet = await xlsx.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /&apos;=HYPERLINK|&apos;|\'=HYPERLINK/);
  assert.match(sheet, /中文第二行/);

  assert.equal(safeText('@cmd'), "'@cmd");
  assert.match(csv([['a,b', 'x"y', '-1']]), /"a,b","x""y",'-1/);
  assert.match(worksheet([['<unsafe>', '换行\n文本']]), /&lt;unsafe&gt;/);
  const directRows = buildRows(state.matrices[0], (await value.repository.loadProject(PROJECT_ID)).citationItems);
  assert.equal(directRows.matrixRows.length, 11);
  assert.ok((await exportCsvZip(state.matrices[0], (await value.repository.loadProject(PROJECT_ID)).citationItems)).length > 0);
  assert.ok((await exportXlsx(state.matrices[0], (await value.repository.loadProject(PROJECT_ID)).citationItems)).length > 0);
});

test('local-only blocks remote prefill while manual editing/export remain durable, and malformed output fails one row only', async t => {
  const local = await fixture(t, { privacyMode: 'local-only' });
  let state = await local.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const row = matrix.rows[0];
  const method = matrix.columns.find(column => column.key === 'method');
  const preview = await local.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: [row.id],
    sourcesByCitationId: { [row.citationItemId]: { type: 'abstract', abstract: 'Local-only abstract' } }, overwriteColumnIds: []
  });
  assert.equal(preview.blocked, true);
  const blocked = await local.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  assert.equal(blocked.outcomes[0].status, 'failed');
  assert.equal(local.captured.length, 0);
  state = await local.service.list(PROJECT_ID);
  const manual = await local.service.updateCell({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowId: row.id, columnId: method.id, value: '本地手工内容'
  });
  assert.equal(manual.cell.value, '本地手工内容');
  assert.ok((await local.service.export({ projectId: PROJECT_ID, matrixId: matrix.id, format: 'xlsx' })).byteCount > 0);

  const malformed = await fixture(t, { transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{bad' } }] }) }) });
  state = await malformed.service.list(PROJECT_ID);
  const malformedRow = state.matrices[0].rows[0];
  const badPreview = await malformed.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: malformed.matrix.id, rowIds: [malformedRow.id],
    sourcesByCitationId: { [malformedRow.citationItemId]: { type: 'abstract', abstract: 'Material' } }, overwriteColumnIds: []
  });
  const outcome = await malformed.service.executePrefillBatch({ previewId: badPreview.previewId, confirmed: true });
  assert.equal(outcome.outcomes[0].status, 'failed');
  const badState = await malformed.service.list(PROJECT_ID);
  assert.equal(badState.matrices[0].rows[0].taskStatus, 'failed');
});

test('parser/source validation and aggregate authority checks fail closed', async t => {
  assert.equal(parseModelContent('```json\n{"cells":[]}\n```').length, 0);
  assert.throws(() => parseModelContent('not json'), error => error.code === 'MATRIX_AI_RESPONSE_INVALID');
  assert.throws(() => parseModelContent('{"cells":"bad"}'), error => error.code === 'MATRIX_AI_RESPONSE_INVALID');
  assert.equal(normalizeSource({ type: 'abstract', abstract: '摘要' }, citationId(0)).type, 'abstract');
  assert.equal(normalizeSource({ type: 'corrupt' }, citationId(0)).reason, 'PDF 无法解析');
  assert.throws(() => normalizeSource({ type: 'abstract', abstract: '' }, citationId(0)), error => error.code === 'MATRIX_SOURCE_INVALID');
  assert.throws(() => normalizeSource({ type: 'pdf', pages: [] }, citationId(0)), error => error.code === 'MATRIX_SOURCE_INVALID');

  const value = await fixture(t);
  const aggregate = await value.repository.loadProject(PROJECT_ID);
  const matrix = aggregate.reviewMatrices[0];
  const column = matrix.columns.find(item => item.key === 'method');
  const timestamp = value.now().toISOString();
  matrix.rows[0].cells[column.id] = {
    schemaVersion: 1, id: crypto.randomUUID(), columnId: column.id, citationItemId: matrix.rows[0].citationItemId,
    value: '恶意确认', origin: 'ai',
    reviewStatus: 'confirmed', userEdited: false, basis: 'not-found', sourceRefs: [],
    auditResultEventId: crypto.randomUUID(), createdAt: timestamp, updatedAt: timestamp
  };
  assert.throws(() => validateProjectAggregate(aggregate), error => error.code === 'SCHEMA_MATRIX_AI_AUTO_CONFIRMED');
});

test('evidence confirmation and matrix-cell confirmation are separate user decisions', async t => {
  const value = await fixture(t);
  let state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const row = matrix.rows[0];
  const method = matrix.columns.find(column => column.key === 'method');
  const preview = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: [row.id],
    sourcesByCitationId: { [row.citationItemId]: { type: 'pdf', assetId: value.asset.assetId, fileSha256: value.asset.sha256, pages: pages() } },
    overwriteColumnIds: [], overwriteCellIds: []
  });
  await value.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  state = await value.service.list(PROJECT_ID);
  const cell = state.matrices[0].rows[0].cells[method.id];
  assert.equal(cell.reviewStatus, 'draft');
  const evidence = new EvidenceService({ repository: value.repository, assetStore: value.assetStore, now: value.now });
  const evidenceReview = await evidence.reviewProposedEvidenceByUser({
    projectId: PROJECT_ID, baseRevision: state.revision,
    evidenceRevisionId: cell.sourceRefs[0].evidenceRevisionId, expectedSequence: 1, decision: 'confirmed'
  });
  state = await value.service.list(PROJECT_ID);
  assert.equal(state.matrices[0].rows[0].cells[method.id].reviewStatus, 'draft');
  const cellReview = await value.service.reviewCell({
    projectId: PROJECT_ID, baseRevision: evidenceReview.revision, matrixId: matrix.id,
    rowId: row.id, columnId: method.id, decision: 'confirmed'
  });
  assert.equal(cellReview.cell.reviewStatus, 'confirmed');
  assert.equal(cellReview.cell.reviewedBy, 'user');
});

test('matrix audit and evidence chains fail closed without committing invalid aggregates', async t => {
  const value = await fixture(t);
  let state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const rows = matrix.rows.slice(0, 2);
  const sourcesByCitationId = Object.fromEntries(rows.map(row => [row.citationItemId, {
    type: 'pdf', assetId: value.asset.assetId, fileSha256: value.asset.sha256, pages: pages()
  }]));
  const preview = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id,
    rowIds: rows.map(row => row.id), sourcesByCitationId, overwriteColumnIds: [], overwriteCellIds: []
  });
  await value.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  const pristine = await value.repository.loadProject(PROJECT_ID);
  const currentRevision = pristine.manifest.revision;
  const method = pristine.reviewMatrices[0].columns.find(column => column.key === 'method');
  const firstCell = pristine.reviewMatrices[0].rows[0].cells[method.id];
  const secondCell = pristine.reviewMatrices[0].rows[1].cells[method.id];
  const result = pristine.auditEvents.find(event => event.eventId === firstCell.auditResultEventId);
  const request = pristine.auditEvents.find(event => event.eventId === result.requestEventId);
  const mutations = [
    aggregate => { delete aggregate.reviewMatrices[0].rows[0].cells[method.id].auditResultEventId; },
    aggregate => { aggregate.auditEvents.find(event => event.eventId === result.eventId).projectId = crypto.randomUUID(); },
    aggregate => { aggregate.auditEvents.find(event => event.eventId === request.eventId).networkContext.operation = 'rewrite'; },
    aggregate => { aggregate.auditEvents.find(event => event.eventId === result.eventId).requestEventId = crypto.randomUUID(); },
    aggregate => { aggregate.reviewMatrices[0].rows[0].cells[method.id].auditResultEventId = secondCell.auditResultEventId; }
  ];
  for (const mutate of mutations) {
    const invalid = JSON.parse(JSON.stringify(pristine));
    mutate(invalid);
    await assert.rejects(value.repository.saveProject({
      projectId: PROJECT_ID, baseRevision: currentRevision, aggregate: invalid, source: 'invalid-matrix-fixture'
    }));
    assert.equal((await value.repository.loadProject(PROJECT_ID)).manifest.revision, currentRevision);
  }
});

test('active matrix batch cancellation aborts transport and marks current and pending rows canceled', async t => {
  let transportStarted;
  const started = new Promise(resolve => { transportStarted = resolve; });
  const value = await fixture(t, { transport: request => new Promise((resolve, reject) => {
    transportStarted();
    request.signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true });
  }) });
  const state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const rows = matrix.rows.slice(0, 3);
  const preview = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: rows.map(row => row.id),
    sourcesByCitationId: Object.fromEntries(rows.map(row => [row.citationItemId, { type: 'abstract', abstract: '待取消摘要' }])),
    overwriteColumnIds: [], overwriteCellIds: []
  });
  const executing = value.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  await started;
  assert.equal(value.service.cancelBatch({ batchId: preview.previewId }).cancelled, true);
  const result = await executing;
  assert.deepEqual(result.outcomes.map(item => item.status), ['canceled', 'canceled', 'canceled']);
  const after = await value.service.list(PROJECT_ID);
  assert.deepEqual(after.matrices[0].rows.slice(0, 3).map(row => row.taskStatus), ['canceled', 'canceled', 'canceled']);
});

test('an exact 50-paper batch can be canceled before transport and leaves every row explicit', async t => {
  const value = await fixture(t, { paperCount: 50 });
  const state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  assert.equal(matrix.rows.length, 50);
  const preview = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id,
    rowIds: matrix.rows.map(row => row.id),
    sourcesByCitationId: Object.fromEntries(matrix.rows.map(row => [row.citationItemId, { type: 'abstract', abstract: '50 篇取消 fixture' }])),
    overwriteColumnIds: [], overwriteCellIds: []
  });
  const executing = value.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  assert.equal(value.service.cancelBatch({ batchId: preview.previewId }).cancelled, true);
  const result = await executing;
  assert.equal(result.outcomes.length, 50);
  assert.equal(result.outcomes.every(item => item.status === 'canceled'), true);
  assert.equal(value.captured.length, 0);
  const after = await value.service.list(PROJECT_ID);
  assert.equal(after.matrices[0].rows.every(row => row.taskStatus === 'canceled'), true);
});

test('service boundary rejects stale, missing, excluded, malformed and unsafe matrix mutations', async t => {
  assert.throws(() => new MatrixService(), error => error.code === 'MATRIX_SERVICE_CONFIG_INVALID');
  const value = await fixture(t);
  let state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const row = matrix.rows[0];
  const column = matrix.columns[0];
  await assert.rejects(value.service.list('bad-id'), error => error.code === 'MATRIX_INPUT_INVALID');
  await assert.rejects(value.service.addColumn({ projectId: PROJECT_ID, baseRevision: 999, matrixId: matrix.id, label: 'x' }), error => error.code === 'MATRIX_REVISION_CONFLICT');
  await assert.rejects(value.service.addColumn({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, label: '' }), error => error.code === 'MATRIX_COLUMN_INVALID');
  await assert.rejects(value.service.deleteColumn({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, columnId: crypto.randomUUID() }), error => error.code === 'MATRIX_COLUMN_NOT_FOUND');
  await assert.rejects(value.service.reorderColumns({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, columnIds: [column.id] }), error => error.code === 'MATRIX_COLUMN_ORDER_INVALID');
  await assert.rejects(value.service.updateCell({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowId: crypto.randomUUID(), columnId: column.id, value: 'x' }), error => error.code === 'MATRIX_CELL_NOT_FOUND');
  await assert.rejects(value.service.updateCell({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowId: row.id, columnId: crypto.randomUUID(), value: 'x' }), error => error.code === 'MATRIX_CELL_NOT_FOUND');
  await assert.rejects(value.service.reviewCell({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowId: row.id, columnId: column.id, decision: 'confirmed' }), error => error.code === 'MATRIX_AI_CELL_NOT_FOUND');
  await assert.rejects(value.service.export({ projectId: PROJECT_ID, matrixId: matrix.id, format: 'ods' }), error => error.code === 'MATRIX_EXPORT_FORMAT_INVALID');
  assert.deepEqual(value.service.cancelBatch({ batchId: crypto.randomUUID() }), { cancelled: false });
  const inactiveBatchId = crypto.randomUUID();
  value.service.activeBatches.set(inactiveBatchId, { cancelled: false, activeRequestId: null });
  assert.deepEqual(value.service.cancelBatch({ batchId: inactiveBatchId }), { cancelled: true });
  const activeBatchId = crypto.randomUUID();
  value.service.activeBatches.set(activeBatchId, { cancelled: false, activeRequestId: crypto.randomUUID() });
  assert.deepEqual(value.service.cancelBatch({ batchId: activeBatchId }), { cancelled: true });
  await assert.rejects(value.service.executePrefillBatch({ previewId: crypto.randomUUID(), confirmed: true }), error => error.code === 'MATRIX_PREVIEW_EXPIRED');

  await assert.rejects(value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: [], sourcesByCitationId: {}, overwriteColumnIds: []
  }), error => error.code === 'MATRIX_BATCH_SIZE_INVALID');
  await assert.rejects(value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: [crypto.randomUUID()], sourcesByCitationId: {}, overwriteColumnIds: []
  }), error => error.code === 'MATRIX_ROW_NOT_FOUND');

  const onlyCorrupt = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: [row.id],
    sourcesByCitationId: { [row.citationItemId]: { type: 'corrupt' } }, overwriteColumnIds: []
  });
  assert.equal(onlyCorrupt.provider, null);
  const corruptDone = await value.service.executePrefillBatch({ previewId: onlyCorrupt.previewId, confirmed: true });
  assert.equal(corruptDone.outcomes[0].status, 'failed');
  state = await value.service.list(PROJECT_ID);
  assert.equal(await value.service._markTask(PROJECT_ID, matrix.id, crypto.randomUUID(), 'failed', 'missing'), null);

  const aggregate = await value.repository.loadProject(PROJECT_ID);
  const excludedId = citationId(1);
  aggregate.projectPaperStates.find(item => item.citationItemId === excludedId).screeningStatus = 'excluded';
  aggregate.projectPaperStates.find(item => item.citationItemId === excludedId).exclusionReason = '不符合标准';
  const saved = await value.repository.saveProject({ projectId: PROJECT_ID, baseRevision: aggregate.manifest.revision, aggregate, source: 'matrix-exclude-fixture' });
  await assert.rejects(value.service.setRows({
    projectId: PROJECT_ID, baseRevision: saved.revision, matrixId: matrix.id, citationItemIds: [excludedId]
  }), error => error.code === 'MATRIX_PAPER_NOT_INCLUDED');
  await assert.rejects(value.service.setRows({
    projectId: PROJECT_ID, baseRevision: saved.revision, matrixId: matrix.id, citationItemIds: [crypto.randomUUID()]
  }), error => error.code === 'MATRIX_CITATION_ITEM_MISSING');
});

test('explicit overwrite regenerates a user-edited cell and invalid PDF claims become declared not-found', async t => {
  const value = await fixture(t, {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cells: [
      { columnKey: 'method', value: '新方法', pageLabel: '999', quote: 'fabricated quote' }
    ] }) } }] }) })
  });
  let state = await value.service.list(PROJECT_ID);
  const matrix = state.matrices[0];
  const row = matrix.rows[0];
  const method = matrix.columns.find(item => item.key === 'method');
  await value.service.updateCell({ projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowId: row.id, columnId: method.id, value: '旧用户值' });
  state = await value.service.list(PROJECT_ID);
  const preview = await value.service.previewPrefillBatch({
    projectId: PROJECT_ID, baseRevision: state.revision, matrixId: matrix.id, rowIds: [row.id],
    sourcesByCitationId: { [row.citationItemId]: { type: 'pdf', assetId: value.asset.assetId, fileSha256: value.asset.sha256, pages: pages() } },
    overwriteColumnIds: [method.id]
  });
  await value.service.executePrefillBatch({ previewId: preview.previewId, confirmed: true });
  state = await value.service.list(PROJECT_ID);
  const result = state.matrices[0].rows.find(item => item.id === row.id).cells[method.id];
  assert.equal(result.userEdited, false);
  assert.equal(result.reviewStatus, 'not-found');
  assert.equal(result.value, '');
  assert.equal(result.sourceRefs.length, 0);
  assert.equal(safeText('ordinary'), 'ordinary');
  assert.equal(safeText(null), '');
});
