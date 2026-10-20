'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  COVERAGE_THRESHOLDS,
  compareAcceptedBaseline,
  coverageArguments,
  discoverTestFiles,
  parseArguments,
  parseLcov,
  readAcceptedBaseline,
  runSuite,
  summarizeCoverage,
  validateCoverage
} = require('../../scripts/run-tests');

const RUNNER = path.resolve(__dirname, '..', '..', 'scripts', 'run-tests.js');
const DISCARD_OUTPUT = Object.freeze({ write() {} });

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-run-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTest(root, suite, relativePath = 'fixture.test.js') {
  const filePath = path.join(root, 'test', suite, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "const test = require('node:test'); test('fixture', () => {});\n");
  return filePath;
}

function sampleLcov(metrics = {}) {
  const lines = metrics.lines || [90, 100];
  const functions = metrics.functions || [9, 10];
  const branches = metrics.branches || [8, 10];
  return [
    'TN:',
    'SF:scripts\\lib\\synthetic.js',
    `FNF:${functions[1]}`,
    `FNH:${functions[0]}`,
    `BRF:${branches[1]}`,
    `BRH:${branches[0]}`,
    `LF:${lines[1]}`,
    `LH:${lines[0]}`,
    'end_of_record',
    ''
  ].join('\n');
}

function coverageStub(lcov, status = 0) {
  return (_executable, args) => {
    const destination = args
      .filter(argument => argument.startsWith('--test-reporter-destination='))
      .map(argument => argument.slice('--test-reporter-destination='.length))
      .find(value => value !== 'stdout');
    if (destination) fs.writeFileSync(destination, lcov);
    return { status, error: null };
  };
}

test('argument parser supports suites and explicit baseline updates only', () => {
  assert.deepEqual(parseArguments([]), { suite: 'unit', help: false, updateBaseline: false });
  assert.deepEqual(parseArguments(['--suite', 'e2e']), {
    suite: 'e2e',
    help: false,
    updateBaseline: false
  });
  assert.deepEqual(parseArguments(['--update-baseline']), {
    suite: 'unit',
    help: false,
    updateBaseline: true
  });
  assert.equal(parseArguments(['--help']).help, true);
  assert.equal(parseArguments(['-h']).help, true);
  assert.deepEqual(parseArguments(['--suite', 'integrity', '--operations', '10000', '--seed', '20260716']), {
    suite: 'integrity', help: false, updateBaseline: false, operations: 10000, seed: 20260716
  });
  assert.throws(() => parseArguments(['--suite', 'unit', '--operations', '10']), /only valid for the integrity suite/);
  assert.throws(() => parseArguments(['--suite']), /requires a name/);
  assert.throws(() => parseArguments(['--suite', '../escape']), /Invalid suite name/);
  assert.throws(() => parseArguments(['--suite', 'e2e', '--update-baseline']), /only valid for the unit suite/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});

test('test discovery is recursive, sorted and limited to .test.js files', t => {
  const root = temporaryRoot(t);
  const second = writeTest(root, 'unit', 'nested/z.test.js');
  const first = writeTest(root, 'unit', 'a.test.js');
  fs.writeFileSync(path.join(root, 'test', 'unit', 'ignored.js'), 'throw new Error();\n');
  assert.deepEqual(discoverTestFiles(root, 'unit'), [first, second]);
  assert.deepEqual(discoverTestFiles(root, 'missing'), []);
  assert.throws(() => discoverTestFiles(root, '..'), /Invalid suite name/);

  const fileSuite = path.join(root, 'test', 'file-suite');
  fs.writeFileSync(fileSuite, 'not a directory');
  assert.throws(() => discoverTestFiles(root, 'file-suite'), /not a directory/);
});

test('LCOV parser and summary aggregate lines, functions and branches', () => {
  const records = parseLcov(sampleLcov());
  assert.equal(records.length, 1);
  assert.equal(records[0].file, 'scripts/lib/synthetic.js');
  const summary = summarizeCoverage(records);
  assert.deepEqual(summary.totals.lines, { found: 100, hit: 90, percent: 90 });
  assert.deepEqual(summary.totals.functions, { found: 10, hit: 9, percent: 90 });
  assert.deepEqual(summary.totals.branches, { found: 10, hit: 8, percent: 80 });
  assert.deepEqual(validateCoverage(summary), []);

  const noCounters = summarizeCoverage(parseLcov([
    'SF:scripts/empty.js',
    'FNF:0', 'FNH:0', 'BRF:0', 'BRH:0', 'LF:0', 'LH:0',
    'end_of_record', ''
  ].join('\n')));
  assert.equal(noCounters.totals.functions.percent, 100);
  assert.ok(validateCoverage(noCounters).includes('coverage contains no executable lines'));
});

test('LCOV parser rejects truncated, orphaned and empty reports', () => {
  assert.throws(() => parseLcov('SF:fixture.js\nLF:1\nLH:1\n'), /missing end_of_record/);
  assert.throws(() => parseLcov('end_of_record\n'), /without SF/);
  assert.throws(() => parseLcov('TN:\n'), /contains no source records/);
  assert.throws(
    () => parseLcov('SF:first.js\nSF:second.js\nend_of_record\n'),
    /missing end_of_record/
  );
});

test('coverage validation reports every hard-threshold failure', () => {
  const summary = summarizeCoverage(parseLcov(sampleLcov({
    lines: [84, 100],
    functions: [8, 10],
    branches: [7, 10]
  })));
  assert.deepEqual(validateCoverage(summary), [
    'lines 84.00% < 85.00%',
    'functions 80.00% < 85.00%',
    'branches 70.00% < 80.00%'
  ]);
  assert.deepEqual(COVERAGE_THRESHOLDS, { lines: 85, functions: 85, branches: 80 });
});

test('accepted baseline parser validates schema and detects regressions over 2pp', t => {
  const root = temporaryRoot(t);
  const baselinePath = path.join(root, 'coverage.json');
  assert.equal(readAcceptedBaseline(baselinePath), null);
  fs.writeFileSync(baselinePath, '{');
  assert.throws(() => readAcceptedBaseline(baselinePath), /invalid JSON/);
  fs.writeFileSync(baselinePath, JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => readAcceptedBaseline(baselinePath), /unsupported schema/);
  fs.writeFileSync(baselinePath, JSON.stringify({
    schemaVersion: 1,
    suite: 'unit',
    metrics: { lines: 90, functions: 90 }
  }));
  assert.throws(() => readAcceptedBaseline(baselinePath), /missing metric: branches/);

  const baseline = {
    schemaVersion: 1,
    suite: 'unit',
    metrics: { lines: 92.5, functions: 93, branches: 84 }
  };
  fs.writeFileSync(baselinePath, JSON.stringify(baseline));
  assert.deepEqual(readAcceptedBaseline(baselinePath), baseline);
  const current = summarizeCoverage(parseLcov(sampleLcov()));
  assert.deepEqual(compareAcceptedBaseline(current, baseline), [
    'lines regressed 2.50pp (baseline 92.50%, current 90.00%)',
    'functions regressed 3.00pp (baseline 93.00%, current 90.00%)',
    'branches regressed 4.00pp (baseline 84.00%, current 80.00%)'
  ]);
  assert.deepEqual(compareAcceptedBaseline(current, null), [
    'accepted coverage baseline is missing; run with --update-baseline'
  ]);
  assert.deepEqual(compareAcceptedBaseline(current, {
    ...baseline,
    metrics: { lines: 92, functions: 92, branches: 82 }
  }), []);
});

test('coverage arguments use native Node coverage and paired LCOV reporting', () => {
  const args = coverageArguments(path.join('artifacts', 'coverage', 'lcov.info'));
  assert.ok(args.includes('--experimental-test-coverage'));
  assert.ok(args.includes('--test-coverage-lines=85'));
  assert.ok(args.includes('--test-coverage-functions=85'));
  assert.ok(args.includes('--test-coverage-branches=80'));
  assert.ok(args.includes('--test-reporter=spec'));
  assert.ok(args.includes('--test-reporter=lcov'));
});

test('non-unit suite is reusable and does not create coverage output', t => {
  const root = temporaryRoot(t);
  writeTest(root, 'e2e', 'nested/smoke.test.js');
  let invocation;
  const result = runSuite({
    rootDir: root,
    suite: 'e2e',
    spawnImplementation(executable, args, options) {
      invocation = { executable, args, options };
      return { status: 0, error: null };
    },
    now: () => new Date('2026-07-16T00:00:00.000Z')
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.coverage, null);
  assert.ok(invocation.args.includes('--test-reporter=spec'));
  assert.equal(invocation.args.includes('--experimental-test-coverage'), false);
  assert.equal(fs.existsSync(path.join(root, 'artifacts', 'coverage')), false);
});

test('unit suite updates accepted baseline only when explicitly requested', t => {
  const root = temporaryRoot(t);
  writeTest(root, 'unit');
  const now = () => new Date('2026-07-16T00:00:00.000Z');
  const update = runSuite({
    rootDir: root,
    suite: 'unit',
    updateBaseline: true,
    spawnImplementation: coverageStub(sampleLcov()),
    now,
    stdout: DISCARD_OUTPUT,
    stderr: DISCARD_OUTPUT
  });
  assert.equal(update.exitCode, 0);
  const acceptedPath = path.join(root, 'test', 'baseline', 'coverage.json');
  const acceptedBytes = fs.readFileSync(acceptedPath);
  const accepted = JSON.parse(acceptedBytes);
  assert.deepEqual(accepted.metrics, { lines: 90, functions: 90, branches: 80 });

  const compare = runSuite({
    rootDir: root,
    suite: 'unit',
    spawnImplementation: coverageStub(sampleLcov()),
    now,
    stdout: DISCARD_OUTPUT,
    stderr: DISCARD_OUTPUT
  });
  assert.equal(compare.exitCode, 0);
  assert.deepEqual(fs.readFileSync(acceptedPath), acceptedBytes);
  const current = JSON.parse(fs.readFileSync(compare.summaryPath, 'utf8'));
  assert.equal(current.baselineMode, 'compare');
  assert.equal(current.passed, true);
});

test('unit suite fails regression and never accepts a failing update', t => {
  const root = temporaryRoot(t);
  writeTest(root, 'unit');
  const baselinePath = path.join(root, 'test', 'baseline', 'coverage.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify({
    schemaVersion: 1,
    suite: 'unit',
    metrics: { lines: 95, functions: 95, branches: 90 }
  }));
  const result = runSuite({
    rootDir: root,
    suite: 'unit',
    spawnImplementation: coverageStub(sampleLcov()),
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    stdout: DISCARD_OUTPUT,
    stderr: DISCARD_OUTPUT
  });
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(fs.readFileSync(result.summaryPath, 'utf8'));
  assert.equal(report.passed, false);
  assert.ok(report.failures.some(failure => /regressed/.test(failure)));

  const failingRoot = temporaryRoot(t);
  writeTest(failingRoot, 'unit');
  const failedUpdate = runSuite({
    rootDir: failingRoot,
    suite: 'unit',
    updateBaseline: true,
    spawnImplementation: coverageStub(sampleLcov({
      lines: [80, 100],
      functions: [8, 10],
      branches: [7, 10]
    }), 1),
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    stdout: DISCARD_OUTPUT,
    stderr: DISCARD_OUTPUT
  });
  assert.equal(failedUpdate.exitCode, 1);
  assert.equal(fs.existsSync(path.join(failingRoot, 'test', 'baseline', 'coverage.json')), false);
});

test('runner fails for zero tests, missing LCOV and child process errors', t => {
  const root = temporaryRoot(t);
  assert.throws(() => runSuite({ rootDir: root, suite: 'unit' }), /No tests found/);
  writeTest(root, 'unit');
  assert.throws(() => runSuite({
    rootDir: root,
    suite: 'unit',
    spawnImplementation: () => ({ status: 0, error: null })
  }), /did not produce LCOV/);

  writeTest(root, 'e2e');
  assert.throws(() => runSuite({
    rootDir: root,
    suite: 'e2e',
    spawnImplementation: () => ({ status: null, error: new Error('synthetic spawn failure') })
  }), /synthetic spawn failure/);

  const processResult = spawnSync(process.execPath, [RUNNER, '--suite', 'definitely-empty-suite'], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8'
  });
  assert.equal(processResult.status, 1);
  assert.match(processResult.stderr, /No tests found/);
});
