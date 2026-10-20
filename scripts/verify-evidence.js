#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function read(relative) { const file = path.join(root, relative); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
function main() {
  const run = read('artifacts/release-run.json');
  if (!run) throw new Error('release-run.json is missing');
  const source = createSourceTreeManifest(root);
  const required = [
    'artifacts/quality-summary.json', 'artifacts/migration-matrix.json', 'artifacts/crash-matrix.json',
    'artifacts/ipc-fuzz.json', 'artifacts/integrity-report.json', 'artifacts/perf-baseline.json',
    'artifacts/offline-network-trace.json', 'artifacts/package-asset-manifest.json',
    'artifacts/dependency-audit.json', 'artifacts/sbom.json', 'artifacts/a11y/report.json',
    'artifacts/a11y/library-responsive-report.json',
    'artifacts/e2e/m5/report.json', 'artifacts/artifact-win-unpacked.json',
    'artifacts/artifact-portable.json', 'artifacts/artifact-nsis.json'
  ];
  const missing = required.filter(relative => !fs.existsSync(path.join(root, relative)));
  const reports = required.filter(relative => !missing.includes(relative)).map(relative => ({ path: relative, sha256: shaFile(path.join(root, relative)) }));
  const artifactReports = ['win-unpacked', 'portable', 'nsis'].map(target => read(`artifacts/artifact-${target}.json`)).filter(Boolean);
  const quality = read('artifacts/quality-summary.json');
  const offline = read('artifacts/offline-network-trace.json');
  const dependency = read('artifacts/dependency-verification.json');
  const failures = [
    ...missing.map(item => `缺少发布证据 ${item}`),
    ...(run.sourceTreeSha256 === source.sourceTreeSha256 ? [] : ['release run sourceTreeSha256 已过期']),
    ...(quality?.passed === true && quality.gate === 'm5' && quality.sourceTreeSha256 === source.sourceTreeSha256 ? [] : ['M5 quality summary 未同源通过']),
    ...(artifactReports.length === 3 ? [] : ['三个 artifact report 不完整']),
    ...(artifactReports.every(item => item.buildRunId === run.buildRunId && item.sourceTreeSha256 === source.sourceTreeSha256) ? [] : ['artifact report build/source 绑定不一致']),
    ...(offline?.buildRunId === run.buildRunId && offline?.sourceTreeSha256 === source.sourceTreeSha256 ? [] : ['offline report build/source 绑定不一致']),
    ...(offline?.passed ? [] : ['offline 门禁未通过']),
    ...(dependency?.passed ? [] : ['dependency 门禁未通过']),
    ...(artifactReports.every(item => item.passed) ? [] : ['一个或多个 artifact 门禁未通过']),
    ...(['artifacts/perf-baseline.json', 'artifacts/integrity-report.json'].flatMap(relative => {
      const value = read(relative);
      return value?.buildRunId === run.buildRunId && value?.sourceTreeSha256 === source.sourceTreeSha256
        ? [] : [`${relative} 未绑定本次 buildRunId/sourceTreeSha256`];
    })),
    ...(read('artifacts/perf-baseline.json')?.milestone === 'm2'
      ? ['perf-baseline 仍是 M2 5000 条文库基线，未覆盖 release 的 30/20 样本、D1/L1/F1、冷暖启动和内存/静置指标'] : []),
    ...(fs.existsSync(path.join(root, 'artifacts', 'integrity-random.json'))
      ? [] : ['未生成并验证 release 要求的 10,000 操作随机完整性报告 artifacts/integrity-random.json'])
  ];
  const win = artifactReports.find(item => item.target === 'win-unpacked');
  const portable = artifactReports.find(item => item.target === 'portable');
  const nsis = artifactReports.find(item => item.target === 'nsis');
  const evidence = {
    schemaVersion: 1, buildRunId: run.buildRunId, sourceTreeSha256: source.sourceTreeSha256,
    sourceTreeManifestSha256: crypto.createHash('sha256').update(source.canonicalManifest, 'utf8').digest('hex'),
    knownDirtyUntracked: { available: false, reason: '当前环境没有可靠 Git metadata；全部实际构建输入已由 canonical source tree 纳入' },
    packageLockSha256: shaFile(path.join(root, 'package-lock.json')),
    fixtureManifestSha256: shaFile(path.join(root, 'test', 'fixtures', 'fixture-manifest.json')),
    coverageBaselineSha256: shaFile(path.join(root, 'test', 'baseline', 'coverage.json')),
    environment: { node: process.version, npm: run.environment?.npm || '', electron: require(path.join(root, 'node_modules', 'electron', 'package.json')).version, os: `${os.platform()} ${os.release()} ${os.arch()}` },
    commands: run.steps, appPayloadSha256: win?.appPayloadSha256 || null,
    winUnpackedTreeSha256: win?.winUnpackedTreeSha256 || null,
    targets: {
      portable: portable ? { targetArtifactSha256: portable.targetArtifactSha256, appPayloadSha256: portable.extractedAppPayloadSha256 } : null,
      nsis: nsis ? { targetArtifactSha256: nsis.targetArtifactSha256, appPayloadSha256: nsis.extractedAppPayloadSha256 } : null
    },
    reports, failures, passed: failures.length === 0
  };
  fs.writeFileSync(path.join(artifacts, 'release-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}
main();
