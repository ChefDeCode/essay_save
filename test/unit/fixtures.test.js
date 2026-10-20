'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(ROOT_DIR, 'test', 'fixtures');
const GENERATOR = path.join(ROOT_DIR, 'scripts', 'generate-fixtures.js');

function fixturePath(relativePath) {
  return path.join(FIXTURE_DIR, ...relativePath.split('/'));
}

function read(relativePath, encoding = 'utf8') {
  return fs.readFileSync(fixturePath(relativePath), encoding);
}

function parseJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function hashFile(relativePath) {
  return crypto.createHash('sha256').update(read(relativePath, null)).digest('hex');
}

function normalizeDoi(value) {
  return String(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim()
    .toLowerCase();
}

async function openPdf(relativePath) {
  const pdfjs = require('pdfjs-dist/build/pdf.js');
  return pdfjs.getDocument({
    data: new Uint8Array(read(relativePath, null)),
    disableFontFace: true,
    useSystemFonts: true,
    cMapUrl: `${path.join(ROOT_DIR, 'node_modules', 'pdfjs-dist', 'cmaps')}${path.sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(ROOT_DIR, 'node_modules', 'pdfjs-dist', 'standard_fonts')}${path.sep}`
  }).promise;
}

async function extractPageText(document, pageNumber = 1) {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  return {
    page,
    content,
    text: content.items.map(item => item.str).join('')
  };
}

test('fixture generator is byte-for-byte reproducible', () => {
  const result = spawnSync(process.execPath, [GENERATOR, '--check'], {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Verified \d+ deterministic fixture files/);
});

test('fixture manifest covers every generated file with matching SHA-256', () => {
  const manifest = parseJson('fixture-manifest.json');
  assert.equal(manifest.syntheticDataOnly, true);
  assert.equal(manifest.containsUserPrivateData, false);
  assert.equal(manifest.seed, 20260716);
  assert.ok(manifest.files.length >= 25);

  for (const entry of manifest.files) {
    const absolutePath = fixturePath(entry.path);
    assert.ok(fs.statSync(absolutePath).isFile(), entry.path);
    assert.equal(fs.statSync(absolutePath).size, entry.bytes, entry.path);
    assert.equal(hashFile(entry.path), entry.sha256, entry.path);
  }
});

test('fixture 1: empty first-start profile contains no userData entries', () => {
  const descriptor = parseJson('profiles/empty-first-start/fixture.json');
  const userData = fixturePath('profiles/empty-first-start/userData');
  assert.equal(descriptor.fixtureType, 'empty-first-start');
  assert.equal(descriptor.expectedEntries, 0);
  assert.deepEqual(fs.readdirSync(userData), []);
});

test('fixture 2: legacy HTML, project metadata and citations are linked', () => {
  const index = parseJson('profiles/legacy/userData/projects/index.json');
  const storage = parseJson('profiles/legacy/renderer/local-storage.json');
  assert.equal(index.length, 1);
  const projectId = index[0].id;
  const html = read(`profiles/legacy/userData/projects/${projectId}.html`);
  const meta = JSON.parse(storage[`essay_project_meta_${projectId}`]);
  const citations = JSON.parse(storage.essay_citations_v2);
  assert.match(html, /Synthetic legacy body/);
  assert.match(html, /data-paper-id="legacy-paper-001"/);
  assert.equal(meta.title, index[0].title);
  assert.equal(citations[projectId][0].paperId, 'legacy-paper-001');
});

test('fixture 3: localStorage and IndexedDB library snapshots agree', () => {
  const local = parseJson('storage/library/local-storage.json');
  const indexed = parseJson('storage/library/indexeddb.json');
  const localPapers = JSON.parse(local.essay_library);
  const indexedPapers = indexed.stores.library.filter(record => record.type !== 'meta');
  assert.equal(indexed.database, 'EssayFlowDB');
  assert.equal(indexed.version, 1);
  assert.deepEqual(indexedPapers.map(paper => paper.id), localPapers.map(paper => paper.id));
  assert.ok(indexed.stores.library.some(record => record.id === '__essayflow_library_meta__'));
});

test('fixture 4: rich project contains bilingual text and all custom blots', () => {
  const html = read('projects/rich/rich-project.html');
  const citations = parseJson('projects/rich/citations.json');
  const png = read('projects/rich/assets/synthetic-pixel.png', null);
  assert.match(html, /中文段落与 English paragraph/);
  assert.match(html, /class="priority-keyword"/);
  assert.match(html, /class="ql-table-embed"/);
  assert.match(html, /data-paper-id="rich-paper-001"/);
  assert.match(html, /essay-asset:\/\/synthetic-pixel/);
  assert.equal(citations[0].paperId, 'rich-paper-001');
  assert.deepEqual(png.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
});

test('fixture 5: corrupt index fails parsing while project body remains intact', () => {
  const rawIndex = read('profiles/corrupt-index/userData/projects/index.json');
  assert.throws(() => JSON.parse(rawIndex), SyntaxError);
  const html = read('profiles/corrupt-index/userData/projects/recoverable-project.html');
  const expectation = parseJson('profiles/corrupt-index/expectation.json');
  assert.match(html, /index is damaged; this body is intact/);
  assert.equal(expectation.recoverableProjectId, 'recoverable-project');
});

test('fixture 6: truncated JSON is observably incomplete and cannot parse', () => {
  const raw = read('invalid/truncated/workspace.json');
  const expectation = parseJson('invalid/truncated/expectation.json');
  assert.throws(() => JSON.parse(raw), SyntaxError);
  assert.match(raw, /"projects": \[/);
  assert.equal(expectation.mustNotSilentlyRecoverAsEmpty, true);
});

test('fixture 7: duplicate project IDs and normalized DOI identities are present', () => {
  const projects = parseJson('invalid/duplicates/projects.json');
  const literature = parseJson('invalid/duplicates/literature.json');
  assert.equal(new Set(projects.map(project => project.id)).size, 1);
  assert.equal(projects.length, 2);
  assert.equal(new Set(literature.map(item => normalizeDoi(item.doi))).size, 1);
  assert.notEqual(literature[0].id, literature[1].id);
});

test('fixture 8: future schema is newer and explicitly read-only', () => {
  const workspace = parseJson('invalid/future-schema/workspace.json');
  assert.ok(workspace.schemaVersion > 1);
  assert.equal(workspace.expectedBehavior, 'read-only-and-refuse-write');
  assert.equal(workspace.synthetic, true);
});

test('fixture 9: Chinese, English and rotated PDFs expose text layers', async () => {
  const expectations = parseJson('pdf/expectations.json').files;
  for (const relativeName of [
    'text-layer-zh.pdf',
    'text-layer-en.pdf',
    'text-layer-rotated-90.pdf'
  ]) {
    const document = await openPdf(`pdf/${relativeName}`);
    try {
      const result = await extractPageText(document);
      assert.equal(document.numPages, expectations[relativeName].pageCount, relativeName);
      assert.ok(result.content.items.length > 0, relativeName);
      assert.match(result.text, new RegExp(expectations[relativeName].textIncludes), relativeName);
      assert.equal(result.page.rotate, expectations[relativeName].rotation, relativeName);
    } finally {
      await document.destroy();
    }
  }
});

test('fixture 10: scanned, corrupt and replaced PDF states are distinguishable', async () => {
  const scanned = await openPdf('pdf/scanned-no-text.pdf');
  try {
    const result = await extractPageText(scanned);
    assert.equal(result.content.items.length, 0);
  } finally {
    await scanned.destroy();
  }

  await assert.rejects(openPdf('pdf/corrupt.pdf'));
  const expectations = parseJson('pdf/expectations.json').replacedSource;
  assert.equal(hashFile(`pdf/${expectations.originalFile}`), expectations.originalSha256);
  assert.equal(hashFile(`pdf/${expectations.replacementFile}`), expectations.replacementSha256);
  assert.notEqual(expectations.originalSha256, expectations.replacementSha256);
  assert.equal(expectations.expectedStatus, 'source-mismatch');
});

test('fixture 11: BibTeX, RIS and CSL-JSON cover required academic item kinds', () => {
  const bibtex = read('citations/academic.bib');
  const ris = read('citations/academic.ris');
  const csl = parseJson('citations/academic.csl.json');
  assert.match(bibtex, /@article\{/);
  assert.match(bibtex, /@incollection\{/);
  assert.match(bibtex, /@inproceedings\{/);
  assert.match(bibtex, /@phdthesis\{/);
  assert.match(bibtex, /@techreport\{/);
  assert.match(bibtex, /@misc\{/);
  for (const risType of ['JOUR', 'CHAP', 'CONF', 'THES', 'RPRT', 'ELEC']) {
    assert.match(ris, new RegExp(`TY  - ${risType}`));
  }
  assert.equal(csl.length, 6);
  assert.deepEqual(
    new Set(csl.map(item => item.type)),
    new Set(['article-journal', 'chapter', 'paper-conference', 'thesis', 'report', 'webpage'])
  );
  assert.ok(csl.some(item => item.author.some(author => author.literal)));
  assert.ok(csl.some(item => item.author.some(author => /[\u3400-\u9fff]/u.test(`${author.family || ''}${author.given || ''}`))));
  assert.ok(csl.some(item => /[\u3400-\u9fff]/u.test(item.title)));
});

test('fixture 12: 5000 and 10000 record JSONL corpora are deterministic and nested', () => {
  const lines5000 = read('scale/library-5000.jsonl').trimEnd().split('\n');
  const lines10000 = read('scale/library-10000.jsonl').trimEnd().split('\n');
  assert.equal(lines5000.length, 5000);
  assert.equal(lines10000.length, 10000);
  assert.deepEqual(lines10000.slice(0, 5000), lines5000);
  assert.equal(JSON.parse(lines5000[0]).id, 'synthetic-paper-00001');
  assert.equal(JSON.parse(lines5000.at(-1)).id, 'synthetic-paper-05000');
  assert.equal(JSON.parse(lines10000.at(-1)).id, 'synthetic-paper-10000');
  assert.ok(lines10000.every(line => JSON.parse(line).synthetic === true));
});

test('fixtures contain no machine-absolute paths and declare synthetic provenance', () => {
  const manifest = parseJson('fixture-manifest.json');
  for (const entry of manifest.files) {
    if (!/\.(?:json|jsonl|html|md|bib|ris)$/i.test(entry.path)) continue;
    const value = read(entry.path);
    assert.doesNotMatch(value, /\b[A-Za-z]:[\\/]/, entry.path);
  }
  assert.equal(manifest.syntheticDataOnly, true);
  assert.equal(manifest.containsUserPrivateData, false);
});
