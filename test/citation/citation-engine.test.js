'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CitationEngineError,
  listLockedStyles,
  loadStyleLock,
  normalizeCluster,
  renderCitationDocument
} = require('../../src/main/citation/engine');
const { auditCitations } = require('../../src/main/citation/audit');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-output.json'), 'utf8'));

test('six locked official CSL styles match independently fixed golden output', () => {
  const styles = listLockedStyles();
  assert.deepEqual(styles.map(style => style.styleId), Object.keys(fixture.expected));
  assert.equal(styles.filter(style => style.citationFormat === 'numeric').length, 2);
  for (const style of styles) {
    const rendered = renderCitationDocument({
      items: fixture.items,
      clusters: fixture.clusters,
      styleId: style.styleId,
      format: 'text'
    });
    assert.equal(rendered.citationFormat, fixture.expected[style.styleId].citationFormat);
    assert.deepEqual(rendered.citations.map(value => value.body), fixture.expected[style.styleId].citations);
    assert.deepEqual(rendered.bibliography.entries.map(value => value.body), fixture.expected[style.styleId].bibliography);
  }
});

test('numeric styles reuse numbering while author-date styles never force square numbers', () => {
  for (const style of listLockedStyles()) {
    const rendered = renderCitationDocument({ items: fixture.items, clusters: fixture.clusters, styleId: style.styleId, format: 'text' });
    if (style.citationFormat === 'numeric') {
      assert.match(rendered.citations[1].body, /1/);
      assert.equal((rendered.bibliography.body.match(/\[1\]/g) || []).length, 1);
    } else {
      assert.doesNotMatch(rendered.citations[1].body, /^\[\d+\]$/);
    }
  }
});

test('HTML rendering uses the same clusters and returns cited bibliography entries only', () => {
  const rendered = renderCitationDocument({ items: fixture.items, clusters: [fixture.clusters[1]], styleId: 'apa-7', format: 'html' });
  assert.match(rendered.citations[0].body, /Wang/);
  assert.equal(rendered.bibliography.entries.length, 1);
  assert.deepEqual(rendered.bibliography.entries[0].citationItemIds, [fixture.items[0].citationItemId]);
  assert.match(rendered.bibliography.body, /csl-entry/);
});

test('empty document has no bibliography and style lock records exact identity and resources', () => {
  const lock = loadStyleLock();
  assert.equal(lock.styles['chicago-17-author-date'].edition, '17th');
  assert.equal(lock.styles['gb-t-7714-2015-numeric'].citationFormat, 'numeric');
  assert.match(lock.locales['zh-CN'].sha256, /^[0-9a-f]{64}$/);
  const rendered = renderCitationDocument({ items: fixture.items, clusters: [], styleId: 'ieee', format: 'text' });
  assert.deepEqual(rendered.citations, []);
  assert.deepEqual(rendered.bibliography.entries, []);
});

test('cluster validation rejects missing items, invalid locators, duplicate entries and duplicate cluster ids', () => {
  const ids = new Set(fixture.items.map(item => item.citationItemId));
  assert.throws(() => normalizeCluster(null, 0, ids), error => error.code === 'CITATION_CLUSTER_INVALID');
  assert.throws(() => normalizeCluster({ items: [{}] }, 0, ids), error => error.code === 'CITATION_CLUSTER_ID_INVALID');
  assert.throws(() => normalizeCluster({ id: 'x', items: [{ citationItemId: 'missing' }] }, 0, ids), error => error.code === 'CITATION_ITEM_MISSING');
  assert.throws(() => normalizeCluster({ id: 'x', items: [{ citationItemId: fixture.items[0].citationItemId, locator: '1' }] }, 0, ids), error => error.code === 'CITATION_LOCATOR_INVALID');
  assert.throws(() => normalizeCluster({ id: 'x', items: [{ citationItemId: fixture.items[0].citationItemId, label: 'page' }] }, 0, ids), error => error.code === 'CITATION_LOCATOR_INVALID');
  assert.throws(() => normalizeCluster({ id: 'x', items: [{ citationItemId: fixture.items[0].citationItemId, locator: '1', label: 'unknown' }] }, 0, ids), error => error.code === 'CITATION_LOCATOR_INVALID');
  const duplicateEntries = { id: 'x', items: [
    { citationItemEntryId: 'same', citationItemId: fixture.items[0].citationItemId, order: 0 },
    { citationItemEntryId: 'same', citationItemId: fixture.items[1].citationItemId, order: 0 }
  ] };
  assert.throws(() => normalizeCluster(duplicateEntries, 0, ids), error => error.code === 'CITATION_CLUSTER_DUPLICATE_ENTRY');
  assert.throws(() => renderCitationDocument({ items: fixture.items, clusters: [fixture.clusters[0], fixture.clusters[0]], styleId: 'apa-7' }), error => error.code === 'CITATION_CLUSTER_DUPLICATE_ID');
});

test('render input rejects unknown styles/locales/formats, duplicate items and missing arrays', () => {
  const base = { items: fixture.items, clusters: fixture.clusters };
  assert.throws(() => renderCitationDocument({ ...base, styleId: 'unknown' }), error => error.code === 'CITATION_STYLE_UNKNOWN');
  assert.throws(() => renderCitationDocument({ ...base, styleId: 'apa-7', locale: 'xx-XX' }), error => error.code === 'CITATION_LOCALE_UNKNOWN');
  assert.throws(() => renderCitationDocument({ ...base, styleId: 'apa-7', format: 'rtf' }), error => error.code === 'CITATION_OUTPUT_FORMAT_INVALID');
  assert.throws(() => renderCitationDocument({ styleId: 'apa-7' }), error => error.code === 'CITATION_RENDER_INPUT_INVALID');
  assert.throws(() => renderCitationDocument({ ...base, items: [fixture.items[0], fixture.items[0]], styleId: 'apa-7' }), error => error.code === 'CITATION_ITEM_DUPLICATE_ID');
  assert.throws(() => renderCitationDocument({ ...base, items: [{ title: 'missing id' }], styleId: 'apa-7' }), error => error.code === 'CITATION_ITEM_ID_INVALID');
  assert.ok(new CitationEngineError('X', 'message').details);
});

test('citation audit distinguishes blocking defects from warnings and states retraction limitation', () => {
  const items = [
    { ...fixture.items[0], metadataProvenance: { source: 'imported', originalFormat: 'bibtex' } },
    { ...fixture.items[1], DOI: '10.5555/alpha', title: fixture.items[0].title }
  ];
  const clusters = [{ id: 'dangling', items: [{ citationItemId: 'missing' }] }];
  const result = auditCitations({ items, clusters });
  assert.equal(result.ok, false);
  assert.ok(result.blockingCount > 0);
  assert.ok(result.issues.some(issue => issue.code === 'DANGLING_CITATION'));
  assert.ok(result.issues.some(issue => issue.code === 'UNCITED_ITEM'));
  assert.ok(result.issues.some(issue => issue.code === 'DUPLICATE_DOI'));
  assert.ok(result.issues.some(issue => issue.code === 'DUPLICATE_TITLE'));
  assert.ok(result.issues.some(issue => issue.code === 'IMPORTED_IDENTITY_UNVERIFIED'));
  assert.ok(result.issues.some(issue => issue.code === 'RETRACTION_STATUS_NOT_CHECKED' && /未检查/.test(issue.message)));
});

test('citation audit accepts linked items but warns on missing non-blocking CSL fields', () => {
  const items = [{ citationItemId: 'a', type: 'book', title: 'A' }];
  const result = auditCitations({ items, clusters: [{ id: 'c', items: [{ citationItemId: 'a' }] }] });
  assert.equal(result.ok, true);
  assert.equal(result.blockingCount, 0);
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_CSL_FIELD' && issue.field === 'author'));
});

test('citation audit handles empty input, alternate stable IDs and verified imports', () => {
  const empty = auditCitations();
  assert.equal(empty.ok, true);
  assert.equal(empty.issues.length, 1);
  const items = [
    { libraryItemId: 'library-a', type: 'book', title: 'Unique A', author: [{ literal: 'Org' }], issued: { 'date-parts': [[2024]] }, metadataProvenance: { source: 'imported' }, verifiedAt: '2026-07-16T00:00:00.000Z' },
    { id: 'external-b', type: '', title: '', author: [], issued: null }
  ];
  const result = auditCitations({ items, clusters: [{ id: 'cluster', items: [{ id: 'library-a' }, { id: 'external-b' }] }] });
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_CSL_FIELD' && issue.field === 'type' && issue.severity === 'blocking'));
  assert.ok(result.issues.some(issue => issue.code === 'MISSING_CSL_FIELD' && issue.field === 'title' && issue.severity === 'blocking'));
  assert.equal(result.issues.some(issue => issue.code === 'IMPORTED_IDENTITY_UNVERIFIED'), false);
});

test('citation audit locates broken evidence revisions, degraded sources, invalid locators and quote hashes', () => {
  const quote = 'Traceable evidence quote';
  const clusters = [{
    id: 'quote-link',
    insertionMode: 'quote',
    items: [{
      citationItemEntryId: 'entry-a',
      citationItemId: 'a',
      evidenceRevisionIds: ['revision-a', 'revision-missing'],
      sourceCitationSnapshots: [{ quoteText: 'different quote' }, {}]
    }]
  }, {
    id: 'empty-quote-link',
    insertionMode: 'quote',
    items: [{ citationItemEntryId: 'entry-b', citationItemId: 'a', evidenceRevisionIds: [], sourceCitationSnapshots: [] }]
  }];
  const result = auditCitations({
    items: [{ citationItemId: 'a', type: 'article-journal', title: 'Source', author: [{ literal: 'Lab' }], issued: { 'date-parts': [[2026]] } }],
    clusters,
    evidenceCards: [{ id: 'evidence-a', status: 'archived' }],
    evidenceRevisions: [{
      id: 'revision-a',
      evidenceId: 'evidence-a',
      locator: { pageIndex: null, pageLabel: '', quoteDisplay: quote, displayQuoteSha256: '0'.repeat(64) }
    }],
    evidenceSourceStates: { 'revision-a': { status: 'source-mismatch' } }
  });
  const codes = new Set(result.issues.map(issue => issue.code));
  for (const code of [
    'EVIDENCE_ARCHIVED',
    'EVIDENCE_SOURCE_MISMATCH',
    'DIRECT_QUOTE_LOCATOR_MISSING',
    'EVIDENCE_QUOTE_HASH_MISMATCH',
    'CITATION_SNAPSHOT_QUOTE_MISMATCH',
    'EVIDENCE_REVISION_MISSING',
    'DIRECT_QUOTE_EVIDENCE_MISSING'
  ]) assert.equal(codes.has(code), true, code);
  assert.equal(result.ok, false);
  assert.ok(result.issues.every(issue => issue.code === 'RETRACTION_STATUS_NOT_CHECKED' || issue.citationInstanceId));
});

test('citation audit accepts a healthy evidence-bound direct quote', () => {
  const quote = 'Traceable evidence quote';
  const displayQuoteSha256 = crypto.createHash('sha256').update(quote).digest('hex');
  const result = auditCitations({
    items: [{ citationItemId: 'a', type: 'article-journal', title: 'Source', author: [{ literal: 'Lab' }], issued: { 'date-parts': [[2026]] } }],
    clusters: [{
      id: 'quote-link',
      insertionMode: 'quote',
      items: [{
        citationItemEntryId: 'entry-a',
        citationItemId: 'a',
        evidenceRevisionIds: ['revision-a'],
        sourceCitationSnapshots: [{ quoteText: quote }]
      }]
    }],
    evidenceCards: [{ id: 'evidence-a', status: 'active' }],
    evidenceRevisions: [{
      id: 'revision-a',
      evidenceId: 'evidence-a',
      locator: { pageIndex: 0, pageLabel: 'PDF 第 1 页', quoteDisplay: quote, displayQuoteSha256 }
    }],
    evidenceSourceStates: { 'revision-a': { status: 'active' } }
  });
  assert.equal(result.blockingCount, 0);
});
