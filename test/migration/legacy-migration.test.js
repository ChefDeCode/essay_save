'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AssetStore } = require('../../src/main/data/asset-store');
const { LibraryStore } = require('../../src/main/data/library-store');
const { canonicalStringify, semanticHash } = require('../../src/main/data/canonical');
const {
  ERROR_CODES,
  LegacyMigrator,
  MIGRATION_MARKER_RELATIVE_PATH,
  MIGRATION_MATRIX_CASES,
  WORKSPACE_MANIFEST_RELATIVE_PATH,
  createMigrationMatrixReport,
  stableUuid,
  verifyBackup
} = require('../../src/main/data/migrator');
const { ProjectRepository } = require('../../src/main/data/repository');

const FIXED_TIME = '2026-07-16T12:00:00.000Z';
const LEGACY_PROJECT_ID = 'legacy-project-001';
const LEGACY_PAPER_ID = 'legacy-paper-001';
const LEGACY_HTML = [
  '<h1>迁移保真测试</h1>',
  '<p>正文 <sup class="ql-cite" data-paper-id="legacy-paper-001" data-citation-num="1">[1]</sup></p>',
  '<div class="ql-table-embed"><table><tbody><tr><td>表格</td></tr></tbody></table></div>',
  '<p><span class="priority-keyword" data-keyword-value="evidence" data-extracted-keywords="evidence,trace">evidence</span></p>',
  '<p><img src="essayflow-image://legacy-image.png"></p>'
].join('');

function makeWritable(directory) {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || stat.isFile()) {
    try { fs.chmodSync(directory, 0o666); } catch {}
    return;
  }
  try { fs.chmodSync(directory, 0o777); } catch {}
  for (const entry of fs.readdirSync(directory)) makeWritable(path.join(directory, entry));
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-migration-'));
  t.after(() => {
    makeWritable(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceTree(rootPath, excludedPath) {
  const files = [];
  function visit(directory) {
    if (path.resolve(directory) === path.resolve(excludedPath)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const target = path.join(directory, entry.name);
      if (path.resolve(target) === path.resolve(excludedPath)) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(target);
        files.push({
          path: path.relative(rootPath, target).split(path.sep).join('/'),
          size: bytes.length,
          sha256: sha256(bytes)
        });
      }
    }
  }
  visit(rootPath);
  return sha256(canonicalStringify(files, { useDefaultUnorderedArrays: false }));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createFixture(t, options = {}) {
  const temporaryRoot = temporaryDirectory(t);
  const legacyRoot = path.join(temporaryRoot, 'profile');
  const workspaceRoot = path.join(legacyRoot, 'workspace');
  const projectsRoot = path.join(legacyRoot, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  const index = [{
    id: LEGACY_PROJECT_ID,
    title: '索引标题',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-02-01T00:00:00.000Z'
  }];
  writeFile(
    path.join(projectsRoot, 'index.json'),
    options.corruptIndex ? '{ this is truncated' : JSON.stringify(index)
  );
  writeFile(path.join(projectsRoot, `${LEGACY_PROJECT_ID}.html`), options.html || LEGACY_HTML);
  const imagePath = path.join(legacyRoot, 'images', 'legacy-image.png');
  const pdfPath = path.join(legacyRoot, 'localPdfs', 'legacy-paper.pdf');
  writeFile(imagePath, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  writeFile(pdfPath, Buffer.from('%PDF-1.4\n% deterministic legacy pdf\n%%EOF\n', 'utf8'));

  const localPaper = {
    id: LEGACY_PAPER_ID,
    title: 'Legacy Evidence Paper',
    authors: 'Fixture Author',
    doi: 'https://doi.org/10.5555/essayflow.migration',
    localPdfPath: pdfPath
  };
  const indexedDuplicate = {
    id: 'indexed-copy-of-paper',
    title: 'Legacy Evidence Paper (IndexedDB latest)',
    authors: 'Fixture Author',
    doi: '10.5555/ESSAYFLOW.MIGRATION'
  };
  const indexedSecond = {
    id: 'second-paper',
    title: '第二篇合成文献',
    authors: '测试作者',
    doi: '10.5555/essayflow.second'
  };
  const rendererSnapshot = {
    localStorage: {
      [`essay_project_meta_${LEGACY_PROJECT_ID}`]: JSON.stringify({
        title: 'Renderer 项目标题',
        author: 'Fixture Author',
        course: 'Migration 101',
        degree: 'MSc',
        wordLimit: '5000',
        referenceStyle: 'APA'
      }),
      essay_citations_v2: options.corruptCitations
        ? '{ broken citations'
        : JSON.stringify({
          [LEGACY_PROJECT_ID]: [{
            paperId: LEGACY_PAPER_ID,
            number: 1,
            paper: localPaper
          }]
        }),
      essay_library: JSON.stringify([localPaper]),
      essay_ai_config: JSON.stringify({ apiKey: 'must-not-enter-backup' })
    },
    indexedDbLibrary: {
      stores: {
        library: [
          indexedDuplicate,
          indexedSecond,
          { id: '__essayflow_library_meta__', type: 'meta', updatedAt: 1 }
        ]
      }
    },
    imageRefs: [{
      path: imagePath,
      projectId: LEGACY_PROJECT_ID,
      role: 'editor-image',
      mimeType: 'image/png'
    }],
    pdfRefs: [{
      path: 'localPdfs/legacy-paper.pdf',
      paperId: LEGACY_PAPER_ID,
      role: 'full-text',
      mimeType: 'application/pdf'
    }]
  };
  return { temporaryRoot, legacyRoot, workspaceRoot, rendererSnapshot, imagePath, pdfPath };
}

function migratorFor(fixture, options = {}) {
  return new LegacyMigrator({
    legacyProfileRoot: fixture.legacyRoot,
    workspaceRoot: fixture.workspaceRoot,
    rendererSnapshot: fixture.rendererSnapshot,
    appVersion: '1.1.0-test',
    now: options.now || (() => new Date(FIXED_TIME)),
    onStage: options.onStage,
    durableWriteJson: options.durableWriteJson
  });
}

test('首次迁移先建立只读校验备份，并完整迁移正文、Blot、引用、文库和资产关系', async t => {
  const fixture = createFixture(t);
  const oldTreeBefore = sourceTree(fixture.legacyRoot, fixture.workspaceRoot);
  const result = await migratorFor(fixture).migrate();
  assert.equal(result.migrated, true);
  assert.match(result.workspaceId, /^[0-9a-f-]{36}$/);
  assert.equal(result.projectIdMap[0].projectId, stableUuid('project', LEGACY_PROJECT_ID));

  const backupPath = path.join(fixture.workspaceRoot, ...result.backup.relativePath.split('/'));
  const backup = verifyBackup(backupPath, result.sourceSnapshotHash);
  assert.equal(backup.manifest.state, 'complete');
  assert.equal(backup.manifest.readOnly, true);
  assert.equal(backup.manifest.fileCount, 4);
  assert.equal(
    fs.readFileSync(path.join(backupPath, 'payload', 'projects', `${LEGACY_PROJECT_ID}.html`), 'utf8'),
    LEGACY_HTML
  );
  assert.equal(fs.statSync(path.join(backupPath, 'manifest.json')).mode & 0o200, 0);

  const repository = new ProjectRepository({ rootPath: fixture.workspaceRoot });
  const aggregate = await repository.loadProject(result.projectIdMap[0].projectId);
  assert.equal(aggregate.document.html, LEGACY_HTML);
  assert.equal(aggregate.manifest.title, 'Renderer 项目标题');
  assert.equal(aggregate.manifest.author, 'Fixture Author');
  assert.equal(aggregate.manifest.wordLimit, 5000);
  assert.equal(aggregate.citationItems.length, 1);
  assert.equal(aggregate.citationLinks.length, 1);
  assert.equal(aggregate.citationLinks[0].items[0].citationItemId, aggregate.citationItems[0].id);
  assert.equal(aggregate.citationLinks[0].insertionMode, 'citation-only');
  assert.equal(aggregate.citationLinks[0].items[0].status, 'active');
  assert.match(aggregate.document.html, /data-paper-id="legacy-paper-001"/);
  assert.match(aggregate.document.html, /ql-table-embed/);
  assert.match(aggregate.document.html, /priority-keyword/);
  assert.equal(aggregate.assetRefs.length, 1);
  assert.equal(aggregate.assetRefs[0].kind, 'image');

  const library = readJson(path.join(fixture.workspaceRoot, 'library', 'library.json'));
  assert.equal(Object.keys(library.itemsById).length, 2, '相同 DOI 的 localStorage/IndexedDB 记录应合并');
  const citationLibraryId = aggregate.citationItems[0].libraryItemId;
  assert.ok(library.itemsById[citationLibraryId]);
  assert.equal(library.itemsById[citationLibraryId].assetRefs.length, 1);
  assert.equal(library.itemsById[citationLibraryId].assetRefs[0].kind, 'pdf');
  assert.equal(new AssetStore(path.join(fixture.workspaceRoot, 'assets')).listDescriptors().length, 2);

  const markerText = fs.readFileSync(
    path.join(fixture.workspaceRoot, ...MIGRATION_MARKER_RELATIVE_PATH.split('/')),
    'utf8'
  );
  assert.ok(!markerText.includes(fixture.temporaryRoot), '新模型不得保存机器绝对路径');
  assert.ok(!markerText.includes('must-not-enter-backup'), '迁移 snapshot 白名单不得收录 AI 密钥');
  const backupSnapshotText = fs.readFileSync(path.join(backupPath, 'renderer-snapshot.json'), 'utf8');
  assert.ok(!backupSnapshotText.includes('must-not-enter-backup'));
  assert.equal(sourceTree(fixture.legacyRoot, fixture.workspaceRoot), oldTreeBefore, '迁移不得改写旧 profile');
});

test('连续运行三次仅首次迁移，第二三次业务语义、映射、资源和完成标记不变', async t => {
  const fixture = createFixture(t);
  let clockCalls = 0;
  const now = () => new Date(Date.parse(FIXED_TIME) + (clockCalls++ * 86_400_000));
  const first = await migratorFor(fixture, { now }).migrate();
  const markerPath = path.join(fixture.workspaceRoot, ...MIGRATION_MARKER_RELATIVE_PATH.split('/'));
  const workspacePath = path.join(fixture.workspaceRoot, WORKSPACE_MANIFEST_RELATIVE_PATH);
  const libraryPath = path.join(fixture.workspaceRoot, 'library', 'library.json');
  const stableFilesBefore = [markerPath, workspacePath, libraryPath].map(file => sha256(fs.readFileSync(file)));
  const commitCountBefore = fs.readdirSync(
    path.join(fixture.workspaceRoot, 'projects', first.projectIdMap[0].projectId, 'commits')
  ).length;
  const assetCountBefore = new AssetStore(path.join(fixture.workspaceRoot, 'assets')).listDescriptors().length;

  const second = await migratorFor(fixture, { now }).migrate();
  const third = await migratorFor(fixture, { now }).migrate();
  assert.equal(second.migrated, false);
  assert.equal(third.migrated, false);
  assert.equal(first.semanticHash, second.semanticHash);
  assert.equal(second.semanticHash, third.semanticHash);
  assert.deepEqual(first.projectIdMap, second.projectIdMap);
  assert.deepEqual(second.projectIdMap, third.projectIdMap);
  assert.deepEqual(first.paperIdMap, second.paperIdMap);
  assert.deepEqual(second.paperIdMap, third.paperIdMap);
  assert.deepEqual(
    [markerPath, workspacePath, libraryPath].map(file => sha256(fs.readFileSync(file))),
    stableFilesBefore
  );
  assert.equal(
    fs.readdirSync(path.join(fixture.workspaceRoot, 'projects', first.projectIdMap[0].projectId, 'commits')).length,
    commitCountBefore
  );
  assert.equal(new AssetStore(path.join(fixture.workspaceRoot, 'assets')).listDescriptors().length, assetCountBefore);
});

test('迁移完成后的正常文库提交不会被误判为迁移损坏', async t => {
  const fixture = createFixture(t);
  await migratorFor(fixture).migrate();
  const libraryStore = new LibraryStore(fixture.workspaceRoot);
  const current = libraryStore.readSync();
  const itemId = Object.keys(current.itemsById)[0];
  const itemsById = JSON.parse(JSON.stringify(current.itemsById));
  itemsById[itemId].title = '用户在迁移后更新的标题';
  await libraryStore.bulkReplace({ itemsById, collections: current.collections }, { baseRevision: current.revision });

  const restarted = await migratorFor(fixture).migrate();
  assert.equal(restarted.migrated, false);
  assert.equal(new LibraryStore(fixture.workspaceRoot).readSync().itemsById[itemId].title, '用户在迁移后更新的标题');
});

test('损坏 legacy index 时从完整 HTML 恢复，且不会伪造空白项目', async t => {
  const fixture = createFixture(t, { corruptIndex: true });
  delete fixture.rendererSnapshot.localStorage[`essay_project_meta_${LEGACY_PROJECT_ID}`];
  const result = await migratorFor(fixture).migrate();
  assert.equal(result.migrated, true);
  assert.deepEqual(result.warnings, [{
    code: 'LEGACY_INDEX_CORRUPT_RECOVERED',
    relativePath: 'projects/index.json'
  }]);
  const aggregate = await new ProjectRepository({ rootPath: fixture.workspaceRoot })
    .loadProject(result.projectIdMap[0].projectId);
  assert.equal(aggregate.manifest.title, '未命名（已恢复）');
  assert.equal(aggregate.document.html, LEGACY_HTML);

  const missingFixture = createFixture(t);
  fs.rmSync(path.join(missingFixture.legacyRoot, 'projects', `${LEGACY_PROJECT_ID}.html`));
  await assert.rejects(
    migratorFor(missingFixture).migrate(),
    error => error.code === ERROR_CODES.SOURCE_CORRUPT && /空白项目/.test(error.message)
  );
  assert.ok(!fs.existsSync(path.join(missingFixture.workspaceRoot, ...MIGRATION_MARKER_RELATIVE_PATH.split('/'))));
});

test('renderer 数据损坏时先保留只读备份，再明确失败且旧数据零修改', async t => {
  const fixture = createFixture(t, { corruptCitations: true });
  const oldTreeBefore = sourceTree(fixture.legacyRoot, fixture.workspaceRoot);
  await assert.rejects(
    migratorFor(fixture).migrate(),
    error => error.code === ERROR_CODES.SOURCE_CORRUPT && /citations/.test(error.message)
  );
  const backupRoot = path.join(fixture.workspaceRoot, 'backups', 'legacy');
  const backupDirectories = fs.readdirSync(backupRoot).filter(name => !name.startsWith('.staging-'));
  assert.equal(backupDirectories.length, 1);
  assert.equal(verifyBackup(path.join(backupRoot, backupDirectories[0])).manifest.state, 'complete');
  assert.ok(!fs.existsSync(path.join(fixture.workspaceRoot, ...MIGRATION_MARKER_RELATIVE_PATH.split('/'))));
  assert.ok(!fs.existsSync(path.join(fixture.workspaceRoot, 'projects')));
  assert.equal(sourceTree(fixture.legacyRoot, fixture.workspaceRoot), oldTreeBefore);
});

test('未来 schema 对源或目标均只读拒绝，不创建备份或覆盖文件', async t => {
  const sourceFuture = createFixture(t);
  const sourceFuturePath = path.join(sourceFuture.legacyRoot, 'workspace.json');
  writeFile(sourceFuturePath, JSON.stringify({ schemaVersion: 999, projects: [] }));
  const sourceBytes = fs.readFileSync(sourceFuturePath);
  await assert.rejects(
    migratorFor(sourceFuture).migrate(),
    error => error.code === ERROR_CODES.FUTURE_SCHEMA_READ_ONLY && error.readOnly === true
  );
  assert.deepEqual(fs.readFileSync(sourceFuturePath), sourceBytes);
  assert.ok(!fs.existsSync(sourceFuture.workspaceRoot));

  const targetFuture = createFixture(t);
  fs.mkdirSync(targetFuture.workspaceRoot, { recursive: true });
  const targetPath = path.join(targetFuture.workspaceRoot, 'workspace.json');
  const targetText = JSON.stringify({ schemaVersion: 999, sentinel: 'future-data' });
  writeFile(targetPath, targetText);
  await assert.rejects(
    migratorFor(targetFuture).migrate(),
    error => error.code === ERROR_CODES.FUTURE_SCHEMA_READ_ONLY && error.details.readOnly === true
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), targetText);
  assert.ok(!fs.existsSync(path.join(targetFuture.workspaceRoot, 'backups')));
});

test('中途写入故障不修改旧数据，稳定 ID 允许下一次安全续迁而不重复项目或资源', async t => {
  const fixture = createFixture(t);
  const oldTreeBefore = sourceTree(fixture.legacyRoot, fixture.workspaceRoot);
  await assert.rejects(
    migratorFor(fixture, {
      onStage(stage) {
        return stage === 'after-projects';
      }
    }).migrate(),
    error => error.code === ERROR_CODES.WRITE_FAILED
  );
  assert.equal(sourceTree(fixture.legacyRoot, fixture.workspaceRoot), oldTreeBefore);
  assert.ok(!fs.existsSync(path.join(fixture.workspaceRoot, ...MIGRATION_MARKER_RELATIVE_PATH.split('/'))));
  assert.equal((await new ProjectRepository({ rootPath: fixture.workspaceRoot }).listProjects()).length, 1);
  assert.equal(new AssetStore(path.join(fixture.workspaceRoot, 'assets')).listDescriptors().length, 2);

  const retried = await migratorFor(fixture).migrate();
  assert.equal(retried.migrated, true);
  assert.equal((await new ProjectRepository({ rootPath: fixture.workspaceRoot }).listProjects()).length, 1);
  assert.equal(new AssetStore(path.join(fixture.workspaceRoot, 'assets')).listDescriptors().length, 2);
  assert.equal(
    fs.readdirSync(path.join(fixture.workspaceRoot, 'projects', retried.projectIdMap[0].projectId, 'commits')).length,
    1
  );
});

test('完成后 legacy 源变化不会静默覆盖新模型，原项目仍保持完成时 checksum', async t => {
  const fixture = createFixture(t);
  const first = await migratorFor(fixture).migrate();
  const repository = new ProjectRepository({ rootPath: fixture.workspaceRoot });
  const before = await repository.loadProject(first.projectIdMap[0].projectId);
  writeFile(path.join(fixture.legacyRoot, 'projects', `${LEGACY_PROJECT_ID}.html`), '<p>late legacy edit</p>');
  await assert.rejects(
    migratorFor(fixture).migrate(),
    error => error.code === ERROR_CODES.SOURCE_CHANGED && error.readOnly === true
  );
  const after = await repository.loadProject(first.projectIdMap[0].projectId);
  assert.equal(semanticHash(after), semanticHash(before));
});

test('稳定 UUID 和 migration matrix 报告与运行顺序、时间无关', () => {
  assert.equal(stableUuid('project', LEGACY_PROJECT_ID), stableUuid('project', LEGACY_PROJECT_ID));
  assert.notEqual(stableUuid('project', LEGACY_PROJECT_ID), stableUuid('library-item', LEGACY_PROJECT_ID));
  assert.match(stableUuid('project', LEGACY_PROJECT_ID), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const results = MIGRATION_MATRIX_CASES.map(item => ({ id: item.id, passed: true, actual: item.expected }));
  const first = createMigrationMatrixReport(results);
  const second = createMigrationMatrixReport([...results].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.passed, true);
  assert.equal(first.cases.length, MIGRATION_MATRIX_CASES.length);
  assert.equal(first.reportSha256, createMigrationMatrixReport(results).reportSha256);

  const artifactPath = path.resolve(__dirname, '..', '..', 'artifacts', 'migration-matrix.json');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    canonicalStringify(first, { useDefaultUnorderedArrays: false }),
    'utf8'
  );
  assert.deepEqual(readJson(artifactPath), first);
});
