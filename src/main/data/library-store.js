'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { durableWriteJson, normalizeRelativePath, resolveContainedPath } = require('./durable-fs');

const LIBRARY_SCHEMA_VERSION = 1;
const LIBRARY_ITEM_SCHEMA_VERSION = 1;
const LIBRARY_COLLECTION_SCHEMA_VERSION = 1;
const DEFAULT_LIBRARY_RELATIVE_PATH = 'library/library.json';
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 100000;
const MAX_COLLECTIONS = 10000;
const MAX_COLLECTION_MEMBERS = 100000;
const MAX_OBJECT_FIELDS = 10000;
const MAX_ARRAY_ITEMS = 100000;
const MAX_JSON_DEPTH = 24;
const MAX_STRING_LENGTH = 2 * 1024 * 1024;
const LIBRARY_ITEM_NAMESPACE = '7c84c3e8-9c7e-4a43-9475-e48d9ca5e447';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_STRING_PATTERN = /^\s*(?:authorization|proxy-authorization|x-api-key|api-key)\s*:/i;
const BEARER_STRING_PATTERN = /^\s*bearer\s+\S+/i;

const ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'LIBRARY_INPUT_INVALID',
  FILE_CORRUPT: 'LIBRARY_FILE_CORRUPT',
  FILE_UNSAFE: 'LIBRARY_FILE_UNSAFE',
  FILE_TOO_LARGE: 'LIBRARY_FILE_TOO_LARGE',
  SCHEMA_INVALID: 'LIBRARY_SCHEMA_INVALID',
  SCHEMA_UNSUPPORTED: 'LIBRARY_SCHEMA_UNSUPPORTED',
  SCHEMA_FUTURE: 'LIBRARY_SCHEMA_FUTURE_READ_ONLY',
  READ_ONLY: 'LIBRARY_READ_ONLY',
  BASE_REVISION_REQUIRED: 'LIBRARY_BASE_REVISION_REQUIRED',
  REVISION_CONFLICT: 'LIBRARY_REVISION_CONFLICT',
  UUID_INVALID: 'LIBRARY_UUID_INVALID',
  ITEM_NOT_FOUND: 'LIBRARY_ITEM_NOT_FOUND',
  COLLECTION_NOT_FOUND: 'LIBRARY_COLLECTION_NOT_FOUND',
  COLLECTION_MEMBER_NOT_FOUND: 'LIBRARY_COLLECTION_MEMBER_NOT_FOUND',
  DUPLICATE_ID: 'LIBRARY_DUPLICATE_ID',
  AMBIGUOUS_ID: 'LIBRARY_AMBIGUOUS_ID',
  PAPER_ID_REJECTED: 'LIBRARY_PAPER_ID_REJECTED',
  SECRET_FIELD_REJECTED: 'LIBRARY_SECRET_FIELD_REJECTED',
  ABSOLUTE_PATH_REJECTED: 'LIBRARY_ABSOLUTE_PATH_REJECTED',
  UNSAFE_KEY_REJECTED: 'LIBRARY_UNSAFE_KEY_REJECTED',
  REFERENCE_INVALID: 'LIBRARY_REFERENCE_INVALID',
  TIMESTAMP_INVALID: 'LIBRARY_TIMESTAMP_INVALID'
});

const SECRET_KEY_TOKENS = Object.freeze([
  'apikey',
  'authorization',
  'proxyauthorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'password',
  'passwd',
  'credential',
  'bearertoken',
  'safestorage',
  'ciphertext',
  'encryptedkey',
  'privatekey',
  'sessiontoken',
  'setcookie'
]);

const PATH_KEY_TOKENS = Object.freeze(new Set([
  'path',
  'absolutepath',
  'filepath',
  'machinepath',
  'localpath',
  'pdfpath',
  'imagepath',
  'sourcepath',
  'directorypath',
  'folderpath'
]));

const COLLECTION_FIELDS = Object.freeze([
  'schemaVersion',
  'collectionId',
  'name',
  'itemIds',
  'createdAt',
  'updatedAt'
]);

const ITEM_OPERATIONAL_FIELDS = Object.freeze(new Set([
  'schemaVersion',
  'libraryItemId',
  'createdAt',
  'updatedAt',
  'legacySourceId',
  'tags',
  'starred',
  'privateNote',
  'note',
  'notes',
  'favorite',
  'isFavorite',
  'collectionIds'
]));

class LibraryStoreError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LibraryStoreError';
    this.code = code;
    this.readOnly = details.readOnly === true;
    this.details = Object.freeze({ ...details });
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedSecurityKey(key) {
  return String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
  const normalized = normalizedSecurityKey(key);
  if (!normalized) return false;
  if (normalized === 'secret' || normalized.endsWith('secret')) return true;
  if (normalized === 'token' || normalized.endsWith('token')) return true;
  if (normalized === 'cookie' || normalized.endsWith('cookie')) return true;
  return SECRET_KEY_TOKENS.some(token => normalized.includes(token));
}

function isPathKey(key) {
  const normalized = normalizedSecurityKey(key);
  return PATH_KEY_TOKENS.has(normalized) || normalized.endsWith('absolutepath') || normalized.endsWith('filepath');
}

function isAbsoluteMachinePath(value) {
  if (typeof value !== 'string' || !value) return false;
  const normalized = value.trim();
  if (/^file:\/\//i.test(normalized)) return true;
  return path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized);
}

function containsEmbeddedUrlCredential(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
  try {
    const parsed = new URL(value.trim());
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function securityErrorForKey(key, jsonPath) {
  const normalized = normalizedSecurityKey(key);
  if (key === '__proto__' || normalized === 'proto' || normalized === 'prototype' || normalized === 'constructor') {
    return new LibraryStoreError(ERROR_CODES.UNSAFE_KEY_REJECTED, `文库字段名不安全: ${jsonPath}`, { path: jsonPath });
  }
  if (normalized === 'paperid') {
    return new LibraryStoreError(ERROR_CODES.PAPER_ID_REJECTED,
      `新文库模型禁止使用含义不明的 paperId，请改用 libraryItemId 或 legacySourceId: ${jsonPath}`, {
        path: jsonPath
      });
  }
  if (isSecretKey(key)) {
    return new LibraryStoreError(ERROR_CODES.SECRET_FIELD_REJECTED, `文库数据禁止包含凭据字段: ${jsonPath}`, {
      path: jsonPath
    });
  }
  if (isPathKey(key)) {
    return new LibraryStoreError(ERROR_CODES.ABSOLUTE_PATH_REJECTED,
      `文库数据禁止保存机器路径字段，请使用 assetId: ${jsonPath}`, { path: jsonPath });
  }
  return null;
}

function cloneSafeJson(value, jsonPath = '$', state = { seen: new Set(), depth: 0 }) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库字符串过长: ${jsonPath}`, { path: jsonPath });
    }
    if (CREDENTIAL_STRING_PATTERN.test(value) || BEARER_STRING_PATTERN.test(value) || containsEmbeddedUrlCredential(value)) {
      throw new LibraryStoreError(ERROR_CODES.SECRET_FIELD_REJECTED, `文库数据包含可复用凭据: ${jsonPath}`, {
        path: jsonPath
      });
    }
    if (isAbsoluteMachinePath(value)) {
      throw new LibraryStoreError(ERROR_CODES.ABSOLUTE_PATH_REJECTED,
        `文库数据禁止保存机器绝对路径，请使用 assetId: ${jsonPath}`, { path: jsonPath });
    }
    return value.replace(/\r\n?/g, '\n').normalize('NFC');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库数字无效: ${jsonPath}`, { path: jsonPath });
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== 'object') {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库值必须是 JSON 数据: ${jsonPath}`, { path: jsonPath });
  }
  if (state.seen.has(value)) {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库数据包含循环引用: ${jsonPath}`, { path: jsonPath });
  }
  if (state.depth >= MAX_JSON_DEPTH) {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库数据嵌套超过 ${MAX_JSON_DEPTH} 层: ${jsonPath}`, {
      path: jsonPath
    });
  }
  state.seen.add(value);
  try {
    const nextState = { seen: state.seen, depth: state.depth + 1 };
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库数组过长: ${jsonPath}`, { path: jsonPath });
      }
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, index)) {
          throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库数组不能包含空位: ${jsonPath}[${index}]`, {
            path: `${jsonPath}[${index}]`
          });
        }
        output.push(cloneSafeJson(value[index], `${jsonPath}[${index}]`, nextState));
      }
      return output;
    }
    if (!isPlainObject(value)) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库值必须是普通对象: ${jsonPath}`, { path: jsonPath });
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new LibraryStoreError(ERROR_CODES.UNSAFE_KEY_REJECTED, `文库对象不能包含 Symbol 字段: ${jsonPath}`, {
        path: jsonPath
      });
    }
    const sourceKeys = Object.keys(value);
    if (sourceKeys.length > MAX_OBJECT_FIELDS) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, `文库对象字段过多: ${jsonPath}`, { path: jsonPath });
    }
    const normalizedKeys = new Map();
    for (const sourceKey of sourceKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, sourceKey);
      if (!descriptor || hasOwn(descriptor, 'get') || hasOwn(descriptor, 'set')) {
        throw new LibraryStoreError(ERROR_CODES.UNSAFE_KEY_REJECTED, `文库对象不能包含访问器字段: ${jsonPath}.${sourceKey}`, {
          path: `${jsonPath}.${sourceKey}`
        });
      }
      const key = sourceKey.normalize('NFC');
      const keyError = securityErrorForKey(key, `${jsonPath}.${key}`);
      if (keyError) throw keyError;
      if (normalizedKeys.has(key)) {
        throw new LibraryStoreError(ERROR_CODES.UNSAFE_KEY_REJECTED,
          `文库字段在 Unicode 规范化后冲突: ${jsonPath}.${key}`, { path: `${jsonPath}.${key}` });
      }
      normalizedKeys.set(key, sourceKey);
    }
    const output = {};
    for (const key of [...normalizedKeys.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
      output[key] = cloneSafeJson(value[normalizedKeys.get(key)], `${jsonPath}.${key}`, nextState);
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function immutableJson(value) {
  return deepFreeze(cloneSafeJson(value));
}

function normalizeUuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new LibraryStoreError(ERROR_CODES.UUID_INVALID, `${field} 必须是稳定 UUID`, { field, value });
  }
  return value.toLowerCase();
}

function uuidToBytes(value) {
  return Buffer.from(normalizeUuid(value, 'namespaceId').replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableUuidV5(namespaceId, name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, '稳定 UUID 的源标识不能为空');
  }
  const digest = crypto.createHash('sha1')
    .update(uuidToBytes(namespaceId))
    .update(Buffer.from(name.normalize('NFC'), 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function libraryItemIdFromLegacySourceId(legacySourceId, namespaceId = LIBRARY_ITEM_NAMESPACE) {
  if (typeof legacySourceId !== 'string' || !legacySourceId.trim()) {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, 'legacySourceId 必须是非空字符串');
  }
  return stableUuidV5(namespaceId, `EssayFlow.LibraryItem\n${legacySourceId.normalize('NFC')}`);
}

function normalizeTimestamp(value, field) {
  if (typeof value !== 'string') {
    throw new LibraryStoreError(ERROR_CODES.TIMESTAMP_INVALID, `${field} 必须是 UTC ISO-8601 时间`, { field });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new LibraryStoreError(ERROR_CODES.TIMESTAMP_INVALID, `${field} 必须是规范 UTC ISO-8601 时间`, {
      field,
      value
    });
  }
  return value;
}

function maximumTimestamp(...values) {
  return values.reduce((latest, current) => (!latest || current > latest ? current : latest), null);
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch (error) {
    throw new LibraryStoreError(ERROR_CODES.TIMESTAMP_INVALID, '无法取得文库更新时间', {}, error);
  }
  if (value instanceof Date) value = value.toISOString();
  return normalizeTimestamp(value, 'updatedAt');
}

function validateSchemaVersion(value, supported, entity) {
  if (!Number.isInteger(value) || value < 1) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, `${entity} schemaVersion 无效`, {
      entity,
      schemaVersion: value
    });
  }
  if (value > supported) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_FUTURE,
      `${entity} schemaVersion ${value} 高于当前支持版本 ${supported}，只允许只读诊断导出`, {
        entity,
        schemaVersion: value,
        supportedVersion: supported,
        readOnly: true
      });
  }
  if (value !== supported) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_UNSUPPORTED, `${entity} schemaVersion ${value} 需要迁移`, {
      entity,
      schemaVersion: value,
      supportedVersion: supported
    });
  }
}

function validateLibraryItem(value) {
  const item = cloneSafeJson(value, '$.item');
  if (!isPlainObject(item)) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'LibraryItem 必须是对象');
  }
  if (hasOwn(item, 'id') || hasOwn(item, 'citationItemId')) {
    throw new LibraryStoreError(ERROR_CODES.AMBIGUOUS_ID,
      'LibraryItem 只能使用 libraryItemId；外部或旧 ID 请放入 legacySourceId');
  }
  if (hasOwn(item, 'collectionIds')) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID,
      '集合归属只能保存在 envelope.collections，LibraryItem.collectionIds 会形成双真相');
  }
  validateSchemaVersion(item.schemaVersion, LIBRARY_ITEM_SCHEMA_VERSION, 'LibraryItem');
  item.libraryItemId = normalizeUuid(item.libraryItemId, 'libraryItemId');
  item.createdAt = normalizeTimestamp(item.createdAt, 'LibraryItem.createdAt');
  item.updatedAt = normalizeTimestamp(item.updatedAt, 'LibraryItem.updatedAt');
  if (item.updatedAt < item.createdAt) {
    throw new LibraryStoreError(ERROR_CODES.TIMESTAMP_INVALID, 'LibraryItem.updatedAt 不能早于 createdAt', {
      libraryItemId: item.libraryItemId
    });
  }
  if (hasOwn(item, 'legacySourceId') &&
      (typeof item.legacySourceId !== 'string' || !item.legacySourceId.trim() || item.legacySourceId.length > 4096)) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'legacySourceId 必须是非空字符串');
  }
  return immutableJson(item);
}

function normalizeLibraryItemForWrite(value, options) {
  const item = cloneSafeJson(value, '$.item');
  if (!isPlainObject(item)) throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, 'LibraryItem 必须是对象');
  if (hasOwn(item, 'id') || hasOwn(item, 'citationItemId')) {
    throw new LibraryStoreError(ERROR_CODES.AMBIGUOUS_ID,
      'LibraryItem 只能使用 libraryItemId；外部或旧 ID 请放入 legacySourceId');
  }
  if (hasOwn(item, 'collectionIds')) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID,
      '集合归属只能保存在 envelope.collections，LibraryItem.collectionIds 会形成双真相');
  }
  if (hasOwn(item, 'schemaVersion')) {
    validateSchemaVersion(item.schemaVersion, LIBRARY_ITEM_SCHEMA_VERSION, 'LibraryItem');
  }
  const generatedId = options.existing?.libraryItemId || options.idFactory();
  const libraryItemId = normalizeUuid(item.libraryItemId || generatedId, 'libraryItemId');
  if (options.existing && libraryItemId !== options.existing.libraryItemId) {
    throw new LibraryStoreError(ERROR_CODES.AMBIGUOUS_ID, '更新 LibraryItem 时不能改变 libraryItemId', {
      expected: options.existing.libraryItemId,
      actual: libraryItemId
    });
  }
  const now = options.now;
  const createdAt = options.existing?.createdAt ||
    (hasOwn(item, 'createdAt') ? normalizeTimestamp(item.createdAt, 'LibraryItem.createdAt') : now);
  const requestedUpdatedAt = options.preserveTimestamps && hasOwn(item, 'updatedAt')
    ? normalizeTimestamp(item.updatedAt, 'LibraryItem.updatedAt')
    : now;
  item.schemaVersion = LIBRARY_ITEM_SCHEMA_VERSION;
  item.libraryItemId = libraryItemId;
  item.createdAt = createdAt;
  item.updatedAt = maximumTimestamp(createdAt, options.existing?.updatedAt, requestedUpdatedAt);
  return validateLibraryItem(item);
}

function validateCollection(value, itemIds = null) {
  const collection = cloneSafeJson(value, '$.collection');
  if (!isPlainObject(collection)) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'Collection 必须是对象');
  }
  const actualFields = Object.keys(collection).sort();
  const expectedFields = [...COLLECTION_FIELDS].sort();
  if (actualFields.length !== expectedFields.length ||
      actualFields.some((field, index) => field !== expectedFields[index])) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'Collection 字段不完整或包含未知字段');
  }
  validateSchemaVersion(collection.schemaVersion, LIBRARY_COLLECTION_SCHEMA_VERSION, 'Collection');
  collection.collectionId = normalizeUuid(collection.collectionId, 'collectionId');
  if (typeof collection.name !== 'string' || !collection.name.trim() || collection.name.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(collection.name)) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'Collection.name 必须是有效非空字符串');
  }
  collection.name = collection.name.trim().normalize('NFC');
  if (!Array.isArray(collection.itemIds) || collection.itemIds.length > MAX_COLLECTION_MEMBERS) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'Collection.itemIds 必须是有限长度数组');
  }
  collection.itemIds = collection.itemIds.map((id, index) => normalizeUuid(id, `Collection.itemIds[${index}]`));
  if (new Set(collection.itemIds).size !== collection.itemIds.length) {
    throw new LibraryStoreError(ERROR_CODES.DUPLICATE_ID, 'Collection.itemIds 不能包含重复 ID', {
      collectionId: collection.collectionId
    });
  }
  collection.itemIds.sort((left, right) => left.localeCompare(right, 'en'));
  if (itemIds) {
    for (const libraryItemId of collection.itemIds) {
      if (!itemIds.has(libraryItemId)) {
        throw new LibraryStoreError(ERROR_CODES.REFERENCE_INVALID, '集合引用了不存在的 LibraryItem', {
          collectionId: collection.collectionId,
          libraryItemId
        });
      }
    }
  }
  collection.createdAt = normalizeTimestamp(collection.createdAt, 'Collection.createdAt');
  collection.updatedAt = normalizeTimestamp(collection.updatedAt, 'Collection.updatedAt');
  if (collection.updatedAt < collection.createdAt) {
    throw new LibraryStoreError(ERROR_CODES.TIMESTAMP_INVALID, 'Collection.updatedAt 不能早于 createdAt', {
      collectionId: collection.collectionId
    });
  }
  return immutableJson(collection);
}

function normalizeCollectionForWrite(value, options) {
  const collection = typeof value === 'string' ? { name: value } : cloneSafeJson(value, '$.collection');
  if (!isPlainObject(collection)) throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, 'Collection 必须是对象或名称字符串');
  for (const field of Object.keys(collection)) {
    if (!COLLECTION_FIELDS.includes(field)) {
      throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, `Collection 包含未知字段: ${field}`, { field });
    }
  }
  if (hasOwn(collection, 'schemaVersion')) {
    validateSchemaVersion(collection.schemaVersion, LIBRARY_COLLECTION_SCHEMA_VERSION, 'Collection');
  }
  const collectionId = normalizeUuid(
    collection.collectionId || options.existing?.collectionId || options.idFactory(),
    'collectionId'
  );
  if (options.existing && collectionId !== options.existing.collectionId) {
    throw new LibraryStoreError(ERROR_CODES.AMBIGUOUS_ID, '更新 Collection 时不能改变 collectionId');
  }
  const createdAt = options.existing?.createdAt ||
    (hasOwn(collection, 'createdAt') ? normalizeTimestamp(collection.createdAt, 'Collection.createdAt') : options.now);
  const requestedUpdatedAt = options.preserveTimestamps && hasOwn(collection, 'updatedAt')
    ? normalizeTimestamp(collection.updatedAt, 'Collection.updatedAt')
    : options.now;
  return validateCollection({
    schemaVersion: LIBRARY_COLLECTION_SCHEMA_VERSION,
    collectionId,
    name: hasOwn(collection, 'name') ? collection.name : options.existing?.name,
    itemIds: hasOwn(collection, 'itemIds') ? collection.itemIds : (options.existing?.itemIds || []),
    createdAt,
    updatedAt: maximumTimestamp(createdAt, options.existing?.updatedAt, requestedUpdatedAt)
  }, options.itemIds);
}

function validateLibraryEnvelope(value) {
  const envelope = cloneSafeJson(value);
  if (!isPlainObject(envelope)) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, '文库 envelope 必须是对象');
  }
  validateSchemaVersion(envelope.schemaVersion, LIBRARY_SCHEMA_VERSION, 'LibraryEnvelope');
  const expectedFields = ['collections', 'itemsById', 'revision', 'schemaVersion', 'updatedAt'];
  const actualFields = Object.keys(envelope).sort();
  if (actualFields.length !== expectedFields.length ||
      actualFields.some((field, index) => field !== expectedFields[index])) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, '文库 envelope 字段不完整或包含未知字段');
  }
  if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 0) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, '文库 revision 必须是非负安全整数');
  }
  envelope.updatedAt = normalizeTimestamp(envelope.updatedAt, 'LibraryEnvelope.updatedAt');
  if (!isPlainObject(envelope.itemsById) || Object.keys(envelope.itemsById).length > MAX_ITEMS) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'itemsById 必须是有限长度对象');
  }
  const itemsById = {};
  for (const mapKey of Object.keys(envelope.itemsById).sort((left, right) => left.localeCompare(right, 'en'))) {
    const normalizedKey = normalizeUuid(mapKey, 'itemsById key');
    const item = validateLibraryItem(envelope.itemsById[mapKey]);
    if (item.libraryItemId !== normalizedKey) {
      throw new LibraryStoreError(ERROR_CODES.AMBIGUOUS_ID, 'itemsById 键与 LibraryItem.libraryItemId 不一致', {
        mapKey,
        libraryItemId: item.libraryItemId
      });
    }
    itemsById[normalizedKey] = item;
  }
  if (!Array.isArray(envelope.collections) || envelope.collections.length > MAX_COLLECTIONS) {
    throw new LibraryStoreError(ERROR_CODES.SCHEMA_INVALID, 'collections 必须是有限长度数组');
  }
  const itemIds = new Set(Object.keys(itemsById));
  const collectionIds = new Set();
  const collections = envelope.collections.map(collection => {
    const validated = validateCollection(collection, itemIds);
    if (collectionIds.has(validated.collectionId)) {
      throw new LibraryStoreError(ERROR_CODES.DUPLICATE_ID, 'collections 包含重复 collectionId', {
        collectionId: validated.collectionId
      });
    }
    collectionIds.add(validated.collectionId);
    return validated;
  }).sort((left, right) => left.collectionId.localeCompare(right.collectionId, 'en'));
  const newestChildTimestamp = maximumTimestamp(
    ...Object.values(itemsById).map(item => item.updatedAt),
    ...collections.map(collection => collection.updatedAt)
  );
  if (newestChildTimestamp && envelope.updatedAt < newestChildTimestamp) {
    throw new LibraryStoreError(ERROR_CODES.TIMESTAMP_INVALID,
      'LibraryEnvelope.updatedAt 不能早于条目或集合更新时间');
  }
  return immutableJson({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision: envelope.revision,
    updatedAt: envelope.updatedAt,
    itemsById,
    collections
  });
}

function createEmptyLibraryEnvelope(updatedAt = new Date().toISOString()) {
  return validateLibraryEnvelope({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: normalizeTimestamp(updatedAt, 'LibraryEnvelope.updatedAt'),
    itemsById: {},
    collections: []
  });
}

function normalizeReplacement(value, options) {
  let itemValues;
  let collectionValues;
  if (Array.isArray(value)) {
    itemValues = value;
    collectionValues = [];
  } else if (isPlainObject(value) && hasOwn(value, 'schemaVersion') && hasOwn(value, 'revision')) {
    const snapshot = validateLibraryEnvelope(value);
    itemValues = Object.values(snapshot.itemsById);
    collectionValues = snapshot.collections;
  } else if (isPlainObject(value) && Array.isArray(value.items)) {
    itemValues = value.items;
    collectionValues = value.collections || [];
  } else if (isPlainObject(value) && isPlainObject(value.itemsById)) {
    itemValues = Object.entries(value.itemsById).map(([mapKey, item]) => {
      if (!isPlainObject(item)) return item;
      if (hasOwn(item, 'libraryItemId')) {
        const mapId = normalizeUuid(mapKey, 'itemsById key');
        const itemId = normalizeUuid(item.libraryItemId, 'libraryItemId');
        if (itemId !== mapId) {
          throw new LibraryStoreError(ERROR_CODES.AMBIGUOUS_ID,
            '批量替换的 itemsById 键与 libraryItemId 不一致', { mapKey, libraryItemId: item.libraryItemId });
        }
      }
      return hasOwn(item, 'libraryItemId') ? item : { ...item, libraryItemId: mapKey };
    });
    collectionValues = value.collections || [];
  } else {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID,
      '批量替换必须提供 LibraryItem 数组、{items, collections}、{itemsById, collections} 或文库快照');
  }
  if (itemValues.length > MAX_ITEMS || !Array.isArray(collectionValues) || collectionValues.length > MAX_COLLECTIONS) {
    throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, '批量替换超过文库容量限制');
  }
  const itemsById = {};
  for (const valueItem of itemValues) {
    const item = normalizeLibraryItemForWrite(valueItem, {
      idFactory: options.idFactory,
      now: options.now,
      preserveTimestamps: true
    });
    if (hasOwn(itemsById, item.libraryItemId)) {
      throw new LibraryStoreError(ERROR_CODES.DUPLICATE_ID, '批量替换包含重复 libraryItemId', {
        libraryItemId: item.libraryItemId
      });
    }
    itemsById[item.libraryItemId] = item;
  }
  const itemIds = new Set(Object.keys(itemsById));
  const collections = [];
  const seenCollections = new Set();
  for (const valueCollection of collectionValues) {
    const collection = normalizeCollectionForWrite(valueCollection, {
      idFactory: options.idFactory,
      now: options.now,
      preserveTimestamps: true,
      itemIds
    });
    if (seenCollections.has(collection.collectionId)) {
      throw new LibraryStoreError(ERROR_CODES.DUPLICATE_ID, '批量替换包含重复 collectionId', {
        collectionId: collection.collectionId
      });
    }
    seenCollections.add(collection.collectionId);
    collections.push(collection);
  }
  collections.sort((left, right) => left.collectionId.localeCompare(right.collectionId, 'en'));
  return { itemsById, collections };
}

function validateBaseRevision(options) {
  const baseRevision = typeof options === 'number' ? options : options?.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new LibraryStoreError(ERROR_CODES.BASE_REVISION_REQUIRED,
      '每次文库写入都必须携带非负整数 baseRevision');
  }
  return baseRevision;
}

function createCitationItemSnapshot(libraryItemValue, options = {}) {
  const libraryItem = validateLibraryItem(libraryItemValue);
  const idFactory = options.idFactory || crypto.randomUUID;
  const citationItemId = normalizeUuid(options.citationItemId || idFactory(), 'citationItemId');
  const capturedAt = options.capturedAt || (options.now ? readNow(options.now) : new Date().toISOString());
  const snapshot = {};
  for (const [key, value] of Object.entries(libraryItem)) {
    if (!ITEM_OPERATIONAL_FIELDS.has(key)) snapshot[key] = value;
  }
  snapshot.schemaVersion = LIBRARY_ITEM_SCHEMA_VERSION;
  snapshot.citationItemId = citationItemId;
  snapshot.libraryItemId = libraryItem.libraryItemId;
  if (hasOwn(options, 'projectId')) snapshot.projectId = normalizeUuid(options.projectId, 'projectId');
  snapshot.capturedAt = normalizeTimestamp(capturedAt, 'CitationItem.capturedAt');
  return immutableJson(snapshot);
}

function readJsonFileSync(filePath, maximumBytes) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new LibraryStoreError(ERROR_CODES.FILE_CORRUPT, '文库文件无法读取', { filePath }, error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LibraryStoreError(ERROR_CODES.FILE_UNSAFE, '文库文件必须是普通文件且不能是符号链接', { filePath });
  }
  if (stat.size > maximumBytes) {
    throw new LibraryStoreError(ERROR_CODES.FILE_TOO_LARGE, `文库文件超过 ${maximumBytes} 字节限制`, {
      filePath,
      size: stat.size,
      maximumBytes
    });
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new LibraryStoreError(ERROR_CODES.FILE_CORRUPT, '文库文件不是有效 JSON', { filePath }, error);
  }
}

class LibraryStore {
  constructor(rootPath, options = {}) {
    if (typeof rootPath !== 'string' || !rootPath) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, 'LibraryStore 需要 repository 根目录');
    }
    this.rootPath = path.resolve(rootPath);
    this.relativePath = normalizeRelativePath(options.relativePath || DEFAULT_LIBRARY_RELATIVE_PATH);
    this.filePath = resolveContainedPath(this.rootPath, this.relativePath);
    this.writeJson = options.durableWriteJson || durableWriteJson;
    this.now = options.now || (() => new Date());
    this.idFactory = options.idFactory || crypto.randomUUID;
    this.maximumFileBytes = options.maximumFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (typeof this.writeJson !== 'function' || typeof this.now !== 'function' || typeof this.idFactory !== 'function' ||
        !Number.isSafeInteger(this.maximumFileBytes) || this.maximumFileBytes < 1) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, 'LibraryStore 适配器或文件大小限制无效');
    }
    this._writeQueue = Promise.resolve();
    this._readOnly = false;
    this._indeterminate = false;
    this._futureEnvelope = null;
    this._cache = createEmptyLibraryEnvelope(readNow(this.now));
    this._loadSync();
  }

  _loadSync() {
    const raw = readJsonFileSync(this.filePath, this.maximumFileBytes);
    if (!raw) return;
    try {
      this._cache = validateLibraryEnvelope(raw);
      this._readOnly = false;
      this._futureEnvelope = null;
    } catch (error) {
      if (error instanceof LibraryStoreError && error.code === ERROR_CODES.SCHEMA_FUTURE) {
        this._futureEnvelope = immutableJson(raw);
        this._readOnly = true;
        return;
      }
      throw error;
    }
  }

  get readOnly() {
    return this._readOnly;
  }

  get revision() {
    this._assertInterpretable();
    return this._cache.revision;
  }

  _assertInterpretable() {
    if (this._futureEnvelope) {
      throw new LibraryStoreError(ERROR_CODES.SCHEMA_FUTURE,
        '未来 schema 文库不能由当前版本解释，只允许导出原始快照用于诊断', { readOnly: true });
    }
  }

  _assertWritable() {
    if (this._readOnly || this._indeterminate) {
      throw new LibraryStoreError(ERROR_CODES.READ_ONLY,
        this._indeterminate ? '文库提交状态无法确认，重新打开前禁止继续写入' : '未来 schema 文库禁止写入', {
          readOnly: true,
          indeterminate: this._indeterminate
        });
    }
  }

  readSync() {
    this._assertInterpretable();
    return immutableJson(this._cache);
  }

  readEnvelopeSync() {
    return immutableJson(this._futureEnvelope || this._cache);
  }

  exportSnapshot() {
    return this.readEnvelopeSync();
  }

  listItems() {
    this._assertInterpretable();
    return immutableJson(Object.values(this._cache.itemsById));
  }

  list() {
    return this.listItems();
  }

  getItem(libraryItemId) {
    this._assertInterpretable();
    const id = normalizeUuid(libraryItemId, 'libraryItemId');
    return hasOwn(this._cache.itemsById, id) ? immutableJson(this._cache.itemsById[id]) : null;
  }

  listCollections() {
    this._assertInterpretable();
    return immutableJson(this._cache.collections);
  }

  getCollection(collectionId) {
    this._assertInterpretable();
    const id = normalizeUuid(collectionId, 'collectionId');
    const collection = this._cache.collections.find(candidate => candidate.collectionId === id);
    return collection ? immutableJson(collection) : null;
  }

  _enqueue(operation) {
    const pending = this._writeQueue.catch(() => undefined).then(operation);
    this._writeQueue = pending;
    return pending;
  }

  whenIdle() {
    return this._writeQueue;
  }

  _assertBaseRevision(baseRevision) {
    if (this._cache.revision !== baseRevision) {
      throw new LibraryStoreError(ERROR_CODES.REVISION_CONFLICT,
        `文库 revision 冲突：期望 ${baseRevision}，当前 ${this._cache.revision}`, {
          baseRevision,
          currentRevision: this._cache.revision
        });
    }
  }

  async _reloadAfterCommittedFailure() {
    try {
      this._loadSync();
    } catch {
      this._indeterminate = true;
      this._readOnly = true;
    }
  }

  async _commitContent(baseRevision, content, label, extra = {}) {
    const updatedAt = maximumTimestamp(
      readNow(this.now),
      this._cache.updatedAt,
      ...Object.values(content.itemsById).map(item => item.updatedAt),
      ...content.collections.map(collection => collection.updatedAt)
    );
    const envelope = validateLibraryEnvelope({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      revision: baseRevision + 1,
      updatedAt,
      itemsById: content.itemsById,
      collections: content.collections
    });
    let acknowledgment;
    try {
      acknowledgment = await this.writeJson(this.rootPath, this.relativePath, envelope, { label });
    } catch (error) {
      if (error?.committed === true || error?.details?.committed === true) {
        await this._reloadAfterCommittedFailure();
      }
      throw error;
    }
    this._cache = envelope;
    return Object.freeze({
      acknowledgment,
      baseRevision,
      newRevision: envelope.revision,
      snapshot: this.readSync(),
      ...extra
    });
  }

  replace(value, options) {
    const baseRevision = validateBaseRevision(options);
    const captured = cloneSafeJson(value);
    return this._enqueue(async () => {
      this._assertWritable();
      this._assertBaseRevision(baseRevision);
      const now = readNow(this.now);
      const content = normalizeReplacement(captured, { idFactory: this.idFactory, now });
      return this._commitContent(baseRevision, content, 'library-bulk-replace');
    });
  }

  bulkReplace(value, options) {
    return this.replace(value, options);
  }

  importSnapshot(snapshot, options) {
    const validated = validateLibraryEnvelope(snapshot);
    return this.replace(validated, options);
  }

  upsertItem(value, options) {
    const baseRevision = validateBaseRevision(options);
    const captured = cloneSafeJson(value, '$.item');
    return this._enqueue(async () => {
      this._assertWritable();
      this._assertBaseRevision(baseRevision);
      const draft = cloneSafeJson(this._cache);
      const requestedId = captured.libraryItemId ? normalizeUuid(captured.libraryItemId, 'libraryItemId') : null;
      const existing = requestedId ? draft.itemsById[requestedId] : null;
      const item = normalizeLibraryItemForWrite(captured, {
        existing,
        idFactory: this.idFactory,
        now: readNow(this.now),
        preserveTimestamps: false
      });
      draft.itemsById[item.libraryItemId] = item;
      return this._commitContent(baseRevision, draft, 'library-item-upsert', { item });
    });
  }

  upsert(value, options) {
    return this.upsertItem(value, options);
  }

  removeItem(libraryItemId, options) {
    const id = normalizeUuid(libraryItemId, 'libraryItemId');
    const baseRevision = validateBaseRevision(options);
    return this._enqueue(async () => {
      this._assertWritable();
      this._assertBaseRevision(baseRevision);
      const draft = cloneSafeJson(this._cache);
      if (!hasOwn(draft.itemsById, id)) {
        throw new LibraryStoreError(ERROR_CODES.ITEM_NOT_FOUND, '要移除的 LibraryItem 不存在', { libraryItemId: id });
      }
      const removedItem = immutableJson(draft.itemsById[id]);
      delete draft.itemsById[id];
      draft.collections = draft.collections.map(collection => ({
        ...collection,
        itemIds: collection.itemIds.filter(itemId => itemId !== id),
        updatedAt: collection.itemIds.includes(id)
          ? maximumTimestamp(collection.updatedAt, readNow(this.now))
          : collection.updatedAt
      }));
      return this._commitContent(baseRevision, draft, 'library-item-remove', { removedItem });
    });
  }

  remove(libraryItemId, options) {
    return this.removeItem(libraryItemId, options);
  }

  upsertCollection(value, options) {
    const baseRevision = validateBaseRevision(options);
    const captured = typeof value === 'string' ? value : cloneSafeJson(value, '$.collection');
    return this._enqueue(async () => {
      this._assertWritable();
      this._assertBaseRevision(baseRevision);
      const draft = cloneSafeJson(this._cache);
      const requestedId = typeof captured === 'object' && captured.collectionId
        ? normalizeUuid(captured.collectionId, 'collectionId')
        : null;
      const existingIndex = requestedId
        ? draft.collections.findIndex(collection => collection.collectionId === requestedId)
        : -1;
      const existing = existingIndex >= 0 ? draft.collections[existingIndex] : null;
      const collection = normalizeCollectionForWrite(captured, {
        existing,
        idFactory: this.idFactory,
        now: readNow(this.now),
        preserveTimestamps: false,
        itemIds: new Set(Object.keys(draft.itemsById))
      });
      if (existingIndex >= 0) draft.collections[existingIndex] = collection;
      else draft.collections.push(collection);
      draft.collections.sort((left, right) => left.collectionId.localeCompare(right.collectionId, 'en'));
      return this._commitContent(baseRevision, draft, 'library-collection-upsert', { collection });
    });
  }

  createCollection(value, options) {
    return this.upsertCollection(value, options);
  }

  renameCollection(collectionId, name, options) {
    const existing = this.getCollection(collectionId);
    if (!existing) {
      throw new LibraryStoreError(ERROR_CODES.COLLECTION_NOT_FOUND, '要重命名的 Collection 不存在', {
        collectionId
      });
    }
    return this.upsertCollection({ ...existing, name }, options);
  }

  removeCollection(collectionId, options) {
    const id = normalizeUuid(collectionId, 'collectionId');
    const baseRevision = validateBaseRevision(options);
    return this._enqueue(async () => {
      this._assertWritable();
      this._assertBaseRevision(baseRevision);
      const draft = cloneSafeJson(this._cache);
      const index = draft.collections.findIndex(collection => collection.collectionId === id);
      if (index < 0) {
        throw new LibraryStoreError(ERROR_CODES.COLLECTION_NOT_FOUND, '要移除的 Collection 不存在', {
          collectionId: id
        });
      }
      const [removedCollection] = draft.collections.splice(index, 1);
      return this._commitContent(baseRevision, draft, 'library-collection-remove', {
        removedCollection: immutableJson(removedCollection)
      });
    });
  }

  deleteCollection(collectionId, options) {
    return this.removeCollection(collectionId, options);
  }

  _changeCollectionMembers(collectionId, options, operation, label) {
    const id = normalizeUuid(collectionId, 'collectionId');
    const baseRevision = validateBaseRevision(options);
    return this._enqueue(async () => {
      this._assertWritable();
      this._assertBaseRevision(baseRevision);
      const draft = cloneSafeJson(this._cache);
      const index = draft.collections.findIndex(collection => collection.collectionId === id);
      if (index < 0) {
        throw new LibraryStoreError(ERROR_CODES.COLLECTION_NOT_FOUND, 'Collection 不存在', { collectionId: id });
      }
      const current = draft.collections[index];
      const itemIds = operation([...current.itemIds], draft.itemsById);
      const collection = normalizeCollectionForWrite({ ...current, itemIds }, {
        existing: current,
        idFactory: this.idFactory,
        now: readNow(this.now),
        preserveTimestamps: false,
        itemIds: new Set(Object.keys(draft.itemsById))
      });
      draft.collections[index] = collection;
      return this._commitContent(baseRevision, draft, label, { collection });
    });
  }

  addItemToCollection(collectionId, libraryItemId, options) {
    const itemId = normalizeUuid(libraryItemId, 'libraryItemId');
    return this._changeCollectionMembers(collectionId, options, (itemIds, itemsById) => {
      if (!hasOwn(itemsById, itemId)) {
        throw new LibraryStoreError(ERROR_CODES.ITEM_NOT_FOUND, '要加入集合的 LibraryItem 不存在', {
          libraryItemId: itemId
        });
      }
      if (!itemIds.includes(itemId)) itemIds.push(itemId);
      return itemIds;
    }, 'library-collection-add-item');
  }

  removeItemFromCollection(collectionId, libraryItemId, options) {
    const itemId = normalizeUuid(libraryItemId, 'libraryItemId');
    return this._changeCollectionMembers(collectionId, options, itemIds => {
      if (!itemIds.includes(itemId)) {
        throw new LibraryStoreError(ERROR_CODES.COLLECTION_MEMBER_NOT_FOUND, 'LibraryItem 不在该集合中', {
          collectionId,
          libraryItemId: itemId
        });
      }
      return itemIds.filter(candidate => candidate !== itemId);
    }, 'library-collection-remove-item');
  }

  replaceCollectionItems(collectionId, itemIds, options) {
    const captured = cloneSafeJson(itemIds, '$.itemIds');
    if (!Array.isArray(captured)) {
      throw new LibraryStoreError(ERROR_CODES.INPUT_INVALID, 'itemIds 必须是 UUID 数组');
    }
    return this._changeCollectionMembers(collectionId, options, (_current, itemsById) => {
      const normalized = captured.map((itemId, index) => normalizeUuid(itemId, `itemIds[${index}]`));
      if (new Set(normalized).size !== normalized.length) {
        throw new LibraryStoreError(ERROR_CODES.DUPLICATE_ID, 'itemIds 不能包含重复 ID');
      }
      for (const itemId of normalized) {
        if (!hasOwn(itemsById, itemId)) {
          throw new LibraryStoreError(ERROR_CODES.ITEM_NOT_FOUND, '集合成员 LibraryItem 不存在', {
            libraryItemId: itemId
          });
        }
      }
      return normalized;
    }, 'library-collection-replace-items');
  }

  setCollectionItems(collectionId, itemIds, options) {
    return this.replaceCollectionItems(collectionId, itemIds, options);
  }
}

module.exports = {
  DEFAULT_LIBRARY_RELATIVE_PATH,
  ERROR_CODES,
  LIBRARY_COLLECTION_SCHEMA_VERSION,
  LIBRARY_ITEM_NAMESPACE,
  LIBRARY_ITEM_SCHEMA_VERSION,
  LIBRARY_SCHEMA_VERSION,
  LibraryStore,
  LibraryStoreError,
  createCitationItemSnapshot,
  createEmptyLibraryEnvelope,
  isAbsoluteMachinePath,
  isSecretKey,
  libraryItemIdFromLegacySourceId,
  stableUuidV5,
  validateCollection,
  validateLibraryEnvelope,
  validateLibraryItem
};
