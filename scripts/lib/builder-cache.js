const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { path7za } = require('7zip-bin');
const { createSourceTreeManifest } = require('./source-tree');

const WIN_CODE_SIGN_VERSION = '2.6.0';
const WIN_CODE_SIGN_ARCHIVE_SHA256 = 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4';
const WIN_CODE_SIGN_TREE_SHA256 = 'a507a917707bd48e3234f24be0f703c76eea7ed9af09d8d0a8ae6fcea92627e8';
const WIN_CODE_SIGN_FILE_COUNT = 83;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Builder cache path must be a child of ${parent}: ${child}`);
  }
}

function validatePreparedCache(cachePath) {
  if (!fs.existsSync(cachePath) || !fs.statSync(cachePath).isDirectory()) return false;
  try {
    const manifest = createSourceTreeManifest(cachePath);
    return manifest.fileCount === WIN_CODE_SIGN_FILE_COUNT &&
      manifest.sourceTreeSha256 === WIN_CODE_SIGN_TREE_SHA256;
  } catch (_) {
    return false;
  }
}

function prepareWinCodeSignCache(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..'));
  const cacheRoot = path.resolve(options.cacheRoot || path.join(rootDir, 'tmp', 'electron-builder-cache'));
  const archivePath = path.resolve(
    options.archivePath || path.join(rootDir, 'vendor', 'electron-builder', `winCodeSign-${WIN_CODE_SIGN_VERSION}.7z`)
  );
  const extractorPath = options.extractorPath || path7za;
  const spawnImplementation = options.spawnImplementation || spawnSync;
  const artifactRoot = path.join(cacheRoot, 'winCodeSign');
  const finalPath = path.join(artifactRoot, `winCodeSign-${WIN_CODE_SIGN_VERSION}`);
  const stagingPath = path.join(artifactRoot, `winCodeSign-${WIN_CODE_SIGN_VERSION}.staging-${process.pid}`);

  assertInside(rootDir, cacheRoot);
  assertInside(cacheRoot, artifactRoot);
  assertInside(artifactRoot, finalPath);
  assertInside(artifactRoot, stagingPath);

  if (!fs.existsSync(archivePath)) throw new Error(`Bundled winCodeSign archive is missing: ${archivePath}`);
  const archiveSha256 = sha256File(archivePath);
  if (archiveSha256 !== WIN_CODE_SIGN_ARCHIVE_SHA256) {
    throw new Error(`Bundled winCodeSign archive checksum mismatch: ${archiveSha256}`);
  }
  if (validatePreparedCache(finalPath)) {
    return { cacheRoot, artifactPath: finalPath, prepared: false, archiveSha256 };
  }

  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.rmSync(stagingPath, { recursive: true, force: true });
  fs.mkdirSync(stagingPath, { recursive: true });
  const extraction = spawnImplementation(extractorPath, [
    'x',
    archivePath,
    `-o${stagingPath}`,
    '-y',
    '-x!darwin\\10.12\\lib\\libcrypto.dylib',
    '-x!darwin\\10.12\\lib\\libssl.dylib'
  ], { cwd: rootDir, encoding: 'utf8', stdio: 'pipe' });
  if (extraction.error || extraction.status !== 0) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    const detail = extraction.error?.message || extraction.stderr || extraction.stdout || `exit ${extraction.status}`;
    throw new Error(`Unable to prepare winCodeSign cache: ${String(detail).trim()}`);
  }

  const macLibraryPath = path.join(stagingPath, 'darwin', '10.12', 'lib');
  fs.copyFileSync(
    path.join(macLibraryPath, 'libcrypto.1.0.0.dylib'),
    path.join(macLibraryPath, 'libcrypto.dylib')
  );
  fs.copyFileSync(
    path.join(macLibraryPath, 'libssl.1.0.0.dylib'),
    path.join(macLibraryPath, 'libssl.dylib')
  );

  if (!validatePreparedCache(stagingPath)) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    throw new Error('Prepared winCodeSign cache failed canonical tree verification');
  }
  fs.rmSync(finalPath, { recursive: true, force: true });
  fs.renameSync(stagingPath, finalPath);
  return { cacheRoot, artifactPath: finalPath, prepared: true, archiveSha256 };
}

module.exports = {
  WIN_CODE_SIGN_ARCHIVE_SHA256,
  WIN_CODE_SIGN_FILE_COUNT,
  WIN_CODE_SIGN_TREE_SHA256,
  WIN_CODE_SIGN_VERSION,
  assertInside,
  prepareWinCodeSignCache,
  sha256File,
  validatePreparedCache
};
