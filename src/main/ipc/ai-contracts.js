'use strict';

const { OPERATIONS, REVIEW_MODES } = require('../ai/model');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class AiContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new AiContractError(code, message, details);
}

function object(value, field = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('AI_IPC_OBJECT_REQUIRED', `${field} 必须是普通对象`, { field });
  }
}

function exact(value, allowed, field = 'payload') {
  object(value, field);
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) fail('AI_IPC_UNKNOWN_FIELD', `${field}.${key} 不允许`, { field: `${field}.${key}` });
  }
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('AI_IPC_UUID_INVALID', `${field} 必须是 UUID`, { field });
}

function revision(value, field = 'baseRevision') {
  if (!Number.isSafeInteger(value) || value < 0) fail('AI_IPC_REVISION_INVALID', `${field} 必须是非负整数`, { field });
}

function string(value, field, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || Array.from(value).length > maximum) {
    fail('AI_IPC_STRING_INVALID', `${field} 格式错误`, { field });
  }
}

function preview(payload) {
  exact(payload, ['projectId', 'baseRevision', 'operation', 'messages', 'contextManifest', 'promptTemplateVersion', 'contentRetention']);
  uuid(payload.projectId, 'projectId');
  if (payload.baseRevision !== undefined) revision(payload.baseRevision);
  string(payload.operation, 'operation', 64);
  if (!OPERATIONS.has(payload.operation)) fail('AI_IPC_OPERATION_INVALID', 'operation 不受支持');
  if (!Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 100) fail('AI_IPC_MESSAGES_INVALID', 'messages 数量无效');
  payload.messages.forEach((message, index) => {
    exact(message, ['role', 'content'], `messages[${index}]`);
    string(message.role, `messages[${index}].role`, 16);
    if (!['system', 'user', 'assistant'].includes(message.role)) fail('AI_IPC_MESSAGES_INVALID', `messages[${index}].role 无效`);
    string(message.content, `messages[${index}].content`, 200_000, true);
  });
  if (!Array.isArray(payload.contextManifest) || payload.contextManifest.length > 100) fail('AI_IPC_CONTEXT_INVALID', 'contextManifest 无效');
  payload.contextManifest.forEach((entry, index) => {
    const field = `contextManifest[${index}]`;
    exact(entry, ['kind', 'id', 'label', 'unicodeCodePointCount', 'evidenceRevisionId', 'rawQuoteSha256', 'pageLabel', 'included'], field);
    string(entry.kind, `${field}.kind`, 32);
    if (!['selection', 'paragraph', 'evidence', 'literature', 'attachment', 'question'].includes(entry.kind)) fail('AI_IPC_CONTEXT_INVALID', `${field}.kind 无效`);
    string(entry.id, `${field}.id`, 256);
    string(entry.label, `${field}.label`, 1000);
    if (!Number.isSafeInteger(entry.unicodeCodePointCount) || entry.unicodeCodePointCount < 0) fail('AI_IPC_CONTEXT_INVALID', `${field}.unicodeCodePointCount 无效`);
    if (entry.evidenceRevisionId !== undefined) uuid(entry.evidenceRevisionId, `${field}.evidenceRevisionId`);
    if (entry.rawQuoteSha256 !== undefined && !SHA256_PATTERN.test(entry.rawQuoteSha256)) fail('AI_IPC_CONTEXT_INVALID', `${field}.rawQuoteSha256 无效`);
    if (entry.pageLabel !== undefined) string(entry.pageLabel, `${field}.pageLabel`, 256);
    if (entry.included !== undefined && typeof entry.included !== 'boolean') fail('AI_IPC_CONTEXT_INVALID', `${field}.included 无效`);
  });
  if (payload.promptTemplateVersion !== undefined) string(payload.promptTemplateVersion, 'promptTemplateVersion', 128);
  if (payload.contentRetention !== undefined && !['full', 'metadata-only'].includes(payload.contentRetention)) fail('AI_IPC_RETENTION_INVALID', 'contentRetention 无效');
}

function execute(payload) {
  exact(payload, ['previewId', 'confirmed', 'requestId']);
  uuid(payload.previewId, 'previewId');
  if (payload.requestId !== undefined) uuid(payload.requestId, 'requestId');
  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'confirmed 必须是布尔值');
}

function cancel(payload) {
  exact(payload, ['requestId']);
  uuid(payload.requestId, 'requestId');
}

function grounded(payload) {
  exact(payload, ['projectId', 'baseRevision', 'question', 'evidenceRevisionIds', 'threadId', 'contentRetention', 'confirmed', 'retryOnInvalid', 'requestId']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
  string(payload.question, 'question', 24_000);
  if (!Array.isArray(payload.evidenceRevisionIds) || payload.evidenceRevisionIds.length < 1 || payload.evidenceRevisionIds.length > 20) {
    fail('AI_IPC_EVIDENCE_LIMIT', 'evidenceRevisionIds 必须为 1-20 项');
  }
  payload.evidenceRevisionIds.forEach((id, index) => uuid(id, `evidenceRevisionIds[${index}]`));
  if (new Set(payload.evidenceRevisionIds.map(id => id.toLowerCase())).size !== payload.evidenceRevisionIds.length) fail('AI_IPC_EVIDENCE_LIMIT', 'evidenceRevisionIds 不得重复');
  if (payload.threadId !== undefined) uuid(payload.threadId, 'threadId');
  if (payload.requestId !== undefined) uuid(payload.requestId, 'requestId');
  if (payload.contentRetention !== undefined && !['full', 'metadata-only'].includes(payload.contentRetention)) fail('AI_IPC_RETENTION_INVALID', 'contentRetention 无效');
  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'confirmed 必须是布尔值');
  if (payload.retryOnInvalid !== undefined && typeof payload.retryOnInvalid !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'retryOnInvalid 必须是布尔值');
}

function projectId(value) {
  uuid(value, 'projectId');
}

function clearChat(payload) {
  exact(payload, ['projectId', 'baseRevision']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
}

function redact(payload) {
  exact(payload, ['projectId', 'baseRevision', 'blobIds', 'scope', 'reason', 'managedBackupIds']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
  if (!Array.isArray(payload.blobIds) || payload.blobIds.length < 1 || payload.blobIds.length > 1000) fail('AI_IPC_REDACTION_INVALID', 'blobIds 数量无效');
  payload.blobIds.forEach((id, index) => uuid(id, `blobIds[${index}]`));
  if (payload.scope !== undefined) string(payload.scope, 'scope', 32);
  if (payload.reason !== undefined) string(payload.reason, 'reason', 32);
  if (payload.managedBackupIds !== undefined) fail('AI_IPC_BACKUP_REDACTION_NOT_IMPLEMENTED', '受管备份脱敏必须由专用备份事务处理');
}

function exportAudit(payload) {
  exact(payload, ['projectId', 'includeContent']);
  uuid(payload.projectId, 'projectId');
  if (payload.includeContent !== undefined && typeof payload.includeContent !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'includeContent 必须是布尔值');
}

function scholarly(payload) {
  exact(payload, ['projectId', 'url', 'method', 'headers', 'body', 'requestId', 'confirmed', 'sourceId', 'operation']);
  uuid(payload.projectId, 'projectId');
  uuid(payload.requestId, 'requestId');
  string(payload.url, 'url', 2048);
  if (payload.method !== undefined) {
    string(payload.method, 'method', 16);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(payload.method.toUpperCase())) fail('AI_IPC_METHOD_INVALID', 'method 无效');
  }
  if (payload.headers !== undefined) {
    object(payload.headers, 'headers');
    if (Object.keys(payload.headers).length > 100) fail('AI_IPC_HEADERS_INVALID', 'headers 过多');
    for (const [name, value] of Object.entries(payload.headers)) {
      string(name, `headers.${name}`, 128);
      string(value, `headers.${name}`, 8192, true);
    }
  }
  if (payload.body !== undefined && payload.body !== null) string(payload.body, 'body', 10_000_000, true);
  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'confirmed 必须是布尔值');
  if (payload.sourceId !== undefined) string(payload.sourceId, 'sourceId', 128);
  if (payload.operation !== undefined && !new Set(['literature-metadata', 'citation-verify']).has(payload.operation)) fail('AI_IPC_OPERATION_INVALID', '学术 operation 无效');
}

function chat(payload) {
  exact(payload, ['projectId', 'baseRevision', 'messages', 'contextManifest', 'threadId', 'attachments', 'promptTemplateVersion', 'contentRetention', 'confirmed', 'requestId']);
  preview({
    projectId: payload.projectId,
    baseRevision: payload.baseRevision,
    operation: 'chat',
    messages: payload.messages,
    contextManifest: payload.contextManifest || [],
    ...(payload.promptTemplateVersion ? { promptTemplateVersion: payload.promptTemplateVersion } : {}),
    ...(payload.contentRetention ? { contentRetention: payload.contentRetention } : {})
  });
  if (payload.threadId !== undefined) uuid(payload.threadId, 'threadId');
  if (payload.requestId !== undefined) uuid(payload.requestId, 'requestId');
  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'confirmed 必须是布尔值');
  if (payload.attachments !== undefined) {
    if (!Array.isArray(payload.attachments) || payload.attachments.length > 20) fail('AI_IPC_ATTACHMENTS_INVALID', 'attachments 数量无效');
    payload.attachments.forEach((attachment, index) => {
      exact(attachment, ['id', 'schemaVersion', 'projectId', 'assetId', 'extractedSnapshotHash', 'retentionMode', 'confirmedAt'], `attachments[${index}]`);
      uuid(attachment.id, `attachments[${index}].id`);
      uuid(attachment.projectId, `attachments[${index}].projectId`);
      uuid(attachment.assetId, `attachments[${index}].assetId`);
      string(attachment.extractedSnapshotHash, `attachments[${index}].extractedSnapshotHash`, 64);
      if (attachment.schemaVersion !== 1 || attachment.projectId.toLowerCase() !== payload.projectId.toLowerCase() ||
          !SHA256_PATTERN.test(attachment.extractedSnapshotHash)) fail('AI_IPC_ATTACHMENTS_INVALID', `attachments[${index}] 归属或 hash 无效`);
      string(attachment.retentionMode, `attachments[${index}].retentionMode`, 64);
      if (!['reference-only', 'retain-excerpt', 'retain-full-managed-asset'].includes(attachment.retentionMode)) fail('AI_IPC_ATTACHMENTS_INVALID', `attachments[${index}].retentionMode 无效`);
      string(attachment.confirmedAt, `attachments[${index}].confirmedAt`, 64);
      if (Number.isNaN(Date.parse(attachment.confirmedAt)) || new Date(attachment.confirmedAt).toISOString() !== attachment.confirmedAt) fail('AI_IPC_ATTACHMENTS_INVALID', `attachments[${index}].confirmedAt 无效`);
    });
  }
}

function reviewRequest(payload) {
  exact(payload, ['projectId', 'baseRevision', 'documentRevision', 'operationMode', 'documentAnchorId', 'selectedText', 'contentRetention', 'confirmed', 'requestId', 'regeneratedFromResultEventId', 'paraphrase', 'evidenceRevisionId', 'instruction']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
  revision(payload.documentRevision, 'documentRevision');
  string(payload.operationMode, 'operationMode', 32);
  if (!REVIEW_MODES.has(payload.operationMode)) fail('AI_IPC_REVIEW_MODE_INVALID', 'operationMode 无效');
  string(payload.documentAnchorId, 'documentAnchorId', 256);
  string(payload.selectedText, 'selectedText', 100_000);
  if (payload.requestId !== undefined) uuid(payload.requestId, 'requestId');
  if (payload.regeneratedFromResultEventId !== undefined) uuid(payload.regeneratedFromResultEventId, 'regeneratedFromResultEventId');
  if (payload.paraphrase !== undefined && typeof payload.paraphrase !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'paraphrase 必须是布尔值');
  if (payload.evidenceRevisionId !== undefined) uuid(payload.evidenceRevisionId, 'evidenceRevisionId');
  if ((payload.paraphrase === true) !== Boolean(payload.evidenceRevisionId)) fail('AI_IPC_PARAPHRASE_SOURCE_REQUIRED', 'AI 转述必须且只能指定一条 EvidenceRevision');
  if (payload.instruction !== undefined) string(payload.instruction, 'instruction', 10_000);
  if (payload.contentRetention !== undefined && !['full', 'metadata-only'].includes(payload.contentRetention)) fail('AI_IPC_RETENTION_INVALID', 'contentRetention 无效');
  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') fail('AI_IPC_BOOLEAN_INVALID', 'confirmed 必须是布尔值');
}

function commitChat(payload) {
  exact(payload, ['projectId', 'baseRevision', 'threadId', 'requestEventId', 'resultEventId', 'userContent', 'assistantContent', 'attachments']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
  if (payload.threadId !== undefined && payload.threadId !== null) uuid(payload.threadId, 'threadId');
  uuid(payload.requestEventId, 'requestEventId');
  uuid(payload.resultEventId, 'resultEventId');
  string(payload.userContent, 'userContent', 200_000, true);
  string(payload.assistantContent, 'assistantContent', 200_000, true);
  if (payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length > 20)) fail('AI_IPC_ATTACHMENTS_INVALID', 'attachments 数量无效');
}

function reviewDecision(payload) {
  exact(payload, ['projectId', 'baseRevision', 'issueId', 'decision', 'reason', 'documentRevision', 'documentAnchorId', 'beforeHash', 'afterHash', 'newDocumentHtml', 'diff', 'contentRetention']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
  uuid(payload.issueId, 'issueId');
  string(payload.decision, 'decision', 16);
  if (!['accepted', 'rejected'].includes(payload.decision)) fail('AI_IPC_REVIEW_DECISION_INVALID', 'decision 无效');
  if (payload.reason !== undefined) string(payload.reason, 'reason', 2000);
  if (payload.decision === 'accepted') {
    revision(payload.documentRevision, 'documentRevision');
    string(payload.documentAnchorId, 'documentAnchorId', 256);
    string(payload.beforeHash, 'beforeHash', 64);
    string(payload.afterHash, 'afterHash', 64);
    if (!SHA256_PATTERN.test(payload.beforeHash) || !SHA256_PATTERN.test(payload.afterHash)) fail('AI_IPC_REVIEW_HASH_INVALID', 'Diff hash 无效');
    string(payload.newDocumentHtml, 'newDocumentHtml', 5_000_000, true);
    string(payload.diff, 'diff', 200_000, true);
  }
}

function reviewBatchDecision(payload) {
  exact(payload, ['projectId', 'baseRevision', 'issueIds', 'decision', 'reason', 'documentRevision', 'documentAnchorId', 'newDocumentHtml', 'diffs', 'contentRetention']);
  uuid(payload.projectId, 'projectId');
  revision(payload.baseRevision);
  if (!Array.isArray(payload.issueIds) || payload.issueIds.length < 1 || payload.issueIds.length > 100) {
    fail('AI_IPC_REVIEW_BATCH_INVALID', 'issueIds 必须为 1-100 项');
  }
  payload.issueIds.forEach((id, index) => uuid(id, `issueIds[${index}]`));
  if (new Set(payload.issueIds.map(id => id.toLowerCase())).size !== payload.issueIds.length) {
    fail('AI_IPC_REVIEW_BATCH_INVALID', 'issueIds 不得重复');
  }
  string(payload.decision, 'decision', 16);
  if (!['accepted', 'rejected'].includes(payload.decision)) fail('AI_IPC_REVIEW_DECISION_INVALID', 'decision 无效');
  if (payload.reason !== undefined) string(payload.reason, 'reason', 2000);
  if (payload.contentRetention !== undefined && !['full', 'metadata-only'].includes(payload.contentRetention)) fail('AI_IPC_RETENTION_INVALID', 'contentRetention 无效');
  if (payload.decision === 'accepted') {
    revision(payload.documentRevision, 'documentRevision');
    string(payload.documentAnchorId, 'documentAnchorId', 256);
    string(payload.newDocumentHtml, 'newDocumentHtml', 5_000_000, true);
    if (!Array.isArray(payload.diffs) || payload.diffs.length !== payload.issueIds.length) {
      fail('AI_IPC_REVIEW_BATCH_INVALID', 'diffs 必须与 issueIds 一一对应');
    }
    payload.diffs.forEach((item, index) => {
      exact(item, ['issueId', 'beforeHash', 'afterHash', 'diff'], `diffs[${index}]`);
      uuid(item.issueId, `diffs[${index}].issueId`);
      if (!SHA256_PATTERN.test(item.beforeHash) || !SHA256_PATTERN.test(item.afterHash)) fail('AI_IPC_REVIEW_HASH_INVALID', `diffs[${index}] hash 无效`);
      string(item.diff, `diffs[${index}].diff`, 200_000, true);
    });
  }
}

module.exports = { AiContractError, cancel, chat, clearChat, commitChat, execute, exportAudit, grounded, preview, projectId, redact, reviewBatchDecision, reviewDecision, reviewRequest, revision, scholarly, uuid };
