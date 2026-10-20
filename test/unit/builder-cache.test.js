const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  WIN_CODE_SIGN_ARCHIVE_SHA256,
  assertInside,
  prepareWinCodeSignCache,
  sha256File,
  validatePreparedCache
} = require('../../scripts/lib/builder-cache');
const { main, runBuild } = require('../../scripts/build');

const projectRoot = path.resolve(__dirname, '..', '..');
const bundledArchive = path.join(projectRoot, 'vendor', 'electron-builder', 'winCodeSign-2.6.0.7z');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-builder-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'vendor', 'electron-builder'), { recursive: true });
  fs.copyFileSync(bundledArchive, path.join(root, 'vendor', 'electron-builder', 'winCodeSign-2.6.0.7z'));
  return root;
}

test('bundled winCodeSign archive is pinned', () => {
  assert.equal(sha256File(bundledArchive), WIN_CODE_SIGN_ARCHIVE_SHA256);
});

test('default preparation uses the repository-local temporary cache', () => {
  const result = prepareWinCodeSignCache();
  assert.equal(validatePreparedCache(result.artifactPath), true);
  assert.equal(result.cacheRoot, path.join(projectRoot, 'tmp', 'electron-builder-cache'));
});

test('prepares and reuses a verified local builder cache without symbolic links', t => {
  const root = temporaryRoot(t);
  const first = prepareWinCodeSignCache({ rootDir: root });
  assert.equal(first.prepared, true);
  assert.equal(validatePreparedCache(first.artifactPath), true);
  for (const name of ['libcrypto.dylib', 'libssl.dylib']) {
    const filePath = path.join(first.artifactPath, 'darwin', '10.12', 'lib', name);
    assert.equal(fs.lstatSync(filePath).isSymbolicLink(), false);
    assert.ok(fs.statSync(filePath).size > 0);
  }

  const second = prepareWinCodeSignCache({ rootDir: root });
  assert.equal(second.prepared, false);
  assert.equal(second.artifactPath, first.artifactPath);
});

test('rejects cache escapes and a modified bundled archive', t => {
  const root = temporaryRoot(t);
  assert.equal(validatePreparedCache(path.join(root, 'missing')), false);
  const regularFile = path.join(root, 'not-a-directory');
  fs.writeFileSync(regularFile, 'file');
  assert.equal(validatePreparedCache(regularFile), false);
  assert.throws(() => assertInside(root, root), /must be a child/);
  assert.throws(
    () => prepareWinCodeSignCache({ rootDir: root, cacheRoot: path.join(root, '..', 'escaped-cache') }),
    /must be a child/
  );
  fs.appendFileSync(path.join(root, 'vendor', 'electron-builder', 'winCodeSign-2.6.0.7z'), 'modified');
  assert.throws(() => prepareWinCodeSignCache({ rootDir: root }), /checksum mismatch/);
});

test('rejects a missing bundled archive', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-builder-cache-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => prepareWinCodeSignCache({ rootDir: root }), /archive is missing/);
});

test('removes failed staging output and reports extraction errors', t => {
  const root = temporaryRoot(t);
  const result = { status: 2, stdout: '', stderr: 'synthetic extraction failure' };
  assert.throws(
    () => prepareWinCodeSignCache({ rootDir: root, spawnImplementation: () => result }),
    /synthetic extraction failure/
  );
  const artifactRoot = path.join(root, 'tmp', 'electron-builder-cache', 'winCodeSign');
  const entries = fs.existsSync(artifactRoot) ? fs.readdirSync(artifactRoot) : [];
  assert.deepEqual(entries, []);

  assert.throws(
    () => prepareWinCodeSignCache({
      rootDir: root,
      spawnImplementation: () => ({ status: null, stdout: 'stdout failure', stderr: '' })
    }),
    /stdout failure/
  );

  assert.throws(
    () => prepareWinCodeSignCache({
      rootDir: root,
      spawnImplementation: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn failure') })
    }),
    /spawn failure/
  );
});

test('build wrapper binds electron-builder to the verified local cache', () => {
  const calls = [];
  const exitCode = runBuild({
    args: ['--dir'],
    cwd: projectRoot,
    electronBuilderCli: 'synthetic-builder.js',
    prepareCache: () => ({ cacheRoot: 'C:\\verified-cache' }),
    spawnImplementation: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    }
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['synthetic-builder.js', '--dir']);
  assert.equal(calls[0].options.env.ELECTRON_BUILDER_CACHE, 'C:\\verified-cache');
});

test('build wrapper propagates failures and CLI main reports errors', () => {
  assert.throws(() => runBuild({
    prepareCache: () => ({ cacheRoot: 'cache' }),
    spawnImplementation: () => ({ status: null, error: new Error('builder spawn failed') })
  }), /builder spawn failed/);

  assert.equal(runBuild({
    prepareCache: () => ({ cacheRoot: 'cache' }),
    spawnImplementation: () => ({ status: null })
  }), 1);

  const output = [];
  assert.equal(main({ runBuildImplementation: () => 0, stderr: { write: value => output.push(value) } }), 0);
  assert.equal(main({
    runBuildImplementation: () => { throw { message: 'plain failure' }; },
    stderr: { write: value => output.push(value) }
  }), 1);
  assert.match(output.join(''), /plain failure/);

  assert.equal(main({
    runBuildOptions: {
      args: [],
      prepareCache: () => ({ cacheRoot: 'cache' }),
      spawnImplementation: () => ({ status: 0 })
    }
  }), 0);

  assert.equal(main({
    runBuildImplementation: () => { throw new Error('stack failure'); },
    stderr: { write: value => output.push(value) }
  }), 1);
  assert.equal(main({
    runBuildImplementation: () => { throw 'string failure'; },
    stderr: { write: value => output.push(value) }
  }), 1);
  assert.match(output.join(''), /stack failure/);
  assert.match(output.join(''), /string failure/);
});
