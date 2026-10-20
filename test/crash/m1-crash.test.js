'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { semanticHash } = require('../../src/main/data/canonical');
const { durableWriteJson } = require('../../src/main/data/durable-fs');
const { FAULT_HOOKS, ProjectRepository } = require('../../src/main/data/repository');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');
const projectId = 'c0000000-0000-4000-8000-000000000001';

function temporaryWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-crash-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function nextAggregate(current, marker) {
  const aggregate = structuredClone(current);
  aggregate.document.html = `<h1>Crash fixture</h1><p>${marker}</p>`;
  aggregate.manifest.title = `Crash fixture ${marker}`;
  return aggregate;
}

async function createBaseline(workspace) {
  const repository = new ProjectRepository({ rootPath: workspace });
  const ack = await repository.createProject({
    projectId,
    title: 'Crash fixture N',
    html: '<h1>Crash fixture</h1><p>N</p>',
    createdAt: '2026-07-16T00:00:00.000Z'
  });
  return { repository, ack, aggregate: await repository.loadProject(projectId) };
}

function writeReport(report) {
  const outputPath = path.join(root, 'artifacts', 'crash-matrix.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, outputPath);
  return outputPath;
}

test('M1 crash matrix never exposes a mixed or corrupt project aggregate', { timeout: 120_000 }, async t => {
  const startedAt = new Date().toISOString();
  const rows = [];
  let mixed = 0;
  let corrupt = 0;

  for (const hook of FAULT_HOOKS) {
    for (let repetition = 0; repetition < 10; repetition += 1) {
      const workspace = temporaryWorkspace(t);
      const baseline = await createBaseline(workspace);
      const oldHash = semanticHash(baseline.aggregate);
      const next = nextAggregate(baseline.aggregate, `${hook}-${repetition}`);
      const nextHashIgnoringRevision = semanticHash(next, { volatilePaths: ['$.manifest.revision', '$.manifest.updatedAt'] });
      let fired = false;
      const faulting = new ProjectRepository({
        rootPath: workspace,
        faultInjector(stage) {
          if (!fired && stage === hook) {
            fired = true;
            const error = new Error(`Injected crash at ${hook}`);
            error.injected = true;
            throw error;
          }
        }
      });
      await assert.rejects(faulting.saveProject({
        projectId,
        baseRevision: 0,
        aggregate: next,
        source: 'crash-fixture'
      }));
      const recovered = new ProjectRepository({ rootPath: workspace });
      await recovered.initialize();
      let loaded;
      try {
        loaded = await recovered.loadProject(projectId);
      } catch (error) {
        corrupt += 1;
        rows.push({ hook, repetition, outcome: 'corrupt', error: error.message });
        continue;
      }
      const loadedHash = semanticHash(loaded);
      const loadedBusinessHash = semanticHash(loaded, { volatilePaths: ['$.manifest.revision', '$.manifest.updatedAt'] });
      const outcome = loadedHash === oldHash
        ? 'complete-N'
        : loadedBusinessHash === nextHashIgnoringRevision
          ? 'complete-N+1'
          : 'mixed';
      if (outcome === 'mixed') mixed += 1;
      rows.push({ hook, repetition, outcome, recoveredRevision: loaded.manifest.revision });
    }
  }

  for (const osCode of ['ENOSPC', 'EACCES', 'EBUSY']) {
    const workspace = temporaryWorkspace(t);
    const baseline = await createBaseline(workspace);
    const oldHash = semanticHash(baseline.aggregate);
    const faulting = new ProjectRepository({
      rootPath: workspace,
      faultInjector(stage) {
        if (stage !== 'temp-write') return;
        const error = new Error(osCode);
        error.code = osCode;
        throw error;
      }
    });
    await assert.rejects(faulting.saveProject({
      projectId,
      baseRevision: 0,
      aggregate: nextAggregate(baseline.aggregate, osCode)
    }));
    const recovered = new ProjectRepository({ rootPath: workspace });
    assert.equal(semanticHash(await recovered.loadProject(projectId)), oldHash);
    rows.push({ hook: 'temp-write', osCode, outcome: 'complete-N', recoveredRevision: 0 });
  }

  {
    const workspace = temporaryWorkspace(t);
    const baseline = await createBaseline(workspace);
    let headWritten = false;
    const faulting = new ProjectRepository({
      rootPath: workspace,
      durableWriteJson: async (rootPath, relativePath, value, options) => {
        const result = await durableWriteJson(rootPath, relativePath, value, options);
        if (!headWritten && /(?:^|[\\/])HEAD\.json$/.test(relativePath)) {
          headWritten = true;
          const error = new Error('Simulated process death after HEAD replacement');
          error.code = 'INJECTED_FAULT';
          throw error;
        }
        return result;
      }
    });
    await assert.rejects(faulting.saveProject({
      projectId,
      baseRevision: 0,
      aggregate: nextAggregate(baseline.aggregate, 'HEAD-before-ACK')
    }));
    const recovered = new ProjectRepository({ rootPath: workspace });
    await recovered.initialize();
    const loaded = await recovered.loadProject(projectId);
    assert.equal(loaded.manifest.revision, 1);
    assert.match(loaded.document.html, /HEAD-before-ACK/);
    rows.push({ hook: 'HEAD-replaced-before-ACK', outcome: 'complete-N+1', recoveredRevision: 1 });
  }

  {
    const workspace = temporaryWorkspace(t);
    const baseline = await createBaseline(workspace);
    const ack = await baseline.repository.saveProject({
      projectId,
      baseRevision: 0,
      aggregate: nextAggregate(baseline.aggregate, 'ACK-received')
    });
    assert.equal(ack.durable, true);
    assert.equal(ack.journalState, 'COMPLETE');
    const restarted = new ProjectRepository({ rootPath: workspace });
    const loaded = await restarted.loadProject(projectId);
    assert.equal(loaded.manifest.revision, 1);
    assert.match(loaded.document.html, /ACK-received/);
    rows.push({ hook: 'after-durable-ACK', outcome: 'complete-N+1', recoveredRevision: 1 });
  }

  assert.equal(mixed, 0);
  assert.equal(corrupt, 0);
  assert.equal(rows.filter(row => row.repetition !== undefined).length, FAULT_HOOKS.length * 10);
  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    milestone: 'm1',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    repetitionsPerHook: 10,
    hooks: FAULT_HOOKS,
    rows,
    mixed,
    corrupt,
    passed: mixed === 0 && corrupt === 0
  };
  const reportPath = writeReport(report);
  assert.ok(fs.existsSync(reportPath));
});
