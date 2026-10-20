const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TRANSIENT_LOCK_ERRORS = new Set(['EBUSY', 'EACCES', 'EPERM']);
const lockRetrySignal = new Int32Array(new SharedArrayBuffer(4));

function readFileWithLockRetry(filePath, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_LOCK_ERRORS.has(error?.code) || attempt === attempts - 1) throw error;
      Atomics.wait(lockRetrySignal, 0, 0, Math.min(10 * (2 ** attempt), 60));
    }
  }
  throw lastError;
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotProfile(profilePath) {
  const root = path.resolve(profilePath);
  if (!fs.existsSync(root)) {
    return {
      schemaVersion: 1,
      path: root,
      exists: false,
      fileCount: 0,
      contentTreeSha256: hashBuffer(Buffer.from('', 'utf8')),
      files: []
    };
  }

  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absolutePath);
        const stat = fs.lstatSync(absolutePath);
        files.push({
          path: relativePath,
          bytes: Buffer.byteLength(target),
          mtimeMs: stat.mtimeMs,
          sha256: hashBuffer(Buffer.from(target, 'utf8')),
          type: 'symlink'
        });
      } else if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolutePath);
        const content = readFileWithLockRetry(absolutePath);
        files.push({
          path: relativePath,
          bytes: content.length,
          mtimeMs: stat.mtimeMs,
          sha256: hashBuffer(content),
          type: 'file'
        });
      }
    }
  }
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const canonicalContent = files
    .map(file => `${JSON.stringify(file.path)}\t${file.bytes}\t${file.sha256}\t${file.type}`)
    .join('\n') + (files.length ? '\n' : '');
  return {
    schemaVersion: 1,
    path: root,
    exists: true,
    fileCount: files.length,
    contentTreeSha256: hashBuffer(Buffer.from(canonicalContent, 'utf8')),
    files
  };
}

function compareProfileSnapshots(before, after) {
  const differences = [];
  if (before.path !== after.path) differences.push('profile path changed');
  if (before.exists !== after.exists) differences.push('profile existence changed');
  if (before.fileCount !== after.fileCount) differences.push('file count changed');
  if (before.contentTreeSha256 !== after.contentTreeSha256) differences.push('content hash changed');

  const beforeFiles = new Map(before.files.map(file => [file.path, file]));
  const afterFiles = new Map(after.files.map(file => [file.path, file]));
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const filePath of paths) {
    const left = beforeFiles.get(filePath);
    const right = afterFiles.get(filePath);
    if (!left) {
      differences.push(`added: ${filePath}`);
    } else if (!right) {
      differences.push(`removed: ${filePath}`);
    } else {
      if (left.bytes !== right.bytes || left.sha256 !== right.sha256) {
        differences.push(`content changed: ${filePath}`);
      }
      if (left.mtimeMs !== right.mtimeMs) {
        differences.push(`mtime changed: ${filePath}`);
      }
    }
  }
  return {
    unchanged: differences.length === 0,
    differences
  };
}

module.exports = {
  compareProfileSnapshots,
  hashBuffer,
  snapshotProfile
};
