'use strict';

const crypto = require('node:crypto');

const { validateProjectAggregate } = require('../data/schema');
const { hashText, normalizeQuote } = require('../evidence/evidence-service');
const { exportCsvZip, exportXlsx } = require('./matrix-export');

const SCHEMA_VERSION = 1;
const MAX_BATCH = 50;
const DEFAULT_COLUMNS = Object.freeze([
  ['author', '作者'], ['year', '年份'], ['research-question', '研究问题'], ['method', '方法'],
  ['sample', '样本'], ['variables', '变量'], ['conclusions', '结论'], ['limitations', '局限'],
  ['relation', '与本研究关系'], ['evidence', '证据摘录']
]);

class MatrixServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MatrixServiceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new MatrixServiceError(code, message, details);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function uuid(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail('MATRIX_INPUT_INVALID', `${field} 必须是 UUID`, { field });
  }
  return value.toLowerCase();
}

function revision(aggregate, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0 || aggregate.manifest.revision !== expected) {
    fail('MATRIX_REVISION_CONFLICT', '项目 revision 已变化，请重新操作', {
      expectedRevision: aggregate.manifest.revision,
      baseRevision: expected
    });
  }
}

function citationId(item) {
  return String(item.citationItemId || item.id).toLowerCase();
}

function authors(item) {
  return (Array.isArray(item.author) ? item.author : [])
    .map(author => author.literal || [author.family, author.given].filter(Boolean).join(', '))
    .filter(Boolean).join('; ');
}

function year(item) {
  return String(item?.issued?.['date-parts']?.[0]?.[0] || item?.year || String(item?.published || '').match(/\d{4}/)?.[0] || '');
}

function defaultCell(service, column, citationItemId, value, timestamp) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: service.randomUUID(),
    columnId: column.id,
    citationItemId,
    value: String(value || ''),
    origin: 'user',
    reviewStatus: 'confirmed',
    userEdited: false,
    basis: 'manual',
    sourceRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function parseModelContent(content) {
  let text = String(content || '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { fail('MATRIX_AI_RESPONSE_INVALID', 'AI 矩阵结果不是有效 JSON'); }
  if (!parsed || !Array.isArray(parsed.cells) || parsed.cells.length > 100) {
    fail('MATRIX_AI_RESPONSE_INVALID', 'AI 矩阵结果必须包含有限 cells 数组');
  }
  return parsed.cells;
}

function normalizeSource(input, citationItemId) {
  if (!input || typeof input !== 'object') fail('MATRIX_SOURCE_INVALID', '矩阵预填缺少来源');
  if (input.type === 'abstract') {
    const abstract = String(input.abstract || '').normalize('NFC');
    if (!abstract) fail('MATRIX_SOURCE_INVALID', '摘要来源不能为空');
    return { type: 'abstract', citationItemId, abstract, sha256: hashText(abstract) };
  }
  if (input.type === 'corrupt') return { type: 'corrupt', citationItemId, reason: String(input.reason || 'PDF 无法解析') };
  if (input.type !== 'pdf' || !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 1000) {
    fail('MATRIX_SOURCE_INVALID', 'PDF 来源必须包含有限页文本');
  }
  const assetId = uuid(input.assetId, 'assetId');
  if (!/^[0-9a-f]{64}$/.test(String(input.fileSha256 || ''))) fail('MATRIX_SOURCE_INVALID', 'PDF 来源 hash 无效');
  return {
    type: 'pdf', citationItemId, assetId, fileSha256: input.fileSha256,
    pages: input.pages.map((page, index) => {
      const text = String(page.text || '').normalize('NFC');
      if (!text) fail('MATRIX_SOURCE_INVALID', `PDF 第 ${index + 1} 页文本为空`);
      return {
        pageIndex: Number(page.pageIndex),
        pageLabel: String(page.pageLabel || `PDF 第 ${Number(page.pageIndex) + 1} 页`),
        text,
        pageTextSha256: hashText(text),
        rects: clone(page.rects || [{ x: 0, y: 0, width: 1, height: 1 }]),
        pageRotation: [0, 90, 180, 270].includes(page.pageRotation) ? page.pageRotation : 0,
        cropBox: clone(page.cropBox || { x: 0, y: 0, width: 612, height: 792 })
      };
    })
  };
}

class MatrixService {
  constructor(options = {}) {
    if (!options.repository || !options.assetStore || !options.trustedAiService) {
      fail('MATRIX_SERVICE_CONFIG_INVALID', 'MatrixService 需要 repository、assetStore 和 Trusted AI gateway');
    }
    this.repository = options.repository;
    this.assetStore = options.assetStore;
    this.trustedAi = options.trustedAiService;
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.batchPreviews = new Map();
    this.activeBatches = new Map();
  }

  _matrix(aggregate, matrixId) {
    const matrix = aggregate.reviewMatrices.find(item => item.id === uuid(matrixId, 'matrixId'));
    if (!matrix) fail('MATRIX_NOT_FOUND', '综述矩阵不存在');
    return matrix;
  }

  async _save(aggregate, baseRevision, source) {
    validateProjectAggregate(aggregate);
    return this.repository.saveProject({ projectId: aggregate.manifest.projectId, baseRevision, aggregate, source });
  }

  _newRow(aggregate, citationItemId, columns, timestamp) {
    const citation = aggregate.citationItems.find(item => citationId(item) === citationItemId);
    if (!citation) fail('MATRIX_CITATION_ITEM_MISSING', '矩阵候选文献不存在', { citationItemId });
    const state = aggregate.projectPaperStates.find(item => item.citationItemId === citationItemId);
    if (!state || state.screeningStatus !== 'included') fail('MATRIX_PAPER_NOT_INCLUDED', '只有纳入的文献可以加入综述矩阵', { citationItemId });
    const cells = {};
    for (const column of columns) {
      if (column.key === 'author') cells[column.id] = defaultCell(this, column, citationItemId, authors(citation), timestamp);
      if (column.key === 'year') cells[column.id] = defaultCell(this, column, citationItemId, year(citation), timestamp);
    }
    return { id: this.randomUUID(), citationItemId, taskStatus: 'queued', attempt: 0, cells, createdAt: timestamp, updatedAt: timestamp };
  }

  async create(input = {}) {
    const projectId = uuid(input.projectId, 'projectId');
    const aggregate = await this.repository.loadProject(projectId);
    revision(aggregate, input.baseRevision);
    const timestamp = nowIso(this.now);
    const columns = DEFAULT_COLUMNS.map(([key, label], order) => ({ id: this.randomUUID(), key, label, order, userDefined: false }));
    const requested = Array.isArray(input.citationItemIds) && input.citationItemIds.length
      ? input.citationItemIds.map(id => uuid(id, 'citationItemId'))
      : aggregate.projectPaperStates.filter(state => state.screeningStatus === 'included').map(state => state.citationItemId);
    const unique = [...new Set(requested)];
    const matrix = {
      schemaVersion: SCHEMA_VERSION,
      id: this.randomUUID(),
      projectId,
      name: String(input.name || '综述矩阵').normalize('NFC').slice(0, 256),
      columns,
      rows: unique.map(id => this._newRow(aggregate, id, columns, timestamp)),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    aggregate.reviewMatrices.push(matrix);
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-create');
    return { success: true, durable: saved.durable === true, revision: saved.revision, matrix: clone(matrix) };
  }

  async list(projectId) {
    const aggregate = await this.repository.loadProject(uuid(projectId, 'projectId'));
    return {
      projectId: aggregate.manifest.projectId,
      revision: aggregate.manifest.revision,
      matrices: clone(aggregate.reviewMatrices),
      citationItems: clone(aggregate.citationItems),
      projectPaperStates: clone(aggregate.projectPaperStates)
    };
  }

  async addColumn(input = {}) {
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    const label = String(input.label || '').normalize('NFC').trim();
    if (!label || Array.from(label).length > 256) fail('MATRIX_COLUMN_INVALID', '列名必须为 1-256 个字符');
    const key = `user-${this.randomUUID()}`;
    const column = { id: this.randomUUID(), key, label, order: matrix.columns.length, userDefined: true };
    matrix.columns.push(column);
    matrix.updatedAt = nowIso(this.now);
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-column-add');
    return { success: true, revision: saved.revision, column: clone(column) };
  }

  async deleteColumn(input = {}) {
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    if (matrix.columns.length === 1) fail('MATRIX_LAST_COLUMN', '矩阵至少保留一列');
    const columnId = uuid(input.columnId, 'columnId');
    const index = matrix.columns.findIndex(column => column.id === columnId);
    if (index < 0) fail('MATRIX_COLUMN_NOT_FOUND', '矩阵列不存在');
    matrix.columns.splice(index, 1);
    matrix.columns.forEach((column, order) => { column.order = order; });
    matrix.rows.forEach(row => { delete row.cells[columnId]; });
    matrix.updatedAt = nowIso(this.now);
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-column-delete');
    return { success: true, revision: saved.revision };
  }

  async reorderColumns(input = {}) {
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    const ids = Array.isArray(input.columnIds) ? input.columnIds.map(id => uuid(id, 'columnId')) : [];
    if (ids.length !== matrix.columns.length || new Set(ids).size !== ids.length || matrix.columns.some(column => !ids.includes(column.id))) {
      fail('MATRIX_COLUMN_ORDER_INVALID', '列顺序必须完整且无重复');
    }
    const byId = new Map(matrix.columns.map(column => [column.id, column]));
    matrix.columns = ids.map((id, order) => ({ ...byId.get(id), order }));
    matrix.updatedAt = nowIso(this.now);
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-column-reorder');
    return { success: true, revision: saved.revision, columns: clone(matrix.columns) };
  }

  async setRows(input = {}) {
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    const ids = [...new Set((input.citationItemIds || []).map(id => uuid(id, 'citationItemId')))];
    const existing = new Map(matrix.rows.map(row => [row.citationItemId, row]));
    const timestamp = nowIso(this.now);
    matrix.rows = ids.map(id => {
      const citation = aggregate.citationItems.find(item => citationId(item) === id);
      if (!citation) fail('MATRIX_CITATION_ITEM_MISSING', '矩阵候选文献不存在', { citationItemId: id });
      const state = aggregate.projectPaperStates.find(item => item.citationItemId === id);
      if (!state || state.screeningStatus !== 'included') fail('MATRIX_PAPER_NOT_INCLUDED', '只有纳入的文献可以加入综述矩阵', { citationItemId: id });
      return existing.get(id) || this._newRow(aggregate, id, matrix.columns, timestamp);
    });
    matrix.updatedAt = timestamp;
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-rows-set');
    return { success: true, revision: saved.revision, rows: clone(matrix.rows) };
  }

  async updateCell(input = {}) {
    if (input.origin !== undefined || input.reviewStatus !== undefined || input.auditResultEventId !== undefined) {
      fail('MATRIX_AUTHORITY_INVALID', '手工编辑接口不接受 AI 来源或审阅身份字段');
    }
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    const row = matrix.rows.find(item => item.id === uuid(input.rowId, 'rowId'));
    const column = matrix.columns.find(item => item.id === uuid(input.columnId, 'columnId'));
    if (!row || !column) fail('MATRIX_CELL_NOT_FOUND', '矩阵行或列不存在');
    const timestamp = nowIso(this.now);
    const existing = row.cells[column.id];
    row.cells[column.id] = {
      schemaVersion: SCHEMA_VERSION,
      id: existing?.id || this.randomUUID(),
      columnId: column.id,
      citationItemId: row.citationItemId,
      value: String(input.value ?? '').normalize('NFC').slice(0, 100000),
      origin: 'user', reviewStatus: 'confirmed', userEdited: true, basis: 'manual', sourceRefs: [],
      createdAt: existing?.createdAt || timestamp, updatedAt: timestamp,
      reviewedBy: 'user', reviewedAt: timestamp
    };
    row.updatedAt = timestamp;
    matrix.updatedAt = timestamp;
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-cell-edit');
    return { success: true, revision: saved.revision, cell: clone(row.cells[column.id]) };
  }

  async reviewCell(input = {}) {
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    const row = matrix.rows.find(item => item.id === uuid(input.rowId, 'rowId'));
    const cell = row?.cells[uuid(input.columnId, 'columnId')];
    if (!cell || cell.origin !== 'ai') fail('MATRIX_AI_CELL_NOT_FOUND', 'AI 矩阵单元格不存在');
    if (!['confirmed', 'draft'].includes(input.decision)) fail('MATRIX_REVIEW_INVALID', '单元格审阅决定无效');
    if (cell.basis === 'abstract-only' && input.decision === 'confirmed') {
      fail('MATRIX_ABSTRACT_CONFIRM_FORBIDDEN', '仅基于摘要的单元格只能保持草稿；请先绑定全文证据或手工改写');
    }
    const timestamp = nowIso(this.now);
    cell.reviewStatus = input.decision;
    cell.reviewedBy = 'user';
    cell.reviewedAt = timestamp;
    cell.updatedAt = timestamp;
    row.updatedAt = timestamp;
    matrix.updatedAt = timestamp;
    const saved = await this._save(aggregate, input.baseRevision, 'matrix-cell-review');
    return { success: true, revision: saved.revision, cell: clone(cell) };
  }

  _messages(citation, source, columns) {
    const targets = columns.filter(column => !['author', 'year'].includes(column.key)).map(column => ({ key: column.key, label: column.label }));
    const material = source.type === 'abstract'
      ? `摘要：\n${source.abstract}`
      : source.pages.map(page => `[[PAGE ${page.pageLabel}]]\n${page.text}`).join('\n\n');
    return [{
      role: 'system',
      content: '你是综述矩阵抽取器。只输出 JSON {"cells":[{"columnKey":"...","value":"...","pageLabel":"...","quote":"..."}]}。仅使用给定材料；找不到的字段不要输出。PDF 模式的 quote 必须逐字来自对应页。不得输出 reviewStatus、actor 或 confirmed。'
    }, {
      role: 'user',
      content: `文献：${citation.title || '未命名'}\n目标列：${JSON.stringify(targets)}\n来源类型：${source.type}\n${material}`
    }];
  }

  async previewPrefillBatch(input = {}) {
    const projectId = uuid(input.projectId, 'projectId');
    const aggregate = await this.repository.loadProject(projectId);
    revision(aggregate, input.baseRevision);
    const matrix = this._matrix(aggregate, input.matrixId);
    const rowIds = [...new Set((input.rowIds || matrix.rows.map(row => row.id)).map(id => uuid(id, 'rowId')))];
    if (!rowIds.length || rowIds.length > MAX_BATCH) fail('MATRIX_BATCH_SIZE_INVALID', `批量预填必须包含 1-${MAX_BATCH} 篇文献`);
    const sourceMap = input.sourcesByCitationId || {};
    const tasks = rowIds.map(rowId => {
      const row = matrix.rows.find(item => item.id === rowId);
      if (!row) fail('MATRIX_ROW_NOT_FOUND', '矩阵行不存在', { rowId });
      const citation = aggregate.citationItems.find(item => citationId(item) === row.citationItemId);
      const source = normalizeSource(sourceMap[row.citationItemId], row.citationItemId);
      const messages = source.type === 'corrupt' ? [] : this._messages(citation, source, matrix.columns);
      return {
        rowId, citationItemId: row.citationItemId, title: citation.title || '未命名文献', source, messages,
        pageCount: source.type === 'pdf' ? source.pages.length : 0,
        outboundCodePointCount: messages.reduce((sum, message) => sum + Array.from(message.content).length, 0),
        requestId: this.randomUUID()
      };
    });
    const firstSendable = tasks.find(task => task.source.type !== 'corrupt');
    let gatewayPreview = null;
    if (firstSendable) {
      gatewayPreview = await this.trustedAi.previewRequest({
        projectId, baseRevision: aggregate.manifest.revision, operation: 'matrix-extraction',
        messages: firstSendable.messages,
        contextManifest: [{ kind: 'literature', id: firstSendable.citationItemId, label: firstSendable.title, unicodeCodePointCount: firstSendable.outboundCodePointCount }],
        promptTemplateVersion: 'essayflow-m5-matrix-v1'
      });
    }
    const previewId = this.randomUUID();
    this.batchPreviews.set(previewId, {
      previewId, projectId, matrixId: matrix.id, baseRevision: aggregate.manifest.revision,
      tasks, firstGatewayPreviewId: gatewayPreview?.previewId || null, expiresAt: Date.now() + 10 * 60 * 1000,
      overwriteColumnIds: [...new Set((input.overwriteColumnIds || []).map(id => uuid(id, 'columnId')))],
      overwriteCellIds: [...new Set((input.overwriteCellIds || []).map(id => uuid(id, 'cellId')))]
    });
    return {
      previewId, projectId, matrixId: matrix.id, privacyMode: aggregate.manifest.privacyMode,
      blocked: gatewayPreview?.blocked === true,
      confirmationRequired: gatewayPreview?.confirmationRequired === true,
      provider: gatewayPreview?.provider || null,
      pageCount: tasks.reduce((sum, task) => sum + task.pageCount, 0),
      totalOutboundCodePointCount: tasks.reduce((sum, task) => sum + task.outboundCodePointCount, 0),
      papers: tasks.map(task => ({
        rowId: task.rowId, citationItemId: task.citationItemId, title: task.title,
        sourceType: task.source.type, pageCount: task.pageCount, outboundCodePointCount: task.outboundCodePointCount
      }))
    };
  }

  cancelBatch(input = {}) {
    const batchId = uuid(input.batchId, 'batchId');
    const batch = this.activeBatches.get(batchId);
    if (!batch) return { cancelled: false };
    batch.cancelled = true;
    if (batch.activeRequestId) this.trustedAi.cancelRequest({ requestId: batch.activeRequestId });
    return { cancelled: true };
  }

  async _markTask(projectId, matrixId, rowId, status, reason) {
    const aggregate = await this.repository.loadProject(projectId);
    const matrix = this._matrix(aggregate, matrixId);
    const row = matrix.rows.find(item => item.id === rowId);
    if (!row) return null;
    const timestamp = nowIso(this.now);
    row.taskStatus = status;
    row.updatedAt = timestamp;
    if (status === 'running') row.attempt += 1;
    if (reason) row.failureReason = String(reason).slice(0, 2000);
    else delete row.failureReason;
    matrix.updatedAt = timestamp;
    return this._save(aggregate, aggregate.manifest.revision, `matrix-task-${status}`);
  }

  _createEvidence(aggregate, row, citation, source, page, claim, auditResultEventId, timestamp) {
    const descriptor = this.assetStore.getDescriptor(source.assetId);
    if (descriptor.sha256 !== source.fileSha256) fail('MATRIX_SOURCE_MISMATCH', 'PDF 来源已变化');
    const quote = String(claim.quote || '').normalize('NFC');
    const occurrenceIndex = page.text.indexOf(quote);
    if (!quote || occurrenceIndex < 0 || Array.from(quote).length > 2000) return null;
    const evidenceId = this.randomUUID();
    const revisionId = this.randomUUID();
    const display = normalizeQuote(quote, 'whitespace-collapse');
    const evidenceRevision = {
      schemaVersion: SCHEMA_VERSION, id: revisionId, evidenceId, revisionNumber: 1,
      citationItemId: row.citationItemId,
      ...(citation.libraryItemId ? { libraryItemId: citation.libraryItemId } : {}),
      sourceSnapshot: {
        assetId: source.assetId, fileSha256: source.fileSha256, title: citation.title || '未命名文献',
        ...(citation.DOI ? { doi: citation.DOI } : {}), metadataSource: 'manual'
      },
      locator: {
        pageIndex: page.pageIndex, pageLabel: page.pageLabel, quoteRaw: quote, quoteDisplay: display,
        rawQuoteSha256: hashText(quote), displayQuoteSha256: hashText(display), pageTextSha256: page.pageTextSha256,
        prefix: page.text.slice(Math.max(0, occurrenceIndex - 128), occurrenceIndex),
        suffix: page.text.slice(occurrenceIndex + quote.length, occurrenceIndex + quote.length + 128),
        occurrenceIndex: page.text.slice(0, occurrenceIndex).split(quote).length - 1,
        rects: clone(page.rects), pageRotation: page.pageRotation, cropBox: clone(page.cropBox),
        extractorName: 'pdfjs', extractorVersion: '3.11.174', transformVersion: '1',
        normalization: 'whitespace-collapse', extraction: 'pdf-text'
      },
      createdBy: 'ai', createdAt: timestamp
    };
    aggregate.evidenceCards.push({
      schemaVersion: SCHEMA_VERSION, id: evidenceId, projectId: aggregate.manifest.projectId,
      currentRevisionId: revisionId, note: `矩阵字段：${String(claim.columnKey || '')}`, tags: ['综述矩阵'],
      color: '#d5a623', researchQuestionIds: [], status: 'active', createdAt: timestamp, updatedAt: timestamp
    });
    aggregate.evidenceRevisions.push(evidenceRevision);
    aggregate.evidenceReviewEvents.push({
      schemaVersion: SCHEMA_VERSION, id: this.randomUUID(), projectId: aggregate.manifest.projectId,
      evidenceId, evidenceRevisionId: revisionId, sequence: 1, previousReviewEventId: null,
      status: 'proposed', actor: 'ai', sourceAuditResultEventId: auditResultEventId, createdAt: timestamp
    });
    if (!aggregate.assetRefs.some(ref => ref.assetId === source.assetId)) {
      aggregate.assetRefs.push({ id: source.assetId, assetId: source.assetId, projectId: aggregate.manifest.projectId, sha256: source.fileSha256, kind: 'pdf' });
    }
    return {
      evidenceId, evidenceRevisionId: revisionId, citationItemId: row.citationItemId,
      pageLabel: page.pageLabel, quote: display, rawQuoteSha256: hashText(quote),
      basis: 'pdf-evidence', reviewStatus: 'proposed'
    };
  }

  async _commitResult(task, batch, result) {
    const aggregate = await this.repository.loadProject(batch.projectId);
    const matrix = this._matrix(aggregate, batch.matrixId);
    const row = matrix.rows.find(item => item.id === task.rowId);
    const citation = aggregate.citationItems.find(item => citationId(item) === row.citationItemId);
    const claims = parseModelContent(result.content);
    const byKey = new Map();
    for (const claim of claims) if (claim && typeof claim === 'object' && typeof claim.columnKey === 'string') byKey.set(claim.columnKey, claim);
    const timestamp = nowIso(this.now);
    for (const column of matrix.columns.filter(item => !['author', 'year'].includes(item.key))) {
      const existing = row.cells[column.id];
      if (existing?.userEdited && !batch.overwriteColumnIds.includes(column.id) && !batch.overwriteCellIds.includes(existing.id)) continue;
      const claim = byKey.get(column.key);
      let basis = 'not-found';
      let reviewStatus = 'not-found';
      let value = '';
      let sourceRefs = [];
      let abstractSnapshotSha256;
      let abstractSnapshotText;
      if (claim && typeof claim.value === 'string' && claim.value.trim()) {
        value = claim.value.normalize('NFC').slice(0, 100000);
        if (task.source.type === 'abstract') {
          basis = 'abstract-only'; reviewStatus = 'draft'; abstractSnapshotSha256 = task.source.sha256; abstractSnapshotText = task.source.abstract;
        } else {
          const page = task.source.pages.find(item => item.pageLabel === String(claim.pageLabel || ''));
          const sourceRef = page && this._createEvidence(aggregate, row, citation, task.source, page, claim, result.resultEventId, timestamp);
          if (sourceRef) { basis = 'pdf-evidence'; reviewStatus = 'draft'; sourceRefs = [sourceRef]; }
          else value = '';
        }
      }
      row.cells[column.id] = {
        schemaVersion: SCHEMA_VERSION, id: existing?.id || this.randomUUID(), columnId: column.id, citationItemId: row.citationItemId,
        value, origin: 'ai', reviewStatus, userEdited: false, basis, sourceRefs,
        auditResultEventId: result.resultEventId,
        ...(abstractSnapshotSha256 ? { abstractSnapshotSha256 } : {}),
        ...(abstractSnapshotText ? { abstractSnapshotText } : {}),
        createdAt: existing?.createdAt || timestamp, updatedAt: timestamp
      };
    }
    row.taskStatus = 'completed';
    delete row.failureReason;
    row.updatedAt = timestamp;
    matrix.updatedAt = timestamp;
    const saved = await this._save(aggregate, aggregate.manifest.revision, 'matrix-prefill-row');
    return saved.revision;
  }

  async executePrefillBatch(input = {}) {
    const previewId = uuid(input.previewId, 'previewId');
    const preview = this.batchPreviews.get(previewId);
    if (!preview || preview.expiresAt <= Date.now()) fail('MATRIX_PREVIEW_EXPIRED', '矩阵批量预览已过期');
    this.batchPreviews.delete(previewId);
    const batchId = previewId;
    const batch = { ...preview, batchId, cancelled: false, activeRequestId: null };
    this.activeBatches.set(batchId, batch);
    const outcomes = [];
    try {
      for (let index = 0; index < batch.tasks.length; index += 1) {
        const task = batch.tasks[index];
        if (batch.cancelled) {
          const aggregate = await this.repository.loadProject(batch.projectId);
          const matrix = this._matrix(aggregate, batch.matrixId);
          const timestamp = nowIso(this.now);
          for (const pending of batch.tasks.slice(index)) {
            const pendingRow = matrix.rows.find(item => item.id === pending.rowId);
            if (!pendingRow) continue;
            pendingRow.taskStatus = 'canceled';
            pendingRow.failureReason = '用户取消批量预填';
            pendingRow.updatedAt = timestamp;
            outcomes.push({ rowId: pending.rowId, status: 'canceled' });
          }
          matrix.updatedAt = timestamp;
          await this._save(aggregate, aggregate.manifest.revision, 'matrix-batch-canceled');
          break;
        }
        if (task.source.type === 'corrupt') {
          await this._markTask(batch.projectId, batch.matrixId, task.rowId, 'failed', task.source.reason);
          outcomes.push({ rowId: task.rowId, status: 'failed', reason: task.source.reason });
          continue;
        }
        await this._markTask(batch.projectId, batch.matrixId, task.rowId, 'running');
        if (batch.cancelled) {
          await this._markTask(batch.projectId, batch.matrixId, task.rowId, 'canceled', '用户取消批量预填');
          outcomes.push({ rowId: task.rowId, status: 'canceled' });
          continue;
        }
        try {
          batch.activeRequestId = task.requestId;
          const aggregate = await this.repository.loadProject(batch.projectId);
          const result = await this.trustedAi.request({
            projectId: batch.projectId, baseRevision: aggregate.manifest.revision, operation: 'matrix-extraction',
            messages: task.messages,
            contextManifest: [{ kind: 'literature', id: task.citationItemId, label: task.title, unicodeCodePointCount: task.outboundCodePointCount }],
            promptTemplateVersion: 'essayflow-m5-matrix-v1', confirmed: input.confirmed === true, requestId: task.requestId
          });
          if (result.blocked) {
            await this._markTask(batch.projectId, batch.matrixId, task.rowId, 'failed', result.reason);
            outcomes.push({ rowId: task.rowId, status: 'failed', reason: result.reason });
          } else {
            const savedRevision = await this._commitResult(task, batch, result);
            outcomes.push({ rowId: task.rowId, status: 'completed', revision: savedRevision });
          }
        } catch (error) {
          const status = error?.code === 'AI_ABORTED' || batch.cancelled ? 'canceled' : 'failed';
          await this._markTask(batch.projectId, batch.matrixId, task.rowId, status, error?.message || '预填失败');
          outcomes.push({ rowId: task.rowId, status, reason: error?.message || '预填失败' });
        } finally {
          batch.activeRequestId = null;
        }
      }
      const aggregate = await this.repository.loadProject(batch.projectId);
      return { success: true, batchId, revision: aggregate.manifest.revision, outcomes };
    } finally {
      this.activeBatches.delete(batchId);
    }
  }

  async export(input = {}) {
    const aggregate = await this.repository.loadProject(uuid(input.projectId, 'projectId'));
    const matrix = this._matrix(aggregate, input.matrixId);
    const format = String(input.format || '').toLowerCase();
    if (!['xlsx', 'csv'].includes(format)) fail('MATRIX_EXPORT_FORMAT_INVALID', '矩阵只支持 XLSX 或 CSV ZIP 导出');
    const buffer = format === 'xlsx'
      ? await exportXlsx(matrix, aggregate.citationItems)
      : await exportCsvZip(matrix, aggregate.citationItems);
    return {
      format,
      extension: format === 'xlsx' ? 'xlsx' : 'zip',
      mimeType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip',
      buffer,
      byteCount: buffer.length
    };
  }
}

module.exports = { DEFAULT_COLUMNS, MatrixService, MatrixServiceError, MAX_BATCH, normalizeSource, parseModelContent };
