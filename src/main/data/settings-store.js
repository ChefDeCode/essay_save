'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { durableWriteJson, normalizeRelativePath, resolveContainedPath } = require('./durable-fs');

const SETTINGS_SCHEMA_VERSION = 1;
const SECRET_SCHEMA_VERSION = 1;
const DEFAULT_SETTINGS_RELATIVE_PATH = 'settings/exportable-settings.json';
const DEFAULT_SECRET_RELATIVE_PATH = 'credentials/provider-credentials.json';
const MAX_STRING_LENGTH = 4096;
const MAX_COLLECTION_ITEMS = 1000;
const MAX_JSON_DEPTH = 8;

const EXPORTABLE_SETTINGS_FIELDS = Object.freeze([
  'theme',
  'layout',
  'shortcuts',
  'defaultReferenceStyle',
  'enabledSearchSourceIds',
  'customSearchSources',
  'providerId',
  'providerOrigin',
  'model',
  'featureToggles'
]);

const CREDENTIAL_STATUS = Object.freeze({
  MISSING: 'missing',
  NEEDS_REENTRY: 'needs-reentry',
  CONFIGURED: 'configured'
});

const ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'SETTINGS_INPUT_INVALID',
  FIELD_UNKNOWN: 'SETTINGS_FIELD_UNKNOWN',
  FIELD_INVALID: 'SETTINGS_FIELD_INVALID',
  SECRET_FIELD: 'SETTINGS_SECRET_FIELD_REJECTED',
  SCHEMA_INVALID: 'SETTINGS_SCHEMA_INVALID',
  SCHEMA_UNSUPPORTED: 'SETTINGS_SCHEMA_UNSUPPORTED',
  SCHEMA_FUTURE: 'SETTINGS_SCHEMA_FUTURE_READ_ONLY',
  FILE_CORRUPT: 'SETTINGS_FILE_CORRUPT',
  FILE_UNSAFE: 'SETTINGS_FILE_UNSAFE',
  READ_ONLY: 'SETTINGS_READ_ONLY',
  BACKUP_INVALID: 'SETTINGS_BACKUP_INVALID',
  PROVIDER_ID_INVALID: 'SECRET_PROVIDER_ID_INVALID',
  SECRET_INPUT_INVALID: 'SECRET_INPUT_INVALID',
  SECRET_SCHEMA_INVALID: 'SECRET_SCHEMA_INVALID',
  SECRET_SCHEMA_UNSUPPORTED: 'SECRET_SCHEMA_UNSUPPORTED',
  SECRET_SCHEMA_FUTURE: 'SECRET_SCHEMA_FUTURE_READ_ONLY',
  SECRET_FILE_CORRUPT: 'SECRET_FILE_CORRUPT',
  SECRET_STORAGE_UNAVAILABLE: 'SECRET_STORAGE_UNAVAILABLE',
  SECRET_ENCRYPT_FAILED: 'SECRET_ENCRYPT_FAILED',
  SECRET_DECRYPT_FAILED: 'SECRET_DECRYPT_FAILED',
  CREDENTIAL_MISSING: 'SECRET_CREDENTIAL_MISSING'
});

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FEATURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CREDENTIAL_STRING_PATTERN = /^\s*(?:authorization|proxy-authorization|x-api-key|api-key)\s*:/i;
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

class SettingsStoreError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SettingsStoreError';
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

function normalizeKeyForSecretCheck(key) {
  return String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
  const normalized = normalizeKeyForSecretCheck(key);
  if (!normalized) return false;
  if (normalized === 'secret' || normalized.endsWith('secret')) return true;
  if (normalized === 'token' || normalized.endsWith('token')) return true;
  if (normalized === 'cookie' || normalized.endsWith('cookie')) return true;
  return SECRET_KEY_TOKENS.some(token => normalized.includes(token));
}

function cloneJson(value, pathLabel = '$', state = { seen: new Set(), depth: 0 }, options = {}) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置字符串过长: ${pathLabel}`, { path: pathLabel });
    }
    if (options.allowSecrets !== true && CREDENTIAL_STRING_PATTERN.test(value)) {
      if (options.dropSecrets === true) {
        options.redactedPaths?.push(pathLabel);
        return undefined;
      }
      throw new SettingsStoreError(ERROR_CODES.SECRET_FIELD, `设置中包含凭据字符串: ${pathLabel}`, { path: pathLabel });
    }
    return value.normalize('NFC');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置数字无效: ${pathLabel}`, { path: pathLabel });
    }
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置值必须可序列化: ${pathLabel}`, { path: pathLabel });
  }
  if (state.seen.has(value)) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置对象包含循环引用: ${pathLabel}`, { path: pathLabel });
  }
  if (state.depth >= MAX_JSON_DEPTH) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置嵌套超过 ${MAX_JSON_DEPTH} 层: ${pathLabel}`, {
      path: pathLabel
    });
  }
  state.seen.add(value);
  const nextState = { seen: state.seen, depth: state.depth + 1 };
  let result;
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置数组过长: ${pathLabel}`, { path: pathLabel });
    }
    result = [];
    value.forEach((item, index) => {
      const copied = cloneJson(item, `${pathLabel}[${index}]`, nextState, options);
      if (copied !== undefined) result.push(copied);
    });
  } else {
    if (!isPlainObject(value)) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置值必须是普通对象: ${pathLabel}`, { path: pathLabel });
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_COLLECTION_ITEMS) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置对象字段过多: ${pathLabel}`, { path: pathLabel });
    }
    result = {};
    for (const key of keys.sort((left, right) => left.localeCompare(right, 'en'))) {
      const childPath = `${pathLabel}.${key}`;
      if (options.allowSecrets !== true && isSecretKey(key)) {
        if (options.dropSecrets === true) {
          options.redactedPaths?.push(childPath);
          continue;
        }
        throw new SettingsStoreError(ERROR_CODES.SECRET_FIELD, `设置中禁止出现凭据字段: ${childPath}`, {
          path: childPath
        });
      }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `设置字段名不安全: ${childPath}`, { path: childPath });
      }
      const copied = cloneJson(value[key], childPath, nextState, options);
      if (copied !== undefined) result[key.normalize('NFC')] = copied;
    }
  }
  state.seen.delete(value);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function immutableJson(value) {
  return deepFreeze(cloneJson(value, '$', undefined, { allowSecrets: true }));
}

function normalizeNonEmptyString(value, field, maximum = 256) {
  if (typeof value !== 'string') {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${field} 必须是字符串`, { path: `$.${field}` });
  }
  const normalized = value.trim().normalize('NFC');
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${field} 格式无效`, { path: `$.${field}` });
  }
  return normalized;
}

function normalizeProviderId(value) {
  const providerId = normalizeNonEmptyString(value, 'providerId', 128);
  if (!PROVIDER_ID_PATTERN.test(providerId) || ['constructor', 'prototype', '__proto__'].includes(providerId)) {
    throw new SettingsStoreError(ERROR_CODES.PROVIDER_ID_INVALID, 'providerId 格式无效', { providerId });
  }
  return providerId;
}

function normalizeProviderOrigin(value, options = {}) {
  const raw = normalizeNonEmptyString(value, 'providerOrigin', 2048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'providerOrigin 必须是有效 URL origin', {
      path: '$.providerOrigin'
    }, error);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'providerOrigin 只允许不含凭据的 HTTP(S) origin', {
      path: '$.providerOrigin'
    });
  }
  if (options.allowPath !== true && (parsed.pathname !== '/' || parsed.search || parsed.hash)) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'providerOrigin 不得包含路径、查询或片段', {
      path: '$.providerOrigin'
    });
  }
  return parsed.origin;
}

function normalizeStringIds(value, field) {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${field} 必须是有限长度数组`, { path: `$.${field}` });
  }
  const ids = value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${field}[${index}] 必须是字符串`, {
        path: `$.${field}[${index}]`
      });
    }
    const id = item.trim().normalize('NFC');
    if (!FEATURE_ID_PATTERN.test(id)) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${field}[${index}] 格式无效`, {
        path: `$.${field}[${index}]`
      });
    }
    return id;
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeFeatureToggles(value) {
  if (!isPlainObject(value)) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'featureToggles 必须是对象', {
      path: '$.featureToggles'
    });
  }
  const output = {};
  const keys = Object.keys(value);
  if (keys.length > 256) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'featureToggles 字段过多', { path: '$.featureToggles' });
  }
  for (const key of keys.sort((left, right) => left.localeCompare(right, 'en'))) {
    if (isSecretKey(key)) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_FIELD, `功能开关名疑似凭据字段: ${key}`, {
        path: `$.featureToggles.${key}`
      });
    }
    if (!FEATURE_ID_PATTERN.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) ||
        typeof value[key] !== 'boolean') {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `功能开关无效: ${key}`, {
        path: `$.featureToggles.${key}`
      });
    }
    output[key] = value[key];
  }
  return output;
}

function normalizeCustomSearchSources(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'customSearchSources 必须是最多 100 项的数组', { path: '$.customSearchSources' });
  }
  const ids = new Set();
  return value.map((source, index) => {
    const itemPath = `$.customSearchSources[${index}]`;
    if (!isPlainObject(source)) throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${itemPath} 必须是对象`, { path: itemPath });
    const keys = Object.keys(source).sort();
    const secretKey = keys.find(key => isSecretKey(key));
    if (secretKey) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_FIELD, `${itemPath} 禁止包含凭据字段: ${secretKey}`, {
        path: `${itemPath}.${secretKey}`
      });
    }
    if (keys.join(',') !== 'enabled,id,name,url') {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${itemPath} 字段无效`, { path: itemPath });
    }
    const id = normalizeNonEmptyString(source.id, 'customSearchSources.id', 80);
    if (!FEATURE_ID_PATTERN.test(id) || ids.has(id)) throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${itemPath}.id 无效或重复`, { path: `${itemPath}.id` });
    ids.add(id);
    const name = normalizeNonEmptyString(source.name, 'customSearchSources.name', 80);
    const rawUrl = normalizeNonEmptyString(source.url, 'customSearchSources.url', 2048);
    let parsed;
    try { parsed = new URL(rawUrl); } catch (error) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${itemPath}.url 无效`, { path: `${itemPath}.url` }, error);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${itemPath}.url 只允许不含凭据的 HTTPS URL`, { path: `${itemPath}.url` });
    }
    if (typeof source.enabled !== 'boolean') throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, `${itemPath}.enabled 必须是布尔值`, { path: `${itemPath}.enabled` });
    return { id, name, url: parsed.toString(), enabled: source.enabled };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function normalizeExportableSettings(value, options = {}) {
  if (!isPlainObject(value)) {
    throw new SettingsStoreError(ERROR_CODES.INPUT_INVALID, 'exportableSettings 必须是对象');
  }
  const mode = options.mode || 'strict';
  const allowed = new Set(EXPORTABLE_SETTINGS_FIELDS);
  if (mode === 'strict') {
    for (const key of Object.keys(value)) {
      if (isSecretKey(key)) {
        throw new SettingsStoreError(ERROR_CODES.SECRET_FIELD, `禁止导出凭据字段: ${key}`, { path: `$.${key}` });
      }
      if (!allowed.has(key)) {
        throw new SettingsStoreError(ERROR_CODES.FIELD_UNKNOWN, `不在设置导出白名单中的字段: ${key}`, {
          path: `$.${key}`
        });
      }
    }
  }

  const output = {};
  if (hasOwn(value, 'theme')) {
    const theme = normalizeNonEmptyString(value.theme, 'theme', 32).toLowerCase();
    if (!['light', 'dark', 'system'].includes(theme)) {
      throw new SettingsStoreError(ERROR_CODES.FIELD_INVALID, 'theme 只允许 light、dark 或 system', { path: '$.theme' });
    }
    output.theme = theme;
  }
  if (hasOwn(value, 'layout')) output.layout = cloneJson(value.layout, '$.layout', undefined, { dropSecrets: mode === 'filter' });
  if (hasOwn(value, 'shortcuts')) output.shortcuts = cloneJson(value.shortcuts, '$.shortcuts', undefined, { dropSecrets: mode === 'filter' });
  if (hasOwn(value, 'defaultReferenceStyle')) {
    output.defaultReferenceStyle = normalizeNonEmptyString(value.defaultReferenceStyle, 'defaultReferenceStyle', 64);
  }
  if (hasOwn(value, 'enabledSearchSourceIds')) {
    output.enabledSearchSourceIds = normalizeStringIds(value.enabledSearchSourceIds, 'enabledSearchSourceIds');
  }
  if (hasOwn(value, 'customSearchSources')) output.customSearchSources = normalizeCustomSearchSources(value.customSearchSources);
  if (hasOwn(value, 'providerId')) output.providerId = normalizeProviderId(value.providerId);
  if (hasOwn(value, 'providerOrigin')) output.providerOrigin = normalizeProviderOrigin(value.providerOrigin);
  if (hasOwn(value, 'model')) output.model = normalizeNonEmptyString(value.model, 'model', 256);
  if (hasOwn(value, 'featureToggles')) output.featureToggles = normalizeFeatureToggles(value.featureToggles);
  return output;
}

function sanitizeExportableSettings(value) {
  return immutableJson(normalizeExportableSettings(value, { mode: 'filter' }));
}

function validateExportableSettings(value) {
  return immutableJson(normalizeExportableSettings(value, { mode: 'strict' }));
}

function validateVersion(value, supported, codes, entity) {
  if (!Number.isInteger(value) || value < 1) {
    throw new SettingsStoreError(codes.invalid, `${entity} schemaVersion 无效`, { schemaVersion: value });
  }
  if (value > supported) {
    throw new SettingsStoreError(codes.future, `${entity} schemaVersion ${value} 高于当前支持版本 ${supported}`, {
      schemaVersion: value,
      supportedVersion: supported,
      readOnly: true
    });
  }
  if (value !== supported) {
    throw new SettingsStoreError(codes.unsupported, `${entity} schemaVersion ${value} 需要迁移`, {
      schemaVersion: value,
      supportedVersion: supported
    });
  }
}

function validateSettingsEnvelope(value) {
  if (!isPlainObject(value)) throw new SettingsStoreError(ERROR_CODES.SCHEMA_INVALID, '设置 envelope 必须是对象');
  validateVersion(value.schemaVersion, SETTINGS_SCHEMA_VERSION, {
    invalid: ERROR_CODES.SCHEMA_INVALID,
    unsupported: ERROR_CODES.SCHEMA_UNSUPPORTED,
    future: ERROR_CODES.SCHEMA_FUTURE
  }, '设置');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'exportableSettings' || keys[1] !== 'schemaVersion') {
    throw new SettingsStoreError(ERROR_CODES.SCHEMA_INVALID, '设置 envelope 字段不完整或包含未知字段');
  }
  return immutableJson({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    exportableSettings: validateExportableSettings(value.exportableSettings)
  });
}

function createSettingsEnvelope(settings) {
  return validateSettingsEnvelope({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    exportableSettings: settings
  });
}

function createBackupSettingsPayload(settings) {
  const exportableSettings = sanitizeExportableSettings(settings);
  return immutableJson({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    exportableSettings,
    credentialStatus: exportableSettings.providerId
      ? CREDENTIAL_STATUS.NEEDS_REENTRY
      : CREDENTIAL_STATUS.MISSING
  });
}

function validateBackupSettingsPayload(value) {
  if (!isPlainObject(value)) throw new SettingsStoreError(ERROR_CODES.BACKUP_INVALID, '备份设置必须是对象');
  const allowed = new Set(['schemaVersion', 'exportableSettings', 'credentialStatus']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SettingsStoreError(isSecretKey(key) ? ERROR_CODES.SECRET_FIELD : ERROR_CODES.BACKUP_INVALID,
        `备份设置包含禁止字段: ${key}`, { path: `$.${key}` });
    }
  }
  validateVersion(value.schemaVersion, SETTINGS_SCHEMA_VERSION, {
    invalid: ERROR_CODES.BACKUP_INVALID,
    unsupported: ERROR_CODES.SCHEMA_UNSUPPORTED,
    future: ERROR_CODES.SCHEMA_FUTURE
  }, '备份设置');
  const settings = validateExportableSettings(value.exportableSettings);
  const expectedStatus = settings.providerId ? CREDENTIAL_STATUS.NEEDS_REENTRY : CREDENTIAL_STATUS.MISSING;
  if (value.credentialStatus !== expectedStatus) {
    throw new SettingsStoreError(ERROR_CODES.BACKUP_INVALID, `备份 credentialStatus 必须为 ${expectedStatus}`, {
      credentialStatus: value.credentialStatus
    });
  }
  return immutableJson({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    exportableSettings: settings,
    credentialStatus: expectedStatus
  });
}

function readJsonFileSync(filePath, codes, entity) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new SettingsStoreError(codes.corrupt, `${entity}文件无法读取`, { filePath }, error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SettingsStoreError(ERROR_CODES.FILE_UNSAFE, `${entity}文件必须是普通文件且不能是符号链接`, { filePath });
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new SettingsStoreError(codes.corrupt, `${entity}文件不是有效 JSON`, { filePath }, error);
  }
}

function queueOperation(store, operation) {
  const pending = store._writeQueue.catch(() => undefined).then(operation);
  store._writeQueue = pending;
  return pending;
}

class SettingsStore {
  constructor(rootPath, options = {}) {
    if (typeof rootPath !== 'string' || !rootPath) {
      throw new SettingsStoreError(ERROR_CODES.INPUT_INVALID, 'SettingsStore 需要根目录');
    }
    this.rootPath = path.resolve(rootPath);
    this.relativePath = normalizeRelativePath(options.relativePath || DEFAULT_SETTINGS_RELATIVE_PATH);
    this.filePath = resolveContainedPath(this.rootPath, this.relativePath);
    this.writeJson = options.durableWriteJson || durableWriteJson;
    this._writeQueue = Promise.resolve();
    this._readOnly = false;
    this._futureEnvelope = null;
    this._cache = immutableJson({});
    this._loadSync();
  }

  _loadSync() {
    const raw = readJsonFileSync(this.filePath, { corrupt: ERROR_CODES.FILE_CORRUPT }, '设置');
    if (!raw) return;
    try {
      const envelope = validateSettingsEnvelope(raw);
      this._cache = envelope.exportableSettings;
    } catch (error) {
      if (error instanceof SettingsStoreError && error.code === ERROR_CODES.SCHEMA_FUTURE) {
        this._readOnly = true;
        this._futureEnvelope = immutableJson(raw);
        return;
      }
      if (error instanceof SettingsStoreError) throw error;
      throw new SettingsStoreError(ERROR_CODES.FILE_CORRUPT, '设置文件校验失败', { filePath: this.filePath }, error);
    }
  }

  get readOnly() {
    return this._readOnly;
  }

  readSync() {
    this._assertWritableSchemaForInterpretation();
    return immutableJson(this._cache);
  }

  readEnvelopeSync() {
    if (this._futureEnvelope) return immutableJson(this._futureEnvelope);
    return createSettingsEnvelope(this._cache);
  }

  _assertWritableSchemaForInterpretation() {
    if (this._readOnly) {
      throw new SettingsStoreError(ERROR_CODES.SCHEMA_FUTURE,
        '设置来自未来 schema，只允许读取原始 envelope 和导出诊断', { readOnly: true });
    }
  }

  _assertWritable() {
    if (this._readOnly) {
      throw new SettingsStoreError(ERROR_CODES.READ_ONLY, '未来 schema 设置禁止写入', { readOnly: true });
    }
  }

  replace(settings) {
    return queueOperation(this, async () => {
      this._assertWritable();
      const envelope = createSettingsEnvelope(settings);
      const acknowledgment = await this.writeJson(this.rootPath, this.relativePath, envelope, {
        label: 'exportable-settings'
      });
      this._cache = envelope.exportableSettings;
      return Object.freeze({ acknowledgment, settings: this.readSync() });
    });
  }

  update(patchOrUpdater) {
    return queueOperation(this, async () => {
      this._assertWritable();
      const current = this.readSync();
      let next;
      if (typeof patchOrUpdater === 'function') {
        next = patchOrUpdater(current);
      } else if (isPlainObject(patchOrUpdater)) {
        next = { ...current, ...patchOrUpdater };
      } else {
        throw new SettingsStoreError(ERROR_CODES.INPUT_INVALID, '设置更新必须是对象或 updater 函数');
      }
      const envelope = createSettingsEnvelope(next);
      const acknowledgment = await this.writeJson(this.rootPath, this.relativePath, envelope, {
        label: 'exportable-settings'
      });
      this._cache = envelope.exportableSettings;
      return Object.freeze({ acknowledgment, settings: this.readSync() });
    });
  }

  exportForBackup() {
    this._assertWritableSchemaForInterpretation();
    return createBackupSettingsPayload(this._cache);
  }

  importFromBackup(payload) {
    const validated = validateBackupSettingsPayload(payload);
    return this.replace(validated.exportableSettings).then(result => Object.freeze({
      ...result,
      credentialStatus: validated.credentialStatus
    }));
  }
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || !value || value.length > 128 * 1024 || !BASE64_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function validateSecretEnvelope(value) {
  if (!isPlainObject(value)) throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_INVALID, '密钥 envelope 必须是对象');
  validateVersion(value.schemaVersion, SECRET_SCHEMA_VERSION, {
    invalid: ERROR_CODES.SECRET_SCHEMA_INVALID,
    unsupported: ERROR_CODES.SECRET_SCHEMA_UNSUPPORTED,
    future: ERROR_CODES.SECRET_SCHEMA_FUTURE
  }, '密钥');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'credentials' || keys[1] !== 'schemaVersion') {
    throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_INVALID, '密钥 envelope 字段不完整或包含未知字段');
  }
  if (!isPlainObject(value.credentials) || Object.keys(value.credentials).length > 100) {
    throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_INVALID, 'credentials 必须是有限长度对象');
  }
  const credentials = {};
  for (const providerId of Object.keys(value.credentials).sort((left, right) => left.localeCompare(right, 'en'))) {
    normalizeProviderId(providerId);
    const record = value.credentials[providerId];
    if (!isPlainObject(record)) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_INVALID, `密钥记录无效: ${providerId}`);
    }
    const recordKeys = Object.keys(record).sort();
    const expected = ['encoding', 'encryptedBase64', 'providerId', 'schemaVersion', 'storage'];
    if (recordKeys.length !== expected.length || recordKeys.some((key, index) => key !== expected[index])) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_INVALID, `密钥记录字段无效: ${providerId}`);
    }
    if (record.schemaVersion !== SECRET_SCHEMA_VERSION || record.providerId !== providerId ||
        record.storage !== 'electron.safeStorage' || record.encoding !== 'base64' ||
        !isCanonicalBase64(record.encryptedBase64)) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_INVALID, `密钥记录内容无效: ${providerId}`);
    }
    credentials[providerId] = {
      schemaVersion: SECRET_SCHEMA_VERSION,
      providerId,
      storage: 'electron.safeStorage',
      encoding: 'base64',
      encryptedBase64: record.encryptedBase64
    };
  }
  return immutableJson({ schemaVersion: SECRET_SCHEMA_VERSION, credentials });
}

function assertSafeStorageAdapter(adapter) {
  if (!adapter || typeof adapter.isEncryptionAvailable !== 'function' ||
      typeof adapter.encryptString !== 'function' || typeof adapter.decryptString !== 'function') {
    throw new SettingsStoreError(ERROR_CODES.SECRET_INPUT_INVALID,
      'SecretStore 需要 Electron safeStorage 适配器');
  }
}

class SecretStore {
  constructor(rootPath, safeStorageAdapter, options = {}) {
    if (typeof rootPath !== 'string' || !rootPath) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_INPUT_INVALID, 'SecretStore 需要独立密钥根目录');
    }
    assertSafeStorageAdapter(safeStorageAdapter);
    this.rootPath = path.resolve(rootPath);
    this.relativePath = normalizeRelativePath(options.relativePath || DEFAULT_SECRET_RELATIVE_PATH);
    this.filePath = resolveContainedPath(this.rootPath, this.relativePath);
    this.safeStorage = safeStorageAdapter;
    this.writeJson = options.durableWriteJson || durableWriteJson;
    this._writeQueue = Promise.resolve();
    this._readOnly = false;
    this._futureEnvelope = null;
    this._cache = immutableJson({ schemaVersion: SECRET_SCHEMA_VERSION, credentials: {} });
    this._needsReentry = new Set(options.needsReentryProviderIds || []);
    this._loadSync();
  }

  _loadSync() {
    const raw = readJsonFileSync(this.filePath, { corrupt: ERROR_CODES.SECRET_FILE_CORRUPT }, '密钥');
    if (!raw) return;
    try {
      this._cache = validateSecretEnvelope(raw);
    } catch (error) {
      if (error instanceof SettingsStoreError && error.code === ERROR_CODES.SECRET_SCHEMA_FUTURE) {
        this._readOnly = true;
        this._futureEnvelope = immutableJson(raw);
        return;
      }
      if (error instanceof SettingsStoreError) throw error;
      throw new SettingsStoreError(ERROR_CODES.SECRET_FILE_CORRUPT, '密钥文件校验失败', {
        filePath: this.filePath
      }, error);
    }
  }

  get readOnly() {
    return this._readOnly;
  }

  readEnvelopeSync() {
    return immutableJson(this._futureEnvelope || this._cache);
  }

  _assertWritable() {
    if (this._readOnly) {
      throw new SettingsStoreError(ERROR_CODES.READ_ONLY, '未来 schema 密钥文件禁止写入', { readOnly: true });
    }
  }

  _encryptionAvailable() {
    try {
      return this.safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  markNeedsReentry(providerId) {
    this._needsReentry.add(normalizeProviderId(providerId));
  }

  credentialStatus(providerId, options = {}) {
    const id = normalizeProviderId(providerId);
    if (this._readOnly || this._needsReentry.has(id)) return CREDENTIAL_STATUS.NEEDS_REENTRY;
    const record = this._cache.credentials[id];
    if (!record) return options.required === true ? CREDENTIAL_STATUS.NEEDS_REENTRY : CREDENTIAL_STATUS.MISSING;
    if (!this._encryptionAvailable()) return CREDENTIAL_STATUS.NEEDS_REENTRY;
    try {
      const plainText = this.safeStorage.decryptString(Buffer.from(record.encryptedBase64, 'base64'));
      return typeof plainText === 'string' && plainText.length > 0
        ? CREDENTIAL_STATUS.CONFIGURED
        : CREDENTIAL_STATUS.NEEDS_REENTRY;
    } catch {
      return CREDENTIAL_STATUS.NEEDS_REENTRY;
    }
  }

  setCredential(providerId, plainText) {
    const id = normalizeProviderId(providerId);
    if (typeof plainText !== 'string' || !plainText || plainText.length > 64 * 1024 || plainText.includes('\0')) {
      return Promise.reject(new SettingsStoreError(ERROR_CODES.SECRET_INPUT_INVALID, '凭据必须是非空字符串'));
    }
    return queueOperation(this, async () => {
      this._assertWritable();
      if (!this._encryptionAvailable()) {
        this._needsReentry.add(id);
        throw new SettingsStoreError(ERROR_CODES.SECRET_STORAGE_UNAVAILABLE,
          '系统安全存储不可用，拒绝将凭据明文写入磁盘');
      }
      let encrypted;
      try {
        encrypted = this.safeStorage.encryptString(plainText);
      } catch (error) {
        this._needsReentry.add(id);
        throw new SettingsStoreError(ERROR_CODES.SECRET_ENCRYPT_FAILED, '凭据加密失败', { providerId: id }, error);
      }
      if (!(Buffer.isBuffer(encrypted) || encrypted instanceof Uint8Array) || encrypted.byteLength === 0) {
        this._needsReentry.add(id);
        throw new SettingsStoreError(ERROR_CODES.SECRET_ENCRYPT_FAILED, 'safeStorage 未返回有效二进制密文', {
          providerId: id
        });
      }
      const encryptedBuffer = Buffer.from(encrypted);
      if (encryptedBuffer.equals(Buffer.from(plainText, 'utf8'))) {
        this._needsReentry.add(id);
        throw new SettingsStoreError(ERROR_CODES.SECRET_ENCRYPT_FAILED, 'safeStorage 返回了未加密明文', {
          providerId: id
        });
      }
      const credentials = { ...this._cache.credentials, [id]: {
        schemaVersion: SECRET_SCHEMA_VERSION,
        providerId: id,
        storage: 'electron.safeStorage',
        encoding: 'base64',
        encryptedBase64: encryptedBuffer.toString('base64')
      } };
      const envelope = validateSecretEnvelope({ schemaVersion: SECRET_SCHEMA_VERSION, credentials });
      const acknowledgment = await this.writeJson(this.rootPath, this.relativePath, envelope, {
        label: 'provider-credentials'
      });
      this._cache = envelope;
      this._needsReentry.delete(id);
      return Object.freeze({ acknowledgment, credentialStatus: CREDENTIAL_STATUS.CONFIGURED });
    });
  }

  getCredential(providerId) {
    const id = normalizeProviderId(providerId);
    if (this._readOnly) {
      throw new SettingsStoreError(ERROR_CODES.SECRET_SCHEMA_FUTURE, '未来 schema 密钥不可解密', {
        readOnly: true,
        providerId: id
      });
    }
    const record = this._cache.credentials[id];
    if (!record) {
      throw new SettingsStoreError(ERROR_CODES.CREDENTIAL_MISSING, '凭据不存在', { providerId: id });
    }
    if (!this._encryptionAvailable()) {
      this._needsReentry.add(id);
      throw new SettingsStoreError(ERROR_CODES.SECRET_STORAGE_UNAVAILABLE, '系统安全存储不可用', { providerId: id });
    }
    try {
      const plainText = this.safeStorage.decryptString(Buffer.from(record.encryptedBase64, 'base64'));
      if (typeof plainText !== 'string' || !plainText) throw new Error('safeStorage returned an empty credential');
      return plainText;
    } catch (error) {
      this._needsReentry.add(id);
      throw new SettingsStoreError(ERROR_CODES.SECRET_DECRYPT_FAILED, '凭据无法解密，需要重新输入', {
        providerId: id
      }, error);
    }
  }

  removeCredential(providerId, options = {}) {
    const id = normalizeProviderId(providerId);
    return queueOperation(this, async () => {
      this._assertWritable();
      const credentials = { ...this._cache.credentials };
      delete credentials[id];
      const envelope = validateSecretEnvelope({ schemaVersion: SECRET_SCHEMA_VERSION, credentials });
      const acknowledgment = await this.writeJson(this.rootPath, this.relativePath, envelope, {
        label: 'provider-credentials'
      });
      this._cache = envelope;
      if (options.needsReentry === true) this._needsReentry.add(id);
      else this._needsReentry.delete(id);
      return Object.freeze({
        acknowledgment,
        credentialStatus: options.needsReentry === true
          ? CREDENTIAL_STATUS.NEEDS_REENTRY
          : CREDENTIAL_STATUS.MISSING
      });
    });
  }
}

function parseLegacyJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function legacyAccessor(legacy) {
  if (!legacy || (typeof legacy !== 'object' && typeof legacy !== 'function')) {
    throw new SettingsStoreError(ERROR_CODES.INPUT_INVALID, 'legacy 设置必须是对象或 Storage');
  }
  if (typeof legacy.getItem === 'function') return key => legacy.getItem(key);
  return key => hasOwn(legacy, key) ? legacy[key] : null;
}

function redactSecrets(value, options = {}) {
  const redactedPaths = [];
  const redacted = cloneJson(value, '$', undefined, { dropSecrets: true, redactedPaths });
  return immutableJson({ value: redacted, redactedPaths: [...new Set(redactedPaths)].sort() });
}

function deliverLegacyCredential(secretSink, input) {
  if (typeof secretSink !== 'function' || typeof input.value !== 'string' || !input.value) return false;
  secretSink(Object.freeze({
    providerId: input.providerId,
    scope: input.scope,
    kind: input.kind,
    value: input.value
  }));
  return true;
}

function splitLegacySettings(legacy, options = {}) {
  const get = legacyAccessor(legacy);
  const settings = {};
  const redactedPaths = [];
  let deliveredSecretCount = 0;
  let discardedCiphertextCount = 0;

  const theme = get('essay_theme');
  if (typeof theme === 'string' && ['light', 'dark', 'system'].includes(theme.toLowerCase())) {
    settings.theme = theme.toLowerCase();
  }

  const horizontal = parseLegacyJson(get('essay_horizontal_flex'));
  const vertical = parseLegacyJson(get('essay_vertical_flex'));
  const layout = {};
  if (isPlainObject(horizontal)) layout.horizontal = redactSecrets(horizontal).value;
  if (isPlainObject(vertical)) layout.vertical = redactSecrets(vertical).value;
  if (Object.keys(layout).length) settings.layout = layout;

  const shortcuts = parseLegacyJson(get('essay_shortcuts'));
  if (Array.isArray(shortcuts) || isPlainObject(shortcuts)) settings.shortcuts = redactSecrets(shortcuts).value;

  const referenceStyle = get('essay_default_reference_style');
  if (typeof referenceStyle === 'string' && referenceStyle.trim()) settings.defaultReferenceStyle = referenceStyle;

  const sources = parseLegacyJson(get('essay_search_sources'));
  if (Array.isArray(sources)) {
    settings.enabledSearchSourceIds = sources
      .filter(source => isPlainObject(source) && source.enabled !== false && typeof source.id === 'string')
      .map(source => source.id);
    const customSources = sources.filter(source => isPlainObject(source) && source.type === 'custom')
      .map(source => ({ id: source.id, name: source.name, url: source.url, enabled: source.enabled !== false }));
    if (customSources.length) {
      try { settings.customSearchSources = normalizeCustomSearchSources(customSources); } catch (_) {}
    }
    sources.forEach((source, index) => {
      if (!isPlainObject(source)) return;
      for (const [key, value] of Object.entries(source)) {
        if (!isSecretKey(key)) continue;
        redactedPaths.push(`$.essay_search_sources[${index}].${key}`);
        if (typeof value === 'string' && value) {
          const providerId = typeof source.id === 'string' && FEATURE_ID_PATTERN.test(source.id)
            ? `search-source:${source.id}`
            : `search-source:legacy-${index}`;
          if (deliverLegacyCredential(options.secretSink, {
            providerId,
            scope: 'search-source',
            kind: 'api-key',
            value
          })) deliveredSecretCount += 1;
        }
      }
    });
  }

  const aiConfig = parseLegacyJson(get('essay_ai_config'));
  if (isPlainObject(aiConfig)) {
    const providerId = typeof aiConfig.provider === 'string' && PROVIDER_ID_PATTERN.test(aiConfig.provider)
      ? aiConfig.provider
      : 'custom';
    settings.providerId = providerId;
    const originValue = aiConfig.origin || aiConfig.base_url || aiConfig.baseUrl;
    if (typeof originValue === 'string' && originValue.trim()) {
      try {
        settings.providerOrigin = normalizeProviderOrigin(originValue, { allowPath: true });
      } catch {
        // Invalid legacy origins are omitted instead of weakening the new origin-only schema.
      }
    }
    if (typeof aiConfig.model === 'string' && aiConfig.model.trim()) settings.model = aiConfig.model;

    const encrypted = aiConfig.encryption === 'encrypted' || aiConfig.encrypted === true;
    for (const [key, value] of Object.entries(aiConfig)) {
      if (!isSecretKey(key)) continue;
      redactedPaths.push(`$.essay_ai_config.${key}`);
      if (typeof value !== 'string' || !value) continue;
      if (encrypted || normalizeKeyForSecretCheck(key).includes('ciphertext') ||
          normalizeKeyForSecretCheck(key).includes('safestorage')) {
        discardedCiphertextCount += 1;
        continue;
      }
      if (deliverLegacyCredential(options.secretSink, {
        providerId,
        scope: 'ai-provider',
        kind: normalizeKeyForSecretCheck(key).includes('authorization') ? 'authorization' : 'api-key',
        value
      })) deliveredSecretCount += 1;
    }
  }

  const toggleMap = {
    aiSearch: 'essay_ai_search_enabled',
    aiLiterature: 'essay_ai_literature_enabled',
    aiVerify: 'essay_ai_verify_enabled',
    toolbarAutoClose: 'essay_toolbar_autoclose'
  };
  const toggles = {};
  for (const [target, source] of Object.entries(toggleMap)) {
    const raw = get(source);
    if (raw === 'true' || raw === true) toggles[target] = true;
    else if (raw === 'false' || raw === false) toggles[target] = false;
  }
  if (Object.keys(toggles).length) settings.featureToggles = toggles;

  const exportableSettings = sanitizeExportableSettings(settings);
  return immutableJson({
    exportableSettings,
    credentialStatus: exportableSettings.providerId
      ? CREDENTIAL_STATUS.NEEDS_REENTRY
      : CREDENTIAL_STATUS.MISSING,
    redactedPaths: [...new Set(redactedPaths)].sort(),
    deliveredSecretCount,
    discardedCiphertextCount
  });
}

module.exports = {
  CREDENTIAL_STATUS,
  DEFAULT_SECRET_RELATIVE_PATH,
  DEFAULT_SETTINGS_RELATIVE_PATH,
  ERROR_CODES,
  EXPORTABLE_SETTINGS_FIELDS,
  SECRET_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  SecretStore,
  SettingsStore,
  SettingsStoreError,
  createBackupSettingsPayload,
  createSettingsEnvelope,
  isSecretKey,
  normalizeExportableSettings,
  normalizeProviderOrigin,
  redactSecrets,
  sanitizeExportableSettings,
  splitLegacySettings,
  validateBackupSettingsPayload,
  validateExportableSettings,
  validateSecretEnvelope,
  validateSettingsEnvelope
};
