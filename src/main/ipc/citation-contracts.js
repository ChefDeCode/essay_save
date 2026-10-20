'use strict';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 10_000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const FORMATS = new Set(['bibtex', 'bib', 'ris', 'csl-json', 'csljson', 'json']);
const SCREENING = new Set(['pending', 'included', 'excluded']);
const READING = new Set(['unread', 'to-read', 'reading', 'read']);

function fail(message) {
  throw new TypeError(message);
}

function plainObject(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式错误`);
  return value;
}

function exactFields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}包含未知字段: ${key}`);
}

function boundedString(value, label, maximum, options = {}) {
  if (typeof value !== 'string' || (!options.allowEmpty && !value.length) || value.length > maximum || value.includes('\0')) {
    fail(`${label}格式错误`);
  }
  return value;
}

function uuid(value, label) {
  boundedString(value, label, 128);
  if (!UUID_PATTERN.test(value)) fail(`${label}必须是 UUID`);
  return value.toLowerCase();
}

function revision(value, label = 'baseRevision') {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}格式错误`);
  return value;
}

function jsonSize(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('参数无法序列化'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) fail('参数超过 10 MB 限制');
}

function uuidArray(value, label, options = {}) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || (!options.allowEmpty && value.length === 0)) fail(`${label}格式错误`);
  const result = value.map((entry, index) => uuid(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label}不能包含重复 ID`);
  return result;
}

function optionalEnum(value, allowed, label) {
  if (value !== undefined && !allowed.has(value)) fail(`${label}格式错误`);
}

function citationRender(value) {
  plainObject(value);
  exactFields(value, ['projectId', 'styleId', 'locale', 'format'], '引用渲染参数');
  uuid(value.projectId, '项目 ID');
  if (value.styleId !== undefined) boundedString(value.styleId, '引用样式 ID', 128);
  if (value.locale !== undefined) boundedString(value.locale, 'locale', 32);
  optionalEnum(value.format, new Set(['html', 'text']), '渲染格式');
  return value;
}

function citationExportAudit(value) {
  plainObject(value);
  exactFields(value, ['projectId', 'baseRevision', 'format', 'forced'], '引用审计参数');
  uuid(value.projectId, '项目 ID');
  revision(value.baseRevision);
  boundedString(value.format, '导出格式', 32);
  if (value.forced !== undefined && typeof value.forced !== 'boolean') fail('forced 格式错误');
  return value;
}

function citationImportCommit(value) {
  plainObject(value);
  exactFields(value, ['sessionId', 'baseRevision', 'decisions'], '引用导入参数');
  uuid(value.sessionId, '导入会话 ID');
  revision(value.baseRevision);
  if (value.decisions !== undefined) plainObject(value.decisions, '导入决策');
  jsonSize(value);
  return value;
}

function citationLibraryExport(value) {
  plainObject(value);
  exactFields(value, ['format', 'itemIds'], '文库导出参数');
  if (!FORMATS.has(value.format)) fail('导出格式不受支持');
  if (value.itemIds !== undefined) uuidArray(value.itemIds, '文献 ID', { allowEmpty: true });
  return value;
}

function citationLibraryQuery(value = {}) {
  plainObject(value);
  exactFields(value, [
    'search', 'year', 'source', 'type', 'hasPdf', 'starred', 'tags', 'collectionId',
    'projectId', 'screeningStatus', 'readingStatus', 'sortBy', 'direction', 'offset', 'limit'
  ], '文库查询参数');
  for (const field of ['search', 'year', 'source', 'type']) {
    if (value[field] !== undefined) boundedString(String(value[field]), field, field === 'search' ? 10_000 : 1_000, { allowEmpty: true });
  }
  for (const field of ['hasPdf', 'starred']) if (value[field] !== undefined && typeof value[field] !== 'boolean') fail(`${field} 格式错误`);
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 100) fail('tags 格式错误');
    value.tags.forEach((tag, index) => boundedString(tag, `tags[${index}]`, 256));
  }
  if (value.collectionId !== undefined) uuid(value.collectionId, '集合 ID');
  if (value.projectId !== undefined) uuid(value.projectId, '项目 ID');
  optionalEnum(value.screeningStatus, SCREENING, 'screeningStatus');
  optionalEnum(value.readingStatus, READING, 'readingStatus');
  optionalEnum(value.sortBy, new Set(['title', 'year', 'source', 'type', 'updatedAt']), 'sortBy');
  optionalEnum(value.direction, new Set(['asc', 'desc']), 'direction');
  if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0)) fail('offset 格式错误');
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 200)) fail('limit 格式错误');
  return value;
}

function citationLibraryBatch(value) {
  plainObject(value);
  exactFields(value, ['baseRevision', 'itemIds', 'operation'], '文库批量参数');
  revision(value.baseRevision);
  uuidArray(value.itemIds, '文献 ID');
  const operation = plainObject(value.operation, '批量操作');
  const type = boundedString(operation.type, '批量操作类型', 64);
  if (['tags-add', 'tags-remove'].includes(type)) {
    exactFields(operation, ['type', 'tags'], '标签操作');
    if (!Array.isArray(operation.tags) || !operation.tags.length || operation.tags.length > 100) fail('标签列表格式错误');
    operation.tags.forEach((tag, index) => boundedString(tag, `标签[${index}]`, 256));
  } else if (type === 'set-starred') {
    exactFields(operation, ['type', 'value'], '星标操作');
    if (typeof operation.value !== 'boolean') fail('星标值格式错误');
  } else if (['collection-add', 'collection-remove'].includes(type)) {
    exactFields(operation, ['type', 'collectionId'], '集合操作');
    uuid(operation.collectionId, '集合 ID');
  } else if (type === 'delete') {
    exactFields(operation, ['type', 'retainManagedAssets'], '删除操作');
    if (operation.retainManagedAssets !== true) fail('M2 删除必须保留受管资产');
  } else if (type === 'set-project-state') {
    exactFields(operation, ['type', 'projectId', 'screeningStatus', 'readingStatus', 'exclusionReason', 'projectNotes'], '项目状态操作');
    uuid(operation.projectId, '项目 ID');
    optionalEnum(operation.screeningStatus, SCREENING, 'screeningStatus');
    optionalEnum(operation.readingStatus, READING, 'readingStatus');
    if (operation.screeningStatus === 'excluded') boundedString(operation.exclusionReason, '排除原因', 10_000);
    else if (operation.exclusionReason) fail('非排除状态不能填写排除原因');
    if (operation.projectNotes !== undefined) boundedString(operation.projectNotes, '项目笔记', 500_000, { allowEmpty: true });
  } else {
    fail(`未知批量操作: ${type}`);
  }
  jsonSize(value);
  return value;
}

function citationLibraryCollection(value) {
  plainObject(value);
  exactFields(value, ['baseRevision', 'collectionId', 'name'], '集合参数');
  revision(value.baseRevision);
  if (value.collectionId !== undefined) uuid(value.collectionId, '集合 ID');
  boundedString(value.name, '集合名称', 512);
  return value;
}

function citationUndo(value) {
  plainObject(value);
  exactFields(value, ['undoToken', 'baseRevision'], '撤销参数');
  uuid(value.undoToken, '撤销令牌');
  revision(value.baseRevision);
  return value;
}

function citationProjectPaperState(value) {
  plainObject(value);
  exactFields(value, [
    'projectId', 'baseRevision', 'citationItemId', 'libraryItemId', 'screeningStatus',
    'readingStatus', 'exclusionReason', 'projectNotes'
  ], '项目文献状态参数');
  uuid(value.projectId, '项目 ID');
  revision(value.baseRevision);
  if (value.citationItemId !== undefined) uuid(value.citationItemId, 'CitationItem ID');
  if (value.libraryItemId !== undefined) uuid(value.libraryItemId, 'LibraryItem ID');
  if (!value.citationItemId && !value.libraryItemId) fail('必须提供 CitationItem ID 或 LibraryItem ID');
  optionalEnum(value.screeningStatus, SCREENING, 'screeningStatus');
  optionalEnum(value.readingStatus, READING, 'readingStatus');
  if (value.screeningStatus === 'excluded') boundedString(value.exclusionReason, '排除原因', 10_000);
  if (value.projectNotes !== undefined) boundedString(value.projectNotes, '项目笔记', 500_000, { allowEmpty: true });
  return value;
}

module.exports = {
  MAX_ITEMS,
  MAX_PAYLOAD_BYTES,
  UUID_PATTERN,
  citationExportAudit,
  citationImportCommit,
  citationLibraryBatch,
  citationLibraryCollection,
  citationLibraryExport,
  citationLibraryQuery,
  citationProjectPaperState,
  citationRender,
  citationUndo,
  uuid,
  uuidArray
};
