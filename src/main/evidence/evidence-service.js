'use strict';

const crypto = require('node:crypto');

const { validateProjectAggregate } = require('../data/schema');
const { libraryItemAsCitationModel } = require('../citation/citation-service');

const SCHEMA_VERSION = 1;
const SESSION_TTL_MS = 10 * 60 * 1000;
const NORMALIZATIONS = new Set(['whitespace-collapse', 'linebreak-join', 'hyphen-join']);

class EvidenceServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EvidenceServiceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new EvidenceServiceError(code, message, details);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeQuote(raw, normalization) {
  const value = String(raw || '').normalize('NFC');
  if (normalization === 'whitespace-collapse') return value.replace(/\s+/gu, ' ').trim();
  if (normalization === 'linebreak-join') return value.replace(/\s*\r?\n\s*/gu, ' ').trim();
  if (normalization === 'hyphen-join') return value.replace(/([\p{L}\p{N}])-\s*\r?\n\s*([\p{L}\p{N}])/gu, '$1$2').trim();
  fail('EVIDENCE_NORMALIZATION_INVALID', '不支持的证据文本规范化方式');
}

function nowIso(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function requireRevision(aggregate, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0 || aggregate.manifest.revision !== expected) {
    fail('EVIDENCE_REVISION_CONFLICT', '项目 revision 已变化，请重新操作', {
      expectedRevision: aggregate.manifest.revision,
      baseRevision: expected
    });
  }
}

function reviewChain(aggregate, revisionId) {
  return aggregate.evidenceReviewEvents
    .filter(event => event.evidenceRevisionId === revisionId)
    .sort((left, right) => left.sequence - right.sequence);
}

function derivedReviewStatus(aggregate, revisionId) {
  const events = reviewChain(aggregate, revisionId);
  return events.length ? events.at(-1).status : null;
}

function citationItemId(item) {
  return item.citationItemId || item.id;
}

function sourceSnapshotForRevision(revision, citationItem, capturedAt) {
  return {
    citationItemId: revision.citationItemId,
    title: revision.sourceSnapshot.title,
    ...(revision.sourceSnapshot.doi ? { doi: revision.sourceSnapshot.doi } : {}),
    assetId: revision.sourceSnapshot.assetId,
    fileSha256: revision.sourceSnapshot.fileSha256,
    pageIndex: revision.locator.pageIndex,
    pageLabel: revision.locator.pageLabel,
    rawQuoteSha256: revision.locator.rawQuoteSha256,
    quoteText: revision.locator.quoteDisplay,
    capturedAt: capturedAt || revision.createdAt
  };
}

class EvidenceService {
  constructor(options = {}) {
    if (!options.repository || !options.assetStore) {
      fail('EVIDENCE_SERVICE_CONFIG_INVALID', 'EvidenceService 需要 repository 和 assetStore');
    }
    this.repository = options.repository;
    this.assetStore = options.assetStore;
    this.libraryStore = options.libraryStore || null;
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.citationSessions = new Map();
  }

  _ensureCitationItem(aggregate, input, createdAt) {
    if (input.citationItemId) {
      const existing = aggregate.citationItems.find(item => citationItemId(item) === input.citationItemId);
      if (existing) return { input, citation: existing };
      fail('EVIDENCE_CITATION_ITEM_MISSING', '证据绑定的 CitationItem 不存在');
    }
    if (!input.libraryItemId || !this.libraryStore) {
      fail('EVIDENCE_CITATION_ITEM_MISSING', '证据必须绑定项目 CitationItem 或文库记录');
    }
    const libraryItem = this.libraryStore.getItem(input.libraryItemId);
    if (!libraryItem) fail('EVIDENCE_LIBRARY_ITEM_MISSING', '证据绑定的文库记录不存在');
    const model = libraryItemAsCitationModel(libraryItem, { now: this.now, idFactory: this.randomUUID });
    const id = this.randomUUID();
    const citation = {
      ...model,
      schemaVersion: SCHEMA_VERSION,
      id,
      citationItemId: id,
      projectId: aggregate.manifest.projectId,
      libraryItemId: input.libraryItemId,
      capturedAt: createdAt
    };
    delete citation.createdAt;
    delete citation.updatedAt;
    aggregate.citationItems.push(citation);
    return { input: { ...input, citationItemId: id }, citation };
  }

  _cleanupSessions() {
    const now = Date.now();
    for (const [id, session] of this.citationSessions) {
      if (session.expiresAt <= now) this.citationSessions.delete(id);
    }
  }

  _selectionRevision(aggregate, input, createdBy, createdAt) {
    const citation = aggregate.citationItems.find(item => citationItemId(item) === input.citationItemId);
    if (!citation) fail('EVIDENCE_CITATION_ITEM_MISSING', '证据必须绑定项目内 CitationItem');
    let descriptor;
    try {
      descriptor = this.assetStore.getDescriptor(input.assetId);
    } catch (error) {
      fail('EVIDENCE_SOURCE_MISSING', '受管 PDF 不存在', { assetId: input.assetId, cause: error.code || error.message });
    }
    if (descriptor.sha256 !== input.fileSha256) {
      fail('EVIDENCE_SOURCE_MISMATCH', 'PDF SHA-256 与选择时不一致', { expected: input.fileSha256, actual: descriptor.sha256 });
    }
    if (descriptor.kind && descriptor.kind !== 'pdf' && descriptor.mimeType !== 'application/pdf') {
      fail('EVIDENCE_SOURCE_NOT_PDF', '证据来源必须是受管 PDF');
    }
    if (!NORMALIZATIONS.has(input.normalization)) fail('EVIDENCE_NORMALIZATION_INVALID', '证据规范化方式无效');
    const quoteRaw = String(input.quoteRaw || '').normalize('NFC');
    if (Array.from(quoteRaw).length < 1 || Array.from(quoteRaw).length > 2000) {
      fail('EVIDENCE_QUOTE_LENGTH', '单次选文必须为 1-2000 个字符');
    }
    if (!Array.isArray(input.rects) || !input.rects.length) fail('EVIDENCE_RECTS_REQUIRED', '证据必须包含文本层矩形');
    const quoteDisplay = normalizeQuote(quoteRaw, input.normalization);
    const evidenceId = input.evidenceId || this.randomUUID();
    const existingRevisions = aggregate.evidenceRevisions.filter(item => item.evidenceId === evidenceId);
    const revision = {
      schemaVersion: SCHEMA_VERSION,
      id: this.randomUUID(),
      evidenceId,
      revisionNumber: existingRevisions.length + 1,
      citationItemId: input.citationItemId,
      ...(input.libraryItemId ? { libraryItemId: input.libraryItemId } : {}),
      sourceSnapshot: {
        assetId: input.assetId,
        fileSha256: input.fileSha256,
        title: String(input.title || citation.title || '未命名文献'),
        ...(input.doi || citation.DOI ? { doi: String(input.doi || citation.DOI) } : {}),
        metadataSource: ['api', 'imported', 'manual'].includes(input.metadataSource) ? input.metadataSource : 'manual'
      },
      locator: {
        pageIndex: input.pageIndex,
        pageLabel: String(input.pageLabel || `PDF 第 ${Number(input.pageIndex) + 1} 页`),
        quoteRaw,
        quoteDisplay,
        rawQuoteSha256: hashText(quoteRaw),
        displayQuoteSha256: hashText(quoteDisplay),
        pageTextSha256: input.pageTextSha256,
        prefix: String(input.prefix || '').normalize('NFC'),
        suffix: String(input.suffix || '').normalize('NFC'),
        occurrenceIndex: input.occurrenceIndex,
        rects: clone(input.rects),
        pageRotation: input.pageRotation,
        cropBox: clone(input.cropBox),
        extractorName: String(input.extractorName || 'pdfjs'),
        extractorVersion: String(input.extractorVersion || '3.11.174'),
        transformVersion: String(input.transformVersion || '1'),
        normalization: input.normalization,
        extraction: 'pdf-text'
      },
      createdBy,
      createdAt
    };
    return { citation, evidenceId, revision };
  }

  async _createEvidence(input, createdBy) {
    const aggregate = await this.repository.loadProject(input.projectId);
    requireRevision(aggregate, input.baseRevision);
    const createdAt = nowIso(this.now);
    const ensured = this._ensureCitationItem(aggregate, input, createdAt);
    input = ensured.input;
    const { evidenceId, revision } = this._selectionRevision(aggregate, input, createdBy, createdAt);
    let card = aggregate.evidenceCards.find(item => item.id === evidenceId);
    if (card && card.status === 'archived') fail('EVIDENCE_ARCHIVED', '已归档证据必须先恢复后再重选');
    if (!card) {
      card = {
        schemaVersion: SCHEMA_VERSION,
        id: evidenceId,
        projectId: input.projectId,
        currentRevisionId: revision.id,
        note: String(input.note || ''),
        tags: [...new Set((input.tags || []).map(String))],
        color: input.color || '#d5a623',
        researchQuestionIds: clone(input.researchQuestionIds || []),
        status: 'active',
        createdAt,
        updatedAt: createdAt
      };
      aggregate.evidenceCards.push(card);
    } else {
      card.currentRevisionId = revision.id;
      card.status = 'active';
      card.updatedAt = createdAt;
    }
    aggregate.evidenceRevisions.push(revision);
    const review = {
      schemaVersion: SCHEMA_VERSION,
      id: this.randomUUID(),
      projectId: input.projectId,
      evidenceId,
      evidenceRevisionId: revision.id,
      sequence: 1,
      previousReviewEventId: null,
      status: createdBy === 'ai' ? 'proposed' : 'confirmed',
      actor: createdBy,
      ...(createdBy === 'ai' ? { sourceAuditResultEventId: input.sourceAuditResultEventId } : {}),
      createdAt
    };
    aggregate.evidenceReviewEvents.push(review);
    if (!aggregate.assetRefs.some(ref => ref.assetId === revision.sourceSnapshot.assetId)) {
      aggregate.assetRefs.push({
        id: revision.sourceSnapshot.assetId,
        assetId: revision.sourceSnapshot.assetId,
        projectId: input.projectId,
        sha256: revision.sourceSnapshot.fileSha256,
        kind: 'pdf'
      });
    }
    validateProjectAggregate(aggregate);
    const saved = await this.repository.saveProject({
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      aggregate,
      source: createdBy === 'ai' ? 'evidence-ai-proposal' : 'evidence-user-selection'
    });
    return { success: true, durable: saved.durable === true, revision: saved.revision, card: clone(card), evidenceRevision: clone(revision), reviewEvent: clone(review) };
  }

  async createEvidenceFromUserSelection(input) {
    if (input.sourceAuditResultEventId !== undefined || input.actor !== undefined || input.status !== undefined) {
      fail('EVIDENCE_AUTHORITY_INVALID', '用户选文接口不接受 actor、status 或 AI 审计字段');
    }
    return this._createEvidence(input, 'user');
  }

  async createProposedEvidenceFromAI(input) {
    if (!input.sourceAuditResultEventId || input.actor !== undefined || input.status !== undefined) {
      fail('EVIDENCE_AUTHORITY_INVALID', 'AI 证据接口只创建 proposed 事件且必须绑定审计结果');
    }
    return this._createEvidence(input, 'ai');
  }

  async reviewProposedEvidenceByUser(input) {
    if (!['confirmed', 'rejected'].includes(input.decision)) fail('EVIDENCE_REVIEW_DECISION_INVALID', '用户审阅只能确认或拒绝');
    const aggregate = await this.repository.loadProject(input.projectId);
    requireRevision(aggregate, input.baseRevision);
    const revision = aggregate.evidenceRevisions.find(item => item.id === input.evidenceRevisionId);
    if (!revision || revision.createdBy !== 'ai') fail('EVIDENCE_REVIEW_NOT_PROPOSED', '只能审阅 AI 提议的证据');
    const chain = reviewChain(aggregate, revision.id);
    if (chain.length !== 1 || chain[0].status !== 'proposed' || input.expectedSequence !== 1) {
      fail('EVIDENCE_REVIEW_TERMINAL', '证据已审阅或审阅序列已变化');
    }
    const event = {
      schemaVersion: SCHEMA_VERSION,
      id: this.randomUUID(),
      projectId: input.projectId,
      evidenceId: revision.evidenceId,
      evidenceRevisionId: revision.id,
      sequence: 2,
      previousReviewEventId: chain[0].id,
      status: input.decision,
      actor: 'user',
      ...(input.reason ? { reason: String(input.reason) } : {}),
      createdAt: nowIso(this.now)
    };
    aggregate.evidenceReviewEvents.push(event);
    validateProjectAggregate(aggregate);
    const saved = await this.repository.saveProject({ projectId: input.projectId, baseRevision: input.baseRevision, aggregate, source: 'evidence-user-review' });
    return { success: true, durable: saved.durable === true, revision: saved.revision, reviewEvent: clone(event) };
  }

  async updateEvidenceCard(input) {
    const aggregate = await this.repository.loadProject(input.projectId);
    requireRevision(aggregate, input.baseRevision);
    const card = aggregate.evidenceCards.find(item => item.id === input.evidenceId);
    if (!card) fail('EVIDENCE_NOT_FOUND', '证据卡不存在');
    if (input.note !== undefined) card.note = String(input.note);
    if (input.tags !== undefined) card.tags = [...new Set(input.tags.map(String))];
    if (input.color !== undefined) card.color = input.color;
    if (input.researchQuestionIds !== undefined) card.researchQuestionIds = clone(input.researchQuestionIds);
    card.updatedAt = nowIso(this.now);
    validateProjectAggregate(aggregate);
    const saved = await this.repository.saveProject({ projectId: input.projectId, baseRevision: input.baseRevision, aggregate, source: 'evidence-card-edit' });
    return { success: true, durable: saved.durable === true, revision: saved.revision, card: clone(card) };
  }

  async listEvidence(projectId) {
    const aggregate = await this.repository.loadProject(projectId);
    const revisionById = new Map(aggregate.evidenceRevisions.map(item => [item.id, item]));
    return {
      projectId,
      revision: aggregate.manifest.revision,
      items: aggregate.evidenceCards.map(card => {
        const revision = revisionById.get(card.currentRevisionId);
        let effectiveStatus = card.status;
        if (effectiveStatus !== 'archived') {
          try {
            const descriptor = this.assetStore.getDescriptor(revision.sourceSnapshot.assetId);
            effectiveStatus = descriptor.sha256 === revision.sourceSnapshot.fileSha256 ? card.status : 'source-mismatch';
          } catch {
            effectiveStatus = 'source-missing';
          }
        }
        const citationCount = aggregate.citationLinks.filter(link =>
          link.items?.some(entry => entry.evidenceRevisionIds?.some(id =>
            aggregate.evidenceRevisions.find(candidate => candidate.id === id)?.evidenceId === card.id))).length;
        return { card: clone(card), revision: clone(revision), effectiveStatus, reviewStatus: derivedReviewStatus(aggregate, revision.id), citationCount };
      })
    };
  }

  async archiveEvidence(input) {
    const aggregate = await this.repository.loadProject(input.projectId);
    requireRevision(aggregate, input.baseRevision);
    const card = aggregate.evidenceCards.find(item => item.id === input.evidenceId);
    if (!card) fail('EVIDENCE_NOT_FOUND', '证据卡不存在');
    const revisionIds = new Set(aggregate.evidenceRevisions.filter(item => item.evidenceId === card.id).map(item => item.id));
    const impactedLinks = aggregate.citationLinks.filter(link => link.items?.some(entry => entry.evidenceRevisionIds?.some(id => revisionIds.has(id))));
    if (input.confirmed !== true) return { requiresConfirmation: true, citationCount: impactedLinks.length };
    const timestamp = nowIso(this.now);
    card.status = 'archived';
    card.archivedAt = timestamp;
    card.updatedAt = timestamp;
    impactedLinks.forEach(link => link.items.forEach(entry => {
      if (entry.evidenceRevisionIds.some(id => revisionIds.has(id))) entry.status = 'evidence-missing';
    }));
    validateProjectAggregate(aggregate);
    const saved = await this.repository.saveProject({ projectId: input.projectId, baseRevision: input.baseRevision, aggregate, source: 'evidence-archive' });
    return { success: true, durable: saved.durable === true, revision: saved.revision, citationCount: impactedLinks.length };
  }

  async prepareEvidenceCitation(input) {
    this._cleanupSessions();
    const aggregate = await this.repository.loadProject(input.projectId);
    requireRevision(aggregate, input.baseRevision);
    if (!['quote', 'paraphrase', 'citation-only'].includes(input.insertionMode)) fail('EVIDENCE_INSERTION_MODE_INVALID', '证据插入方式无效');
    const revisions = input.evidenceRevisionIds.map(id => aggregate.evidenceRevisions.find(item => item.id === id));
    if (revisions.some(item => !item)) fail('EVIDENCE_REVISION_NOT_FOUND', '引用包含不存在的证据版本');
    if (input.insertionMode === 'quote' && revisions.some(item => derivedReviewStatus(aggregate, item.id) !== 'confirmed')) {
      fail('EVIDENCE_DIRECT_QUOTE_NOT_CONFIRMED', '原文引用只能使用已确认的证据');
    }
    if (revisions.some(item => aggregate.evidenceCards.find(card => card.id === item.evidenceId)?.status === 'archived')) {
      fail('EVIDENCE_ARCHIVED', '已归档证据不能插入正文');
    }
    const timestamp = nowIso(this.now);
    const byCitation = new Map();
    revisions.forEach(revision => {
      if (!byCitation.has(revision.citationItemId)) byCitation.set(revision.citationItemId, []);
      byCitation.get(revision.citationItemId).push(revision);
    });
    const linkId = this.randomUUID();
    const link = {
      schemaVersion: SCHEMA_VERSION,
      id: linkId,
      projectId: input.projectId,
      insertionMode: input.insertionMode,
      items: [...byCitation.entries()].map(([itemId, itemRevisions], order) => ({
        citationItemEntryId: this.randomUUID(),
        citationItemId: itemId,
        evidenceRevisionIds: itemRevisions.map(item => item.id),
        sourceCitationSnapshots: itemRevisions.map(item => sourceSnapshotForRevision(item, null, timestamp)),
        ...(itemRevisions.length ? {
          locator: itemRevisions.map(item => item.locator.pageLabel.replace(/^PDF 第 | 页$/g, '')).join(', '),
          label: 'page'
        } : {}),
        suppressAuthor: false,
        order,
        status: 'active'
      })),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const sessionId = this.randomUUID();
    this.citationSessions.set(sessionId, { projectId: input.projectId, baseRevision: input.baseRevision, link, expiresAt: Date.now() + SESSION_TTL_MS });
    return { sessionId, citationInstanceId: linkId, link: clone(link) };
  }

  async commitEvidenceCitation(input) {
    this._cleanupSessions();
    const session = this.citationSessions.get(input.sessionId);
    if (!session || session.projectId !== input.projectId) fail('EVIDENCE_CITATION_SESSION_EXPIRED', '证据引用会话不存在或已过期');
    const aggregate = await this.repository.loadProject(input.projectId);
    requireRevision(aggregate, session.baseRevision);
    const anchor = `data-citation-instance-id="${session.link.id}"`;
    if (typeof input.documentHtml !== 'string' || !input.documentHtml.includes(anchor)) {
      fail('EVIDENCE_CITATION_ANCHOR_MISSING', '正文未包含准备好的稳定引用实例');
    }
    aggregate.document.html = input.documentHtml;
    aggregate.citationLinks.push(clone(session.link));
    validateProjectAggregate(aggregate);
    const saved = await this.repository.saveProject({ projectId: input.projectId, baseRevision: session.baseRevision, aggregate, source: 'evidence-citation-insert' });
    this.citationSessions.delete(input.sessionId);
    return { success: true, durable: saved.durable === true, revision: saved.revision, link: clone(session.link) };
  }
}

module.exports = {
  EvidenceService,
  EvidenceServiceError,
  derivedReviewStatus,
  hashText,
  normalizeQuote
};
