const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const artifactsRoot = path.join(root, 'artifacts');
const supportedMilestones = new Set(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function commandDisplay(command, args) {
  return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function runStep(name, command, args) {
  const startedAt = new Date().toISOString();
  const display = commandDisplay(command, args);
  process.stdout.write(`\n[gate] ${name}: ${display}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const report = {
    name,
    command: display,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode,
    stdoutSha256: crypto.createHash('sha256').update(result.stdout || '', 'utf8').digest('hex'),
    stderrSha256: crypto.createHash('sha256').update(result.stderr || '', 'utf8').digest('hex')
  };
  if (result.error) report.spawnError = result.error.message;
  return report;
}

function m0Steps() {
  const appPath = path.join(root, 'dist', 'win-unpacked', 'EssayFlow.exe');
  return [
    ['fixtures', process.execPath, ['scripts/generate-fixtures.js', '--check']],
    ['runtime-assets', process.execPath, ['scripts/verify-runtime-assets.js']],
    ['architecture', process.execPath, ['scripts/check-architecture.js']],
    ['unit', process.execPath, ['scripts/run-tests.js', '--suite', 'unit']],
    ['smoke-development', process.execPath, ['scripts/run-electron-smoke.js', '--target', 'development']],
    ['e2e-development', process.execPath, ['scripts/run-tests.js', '--suite', 'e2e']],
    ['build-win-unpacked', process.execPath, ['scripts/build.js', '--dir']],
    ['verify-win-unpacked', process.execPath, ['scripts/verify-package.js', '--app', appPath]],
    ['smoke-win-unpacked', process.execPath, ['scripts/run-electron-smoke.js', '--app', appPath, '--target', 'win-unpacked']]
  ];
}

function milestoneSteps(milestone) {
  const steps = m0Steps();
  if (['m1', 'm2', 'm3', 'm4', 'm5'].includes(milestone)) {
    steps.push(
      ['repository', process.execPath, ['scripts/run-tests.js', '--suite', 'repository']],
      ['migration', process.execPath, ['scripts/run-tests.js', '--suite', 'migration']],
      ['upgrade', process.execPath, ['scripts/run-tests.js', '--suite', 'upgrade']],
      ['crash', process.execPath, ['scripts/run-tests.js', '--suite', 'crash']],
      ['integrity', process.execPath, ['scripts/run-tests.js', '--suite', 'integrity']],
      ['verify-data', process.execPath, ['scripts/verify-data.js', '--profile', 'test/fixtures/workspaces/acceptance', '--deep']],
      ['m1-e2e', process.execPath, ['scripts/run-tests.js', '--suite', 'm1-e2e']]
    );
  }
  if (['m2', 'm3', 'm4', 'm5'].includes(milestone)) {
    steps.push(
      ['citation', process.execPath, ['scripts/run-tests.js', '--suite', 'citation']],
      ['paper-normalize', process.execPath, ['scripts/run-tests.js', '--suite', 'paper-normalize']],
      ['ipc', process.execPath, ['scripts/run-tests.js', '--suite', 'ipc']],
      ['m2-performance', process.execPath, ['scripts/test-performance.js']],
      ['m2-e2e', process.execPath, ['scripts/run-tests.js', '--suite', 'm2-e2e']]
    );
  }
  if (['m3', 'm4', 'm5'].includes(milestone)) {
    steps.push(
      ['evidence', process.execPath, ['scripts/run-tests.js', '--suite', 'evidence']],
      ['m3-e2e', process.execPath, ['scripts/run-tests.js', '--suite', 'm3-e2e']]
    );
  }
  if (['m4', 'm5'].includes(milestone)) {
    steps.push(
      ['trusted-ai', process.execPath, ['scripts/run-tests.js', '--suite', 'trusted-ai']],
      ['security', process.execPath, ['scripts/run-tests.js', '--suite', 'security']],
      ['m4-e2e', process.execPath, ['scripts/run-tests.js', '--suite', 'm4-e2e']]
    );
  }
  if (milestone === 'm5') {
    steps.push(
      ['matrix', process.execPath, ['scripts/run-tests.js', '--suite', 'matrix']],
      ['m5-performance', process.execPath, ['scripts/test-m5-performance.js']],
      ['a11y', process.execPath, ['scripts/run-tests.js', '--suite', 'a11y']],
      ['m5-e2e', process.execPath, ['scripts/run-tests.js', '--suite', 'm5-e2e']]
    );
  }
  return steps;
}

function main() {
  const milestone = String(readOption('--milestone', 'm0')).toLowerCase();
  if (!/^m[0-5]$/.test(milestone)) {
    throw new Error(`Unknown milestone: ${milestone}`);
  }
  if (!supportedMilestones.has(milestone)) {
    throw new Error(`${milestone.toUpperCase()} has not been implemented or accepted. Refusing to report a future gate as passed.`);
  }

  fs.mkdirSync(artifactsRoot, { recursive: true });
  const report = {
    schemaVersion: 1,
    gate: milestone,
    startedAt: new Date().toISOString(),
    passed: false,
    steps: []
  };
  const reportPath = path.join(artifactsRoot, 'quality-summary.json');

  for (const [name, command, args] of milestoneSteps(milestone)) {
    const step = runStep(name, command, args);
    report.steps.push(step);
    if (step.exitCode !== 0) {
      report.completedAt = new Date().toISOString();
      report.failedStep = name;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
      throw new Error(`Gate ${milestone} failed at ${name} (exit ${step.exitCode}).`);
    }
  }

  const evidenceFiles = [
    path.join(artifactsRoot, 'coverage', 'lcov.info'),
    path.join(artifactsRoot, 'coverage', 'coverage-summary.json'),
    path.join(artifactsRoot, 'm0', 'architecture-report.json'),
    path.join(artifactsRoot, 'm0', 'smoke-development.json'),
    path.join(artifactsRoot, 'm0', 'smoke-win-unpacked.json'),
    path.join(artifactsRoot, 'e2e', 'm0', 'report.json'),
    path.join(artifactsRoot, 'package-asset-manifest.json')
  ];
  if (['m1', 'm2', 'm3', 'm4', 'm5'].includes(milestone)) {
    evidenceFiles.push(
      path.join(artifactsRoot, 'migration-matrix.json'),
      path.join(artifactsRoot, 'crash-matrix.json'),
      path.join(artifactsRoot, 'integrity-report.json'),
      path.join(artifactsRoot, 'e2e', 'm1', 'report.json')
    );
  }
  if (['m2', 'm3', 'm4', 'm5'].includes(milestone)) {
    evidenceFiles.push(
      path.join(artifactsRoot, 'coverage', 'citation', 'lcov.info'),
      path.join(artifactsRoot, 'coverage', 'citation', 'coverage-summary.json'),
      path.join(artifactsRoot, 'coverage', 'paper-normalize', 'lcov.info'),
      path.join(artifactsRoot, 'coverage', 'paper-normalize', 'coverage-summary.json'),
      path.join(artifactsRoot, 'ipc-fuzz.json'),
      path.join(artifactsRoot, 'perf-baseline.json'),
      path.join(artifactsRoot, 'e2e', 'm2', 'report.json')
    );
  }
  if (['m3', 'm4', 'm5'].includes(milestone)) {
    evidenceFiles.push(
      path.join(artifactsRoot, 'coverage', 'evidence', 'lcov.info'),
      path.join(artifactsRoot, 'coverage', 'evidence', 'coverage-summary.json'),
      path.join(artifactsRoot, 'e2e', 'm3', 'report.json')
    );
  }
  if (['m4', 'm5'].includes(milestone)) {
    evidenceFiles.push(
      path.join(artifactsRoot, 'coverage', 'trusted-ai', 'lcov.info'),
      path.join(artifactsRoot, 'coverage', 'trusted-ai', 'coverage-summary.json'),
      path.join(artifactsRoot, 'coverage', 'security', 'lcov.info'),
      path.join(artifactsRoot, 'coverage', 'security', 'coverage-summary.json'),
      path.join(artifactsRoot, 'e2e', 'm4', 'report.json')
    );
  }
  if (milestone === 'm5') {
    evidenceFiles.push(
      path.join(artifactsRoot, 'coverage', 'matrix', 'lcov.info'),
      path.join(artifactsRoot, 'coverage', 'matrix', 'coverage-summary.json'),
      path.join(artifactsRoot, 'm5-performance.json'),
      path.join(artifactsRoot, 'a11y', 'report.json'),
      path.join(artifactsRoot, 'a11y', 'library-responsive-report.json'),
      path.join(artifactsRoot, 'e2e', 'm5', 'report.json')
    );
  }
  const missing = evidenceFiles.filter(filePath => !fs.existsSync(filePath));
  if (missing.length) {
    report.completedAt = new Date().toISOString();
    report.failedStep = 'evidence-completeness';
    report.missingEvidence = missing.map(filePath => path.relative(root, filePath).split(path.sep).join('/'));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    throw new Error(`${milestone.toUpperCase()} evidence is incomplete: ${report.missingEvidence.join(', ')}`);
  }
  const sourceTree = createSourceTreeManifest(root);
  const boundReports = evidenceFiles.filter(filePath => path.extname(filePath).toLowerCase() === '.json');
  const stale = boundReports.filter(filePath => {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Object.prototype.hasOwnProperty.call(value, 'sourceTreeSha256') &&
      value.sourceTreeSha256 !== sourceTree.sourceTreeSha256;
  });
  if (stale.length) {
    report.completedAt = new Date().toISOString();
    report.failedStep = 'evidence-source-binding';
    report.sourceTreeSha256 = sourceTree.sourceTreeSha256;
    report.staleEvidence = stale.map(filePath => path.relative(root, filePath).split(path.sep).join('/'));
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    throw new Error(`${milestone.toUpperCase()} evidence is bound to stale source: ${report.staleEvidence.join(', ')}`);
  }
  report.sourceTreeSha256 = sourceTree.sourceTreeSha256;
  report.sourceTreeFileCount = sourceTree.fileCount;
  report.evidence = evidenceFiles.map(filePath => ({
    path: path.relative(root, filePath).split(path.sep).join('/'),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath)
  }));
  report.passed = true;
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(`\nGate ${milestone} passed.\nreport=${reportPath}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}
