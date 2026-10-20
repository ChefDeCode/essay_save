const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  collectFiles,
  createSourceTreeManifest,
  serializeEntries,
  sha256,
  toPosixPath,
  writeSourceTreeManifest
} = require('../../scripts/lib/source-tree');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-source-tree-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('source tree is canonical, sorted and excludes generated directories', t => {
  const root = temporaryDirectory(t);
  fs.mkdirSync(path.join(root, 'z'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.mkdirSync(path.join(root, 'output'));
  fs.writeFileSync(path.join(root, 'z', 'b.txt'), 'beta');
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  fs.writeFileSync(path.join(root, 'artifacts', 'ignored.json'), 'ignored');
  fs.writeFileSync(path.join(root, 'tmp', 'coverage.lcov'), 'ignored');
  fs.writeFileSync(path.join(root, 'output', 'export.pdf'), 'ignored');

  const manifest = createSourceTreeManifest(root);
  assert.deepEqual(manifest.entries.map(entry => entry.path), ['a.txt', 'z/b.txt']);
  assert.equal(manifest.fileCount, 2);
  assert.equal(manifest.sourceTreeSha256, sha256(Buffer.from(manifest.canonicalManifest, 'utf8')));
  assert.match(manifest.canonicalManifest, /^"a\.txt"\t5\t[0-9a-f]{64}\n/);
});

test('source tree hash changes with content but not file creation order', t => {
  const first = temporaryDirectory(t);
  const second = temporaryDirectory(t);
  fs.writeFileSync(path.join(first, 'b.txt'), 'B');
  fs.writeFileSync(path.join(first, 'a.txt'), 'A');
  fs.writeFileSync(path.join(second, 'a.txt'), 'A');
  fs.writeFileSync(path.join(second, 'b.txt'), 'B');

  const firstHash = createSourceTreeManifest(first).sourceTreeSha256;
  const secondHash = createSourceTreeManifest(second).sourceTreeSha256;
  assert.equal(firstHash, secondHash);
  fs.writeFileSync(path.join(second, 'b.txt'), 'changed');
  assert.notEqual(createSourceTreeManifest(second).sourceTreeSha256, firstHash);
});

test('custom exclusions, path normalization and manifest writing are deterministic', t => {
  const root = temporaryDirectory(t);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'keep.txt'), '\u4e2d\u6587');
  fs.writeFileSync(path.join(root, 'nested', 'drop.tmp'), 'drop');
  const files = collectFiles(root, { exclude: [/\.tmp$/] });
  assert.equal(files.length, 1);
  assert.equal(toPosixPath(path.join('nested', 'keep.txt')), 'nested/keep.txt');

  const outputPath = path.join(root, 'result', 'manifest.json');
  const output = writeSourceTreeManifest(root, outputPath, {
    excludedDirectories: ['result'],
    exclude: [/\.tmp$/]
  });
  const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.deepEqual(written, output);
  assert.equal(written.entries[0].bytes, Buffer.byteLength('\u4e2d\u6587'));
  assert.equal(serializeEntries(written.entries).endsWith('\n'), true);
});

test('symbolic links are rejected instead of silently changing the hash model', t => {
  if (process.platform === 'win32') return;
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, 'target.txt'), 'target');
  fs.symlinkSync('target.txt', path.join(root, 'link.txt'));
  assert.throws(() => createSourceTreeManifest(root), /symbolic links/);
});
