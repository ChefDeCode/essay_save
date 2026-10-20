'use strict';

const { UUID_PATTERN } = require('./citation-contracts');

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(message) { throw new TypeError(message); }
function object(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式错误`);
  return value;
}
function exact(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}包含未知字段: ${key}`);
}
function string(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || Array.from(value).length > maximum || value.includes('\0')) fail(`${label}格式错误`);
  return value;
}
function uuid(value, label) {
  string(value, label, 128);
  if (!UUID_PATTERN.test(value)) fail(`${label}必须是 UUID`);
  return value.toLowerCase();
}
function revision(value, label = 'baseRevision') {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label}格式错误`);
}
function jsonSize(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('参数无法序列化'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) fail('参数超过 10 MB 限制');
}
function finite(value, label, minimum = 0, maximum = Number.MAX_VALUE) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(`${label}格式错误`);
}
function rect(value, label, normalized) {
  object(value, label);
  exact(value, ['x', 'y', 'width', 'height'], label);
  for (const key of ['x', 'y', 'width', 'height']) finite(value[key], `${label}.${key}`, 0, normalized ? 1 : Number.MAX_VALUE);
  if (value.width <= 0 || value.height <= 0 || (normalized && (value.x + value.width > 1.000001 || value.y + value.height > 1.000001))) fail(`${label}越界`);
}
function selection(value, options = {}) {
  object(value, '证据选文参数');
  const fields = [
    'projectId', 'baseRevision', 'citationItemId', 'libraryItemId', 'evidenceId', 'assetId', 'fileSha256',
    'title', 'doi', 'metadataSource', 'pageIndex', 'pageLabel', 'quoteRaw', 'pageTextSha256', 'prefix', 'suffix',
    'occurrenceIndex', 'rects', 'pageRotation', 'cropBox', 'extractorName', 'extractorVersion',
    'transformVersion', 'normalization', 'note', 'tags', 'color', 'researchQuestionIds'
  ];
  if (options.ai) fields.push('sourceAuditResultEventId');
  exact(value, fields, '证据选文参数');
  uuid(value.projectId, '项目 ID');
  revision(value.baseRevision);
  if (!value.citationItemId && !value.libraryItemId) fail('必须提供 CitationItem ID 或 LibraryItem ID');
  for (const key of ['citationItemId', 'libraryItemId', 'evidenceId', 'assetId']) if (value[key] !== undefined) uuid(value[key], key);
  if (!SHA256_PATTERN.test(value.fileSha256)) fail('PDF SHA-256 格式错误');
  if (!SHA256_PATTERN.test(value.pageTextSha256)) fail('页面文本 SHA-256 格式错误');
  string(value.title, '文献标题', 2048);
  if (value.doi !== undefined) string(value.doi, 'DOI', 1024);
  if (!['api', 'imported', 'manual'].includes(value.metadataSource)) fail('元数据来源格式错误');
  if (!Number.isSafeInteger(value.pageIndex) || value.pageIndex < 0) fail('页码格式错误');
  string(value.pageLabel, '页面标签', 256);
  const quoteLength = Array.from(string(value.quoteRaw, '选文', 2000)).length;
  if (quoteLength < 1) fail('选文不能为空');
  string(value.prefix, '前文', 256, true);
  string(value.suffix, '后文', 256, true);
  if (!Number.isSafeInteger(value.occurrenceIndex) || value.occurrenceIndex < 0) fail('出现序号格式错误');
  if (!Array.isArray(value.rects) || !value.rects.length || value.rects.length > 500) fail('选文矩形格式错误');
  value.rects.forEach((item, index) => rect(item, `选文矩形[${index}]`, true));
  if (![0, 90, 180, 270].includes(value.pageRotation)) fail('页面旋转格式错误');
  rect(value.cropBox, '裁剪框', false);
  for (const key of ['extractorName', 'extractorVersion', 'transformVersion']) string(value[key], key, 128);
  if (!['whitespace-collapse', 'linebreak-join', 'hyphen-join'].includes(value.normalization)) fail('规范化方式错误');
  if (value.note !== undefined) string(value.note, '笔记', 100000, true);
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 100) fail('标签格式错误');
    value.tags.forEach((tag, index) => string(tag, `标签[${index}]`, 256));
  }
  if (value.color !== undefined && !/^#[0-9a-f]{6}$/i.test(value.color)) fail('颜色格式错误');
  if (value.researchQuestionIds !== undefined) {
    if (!Array.isArray(value.researchQuestionIds) || value.researchQuestionIds.length > 100) fail('研究问题格式错误');
    value.researchQuestionIds.forEach((id, index) => uuid(id, `研究问题[${index}]`));
  }
  if (options.ai) uuid(value.sourceAuditResultEventId, 'AI 审计结果 ID');
  jsonSize(value);
  return value;
}

function userSelection(value) { return selection(value); }
function aiSelection(value) { return selection(value, { ai: true }); }
function list(value) { return uuid(value, '项目 ID'); }
function review(value) {
  object(value); exact(value, ['projectId', 'baseRevision', 'evidenceRevisionId', 'decision', 'expectedSequence', 'reason'], '证据审阅参数');
  uuid(value.projectId, '项目 ID'); revision(value.baseRevision); uuid(value.evidenceRevisionId, '证据版本 ID');
  if (!['confirmed', 'rejected'].includes(value.decision)) fail('审阅结论格式错误');
  if (value.expectedSequence !== 1) fail('审阅序列格式错误');
  if (value.reason !== undefined) string(value.reason, '审阅原因', 10000);
  return value;
}
function update(value) {
  object(value); exact(value, ['projectId', 'baseRevision', 'evidenceId', 'note', 'tags', 'color', 'researchQuestionIds'], '证据编辑参数');
  uuid(value.projectId, '项目 ID'); revision(value.baseRevision); uuid(value.evidenceId, '证据 ID');
  if (!['note', 'tags', 'color', 'researchQuestionIds'].some(key => value[key] !== undefined)) fail('没有可编辑字段');
  if (value.note !== undefined) string(value.note, '笔记', 100000, true);
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 100) fail('标签格式错误');
    value.tags.forEach((tag, index) => string(tag, `标签[${index}]`, 256));
  }
  if (value.color !== undefined && !/^#[0-9a-f]{6}$/i.test(value.color)) fail('颜色格式错误');
  if (value.researchQuestionIds !== undefined) {
    if (!Array.isArray(value.researchQuestionIds) || value.researchQuestionIds.length > 100) fail('研究问题格式错误');
    value.researchQuestionIds.forEach((id, index) => uuid(id, `研究问题[${index}]`));
  }
  jsonSize(value); return value;
}
function archive(value) {
  object(value); exact(value, ['projectId', 'baseRevision', 'evidenceId', 'confirmed'], '证据归档参数');
  uuid(value.projectId, '项目 ID'); revision(value.baseRevision); uuid(value.evidenceId, '证据 ID');
  if (value.confirmed !== undefined && typeof value.confirmed !== 'boolean') fail('确认状态格式错误');
  return value;
}
function prepareCitation(value) {
  object(value); exact(value, ['projectId', 'baseRevision', 'insertionMode', 'evidenceRevisionIds'], '证据插入参数');
  uuid(value.projectId, '项目 ID'); revision(value.baseRevision);
  if (!['quote', 'paraphrase', 'citation-only'].includes(value.insertionMode)) fail('插入方式错误');
  if (!Array.isArray(value.evidenceRevisionIds) || !value.evidenceRevisionIds.length || value.evidenceRevisionIds.length > 100) fail('证据版本列表错误');
  value.evidenceRevisionIds.forEach((id, index) => uuid(id, `证据版本[${index}]`));
  if (new Set(value.evidenceRevisionIds).size !== value.evidenceRevisionIds.length) fail('证据版本不能重复');
  return value;
}
function commitCitation(value) {
  object(value); exact(value, ['projectId', 'sessionId', 'documentHtml'], '证据提交参数');
  uuid(value.projectId, '项目 ID'); uuid(value.sessionId, '会话 ID'); string(value.documentHtml, '正文', MAX_PAYLOAD_BYTES, true);
  jsonSize(value); return value;
}
function managedPdfLocator(value) { return string(value, '受管 PDF 定位符', 4096); }

module.exports = {
  MAX_PAYLOAD_BYTES,
  aiSelection,
  archive,
  commitCitation,
  list,
  managedPdfLocator,
  prepareCitation,
  review,
  update,
  userSelection
};
