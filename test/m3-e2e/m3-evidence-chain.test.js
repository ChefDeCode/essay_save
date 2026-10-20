'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

test('M3 PDF evidence survives zoom, insertion, renumbering, restart and source loss', { timeout: 240_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m3-e2e-'));
  const localPdfRoot = path.join(profileRoot, 'localPdfs');
  fs.mkdirSync(localPdfRoot, { recursive: true });
  const pdfPaths = {
    english: path.join(localPdfRoot, 'english.pdf'),
    rotated: path.join(localPdfRoot, 'rotated.pdf'),
    scanned: path.join(localPdfRoot, 'scanned.pdf')
  };
  fs.copyFileSync(path.join(root, 'test', 'fixtures', 'pdf', 'text-layer-en.pdf'), pdfPaths.english);
  fs.copyFileSync(path.join(root, 'test', 'fixtures', 'pdf', 'text-layer-rotated-90.pdf'), pdfPaths.rotated);
  fs.copyFileSync(path.join(root, 'test', 'fixtures', 'pdf', 'scanned-no-text.pdf'), pdfPaths.scanned);
  const profileReportPath = path.join(profileRoot, 'profile-report.json');
  let driver = await launchElectron({ rootPath: root, userDataPath: profileRoot, profileReportPath });
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && Boolean(window.essayflowLibraryReady)', { timeoutMs: 45_000 });
  t.diagnostic('M3 stage: initial renderer ready');

  driver.client.timeoutMs = 45_000;
  let firstPhase;
  try {
    firstPhase = await driver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, label, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('M3 timed out: ' + label);
    };
    const paths = ${JSON.stringify(pdfPaths)};
    window.__m3Stage = 'import-managed-pdfs';
    await window.essayflowDataReady;
    const descriptors = {
      english: await window.electronAPI.importManagedPdfForEvidence(paths.english),
      rotated: await window.electronAPI.importManagedPdfForEvidence(paths.rotated),
      scanned: await window.electronAPI.importManagedPdfForEvidence(paths.scanned)
    };
    const assetRef = descriptor => ({
      assetId: descriptor.assetId,
      sha256: descriptor.sha256,
      kind: 'pdf',
      role: 'full-text'
    });
    window.__m3Stage = 'replace-library';
    let library = await window.electronAPI.loadLibraryStore();
    const items = [{
      id: 'm3-english', type: 'article-journal', title: 'English Evidence Fixture',
      author: [{ family: 'Fixture', given: 'English' }], issued: { 'date-parts': [[2026]] },
      DOI: '10.5555/m3.english', assetRefs: [assetRef(descriptors.english)], hasPdf: true,
      metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
    }, {
      id: 'm3-rotated', type: 'article-journal', title: 'Rotated Evidence Fixture',
      author: [{ family: 'Fixture', given: 'Rotated' }], issued: { 'date-parts': [[2026]] },
      DOI: '10.5555/m3.rotated', assetRefs: [assetRef(descriptors.rotated)], hasPdf: true,
      metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
    }, {
      id: 'm3-scanned', type: 'article-journal', title: 'Scanned Evidence Fixture',
      author: [{ literal: 'Synthetic Fixture Lab' }], issued: { 'date-parts': [[2026]] },
      assetRefs: [assetRef(descriptors.scanned)], hasPdf: true,
      metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
    }];
    await window.electronAPI.replaceLibraryStore({ baseRevision: library.revision, items });
    await loadLibrary();
    library = await window.electronAPI.loadLibraryStore();
    const byTitle = new Map(library.items.map(item => [item.title, item]));
    window.__m3Stage = 'create-project';
    const projectId = crypto.randomUUID();
    await window.electronAPI.saveProjectAuto({
      projectId, baseRevision: -1, content: '<h1>M3 证据链验收</h1><p>正文起点</p>',
      meta: { title: 'M3 证据链验收', referenceStyle: 'IEEE' }, citations: [], source: 'm3-e2e-create'
    });
    await loadProject(projectId);

    const createFromPdf = async (paper, expectedText, stagePrefix) => {
      window.__m3Stage = stagePrefix + '-open';
      await showPdfView(paper);
      window.__m3Stage = stagePrefix + '-wait-text-layer';
      await waitUntil(() => document.querySelectorAll('.pdf-text-layer span').length > 0, 'PDF text layer');
      window.__m3Stage = stagePrefix + '-search';
      const matches = await window.essayflowPdfEvidence.search(expectedText.split(' ')[0]);
      if (!matches.length || matches[0].pageNumber !== 1) throw new Error('PDF full-text search did not locate page 1');
      const span = [...document.querySelectorAll('.pdf-text-layer span')].find(value => value.textContent.trim());
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.__m3Stage = stagePrefix + '-save';
      const beforeItems = (await window.electronAPI.listEvidence(projectId)).items;
      const beforeIds = new Set(beforeItems.map(item => item.card.id));
      document.getElementById('pdf-save-evidence').click();
      await waitUntil(async () => {
        const count = (await window.electronAPI.listEvidence(projectId)).items.length;
        const toast = document.getElementById('toast')?.textContent || '';
        if (toast.startsWith('保存证据失败：')) throw new Error(toast);
        return count === beforeItems.length + 1;
      }, 'evidence durable creation');
      window.__m3Stage = stagePrefix + '-saved';
      const created = (await window.electronAPI.listEvidence(projectId)).items.find(item => !beforeIds.has(item.card.id));
      if (!created) throw new Error('Evidence durable creation did not return a new stable ID');
      return created;
    };

    const englishPaper = { ...byTitle.get('English Evidence Fixture'), managedAssetId: descriptors.english.assetId, hasPdf: true };
    const rotatedPaper = { ...byTitle.get('Rotated Evidence Fixture'), managedAssetId: descriptors.rotated.assetId, hasPdf: true };
    const scannedPaper = { ...byTitle.get('Scanned Evidence Fixture'), managedAssetId: descriptors.scanned.assetId, hasPdf: true };
    window.__m3Stage = 'create-english-evidence';
    const english = await createFromPdf(englishPaper, 'English text layer fixture', 'english');
    window.__m3Stage = 'create-rotated-evidence';
    const rotated = await createFromPdf(rotatedPaper, 'Rotated text layer fixture', 'rotated');
    if (rotated.revision.locator.pageRotation !== 90) throw new Error('Rotated page anchor lost rotation');

    window.__m3Stage = 'verify-scanned-pdf';
    await showPdfView(scannedPaper);
    await waitUntil(() => Boolean(document.querySelector('.pdf-ocr-notice')), 'OCR unsupported notice');
    const beforeScan = (await window.electronAPI.listEvidence(projectId)).items.length;
    document.getElementById('pdf-save-evidence').click();
    await new Promise(resolve => setTimeout(resolve, 200));
    if ((await window.electronAPI.listEvidence(projectId)).items.length !== beforeScan) throw new Error('Scanned PDF created an evidence card');

    const insert = async (item, mode, paraphraseText = '') => {
      const promise = window.insertEssayflowEvidence(item);
      await waitUntil(() => Boolean(document.querySelector('.evidence-insert-dialog[open]')), 'insertion dialog');
      const dialog = document.querySelector('.evidence-insert-dialog[open]');
      const button = [...dialog.querySelectorAll('.evidence-insert-modes button')].find(value => ({ quote: '原文引用', paraphrase: '手工转述', 'citation-only': '仅插入引用' }[mode] === value.textContent));
      button.click();
      if (mode === 'paraphrase') {
        dialog.querySelector('textarea').value = paraphraseText;
        dialog.querySelector('.evidence-insert-actions button:last-child').click();
      }
      if (!await promise) throw new Error('Evidence insertion failed: ' + mode);
    };
    window.__m3Stage = 'insert-quote';
    await insert(english, 'quote');
    window.__m3Stage = 'insert-paraphrase';
    await insert(rotated, 'paraphrase', '用户手工转述旋转页中的研究结论。');
    window.__m3Stage = 'insert-citation-only';
    await insert(rotated, 'citation-only');
    const beforeRenumber = await window.electronAPI.loadProject(projectId);
    const evidenceLinkIds = beforeRenumber.aggregate.citationLinks.map(link => link.id);
    const evidenceRevisionIds = beforeRenumber.aggregate.citationLinks.map(link => link.items[0].evidenceRevisionIds[0]);
    const extra = createCitationCluster([englishPaper]);
    quill.insertText(0, '[0]', { cite: { citationInstanceId: extra.citationInstanceId, paperId: englishPaper.id, num: 0 } }, Quill.sources.USER);
    window.__m3Stage = 'renumber-autosave';
    await autoSaveProject();
    const afterRenumber = await window.electronAPI.loadProject(projectId);
    for (let index = 0; index < evidenceLinkIds.length; index += 1) {
      const link = afterRenumber.aggregate.citationLinks.find(value => value.id === evidenceLinkIds[index]);
      if (!link || link.items[0].evidenceRevisionIds[0] !== evidenceRevisionIds[index]) throw new Error('Renumbering changed stable evidence link');
    }
    return {
      projectId,
      evidenceIds: [english.card.id, rotated.card.id],
      evidenceRevisionIds,
      linkIds: evidenceLinkIds,
      englishAssetId: english.revision.sourceSnapshot.assetId,
      rotations: [english.revision.locator.pageRotation, rotated.revision.locator.pageRotation],
      rects: [english.revision.locator.rects, rotated.revision.locator.rects],
      quoteInserted: afterRenumber.content.includes(english.revision.locator.quoteDisplay),
      paraphraseInserted: afterRenumber.content.includes('用户手工转述旋转页中的研究结论。'),
      citationLinkCount: afterRenumber.aggregate.citationLinks.length
    };
  })()`);
  } catch (error) {
    driver.client.timeoutMs = 5_000;
    let stage = { phase: 'unavailable' };
    try {
      stage = await driver.client.evaluate(`(() => {
        const view = document.querySelector('.pdf-full-view');
        const shell = document.querySelector('.pdf-page-shell');
        return {
          phase: window.__m3Stage || 'not-started',
          pdfStage: view?.dataset.pdfStage || 'no-view',
          pageShellCount: document.querySelectorAll('.pdf-page-shell').length,
          textSpanCount: document.querySelectorAll('.pdf-text-layer span').length,
          firstPageRendering: shell?.dataset.rendering || '',
          firstPageRendered: shell?.dataset.rendered || '',
          firstPageRenderError: shell?.dataset.renderError || '',
          canvasPixels: shell ? [shell.querySelector('canvas')?.width || 0, shell.querySelector('canvas')?.height || 0] : [],
          containerSize: view ? [view.clientWidth, view.clientHeight] : [],
          documentVisibility: document.visibilityState,
          devicePixelRatio: window.devicePixelRatio,
          loadingText: document.querySelector('.pdf-loading')?.textContent || ''
        };
      })()`, { awaitPromise: false });
    } catch {}
    throw new Error(`M3 first phase failed at ${JSON.stringify(stage)}: ${error.message}`, { cause: error });
  } finally {
    driver.client.timeoutMs = 120_000;
  }
  t.diagnostic('M3 stage: evidence creation and insertion complete');

  assert.deepEqual(firstPhase.rotations, [0, 90]);
  assert.ok(firstPhase.rects.every(rects => rects.length > 0 && rects.every(rect => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001)));
  assert.equal(firstPhase.quoteInserted, true);
  assert.equal(firstPhase.paraphraseInserted, true);
  assert.equal(firstPhase.citationLinkCount, 4);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));
  assert.equal(await driver.close(), 0);
  driver = null;

  driver = await launchElectron({ rootPath: root, userDataPath: profileRoot, profileReportPath });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled()', { timeoutMs: 45_000 });
  t.diagnostic('M3 stage: restart renderer ready');
  const restartBase = await driver.client.evaluate(String.raw`(async () => {
    const projectId = ${JSON.stringify(firstPhase.projectId)};
    await window.essayflowDataReady;
    await loadProject(projectId);
    const snapshot = await window.electronAPI.listEvidence(projectId);
    const item = snapshot.items.find(value => value.card.id === ${JSON.stringify(firstPhase.evidenceIds[0])});
    return { item, evidenceCount: snapshot.items.length, activeStatus: item.effectiveStatus };
  })()`);
  driver.client.timeoutMs = 60_000;
  await driver.client.evaluate(`(() => {
    window.__m3OpenResult = null;
    window.openEssayflowEvidenceSource(${JSON.stringify(restartBase.item)})
      .then(value => { window.__m3OpenResult = { value }; })
      .catch(error => { window.__m3OpenResult = { error: error.message || String(error) }; });
    return true;
  })()`);
  const opened = await driver.client.evaluate(String.raw`(async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (window.__m3OpenResult) return window.__m3OpenResult;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('M3 source open timed out at PDF stage: ' + (document.querySelector('.pdf-full-view')?.dataset.pdfStage || 'no-view'));
  })()`);
  driver.client.timeoutMs = 15_000;
  assert.deepEqual(opened, { value: true });
  const initialHighlightCount = await driver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('M3 restart timed out');
    };
    return waitUntil(() => document.querySelectorAll('[data-evidence-id="${firstPhase.evidenceIds[0]}"]').length);
  })()`);
  const zoomHighlightCount = await driver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('M3 zoom timed out');
    };
    for (let i = 0; i < 5; i += 1) document.getElementById('pdf-zoom-in').click();
    await waitUntil(() => document.getElementById('pdf-zoom-value').textContent === '150%');
    return waitUntil(() => document.querySelectorAll('[data-evidence-id="${firstPhase.evidenceIds[0]}"]').length);
  })()`);
  const restart = await driver.client.evaluate(String.raw`(async () => {
    const projectId = ${JSON.stringify(firstPhase.projectId)};
    const project = await window.electronAPI.loadProject(projectId);
    return {
      evidenceCount: ${restartBase.evidenceCount},
      activeStatus: ${JSON.stringify(restartBase.activeStatus)},
      highlightCount: ${zoomHighlightCount},
      anchorIds: [...quill.root.querySelectorAll('sup[data-citation-instance-id]')].map(node => node.dataset.citationInstanceId),
      linkIds: project.aggregate.citationLinks.map(link => link.id)
    };
  })()`);
  t.diagnostic('M3 stage: restart backlink and zoom complete');
  assert.ok(initialHighlightCount > 0);
  assert.equal(restart.evidenceCount, 2);
  assert.equal(restart.activeStatus, 'active');
  assert.ok(restart.highlightCount > 0);
  firstPhase.linkIds.forEach(id => assert.ok(restart.linkIds.includes(id)));
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(await driver.close(), 0);
  driver = null;

  const recordPath = path.join(profileRoot, 'workspace', 'assets', 'records', `${firstPhase.englishAssetId}.json`);
  fs.rmSync(recordPath, { force: true });
  driver = await launchElectron({ rootPath: root, userDataPath: profileRoot, profileReportPath });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled()', { timeoutMs: 45_000 });
  t.diagnostic('M3 stage: degraded-source renderer ready');
  const missing = await driver.client.evaluate(String.raw`(async () => {
    const projectId = ${JSON.stringify(firstPhase.projectId)};
    await window.essayflowDataReady;
    await loadProject(projectId);
    const snapshot = await window.electronAPI.listEvidence(projectId);
    const item = snapshot.items.find(value => value.card.id === ${JSON.stringify(firstPhase.evidenceIds[0])});
    const audit = await window.electronAPI.auditProjectCitations(projectId);
    return {
      status: item.effectiveStatus,
      jumped: await window.openEssayflowEvidenceSource(item),
      pdfVisible: Boolean(document.querySelector('.pdf-full-view')),
      auditCodes: audit.issues.map(issue => issue.code),
      auditBlockingCount: audit.blockingCount
    };
  })()`);
  assert.equal(missing.status, 'source-missing');
  assert.equal(missing.jumped, false);
  assert.equal(missing.pdfVisible, false);
  assert.ok(missing.auditCodes.includes('EVIDENCE_SOURCE_MISSING'));
  assert.ok(missing.auditBlockingCount > 0);
  t.diagnostic('M3 stage: degraded-source audit complete');
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));

  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    milestone: 'm3',
    scenario: 'PDF text layer, canonical evidence anchors, insertion, stable backlink and degraded source',
    fixtureData: 'synthetic',
    passed: true,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    firstPhase,
    restart,
    missing
  };
  const reportPath = path.join(root, 'artifacts', 'e2e', 'm3', 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});
