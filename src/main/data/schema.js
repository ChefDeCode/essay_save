'use strict';

const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');
const { validateAiCollections } = require('../ai/model');

const SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const PROJECT_COLLECTION_FIELDS = Object.freeze([
  'citationItems',
  'citationLinks',
  'researchQuestions',
  'evidenceCards',
  'evidenceRevisions',
  'evidenceReviewEvents',
  'aiThreads',
  'groundedAnswers',
  'reviewIssues',
  'auditEvents',
  'auditContentBlobs',
  'projectPaperStates',
  'reviewMatrices',
  'assetRefs',
  'versions'
]);

const FUTURE_COLLECTION_FIELDS = Object.freeze([
  'researchQuestions',
  'evidenceCards',
  'evidenceRevisions',
  'evidenceReviewEvents',
  'aiThreads',
  'groundedAnswers',
  'reviewIssues',
  'auditEvents',
  'auditContentBlobs',
  'projectPaperStates'
]);

const COLLECTION_ID_KEYS = Object.freeze({
  citationItems: ['id', 'citationItemId'],
  citationLinks: ['id'],
  researchQuestions: ['id'],
  evidenceCards: ['id'],
  evidenceRevisions: ['id'],
  evidenceReviewEvents: ['id'],
  aiThreads: ['id', 'threadId'],
  groundedAnswers: ['id'],
  reviewIssues: ['id'],
  auditEvents: ['eventId', 'id'],
  auditContentBlobs: ['blobId', 'id'],
  projectPaperStates: ['id'],
  reviewMatrices: ['id'],
  assetRefs: ['id', 'assetId'],
  versions: ['id', 'versionId', 'snapshotId']
});

class SchemaValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SchemaValidationError';
    this.code = code;
    this.path = details.path || '$';
    this.readOnly = details.readOnly === true;
    this.details = Object.freeze({ ...details, path: this.path });
  }
}

function fail(code, message, path, details = {}) {
  throw new SchemaValidationError(code, message, { ...details, path });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, path) {
  if (!isPlainObject(value)) {
    fail('SCHEMA_EXPECTED_OBJECT', `Expected an object at ${path}`, path);
  }
}

function assertExactFields(value, required, optional, path, options) {
  for (const key of required) {
    if (!hasOwn(value, key)) {
      fail('SCHEMA_REQUIRED_FIELD_MISSING', `Required field is missing at ${path}.${key}`, `${path}.${key}`);
    }
  }
  if (options.allowUnknownFields === true) return;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('SCHEMA_UNKNOWN_FIELD', `Unknown field at ${path}.${key}`, `${path}.${key}`, { field: key });
    }
  }
}

function assertSchemaVersion(value, path, entityType) {
  if (!Number.isInteger(value)) {
    fail('SCHEMA_INVALID_VERSION', `schemaVersion must be an integer at ${path}`, path, {
      entityType,
      actualVersion: value,
      supportedVersion: SCHEMA_VERSION
    });
  }
  if (value > SCHEMA_VERSION) {
    fail(
      'SCHEMA_FUTURE_VERSION_READ_ONLY',
      `${entityType} schema ${value} is newer than supported schema ${SCHEMA_VERSION}; writes are disabled`,
      path,
      {
        entityType,
        actualVersion: value,
        supportedVersion: SCHEMA_VERSION,
        readOnly: true
      }
    );
  }
  if (value !== SCHEMA_VERSION) {
    fail('SCHEMA_UNSUPPORTED_VERSION', `${entityType} schema ${value} requires migration`, path, {
      entityType,
      actualVersion: value,
      supportedVersion: SCHEMA_VERSION
    });
  }
}

function isStableUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function assertStableUuid(value, path) {
  if (!isStableUuid(value)) {
    fail('SCHEMA_INVALID_UUID', `Expected a stable UUID at ${path}`, path, { value });
  }
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  const fraction = (match[7] || '').padEnd(3, '0');
  const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${fraction || '000'}Z`;
  return new Date(epoch).toISOString() === expected;
}

function assertUtcTimestamp(value, path) {
  if (!isUtcTimestamp(value)) {
    fail('SCHEMA_INVALID_UTC_TIMESTAMP', `Expected a valid UTC ISO-8601 timestamp at ${path}`, path, { value });
  }
}

function assertString(value, path, options = {}) {
  if (typeof value !== 'string' || (options.nonEmpty && value.length === 0)) {
    fail('SCHEMA_INVALID_STRING', `Expected ${options.nonEmpty ? 'a non-empty ' : ''}string at ${path}`, path);
  }
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    fail('SCHEMA_INVALID_NON_NEGATIVE_INTEGER', `Expected a non-negative integer at ${path}`, path, { value });
  }
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') fail('SCHEMA_INVALID_BOOLEAN', `Expected a boolean at ${path}`, path);
}

function assertFiniteNumber(value, path, options = {}) {
  if (!Number.isFinite(value) || (options.minimum !== undefined && value < options.minimum) ||
      (options.maximum !== undefined && value > options.maximum)) {
    fail('SCHEMA_INVALID_NUMBER', `Expected a finite number at ${path}`, path, { value });
  }
}

function assertStringArray(value, path, options = {}) {
  if (!Array.isArray(value) || (options.maximumItems !== undefined && value.length > options.maximumItems)) {
    fail('SCHEMA_EXPECTED_ARRAY', `Expected an array at ${path}`, path);
  }
  value.forEach((item, index) => {
    assertString(item, `${path}[${index}]`, { nonEmpty: options.nonEmpty === true });
    if (options.maximumCodePoints !== undefined && Array.from(item).length > options.maximumCodePoints) {
      fail('SCHEMA_STRING_TOO_LONG', `String is too long at ${path}[${index}]`, `${path}[${index}]`);
    }
  });
}

function assertTimestampOrder(createdAt, updatedAt, path) {
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail('SCHEMA_TIMESTAMP_REGRESSION', `updatedAt precedes createdAt at ${path}`, path, {
      createdAt,
      updatedAt
    });
  }
}

function collectionItemId(item, field, path) {
  const keys = COLLECTION_ID_KEYS[field] || ['id'];
  const ids = keys
    .map(key => item[key])
    .filter(value => typeof value === 'string' && value.length > 0);
  if (new Set(ids.map(id => id.toLowerCase())).size > 1) {
    fail('SCHEMA_AMBIGUOUS_ID', `Conflicting identity fields at ${path}`, path, { ids });
  }
  return ids[0] || null;
}

function validateVersionEntry(item, path, options) {
  const required = ['id', 'snapshotHash', 'createdAt', 'source', 'manual', 'summary'];
  const optional = ['schemaVersion'];
  assertExactFields(item, required, optional, path, options);
  assertStableUuid(item.id, `${path}.id`);
  if (!SHA256_PATTERN.test(item.snapshotHash)) {
    fail('SCHEMA_INVALID_SHA256', `Expected a lowercase SHA-256 at ${path}.snapshotHash`, `${path}.snapshotHash`);
  }
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
  assertString(item.source, `${path}.source`, { nonEmpty: true });
  if (typeof item.manual !== 'boolean') {
    fail('SCHEMA_INVALID_BOOLEAN', `Expected a boolean at ${path}.manual`, `${path}.manual`);
  }
  assertPlainObject(item.summary, `${path}.summary`);
}

function validateCitationItem(item, path) {
  const citationItemId = item.citationItemId || item.id;
  assertStableUuid(citationItemId, `${path}.citationItemId`);
  if (item.id !== undefined && item.id.toLowerCase() !== citationItemId.toLowerCase()) {
    fail('SCHEMA_AMBIGUOUS_ID', `CitationItem identity mismatch at ${path}`, path);
  }
  if (item.libraryItemId !== undefined) assertStableUuid(item.libraryItemId, `${path}.libraryItemId`);
  const modern = item.capturedAt !== undefined || item.type !== undefined;
  if (modern) {
    assertString(item.type, `${path}.type`, { nonEmpty: true });
    assertString(item.title, `${path}.title`, { nonEmpty: true });
    if (item.capturedAt !== undefined) assertUtcTimestamp(item.capturedAt, `${path}.capturedAt`);
    for (const field of ['author', 'editor']) {
      if (item[field] === undefined) continue;
      if (!Array.isArray(item[field])) fail('SCHEMA_EXPECTED_ARRAY', `Expected an array at ${path}.${field}`, `${path}.${field}`);
      item[field].forEach((name, index) => {
        const namePath = `${path}.${field}[${index}]`;
        assertPlainObject(name, namePath);
        const literal = typeof name.literal === 'string' && name.literal.length > 0;
        const personal = (typeof name.family === 'string' && name.family.length > 0) || (typeof name.given === 'string' && name.given.length > 0);
        if (literal === personal) fail('SCHEMA_INVALID_CSL_NAME', `CSL name must use literal or family/given at ${namePath}`, namePath);
      });
    }
  }
}

function validateSourceCitationSnapshot(item, path) {
  assertPlainObject(item, path);
  assertExactFields(item, [
    'citationItemId', 'title', 'pageIndex', 'pageLabel', 'rawQuoteSha256', 'capturedAt'
  ], ['doi', 'assetId', 'fileSha256', 'quoteText'], path, {});
  assertStableUuid(item.citationItemId, `${path}.citationItemId`);
  assertString(item.title, `${path}.title`, { nonEmpty: true });
  if (item.doi !== undefined) assertString(item.doi, `${path}.doi`, { nonEmpty: true });
  if (item.assetId !== undefined) assertStableUuid(item.assetId, `${path}.assetId`);
  if (item.fileSha256 !== undefined && !SHA256_PATTERN.test(item.fileSha256)) {
    fail('SCHEMA_INVALID_SHA256', `Expected a lowercase SHA-256 at ${path}.fileSha256`, `${path}.fileSha256`);
  }
  if ((item.assetId === undefined) !== (item.fileSha256 === undefined)) {
    fail('SCHEMA_INCOMPLETE_SOURCE_ASSET', `assetId and fileSha256 must be paired at ${path}`, path);
  }
  assertNonNegativeInteger(item.pageIndex, `${path}.pageIndex`);
  assertString(item.pageLabel, `${path}.pageLabel`, { nonEmpty: true });
  if (!SHA256_PATTERN.test(item.rawQuoteSha256)) {
    fail('SCHEMA_INVALID_SHA256', `Expected a lowercase SHA-256 at ${path}.rawQuoteSha256`, `${path}.rawQuoteSha256`);
  }
  if (item.quoteText !== undefined) assertString(item.quoteText, `${path}.quoteText`, { nonEmpty: true });
  assertUtcTimestamp(item.capturedAt, `${path}.capturedAt`);
}

function validateEvidenceCard(item, path) {
  assertExactFields(item, [
    'schemaVersion', 'id', 'projectId', 'currentRevisionId', 'note', 'tags', 'color',
    'researchQuestionIds', 'status', 'createdAt', 'updatedAt'
  ], ['archivedAt'], path, {});
  assertStableUuid(item.currentRevisionId, `${path}.currentRevisionId`);
  assertString(item.note, `${path}.note`);
  assertStringArray(item.tags, `${path}.tags`, { maximumItems: 100, maximumCodePoints: 256, nonEmpty: true });
  if (new Set(item.tags).size !== item.tags.length) fail('SCHEMA_DUPLICATE_TAG', `Duplicate tag at ${path}.tags`, `${path}.tags`);
  assertString(item.color, `${path}.color`, { nonEmpty: true });
  if (!/^#[0-9a-f]{6}$/i.test(item.color)) fail('SCHEMA_INVALID_COLOR', `Invalid evidence color at ${path}.color`, `${path}.color`);
  if (!Array.isArray(item.researchQuestionIds)) fail('SCHEMA_EXPECTED_ARRAY', `Expected an array at ${path}.researchQuestionIds`, `${path}.researchQuestionIds`);
  item.researchQuestionIds.forEach((id, index) => assertStableUuid(id, `${path}.researchQuestionIds[${index}]`));
  if (!['active', 'source-missing', 'source-mismatch', 'anchor-missing', 'archived'].includes(item.status)) {
    fail('SCHEMA_INVALID_EVIDENCE_STATUS', `Invalid evidence status at ${path}.status`, `${path}.status`);
  }
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
  assertUtcTimestamp(item.updatedAt, `${path}.updatedAt`);
  assertTimestampOrder(item.createdAt, item.updatedAt, path);
  if (item.status === 'archived') {
    assertUtcTimestamp(item.archivedAt, `${path}.archivedAt`);
  } else if (item.archivedAt !== undefined) {
    fail('SCHEMA_UNEXPECTED_ARCHIVED_AT', `Only archived evidence may have archivedAt at ${path}`, `${path}.archivedAt`);
  }
}

function validateEvidenceRect(item, path, normalized) {
  assertPlainObject(item, path);
  assertExactFields(item, ['x', 'y', 'width', 'height'], [], path, {});
  const maximum = normalized ? 1 : undefined;
  for (const field of ['x', 'y', 'width', 'height']) {
    assertFiniteNumber(item[field], `${path}.${field}`, { minimum: 0, maximum });
  }
  if (item.width <= 0 || item.height <= 0) fail('SCHEMA_EMPTY_RECT', `Rectangle has no area at ${path}`, path);
  if (normalized && (item.x + item.width > 1.000001 || item.y + item.height > 1.000001)) {
    fail('SCHEMA_RECT_OUT_OF_BOUNDS', `Normalized rectangle exceeds page bounds at ${path}`, path);
  }
}

function validateEvidenceRevision(item, path) {
  assertExactFields(item, [
    'schemaVersion', 'id', 'evidenceId', 'revisionNumber', 'citationItemId', 'sourceSnapshot',
    'locator', 'createdBy', 'createdAt'
  ], ['libraryItemId'], path, {});
  assertStableUuid(item.evidenceId, `${path}.evidenceId`);
  if (!Number.isInteger(item.revisionNumber) || item.revisionNumber < 1) {
    fail('SCHEMA_INVALID_REVISION_NUMBER', `Invalid evidence revision number at ${path}.revisionNumber`, `${path}.revisionNumber`);
  }
  assertStableUuid(item.citationItemId, `${path}.citationItemId`);
  if (item.libraryItemId !== undefined) assertStableUuid(item.libraryItemId, `${path}.libraryItemId`);
  const source = item.sourceSnapshot;
  assertPlainObject(source, `${path}.sourceSnapshot`);
  assertExactFields(source, ['assetId', 'fileSha256', 'title', 'metadataSource'], ['doi'], `${path}.sourceSnapshot`, {});
  assertStableUuid(source.assetId, `${path}.sourceSnapshot.assetId`);
  if (!SHA256_PATTERN.test(source.fileSha256)) fail('SCHEMA_INVALID_SHA256', `Invalid source hash at ${path}.sourceSnapshot.fileSha256`, `${path}.sourceSnapshot.fileSha256`);
  assertString(source.title, `${path}.sourceSnapshot.title`, { nonEmpty: true });
  if (source.doi !== undefined) assertString(source.doi, `${path}.sourceSnapshot.doi`, { nonEmpty: true });
  if (!['api', 'imported', 'manual'].includes(source.metadataSource)) {
    fail('SCHEMA_INVALID_METADATA_SOURCE', `Invalid metadata source at ${path}.sourceSnapshot.metadataSource`, `${path}.sourceSnapshot.metadataSource`);
  }
  const locator = item.locator;
  assertPlainObject(locator, `${path}.locator`);
  assertExactFields(locator, [
    'pageIndex', 'pageLabel', 'quoteRaw', 'quoteDisplay', 'rawQuoteSha256', 'displayQuoteSha256',
    'pageTextSha256', 'prefix', 'suffix', 'occurrenceIndex', 'rects', 'pageRotation', 'cropBox',
    'extractorName', 'extractorVersion', 'transformVersion', 'normalization', 'extraction'
  ], [], `${path}.locator`, {});
  assertNonNegativeInteger(locator.pageIndex, `${path}.locator.pageIndex`);
  assertString(locator.pageLabel, `${path}.locator.pageLabel`, { nonEmpty: true });
  for (const field of ['quoteRaw', 'quoteDisplay']) {
    assertString(locator[field], `${path}.locator.${field}`, { nonEmpty: true });
    const length = Array.from(locator[field]).length;
    if (length < 1 || length > 2000) fail('SCHEMA_EVIDENCE_QUOTE_LENGTH', `Evidence quote must contain 1-2000 characters at ${path}.locator.${field}`, `${path}.locator.${field}`);
  }
  for (const field of ['rawQuoteSha256', 'displayQuoteSha256', 'pageTextSha256']) {
    if (!SHA256_PATTERN.test(locator[field])) fail('SCHEMA_INVALID_SHA256', `Invalid hash at ${path}.locator.${field}`, `${path}.locator.${field}`);
  }
  for (const field of ['prefix', 'suffix']) {
    assertString(locator[field], `${path}.locator.${field}`);
    if (Array.from(locator[field]).length > 256) fail('SCHEMA_EVIDENCE_CONTEXT_TOO_LONG', `Evidence context exceeds 256 characters at ${path}.locator.${field}`, `${path}.locator.${field}`);
  }
  assertNonNegativeInteger(locator.occurrenceIndex, `${path}.locator.occurrenceIndex`);
  if (!Array.isArray(locator.rects) || !locator.rects.length) fail('SCHEMA_EVIDENCE_RECTS_REQUIRED', `Evidence rectangles are required at ${path}.locator.rects`, `${path}.locator.rects`);
  locator.rects.forEach((rect, index) => validateEvidenceRect(rect, `${path}.locator.rects[${index}]`, true));
  if (![0, 90, 180, 270].includes(locator.pageRotation)) fail('SCHEMA_INVALID_PAGE_ROTATION', `Invalid page rotation at ${path}.locator.pageRotation`, `${path}.locator.pageRotation`);
  validateEvidenceRect(locator.cropBox, `${path}.locator.cropBox`, false);
  for (const field of ['extractorName', 'extractorVersion', 'transformVersion']) assertString(locator[field], `${path}.locator.${field}`, { nonEmpty: true });
  if (!['whitespace-collapse', 'linebreak-join', 'hyphen-join'].includes(locator.normalization)) {
    fail('SCHEMA_INVALID_NORMALIZATION', `Invalid evidence normalization at ${path}.locator.normalization`, `${path}.locator.normalization`);
  }
  if (locator.extraction !== 'pdf-text') fail('SCHEMA_INVALID_EXTRACTION', `Evidence extraction must be pdf-text at ${path}.locator.extraction`, `${path}.locator.extraction`);
  if (!['user', 'ai'].includes(item.createdBy)) fail('SCHEMA_INVALID_EVIDENCE_ACTOR', `Invalid evidence creator at ${path}.createdBy`, `${path}.createdBy`);
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
}

function validateEvidenceReviewEvent(item, path) {
  assertExactFields(item, [
    'schemaVersion', 'id', 'projectId', 'evidenceId', 'evidenceRevisionId', 'sequence',
    'previousReviewEventId', 'status', 'actor', 'createdAt'
  ], ['sourceAuditResultEventId', 'reason'], path, {});
  assertStableUuid(item.evidenceId, `${path}.evidenceId`);
  assertStableUuid(item.evidenceRevisionId, `${path}.evidenceRevisionId`);
  if (!Number.isInteger(item.sequence) || item.sequence < 1) fail('SCHEMA_INVALID_EVIDENCE_SEQUENCE', `Invalid evidence review sequence at ${path}.sequence`, `${path}.sequence`);
  if (item.previousReviewEventId !== null) assertStableUuid(item.previousReviewEventId, `${path}.previousReviewEventId`);
  if (!['proposed', 'confirmed', 'rejected'].includes(item.status)) fail('SCHEMA_INVALID_EVIDENCE_REVIEW_STATUS', `Invalid review status at ${path}.status`, `${path}.status`);
  if (!['user', 'ai'].includes(item.actor)) fail('SCHEMA_INVALID_EVIDENCE_ACTOR', `Invalid review actor at ${path}.actor`, `${path}.actor`);
  if (item.sourceAuditResultEventId !== undefined) assertStableUuid(item.sourceAuditResultEventId, `${path}.sourceAuditResultEventId`);
  if (item.reason !== undefined) assertString(item.reason, `${path}.reason`, { nonEmpty: true });
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
}

function validateCitationLink(item, path, seenIds) {
  if (!Array.isArray(item.items)) {
    assertStableUuid(item.citationItemId, `${path}.citationItemId`);
    if (!isPlainObject(item.migration)) fail('SCHEMA_LEGACY_CITATION_INVALID', `Legacy CitationLink migration metadata is required at ${path}`, path);
    return;
  }
  assertExactFields(item, ['schemaVersion', 'id', 'projectId', 'insertionMode', 'items', 'createdAt', 'updatedAt'], [], path, {});
  if (!['quote', 'paraphrase', 'citation-only'].includes(item.insertionMode)) {
    fail('SCHEMA_INVALID_CITATION_MODE', `Invalid CitationLink insertionMode at ${path}`, `${path}.insertionMode`);
  }
  if (!item.items.length) fail('SCHEMA_EMPTY_CITATION_CLUSTER', `CitationLink items cannot be empty at ${path}`, `${path}.items`);
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
  assertUtcTimestamp(item.updatedAt, `${path}.updatedAt`);
  assertTimestampOrder(item.createdAt, item.updatedAt, path);
  const orders = new Set();
  item.items.forEach((entry, index) => {
    const entryPath = `${path}.items[${index}]`;
    assertPlainObject(entry, entryPath);
    assertExactFields(entry, [
      'citationItemEntryId', 'citationItemId', 'evidenceRevisionIds', 'sourceCitationSnapshots',
      'suppressAuthor', 'order', 'status'
    ], ['locator', 'label', 'prefix', 'suffix'], entryPath, {});
    assertStableUuid(entry.citationItemEntryId, `${entryPath}.citationItemEntryId`);
    const normalizedEntryId = entry.citationItemEntryId.toLowerCase();
    if (seenIds.has(normalizedEntryId)) {
      fail('SCHEMA_DUPLICATE_ID', `Duplicate citation entry ID at ${entryPath}`, entryPath, { id: entry.citationItemEntryId });
    }
    seenIds.set(normalizedEntryId, entryPath);
    assertStableUuid(entry.citationItemId, `${entryPath}.citationItemId`);
    if (!Array.isArray(entry.evidenceRevisionIds) || !Array.isArray(entry.sourceCitationSnapshots)) {
      fail('SCHEMA_EXPECTED_ARRAY', `Citation evidence arrays are required at ${entryPath}`, entryPath);
    }
    entry.evidenceRevisionIds.forEach((id, evidenceIndex) => assertStableUuid(id, `${entryPath}.evidenceRevisionIds[${evidenceIndex}]`));
    if (entry.evidenceRevisionIds.length !== entry.sourceCitationSnapshots.length) {
      fail('SCHEMA_CITATION_SNAPSHOT_COUNT_MISMATCH', `Citation evidence and snapshot counts differ at ${entryPath}`, entryPath);
    }
    entry.sourceCitationSnapshots.forEach((snapshot, snapshotIndex) =>
      validateSourceCitationSnapshot(snapshot, `${entryPath}.sourceCitationSnapshots[${snapshotIndex}]`));
    const hasLocator = typeof entry.locator === 'string' && entry.locator.length > 0;
    const hasLabel = typeof entry.label === 'string' && entry.label.length > 0;
    if (hasLocator !== hasLabel || (hasLabel && !['page', 'chapter', 'section', 'paragraph', 'figure', 'table'].includes(entry.label))) {
      fail('SCHEMA_INVALID_CITATION_LOCATOR', `Citation locator and label must be a valid pair at ${entryPath}`, entryPath);
    }
    for (const field of ['prefix', 'suffix']) if (entry[field] !== undefined) assertString(entry[field], `${entryPath}.${field}`);
    assertBoolean(entry.suppressAuthor, `${entryPath}.suppressAuthor`);
    assertNonNegativeInteger(entry.order, `${entryPath}.order`);
    if (orders.has(entry.order)) fail('SCHEMA_DUPLICATE_CITATION_ORDER', `Duplicate CitationLink item order at ${entryPath}`, `${entryPath}.order`);
    orders.add(entry.order);
    if (!['active', 'evidence-missing', 'source-mismatch'].includes(entry.status)) {
      fail('SCHEMA_INVALID_CITATION_STATUS', `Invalid citation item status at ${entryPath}`, `${entryPath}.status`);
    }
  });
}

function validateProjectPaperState(item, path) {
  assertExactFields(item, [
    'schemaVersion', 'id', 'projectId', 'citationItemId', 'screeningStatus', 'readingStatus',
    'projectNotes', 'createdAt', 'updatedAt'
  ], ['exclusionReason'], path, {});
  assertStableUuid(item.citationItemId, `${path}.citationItemId`);
  if (!['pending', 'included', 'excluded'].includes(item.screeningStatus)) {
    fail('SCHEMA_INVALID_SCREENING_STATUS', `Invalid screeningStatus at ${path}`, `${path}.screeningStatus`);
  }
  if (!['unread', 'to-read', 'reading', 'read'].includes(item.readingStatus)) {
    fail('SCHEMA_INVALID_READING_STATUS', `Invalid readingStatus at ${path}`, `${path}.readingStatus`);
  }
  assertString(item.projectNotes, `${path}.projectNotes`);
  if (item.screeningStatus === 'excluded') assertString(item.exclusionReason, `${path}.exclusionReason`, { nonEmpty: true });
  else if (item.exclusionReason !== undefined) fail('SCHEMA_UNEXPECTED_EXCLUSION_REASON', `Only excluded papers may have exclusionReason at ${path}`, `${path}.exclusionReason`);
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
  assertUtcTimestamp(item.updatedAt, `${path}.updatedAt`);
  assertTimestampOrder(item.createdAt, item.updatedAt, path);
}

function validateMatrixSourceRef(item, path) {
  assertPlainObject(item, path);
  assertExactFields(item, [
    'evidenceId', 'evidenceRevisionId', 'citationItemId', 'pageLabel', 'quote',
    'rawQuoteSha256', 'basis', 'reviewStatus'
  ], [], path, {});
  for (const field of ['evidenceId', 'evidenceRevisionId', 'citationItemId']) assertStableUuid(item[field], `${path}.${field}`);
  for (const field of ['pageLabel', 'quote']) assertString(item[field], `${path}.${field}`, { nonEmpty: true });
  if (!SHA256_PATTERN.test(item.rawQuoteSha256)) fail('SCHEMA_INVALID_SHA256', `Invalid matrix quote hash at ${path}.rawQuoteSha256`, `${path}.rawQuoteSha256`);
  if (item.basis !== 'pdf-evidence') fail('SCHEMA_INVALID_MATRIX_BASIS', `Matrix source reference must use pdf-evidence at ${path}`, `${path}.basis`);
  if (!['proposed', 'confirmed', 'rejected'].includes(item.reviewStatus)) {
    fail('SCHEMA_INVALID_MATRIX_REVIEW_STATUS', `Invalid matrix source review status at ${path}`, `${path}.reviewStatus`);
  }
}

function validateReviewMatrix(item, path) {
  assertExactFields(item, [
    'schemaVersion', 'id', 'projectId', 'name', 'columns', 'rows', 'createdAt', 'updatedAt'
  ], [], path, {});
  assertString(item.name, `${path}.name`, { nonEmpty: true });
  if (!Array.isArray(item.columns) || item.columns.length < 1 || item.columns.length > 100) {
    fail('SCHEMA_INVALID_MATRIX_COLUMNS', `Matrix must contain 1-100 columns at ${path}.columns`, `${path}.columns`);
  }
  if (!Array.isArray(item.rows) || item.rows.length > 10000) {
    fail('SCHEMA_INVALID_MATRIX_ROWS', `Matrix rows are invalid at ${path}.rows`, `${path}.rows`);
  }
  const columnIds = new Set();
  const columnKeys = new Set();
  const orders = new Set();
  item.columns.forEach((column, index) => {
    const columnPath = `${path}.columns[${index}]`;
    assertPlainObject(column, columnPath);
    assertExactFields(column, ['id', 'key', 'label', 'order', 'userDefined'], [], columnPath, {});
    assertStableUuid(column.id, `${columnPath}.id`);
    assertString(column.key, `${columnPath}.key`, { nonEmpty: true });
    assertString(column.label, `${columnPath}.label`, { nonEmpty: true });
    assertNonNegativeInteger(column.order, `${columnPath}.order`);
    assertBoolean(column.userDefined, `${columnPath}.userDefined`);
    const id = column.id.toLowerCase();
    if (columnIds.has(id) || columnKeys.has(column.key) || orders.has(column.order)) {
      fail('SCHEMA_DUPLICATE_MATRIX_COLUMN', `Duplicate matrix column identity at ${columnPath}`, columnPath);
    }
    columnIds.add(id);
    columnKeys.add(column.key);
    orders.add(column.order);
  });
  const rowIds = new Set();
  item.rows.forEach((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    assertPlainObject(row, rowPath);
    assertExactFields(row, [
      'id', 'citationItemId', 'taskStatus', 'attempt', 'cells', 'createdAt', 'updatedAt'
    ], ['failureReason'], rowPath, {});
    assertStableUuid(row.id, `${rowPath}.id`);
    assertStableUuid(row.citationItemId, `${rowPath}.citationItemId`);
    if (rowIds.has(row.id.toLowerCase())) fail('SCHEMA_DUPLICATE_MATRIX_ROW', `Duplicate matrix row at ${rowPath}`, rowPath);
    rowIds.add(row.id.toLowerCase());
    if (!['queued', 'running', 'completed', 'failed', 'canceled'].includes(row.taskStatus)) {
      fail('SCHEMA_INVALID_MATRIX_TASK_STATUS', `Invalid matrix task status at ${rowPath}.taskStatus`, `${rowPath}.taskStatus`);
    }
    assertNonNegativeInteger(row.attempt, `${rowPath}.attempt`);
    if (row.failureReason !== undefined) assertString(row.failureReason, `${rowPath}.failureReason`, { nonEmpty: true });
    assertPlainObject(row.cells, `${rowPath}.cells`);
    for (const [columnId, cell] of Object.entries(row.cells)) {
      const cellPath = `${rowPath}.cells.${columnId}`;
      assertStableUuid(columnId, `${cellPath}.columnKey`);
      if (!columnIds.has(columnId.toLowerCase())) fail('SCHEMA_MATRIX_COLUMN_MISSING', `Matrix cell column is missing at ${cellPath}`, cellPath);
      assertPlainObject(cell, cellPath);
      assertExactFields(cell, [
        'schemaVersion', 'id', 'columnId', 'citationItemId', 'value', 'origin', 'reviewStatus', 'userEdited',
        'basis', 'sourceRefs', 'createdAt', 'updatedAt'
      ], ['auditResultEventId', 'abstractSnapshotSha256', 'abstractSnapshotText', 'reviewedBy', 'reviewedAt'], cellPath, {});
      assertStableUuid(cell.id, `${cellPath}.id`);
      assertStableUuid(cell.columnId, `${cellPath}.columnId`);
      assertStableUuid(cell.citationItemId, `${cellPath}.citationItemId`);
      if (cell.citationItemId.toLowerCase() !== row.citationItemId.toLowerCase()) fail('SCHEMA_MATRIX_CELL_CITATION_MISMATCH', `Matrix cell citation mismatch at ${cellPath}`, cellPath);
      if (cell.columnId.toLowerCase() !== columnId.toLowerCase()) fail('SCHEMA_MATRIX_COLUMN_MISMATCH', `Matrix cell column mismatch at ${cellPath}`, cellPath);
      assertString(cell.value, `${cellPath}.value`);
      if (!['user', 'ai'].includes(cell.origin)) fail('SCHEMA_INVALID_MATRIX_ORIGIN', `Invalid matrix origin at ${cellPath}.origin`, `${cellPath}.origin`);
      if (!['draft', 'proposed', 'confirmed', 'not-found'].includes(cell.reviewStatus)) {
        fail('SCHEMA_INVALID_MATRIX_REVIEW_STATUS', `Invalid matrix review status at ${cellPath}.reviewStatus`, `${cellPath}.reviewStatus`);
      }
      assertBoolean(cell.userEdited, `${cellPath}.userEdited`);
      if (!['manual', 'pdf-evidence', 'abstract-only', 'not-found'].includes(cell.basis)) {
        fail('SCHEMA_INVALID_MATRIX_BASIS', `Invalid matrix basis at ${cellPath}.basis`, `${cellPath}.basis`);
      }
      if (!Array.isArray(cell.sourceRefs)) fail('SCHEMA_EXPECTED_ARRAY', `Matrix sourceRefs must be an array at ${cellPath}.sourceRefs`, `${cellPath}.sourceRefs`);
      cell.sourceRefs.forEach((ref, refIndex) => validateMatrixSourceRef(ref, `${cellPath}.sourceRefs[${refIndex}]`));
      if (cell.basis === 'pdf-evidence' && !cell.sourceRefs.length) fail('SCHEMA_MATRIX_EVIDENCE_REQUIRED', `PDF matrix cell requires evidence at ${cellPath}`, cellPath);
      if (cell.basis !== 'pdf-evidence' && cell.sourceRefs.length) fail('SCHEMA_MATRIX_EVIDENCE_UNEXPECTED', `Only PDF matrix cells may carry evidence at ${cellPath}`, cellPath);
      if (cell.origin === 'ai') {
        assertStableUuid(cell.auditResultEventId, `${cellPath}.auditResultEventId`);
        if (cell.reviewStatus === 'confirmed' && cell.reviewedBy !== 'user') {
          fail('SCHEMA_MATRIX_AI_AUTO_CONFIRMED', `AI matrix cell cannot self-confirm at ${cellPath}`, cellPath);
        }
      } else if (cell.auditResultEventId !== undefined) {
        fail('SCHEMA_MATRIX_AUDIT_UNEXPECTED', `Manual matrix cell cannot claim an AI audit event at ${cellPath}`, cellPath);
      }
      if (cell.basis === 'abstract-only') {
        if (!SHA256_PATTERN.test(cell.abstractSnapshotSha256 || '')) fail('SCHEMA_MATRIX_ABSTRACT_HASH_REQUIRED', `Abstract-only cell requires a snapshot hash at ${cellPath}`, cellPath);
        assertString(cell.abstractSnapshotText, `${cellPath}.abstractSnapshotText`, { nonEmpty: true });
        const actualHash = crypto.createHash('sha256').update(cell.abstractSnapshotText, 'utf8').digest('hex');
        if (actualHash !== cell.abstractSnapshotSha256) fail('SCHEMA_MATRIX_ABSTRACT_HASH_MISMATCH', `Abstract snapshot hash mismatch at ${cellPath}`, cellPath);
        if (cell.reviewStatus !== 'draft') fail('SCHEMA_MATRIX_ABSTRACT_MUST_BE_DRAFT', `Abstract-only AI cell must remain draft at ${cellPath}`, cellPath);
      }
      if (cell.basis === 'not-found' && (cell.value !== '' || cell.reviewStatus !== 'not-found')) {
        fail('SCHEMA_MATRIX_NOT_FOUND_INVALID', `Not-found matrix cell must be empty and declared at ${cellPath}`, cellPath);
      }
      if (cell.reviewedBy !== undefined && cell.reviewedBy !== 'user') fail('SCHEMA_MATRIX_REVIEWER_INVALID', `Matrix reviewer must be user at ${cellPath}`, `${cellPath}.reviewedBy`);
      if ((cell.reviewedBy === undefined) !== (cell.reviewedAt === undefined)) fail('SCHEMA_MATRIX_REVIEW_PAIR_INVALID', `Matrix review actor and time must be paired at ${cellPath}`, cellPath);
      if (cell.reviewedAt !== undefined) assertUtcTimestamp(cell.reviewedAt, `${cellPath}.reviewedAt`);
      assertUtcTimestamp(cell.createdAt, `${cellPath}.createdAt`);
      assertUtcTimestamp(cell.updatedAt, `${cellPath}.updatedAt`);
      assertTimestampOrder(cell.createdAt, cell.updatedAt, cellPath);
    }
    assertUtcTimestamp(row.createdAt, `${rowPath}.createdAt`);
    assertUtcTimestamp(row.updatedAt, `${rowPath}.updatedAt`);
    assertTimestampOrder(row.createdAt, row.updatedAt, rowPath);
  });
  assertUtcTimestamp(item.createdAt, `${path}.createdAt`);
  assertUtcTimestamp(item.updatedAt, `${path}.updatedAt`);
  assertTimestampOrder(item.createdAt, item.updatedAt, path);
}

function validateProjectCollection(field, value, projectId, seenIds, options) {
  const path = `$.${field}`;
  if (!Array.isArray(value)) fail('SCHEMA_EXPECTED_ARRAY', `Expected an array at ${path}`, path);
  if (options.requireEmptyFutureCollections === true && FUTURE_COLLECTION_FIELDS.includes(field) && value.length) {
    fail('SCHEMA_FUTURE_COLLECTION_NOT_EMPTY', `Future collection must remain empty at ${path}`, path, {
      itemCount: value.length
    });
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    assertPlainObject(item, itemPath);
    const id = collectionItemId(item, field, itemPath);
    assertStableUuid(id, `${itemPath}.id`);
    const normalizedId = id.toLowerCase();
    if (seenIds.has(normalizedId)) {
      fail('SCHEMA_DUPLICATE_ID', `Duplicate primary ID at ${itemPath}`, itemPath, {
        id,
        firstPath: seenIds.get(normalizedId)
      });
    }
    seenIds.set(normalizedId, itemPath);
    if (hasOwn(item, 'schemaVersion')) {
      assertSchemaVersion(item.schemaVersion, `${itemPath}.schemaVersion`, field);
    }
    if (hasOwn(item, 'projectId')) {
      assertStableUuid(item.projectId, `${itemPath}.projectId`);
      if (item.projectId.toLowerCase() !== projectId.toLowerCase()) {
        fail('SCHEMA_PROJECT_ID_MISMATCH', `Project ID mismatch at ${itemPath}.projectId`, `${itemPath}.projectId`, {
          expectedProjectId: projectId,
          actualProjectId: item.projectId
        });
      }
    }
    if (field === 'citationItems') validateCitationItem(item, itemPath);
    if (field === 'citationLinks') validateCitationLink(item, itemPath, seenIds);
    if (field === 'evidenceCards') validateEvidenceCard(item, itemPath);
    if (field === 'evidenceRevisions') validateEvidenceRevision(item, itemPath);
    if (field === 'evidenceReviewEvents') validateEvidenceReviewEvent(item, itemPath);
    if (field === 'projectPaperStates') validateProjectPaperState(item, itemPath);
    if (field === 'reviewMatrices') validateReviewMatrix(item, itemPath);
    if (field === 'versions') validateVersionEntry(item, itemPath, options);
  });
}

function validateProjectAggregate(value, options = {}) {
  assertPlainObject(value, '$');
  assertExactFields(
    value,
    ['schemaVersion', 'manifest', 'document', ...PROJECT_COLLECTION_FIELDS],
    [],
    '$',
    options
  );
  assertSchemaVersion(value.schemaVersion, '$.schemaVersion', 'ProjectAggregate');

  const manifest = value.manifest;
  assertPlainObject(manifest, '$.manifest');
  assertExactFields(manifest, [
    'projectId',
    'title',
    'author',
    'course',
    'degree',
    'wordLimit',
    'referenceStyle',
    'privacyMode',
    'createdAt',
    'updatedAt',
    'revision'
  ], [], '$.manifest', options);
  assertStableUuid(manifest.projectId, '$.manifest.projectId');
  for (const key of ['title', 'author', 'course', 'degree']) assertString(manifest[key], `$.manifest.${key}`);
  if (manifest.wordLimit !== null) assertNonNegativeInteger(manifest.wordLimit, '$.manifest.wordLimit');
  assertString(manifest.referenceStyle, '$.manifest.referenceStyle', { nonEmpty: true });
  if (!['normal', 'sensitive', 'local-only'].includes(manifest.privacyMode)) {
    fail('SCHEMA_INVALID_PRIVACY_MODE', 'Invalid privacy mode at $.manifest.privacyMode', '$.manifest.privacyMode', {
      value: manifest.privacyMode
    });
  }
  assertUtcTimestamp(manifest.createdAt, '$.manifest.createdAt');
  assertUtcTimestamp(manifest.updatedAt, '$.manifest.updatedAt');
  assertTimestampOrder(manifest.createdAt, manifest.updatedAt, '$.manifest');
  assertNonNegativeInteger(manifest.revision, '$.manifest.revision');

  const document = value.document;
  assertPlainObject(document, '$.document');
  assertExactFields(document, ['canonicalFormat', 'html'], ['derivedDelta'], '$.document', options);
  if (document.canonicalFormat !== 'html') {
    fail('SCHEMA_INVALID_CANONICAL_FORMAT', 'Project document canonicalFormat must be html', '$.document.canonicalFormat', {
      value: document.canonicalFormat
    });
  }
  assertString(document.html, '$.document.html');
  if (hasOwn(document, 'derivedDelta') && !isPlainObject(document.derivedDelta)) {
    fail('SCHEMA_INVALID_DERIVED_DELTA', 'derivedDelta must be an object when present', '$.document.derivedDelta');
  }

  const seenIds = new Map([[manifest.projectId.toLowerCase(), '$.manifest.projectId']]);
  for (const field of PROJECT_COLLECTION_FIELDS) {
    validateProjectCollection(field, value[field], manifest.projectId, seenIds, options);
  }
  const citationItemIds = new Set(value.citationItems.map(item => (item.citationItemId || item.id).toLowerCase()));
  for (const link of value.citationLinks) {
    const entries = Array.isArray(link.items) ? link.items : [{ citationItemId: link.citationItemId }];
    for (const entry of entries) {
      if (!citationItemIds.has(entry.citationItemId.toLowerCase())) {
        fail('SCHEMA_DANGLING_CITATION_ITEM', 'CitationLink references a missing CitationItem', '$.citationLinks', {
          citationLinkId: link.id,
          citationItemId: entry.citationItemId
        });
      }
    }
  }
  for (const state of value.projectPaperStates) {
    if (!citationItemIds.has(state.citationItemId.toLowerCase())) {
      fail('SCHEMA_DANGLING_PROJECT_PAPER_STATE', 'ProjectPaperState references a missing CitationItem', '$.projectPaperStates', {
        stateId: state.id,
        citationItemId: state.citationItemId
      });
    }
  }
  const evidenceCardsById = new Map(value.evidenceCards.map(item => [item.id.toLowerCase(), item]));
  const evidenceRevisionsById = new Map(value.evidenceRevisions.map(item => [item.id.toLowerCase(), item]));
  const evidenceReviewByRevision = new Map();
  const revisionNumbersByEvidence = new Map();
  const auditEventsById = new Map(value.auditEvents.map(item => [String(item.eventId || item.id || '').toLowerCase(), item]));
  for (const revision of value.evidenceRevisions) {
    const evidenceId = revision.evidenceId.toLowerCase();
    if (!evidenceCardsById.has(evidenceId)) {
      fail('SCHEMA_DANGLING_EVIDENCE_CARD', 'EvidenceRevision references a missing EvidenceCard', '$.evidenceRevisions', {
        evidenceRevisionId: revision.id,
        evidenceId: revision.evidenceId
      });
    }
    if (!citationItemIds.has(revision.citationItemId.toLowerCase())) {
      fail('SCHEMA_DANGLING_EVIDENCE_CITATION_ITEM', 'EvidenceRevision references a missing CitationItem', '$.evidenceRevisions', {
        evidenceRevisionId: revision.id,
        citationItemId: revision.citationItemId
      });
    }
    if (!revisionNumbersByEvidence.has(evidenceId)) revisionNumbersByEvidence.set(evidenceId, new Set());
    if (revisionNumbersByEvidence.get(evidenceId).has(revision.revisionNumber)) {
      fail('SCHEMA_DUPLICATE_EVIDENCE_REVISION_NUMBER', 'Evidence revision number is duplicated', '$.evidenceRevisions', {
        evidenceId: revision.evidenceId,
        revisionNumber: revision.revisionNumber
      });
    }
    revisionNumbersByEvidence.get(evidenceId).add(revision.revisionNumber);
  }
  for (const card of value.evidenceCards) {
    const current = evidenceRevisionsById.get(card.currentRevisionId.toLowerCase());
    if (!current || current.evidenceId.toLowerCase() !== card.id.toLowerCase()) {
      fail('SCHEMA_INVALID_CURRENT_EVIDENCE_REVISION', 'EvidenceCard currentRevisionId is missing or belongs to another card', '$.evidenceCards', {
        evidenceId: card.id,
        currentRevisionId: card.currentRevisionId
      });
    }
  }
  for (const event of value.evidenceReviewEvents) {
    const revision = evidenceRevisionsById.get(event.evidenceRevisionId.toLowerCase());
    if (!revision || revision.evidenceId.toLowerCase() !== event.evidenceId.toLowerCase()) {
      fail('SCHEMA_DANGLING_EVIDENCE_REVIEW', 'EvidenceReviewEvent references a missing or mismatched revision', '$.evidenceReviewEvents', {
        reviewEventId: event.id,
        evidenceRevisionId: event.evidenceRevisionId
      });
    }
    const key = event.evidenceRevisionId.toLowerCase();
    if (!evidenceReviewByRevision.has(key)) evidenceReviewByRevision.set(key, []);
    evidenceReviewByRevision.get(key).push(event);
  }
  const derivedReviewStatus = new Map();
  for (const revision of value.evidenceRevisions) {
    const events = (evidenceReviewByRevision.get(revision.id.toLowerCase()) || [])
      .sort((left, right) => left.sequence - right.sequence);
    if (events.length < 1 || events.length > 2) {
      fail('SCHEMA_INVALID_EVIDENCE_REVIEW_CHAIN', 'EvidenceRevision must have one or two review events', '$.evidenceReviewEvents', { evidenceRevisionId: revision.id });
    }
    const first = events[0];
    const expectedFirstStatus = revision.createdBy === 'ai' ? 'proposed' : 'confirmed';
    const expectedFirstActor = revision.createdBy;
    if (first.sequence !== 1 || first.previousReviewEventId !== null || first.actor !== expectedFirstActor || first.status !== expectedFirstStatus) {
      fail('SCHEMA_INVALID_EVIDENCE_REVIEW_CHAIN', 'EvidenceRevision first review event is invalid', '$.evidenceReviewEvents', { evidenceRevisionId: revision.id });
    }
    if (revision.createdBy === 'ai') {
      const audit = first.sourceAuditResultEventId && auditEventsById.get(first.sourceAuditResultEventId.toLowerCase());
      if (!audit || audit.eventType !== 'ai-result' || String(audit.projectId).toLowerCase() !== manifest.projectId.toLowerCase()) {
        fail('SCHEMA_INVALID_EVIDENCE_AUDIT_SOURCE', 'AI evidence must reference a same-project ai-result event', '$.evidenceReviewEvents', { evidenceRevisionId: revision.id });
      }
    } else if (first.sourceAuditResultEventId !== undefined) {
      fail('SCHEMA_UNEXPECTED_EVIDENCE_AUDIT_SOURCE', 'User evidence cannot reference an AI result', '$.evidenceReviewEvents', { evidenceRevisionId: revision.id });
    }
    if (events.length === 2) {
      const second = events[1];
      if (revision.createdBy !== 'ai' || second.sequence !== 2 || second.actor !== 'user' ||
          !['confirmed', 'rejected'].includes(second.status) || second.previousReviewEventId !== first.id ||
          second.sourceAuditResultEventId !== undefined) {
        fail('SCHEMA_INVALID_EVIDENCE_REVIEW_CHAIN', 'EvidenceRevision terminal review event is invalid', '$.evidenceReviewEvents', { evidenceRevisionId: revision.id });
      }
    }
    derivedReviewStatus.set(revision.id.toLowerCase(), events.at(-1).status);
  }
  for (const link of value.citationLinks.filter(item => Array.isArray(item.items))) {
    for (const entry of link.items) {
      entry.evidenceRevisionIds.forEach((revisionId, index) => {
        const revision = evidenceRevisionsById.get(revisionId.toLowerCase());
        if (!revision) {
          if (!['evidence-missing', 'source-mismatch'].includes(entry.status)) {
            fail('SCHEMA_DANGLING_EVIDENCE_REVISION', 'CitationLink references missing evidence without a degraded status', '$.citationLinks', { citationLinkId: link.id, evidenceRevisionId: revisionId });
          }
          return;
        }
        const snapshot = entry.sourceCitationSnapshots[index];
        if (snapshot.citationItemId.toLowerCase() !== revision.citationItemId.toLowerCase() ||
            snapshot.rawQuoteSha256 !== revision.locator.rawQuoteSha256) {
          fail('SCHEMA_EVIDENCE_SNAPSHOT_MISMATCH', 'Citation source snapshot does not match its EvidenceRevision', '$.citationLinks', { citationLinkId: link.id, evidenceRevisionId: revisionId });
        }
        if (link.insertionMode === 'quote' && derivedReviewStatus.get(revisionId.toLowerCase()) !== 'confirmed') {
          fail('SCHEMA_UNCONFIRMED_DIRECT_QUOTE', 'Direct quotations require confirmed evidence', '$.citationLinks', { citationLinkId: link.id, evidenceRevisionId: revisionId });
        }
      });
      if (link.insertionMode === 'quote' && (!entry.evidenceRevisionIds.length || !entry.locator || !entry.label)) {
        fail('SCHEMA_DIRECT_QUOTE_SOURCE_REQUIRED', 'Direct quotations require evidence and a locator', '$.citationLinks', { citationLinkId: link.id });
      }
    }
  }
  for (const matrix of value.reviewMatrices) {
    for (const row of matrix.rows) {
      if (!citationItemIds.has(row.citationItemId.toLowerCase())) {
        fail('SCHEMA_DANGLING_MATRIX_CITATION_ITEM', 'Review matrix row references a missing CitationItem', '$.reviewMatrices', {
          matrixId: matrix.id,
          rowId: row.id,
          citationItemId: row.citationItemId
        });
      }
      for (const cell of Object.values(row.cells)) {
        if (cell.origin === 'ai') {
          const result = auditEventsById.get(cell.auditResultEventId.toLowerCase());
          const request = result?.requestEventId && auditEventsById.get(result.requestEventId.toLowerCase());
          if (!result || result.eventType !== 'ai-result' || !request || request.eventType !== 'ai-request' ||
              request.networkContext?.operation !== 'matrix-extraction' ||
              String(result.projectId).toLowerCase() !== manifest.projectId.toLowerCase() ||
              String(request.projectId).toLowerCase() !== manifest.projectId.toLowerCase() ||
              String(result.requestEventId).toLowerCase() !== String(request.eventId || request.id).toLowerCase()) {
            fail('SCHEMA_MATRIX_AUDIT_CHAIN_INVALID', 'AI matrix cell must reference a matrix-extraction audit result', '$.reviewMatrices', {
              matrixId: matrix.id,
              rowId: row.id,
              cellId: cell.id
            });
          }
        }
        for (const sourceRef of cell.sourceRefs) {
          const revision = evidenceRevisionsById.get(sourceRef.evidenceRevisionId.toLowerCase());
          const card = evidenceCardsById.get(sourceRef.evidenceId.toLowerCase());
          const firstReview = (evidenceReviewByRevision.get(sourceRef.evidenceRevisionId.toLowerCase()) || [])
            .find(event => event.sequence === 1);
          if (!revision || !card || revision.evidenceId.toLowerCase() !== sourceRef.evidenceId.toLowerCase() ||
              revision.citationItemId.toLowerCase() !== row.citationItemId.toLowerCase() ||
              sourceRef.citationItemId.toLowerCase() !== row.citationItemId.toLowerCase() ||
              revision.locator.rawQuoteSha256 !== sourceRef.rawQuoteSha256 ||
              revision.locator.pageLabel !== sourceRef.pageLabel || revision.locator.quoteDisplay !== sourceRef.quote ||
              !firstReview || String(firstReview.sourceAuditResultEventId).toLowerCase() !== cell.auditResultEventId.toLowerCase()) {
            fail('SCHEMA_MATRIX_EVIDENCE_CHAIN_INVALID', 'Matrix source reference does not match its immutable evidence revision', '$.reviewMatrices', {
              matrixId: matrix.id,
              rowId: row.id,
              cellId: cell.id,
              evidenceRevisionId: sourceRef.evidenceRevisionId
            });
          }
        }
      }
    }
  }
  validateAiCollections(value);
  return value;
}

function validateWorkspaceItemMap(value, path, idKeys, options) {
  assertPlainObject(value, path);
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    assertStableUuid(key, itemPath);
    assertPlainObject(item, itemPath);
    const identityValues = idKeys
      .map(idKey => item[idKey])
      .filter(candidate => typeof candidate === 'string' && candidate.length > 0);
    if (new Set(identityValues.map(id => id.toLowerCase())).size > 1) {
      fail('SCHEMA_AMBIGUOUS_ID', `Conflicting identity fields at ${itemPath}`, itemPath, {
        ids: identityValues
      });
    }
    const actualId = identityValues[0];
    assertStableUuid(actualId, `${itemPath}.id`);
    if (actualId.toLowerCase() !== key.toLowerCase()) {
      fail('SCHEMA_MAP_KEY_ID_MISMATCH', `Map key does not match item ID at ${itemPath}`, itemPath, {
        mapKey: key,
        itemId: actualId
      });
    }
    if (hasOwn(item, 'schemaVersion')) {
      assertSchemaVersion(item.schemaVersion, `${itemPath}.schemaVersion`, path);
    } else if (options.requireNestedSchemaVersions === true) {
      fail('SCHEMA_REQUIRED_FIELD_MISSING', `schemaVersion is missing at ${itemPath}`, `${itemPath}.schemaVersion`);
    }
  }
}

function validateWorkspace(value, options = {}) {
  assertPlainObject(value, '$');
  assertExactFields(value, [
    'schemaVersion',
    'workspaceManifest',
    'projectsById',
    'libraryItemsById',
    'collections',
    'assetStore',
    'exportableSettings'
  ], [], '$', options);
  assertSchemaVersion(value.schemaVersion, '$.schemaVersion', 'Workspace');

  const manifest = value.workspaceManifest;
  assertPlainObject(manifest, '$.workspaceManifest');
  assertExactFields(manifest, [
    'schemaVersion',
    'workspaceId',
    'appVersion',
    'createdAt',
    'updatedAt'
  ], [], '$.workspaceManifest', options);
  assertSchemaVersion(manifest.schemaVersion, '$.workspaceManifest.schemaVersion', 'WorkspaceManifest');
  assertStableUuid(manifest.workspaceId, '$.workspaceManifest.workspaceId');
  assertString(manifest.appVersion, '$.workspaceManifest.appVersion', { nonEmpty: true });
  assertUtcTimestamp(manifest.createdAt, '$.workspaceManifest.createdAt');
  assertUtcTimestamp(manifest.updatedAt, '$.workspaceManifest.updatedAt');
  assertTimestampOrder(manifest.createdAt, manifest.updatedAt, '$.workspaceManifest');

  assertPlainObject(value.projectsById, '$.projectsById');
  for (const [projectId, project] of Object.entries(value.projectsById)) {
    assertStableUuid(projectId, `$.projectsById.${projectId}`);
    validateProjectAggregate(project, options);
    if (project.manifest.projectId.toLowerCase() !== projectId.toLowerCase()) {
      fail('SCHEMA_MAP_KEY_ID_MISMATCH', `Project map key does not match manifest ID: ${projectId}`, `$.projectsById.${projectId}`, {
        mapKey: projectId,
        projectId: project.manifest.projectId
      });
    }
  }
  validateWorkspaceItemMap(value.libraryItemsById, '$.libraryItemsById', ['id', 'libraryItemId'], options);

  if (!Array.isArray(value.collections)) {
    fail('SCHEMA_EXPECTED_ARRAY', 'Expected an array at $.collections', '$.collections');
  }
  const collectionIds = new Set();
  value.collections.forEach((collection, index) => {
    const itemPath = `$.collections[${index}]`;
    assertPlainObject(collection, itemPath);
    const identityValues = [collection.id, collection.collectionId]
      .filter(candidate => typeof candidate === 'string' && candidate.length > 0);
    if (new Set(identityValues.map(id => id.toLowerCase())).size > 1) {
      fail('SCHEMA_AMBIGUOUS_ID', `Conflicting identity fields at ${itemPath}`, itemPath, {
        ids: identityValues
      });
    }
    const id = identityValues[0];
    assertStableUuid(id, `${itemPath}.id`);
    if (collectionIds.has(id.toLowerCase())) {
      fail('SCHEMA_DUPLICATE_ID', `Duplicate collection ID at ${itemPath}`, itemPath, { id });
    }
    collectionIds.add(id.toLowerCase());
    if (hasOwn(collection, 'schemaVersion')) {
      assertSchemaVersion(collection.schemaVersion, `${itemPath}.schemaVersion`, 'Collection');
    }
  });

  assertPlainObject(value.assetStore, '$.assetStore');
  assertExactFields(value.assetStore, ['schemaVersion', 'assetsById'], [], '$.assetStore', options);
  assertSchemaVersion(value.assetStore.schemaVersion, '$.assetStore.schemaVersion', 'AssetStore');
  validateWorkspaceItemMap(value.assetStore.assetsById, '$.assetStore.assetsById', ['id', 'assetId'], options);
  assertPlainObject(value.exportableSettings, '$.exportableSettings');
  return value;
}

function createEmptyProjectAggregate(input = {}) {
  const createdAt = input.createdAt;
  const aggregate = {
    schemaVersion: SCHEMA_VERSION,
    manifest: {
      projectId: input.projectId,
      title: input.title ?? '',
      author: input.author ?? '',
      course: input.course ?? '',
      degree: input.degree ?? '',
      wordLimit: input.wordLimit ?? null,
      referenceStyle: input.referenceStyle ?? 'MLA',
      privacyMode: input.privacyMode ?? 'normal',
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
      revision: input.revision ?? 0
    },
    document: {
      canonicalFormat: 'html',
      html: input.html ?? ''
    }
  };
  if (hasOwn(input, 'derivedDelta')) aggregate.document.derivedDelta = input.derivedDelta;
  for (const field of PROJECT_COLLECTION_FIELDS) aggregate[field] = [];
  return normalizeProjectAggregate(aggregate);
}

function createEmptyWorkspace(input = {}) {
  const createdAt = input.createdAt;
  const workspace = {
    schemaVersion: SCHEMA_VERSION,
    workspaceManifest: {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      appVersion: input.appVersion,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt
    },
    projectsById: {},
    libraryItemsById: {},
    collections: [],
    assetStore: {
      schemaVersion: SCHEMA_VERSION,
      assetsById: {}
    },
    exportableSettings: {}
  };
  return normalizeWorkspace(workspace);
}

function normalizeProjectAggregate(value, options = {}) {
  const normalized = canonicalize(value, options);
  validateProjectAggregate(normalized, options);
  return normalized;
}

function normalizeWorkspace(value, options = {}) {
  const normalized = canonicalize(value, options);
  validateWorkspace(normalized, options);
  return normalized;
}

module.exports = {
  COLLECTION_ID_KEYS,
  FUTURE_COLLECTION_FIELDS,
  PROJECT_COLLECTION_FIELDS,
  SCHEMA_VERSION,
  SHA256_PATTERN,
  SchemaValidationError,
  UUID_PATTERN,
  assertStableUuid,
  assertUtcTimestamp,
  createEmptyProjectAggregate,
  createEmptyWorkspace,
  isPlainObject,
  isStableUuid,
  isUtcTimestamp,
  normalizeProjectAggregate,
  normalizeWorkspace,
  validateProjectAggregate,
  validateWorkspace
};
