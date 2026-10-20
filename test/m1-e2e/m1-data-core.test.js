'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

test('M1 project center creates history, restores a version and recovers a trashed project', { timeout: 120_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m1-e2e-'));
  const profileReportPath = path.join(profileRoot, 'profile-report.json');
  let driver = await launchElectron({ rootPath: root, userDataPath: profileRoot, profileReportPath });
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, "appInitializationComplete === true && quill.isEnabled()", { timeoutMs: 45_000 });

  const result = await driver.client.evaluate(String.raw`(async () => {
    const waitUntil = async (predicate, timeout = 30000, label = 'condition') => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('M1 renderer ' + label + ' timed out');
    };
    await window.essayflowDataReady;
    const projectId = crypto.randomUUID();
    const created = await window.electronAPI.saveProjectAuto({
      projectId,
      baseRevision: -1,
      content: '<h1>M1 数据核心</h1><p>版本一</p>',
      meta: { title: 'M1 数据核心', referenceStyle: 'MLA' },
      citations: [],
      source: 'm1-e2e-create'
    });
    if (!created.durable || created.journalState !== 'COMPLETE') throw new Error('Initial project was not durable');
    await loadProject(projectId);

    document.getElementById('btn-projects').click();
    await waitUntil(
      () => document.getElementById('projects-modal').classList.contains('open'),
      30000,
      'project modal open'
    );
    await waitUntil(
      () => Boolean(document.querySelector('.btn-history[data-id="' + projectId + '"]')),
      30000,
      'project list population'
    );
    document.getElementById('project-checkpoint-btn').click();
    try {
      await waitUntil(
        async () => (await window.electronAPI.listProjectVersions(projectId)).length === 1,
        5000,
        'checkpoint creation'
      );
    } catch (error) {
      throw new Error(error.message + ' ' + JSON.stringify({
        projectId,
        currentProjectId,
        currentProjectRevision,
        documentRevision,
        savedRevision,
        saveState: document.getElementById('save-status').dataset.state,
        toast: document.getElementById('toast')?.textContent || '',
        versions: await window.electronAPI.listProjectVersions(projectId)
      }));
    }
    const [version] = await window.electronAPI.listProjectVersions(projectId);

    closeModalEl(document.getElementById('projects-modal'));
    quill.insertText(Math.max(0, quill.getLength() - 1), '版本二新增内容', Quill.sources.USER);
    await waitUntil(
      () => documentRevision === savedRevision && document.getElementById('save-status').dataset.state === 'saved',
      30000,
      'edited document durable save'
    );
    const revisionAfterEdit = currentProjectRevision;

    document.getElementById('btn-projects').click();
    await waitUntil(
      () => Boolean(document.querySelector('.btn-history[data-id="' + projectId + '"]')),
      30000,
      'history action population'
    );
    document.querySelector('.btn-history[data-id="' + projectId + '"]').click();
    await waitUntil(
      () => Boolean(document.querySelector('.btn-version-restore[data-id="' + version.id + '"]')),
      30000,
      'version history population'
    );
    const preview = await window.electronAPI.previewProjectVersion({ projectId, versionId: version.id });
    if (!preview.changes.documentChanged) throw new Error('Version preview did not detect document changes');
    window.confirm = () => true;
    document.querySelector('.btn-version-restore[data-id="' + version.id + '"]').click();
    await waitUntil(
      () => !quill.getText().includes('版本二新增内容') && currentProjectRevision > revisionAfterEdit,
      30000,
      'version restore completion'
    );

    closeModalEl(document.getElementById('project-data-modal'));
    document.getElementById('btn-projects').click();
    await waitUntil(
      () => Boolean(document.querySelector('.btn-delete[data-id="' + projectId + '"]')),
      30000,
      'delete action population'
    );
    document.querySelector('.btn-rename[data-id="' + projectId + '"]').click();
    const renameInput = document.querySelector('.project-item[data-id="' + projectId + '"] .project-rename-input');
    renameInput.value = '项目中心改名成功';
    document.querySelector('.project-item[data-id="' + projectId + '"] .project-rename-save').click();
    await waitUntil(
      async () => (await window.electronAPI.listProjects()).find(item => item.projectId === projectId)?.title === '项目中心改名成功',
      30000,
      'project rename durable commit'
    );
    document.querySelector('.btn-delete[data-id="' + projectId + '"]').click();
    await waitUntil(
      () => document.getElementById('essayflow-confirm-modal').classList.contains('open'),
      30000,
      'styled trash confirmation'
    );
    const trashDialogTitle = document.getElementById('essayflow-confirm-title').textContent;
    const trashDialogDetails = document.querySelectorAll('#essayflow-confirm-details .ef-confirm-detail').length;
    document.getElementById('essayflow-confirm-accept').click();
    await waitUntil(async () => (await window.electronAPI.listTrash()).length === 1, 30000, 'trash commit');
    document.getElementById('project-trash-btn').click();
    await waitUntil(
      () => Boolean(document.querySelector('.btn-trash-restore[data-id="' + projectId + '"]')),
      30000,
      'trash list population'
    );
    document.querySelector('.btn-trash-restore[data-id="' + projectId + '"]').click();
    await waitUntil(
      async () => (await window.electronAPI.listProjects()).some(item => item.projectId === projectId),
      30000,
      'trash restore completion'
    );

    const restored = await window.electronAPI.loadProject(projectId);
    return {
      projectId,
      checkpointId: version.id,
      revision: restored.revision,
      content: restored.content,
      title: restored.meta.title,
      trashDialogTitle,
      trashDialogDetails,
      trashCount: (await window.electronAPI.listTrash()).length,
      projectCount: (await window.electronAPI.listProjects()).length
    };
  })()`);

  assert.match(result.content, /版本一/);
  assert.doesNotMatch(result.content, /版本二新增内容/);
  assert.equal(result.title, '项目中心改名成功');
  assert.match(result.trashDialogTitle, /项目中心改名成功/);
  assert.equal(result.trashDialogDetails, 3);
  assert.equal(result.trashCount, 0);
  assert.equal(result.projectCount, 1);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    milestone: 'm1',
    passed: true,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    result
  };
  const reportPath = path.join(root, 'artifacts', 'e2e', 'm1', 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
});
