#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSourceTreeManifest } = require('./lib/source-tree');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_SUITE = 'unit';
const COVERAGE_THRESHOLDS = Object.freeze({
  lines: 85,
  functions: 85,
  branches: 80
});
const STRICT_COVERAGE_THRESHOLDS = Object.freeze({
  lines: 90,
  functions: 90,
  branches: 85
});
const COVERAGE_SUITES = Object.freeze({
  unit: COVERAGE_THRESHOLDS,
  citation: STRICT_COVERAGE_THRESHOLDS,
  'paper-normalize': STRICT_COVERAGE_THRESHOLDS,
  evidence: COVERAGE_THRESHOLDS,
  'trusted-ai': COVERAGE_THRESHOLDS,
  matrix: COVERAGE_THRESHOLDS,
  security: COVERAGE_THRESHOLDS
});
const COVERAGE_INCLUDES = Object.freeze({
  citation: [
    'src/main/citation/audit.js',
    'src/main/citation/engine.js',
    'src/main/citation/exchange.js'
  ],
  'paper-normalize': [
    'src/main/citation/model.js',
    'src/main/citation/merge.js'
  ],
  evidence: [
    'src/main/evidence/evidence-service.js'
  ],
  'trusted-ai': [
    'src/main/ai/model.js',
    'src/main/ai/trusted-ai-service.js'
  ],
  matrix: [
    'src/main/matrix/matrix-service.js',
    'src/main/matrix/matrix-export.js'
  ],
  security: [
    'src/main/ai/secure-transport.js'
  ]
});

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function parseArguments(argv) {
  const options = { suite: DEFAULT_SUITE, help: false, updateBaseline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--suite') {
      const suite = argv[index + 1];
      if (!suite || suite.startsWith('-')) throw new Error('--suite requires a name');
      options.suite = suite;
      index += 1;
      continue;
    }
    if (argument === '--update-baseline') {
      options.updateBaseline = true;
      continue;
    }
    if (argument === '--operations' || argument === '--seed') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${argument} requires a positive integer`);
      options[argument === '--operations' ? 'operations' : 'seed'] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.suite)) {
    throw new Error(`Invalid suite name: ${options.suite}`);
  }
  if (options.updateBaseline && options.suite !== 'unit') {
    throw new Error('--update-baseline is only valid for the unit suite');
  }
  if ((options.operations !== undefined || options.seed !== undefined) && options.suite !== 'integrity') {
    throw new Error('--operations and --seed are only valid for the integrity suite');
  }
  return options;
}

function discoverTestFiles(rootDir, suite) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(suite)) {
    throw new Error(`Invalid suite name: ${suite}`);
  }
  const suiteDirectory = path.join(rootDir, 'test', suite);
  if (!fs.existsSync(suiteDirectory)) return [];
  if (!fs.statSync(suiteDirectory).isDirectory()) {
    throw new Error(`Test suite path is not a directory: ${suiteDirectory}`);
  }

  const result = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Test suite cannot contain symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        result.push(absolutePath);
      }
    }
  }
  visit(suiteDirectory);
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

function emptyCounter() {
  return { found: 0, hit: 0 };
}

function parseLcov(content) {
  const records = [];
  let current = null;
  for (const rawLine of String(content).split(/\r?\n/)) {
    if (!rawLine) continue;
    const separator = rawLine.indexOf(':');
    const key = separator >= 0 ? rawLine.slice(0, separator) : rawLine;
    const value = separator >= 0 ? rawLine.slice(separator + 1) : '';
    if (key === 'SF') {
      if (current) throw new Error(`LCOV record missing end_of_record: ${current.file}`);
      current = {
        file: toPosixPath(value),
        lines: emptyCounter(),
        functions: emptyCounter(),
        branches: emptyCounter()
      };
      continue;
    }
    if (key === 'end_of_record') {
      if (!current) throw new Error('LCOV contains end_of_record without SF');
      records.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    if (key === 'LF') current.lines.found = Number(value);
    else if (key === 'LH') current.lines.hit = Number(value);
    else if (key === 'FNF') current.functions.found = Number(value);
    else if (key === 'FNH') current.functions.hit = Number(value);
    else if (key === 'BRF') current.branches.found = Number(value);
    else if (key === 'BRH') current.branches.hit = Number(value);
  }
  if (current) throw new Error(`LCOV record missing end_of_record: ${current.file}`);
  if (!records.length) throw new Error('LCOV report contains no source records');
  return records;
}

function percentage(counter) {
  if (!counter.found) return 100;
  return Number(((counter.hit / counter.found) * 100).toFixed(2));
}

function summarizeCoverage(records) {
  const totals = {
    lines: emptyCounter(),
    functions: emptyCounter(),
    branches: emptyCounter()
  };
  const files = records.map(record => {
    for (const metric of Object.keys(totals)) {
      totals[metric].found += record[metric].found;
      totals[metric].hit += record[metric].hit;
    }
    return {
      file: record.file,
      lines: { ...record.lines, percent: percentage(record.lines) },
      functions: { ...record.functions, percent: percentage(record.functions) },
      branches: { ...record.branches, percent: percentage(record.branches) }
    };
  });
  for (const metric of Object.keys(totals)) {
    totals[metric].percent = percentage(totals[metric]);
  }
  return { totals, files };
}

function validateCoverage(summary, thresholds = COVERAGE_THRESHOLDS) {
  const failures = [];
  if (summary.totals.lines.found === 0) failures.push('coverage contains no executable lines');
  for (const metric of ['lines', 'functions', 'branches']) {
    const actual = summary.totals[metric].percent;
    const required = thresholds[metric];
    if (actual < required) failures.push(`${metric} ${actual.toFixed(2)}% < ${required.toFixed(2)}%`);
  }
  return failures;
}

function readAcceptedBaseline(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Coverage baseline is invalid JSON: ${error.message}`);
  }
  if (baseline?.schemaVersion !== 1 || baseline?.suite !== 'unit' || !baseline.metrics) {
    throw new Error('Coverage baseline has an unsupported schema');
  }
  for (const metric of ['lines', 'functions', 'branches']) {
    if (!Number.isFinite(baseline.metrics[metric])) {
      throw new Error(`Coverage baseline is missing metric: ${metric}`);
    }
  }
  return baseline;
}

function compareAcceptedBaseline(summary, baseline, maximumDrop = 2) {
  if (!baseline) return ['accepted coverage baseline is missing; run with --update-baseline'];
  const failures = [];
  for (const metric of ['lines', 'functions', 'branches']) {
    const accepted = baseline.metrics[metric];
    const actual = summary.totals[metric].percent;
    const drop = Number((accepted - actual).toFixed(2));
    if (drop > maximumDrop) {
      failures.push(`${metric} regressed ${drop.toFixed(2)}pp (baseline ${accepted.toFixed(2)}%, current ${actual.toFixed(2)}%)`);
    }
  }
  return failures;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function coverageArguments(lcovPath, thresholds = COVERAGE_THRESHOLDS, includes = []) {
  return [
    '--experimental-test-coverage',
    `--test-coverage-lines=${thresholds.lines}`,
    `--test-coverage-functions=${thresholds.functions}`,
    `--test-coverage-branches=${thresholds.branches}`,
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    ...includes.map(value => `--test-coverage-include=${value}`)
  ];
}

function runSuite(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const suite = options.suite || DEFAULT_SUITE;
  const spawnImplementation = options.spawnImplementation || spawnSync;
  const updateBaseline = options.updateBaseline === true;
  const now = options.now || (() => new Date());
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const testFiles = discoverTestFiles(rootDir, suite);
  if (!testFiles.length) throw new Error(`No tests found for suite: ${suite}`);

  const relativeTests = testFiles.map(file => toPosixPath(path.relative(rootDir, file)));
  const args = ['--test'];
  const thresholds = COVERAGE_SUITES[suite] || null;
  const coverageEnabled = Boolean(thresholds);
  const coverageDirectory = suite === 'unit'
    ? path.join(rootDir, 'artifacts', 'coverage')
    : path.join(rootDir, 'artifacts', 'coverage', suite);
  const lcovPath = path.join(coverageDirectory, 'lcov.info');
  const summaryPath = path.join(coverageDirectory, 'coverage-summary.json');
  const baselinePath = path.join(rootDir, 'test', 'baseline', 'coverage.json');
  if (coverageEnabled) {
    fs.mkdirSync(coverageDirectory, { recursive: true });
    fs.rmSync(lcovPath, { force: true });
    args.push(...coverageArguments(lcovPath, thresholds, COVERAGE_INCLUDES[suite] || []));
  } else {
    args.push('--test-reporter=spec');
  }
  args.push(...relativeTests);

  const startedAt = now().toISOString();
  const result = spawnImplementation(process.execPath, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...(options.operations ? { ESSAYFLOW_INTEGRITY_OPERATIONS: String(options.operations) } : {}),
      ...(options.seed ? { ESSAYFLOW_INTEGRITY_SEED: String(options.seed) } : {})
    },
    stdio: 'inherit'
  });
  const finishedAt = now().toISOString();
  const processExitCode = Number.isInteger(result.status) ? result.status : 1;
  if (result.error) throw result.error;

  if (!coverageEnabled) {
    return { suite, testFiles: relativeTests, exitCode: processExitCode, coverage: null };
  }
  if (!fs.existsSync(lcovPath)) {
    throw new Error(`Node test runner did not produce LCOV: ${lcovPath}`);
  }

  const coverage = summarizeCoverage(parseLcov(fs.readFileSync(lcovPath, 'utf8')));
  const thresholdFailures = validateCoverage(coverage, thresholds);
  let acceptedBaseline = null;
  let regressionFailures = [];
  if (suite === 'unit' && !updateBaseline) {
    acceptedBaseline = readAcceptedBaseline(baselinePath);
    regressionFailures = compareAcceptedBaseline(coverage, acceptedBaseline);
  }
  const failures = [...thresholdFailures, ...regressionFailures];
  if (updateBaseline && (processExitCode !== 0 || thresholdFailures.length)) {
    failures.push('accepted baseline was not updated because tests or hard thresholds failed');
  }
  const passed = processExitCode === 0 && failures.length === 0;
  const sourceTree = createSourceTreeManifest(rootDir);
  const currentReport = {
    schemaVersion: 1,
    suite,
    generatedAt: finishedAt,
    startedAt,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    thresholds,
    maximumBaselineDropPercentagePoints: 2,
    baselineMode: updateBaseline ? 'update' : 'compare',
    acceptedBaselinePath: toPosixPath(path.relative(rootDir, baselinePath)),
    acceptedBaselineMetrics: acceptedBaseline ? acceptedBaseline.metrics : null,
    passed,
    processExitCode,
    failures,
    testFiles: relativeTests,
    lcov: {
      path: toPosixPath(path.relative(rootDir, lcovPath)),
      sha256: sha256File(lcovPath)
    },
    coverage
  };
  atomicWriteJson(summaryPath, currentReport);

  if (updateBaseline) {
    if (passed) {
      const accepted = {
        schemaVersion: 1,
        suite: 'unit',
        updatedAt: finishedAt,
        nodeVersion: process.version,
        thresholds: COVERAGE_THRESHOLDS,
        maximumDropPercentagePoints: 2,
        sourceTreeSha256: sourceTree.sourceTreeSha256,
        sourceTreeFileCount: sourceTree.fileCount,
        metrics: {
          lines: coverage.totals.lines.percent,
          functions: coverage.totals.functions.percent,
          branches: coverage.totals.branches.percent
        },
        sourceFiles: coverage.files.map(file => file.file),
        lcovSha256: sha256File(lcovPath)
      };
      atomicWriteJson(baselinePath, accepted);
    }
  }

  stdout.write(
    `Coverage: lines ${coverage.totals.lines.percent.toFixed(2)}%, ` +
    `functions ${coverage.totals.functions.percent.toFixed(2)}%, ` +
    `branches ${coverage.totals.branches.percent.toFixed(2)}%\n`
  );
  stdout.write(`Coverage report: ${summaryPath}\n`);
  if (updateBaseline && processExitCode === 0 && thresholdFailures.length === 0) {
    stdout.write(`Accepted coverage baseline updated: ${baselinePath}\n`);
  }
  if (failures.length) {
    stderr.write(`Coverage gate failed: ${failures.join('; ')}\n`);
  }
  return {
    suite,
    testFiles: relativeTests,
    exitCode: processExitCode === 0 && failures.length === 0 ? 0 : 1,
    coverage,
    baselinePath,
    summaryPath,
    lcovPath
  };
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/run-tests.js [--suite <name>] [--update-baseline]\n' +
    'Discovers test/<name>/**/*.test.js. The unit suite enforces native Node coverage.\n' +
    'Only --update-baseline may write test/baseline/coverage.json.\n'
  );
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      printHelp();
      return 0;
    }
    return runSuite({ suite: options.suite, updateBaseline: options.updateBaseline, operations: options.operations, seed: options.seed }).exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  COVERAGE_THRESHOLDS,
  COVERAGE_SUITES,
  COVERAGE_INCLUDES,
  STRICT_COVERAGE_THRESHOLDS,
  compareAcceptedBaseline,
  coverageArguments,
  discoverTestFiles,
  main,
  parseArguments,
  parseLcov,
  readAcceptedBaseline,
  runSuite,
  summarizeCoverage,
  validateCoverage
};
