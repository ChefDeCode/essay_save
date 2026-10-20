'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_PACKAGES
} = require('./runtime-assets');
const {
  extractCsp,
  inspectRuntimeAssets,
  parseCsp
} = require('../verify-runtime-assets');
const {
  createSourceTreeManifest,
  serializeEntries,
  sha256,
  toPosixPath
} = require('./source-tree');

function normalizeRelativePath(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || normalized.includes('\0') || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid package-relative path: ${value}`);
  }
  return normalized;
}

function hashFile(filePath) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  let bytes = 0;
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { bytes, sha256: digest.digest('hex') };
}

function createCanonicalDirectoryManifest(rootPath) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Canonical tree root is not a directory: ${root}`);
  }
  const entries = [];

  function visit(directory) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = toPosixPath(path.relative(root, absolutePath));
      if (child.isSymbolicLink()) throw new Error(`Packaged tree cannot contain symbolic links: ${relativePath}`);
      if (child.isDirectory()) {
        visit(absolutePath);
      } else if (child.isFile()) {
        const hashed = hashFile(absolutePath);
        entries.push({ path: relativePath, ...hashed });
      }
    }
  }

  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const canonicalManifest = serializeEntries(entries);
  return {
    root,
    fileCount: entries.length,
    entries,
    canonicalManifest,
    treeSha256: sha256(Buffer.from(canonicalManifest, 'utf8'))
  };
}

function createFilesystemReader(rootPath) {
  const root = fs.realpathSync(path.resolve(rootPath));

  function resolveFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const candidate = path.resolve(root, ...normalized.split('/'));
    const relative = path.relative(root, candidate);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`Runtime asset escaped source root: ${normalized}`);
    }
    if (!fs.existsSync(candidate)) throw new Error(`Missing runtime asset: ${normalized}`);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Runtime asset is not a regular file: ${normalized}`);
    const realFile = fs.realpathSync(candidate);
    const realRelative = path.relative(root, realFile);
    if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) {
      throw new Error(`Runtime asset resolved outside source root: ${normalized}`);
    }
    return realFile;
  }

  function listFiles(relativeDirectory) {
    const normalizedDirectory = normalizeRelativePath(relativeDirectory);
    const directory = path.resolve(root, ...normalizedDirectory.split('/'));
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`Missing runtime asset directory: ${normalizedDirectory}`);
    }
    const results = [];
    function visit(current) {
      const children = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const child of children) {
        const absolutePath = path.join(current, child.name);
        if (child.isSymbolicLink()) throw new Error(`Runtime asset directory contains a symbolic link: ${absolutePath}`);
        if (child.isDirectory()) visit(absolutePath);
        else if (child.isFile()) results.push(toPosixPath(path.relative(root, absolutePath)));
      }
    }
    visit(directory);
    return results.sort((left, right) => left.localeCompare(right, 'en'));
  }

  return {
    kind: 'source',
    listFiles,
    readFile(relativePath) {
      return fs.readFileSync(resolveFile(relativePath));
    }
  };
}

function createAsarReader(asarPath, asarApi = asar) {
  const archivePath = path.resolve(asarPath);
  const entryMap = new Map();
  for (const rawEntry of asarApi.listPackage(archivePath)) {
    const normalized = normalizeRelativePath(rawEntry);
    const archiveEntry = String(rawEntry).replace(/^[\\/]+/, '');
    if (entryMap.has(normalized) && entryMap.get(normalized) !== archiveEntry) {
      throw new Error(`ASAR contains duplicate normalized path: ${normalized}`);
    }
    entryMap.set(normalized, archiveEntry);
  }

  function fileEntry(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const archiveEntry = entryMap.get(normalized);
    if (!archiveEntry) throw new Error(`ASAR is missing runtime asset: ${normalized}`);
    const stat = asarApi.statFile(archivePath, archiveEntry);
    if (!stat || !Number.isFinite(stat.size)) throw new Error(`ASAR entry is not a file: ${normalized}`);
    return { archiveEntry, normalized };
  }

  return {
    kind: 'asar',
    listFiles(relativeDirectory) {
      const prefix = `${normalizeRelativePath(relativeDirectory)}/`;
      const files = [];
      for (const [normalized, archiveEntry] of entryMap) {
        if (!normalized.startsWith(prefix)) continue;
        const stat = asarApi.statFile(archivePath, archiveEntry);
        if (stat && Number.isFinite(stat.size)) files.push(normalized);
      }
      return files.sort((left, right) => left.localeCompare(right, 'en'));
    },
    readFile(relativePath) {
      const entry = fileEntry(relativePath);
      return Buffer.from(asarApi.extractFile(archivePath, entry.archiveEntry));
    }
  };
}

function validateCsp(indexHtml, errors) {
  const cspContent = extractCsp(indexHtml);
  if (!cspContent) {
    errors.push('src/index.html is missing Content-Security-Policy');
    return { content: null, directives: {} };
  }
  const csp = parseCsp(cspContent);
  const scriptSrc = csp.get('script-src') || [];
  const objectSrc = csp.get('object-src') || [];
  if (scriptSrc.length !== 1 || scriptSrc[0] !== "'self'") errors.push("Packaged CSP script-src must be exactly 'self'");
  if (objectSrc.length !== 1 || objectSrc[0] !== "'none'") errors.push("Packaged CSP object-src must be exactly 'none'");
  if (/(?:<script\b[^>]*\bsrc|<link\b[^>]*\bhref)\s*=\s*["']https?:\/\//i.test(indexHtml)) {
    errors.push('Packaged index contains a remote executable asset');
  }
  if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i.test(indexHtml)) {
    errors.push('Packaged index contains an inline script');
  }
  return { content: cspContent, directives: Object.fromEntries(csp) };
}

function inspectRuntimePayload(reader, options = {}) {
  const runtimeFiles = options.runtimeFiles || RUNTIME_FILES;
  const runtimeDirectories = options.runtimeDirectories || RUNTIME_DIRECTORIES;
  const runtimePackages = options.runtimePackages || RUNTIME_PACKAGES;
  const errors = [];
  const files = [];
  const directories = [];
  const packages = [];
  const manifestEntries = new Map();

  function addManifestEntry(relativePath, contents) {
    const normalized = normalizeRelativePath(relativePath);
    const entry = { path: normalized, bytes: contents.length, sha256: sha256(contents) };
    const existing = manifestEntries.get(normalized);
    if (existing && (existing.bytes !== entry.bytes || existing.sha256 !== entry.sha256)) {
      errors.push(`Runtime manifest path has conflicting contents: ${normalized}`);
    } else {
      manifestEntries.set(normalized, entry);
    }
    return entry;
  }

  for (const asset of runtimeFiles) {
    try {
      const contents = reader.readFile(asset.relativePath);
      if (!contents.length) errors.push(`Runtime asset is empty: ${asset.relativePath}`);
      files.push({ ...asset, ...addManifestEntry(asset.relativePath, contents) });
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const asset of runtimeDirectories) {
    try {
      const paths = reader.listFiles(asset.relativePath);
      if (paths.length !== asset.expectedFileCount) {
        errors.push(`${asset.relativePath} expected ${asset.expectedFileCount} files, found ${paths.length}`);
      }
      const prefix = `${normalizeRelativePath(asset.relativePath)}/`;
      const directoryEntries = paths.map(relativePath => {
        const contents = reader.readFile(relativePath);
        addManifestEntry(relativePath, contents);
        return {
          path: relativePath.slice(prefix.length),
          bytes: contents.length,
          sha256: sha256(contents)
        };
      }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
      const treeInput = directoryEntries
        .map(entry => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`)
        .join('');
      directories.push({
        ...asset,
        fileCount: directoryEntries.length,
        sha256: sha256(Buffer.from(treeInput, 'utf8'))
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const expected of runtimePackages) {
    const relativePath = `node_modules/${expected.name}/package.json`;
    try {
      const contents = reader.readFile(relativePath);
      const packageJson = JSON.parse(contents.toString('utf8'));
      packages.push({ ...expected, actualVersion: packageJson.version });
      if (packageJson.version !== expected.version) {
        errors.push(`${expected.name} expected version ${expected.version}, found ${packageJson.version || 'unknown'}`);
      }
    } catch (error) {
      errors.push(`Cannot inspect runtime package ${expected.name}: ${error.message}`);
    }
  }

  let packageJson = null;
  try {
    packageJson = JSON.parse(reader.readFile('package.json').toString('utf8'));
  } catch (error) {
    errors.push(`Cannot parse packaged application manifest: ${error.message}`);
  }

  let csp = { content: null, directives: {} };
  try {
    csp = validateCsp(reader.readFile('src/index.html').toString('utf8'), errors);
  } catch (error) {
    errors.push(`Cannot inspect packaged CSP: ${error.message}`);
  }

  const entries = [...manifestEntries.values()]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const canonicalManifest = serializeEntries(entries);
  return {
    kind: reader.kind,
    ok: errors.length === 0,
    files,
    directories,
    packages,
    packageJson,
    csp,
    entries,
    runtimeAssetManifestSha256: sha256(Buffer.from(canonicalManifest, 'utf8')),
    errors
  };
}

function compareRuntimePayloads(source, packaged, runtimePackages = RUNTIME_PACKAGES) {
  const errors = [];
  const sourceEntries = new Map(source.entries.map(entry => [entry.path, entry]));
  const packagedEntries = new Map(packaged.entries.map(entry => [entry.path, entry]));
  const allPaths = [...new Set([...sourceEntries.keys(), ...packagedEntries.keys()])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const relativePath of allPaths) {
    const expected = sourceEntries.get(relativePath);
    const actual = packagedEntries.get(relativePath);
    if (!expected) errors.push(`ASAR contains undeclared runtime asset: ${relativePath}`);
    else if (!actual) errors.push(`ASAR is missing runtime asset: ${relativePath}`);
    else if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
      errors.push(`ASAR runtime asset differs from source: ${relativePath}`);
    }
  }

  for (const field of ['name', 'version', 'main']) {
    if (source.packageJson?.[field] !== packaged.packageJson?.[field]) {
      errors.push(`Packaged manifest ${field} differs from source`);
    }
  }
  for (const runtimePackage of runtimePackages) {
    const expected = source.packageJson?.dependencies?.[runtimePackage.name];
    const actual = packaged.packageJson?.dependencies?.[runtimePackage.name];
    if (expected !== actual) errors.push(`Packaged dependency declaration differs: ${runtimePackage.name}`);
  }
  if (source.csp.content !== packaged.csp.content) errors.push('Packaged CSP differs from source CSP');
  if (source.runtimeAssetManifestSha256 !== packaged.runtimeAssetManifestSha256) {
    errors.push('Packaged runtime asset manifest hash differs from source');
  }
  return errors;
}

function verifyWinUnpackedPackage(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const applicationPath = path.resolve(options.applicationPath);
  if (!fs.existsSync(applicationPath) || !fs.lstatSync(applicationPath).isFile()) {
    throw new Error(`Packaged application does not exist: ${applicationPath}`);
  }
  if (fs.lstatSync(applicationPath).isSymbolicLink()) throw new Error('Packaged application cannot be a symbolic link');
  const winUnpackedRoot = path.dirname(applicationPath);
  const appAsarPath = path.join(winUnpackedRoot, 'resources', 'app.asar');
  if (!fs.existsSync(appAsarPath) || !fs.lstatSync(appAsarPath).isFile()) {
    throw new Error(`Packaged application is missing resources/app.asar: ${appAsarPath}`);
  }
  if (fs.lstatSync(appAsarPath).isSymbolicLink()) throw new Error('resources/app.asar cannot be a symbolic link');

  const runtimeOptions = {
    runtimeFiles: options.runtimeFiles || RUNTIME_FILES,
    runtimeDirectories: options.runtimeDirectories || RUNTIME_DIRECTORIES,
    runtimePackages: options.runtimePackages || RUNTIME_PACKAGES
  };
  const errors = [];
  const sourceRuntime = inspectRuntimePayload(createFilesystemReader(sourceRoot), runtimeOptions);
  const packagedRuntime = inspectRuntimePayload(createAsarReader(appAsarPath, options.asarApi || asar), runtimeOptions);
  errors.push(...sourceRuntime.errors.map(error => `source: ${error}`));
  errors.push(...packagedRuntime.errors.map(error => `asar: ${error}`));
  errors.push(...compareRuntimePayloads(sourceRuntime, packagedRuntime, runtimeOptions.runtimePackages));

  let sourceRuntimePolicyPassed = true;
  if (options.validateSourceRuntime !== false) {
    const sourceInspection = inspectRuntimeAssets(sourceRoot);
    sourceRuntimePolicyPassed = sourceInspection.ok;
    errors.push(...sourceInspection.errors.map(error => `source runtime policy: ${error}`));
  }

  const sourcePackage = sourceRuntime.packageJson || {};
  const expectedExecutableName = `${sourcePackage.build?.productName || sourcePackage.name || 'EssayFlow'}.exe`;
  if (path.basename(applicationPath).toLowerCase() !== expectedExecutableName.toLowerCase()) {
    errors.push(`Expected packaged executable ${expectedExecutableName}, found ${path.basename(applicationPath)}`);
  }

  const appPayload = hashFile(appAsarPath);
  const executable = hashFile(applicationPath);
  const winUnpackedTree = createCanonicalDirectoryManifest(winUnpackedRoot);
  const appAsarTreeEntry = winUnpackedTree.entries.find(entry => entry.path === 'resources/app.asar');
  const appPayloadBoundToTree = Boolean(appAsarTreeEntry && appAsarTreeEntry.sha256 === appPayload.sha256);
  if (!appPayloadBoundToTree) {
    errors.push('win-unpacked tree manifest does not bind the inspected app.asar payload');
  }
  const sourceTree = createSourceTreeManifest(sourceRoot);
  const manifestFieldsMatch = ['name', 'main'].every(field =>
    sourceRuntime.packageJson?.[field] === packagedRuntime.packageJson?.[field]
  );
  const versionMatches = sourceRuntime.packageJson?.version === packagedRuntime.packageJson?.version;
  const dependencyManifestMatches = runtimeOptions.runtimePackages.every(runtimePackage =>
    sourceRuntime.packageJson?.dependencies?.[runtimePackage.name] ===
      packagedRuntime.packageJson?.dependencies?.[runtimePackage.name]
  );
  const runtimePackageVersionsMatch = runtimeOptions.runtimePackages.every(runtimePackage => {
    const sourceVersion = sourceRuntime.packages.find(item => item.name === runtimePackage.name)?.actualVersion;
    const packagedVersion = packagedRuntime.packages.find(item => item.name === runtimePackage.name)?.actualVersion;
    return sourceVersion === runtimePackage.version && packagedVersion === runtimePackage.version;
  });
  const runtimeAssetHashesMatch = sourceRuntime.runtimeAssetManifestSha256 ===
    packagedRuntime.runtimeAssetManifestSha256;
  const cspMatches = Boolean(sourceRuntime.csp.content &&
    sourceRuntime.csp.content === packagedRuntime.csp.content &&
    packagedRuntime.csp.directives['script-src']?.length === 1 &&
    packagedRuntime.csp.directives['script-src'][0] === "'self'" &&
    packagedRuntime.csp.directives['object-src']?.length === 1 &&
    packagedRuntime.csp.directives['object-src'][0] === "'none'");

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: 'win-unpacked',
    ok: errors.length === 0,
    applicationPath,
    winUnpackedRoot,
    appAsarPath,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    appPayloadSha256: appPayload.sha256,
    appPayloadBytes: appPayload.bytes,
    executableSha256: executable.sha256,
    executableBytes: executable.bytes,
    winUnpackedTreeSha256: winUnpackedTree.treeSha256,
    winUnpackedFileCount: winUnpackedTree.fileCount,
    winUnpackedEntries: winUnpackedTree.entries,
    sourceRuntimeAssetManifestSha256: sourceRuntime.runtimeAssetManifestSha256,
    runtimeAssetManifestSha256: packagedRuntime.runtimeAssetManifestSha256,
    runtimeAssetFileCount: packagedRuntime.entries.length,
    runtimeAssets: packagedRuntime.entries,
    sourcePackage: sourceRuntime.packageJson && {
      name: sourceRuntime.packageJson.name,
      version: sourceRuntime.packageJson.version,
      main: sourceRuntime.packageJson.main,
      dependencies: sourceRuntime.packageJson.dependencies
    },
    packagedPackage: packagedRuntime.packageJson,
    csp: packagedRuntime.csp,
    runtimeDirectories: packagedRuntime.directories,
    runtimePackages: packagedRuntime.packages,
    checks: {
      appAsarExists: true,
      appPayloadBoundToTree,
      sourceRuntimePolicyPassed,
      manifestMatches: manifestFieldsMatch && dependencyManifestMatches,
      versionMatches,
      runtimePackageVersionsMatch,
      runtimeAssetHashesMatch,
      cspMatches
    },
    errors
  };
}

function writePackageAssetManifest(report, outputPath) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporaryPath = `${resolved}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, resolved);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
  return resolved;
}

module.exports = {
  compareRuntimePayloads,
  createAsarReader,
  createCanonicalDirectoryManifest,
  createFilesystemReader,
  hashFile,
  inspectRuntimePayload,
  normalizeRelativePath,
  verifyWinUnpackedPackage,
  writePackageAssetManifest
};
