'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CitationModelError,
  normalizeCitationItem,
  normalizeDate,
  normalizeDoi,
  normalizeName,
  semanticDigest,
  semanticKey,
  legacyPaperToCsl,
  toCslJson
} = require('../../src/main/citation/model');
const { conflictFields, mergeItems, planImportMerge } = require('../../src/main/citation/merge');

const NOW = '2026-07-16T00:00:00.000Z';
const LATER = '2026-07-16T01:00:00.000Z';
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const C = '10000000-0000-4000-8000-000000000003';

function base(overrides = {}) {
  return {
    libraryItemId: A,
    type: 'article-journal',
    title: '  合成研究\r\nSynthetic Study  ',
    author: [{ family: '王', given: '伟' }, { literal: '研究机构' }],
    issued: { 'date-parts': [[2025, 7, 16]] },
    DOI: 'https://doi.org/10.5555/EssayFlow.Test',
    URL: 'https://example.invalid/paper#fragment',
    metadataProvenance: { source: 'manual', fields: { title: 'manual' } },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

test('normalization keeps structured people, institution author, Unicode and provenance', () => {
  const item = normalizeCitationItem(base({
    editor: [{ family: 'Editor', given: 'Erin', suffix: 'Jr.' }],
    accessed: { 'date-parts': [[2026, 7, 16]] },
    tags: ['证据', '证据', 'review'],
    starred: true,
    privateNote: '',
    fieldConfidence: { title: 1, DOI: 0.8 },
    verifiedAt: NOW
  }), { now: () => NOW });
  assert.equal(item.title, '合成研究\nSynthetic Study');
  assert.equal(item.DOI, '10.5555/essayflow.test');
  assert.equal(item.URL, 'https://example.invalid/paper');
  assert.deepEqual(item.author[1], { literal: '研究机构' });
  assert.deepEqual(item.tags, ['review', '证据']);
  assert.equal(item.metadataProvenance.fields.title, 'manual');
  assert.equal(item.fieldConfidence.DOI, 0.8);
});

test('external non-UUID IDs become legacySourceId while app UUIDs remain stable', () => {
  const item = normalizeCitationItem({ id: 'Bib-Key-一', type: 'book', title: 'Book' }, { idFactory: () => A, now: () => NOW, sourceFormat: 'bibtex' });
  assert.equal(item.libraryItemId, A);
  assert.equal(item.legacySourceId, 'Bib-Key-一');
  assert.equal(item.metadataProvenance.originalFormat, 'bibtex');
  const restored = normalizeCitationItem({ id: B, type: 'book', title: 'Book' }, { idFactory: () => C, now: () => NOW });
  assert.equal(restored.libraryItemId, B);
});

test('DOI and semantic identity normalize prefixes, case and title punctuation', () => {
  assert.equal(normalizeDoi(' DOI: 10.1000/ABC.1 '), '10.1000/abc.1');
  assert.equal(semanticKey(base()), 'doi:10.5555/essayflow.test');
  const noDoiA = base({ DOI: undefined, title: 'A Study: of Tests!' });
  const noDoiB = base({ libraryItemId: B, DOI: undefined, title: 'a study of tests', author: [{ family: '王' }] });
  assert.equal(semanticKey(noDoiA), semanticKey(noDoiB));
});

test('semantic digest ignores operational metadata but detects CSL changes', () => {
  const first = base();
  const operationalChange = base({ tags: ['x'], starred: true, privateNote: 'note', updatedAt: LATER });
  assert.equal(semanticDigest(first), semanticDigest(operationalChange));
  assert.notEqual(semanticDigest(first), semanticDigest(base({ volume: '2' })));
  const csl = toCslJson(first);
  assert.equal(csl.id, A);
  assert.equal(csl.DOI, '10.5555/essayflow.test');
  assert.equal(csl.privateNote, undefined);
});

test('name, date, DOI, URL, type, confidence and timestamp failures are explicit', () => {
  const failures = [
    [() => normalizeName('Wang', 'author[0]'), 'CITATION_NAME_INVALID'],
    [() => normalizeName({ literal: 'Org', family: 'Org' }, 'author[0]'), 'CITATION_NAME_AMBIGUOUS'],
    [() => normalizeName({}, 'author[0]'), 'CITATION_NAME_INVALID'],
    [() => normalizeDate({ 'date-parts': [[2025, 13]] }, 'issued'), 'CITATION_DATE_INVALID'],
    [() => normalizeDate({}, 'issued'), 'CITATION_DATE_INVALID'],
    [() => normalizeDoi('invalid'), 'CITATION_DOI_INVALID'],
    [() => normalizeCitationItem(base({ URL: 'file:///secret' })), 'CITATION_URL_INVALID'],
    [() => normalizeCitationItem(base({ URL: 'https://user:pass@example.com' })), 'CITATION_URL_INVALID'],
    [() => normalizeCitationItem(base({ type: 'unknown-type' })), 'CITATION_TYPE_INVALID'],
    [() => normalizeCitationItem(base({ fieldConfidence: { title: 2 } })), 'CITATION_CONFIDENCE_INVALID'],
    [() => normalizeCitationItem(base({ updatedAt: '2026-07-16' })), 'CITATION_TIMESTAMP_INVALID'],
    [() => normalizeCitationItem(base({ title: '' })), 'CITATION_TEXT_INVALID']
  ];
  for (const [operation, code] of failures) assert.throws(operation, error => error instanceof CitationModelError && error.code === code);
});

test('merge planner prioritizes DOI, reports manual conflicts and duplicate incoming identities', () => {
  const existing = base({ title: 'Local title', metadataProvenance: { source: 'manual', fields: { title: 'manual' } } });
  const incoming = base({ libraryItemId: B, title: 'Imported title', abstract: 'More complete', metadataProvenance: { source: 'imported' } });
  const duplicateIncoming = base({ libraryItemId: C, title: 'Duplicate import' });
  const plan = planImportMerge([existing], [incoming, duplicateIncoming], { now: () => NOW });
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.matches.length, 1);
  assert.equal(plan.matches[0].reason, 'doi');
  assert.equal(plan.matches[0].conflicts.find(value => value.field === 'title').requiresUserChoice, true);
  assert.equal(plan.duplicateIncoming.length, 1);
});

test('merge planner adds unknown identities and reports ambiguous existing duplicates', () => {
  const duplicateExisting = base({ libraryItemId: B });
  const incomingKnown = base({ libraryItemId: C });
  const incomingNew = base({ libraryItemId: '10000000-0000-4000-8000-000000000004', DOI: '10.5555/new', title: 'New' });
  const plan = planImportMerge([base(), duplicateExisting], [incomingKnown, incomingNew], { now: () => NOW });
  assert.equal(plan.additions.length, 1);
  assert.deepEqual(plan.matches[0].ambiguousExistingIds, [B]);
});

test('merge preserves local values by default and combines operational metadata', () => {
  const existing = base({ tags: ['local'], starred: false, privateNote: 'local note', assetRefs: [{ assetId: A }] });
  const incoming = base({ libraryItemId: B, title: 'Remote title', tags: ['remote'], starred: true, privateNote: 'remote note', assetRefs: [{ assetId: B }], abstract: 'Added' });
  const conflicts = conflictFields(normalizeCitationItem(existing), normalizeCitationItem(incoming));
  assert.ok(conflicts.some(value => value.field === 'title'));
  const mergedDefault = mergeItems(existing, incoming, {}, { now: () => LATER });
  assert.equal(mergedDefault.libraryItemId, A);
  assert.equal(mergedDefault.title, '合成研究\nSynthetic Study');
  assert.equal(mergedDefault.abstract, 'Added');
  assert.deepEqual(mergedDefault.tags, ['local', 'remote']);
  assert.equal(mergedDefault.starred, true);
  assert.match(mergedDefault.privateNote, /local note\n\nremote note/);
  assert.equal(mergedDefault.assetRefs.length, 2);
  const mergedChosen = mergeItems(existing, incoming, { title: 'incoming' }, { now: () => LATER });
  assert.equal(mergedChosen.title, 'Remote title');
  assert.equal(mergedChosen.metadataProvenance.fields.title, 'manual');
  assert.throws(() => mergeItems(existing, incoming, { title: 'invalid' }, { now: () => LATER }), /选择无效/);
});

test('merge rejects items with different semantic identities', () => {
  assert.throws(() => mergeItems(base(), base({ libraryItemId: B, DOI: '10.5555/other' }), {}, { now: () => NOW }), /身份键不同/);
});

test('legacy search records become structured CSL without flattening institution text further', () => {
  const csl = legacyPaperToCsl({
    title: 'Legacy result',
    authors: 'Fixture Research Institute',
    published: 'Published 2024-05-10',
    journal: 'Legacy Journal',
    doi: 'https://doi.org/10.5555/Legacy',
    link: 'https://example.invalid/legacy'
  }, { citationItemId: A, now: () => NOW });
  assert.equal(csl.id, A);
  assert.deepEqual(csl.author, [{ literal: 'Fixture Research Institute' }]);
  assert.deepEqual(csl.issued['date-parts'], [[2024]]);
  assert.equal(csl['container-title'], 'Legacy Journal');
  assert.equal(csl.DOI, '10.5555/legacy');
});

test('legacy conversion covers arrays, aliases and optional bibliographic fields', () => {
  const csl = legacyPaperToCsl({
    title: 'Conference item',
    type: 'conference',
    authors: [{ family: 'Wang', given: 'Wei' }, 'Fixture Org'],
    year: 2023,
    source: 'Proceedings',
    publisher: 'Press',
    volume: 2,
    issue: 4,
    pages: '11-19',
    DOI: '10.5555/conference',
    URL: 'https://example.invalid/conference',
    abstract: 'Abstract',
    language: 'en',
    metadataProvenance: { source: 'api' },
    verifiedAt: NOW
  }, { citationItemId: A, now: () => NOW, sourceFormat: 'api' });
  assert.equal(csl.type, 'paper-conference');
  assert.deepEqual(csl.author, [{ family: 'Wang', given: 'Wei' }, { literal: 'Fixture Org' }]);
  assert.equal(csl.publisher, 'Press');
  assert.equal(csl.volume, '2');
  assert.equal(csl.issue, '4');
  assert.equal(csl.page, '11-19');
  assert.equal(csl.abstract, 'Abstract');
  assert.equal(csl.language, 'en');

  const minimal = legacyPaperToCsl({ title: 'Unknown kind', type: 'not-known' }, { citationItemId: B, now: () => NOW });
  assert.equal(minimal.type, 'article-journal');
  assert.equal(minimal.author, undefined);
  assert.equal(minimal.issued, undefined);
});

test('normalizer edge matrix rejects malformed containers and accepts full CSL name/date variants', () => {
  assert.throws(() => normalizeCitationItem(null), error => error.code === 'CITATION_ITEM_INVALID');
  assert.throws(() => normalizeCitationItem(base({ libraryItemId: 'not-a-uuid' })), error => error.code === 'CITATION_UUID_INVALID');
  assert.throws(() => normalizeCitationItem(base({ URL: 'not a url' })), error => error.code === 'CITATION_URL_INVALID');
  assert.throws(() => normalizeCitationItem(base({ author: 'Wang' })), error => error.code === 'CITATION_NAME_INVALID');
  assert.throws(() => normalizeCitationItem(base({ tags: 'tag' })), error => error.code === 'CITATION_ARRAY_INVALID');
  assert.throws(() => normalizeCitationItem(base({ assetRefs: {} })), error => error.code === 'CITATION_ARRAY_INVALID');
  assert.throws(() => normalizeDate('2024', 'issued'), error => error.code === 'CITATION_DATE_INVALID');
  assert.throws(() => normalizeDate({ 'date-parts': [] }, 'issued'), error => error.code === 'CITATION_DATE_INVALID');
  assert.throws(() => normalizeDate({ 'date-parts': [[]] }, 'issued'), error => error.code === 'CITATION_DATE_INVALID');
  const name = normalizeName({ family: 'de Test', given: 'A', 'non-dropping-particle': 'de', 'comma-suffix': true, 'static-ordering': false }, 'author');
  assert.equal(name['non-dropping-particle'], 'de');
  assert.equal(name['comma-suffix'], true);
  const date = normalizeDate({ literal: 'Spring 2024', raw: '2024-21', season: '1', circa: true }, 'issued');
  assert.equal(date.literal, 'Spring 2024');
  assert.equal(date.circa, true);
});
