const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchElectron, waitForRenderer } = require('./lib/electron-driver');
const { compareProfileSnapshots, snapshotProfile } = require('./lib/profile-guard');
const { createSourceTreeManifest } = require('./lib/source-tree');

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

function candidateRealProfiles(rootPath) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
  const names = new Set([
    packageJson.name,
    packageJson.build?.productName,
    'Electron'
  ].filter(Boolean));
  if (!process.env.APPDATA) throw new Error('APPDATA is required for the Windows profile guard');
  return [...names].map(name => path.resolve(process.env.APPDATA, name));
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const applicationPath = readOption('--app');
  const target = readOption('--target') || (applicationPath ? 'win-unpacked' : 'development');
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), `essayflow-${target}-smoke-`));
  const reportPath = path.join(profileRoot, 'profile-report.json');
  const candidates = candidateRealProfiles(root);
  const beforeSnapshots = new Map(candidates.map(candidate => [candidate.toLowerCase(), snapshotProfile(candidate)]));
  const startedAt = new Date().toISOString();
  let driver;
  try {
    driver = await launchElectron({
      rootPath: root,
      applicationPath,
      userDataPath: profileRoot,
      profileReportPath: reportPath
    });
    await waitForRenderer(driver, "typeof quill !== 'undefined' && appInitializationComplete === true && !quill.root.hasAttribute('aria-busy')", {
      timeoutMs: 45_000
    });
    const bootstrapError = await driver.client.evaluate(`window.essayflowDataReady
      .then(() => null)
      .catch(error => ({
        name: error?.name || 'Error',
        code: error?.code || '',
        message: error?.message || String(error),
        stack: error?.stack || ''
      }))`);
    assert.equal(bootstrapError, null, `Workspace bootstrap failed: ${JSON.stringify(bootstrapError, null, 2)}`);
    const renderer = await driver.client.evaluate(`(async () => {
      const projects = await window.electronAPI.listProjects();
      return {
        title: document.title,
        projectCount: Array.isArray(projects) ? projects.length : -1,
        quillVersion: window.Quill && window.Quill.version,
        editorEnabled: quill.isEnabled(),
        pdfjsWindowType: typeof window.pdfjsLib,
        pdfjsGlobalType: typeof pdfjsLib,
        scriptSources: Array.from(document.scripts).map(script => script.src),
        styleSources: Array.from(document.styleSheets).map(sheet => sheet.href).filter(Boolean),
        pdfRuntime: window.essayFlowPdfRuntime ? {
          workerSrc: window.essayFlowPdfRuntime.workerSrc,
          cMapUrl: window.essayFlowPdfRuntime.cMapUrl,
          standardFontDataUrl: window.essayFlowPdfRuntime.standardFontDataUrl,
          cMapPacked: window.essayFlowPdfRuntime.cMapPacked,
          isEvalSupported: window.essayFlowPdfRuntime.isEvalSupported
        } : null,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''
      };
    })()`);
    assert.equal(renderer.title, 'EssayFlow');
    assert.equal(renderer.projectCount, 0);
    assert.equal(renderer.editorEnabled, true);
    assert.equal(renderer.quillVersion, '1.3.6');
    assert.equal(renderer.scriptSources.every(source => source.startsWith('file:')), true);
    assert.equal(renderer.styleSources.every(source => source.startsWith('file:')), true);
    assert.ok(renderer.pdfRuntime, `PDF runtime missing: ${JSON.stringify({ renderer, exceptions: driver.exceptions, securityErrors: driver.securityErrors }, null, 2)}`);
    assert.match(renderer.pdfRuntime.workerSrc, /^file:/);
    assert.match(renderer.pdfRuntime.cMapUrl, /^file:/);
    assert.match(renderer.pdfRuntime.standardFontDataUrl, /^file:/);
    assert.match(renderer.csp, /script-src 'self'/);
    assert.equal(driver.profileReport.profileIsolated, true);
    assert.equal(driver.profileReport.networkBlocked, true);
    assert.equal(path.resolve(driver.profileReport.activeUserData), path.resolve(profileRoot));
    assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
    assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

    const defaultProfileKey = path.resolve(driver.profileReport.defaultUserData).toLowerCase();
    const before = beforeSnapshots.get(defaultProfileKey);
    assert.ok(before, `Default userData was not snapshotted before launch: ${driver.profileReport.defaultUserData}`);
    await driver.close();
    driver = null;
    const after = snapshotProfile(before.path);
    const comparison = compareProfileSnapshots(before, after);
    assert.equal(comparison.unchanged, true, comparison.differences.join('\n'));

    const sourceTree = createSourceTreeManifest(root);
    const output = {
      schemaVersion: 1,
      target,
      applicationPath: applicationPath ? path.resolve(applicationPath) : null,
      startedAt,
      completedAt: new Date().toISOString(),
      sourceTreeSha256: sourceTree.sourceTreeSha256,
      isolatedProfile: profileRoot,
      defaultProfile: before.path,
      defaultProfileBefore: {
        fileCount: before.fileCount,
        contentTreeSha256: before.contentTreeSha256
      },
      defaultProfileAfter: {
        fileCount: after.fileCount,
        contentTreeSha256: after.contentTreeSha256
      },
      defaultProfileUnchanged: comparison.unchanged,
      renderer,
      profileReport: driver?.profileReport || JSON.parse(fs.readFileSync(reportPath, 'utf8')),
      passed: true
    };
    const artifactPath = path.join(root, 'artifacts', 'm0', `smoke-${target}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
    console.log(`Electron ${target} smoke passed.`);
    console.log(`isolatedProfile=${profileRoot}`);
    console.log(`defaultProfileUnchanged=true`);
    console.log(`report=${artifactPath}`);
  } finally {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
