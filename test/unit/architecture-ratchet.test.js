const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  createArchitectureBaseline,
  evaluateRatchet,
  scanArchitecture,
  summarizeFindings
} = require('../../scripts/lib/architecture-ratchet');

function makeProject(t, html = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'; object-src \'none\'"><script src="app.js"></script>') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-architecture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.html'), html);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "localStorage.setItem('legacy', '1');\n");
  fs.writeFileSync(path.join(root, 'main.js'), "ipcMain.on('legacy', handler);\nfs.writeFileSync(file, value);\n");
  fs.writeFileSync(path.join(root, 'preload.js'), '');
  return root;
}

test('ratchet accepts existing debt and rejects a new occurrence', t => {
  const root = makeProject(t);
  const baseline = createArchitectureBaseline(root);
  const initial = evaluateRatchet(scanArchitecture(root), baseline);
  assert.equal(initial.passed, true);

  fs.appendFileSync(path.join(root, 'src', 'app.js'), "localStorage.setItem('new-key', '2');\n");
  const changed = evaluateRatchet(scanArchitecture(root), baseline);
  assert.equal(changed.passed, false);
  assert.equal(changed.violations.some(item => item.rule === 'renderer-business-localstorage'), true);
});

test('ratchet permits debt removal without rewriting the baseline', t => {
  const root = makeProject(t);
  const baseline = createArchitectureBaseline(root);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const value = 1;\n');
  const result = evaluateRatchet(scanArchitecture(root), baseline);
  assert.equal(result.passed, true);
  assert.ok(result.currentSummary.length < baseline.findings.length);
});

test('remote scripts, inline handlers and unsafe CSP are hard-zero rules', t => {
  const root = makeProject(t, '<script>window.bad = true</script><script src="https://cdn.example/app.js"></script><img onerror="bad()">');
  const findings = scanArchitecture(root);
  const rules = new Set(findings.map(finding => finding.rule));
  assert.ok(rules.has('inline-script'));
  assert.ok(rules.has('remote-executable-code'));
  assert.ok(rules.has('inline-event-handler'));
  assert.ok(rules.has('unsafe-script-csp'));

  const permissiveBaseline = { findings: summarizeFindings(findings) };
  const result = evaluateRatchet(findings, permissiveBaseline);
  assert.equal(result.passed, false);
  assert.equal(result.violations.every(item => item.hardZero), true);
});

test('CSP ratchet requires exact self-only scripts and object-src none', t => {
  const root = makeProject(t,
    '<meta http-equiv="Content-Security-Policy" content="script-src \'self\' https://cdn.example; object-src \'self\'">' +
    '<script src="app.js"></script>'
  );
  const findings = scanArchitecture(root);
  assert.equal(findings.some(finding => finding.rule === 'unsafe-script-csp'), true);
});
