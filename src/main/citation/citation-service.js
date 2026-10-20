'use strict';

const crypto = require('node:crypto');

const { auditCitations } = require('./audit');
const { listLockedStyles, renderCitationDocument } = require('./engine');
const { exportCitationItems, importCitationText } = require('./exchange');
const { mergeItems, planImportMerge } = require('./merge');
const { legacyPaperToCsl, normalizeCitationItem, normalizedTitle } = require('./model');

const MAX_QUERY_LIMIT = 200;
const MAX_BATCH_ITEMS = 10000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const SCREENING_STATUSES = new Set(['pending', 'included', 'excluded']);
const READING_STATUSES = new Set(['unread', 'to-read', 'reading', 'read']);

class CitationServiceError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CitationServiceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nowIso(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function itemAuthorsText(item) {
  if (Array.isArray(item.author)) {
    return item.author.map(author => author.literal || [author.family, author.given].filter(Boolean).join(' ')).join(' ');
  }
  if (Array.isArray(item.authors)) return item.authors.map(String).join(' ');
  return String(item.authors || item.author || '');
}

function itemYear(item) {
  return item.issued?.['date-parts']?.[0]?.[0] ?? String(item.year || item.published || '').match(/\d{4}/)?.[0] ?? null;
}

function itemSource(item) {
  return item['container-title'] || item.journal || item.source || item.publisher || '';
}

function itemHasPdf(item) {
  return Boolean((item.assetRefs || []).some(ref => ref.kind === 'pdf') || item.hasPdf || item.localPdf || item.localPdfPath);
}

function libraryItemAsCitationModel(item, options) {
  try {
    return normalizeCitationItem(item, options);
  } catch {
    const csl = legacyPaperToCsl(item, {
      citationItemId: item.libraryItemId,
      now: options.now,
      source: item.metadataProvenance?.source || 'legacy-library'
    });
    return normalizeCitationItem({
      ...csl,
      libraryItemId: item.libraryItemId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      legacySourceId: item.legacySourceId,
      tags: item.tags || [],
      starred: item.starred === true,
      privateNote: item.privateNote || item.note || '',
      assetRefs: item.assetRefs || [],
      metadataProvenance: item.metadataProvenance || { source: 'legacy-library' },
      ...(item.verifiedAt ? { verifiedAt: item.verifiedAt } : {})
    }, options);
  }
}

function projectCitationClusters(aggregate) {
  return aggregate.citationLinks.filter(link => Array.isArray(link.items));
}

class CitationService {
  constructor(options = {}) {
    if (!options.repository || !options.libraryStore) {
      throw new CitationServiceError('CITATION_SERVICE_CONFIG_INVALID', 'CitationService 需要 repository 和 libraryStore');
    }
    this.repository = options.repository;
    this.libraryStore = options.libraryStore;
    this.assetStore = options.assetStore || null;
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.importSessions = new Map();
    this.undoSessions = new Map();
    this.libraryQueryCache = null;
  }

  _cleanupSessions() {
    const now = Date.now();
    for (const sessions of [this.importSessions, this.undoSessions]) {
      for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    }
  }

  _libraryModels() {
    return Object.values(this.libraryStore.readSync().itemsById).map(item => libraryItemAsCitationModel(item, {
      now: this.now,
      idFactory: this.randomUUID
    }));
  }

  listStyles() {
    return listLockedStyles();
  }

  async renderProject(projectId, options = {}) {
    const aggregate = await this.repository.loadProject(projectId);
    return renderCitationDocument({
      items: aggregate.citationItems,
      clusters: projectCitationClusters(aggregate),
      styleId: options.styleId,
      locale: options.locale,
      format: options.format || 'html'
    });
  }

  async auditProject(projectId) {
    const aggregate = await this.repository.loadProject(projectId);
    return auditCitations(this._auditInput(aggregate));
  }

  _auditInput(aggregate) {
    const evidenceSourceStates = {};
    for (const revision of aggregate.evidenceRevisions || []) {
      const card = aggregate.evidenceCards.find(item => item.id === revision.evidenceId);
      let status = card?.status || 'active';
      if (status !== 'archived' && this.assetStore) {
        try {
          const descriptor = this.assetStore.getDescriptor(revision.sourceSnapshot.assetId);
          status = descriptor.sha256 === revision.sourceSnapshot.fileSha256 ? status : 'source-mismatch';
        } catch {
          status = 'source-missing';
        }
      }
      evidenceSourceStates[revision.id] = { status };
    }
    return {
      items: aggregate.citationItems,
      clusters: projectCitationClusters(aggregate),
      evidenceCards: aggregate.evidenceCards,
      evidenceRevisions: aggregate.evidenceRevisions,
      evidenceSourceStates
    };
  }

  async recordExportAudit(options = {}) {
    const aggregate = await this.repository.loadProject(options.projectId);
    if (aggregate.manifest.revision !== options.baseRevision) {
      throw new CitationServiceError('CITATION_PROJECT_REVISION_CONFLICT', '项目 revision 已变化，请重新执行引用审计');
    }
    const audit = auditCitations(this._auditInput(aggregate));
    if (audit.blockingCount > 0 && options.forced !== true) {
      throw new CitationServiceError('CITATION_EXPORT_BLOCKED', '引用审计存在阻断问题，必须明确强制导出', { audit });
    }
    const timestamp = nowIso(this.now);
    const report = {
      schemaVersion: 1,
      id: this.randomUUID(),
      projectId: options.projectId,
      category: 'citation-export-audit',
      severity: audit.blockingCount ? 'blocking' : 'warning',
      status: 'recorded',
      exportFormat: String(options.format || 'unknown'),
      forced: options.forced === true,
      audit,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    aggregate.reviewIssues.push(report);
    const saved = await this.repository.saveProject({
      projectId: options.projectId,
      baseRevision: options.baseRevision,
      aggregate,
      source: 'citation-export-audit'
    });
    return { success: true, durable: saved.durable === true, revision: saved.revision, report };
  }

  planImport(text, format) {
    this._cleanupSessions();
    const parsed = importCitationText(text, format, {
      idFactory: this.randomUUID,
      now: this.now,
      collectErrors: true
    });
    const plan = planImportMerge(this._libraryModels(), parsed.items, { now: this.now, idFactory: this.randomUUID });
    const sessionId = this.randomUUID();
    this.importSessions.set(sessionId, { parsed, plan, expiresAt: Date.now() + SESSION_TTL_MS });
    return {
      schemaVersion: 1,
      sessionId,
      format: parsed.format,
      parsedCount: parsed.itemCount,
      rejectedCount: parsed.rejectedCount,
      errors: parsed.errors,
      additions: plan.additions.map(item => ({ libraryItemId: item.libraryItemId, title: item.title, DOI: item.DOI })),
      matches: plan.matches.map(match => ({
        semanticKey: match.semanticKey,
        reason: match.reason,
        existingItemId: match.existingItemId,
        incomingItemId: match.incomingItemId,
        ambiguousExistingIds: match.ambiguousExistingIds,
        conflicts: match.conflicts
      })),
      duplicateIncoming: plan.duplicateIncoming
    };
  }

  async commitImport(options = {}) {
    this._cleanupSessions();
    const session = this.importSessions.get(options.sessionId);
    if (!session) throw new CitationServiceError('CITATION_IMPORT_SESSION_EXPIRED', '引用导入会话不存在或已过期');
    const current = this.libraryStore.readSync();
    if (current.revision !== options.baseRevision) {
      throw new CitationServiceError('CITATION_LIBRARY_REVISION_CONFLICT', '文库已变化，请重新检查导入冲突', {
        baseRevision: options.baseRevision,
        currentRevision: current.revision
      });
    }
    const itemsById = clone(current.itemsById);
    for (const addition of session.plan.additions) itemsById[addition.libraryItemId] = addition;
    for (const match of session.plan.matches) {
      const decision = options.decisions?.[match.incomingItemId] || {};
      if (decision.action === 'skip') continue;
      if (match.ambiguousExistingIds.length && !decision.existingItemId) {
        throw new CitationServiceError('CITATION_IMPORT_AMBIGUOUS_MATCH', '重复文献对应多个本地记录，需要选择合并目标', {
          incomingItemId: match.incomingItemId
        });
      }
      const targetId = decision.existingItemId || match.existingItemId;
      if (![match.existingItemId, ...match.ambiguousExistingIds].includes(targetId)) {
        throw new CitationServiceError('CITATION_IMPORT_DECISION_INVALID', '导入冲突选择了无效目标');
      }
      const unresolvedManual = match.conflicts.filter(conflict => conflict.requiresUserChoice && !hasOwn(decision.fields || {}, conflict.field));
      if (unresolvedManual.length) {
        throw new CitationServiceError('CITATION_IMPORT_CONFLICT_UNRESOLVED', '人工字段冲突尚未选择', {
          incomingItemId: match.incomingItemId,
          fields: unresolvedManual.map(conflict => conflict.field)
        });
      }
      itemsById[targetId] = mergeItems(itemsById[targetId], match.incoming, decision.fields || {}, {
        now: this.now,
        idFactory: this.randomUUID
      });
    }
    const result = await this.libraryStore.bulkReplace({ itemsById, collections: current.collections }, {
      baseRevision: current.revision
    });
    this.importSessions.delete(options.sessionId);
    return { success: true, durable: true, revision: result.newRevision, importedCount: session.plan.additions.length, mergedCount: session.plan.matches.length };
  }

  exportLibrary(format, itemIds) {
    const snapshot = this.libraryStore.readSync();
    const ids = Array.isArray(itemIds) && itemIds.length ? itemIds : Object.keys(snapshot.itemsById);
    if (ids.length > MAX_BATCH_ITEMS) throw new CitationServiceError('CITATION_BATCH_TOO_LARGE', `一次最多导出 ${MAX_BATCH_ITEMS} 条文献`);
    const items = ids.map(id => snapshot.itemsById[id]).filter(Boolean).map(item => libraryItemAsCitationModel(item, {
      now: this.now,
      idFactory: this.randomUUID
    }));
    if (items.length !== ids.length) throw new CitationServiceError('CITATION_LIBRARY_ITEM_MISSING', '导出选择包含不存在的文献');
    return exportCitationItems(items, format, { now: this.now, idFactory: this.randomUUID });
  }

  async queryLibrary(query = {}) {
    const startedAt = performance.now();
    const storeRevision = this.libraryStore.revision;
    if (!this.libraryQueryCache || this.libraryQueryCache.revision !== storeRevision) {
      this.libraryQueryCache = { revision: storeRevision, snapshot: this.libraryStore.readSync() };
    }
    const snapshot = this.libraryQueryCache.snapshot;
    let aggregate = null;
    let stateByLibraryId = new Map();
    let citedLibraryIds = new Set();
    if (query.projectId) {
      aggregate = await this.repository.loadProject(query.projectId);
      const itemById = new Map(aggregate.citationItems.map(item => [item.citationItemId || item.id, item]));
      const libraryIdByCitationId = new Map(aggregate.citationItems
        .filter(item => item.libraryItemId)
        .map(item => [item.citationItemId || item.id, item.libraryItemId]));
      stateByLibraryId = new Map(aggregate.projectPaperStates.map(state => {
        const item = itemById.get(state.citationItemId);
        return [item?.libraryItemId, state];
      }).filter(([libraryItemId]) => libraryItemId));
      for (const link of aggregate.citationLinks) {
        const entries = Array.isArray(link.items) ? link.items : [{ citationItemId: link.citationItemId }];
        for (const entry of entries) {
          const libraryItemId = libraryIdByCitationId.get(entry.citationItemId);
          if (libraryItemId) citedLibraryIds.add(libraryItemId);
        }
      }
    }
    const collection = query.collectionId
      ? snapshot.collections.find(value => value.collectionId === query.collectionId)
      : null;
    const collectionIds = collection ? new Set(collection.itemIds) : null;
    const terms = normalizedTitle(query.search || '').split(' ').filter(Boolean);
    const tags = new Set((query.tags || []).map(value => String(value).normalize('NFC').toLocaleLowerCase('und')));
    let items = Object.values(snapshot.itemsById).filter(item => {
      if (collectionIds && !collectionIds.has(item.libraryItemId)) return false;
      if (query.year !== undefined && String(itemYear(item)) !== String(query.year)) return false;
      if (query.source && normalizedTitle(itemSource(item)) !== normalizedTitle(query.source)) return false;
      if (query.type && item.type !== query.type) return false;
      if (query.hasPdf !== undefined && itemHasPdf(item) !== query.hasPdf) return false;
      if (query.starred !== undefined && (item.starred === true) !== query.starred) return false;
      const projectState = stateByLibraryId.get(item.libraryItemId);
      if (query.screeningStatus && projectState?.screeningStatus !== query.screeningStatus) return false;
      if (query.readingStatus && projectState?.readingStatus !== query.readingStatus) return false;
      if (tags.size && ![...tags].every(tag => (item.tags || []).some(value => String(value).toLocaleLowerCase('und') === tag))) return false;
      if (terms.length) {
        const haystack = normalizedTitle([
          item.title, itemAuthorsText(item), item.DOI || item.doi, (item.tags || []).join(' '), item.privateNote || item.note
        ].filter(Boolean).join(' '));
        if (!terms.every(term => haystack.includes(term))) return false;
      }
      return true;
    });
    const direction = query.direction === 'desc' ? -1 : 1;
    const sortBy = ['title', 'year', 'source', 'type', 'updatedAt'].includes(query.sortBy) ? query.sortBy : 'updatedAt';
    items.sort((left, right) => {
      const values = {
        title: [left.title || '', right.title || ''],
        year: [itemYear(left) || 0, itemYear(right) || 0],
        source: [itemSource(left), itemSource(right)],
        type: [left.type || '', right.type || ''],
        updatedAt: [left.updatedAt || '', right.updatedAt || '']
      }[sortBy];
      return String(values[0]).localeCompare(String(values[1]), 'zh-CN', { numeric: true }) * direction;
    });
    const offset = Number.isInteger(query.offset) && query.offset >= 0 ? query.offset : 0;
    const limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, MAX_QUERY_LIMIT) : 100;
    const total = items.length;
    items = items.slice(offset, offset + limit).map(item => ({
      ...item,
      isCited: citedLibraryIds.has(item.libraryItemId),
      ...(stateByLibraryId.has(item.libraryItemId) ? { projectPaperState: stateByLibraryId.get(item.libraryItemId) } : {})
    }));
    return {
      schemaVersion: 1,
      revision: snapshot.revision,
      ...(aggregate ? { projectRevision: aggregate.manifest.revision } : {}),
      total,
      offset,
      limit,
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      items
    };
  }

  async applyLibraryBatch(options = {}) {
    this._cleanupSessions();
    const ids = [...new Set(options.itemIds || [])];
    if (!ids.length || ids.length > MAX_BATCH_ITEMS) throw new CitationServiceError('CITATION_BATCH_INVALID', `批量操作必须包含 1..${MAX_BATCH_ITEMS} 个唯一 ID`);
    if (options.operation?.type === 'set-project-state') {
      return this._applyProjectStateBatch({ ...options, itemIds: ids });
    }
    const snapshot = this.libraryStore.readSync();
    if (snapshot.revision !== options.baseRevision) throw new CitationServiceError('CITATION_LIBRARY_REVISION_CONFLICT', '文库 revision 已变化');
    const draft = clone(snapshot);
    for (const id of ids) if (!draft.itemsById[id]) throw new CitationServiceError('CITATION_LIBRARY_ITEM_MISSING', `文献不存在: ${id}`);
    const operation = options.operation || {};
    if (operation.type === 'tags-add' || operation.type === 'tags-remove') {
      const tags = [...new Set((operation.tags || []).map(value => String(value).trim().normalize('NFC')).filter(Boolean))];
      for (const id of ids) {
        const current = new Set(draft.itemsById[id].tags || []);
        for (const tag of tags) operation.type === 'tags-add' ? current.add(tag) : current.delete(tag);
        draft.itemsById[id].tags = [...current].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      }
    } else if (operation.type === 'set-starred') {
      for (const id of ids) draft.itemsById[id].starred = operation.value === true;
    } else if (operation.type === 'collection-add' || operation.type === 'collection-remove') {
      const collection = draft.collections.find(value => value.collectionId === operation.collectionId);
      if (!collection) throw new CitationServiceError('CITATION_COLLECTION_MISSING', '集合不存在');
      const members = new Set(collection.itemIds);
      for (const id of ids) operation.type === 'collection-add' ? members.add(id) : members.delete(id);
      collection.itemIds = [...members];
    } else if (operation.type === 'delete') {
      for (const id of ids) delete draft.itemsById[id];
      for (const collection of draft.collections) collection.itemIds = collection.itemIds.filter(id => !ids.includes(id));
    } else {
      throw new CitationServiceError('CITATION_BATCH_OPERATION_INVALID', `未知批量操作: ${operation.type}`);
    }
    const result = await this.libraryStore.bulkReplace({ itemsById: draft.itemsById, collections: draft.collections }, {
      baseRevision: snapshot.revision
    });
    const undoToken = this.randomUUID();
    this.undoSessions.set(undoToken, {
      snapshot,
      expectedRevision: result.newRevision,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    return { success: true, durable: true, revision: result.newRevision, affectedCount: ids.length, undoToken };
  }

  async undoLibraryBatch(options = {}) {
    this._cleanupSessions();
    const session = this.undoSessions.get(options.undoToken);
    if (!session) throw new CitationServiceError('CITATION_UNDO_EXPIRED', '撤销令牌不存在或已过期');
    if (session.scope === 'project') {
      const current = await this.repository.loadProject(session.projectId);
      if (current.manifest.revision !== options.baseRevision || current.manifest.revision !== session.expectedRevision) {
        throw new CitationServiceError('CITATION_PROJECT_REVISION_CONFLICT', '项目 revision 已变化，不能撤销旧操作');
      }
      const saved = await this.repository.saveProject({
        projectId: session.projectId,
        baseRevision: current.manifest.revision,
        aggregate: session.snapshot,
        source: 'project-paper-state-undo'
      });
      this.undoSessions.delete(options.undoToken);
      return { success: true, durable: saved.durable === true, revision: saved.revision, scope: 'project' };
    }
    const current = this.libraryStore.readSync();
    if (current.revision !== options.baseRevision || current.revision !== session.expectedRevision) {
      throw new CitationServiceError('CITATION_LIBRARY_REVISION_CONFLICT', '文库已变化，不能撤销旧操作');
    }
    const result = await this.libraryStore.bulkReplace(session.snapshot, { baseRevision: current.revision });
    this.undoSessions.delete(options.undoToken);
    return { success: true, durable: true, revision: result.newRevision, scope: 'library' };
  }

  _ensureProjectCitationItem(aggregate, libraryItemId, timestamp) {
    let citationItem = aggregate.citationItems.find(item => item.libraryItemId === libraryItemId);
    if (citationItem) return citationItem;
    const libraryItem = this.libraryStore.getItem(libraryItemId);
    if (!libraryItem) throw new CitationServiceError('CITATION_LIBRARY_ITEM_MISSING', `文献不存在: ${libraryItemId}`);
    const model = libraryItemAsCitationModel(libraryItem, { now: this.now, idFactory: this.randomUUID });
    const citationItemId = this.randomUUID();
    citationItem = {
      ...model,
      schemaVersion: 1,
      id: citationItemId,
      citationItemId,
      projectId: aggregate.manifest.projectId,
      libraryItemId,
      capturedAt: timestamp
    };
    delete citationItem.createdAt;
    delete citationItem.updatedAt;
    aggregate.citationItems.push(citationItem);
    return citationItem;
  }

  _projectPaperState(aggregate, citationItem, values, timestamp) {
    const citationItemId = citationItem.citationItemId || citationItem.id;
    const existing = aggregate.projectPaperStates.find(state => state.citationItemId === citationItemId);
    return {
      schemaVersion: 1,
      id: existing?.id || this.randomUUID(),
      projectId: aggregate.manifest.projectId,
      citationItemId,
      screeningStatus: values.screeningStatus,
      ...(values.screeningStatus === 'excluded' ? { exclusionReason: String(values.exclusionReason).trim().normalize('NFC') } : {}),
      readingStatus: values.readingStatus,
      projectNotes: String(values.projectNotes || existing?.projectNotes || '').normalize('NFC'),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
  }

  async _applyProjectStateBatch(options) {
    const operation = options.operation || {};
    if (!SCREENING_STATUSES.has(operation.screeningStatus) || !READING_STATUSES.has(operation.readingStatus)) {
      throw new CitationServiceError('PROJECT_PAPER_STATE_INVALID', '项目筛选或阅读状态无效');
    }
    if (operation.screeningStatus === 'excluded' && !String(operation.exclusionReason || '').trim()) {
      throw new CitationServiceError('PROJECT_PAPER_EXCLUSION_REASON_REQUIRED', '排除文献必须填写原因');
    }
    const aggregate = await this.repository.loadProject(operation.projectId);
    if (aggregate.manifest.revision !== options.baseRevision) throw new CitationServiceError('CITATION_PROJECT_REVISION_CONFLICT', '项目 revision 已变化');
    const snapshot = clone(aggregate);
    const timestamp = nowIso(this.now);
    for (const libraryItemId of options.itemIds) {
      const citationItem = this._ensureProjectCitationItem(aggregate, libraryItemId, timestamp);
      const state = this._projectPaperState(aggregate, citationItem, operation, timestamp);
      aggregate.projectPaperStates = aggregate.projectPaperStates.filter(value => value.id !== state.id).concat(state);
    }
    const saved = await this.repository.saveProject({
      projectId: operation.projectId,
      baseRevision: options.baseRevision,
      aggregate,
      source: 'project-paper-state-batch'
    });
    const undoToken = this.randomUUID();
    this.undoSessions.set(undoToken, {
      scope: 'project',
      projectId: operation.projectId,
      snapshot,
      expectedRevision: saved.revision,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    return { success: true, durable: saved.durable === true, revision: saved.revision, affectedCount: options.itemIds.length, undoToken, scope: 'project' };
  }

  async upsertLibraryCollection(options = {}) {
    const result = await this.libraryStore.upsertCollection({
      ...(options.collectionId ? { collectionId: options.collectionId } : {}),
      name: options.name
    }, { baseRevision: options.baseRevision });
    return {
      success: true,
      durable: true,
      revision: result.newRevision,
      collection: result.collection,
      collections: this.libraryStore.listCollections()
    };
  }

  async citationImpact(itemIds) {
    const ids = new Set(itemIds || []);
    const summaries = await this.repository.listProjects();
    const projects = [];
    let citationCount = 0;
    for (const summary of summaries) {
      const aggregate = await this.repository.loadProject(summary.projectId || summary.id);
      const citationItemIds = new Set(aggregate.citationItems
        .filter(item => ids.has(item.libraryItemId))
        .map(item => item.citationItemId || item.id));
      const count = aggregate.citationLinks.reduce((total, link) => total + (Array.isArray(link.items)
        ? link.items.filter(entry => citationItemIds.has(entry.citationItemId)).length
        : citationItemIds.has(link.citationItemId) ? 1 : 0), 0);
      if (count) projects.push({ projectId: aggregate.manifest.projectId, title: aggregate.manifest.title, citationCount: count });
      citationCount += count;
    }
    return { itemCount: ids.size, citationCount, projects };
  }

  async updateProjectPaperState(options = {}) {
    if (!SCREENING_STATUSES.has(options.screeningStatus) || !READING_STATUSES.has(options.readingStatus)) {
      throw new CitationServiceError('PROJECT_PAPER_STATE_INVALID', '项目筛选或阅读状态无效');
    }
    if (options.screeningStatus === 'excluded' && !String(options.exclusionReason || '').trim()) {
      throw new CitationServiceError('PROJECT_PAPER_EXCLUSION_REASON_REQUIRED', '排除文献必须填写原因');
    }
    const aggregate = await this.repository.loadProject(options.projectId);
    if (aggregate.manifest.revision !== options.baseRevision) throw new CitationServiceError('CITATION_PROJECT_REVISION_CONFLICT', '项目 revision 已变化');
    let citationItem = aggregate.citationItems.find(item =>
      (options.citationItemId && (item.citationItemId || item.id) === options.citationItemId) ||
      (options.libraryItemId && item.libraryItemId === options.libraryItemId));
    const timestamp = nowIso(this.now);
    if (!citationItem && options.libraryItemId) citationItem = this._ensureProjectCitationItem(aggregate, options.libraryItemId, timestamp);
    if (!citationItem) throw new CitationServiceError('CITATION_ITEM_MISSING', '项目中没有对应 CitationItem 快照');
    const state = this._projectPaperState(aggregate, citationItem, options, timestamp);
    aggregate.projectPaperStates = aggregate.projectPaperStates.filter(value => value.id !== state.id).concat(state);
    const saved = await this.repository.saveProject({
      projectId: options.projectId,
      baseRevision: options.baseRevision,
      aggregate,
      source: 'project-paper-state'
    });
    return { success: true, durable: saved.durable === true, revision: saved.revision, state };
  }
}

module.exports = {
  CitationService,
  CitationServiceError,
  MAX_QUERY_LIMIT,
  libraryItemAsCitationModel
};
