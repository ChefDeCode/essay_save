'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest, sha256 } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

function writeFixtures(profileRoot) {
  const fixtureRoot = path.join(profileRoot, 'M2Fixtures');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const bib = path.join(fixtureRoot, 'm2.bib');
  const ris = path.join(fixtureRoot, 'm2.ris');
  const csl = path.join(fixtureRoot, 'm2.json');
  fs.writeFileSync(bib, `@article{shared,
  title = {Incoming Conflict Title},
  author = {Wang, Wei and {{Institute One}}},
  year = {2024},
  journal = {M2 Journal},
  volume = {8},
  number = {2},
  pages = {12--18},
  doi = {10.5555/m2.shared}
}
@book{unicode,
  title = {Unicode Academic Exchange 学术交换},
  author = {Li, Ming and {{联合研究中心}}},
  year = {2023},
  publisher = {Fixture Press},
  isbn = {9780000000002}
}
`, 'utf8');
  fs.writeFileSync(ris, `TY  - JOUR
TI  - RIS Evidence Record
AU  - García, Ana
AU  - Synthetic Consortium
PY  - 2022
JO  - Exchange Review
VL  - 3
IS  - 1
SP  - 41
EP  - 49
DO  - 10.5555/m2.ris
UR  - https://example.invalid/m2-ris
ER  -
`, 'utf8');
  fs.writeFileSync(csl, `${JSON.stringify([{
    id: 'external-csl-record',
    type: 'article-journal',
    title: 'CSL 结构化机构作者记录',
    author: [{ literal: '跨语言证据研究院' }, { family: 'Zhao', given: 'Lin' }],
    issued: { 'date-parts': [[2021, 7, 1]] },
    accessed: { 'date-parts': [[2026, 7, 16]] },
    'container-title': '结构化数据期刊',
    volume: '5',
    issue: '4',
    page: '88-102',
    DOI: '10.5555/m2.csl',
    URL: 'https://example.invalid/m2-csl',
    language: 'zh-CN',
    abstract: '仅用于确定性验收的合成摘要。'
  }], null, 2)}\n`, 'utf8');
  return { bib, ris, csl };
}

test('M2 standard exchange, library workflow and CSL citation editing survive restart', { timeout: 240_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m2-e2e-'));
  const profileReportPath = path.join(profileRoot, 'profile-report.json');
  const fixtures = writeFixtures(profileRoot);
  const exports = {
    json: path.join(profileRoot, 'TestExports', 'EssayFlow-Library.json'),
    bib: path.join(profileRoot, 'TestExports', 'EssayFlow-Library.bib'),
    ris: path.join(profileRoot, 'TestExports', 'EssayFlow-Library.ris')
  };
  const importQueue = [fixtures.bib, fixtures.ris, fixtures.csl, exports.json, exports.bib, exports.ris, exports.json].join(path.delimiter);
  let driver = await launchElectron({
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath,
    env: { ESSAYFLOW_AUTOMATION_CITATION_IMPORT: importQueue }
  });
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, "appInitializationComplete === true && quill.isEnabled() && Boolean(window.essayflowLibraryReady)", { timeoutMs: 45_000 });

  const firstPhase = await driver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('M2 renderer scenario timed out');
    };
    await window.essayflowDataReady;
    await window.essayflowLibraryReady;

    let snapshot = await window.electronAPI.loadLibraryStore();
    await window.electronAPI.replaceLibraryStore({
      baseRevision: snapshot.revision,
      items: [{
        id: 'm2-manual-local',
        type: 'article-journal',
        title: 'Local Manual Title',
        author: [{ family: 'Wang', given: 'Wei' }, { literal: 'Institute One' }],
        issued: { 'date-parts': [[2024]] },
        DOI: '10.5555/m2.shared',
        'container-title': 'M2 Journal',
        privateNote: '人工笔记必须保留',
        tags: ['manual'],
        metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual', privateNote: 'manual' } }
      }]
    });
    await loadLibrary();
    document.getElementById('btn-library').click();
    document.getElementById('search-toggle-btn').click();
    await waitUntil(() => !document.getElementById('library-controls').hidden);

    const importOne = async expectedCount => {
      document.getElementById('library-import-standard').click();
      await waitUntil(() => Boolean(document.querySelector('.citation-dialog-backdrop')));
      const modal = document.querySelector('.citation-dialog-backdrop');
      modal.querySelectorAll('.citation-conflict-target').forEach(select => { select.value = select.options[1]?.value || ''; });
      modal.querySelectorAll('.citation-field-choice').forEach(select => { select.value = 'existing'; });
      const conflictCount = modal.querySelectorAll('[data-field]').length;
      modal.querySelector('.citation-dialog-actions button:last-child').click();
      await waitUntil(() => !document.body.contains(modal));
      await waitUntil(async () => (await window.electronAPI.loadLibraryStore()).items.length === expectedCount);
      return conflictCount;
    };
    const bibConflicts = await importOne(2);
    await importOne(3);
    await importOne(4);
    snapshot = await window.electronAPI.loadLibraryStore();
    const originalIds = snapshot.items.map(item => item.libraryItemId).sort();
    const shared = snapshot.items.find(item => item.DOI === '10.5555/m2.shared');
    if (shared.title !== 'Local Manual Title' || !shared.privateNote.includes('人工笔记')) throw new Error('人工字段被导入静默覆盖');

    const exportOne = async format => {
      document.getElementById('library-export-format').value = format;
      document.getElementById('library-export-standard').click();
      await waitUntil(() => Boolean(document.querySelector('.citation-dialog-backdrop')));
      const modal = document.querySelector('.citation-dialog-backdrop');
      const text = modal.textContent;
      modal.querySelector('.citation-dialog-actions button').click();
      await waitUntil(() => !document.body.contains(modal));
      return text;
    };
    const exportReports = {
      csl: await exportOne('csl-json'),
      bib: await exportOne('bibtex'),
      ris: await exportOne('ris')
    };

    const clearLibrary = async () => {
      const current = await window.electronAPI.loadLibraryStore();
      if (!current.items.length) return;
      await window.electronAPI.applyCitationLibraryBatch({
        baseRevision: current.revision,
        itemIds: current.items.map(item => item.libraryItemId),
        operation: { type: 'delete', retainManagedAssets: true }
      });
      await loadLibrary();
    };
    await clearLibrary();
    await importOne(4);
    const cslRoundTrip = await window.electronAPI.loadLibraryStore();
    const cslIds = cslRoundTrip.items.map(item => item.libraryItemId).sort();
    if (JSON.stringify(cslIds) !== JSON.stringify(originalIds)) throw new Error('CSL-JSON round trip changed stable IDs');
    if (!cslRoundTrip.items.some(item => item.author?.[0]?.literal === '跨语言证据研究院')) throw new Error('CSL institution author was lost');
    await clearLibrary();
    await importOne(4);
    const bibCount = (await window.electronAPI.loadLibraryStore()).items.length;
    await clearLibrary();
    await importOne(4);
    const risCount = (await window.electronAPI.loadLibraryStore()).items.length;
    await clearLibrary();
    await importOne(4);
    await loadLibrary();

    snapshot = await window.electronAPI.loadLibraryStore();
    const papers = snapshot.items.slice(0, 2);
    const projectId = crypto.randomUUID();
    const citationInstanceId = crypto.randomUUID();
    const citationItemIds = [crypto.randomUUID(), crypto.randomUUID()];
    const created = await window.electronAPI.saveProjectAuto({
      projectId,
      baseRevision: -1,
      content: '<h1>M2 引用验收</h1><p>可追溯论证 <sup data-citation-instance-id="' + citationInstanceId + '">[1]</sup></p>',
      meta: { title: 'M2 引用验收', referenceStyle: 'APA' },
      citations: [{
        citationInstanceId,
        insertionMode: 'citation-only',
        items: [{
          citationItemEntryId: crypto.randomUUID(),
          citationItemId: citationItemIds[0],
          libraryItemId: papers[0].libraryItemId,
          paper: papers[0],
          locator: '12',
          label: 'page',
          prefix: '参见 ',
          suffix: '，重点',
          suppressAuthor: false,
          order: 0
        }, {
          citationItemEntryId: crypto.randomUUID(),
          citationItemId: citationItemIds[1],
          libraryItemId: papers[1].libraryItemId,
          paper: papers[1],
          suppressAuthor: true,
          order: 1
        }]
      }],
      source: 'm2-e2e-create'
    });
    await loadProject(projectId);
    await waitUntil(() => Boolean(quill.root.querySelector('sup[data-citation-instance-id="' + citationInstanceId + '"]')));
    await waitUntil(() => quill.root.querySelectorAll('p[data-ref-section][data-citation-item-id]').length === 2);

    const apa = await window.electronAPI.renderProjectCitations({ projectId, styleId: 'apa-7', format: 'text' });
    const ieee = await window.electronAPI.renderProjectCitations({ projectId, styleId: 'ieee', format: 'text' });
    const gbt = await window.electronAPI.renderProjectCitations({ projectId, styleId: 'gb-t-7714-2015-numeric', format: 'text' });
    if (/^\s*\[\d+\]/.test(apa.citations[0].body)) throw new Error('APA was rendered as a fixed number');
    if (ieee.citationFormat !== 'numeric' || gbt.citationFormat !== 'numeric' || !/1/.test(ieee.citations[0].body) || !/1/.test(gbt.citations[0].body)) {
      throw new Error('Numeric styles did not render a stable number');
    }

    const anchor = quill.root.querySelector('sup[data-citation-instance-id="' + citationInstanceId + '"]');
    anchor.click();
    await waitUntil(() => !citationEditorModal.hidden);
    const firstRow = citationEditorModal.querySelector('.citation-editor-row');
    firstRow.querySelector('[data-field="locator"]').value = '33';
    firstRow.querySelector('[data-field="label"]').value = 'page';
    firstRow.querySelector('[data-field="prefix"]').value = '另见 ';
    firstRow.querySelector('[data-field="suffix"]').value = '，复核';
    firstRow.querySelector('[data-field="suppressAuthor"]').checked = true;
    citationEditorModal.querySelector('[data-citation-action="save"]').click();
    await waitUntil(() => citationEditorModal.hidden && document.getElementById('save-status').dataset.state === 'saved');
    const edited = await window.electronAPI.loadProject(projectId);
    const editedEntry = edited.citations[0].items[0];
    if (editedEntry.locator !== '33' || editedEntry.prefix !== '另见 ' || editedEntry.suffix !== '，复核' || !editedEntry.suppressAuthor) {
      throw new Error('Citation editor fields were not persisted');
    }
    anchor.click();
    await waitUntil(() => !citationEditorModal.hidden);
    citationEditorModal.querySelector('.citation-editor-row [data-field="locator"]').value = '999';
    citationEditorModal.querySelector('[data-citation-action="cancel"]').click();
    const afterCancel = await window.electronAPI.loadProject(projectId);
    if (afterCancel.citations[0].items[0].locator !== '33') throw new Error('Cancel changed the citation');

    return {
      projectId,
      citationInstanceId,
      libraryCount: snapshot.items.length,
      bibConflicts,
      originalIds,
      cslRoundTripIds: cslIds,
      bibRoundTripCount: bibCount,
      risRoundTripCount: risCount,
      exportReports,
      createdRevision: created.revision,
      editedRevision: edited.revision,
      styleBodies: { apa: apa.citations[0].body, ieee: ieee.citations[0].body, gbt: gbt.citations[0].body },
      finalEntry: editedEntry,
      domPaperCardCount: document.querySelectorAll('#library-results .paper-card').length
    };
  })()`);

  assert.ok(firstPhase.bibConflicts >= 1);
  assert.equal(firstPhase.libraryCount, 4);
  assert.deepEqual(firstPhase.cslRoundTripIds, firstPhase.originalIds);
  assert.equal(firstPhase.bibRoundTripCount, 4);
  assert.equal(firstPhase.risRoundTripCount, 4);
  assert.ok(firstPhase.exportReports.bib.includes('无法表达的字段'));
  assert.ok(firstPhase.exportReports.ris.includes('无法表达的字段'));
  assert.ok(firstPhase.domPaperCardCount <= 200);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));
  let exitCode = await driver.close();
  assert.equal(exitCode, 0);
  driver = null;

  driver = await launchElectron({ rootPath: root, userDataPath: profileRoot, profileReportPath });
  await waitForRenderer(driver, "appInitializationComplete === true && quill.isEnabled()", { timeoutMs: 45_000 });
  const restart = await driver.client.evaluate(String.raw`(async () => {
    await window.essayflowDataReady;
    await loadProject(${JSON.stringify(firstPhase.projectId)});
    const project = await window.electronAPI.loadProject(${JSON.stringify(firstPhase.projectId)});
    const entry = project.citations[0].items[0];
    return {
      citationInstanceId: project.citations[0].citationInstanceId,
      locator: entry.locator,
      label: entry.label,
      prefix: entry.prefix,
      suffix: entry.suffix,
      suppressAuthor: entry.suppressAuthor,
      itemCount: project.citations[0].items.length,
      referenceCount: quill.root.querySelectorAll('p[data-ref-section][data-citation-item-id]').length,
      anchorCount: quill.root.querySelectorAll('sup[data-citation-instance-id="' + project.citations[0].citationInstanceId + '"]').length
    };
  })()`);
  assert.equal(restart.citationInstanceId, firstPhase.citationInstanceId);
  assert.equal(restart.locator, '33');
  assert.equal(restart.label, 'page');
  assert.equal(restart.prefix, '另见 ');
  assert.equal(restart.suffix, '，复核');
  assert.equal(restart.suppressAuthor, true);
  assert.equal(restart.itemCount, 2);
  assert.equal(restart.referenceCount, 2);
  assert.equal(restart.anchorCount, 1);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    milestone: 'm2',
    scenario: 'standard exchange, library organization, CSL rendering and restart persistence',
    fixtureData: 'synthetic',
    passed: true,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    firstPhase,
    restart,
    exports: Object.fromEntries(Object.entries(exports).map(([format, filePath]) => [format, {
      path: filePath,
      bytes: fs.statSync(filePath).size,
      sha256: sha256(fs.readFileSync(filePath))
    }]))
  };
  const reportPath = path.join(root, 'artifacts', 'e2e', 'm2', 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});
