'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ArchiveService } = require('./archive-service');
const { AssetStore } = require('./asset-store');
const {
  LibraryStore,
  libraryItemIdFromLegacySourceId
} = require('./library-store');
const {
  LegacyMigrator,
  WORKSPACE_MANIFEST_RELATIVE_PATH,
  stableUuid
} = require('./migrator');
const {
  ERROR_CODES: REPOSITORY_ERROR_CODES,
  ProjectRepository
} = require('./repository');
const { createEmptyProjectAggregate, isStableUuid, normalizeProjectAggregate } = require('./schema');
const { SecretStore, SettingsStore, splitLegacySettings } = require('./settings-store');
const { legacyPaperToCsl } = require('../citation/model');
const { CitationService } = require('../citation/citation-service');
const { EvidenceService } = require('../evidence/evidence-service');
const { TrustedAiService } = require('../ai/trusted-ai-service');
const { MatrixService } = require('../matrix/matrix-service');
const { secureTransport } = require('../ai/secure-transport');

const SERVICE_SCHEMA_VERSION = 1;
const MAX_HTML_BYTES = 50 * 1024 * 1024;
const MAX_CITATIONS = 10_000;
const MAX_LIBRARY_ITEMS = 100_000;

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'WORKSPACE_INVALID_ARGUMENT',
  NOT_BOOTSTRAPPED: 'WORKSPACE_NOT_BOOTSTRAPPED',
  PROJECT_NOT_FOUND: 'WORKSPACE_PROJECT_NOT_FOUND',
  REVISION_REQUIRED: 'WORKSPACE_BASE_REVISION_REQUIRED',
  REVISION_CONFLICT: 'WORKSPACE_REVISION_CONFLICT',
  DATA_TOO_LARGE: 'WORKSPACE_DATA_TOO_LARGE',
  CREDENTIAL_FAILED: 'WORKSPACE_CREDENTIAL_FAILED'
});

class WorkspaceServiceError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkspaceServiceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details, cause) {
  throw new WorkspaceServiceError(code, message, details, cause);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label}格式错误`, { field: label });
  return value;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, maximum = 4096) {
  return typeof value === 'string' ? value.normalize('NFC').slice(0, maximum) : '';
}

function normalizeNullableWordLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function normalizePrivacyMode(value) {
  return ['normal', 'sensitive', 'local-only'].includes(value) ? value : 'normal';
}

function normalizeMeta(meta, fallback = {}) {
  const input = isPlainObject(meta) ? meta : {};
  return {
    title: normalizeText(input.title ?? fallback.title, 500) || '未命名',
    author: normalizeText(input.author ?? fallback.author, 500),
    course: normalizeText(input.course ?? fallback.course, 500),
    degree: normalizeText(input.degree ?? fallback.degree, 500),
    wordLimit: normalizeNullableWordLimit(input.wordLimit ?? fallback.wordLimit),
    referenceStyle: normalizeText(input.referenceStyle ?? fallback.referenceStyle, 100) || 'MLA',
    privacyMode: normalizePrivacyMode(input.privacyMode ?? fallback.privacyMode)
  };
}

function normalizeBaseRevision(value, options = {}) {
  if (options.allowCreate === true && (value === -1 || value === null)) return -1;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(ERROR_CODES.REVISION_REQUIRED, '保存必须携带非负 baseRevision', { baseRevision: value });
  }
  return value;
}

function normalizeHtml(value) {
  if (typeof value !== 'string') fail(ERROR_CODES.INVALID_ARGUMENT, '项目正文必须是字符串');
  if (Buffer.byteLength(value, 'utf8') > MAX_HTML_BYTES) {
    fail(ERROR_CODES.DATA_TOO_LARGE, '项目正文超过 50 MB 限制');
  }
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function normalizeDoi(value) {
  return normalizeText(value, 512).trim().toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
}

function citationIdentity(citation, index) {
  const paper = isPlainObject(citation.paper) ? citation.paper : citation;
  const doi = normalizeDoi(paper.doi || paper.DOI);
  if (doi) return `doi:${doi}`;
  const legacyId = citation.paperId ?? paper.id;
  if (typeof legacyId === 'string' && legacyId) return `legacy:${legacyId.normalize('NFC')}`;
  return `position:${index}`;
}

function sanitizePaper(value) {
  if (!isPlainObject(value)) return {};
  const clone = jsonClone(value);
  for (const key of Object.keys(clone)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['id', 'paperid', 'apikey', 'authorization', 'password', 'token'].includes(normalized) ||
        normalized.endsWith('filepath') || normalized.endsWith('absolutepath')) {
      delete clone[key];
    }
  }
  return clone;
}

function legacyCitationsToAggregate(projectId, citations, existingAggregate) {
  if (!Array.isArray(citations) || citations.length > MAX_CITATIONS) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `引用列表必须是最多 ${MAX_CITATIONS} 项的数组`);
  }
  const existingByIdentity = new Map();
  for (const item of existingAggregate?.citationItems || []) {
    const legacy = item.migration?.legacyPaperId;
    const doi = normalizeDoi(item.doi || item.DOI);
    if (doi) existingByIdentity.set(`doi:${doi}`, item);
    if (legacy) existingByIdentity.set(`legacy:${legacy}`, item);
  }
  const existingLinks = new Map();
  for (const link of existingAggregate?.citationLinks || []) {
    const legacy = link.migration?.legacyPaperId;
    if (legacy) existingLinks.set(`legacy:${legacy}`, link);
    const item = (existingAggregate?.citationItems || []).find(candidate =>
      candidate.citationItemId === link.citationItemId || candidate.id === link.citationItemId);
    const doi = normalizeDoi(item?.doi || item?.DOI);
    if (doi) existingLinks.set(`doi:${doi}`, link);
  }
  const items = [];
  const links = [];
  const seenItems = new Set();
  citations.forEach((citation, index) => {
    if (!isPlainObject(citation)) fail(ERROR_CODES.INVALID_ARGUMENT, `引用 ${index + 1} 格式错误`);
    const paper = isPlainObject(citation.paper) ? citation.paper : citation;
    const identity = citationIdentity(citation, index);
    const legacyPaperId = normalizeText(citation.paperId ?? paper.id ?? identity, 1000);
    const existing = existingByIdentity.get(identity);
    const citationItemId = existing?.citationItemId || existing?.id ||
      stableUuid('citation-item', `${projectId}\0${identity}`);
    if (!seenItems.has(citationItemId)) {
      const metadata = sanitizePaper(paper);
      items.push({
        ...metadata,
        schemaVersion: SERVICE_SCHEMA_VERSION,
        id: citationItemId,
        citationItemId,
        projectId,
        ...(existing?.libraryItemId ? { libraryItemId: existing.libraryItemId } : {}),
        migration: { source: existing?.migration?.source || 'renderer', legacyPaperId }
      });
      seenItems.add(citationItemId);
    }
    const existingLink = existingLinks.get(identity);
    const linkId = existingLink?.id || stableUuid('citation-link', `${projectId}\0${identity}`);
    links.push({
      schemaVersion: SERVICE_SCHEMA_VERSION,
      id: linkId,
      projectId,
      citationItemId,
      migration: {
        source: existingLink?.migration?.source || 'renderer',
        legacyCitationNumber: Number.isInteger(citation.number) ? citation.number : index + 1,
        legacyPaperId
      }
    });
  });
  return { citationItems: items, citationLinks: links };
}

function modernCitationsToAggregate(projectId, citations, existingAggregate, options = {}) {
  const now = options.now || new Date().toISOString();
  const existingItems = new Map((existingAggregate?.citationItems || []).map(item => [item.citationItemId || item.id, item]));
  const existingLinks = new Map((existingAggregate?.citationLinks || []).map(link => [link.id, link]));
  const citationItems = new Map();
  const citationLinks = [];
  const seenLinks = new Set();
  citations.forEach((cluster, clusterIndex) => {
    if (!isPlainObject(cluster) || !Array.isArray(cluster.items) || !cluster.items.length) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `引用簇 ${clusterIndex + 1} 格式错误`);
    }
    const sourceInstanceId = cluster.citationInstanceId || cluster.id || `position:${clusterIndex}`;
    const linkId = isStableUuid(sourceInstanceId)
      ? sourceInstanceId.toLowerCase()
      : stableUuid('citation-link', `${projectId}\0${sourceInstanceId}`);
    if (seenLinks.has(linkId)) fail(ERROR_CODES.INVALID_ARGUMENT, '引用簇 citationInstanceId 重复', { citationInstanceId: linkId });
    seenLinks.add(linkId);
    const existingLink = existingLinks.get(linkId);
    const seenOrders = new Set();
    const entries = cluster.items.map((entry, entryIndex) => {
      if (!isPlainObject(entry)) fail(ERROR_CODES.INVALID_ARGUMENT, `引用簇 ${clusterIndex + 1} 的条目格式错误`);
      const paper = isPlainObject(entry.paper) ? entry.paper : (isPlainObject(entry.citationItem) ? entry.citationItem : {});
      const identity = citationIdentity({ paperId: entry.paperId, paper }, entryIndex);
      const requestedItemId = entry.citationItemId;
      const citationItemId = isStableUuid(requestedItemId)
        ? requestedItemId.toLowerCase()
        : stableUuid('citation-item', `${projectId}\0${identity}`);
      const existingItem = existingItems.get(citationItemId);
      if (!citationItems.has(citationItemId)) {
        if (existingItem) {
          citationItems.set(citationItemId, jsonClone(existingItem));
        } else {
          if (!Object.keys(paper).length) {
            fail(ERROR_CODES.INVALID_ARGUMENT, `新引用条目缺少文献快照`, { citationInstanceId: linkId, citationItemId });
          }
          const csl = legacyPaperToCsl(paper, { citationItemId, now: () => now, source: 'renderer' });
          delete csl.id;
          citationItems.set(citationItemId, {
            ...csl,
            schemaVersion: SERVICE_SCHEMA_VERSION,
            id: citationItemId,
            citationItemId,
            projectId,
            ...(isStableUuid(entry.libraryItemId) ? { libraryItemId: entry.libraryItemId.toLowerCase() } : {}),
            capturedAt: now
          });
        }
      }
      const order = Number.isInteger(entry.order) && entry.order >= 0 ? entry.order : entryIndex;
      if (seenOrders.has(order)) fail(ERROR_CODES.INVALID_ARGUMENT, '引用簇条目 order 重复', { citationInstanceId: linkId, order });
      seenOrders.add(order);
      const locator = normalizeText(entry.locator, 2048).trim();
      const label = normalizeText(entry.label, 64).trim();
      if (Boolean(locator) !== Boolean(label) || (label && !['page', 'chapter', 'section', 'paragraph', 'figure', 'table'].includes(label))) {
        fail(ERROR_CODES.INVALID_ARGUMENT, 'locator 与 label 必须成对且 label 必须是受支持类型', { citationInstanceId: linkId });
      }
      const requestedEntryId = entry.citationItemEntryId;
      const citationItemEntryId = isStableUuid(requestedEntryId)
        ? requestedEntryId.toLowerCase()
        : stableUuid('citation-entry', `${linkId}\0${order}\0${citationItemId}`);
      const evidenceRevisionIds = Array.isArray(entry.evidenceRevisionIds)
        ? entry.evidenceRevisionIds.map(id => String(id).toLowerCase())
        : [];
      const sourceCitationSnapshots = Array.isArray(entry.sourceCitationSnapshots)
        ? jsonClone(entry.sourceCitationSnapshots)
        : [];
      return {
        citationItemEntryId,
        citationItemId,
        evidenceRevisionIds,
        sourceCitationSnapshots,
        ...(locator ? { locator, label } : {}),
        ...(entry.prefix ? { prefix: normalizeText(entry.prefix, 2048) } : {}),
        ...(entry.suffix ? { suffix: normalizeText(entry.suffix, 2048) } : {}),
        suppressAuthor: entry.suppressAuthor === true,
        order,
        status: ['active', 'evidence-missing', 'source-mismatch'].includes(entry.status) ? entry.status : 'active'
      };
    }).sort((left, right) => left.order - right.order);
    citationLinks.push({
      schemaVersion: SERVICE_SCHEMA_VERSION,
      id: linkId,
      projectId,
      insertionMode: ['quote', 'paraphrase', 'citation-only'].includes(cluster.insertionMode)
        ? cluster.insertionMode
        : 'citation-only',
      items: entries,
      createdAt: existingLink?.createdAt || now,
      updatedAt: now
    });
  });
  return { citationItems: [...citationItems.values()], citationLinks };
}

function citationsToAggregate(projectId, citations, existingAggregate, options = {}) {
  if (!Array.isArray(citations) || citations.length > MAX_CITATIONS) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `引用列表必须是最多 ${MAX_CITATIONS} 项的数组`);
  }
  const modern = citations.some(citation => isPlainObject(citation) && Array.isArray(citation.items));
  return modern
    ? modernCitationsToAggregate(projectId, citations, existingAggregate, options)
    : legacyCitationsToAggregate(projectId, citations, existingAggregate);
}

function retainReferencedCitationItems(existingAggregate, nextCitationItems) {
  const retained = new Map(nextCitationItems.map(item => [String(item.citationItemId || item.id).toLowerCase(), item]));
  if (!existingAggregate) return [...retained.values()];
  const referencedIds = new Set([
    ...(existingAggregate.evidenceRevisions || []).map(item => item.citationItemId),
    ...(existingAggregate.projectPaperStates || []).map(item => item.citationItemId)
  ].filter(Boolean).map(id => String(id).toLowerCase()));
  for (const item of existingAggregate.citationItems || []) {
    const id = String(item.citationItemId || item.id).toLowerCase();
    if (referencedIds.has(id) && !retained.has(id)) retained.set(id, jsonClone(item));
  }
  return [...retained.values()];
}

function aggregateToCitations(aggregate) {
  if (aggregate.citationLinks.some(link => Array.isArray(link.items))) {
    const itemById = new Map(aggregate.citationItems.map(item => [item.citationItemId || item.id, item]));
    return aggregate.citationLinks.map(link => ({
      id: link.id,
      citationInstanceId: link.id,
      insertionMode: link.insertionMode || 'citation-only',
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      items: (link.items || []).map(entry => {
        const snapshot = itemById.get(entry.citationItemId);
        const paper = snapshot ? jsonClone(snapshot) : null;
        if (paper) {
          for (const key of ['schemaVersion', 'id', 'citationItemId', 'projectId', 'capturedAt']) delete paper[key];
          paper.id = snapshot.libraryItemId || snapshot.citationItemId || snapshot.id;
        }
        return { ...jsonClone(entry), ...(paper ? { paper } : {}) };
      })
    }));
  }
  const links = [...aggregate.citationLinks].sort((left, right) =>
    (left.migration?.legacyCitationNumber || 0) - (right.migration?.legacyCitationNumber || 0));
  return links.map((link, index) => {
    const item = aggregate.citationItems.find(candidate =>
      candidate.citationItemId === link.citationItemId || candidate.id === link.citationItemId);
    if (!item) return null;
    const paper = jsonClone(item);
    for (const key of ['schemaVersion', 'id', 'citationItemId', 'projectId', 'libraryItemId', 'migration']) delete paper[key];
    const paperId = link.migration?.legacyPaperId || item.migration?.legacyPaperId || item.citationItemId || item.id;
    paper.id = paperId;
    return {
      paperId,
      number: link.migration?.legacyCitationNumber || index + 1,
      paper
    };
  }).filter(Boolean);
}

function projectDto(aggregate) {
  const manifest = aggregate.manifest;
  return {
    schemaVersion: SERVICE_SCHEMA_VERSION,
    id: manifest.projectId,
    projectId: manifest.projectId,
    content: aggregate.document.html,
    meta: {
      title: manifest.title,
      author: manifest.author,
      course: manifest.course,
      degree: manifest.degree,
      wordLimit: manifest.wordLimit,
      referenceStyle: manifest.referenceStyle,
      privacyMode: manifest.privacyMode,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt
    },
    citations: aggregateToCitations(aggregate),
    revision: manifest.revision,
    aggregate
  };
}

function libraryItemToRenderer(item) {
  const output = jsonClone(item);
  output.id = item.legacySourceId || item.libraryItemId;
  delete output.schemaVersion;
  delete output.createdAt;
  delete output.updatedAt;
  delete output.legacySourceId;
  return output;
}

function rendererLibraryItem(value, existingByLegacy, existingById, now) {
  if (!isPlainObject(value)) fail(ERROR_CODES.INVALID_ARGUMENT, '文献记录格式错误');
  const legacySourceId = normalizeText(value.id || value.legacySourceId || '', 1000) ||
    `semantic:${normalizeDoi(value.doi || value.DOI) || crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  const requestedId = isStableUuid(value.libraryItemId) ? value.libraryItemId.toLowerCase() : null;
  const existing = (requestedId && existingById.get(requestedId)) || existingByLegacy.get(legacySourceId);
  const libraryItemId = existing?.libraryItemId || libraryItemIdFromLegacySourceId(legacySourceId);
  const sanitized = sanitizePaper(value);
  delete sanitized.libraryItemId;
  delete sanitized.createdAt;
  delete sanitized.updatedAt;
  return {
    ...sanitized,
    schemaVersion: SERVICE_SCHEMA_VERSION,
    libraryItemId,
    legacySourceId,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

class WorkspaceService {
  constructor(options) {
    assertObject(options, 'options');
    if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
      fail(ERROR_CODES.INVALID_ARGUMENT, 'userDataPath 必填');
    }
    this.userDataPath = path.resolve(options.userDataPath);
    this.workspaceRoot = path.join(this.userDataPath, 'workspace');
    this.appVersion = String(options.appVersion || '0.0.0');
    this.safeStorage = options.safeStorage;
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
    this.aiTransport = options.aiTransport || secureTransport;
    this.assetStore = options.assetStore || new AssetStore(path.join(this.workspaceRoot, 'assets'), { now: this.now });
    this.repository = options.repository || new ProjectRepository({
      rootPath: this.workspaceRoot,
      assetStore: this.assetStore,
      now: this.now,
      randomUUID: this.randomUUID,
      backupRoots: [path.join(this.workspaceRoot, 'backups')]
    });
    this.libraryStore = options.libraryStore || new LibraryStore(this.workspaceRoot, { now: this.now, idFactory: this.randomUUID });
    this.settingsStore = options.settingsStore || new SettingsStore(this.workspaceRoot);
    this.secretStore = options.secretStore || (this.safeStorage
      ? new SecretStore(path.join(this.userDataPath, 'secure'), this.safeStorage)
      : null);
    this._bootstrapPromise = null;
    this._bootstrapResult = null;
    this._archiveService = null;
    this._citationService = null;
    this._evidenceService = null;
    this._trustedAiService = null;
    this._matrixService = null;
  }

  async initialize() {
    await fs.promises.mkdir(this.workspaceRoot, { recursive: true });
    await this.repository.initialize();
    return this;
  }

  async bootstrapLegacy(rendererSnapshot = {}) {
    if (this._bootstrapPromise) return this._bootstrapPromise;
    this._bootstrapPromise = (async () => {
      await this.initialize();
      const credentialTasks = [];
      const legacySettings = splitLegacySettings(rendererSnapshot.localStorage || rendererSnapshot, {
        secretSink: credential => {
          if (!this.secretStore) return;
          credentialTasks.push(this.secretStore.setCredential(credential.providerId, credential.value).catch(() => {
            this.secretStore.markNeedsReentry(credential.providerId);
          }));
        }
      });
      if (!Object.keys(this.settingsStore.readSync()).length && Object.keys(legacySettings.exportableSettings).length) {
        await this.settingsStore.replace(legacySettings.exportableSettings);
      }
      await Promise.all(credentialTasks);
      const migrator = new LegacyMigrator({
        legacyProfileRoot: this.userDataPath,
        workspaceRoot: this.workspaceRoot,
        rendererSnapshot,
        appVersion: this.appVersion,
        now: this.now,
        repository: this.repository,
        assetStore: this.assetStore,
        libraryStore: this.libraryStore
      });
      const migration = await migrator.migrate();
      this._bootstrapResult = Object.freeze({
        schemaVersion: SERVICE_SCHEMA_VERSION,
        migration,
        settings: this.settingsStore.readSync(),
        library: this.librarySnapshot()
      });
      return this._bootstrapResult;
    })().catch(error => {
      this._bootstrapPromise = null;
      throw error;
    });
    return this._bootstrapPromise;
  }

  _requireBootstrap() {
    if (!this._bootstrapResult) fail(ERROR_CODES.NOT_BOOTSTRAPPED, '工作区尚未完成迁移初始化');
  }

  async listProjects(options = {}) {
    this._requireBootstrap();
    const summaries = await this.repository.listProjects(options);
    return summaries.map(summary => ({
      id: summary.projectId,
      projectId: summary.projectId,
      title: summary.title,
      author: summary.author,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      revision: summary.revision,
      wordCount: summary.wordCount,
      citationCount: summary.citationCount,
      versionCount: summary.versionCount,
      state: summary.state
    }));
  }

  async loadProject(projectId, options = {}) {
    this._requireBootstrap();
    if (!isStableUuid(projectId)) fail(ERROR_CODES.INVALID_ARGUMENT, '项目 ID 格式错误');
    try {
      return projectDto(await this.repository.loadProject(projectId.toLowerCase(), options));
    } catch (error) {
      if (error.code === REPOSITORY_ERROR_CODES.PROJECT_NOT_FOUND) {
        fail(ERROR_CODES.PROJECT_NOT_FOUND, '项目不存在', { projectId }, error);
      }
      throw error;
    }
  }

  async saveProject(payload) {
    this._requireBootstrap();
    assertObject(payload, '保存参数');
    const projectId = (payload.projectId || payload.id || '').toLowerCase();
    if (!isStableUuid(projectId)) fail(ERROR_CODES.INVALID_ARGUMENT, '项目 ID 必须是 UUID');
    const content = normalizeHtml(payload.content);
    let existing = null;
    try {
      existing = await this.repository.loadProject(projectId);
    } catch (error) {
      if (error.code !== REPOSITORY_ERROR_CODES.PROJECT_NOT_FOUND) throw error;
    }
    const baseRevision = normalizeBaseRevision(payload.baseRevision, { allowCreate: !existing });
    if (!existing && baseRevision !== -1) {
      fail(ERROR_CODES.REVISION_CONFLICT, '新项目 baseRevision 必须为 -1', { baseRevision });
    }
    if (existing && baseRevision !== existing.manifest.revision) {
      fail(ERROR_CODES.REVISION_CONFLICT, '项目 revision 已变化，请重新加载后再保存', {
        baseRevision,
        currentRevision: existing.manifest.revision
      });
    }
    const meta = normalizeMeta(payload.meta || { title: payload.title }, existing?.manifest);
    const timestamp = this.now().toISOString();
    const aggregate = existing ? jsonClone(existing) : createEmptyProjectAggregate({
      projectId,
      createdAt: timestamp,
      ...meta,
      html: content,
      revision: 0
    });
    Object.assign(aggregate.manifest, meta);
    aggregate.document = { canonicalFormat: 'html', html: content };
    const citations = citationsToAggregate(projectId, payload.citations || [], existing, { now: timestamp });
    aggregate.citationItems = retainReferencedCitationItems(existing, citations.citationItems);
    aggregate.citationLinks = citations.citationLinks;
    const normalized = normalizeProjectAggregate(aggregate);
    const acknowledgment = existing
      ? await this.repository.saveProject({
        projectId,
        baseRevision,
        aggregate: normalized,
        source: payload.source || 'renderer-autosave'
      })
      : await this.repository.createProject({ projectId, aggregate: normalized });
    return {
      success: true,
      durable: acknowledgment.durable === true && acknowledgment.journalState === 'COMPLETE',
      journalState: acknowledgment.journalState,
      revision: acknowledgment.revision,
      commitId: acknowledgment.commitId,
      aggregateHash: acknowledgment.aggregateHash,
      project: projectDto(acknowledgment.aggregate)
    };
  }

  async renameProject(payload) {
    this._requireBootstrap();
    assertObject(payload, '项目重命名参数');
    const projectId = normalizeText(payload.projectId, 128).toLowerCase();
    if (!isStableUuid(projectId)) fail(ERROR_CODES.INVALID_ARGUMENT, '项目 ID 必须是 UUID');
    if (typeof payload.title !== 'string') fail(ERROR_CODES.INVALID_ARGUMENT, '项目名称必须是字符串');
    const title = payload.title.normalize('NFC').trim();
    if (!title) fail(ERROR_CODES.INVALID_ARGUMENT, '项目名称不能为空');
    if (title.length > 500) fail(ERROR_CODES.INVALID_ARGUMENT, '项目名称不能超过 500 个字符');
    const baseRevision = normalizeBaseRevision(payload.baseRevision);
    const existing = await this.repository.loadProject(projectId);
    const aggregate = jsonClone(existing);
    aggregate.manifest.title = title;
    const acknowledgment = await this.repository.saveProject({
      projectId,
      baseRevision,
      aggregate: normalizeProjectAggregate(aggregate),
      source: 'project-rename'
    });
    return {
      success: true,
      durable: acknowledgment.durable === true && acknowledgment.journalState === 'COMPLETE',
      journalState: acknowledgment.journalState,
      projectId,
      title,
      revision: acknowledgment.revision,
      commitId: acknowledgment.commitId,
      aggregateHash: acknowledgment.aggregateHash,
      project: projectDto(acknowledgment.aggregate)
    };
  }

  async createCheckpoint(options) {
    this._requireBootstrap();
    return this.repository.createCheckpoint(options);
  }

  async listVersions(projectId) {
    this._requireBootstrap();
    return this.repository.listVersions(projectId);
  }

  async previewVersion(projectId, versionId) {
    this._requireBootstrap();
    return this.repository.previewVersion(projectId, versionId);
  }

  async restoreVersion(options) {
    this._requireBootstrap();
    const result = await this.repository.restoreVersion(options);
    return { ...result, project: projectDto(result.aggregate) };
  }

  async trashImpact(projectId) {
    this._requireBootstrap();
    return this.repository.getTrashImpact(projectId);
  }

  async moveToTrash(options) {
    this._requireBootstrap();
    return this.repository.moveToTrash(options);
  }

  async listTrash() {
    this._requireBootstrap();
    return this.repository.listTrash();
  }

  async restoreFromTrash(options) {
    this._requireBootstrap();
    return this.repository.restoreFromTrash(options);
  }

  async permanentlyDelete(options) {
    this._requireBootstrap();
    return this.repository.permanentlyDelete(options);
  }

  librarySnapshot() {
    const envelope = this.libraryStore.readSync();
    return {
      revision: envelope.revision,
      updatedAt: envelope.updatedAt,
      items: Object.values(envelope.itemsById).map(libraryItemToRenderer),
      collections: envelope.collections
    };
  }

  async replaceLibrary(payload) {
    this._requireBootstrap();
    assertObject(payload, '文库参数');
    if (!Array.isArray(payload.items) || payload.items.length > MAX_LIBRARY_ITEMS) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `文库必须是最多 ${MAX_LIBRARY_ITEMS} 项的数组`);
    }
    const baseRevision = normalizeBaseRevision(payload.baseRevision);
    const current = this.libraryStore.readSync();
    const existingByLegacy = new Map(Object.values(current.itemsById)
      .filter(item => item.legacySourceId)
      .map(item => [item.legacySourceId, item]));
    const existingById = new Map(Object.values(current.itemsById).map(item => [item.libraryItemId, item]));
    const timestamp = this.now().toISOString();
    const itemsById = {};
    for (const value of payload.items) {
      const item = rendererLibraryItem(value, existingByLegacy, existingById, timestamp);
      itemsById[item.libraryItemId] = item;
    }
    const result = await this.libraryStore.bulkReplace({
      itemsById,
      collections: payload.collections || current.collections
    }, { baseRevision });
    return { success: true, durable: true, ...this.librarySnapshot(), acknowledgment: result.acknowledgment };
  }

  readSettings() {
    this._requireBootstrap();
    return this.settingsStore.readSync();
  }

  async updateSettings(patch) {
    this._requireBootstrap();
    return this.settingsStore.update(patch);
  }

  async setCredential(providerId, plainText) {
    this._requireBootstrap();
    if (!this.secretStore) fail(ERROR_CODES.CREDENTIAL_FAILED, '系统安全存储不可用');
    const result = await this.secretStore.setCredential(providerId, plainText);
    return { credentialStatus: result.credentialStatus };
  }

  async removeCredential(providerId) {
    this._requireBootstrap();
    if (!this.secretStore) fail(ERROR_CODES.CREDENTIAL_FAILED, '系统安全存储不可用');
    const result = await this.secretStore.removeCredential(providerId);
    return { credentialStatus: result.credentialStatus };
  }

  credentialStatus(providerId, options) {
    this._requireBootstrap();
    if (!this.secretStore) return 'needs-reentry';
    return this.secretStore.credentialStatus(providerId, options);
  }

  getCredential(providerId) {
    this._requireBootstrap();
    if (!this.secretStore) fail(ERROR_CODES.CREDENTIAL_FAILED, '系统安全存储不可用');
    return this.secretStore.getCredential(providerId);
  }

  _archiveLibraryAdapter() {
    const store = this.libraryStore;
    return {
      exportForBackup() {
        const envelope = store.readSync();
        return {
          schemaVersion: SERVICE_SCHEMA_VERSION,
          libraryItemsById: jsonClone(envelope.itemsById),
          collections: jsonClone(envelope.collections)
        };
      },
      async importFromBackup(payload, options = {}) {
        assertObject(payload, '归档文库');
        const current = store.readSync();
        const incoming = isPlainObject(payload.libraryItemsById) ? payload.libraryItemsById : {};
        let itemsById = options.replaceAll === true ? {} : jsonClone(current.itemsById);
        if (options.replaceAll === true) {
          itemsById = jsonClone(incoming);
        } else {
          for (const [itemId, item] of Object.entries(incoming)) {
            const action = options.actions?.[itemId] || (itemsById[itemId] ? 'overwrite' : 'create');
            if (action === 'skip') continue;
            itemsById[itemId] = jsonClone(item);
          }
        }
        const collections = options.replaceAll === true
          ? jsonClone(payload.collections || [])
          : [...current.collections.filter(existing =>
            !(payload.collections || []).some(incomingCollection =>
              incomingCollection.collectionId === existing.collectionId)), ...jsonClone(payload.collections || [])];
        return store.bulkReplace({ itemsById, collections }, { baseRevision: store.revision });
      }
    };
  }

  async putAsset(input) {
    this._requireBootstrap();
    assertObject(input, '资产参数');
    const buffer = Buffer.isBuffer(input.buffer)
      ? input.buffer
      : typeof input.base64 === 'string'
        ? Buffer.from(input.base64, 'base64')
        : null;
    if (!buffer) fail(ERROR_CODES.INVALID_ARGUMENT, '资产必须包含 Buffer 或 base64');
    return this.assetStore.putBuffer({ ...input, buffer });
  }

  readAsset(assetId) {
    this._requireBootstrap();
    return this.assetStore.readBuffer(assetId);
  }

  _workspaceId() {
    const manifestPath = path.join(this.workspaceRoot, ...WORKSPACE_MANIFEST_RELATIVE_PATH.split('/'));
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (isStableUuid(manifest.workspaceId)) return manifest.workspaceId;
    }
    return stableUuid('workspace-service', this.workspaceRoot);
  }

  archiveService() {
    this._requireBootstrap();
    if (!this._archiveService) {
      this._archiveService = new ArchiveService({
        repository: this.repository,
        assetStore: this.assetStore,
        libraryStore: this._archiveLibraryAdapter(),
        settingsStore: this.settingsStore,
        workspaceId: this._workspaceId(),
        productVersion: this.appVersion,
        stagingRoot: path.join(this.workspaceRoot, 'staging', 'archives'),
        now: this.now,
        randomUUID: this.randomUUID
      });
    }
    return this._archiveService;
  }

  citationService() {
    this._requireBootstrap();
    if (!this._citationService) {
      this._citationService = new CitationService({
        repository: this.repository,
        libraryStore: this.libraryStore,
        assetStore: this.assetStore,
        now: this.now,
        randomUUID: this.randomUUID
      });
    }
    return this._citationService;
  }

  evidenceService() {
    this._requireBootstrap();
    if (!this._evidenceService) {
      this._evidenceService = new EvidenceService({
        repository: this.repository,
        assetStore: this.assetStore,
        libraryStore: this.libraryStore,
        now: this.now,
        randomUUID: this.randomUUID
      });
    }
    return this._evidenceService;
  }

  matrixService() {
    this._requireBootstrap();
    if (!this._matrixService) {
      const trustedAiAdapter = {
        previewRequest: input => this.trustedAiService().previewRequest(input),
        request: input => this.trustedAiService().request(input),
        cancelRequest: input => this.trustedAiService().cancelRequest(input)
      };
      this._matrixService = new MatrixService({
        repository: this.repository,
        assetStore: this.assetStore,
        trustedAiService: trustedAiAdapter,
        now: this.now,
        randomUUID: this.randomUUID
      });
    }
    return this._matrixService;
  }

  trustedAiService() {
    this._requireBootstrap();
    if (!this.secretStore) fail(ERROR_CODES.CREDENTIAL_FAILED, '系统安全存储不可用，无法启动可信 AI gateway');
    if (!this._trustedAiService) {
      this._trustedAiService = new TrustedAiService({
        repository: this.repository,
        settingsStore: this.settingsStore,
        secretStore: this.secretStore,
        transport: this.aiTransport,
        now: this.now,
        randomUUID: this.randomUUID
      });
    }
    return this._trustedAiService;
  }
}

module.exports = {
  ERROR_CODES,
  SERVICE_SCHEMA_VERSION,
  WorkspaceService,
  WorkspaceServiceError,
  aggregateToCitations,
  citationsToAggregate,
  legacyCitationsToAggregate,
  modernCitationsToAggregate,
  libraryItemToRenderer,
  normalizeMeta,
  projectDto,
  rendererLibraryItem
};
