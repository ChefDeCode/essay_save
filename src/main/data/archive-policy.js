'use strict';

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

const ARCHIVE_LIMITS = Object.freeze({
  MAX_FILE_COUNT: 20_000,
  MAX_FILE_UNCOMPRESSED_BYTES: 500 * MEBIBYTE,
  MAX_EXPANDED_BYTES: 5 * GIBIBYTE,
  MAX_COMPRESSION_RATIO: 200,
  MAX_RELATIVE_PATH_LENGTH: 240,
  MAX_PATH_DEPTH: 20,
  IMPORT_DISK_MULTIPLIER: 2
});

const DEFAULT_CRITICAL_ENTRIES = Object.freeze(['manifest.json']);

const ARCHIVE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'ARCHIVE_INPUT_INVALID',
  ENTRY_NAME_INVALID: 'ARCHIVE_ENTRY_NAME_INVALID',
  PATH_NUL: 'ARCHIVE_PATH_NUL',
  PATH_ABSOLUTE: 'ARCHIVE_PATH_ABSOLUTE',
  PATH_TRAVERSAL: 'ARCHIVE_PATH_TRAVERSAL',
  PATH_INVALID_SEGMENT: 'ARCHIVE_PATH_INVALID_SEGMENT',
  PATH_TOO_LONG: 'ARCHIVE_PATH_TOO_LONG',
  PATH_TOO_DEEP: 'ARCHIVE_PATH_TOO_DEEP',
  DUPLICATE_PATH: 'ARCHIVE_DUPLICATE_PATH',
  LINK_ENTRY: 'ARCHIVE_LINK_ENTRY',
  ENTRY_TYPE_UNSUPPORTED: 'ARCHIVE_ENTRY_TYPE_UNSUPPORTED',
  ENTRY_SIZE_INVALID: 'ARCHIVE_ENTRY_SIZE_INVALID',
  DIRECTORY_SIZE_INVALID: 'ARCHIVE_DIRECTORY_SIZE_INVALID',
  FILE_COUNT_EXCEEDED: 'ARCHIVE_FILE_COUNT_EXCEEDED',
  FILE_SIZE_EXCEEDED: 'ARCHIVE_FILE_SIZE_EXCEEDED',
  EXPANDED_SIZE_EXCEEDED: 'ARCHIVE_EXPANDED_SIZE_EXCEEDED',
  COMPRESSION_RATIO_EXCEEDED: 'ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
  CRITICAL_ENTRY_MISSING: 'ARCHIVE_CRITICAL_ENTRY_MISSING',
  MANIFEST_INVALID: 'ARCHIVE_MANIFEST_INVALID',
  DISK_SPACE_INVALID: 'ARCHIVE_DISK_SPACE_INVALID',
  DISK_SPACE_INSUFFICIENT: 'ARCHIVE_DISK_SPACE_INSUFFICIENT',
  CANCELLATION_INVALID: 'ARCHIVE_CANCELLATION_INVALID'
});

class ArchivePolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArchivePolicyError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ArchivePolicyError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, 'Archive entry name must be a non-empty string');
  }
  if (value.includes('\0')) {
    fail(ARCHIVE_ERROR_CODES.PATH_NUL, 'Archive entry path contains a NUL byte', { path: value });
  }

  const slashPath = value.normalize('NFC').replace(/\\/g, '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath)) {
    fail(ARCHIVE_ERROR_CODES.PATH_ABSOLUTE, 'Archive entry path must be relative', { path: value });
  }

  const rawSegments = slashPath.split('/');
  if (rawSegments.includes('..')) {
    fail(ARCHIVE_ERROR_CODES.PATH_TRAVERSAL, 'Archive entry path contains traversal', { path: value });
  }

  const segments = rawSegments.filter(segment => segment && segment !== '.');
  if (!segments.length) {
    fail(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, 'Archive entry path resolves to an empty path', { path: value });
  }

  const invalidWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  for (const segment of segments) {
    if (/[-<>:"|?*]/.test(segment) || /[ .]$/.test(segment) || invalidWindowsName.test(segment)) {
      fail(ARCHIVE_ERROR_CODES.PATH_INVALID_SEGMENT, 'Archive entry path is not safe on Windows', {
        path: value,
        segment
      });
    }
  }

  const normalizedPath = segments.join('/');
  if (normalizedPath.length > ARCHIVE_LIMITS.MAX_RELATIVE_PATH_LENGTH) {
    fail(ARCHIVE_ERROR_CODES.PATH_TOO_LONG, 'Archive entry path exceeds the configured length limit', {
      path: normalizedPath,
      actual: normalizedPath.length,
      maximum: ARCHIVE_LIMITS.MAX_RELATIVE_PATH_LENGTH
    });
  }
  if (segments.length > ARCHIVE_LIMITS.MAX_PATH_DEPTH) {
    fail(ARCHIVE_ERROR_CODES.PATH_TOO_DEEP, 'Archive entry path exceeds the configured depth limit', {
      path: normalizedPath,
      actual: segments.length,
      maximum: ARCHIVE_LIMITS.MAX_PATH_DEPTH
    });
  }
  return normalizedPath;
}

function canonicalPathKey(normalizedPath) {
  return normalizedPath.normalize('NFC').toLowerCase();
}

function readEntryName(entry) {
  if (!isPlainObject(entry)) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, 'Each archive entry must be an object');
  }
  const candidates = [entry.fileName, entry.path, entry.name].filter(value => value !== undefined);
  if (candidates.length !== 1 || typeof candidates[0] !== 'string') {
    fail(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, 'Archive entry must have exactly one string path field');
  }
  return candidates[0];
}

function normalizedEntryType(entry) {
  const declared = entry.entryType === undefined ? entry.type : entry.entryType;
  if (declared === undefined || declared === null || declared === '') return null;
  if (typeof declared !== 'string') {
    fail(ARCHIVE_ERROR_CODES.ENTRY_TYPE_UNSUPPORTED, 'Archive entry type must be a string');
  }
  return declared.toLowerCase().replace(/[ _]/g, '-');
}

function unixMode(entry) {
  if (Number.isInteger(entry.mode) && entry.mode >= 0) return entry.mode;
  if (!Number.isInteger(entry.externalFileAttributes)) return null;
  const hostSystem = Number.isInteger(entry.versionMadeBy) ? (entry.versionMadeBy >>> 8) & 0xff : null;
  return hostSystem === 3 ? (entry.externalFileAttributes >>> 16) & 0xffff : null;
}

function hasWindowsReparseAttribute(entry) {
  let attributes = null;
  if (Number.isInteger(entry.dosAttributes)) {
    attributes = entry.dosAttributes;
  } else if (Number.isInteger(entry.externalFileAttributes)) {
    const hostSystem = Number.isInteger(entry.versionMadeBy) ? (entry.versionMadeBy >>> 8) & 0xff : null;
    if (hostSystem === 0 || hostSystem === 10) attributes = entry.externalFileAttributes & 0xffff;
  }
  return attributes !== null && ((attributes >>> 0) & 0x400) !== 0;
}

function classifyEntry(entry, rawPath) {
  const type = normalizedEntryType(entry);
  const linkTypes = new Set(['link', 'symlink', 'symbolic-link', 'junction', 'reparse-point']);
  const explicitLink = entry.isLink === true || entry.isSymlink === true ||
    entry.isSymbolicLink === true || entry.isJunction === true || entry.isReparsePoint === true;
  const mode = unixMode(entry);
  const fileType = mode === null ? 0 : mode & 0xf000;
  if (explicitLink || linkTypes.has(type) || fileType === 0xa000 || hasWindowsReparseAttribute(entry)) {
    fail(ARCHIVE_ERROR_CODES.LINK_ENTRY, 'Archive cannot contain symbolic links or junctions', {
      path: rawPath
    });
  }

  const supportedTypes = new Set([null, 'file', 'regular', 'regular-file', 'directory', 'dir']);
  if (!supportedTypes.has(type) || (fileType !== 0 && fileType !== 0x4000 && fileType !== 0x8000)) {
    fail(ARCHIVE_ERROR_CODES.ENTRY_TYPE_UNSUPPORTED, 'Archive entry is not a regular file or directory', {
      path: rawPath,
      type: type || fileType
    });
  }

  return entry.isDirectory === true || type === 'directory' || type === 'dir' ||
    rawPath.replace(/\\/g, '/').endsWith('/') || fileType === 0x4000;
}

function readSize(entry, field) {
  const value = entry[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(ARCHIVE_ERROR_CODES.ENTRY_SIZE_INVALID, `Archive entry ${field} must be a non-negative safe integer`, {
      field,
      value
    });
  }
  return value;
}

function validateCriticalEntries(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, 'At least one critical archive entry is required');
  }
  const entries = value.map(normalizeArchivePath);
  return [...new Set(entries.map(canonicalPathKey))].sort(compareText);
}

function validateArchiveEntries(entries, options = {}) {
  if (!Array.isArray(entries)) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, 'Archive entries must be an array');
  }
  if (!isPlainObject(options)) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, 'Archive validation options must be an object');
  }

  const criticalEntries = validateCriticalEntries(options.criticalEntries || DEFAULT_CRITICAL_ENTRIES);
  if (entries.length > ARCHIVE_LIMITS.MAX_FILE_COUNT) {
    fail(ARCHIVE_ERROR_CODES.FILE_COUNT_EXCEEDED, 'Archive contains too many entries', {
      actual: entries.length,
      maximum: ARCHIVE_LIMITS.MAX_FILE_COUNT
    });
  }

  const records = [];
  let fileCount = 0;
  let directoryCount = 0;
  let expandedBytes = 0;
  let compressedBytes = 0;
  let maximumObservedCompressionRatio = 0;

  for (const entry of entries) {
    const rawPath = readEntryName(entry);
    const normalizedPath = normalizeArchivePath(rawPath);
    const isDirectory = classifyEntry(entry, rawPath);
    const uncompressedSize = readSize(entry, 'uncompressedSize');
    const compressedSize = readSize(entry, 'compressedSize');

    if (isDirectory) {
      if (uncompressedSize !== 0 || compressedSize !== 0) {
        fail(ARCHIVE_ERROR_CODES.DIRECTORY_SIZE_INVALID, 'Archive directory entries must have zero sizes', {
          path: normalizedPath,
          uncompressedSize,
          compressedSize
        });
      }
      directoryCount += 1;
    } else {
      fileCount += 1;
      if (uncompressedSize > ARCHIVE_LIMITS.MAX_FILE_UNCOMPRESSED_BYTES) {
        fail(ARCHIVE_ERROR_CODES.FILE_SIZE_EXCEEDED, 'Archive entry exceeds the uncompressed file size limit', {
          path: normalizedPath,
          actual: uncompressedSize,
          maximum: ARCHIVE_LIMITS.MAX_FILE_UNCOMPRESSED_BYTES
        });
      }
      if (uncompressedSize > 0 && (compressedSize === 0 ||
          BigInt(uncompressedSize) > BigInt(compressedSize) * BigInt(ARCHIVE_LIMITS.MAX_COMPRESSION_RATIO))) {
        fail(ARCHIVE_ERROR_CODES.COMPRESSION_RATIO_EXCEEDED, 'Archive entry exceeds the compression ratio limit', {
          path: normalizedPath,
          uncompressedSize,
          compressedSize,
          maximum: ARCHIVE_LIMITS.MAX_COMPRESSION_RATIO
        });
      }
      const ratio = uncompressedSize === 0 ? 0 : uncompressedSize / compressedSize;
      maximumObservedCompressionRatio = Math.max(maximumObservedCompressionRatio, ratio);
      expandedBytes += uncompressedSize;
      compressedBytes += compressedSize;
      if (!Number.isSafeInteger(compressedBytes)) {
        fail(ARCHIVE_ERROR_CODES.ENTRY_SIZE_INVALID, 'Archive compressed byte total exceeds the safe integer range');
      }
      if (expandedBytes > ARCHIVE_LIMITS.MAX_EXPANDED_BYTES) {
        fail(ARCHIVE_ERROR_CODES.EXPANDED_SIZE_EXCEEDED, 'Archive exceeds the total expanded size limit', {
          actual: expandedBytes,
          maximum: ARCHIVE_LIMITS.MAX_EXPANDED_BYTES
        });
      }
    }

    records.push({
      normalizedPath,
      key: canonicalPathKey(normalizedPath),
      isDirectory,
      uncompressedSize,
      compressedSize
    });
  }

  records.sort((left, right) => compareText(left.key, right.key) ||
    compareText(left.normalizedPath, right.normalizedPath));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].key === records[index].key) {
      fail(ARCHIVE_ERROR_CODES.DUPLICATE_PATH, 'Archive contains duplicate normalized paths', {
        path: records[index].normalizedPath
      });
    }
  }

  const fileKeys = new Set(records.filter(record => !record.isDirectory).map(record => record.key));
  for (const record of records) {
    const segments = record.key.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join('/');
      if (fileKeys.has(parent)) {
        fail(ARCHIVE_ERROR_CODES.DUPLICATE_PATH, 'Archive path collides with a parent file', {
          path: record.normalizedPath,
          parent
        });
      }
    }
  }

  const presentFiles = new Set(records.filter(record => !record.isDirectory).map(record => record.key));
  const missingCriticalEntries = criticalEntries.filter(entry => !presentFiles.has(entry));
  if (missingCriticalEntries.length) {
    fail(ARCHIVE_ERROR_CODES.CRITICAL_ENTRY_MISSING, 'Archive is missing critical entries', {
      missing: missingCriticalEntries
    });
  }

  return Object.freeze({
    entryCount: records.length,
    fileCount,
    directoryCount,
    expandedBytes,
    compressedBytes,
    maximumObservedCompressionRatio,
    normalizedPaths: Object.freeze(records.map(record => record.normalizedPath))
  });
}

function countFromManifest(manifest, label, declaredValues, collections) {
  const values = declaredValues.filter(value => value !== undefined);
  for (const collection of collections) {
    if (collection !== undefined) {
      if (!Array.isArray(collection)) {
        fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, `Manifest ${label} collection must be an array`);
      }
      values.push(collection.length);
    }
  }
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, `Manifest ${label} count must be a non-negative integer`, {
        value
      });
    }
  }
  if (new Set(values).size > 1) {
    fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, `Manifest ${label} counts do not agree`, { values });
  }
  return values[0] || 0;
}

function summarizeManifest(manifest) {
  if (!isPlainObject(manifest)) {
    fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, 'Archive manifest must be an object');
  }
  const versions = [manifest.packageVersion, manifest.productVersion]
    .filter(value => value !== undefined);
  if (!versions.length || versions.some(value => typeof value !== 'string' || !value.trim())) {
    fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, 'Manifest packageVersion must be a non-empty string');
  }
  const normalizedVersions = versions.map(value => value.trim().normalize('NFC'));
  if (new Set(normalizedVersions).size !== 1) {
    fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, 'Manifest package versions do not agree');
  }
  const counts = isPlainObject(manifest.counts) ? manifest.counts : {};
  if (manifest.counts !== undefined && !isPlainObject(manifest.counts)) {
    fail(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, 'Manifest counts must be an object');
  }
  return Object.freeze({
    packageVersion: normalizedVersions[0],
    projectCount: countFromManifest(manifest, 'project', [
      manifest.projectCount,
      counts.projects,
      counts.projectCount
    ], [manifest.projects]),
    libraryCount: countFromManifest(manifest, 'library', [
      manifest.libraryCount,
      counts.library,
      counts.libraryItems,
      counts.libraryCount
    ], [manifest.libraryItems, Array.isArray(manifest.library) ? manifest.library : manifest.library?.items]),
    resourceCount: countFromManifest(manifest, 'resource', [
      manifest.resourceCount,
      counts.resources,
      counts.assets,
      counts.resourceCount
    ], [manifest.resources, manifest.assets])
  });
}

function stableClone(value, location = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value === 'string' ? value.normalize('NFC') : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, `${location} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, `${location} must contain JSON-compatible values`);
  }
  if (seen.has(value)) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, `${location} contains a cycle`);
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => stableClone(item, `${location}[${index}]`, seen));
  } else if (isPlainObject(value)) {
    result = {};
    for (const key of Object.keys(value).sort(compareText)) {
      Object.defineProperty(result, key, {
        value: stableClone(value[key], `${location}.${key}`, seen),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  } else {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, `${location} must contain plain objects`);
  }
  seen.delete(value);
  return result;
}

function normalizeSummaryList(value, label) {
  if (!Array.isArray(value)) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, `${label} must be an array`);
  }
  const unique = new Map();
  value.forEach((item, index) => {
    if ((typeof item !== 'string' || !item.trim()) && !isPlainObject(item)) {
      fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, `${label}[${index}] must be a non-empty ID or a plain object`);
    }
    const clone = stableClone(item, `${label}[${index}]`);
    const serialized = JSON.stringify(clone);
    unique.set(serialized, clone);
  });
  return Object.freeze([...unique.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(entry => Object.freeze(entry[1])));
}

function estimateImportDiskBytes(expandedBytes) {
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes < 0 ||
      expandedBytes > ARCHIVE_LIMITS.MAX_EXPANDED_BYTES) {
    fail(ARCHIVE_ERROR_CODES.DISK_SPACE_INVALID, 'Expanded bytes are invalid for disk estimation', {
      expandedBytes
    });
  }
  return expandedBytes * ARCHIVE_LIMITS.IMPORT_DISK_MULTIPLIER;
}

function validateAvailableDiskBytes(availableDiskBytes, estimatedDiskBytes) {
  if (!Number.isSafeInteger(availableDiskBytes) || availableDiskBytes < 0) {
    fail(ARCHIVE_ERROR_CODES.DISK_SPACE_INVALID, 'Available disk bytes must be a non-negative safe integer', {
      availableDiskBytes
    });
  }
  if (availableDiskBytes < estimatedDiskBytes) {
    fail(ARCHIVE_ERROR_CODES.DISK_SPACE_INSUFFICIENT, 'Available disk space is below the preflight estimate', {
      availableDiskBytes,
      estimatedDiskBytes,
      shortfallBytes: estimatedDiskBytes - availableDiskBytes
    });
  }
  return availableDiskBytes;
}

function cancelImportPreflight(preflight, reason = 'user') {
  if (!isPlainObject(preflight) || preflight.schemaVersion !== 1 || preflight.phase !== 'preflight' ||
      !['ready', 'canceled'].includes(preflight.status)) {
    fail(ARCHIVE_ERROR_CODES.CANCELLATION_INVALID, 'Only a valid pre-commit summary can be canceled');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    fail(ARCHIVE_ERROR_CODES.CANCELLATION_INVALID, 'Cancellation reason must be a non-empty string');
  }
  if (preflight.status === 'canceled') return preflight;
  return Object.freeze({
    ...preflight,
    status: 'canceled',
    commitAllowed: false,
    businessWritesPerformed: false,
    cancellation: Object.freeze({
      requested: true,
      beforeCommit: true,
      reason: reason.trim().normalize('NFC')
    })
  });
}

function createImportPreflight(options) {
  if (!isPlainObject(options)) {
    fail(ARCHIVE_ERROR_CODES.INPUT_INVALID, 'Import preflight options must be an object');
  }
  const archive = validateArchiveEntries(options.entries, {
    criticalEntries: options.criticalEntries || DEFAULT_CRITICAL_ENTRIES
  });
  const manifest = summarizeManifest(options.manifest);
  const optionalMissingAssets = normalizeSummaryList(
    options.optionalMissingAssets === undefined
      ? (options.manifest.optionalMissingAssets || [])
      : options.optionalMissingAssets,
    'optionalMissingAssets'
  );
  const conflicts = normalizeSummaryList(options.conflicts || [], 'conflicts');
  const estimatedDiskBytes = estimateImportDiskBytes(archive.expandedBytes);
  const availableDiskBytes = validateAvailableDiskBytes(options.availableDiskBytes, estimatedDiskBytes);

  const summary = Object.freeze({
    schemaVersion: 1,
    phase: 'preflight',
    status: 'ready',
    commitAllowed: true,
    businessWritesPerformed: false,
    packageVersion: manifest.packageVersion,
    projectCount: manifest.projectCount,
    libraryCount: manifest.libraryCount,
    resourceCount: manifest.resourceCount,
    entryCount: archive.entryCount,
    fileCount: archive.fileCount,
    directoryCount: archive.directoryCount,
    expandedBytes: archive.expandedBytes,
    optionalMissingAssets,
    conflicts,
    estimatedDiskBytes,
    availableDiskBytes,
    cancellation: Object.freeze({
      requested: false,
      beforeCommit: false,
      reason: null
    })
  });

  if (options.cancellationRequested === undefined || options.cancellationRequested === false) return summary;
  if (options.cancellationRequested !== true) {
    fail(ARCHIVE_ERROR_CODES.CANCELLATION_INVALID, 'cancellationRequested must be a boolean');
  }
  return cancelImportPreflight(summary, options.cancellationReason || 'user');
}

module.exports = {
  ARCHIVE_ERROR_CODES,
  ARCHIVE_LIMITS,
  ArchivePolicyError,
  DEFAULT_CRITICAL_ENTRIES,
  cancelImportPreflight,
  canonicalPathKey,
  createImportPreflight,
  estimateImportDiskBytes,
  normalizeArchivePath,
  summarizeManifest,
  validateArchiveEntries,
  validateAvailableDiskBytes
};
