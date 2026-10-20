'use strict';

const { UUID_PATTERN } = require('./citation-contracts');

const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

function fail(message) { throw new TypeError(message); }
function object(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式错误`);
  return value;
}
function exact(value, fields, label = '参数') {
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${label}包含未知字段: ${key}`);
}
function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(`${label}必须是 UUID`);
  return value.toLowerCase();
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fail('baseRevision 格式错误'); }
function text(value, label, maximum = 100000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || Array.from(value).length > maximum || value.includes('\0')) fail(`${label}格式错误`);
}
function size(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('参数无法序列化'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) fail('参数超过 20 MB 限制');
}
function base(value, additional = [], requireMatrix = true) {
  object(value); exact(value, ['projectId', 'baseRevision', 'matrixId', ...additional]);
  uuid(value.projectId, '项目 ID'); revision(value.baseRevision);
  if (requireMatrix && value.matrixId === undefined) fail('矩阵 ID 缺失');
  if (value.matrixId !== undefined) uuid(value.matrixId, '矩阵 ID');
  size(value); return value;
}
function projectId(value) { return uuid(value, '项目 ID'); }
function create(value) {
  base(value, ['name', 'citationItemIds'], false);
  if (value.name !== undefined) text(value.name, '矩阵名称', 256);
  ids(value.citationItemIds || [], '文献 ID', 10000, true);
  return value;
}
function ids(value, label, maximum, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > maximum) fail(`${label}列表格式错误`);
  value.forEach((id, index) => uuid(id, `${label}[${index}]`));
  if (new Set(value).size !== value.length) fail(`${label}不能重复`);
}
function addColumn(value) { base(value, ['label']); text(value.label, '列名', 256); return value; }
function deleteColumn(value) { base(value, ['columnId']); uuid(value.columnId, '列 ID'); return value; }
function reorder(value) { base(value, ['columnIds']); ids(value.columnIds, '列 ID', 100); return value; }
function setRows(value) { base(value, ['citationItemIds']); ids(value.citationItemIds, '文献 ID', 10000, true); return value; }
function updateCell(value) {
  base(value, ['rowId', 'columnId', 'value']); uuid(value.rowId, '行 ID'); uuid(value.columnId, '列 ID');
  text(value.value, '单元格', 100000, true); return value;
}
function reviewCell(value) {
  base(value, ['rowId', 'columnId', 'decision']); uuid(value.rowId, '行 ID'); uuid(value.columnId, '列 ID');
  if (!['confirmed', 'draft'].includes(value.decision)) fail('审阅决定格式错误'); return value;
}
function prefillPreview(value) {
  base(value, ['rowIds', 'sourcesByCitationId', 'overwriteColumnIds', 'overwriteCellIds']);
  ids(value.rowIds, '行 ID', 50);
  object(value.sourcesByCitationId, '来源映射');
  for (const [citationItemId, source] of Object.entries(value.sourcesByCitationId)) {
    uuid(citationItemId, '来源文献 ID'); object(source, '来源');
    exact(source, ['type', 'abstract', 'reason', 'assetId', 'fileSha256', 'pages'], '来源');
    if (!['abstract', 'pdf', 'corrupt'].includes(source.type)) fail('来源类型错误');
    if (source.type === 'abstract') text(source.abstract, '摘要', 500000);
    if (source.type === 'corrupt' && source.reason !== undefined) text(source.reason, '损坏原因', 2000);
    if (source.type === 'pdf') {
      uuid(source.assetId, '资产 ID');
      if (!/^[0-9a-f]{64}$/.test(source.fileSha256 || '')) fail('PDF hash 格式错误');
      if (!Array.isArray(source.pages) || !source.pages.length || source.pages.length > 1000) fail('PDF 页文本格式错误');
      source.pages.forEach((page, index) => {
        object(page, `PDF 页[${index}]`);
        exact(page, ['pageIndex', 'pageLabel', 'text', 'rects', 'pageRotation', 'cropBox'], `PDF 页[${index}]`);
        if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0) fail('PDF 页码格式错误');
        text(page.pageLabel, 'PDF 页标签', 256); text(page.text, 'PDF 页文本', 500000);
        if (page.pageRotation !== undefined && ![0, 90, 180, 270].includes(page.pageRotation)) fail('PDF 页面旋转格式错误');
        if (page.rects !== undefined) {
          if (!Array.isArray(page.rects) || !page.rects.length || page.rects.length > 500) fail('PDF 页面矩形格式错误');
          page.rects.forEach(rect => validateRect(rect, true));
        }
        if (page.cropBox !== undefined) validateRect(page.cropBox, false);
      });
    }
  }
  ids(value.overwriteColumnIds || [], '覆盖列 ID', 100, true);
  ids(value.overwriteCellIds || [], '覆盖单元格 ID', 5000, true);
  size(value); return value;
}
function validateRect(value, normalized) {
  object(value, '矩形'); exact(value, ['x', 'y', 'width', 'height'], '矩形');
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || (normalized && value[key] > 1)) fail('矩形格式错误');
  }
  if (value.width <= 0 || value.height <= 0 || (normalized && (value.x + value.width > 1.000001 || value.y + value.height > 1.000001))) fail('矩形越界');
}
function prefillExecute(value) {
  object(value); exact(value, ['previewId', 'confirmed']); uuid(value.previewId, '预览 ID');
  if (value.confirmed !== undefined && typeof value.confirmed !== 'boolean') fail('确认状态格式错误'); return value;
}
function cancel(value) { object(value); exact(value, ['batchId']); uuid(value.batchId, '批次 ID'); return value; }
function exportMatrix(value) {
  object(value); exact(value, ['projectId', 'matrixId', 'format']); uuid(value.projectId, '项目 ID'); uuid(value.matrixId, '矩阵 ID');
  if (!['csv', 'xlsx'].includes(value.format)) fail('导出格式错误'); return value;
}

module.exports = {
  MAX_PAYLOAD_BYTES, addColumn, cancel, create, deleteColumn, exportMatrix, prefillExecute,
  prefillPreview, projectId, reorder, reviewCell, setRows, updateCell
};
