'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { durableWriteFile, durableWriteJson, resolveContainedPath } = require('./durable-fs');

const ASSET_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ASSET_BYTES = 500 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AssetStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AssetStoreError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assetIdFromSha256(sha256) {
  if (!SHA256_PATTERN.test(sha256)) throw new AssetStoreError('ASSET_HASH_INVALID', '资产 SHA-256 格式错误');
  const bytes = Buffer.from(sha256.slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizeAssetName(value) {
  const raw = typeof value === 'string' ? path.basename(value) : 'asset';
  const cleaned = raw.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  return (cleaned || 'asset').slice(0, 180);
}

function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssetStoreError('ASSET_DESCRIPTOR_INVALID', '资产描述不是对象');
  }
  if (value.schemaVersion !== ASSET_SCHEMA_VERSION) {
    throw new AssetStoreError(
      value.schemaVersion > ASSET_SCHEMA_VERSION ? 'ASSET_SCHEMA_FUTURE' : 'ASSET_SCHEMA_UNSUPPORTED',
      '资产 schemaVersion 不受支持',
      { readOnly: value.schemaVersion > ASSET_SCHEMA_VERSION }
    );
  }
  if (!UUID_PATTERN.test(value.assetId || '') || !SHA256_PATTERN.test(value.sha256 || '') ||
      value.assetId !== assetIdFromSha256(value.sha256)) {
    throw new AssetStoreError('ASSET_IDENTITY_INVALID', '资产 ID 与内容哈希不一致');
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0 || typeof value.mimeType !== 'string' ||
      !value.mimeType || typeof value.kind !== 'string' || !value.kind || typeof value.originalName !== 'string') {
    throw new AssetStoreError('ASSET_DESCRIPTOR_INVALID', '资产描述字段无效');
  }
  if (Number.isNaN(Date.parse(value.createdAt))) {
    throw new AssetStoreError('ASSET_DESCRIPTOR_INVALID', '资产创建时间无效');
  }
  return value;
}

class AssetStore {
  constructor(rootPath, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.blobsPath = path.join(this.rootPath, 'blobs');
    this.recordsPath = path.join(this.rootPath, 'records');
    this.maxAssetBytes = options.maxAssetBytes || DEFAULT_MAX_ASSET_BYTES;
    this.now = options.now || (() => new Date());
    this.writeFile = options.durableWriteFile || durableWriteFile;
    this.writeJson = options.durableWriteJson || durableWriteJson;
    fs.mkdirSync(this.blobsPath, { recursive: true });
    fs.mkdirSync(this.recordsPath, { recursive: true });
  }

  blobPath(sha256) {
    if (!SHA256_PATTERN.test(sha256)) throw new AssetStoreError('ASSET_HASH_INVALID', '资产 SHA-256 格式错误');
    return resolveContainedPath(this.blobsPath, path.join(sha256.slice(0, 2), sha256));
  }

  recordPath(assetId) {
    if (!UUID_PATTERN.test(assetId || '')) throw new AssetStoreError('ASSET_ID_INVALID', '资产 ID 格式错误');
    return resolveContainedPath(this.recordsPath, `${assetId}.json`);
  }

  relativePath(absolutePath) {
    const relative = path.relative(this.rootPath, absolutePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AssetStoreError('ASSET_PATH_ESCAPE', '资产路径超出受管目录');
    }
    return relative;
  }

  async putBuffer(input) {
    if (!input || typeof input !== 'object' || !Buffer.isBuffer(input.buffer)) {
      throw new AssetStoreError('ASSET_INPUT_INVALID', '资产输入必须包含 Buffer');
    }
    if (input.buffer.length > this.maxAssetBytes) {
      throw new AssetStoreError('ASSET_TOO_LARGE', `资产超过 ${this.maxAssetBytes} 字节限制`);
    }
    const sha256 = sha256Buffer(input.buffer);
    const assetId = assetIdFromSha256(sha256);
    const recordPath = this.recordPath(assetId);
    if (fs.existsSync(recordPath)) {
      const existing = this.getDescriptor(assetId);
      await this.verifyAsset(existing);
      return existing;
    }
    const descriptor = {
      schemaVersion: ASSET_SCHEMA_VERSION,
      assetId,
      sha256,
      size: input.buffer.length,
      mimeType: String(input.mimeType || 'application/octet-stream').slice(0, 200),
      kind: String(input.kind || 'attachment').slice(0, 50),
      originalName: sanitizeAssetName(input.originalName),
      createdAt: this.now().toISOString()
    };
    validateDescriptor(descriptor);
    const blobPath = this.blobPath(sha256);
    if (!fs.existsSync(blobPath)) {
      await this.writeFile(this.rootPath, this.relativePath(blobPath), input.buffer, { label: 'asset-blob' });
    }
    await this.writeJson(this.rootPath, this.relativePath(recordPath), descriptor, { label: 'asset-record' });
    return descriptor;
  }

  async importFile(filePath, metadata = {}) {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new AssetStoreError('ASSET_SOURCE_INVALID', '资产来源不是普通文件');
    if (stat.size > this.maxAssetBytes) throw new AssetStoreError('ASSET_TOO_LARGE', '资产来源超过大小限制');
    return this.putBuffer({ ...metadata, originalName: metadata.originalName || path.basename(resolved), buffer: fs.readFileSync(resolved) });
  }

  getDescriptor(assetId) {
    const recordPath = this.recordPath(assetId);
    if (!fs.existsSync(recordPath)) throw new AssetStoreError('ASSET_NOT_FOUND', '资产记录不存在', { assetId });
    let descriptor;
    try {
      descriptor = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    } catch (error) {
      throw new AssetStoreError('ASSET_DESCRIPTOR_CORRUPT', '资产描述无法解析', { assetId, cause: error.message });
    }
    return validateDescriptor(descriptor);
  }

  readBuffer(assetId, options = {}) {
    const descriptor = this.getDescriptor(assetId);
    const blobPath = this.blobPath(descriptor.sha256);
    if (!fs.existsSync(blobPath)) throw new AssetStoreError('ASSET_BLOB_MISSING', '资产文件缺失', { assetId });
    const buffer = fs.readFileSync(blobPath);
    if (options.verify !== false && (buffer.length !== descriptor.size || sha256Buffer(buffer) !== descriptor.sha256)) {
      throw new AssetStoreError('ASSET_CHECKSUM_MISMATCH', '资产校验失败', { assetId });
    }
    return { descriptor, buffer };
  }

  async verifyAsset(descriptorOrId) {
    const descriptor = typeof descriptorOrId === 'string' ? this.getDescriptor(descriptorOrId) : validateDescriptor(descriptorOrId);
    this.readBuffer(descriptor.assetId);
    return descriptor;
  }

  listDescriptors() {
    const descriptors = [];
    for (const name of fs.readdirSync(this.recordsPath).sort((left, right) => left.localeCompare(right, 'en'))) {
      if (!name.endsWith('.json')) continue;
      descriptors.push(this.getDescriptor(name.slice(0, -5)));
    }
    return descriptors;
  }

  async verifyAll() {
    const errors = [];
    const descriptors = [];
    for (const name of fs.readdirSync(this.recordsPath).sort((left, right) => left.localeCompare(right, 'en'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const descriptor = this.getDescriptor(name.slice(0, -5));
        await this.verifyAsset(descriptor);
        descriptors.push(descriptor);
      } catch (error) {
        errors.push({ file: name, code: error.code || 'ASSET_VERIFY_FAILED', message: error.message });
      }
    }
    return { ok: errors.length === 0, checked: descriptors.length, descriptors, errors };
  }

  managedUrl(assetId) {
    this.getDescriptor(assetId);
    return `essayflow-asset://asset/${assetId}`;
  }

  async garbageCollect(reachableAssetIds, options = {}) {
    const reachable = new Set(reachableAssetIds || []);
    const deleted = [];
    const retained = [];
    for (const descriptor of this.listDescriptors()) {
      if (reachable.has(descriptor.assetId)) {
        retained.push(descriptor.assetId);
        continue;
      }
      deleted.push(descriptor.assetId);
      if (options.dryRun) continue;
      const recordPath = this.recordPath(descriptor.assetId);
      const tombstonePath = `${recordPath}.gc-${process.pid}`;
      fs.renameSync(recordPath, tombstonePath);
      const blobPath = this.blobPath(descriptor.sha256);
      if (fs.existsSync(blobPath)) fs.rmSync(blobPath, { force: true });
      fs.rmSync(tombstonePath, { force: true });
    }
    return { deleted: deleted.sort(), retained: retained.sort(), dryRun: options.dryRun === true };
  }
}

function collectAssetIds(value, output = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (typeof value.assetId === 'string' && UUID_PATTERN.test(value.assetId)) output.add(value.assetId);
  if (Array.isArray(value)) value.forEach(item => collectAssetIds(item, output, seen));
  else Object.values(value).forEach(item => collectAssetIds(item, output, seen));
  return output;
}

module.exports = {
  ASSET_SCHEMA_VERSION,
  AssetStoreError,
  AssetStore,
  DEFAULT_MAX_ASSET_BYTES,
  assetIdFromSha256,
  collectAssetIds,
  sanitizeAssetName,
  sha256Buffer,
  validateDescriptor
};
