'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspaceService } = require('../../src/main/data/workspace-service');

const root = path.resolve(__dirname, '..', '..');

function safeStorageStub() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

test('legacy profile upgrades once, survives three service restarts and accepts a durable post-upgrade edit', async t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-upgrade-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'test', 'fixtures', 'profiles', 'legacy', 'userData'), userDataPath, { recursive: true });
  const localStorage = JSON.parse(fs.readFileSync(
    path.join(root, 'test', 'fixtures', 'profiles', 'legacy', 'renderer', 'local-storage.json'),
    'utf8'
  ));
  const snapshot = { localStorage, indexedDbLibrary: [] };

  const firstService = new WorkspaceService({ userDataPath, appVersion: '1.1.0', safeStorage: safeStorageStub() });
  const first = await firstService.bootstrapLegacy(snapshot);
  assert.equal(first.migration.migrated, true);
  const [project] = await firstService.listProjects();
  const loaded = await firstService.loadProject(project.projectId);
  const saved = await firstService.saveProject({
    projectId: project.projectId,
    baseRevision: loaded.revision,
    content: `${loaded.content}<p>升级后的持久化编辑</p>`,
    meta: loaded.meta,
    citations: loaded.citations,
    source: 'upgrade-test'
  });
  assert.equal(saved.durable, true);
  assert.equal(saved.journalState, 'COMPLETE');

  for (let restart = 0; restart < 2; restart++) {
    const service = new WorkspaceService({ userDataPath, appVersion: '1.1.0', safeStorage: safeStorageStub() });
    const boot = await service.bootstrapLegacy(snapshot);
    assert.equal(boot.migration.migrated, false);
    const projects = await service.listProjects();
    assert.equal(projects.length, 1);
    const reloaded = await service.loadProject(project.projectId);
    assert.match(reloaded.content, /升级后的持久化编辑/);
    assert.equal(reloaded.revision, saved.revision);
  }
});
