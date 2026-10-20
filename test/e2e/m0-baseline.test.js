const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const JSZip = require('jszip');
const pdfjs = require('pdfjs-dist/build/pdf.js');
const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { compareProfileSnapshots, snapshotProfile } = require('../../scripts/lib/profile-guard');
const { createSourceTreeManifest, sha256 } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

function candidateRealProfiles() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const names = new Set([packageJson.name, packageJson.build?.productName, 'Electron'].filter(Boolean));
  assert.ok(process.env.APPDATA, 'APPDATA is required for the Windows real-profile guard');
  return [...names].map(name => path.resolve(process.env.APPDATA, name));
}

async function assertDocx(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file('word/document.xml').async('string');
  assert.match(documentXml, /EssayFlow M0/);
  assert.match(documentXml, /\u4e2d\u82f1\u6587/);
  assert.ok(zip.file('word/media/image1.png'));
}

async function assertPdf(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  assert.ok(pdf.numPages >= 1);
  await loadingTask.destroy();
}

async function assertWorkspaceBootstrap(driver) {
  const error = await driver.client.evaluate(`window.essayflowDataReady
    .then(() => null)
    .catch(error => ({
      name: error?.name || 'Error',
      code: error?.code || '',
      message: error?.message || String(error),
      stack: error?.stack || ''
    }))`);
  assert.equal(error, null, `Workspace bootstrap failed: ${JSON.stringify(error, null, 2)}`);
}

async function waitForProjectCommit(profileRoot, projectId, expectedContent, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastContent = '';
  const headPath = path.join(profileRoot, 'workspace', 'projects', projectId, 'HEAD.json');
  while (Date.now() < deadline) {
    try {
      const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
      const commitName = `${String(head.revision).padStart(12, '0')}-${head.commitId}.json`;
      const commitPath = path.join(profileRoot, 'workspace', 'projects', projectId, 'commits', commitName);
      const commit = JSON.parse(fs.readFileSync(commitPath, 'utf8'));
      lastContent = commit.aggregate?.document?.html || '';
      if (lastContent.includes(expectedContent)) return { head, commit, content: lastContent };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for durable project commit at ${headPath}. Last bytes: ${Buffer.byteLength(lastContent)}`);
}

test('M0 Electron baseline survives restart and exports Word/PDF', { timeout: 240_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m0-e2e-'));
  const profileReportPath = path.join(profileRoot, 'profile-report.json');
  const exportArtifactRoot = path.join(root, 'artifacts', 'e2e', 'm0');
  fs.mkdirSync(exportArtifactRoot, { recursive: true });
  const realProfileBefore = new Map(candidateRealProfiles().map(profile => [
    profile.toLowerCase(),
    snapshotProfile(profile)
  ]));
  const startedAt = new Date().toISOString();
  const phases = [];
  let activeDriver = null;
  t.after(async () => {
    if (activeDriver) await activeDriver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });

  activeDriver = await launchElectron({
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath
  });
  await waitForRenderer(activeDriver, "typeof quill !== 'undefined' && appInitializationComplete === true && quill.isEnabled()", {
    timeoutMs: 45_000
  });
  await assertWorkspaceBootstrap(activeDriver);
  const createSetupResult = await activeDriver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, timeout = 30000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Renderer fixture timed out');
    };

    document.getElementById('btn-new-project').click();
    document.getElementById('project-title').value = 'EssayFlow M0 \u4e2d\u82f1\u6587\u9a8c\u6536';
    document.getElementById('project-author').value = '\u5408\u6210\u6d4b\u8bd5\u4f5c\u8005';
    document.getElementById('project-course').value = 'Research Methods';
    document.getElementById('project-reference-style').value = 'APA';
    document.getElementById('modal-create').click();
    await waitUntil(() => !document.getElementById('modal-create').disabled && Boolean(currentProjectId));
    const projectId = currentProjectId;

    let insertAt = Math.max(0, quill.getLength() - 1);
    quill.insertText(insertAt, '\u4e2d\u82f1\u6587\u6df7\u5408\u6bb5\u843d\uff1aEvidence-driven writing remains traceable.\n', Quill.sources.USER);
    const headingStart = quill.getLength() - 1;
    quill.insertText(headingStart, '\u7814\u7a76\u65b9\u6cd5\n', Quill.sources.USER);
    quill.formatLine(headingStart, 4, 'header', 2, Quill.sources.USER);

    quill.setSelection(Math.max(0, quill.getLength() - 1), 0, Quill.sources.SILENT);
    document.getElementById('btn-more-dropdown').click();
    await waitUntil(() => document.getElementById('more-dropdown-menu').classList.contains('open'));
    document.querySelector('#more-dropdown-menu [data-action="insert-table"]').click();
    await waitUntil(() => document.getElementById('table-insert-dialog').classList.contains('open'));
    document.getElementById('table-rows').value = '2';
    document.getElementById('table-cols').value = '2';
    document.getElementById('table-insert-confirm').click();
    await waitUntil(() => Boolean(
      quill.root.querySelector('.ql-table-embed table') &&
      !document.getElementById('table-insert-dialog').classList.contains('open')
    ));

    const imageIndex = Math.max(0, quill.getLength() - 1);
    const fixtureImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDAxAADAA0EAQF7rE1KAAAAAElFTkSuQmCC';
    quill.insertEmbed(imageIndex, 'image', fixtureImage, Quill.sources.USER);
    quill.insertText(imageIndex + 1, '\n', Quill.sources.USER);

    const keywordIndex = Math.max(0, quill.getLength() - 1);
    quill.insertText(keywordIndex, '\u8bc1\u636e\u94fe', Quill.sources.USER);
    quill.formatText(keywordIndex, 3, 'priorityKeyword', {
      keyword: '\u8bc1\u636e\u94fe',
      extracted: '\u8bc1\u636e,\u5f15\u7528,\u8ffd\u6eaf'
    }, Quill.sources.USER);
    quill.insertText(keywordIndex + 3, '\n', Quill.sources.USER);

    const paper = {
      id: 'fixture-paper-m0',
      title: 'Traceable Evidence for Synthetic Acceptance Testing',
      authors: ['Alice Fixture', '\u738b\u660e'],
      year: '2024',
      source: 'Fixture Journal',
      doi: '10.5555/essayflow.m0',
      abstract: 'Synthetic fixture only. No private or live research data.',
      url: 'https://example.invalid/fixture-paper'
    };
    addToLibrary(paper);
    window._draggingPaper = paper;
    const transfer = new DataTransfer();
    transfer.setData('application/json', JSON.stringify(paper));
    const editor = quill.root;
    const rect = editor.getBoundingClientRect();
    editor.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: rect.left + 8,
      clientY: rect.bottom - 2
    }));
    const getFixtureCitationState = () => {
      const anchor = quill.root.querySelector('sup[data-citation-instance-id]');
      const citationInstanceId = anchor?.getAttribute('data-citation-instance-id') || '';
      const cluster = citations.find(value => (value.citationInstanceId || value.id) === citationInstanceId);
      const item = cluster?.items?.length === 1
        ? cluster.items[0]
        : cluster?.items?.find(value => value.paperId === paper.id);
      const reference = item
        ? quill.root.querySelector('p[data-ref-section][data-citation-item-id="' + item.citationItemId + '"]')
        : null;
      return { anchor, citationInstanceId, cluster, item, reference };
    };
    try {
      await waitUntil(() => {
        const state = getFixtureCitationState();
        return Boolean(state.anchor && state.cluster && state.item && state.reference);
      });
    } catch (error) {
      const state = getFixtureCitationState();
      throw new Error(error.message + ' ' + JSON.stringify({
        citationInstanceId: state.citationInstanceId,
        citationCount: citations.length,
        cluster: state.cluster,
        item: state.item,
        hasAnchor: Boolean(state.anchor),
        hasReference: Boolean(state.reference),
        saveState: document.getElementById('save-status').dataset.state,
        documentRevision,
        savedRevision,
        currentProjectRevision,
        autoSaveInFlight: Boolean(autoSaveInFlight),
        editorTail: quill.root.innerHTML.slice(-1200)
      }));
    }

    // Let all setup edits and their scheduled saves settle before measuring the
    // final user edit. The measured edit below must travel through the real
    // text-change debounce and save queue; the test never calls autoSaveProject.
    await waitUntil(() => (
      document.getElementById('save-status').dataset.state === 'saved' &&
      autoSaveInFlight === null &&
      documentRevision === savedRevision
    ));
    await new Promise(resolve => setTimeout(resolve, 1200));
    await waitUntil(() => (
      document.getElementById('save-status').dataset.state === 'saved' &&
      autoSaveInFlight === null &&
      documentRevision === savedRevision
    ));

    const evidenceText = 'Evidence-driven writing remains traceable.';
    const evidenceEnd = quill.getText().indexOf(evidenceText) + evidenceText.length;
    if (evidenceEnd < evidenceText.length) throw new Error('Unable to place autosave edit cursor');
    const saveStatus = document.getElementById('save-status');
    const probe = {
      states: [{ state: saveStatus.dataset.state, at: performance.now() }],
      startedAt: performance.now(),
      firstInputAt: null,
      lastInputAt: null,
      startRevision: documentRevision,
      startSavedRevision: savedRevision
    };
    probe.observer = new MutationObserver(() => {
      probe.states.push({ state: saveStatus.dataset.state, at: performance.now() });
    });
    probe.observer.observe(saveStatus, { attributes: true, attributeFilter: ['data-state'] });
    window.__m0AutoSaveProbe = probe;
    quill.setSelection(evidenceEnd, 0, Quill.sources.SILENT);
    quill.focus();

    const fixtureCitationState = getFixtureCitationState();
    return {
      projectId,
      title: getFirstH1(),
      hasTable: Boolean(quill.root.querySelector('.ql-table-embed table')),
      hasImage: Boolean(quill.root.querySelector('img')),
      hasPriorityKeyword: Boolean(quill.root.querySelector('.priority-keyword[data-priority-keyword="true"]')),
      hasCitation: Boolean(fixtureCitationState.anchor),
      hasCitationLink: Boolean(fixtureCitationState.cluster && fixtureCitationState.item),
      hasReferences: Boolean(fixtureCitationState.reference),
      citationInstanceId: fixtureCitationState.citationInstanceId,
      citationItemId: fixtureCitationState.item?.citationItemId || ''
    };
  })()`);
  const autosaveSentinel = ' M0_AUTOSAVE_DURABLE_SENTINEL';
  await activeDriver.client.evaluate('window.__m0AutoSaveProbe.firstInputAt = performance.now()');
  await activeDriver.client.send('Input.insertText', { text: ' M0_AUTOSAVE_' });
  await new Promise(resolve => setTimeout(resolve, 350));
  await activeDriver.client.evaluate('window.__m0AutoSaveProbe.lastInputAt = performance.now()');
  await activeDriver.client.send('Input.insertText', { text: 'DURABLE_SENTINEL' });
  await waitForRenderer(activeDriver, String.raw`(() => {
    const probe = window.__m0AutoSaveProbe;
    if (!probe || !quill.getText().includes(${JSON.stringify(autosaveSentinel)})) return false;
    const unsavedIndex = probe.states.findIndex(entry => entry.state === 'unsaved');
    const savingIndex = probe.states.findIndex((entry, index) => index > unsavedIndex && entry.state === 'saving');
    const savedIndex = probe.states.findIndex((entry, index) => index > savingIndex && entry.state === 'saved');
    return unsavedIndex >= 0 && savingIndex > unsavedIndex && savedIndex > savingIndex &&
      document.getElementById('save-status').dataset.state === 'saved' &&
      autoSaveInFlight === null && documentRevision === savedRevision;
  })()`, { timeoutMs: 30_000 });
  const autosaveResult = await activeDriver.client.evaluate(String.raw`(() => {
    const probe = window.__m0AutoSaveProbe;
    probe.observer.disconnect();
    const unsavedIndex = probe.states.findIndex(entry => entry.state === 'unsaved');
    const savingIndex = probe.states.findIndex((entry, index) => index > unsavedIndex && entry.state === 'saving');
    const savedIndex = probe.states.findIndex((entry, index) => index > savingIndex && entry.state === 'saved');
    return {
      states: probe.states.map(({ state, at }) => ({ state, at })),
      startRevision: probe.startRevision,
      startSavedRevision: probe.startSavedRevision,
      finalRevision: documentRevision,
      finalSavedRevision: savedRevision,
      firstInputAt: probe.firstInputAt,
      lastInputAt: probe.lastInputAt,
      savingDelayAfterLastInputMs: probe.states[savingIndex].at - probe.lastInputAt,
      savedDelayAfterLastInputMs: probe.states[savedIndex].at - probe.lastInputAt,
      saveState: document.getElementById('save-status').dataset.state,
      hasSentinel: quill.getText().includes(${JSON.stringify(autosaveSentinel)})
    };
  })()`);
  const createResult = { ...createSetupResult, autosave: autosaveResult };
  assert.match(createResult.projectId, /^[A-Za-z0-9_-]+$/);
  assert.equal(createResult.title, 'EssayFlow M0 \u4e2d\u82f1\u6587\u9a8c\u6536');
  assert.equal(createResult.hasTable, true);
  assert.equal(createResult.hasImage, true);
  assert.equal(createResult.hasPriorityKeyword, true);
  assert.equal(createResult.hasCitation, true);
  assert.equal(createResult.hasCitationLink, true);
  assert.equal(createResult.hasReferences, true);
  assert.match(createResult.citationInstanceId, /^[0-9a-f-]{36}$/i);
  assert.match(createResult.citationItemId, /^[0-9a-f-]{36}$/i);
  assert.equal(createResult.autosave.hasSentinel, true);
  assert.equal(createResult.autosave.saveState, 'saved');
  assert.ok(createResult.autosave.finalRevision > createResult.autosave.startRevision);
  assert.equal(createResult.autosave.finalSavedRevision, createResult.autosave.finalRevision);
  assert.ok(
    createResult.autosave.savingDelayAfterLastInputMs >= 800,
    `Autosave did not honor the edit debounce: ${createResult.autosave.savingDelayAfterLastInputMs}ms`
  );
  assert.equal(activeDriver.exceptions.length, 0, JSON.stringify(activeDriver.exceptions, null, 2));
  assert.equal(activeDriver.securityErrors.length, 0, JSON.stringify(activeDriver.securityErrors, null, 2));
  phases.push({ name: 'create-and-save', result: createResult });

  const durableCommit = await waitForProjectCommit(profileRoot, createResult.projectId, autosaveSentinel);
  assert.equal(durableCommit.head.commitId, durableCommit.commit.commitId);
  assert.equal(durableCommit.head.revision, durableCommit.commit.revision);
  const savedHtml = durableCommit.content;
  assert.match(savedHtml, /ql-table-embed/);
  assert.match(savedHtml, /data-priority-keyword="true"/);
  assert.match(savedHtml, new RegExp(`data-citation-instance-id="${createResult.citationInstanceId}"`));
  const durableCitation = durableCommit.commit.aggregate.citationLinks.find(
    value => (value.citationInstanceId || value.id) === createResult.citationInstanceId
  );
  assert.ok(durableCitation, 'Durable CitationLink is missing for the editor anchor');
  assert.ok(
    durableCitation.items.some(item => item.citationItemId === createResult.citationItemId),
    'Durable CitationLink item does not match the rendered bibliography entry'
  );
  const durableCitationItem = durableCommit.commit.aggregate.citationItems.find(
    item => (item.citationItemId || item.id) === createResult.citationItemId
  );
  assert.ok(durableCitationItem, 'Durable CitationItem snapshot is missing');
  assert.equal(durableCitationItem.title, 'Traceable Evidence for Synthetic Acceptance Testing');
  assert.equal(durableCitationItem.DOI, '10.5555/essayflow.m0');
  const profileReport = activeDriver.profileReport;
  const firstExitCode = await activeDriver.close();
  assert.equal(firstExitCode, 0, `First Electron phase exit code: ${firstExitCode}`);
  activeDriver = null;

  activeDriver = await launchElectron({
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath
  });
  await waitForRenderer(activeDriver, "typeof quill !== 'undefined' && appInitializationComplete === true && quill.isEnabled()", {
    timeoutMs: 45_000
  });
  await assertWorkspaceBootstrap(activeDriver);
  const reloadResult = await activeDriver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, timeout = 90000, label = 'reload/export condition') => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Renderer ' + label + ' timed out');
    };
    document.getElementById('btn-projects').click();
    try {
      await waitUntil(
        () => document.getElementById('projects-modal').classList.contains('open'),
        30000,
        'project modal open'
      );
      await waitUntil(
        () => Boolean(document.querySelector('.btn-load[data-id=${JSON.stringify(createResult.projectId)}]')),
        60000,
        'project list population'
      );
    } catch (error) {
      throw new Error(error.message + ' ' + JSON.stringify({
        projectId: ${JSON.stringify(createResult.projectId)},
        modalClass: document.getElementById('projects-modal')?.className || '',
        projectListText: document.getElementById('projects-list')?.textContent?.slice(0, 1000) || '',
        loadButtonIds: Array.from(document.querySelectorAll('.btn-load[data-id]')).map(button => button.dataset.id),
        appInitializationComplete,
        dataReadyState: window.essayflowDataReady ? 'available' : 'missing',
        currentProjectId,
        projectLoadToken
      }));
    }
    const loadButton = document.querySelector('.btn-load[data-id=${JSON.stringify(createResult.projectId)}]');
    const listed = Boolean(loadButton);
    const loadTokenBeforeClick = projectLoadToken;
    loadButton.click();
    await waitUntil(() => projectLoadToken > loadTokenBeforeClick, 90000, 'project load start');
    await waitUntil(() => (
      currentProjectId === ${JSON.stringify(createResult.projectId)} &&
      !isLoadingProject && quill.isEnabled()
    ), 90000, 'project load completion');
    await waitUntil(() => document.getElementById('save-status').dataset.state === 'saved', 90000, 'saved state');
    try {
      await waitUntil(() => Boolean(quill.root.querySelector('p[data-ref-section]')), 5000, 'reference render');
    } catch (error) {
      throw new Error(error.message + ' ' + JSON.stringify({
        citationCount: citations.length,
        citations,
        citationStorage: localStorage.getItem('essay_citations_v2'),
        currentProjectId,
        citationAnchorCount: quill.root.querySelectorAll('sup[data-citation-instance-id]').length,
        isUpdatingReferences,
        pendingReferenceUpdate,
        libraryCount: Array.isArray(window.libraryPapers) ? window.libraryPapers.length : -1,
        editorTail: quill.root.innerHTML.slice(-1200)
      }));
    }
    const anchor = quill.root.querySelector(
      'sup[data-citation-instance-id="' + ${JSON.stringify(createResult.citationInstanceId)} + '"]'
    );
    const restoredCluster = citations.find(value =>
      (value.citationInstanceId || value.id) === ${JSON.stringify(createResult.citationInstanceId)}
    );
    const restoredItem = restoredCluster?.items?.find(value =>
      value.citationItemId === ${JSON.stringify(createResult.citationItemId)}
    );
    const restoredReference = restoredItem
      ? quill.root.querySelector('p[data-ref-section][data-citation-item-id="' + restoredItem.citationItemId + '"]')
      : null;
    const restored = {
      listed,
      title: getFirstH1(),
      hasChineseEnglish: quill.getText().includes('\u4e2d\u82f1\u6587\u6df7\u5408\u6bb5\u843d') && quill.getText().includes('Evidence-driven'),
      hasAutosaveSentinel: quill.getText().includes(${JSON.stringify(autosaveSentinel)}),
      hasTable: Boolean(quill.root.querySelector('.ql-table-embed table')),
      hasImage: Boolean(quill.root.querySelector('img')),
      hasPriorityKeyword: Boolean(quill.root.querySelector('.priority-keyword[data-priority-keyword="true"]')),
      hasCitation: Boolean(anchor),
      hasCitationLink: Boolean(restoredCluster && restoredItem),
      hasReferences: Boolean(restoredReference)
    };

    const wordButton = document.getElementById('btn-export-word');
    wordButton.click();
    await waitUntil(() => wordButton.disabled);
    await waitUntil(() => !wordButton.disabled);
    const pdfButton = document.getElementById('btn-export');
    pdfButton.click();
    await waitUntil(() => pdfButton.disabled);
    await waitUntil(() => !pdfButton.disabled, 120000);
    await new Promise(resolve => setTimeout(resolve, 300));
    return { ...restored, finalToast: document.getElementById('toast').textContent };
  })()`);
  Object.entries(reloadResult).forEach(([key, value]) => {
    if (key.startsWith('has') || key === 'listed') assert.equal(value, true, `${key} was not restored`);
  });
  assert.equal(reloadResult.title, 'EssayFlow M0 \u4e2d\u82f1\u6587\u9a8c\u6536');
  assert.equal(activeDriver.exceptions.length, 0, JSON.stringify(activeDriver.exceptions, null, 2));
  assert.equal(activeDriver.securityErrors.length, 0, JSON.stringify(activeDriver.securityErrors, null, 2));
  phases.push({ name: 'reload-and-export', result: reloadResult });
  const secondExitCode = await activeDriver.close();
  assert.equal(secondExitCode, 0, `Second Electron phase exit code: ${secondExitCode}`);
  activeDriver = null;

  const wordPath = profileReport.deterministicExports.docx;
  const pdfPath = profileReport.deterministicExports.pdf;
  assert.ok(fs.existsSync(wordPath), `Word export missing: ${wordPath}`);
  assert.ok(fs.existsSync(pdfPath), `PDF export missing: ${pdfPath}`);
  await assertDocx(wordPath);
  await assertPdf(pdfPath);
  const artifactWordPath = path.join(exportArtifactRoot, 'EssayFlow.docx');
  const artifactPdfPath = path.join(exportArtifactRoot, 'EssayFlow.pdf');
  fs.copyFileSync(wordPath, artifactWordPath);
  fs.copyFileSync(pdfPath, artifactPdfPath);

  const defaultProfileKey = path.resolve(profileReport.defaultUserData).toLowerCase();
  const before = realProfileBefore.get(defaultProfileKey);
  assert.ok(before, `Default profile was not snapshotted before launch: ${profileReport.defaultUserData}`);
  const after = snapshotProfile(before.path);
  const profileComparison = compareProfileSnapshots(before, after);
  assert.equal(profileComparison.unchanged, true, profileComparison.differences.join('\n'));

  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    scenario: 'M0 baseline create-save-restart-reload-export',
    fixtureData: 'synthetic',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    isolatedProfile: profileRoot,
    phases,
    exports: {
      docx: { path: artifactWordPath, bytes: fs.statSync(artifactWordPath).size, sha256: sha256(fs.readFileSync(artifactWordPath)) },
      pdf: { path: artifactPdfPath, bytes: fs.statSync(artifactPdfPath).size, sha256: sha256(fs.readFileSync(artifactPdfPath)) }
    },
    realProfile: {
      path: before.path,
      beforeFileCount: before.fileCount,
      afterFileCount: after.fileCount,
      beforeContentTreeSha256: before.contentTreeSha256,
      afterContentTreeSha256: after.contentTreeSha256,
      unchanged: profileComparison.unchanged,
      differences: profileComparison.differences
    },
    passed: true
  };
  const reportPath = path.join(exportArtifactRoot, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`M0 E2E report: ${reportPath}`);
});
