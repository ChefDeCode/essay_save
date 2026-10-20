const fs = require('fs');
const path = require('path');
const {
  createArchitectureBaseline,
  evaluateRatchet,
  scanArchitecture
} = require('./lib/architecture-ratchet');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const baselinePath = path.join(root, 'test', 'baseline', 'architecture.json');
const reportPath = path.join(root, 'artifacts', 'm0', 'architecture-report.json');
const updateBaseline = process.argv.includes('--update-baseline');

if (updateBaseline) {
  const baseline = createArchitectureBaseline(root, 'm0');
  const hardZeroFindings = baseline.findings.filter(finding => [
    'remote-executable-code',
    'inline-script',
    'inline-event-handler',
    'unsafe-script-csp'
  ].includes(finding.rule));
  if (hardZeroFindings.length) {
    console.error('Refusing to accept a baseline with M0 hard-zero violations.');
    hardZeroFindings.forEach(finding => console.error(`${finding.rule}: ${finding.file}: ${finding.snippet}`));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log(`Architecture baseline updated: ${baselinePath}`);
  console.log(`sourceTreeSha256=${baseline.sourceTreeSha256}`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(`Architecture baseline is missing: ${baselinePath}`);
  console.error('Create it explicitly with: node scripts/check-architecture.js --update-baseline');
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const currentFindings = scanArchitecture(root);
const evaluation = evaluateRatchet(currentFindings, baseline);
const sourceTree = createSourceTreeManifest(root);
const report = {
  schemaVersion: 1,
  milestone: baseline.milestone,
  passed: evaluation.passed,
  baselineSourceTreeSha256: baseline.sourceTreeSha256,
  sourceTreeSha256: sourceTree.sourceTreeSha256,
  sourceFileCount: sourceTree.fileCount,
  baselineFindingCount: (baseline.findings || []).reduce((sum, finding) => sum + finding.count, 0),
  currentFindingCount: evaluation.currentSummary.reduce((sum, finding) => sum + finding.count, 0),
  violations: evaluation.violations
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (!evaluation.passed) {
  console.error('Architecture ratchet failed. New or hard-zero violations:');
  evaluation.violations.forEach(violation => {
    console.error(`- ${violation.rule} ${violation.file}: ${violation.snippet}`);
  });
  process.exit(1);
}

console.log(`Architecture ratchet passed (${report.currentFindingCount} accepted debt occurrences, no additions).`);
console.log(`sourceTreeSha256=${sourceTree.sourceTreeSha256}`);
console.log(`report=${reportPath}`);
