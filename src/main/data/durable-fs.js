'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalBytes } = require('./canonical');

const ERROR_CODES = Object.freeze({
  INVALID_DATA: 'DURABLE_INVALID_DATA',
  INVALID_PATH: 'DURABLE_INVALID_PATH',
  PATH_ESCAPE: 'DURABLE_PATH_ESCAPE',
  SYMBOLIC_LINK: 'DURABLE_SYMBOLIC_LINK_REJECTED',
  NOT_DIRECTORY: 'DURABLE_NOT_DIRECTORY',
  TARGET_NOT_FILE: 'DURABLE_TARGET_NOT_FILE',
  TEMP_OPEN_FAILED: 'DURABLE_TEMP_OPEN_FAILED',
  TEMP_WRITE_FAILED: 'DURABLE_TEMP_WRITE_FAILED',
  TEMP_SYNC_FAILED: 'DURABLE_TEMP_SYNC_FAILED',
  TEMP_CLOSE_FAILED: 'DURABLE_TEMP_CLOSE_FAILED',
  ATOMIC_REPLACE_FAILED: 'DURABLE_ATOMIC_REPLACE_FAILED',
  DIRECTORY_SYNC_FAILED: 'DURABLE_DIRECTORY_SYNC_FAILED',
  FAULT_INJECTED: 'DURABLE_FAULT_INJECTED',
  NO_SPACE: 'DURABLE_NO_SPACE',
  ACCESS_DENIED: 'DURABLE_ACCESS_DENIED',
  FILE_LOCKED: 'DURABLE_FILE_LOCKED',
  IO_FAILED: 'DURABLE_IO_FAILED'
});

const FAULT_STAGES = Object.freeze({
  PREPARE_PATH: 'prepare-path',
  BEFORE_TEMP_OPEN: 'before-temp-open',
  AFTER_TEMP_OPEN: 'after-temp-open',
  BEFORE_TEMP_WRITE: 'before-temp-write',
  AFTER_TEMP_WRITE: 'after-temp-write',
  BEFORE_TEMP_FSYNC: 'before-temp-fsync',
  AFTER_TEMP_FSYNC: 'after-temp-fsync',
  BEFORE_TEMP_CLOSE: 'before-temp-close',
  AFTER_TEMP_CLOSE: 'after-temp-close',
  BEFORE_ATOMIC_REPLACE: 'before-atomic-replace',
  AFTER_ATOMIC_REPLACE: 'after-atomic-replace',
  BEFORE_DIRECTORY_FSYNC: 'before-directory-fsync',
  AFTER_DIRECTORY_FSYNC: 'after-directory-fsync',
  BEFORE_DURABLE_ACK: 'before-durable-ack',
  DURABLE_ACK: 'durable-ack'
});

const STAGE_ERROR_CODES = Object.freeze({
  [FAULT_STAGES.PREPARE_PATH]: ERROR_CODES.IO_FAILED,
  [FAULT_STAGES.BEFORE_TEMP_OPEN]: ERROR_CODES.TEMP_OPEN_FAILED,
  [FAULT_STAGES.AFTER_TEMP_OPEN]: ERROR_CODES.TEMP_OPEN_FAILED,
  [FAULT_STAGES.BEFORE_TEMP_WRITE]: ERROR_CODES.TEMP_WRITE_FAILED,
  [FAULT_STAGES.AFTER_TEMP_WRITE]: ERROR_CODES.TEMP_WRITE_FAILED,
  [FAULT_STAGES.BEFORE_TEMP_FSYNC]: ERROR_CODES.TEMP_SYNC_FAILED,
  [FAULT_STAGES.AFTER_TEMP_FSYNC]: ERROR_CODES.TEMP_SYNC_FAILED,
  [FAULT_STAGES.BEFORE_TEMP_CLOSE]: ERROR_CODES.TEMP_CLOSE_FAILED,
  [FAULT_STAGES.AFTER_TEMP_CLOSE]: ERROR_CODES.TEMP_CLOSE_FAILED,
  [FAULT_STAGES.BEFORE_ATOMIC_REPLACE]: ERROR_CODES.ATOMIC_REPLACE_FAILED,
  [FAULT_STAGES.AFTER_ATOMIC_REPLACE]: ERROR_CODES.ATOMIC_REPLACE_FAILED,
  [FAULT_STAGES.BEFORE_DIRECTORY_FSYNC]: ERROR_CODES.DIRECTORY_SYNC_FAILED,
  [FAULT_STAGES.AFTER_DIRECTORY_FSYNC]: ERROR_CODES.DIRECTORY_SYNC_FAILED,
  [FAULT_STAGES.BEFORE_DURABLE_ACK]: ERROR_CODES.IO_FAILED,
  [FAULT_STAGES.DURABLE_ACK]: ERROR_CODES.IO_FAILED
});

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_SEGMENT = /[<>:"|?*\u0000-\u001f]/;

class DurableFsError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DurableFsError';
    this.code = code;
    this.stage = details.stage || 'validation';
    this.committed = details.committed === true;
    this.details = Object.freeze({
      ...details,
      stage: this.stage,
      committed: this.committed,
      commitState: this.committed ? 'committed-not-acknowledged' : 'not-committed'
    });
  }
}

function pathError(code, message, details = {}) {
  return new DurableFsError(code, message, { ...details, stage: 'validation', committed: false });
}

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw pathError(ERROR_CODES.INVALID_PATH, 'A non-empty relative path is required');
  }
  if (
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw pathError(ERROR_CODES.PATH_ESCAPE, 'Absolute and drive-relative paths are not allowed', { relativePath });
  }
  const segments = relativePath.split(/[\\/]/);
  if (!segments.length || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw pathError(ERROR_CODES.PATH_ESCAPE, 'Path traversal and empty path segments are not allowed', { relativePath });
  }
  for (const segment of segments) {
    if (
      WINDOWS_INVALID_SEGMENT.test(segment) ||
      WINDOWS_RESERVED_NAME.test(segment) ||
      segment.endsWith('.') ||
      segment.endsWith(' ')
    ) {
      throw pathError(ERROR_CODES.INVALID_PATH, 'The relative path is not portable to Windows', {
        relativePath,
        segment
      });
    }
  }
  return segments.map(segment => segment.normalize('NFC')).join(path.sep);
}

function isContained(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveContainedPath(rootPath, relativePath) {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw pathError(ERROR_CODES.INVALID_PATH, 'A non-empty repository root is required');
  }
  const root = path.resolve(rootPath);
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const target = path.resolve(root, normalizedRelativePath);
  if (!isContained(root, target)) {
    throw pathError(ERROR_CODES.PATH_ESCAPE, 'Resolved path escapes the repository root', {
      rootPath: root,
      relativePath
    });
  }
  return target;
}

async function lstatIfPresent(io, filePath) {
  try {
    return await io.lstat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNotSymbolicLink(stat, filePath, relativePath) {
  if (stat && stat.isSymbolicLink()) {
    throw pathError(ERROR_CODES.SYMBOLIC_LINK, 'Symbolic links and junctions are not valid repository paths', {
      filePath,
      relativePath
    });
  }
}

async function ensureSafeParent(rootPath, targetPath, relativePath, io) {
  await io.mkdir(rootPath, { recursive: true });
  const rootStat = await io.lstat(rootPath);
  assertNotSymbolicLink(rootStat, rootPath, relativePath);
  if (!rootStat.isDirectory()) {
    throw pathError(ERROR_CODES.NOT_DIRECTORY, 'Repository root is not a directory', { rootPath, relativePath });
  }

  const parentPath = path.dirname(targetPath);
  const relativeParent = path.relative(rootPath, parentPath);
  const parentSegments = relativeParent === '' ? [] : relativeParent.split(path.sep);
  let current = rootPath;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    let stat = await lstatIfPresent(io, current);
    if (!stat) {
      await io.mkdir(current);
      stat = await io.lstat(current);
    }
    assertNotSymbolicLink(stat, current, relativePath);
    if (!stat.isDirectory()) {
      throw pathError(ERROR_CODES.NOT_DIRECTORY, 'A repository path component is not a directory', {
        filePath: current,
        relativePath
      });
    }
  }

  const realRoot = await io.realpath(rootPath);
  const realParent = await io.realpath(parentPath);
  if (realParent !== realRoot && !isContained(realRoot, realParent)) {
    throw pathError(ERROR_CODES.PATH_ESCAPE, 'Resolved parent escapes the repository root', {
      rootPath: realRoot,
      relativePath
    });
  }

  const targetStat = await lstatIfPresent(io, targetPath);
  assertNotSymbolicLink(targetStat, targetPath, relativePath);
  if (targetStat && !targetStat.isFile()) {
    throw pathError(ERROR_CODES.TARGET_NOT_FILE, 'Durable write target is not a regular file', {
      filePath: targetPath,
      relativePath
    });
  }
  return parentPath;
}

function unsupportedDirectorySync(error, platform) {
  if (!error) return false;
  if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error.code)) return true;
  return platform === 'win32' && error.code === 'EPERM' && error.syscall === 'fsync';
}

async function fsyncDirectory(directoryPath, options = {}) {
  const io = options.io || fs.promises;
  const platform = options.platform || process.platform;
  let handle;
  try {
    handle = await io.open(directoryPath, 'r');
    await handle.sync();
    await handle.close();
    handle = null;
    return Object.freeze({ synced: true, supported: true, osCode: null });
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the directory sync/open failure as the primary error.
      }
    }
    if (options.allowUnsupported !== false && unsupportedDirectorySync(error, platform)) {
      return Object.freeze({ synced: false, supported: false, osCode: error.code });
    }
    throw error;
  }
}

function dataToBuffer(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new DurableFsError(ERROR_CODES.INVALID_DATA, 'Durable writes accept strings, Buffers or Uint8Arrays', {
    stage: 'validation',
    committed: false,
    valueType: typeof data
  });
}

function defaultTemporaryName() {
  return `.essayflow-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`;
}

function validateTemporaryName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    WINDOWS_INVALID_SEGMENT.test(name) ||
    WINDOWS_RESERVED_NAME.test(name) ||
    name.endsWith('.') ||
    name.endsWith(' ')
  ) {
    throw pathError(ERROR_CODES.INVALID_PATH, 'Temporary name factory returned an invalid file name');
  }
  return name;
}

async function callFaultInjector(options, stage, context) {
  if (typeof options.faultInjector !== 'function') return;
  const result = await options.faultInjector(stage, Object.freeze({ ...context, stage }));
  if (result === true || typeof result === 'string') {
    const error = new Error(`Injected failure at ${stage}`);
    error.code = typeof result === 'string' ? result : 'INJECTED_FAULT';
    error.injected = true;
    throw error;
  }
}

function mapError(error, stage, context, cleanupError) {
  if (error instanceof DurableFsError) return error;
  let code = STAGE_ERROR_CODES[stage] || ERROR_CODES.IO_FAILED;
  if (error && error.code === 'ENOSPC') code = ERROR_CODES.NO_SPACE;
  else if (error && ['EACCES', 'EPERM'].includes(error.code)) code = ERROR_CODES.ACCESS_DENIED;
  else if (error && ['EBUSY', 'ETXTBSY', 'EAGAIN'].includes(error.code)) code = ERROR_CODES.FILE_LOCKED;
  else if (error && (error.injected === true || error.code === 'INJECTED_FAULT')) code = ERROR_CODES.FAULT_INJECTED;
  return new DurableFsError(code, `Durable write failed at ${stage}: ${error?.message || 'unknown error'}`, {
    stage,
    committed: context.committed,
    label: context.label,
    relativePath: context.relativePath,
    osCode: error?.code || null,
    cleanupErrorCode: cleanupError?.code || null
  }, error);
}

async function durableWriteFile(rootPath, relativePath, data, options = {}) {
  const io = options.io || fs.promises;
  const targetPath = resolveContainedPath(rootPath, relativePath);
  const resolvedRoot = path.resolve(rootPath);
  const bytes = dataToBuffer(data);
  let parentPath;
  try {
    parentPath = await ensureSafeParent(resolvedRoot, targetPath, relativePath, io);
  } catch (error) {
    throw mapError(error, FAULT_STAGES.PREPARE_PATH, {
      label: options.label || 'data',
      relativePath,
      committed: false
    });
  }
  let temporaryName;
  try {
    temporaryName = validateTemporaryName(
      options.tempNameFactory ? options.tempNameFactory({ targetPath, relativePath }) : defaultTemporaryName()
    );
  } catch (error) {
    throw mapError(error, FAULT_STAGES.PREPARE_PATH, {
      label: options.label || 'data',
      relativePath,
      committed: false
    });
  }
  const temporaryPath = path.join(parentPath, temporaryName);
  if (!isContained(parentPath, temporaryPath) || path.resolve(temporaryPath) === path.resolve(targetPath)) {
    throw pathError(ERROR_CODES.PATH_ESCAPE, 'Temporary path escapes its target directory', { relativePath });
  }

  let handle = null;
  let temporaryCreated = false;
  let committed = false;
  let stage = FAULT_STAGES.BEFORE_TEMP_OPEN;
  let directorySync = Object.freeze({ synced: false, supported: false, osCode: null });
  const context = () => ({
    label: options.label || 'data',
    relativePath,
    targetPath,
    temporaryPath,
    byteLength: bytes.length,
    committed
  });

  try {
    await callFaultInjector(options, stage, context());
    handle = await io.open(temporaryPath, 'wx', options.mode ?? 0o600);
    temporaryCreated = true;

    stage = FAULT_STAGES.AFTER_TEMP_OPEN;
    await callFaultInjector(options, stage, context());
    stage = FAULT_STAGES.BEFORE_TEMP_WRITE;
    await callFaultInjector(options, stage, context());
    await handle.writeFile(bytes);

    stage = FAULT_STAGES.AFTER_TEMP_WRITE;
    await callFaultInjector(options, stage, context());
    stage = FAULT_STAGES.BEFORE_TEMP_FSYNC;
    await callFaultInjector(options, stage, context());
    await handle.sync();

    stage = FAULT_STAGES.AFTER_TEMP_FSYNC;
    await callFaultInjector(options, stage, context());
    stage = FAULT_STAGES.BEFORE_TEMP_CLOSE;
    await callFaultInjector(options, stage, context());
    await handle.close();
    handle = null;

    stage = FAULT_STAGES.AFTER_TEMP_CLOSE;
    await callFaultInjector(options, stage, context());
    stage = FAULT_STAGES.BEFORE_ATOMIC_REPLACE;
    await callFaultInjector(options, stage, context());
    await io.rename(temporaryPath, targetPath);
    committed = true;

    stage = FAULT_STAGES.AFTER_ATOMIC_REPLACE;
    await callFaultInjector(options, stage, context());
    stage = FAULT_STAGES.BEFORE_DIRECTORY_FSYNC;
    await callFaultInjector(options, stage, context());
    directorySync = await fsyncDirectory(parentPath, {
      io,
      platform: options.platform,
      allowUnsupported: options.allowUnsupportedDirectoryFsync
    });

    stage = FAULT_STAGES.AFTER_DIRECTORY_FSYNC;
    await callFaultInjector(options, stage, { ...context(), directorySync });
    const result = Object.freeze({
      path: targetPath,
      relativePath,
      byteLength: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      directorySynced: directorySync.synced,
      directoryFsyncSupported: directorySync.supported,
      durable: true,
      durability: directorySync.synced ? 'filesystem-flushed' : 'process-crash'
    });

    stage = FAULT_STAGES.BEFORE_DURABLE_ACK;
    await callFaultInjector(options, stage, { ...context(), result });
    stage = FAULT_STAGES.DURABLE_ACK;
    await callFaultInjector(options, stage, { ...context(), result });
    return result;
  } catch (error) {
    let cleanupError = null;
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupError = closeError;
      }
      handle = null;
    }
    if (!committed && temporaryCreated) {
      try {
        await io.unlink(temporaryPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT' && !cleanupError) cleanupError = unlinkError;
      }
    }
    throw mapError(error, stage, context(), cleanupError);
  }
}

function durableWriteJson(rootPath, relativePath, value, options = {}) {
  const bytes = canonicalBytes(value, options.canonicalOptions || {});
  return durableWriteFile(rootPath, relativePath, bytes, options);
}

module.exports = {
  DurableFsError,
  ERROR_CODES,
  FAULT_STAGES,
  durableWriteFile,
  durableWriteJson,
  fsyncDirectory,
  normalizeRelativePath,
  resolveContainedPath
};
