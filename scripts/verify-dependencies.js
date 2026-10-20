#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const npmCli = process.env.npm_execpath;

function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  if (!npmCli || !fs.existsSync(npmCli)) throw new Error('npm CLI path is unavailable');
  const auditRun = spawnSync(process.execPath, [npmCli, 'audit', '--omit=dev', '--audit-level=high', '--json'], {
    cwd: root, encoding: 'utf8', shell: false, maxBuffer: 50 * 1024 * 1024
  });
  let audit;
  try { audit = JSON.parse(auditRun.stdout || '{}'); } catch (_) { audit = { parseError: true, rawStderr: auditRun.stderr }; }
  const vulnerabilities = audit.metadata?.vulnerabilities || {};
  const auditReport = {
    schemaVersion: 1,
    command: 'npm audit --omit=dev --audit-level=high --json',
    exitCode: auditRun.status ?? 1,
    vulnerabilities,
    raw: audit
  };
  fs.writeFileSync(path.join(artifacts, 'dependency-audit.json'), `${JSON.stringify(auditReport, null, 2)}\n`);

  const packages = Object.entries(lock.packages || {})
    .filter(([name, value]) => name && value && value.dev !== true)
    .map(([name, value]) => ({
      path: name.replace(/^node_modules\//, ''), name: value.name || name.split('node_modules/').at(-1),
      version: value.version || '', license: value.license || 'UNKNOWN', resolved: value.resolved || ''
    })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const source = createSourceTreeManifest(root);
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1, metadata: { component: { type: 'application', name: pkg.name, version: pkg.version } },
    components: packages.map(item => ({ type: 'library', name: item.name, version: item.version, properties: [{ name: 'lockPath', value: item.path }] })),
    sourceTreeSha256: source.sourceTreeSha256
  };
  fs.writeFileSync(path.join(artifacts, 'sbom.json'), `${JSON.stringify(sbom, null, 2)}\n`);
  fs.writeFileSync(path.join(artifacts, 'third-party-licenses.json'), `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`);

  const installedElectron = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
  const electronMajor = Number(installedElectron.split('.')[0]);
  const supportedMajorsAsOf20260717 = [41, 42, 43];
  const electronSupported = supportedMajorsAsOf20260717.includes(electronMajor);
  const highOrCritical = Number(vulnerabilities.high || 0) + Number(vulnerabilities.critical || 0);
  const lockRoot = lock.packages?.[''] || {};
  const lockConsistent = JSON.stringify(lockRoot.dependencies || {}) === JSON.stringify(pkg.dependencies || {}) &&
    JSON.stringify(lockRoot.devDependencies || {}) === JSON.stringify(pkg.devDependencies || {});
  const report = {
    schemaVersion: 1, sourceTreeSha256: source.sourceTreeSha256,
    packageLockSha256: sha(fs.readFileSync(lockPath)), lockfileVersion: lock.lockfileVersion, lockConsistent,
    electron: {
      installedVersion: installedElectron, supported: electronSupported, supportedMajorsAsOf: '2026-07-17',
      supportedMajors: supportedMajorsAsOf20260717,
      policyUrl: 'https://www.electronjs.org/docs/latest/tutorial/electron-timelines',
      releasesUrl: 'https://releases.electronjs.org/'
    },
    runtimePackageCount: packages.length, highOrCritical, auditExitCode: auditReport.exitCode,
    failures: [
      ...(!lockConsistent ? ['package.json 与 package-lock root 声明不一致'] : []),
      ...(!electronSupported ? [`Electron ${installedElectron} 不在官方最新三个稳定 major 41/42/43 内`] : []),
      ...(highOrCritical ? [`运行时依赖存在 ${highOrCritical} 个 high/critical 漏洞且无书面限期豁免`] : []),
      ...(audit.parseError ? ['npm audit JSON 无法解析'] : [])
    ]
  };
  report.passed = report.failures.length === 0;
  fs.writeFileSync(path.join(artifacts, 'dependency-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main();
