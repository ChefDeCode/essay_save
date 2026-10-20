const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  '.agents',
  '.codex',
  '.git',
  '.nyc_output',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'output',
  'tmp'
]);

const DEFAULT_EXCLUDED_FILES = new Set([
  'server.log',
  '\u65e5\u5fd7.txt'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function shouldExclude(relativePath, entryName, isDirectory, options) {
  if (isDirectory && options.excludedDirectories.has(entryName)) return true;
  if (!isDirectory && options.excludedFiles.has(entryName)) return true;
  return options.exclude.some(pattern => pattern.test(relativePath));
}

function collectFiles(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const normalizedOptions = {
    excludedDirectories: new Set([
      ...DEFAULT_EXCLUDED_DIRECTORIES,
      ...(options.excludedDirectories || [])
    ]),
    excludedFiles: new Set([
      ...DEFAULT_EXCLUDED_FILES,
      ...(options.excludedFiles || [])
    ]),
    exclude: options.exclude || []
  };
  const files = [];

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(root, absolutePath));
      if (shouldExclude(relativePath, entry.name, entry.isDirectory(), normalizedOptions)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`Source tree cannot contain symbolic links: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({ absolutePath, relativePath });
      }
    }
  }

  visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

function serializeEntries(entries) {
  return entries
    .map(entry => `${JSON.stringify(entry.path)}\t${entry.bytes}\t${entry.sha256}`)
    .join('\n') + '\n';
}

function createSourceTreeManifest(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const entries = collectFiles(root, options).map(file => {
    const bytes = fs.readFileSync(file.absolutePath);
    return {
      path: file.relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes)
    };
  });
  const canonicalManifest = serializeEntries(entries);
  return {
    schemaVersion: 1,
    root,
    fileCount: entries.length,
    entries,
    canonicalManifest,
    sourceTreeSha256: sha256(Buffer.from(canonicalManifest, 'utf8'))
  };
}

function writeSourceTreeManifest(rootPath, outputPath, options = {}) {
  const manifest = createSourceTreeManifest(rootPath, options);
  const output = {
    schemaVersion: manifest.schemaVersion,
    sourceTreeSha256: manifest.sourceTreeSha256,
    fileCount: manifest.fileCount,
    entries: manifest.entries
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  return output;
}

module.exports = {
  DEFAULT_EXCLUDED_DIRECTORIES,
  DEFAULT_EXCLUDED_FILES,
  collectFiles,
  createSourceTreeManifest,
  serializeEntries,
  sha256,
  toPosixPath,
  writeSourceTreeManifest
};
