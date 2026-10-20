'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

function sha(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function startMock(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: request.url, body, authorizationPresent: Boolean(request.headers.authorization) });
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = String(messages.find(message => message.role === 'system')?.content || '');
      const user = String(messages.find(message => message.role === 'user')?.content || '');
      let content = 'fixture';
      if (system.includes('综述矩阵抽取器')) {
        const page = /\[\[PAGE ([^\]]+)\]\]\n([^\n]+)/u.exec(user);
        const source = page?.[2] || '';
        const quote = source.slice(0, Math.min(90, source.length));
        const locator = page ? { pageLabel: page[1], quote } : {};
        content = JSON.stringify({
          cells: [
            { columnKey: 'method', value: '固定方法：对照研究', ...locator, reviewStatus: 'confirmed', actor: 'user' },
            { columnKey: 'sample', value: '固定样本：120', ...locator },
            { columnKey: 'conclusions', value: '固定结论：主要结局改善', ...locator }
          ],
          reviewStatus: 'confirmed',
          actor: 'user'
        });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, origin: `http://127.0.0.1:${server.address().port}` };
}

test('M5 review matrix handles ten candidates, evidence-bound AI drafts, safe exports and local-only', { timeout: 300_000 }, async t => {
  const mock = await startMock(t);
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m5-e2e-'));
  const localPdfRoot = path.join(profileRoot, 'localPdfs');
  fs.mkdirSync(localPdfRoot, { recursive: true });
  const pdfPath = path.join(localPdfRoot, 'm5-full-text.pdf');
  fs.copyFileSync(path.join(root, 'test', 'fixtures', 'pdf', 'text-layer-en.pdf'), pdfPath);
  const launchOptions = {
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath: path.join(profileRoot, 'profile-report.json'),
    env: { ESSAYFLOW_AUTOMATION_LOCAL_AI_ORIGIN: mock.origin }
  };
  let driver = await launchElectron(launchOptions);
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && window.essayflowReviewMatrixReady === true', { timeoutMs: 45_000 });
  driver.client.timeoutMs = 240_000;

  let first;
  try {
    first = await driver.client.evaluate(String.raw`(async () => {
      window.__m5ConfirmMessages = [];
      window.confirm = message => {
        window.__m5ConfirmMessages.push(String(message));
        return !/覆盖手工内容/.test(String(message));
      };
      window.prompt = (message, fallback) => fallback || 'M5 系统综述矩阵';
      const waitUntil = async (predicate, label, timeout = 180000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const value = await predicate();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 75));
        }
        throw new Error('M5 timeout: ' + label + '; status=' + (document.getElementById('review-matrix-status')?.textContent || ''));
      };
      await window.essayflowDataReady;
      let settings = await window.electronAPI.updateExportableSettings({
        providerId: 'm5-local-fixture', providerOrigin: ${JSON.stringify(mock.origin)}, model: 'm5-deterministic-model'
      });
      window.essayflowDataState.settings = settings.settings;
      await window.electronAPI.setProviderCredential({ providerId: 'm5-local-fixture', value: 'm5-secret-canary' });
      const descriptor = await window.electronAPI.importManagedPdfForEvidence(${JSON.stringify(pdfPath)});
      let library = await window.electronAPI.loadLibraryStore();
      const items = Array.from({ length: 10 }, (_, index) => ({
        id: 'm5-paper-' + (index + 1), type: 'article-journal', title: 'M5 候选文献 ' + (index + 1),
        author: [{ family: 'Candidate' + (index + 1), given: 'M5' }], issued: { 'date-parts': [[2015 + index]] },
        DOI: '10.5555/m5.' + (index + 1),
        abstract: index >= 7 && index < 9 ? 'Abstract-only deterministic method, sample and conclusion for candidate ' + (index + 1) : '',
        ...(index < 7 ? { assetRefs: [{ assetId: descriptor.assetId, sha256: descriptor.sha256, kind: 'pdf', role: 'full-text' }], hasPdf: true } : {}),
        metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
      }));
      await window.electronAPI.replaceLibraryStore({ baseRevision: library.revision, items });
      library = await window.electronAPI.loadLibraryStore();
      const projectId = crypto.randomUUID();
      const created = await window.electronAPI.saveProjectAuto({
        projectId, baseRevision: -1, content: '<h1>M5 系统综述</h1><p>矩阵验收正文。</p>',
        meta: { title: 'M5 系统综述', referenceStyle: 'APA', privacyMode: 'sensitive' }, citations: [], source: 'm5-e2e-create'
      });
      await loadProject(projectId);
      let revision = created.revision;
      for (const item of library.items) {
        const changed = await window.electronAPI.updateProjectPaperState({
          projectId, baseRevision: revision, libraryItemId: item.libraryItemId,
          screeningStatus: 'included', readingStatus: 'to-read', projectNotes: ''
        });
        revision = changed.revision;
        window.applyEssayflowProjectRevision(projectId, revision);
      }
      document.getElementById('btn-library').click();
      document.getElementById('review-matrix-open').click();
      await waitUntil(() => document.getElementById('review-matrix-modal').getAttribute('aria-hidden') === 'false', 'matrix modal');
      await waitUntil(async () => (await window.electronAPI.listReviewMatrices(projectId)).projectPaperStates.filter(state => state.screeningStatus === 'included').length === 10, 'project candidates');
      await waitUntil(() => document.querySelector('#review-matrix-select option'), 'matrix state loaded');
      document.getElementById('review-matrix-create').click();
      await waitUntil(() => document.querySelectorAll('#review-matrix-table-shell tbody tr').length === 10, 'ten matrix rows');
      let snapshot = await window.electronAPI.listReviewMatrices(projectId);
      const matrix = snapshot.matrices[0];
      const method = matrix.columns.find(column => column.key === 'method');
      const protectedRow = matrix.rows[0];
      const protectedEditor = document.querySelector('tr[data-row-id="' + protectedRow.id + '"] td[data-column-id="' + method.id + '"] textarea');
      protectedEditor.value = '用户先写的方法，不得被默认覆盖';
      protectedEditor.dispatchEvent(new Event('change', { bubbles: true }));
      await waitUntil(async () => {
        const current = await window.electronAPI.listReviewMatrices(projectId);
        return current.matrices[0].rows.find(row => row.id === protectedRow.id).cells[method.id]?.userEdited;
      }, 'protected manual edit');
      document.querySelector('#review-matrix-table-shell thead input[type="checkbox"]').click();
      document.getElementById('review-matrix-prefill').click();
      await waitUntil(() => /预填结束/.test(document.getElementById('review-matrix-status').textContent), 'matrix prefill');
      snapshot = await window.electronAPI.listReviewMatrices(projectId);
      const populated = snapshot.matrices[0];
      const project = await window.electronAPI.loadProject(projectId);
      const pdfRows = populated.rows.filter(row => row.taskStatus === 'completed' && Object.values(row.cells).some(cell => cell.basis === 'pdf-evidence'));
      const abstractRows = populated.rows.filter(row => row.taskStatus === 'completed' && Object.values(row.cells).some(cell => cell.basis === 'abstract-only'));
      const failedRows = populated.rows.filter(row => row.taskStatus === 'failed');
      const protectedCell = populated.rows.find(row => row.id === protectedRow.id).cells[method.id];
      const modelConfirmedCells = populated.rows.flatMap(row => Object.values(row.cells)).filter(cell => cell.origin === 'ai' && cell.reviewStatus === 'confirmed');
      const evidenceBoundCells = populated.rows.flatMap(row => Object.values(row.cells)).filter(cell => cell.basis === 'pdf-evidence');
      const abstractCells = populated.rows.flatMap(row => Object.values(row.cells)).filter(cell => cell.basis === 'abstract-only');
      const cellsMissingCitationId = populated.rows.flatMap(row => Object.values(row.cells)).filter(cell => !cell.citationItemId);

      document.getElementById('review-matrix-export-csv').click();
      await waitUntil(() => /已导出 CSV/.test(document.getElementById('review-matrix-status').textContent), 'CSV export');
      document.getElementById('review-matrix-export-xlsx').click();
      await waitUntil(() => /已导出 XLSX/.test(document.getElementById('review-matrix-status').textContent), 'XLSX export');

      const beforeBlockedRequests = ${mock.requests.length};
      await window.setEssayflowPrivacyMode('local-only');
      settings = await window.electronAPI.updateExportableSettings({ providerId: 'm5-remote-fixture', providerOrigin: 'https://provider.example', model: 'remote-model' });
      window.essayflowDataState.settings = settings.settings;
      await window.electronAPI.setProviderCredential({ providerId: 'm5-remote-fixture', value: 'm5-remote-secret-canary' });
      const allSelector = document.querySelector('#review-matrix-table-shell thead input[type="checkbox"]');
      if (allSelector.checked || allSelector.indeterminate) allSelector.click();
      const blockedCandidate = document.querySelector('tr[data-row-id="' + pdfRows[0].id + '"] input[type="checkbox"]');
      if (!blockedCandidate) throw new Error('local-only 验证缺少可外发的 PDF 矩阵行');
      blockedCandidate.click();
      document.getElementById('review-matrix-prefill').click();
      await waitUntil(() => /预填结束/.test(document.getElementById('review-matrix-status').textContent), 'local-only blocked prefill');
      try {
        await waitUntil(async () => (await window.electronAPI.loadProject(projectId)).aggregate.auditEvents
          .some(event => event.eventType === 'ai-blocked' && event.networkContext?.operation === 'matrix-extraction'), 'local-only blocked audit', 5000);
      } catch (error) {
        const diagnosticProject = await window.electronAPI.loadProject(projectId);
        const diagnosticMatrix = await window.electronAPI.listReviewMatrices(projectId);
        throw new Error(error.message + '; diagnostic=' + JSON.stringify({
          privacyMode: diagnosticProject.aggregate.manifest.privacyMode,
          auditEvents: diagnosticProject.aggregate.auditEvents.slice(-8).map(event => ({
            eventType: event.eventType, operation: event.networkContext?.operation, reason: event.reason
          })),
          rows: diagnosticMatrix.matrices[0].rows.map(row => ({
            citationItemId: row.citationItemId, taskStatus: row.taskStatus, failureReason: row.failureReason, attempt: row.attempt
          }))
        }));
      }
      const afterBlocked = await window.electronAPI.loadProject(projectId);
      const blockedAudit = afterBlocked.aggregate.auditEvents.some(event => event.eventType === 'ai-blocked' && event.networkContext?.operation === 'matrix-extraction');
      const blockedAuditOperations = afterBlocked.aggregate.auditEvents.filter(event => event.eventType === 'ai-blocked').map(event => event.networkContext?.operation || 'missing');
      const firstEditor = document.querySelector('#review-matrix-table-shell tbody td[data-column-id="' + method.id + '"] textarea');
      firstEditor.value = 'local-only 下的手工矩阵内容';
      firstEditor.dispatchEvent(new Event('change', { bubbles: true }));
      await waitUntil(() => /手工编辑已持久化/.test(document.getElementById('review-matrix-status').textContent), 'local-only manual edit');
      document.getElementById('review-matrix-export-xlsx').click();
      await waitUntil(() => /已导出 XLSX/.test(document.getElementById('review-matrix-status').textContent), 'local-only export');
      const finalSnapshot = await window.electronAPI.listReviewMatrices(projectId);
      return {
        projectId,
        matrixId: matrix.id,
        rowCount: populated.rows.length,
        pdfRowCount: pdfRows.length,
        abstractRowCount: abstractRows.length,
        failedRowCount: failedRows.length,
        protectedValue: protectedCell.value,
        protectedUserEdited: protectedCell.userEdited,
        evidenceBoundCellCount: evidenceBoundCells.length,
        abstractSnapshotCount: abstractCells.filter(cell => cell.abstractSnapshotText && /^[0-9a-f]{64}$/.test(cell.abstractSnapshotSha256)).length,
        abstractCellCount: abstractCells.length,
        cellsMissingCitationId: cellsMissingCitationId.length,
        confirmMessages: [...window.__m5ConfirmMessages],
        evidenceRevisionCount: project.aggregate.evidenceRevisions.length,
        proposedEvidenceCount: project.aggregate.evidenceReviewEvents.filter(event => event.status === 'proposed' && event.actor === 'ai').length,
        modelConfirmedCellCount: modelConfirmedCells.length,
        blockedAudit,
        blockedAuditOperations,
        durablePrivacyMode: afterBlocked.aggregate.manifest.privacyMode,
        beforeBlockedRequests,
        finalRevision: finalSnapshot.revision,
        localOnlyManual: finalSnapshot.matrices[0].rows.some(row => Object.values(row.cells).some(cell => cell.value === 'local-only 下的手工矩阵内容')),
        statusText: document.getElementById('review-matrix-status').textContent
      };
    })()`);
  } catch (error) {
    throw new Error(`${error.message}; requests=${JSON.stringify(mock.requests.map(request => ({ url: request.url, bodySha256: sha(request.body) })))}; rendererExceptions=${JSON.stringify(driver.exceptions)}`, { cause: error });
  }

  assert.equal(first.rowCount, 10);
  assert.equal(first.pdfRowCount, 7);
  assert.equal(first.abstractRowCount, 2);
  assert.equal(first.failedRowCount, 1);
  assert.equal(first.protectedValue, '用户先写的方法，不得被默认覆盖');
  assert.equal(first.protectedUserEdited, true);
  assert.ok(first.evidenceBoundCellCount >= 20, JSON.stringify(first));
  assert.equal(first.evidenceRevisionCount, first.evidenceBoundCellCount);
  assert.equal(first.proposedEvidenceCount, first.evidenceBoundCellCount);
  assert.equal(first.abstractSnapshotCount, first.abstractCellCount);
  assert.equal(first.cellsMissingCitationId, 0);
  assert.equal(first.modelConfirmedCellCount, 0);
  assert.equal(first.confirmMessages.some(message => /覆盖手工内容/.test(message)), true);
  assert.equal(first.confirmMessages.some(message => /合计：10 篇｜\d+ 页｜预计发送 \d+ 字符/.test(message) && /M5 候选文献 10/.test(message)), true);
  assert.equal(first.blockedAudit, true, JSON.stringify(first));
  assert.equal(first.localOnlyManual, true);
  assert.equal(mock.requests.length, 9);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  const exportRoot = path.join(profileRoot, 'TestExports');
  const csvPath = path.join(exportRoot, 'EssayFlow-Matrix-CSV.zip');
  const xlsxPath = path.join(exportRoot, 'EssayFlow-Matrix.xlsx');
  assert.ok(fs.statSync(csvPath).size > 500);
  assert.ok(fs.statSync(xlsxPath).size > 500);
  const csvArchive = await JSZip.loadAsync(fs.readFileSync(csvPath));
  assert.deepEqual(Object.keys(csvArchive.files).sort(), ['matrix.csv', 'sources.csv']);
  assert.match(await csvArchive.file('matrix.csv').async('string'), /用户先写的方法，不得被默认覆盖/);
  assert.match(await csvArchive.file('sources.csv').async('string'), /矩阵 ID,单元格 ID,文献 ID,题名,DOI/);
  const workbook = await JSZip.loadAsync(fs.readFileSync(xlsxPath));
  assert.ok(workbook.file('xl/worksheets/sheet1.xml'));
  assert.ok(workbook.file('xl/worksheets/sheet2.xml'));
  assert.match(await workbook.file('xl/worksheets/sheet1.xml').async('string'), /local-only 下的手工矩阵内容/);
  assert.equal(Object.keys(workbook.files).some(name => /vbaProject|externalLinks/i.test(name)), false);

  const screenshotRoot = path.join(root, 'artifacts', 'screenshots');
  fs.mkdirSync(screenshotRoot, { recursive: true });
  const screenshotPath = path.join(screenshotRoot, 'm5-review-matrix.png');
  const screenshot = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
  const screenshotBytes = Buffer.from(screenshot.base64, 'base64');
  assert.ok(screenshotBytes.length > 1000);
  assert.equal(screenshotBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fs.writeFileSync(screenshotPath, screenshotBytes);

  assert.equal(await driver.close(), 0);
  driver = null;
  driver = await launchElectron(launchOptions);
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && window.essayflowReviewMatrixReady === true', { timeoutMs: 45_000 });
  const restart = await driver.client.evaluate(String.raw`(async () => {
    await window.essayflowDataReady;
    await loadProject(${JSON.stringify(first.projectId)});
    document.getElementById('btn-library').click();
    const deadline = Date.now() + 15000;
    document.getElementById('review-matrix-open').click();
    while (Date.now() < deadline && document.querySelectorAll('#review-matrix-table-shell tbody tr').length !== 10 &&
           document.getElementById('review-matrix-status').dataset.kind !== 'error') {
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    const snapshot = await window.electronAPI.listReviewMatrices(${JSON.stringify(first.projectId)});
    return {
      privacyMode: window.getEssayflowProjectContext().privacyMode,
      matrixCount: snapshot.matrices.length,
      rowCount: snapshot.matrices[0].rows.length,
      manualRestored: snapshot.matrices[0].rows.some(row => Object.values(row.cells).some(cell => cell.value === 'local-only 下的手工矩阵内容')),
      renderedRows: document.querySelectorAll('#review-matrix-table-shell tbody tr').length,
      modalHidden: document.getElementById('review-matrix-modal').getAttribute('aria-hidden'),
      matrixStatus: document.getElementById('review-matrix-status').textContent,
      matrixOptionCount: document.querySelectorAll('#review-matrix-select option').length
    };
  })()`);
  assert.equal(restart.privacyMode, 'local-only');
  assert.equal(restart.matrixCount, 1);
  assert.equal(restart.rowCount, 10);
  assert.equal(restart.manualRestored, true);
  assert.equal(restart.renderedRows, 10, JSON.stringify(restart));
  assert.equal(mock.requests.length, 9);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    milestone: 'm5',
    scenario: 'ten-paper review matrix, proposed evidence, abstract drafts, corrupt isolation, CSV/XLSX and local-only',
    fixtureData: 'synthetic',
    passed: true,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    mockTransport: {
      requestCount: mock.requests.length,
      authorizationPresentCount: mock.requests.filter(request => request.authorizationPresent).length,
      payloadSha256: mock.requests.map(request => sha(request.body))
    },
    first,
    restart,
    exports: {
      csvZip: path.relative(root, csvPath).split(path.sep).join('/'),
      xlsx: path.relative(root, xlsxPath).split(path.sep).join('/')
    },
    screenshot: path.relative(root, screenshotPath).split(path.sep).join('/')
  };
  const reportPath = path.join(root, 'artifacts', 'e2e', 'm5', 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});
