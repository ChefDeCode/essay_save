#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT_DIR, 'test', 'fixtures');
const FIXED_TIME = '2026-07-16T00:00:00.000Z';
const FIXTURE_SEED = 20260716;
const EMPTY_DIRECTORIES = ['profiles/empty-first-start/userData'];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function pdfStream(value) {
  const body = asBuffer(value);
  return Buffer.concat([
    Buffer.from(`<< /Length ${body.length} >>\nstream\n`, 'ascii'),
    body,
    Buffer.from('\nendstream', 'ascii')
  ]);
}

function assemblePdf(objects) {
  const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const chunks = [header];
  const offsets = [0];
  let byteOffset = header.length;

  objects.forEach((body, index) => {
    offsets.push(byteOffset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'ascii'),
      asBuffer(body),
      Buffer.from('\nendobj\n', 'ascii')
    ]);
    chunks.push(chunk);
    byteOffset += chunk.length;
  });

  const xrefOffset = byteOffset;
  const entries = offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  const trailer = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`,
    'ascii'
  );
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

function escapePdfLiteral(value) {
  return value.replace(/([\\()])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}

function buildLatinTextPdf(text, options = {}) {
  const rotate = options.rotate || 0;
  const rotateEntry = rotate ? ` /Rotate ${rotate}` : '';
  const content = `BT\n/F1 18 Tf\n72 700 Td\n(${escapePdfLiteral(text)}) Tj\nET`;
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotateEntry} ` +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    pdfStream(content)
  ]);
}

function utf16Hex(value) {
  return Buffer.from(`\uFEFF${value}`, 'utf16le').swap16().toString('hex').toUpperCase();
}

function buildUnicodeTextPdf(text) {
  const characters = Array.from(new Set(Array.from(text)));
  const characterCodes = new Map(characters.map((character, index) => [character, index + 1]));
  const contentHex = Array.from(text)
    .map(character => characterCodes.get(character).toString(16).toUpperCase().padStart(2, '0'))
    .join('');
  const mappings = characters
    .map((character, index) => {
      const source = (index + 1).toString(16).toUpperCase().padStart(2, '0');
      const destination = utf16Hex(character).slice(4);
      return `<${source}> <${destination}>`;
    })
    .join('\n');
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /EssayFlowSyntheticToUnicode def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    `${characters.length} beginbfchar`,
    mappings,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end'
  ].join('\n');
  const content = `BT\n/F1 18 Tf\n72 700 Td\n<${contentHex}> Tj\nET`;
  const charProcStart = 6;
  const toUnicodeObject = charProcStart + characters.length;
  const charProcs = characters
    .map((_, index) => `/g${index + 1} ${charProcStart + index} 0 R`)
    .join(' ');
  const differences = characters.map((_, index) => `/g${index + 1}`).join(' ');
  const widths = characters.map(() => '1000').join(' ');
  const type3Font =
    '<< /Type /Font /Subtype /Type3 /Name /F1 /FontBBox [0 0 1000 1000] ' +
    '/FontMatrix [0.001 0 0 0.001 0 0] ' +
    `/CharProcs << ${charProcs} >> ` +
    `/Encoding << /Type /Encoding /Differences [1 ${differences}] >> ` +
    `/FirstChar 1 /LastChar ${characters.length} /Widths [${widths}] ` +
    `/Resources << >> /ToUnicode ${toUnicodeObject} 0 R >>`;
  const glyphStreams = characters.map((_, index) => {
    const inset = 90 + (index % 4) * 25;
    return pdfStream(
      `1000 0 0 0 900 900 d1\n${inset} ${inset} ${820 - inset} ${820 - inset} re S`
    );
  });

  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    type3Font,
    pdfStream(content),
    ...glyphStreams,
    pdfStream(toUnicode)
  ]);
}

function buildScannedPdf() {
  const imageData = Buffer.from([0x88]);
  const imageObject = Buffer.concat([
    Buffer.from(
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ' +
      '/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n',
      'ascii'
    ),
    imageData,
    Buffer.from('\nendstream', 'ascii')
  ]);
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    imageObject,
    pdfStream('q\n500 0 0 650 56 70 cm\n/Im1 Do\nQ')
  ]);
}

function buildSyntheticRecord(index) {
  const number = String(index).padStart(5, '0');
  const year = 1990 + (index % 36);
  return {
    id: `synthetic-paper-${number}`,
    type: index % 11 === 0 ? 'conference-paper' : 'article-journal',
    title: index % 2 === 0
      ? `Synthetic Evidence Study ${number}`
      : `合成研究记录 ${number}`,
    authors: [
      { family: `Author${index % 97}`, given: `Fixture${index % 31}` },
      { literal: `Synthetic Institute ${index % 13}` }
    ],
    issued: { 'date-parts': [[year]] },
    doi: `10.5555/essayflow.${number}`,
    containerTitle: `Fixture Journal ${index % 23}`,
    abstract: `Deterministic synthetic abstract ${number}; seed=${FIXTURE_SEED}.`,
    tags: [`topic-${index % 17}`, `method-${index % 9}`],
    synthetic: true
  };
}

function buildJsonLines(count) {
  const lines = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(JSON.stringify(buildSyntheticRecord(index)));
  }
  return `${lines.join('\n')}\n`;
}

function buildFixtures() {
  const files = new Map();
  const put = (relativePath, value) => files.set(relativePath.replace(/\\/g, '/'), asBuffer(value));

  put('README.md', `# EssayFlow synthetic acceptance fixtures\n\n` +
    `Generated by \`scripts/generate-fixtures.js\` with seed ${FIXTURE_SEED}.\n` +
    'Every person, title, DOI, project and document in this directory is synthetic.\n' +
    'Run `node scripts/generate-fixtures.js --check` to verify deterministic bytes.\n');

  put('profiles/empty-first-start/fixture.json', json({
    schemaVersion: 1,
    fixtureType: 'empty-first-start',
    userDataDirectory: 'userData',
    expectedEntries: 0,
    synthetic: true
  }));

  const legacyProjectId = 'legacy-project-001';
  const legacyPaper = {
    id: 'legacy-paper-001',
    title: 'Synthetic Legacy Citation',
    authors: 'Fixture Author',
    year: '2024',
    doi: '10.5555/essayflow.legacy'
  };
  put('profiles/legacy/userData/projects/index.json', json([{
    id: legacyProjectId,
    title: '合成旧版项目 Synthetic Legacy Project',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME
  }]));
  put(`profiles/legacy/userData/projects/${legacyProjectId}.html`,
    '<h1>合成旧版项目</h1><p>Synthetic legacy body ' +
    '<sup data-paper-id="legacy-paper-001" data-citation-num="1">[1]</sup></p>\n');
  put('profiles/legacy/renderer/local-storage.json', json({
    [`essay_project_meta_${legacyProjectId}`]: JSON.stringify({
      title: '合成旧版项目 Synthetic Legacy Project',
      author: 'Fixture Author',
      course: 'Synthetic Research 101',
      wordLimit: 5000
    }),
    essay_citations_v2: JSON.stringify({
      [legacyProjectId]: [{ paperId: legacyPaper.id, number: 1, paper: legacyPaper }]
    })
  }));

  const libraryRecords = [
    {
      id: 'library-paper-001',
      title: 'Synthetic Storage Paper',
      authors: 'A. Fixture',
      published: '2023',
      doi: '10.5555/essayflow.storage.1',
      synthetic: true
    },
    {
      id: 'library-paper-002',
      title: '合成文库存储记录',
      authors: '测试作者',
      published: '2022',
      doi: '10.5555/essayflow.storage.2',
      synthetic: true
    }
  ];
  put('storage/library/local-storage.json', json({
    essay_library: JSON.stringify(libraryRecords),
    essay_library_updated_at: '1784160000000'
  }));
  put('storage/library/indexeddb.json', json({
    database: 'EssayFlowDB',
    version: 1,
    stores: {
      library: [
        ...libraryRecords,
        { id: '__essayflow_library_meta__', updatedAt: 1784160000000, type: 'meta' }
      ]
    }
  }));

  const pixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZpN4AAAAASUVORK5CYII=',
    'base64'
  );
  put('projects/rich/assets/synthetic-pixel.png', pixelPng);
  put('projects/rich/rich-project.html', [
    '<h1>合成富文本项目 Synthetic Rich Project</h1>',
    '<p>中文段落与 English paragraph。</p>',
    '<p><span class="priority-keyword" data-keyword-value="可追溯性" ' +
      'data-extracted-keywords="[&quot;证据&quot;,&quot;引用&quot;]">可追溯性</span></p>',
    '<div class="ql-table-embed"><table><tbody><tr><td>样本</td><td>42</td></tr>' +
      '<tr><td>Method</td><td>Synthetic</td></tr></tbody></table></div>',
    '<p>Reference <sup data-paper-id="rich-paper-001" data-citation-num="1">[1]</sup></p>',
    '<p><img src="essay-asset://synthetic-pixel" alt="Synthetic fixture pixel"></p>'
  ].join('\n') + '\n');
  put('projects/rich/project-meta.json', json({
    id: 'rich-project-001',
    title: '合成富文本项目 Synthetic Rich Project',
    author: 'Fixture Author',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    synthetic: true
  }));
  put('projects/rich/citations.json', json([{
    paperId: 'rich-paper-001',
    number: 1,
    paper: {
      id: 'rich-paper-001',
      title: 'Traceable Synthetic Scholarship',
      authors: 'A. Fixture',
      year: '2025',
      doi: '10.5555/essayflow.rich.1'
    }
  }]));

  put('profiles/corrupt-index/userData/projects/index.json', '{ this is not valid JSON ]\n');
  put('profiles/corrupt-index/userData/projects/recoverable-project.html',
    '<h1>Recoverable Synthetic Project</h1><p>The index is damaged; this body is intact.</p>\n');
  put('profiles/corrupt-index/expectation.json', json({
    fixtureType: 'corrupt-index-intact-project',
    recoverableProjectId: 'recoverable-project',
    expectedRecoveredTitle: '未命名（已恢复）',
    synthetic: true
  }));

  put('invalid/truncated/workspace.json',
    '{\n  "schemaVersion": 1,\n  "workspaceId": "synthetic-truncated",\n  "projects": [\n');
  put('invalid/truncated/expectation.json', json({
    fixtureType: 'truncated-json',
    expectedError: 'parse-error',
    mustNotSilentlyRecoverAsEmpty: true,
    synthetic: true
  }));

  put('invalid/duplicates/projects.json', json([
    { id: 'duplicate-project-id', title: 'Synthetic Duplicate A', updatedAt: FIXED_TIME },
    { id: 'duplicate-project-id', title: 'Synthetic Duplicate B', updatedAt: FIXED_TIME }
  ]));
  put('invalid/duplicates/literature.json', json([
    { id: 'duplicate-doi-a', title: 'Synthetic DOI A', doi: '10.5555/EssayFlow.Duplicate' },
    { id: 'duplicate-doi-b', title: 'Synthetic DOI B', doi: 'https://doi.org/10.5555/essayflow.duplicate' }
  ]));

  put('invalid/future-schema/workspace.json', json({
    schemaVersion: 999,
    workspaceId: 'synthetic-future-schema',
    createdAt: FIXED_TIME,
    projects: [],
    expectedBehavior: 'read-only-and-refuse-write',
    synthetic: true
  }));

  const englishPdf = buildLatinTextPdf('English text layer fixture for EssayFlow.');
  const chinesePdf = buildUnicodeTextPdf('中文文本层合成样本');
  const rotatedPdf = buildLatinTextPdf('Rotated text layer fixture.', { rotate: 90 });
  const scannedPdf = buildScannedPdf();
  const originalPdf = buildLatinTextPdf('Synthetic managed source revision A.');
  const replacementPdf = buildLatinTextPdf('Synthetic managed source revision B with changed bytes.');
  const corruptPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\n', 'ascii');

  put('pdf/text-layer-zh.pdf', chinesePdf);
  put('pdf/text-layer-en.pdf', englishPdf);
  put('pdf/text-layer-rotated-90.pdf', rotatedPdf);
  put('pdf/scanned-no-text.pdf', scannedPdf);
  put('pdf/corrupt.pdf', corruptPdf);
  put('pdf/source-original.pdf', originalPdf);
  put('pdf/source-replaced.pdf', replacementPdf);
  put('pdf/expectations.json', json({
    files: {
      'text-layer-zh.pdf': { textIncludes: '中文文本层合成样本', pageCount: 1, rotation: 0 },
      'text-layer-en.pdf': { textIncludes: 'English text layer fixture', pageCount: 1, rotation: 0 },
      'text-layer-rotated-90.pdf': { textIncludes: 'Rotated text layer fixture', pageCount: 1, rotation: 90 },
      'scanned-no-text.pdf': { textItemCount: 0, pageCount: 1, expectedStatus: 'ocr-unsupported' },
      'corrupt.pdf': { expectedError: 'invalid-pdf' }
    },
    replacedSource: {
      logicalPath: 'managed/source.pdf',
      originalFile: 'source-original.pdf',
      replacementFile: 'source-replaced.pdf',
      originalSha256: sha256(originalPdf),
      replacementSha256: sha256(replacementPdf),
      expectedStatus: 'source-mismatch'
    },
    synthetic: true
  }));

  put('citations/academic.bib', `@article{synthetic-article,
  title = {合成证据研究 Synthetic Evidence Study},
  author = {王, 伟 and Wang, Wei and {Synthetic Research Institute}},
  year = {2025},
  journal = {Fixture Journal},
  volume = {12},
  number = {3},
  pages = {10--24},
  doi = {10.5555/essayflow.article}
}

@incollection{synthetic-chapter,
  title = {A Synthetic Book Chapter},
  author = {Fixture, Alice},
  booktitle = {Handbook of Generated Scholarship},
  editor = {Example, Erin},
  publisher = {Fixture Press},
  pages = {101--120},
  year = {2024}
}

@inproceedings{synthetic-conference,
  title = {Deterministic Conference Fixture},
  author = {Tester, Bo},
  booktitle = {Proceedings of the Synthetic Methods Conference},
  year = {2023},
  pages = {1--8}
}

@phdthesis{synthetic-thesis,
  title = {合成学位论文},
  author = {Li, Ming},
  school = {Synthetic University},
  year = {2022}
}

@techreport{synthetic-institution,
  title = {Institutional Fixture Report},
  author = {{Synthetic Research Institute}},
  institution = {Synthetic Research Institute},
  year = {2021}
}

@misc{synthetic-web,
  title = {Synthetic Web Resource},
  author = {{EssayFlow Fixture Group}},
  year = {2020},
  url = {https://example.invalid/synthetic-resource},
  note = {Accessed 2026-07-16}
}
`);

  put('citations/academic.ris', `TY  - JOUR
ID  - synthetic-article
TI  - 合成证据研究 Synthetic Evidence Study
AU  - Wang, Wei
AU  - 王, 伟
AU  - Synthetic Research Institute
PY  - 2025
JO  - Fixture Journal
VL  - 12
IS  - 3
SP  - 10
EP  - 24
DO  - 10.5555/essayflow.article
ER  -

TY  - CHAP
ID  - synthetic-chapter
TI  - A Synthetic Book Chapter
AU  - Fixture, Alice
A2  - Example, Erin
T2  - Handbook of Generated Scholarship
PB  - Fixture Press
PY  - 2024
SP  - 101
EP  - 120
ER  -

TY  - CONF
ID  - synthetic-conference
TI  - Deterministic Conference Fixture
AU  - Tester, Bo
T2  - Proceedings of the Synthetic Methods Conference
PY  - 2023
SP  - 1
EP  - 8
ER  -

TY  - THES
ID  - synthetic-thesis
TI  - 合成学位论文
AU  - Li, Ming
PB  - Synthetic University
PY  - 2022
ER  -

TY  - RPRT
ID  - synthetic-institution
TI  - Institutional Fixture Report
AU  - Synthetic Research Institute
PB  - Synthetic Research Institute
PY  - 2021
ER  -

TY  - ELEC
ID  - synthetic-web
TI  - Synthetic Web Resource
AU  - EssayFlow Fixture Group
PY  - 2020
UR  - https://example.invalid/synthetic-resource
Y2  - 2026/07/16
ER  -
`);

  put('citations/academic.csl.json', json([
    {
      id: 'synthetic-article',
      type: 'article-journal',
      title: '合成证据研究 Synthetic Evidence Study',
      author: [
        { family: '王', given: '伟' },
        { family: 'Wang', given: 'Wei' },
        { literal: 'Synthetic Research Institute' }
      ],
      issued: { 'date-parts': [[2025]] },
      'container-title': 'Fixture Journal',
      volume: '12',
      issue: '3',
      page: '10-24',
      DOI: '10.5555/essayflow.article'
    },
    {
      id: 'synthetic-chapter',
      type: 'chapter',
      title: 'A Synthetic Book Chapter',
      author: [{ family: 'Fixture', given: 'Alice' }],
      editor: [{ family: 'Example', given: 'Erin' }],
      'container-title': 'Handbook of Generated Scholarship',
      publisher: 'Fixture Press',
      page: '101-120',
      issued: { 'date-parts': [[2024]] }
    },
    {
      id: 'synthetic-conference',
      type: 'paper-conference',
      title: 'Deterministic Conference Fixture',
      author: [{ family: 'Tester', given: 'Bo' }],
      'container-title': 'Proceedings of the Synthetic Methods Conference',
      page: '1-8',
      issued: { 'date-parts': [[2023]] }
    },
    {
      id: 'synthetic-thesis',
      type: 'thesis',
      title: '合成学位论文',
      author: [{ family: 'Li', given: 'Ming' }],
      publisher: 'Synthetic University',
      genre: 'PhD thesis',
      issued: { 'date-parts': [[2022]] }
    },
    {
      id: 'synthetic-institution',
      type: 'report',
      title: 'Institutional Fixture Report',
      author: [{ literal: 'Synthetic Research Institute' }],
      publisher: 'Synthetic Research Institute',
      issued: { 'date-parts': [[2021]] }
    },
    {
      id: 'synthetic-web',
      type: 'webpage',
      title: 'Synthetic Web Resource',
      author: [{ literal: 'EssayFlow Fixture Group' }],
      issued: { 'date-parts': [[2020]] },
      accessed: { 'date-parts': [[2026, 7, 16]] },
      URL: 'https://example.invalid/synthetic-resource'
    }
  ]));

  put('scale/library-5000.jsonl', buildJsonLines(5000));
  put('scale/library-10000.jsonl', buildJsonLines(10000));

  put('workspaces/acceptance/fixture-index.json', json({
    schemaVersion: 1,
    fixtureSet: 'EssayFlow M0 acceptance',
    seed: FIXTURE_SEED,
    syntheticDataOnly: true,
    categories: {
      emptyProfile: '../../profiles/empty-first-start',
      legacyProfile: '../../profiles/legacy',
      libraryStorage: '../../storage/library',
      richProject: '../../projects/rich',
      corruptIndex: '../../profiles/corrupt-index',
      truncatedJson: '../../invalid/truncated',
      duplicates: '../../invalid/duplicates',
      futureSchema: '../../invalid/future-schema',
      pdf: '../../pdf',
      citationExchange: '../../citations',
      scale: '../../scale'
    }
  }));

  const fileInventory = Array.from(files.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, body]) => ({
      path: relativePath,
      bytes: body.length,
      sha256: sha256(body)
    }));
  const manifest = {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-fixtures.js',
    generatedAt: FIXED_TIME,
    seed: FIXTURE_SEED,
    syntheticDataOnly: true,
    containsUserPrivateData: false,
    emptyDirectories: EMPTY_DIRECTORIES,
    files: fileInventory
  };
  put('fixture-manifest.json', json(manifest));
  return files;
}

function writeFixtures(files) {
  for (const relativePath of EMPTY_DIRECTORIES) {
    const absolutePath = path.join(FIXTURE_DIR, relativePath);
    fs.mkdirSync(absolutePath, { recursive: true });
    const entries = fs.readdirSync(absolutePath);
    if (entries.length !== 0) {
      throw new Error(`Empty profile fixture is not empty: ${relativePath}`);
    }
  }

  for (const [relativePath, body] of files) {
    const absolutePath = path.join(FIXTURE_DIR, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath) : null;
    if (!current || !current.equals(body)) fs.writeFileSync(absolutePath, body);
  }
}

function checkFixtures(files) {
  const failures = [];
  for (const relativePath of EMPTY_DIRECTORIES) {
    const absolutePath = path.join(FIXTURE_DIR, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
      failures.push(`missing empty directory: ${relativePath}`);
    } else if (fs.readdirSync(absolutePath).length !== 0) {
      failures.push(`directory is not empty: ${relativePath}`);
    }
  }
  for (const [relativePath, expected] of files) {
    const absolutePath = path.join(FIXTURE_DIR, relativePath);
    if (!fs.existsSync(absolutePath)) {
      failures.push(`missing file: ${relativePath}`);
      continue;
    }
    const actual = fs.readFileSync(absolutePath);
    if (!actual.equals(expected)) failures.push(`byte mismatch: ${relativePath}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

function main() {
  const files = buildFixtures();
  if (process.argv.includes('--check')) {
    checkFixtures(files);
    process.stdout.write(`Verified ${files.size} deterministic fixture files.\n`);
    return;
  }
  writeFixtures(files);
  process.stdout.write(`Generated ${files.size} fixture files in ${FIXTURE_DIR}.\n`);
}

if (require.main === module) main();

module.exports = {
  EMPTY_DIRECTORIES,
  FIXTURE_DIR,
  FIXTURE_SEED,
  buildFixtures,
  checkFixtures
};
