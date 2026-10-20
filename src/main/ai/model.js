'use strict';

const crypto = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPERATIONS = new Set([
  'grounded-qa', 'rewrite', 'summarize', 'search-keywords',
  'literature-metadata', 'citation-verify', 'pdf-download', 'chat', 'matrix-extraction'
]);
const PRIVACY_MODES = new Set(['normal', 'sensitive', 'local-only']);
const NETWORK_DECISIONS = new Set(['sent', 'blocked', 'local']);
const CONTENT_RETENTIONS = new Set(['full', 'metadata-only']);
const BLOB_KINDS = new Set(['prompt', 'output', 'diff', 'document-context']);
const REVIEW_MODES = new Set(['language', 'structure', 'logic', 'terminology', 'citation-gap']);
const LOCAL_EVENT_TYPES = new Set(['ai-accepted', 'ai-rejected', 'ai-regenerated', 'restore', 'audit-redacted']);
const SECRET_KEY_PATTERN = /authorization|api[-_]?key|access[-_]?token|password|cookie/i;

class AiModelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AiModelError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new AiModelError(code, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, required, optional, path) {
  if (!isObject(value)) fail('SCHEMA_EXPECTED_OBJECT', `${path} 必须是对象`, { path });
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail('SCHEMA_REQUIRED_FIELD_MISSING', `${path}.${key} 必填`, { path: `${path}.${key}` });
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('SCHEMA_UNKNOWN_FIELD', `${path}.${key} 不属于数据契约`, { path: `${path}.${key}` });
  }
}

function uuid(value, path) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('SCHEMA_INVALID_UUID', `${path} 必须是 UUID`, { path, value });
  }
}

function sha(value, path) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('SCHEMA_INVALID_SHA256', `${path} 必须是小写 SHA-256`, { path, value });
  }
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('SCHEMA_INVALID_UTC_TIMESTAMP', `${path} 必须是 UTC ISO-8601 时间`, { path, value });
  }
}

function string(value, path, maximum = 1_000_000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Array.from(value).length > maximum) {
    fail('SCHEMA_INVALID_STRING', `${path} 字符串无效`, { path });
  }
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('SCHEMA_INVALID_INTEGER', `${path} 必须是不小于 ${minimum} 的安全整数`, { path, value });
  }
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value)) fail('SCHEMA_INVALID_ENUM', `${path} 值无效`, { path, value });
}

function assertProject(value, projectId, path) {
  uuid(value, path);
  if (value.toLowerCase() !== projectId.toLowerCase()) {
    fail('SCHEMA_CROSS_PROJECT_REFERENCE', `${path} 指向其他项目`, { path, value, projectId });
  }
}

function rejectSecrets(value, path = '$', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('SCHEMA_CYCLIC_VALUE', `${path} 包含循环引用`, { path });
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) fail('SCHEMA_SECRET_FIELD', `${path}.${key} 禁止保存凭据`, { path: `${path}.${key}` });
    rejectSecrets(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function validateNetworkContext(value, path, expectedDecision) {
  exact(value, ['operation', 'provider', 'privacyMode', 'networkDecision'], [], path);
  enumValue(value.operation, OPERATIONS, `${path}.operation`);
  enumValue(value.privacyMode, PRIVACY_MODES, `${path}.privacyMode`);
  enumValue(value.networkDecision, NETWORK_DECISIONS, `${path}.networkDecision`);
  if (expectedDecision && !expectedDecision.has(value.networkDecision)) {
    fail('SCHEMA_INVALID_NETWORK_DECISION', `${path}.networkDecision 与事件类型不符`, { path });
  }
  exact(value.provider, ['origin', 'providerKind'], ['model'], `${path}.provider`);
  let parsed;
  try { parsed = new URL(value.provider.origin); } catch (_) {
    fail('SCHEMA_INVALID_PROVIDER_ORIGIN', `${path}.provider.origin 无效`, { path });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value.provider.origin) {
    fail('SCHEMA_INVALID_PROVIDER_ORIGIN', `${path}.provider.origin 必须是规范 origin`, { path });
  }
  enumValue(value.provider.providerKind, new Set(['remote-ai', 'local-ai', 'scholarly-api']), `${path}.provider.providerKind`);
  if (value.provider.model !== undefined) string(value.provider.model, `${path}.provider.model`, 256);
}

function validateContextManifest(value, path) {
  if (!Array.isArray(value) || value.length > 100) fail('SCHEMA_INVALID_CONTEXT_MANIFEST', `${path} 必须是有限数组`, { path });
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    exact(entry, ['kind', 'id', 'label', 'unicodeCodePointCount'], ['evidenceRevisionId', 'rawQuoteSha256', 'pageLabel', 'included'], itemPath);
    enumValue(entry.kind, new Set(['selection', 'paragraph', 'evidence', 'literature', 'attachment', 'question']), `${itemPath}.kind`);
    string(entry.id, `${itemPath}.id`, 256);
    string(entry.label, `${itemPath}.label`, 1000);
    integer(entry.unicodeCodePointCount, `${itemPath}.unicodeCodePointCount`);
    if (entry.evidenceRevisionId !== undefined) uuid(entry.evidenceRevisionId, `${itemPath}.evidenceRevisionId`);
    if (entry.rawQuoteSha256 !== undefined) sha(entry.rawQuoteSha256, `${itemPath}.rawQuoteSha256`);
    if (entry.pageLabel !== undefined) string(entry.pageLabel, `${itemPath}.pageLabel`, 256);
    if (entry.included !== undefined && typeof entry.included !== 'boolean') fail('SCHEMA_INVALID_BOOLEAN', `${itemPath}.included 必须是布尔值`, { path: `${itemPath}.included` });
  });
}

function validateBlob(blob, projectId, path) {
  exact(blob, ['blobId', 'schemaVersion', 'projectId', 'ownerEventId', 'kind', 'sha256', 'byteCount', 'utf8Content', 'createdAt'], [], path);
  uuid(blob.blobId, `${path}.blobId`);
  if (blob.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED_VERSION', `${path}.schemaVersion 不受支持`, { path });
  assertProject(blob.projectId, projectId, `${path}.projectId`);
  uuid(blob.ownerEventId, `${path}.ownerEventId`);
  enumValue(blob.kind, BLOB_KINDS, `${path}.kind`);
  sha(blob.sha256, `${path}.sha256`);
  integer(blob.byteCount, `${path}.byteCount`);
  string(blob.utf8Content, `${path}.utf8Content`, 2_000_000, true);
  timestamp(blob.createdAt, `${path}.createdAt`);
  const bytes = Buffer.from(blob.utf8Content, 'utf8');
  if (bytes.length !== blob.byteCount || crypto.createHash('sha256').update(bytes).digest('hex') !== blob.sha256) {
    fail('SCHEMA_AUDIT_BLOB_HASH_MISMATCH', `${path} 正文 hash 或长度不匹配`, { path, blobId: blob.blobId });
  }
}

function validateAuditEvent(event, projectId, path) {
  const envelope = ['schemaVersion', 'eventId', 'projectId', 'sessionId', 'sequence', 'eventType', 'occurredAt'];
  const branches = {
    'ai-request': ['networkContext', 'contentRetention', 'promptTemplateVersion', 'userPromptSha256', 'userPromptByteCount', 'contextManifest', 'outbound'],
    'ai-result': ['requestEventId', 'contentRetention', 'outputSha256', 'byteCount', 'partial', 'responseStatus'],
    'ai-accepted': ['resultEventId', 'contentRetention', 'diffSha256', 'baseDocumentRevision', 'beforeHash', 'afterHash'],
    'ai-rejected': ['resultEventId', 'reason'],
    'ai-regenerated': ['resultEventId', 'replacementRequestEventId', 'reason'],
    'ai-aborted': ['requestEventId', 'reason'],
    'ai-error': ['requestEventId', 'reason'],
    'ai-blocked': ['networkContext', 'contentRetention', 'userPromptSha256', 'userPromptByteCount', 'reason', 'outbound'],
    restore: ['restoredSnapshotId', 'resultingRevision'],
    'audit-redacted': ['targetEventIds', 'scope', 'redactedBlobs', 'reason']
  };
  const optional = {
    'ai-request': ['promptContentBlobId'],
    'ai-blocked': ['promptContentBlobId'],
    'ai-result': ['outputContentBlobId'],
    'ai-accepted': ['diffContentBlobId']
  };
  if (!isObject(event) || !branches[event.eventType]) fail('SCHEMA_INVALID_AUDIT_EVENT_TYPE', `${path}.eventType 无效`, { path });
  exact(event, [...envelope, ...branches[event.eventType]], optional[event.eventType] || [], path);
  if (event.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED_VERSION', `${path}.schemaVersion 不受支持`, { path });
  uuid(event.eventId, `${path}.eventId`);
  assertProject(event.projectId, projectId, `${path}.projectId`);
  uuid(event.sessionId, `${path}.sessionId`);
  integer(event.sequence, `${path}.sequence`, 1);
  timestamp(event.occurredAt, `${path}.occurredAt`);

  if (event.eventType === 'ai-request' || event.eventType === 'ai-blocked') {
    validateNetworkContext(event.networkContext, `${path}.networkContext`, event.eventType === 'ai-blocked' ? new Set(['blocked']) : new Set(['sent', 'local']));
    enumValue(event.contentRetention, CONTENT_RETENTIONS, `${path}.contentRetention`);
    sha(event.userPromptSha256, `${path}.userPromptSha256`);
    integer(event.userPromptByteCount, `${path}.userPromptByteCount`);
    if (event.promptContentBlobId !== undefined) uuid(event.promptContentBlobId, `${path}.promptContentBlobId`);
    if ((event.contentRetention === 'full') !== Boolean(event.promptContentBlobId)) {
      fail('SCHEMA_AUDIT_RETENTION_MISMATCH', `${path} prompt blob 与 retention 不匹配`, { path });
    }
    if (event.eventType === 'ai-request') {
      string(event.promptTemplateVersion, `${path}.promptTemplateVersion`, 128);
      validateContextManifest(event.contextManifest, `${path}.contextManifest`);
      exact(event.outbound, ['payloadSha256', 'byteCount', 'unicodeCodePointCount', 'sentAt'], [], `${path}.outbound`);
      sha(event.outbound.payloadSha256, `${path}.outbound.payloadSha256`);
      integer(event.outbound.byteCount, `${path}.outbound.byteCount`);
      integer(event.outbound.unicodeCodePointCount, `${path}.outbound.unicodeCodePointCount`);
      timestamp(event.outbound.sentAt, `${path}.outbound.sentAt`);
    } else {
      string(event.reason, `${path}.reason`, 2000);
      if (event.outbound !== null) fail('SCHEMA_BLOCKED_OUTBOUND_NOT_NULL', `${path}.outbound 必须为 null`, { path });
    }
  } else if (event.eventType === 'ai-result') {
    uuid(event.requestEventId, `${path}.requestEventId`);
    enumValue(event.contentRetention, CONTENT_RETENTIONS, `${path}.contentRetention`);
    sha(event.outputSha256, `${path}.outputSha256`);
    integer(event.byteCount, `${path}.byteCount`);
    if (typeof event.partial !== 'boolean') fail('SCHEMA_INVALID_BOOLEAN', `${path}.partial 必须是布尔值`, { path });
    integer(event.responseStatus, `${path}.responseStatus`, 100);
    if (event.outputContentBlobId !== undefined) uuid(event.outputContentBlobId, `${path}.outputContentBlobId`);
    if ((event.contentRetention === 'full') !== Boolean(event.outputContentBlobId)) fail('SCHEMA_AUDIT_RETENTION_MISMATCH', `${path} output blob 与 retention 不匹配`, { path });
  } else if (event.eventType === 'ai-accepted') {
    uuid(event.resultEventId, `${path}.resultEventId`);
    enumValue(event.contentRetention, CONTENT_RETENTIONS, `${path}.contentRetention`);
    sha(event.diffSha256, `${path}.diffSha256`);
    integer(event.baseDocumentRevision, `${path}.baseDocumentRevision`);
    sha(event.beforeHash, `${path}.beforeHash`);
    sha(event.afterHash, `${path}.afterHash`);
    if (event.diffContentBlobId !== undefined) uuid(event.diffContentBlobId, `${path}.diffContentBlobId`);
    if ((event.contentRetention === 'full') !== Boolean(event.diffContentBlobId)) fail('SCHEMA_AUDIT_RETENTION_MISMATCH', `${path} diff blob 与 retention 不匹配`, { path });
  } else if (['ai-rejected', 'ai-regenerated'].includes(event.eventType)) {
    uuid(event.resultEventId, `${path}.resultEventId`);
    string(event.reason, `${path}.reason`, 2000);
    if (event.replacementRequestEventId !== undefined) uuid(event.replacementRequestEventId, `${path}.replacementRequestEventId`);
  } else if (['ai-aborted', 'ai-error'].includes(event.eventType)) {
    uuid(event.requestEventId, `${path}.requestEventId`);
    string(event.reason, `${path}.reason`, 2000);
  } else if (event.eventType === 'restore') {
    uuid(event.restoredSnapshotId, `${path}.restoredSnapshotId`);
    integer(event.resultingRevision, `${path}.resultingRevision`, 1);
  } else if (event.eventType === 'audit-redacted') {
    if (!Array.isArray(event.targetEventIds) || !event.targetEventIds.length) fail('SCHEMA_REDACTION_TARGET_REQUIRED', `${path}.targetEventIds 不能为空`, { path });
    event.targetEventIds.forEach((id, index) => uuid(id, `${path}.targetEventIds[${index}]`));
    enumValue(event.scope, new Set([...BLOB_KINDS, 'all']), `${path}.scope`);
    if (!Array.isArray(event.redactedBlobs) || !event.redactedBlobs.length) fail('SCHEMA_REDACTION_BLOB_REQUIRED', `${path}.redactedBlobs 不能为空`, { path });
    event.redactedBlobs.forEach((blob, index) => {
      const blobPath = `${path}.redactedBlobs[${index}]`;
      exact(blob, ['blobId', 'kind', 'sha256', 'byteCount'], [], blobPath);
      uuid(blob.blobId, `${blobPath}.blobId`);
      enumValue(blob.kind, BLOB_KINDS, `${blobPath}.kind`);
      sha(blob.sha256, `${blobPath}.sha256`);
      integer(blob.byteCount, `${blobPath}.byteCount`);
    });
    enumValue(event.reason, new Set(['user-request', 'project-delete', 'retention-policy']), `${path}.reason`);
  }
  if (LOCAL_EVENT_TYPES.has(event.eventType) && event.networkContext !== undefined) {
    fail('SCHEMA_LOCAL_EVENT_NETWORK_CONTEXT', `${path} 本地事件不得伪造网络字段`, { path });
  }
  rejectSecrets(event, path);
}

function validateSourceSnapshot(value, path) {
  exact(value, ['citationItemId', 'title', 'assetId', 'fileSha256', 'pageIndex', 'pageLabel', 'rawQuoteSha256', 'quoteText', 'capturedAt'], ['doi'], path);
  uuid(value.citationItemId, `${path}.citationItemId`);
  string(value.title, `${path}.title`, 2000);
  uuid(value.assetId, `${path}.assetId`);
  sha(value.fileSha256, `${path}.fileSha256`);
  integer(value.pageIndex, `${path}.pageIndex`);
  string(value.pageLabel, `${path}.pageLabel`, 256);
  sha(value.rawQuoteSha256, `${path}.rawQuoteSha256`);
  string(value.quoteText, `${path}.quoteText`, 20_000);
  timestamp(value.capturedAt, `${path}.capturedAt`);
  if (value.doi !== undefined) string(value.doi, `${path}.doi`, 2048);
}

function validateGroundedAnswer(answer, aggregate, eventsById, path) {
  exact(answer, ['id', 'schemaVersion', 'threadId', 'projectId', 'auditRequestId', 'auditResultId', 'question', 'status', 'segments', 'inputEvidenceRefs', 'excludedEvidence', 'modelSnapshot', 'createdAt', 'updatedAt'], ['sanitizations'], path);
  uuid(answer.id, `${path}.id`);
  if (answer.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED_VERSION', `${path}.schemaVersion 不受支持`, { path });
  uuid(answer.threadId, `${path}.threadId`);
  assertProject(answer.projectId, aggregate.manifest.projectId, `${path}.projectId`);
  uuid(answer.auditRequestId, `${path}.auditRequestId`);
  uuid(answer.auditResultId, `${path}.auditResultId`);
  string(answer.question, `${path}.question`, 24_000);
  enumValue(answer.status, new Set(['complete', 'partial', 'invalid']), `${path}.status`);
  timestamp(answer.createdAt, `${path}.createdAt`);
  timestamp(answer.updatedAt, `${path}.updatedAt`);
  const request = eventsById.get(answer.auditRequestId.toLowerCase());
  const result = eventsById.get(answer.auditResultId.toLowerCase());
  if (!request || request.eventType !== 'ai-request' || request.networkContext.operation !== 'grounded-qa') {
    fail('SCHEMA_GROUNDED_REQUEST_INVALID', `${path}.auditRequestId 必须指向 grounded-qa request`, { path });
  }
  if (!result || result.eventType !== 'ai-result' || result.requestEventId !== request.eventId) {
    fail('SCHEMA_GROUNDED_RESULT_INVALID', `${path}.auditResultId 与 request 不配对`, { path });
  }
  exact(answer.modelSnapshot, ['providerOrigin', 'providerKind', 'model'], [], `${path}.modelSnapshot`);
  if (answer.modelSnapshot.providerOrigin !== request.networkContext.provider.origin ||
      answer.modelSnapshot.providerKind !== request.networkContext.provider.providerKind ||
      answer.modelSnapshot.model !== request.networkContext.provider.model) {
    fail('SCHEMA_GROUNDED_MODEL_MISMATCH', `${path}.modelSnapshot 与审计请求不一致`, { path });
  }
  if (!Array.isArray(answer.inputEvidenceRefs) || answer.inputEvidenceRefs.length > 20) fail('SCHEMA_GROUNDED_EVIDENCE_LIMIT', `${path}.inputEvidenceRefs 超限`, { path });
  const evidenceByRevision = new Map(aggregate.evidenceRevisions.map(item => [item.id.toLowerCase(), item]));
  const included = new Map();
  answer.inputEvidenceRefs.forEach((ref, index) => {
    const refPath = `${path}.inputEvidenceRefs[${index}]`;
    exact(ref, ['evidenceId', 'evidenceRevisionId', 'rawQuoteSha256', 'included'], [], refPath);
    uuid(ref.evidenceId, `${refPath}.evidenceId`);
    uuid(ref.evidenceRevisionId, `${refPath}.evidenceRevisionId`);
    sha(ref.rawQuoteSha256, `${refPath}.rawQuoteSha256`);
    if (typeof ref.included !== 'boolean') fail('SCHEMA_INVALID_BOOLEAN', `${refPath}.included 必须是布尔值`, { path: refPath });
    const revision = evidenceByRevision.get(ref.evidenceRevisionId.toLowerCase());
    if (!revision || revision.evidenceId !== ref.evidenceId || revision.locator.rawQuoteSha256 !== ref.rawQuoteSha256) {
      fail('SCHEMA_GROUNDED_EVIDENCE_MISMATCH', `${refPath} 与 EvidenceRevision 不匹配`, { path: refPath });
    }
    if (ref.included) included.set(ref.evidenceRevisionId.toLowerCase(), ref);
  });
  if (!Array.isArray(answer.excludedEvidence)) fail('SCHEMA_EXPECTED_ARRAY', `${path}.excludedEvidence 必须是数组`, { path });
  answer.excludedEvidence.forEach((ref, index) => {
    const refPath = `${path}.excludedEvidence[${index}]`;
    exact(ref, ['evidenceId', 'evidenceRevisionId', 'reason'], [], refPath);
    uuid(ref.evidenceId, `${refPath}.evidenceId`);
    uuid(ref.evidenceRevisionId, `${refPath}.evidenceRevisionId`);
    string(ref.reason, `${refPath}.reason`, 1000);
  });
  if (!Array.isArray(answer.segments) || !answer.segments.length) fail('SCHEMA_GROUNDED_SEGMENTS_REQUIRED', `${path}.segments 不能为空`, { path });
  answer.segments.forEach((segment, index) => {
    const segmentPath = `${path}.segments[${index}]`;
    exact(segment, ['id', 'text', 'kind', 'userReviewStatus', 'sourceRefs'], [], segmentPath);
    uuid(segment.id, `${segmentPath}.id`);
    string(segment.text, `${segmentPath}.text`, 50_000);
    enumValue(segment.kind, new Set(['sourced', 'inference', 'insufficient']), `${segmentPath}.kind`);
    enumValue(segment.userReviewStatus, new Set(['unreviewed', 'confirmed', 'rejected']), `${segmentPath}.userReviewStatus`);
    if (!Array.isArray(segment.sourceRefs)) fail('SCHEMA_EXPECTED_ARRAY', `${segmentPath}.sourceRefs 必须是数组`, { path: segmentPath });
    if (segment.kind === 'sourced' && !segment.sourceRefs.length) fail('SCHEMA_GROUNDED_SOURCE_REQUIRED', `${segmentPath} 缺少来源`, { path: segmentPath });
    if (segment.kind !== 'sourced' && segment.sourceRefs.length) fail('SCHEMA_GROUNDED_UNEXPECTED_SOURCE', `${segmentPath} 不应包含来源`, { path: segmentPath });
    segment.sourceRefs.forEach((ref, refIndex) => {
      const refPath = `${segmentPath}.sourceRefs[${refIndex}]`;
      exact(ref, ['evidenceId', 'evidenceRevisionId', 'rawQuoteSha256', 'sourceCitationSnapshot'], [], refPath);
      uuid(ref.evidenceId, `${refPath}.evidenceId`);
      uuid(ref.evidenceRevisionId, `${refPath}.evidenceRevisionId`);
      sha(ref.rawQuoteSha256, `${refPath}.rawQuoteSha256`);
      validateSourceSnapshot(ref.sourceCitationSnapshot, `${refPath}.sourceCitationSnapshot`);
      const inputRef = included.get(ref.evidenceRevisionId.toLowerCase());
      if (!inputRef || inputRef.evidenceId !== ref.evidenceId || inputRef.rawQuoteSha256 !== ref.rawQuoteSha256 ||
          ref.sourceCitationSnapshot.rawQuoteSha256 !== ref.rawQuoteSha256) {
        fail('SCHEMA_GROUNDED_SOURCE_NOT_INCLUDED', `${refPath} 未映射到本次 included 证据`, { path: refPath });
      }
    });
  });
  if (answer.sanitizations !== undefined) {
    if (!Array.isArray(answer.sanitizations) || answer.sanitizations.length > 100) {
      fail('SCHEMA_GROUNDED_SANITIZATION_INVALID', `${path}.sanitizations 必须是有界数组`, { path });
    }
    answer.sanitizations.forEach((entry, index) => {
      const entryPath = `${path}.sanitizations[${index}]`;
      exact(entry, ['code', 'path', 'reason'], [], entryPath);
      string(entry.code, `${entryPath}.code`, 128);
      string(entry.path, `${entryPath}.path`, 512);
      string(entry.reason, `${entryPath}.reason`, 1000);
    });
  }
}

function validateReviewIssue(issue, aggregate, eventsById, path) {
  exact(issue, ['id', 'schemaVersion', 'projectId', 'operationMode', 'documentAnchorId', 'baseDocumentRevision', 'beforeHash', 'category', 'originalText', 'suggestedText', 'reason', 'status', 'auditResultId'], [], path);
  uuid(issue.id, `${path}.id`);
  if (issue.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED_VERSION', `${path}.schemaVersion 不受支持`, { path });
  assertProject(issue.projectId, aggregate.manifest.projectId, `${path}.projectId`);
  enumValue(issue.operationMode, REVIEW_MODES, `${path}.operationMode`);
  string(issue.documentAnchorId, `${path}.documentAnchorId`, 256);
  integer(issue.baseDocumentRevision, `${path}.baseDocumentRevision`);
  sha(issue.beforeHash, `${path}.beforeHash`);
  string(issue.category, `${path}.category`, 256);
  string(issue.originalText, `${path}.originalText`, 100_000);
  string(issue.suggestedText, `${path}.suggestedText`, 100_000);
  string(issue.reason, `${path}.reason`, 10_000);
  enumValue(issue.status, new Set(['proposed', 'accepted', 'rejected', 'stale']), `${path}.status`);
  uuid(issue.auditResultId, `${path}.auditResultId`);
  const result = eventsById.get(issue.auditResultId.toLowerCase());
  const request = result && eventsById.get(String(result.requestEventId || '').toLowerCase());
  if (!result || result.eventType !== 'ai-result' || !request || request.eventType !== 'ai-request' || request.networkContext.operation !== 'rewrite') {
    fail('SCHEMA_REVIEW_ISSUE_AUDIT_INVALID', `${path}.auditResultId 必须关联 rewrite result`, { path });
  }
}

function validateAiThread(thread, aggregate, eventsById, path) {
  exact(thread, ['id', 'schemaVersion', 'projectId', 'createdAt', 'updatedAt', 'messages'], [], path);
  uuid(thread.id, `${path}.id`);
  if (thread.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED_VERSION', `${path}.schemaVersion 不受支持`, { path });
  assertProject(thread.projectId, aggregate.manifest.projectId, `${path}.projectId`);
  timestamp(thread.createdAt, `${path}.createdAt`);
  timestamp(thread.updatedAt, `${path}.updatedAt`);
  if (!Array.isArray(thread.messages) || thread.messages.length > 10_000) fail('SCHEMA_INVALID_CHAT_MESSAGES', `${path}.messages 无效`, { path });
  thread.messages.forEach((message, index) => {
    const messagePath = `${path}.messages[${index}]`;
    exact(message, ['id', 'role', 'content', 'createdAt', 'attachments'], ['auditEventId'], messagePath);
    uuid(message.id, `${messagePath}.id`);
    enumValue(message.role, new Set(['user', 'assistant']), `${messagePath}.role`);
    string(message.content, `${messagePath}.content`, 200_000, true);
    timestamp(message.createdAt, `${messagePath}.createdAt`);
    if (message.auditEventId !== undefined) {
      uuid(message.auditEventId, `${messagePath}.auditEventId`);
      if (!eventsById.has(message.auditEventId.toLowerCase())) fail('SCHEMA_CHAT_AUDIT_MISSING', `${messagePath}.auditEventId 不存在`, { path: messagePath });
    }
    if (!Array.isArray(message.attachments) || message.attachments.length > 20) fail('SCHEMA_INVALID_CHAT_ATTACHMENTS', `${messagePath}.attachments 无效`, { path: messagePath });
    message.attachments.forEach((attachment, attachmentIndex) => {
      const attachmentPath = `${messagePath}.attachments[${attachmentIndex}]`;
      exact(attachment, ['id', 'schemaVersion', 'projectId', 'assetId', 'extractedSnapshotHash', 'retentionMode', 'confirmedAt'], [], attachmentPath);
      uuid(attachment.id, `${attachmentPath}.id`);
      if (attachment.schemaVersion !== 1) fail('SCHEMA_UNSUPPORTED_VERSION', `${attachmentPath}.schemaVersion 不受支持`, { path: attachmentPath });
      assertProject(attachment.projectId, aggregate.manifest.projectId, `${attachmentPath}.projectId`);
      uuid(attachment.assetId, `${attachmentPath}.assetId`);
      sha(attachment.extractedSnapshotHash, `${attachmentPath}.extractedSnapshotHash`);
      enumValue(attachment.retentionMode, new Set(['reference-only', 'retain-excerpt', 'retain-full-managed-asset']), `${attachmentPath}.retentionMode`);
      timestamp(attachment.confirmedAt, `${attachmentPath}.confirmedAt`);
    });
  });
}

function validateAiCollections(aggregate) {
  const projectId = aggregate.manifest.projectId;
  const eventsById = new Map();
  const sequenceSet = new Set();
  aggregate.auditEvents.forEach((event, index) => {
    const path = `$.auditEvents[${index}]`;
    if (event.schemaVersion === 1) {
      validateAuditEvent(event, projectId, path);
      if (sequenceSet.has(event.sequence)) fail('SCHEMA_DUPLICATE_AUDIT_SEQUENCE', `${path}.sequence 重复`, { path });
      sequenceSet.add(event.sequence);
    }
    eventsById.set(event.eventId.toLowerCase(), event);
  });
  const ordered = aggregate.auditEvents.filter(event => event.schemaVersion === 1).sort((a, b) => a.sequence - b.sequence);
  ordered.forEach(event => {
    const earlier = id => {
      const target = eventsById.get(String(id || '').toLowerCase());
      return target && target.sequence < event.sequence ? target : null;
    };
    if (['ai-result', 'ai-aborted', 'ai-error'].includes(event.eventType)) {
      const request = earlier(event.requestEventId);
      if (!request || request.eventType !== 'ai-request') fail('SCHEMA_AUDIT_REQUEST_RELATION_INVALID', `审计事件 ${event.eventId} 的 request 关系无效`);
    }
    if (['ai-accepted', 'ai-rejected'].includes(event.eventType)) {
      const result = earlier(event.resultEventId);
      if (!result || result.eventType !== 'ai-result') fail('SCHEMA_AUDIT_RESULT_RELATION_INVALID', `审计事件 ${event.eventId} 的 result 关系无效`);
      if (event.eventType === 'ai-accepted') {
        const request = eventsById.get(result.requestEventId.toLowerCase());
        if (!request || !['rewrite', 'summarize'].includes(request.networkContext.operation)) {
          fail('SCHEMA_AUDIT_DECISION_OPERATION_INVALID', `操作 ${request?.networkContext?.operation || 'unknown'} 不允许 accepted`);
        }
      }
    }
    if (event.eventType === 'ai-regenerated') {
      const result = earlier(event.resultEventId);
      const replacement = earlier(event.replacementRequestEventId);
      if (!result || result.eventType !== 'ai-result' || !replacement || replacement.eventType !== 'ai-request') {
        fail('SCHEMA_AUDIT_REGENERATION_RELATION_INVALID', `审计事件 ${event.eventId} 的再生成关系无效`);
      }
    }
  });
  const blobsById = new Map();
  aggregate.auditContentBlobs.forEach((blob, index) => {
    if (blob.schemaVersion === 1) validateBlob(blob, projectId, `$.auditContentBlobs[${index}]`);
    blobsById.set(blob.blobId.toLowerCase(), blob);
  });
  const redactedBlobIds = new Set(aggregate.auditEvents
    .filter(event => event.schemaVersion === 1 && event.eventType === 'audit-redacted')
    .flatMap(event => event.redactedBlobs.map(blob => blob.blobId.toLowerCase())));
  for (const event of aggregate.auditEvents.filter(item => item.schemaVersion === 1)) {
    for (const [field, kind] of [['promptContentBlobId', 'prompt'], ['outputContentBlobId', 'output'], ['diffContentBlobId', 'diff']]) {
      if (!event[field]) continue;
      const blob = blobsById.get(event[field].toLowerCase());
      if ((!blob && !redactedBlobIds.has(event[field].toLowerCase())) ||
          (blob && (blob.ownerEventId !== event.eventId || blob.kind !== kind))) {
        fail('SCHEMA_AUDIT_BLOB_RELATION_INVALID', `${field} 与审计事件不匹配`, { eventId: event.eventId });
      }
    }
  }
  aggregate.aiThreads.forEach((thread, index) => {
    if (thread.schemaVersion === 1) validateAiThread(thread, aggregate, eventsById, `$.aiThreads[${index}]`);
  });
  aggregate.groundedAnswers.forEach((answer, index) => {
    if (answer.schemaVersion === 1) validateGroundedAnswer(answer, aggregate, eventsById, `$.groundedAnswers[${index}]`);
  });
  aggregate.reviewIssues.forEach((issue, index) => {
    if (issue.schemaVersion === 1 && issue.operationMode) validateReviewIssue(issue, aggregate, eventsById, `$.reviewIssues[${index}]`);
  });
  return aggregate;
}

module.exports = {
  AiModelError,
  BLOB_KINDS,
  CONTENT_RETENTIONS,
  OPERATIONS,
  PRIVACY_MODES,
  REVIEW_MODES,
  hashUtf8(value) {
    const buffer = Buffer.from(String(value), 'utf8');
    return { sha256: crypto.createHash('sha256').update(buffer).digest('hex'), byteCount: buffer.length };
  },
  validateAiCollections,
  validateAuditEvent,
  validateContextManifest,
  validateGroundedAnswer
};
