'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  cloneCanonical,
  semanticHash
} = require('./canonical');
const {
  SCHEMA_VERSION,
  createEmptyProjectAggregate,
  isStableUuid,
  normalizeProjectAggregate,
  validateProjectAggregate
} = require('./schema');
const {
  durableWriteJson,
  fsyncDirectory,
  resolveContainedPath
} = require('./durable-fs');
const { collectAssetIds } = require('./asset-store');

const REPOSITORY_SCHEMA_VERSION = 1;
const COMMIT_KIND = 'essayflow-project-commit';
const HEAD_KIND = 'essayflow-project-head';
const JOURNAL_KIND = 'essayflow-project-journal';
const VERSION_KIND = 'essayflow-project-version';
const INDEX_KIND = 'essayflow-project-index';

const JOURNAL_STATES = Object.freeze({
  PREPARING: 'PREPARING',
  STAGED: 'STAGED',
  COMMIT_READY: 'COMMIT_READY',
  HEAD_COMMITTED: 'HEAD_COMMITTED',
  COMPLETE: 'COMPLETE'
});

const HEAD_STATES = Object.freeze({
  ACTIVE: 'active',
  TRASHED: 'trashed'
});

const FAULT_HOOKS = Object.freeze([
  'temp-write',
  'journal',
  'document',
  'citations',
  'manifest',
  'atomic-replace'
]);

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'ERR_REPOSITORY_INVALID_ARGUMENT',
  INVALID_AGGREGATE: 'ERR_REPOSITORY_INVALID_AGGREGATE',
  PROJECT_EXISTS: 'ERR_REPOSITORY_PROJECT_EXISTS',
  PROJECT_NOT_FOUND: 'ERR_REPOSITORY_PROJECT_NOT_FOUND',
  PROJECT_TRASHED: 'ERR_REPOSITORY_PROJECT_TRASHED',
  PROJECT_NOT_TRASHED: 'ERR_REPOSITORY_PROJECT_NOT_TRASHED',
  REVISION_CONFLICT: 'ERR_REPOSITORY_REVISION_CONFLICT',
  VERSION_NOT_FOUND: 'ERR_REPOSITORY_VERSION_NOT_FOUND',
  CONFIRMATION_REQUIRED: 'ERR_REPOSITORY_CONFIRMATION_REQUIRED',
  CORRUPT_DATA: 'ERR_REPOSITORY_CORRUPT_DATA',
  FUTURE_SCHEMA: 'ERR_REPOSITORY_FUTURE_SCHEMA',
  IO: 'ERR_REPOSITORY_IO',
  FAULT_INJECTED: 'ERR_REPOSITORY_FAULT_INJECTED'
});

const DEFAULT_RETENTION_POLICY = Object.freeze({
  recentAutomatic: 20,
  dailyDays: 30
});

class RepositoryError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RepositoryError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function asRepositoryError(error, context = {}) {
  if (error instanceof RepositoryError) return error;
  if (error?.code === 'SCHEMA_FUTURE_VERSION_READ_ONLY') {
    return new RepositoryError(ERROR_CODES.FUTURE_SCHEMA, error.message, {
      ...context,
      schemaCode: error.code,
      readOnly: true
    }, error);
  }
  if (typeof error?.code === 'string' && error.code.startsWith('SCHEMA_')) {
    return new RepositoryError(ERROR_CODES.INVALID_AGGREGATE, error.message, {
      ...context,
      schemaCode: error.code,
      path: error.path
    }, error);
  }
  if (error?.injected === true || error?.code === 'INJECTED_FAULT') {
    return new RepositoryError(ERROR_CODES.FAULT_INJECTED, error.message, context, error);
  }
  return new RepositoryError(ERROR_CODES.IO, error?.message || 'Repository I/O failed', {
    ...context,
    osCode: error?.code || null
  }, error);
}

function assertProjectId(projectId) {
  if (!isStableUuid(projectId)) {
    throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, 'projectId must be a stable UUID', {
      field: 'projectId'
    });
  }
  return projectId.toLowerCase();
}

function assertUuid(value, field) {
  if (!isStableUuid(value)) {
    throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be a stable UUID`, { field });
  }
  return value.toLowerCase();
}

function assertBaseRevision(baseRevision) {
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, 'baseRevision must be a non-negative integer', {
      field: 'baseRevision'
    });
  }
  return baseRevision;
}

function assertPlainOptions(value, name = 'options') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, `${name} must be an object`, { field: name });
  }
  return value;
}

function toTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, 'Repository clock returned an invalid date');
  }
  return date.toISOString();
}

function latestTimestamp(...timestamps) {
  const epoch = Math.max(...timestamps.map(value => Date.parse(value)).filter(Number.isFinite));
  return new Date(epoch).toISOString();
}

function relative(...segments) {
  return segments.join('/');
}

function headRelativePath(projectId) {
  return relative('projects', projectId, 'HEAD.json');
}

function commitRelativePath(projectId, revision, commitId) {
  const prefix = String(revision).padStart(12, '0');
  return relative('projects', projectId, 'commits', `${prefix}-${commitId}.json`);
}

function versionRelativePath(projectId, versionId) {
  return relative('projects', projectId, 'versions', `${versionId}.json`);
}

function journalRelativePath(projectId, journalId) {
  return relative('journal', `${projectId}-${journalId}.json`);
}

function parseJson(bytes, details) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Repository JSON is corrupt', details, error);
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(html) {
  const text = stripHtml(html);
  if (!text) return 0;
  return [...text.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)].length;
}

function versionProjection(aggregate) {
  const projection = cloneCanonical(aggregate);
  delete projection.versions;
  delete projection.auditEvents;
  delete projection.auditContentBlobs;
  return projection;
}

function versionContentHash(projection) {
  return semanticHash(projection, {
    excludedPaths: ['$.manifest.revision', '$.manifest.updatedAt']
  });
}

function summarizeAggregate(aggregate) {
  const projection = versionProjection(aggregate);
  const snapshotHash = versionContentHash(projection);
  return {
    snapshotHash,
    documentHash: semanticHash(projection.document),
    title: projection.manifest.title,
    wordCount: wordCount(projection.document.html),
    citationItemCount: projection.citationItems.length,
    citationLinkCount: projection.citationLinks.length,
    evidenceCardCount: projection.evidenceCards.length,
    evidenceRevisionCount: projection.evidenceRevisions.length,
    reviewMatrixCount: projection.reviewMatrices.length,
    assetCount: collectAssetIds(projection).size
  };
}

function versionDifference(current, target) {
  return {
    titleChanged: current.title !== target.title,
    wordCountDelta: target.wordCount - current.wordCount,
    citationItemDelta: target.citationItemCount - current.citationItemCount,
    citationLinkDelta: target.citationLinkCount - current.citationLinkCount,
    evidenceCardDelta: target.evidenceCardCount - current.evidenceCardCount,
    reviewMatrixDelta: target.reviewMatrixCount - current.reviewMatrixCount,
    documentChanged: current.documentHash !== target.documentHash,
    semanticChanged: current.snapshotHash !== target.snapshotHash
  };
}

function clone(value) {
  return cloneCanonical(value);
}

function versionSortDescending(left, right) {
  const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return time || left.id.localeCompare(right.id, 'en');
}

function normalizeRetentionPolicy(policy = {}) {
  const recentAutomatic = policy.recentAutomatic ?? DEFAULT_RETENTION_POLICY.recentAutomatic;
  const dailyDays = policy.dailyDays ?? DEFAULT_RETENTION_POLICY.dailyDays;
  if (!Number.isInteger(recentAutomatic) || recentAutomatic < 0 || !Number.isInteger(dailyDays) || dailyDays < 0) {
    throw new RepositoryError(
      ERROR_CODES.INVALID_ARGUMENT,
      'Retention counts must be non-negative integers',
      { recentAutomatic, dailyDays }
    );
  }
  return { recentAutomatic, dailyDays };
}

function selectRetainedVersions(versions, policy, nowTimestamp) {
  const retained = new Set();
  const sorted = [...versions].sort(versionSortDescending);
  for (const version of sorted) {
    if (version.manual) retained.add(version.id);
  }
  const automatic = sorted.filter(version => !version.manual);
  automatic.slice(0, policy.recentAutomatic).forEach(version => retained.add(version.id));

  const cutoff = Date.parse(nowTimestamp) - (policy.dailyDays * 24 * 60 * 60 * 1000);
  const daily = new Set();
  for (const version of automatic) {
    const created = Date.parse(version.createdAt);
    if (created < cutoff) continue;
    const day = version.createdAt.slice(0, 10);
    if (!daily.has(day)) {
      daily.add(day);
      retained.add(version.id);
    }
  }
  return retained;
}

function aggregateCounts(aggregate) {
  return {
    citationItems: aggregate.citationItems.length,
    citationLinks: aggregate.citationLinks.length,
    evidenceCards: aggregate.evidenceCards.length,
    evidenceRevisions: aggregate.evidenceRevisions.length,
    evidenceReviewEvents: aggregate.evidenceReviewEvents.length,
    auditEvents: aggregate.auditEvents.length,
    auditContentBlobs: aggregate.auditContentBlobs.length,
    versions: aggregate.versions.length,
    assets: collectAssetIds(aggregate).size
  };
}

class ProjectRepository {
  constructor(options) {
    assertPlainOptions(options);
    if (typeof options.rootPath !== 'string' || options.rootPath.trim() === '') {
      throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, 'rootPath is required', { field: 'rootPath' });
    }
    this.rootPath = path.resolve(options.rootPath);
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
    this.faultInjector = options.faultInjector || null;
    this.writeJson = options.durableWriteJson || durableWriteJson;
    this.assetStore = options.assetStore || null;
    this.backupRoots = (options.backupRoots || [path.join(this.rootPath, 'backups')]).map(value => path.resolve(value));
    this.sessionId = assertUuid(options.sessionId || this.randomUUID(), 'sessionId');
    this.projectQueues = new Map();
    this.indexTail = Promise.resolve();
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = this._initialize().catch(error => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async _initialize() {
    await fs.promises.mkdir(this.rootPath, { recursive: true });
    for (const directory of ['projects', 'journal', 'purge']) {
      await fs.promises.mkdir(resolveContainedPath(this.rootPath, directory), { recursive: true });
    }
    await this._recoverJournals();
    await this._refreshIndexBestEffort();
    return this;
  }

  _serialize(projectId, operation) {
    const previous = this.projectQueues.get(projectId) || Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.projectQueues.set(projectId, tail);
    tail.finally(() => {
      if (this.projectQueues.get(projectId) === tail) this.projectQueues.delete(projectId);
    });
    return current;
  }

  async _inject(stage, context) {
    if (!FAULT_HOOKS.includes(stage) || typeof this.faultInjector !== 'function') return;
    const result = await this.faultInjector(stage, Object.freeze({ ...context, stage }));
    if (result === true || typeof result === 'string') {
      const error = new Error(`Injected repository fault at ${stage}`);
      error.code = typeof result === 'string' ? result : 'INJECTED_FAULT';
      error.injected = true;
      throw error;
    }
  }

  async _write(relativePath, value, label) {
    return this.writeJson(this.rootPath, relativePath, value, { label });
  }

  async _readJson(relativePath, options = {}) {
    const target = resolveContainedPath(this.rootPath, relativePath);
    let bytes;
    try {
      bytes = await fs.promises.readFile(target, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' && options.optional) return null;
      throw asRepositoryError(error, { relativePath });
    }
    return parseJson(bytes, { relativePath });
  }

  async _writeJournal(journal, state, extra = {}) {
    const next = {
      ...journal,
      ...extra,
      state,
      updatedAt: toTimestamp(this.now)
    };
    await this._write(journal.relativePath, next, 'journal');
    return next;
  }

  async _readHead(projectId, options = {}) {
    const head = await this._readJson(headRelativePath(projectId), { optional: options.optional === true });
    if (!head) return null;
    this._validateHead(head, projectId);
    return head;
  }

  _validateHead(head, projectId) {
    if (
      !head ||
      head.schemaVersion !== REPOSITORY_SCHEMA_VERSION ||
      head.kind !== HEAD_KIND ||
      head.projectId !== projectId ||
      !Number.isInteger(head.revision) ||
      head.revision < 0 ||
      !/^[0-9a-f]{64}$/.test(head.commitId || '') ||
      !/^[0-9a-f]{64}$/.test(head.envelopeHash || '') ||
      !Object.values(HEAD_STATES).includes(head.state)
    ) {
      throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Project HEAD is invalid', { projectId });
    }
  }

  async _readCommit(head) {
    const relativePath = commitRelativePath(head.projectId, head.revision, head.commitId);
    const envelope = await this._readJson(relativePath);
    if (
      !envelope ||
      envelope.schemaVersion !== REPOSITORY_SCHEMA_VERSION ||
      envelope.kind !== COMMIT_KIND ||
      envelope.projectId !== head.projectId ||
      envelope.revision !== head.revision ||
      envelope.commitId !== head.commitId ||
      semanticHash(envelope) !== head.envelopeHash
    ) {
      throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Project commit envelope checksum failed', {
        projectId: head.projectId,
        revision: head.revision,
        relativePath
      });
    }
    let aggregate;
    try {
      aggregate = normalizeProjectAggregate(envelope.aggregate);
    } catch (error) {
      throw asRepositoryError(error, { projectId: head.projectId, revision: head.revision });
    }
    if (
      aggregate.manifest.projectId !== head.projectId ||
      aggregate.manifest.revision !== head.revision ||
      semanticHash(aggregate) !== envelope.aggregateHash
    ) {
      throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Project aggregate checksum failed', {
        projectId: head.projectId,
        revision: head.revision
      });
    }
    return { envelope, aggregate };
  }

  async _record(projectId, options = {}) {
    const head = await this._readHead(projectId, { optional: true });
    if (!head) {
      throw new RepositoryError(ERROR_CODES.PROJECT_NOT_FOUND, 'Project does not exist', { projectId });
    }
    if (head.state === HEAD_STATES.TRASHED && options.includeTrashed !== true) {
      throw new RepositoryError(ERROR_CODES.PROJECT_TRASHED, 'Project is in the trash', { projectId });
    }
    const commit = await this._readCommit(head);
    return { head, ...commit };
  }

  _assertRevision(head, baseRevision) {
    if (head.revision !== baseRevision) {
      throw new RepositoryError(ERROR_CODES.REVISION_CONFLICT, 'Project revision is stale', {
        projectId: head.projectId,
        expectedRevision: head.revision,
        baseRevision
      });
    }
  }

  _normalizeForCommit(aggregate, projectId, revision, timestamp) {
    let normalized;
    try {
      normalized = normalizeProjectAggregate(aggregate);
      if (normalized.manifest.projectId.toLowerCase() !== projectId) {
        throw new RepositoryError(ERROR_CODES.INVALID_AGGREGATE, 'Aggregate projectId does not match target project', {
          projectId,
          aggregateProjectId: normalized.manifest.projectId
        });
      }
      normalized.manifest.projectId = projectId;
      normalized.manifest.revision = revision;
      normalized.manifest.updatedAt = latestTimestamp(
        normalized.manifest.createdAt,
        normalized.manifest.updatedAt,
        timestamp
      );
      validateProjectAggregate(normalized);
      return normalizeProjectAggregate(normalized);
    } catch (error) {
      throw asRepositoryError(error, { projectId });
    }
  }

  async _writeImmutable(relativePath, value, label) {
    const existing = await this._readJson(relativePath, { optional: true });
    if (existing) {
      if (semanticHash(existing) !== semanticHash(value)) {
        throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Immutable repository object already differs', {
          relativePath
        });
      }
      return;
    }
    await this._write(relativePath, value, label);
  }

  async _commit(options) {
    const projectId = options.projectId;
    const previousHead = options.previousHead || null;
    const revision = previousHead ? previousHead.revision + 1 : 0;
    const committedAt = toTimestamp(this.now);
    const aggregate = this._normalizeForCommit(options.aggregate, projectId, revision, committedAt);
    const aggregateHash = semanticHash(aggregate);
    const commitId = semanticHash({
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      projectId,
      revision,
      parentCommitId: previousHead?.commitId || null,
      aggregateHash,
      operation: options.operation
    });
    const envelope = {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      kind: COMMIT_KIND,
      projectId,
      revision,
      commitId,
      parentCommitId: previousHead?.commitId || null,
      aggregateHash,
      operation: options.operation,
      committedAt,
      aggregate
    };
    const targetHead = {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      kind: HEAD_KIND,
      projectId,
      revision,
      commitId,
      envelopeHash: semanticHash(envelope),
      state: options.state || HEAD_STATES.ACTIVE,
      updatedAt: committedAt
    };
    const journalId = assertUuid(this.randomUUID(), 'journalId');
    const stagedPaths = [commitRelativePath(projectId, revision, commitId), ...(options.ancillaryFiles || []).map(file => file.relativePath)];
    let journal = {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      kind: JOURNAL_KIND,
      journalId,
      projectId,
      operation: options.operation,
      state: JOURNAL_STATES.PREPARING,
      previousHead: previousHead ? clone(previousHead) : null,
      targetHead,
      stagedPaths,
      createdAt: committedAt,
      updatedAt: committedAt,
      relativePath: journalRelativePath(projectId, journalId)
    };
    const hookContext = {
      projectId,
      journalId,
      operation: options.operation,
      baseRevision: previousHead?.revision ?? null,
      newRevision: revision,
      aggregateHash
    };
    let headCommitted = false;
    try {
      await this._inject('journal', hookContext);
      journal = await this._writeJournal(journal, JOURNAL_STATES.PREPARING);

      await this._inject('document', hookContext);
      await this._inject('citations', hookContext);
      await this._inject('manifest', hookContext);
      await this._inject('temp-write', hookContext);
      for (const file of options.ancillaryFiles || []) {
        await this._writeImmutable(file.relativePath, file.value, file.label || 'version');
      }
      await this._writeImmutable(commitRelativePath(projectId, revision, commitId), envelope, 'project-commit');
      journal = await this._writeJournal(journal, JOURNAL_STATES.STAGED);
      journal = await this._writeJournal(journal, JOURNAL_STATES.COMMIT_READY);

      await this._inject('atomic-replace', hookContext);
      await this._write(headRelativePath(projectId), targetHead, 'project-head');
      headCommitted = true;
      journal = await this._writeJournal(journal, JOURNAL_STATES.HEAD_COMMITTED);
      journal = await this._writeJournal(journal, JOURNAL_STATES.COMPLETE, {
        outcome: 'committed',
        completedAt: toTimestamp(this.now)
      });
    } catch (error) {
      throw asRepositoryError(error, { ...hookContext, headCommitted });
    }

    await this._refreshIndexBestEffort();
    return Object.freeze({
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      durable: true,
      journalState: journal.state,
      projectId,
      revision,
      commitId,
      aggregateHash,
      committedAt,
      state: targetHead.state,
      aggregate: clone(aggregate)
    });
  }

  async createProject(input = {}) {
    await this.initialize();
    assertPlainOptions(input, 'input');
    const projectId = assertProjectId(input.projectId || input.aggregate?.manifest?.projectId || this.randomUUID());
    return this._serialize(projectId, async () => {
      if (await this._readHead(projectId, { optional: true })) {
        throw new RepositoryError(ERROR_CODES.PROJECT_EXISTS, 'Project already exists', { projectId });
      }
      const timestamp = toTimestamp(this.now);
      let aggregate;
      try {
        aggregate = input.aggregate
          ? normalizeProjectAggregate(input.aggregate)
          : createEmptyProjectAggregate({
            ...input,
            projectId,
            createdAt: input.createdAt || timestamp,
            updatedAt: input.updatedAt || input.createdAt || timestamp,
            revision: 0
          });
      } catch (error) {
        throw asRepositoryError(error, { projectId });
      }
      if (aggregate.manifest.projectId.toLowerCase() !== projectId) {
        throw new RepositoryError(ERROR_CODES.INVALID_AGGREGATE, 'Aggregate projectId does not match create request', {
          projectId,
          aggregateProjectId: aggregate.manifest.projectId
        });
      }
      aggregate.manifest.projectId = projectId;
      aggregate.manifest.revision = 0;
      return this._commit({
        projectId,
        previousHead: null,
        aggregate,
        operation: 'create-project',
        state: HEAD_STATES.ACTIVE
      });
    });
  }

  async loadProject(projectId, options = {}) {
    await this.initialize();
    const normalizedId = assertProjectId(projectId);
    const record = await this._record(normalizedId, options);
    return clone(record.aggregate);
  }

  async saveProject(first, second, third = {}) {
    await this.initialize();
    const options = typeof first === 'string'
      ? { ...third, projectId: first, aggregate: second }
      : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    const baseRevision = assertBaseRevision(options.baseRevision);
    if (!options.aggregate) {
      throw new RepositoryError(ERROR_CODES.INVALID_ARGUMENT, 'aggregate is required', { field: 'aggregate' });
    }
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId);
      this._assertRevision(record.head, baseRevision);
      return this._commit({
        projectId,
        previousHead: record.head,
        aggregate: options.aggregate,
        operation: options.source || 'user-save',
        state: HEAD_STATES.ACTIVE
      });
    });
  }

  async listProjects(options = {}) {
    await this.initialize();
    const includeTrashed = options.includeTrashed === true;
    const records = await this._scanRecords();
    return records
      .filter(record => includeTrashed || record.head.state === HEAD_STATES.ACTIVE)
      .map(record => this._projectSummary(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, 'en') || left.projectId.localeCompare(right.projectId, 'en'));
  }

  async listTrash() {
    await this.initialize();
    const records = await this._scanRecords();
    return records
      .filter(record => record.head.state === HEAD_STATES.TRASHED)
      .map(record => this._projectSummary(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, 'en'));
  }

  _projectSummary(record) {
    return {
      projectId: record.head.projectId,
      state: record.head.state,
      revision: record.head.revision,
      title: record.aggregate.manifest.title,
      author: record.aggregate.manifest.author,
      updatedAt: record.aggregate.manifest.updatedAt,
      wordCount: wordCount(record.aggregate.document.html),
      citationCount: record.aggregate.citationItems.length,
      versionCount: record.aggregate.versions.length,
      aggregateHash: record.envelope.aggregateHash
    };
  }

  async createCheckpoint(first, second = {}) {
    await this.initialize();
    const options = typeof first === 'string' ? { ...second, projectId: first } : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId);
      if (options.baseRevision !== undefined) this._assertRevision(record.head, assertBaseRevision(options.baseRevision));
      const projection = versionProjection(record.aggregate);
      const summary = summarizeAggregate(record.aggregate);
      const existing = record.aggregate.versions.find(version => version.snapshotHash === summary.snapshotHash);
      if (existing) {
        return Object.freeze({
          durable: true,
          created: false,
          projectId,
          revision: record.head.revision,
          version: clone(existing)
        });
      }
      const createdAt = toTimestamp(this.now);
      const versionId = assertUuid(this.randomUUID(), 'versionId');
      const version = {
        id: versionId,
        snapshotHash: summary.snapshotHash,
        createdAt,
        source: String(options.source || 'manual-checkpoint'),
        manual: options.manual !== undefined
          ? options.manual === true
          : ['manual', 'manual-checkpoint', 'user-checkpoint'].includes(options.source || 'manual-checkpoint'),
        summary: { ...summary, ...(options.summary || {}) }
      };
      const snapshot = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        kind: VERSION_KIND,
        projectId,
        versionId,
        snapshotHash: summary.snapshotHash,
        createdAt,
        aggregate: projection
      };
      const aggregate = clone(record.aggregate);
      aggregate.versions.push(version);
      const ack = await this._commit({
        projectId,
        previousHead: record.head,
        aggregate,
        operation: `checkpoint:${version.source}`,
        ancillaryFiles: [{
          relativePath: versionRelativePath(projectId, versionId),
          value: snapshot,
          label: 'version-snapshot'
        }]
      });
      return Object.freeze({ ...ack, created: true, version: clone(version) });
    });
  }

  async listVersions(projectId) {
    const aggregate = await this.loadProject(projectId);
    return clone([...aggregate.versions].sort(versionSortDescending));
  }

  async _readVersion(projectId, version) {
    const relativePath = versionRelativePath(projectId, version.id);
    const snapshot = await this._readJson(relativePath);
    if (
      !snapshot ||
      snapshot.schemaVersion !== REPOSITORY_SCHEMA_VERSION ||
      snapshot.kind !== VERSION_KIND ||
      snapshot.projectId !== projectId ||
      snapshot.versionId !== version.id ||
      snapshot.snapshotHash !== version.snapshotHash ||
      versionContentHash(snapshot.aggregate) !== version.snapshotHash
    ) {
      throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Version snapshot checksum failed', {
        projectId,
        versionId: version.id,
        relativePath
      });
    }
    return snapshot;
  }

  async previewVersion(first, second) {
    await this.initialize();
    const options = typeof first === 'string'
      ? { projectId: first, versionId: second }
      : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    const versionId = assertUuid(options.versionId, 'versionId');
    const record = await this._record(projectId);
    const version = record.aggregate.versions.find(item => item.id === versionId);
    if (!version) {
      throw new RepositoryError(ERROR_CODES.VERSION_NOT_FOUND, 'Version does not exist', { projectId, versionId });
    }
    const snapshot = await this._readVersion(projectId, version);
    const current = summarizeAggregate(record.aggregate);
    const target = summarizeAggregate({
      ...snapshot.aggregate,
      versions: [],
      auditEvents: [],
      auditContentBlobs: []
    });
    return {
      projectId,
      version: clone(version),
      current,
      target,
      changes: versionDifference(current, target)
    };
  }

  async restoreVersion(first, second = {}) {
    await this.initialize();
    const options = typeof first === 'string' ? { ...second, projectId: first } : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    const versionId = assertUuid(options.versionId, 'versionId');
    const baseRevision = options.baseRevision === undefined ? null : assertBaseRevision(options.baseRevision);
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId);
      if (baseRevision !== null) this._assertRevision(record.head, baseRevision);
      const targetVersion = record.aggregate.versions.find(item => item.id === versionId);
      if (!targetVersion) {
        throw new RepositoryError(ERROR_CODES.VERSION_NOT_FOUND, 'Version does not exist', { projectId, versionId });
      }
      const targetSnapshot = await this._readVersion(projectId, targetVersion);
      const beforeProjection = versionProjection(record.aggregate);
      const beforeSummary = summarizeAggregate(record.aggregate);
      let beforeVersion = record.aggregate.versions.find(version => version.snapshotHash === beforeSummary.snapshotHash) || null;
      const ancillaryFiles = [];
      const versions = clone(record.aggregate.versions);
      if (!beforeVersion) {
        const beforeVersionId = assertUuid(this.randomUUID(), 'versionId');
        const createdAt = toTimestamp(this.now);
        beforeVersion = {
          id: beforeVersionId,
          snapshotHash: beforeSummary.snapshotHash,
          createdAt,
          source: 'restore-before',
          manual: false,
          summary: beforeSummary
        };
        versions.push(beforeVersion);
        ancillaryFiles.push({
          relativePath: versionRelativePath(projectId, beforeVersionId),
          value: {
            schemaVersion: REPOSITORY_SCHEMA_VERSION,
            kind: VERSION_KIND,
            projectId,
            versionId: beforeVersionId,
            snapshotHash: beforeSummary.snapshotHash,
            createdAt,
            aggregate: beforeProjection
          },
          label: 'restore-before-snapshot'
        });
      }

      const aggregate = clone(targetSnapshot.aggregate);
      aggregate.versions = versions;
      aggregate.auditEvents = clone(record.aggregate.auditEvents);
      aggregate.auditContentBlobs = clone(record.aggregate.auditContentBlobs);
      const resultingRevision = record.head.revision + 1;
      const sequence = aggregate.auditEvents.reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0) + 1;
      aggregate.auditEvents.push({
        schemaVersion: SCHEMA_VERSION,
        eventId: assertUuid(this.randomUUID(), 'eventId'),
        projectId,
        sessionId: this.sessionId,
        sequence,
        eventType: 'restore',
        occurredAt: toTimestamp(this.now),
        restoredSnapshotId: versionId,
        resultingRevision
      });
      const ack = await this._commit({
        projectId,
        previousHead: record.head,
        aggregate,
        operation: 'restore-version',
        ancillaryFiles
      });
      return Object.freeze({
        ...ack,
        restoredVersionId: versionId,
        restoreBeforeVersionId: beforeVersion.id,
        restoreBeforeCreated: ancillaryFiles.length > 0
      });
    });
  }

  async garbageCollectVersions(first, second = {}) {
    await this.initialize();
    const options = typeof first === 'string' ? { ...second, projectId: first } : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    const policy = normalizeRetentionPolicy(options.policy);
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId);
      if (options.baseRevision !== undefined) this._assertRevision(record.head, assertBaseRevision(options.baseRevision));
      const nowTimestamp = options.now ? new Date(options.now).toISOString() : toTimestamp(this.now);
      const retainedIds = selectRetainedVersions(record.aggregate.versions, policy, nowTimestamp);
      const retained = record.aggregate.versions.filter(version => retainedIds.has(version.id));
      const removed = record.aggregate.versions.filter(version => !retainedIds.has(version.id));
      let ack = {
        durable: true,
        projectId,
        revision: record.head.revision,
        aggregate: clone(record.aggregate)
      };
      if (removed.length) {
        const aggregate = clone(record.aggregate);
        aggregate.versions = retained;
        ack = await this._commit({
          projectId,
          previousHead: record.head,
          aggregate,
          operation: 'version-retention-gc'
        });
        for (const version of removed) {
          const target = resolveContainedPath(this.rootPath, versionRelativePath(projectId, version.id));
          await fs.promises.rm(target, { force: true });
        }
      }
      const reachableAssetIds = await this.collectReachableAssetIds({
        protectedAssetIds: options.protectedAssetIds
      });
      const assetGc = this.assetStore
        ? await this.assetStore.garbageCollect(reachableAssetIds, { dryRun: options.dryRunAssets === true })
        : { deleted: [], retained: [...reachableAssetIds].sort(), dryRun: true };
      return Object.freeze({
        ...ack,
        policy,
        retainedVersionIds: retained.map(version => version.id),
        removedVersionIds: removed.map(version => version.id),
        reachableAssetIds: [...reachableAssetIds].sort(),
        assetGc
      });
    });
  }

  async getTrashImpact(projectId) {
    await this.initialize();
    const normalizedId = assertProjectId(projectId);
    const record = await this._record(normalizedId, { includeTrashed: true });
    const owned = await this._assetsForRecord(record);
    const otherReachable = await this.collectReachableAssetIds({ excludeProjectIds: [normalizedId] });
    const shared = [...owned].filter(assetId => otherReachable.has(assetId)).sort();
    const exclusive = [...owned].filter(assetId => !otherReachable.has(assetId)).sort();
    return {
      projectId: normalizedId,
      state: record.head.state,
      revision: record.head.revision,
      title: record.aggregate.manifest.title,
      counts: aggregateCounts(record.aggregate),
      sharedAssetIds: shared,
      exclusiveAssetIds: exclusive
    };
  }

  async moveToTrash(first, second = {}) {
    await this.initialize();
    const options = typeof first === 'string' ? { ...second, projectId: first } : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    const baseRevision = options.baseRevision === undefined ? null : assertBaseRevision(options.baseRevision);
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId, { includeTrashed: true });
      if (record.head.state === HEAD_STATES.TRASHED) {
        return Object.freeze({
          durable: true,
          projectId,
          revision: record.head.revision,
          state: HEAD_STATES.TRASHED,
          alreadyTrashed: true
        });
      }
      if (baseRevision !== null) this._assertRevision(record.head, baseRevision);
      const ack = await this._commit({
        projectId,
        previousHead: record.head,
        aggregate: record.aggregate,
        operation: 'move-to-trash',
        state: HEAD_STATES.TRASHED
      });
      return Object.freeze({ ...ack, alreadyTrashed: false });
    });
  }

  async restoreFromTrash(first, second = {}) {
    await this.initialize();
    const options = typeof first === 'string' ? { ...second, projectId: first } : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    const baseRevision = options.baseRevision === undefined ? null : assertBaseRevision(options.baseRevision);
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId, { includeTrashed: true });
      if (record.head.state !== HEAD_STATES.TRASHED) {
        throw new RepositoryError(ERROR_CODES.PROJECT_NOT_TRASHED, 'Project is not in the trash', { projectId });
      }
      if (baseRevision !== null) this._assertRevision(record.head, baseRevision);
      return this._commit({
        projectId,
        previousHead: record.head,
        aggregate: record.aggregate,
        operation: 'restore-from-trash',
        state: HEAD_STATES.ACTIVE
      });
    });
  }

  async permanentlyDelete(first, second = {}) {
    await this.initialize();
    const options = typeof first === 'string' ? { ...second, projectId: first } : assertPlainOptions(first);
    const projectId = assertProjectId(options.projectId);
    if (options.confirmed !== true) {
      throw new RepositoryError(ERROR_CODES.CONFIRMATION_REQUIRED, 'Permanent deletion requires explicit confirmation', {
        projectId
      });
    }
    return this._serialize(projectId, async () => {
      const record = await this._record(projectId, { includeTrashed: true });
      if (record.head.state !== HEAD_STATES.TRASHED) {
        throw new RepositoryError(ERROR_CODES.PROJECT_NOT_TRASHED, 'Only trashed projects can be permanently deleted', {
          projectId
        });
      }
      if (options.baseRevision !== undefined) {
        this._assertRevision(record.head, assertBaseRevision(options.baseRevision));
      }
      const owned = await this._assetsForRecord(record);
      const otherReachable = await this.collectReachableAssetIds({ excludeProjectIds: [projectId] });
      const sharedAssetIds = [...owned].filter(assetId => otherReachable.has(assetId)).sort();
      const eligibleAssetIds = [...owned].filter(assetId => !otherReachable.has(assetId)).sort();
      const projectDirectory = resolveContainedPath(this.rootPath, relative('projects', projectId));
      const purgeId = assertUuid(this.randomUUID(), 'purgeId');
      const purgeDirectory = resolveContainedPath(this.rootPath, relative('purge', `${projectId}-${purgeId}`));
      await fs.promises.rename(projectDirectory, purgeDirectory);
      await fsyncDirectory(resolveContainedPath(this.rootPath, 'projects'));
      await fs.promises.rm(purgeDirectory, { recursive: true, force: true });
      await fsyncDirectory(resolveContainedPath(this.rootPath, 'purge'));
      const reachableAssetIds = await this.collectReachableAssetIds({
        protectedAssetIds: options.protectedAssetIds
      });
      const assetGc = this.assetStore
        ? await this.assetStore.garbageCollect(reachableAssetIds, { dryRun: options.dryRunAssets === true })
        : { deleted: [], retained: [...reachableAssetIds].sort(), dryRun: true };
      await this._refreshIndexBestEffort();
      return Object.freeze({
        durable: true,
        projectId,
        deletedRevision: record.head.revision,
        sharedAssetIds,
        eligibleAssetIds,
        reachableAssetIds: [...reachableAssetIds].sort(),
        assetGc
      });
    });
  }

  async _assetsForRecord(record) {
    const result = collectAssetIds(record.aggregate);
    for (const version of record.aggregate.versions) {
      const snapshot = await this._readVersion(record.head.projectId, version);
      collectAssetIds(snapshot.aggregate, result);
    }
    return result;
  }

  async collectReachableAssetIds(options = {}) {
    await this.initialize();
    const excluded = new Set((options.excludeProjectIds || []).map(assertProjectId));
    const result = new Set(options.protectedAssetIds || []);
    const records = await this._scanRecords();
    for (const record of records) {
      if (excluded.has(record.head.projectId)) continue;
      const assets = await this._assetsForRecord(record);
      assets.forEach(assetId => result.add(assetId));
    }
    await this._collectJournalAssets(result, excluded);
    for (const backupRoot of this.backupRoots) await this._collectBackupAssets(backupRoot, result);
    return result;
  }

  async _collectJournalAssets(result, excluded) {
    const journalDirectory = resolveContainedPath(this.rootPath, 'journal');
    const entries = await fs.promises.readdir(journalDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const journal = await this._readJson(relative('journal', entry.name), { optional: true });
      if (!journal || journal.state === JOURNAL_STATES.COMPLETE || excluded.has(journal.projectId)) continue;
      const targetHead = journal.targetHead;
      if (!targetHead) continue;
      try {
        const commit = await this._readCommit(targetHead);
        collectAssetIds(commit.aggregate, result);
      } catch {
        // An incomplete staging record without a valid commit has no reachable assets.
      }
    }
  }

  async _collectBackupAssets(root, result) {
    let stat;
    try {
      stat = await fs.promises.lstat(root);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const visit = async (directory, depth) => {
      if (depth > 20) return;
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(target, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          const fileStat = await fs.promises.stat(target);
          if (fileStat.size > 10 * 1024 * 1024) continue;
          try {
            collectAssetIds(JSON.parse(await fs.promises.readFile(target, 'utf8')), result);
          } catch {
            // Backup verification reports corrupt JSON; reachability remains conservative elsewhere.
          }
        }
      }
    };
    await visit(root, 0);
  }

  async _scanRecords() {
    const projectsDirectory = resolveContainedPath(this.rootPath, 'projects');
    const entries = await fs.promises.readdir(projectsDirectory, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isStableUuid(entry.name)) continue;
      const projectId = entry.name.toLowerCase();
      const head = await this._readHead(projectId, { optional: true });
      if (!head) continue;
      const commit = await this._readCommit(head);
      records.push({ head, ...commit });
    }
    return records;
  }

  _refreshIndexBestEffort() {
    const work = this.indexTail.then(async () => {
      const records = await this._scanRecords();
      const index = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        kind: INDEX_KIND,
        projects: records.map(record => this._projectSummary(record))
          .sort((left, right) => left.projectId.localeCompare(right.projectId, 'en'))
      };
      await this._write('index.json', index, 'rebuildable-index');
    });
    this.indexTail = work.then(() => undefined, () => undefined);
    return work.catch(() => undefined);
  }

  async _recoverJournals() {
    const journalDirectory = resolveContainedPath(this.rootPath, 'journal');
    const entries = await fs.promises.readdir(journalDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const relativePath = relative('journal', entry.name);
      let journal = await this._readJson(relativePath);
      if (
        journal.schemaVersion !== REPOSITORY_SCHEMA_VERSION ||
        journal.kind !== JOURNAL_KIND ||
        !isStableUuid(journal.projectId) ||
        !Object.values(JOURNAL_STATES).includes(journal.state)
      ) {
        throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Repository journal is invalid', { relativePath });
      }
      if (journal.state === JOURNAL_STATES.COMPLETE) continue;
      const projectId = journal.projectId.toLowerCase();
      const currentHead = await this._readHead(projectId, { optional: true });
      const target = journal.targetHead;
      const currentIsTarget = currentHead && target && currentHead.commitId === target.commitId;
      if (currentIsTarget) {
        await this._readCommit(currentHead);
        journal = await this._writeJournal(journal, JOURNAL_STATES.HEAD_COMMITTED, {
          recovery: 'commit-observed'
        });
        await this._writeJournal(journal, JOURNAL_STATES.COMPLETE, {
          outcome: 'committed',
          recovery: 'commit-observed',
          completedAt: toTimestamp(this.now)
        });
        continue;
      }
      if (journal.state === JOURNAL_STATES.HEAD_COMMITTED) {
        if (currentHead && target && currentHead.revision > target.revision) {
          await this._writeJournal(journal, JOURNAL_STATES.COMPLETE, {
            outcome: 'superseded',
            recovery: 'newer-head-observed',
            completedAt: toTimestamp(this.now)
          });
          continue;
        }
        if (!target) {
          throw new RepositoryError(ERROR_CODES.CORRUPT_DATA, 'Committed journal is missing target HEAD', {
            relativePath
          });
        }
        await this._readCommit(target);
        await this._write(headRelativePath(projectId), target, 'recovered-project-head');
        journal = await this._writeJournal(journal, JOURNAL_STATES.HEAD_COMMITTED, {
          recovery: 'head-reinstalled'
        });
        await this._writeJournal(journal, JOURNAL_STATES.COMPLETE, {
          outcome: 'committed',
          recovery: 'head-reinstalled',
          completedAt: toTimestamp(this.now)
        });
        continue;
      }
      if (!currentHead && journal.previousHead) {
        await this._readCommit(journal.previousHead);
        await this._write(headRelativePath(projectId), journal.previousHead, 'recovered-previous-head');
      }
      await this._writeJournal(journal, JOURNAL_STATES.COMPLETE, {
        outcome: 'rolled-back',
        recovery: 'pre-commit-journal',
        completedAt: toTimestamp(this.now)
      });
    }
  }
}

module.exports = {
  COMMIT_KIND,
  DEFAULT_RETENTION_POLICY,
  ERROR_CODES,
  FAULT_HOOKS,
  HEAD_KIND,
  HEAD_STATES,
  JOURNAL_KIND,
  JOURNAL_STATES,
  ProjectRepository,
  REPOSITORY_SCHEMA_VERSION,
  RepositoryError,
  VERSION_KIND,
  aggregateCounts,
  selectRetainedVersions,
  summarizeAggregate,
  versionContentHash,
  versionDifference,
  versionProjection,
  wordCount
};
