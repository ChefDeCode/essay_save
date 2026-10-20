'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalStringify,
  semanticHash
} = require('./canonical');
const { AssetStore } = require('./asset-store');
const { durableWriteJson } = require('./durable-fs');
const {
  DEFAULT_LIBRARY_RELATIVE_PATH,
  LibraryStore,
  libraryItemIdFromLegacySourceId,
  validateLibraryEnvelope
} = require('./library-store');
const { ProjectRepository, ERROR_CODES: REPOSITORY_ERROR_CODES } = require('./repository');
const { createEmptyProjectAggregate, normalizeProjectAggregate } = require('./schema');
const { legacyPaperToCsl } = require('../citation/model');

const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_VERSION = 1;
const MIGRATION_KIND = 'essayflow-legacy-migration';
const WORKSPACE_KIND = 'essayflow-workspace-manifest';
const BACKUP_KIND = 'essayflow-legacy-backup';
const MATRIX_KIND = 'essayflow-migration-matrix';
const MIGRATION_MARKER_RELATIVE_PATH = 'migration/legacy-v1.json';
const WORKSPACE_MANIFEST_RELATIVE_PATH = 'workspace.json';
const LIBRARY_RELATIVE_PATH = DEFAULT_LIBRARY_RELATIVE_PATH.split(path.sep).join('/');
const BACKUP_ROOT_RELATIVE_PATH = 'backups/legacy';
const MIGRATION_NAMESPACE = 'EssayFlow/legacy-migration/v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'ERR_MIGRATION_INVALID_ARGUMENT',
  SOURCE_NOT_FOUND: 'ERR_MIGRATION_SOURCE_NOT_FOUND',
  SOURCE_UNSAFE: 'ERR_MIGRATION_SOURCE_UNSAFE',
  SOURCE_CORRUPT: 'ERR_MIGRATION_SOURCE_CORRUPT',
  SOURCE_CHANGED: 'ERR_MIGRATION_SOURCE_CHANGED',
  FUTURE_SCHEMA_READ_ONLY: 'ERR_MIGRATION_FUTURE_SCHEMA_READ_ONLY',
  TARGET_CORRUPT: 'ERR_MIGRATION_TARGET_CORRUPT',
  TARGET_CONFLICT: 'ERR_MIGRATION_TARGET_CONFLICT',
  BACKUP_FAILED: 'ERR_MIGRATION_BACKUP_FAILED',
  WRITE_FAILED: 'ERR_MIGRATION_WRITE_FAILED'
});

const MIGRATION_MATRIX_CASES = Object.freeze([
  Object.freeze({ id: 'legacy-rich-profile', expected: 'migrated' }),
  Object.freeze({ id: 'second-start', expected: 'migrated-false' }),
  Object.freeze({ id: 'third-start', expected: 'migrated-false' }),
  Object.freeze({ id: 'corrupt-index-recovery', expected: 'recovered-from-html' }),
  Object.freeze({ id: 'truncated-renderer-snapshot', expected: 'rejected-without-legacy-mutation' }),
  Object.freeze({ id: 'future-schema', expected: 'read-only-rejected' }),
  Object.freeze({ id: 'injected-write-failure', expected: 'legacy-unchanged' }),
  Object.freeze({ id: 'stable-id-mapping', expected: 'stable-uuid' }),
  Object.freeze({ id: 'html-custom-blots', expected: 'byte-semantic-preserved' })
]);

class MigrationError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MigrationError';
    this.code = code;
    this.readOnly = details.readOnly === true;
    this.details = Object.freeze({ ...details, readOnly: this.readOnly });
  }
}

function fail(code, message, details = {}, cause) {
  throw new MigrationError(code, message, details, cause);
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalHash(value) {
  return sha256Bytes(canonicalStringify(value, { useDefaultUnorderedArrays: false }));
}

function stableUuid(scope, legacyId) {
  if (typeof scope !== 'string' || !scope || typeof legacyId !== 'string' || !legacyId) {
    fail(ERROR_CODES.INVALID_ARGUMENT, '稳定 ID 映射需要非空 scope 和 legacyId');
  }
  const bytes = crypto.createHash('sha256')
    .update(MIGRATION_NAMESPACE)
    .update('\0')
    .update(scope.normalize('NFC'))
    .update('\0')
    .update(legacyId.normalize('NFC'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${name} 必须是普通对象`, { field: name });
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isPortableRelativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) return false;
  const segments = value.split(/[\\/]/);
  return segments.length > 0 && segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function isContainedOrEqual(rootPath, targetPath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function normalizeTimestamp(value, fallback) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function parseJsonText(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(ERROR_CODES.SOURCE_CORRUPT, `${field} 不是有效 JSON`, { field }, error);
  }
}

function jsonSafeClone(value, field) {
  try {
    return JSON.parse(canonicalStringify(value, { useDefaultUnorderedArrays: false }));
  } catch (error) {
    fail(ERROR_CODES.SOURCE_CORRUPT, `${field} 不能转换为确定性 JSON`, { field }, error);
  }
}

function rendererLocalStorage(snapshot) {
  if (isPlainObject(snapshot.localStorage)) return snapshot.localStorage;
  if (isPlainObject(snapshot.local_storage)) return snapshot.local_storage;
  return snapshot;
}

function normalizeProjectMeta(snapshot, localStorage) {
  const result = {};
  const explicit = snapshot.projectMetaById || snapshot.projectMeta || snapshot.projectMetadata;
  if (isPlainObject(explicit)) {
    for (const [legacyId, rawMeta] of Object.entries(explicit)) {
      const meta = parseJsonText(rawMeta, `projectMeta.${legacyId}`, {});
      if (!isPlainObject(meta)) fail(ERROR_CODES.SOURCE_CORRUPT, `项目元数据 ${legacyId} 必须是对象`);
      result[String(legacyId)] = jsonSafeClone(meta, `projectMeta.${legacyId}`);
    }
  }
  for (const [key, rawMeta] of Object.entries(localStorage)) {
    if (!key.startsWith('essay_project_meta_')) continue;
    const legacyId = key.slice('essay_project_meta_'.length);
    const meta = parseJsonText(rawMeta, key, {});
    if (!isPlainObject(meta)) fail(ERROR_CODES.SOURCE_CORRUPT, `${key} 必须是对象`);
    result[legacyId] = { ...(result[legacyId] || {}), ...jsonSafeClone(meta, key) };
  }
  return result;
}

function normalizeCitations(snapshot, localStorage) {
  const raw = snapshot.citationsV2 ?? snapshot.citations ?? localStorage.essay_citations_v2 ?? {};
  const parsed = parseJsonText(raw, 'essay_citations_v2', {});
  if (!isPlainObject(parsed)) fail(ERROR_CODES.SOURCE_CORRUPT, 'essay_citations_v2 必须是按项目分组的对象');
  const result = {};
  for (const [legacyProjectId, citations] of Object.entries(parsed)) {
    if (!Array.isArray(citations)) {
      fail(ERROR_CODES.SOURCE_CORRUPT, `项目 ${legacyProjectId} 的引用必须是数组`);
    }
    result[legacyProjectId] = jsonSafeClone(citations, `citations.${legacyProjectId}`);
  }
  return result;
}

function indexedDbItems(value) {
  const parsed = parseJsonText(value, 'indexedDbLibrary', []);
  if (Array.isArray(parsed)) return parsed;
  const candidates = [
    parsed?.stores?.library,
    parsed?.library,
    parsed?.records,
    parsed?.items
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeLibrary(snapshot, localStorage) {
  const localRaw = snapshot.library ?? snapshot.localStorageLibrary ?? localStorage.essay_library ?? [];
  const localItems = parseJsonText(localRaw, 'essay_library', []);
  if (!Array.isArray(localItems)) fail(ERROR_CODES.SOURCE_CORRUPT, 'essay_library 必须是数组');
  const indexedRaw = snapshot.indexedDbLibrary ?? snapshot.indexedDBLibrary ?? snapshot.indexedDB ?? [];
  const indexedItems = indexedDbItems(indexedRaw);
  for (const [name, items] of [['localStorage', localItems], ['IndexedDB', indexedItems]]) {
    if (!Array.isArray(items) || items.some(item => !isPlainObject(item))) {
      fail(ERROR_CODES.SOURCE_CORRUPT, `${name} 文库包含无效记录`);
    }
  }
  return {
    localItems: jsonSafeClone(localItems, 'localStorage library'),
    indexedItems: jsonSafeClone(
      indexedItems.filter(item => item.id !== '__essayflow_library_meta__' && item.type !== 'meta'),
      'IndexedDB library'
    )
  };
}

function normalizeAssetRefs(snapshot) {
  const sources = [
    ['asset', snapshot.assets],
    ['image', snapshot.imageRefs],
    ['image', snapshot.images],
    ['pdf', snapshot.pdfRefs],
    ['pdf', snapshot.pdfs]
  ];
  const result = [];
  for (const [defaultKind, raw] of sources) {
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw)) fail(ERROR_CODES.SOURCE_CORRUPT, `${defaultKind} 资产关系必须是数组`);
    raw.forEach((item, index) => {
      if (!isPlainObject(item)) fail(ERROR_CODES.SOURCE_CORRUPT, `${defaultKind} 资产关系 ${index} 无效`);
      const legacyPath = item.legacyPath || item.relativePath || item.filePath || item.localPath || item.path;
      if (typeof legacyPath !== 'string' || !legacyPath) {
        fail(ERROR_CODES.SOURCE_CORRUPT, `${defaultKind} 资产关系 ${index} 缺少路径`);
      }
      result.push({
        legacyPath,
        kind: String(item.kind || defaultKind),
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : null,
        originalName: typeof item.originalName === 'string' ? item.originalName : null,
        legacyProjectId: item.legacyProjectId ?? item.projectId ?? null,
        legacyPaperId: item.legacyPaperId ?? item.paperId ?? item.libraryItemId ?? null,
        role: typeof item.role === 'string' ? item.role : defaultKind
      });
    });
  }
  return result.sort((left, right) => (
    String(left.legacyPath).localeCompare(String(right.legacyPath), 'en') ||
    String(left.legacyProjectId || '').localeCompare(String(right.legacyProjectId || ''), 'en') ||
    String(left.legacyPaperId || '').localeCompare(String(right.legacyPaperId || ''), 'en')
  ));
}

function normalizeRendererSnapshot(input = {}) {
  assertPlainObject(input, 'rendererSnapshot');
  const snapshot = jsonSafeClone(input, 'rendererSnapshot');
  const localStorage = rendererLocalStorage(snapshot);
  const library = normalizeLibrary(snapshot, localStorage);
  return Object.freeze({
    projectMetaById: normalizeProjectMeta(snapshot, localStorage),
    citationsByProjectId: normalizeCitations(snapshot, localStorage),
    localLibrary: library.localItems,
    indexedDbLibrary: library.indexedItems,
    assetRefs: normalizeAssetRefs(snapshot)
  });
}

function selectLegacyRendererSnapshot(input = {}) {
  assertPlainObject(input, 'rendererSnapshot');
  const selected = {};
  const directKeys = [
    'projectMetaById', 'projectMeta', 'projectMetadata',
    'citationsV2', 'citations',
    'library', 'localStorageLibrary',
    'indexedDbLibrary', 'indexedDBLibrary', 'indexedDB',
    'assets', 'imageRefs', 'images', 'pdfRefs', 'pdfs'
  ];
  for (const key of directKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) selected[key] = input[key];
  }
  const localStorage = rendererLocalStorage(input);
  const selectedLocalStorage = {};
  for (const [key, value] of Object.entries(localStorage)) {
    if (
      key === 'essay_citations_v2' ||
      key === 'essay_library' ||
      key === 'essay_library_updated_at' ||
      key.startsWith('essay_project_meta_')
    ) {
      selectedLocalStorage[key] = value;
    }
  }
  if (Object.keys(selectedLocalStorage).length) selected.localStorage = selectedLocalStorage;
  return jsonSafeClone(selected, 'rendererSnapshot');
}

function relativizeAssetRefs(rendererSnapshot, legacyRoot, validationRoot = legacyRoot) {
  return Object.freeze({
    ...rendererSnapshot,
    assetRefs: rendererSnapshot.assetRefs.map(ref => {
      let relativePath = ref.legacyPath;
      if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
        const absolutePath = path.resolve(relativePath);
        if (!isContainedOrEqual(legacyRoot, absolutePath) || absolutePath === legacyRoot) {
          fail(ERROR_CODES.SOURCE_UNSAFE, '旧资产路径超出 profile', { legacyPath: ref.legacyPath });
        }
        relativePath = path.relative(legacyRoot, absolutePath);
      }
      const validatedPath = resolveLegacyAssetPath(validationRoot, relativePath);
      return {
        ...ref,
        legacyPath: toPosix(path.relative(validationRoot, validatedPath))
      };
    })
  });
}

function scanLegacyFiles(legacyRoot, workspaceRoot) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(legacyRoot);
  } catch (error) {
    if (error.code === 'ENOENT') fail(ERROR_CODES.SOURCE_NOT_FOUND, '旧版 profile 不存在', {}, error);
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(ERROR_CODES.SOURCE_UNSAFE, '旧版 profile 必须是真实目录，不能是符号链接');
  }
  const files = [];
  const legacyBusinessRoots = new Set([
    'projects',
    'localPdfs',
    'images',
    'dictionary.json',
    'workspace.json'
  ]);
  function visit(directory) {
    if (isContainedOrEqual(workspaceRoot, directory)) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (isContainedOrEqual(workspaceRoot, absolutePath)) continue;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        fail(ERROR_CODES.SOURCE_UNSAFE, '旧版 profile 中包含符号链接或 junction', {
          relativePath: toPosix(path.relative(legacyRoot, absolutePath))
        });
      }
      if (stat.isDirectory()) visit(absolutePath);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolutePath);
        files.push({
          absolutePath,
          relativePath: toPosix(path.relative(legacyRoot, absolutePath)),
          size: bytes.length,
          sha256: sha256Bytes(bytes)
        });
      }
    }
  }
  for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!legacyBusinessRoots.has(entry.name)) continue;
    const target = path.join(legacyRoot, entry.name);
    if (isContainedOrEqual(workspaceRoot, target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fail(ERROR_CODES.SOURCE_UNSAFE, '旧版业务数据中包含符号链接或 junction', { relativePath: entry.name });
    }
    if (stat.isDirectory()) visit(target);
    else if (stat.isFile()) {
      const bytes = fs.readFileSync(target);
      files.push({
        absolutePath: target,
        relativePath: toPosix(path.relative(legacyRoot, target)),
        size: bytes.length,
        sha256: sha256Bytes(bytes)
      });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

function inspectFutureSchema(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(ERROR_CODES.TARGET_CORRUPT, `${label} 无法解析，已停止写入`, { file: path.basename(filePath), readOnly: true }, error);
  }
  if (Number.isInteger(value?.schemaVersion) && value.schemaVersion > MIGRATION_SCHEMA_VERSION) {
    fail(ERROR_CODES.FUTURE_SCHEMA_READ_ONLY, `${label} 来自更高版本，当前版本只能只读诊断`, {
      actualVersion: value.schemaVersion,
      supportedVersion: MIGRATION_SCHEMA_VERSION,
      readOnly: true
    });
  }
  return value;
}

function inspectLegacyFutureSchema(legacyRoot, workspaceRoot) {
  const candidates = [path.join(legacyRoot, 'workspace.json'), path.join(legacyRoot, 'workspace', 'workspace.json')];
  for (const candidate of candidates) {
    if (isContainedOrEqual(workspaceRoot, candidate) || !fs.existsSync(candidate)) continue;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (error) {
      fail(ERROR_CODES.SOURCE_CORRUPT, '旧版 workspace 描述损坏，迁移未开始', {
        relativePath: toPosix(path.relative(legacyRoot, candidate))
      }, error);
    }
    if (Number.isInteger(value?.schemaVersion) && value.schemaVersion > MIGRATION_SCHEMA_VERSION) {
      fail(ERROR_CODES.FUTURE_SCHEMA_READ_ONLY, '旧版 profile 实际来自更高 schema，禁止猜测降级', {
        actualVersion: value.schemaVersion,
        supportedVersion: MIGRATION_SCHEMA_VERSION,
        readOnly: true,
        relativePath: toPosix(path.relative(legacyRoot, candidate))
      });
    }
  }
}

function setTreeReadOnly(rootPath) {
  const directories = [];
  function visit(directory) {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else fs.chmodSync(target, 0o444);
    }
  }
  visit(rootPath);
  directories.sort((left, right) => right.length - left.length).forEach(directory => fs.chmodSync(directory, 0o555));
}

function verifyBackup(backupPath, expectedSourceHash = null) {
  let backupStat;
  try {
    backupStat = fs.lstatSync(backupPath);
  } catch (error) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份目录不存在', {}, error);
  }
  if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份必须是真实目录，不能是符号链接');
  }
  const manifestPath = path.join(backupPath, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 manifest 无法读取', { backupId: path.basename(backupPath) }, error);
  }
  if (
    manifest.schemaVersion !== MIGRATION_SCHEMA_VERSION ||
    manifest.kind !== BACKUP_KIND ||
    manifest.state !== 'complete' ||
    !UUID_PATTERN.test(manifest.backupId || '') ||
    !SHA256_PATTERN.test(manifest.sourceSnapshotHash || '') ||
    !SHA256_PATTERN.test(manifest.rendererSnapshotHash || '') ||
    !SHA256_PATTERN.test(manifest.rendererSnapshotFileSha256 || '') ||
    !Number.isSafeInteger(manifest.fileCount) ||
    manifest.fileCount < 0 ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0 ||
    manifest.readOnly !== true ||
    !Array.isArray(manifest.files) ||
    (expectedSourceHash && manifest.sourceSnapshotHash !== expectedSourceHash)
  ) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 manifest 校验失败', { backupId: path.basename(backupPath) });
  }
  const seenPaths = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (
      !isPlainObject(file) ||
      !isPortableRelativePath(file.relativePath) ||
      seenPaths.has(file.relativePath) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !SHA256_PATTERN.test(file.sha256 || '')
    ) {
      fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 manifest 包含不安全文件记录');
    }
    seenPaths.add(file.relativePath);
    totalBytes += file.size;
    const target = path.join(backupPath, 'payload', ...String(file.relativePath).split('/'));
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 payload 不是普通文件', { relativePath: file.relativePath });
    }
    const bytes = fs.readFileSync(target);
    if (bytes.length !== file.size || sha256Bytes(bytes) !== file.sha256) {
      fail(ERROR_CODES.BACKUP_FAILED, '迁移备份文件 checksum 不匹配', { relativePath: file.relativePath });
    }
  }
  if (seenPaths.size !== manifest.fileCount || totalBytes !== manifest.totalBytes) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 manifest 计数或总字节数不一致');
  }
  const rendererPath = path.join(backupPath, 'renderer-snapshot.json');
  const rendererStat = fs.lstatSync(rendererPath);
  if (rendererStat.isSymbolicLink() || !rendererStat.isFile()) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 renderer snapshot 不是普通文件');
  }
  const rendererBytes = fs.readFileSync(rendererPath);
  if (sha256Bytes(rendererBytes) !== manifest.rendererSnapshotFileSha256) {
    fail(ERROR_CODES.BACKUP_FAILED, '迁移备份 renderer snapshot checksum 不匹配');
  }
  return {
    manifest,
    manifestSha256: sha256Bytes(fs.readFileSync(manifestPath)),
    relativePath: toPosix(path.join(BACKUP_ROOT_RELATIVE_PATH, manifest.backupId))
  };
}

function createBackup(workspaceRoot, sourceFiles, rendererSnapshot, sourceSnapshotHash, now) {
  const backupId = stableUuid('backup', sourceSnapshotHash);
  const backupRoot = path.join(workspaceRoot, ...BACKUP_ROOT_RELATIVE_PATH.split('/'));
  const finalPath = path.join(backupRoot, backupId);
  if (fs.existsSync(finalPath)) return verifyBackup(finalPath, sourceSnapshotHash);

  fs.mkdirSync(backupRoot, { recursive: true });
  const stagingPath = path.join(backupRoot, `.staging-${backupId}-${process.pid}`);
  fs.rmSync(stagingPath, { recursive: true, force: true });
  const createdAt = now().toISOString();
  try {
    fs.mkdirSync(path.join(stagingPath, 'payload'), { recursive: true });
    for (const file of sourceFiles) {
      const target = path.join(stagingPath, 'payload', ...file.relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.absolutePath, target, fs.constants.COPYFILE_EXCL);
      const copied = fs.readFileSync(target);
      if (copied.length !== file.size || sha256Bytes(copied) !== file.sha256) {
        fail(ERROR_CODES.BACKUP_FAILED, '复制迁移备份时源文件发生变化', { relativePath: file.relativePath });
      }
    }
    const rendererBytes = Buffer.from(canonicalStringify(rendererSnapshot, { useDefaultUnorderedArrays: false }), 'utf8');
    fs.writeFileSync(path.join(stagingPath, 'renderer-snapshot.json'), rendererBytes, { flag: 'wx', mode: 0o600 });
    const manifest = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      kind: BACKUP_KIND,
      state: 'complete',
      backupId,
      sourceSnapshotHash,
      rendererSnapshotHash: canonicalHash(rendererSnapshot),
      rendererSnapshotFileSha256: sha256Bytes(rendererBytes),
      fileCount: sourceFiles.length,
      totalBytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
      createdAt,
      readOnly: true,
      files: sourceFiles.map(file => ({
        relativePath: file.relativePath,
        size: file.size,
        sha256: file.sha256
      }))
    };
    fs.writeFileSync(
      path.join(stagingPath, 'manifest.json'),
      canonicalStringify(manifest, { useDefaultUnorderedArrays: false }),
      { flag: 'wx', mode: 0o600 }
    );
    verifyBackup(stagingPath, sourceSnapshotHash);
    setTreeReadOnly(stagingPath);
    fs.renameSync(stagingPath, finalPath);
    return verifyBackup(finalPath, sourceSnapshotHash);
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    if (error instanceof MigrationError) throw error;
    fail(ERROR_CODES.BACKUP_FAILED, '无法创建迁移前只读备份', { backupId }, error);
  }
}

function normalizeDoi(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
}

const MACHINE_PATH_KEYS = new Set([
  'path', 'absolutepath', 'machinepath', 'profilepath', 'filepath', 'localpath',
  'localpdfpath', 'pdfpath', 'imagepath', 'sourcepath', 'directorypath', 'folderpath'
]);

function removeMachinePaths(value, key = '') {
  const normalizedKey = String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (MACHINE_PATH_KEYS.has(normalizedKey) || normalizedKey.endsWith('absolutepath') || normalizedKey.endsWith('filepath')) {
    return undefined;
  }
  if (Array.isArray(value)) return value.map(item => removeMachinePaths(item)).filter(item => item !== undefined);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    const sanitized = removeMachinePaths(child, childKey);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

function legacyPaperId(paper, fallback) {
  const value = paper?.id ?? paper?.paperId ?? paper?.libraryItemId ?? fallback;
  return String(value ?? fallback);
}

function libraryIdentity(paper, fallback) {
  const doi = normalizeDoi(paper?.doi || paper?.DOI);
  if (doi) return `doi:${doi}`;
  return `legacy:${legacyPaperId(paper, fallback)}`;
}

function buildLibrary(rendererSnapshot, migrationTimestamp) {
  const merged = new Map();
  const paperIdMap = new Map();
  const doiMap = new Map();
  const all = [
    ...rendererSnapshot.localLibrary.map((paper, index) => ({ paper, source: 'localStorage', index })),
    ...rendererSnapshot.indexedDbLibrary.map((paper, index) => ({ paper, source: 'indexedDB', index }))
  ];
  for (const entry of all) {
    const identity = libraryIdentity(entry.paper, `${entry.source}:${entry.index}`);
    const existing = merged.get(identity) || { metadata: {}, legacyIds: new Set(), sources: new Set() };
    existing.metadata = { ...existing.metadata, ...removeMachinePaths(entry.paper) };
    existing.legacyIds.add(legacyPaperId(entry.paper, identity));
    existing.sources.add(entry.source);
    merged.set(identity, existing);
  }

  const itemsById = {};
  for (const [identity, entry] of [...merged.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const id = libraryItemIdFromLegacySourceId(identity);
    const metadata = removeMachinePaths(entry.metadata);
    delete metadata.id;
    delete metadata.paperId;
    delete metadata.libraryItemId;
    const item = {
      ...metadata,
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      libraryItemId: id,
      legacySourceId: identity,
      createdAt: migrationTimestamp,
      updatedAt: migrationTimestamp,
      migration: {
        source: 'legacy',
        legacyIds: [...entry.legacyIds].sort((left, right) => left.localeCompare(right, 'en')),
        stores: [...entry.sources].sort((left, right) => left.localeCompare(right, 'en'))
      }
    };
    itemsById[id] = item;
    for (const legacyId of entry.legacyIds) paperIdMap.set(legacyId, id);
    const doi = normalizeDoi(item.doi || item.DOI);
    if (doi) doiMap.set(doi, id);
  }
  return { itemsById, paperIdMap, doiMap };
}

function mimeTypeFor(filePath, kind) {
  const extension = path.extname(filePath).toLowerCase();
  const known = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  return known[extension] || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream');
}

function resolveLegacyAssetPath(legacyRoot, legacyPath) {
  const target = path.isAbsolute(legacyPath) || path.win32.isAbsolute(legacyPath)
    ? path.resolve(legacyPath)
    : path.resolve(legacyRoot, legacyPath);
  if (!isContainedOrEqual(legacyRoot, target) || target === legacyRoot) {
    fail(ERROR_CODES.SOURCE_UNSAFE, '旧资产路径超出 profile', { legacyPath });
  }
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(legacyRoot);
    realTarget = fs.realpathSync(target);
  } catch (error) {
    fail(ERROR_CODES.SOURCE_CORRUPT, '旧资产文件不存在或无法读取', { legacyPath }, error);
  }
  if (!isContainedOrEqual(realRoot, realTarget) || fs.lstatSync(target).isSymbolicLink() || !fs.statSync(realTarget).isFile()) {
    fail(ERROR_CODES.SOURCE_UNSAFE, '旧资产必须是 profile 内普通文件', { legacyPath });
  }
  return realTarget;
}

function discoverManagedAssets(legacyRoot, sourceFiles, explicitRefs) {
  const byPath = new Map();
  const explicitlyRelatedPaths = new Set();
  for (const ref of explicitRefs) {
    const absolutePath = resolveLegacyAssetPath(legacyRoot, ref.legacyPath);
    const relativePath = toPosix(path.relative(legacyRoot, absolutePath));
    explicitlyRelatedPaths.add(relativePath);
    const key = `${relativePath}\0${String(ref.legacyProjectId || '')}\0${String(ref.legacyPaperId || '')}`;
    byPath.set(key, { ...ref, absolutePath, relativePath });
  }
  for (const file of sourceFiles) {
    const first = file.relativePath.split('/')[0]?.toLowerCase();
    if (!['localpdfs', 'images'].includes(first)) continue;
    if (explicitlyRelatedPaths.has(file.relativePath)) continue;
    const kind = first === 'localpdfs' ? 'pdf' : 'image';
    const key = `${file.relativePath}\0\0`;
    if (!byPath.has(key)) {
      byPath.set(key, {
        legacyPath: file.relativePath,
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        kind,
        mimeType: null,
        originalName: null,
        legacyProjectId: null,
        legacyPaperId: null,
        role: kind
      });
    }
  }
  return [...byPath.values()].sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath, 'en') ||
    String(left.legacyProjectId || '').localeCompare(String(right.legacyProjectId || ''), 'en') ||
    String(left.legacyPaperId || '').localeCompare(String(right.legacyPaperId || ''), 'en')
  ));
}

function parseLegacyProjects(legacyRoot, rendererSnapshot, migrationTimestamp) {
  const projectsDirectory = path.join(legacyRoot, 'projects');
  if (!fs.existsSync(projectsDirectory)) return { projects: [], warnings: [] };
  const stat = fs.lstatSync(projectsDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(ERROR_CODES.SOURCE_UNSAFE, '旧 projects 路径不是安全目录');
  const warnings = [];
  const htmlFiles = new Map();
  for (const entry of fs.readdirSync(projectsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.html')) continue;
    const legacyId = entry.name.slice(0, -5);
    htmlFiles.set(legacyId, path.join(projectsDirectory, entry.name));
  }

  let indexEntries = [];
  const indexPath = path.join(projectsDirectory, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (isPlainObject(parsed) && Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > MIGRATION_SCHEMA_VERSION) {
        fail(ERROR_CODES.FUTURE_SCHEMA_READ_ONLY, '旧项目索引来自更高 schema，禁止写入', {
          actualVersion: parsed.schemaVersion,
          supportedVersion: MIGRATION_SCHEMA_VERSION,
          readOnly: true
        });
      }
      if (!Array.isArray(parsed)) throw new Error('index root is not an array');
      indexEntries = parsed.filter(isPlainObject);
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      warnings.push({ code: 'LEGACY_INDEX_CORRUPT_RECOVERED', relativePath: 'projects/index.json' });
    }
  }
  const indexById = new Map();
  for (const entry of indexEntries) {
    if (typeof entry.id !== 'string' || !entry.id) continue;
    if (!indexById.has(entry.id)) indexById.set(entry.id, entry);
  }
  for (const legacyId of indexById.keys()) {
    if (!htmlFiles.has(legacyId)) {
      fail(ERROR_CODES.SOURCE_CORRUPT, '旧项目索引存在但正文文件缺失，拒绝创建空白项目', { legacyProjectId: legacyId });
    }
  }

  const projects = [];
  for (const [legacyId, htmlPath] of [...htmlFiles.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const index = indexById.get(legacyId) || {};
    const meta = rendererSnapshot.projectMetaById[legacyId] || {};
    const createdAt = normalizeTimestamp(meta.createdAt ?? index.createdAt, migrationTimestamp);
    let updatedAt = normalizeTimestamp(meta.updatedAt ?? index.updatedAt, createdAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) updatedAt = createdAt;
    projects.push({
      legacyId,
      projectId: stableUuid('project', legacyId),
      html: fs.readFileSync(htmlPath, 'utf8'),
      meta: {
        title: String(meta.title ?? index.title ?? '未命名（已恢复）'),
        author: String(meta.author ?? index.author ?? ''),
        course: String(meta.course ?? index.course ?? ''),
        degree: String(meta.degree ?? index.degree ?? ''),
        wordLimit: Number.isFinite(Number(meta.wordLimit)) && Number(meta.wordLimit) >= 0
          ? Math.floor(Number(meta.wordLimit))
          : null,
        referenceStyle: String(meta.referenceStyle || 'MLA'),
        privacyMode: ['normal', 'sensitive', 'local-only'].includes(meta.privacyMode) ? meta.privacyMode : 'normal',
        createdAt,
        updatedAt
      },
      citations: rendererSnapshot.citationsByProjectId[legacyId] || []
    });
  }
  return { projects, warnings };
}

function citationIdentity(citation, index) {
  const paper = isPlainObject(citation.paper) ? citation.paper : citation;
  const doi = normalizeDoi(paper.doi || paper.DOI);
  if (doi) return `doi:${doi}`;
  return `legacy:${String(citation.paperId ?? paper.id ?? index)}`;
}

function buildProjectAggregate(project, library, assetRelations) {
  const aggregate = createEmptyProjectAggregate({
    projectId: project.projectId,
    ...project.meta,
    html: project.html,
    revision: 0
  });
  const citationItems = new Map();
  project.citations.forEach((rawCitation, index) => {
    if (!isPlainObject(rawCitation)) {
      fail(ERROR_CODES.SOURCE_CORRUPT, `项目 ${project.legacyId} 的引用 ${index} 无效`);
    }
    const paper = isPlainObject(rawCitation.paper) ? removeMachinePaths(rawCitation.paper) : {};
    const identity = citationIdentity(rawCitation, index);
    const citationItemId = stableUuid('citation-item', `${project.legacyId}\0${identity}`);
    const legacyId = String(rawCitation.paperId ?? paper.id ?? identity);
    const doi = normalizeDoi(paper.doi || paper.DOI);
    const libraryItemId = library.paperIdMap.get(legacyId) || library.doiMap.get(doi) || null;
    if (!citationItems.has(citationItemId)) {
      const metadata = legacyPaperToCsl(paper, {
        citationItemId,
        now: () => project.meta.createdAt,
        source: 'legacy-migration'
      });
      delete metadata.id;
      citationItems.set(citationItemId, {
        ...metadata,
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        id: citationItemId,
        citationItemId,
        projectId: project.projectId,
        ...(libraryItemId ? { libraryItemId } : {}),
        capturedAt: project.meta.createdAt,
        migration: { source: 'legacy', legacyPaperId: legacyId }
      });
    }
    const citationLinkId = stableUuid(
      'citation-link',
      `${project.legacyId}\0${identity}\0${String(rawCitation.number ?? '')}\0${index}`
    );
    aggregate.citationLinks.push({
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      id: citationLinkId,
      projectId: project.projectId,
      insertionMode: 'citation-only',
      items: [{
        citationItemEntryId: stableUuid('citation-entry', `${citationLinkId}\0${citationItemId}`),
        citationItemId,
        evidenceRevisionIds: [],
        sourceCitationSnapshots: [],
        suppressAuthor: false,
        order: 0,
        status: 'active'
      }],
      createdAt: project.meta.createdAt,
      updatedAt: project.meta.updatedAt
    });
  });
  aggregate.citationItems = [...citationItems.values()];
  const refsByAsset = new Map();
  for (const relation of assetRelations.filter(item => item.legacyProjectId === project.legacyId)) {
    const existing = refsByAsset.get(relation.descriptor.assetId) || {
      assetId: relation.descriptor.assetId,
      sha256: relation.descriptor.sha256,
      kind: relation.descriptor.kind,
      roles: [],
      legacyPaths: []
    };
    existing.roles.push(relation.role);
    existing.legacyPaths.push(relation.relativePath);
    existing.roles = [...new Set(existing.roles)].sort();
    existing.legacyPaths = [...new Set(existing.legacyPaths)].sort();
    refsByAsset.set(relation.descriptor.assetId, existing);
  }
  aggregate.assetRefs = [...refsByAsset.values()];
  return normalizeProjectAggregate(aggregate);
}

function attachLibraryAssets(library, assetRelations) {
  for (const relation of assetRelations) {
    if (!relation.legacyPaperId) continue;
    const libraryItemId = library.paperIdMap.get(String(relation.legacyPaperId));
    if (!libraryItemId || !library.itemsById[libraryItemId]) continue;
    const item = library.itemsById[libraryItemId];
    const refs = Array.isArray(item.assetRefs) ? item.assetRefs : [];
    if (!refs.some(ref => ref.assetId === relation.descriptor.assetId)) {
      refs.push({
        assetId: relation.descriptor.assetId,
        sha256: relation.descriptor.sha256,
        kind: relation.descriptor.kind,
        role: relation.role
      });
    }
    item.assetRefs = refs.sort((left, right) => left.assetId.localeCompare(right.assetId, 'en'));
  }
}

function validateMigrationMarker(marker) {
  if (
    !isPlainObject(marker) ||
    marker.schemaVersion !== MIGRATION_SCHEMA_VERSION ||
    marker.kind !== MIGRATION_KIND ||
    marker.migrationVersion !== MIGRATION_VERSION ||
    marker.state !== 'complete' ||
    !UUID_PATTERN.test(marker.migrationId || '') ||
    !UUID_PATTERN.test(marker.workspaceId || '') ||
    !SHA256_PATTERN.test(marker.sourceSnapshotHash || '') ||
    !SHA256_PATTERN.test(marker.rendererSnapshotHash || '') ||
    !SHA256_PATTERN.test(marker.workspaceManifestHash || '') ||
    !SHA256_PATTERN.test(marker.libraryHash || '') ||
    !SHA256_PATTERN.test(marker.semanticHash || '') ||
    !isPlainObject(marker.backup) ||
    !UUID_PATTERN.test(marker.backup.backupId || '') ||
    marker.backup.relativePath !== `${BACKUP_ROOT_RELATIVE_PATH}/${marker.backup.backupId}` ||
    !SHA256_PATTERN.test(marker.backup.manifestSha256 || '') ||
    !Array.isArray(marker.projectIdMap) ||
    !Array.isArray(marker.paperIdMap) ||
    !Array.isArray(marker.assetPathMap) ||
    !Array.isArray(marker.warnings)
  ) {
    fail(ERROR_CODES.TARGET_CORRUPT, '迁移完成标记损坏，禁止继续写入', { readOnly: true });
  }
  const projectLegacyIds = new Set();
  const projectIds = new Set();
  for (const mapping of marker.projectIdMap) {
    if (
      !isPlainObject(mapping) ||
      typeof mapping.legacyId !== 'string' ||
      !mapping.legacyId ||
      !UUID_PATTERN.test(mapping.projectId || '') ||
      !SHA256_PATTERN.test(mapping.aggregateHash || '') ||
      projectLegacyIds.has(mapping.legacyId) ||
      projectIds.has(mapping.projectId)
    ) fail(ERROR_CODES.TARGET_CORRUPT, '迁移项目 ID 映射损坏', { readOnly: true });
    projectLegacyIds.add(mapping.legacyId);
    projectIds.add(mapping.projectId);
  }
  const paperLegacyIds = new Set();
  for (const mapping of marker.paperIdMap) {
    if (
      !isPlainObject(mapping) ||
      typeof mapping.legacyId !== 'string' ||
      !mapping.legacyId ||
      !UUID_PATTERN.test(mapping.libraryItemId || '') ||
      paperLegacyIds.has(mapping.legacyId)
    ) fail(ERROR_CODES.TARGET_CORRUPT, '迁移文献 ID 映射损坏', { readOnly: true });
    paperLegacyIds.add(mapping.legacyId);
  }
  const assetRelations = new Set();
  for (const mapping of marker.assetPathMap) {
    const relationKey = `${mapping?.legacyPath || ''}\0${mapping?.assetId || ''}`;
    if (
      !isPlainObject(mapping) ||
      !isPortableRelativePath(mapping.legacyPath) ||
      !UUID_PATTERN.test(mapping.assetId || '') ||
      !SHA256_PATTERN.test(mapping.sha256 || '') ||
      assetRelations.has(relationKey)
    ) fail(ERROR_CODES.TARGET_CORRUPT, '迁移资产映射损坏', { readOnly: true });
    assetRelations.add(relationKey);
  }
  return marker;
}

function workspaceSemanticHash(value) {
  return semanticHash(value, {
    excludedKeys: ['createdAt', 'updatedAt', 'completedAt', 'committedAt', 'runtimeLog', 'runtimeLogs']
  });
}

function createMigrationMatrixReport(caseResults) {
  if (!Array.isArray(caseResults)) fail(ERROR_CODES.INVALID_ARGUMENT, 'migration matrix caseResults 必须是数组');
  const byId = new Map(caseResults.map(result => [result.id, result]));
  const cases = MIGRATION_MATRIX_CASES.map(definition => {
    const result = byId.get(definition.id) || {};
    return {
      id: definition.id,
      expected: definition.expected,
      passed: result.passed === true,
      ...(result.actual === undefined ? {} : { actual: String(result.actual) }),
      ...(result.errorCode === undefined ? {} : { errorCode: String(result.errorCode) })
    };
  });
  const report = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    kind: MATRIX_KIND,
    deterministic: true,
    passed: cases.every(item => item.passed),
    cases
  };
  return Object.freeze({ ...report, reportSha256: canonicalHash(report) });
}

class LegacyMigrator {
  constructor(options) {
    assertPlainObject(options, 'options');
    if (typeof options.legacyProfileRoot !== 'string' || !options.legacyProfileRoot.trim()) {
      fail(ERROR_CODES.INVALID_ARGUMENT, 'legacyProfileRoot 必填', { field: 'legacyProfileRoot' });
    }
    if (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot.trim()) {
      fail(ERROR_CODES.INVALID_ARGUMENT, 'workspaceRoot 必填', { field: 'workspaceRoot' });
    }
    this.legacyRoot = path.resolve(options.legacyProfileRoot);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    if (this.legacyRoot === this.workspaceRoot || isContainedOrEqual(this.workspaceRoot, this.legacyRoot)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, 'workspaceRoot 不能等于旧 profile 或包含旧 profile');
    }
    this.rendererSnapshotInput = options.rendererSnapshot || {};
    this.appVersion = String(options.appVersion || '1.0.0');
    this.now = options.now || (() => new Date());
    this.repository = options.repository || null;
    this.assetStore = options.assetStore || null;
    this.libraryStore = options.libraryStore || null;
    this.writeJson = options.durableWriteJson || durableWriteJson;
    this.onStage = options.onStage || null;
  }

  async _stage(stage, details = {}) {
    if (typeof this.onStage !== 'function') return;
    const result = await this.onStage(stage, Object.freeze({ ...details, stage }));
    if (result === true || typeof result === 'string') {
      const error = new Error(`Injected migration failure at ${stage}`);
      error.code = typeof result === 'string' ? result : 'INJECTED_FAULT';
      throw error;
    }
  }

  _inspectTarget() {
    const workspace = inspectFutureSchema(path.join(this.workspaceRoot, WORKSPACE_MANIFEST_RELATIVE_PATH), 'workspace manifest');
    const library = inspectFutureSchema(path.join(this.workspaceRoot, ...LIBRARY_RELATIVE_PATH.split('/')), 'workspace library');
    const marker = inspectFutureSchema(path.join(this.workspaceRoot, ...MIGRATION_MARKER_RELATIVE_PATH.split('/')), 'migration marker');
    return { workspace, library, marker: marker ? validateMigrationMarker(marker) : null };
  }

  async _writeImmutable(relativePath, value, label) {
    const target = path.join(this.workspaceRoot, ...relativePath.split('/'));
    if (fs.existsSync(target)) {
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        fail(ERROR_CODES.TARGET_CORRUPT, `${label} 已存在但无法解析`, { relativePath, readOnly: true }, error);
      }
      if (canonicalHash(existing) !== canonicalHash(value)) {
        fail(ERROR_CODES.TARGET_CONFLICT, `${label} 与本次迁移内容冲突`, { relativePath, readOnly: true });
      }
      return;
    }
    await this.writeJson(this.workspaceRoot, relativePath, value, {
      label,
      canonicalOptions: { useDefaultUnorderedArrays: false }
    });
  }

  async _verifyCompleted(marker, targetState, sourceSnapshotHash) {
    if (marker.sourceSnapshotHash !== sourceSnapshotHash) {
      fail(ERROR_CODES.SOURCE_CHANGED, '旧版数据在完成迁移后发生变化，禁止静默覆盖新 workspace', {
        expectedSourceSnapshotHash: marker.sourceSnapshotHash,
        actualSourceSnapshotHash: sourceSnapshotHash,
        readOnly: true
      });
    }
    if (!targetState.workspace || !targetState.library) {
      fail(ERROR_CODES.TARGET_CORRUPT, '迁移标记存在但 workspace 或文库 envelope 缺失', { readOnly: true });
    }
    try {
      validateLibraryEnvelope(targetState.library);
    } catch (error) {
      fail(ERROR_CODES.TARGET_CORRUPT, '迁移完成后的文库 schema 校验失败', { readOnly: true }, error);
    }
    if (canonicalHash(targetState.workspace) !== marker.workspaceManifestHash) {
      fail(ERROR_CODES.TARGET_CORRUPT, '迁移完成后的 workspace manifest checksum 不匹配', { readOnly: true });
    }
    const backupPath = path.join(this.workspaceRoot, ...marker.backup.relativePath.split('/'));
    const backup = verifyBackup(backupPath, sourceSnapshotHash);
    if (backup.manifestSha256 !== marker.backup.manifestSha256) {
      fail(ERROR_CODES.BACKUP_FAILED, '迁移完成标记中的备份 checksum 不匹配');
    }
    return Object.freeze({
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      migrated: false,
      migrationId: marker.migrationId,
      workspaceId: marker.workspaceId,
      sourceSnapshotHash,
      semanticHash: marker.semanticHash,
      backup: marker.backup,
      projectIdMap: marker.projectIdMap,
      paperIdMap: marker.paperIdMap,
      warnings: marker.warnings || []
    });
  }

  async migrate() {
    let targetState = this._inspectTarget();
    inspectLegacyFutureSchema(this.legacyRoot, this.workspaceRoot);
    const backupRendererSnapshot = selectLegacyRendererSnapshot(this.rendererSnapshotInput);
    const sourceFiles = scanLegacyFiles(this.legacyRoot, this.workspaceRoot);
    const sourceSnapshotHash = canonicalHash({
      files: sourceFiles.map(file => ({ relativePath: file.relativePath, size: file.size, sha256: file.sha256 })),
      rendererSnapshot: backupRendererSnapshot
    });
    if (targetState.marker) return this._verifyCompleted(targetState.marker, targetState, sourceSnapshotHash);

    const backup = createBackup(this.workspaceRoot, sourceFiles, backupRendererSnapshot, sourceSnapshotHash, this.now);
    const migrationTimestamp = backup.manifest.createdAt;
    const migrationId = stableUuid('migration', sourceSnapshotHash);
    const workspaceId = stableUuid('workspace', sourceSnapshotHash);
    const backupPayloadRoot = path.join(
      this.workspaceRoot,
      ...backup.relativePath.split('/'),
      'payload'
    );
    const backupSourceFiles = sourceFiles.map(file => ({
      ...file,
      absolutePath: path.join(backupPayloadRoot, ...file.relativePath.split('/'))
    }));
    try {
      await this._stage('after-backup', { backupId: backup.manifest.backupId });
      const rendererSnapshot = relativizeAssetRefs(
        normalizeRendererSnapshot(backupRendererSnapshot),
        this.legacyRoot,
        backupPayloadRoot
      );
      const library = buildLibrary(rendererSnapshot, migrationTimestamp);
      const parsed = parseLegacyProjects(backupPayloadRoot, rendererSnapshot, migrationTimestamp);
      const libraryStore = this.libraryStore || new LibraryStore(this.workspaceRoot, {
        now: () => new Date(migrationTimestamp),
        durableWriteJson: this.writeJson
      });
      const managedAssets = discoverManagedAssets(backupPayloadRoot, backupSourceFiles, rendererSnapshot.assetRefs);
      const assetStore = this.assetStore || new AssetStore(path.join(this.workspaceRoot, 'assets'), {
        now: () => new Date(migrationTimestamp)
      });
      const assetRelations = [];
      for (const asset of managedAssets) {
        const descriptor = await assetStore.importFile(asset.absolutePath, {
          kind: asset.kind,
          mimeType: asset.mimeType || mimeTypeFor(asset.absolutePath, asset.kind),
          originalName: asset.originalName || path.basename(asset.absolutePath)
        });
        assetRelations.push({ ...asset, descriptor });
      }
      attachLibraryAssets(library, assetRelations);
      await this._stage('after-assets', { assetCount: assetRelations.length });

      const repository = this.repository || new ProjectRepository({
        rootPath: this.workspaceRoot,
        now: () => new Date(migrationTimestamp),
        assetStore,
        backupRoots: [path.join(this.workspaceRoot, 'backups')]
      });
      const projectIdMap = [];
      for (const project of parsed.projects) {
        const aggregate = buildProjectAggregate(project, library, assetRelations);
        let committed;
        try {
          committed = await repository.createProject({ projectId: project.projectId, aggregate });
        } catch (error) {
          if (error.code !== REPOSITORY_ERROR_CODES.PROJECT_EXISTS) throw error;
          const existing = await repository.loadProject(project.projectId);
          const expectedHash = semanticHash(aggregate, {
            excludedPaths: ['$.manifest.revision', '$.manifest.updatedAt']
          });
          const existingHash = semanticHash(existing, {
            excludedPaths: ['$.manifest.revision', '$.manifest.updatedAt']
          });
          if (expectedHash !== existingHash) {
            fail(ERROR_CODES.TARGET_CONFLICT, '稳定项目 ID 已存在但内容与旧项目不一致', {
              projectId: project.projectId,
              readOnly: true
            });
          }
          committed = { aggregate: existing, aggregateHash: semanticHash(existing) };
        }
        projectIdMap.push({
          legacyId: project.legacyId,
          projectId: project.projectId,
          aggregateHash: committed.aggregateHash || semanticHash(committed.aggregate)
        });
      }
      projectIdMap.sort((left, right) => left.legacyId.localeCompare(right.legacyId, 'en'));
      await this._stage('after-projects', { projectCount: projectIdMap.length });

      const assetsById = {};
      for (const relation of assetRelations) assetsById[relation.descriptor.assetId] = relation.descriptor;
      const paperIdMap = [...library.paperIdMap.entries()]
        .map(([legacyId, libraryItemId]) => ({ legacyId, libraryItemId }))
        .sort((left, right) => left.legacyId.localeCompare(right.legacyId, 'en'));
      let libraryEnvelope;
      if (libraryStore.revision === 0) {
        const replacement = await libraryStore.bulkReplace({
          itemsById: library.itemsById,
          collections: []
        }, { baseRevision: 0 });
        libraryEnvelope = replacement.snapshot;
      } else {
        const existing = libraryStore.readSync();
        if (
          canonicalHash(existing.itemsById) !== canonicalHash(library.itemsById) ||
          existing.collections.length !== 0
        ) {
          fail(ERROR_CODES.TARGET_CONFLICT, '现有文库与 legacy 迁移内容冲突', { readOnly: true });
        }
        libraryEnvelope = existing;
      }
      const workspaceEnvelope = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        kind: WORKSPACE_KIND,
        workspaceId,
        appVersion: this.appVersion,
        createdAt: migrationTimestamp,
        updatedAt: migrationTimestamp,
        projectIds: projectIdMap.map(item => item.projectId),
        libraryItemIds: Object.keys(library.itemsById).sort(),
        assetsById,
        migrationId
      };
      await this._writeImmutable(WORKSPACE_MANIFEST_RELATIVE_PATH, workspaceEnvelope, 'workspace-manifest');
      await this._stage('before-marker', { migrationId });

      const markerCore = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        kind: MIGRATION_KIND,
        migrationVersion: MIGRATION_VERSION,
        state: 'complete',
        migrationId,
        workspaceId,
        sourceSnapshotHash,
        rendererSnapshotHash: canonicalHash(rendererSnapshot),
        completedAt: migrationTimestamp,
        backup: {
          backupId: backup.manifest.backupId,
          relativePath: backup.relativePath,
          manifestSha256: backup.manifestSha256
        },
        workspaceManifestHash: canonicalHash(workspaceEnvelope),
        libraryHash: canonicalHash(libraryEnvelope),
        projectIdMap,
        paperIdMap,
        assetPathMap: assetRelations.map(relation => ({
          legacyPath: relation.relativePath,
          assetId: relation.descriptor.assetId,
          sha256: relation.descriptor.sha256
        })).sort((left, right) => left.legacyPath.localeCompare(right.legacyPath, 'en')),
        warnings: parsed.warnings
      };
      const marker = {
        ...markerCore,
        semanticHash: workspaceSemanticHash({
          workspace: workspaceEnvelope,
          library: libraryEnvelope,
          projects: projectIdMap,
          assets: markerCore.assetPathMap
        })
      };
      await this.writeJson(this.workspaceRoot, MIGRATION_MARKER_RELATIVE_PATH, marker, {
        label: 'migration-complete-marker',
        canonicalOptions: { useDefaultUnorderedArrays: false }
      });
      targetState = this._inspectTarget();
      validateMigrationMarker(targetState.marker);
      return Object.freeze({
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        migrated: true,
        migrationId,
        workspaceId,
        sourceSnapshotHash,
        semanticHash: marker.semanticHash,
        backup: marker.backup,
        projectIdMap,
        paperIdMap,
        assetPathMap: marker.assetPathMap,
        warnings: parsed.warnings
      });
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      fail(ERROR_CODES.WRITE_FAILED, '迁移未完成；旧版数据和只读备份均未删除', {
        sourceSnapshotHash,
        backupId: backup.manifest.backupId
      }, error);
    }
  }
}

module.exports = {
  BACKUP_KIND,
  BACKUP_ROOT_RELATIVE_PATH,
  ERROR_CODES,
  LIBRARY_RELATIVE_PATH,
  LegacyMigrator,
  MATRIX_KIND,
  MIGRATION_KIND,
  MIGRATION_MARKER_RELATIVE_PATH,
  MIGRATION_MATRIX_CASES,
  MIGRATION_SCHEMA_VERSION,
  MIGRATION_VERSION,
  MigrationError,
  WORKSPACE_KIND,
  WORKSPACE_MANIFEST_RELATIVE_PATH,
  canonicalHash,
  createMigrationMatrixReport,
  normalizeRendererSnapshot,
  stableUuid,
  verifyBackup,
  workspaceSemanticHash
};
