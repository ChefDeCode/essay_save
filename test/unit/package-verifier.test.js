'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const asar = require('@electron/asar');
const {
  createCanonicalDirectoryManifest,
  hashFile,
  verifyWinUnpackedPackage,
  writePackageAssetManifest
} = require('../../scripts/lib/package-verifier');
const {
  buildSmokeInvocation,
  parseArguments: parseSmokeArguments,
  runPackagedSmoke
} = require('../../scripts/run-packaged-smoke');
const {
  parseArguments: parseVerifyArguments
} = require('../../scripts/verify-package');

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

const runtimeFiles = [
  { id: 'renderer-entry', relativePath: 'src/index.html' },
  { id: 'renderer-app', relativePath: 'src/app.js' }
];
const runtimeDirectories = [
  { id: 'runtime-data', relativePath: 'runtime-data', expectedFileCount: 2 }
];
const runtimePackages = [
  { name: 'fixture-runtime', version: '1.2.3' }
];

async function createPackagedFixture(t, mutateStaging) {
  const fixtureRoot = temporaryDirectory(t, 'essayflow-package-verifier-');
  const sourceRoot = path.join(fixtureRoot, 'source');
  const stagingRoot = path.join(fixtureRoot, 'staging');
  const winUnpackedRoot = path.join(fixtureRoot, 'win-unpacked');
  const applicationPath = path.join(winUnpackedRoot, 'EssayFlow.exe');
  const appAsarPath = path.join(winUnpackedRoot, 'resources', 'app.asar');
  const packageJson = {
    name: 'essay-fixture',
    version: '9.8.7',
    main: 'main.js',
    dependencies: { 'fixture-runtime': '1.2.3' },
    build: { productName: 'EssayFlow' }
  };
  const indexHtml = '<!doctype html><html><head>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; object-src \'none\'">' +
    '<script src="app.js"></script></head><body></body></html>';

  writeFile(sourceRoot, 'package.json', JSON.stringify(packageJson));
  writeFile(sourceRoot, 'main.js', 'console.log("fixture");\n');
  writeFile(sourceRoot, 'src/index.html', indexHtml);
  writeFile(sourceRoot, 'src/app.js', 'window.fixture = true;\n');
  writeFile(sourceRoot, 'runtime-data/a.txt', 'alpha');
  writeFile(sourceRoot, 'runtime-data/nested/b.txt', 'beta');
  writeFile(sourceRoot, 'node_modules/fixture-runtime/package.json', JSON.stringify({
    name: 'fixture-runtime',
    version: '1.2.3'
  }));
  fs.cpSync(sourceRoot, stagingRoot, { recursive: true });
  if (mutateStaging) mutateStaging(stagingRoot);
  fs.mkdirSync(path.dirname(appAsarPath), { recursive: true });
  fs.writeFileSync(applicationPath, 'synthetic-executable');
  await asar.createPackage(stagingRoot, appAsarPath);

  return {
    sourceRoot,
    applicationPath,
    appAsarPath,
    verify() {
      return verifyWinUnpackedPackage({
        sourceRoot,
        applicationPath,
        runtimeFiles,
        runtimeDirectories,
        runtimePackages,
        validateSourceRuntime: false
      });
    }
  };
}

test('win-unpacked verifier binds ASAR runtime assets, version, CSP and hashes', async t => {
  const fixture = await createPackagedFixture(t);
  const report = fixture.verify();
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.equal(report.sourcePackage.version, '9.8.7');
  assert.equal(report.packagedPackage.version, '9.8.7');
  assert.deepEqual(report.checks, {
    appAsarExists: true,
    appPayloadBoundToTree: true,
    sourceRuntimePolicyPassed: true,
    manifestMatches: true,
    versionMatches: true,
    runtimePackageVersionsMatch: true,
    runtimeAssetHashesMatch: true,
    cspMatches: true
  });
  assert.equal(report.csp.directives['script-src'][0], "'self'");
  assert.equal(report.runtimeAssetFileCount, 4);
  assert.equal(report.appPayloadSha256, hashFile(fixture.appAsarPath).sha256);
  assert.match(report.winUnpackedTreeSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    report.winUnpackedEntries.find(entry => entry.path === 'resources/app.asar').sha256,
    report.appPayloadSha256
  );

  const outputPath = path.join(path.dirname(fixture.sourceRoot), 'artifact', 'package-assets.json');
  assert.equal(writePackageAssetManifest(report, outputPath), path.resolve(outputPath));
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).appPayloadSha256, report.appPayloadSha256);
});

test('win-unpacked verifier rejects a runtime asset changed after source capture', async t => {
  const fixture = await createPackagedFixture(t, stagingRoot => {
    writeFile(stagingRoot, 'src/app.js', 'window.fixture = "tampered";\n');
  });
  const report = fixture.verify();
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /ASAR runtime asset differs from source: src\/app\.js/);
  assert.match(report.errors.join('\n'), /runtime asset manifest hash differs/i);
});

test('win-unpacked verifier rejects packaged CSP drift and remote executable assets', async t => {
  const fixture = await createPackagedFixture(t, stagingRoot => {
    writeFile(stagingRoot, 'src/index.html', '<meta http-equiv="Content-Security-Policy" content="script-src https://cdn.example; object-src \'none\'"><script src="https://cdn.example/app.js"></script>');
  });
  const report = fixture.verify();
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /script-src must be exactly 'self'/);
  assert.match(report.errors.join('\n'), /remote executable asset/);
  assert.match(report.errors.join('\n'), /Packaged CSP differs from source CSP/);
});

test('win-unpacked verifier fails closed when resources/app.asar is missing', t => {
  const root = temporaryDirectory(t, 'essayflow-package-missing-');
  const sourceRoot = path.join(root, 'source');
  const applicationPath = path.join(root, 'win-unpacked', 'EssayFlow.exe');
  writeFile(sourceRoot, 'package.json', '{}');
  writeFile(path.dirname(applicationPath), path.basename(applicationPath), 'exe');
  assert.throws(() => verifyWinUnpackedPackage({ sourceRoot, applicationPath }), /missing resources\/app\.asar/i);
});

test('canonical packaged tree includes every directory and is creation-order independent', t => {
  const first = temporaryDirectory(t, 'essayflow-package-tree-a-');
  const second = temporaryDirectory(t, 'essayflow-package-tree-b-');
  writeFile(first, 'node_modules/runtime/a.js', 'A');
  writeFile(first, 'resources/app.asar', 'B');
  writeFile(second, 'resources/app.asar', 'B');
  writeFile(second, 'node_modules/runtime/a.js', 'A');
  const firstManifest = createCanonicalDirectoryManifest(first);
  const secondManifest = createCanonicalDirectoryManifest(second);
  assert.deepEqual(firstManifest.entries.map(entry => entry.path), [
    'node_modules/runtime/a.js',
    'resources/app.asar'
  ]);
  assert.equal(firstManifest.treeSha256, secondManifest.treeSha256);
  writeFile(second, 'resources/app.asar', 'changed');
  assert.notEqual(createCanonicalDirectoryManifest(second).treeSha256, firstManifest.treeSha256);
});

test('verify-package and packaged-smoke CLIs expose deterministic argument contracts', () => {
  const verify = parseVerifyArguments(['--app', 'dist/win-unpacked/EssayFlow.exe']);
  assert.equal(path.basename(verify.applicationPath), 'EssayFlow.exe');
  assert.equal(path.basename(verify.outputPath), 'package-asset-manifest.json');

  const smoke = parseSmokeArguments(['--app=dist/win-unpacked/EssayFlow.exe']);
  const invocation = buildSmokeInvocation(smoke);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(-4), [
    '--app',
    smoke.applicationPath,
    '--target',
    'win-unpacked'
  ]);
});

test('packaged smoke verifies the package before invoking the shared Electron smoke', async () => {
  const rootPath = path.resolve('fixture-root');
  const applicationPath = path.join(rootPath, 'win-unpacked', 'EssayFlow.exe');
  const manifestPath = path.join(rootPath, 'manifest.json');
  const calls = [];
  const report = { ok: true, errors: [], appPayloadSha256: 'a'.repeat(64) };
  const resultPromise = runPackagedSmoke({ rootPath, applicationPath, manifestPath }, {
    verify(options) {
      calls.push({ type: 'verify', options });
      return report;
    },
    writeManifest(value, outputPath) {
      calls.push({ type: 'manifest', value, outputPath });
    },
    spawn(command, args, options) {
      calls.push({ type: 'spawn', command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }
  });
  const result = await resultPromise;
  assert.equal(result.report, report);
  assert.deepEqual(calls.map(call => call.type), ['verify', 'manifest', 'spawn']);
  assert.equal(calls[2].args.includes(applicationPath), true);
  assert.equal(calls[2].options.windowsHide, true);
});
