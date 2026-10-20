'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { semanticHash } = require('../../src/main/data/canonical');
const { durableWriteJson } = require('../../src/main/data/durable-fs');
const {
  ERROR_CODES,
  FAULT_HOOKS,
  JOURNAL_STATES,
  ProjectRepository,
  summarizeAggregate,
  versionProjection
} = require('../../src/main/data/repository');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-repository-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function monotonicClock(start = '2026-07-16T00:00:00.000Z') {
  let epoch = Date.parse(start);
  return () => new Date(epoch++);
}

function uuid() {
  return crypto.randomUUID();
}

function clone(value) {
  return structuredClone(value);
}

function contentHash(aggregate) {
  return semanticHash(versionProjection(aggregate), {
    excludedPaths: ['$.manifest.revision', '$.manifest.updatedAt']
  });
}

function assetRef(assetId, suffix = '') {
  return {
    assetId,
    sha256: crypto.createHash('sha256').update(`${assetId}:${suffix}`).digest('hex')
  };
}

function fakeAssetStore() {
  const calls = [];
  return {
    calls,
    async garbageCollect(reachableAssetIds, options = {}) {
      const retained = [...reachableAssetIds].sort();
      calls.push({ retained, dryRun: options.dryRun === true });
      return { deleted: [], retained, dryRun: options.dryRun === true };
    }
  };
}

test('create/save/list uses the five journal states and rebuildable index', async t => {
  const rootPath = temporaryDirectory(t);
  const states = [];
  const repository = new ProjectRepository({
    rootPath,
    now: monotonicClock(),
    durableWriteJson: async (root, relativePath, value, options) => {
      if (options.label === 'journal') states.push(value.state);
      return durableWriteJson(root, relativePath, value, options);
    }
  });

  const created = await repository.createProject({ title: '原子项目', author: '测试者' });
  assert.equal(created.revision, 0);
  assert.equal(created.durable, true);
  assert.equal(created.journalState, JOURNAL_STATES.COMPLETE);
  assert.deepEqual(states, [
    JOURNAL_STATES.PREPARING,
    JOURNAL_STATES.STAGED,
    JOURNAL_STATES.COMMIT_READY,
    JOURNAL_STATES.HEAD_COMMITTED,
    JOURNAL_STATES.COMPLETE
  ]);

  const aggregate = await repository.loadProject(created.projectId);
  aggregate.document.html = '<h1>标题</h1><p>中文 and English</p>';
  const saved = await repository.saveProject({
    projectId: created.projectId,
    baseRevision: 0,
    aggregate
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.aggregate.document.html, aggregate.document.html);
  assert.equal((await repository.listProjects())[0].wordCount, 6);

  fs.writeFileSync(path.join(rootPath, 'index.json'), '{broken', 'utf8');
  const restarted = new ProjectRepository({ rootPath, now: monotonicClock('2026-07-17T00:00:00.000Z') });
  const listed = await restarted.listProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].projectId, created.projectId);
  assert.equal((await restarted.loadProject(created.projectId)).document.html, aggregate.document.html);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(rootPath, 'index.json'), 'utf8')));
});

test('100 queued concurrent saves reach the final acknowledged revision and stale CAS is rejected', { timeout: 120_000 }, async t => {
  const rootPath = temporaryDirectory(t);
  const repository = new ProjectRepository({ rootPath, now: monotonicClock() });
  const created = await repository.createProject({ title: '并发保存' });
  const initial = await repository.loadProject(created.projectId);

  const operations = Array.from({ length: 100 }, (_, index) => {
    const aggregate = clone(initial);
    aggregate.document.html = `<p>rapid-edit-${index + 1}</p>`;
    return repository.saveProject({
      projectId: created.projectId,
      baseRevision: index,
      aggregate,
      source: `rapid-edit-${index + 1}`
    });
  });
  const acknowledgements = await Promise.all(operations);
  assert.deepEqual(acknowledgements.map(item => item.revision), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.ok(acknowledgements.every(item => item.durable && item.journalState === JOURNAL_STATES.COMPLETE));

  const finalAggregate = await repository.loadProject(created.projectId);
  assert.equal(finalAggregate.manifest.revision, 100);
  assert.equal(finalAggregate.document.html, '<p>rapid-edit-100</p>');
  await assert.rejects(
    repository.saveProject({
      projectId: created.projectId,
      baseRevision: 99,
      aggregate: finalAggregate
    }),
    error => error.code === ERROR_CODES.REVISION_CONFLICT &&
      error.details.expectedRevision === 100 &&
      error.details.baseRevision === 99
  );

  const restarted = new ProjectRepository({ rootPath, now: monotonicClock('2026-07-17T00:00:00.000Z') });
  const diskAggregate = await restarted.loadProject(created.projectId);
  assert.equal(diskAggregate.manifest.revision, acknowledgements.at(-1).revision);
  assert.equal(semanticHash(diskAggregate), acknowledgements.at(-1).aggregateHash);
});

test('all six named fault hooks preserve the prior complete aggregate in ten repetitions', { timeout: 120_000 }, async t => {
  const rootPath = temporaryDirectory(t);
  let armedStage = null;
  const options = {
    rootPath,
    now: monotonicClock(),
    faultInjector(stage) {
      return stage === armedStage;
    }
  };
  let repository = new ProjectRepository(options);
  const created = await repository.createProject({ title: '故障矩阵', html: '<p>revision-zero</p>' });
  const baseline = await repository.loadProject(created.projectId);
  const baselineHash = semanticHash(baseline);

  for (const stage of FAULT_HOOKS) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const changed = clone(baseline);
      changed.document.html = `<p>${stage}-${attempt}</p>`;
      armedStage = stage;
      await assert.rejects(
        repository.saveProject({
          projectId: created.projectId,
          baseRevision: 0,
          aggregate: changed,
          source: 'fault-matrix'
        }),
        error => error.code === ERROR_CODES.FAULT_INJECTED
      );
      armedStage = null;
      const afterFault = await repository.loadProject(created.projectId);
      assert.equal(afterFault.manifest.revision, 0, `${stage} attempt ${attempt} changed revision`);
      assert.equal(semanticHash(afterFault), baselineHash, `${stage} attempt ${attempt} changed aggregate`);
    }
    repository = new ProjectRepository(options);
    const recovered = await repository.loadProject(created.projectId);
    assert.equal(recovered.manifest.revision, 0, `${stage} recovery selected a partial revision`);
    assert.equal(semanticHash(recovered), baselineHash, `${stage} recovery produced mixed data`);
  }

  const successful = clone(baseline);
  successful.document.html = '<p>after-fault-success</p>';
  const ack = await repository.saveProject({
    projectId: created.projectId,
    baseRevision: 0,
    aggregate: successful
  });
  assert.equal(ack.revision, 1);
  assert.equal((await repository.loadProject(created.projectId)).document.html, successful.document.html);
});

test('a crash after atomic HEAD replacement but before ACK recovers one complete N+1', async t => {
  const rootPath = temporaryDirectory(t);
  let failAfterHead = false;
  const repository = new ProjectRepository({
    rootPath,
    now: monotonicClock(),
    durableWriteJson: async (root, relativePath, value, options) => {
      if (failAfterHead && options.label === 'journal' && value.state === JOURNAL_STATES.HEAD_COMMITTED) {
        failAfterHead = false;
        const error = new Error('simulated process loss before journal acknowledgement');
        error.code = 'EIO';
        throw error;
      }
      return durableWriteJson(root, relativePath, value, options);
    }
  });
  const created = await repository.createProject({ title: 'ACK 边界' });
  const changed = await repository.loadProject(created.projectId);
  changed.document.html = '<p>whole-N-plus-one</p>';
  const citationItemId = uuid();
  changed.citationItems.push({
    schemaVersion: 1,
    id: citationItemId,
    citationItemId,
    projectId: created.projectId,
    type: 'article-journal',
    title: 'Atomic citation',
    capturedAt: changed.manifest.updatedAt
  });
  changed.citationLinks.push({
    schemaVersion: 1,
    id: uuid(),
    projectId: created.projectId,
    insertionMode: 'citation-only',
    items: [{
      citationItemEntryId: uuid(),
      citationItemId,
      evidenceRevisionIds: [],
      sourceCitationSnapshots: [],
      suppressAuthor: false,
      order: 0,
      status: 'active'
    }],
    createdAt: changed.manifest.updatedAt,
    updatedAt: changed.manifest.updatedAt
  });

  failAfterHead = true;
  await assert.rejects(
    repository.saveProject({ projectId: created.projectId, baseRevision: 0, aggregate: changed }),
    error => error.code === ERROR_CODES.IO && error.details.headCommitted === true
  );

  const restarted = new ProjectRepository({ rootPath, now: monotonicClock('2026-07-18T00:00:00.000Z') });
  const recovered = await restarted.loadProject(created.projectId);
  assert.equal(recovered.manifest.revision, 1);
  assert.equal(recovered.document.html, changed.document.html);
  assert.equal(recovered.citationItems.length, 1);
  assert.equal(recovered.citationLinks.length, 1);
});

test('50 immutable versions dedupe unchanged content and ten deterministic restores match semantic summaries', { timeout: 120_000 }, async t => {
  const rootPath = temporaryDirectory(t);
  const repository = new ProjectRepository({ rootPath, now: monotonicClock() });
  const created = await repository.createProject({ title: '版本历史' });
  const expectedByVersion = new Map();

  for (let index = 0; index < 50; index += 1) {
    const current = await repository.loadProject(created.projectId);
    current.manifest.title = `版本-${index + 1}`;
    current.document.html = `<h1>版本 ${index + 1}</h1><p>semantic body ${index + 1} 中文</p>`;
    if (index % 5 === 0) {
      current.citationItems.push({
        id: uuid(),
        projectId: created.projectId,
        title: `Citation ${index}`
      });
    }
    const saved = await repository.saveProject({
      projectId: created.projectId,
      baseRevision: current.manifest.revision,
      aggregate: current,
      source: 'test-edit'
    });
    const checkpoint = await repository.createCheckpoint({
      projectId: created.projectId,
      baseRevision: saved.revision,
      source: index % 10 === 0 ? 'manual-checkpoint' : 'word-import',
      manual: index % 10 === 0
    });
    assert.equal(checkpoint.created, true);
    expectedByVersion.set(checkpoint.version.id, {
      hash: checkpoint.version.snapshotHash,
      summary: clone(checkpoint.version.summary)
    });

    if (index === 0) {
      const duplicate = await repository.createCheckpoint({
        projectId: created.projectId,
        source: 'accepted-ai-change',
        manual: false
      });
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.version.id, checkpoint.version.id);
    }
  }

  const versions = await repository.listVersions(created.projectId);
  assert.equal(versions.length, 50);
  const selected = Array.from({ length: 10 }, (_, index) => versions[(index * 17) % versions.length]);
  for (const version of selected) {
    const expected = expectedByVersion.get(version.id);
    const preview = await repository.previewVersion(created.projectId, version.id);
    assert.equal(preview.target.snapshotHash, expected.hash);
    assert.deepEqual(preview.target, expected.summary);

    const current = await repository.loadProject(created.projectId);
    const restored = await repository.restoreVersion({
      projectId: created.projectId,
      versionId: version.id,
      baseRevision: current.manifest.revision
    });
    assert.equal(restored.durable, true);
    assert.equal(restored.restoredVersionId, version.id);
    const aggregate = await repository.loadProject(created.projectId);
    assert.equal(contentHash(aggregate), expected.hash);
    assert.equal(summarizeAggregate(aggregate).title, expected.summary.title);
    assert.equal(summarizeAggregate(aggregate).wordCount, expected.summary.wordCount);
    assert.equal(summarizeAggregate(aggregate).citationItemCount, expected.summary.citationItemCount);
    const latestAuditEvent = aggregate.auditEvents.reduce((latest, event) => (
      !latest || event.sequence > latest.sequence ? event : latest
    ), null);
    assert.equal(latestAuditEvent.eventType, 'restore');
    assert.equal(latestAuditEvent.resultingRevision, aggregate.manifest.revision);
  }
});

test('retention keeps manual checkpoints and assets reachable through retained history', async t => {
  const rootPath = temporaryDirectory(t);
  const assets = fakeAssetStore();
  const repository = new ProjectRepository({ rootPath, now: monotonicClock(), assetStore: assets });
  const created = await repository.createProject({ title: '保留策略' });
  const historicalAssetId = uuid();
  const currentAssetId = uuid();

  let aggregate = await repository.loadProject(created.projectId);
  aggregate.assetRefs = [assetRef(historicalAssetId, 'history')];
  let saved = await repository.saveProject({
    projectId: created.projectId,
    baseRevision: aggregate.manifest.revision,
    aggregate
  });
  const manual = await repository.createCheckpoint({
    projectId: created.projectId,
    baseRevision: saved.revision,
    source: 'manual-checkpoint',
    manual: true
  });

  for (let index = 0; index < 8; index += 1) {
    aggregate = await repository.loadProject(created.projectId);
    aggregate.document.html = `<p>automatic-${index}</p>`;
    aggregate.assetRefs = [assetRef(currentAssetId, `current-${index}`)];
    saved = await repository.saveProject({
      projectId: created.projectId,
      baseRevision: aggregate.manifest.revision,
      aggregate
    });
    await repository.createCheckpoint({
      projectId: created.projectId,
      baseRevision: saved.revision,
      source: 'accepted-ai-change',
      manual: false
    });
  }

  aggregate = await repository.loadProject(created.projectId);
  const result = await repository.garbageCollectVersions({
    projectId: created.projectId,
    baseRevision: aggregate.manifest.revision,
    policy: { recentAutomatic: 2, dailyDays: 0 }
  });
  assert.ok(result.retainedVersionIds.includes(manual.version.id));
  assert.ok(result.removedVersionIds.length >= 6);
  assert.ok(result.reachableAssetIds.includes(historicalAssetId));
  assert.ok(result.reachableAssetIds.includes(currentAssetId));
  assert.ok(assets.calls.at(-1).retained.includes(historicalAssetId));
  assert.ok(assets.calls.at(-1).retained.includes(currentAssetId));
});

test('trash restore is lossless and permanent deletion protects shared assets', async t => {
  const rootPath = temporaryDirectory(t);
  const assets = fakeAssetStore();
  const repository = new ProjectRepository({ rootPath, now: monotonicClock(), assetStore: assets });
  const sharedAssetId = uuid();
  const exclusiveAssetId = uuid();

  const first = await repository.createProject({ title: '项目 A', html: '<p>A body</p>' });
  let firstAggregate = await repository.loadProject(first.projectId);
  firstAggregate.assetRefs = [assetRef(sharedAssetId, 'shared'), assetRef(exclusiveAssetId, 'exclusive')];
  firstAggregate.citationItems.push({ id: uuid(), projectId: first.projectId, title: 'A citation' });
  let firstSaved = await repository.saveProject({
    projectId: first.projectId,
    baseRevision: 0,
    aggregate: firstAggregate
  });
  await repository.createCheckpoint({
    projectId: first.projectId,
    baseRevision: firstSaved.revision,
    source: 'manual-checkpoint',
    manual: true
  });

  const second = await repository.createProject({ title: '项目 B', html: '<p>B body</p>' });
  const secondAggregate = await repository.loadProject(second.projectId);
  secondAggregate.assetRefs = [assetRef(sharedAssetId, 'shared')];
  await repository.saveProject({
    projectId: second.projectId,
    baseRevision: 0,
    aggregate: secondAggregate
  });

  const beforeTrash = await repository.loadProject(first.projectId);
  const beforeHash = contentHash(beforeTrash);
  const impact = await repository.getTrashImpact(first.projectId);
  assert.deepEqual(impact.sharedAssetIds, [sharedAssetId]);
  assert.deepEqual(impact.exclusiveAssetIds, [exclusiveAssetId]);

  const trashed = await repository.moveToTrash({
    projectId: first.projectId,
    baseRevision: beforeTrash.manifest.revision
  });
  assert.equal(trashed.state, 'trashed');
  await assert.rejects(repository.loadProject(first.projectId), error => error.code === ERROR_CODES.PROJECT_TRASHED);
  assert.equal((await repository.listTrash()).length, 1);

  const restored = await repository.restoreFromTrash({
    projectId: first.projectId,
    baseRevision: trashed.revision
  });
  assert.equal(restored.state, 'active');
  const afterRestore = await repository.loadProject(first.projectId);
  assert.equal(contentHash(afterRestore), beforeHash);
  assert.equal(afterRestore.citationItems.length, 1);
  assert.equal(afterRestore.versions.length, 1);

  const trashedAgain = await repository.moveToTrash({
    projectId: first.projectId,
    baseRevision: afterRestore.manifest.revision
  });
  await assert.rejects(
    repository.permanentlyDelete({ projectId: first.projectId }),
    error => error.code === ERROR_CODES.CONFIRMATION_REQUIRED
  );
  const deleted = await repository.permanentlyDelete({
    projectId: first.projectId,
    confirmed: true,
    baseRevision: trashedAgain.revision
  });
  assert.deepEqual(deleted.sharedAssetIds, [sharedAssetId]);
  assert.deepEqual(deleted.eligibleAssetIds, [exclusiveAssetId]);
  assert.ok(deleted.reachableAssetIds.includes(sharedAssetId));
  assert.ok(!deleted.reachableAssetIds.includes(exclusiveAssetId));
  assert.ok(assets.calls.at(-1).retained.includes(sharedAssetId));
  assert.equal((await repository.listTrash()).length, 0);
  assert.equal((await repository.listProjects()).length, 1);
  await assert.rejects(repository.loadProject(first.projectId), error => error.code === ERROR_CODES.PROJECT_NOT_FOUND);
});
