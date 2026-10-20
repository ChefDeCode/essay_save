const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSourceTreeManifest } = require('./source-tree');
const { extractCsp, parseCsp } = require('../verify-runtime-assets');

const HARD_ZERO_RULES = new Set([
  'remote-executable-code',
  'inline-script',
  'inline-event-handler',
  'unsafe-script-csp'
]);

function normalizeSnippet(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 500);
}

function fingerprintFinding(finding) {
  return crypto.createHash('sha256')
    .update(`${finding.rule}\n${finding.file}\n${finding.snippet}`, 'utf8')
    .digest('hex');
}

function collectRuntimeFiles(rootPath) {
  const root = path.resolve(rootPath);
  const roots = [path.join(root, 'src')];
  const topLevel = [path.join(root, 'main.js'), path.join(root, 'preload.js')];
  const files = [];

  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && /\.(?:html|js)$/i.test(entry.name)) files.push(absolutePath);
    }
  }
  roots.forEach(visit);
  topLevel.filter(filePath => fs.existsSync(filePath)).forEach(filePath => files.push(filePath));
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function lineFindings(rootPath, absolutePath, rule, expression, predicate = () => true) {
  const root = path.resolve(rootPath);
  const file = path.relative(root, absolutePath).split(path.sep).join('/');
  const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  const findings = [];
  lines.forEach((line, index) => {
    expression.lastIndex = 0;
    if (expression.test(line) && predicate(line, absolutePath)) {
      findings.push({
        rule,
        file,
        line: index + 1,
        snippet: normalizeSnippet(line)
      });
    }
  });
  return findings;
}

function scanArchitecture(rootPath) {
  const root = path.resolve(rootPath);
  const files = collectRuntimeFiles(root);
  const findings = [];
  const htmlFiles = files.filter(filePath => filePath.endsWith('.html'));
  const rendererJs = files.filter(filePath => filePath.includes(`${path.sep}src${path.sep}`) && filePath.endsWith('.js'));
  const mainPath = path.join(root, 'main.js');
  const preloadPath = path.join(root, 'preload.js');

  for (const htmlPath of htmlFiles) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const file = path.relative(root, htmlPath).split(path.sep).join('/');
    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    while ((scriptMatch = scriptPattern.exec(html))) {
      const attributes = scriptMatch[1] || '';
      const body = scriptMatch[2] || '';
      const line = html.slice(0, scriptMatch.index).split(/\r?\n/).length;
      const sourceMatch = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!sourceMatch && body.trim()) {
        findings.push({ rule: 'inline-script', file, line, snippet: normalizeSnippet(body) });
      }
      if (sourceMatch && /^https?:\/\//i.test(sourceMatch[1])) {
        findings.push({ rule: 'remote-executable-code', file, line, snippet: normalizeSnippet(sourceMatch[1]) });
      }
    }
    const remoteStylePattern = /<link\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let remoteStyle;
    while ((remoteStyle = remoteStylePattern.exec(html))) {
      const line = html.slice(0, remoteStyle.index).split(/\r?\n/).length;
      findings.push({ rule: 'remote-executable-code', file, line, snippet: normalizeSnippet(remoteStyle[1]) });
    }
    const inlineHandlerPattern = /\s(on[a-z]+)\s*=\s*["']([^"']*)["']/gi;
    let inlineHandler;
    while ((inlineHandler = inlineHandlerPattern.exec(html))) {
      const line = html.slice(0, inlineHandler.index).split(/\r?\n/).length;
      findings.push({
        rule: 'inline-event-handler',
        file,
        line,
        snippet: normalizeSnippet(`${inlineHandler[1]}=${inlineHandler[2]}`)
      });
    }
    const cspContent = extractCsp(html);
    const csp = cspContent ? parseCsp(cspContent) : new Map();
    const scriptSrc = csp.get('script-src') || [];
    const objectSrc = csp.get('object-src') || [];
    if (scriptSrc.length !== 1 || scriptSrc[0] !== "'self'" ||
        objectSrc.length !== 1 || objectSrc[0] !== "'none'") {
      findings.push({
        rule: 'unsafe-script-csp',
        file,
        line: 1,
        snippet: normalizeSnippet(cspContent || 'missing Content-Security-Policy')
      });
    }
  }

  for (const filePath of rendererJs) {
    findings.push(...lineFindings(root, filePath, 'renderer-business-localstorage', /\blocalStorage\.setItem\s*\(/));
    findings.push(...lineFindings(root, filePath, 'renderer-secret-material', /\b(?:api_key|apiKey|Authorization)\b/));
    findings.push(...lineFindings(root, filePath, 'remote-executable-code', /https?:\/\/[^\s'"`]+(?:\.js|cdn|worker)/i));
  }
  if (fs.existsSync(mainPath)) {
    findings.push(...lineFindings(root, mainPath, 'main-direct-business-fs-write', /\bfs\.(?:appendFileSync|copyFileSync|mkdirSync|renameSync|rmSync|unlinkSync|writeFileSync)\s*\(/));
    findings.push(...lineFindings(root, mainPath, 'raw-ipc-registration', /\bipcMain\.(?:handle|on)\s*\(/));
  }
  if (fs.existsSync(preloadPath)) {
    findings.push(...lineFindings(root, preloadPath, 'preload-arbitrary-network-broker', /\b(?:netRequest|netStream)\s*:/));
    findings.push(...lineFindings(root, preloadPath, 'preload-path-write-capability', /\b(?:saveFile|saveProject|saveDocx)\s*:/));
    findings.push(...lineFindings(root, preloadPath, 'preload-secret-roundtrip', /\b(?:encryptApiKey|decryptApiKey)\s*:/));
  }

  return findings.map(finding => ({ ...finding, fingerprint: fingerprintFinding(finding) }));
}

function summarizeFindings(findings) {
  const summary = new Map();
  for (const finding of findings) {
    const existing = summary.get(finding.fingerprint) || {
      fingerprint: finding.fingerprint,
      rule: finding.rule,
      file: finding.file,
      snippet: finding.snippet,
      count: 0
    };
    existing.count += 1;
    summary.set(finding.fingerprint, existing);
  }
  return [...summary.values()].sort((left, right) =>
    `${left.rule}\n${left.file}\n${left.snippet}`.localeCompare(`${right.rule}\n${right.file}\n${right.snippet}`, 'en')
  );
}

function evaluateRatchet(currentFindings, baseline) {
  const baselineCounts = new Map((baseline.findings || []).map(item => [item.fingerprint, item.count]));
  const currentSummary = summarizeFindings(currentFindings);
  const violations = [];
  for (const finding of currentSummary) {
    const allowedCount = baselineCounts.get(finding.fingerprint) || 0;
    if (finding.count > allowedCount) {
      violations.push({ ...finding, allowedCount, addedCount: finding.count - allowedCount });
    }
  }
  for (const finding of currentSummary) {
    if (HARD_ZERO_RULES.has(finding.rule)) {
      violations.push({ ...finding, allowedCount: 0, addedCount: finding.count, hardZero: true });
    }
  }
  const deduplicated = new Map();
  violations.forEach(violation => deduplicated.set(violation.fingerprint, violation));
  return {
    passed: deduplicated.size === 0,
    violations: [...deduplicated.values()],
    currentSummary
  };
}

function createArchitectureBaseline(rootPath, milestone = 'm0') {
  const sourceTree = createSourceTreeManifest(rootPath);
  const findings = scanArchitecture(rootPath);
  return {
    schemaVersion: 1,
    milestone,
    capturedAt: new Date().toISOString(),
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceFileCount: sourceTree.fileCount,
    findings: summarizeFindings(findings)
  };
}

module.exports = {
  HARD_ZERO_RULES,
  collectRuntimeFiles,
  createArchitectureBaseline,
  evaluateRatchet,
  fingerprintFinding,
  normalizeSnippet,
  scanArchitecture,
  summarizeFindings
};
