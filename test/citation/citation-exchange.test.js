'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CitationExchangeError,
  LOSS_MATRIX,
  buildLossReport,
  exportCitationItems,
  importCitationText,
  normalizeFormat,
  parseCslJson
} = require('../../src/main/citation/exchange');
const { semanticDigest } = require('../../src/main/citation/model');

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'citations');
const NOW = '2026-07-16T00:00:00.000Z';

function idFactory() {
  let index = 0;
  return () => `00000000-0000-4000-8000-${String(++index).padStart(12, '0')}`;
}

function importFixture(format, extension) {
  return importCitationText(fs.readFileSync(path.join(FIXTURES, `academic.${extension}`), 'utf8'), format, {
    idFactory: idFactory(),
    now: () => NOW
  });
}

test('BibTeX, RIS and CSL-JSON imports preserve mapped academic fields and Unicode', () => {
  const variants = [importFixture('bibtex', 'bib'), importFixture('ris', 'ris'), importFixture('csl-json', 'csl.json')];
  for (const imported of variants) {
    assert.equal(imported.itemCount, 6);
    assert.equal(imported.rejectedCount, 0);
    assert.equal(imported.items[0].title, '合成证据研究 Synthetic Evidence Study');
    assert.equal(imported.items[0].DOI, '10.5555/essayflow.article');
    assert.equal(imported.items[0]['container-title'], 'Fixture Journal');
    assert.deepEqual(imported.items[0].issued['date-parts'], [[2025]]);
    assert.equal(imported.items[0].author.length, 3);
    assert.equal(imported.items[1].editor[0].family, 'Example');
    assert.equal(imported.items[1].page, '101-120');
  }
});

test('CSL-JSON export/import is lossless for supported fields, stable UUID and app extensions', () => {
  const original = importFixture('csl-json', 'csl.json').items;
  original[0].tags = ['证据', 'review'];
  original[0].starred = true;
  original[0].privateNote = '人工备注';
  original[0].verifiedAt = NOW;
  original[0].fieldConfidence = { DOI: 0.98 };
  const exported = exportCitationItems(original, 'csl-json', { now: () => NOW });
  assert.equal(exported.lossReport.lossless, true);
  assert.equal(exported.lossReport.affectedItemCount, 0);
  const restored = importCitationText(exported.text, 'csl-json', { now: () => NOW });
  assert.deepEqual(restored.items.map(semanticDigest), original.map(semanticDigest));
  assert.equal(restored.items[0].libraryItemId, original[0].libraryItemId);
  assert.deepEqual(restored.items[0].author, original[0].author);
  assert.deepEqual(restored.items[0].tags, ['review', '证据']);
  assert.equal(restored.items[0].privateNote, '人工备注');
});

test('BibTeX and RIS exports round-trip expressible core fields and report fixed format losses', () => {
  const items = importFixture('csl-json', 'csl.json').items;
  items[0].privateNote = 'not representable';
  items[0].tags = ['tag'];
  for (const format of ['bibtex', 'ris']) {
    const exported = exportCitationItems(items, format, { now: () => NOW });
    assert.ok(exported.bytes > 100);
    assert.equal(exported.lossReport.lossless, false);
    assert.ok(exported.lossReport.entries[0].lostFields.includes('privateNote'));
    assert.ok(exported.lossReport.entries[0].lostFields.includes('tags'));
    const restored = importCitationText(exported.text, format, { idFactory: idFactory(), now: () => NOW });
    assert.equal(restored.items[0].title, items[0].title);
    assert.equal(restored.items[0].DOI, items[0].DOI);
    assert.equal(restored.items[0].author.length, items[0].author.length);
  }
  const actualLostFields = buildLossReport(items, 'ris').entries[0].lostFields;
  assert.ok(actualLostFields.every(field => LOSS_MATRIX.formats.ris.unsupportedFields.includes(field)));
  assert.ok(LOSS_MATRIX.formats.ris.unsupportedFields.includes('title-short'));
  assert.ok(LOSS_MATRIX.formats.ris.unsupportedFields.includes('publisher-place'));
});

test('format aliases normalize and unsupported formats fail explicitly', () => {
  assert.equal(normalizeFormat('.bib'), 'bibtex');
  assert.equal(normalizeFormat('json'), 'csl-json');
  assert.equal(normalizeFormat('csljson'), 'csl-json');
  assert.throws(() => normalizeFormat('endnote'), error => error instanceof CitationExchangeError && error.code === 'CITATION_FORMAT_UNSUPPORTED');
});

test('malformed, oversized, empty and excessive imports fail instead of silently succeeding', () => {
  assert.throws(() => parseCslJson('{broken'), error => error.code === 'CITATION_IMPORT_PARSE_FAILED');
  assert.throws(() => parseCslJson('[]'), error => error.code === 'CITATION_IMPORT_PARSE_FAILED');
  assert.throws(() => importCitationText('@not-bibtex', 'bibtex'), error => error.code === 'CITATION_IMPORT_PARSE_FAILED');
  assert.throws(() => importCitationText('12345', 'csl-json', { maximumBytes: 2 }), error => error.code === 'CITATION_IMPORT_TOO_LARGE');
  const text = JSON.stringify([{ id: 'a', type: 'book', title: 'A' }, { id: 'b', type: 'book', title: 'B' }]);
  assert.throws(() => importCitationText(text, 'csl-json', { maximumItems: 1 }), error => error.code === 'CITATION_IMPORT_TOO_MANY_ITEMS');
});

test('invalid DOI records are rejected or collected with an indexed error matrix', () => {
  const text = JSON.stringify([
    { id: 'a', type: 'book', title: 'Valid' },
    { id: 'b', type: 'article-journal', title: 'Invalid DOI', DOI: 'not-a-doi' }
  ]);
  assert.throws(() => importCitationText(text, 'csl-json', { idFactory: idFactory(), now: () => NOW }), error => error.code === 'CITATION_IMPORT_ITEM_INVALID' && error.details.index === 1);
  const collected = importCitationText(text, 'csl-json', { idFactory: idFactory(), now: () => NOW, collectErrors: true });
  assert.equal(collected.itemCount, 1);
  assert.equal(collected.rejectedCount, 1);
  assert.equal(collected.errors[0].code, 'CITATION_DOI_INVALID');
});
