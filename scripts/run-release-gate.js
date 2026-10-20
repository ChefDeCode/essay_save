#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('npm CLI path is unavailable');
const npmCommand = process.execPath;
const npmArgs = args => [npmCli, ...args];
function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const source = createSourceTreeManifest(root);
  const npmVersionRun = spawnSync(npmCommand, npmArgs(['--version']), { cwd: root, encoding: 'utf8', shell: false });
  const npmVersion = String(npmVersionRun.stdout || '').trim();
  const report = {
    schemaVersion: 1, buildRunId: crypto.randomUUID(), sourceTreeSha256: source.sourceTreeSha256,
    startedAt: new Date().toISOString(), passed: false, environment: { node: process.version, npm: npmVersion }, steps: []
  };
  const runPath = path.join(artifacts, 'release-run.json');
  const write = () => fs.writeFileSync(runPath, `${JSON.stringify(report, null, 2)}\n`);
  write();
  const env = { ...process.env, ESSAYFLOW_BUILD_RUN_ID: report.buildRunId, ESSAYFLOW_SOURCE_TREE_SHA256: source.sourceTreeSha256, FORCE_COLOR: '0' };
  const steps = [
    ['npm-ci', npmCommand, npmArgs(['ci'])],
    ['gate-m5', npmCommand, npmArgs(['run', 'gate:m5'])],
    ['build-win-unpacked', npmCommand, npmArgs(['run', 'build', '--', '--dir'])],
    ['verify-package', npmCommand, npmArgs(['run', 'verify:package', '--', '--app', path.join(root, 'dist', 'win-unpacked', 'EssayFlow.exe')])],
    ['offline', npmCommand, npmArgs(['run', 'test:offline', '--', '--app', path.join(root, 'dist', 'win-unpacked', 'EssayFlow.exe')])],
    ['build-windows-artifacts', npmCommand, npmArgs(['run', 'build'])],
    ['artifact-win-unpacked', npmCommand, npmArgs(['run', 'test:artifact', '--', '--target', 'win-unpacked'])],
    ['artifact-portable', npmCommand, npmArgs(['run', 'test:artifact', '--', '--target', 'portable'])],
    ['artifact-nsis', npmCommand, npmArgs(['run', 'test:artifact', '--', '--target', 'nsis'])],
    ['packaged-performance', npmCommand, npmArgs(['run', 'test:perf', '--', '--app', path.join(root, 'dist', 'win-unpacked', 'EssayFlow.exe')])],
    ['verify-data', npmCommand, npmArgs(['run', 'verify:data', '--', '--profile', 'test/fixtures/workspaces/acceptance', '--deep'])],
    ['integrity-10000', npmCommand, npmArgs(['run', 'test:integrity', '--', '--operations', '10000', '--seed', '20260716'])],
    ['dependencies', npmCommand, npmArgs(['run', 'verify:dependencies'])],
    ['verify-evidence', npmCommand, npmArgs(['run', 'verify:evidence'])]
  ];
  for (const [name, command, args] of steps) {
    const startedAt = new Date().toISOString();
    process.stdout.write(`\n[release] ${name}: ${command} ${args.join(' ')}\n`);
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', shell: false, timeout: 30 * 60_000, maxBuffer: 100 * 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    report.steps.push({
      name, command: [command, ...args].join(' '), startedAt, completedAt: new Date().toISOString(), exitCode: result.status ?? 1,
      stdoutSha256: crypto.createHash('sha256').update(result.stdout || '', 'utf8').digest('hex'),
      stderrSha256: crypto.createHash('sha256').update(result.stderr || '', 'utf8').digest('hex'),
      ...(result.error ? { spawnError: result.error.message } : {})
    });
    write();
  }
  report.completedAt = new Date().toISOString();
  report.failedSteps = report.steps.filter(step => step.exitCode !== 0).map(step => step.name);
  report.passed = report.failedSteps.length === 0;
  write();
  fs.writeFileSync(path.join(artifacts, 'release-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
main();
