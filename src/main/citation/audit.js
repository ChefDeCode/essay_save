'use strict';

const crypto = require('node:crypto');

const { normalizedTitle } = require('./model');

function itemId(item) {
  return String(item.citationItemId || item.libraryItemId || item.id || '');
}

function addIssue(state, severity, code, message, details = {}) {
  state.push({ severity, code, message, ...details });
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function evidenceLocation(cluster, entry, revision, revisionId) {
  return {
    citationInstanceId: cluster.id,
    citationItemEntryId: entry.citationItemEntryId,
    citationItemId: entry.citationItemId,
    evidenceRevisionId: revisionId,
    ...(revision?.evidenceId ? { evidenceId: revision.evidenceId } : {})
  };
}

function auditEvidence(options, issues, clusters) {
  const cards = Array.isArray(options.evidenceCards) ? options.evidenceCards : [];
  const revisions = Array.isArray(options.evidenceRevisions) ? options.evidenceRevisions : [];
  const sourceStates = options.evidenceSourceStates && typeof options.evidenceSourceStates === 'object'
    ? options.evidenceSourceStates
    : {};
  const cardsById = new Map(cards.map(card => [String(card.id), card]));
  const revisionsById = new Map(revisions.map(revision => [String(revision.id), revision]));

  for (const cluster of clusters) {
    for (const entry of cluster.items || []) {
      const revisionIds = Array.isArray(entry.evidenceRevisionIds) ? entry.evidenceRevisionIds.map(String) : [];
      const snapshots = Array.isArray(entry.sourceCitationSnapshots) ? entry.sourceCitationSnapshots : [];
      if (cluster.insertionMode === 'quote' && revisionIds.length === 0) {
        addIssue(issues, 'blocking', 'DIRECT_QUOTE_EVIDENCE_MISSING', '直接引语没有绑定证据版本', {
          citationInstanceId: cluster.id,
          citationItemEntryId: entry.citationItemEntryId,
          citationItemId: entry.citationItemId
        });
      }
      revisionIds.forEach((revisionId, index) => {
        const revision = revisionsById.get(revisionId);
        const location = evidenceLocation(cluster, entry, revision, revisionId);
        if (!revision) {
          addIssue(issues, 'blocking', 'EVIDENCE_REVISION_MISSING', '正文引用绑定的证据版本不存在', location);
          return;
        }
        const card = cardsById.get(String(revision.evidenceId));
        if (!card) {
          addIssue(issues, 'blocking', 'EVIDENCE_CARD_MISSING', '证据版本所属证据卡不存在', location);
        } else if (card.status === 'archived') {
          addIssue(issues, 'blocking', 'EVIDENCE_ARCHIVED', '正文引用绑定的证据已归档', location);
        }

        const sourceStatus = sourceStates[revisionId]?.status || card?.status || 'active';
        const sourceCodes = {
          'source-missing': ['EVIDENCE_SOURCE_MISSING', '证据来源 PDF 已缺失'],
          'source-mismatch': ['EVIDENCE_SOURCE_MISMATCH', '证据来源 PDF 哈希与创建时不一致'],
          'anchor-missing': ['EVIDENCE_ANCHOR_MISSING', '证据原文锚点已失效']
        };
        if (sourceCodes[sourceStatus]) {
          addIssue(issues, 'blocking', sourceCodes[sourceStatus][0], sourceCodes[sourceStatus][1], location);
        }

        if (cluster.insertionMode === 'quote' &&
            (!revision.locator || !Number.isSafeInteger(revision.locator.pageIndex) || !String(revision.locator.pageLabel || '').trim())) {
          addIssue(issues, 'blocking', 'DIRECT_QUOTE_LOCATOR_MISSING', '直接引语缺少可定位的页码信息', location);
        }
        const quoteDisplay = revision.locator?.quoteDisplay;
        const displayHash = revision.locator?.displayQuoteSha256;
        if (typeof quoteDisplay !== 'string' || !displayHash || sha256Text(quoteDisplay) !== displayHash) {
          addIssue(issues, 'blocking', 'EVIDENCE_QUOTE_HASH_MISMATCH', '证据显示原文与不可变哈希不一致', location);
        }
        const snapshot = snapshots[index];
        if (snapshot?.quoteText && displayHash && sha256Text(snapshot.quoteText) !== displayHash) {
          addIssue(issues, 'blocking', 'CITATION_SNAPSHOT_QUOTE_MISMATCH', '引用保存的来源快照与证据原文不一致', location);
        }
      });
    }
  }
}

function auditCitations(options = {}) {
  const items = Array.isArray(options.items) ? options.items : [];
  const clusters = Array.isArray(options.clusters) ? options.clusters : [];
  const issues = [];
  const byId = new Map(items.map(item => [itemId(item), item]));
  const citedIds = new Set();
  for (const cluster of clusters) {
    for (const entry of cluster.items || []) {
      const citationItemId = String(entry.citationItemId || entry.id || '');
      citedIds.add(citationItemId);
      if (!byId.has(citationItemId)) {
        addIssue(issues, 'blocking', 'DANGLING_CITATION', '正文引用没有对应文献项', {
          citationInstanceId: cluster.id,
          citationItemId
        });
      }
    }
  }
  const doiGroups = new Map();
  const titleGroups = new Map();
  for (const item of items) {
    const id = itemId(item);
    if (!citedIds.has(id)) addIssue(issues, 'warning', 'UNCITED_ITEM', '文献项未在正文中引用', { citationItemId: id });
    for (const field of ['type', 'title', 'author', 'issued']) {
      if (item[field] === undefined || item[field] === null || item[field] === '' || (Array.isArray(item[field]) && !item[field].length)) {
        addIssue(issues, field === 'title' || field === 'type' ? 'blocking' : 'warning', 'MISSING_CSL_FIELD', `文献缺少关键 CSL 字段: ${field}`, {
          citationItemId: id,
          field
        });
      }
    }
    if (item.DOI) {
      const doi = String(item.DOI).toLowerCase();
      if (!doiGroups.has(doi)) doiGroups.set(doi, []);
      doiGroups.get(doi).push(id);
    }
    const title = normalizedTitle(item.title);
    if (title) {
      if (!titleGroups.has(title)) titleGroups.set(title, []);
      titleGroups.get(title).push(id);
    }
    const provenanceSource = item.metadataProvenance?.source;
    if ((provenanceSource === 'imported' || item.metadataProvenance?.originalFormat) && !item.verifiedAt) {
      addIssue(issues, 'warning', 'IMPORTED_IDENTITY_UNVERIFIED', '文献身份来自用户导入且尚未核对出版来源', {
        citationItemId: id
      });
    }
  }
  for (const [doi, ids] of doiGroups) {
    if (ids.length > 1) addIssue(issues, 'warning', 'DUPLICATE_DOI', `发现重复 DOI: ${doi}`, { citationItemIds: ids });
  }
  for (const [title, ids] of titleGroups) {
    if (ids.length > 1) addIssue(issues, 'warning', 'DUPLICATE_TITLE', '发现规范化标题重复', { normalizedTitle: title, citationItemIds: ids });
  }
  auditEvidence(options, issues, clusters);
  addIssue(issues, 'warning', 'RETRACTION_STATUS_NOT_CHECKED', '未检查撤稿/更正状态');
  const blockingCount = issues.filter(issue => issue.severity === 'blocking').length;
  return {
    schemaVersion: 1,
    ok: blockingCount === 0,
    blockingCount,
    warningCount: issues.length - blockingCount,
    issues
  };
}

module.exports = { auditCitations };
