'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const JSZip = require('jszip');
const yauzl = require('yauzl');
const {
  ARCHIVE_ERROR_CODES,
  ArchivePolicyError,
  cancelImportPreflight,
  createImportPreflight,
  normalizeArchivePath,
  validateArchiveEntries
} = require('./archive-policy');
const { canonicalBytes, cloneCanonical, semanticHash } = require('./canonical');
const { fsyncDirectory, resolveContainedPath } = require('./durable-fs');
const {
  ASSET_SCHEMA_VERSION,
  collectAssetIds,
  sha256Buffer,
  validateDescriptor
} = require('./asset-store');
const {
  COMMIT_KIND,
  HEAD_KIND,
  HEAD_STATES,
  REPOSITORY_SCHEMA_VERSION,
  VERSION_KIND,
  summarizeAggregate,
  versionContentHash
} = require('./repository');
const {
  SCHEMA_VERSION,
  UUID_PATTERN,
  isPlainObject,
  normalizeProjectAggregate
} = require('./schema');
const {
  CREDENTIAL_STATUS,
  createBackupSettingsPayload,
  isSecretKey,
  validateBackupSettingsPayload
} = require('./settings-store');

const ARCHIVE_SCHEMA_VERSION = 1;
const LIBRARY_SCHEMA_VERSION = 1;
const PACKAGE_KINDS = Object.freeze({
  PROJECT: 'essayflow-project-package',
  WORKSPACE: 'essayflow-workspace-backup'
});
const CONFLICT_STRATEGIES = Object.freeze(['keep-both', 'overwrite', 'skip']);
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const UUID_GLOBAL_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

const ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'ARCHIVE_SERVICE_INPUT_INVALID',
  SOURCE_UNSAFE: 'ARCHIVE_SERVICE_SOURCE_UNSAFE',
  ZIP_INVALID: 'ARCHIVE_SERVICE_ZIP_INVALID',
  ENCRYPTED_ENTRY: 'ARCHIVE_SERVICE_ENCRYPTED_ENTRY',
  MANIFEST_INVALID: 'ARCHIVE_SERVICE_MANIFEST_INVALID',
  SCHEMA_UNSUPPORTED: 'ARCHIVE_SERVICE_SCHEMA_UNSUPPORTED',
  SCHEMA_FUTURE: 'ARCHIVE_SERVICE_SCHEMA_FUTURE_READ_ONLY',
  CHECKSUM_MISMATCH: 'ARCHIVE_SERVICE_CHECKSUM_MISMATCH',
  UNDECLARED_ENTRY: 'ARCHIVE_SERVICE_UNDECLARED_ENTRY',
  REQUIRED_ENTRY_MISSING: 'ARCHIVE_SERVICE_REQUIRED_ENTRY_MISSING',
  SECRET_DETECTED: 'ARCHIVE_SERVICE_SECRET_DETECTED',
  INSPECTION_NOT_FOUND: 'ARCHIVE_SERVICE_INSPECTION_NOT_FOUND',
  INSPECTION_CANCELED: 'ARCHIVE_SERVICE_INSPECTION_CANCELED',
  IMPORT_READ_ONLY: 'ARCHIVE_SERVICE_IMPORT_READ_ONLY',
  CONFLICT_STRATEGY_INVALID: 'ARCHIVE_SERVICE_CONFLICT_STRATEGY_INVALID',
  PROJECT_CONFLICT: 'ARCHIVE_SERVICE_PROJECT_CONFLICT',
  LIBRARY_INVALID: 'ARCHIVE_SERVICE_LIBRARY_INVALID',
  VERSION_INVALID: 'ARCHIVE_SERVICE_VERSION_INVALID',
  ASSET_INVALID: 'ARCHIVE_SERVICE_ASSET_INVALID',
  COMMIT_FAILED: 'ARCHIVE_SERVICE_COMMIT_FAILED',
  ROLLBACK_FAILED: 'ARCHIVE_SERVICE_ROLLBACK_FAILED',
  CANCELED: 'ARCHIVE_SERVICE_CANCELED'
});

class ArchiveServiceError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ArchiveServiceError';
    this.code = code;
    this.readOnly = details.readOnly === true;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details, cause) {
  throw new ArchiveServiceError(code, message, details, cause);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return cloneCanonical(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(ERROR_CODES.INPUT_INVALID, `${label} 必须是对象`);
  return value;
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(ERROR_CODES.INPUT_INVALID, `${label} 必须是稳定 UUID`, { value });
  }
  return value.toLowerCase();
}

function assertVersion(value, supported, label) {
  if (!Number.isInteger(value) || value < 1) {
    fail(ERROR_CODES.MANIFEST_INVALID, `${label} schemaVersion 无效`, { schemaVersion: value });
  }
  if (value > supported) {
    fail(ERROR_CODES.SCHEMA_FUTURE, `${label} schema ${value} 高于当前支持版本 ${supported}`, {
      schemaVersion: value,
      supportedVersion: supported,
      readOnly: true
    });
  }
  if (value !== supported) {
    fail(ERROR_CODES.SCHEMA_UNSUPPORTED, `${label} schema ${value} 需要迁移`, {
      schemaVersion: value,
      supportedVersion: supported
    });
  }
}

function assertNoSecretFields(value, location = '$', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail(ERROR_CODES.INPUT_INVALID, `归档数据包含循环引用: ${location}`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${location}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (isSecretKey(key) && key !== 'credentialStatus') {
        fail(ERROR_CODES.SECRET_DETECTED, `归档数据包含凭据字段: ${location}.${key}`, {
          path: `${location}.${key}`
        });
      }
      assertNoSecretFields(child, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function normalizeLibraryPayload(value) {
  if (value === undefined || value === null) {
    return { schemaVersion: LIBRARY_SCHEMA_VERSION, libraryItemsById: {}, collections: [] };
  }
  assertPlainObject(value, 'library payload');
  assertVersion(value.schemaVersion, LIBRARY_SCHEMA_VERSION, 'Library');
  if (!isPlainObject(value.libraryItemsById) || !Array.isArray(value.collections)) {
    fail(ERROR_CODES.LIBRARY_INVALID, 'library payload 必须包含 libraryItemsById 和 collections');
  }
  const result = {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    libraryItemsById: {},
    collections: clone(value.collections)
  };
  for (const key of Object.keys(value.libraryItemsById).sort(compareText)) {
    const id = assertUuid(key, `libraryItemsById.${key}`);
    const item = value.libraryItemsById[key];
    if (!isPlainObject(item)) fail(ERROR_CODES.LIBRARY_INVALID, `文献记录不是对象: ${key}`);
    const declared = item.libraryItemId || item.id;
    if (declared !== undefined && assertUuid(declared, `libraryItemsById.${key}.id`) !== id) {
      fail(ERROR_CODES.LIBRARY_INVALID, `文献记录 ID 与 map key 不一致: ${key}`);
    }
    result.libraryItemsById[id] = clone(item);
  }
  assertNoSecretFields(result, '$.library');
  return result;
}

function libraryItemIds(payload) {
  return Object.keys(payload.libraryItemsById).sort(compareText);
}

function sourceBuffer(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_ARCHIVE_BYTES) fail(ERROR_CODES.SOURCE_UNSAFE, '归档 Buffer 超过大小限制');
    return Buffer.from(input);
  }
  if (input && Buffer.isBuffer(input.buffer)) {
    if (input.buffer.length > MAX_ARCHIVE_BYTES) fail(ERROR_CODES.SOURCE_UNSAFE, '归档 Buffer 超过大小限制');
    return Buffer.from(input.buffer);
  }
  const filePath = typeof input === 'string' ? input : input?.filePath;
  if (typeof filePath !== 'string' || !filePath) {
    fail(ERROR_CODES.INPUT_INVALID, '归档来源必须是 Buffer 或普通文件路径');
  }
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail(ERROR_CODES.SOURCE_UNSAFE, '归档文件无法读取', { filePath: resolved }, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_BYTES) {
    fail(ERROR_CODES.SOURCE_UNSAFE, '归档来源必须是大小受限的普通文件且不能是链接', {
      filePath: resolved,
      size: stat.size
    });
  }
  return fs.readFileSync(resolved);
}

function zipEntryMetadata(entry) {
  const external = Number(entry.externalFileAttributes) >>> 0;
  return {
    fileName: entry.fileName,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    externalFileAttributes: external,
    versionMadeBy: entry.versionMadeBy,
    mode: (external >>> 16) & 0xffff,
    dosAttributes: external & 0xffff,
    isDirectory: entry.fileName.replace(/\\/g, '/').endsWith('/')
  };
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      strictFileNames: false,
      validateEntrySizes: true
    }, (error, zipFile) => {
      if (error) reject(new ArchiveServiceError(ERROR_CODES.ZIP_INVALID, 'ZIP 中央目录无效', {}, error));
      else resolve(zipFile);
    });
  });
}

function openEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function walkZip(buffer, handler) {
  const zipFile = await openZip(buffer);
  try {
    await new Promise((resolve, reject) => {
      let pending = false;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      zipFile.once('error', error => finish(new ArchiveServiceError(
        ERROR_CODES.ZIP_INVALID,
        'ZIP 条目读取失败',
        {},
        error
      )));
      zipFile.once('end', () => {
        if (!pending) finish();
      });
      zipFile.on('entry', entry => {
        pending = true;
        Promise.resolve(handler(entry, zipFile)).then(() => {
          pending = false;
          if (!settled) zipFile.readEntry();
        }, finish);
      });
      zipFile.readEntry();
    });
  } finally {
    try { zipFile.close(); } catch { /* already closed */ }
  }
}

async function streamEntryToBuffer(zipFile, entry, limit) {
  if (entry.uncompressedSize > limit) {
    fail(ERROR_CODES.MANIFEST_INVALID, '归档元数据文件超过大小限制', {
      path: entry.fileName,
      size: entry.uncompressedSize,
      limit
    });
  }
  const stream = await openEntryStream(zipFile, entry);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy();
      fail(ERROR_CODES.MANIFEST_INVALID, '归档元数据解压后超过大小限制', {
        path: entry.fileName,
        limit
      });
    }
    chunks.push(chunk);
  }
  if (total !== entry.uncompressedSize) {
    fail(ERROR_CODES.ZIP_INVALID, 'ZIP 条目展开大小与中央目录不一致', { path: entry.fileName });
  }
  return Buffer.concat(chunks);
}

async function inspectCentralDirectory(buffer) {
  const entries = [];
  let manifestBytes = null;
  await walkZip(buffer, async (entry, zipFile) => {
    if ((entry.generalPurposeBitFlag & 1) !== 0) {
      fail(ERROR_CODES.ENCRYPTED_ENTRY, '归档不允许加密条目', { path: entry.fileName });
    }
    entries.push(zipEntryMetadata(entry));
    let normalized;
    try {
      normalized = normalizeArchivePath(entry.fileName);
    } catch (error) {
      if (error instanceof ArchivePolicyError) throw error;
      throw error;
    }
    if (normalized === 'manifest.json') {
      if (manifestBytes) fail(ARCHIVE_ERROR_CODES.DUPLICATE_PATH, '归档包含重复 manifest.json');
      manifestBytes = await streamEntryToBuffer(zipFile, entry, MAX_MANIFEST_BYTES);
    }
  });
  validateArchiveEntries(entries, { criticalEntries: ['manifest.json'] });
  if (!manifestBytes) fail(ERROR_CODES.REQUIRED_ENTRY_MISSING, '归档缺少 manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest.json 不是有效 JSON', {}, error);
  }
  return { entries, manifest };
}

function normalizeManifest(manifest, entries) {
  assertPlainObject(manifest, 'manifest');
  const schemaVersion = manifest.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest schemaVersion 无效', { schemaVersion });
  }
  if (schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    return {
      future: true,
      schemaVersion,
      kind: manifest.kind,
      productVersion: String(manifest.productVersion || manifest.packageVersion || ''),
      projectCount: Number(manifest.counts?.projects || 0),
      libraryCount: Number(manifest.counts?.libraryItems || 0),
      resourceCount: Number(manifest.counts?.assets || 0),
      optionalMissingAssets: Array.isArray(manifest.optionalMissingAssets) ? clone(manifest.optionalMissingAssets) : []
    };
  }
  assertVersion(schemaVersion, ARCHIVE_SCHEMA_VERSION, 'Archive');
  if (!Object.values(PACKAGE_KINDS).includes(manifest.kind)) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest kind 不受支持', { kind: manifest.kind });
  }
  if (typeof manifest.productVersion !== 'string' || !manifest.productVersion.trim() ||
      manifest.packageVersion !== manifest.productVersion) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest 产品版本无效或不一致');
  }
  if (!Array.isArray(manifest.projects) || !Array.isArray(manifest.assets) ||
      !Array.isArray(manifest.optionalMissingAssets) || !Array.isArray(manifest.files) ||
      !isPlainObject(manifest.counts)) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest 集合字段不完整');
  }
  if (manifest.kind === PACKAGE_KINDS.PROJECT && manifest.projects.length !== 1) {
    fail(ERROR_CODES.MANIFEST_INVALID, '单项目包必须且只能包含一个项目');
  }
  const filesByPath = new Map();
  for (const record of manifest.files) {
    if (!isPlainObject(record)) fail(ERROR_CODES.MANIFEST_INVALID, 'manifest files 条目无效');
    const normalizedPath = normalizeArchivePath(record.path);
    if (normalizedPath === 'manifest.json' || filesByPath.has(normalizedPath.toLowerCase()) ||
        !/^[0-9a-f]{64}$/.test(record.sha256 || '') ||
        !Number.isSafeInteger(record.size) || record.size < 0 ||
        typeof record.kind !== 'string' || !record.kind) {
      fail(ERROR_CODES.MANIFEST_INVALID, 'manifest files 条目字段无效或重复', { path: record.path });
    }
    filesByPath.set(normalizedPath.toLowerCase(), { ...record, path: normalizedPath });
  }
  const actualFiles = entries.filter(entry => !entry.isDirectory).map(entry => normalizeArchivePath(entry.fileName));
  for (const actualPath of actualFiles) {
    if (actualPath !== 'manifest.json' && !filesByPath.has(actualPath.toLowerCase())) {
      fail(ERROR_CODES.UNDECLARED_ENTRY, '归档包含 manifest 未声明的文件', { path: actualPath });
    }
  }
  for (const record of filesByPath.values()) {
    if (!actualFiles.some(actualPath => actualPath.toLowerCase() === record.path.toLowerCase())) {
      fail(ERROR_CODES.REQUIRED_ENTRY_MISSING, 'manifest 声明的文件不存在', { path: record.path });
    }
  }
  const payloadHash = manifest.payloadSha256;
  const withoutHash = clone(manifest);
  delete withoutHash.payloadSha256;
  if (!/^[0-9a-f]{64}$/.test(payloadHash || '') || semanticHash(withoutHash) !== payloadHash) {
    fail(ERROR_CODES.CHECKSUM_MISMATCH, 'manifest payloadSha256 校验失败');
  }
  const projectIds = new Set();
  for (const project of manifest.projects) {
    if (!isPlainObject(project)) fail(ERROR_CODES.MANIFEST_INVALID, 'manifest project 条目无效');
    const projectId = assertUuid(project.projectId, 'manifest.projects.projectId');
    if (projectIds.has(projectId)) fail(ERROR_CODES.MANIFEST_INVALID, 'manifest 项目 ID 重复', { projectId });
    projectIds.add(projectId);
    if (project.schemaVersion > SCHEMA_VERSION) {
      fail(ERROR_CODES.SCHEMA_FUTURE, '项目来自未来 schema，只允许读取包元数据', {
        projectId,
        schemaVersion: project.schemaVersion,
        readOnly: true
      });
    }
    assertVersion(project.schemaVersion, SCHEMA_VERSION, `Project ${projectId}`);
    if (!filesByPath.has(normalizeArchivePath(project.aggregatePath).toLowerCase()) ||
        !Array.isArray(project.versions)) {
      fail(ERROR_CODES.MANIFEST_INVALID, 'manifest 项目文件声明不完整', { projectId });
    }
  }
  if (manifest.counts.projects !== manifest.projects.length ||
      manifest.counts.assets !== manifest.assets.length ||
      manifest.counts.libraryItems !== Number(manifest.library?.itemCount || 0)) {
    fail(ERROR_CODES.MANIFEST_INVALID, 'manifest counts 与集合数量不一致');
  }
  return { ...clone(manifest), filesByPath, future: false };
}

function abortRequested(signal) {
  return signal?.aborted === true;
}

function throwIfAborted(signal) {
  if (abortRequested(signal)) fail(ERROR_CODES.CANCELED, '归档导入已取消');
}

async function extractToStaging(buffer, stagingPath, manifest, signal) {
  const extracted = new Map();
  await fs.promises.mkdir(stagingPath, { recursive: true });
  await walkZip(buffer, async (entry, zipFile) => {
    throwIfAborted(signal);
    const metadata = zipEntryMetadata(entry);
    const normalizedPath = normalizeArchivePath(entry.fileName);
    if (metadata.isDirectory) return;
    const target = resolveContainedPath(stagingPath, normalizedPath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const hash = crypto.createHash('sha256');
    let byteLength = 0;
    const verifier = new Transform({
      transform(chunk, encoding, callback) {
        if (abortRequested(signal)) return callback(new ArchiveServiceError(ERROR_CODES.CANCELED, '归档导入已取消'));
        byteLength += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    const source = await openEntryStream(zipFile, entry);
    await pipeline(source, verifier, fs.createWriteStream(target, { flags: 'wx' }));
    if (byteLength !== entry.uncompressedSize) {
      fail(ERROR_CODES.ZIP_INVALID, '归档条目展开大小不一致', { path: normalizedPath });
    }
    const digest = hash.digest('hex');
    if (normalizedPath !== 'manifest.json') {
      const declaration = manifest.filesByPath.get(normalizedPath.toLowerCase());
      if (!declaration || declaration.size !== byteLength || declaration.sha256 !== digest) {
        fail(ERROR_CODES.CHECKSUM_MISMATCH, '归档文件 checksum 或大小不一致', {
          path: normalizedPath,
          expectedSha256: declaration?.sha256,
          actualSha256: digest,
          expectedSize: declaration?.size,
          actualSize: byteLength
        });
      }
    }
    extracted.set(normalizedPath.toLowerCase(), { path: normalizedPath, target, sha256: digest, size: byteLength });
  });
  throwIfAborted(signal);
  return extracted;
}

function readStagedJson(stagingPath, relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  const target = resolveContainedPath(stagingPath, normalized);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    fail(ERROR_CODES.REQUIRED_ENTRY_MISSING, '归档关键 JSON 文件不存在', { path: normalized }, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(ERROR_CODES.SOURCE_UNSAFE, '归档 staging 中出现非普通文件', { path: normalized });
  }
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    fail(ERROR_CODES.MANIFEST_INVALID, '归档 JSON 文件无法解析', { path: normalized }, error);
  }
}

function validateVersionSnapshot(snapshot, projectId, descriptor) {
  if (!isPlainObject(snapshot) || snapshot.schemaVersion !== REPOSITORY_SCHEMA_VERSION ||
      snapshot.kind !== VERSION_KIND || snapshot.projectId !== projectId ||
      snapshot.versionId !== descriptor.id || snapshot.snapshotHash !== descriptor.snapshotHash) {
    fail(ERROR_CODES.VERSION_INVALID, '项目版本 envelope 与 manifest/aggregate 不一致', {
      projectId,
      versionId: descriptor.id
    });
  }
  const aggregate = normalizeVersionProjection(snapshot.aggregate);
  if (versionContentHash(aggregate) !== snapshot.snapshotHash) {
    fail(ERROR_CODES.CHECKSUM_MISMATCH, '项目版本内容 hash 不一致', {
      projectId,
      versionId: descriptor.id
    });
  }
  return { ...clone(snapshot), aggregate };
}

function normalizeVersionProjection(value) {
  if (!isPlainObject(value)) fail(ERROR_CODES.VERSION_INVALID, '项目版本 aggregate 必须是对象');
  const complete = {
    ...clone(value),
    versions: [],
    auditEvents: [],
    auditContentBlobs: []
  };
  const normalized = normalizeProjectAggregate(complete);
  delete normalized.versions;
  delete normalized.auditEvents;
  delete normalized.auditContentBlobs;
  return normalized;
}

function prepareStagedPayload(stagingPath, manifest) {
  const projects = [];
  for (const projectRecord of manifest.projects) {
    const aggregate = normalizeProjectAggregate(readStagedJson(stagingPath, projectRecord.aggregatePath));
    const projectId = aggregate.manifest.projectId.toLowerCase();
    if (projectId !== projectRecord.projectId.toLowerCase() || semanticHash(aggregate) !== projectRecord.aggregateSha256) {
      fail(ERROR_CODES.CHECKSUM_MISMATCH, '项目聚合与 manifest 不一致', { projectId: projectRecord.projectId });
    }
    assertNoSecretFields(aggregate, `$.projects.${projectId}`);
    const descriptors = new Map(aggregate.versions.map(version => [version.id, version]));
    const versions = projectRecord.versions.map(versionRecord => {
      const descriptor = descriptors.get(versionRecord.versionId);
      if (!descriptor || descriptor.snapshotHash !== versionRecord.snapshotHash) {
        fail(ERROR_CODES.VERSION_INVALID, '版本描述未出现在项目聚合中', {
          projectId,
          versionId: versionRecord.versionId
        });
      }
      return validateVersionSnapshot(readStagedJson(stagingPath, versionRecord.path), projectId, descriptor);
    });
    if (versions.length !== aggregate.versions.length) {
      fail(ERROR_CODES.VERSION_INVALID, '项目版本文件数量与聚合不一致', { projectId });
    }
    projects.push({
      projectId,
      state: projectRecord.state === HEAD_STATES.TRASHED ? HEAD_STATES.TRASHED : HEAD_STATES.ACTIVE,
      aggregate,
      versions
    });
  }

  const assets = [];
  for (const assetRecord of manifest.assets) {
    if (!isPlainObject(assetRecord)) fail(ERROR_CODES.ASSET_INVALID, 'asset manifest 条目无效');
    const descriptor = validateDescriptor(readStagedJson(stagingPath, assetRecord.recordPath));
    if (descriptor.assetId !== assetRecord.assetId || descriptor.sha256 !== assetRecord.sha256 ||
        descriptor.size !== assetRecord.size) {
      fail(ERROR_CODES.ASSET_INVALID, '资产 descriptor 与 manifest 不一致', { assetId: assetRecord.assetId });
    }
    let blobPath = null;
    if (assetRecord.included) {
      blobPath = resolveContainedPath(stagingPath, normalizeArchivePath(assetRecord.blobPath));
      const buffer = fs.readFileSync(blobPath);
      if (buffer.length !== descriptor.size || sha256Buffer(buffer) !== descriptor.sha256) {
        fail(ERROR_CODES.CHECKSUM_MISMATCH, '资产 blob 校验失败', { assetId: descriptor.assetId });
      }
    } else if (!manifest.optionalMissingAssets.some(item => item?.assetId === descriptor.assetId &&
        item?.sha256 === descriptor.sha256 && item?.size === descriptor.size)) {
      fail(ERROR_CODES.ASSET_INVALID, '未携带的资产 blob 未在 optionalMissingAssets 中声明', {
        assetId: descriptor.assetId
      });
    }
    assets.push({ descriptor: clone(descriptor), blobPath, included: assetRecord.included === true });
  }
  const descriptorIds = new Set(assets.map(asset => asset.descriptor.assetId));
  for (const project of projects) {
    const referenced = collectAssetIds(project.aggregate);
    project.versions.forEach(version => collectAssetIds(version.aggregate, referenced));
    for (const assetId of referenced) {
      if (!descriptorIds.has(assetId)) {
        fail(ERROR_CODES.ASSET_INVALID, '项目引用的资产缺少 descriptor', { projectId: project.projectId, assetId });
      }
    }
  }

  const library = manifest.library?.path
    ? normalizeLibraryPayload(readStagedJson(stagingPath, manifest.library.path))
    : normalizeLibraryPayload(null);
  if (libraryItemIds(library).length !== manifest.counts.libraryItems) {
    fail(ERROR_CODES.LIBRARY_INVALID, '文库条目数量与 manifest 不一致');
  }
  const settings = manifest.settings?.path
    ? validateBackupSettingsPayload(readStagedJson(stagingPath, manifest.settings.path))
    : null;
  return { kind: manifest.kind, projects, assets, library, settings };
}

function collectUuidStrings(value, output = new Set(), seen = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(UUID_GLOBAL_PATTERN)) output.add(match[0].toLowerCase());
    return output;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) value.forEach(item => collectUuidStrings(item, output, seen));
  else {
    Object.keys(value).forEach(key => {
      collectUuidStrings(key, output, seen);
      collectUuidStrings(value[key], output, seen);
    });
  }
  return output;
}

function remapString(value, idMap) {
  return value.replace(UUID_GLOBAL_PATTERN, match => idMap.get(match.toLowerCase()) || match);
}

function remapDeep(value, idMap, seen = new Map()) {
  if (typeof value === 'string') return remapString(value, idMap);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    value.forEach(item => result.push(remapDeep(item, idMap, seen)));
    return result;
  }
  const result = {};
  seen.set(value, result);
  for (const key of Object.keys(value)) result[remapString(key, idMap)] = remapDeep(value[key], idMap, seen);
  return result;
}

function normalizeStrategy(value, fallback = 'keep-both') {
  const strategy = value === undefined ? fallback : value;
  if (!CONFLICT_STRATEGIES.includes(strategy)) {
    fail(ERROR_CODES.CONFLICT_STRATEGY_INVALID, '冲突策略只允许 keep-both、overwrite 或 skip', { strategy });
  }
  return strategy;
}

function strategyFor(options, type, id) {
  if (typeof options.strategy === 'string' || options.strategy === undefined) {
    return normalizeStrategy(options.strategy);
  }
  assertPlainObject(options.strategy, 'strategy');
  const scoped = options.strategy[type];
  if (typeof scoped === 'string') return normalizeStrategy(scoped);
  if (isPlainObject(scoped) && scoped[id]) return normalizeStrategy(scoped[id]);
  return normalizeStrategy(options.strategy.default);
}

function newUniqueUuid(randomUUID, reserved) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = assertUuid(randomUUID(), 'randomUUID()');
    if (!reserved.has(id)) {
      reserved.add(id);
      return id;
    }
  }
  fail(ERROR_CODES.COMMIT_FAILED, '无法生成不冲突的 UUID');
}

function remapVersionHashes(project) {
  const versionsById = new Map(project.versions.map(snapshot => [snapshot.versionId, snapshot]));
  for (const descriptor of project.aggregate.versions) {
    const snapshot = versionsById.get(descriptor.id);
    if (!snapshot) fail(ERROR_CODES.VERSION_INVALID, '重映射后的版本快照缺失', { versionId: descriptor.id });
    snapshot.aggregate = normalizeVersionProjection(snapshot.aggregate);
    snapshot.projectId = project.aggregate.manifest.projectId;
    snapshot.versionId = descriptor.id;
    snapshot.snapshotHash = versionContentHash(snapshot.aggregate);
    descriptor.snapshotHash = snapshot.snapshotHash;
    descriptor.summary = summarizeAggregate(snapshot.aggregate);
  }
  project.aggregate = normalizeProjectAggregate(project.aggregate);
  return project;
}

function createImportPlan(payload, context, options, randomUUID) {
  if (typeof options.strategy === 'string' || options.strategy === undefined) {
    normalizeStrategy(options.strategy);
  } else {
    assertPlainObject(options.strategy, 'strategy');
    if (options.strategy.default !== undefined) normalizeStrategy(options.strategy.default);
  }
  const reserved = new Set(context.existingUuids || []);
  payload.projects.forEach(project => collectUuidStrings(project, reserved));
  libraryItemIds(payload.library).forEach(id => reserved.add(id));
  payload.assets.forEach(asset => reserved.add(asset.descriptor.assetId));

  let library = clone(payload.library);
  const libraryMap = new Map();
  const libraryActions = {};
  for (const id of libraryItemIds(library)) {
    if (!context.libraryIds.has(id)) {
      libraryActions[id] = 'create';
      continue;
    }
    const strategy = strategyFor(options, 'library', id);
    libraryActions[id] = strategy;
    if (strategy === 'keep-both') libraryMap.set(id, newUniqueUuid(randomUUID, reserved));
  }
  if (libraryMap.size) library = normalizeLibraryPayload(remapDeep(library, libraryMap));

  const projects = [];
  const remaps = [];
  for (const sourceProject of payload.projects) {
    let project = clone(sourceProject);
    if (libraryMap.size) project = remapDeep(project, libraryMap);
    const conflict = context.projectIds.has(project.projectId);
    const strategy = conflict ? strategyFor(options, 'projects', project.projectId) : 'create';
    if (strategy === 'skip') {
      remaps.push({ sourceProjectId: sourceProject.projectId, targetProjectId: null, strategy: 'skip', idMap: {} });
      continue;
    }
    let projectMap = new Map();
    if (strategy === 'keep-both') {
      const excluded = new Set([
        ...payload.assets.map(asset => asset.descriptor.assetId),
        ...libraryItemIds(library)
      ]);
      const ids = [...collectUuidStrings(project)].filter(id => !excluded.has(id)).sort(compareText);
      for (const id of ids) projectMap.set(id, newUniqueUuid(randomUUID, reserved));
      project = remapDeep(project, projectMap);
    }
    project.projectId = project.aggregate.manifest.projectId.toLowerCase();
    project = remapVersionHashes(project);
    projects.push({ ...project, strategy });
    remaps.push({
      sourceProjectId: sourceProject.projectId,
      targetProjectId: project.projectId,
      strategy,
      idMap: Object.fromEntries([...projectMap.entries()].sort((a, b) => compareText(a[0], b[0])))
    });
  }
  const skippedWholeProjectPackage = payload.kind === PACKAGE_KINDS.PROJECT && projects.length === 0;
  return {
    kind: payload.kind,
    projects,
    assets: skippedWholeProjectPackage ? [] : clone(payload.assets),
    library: skippedWholeProjectPackage ? normalizeLibraryPayload(null) : library,
    libraryActions: skippedWholeProjectPackage ? {} : libraryActions,
    settings: payload.settings ? clone(payload.settings) : null,
    remaps,
    libraryIdMap: Object.fromEntries([...libraryMap.entries()].sort((a, b) => compareText(a[0], b[0])))
  };
}

function manifestForTransport(manifest) {
  const result = { ...manifest };
  delete result.filesByPath;
  delete result.future;
  return clone(result);
}

async function copyIfExists(source, target) {
  try {
    const stat = await fs.promises.lstat(source);
    if (stat.isSymbolicLink()) fail(ERROR_CODES.SOURCE_UNSAFE, '事务备份源不能是符号链接', { path: source });
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.cp(source, target, { recursive: stat.isDirectory(), errorOnExist: true, force: false });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceFromBackup(target, backup, existed) {
  await fs.promises.rm(target, { recursive: true, force: true });
  if (existed) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.cp(backup, target, { recursive: true, errorOnExist: true, force: false });
  }
}

function relativeVersionPath(projectId, versionId) {
  return `projects/${projectId}/versions/${versionId}.json`;
}

class ArchiveService {
  constructor(options = {}) {
    assertPlainObject(options, 'ArchiveService options');
    if (!options.repository) fail(ERROR_CODES.INPUT_INVALID, 'ArchiveService 需要 ProjectRepository');
    this.repository = options.repository;
    this.assetStore = options.assetStore || null;
    this.settingsStore = options.settingsStore || null;
    this.libraryStore = options.libraryStore || null;
    this.workspaceId = assertUuid(options.workspaceId || crypto.randomUUID(), 'workspaceId');
    this.productVersion = String(options.productVersion || '0.0.0').trim();
    if (!this.productVersion) fail(ERROR_CODES.INPUT_INVALID, 'productVersion 不能为空');
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
    this.stagingRoot = path.resolve(options.stagingRoot || path.join(os.tmpdir(), 'EssayFlowArchiveStaging'));
    this.availableDiskBytes = options.availableDiskBytes || null;
    this.snapshotCoordinator = options.snapshotCoordinator || null;
    this.transaction = options.transaction || null;
    this.faultInjector = options.faultInjector || null;
    this.inspections = new Map();
  }

  async _inject(stage, context = {}) {
    if (typeof this.faultInjector !== 'function') return;
    const result = await this.faultInjector(stage, Object.freeze({ ...context, stage }));
    if (result === true || typeof result === 'string') {
      const error = new Error(`Injected archive fault at ${stage}`);
      error.code = typeof result === 'string' ? result : 'INJECTED_ARCHIVE_FAULT';
      throw error;
    }
  }

  async _availableBytes() {
    if (typeof this.availableDiskBytes === 'function') return this.availableDiskBytes();
    if (Number.isSafeInteger(this.availableDiskBytes)) return this.availableDiskBytes;
    const probe = fs.existsSync(this.stagingRoot) ? this.stagingRoot : path.dirname(this.stagingRoot);
    try {
      const stat = await fs.promises.statfs(probe);
      const bytes = Number(BigInt(stat.bavail) * BigInt(stat.bsize));
      return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  async _existingContext(manifest) {
    const projectIds = new Set();
    const existingUuids = new Set();
    const summaries = await this.repository.listProjects({ includeTrashed: true });
    for (const summary of summaries) {
      const id = summary.projectId.toLowerCase();
      projectIds.add(id);
      existingUuids.add(id);
      const aggregate = await this.repository.loadProject(id, { includeTrashed: true });
      collectUuidStrings(aggregate, existingUuids);
    }
    const library = await this._exportLibrary();
    const libraryIds = new Set(libraryItemIds(library));
    libraryIds.forEach(id => existingUuids.add(id));
    const conflicts = [];
    manifest.projects?.forEach(project => {
      const id = String(project.projectId).toLowerCase();
      if (projectIds.has(id)) conflicts.push({ type: 'project', id });
    });
    (manifest.library?.itemIds || []).forEach(value => {
      const id = String(value).toLowerCase();
      if (libraryIds.has(id)) conflicts.push({ type: 'library', id });
    });
    return { projectIds, libraryIds, existingUuids, conflicts };
  }

  async inspectArchive(input, options = {}) {
    const buffer = sourceBuffer(input);
    const sourceSha256 = sha256(buffer);
    const central = await inspectCentralDirectory(buffer);
    let manifest;
    try {
      manifest = normalizeManifest(central.manifest, central.entries);
    } catch (error) {
      if (!(error instanceof ArchiveServiceError && error.code === ERROR_CODES.SCHEMA_FUTURE)) throw error;
      manifest = {
        future: true,
        schemaVersion: central.manifest.schemaVersion,
        kind: central.manifest.kind,
        productVersion: String(central.manifest.productVersion || central.manifest.packageVersion || ''),
        projectCount: Number(central.manifest.counts?.projects || 0),
        libraryCount: Number(central.manifest.counts?.libraryItems || 0),
        resourceCount: Number(central.manifest.counts?.assets || 0),
        optionalMissingAssets: Array.isArray(central.manifest.optionalMissingAssets)
          ? clone(central.manifest.optionalMissingAssets)
          : []
      };
    }
    const context = manifest.future
      ? { projectIds: new Set(), libraryIds: new Set(), existingUuids: new Set(), conflicts: [] }
      : await this._existingContext(manifest);
    const preflightManifest = manifest.future ? {
      packageVersion: manifest.productVersion || 'unknown',
      projectCount: manifest.projectCount,
      libraryCount: manifest.libraryCount,
      resourceCount: manifest.resourceCount,
      optionalMissingAssets: manifest.optionalMissingAssets
    } : {
      packageVersion: manifest.productVersion,
      counts: {
        projects: manifest.counts.projects,
        libraryItems: manifest.counts.libraryItems,
        assets: manifest.counts.assets
      },
      optionalMissingAssets: manifest.optionalMissingAssets
    };
    let preflight = createImportPreflight({
      entries: central.entries,
      manifest: preflightManifest,
      optionalMissingAssets: manifest.optionalMissingAssets,
      conflicts: context.conflicts,
      availableDiskBytes: options.availableDiskBytes ?? await this._availableBytes()
    });
    if (manifest.future) {
      preflight = Object.freeze({
        ...preflight,
        status: 'read-only',
        commitAllowed: false,
        readOnly: true,
        schemaVersion: manifest.schemaVersion,
        supportedSchemaVersion: ARCHIVE_SCHEMA_VERSION
      });
    }
    const inspectionId = assertUuid(this.randomUUID(), 'inspectionId');
    this.inspections.set(inspectionId, { buffer, sourceSha256, manifest, context, preflight, canceled: false });
    return Object.freeze({ inspectionId, sourceSha256, ...preflight });
  }

  cancelImport(inspectionId, reason = 'user') {
    const session = this.inspections.get(assertUuid(inspectionId, 'inspectionId'));
    if (!session) fail(ERROR_CODES.INSPECTION_NOT_FOUND, '导入预检会话不存在或已释放', { inspectionId });
    session.canceled = true;
    session.preflight = cancelImportPreflight(session.preflight, reason);
    return Object.freeze({ inspectionId, ...session.preflight });
  }

  discardInspection(inspectionId) {
    return this.inspections.delete(assertUuid(inspectionId, 'inspectionId'));
  }

  async importArchive(inspectionOrInput, options = {}) {
    let inspectionId = typeof inspectionOrInput === 'string' && UUID_PATTERN.test(inspectionOrInput)
      ? inspectionOrInput.toLowerCase()
      : null;
    if (!inspectionId) {
      const inspected = await this.inspectArchive(inspectionOrInput, options);
      inspectionId = inspected.inspectionId;
    }
    const session = this.inspections.get(inspectionId);
    if (!session) fail(ERROR_CODES.INSPECTION_NOT_FOUND, '导入预检会话不存在或已释放', { inspectionId });
    if (session.canceled || session.preflight.status === 'canceled') {
      return Object.freeze({ inspectionId, status: 'canceled', businessWritesPerformed: false });
    }
    if (session.preflight.readOnly || session.manifest.future) {
      fail(ERROR_CODES.IMPORT_READ_ONLY, '未来 schema 归档只允许查看元数据，禁止导入', {
        inspectionId,
        readOnly: true
      });
    }
    if (abortRequested(options.signal)) {
      session.canceled = true;
      return Object.freeze({ inspectionId, status: 'canceled', businessWritesPerformed: false });
    }
    const stagingPath = resolveContainedPath(this.stagingRoot, `import-${inspectionId}`);
    await fs.promises.rm(stagingPath, { recursive: true, force: true });
    try {
      await extractToStaging(session.buffer, stagingPath, session.manifest, options.signal);
      const payload = prepareStagedPayload(stagingPath, session.manifest);
      throwIfAborted(options.signal);
      const currentContext = await this._existingContext(session.manifest);
      const plan = createImportPlan(payload, currentContext, options, this.randomUUID);
      const result = this.transaction
        ? await this.transaction.commit(plan, {
          inspectionId,
          stagingPath,
          manifest: manifestForTransport(session.manifest)
        })
        : await this._commitPlan(plan, { inspectionId, stagingPath });
      this.inspections.delete(inspectionId);
      return Object.freeze({
        inspectionId,
        status: 'imported',
        businessWritesPerformed: result?.businessWritesPerformed !== false,
        projectCount: plan.projects.length,
        assetCount: plan.assets.filter(asset => asset.included).length,
        remaps: clone(plan.remaps),
        libraryIdMap: clone(plan.libraryIdMap),
        result
      });
    } catch (error) {
      if (error instanceof ArchiveServiceError && error.code === ERROR_CODES.CANCELED) {
        session.canceled = true;
        return Object.freeze({ inspectionId, status: 'canceled', businessWritesPerformed: false });
      }
      throw error;
    } finally {
      await fs.promises.rm(stagingPath, { recursive: true, force: true });
    }
  }

  async _exportLibrary() {
    if (!this.libraryStore) return normalizeLibraryPayload(null);
    const value = typeof this.libraryStore.exportForBackup === 'function'
      ? await this.libraryStore.exportForBackup()
      : typeof this.libraryStore.readSync === 'function'
        ? this.libraryStore.readSync()
        : null;
    return normalizeLibraryPayload(value);
  }

  async _importLibrary(payload, actions) {
    if (!this.libraryStore) {
      if (libraryItemIds(payload).length) fail(ERROR_CODES.COMMIT_FAILED, '当前 workspace 没有文库导入器');
      return null;
    }
    if (typeof this.libraryStore.importFromBackup !== 'function') {
      fail(ERROR_CODES.COMMIT_FAILED, '文库适配器缺少 importFromBackup');
    }
    return this.libraryStore.importFromBackup(payload, { actions });
  }

  async _projectBundle(projectId, includeTrashed = true) {
    const aggregate = await this.repository.loadProject(projectId, { includeTrashed });
    const versions = [];
    for (const descriptor of aggregate.versions) {
      let snapshot;
      if (typeof this.repository._readVersion === 'function') {
        snapshot = await this.repository._readVersion(projectId, descriptor);
      } else if (typeof this.repository.readVersionForArchive === 'function') {
        snapshot = await this.repository.readVersionForArchive(projectId, descriptor.id);
      } else {
        fail(ERROR_CODES.VERSION_INVALID, 'Repository 未提供版本快照读取能力', { projectId });
      }
      versions.push(clone(snapshot));
    }
    return { projectId, aggregate, versions };
  }

  async _withSnapshot(projectIds, operation) {
    if (this.snapshotCoordinator?.runReadTransaction) {
      return this.snapshotCoordinator.runReadTransaction(projectIds, operation);
    }
    if (typeof this.repository._serialize !== 'function' || projectIds.length === 0) return operation();
    const releases = [];
    const holders = [];
    try {
      for (const projectId of [...projectIds].sort(compareText)) {
        let entered;
        const enteredPromise = new Promise(resolve => { entered = resolve; });
        let release;
        const releasePromise = new Promise(resolve => { release = resolve; });
        releases.push(release);
        holders.push(this.repository._serialize(projectId, async () => {
          entered();
          await releasePromise;
        }));
        await enteredPromise;
      }
      return await operation();
    } finally {
      releases.reverse().forEach(release => release());
      await Promise.allSettled(holders);
    }
  }

  async exportProject(projectId, options = {}) {
    const id = assertUuid(projectId, 'projectId');
    return this._withSnapshot([id], async () => {
      const bundle = await this._projectBundle(id, true);
      const allLibrary = await this._exportLibrary();
      const linkedIds = new Set();
      const scan = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(scan);
        for (const [key, child] of Object.entries(value)) {
          if (key === 'libraryItemId' && typeof child === 'string' && UUID_PATTERN.test(child)) linkedIds.add(child.toLowerCase());
          scan(child);
        }
      };
      scan(bundle.aggregate);
      const library = normalizeLibraryPayload({
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        libraryItemsById: Object.fromEntries([...linkedIds]
          .filter(itemId => allLibrary.libraryItemsById[itemId])
          .sort(compareText)
          .map(itemId => [itemId, allLibrary.libraryItemsById[itemId]])),
        collections: []
      });
      return this._createArchive(PACKAGE_KINDS.PROJECT, [bundle], library, null, options);
    });
  }

  async exportWorkspace(options = {}) {
    const summaries = await this.repository.listProjects({ includeTrashed: true });
    const ids = summaries.map(summary => summary.projectId.toLowerCase()).sort(compareText);
    return this._withSnapshot(ids, async () => {
      const stableSummaries = await this.repository.listProjects({ includeTrashed: true });
      const stableIds = stableSummaries.map(summary => summary.projectId.toLowerCase()).sort(compareText);
      if (stableIds.join('\0') !== ids.join('\0')) {
        fail(ERROR_CODES.COMMIT_FAILED, '备份期间项目集合发生变化，请重试');
      }
      const projects = [];
      for (const id of stableIds) {
        const bundle = await this._projectBundle(id, true);
        const summary = stableSummaries.find(item => item.projectId.toLowerCase() === id);
        bundle.state = summary?.state || HEAD_STATES.ACTIVE;
        projects.push(bundle);
      }
      const library = await this._exportLibrary();
      const settings = this.settingsStore
        ? validateBackupSettingsPayload(await this.settingsStore.exportForBackup())
        : createBackupSettingsPayload({});
      return this._createArchive(PACKAGE_KINDS.WORKSPACE, projects, library, settings, options);
    });
  }

  async _createArchive(kind, projects, library, settings, options) {
    const includeAssets = options.includeAssets !== false;
    const files = new Map();
    const addJson = (relativePath, value, fileKind) => {
      assertNoSecretFields(value, `$.archive.${relativePath}`);
      files.set(relativePath, { bytes: canonicalBytes(value), kind: fileKind });
    };
    const projectRecords = [];
    const requiredAssetIds = new Set();
    for (const bundle of projects.sort((left, right) => compareText(left.projectId, right.projectId))) {
      const aggregate = normalizeProjectAggregate(bundle.aggregate);
      const projectId = aggregate.manifest.projectId.toLowerCase();
      const aggregatePath = `projects/${projectId}/aggregate.json`;
      addJson(aggregatePath, aggregate, 'project-aggregate');
      collectAssetIds(aggregate, requiredAssetIds);
      const versionRecords = [];
      for (const snapshot of bundle.versions.sort((left, right) => compareText(left.versionId, right.versionId))) {
        const descriptor = aggregate.versions.find(version => version.id === snapshot.versionId);
        validateVersionSnapshot(snapshot, projectId, descriptor || {});
        collectAssetIds(snapshot.aggregate, requiredAssetIds);
        const versionPath = `projects/${projectId}/versions/${snapshot.versionId}.json`;
        addJson(versionPath, snapshot, 'project-version');
        versionRecords.push({
          versionId: snapshot.versionId,
          snapshotHash: snapshot.snapshotHash,
          path: versionPath
        });
      }
      projectRecords.push({
        schemaVersion: SCHEMA_VERSION,
        projectId,
        state: bundle.state === HEAD_STATES.TRASHED ? HEAD_STATES.TRASHED : HEAD_STATES.ACTIVE,
        title: aggregate.manifest.title,
        revision: aggregate.manifest.revision,
        aggregatePath,
        aggregateSha256: semanticHash(aggregate),
        versions: versionRecords
      });
    }

    const libraryPath = 'workspace/library.json';
    addJson(libraryPath, library, 'library');
    let settingsRecord = null;
    if (settings) {
      const validatedSettings = validateBackupSettingsPayload(settings);
      const settingsPath = 'workspace/exportable-settings.json';
      addJson(settingsPath, validatedSettings, 'exportable-settings');
      settingsRecord = {
        schemaVersion: validatedSettings.schemaVersion,
        path: settingsPath,
        credentialStatus: validatedSettings.credentialStatus
      };
    }

    let descriptors = [];
    if (this.assetStore) {
      descriptors = kind === PACKAGE_KINDS.WORKSPACE
        ? this.assetStore.listDescriptors()
        : [...requiredAssetIds].sort(compareText).map(assetId => this.assetStore.getDescriptor(assetId));
    } else if (requiredAssetIds.size) {
      fail(ERROR_CODES.ASSET_INVALID, '项目引用资产，但 ArchiveService 未配置 AssetStore');
    }
    const assetRecords = [];
    const optionalMissingAssets = [];
    for (const descriptorValue of descriptors.sort((left, right) => compareText(left.assetId, right.assetId))) {
      const descriptor = validateDescriptor(descriptorValue);
      const recordPath = `assets/records/${descriptor.assetId}.json`;
      addJson(recordPath, descriptor, 'asset-record');
      const blobArchivePath = `assets/blobs/${descriptor.sha256.slice(0, 2)}/${descriptor.sha256}`;
      let included = false;
      if (includeAssets) {
        const read = this.assetStore.readBuffer(descriptor.assetId);
        files.set(blobArchivePath, { bytes: Buffer.from(read.buffer), kind: 'asset-blob' });
        included = true;
      } else {
        optionalMissingAssets.push({
          assetId: descriptor.assetId,
          sha256: descriptor.sha256,
          size: descriptor.size,
          reason: 'blob-not-included'
        });
      }
      assetRecords.push({
        schemaVersion: ASSET_SCHEMA_VERSION,
        assetId: descriptor.assetId,
        sha256: descriptor.sha256,
        size: descriptor.size,
        recordPath,
        blobPath: included ? blobArchivePath : null,
        included
      });
    }
    for (const assetId of requiredAssetIds) {
      if (!assetRecords.some(record => record.assetId === assetId)) {
        fail(ERROR_CODES.ASSET_INVALID, '项目引用资产未进入归档 manifest', { assetId });
      }
    }

    const fileRecords = [...files.entries()].map(([relativePath, record]) => ({
      path: relativePath,
      sha256: sha256(record.bytes),
      size: record.bytes.length,
      kind: record.kind
    })).sort((left, right) => compareText(left.path, right.path));
    const generatedAt = this.now().toISOString();
    const manifest = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      kind,
      productVersion: this.productVersion,
      packageVersion: this.productVersion,
      generatedAt,
      workspaceId: this.workspaceId,
      counts: {
        projects: projectRecords.length,
        libraryItems: libraryItemIds(library).length,
        assets: assetRecords.length
      },
      projects: projectRecords,
      library: {
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        path: libraryPath,
        itemCount: libraryItemIds(library).length,
        itemIds: libraryItemIds(library)
      },
      settings: settingsRecord,
      assets: assetRecords,
      optionalMissingAssets,
      files: fileRecords
    };
    manifest.payloadSha256 = semanticHash(manifest);
    const zip = new JSZip();
    zip.file('manifest.json', canonicalBytes(manifest), { createFolders: false, date: new Date(generatedAt) });
    for (const [relativePath, record] of [...files.entries()].sort((a, b) => compareText(a[0], b[0]))) {
      zip.file(relativePath, record.bytes, { createFolders: false, date: new Date(generatedAt) });
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
      platform: 'UNIX',
      streamFiles: false
    });
    if (options.targetPath) await this._writeArchiveFile(options.targetPath, buffer);
    return Object.freeze({
      kind,
      buffer,
      manifest: clone(manifest),
      targetPath: options.targetPath ? path.resolve(options.targetPath) : null,
      sha256: sha256(buffer),
      byteLength: buffer.length
    });
  }

  async _writeArchiveFile(targetPath, buffer) {
    const target = path.resolve(targetPath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, target);
      await fsyncDirectory(path.dirname(target));
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async _installAsset(asset, transactionState) {
    if (!this.assetStore) {
      if (asset.included) fail(ERROR_CODES.COMMIT_FAILED, '导入含资产，但未配置 AssetStore');
      return;
    }
    const descriptor = validateDescriptor(asset.descriptor);
    const recordPath = this.assetStore.recordPath(descriptor.assetId);
    const blobPath = this.assetStore.blobPath(descriptor.sha256);
    const recordExisted = fs.existsSync(recordPath);
    const blobExisted = fs.existsSync(blobPath);
    transactionState.assets.push({ recordPath, blobPath, recordExisted, blobExisted });
    if (recordExisted) {
      const existing = this.assetStore.getDescriptor(descriptor.assetId);
      if (existing.sha256 !== descriptor.sha256 || existing.size !== descriptor.size) {
        fail(ERROR_CODES.ASSET_INVALID, '现有资产 descriptor 与导入包冲突', { assetId: descriptor.assetId });
      }
    }
    if (asset.included) {
      const buffer = fs.readFileSync(asset.blobPath);
      if (!blobExisted) {
        await this.assetStore.writeFile(
          this.assetStore.rootPath,
          this.assetStore.relativePath(blobPath),
          buffer,
          { label: 'archive-asset-blob' }
        );
      } else if (sha256Buffer(fs.readFileSync(blobPath)) !== descriptor.sha256) {
        fail(ERROR_CODES.ASSET_INVALID, '现有资产 blob hash 冲突', { assetId: descriptor.assetId });
      }
    }
    if (!recordExisted) {
      await this.assetStore.writeJson(
        this.assetStore.rootPath,
        this.assetStore.relativePath(recordPath),
        descriptor,
        { label: 'archive-asset-record' }
      );
    }
  }

  async _installProject(project) {
    if (typeof this.repository.importProjectPackage === 'function') {
      return this.repository.importProjectPackage(project);
    }
    if (typeof this.repository._serialize !== 'function' || typeof this.repository._commit !== 'function') {
      fail(ERROR_CODES.COMMIT_FAILED, 'Repository 未提供事务导入能力');
    }
    const projectId = project.projectId;
    return this.repository._serialize(projectId, async () => {
      const existingHead = await this.repository._readHead(projectId, { optional: true });
      if (existingHead && project.strategy !== 'overwrite') {
        fail(ERROR_CODES.PROJECT_CONFLICT, '项目 ID 已存在且未选择覆盖', { projectId });
      }
      const ancillaryFiles = project.versions.map(snapshot => ({
        relativePath: relativeVersionPath(projectId, snapshot.versionId),
        value: snapshot,
        label: 'imported-version-snapshot'
      }));
      if (existingHead) {
        for (const file of ancillaryFiles) {
          const target = resolveContainedPath(this.repository.rootPath, file.relativePath);
          if (fs.existsSync(target)) {
            const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
            if (semanticHash(existing) !== semanticHash(file.value)) await fs.promises.rm(target, { force: true });
          }
        }
        const record = await this.repository._record(projectId, { includeTrashed: true });
        return this.repository._commit({
          projectId,
          previousHead: record.head,
          aggregate: project.aggregate,
          operation: 'import-overwrite',
          state: project.state,
          ancillaryFiles
        });
      }

      const aggregate = normalizeProjectAggregate(project.aggregate);
      const revision = aggregate.manifest.revision;
      const aggregateHash = semanticHash(aggregate);
      const operation = 'import-project-package';
      const commitId = semanticHash({
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        projectId,
        revision,
        parentCommitId: null,
        aggregateHash,
        operation
      });
      const committedAt = aggregate.manifest.updatedAt;
      const envelope = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        kind: COMMIT_KIND,
        projectId,
        revision,
        commitId,
        parentCommitId: null,
        aggregateHash,
        operation,
        committedAt,
        aggregate
      };
      const head = {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        kind: HEAD_KIND,
        projectId,
        revision,
        commitId,
        envelopeHash: semanticHash(envelope),
        state: project.state,
        updatedAt: committedAt
      };
      for (const file of ancillaryFiles) await this.repository._writeImmutable(file.relativePath, file.value, file.label);
      const commitPath = `projects/${projectId}/commits/${String(revision).padStart(12, '0')}-${commitId}.json`;
      await this.repository._writeImmutable(commitPath, envelope, 'imported-project-commit');
      await this.repository._write(`projects/${projectId}/HEAD.json`, head, 'imported-project-head');
      await this.repository._refreshIndexBestEffort();
      return { durable: true, projectId, revision, commitId, aggregateHash, state: project.state };
    });
  }

  async _commitPlan(plan, context) {
    await this.repository.initialize();
    const transactionPath = resolveContainedPath(this.stagingRoot, `transaction-${context.inspectionId}`);
    await fs.promises.rm(transactionPath, { recursive: true, force: true });
    await fs.promises.mkdir(transactionPath, { recursive: true });
    const state = { projects: [], assets: [], previousLibrary: null, previousSettings: null };
    let businessWrites = false;
    try {
      const hasLibraryWrites = libraryItemIds(plan.library).length > 0 || plan.library.collections.length > 0;
      const hasWrites = plan.projects.length > 0 || plan.assets.length > 0 || hasLibraryWrites || Boolean(plan.settings);
      if (!hasWrites) {
        await fs.promises.rm(transactionPath, { recursive: true, force: true });
        return {
          durable: true,
          businessWritesPerformed: false,
          projectResults: [],
          libraryResult: null,
          settingsResult: null
        };
      }
      for (const project of plan.projects) {
        const target = resolveContainedPath(this.repository.rootPath, `projects/${project.projectId}`);
        const backup = resolveContainedPath(transactionPath, `projects/${project.projectId}`);
        const existed = await copyIfExists(target, backup);
        state.projects.push({ target, backup, existed });
      }
      state.previousLibrary = await this._exportLibrary();
      state.previousSettings = this.settingsStore ? await this.settingsStore.exportForBackup() : null;

      businessWrites = true;
      for (const asset of plan.assets) await this._installAsset(asset, state);
      await this._inject('after-assets', context);
      const projectResults = [];
      for (const project of plan.projects) projectResults.push(await this._installProject(project));
      await this._inject('after-projects', context);
      const libraryResult = hasLibraryWrites
        ? await this._importLibrary(plan.library, plan.libraryActions)
        : null;
      await this._inject('after-library', context);
      const settingsResult = plan.settings && this.settingsStore
        ? await this.settingsStore.importFromBackup(plan.settings)
        : null;
      await this._inject('after-settings', context);

      for (const project of plan.projects) {
        const loaded = await this.repository.loadProject(project.projectId, { includeTrashed: true });
        if (project.strategy !== 'overwrite' && semanticHash(loaded) !== semanticHash(project.aggregate)) {
          fail(ERROR_CODES.CHECKSUM_MISMATCH, '导入后项目语义 hash 不一致', { projectId: project.projectId });
        }
      }
      if (this.assetStore) {
        for (const asset of plan.assets.filter(item => item.included)) await this.assetStore.verifyAsset(asset.descriptor);
      }
      await fs.promises.rm(transactionPath, { recursive: true, force: true });
      return { durable: true, projectResults, libraryResult, settingsResult };
    } catch (error) {
      if (!businessWrites) throw error;
      const rollbackErrors = [];
      for (const project of [...state.projects].reverse()) {
        try { await replaceFromBackup(project.target, project.backup, project.existed); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      for (const asset of [...state.assets].reverse()) {
        try {
          if (!asset.recordExisted) await fs.promises.rm(asset.recordPath, { force: true });
          if (!asset.blobExisted) await fs.promises.rm(asset.blobPath, { force: true });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (this.libraryStore && state.previousLibrary) {
        try { await this.libraryStore.importFromBackup(state.previousLibrary, { replaceAll: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (this.settingsStore && state.previousSettings) {
        try { await this.settingsStore.importFromBackup(state.previousSettings); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      await this.repository._refreshIndexBestEffort?.();
      await fs.promises.rm(transactionPath, { recursive: true, force: true }).catch(() => undefined);
      if (rollbackErrors.length) {
        fail(ERROR_CODES.ROLLBACK_FAILED, '归档导入失败且回滚不完整', {
          originalError: error.message,
          rollbackErrors: rollbackErrors.map(item => item.message)
        }, error);
      }
      throw new ArchiveServiceError(ERROR_CODES.COMMIT_FAILED, '归档导入提交失败，已完整回滚', {
        rolledBack: true
      }, error);
    }
  }
}

module.exports = {
  ARCHIVE_SCHEMA_VERSION,
  CONFLICT_STRATEGIES,
  ERROR_CODES,
  LIBRARY_SCHEMA_VERSION,
  PACKAGE_KINDS,
  ArchiveService,
  ArchiveServiceError,
  assertNoSecretFields,
  collectUuidStrings,
  createImportPlan,
  normalizeLibraryPayload,
  remapDeep,
  sourceBuffer
};
