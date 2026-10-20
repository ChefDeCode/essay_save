'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  INDEX_REFERENCES,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_PACKAGES
} = require('../../scripts/lib/runtime-assets');
const {
  extractCsp,
  inspectRuntimeAssets,
  parseCsp
} = require('../../scripts/verify-runtime-assets');

const projectRoot = path.resolve(__dirname, '..', '..');

test('运行资产清单中的 ID 和路径唯一', () => {
  const entries = [...RUNTIME_FILES, ...RUNTIME_DIRECTORIES];
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.equal(new Set(entries.map((entry) => entry.relativePath)).size, entries.length);
  assert.equal(new Set(INDEX_REFERENCES).size, INDEX_REFERENCES.length);
  assert.equal(new Set(RUNTIME_PACKAGES.map((entry) => entry.name)).size, RUNTIME_PACKAGES.length);
});

test('运行资产完整且页面没有远程可执行回退', () => {
  const report = inspectRuntimeAssets(projectRoot);
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.equal(report.files.length, RUNTIME_FILES.length);
  assert.equal(report.directories.length, RUNTIME_DIRECTORIES.length);
  assert.equal(report.packages.length, RUNTIME_PACKAGES.length);
});

test('CSP 严格限制脚本与 object', () => {
  const report = inspectRuntimeAssets(projectRoot);
  assert.deepEqual(report.csp.directives['script-src'], ["'self'"]);
  assert.deepEqual(report.csp.directives['object-src'], ["'none'"]);
});

test('PDF.js 始终注入本地 worker、cMap 和标准字体', () => {
  const report = inspectRuntimeAssets(projectRoot);
  assert.match(report.pdfRuntime.workerSrc, /\/node_modules\/pdfjs-dist\/build\/pdf\.worker\.min\.js$/i);
  assert.match(report.pdfRuntime.cMapUrl, /\/node_modules\/pdfjs-dist\/cmaps\/$/i);
  assert.match(report.pdfRuntime.standardFontDataUrl, /\/node_modules\/pdfjs-dist\/standard_fonts\/$/i);
  assert.equal(report.pdfRuntime.cMapPacked, true);
  assert.equal(report.pdfRuntime.isEvalSupported, false);
});

test('运行资产校验对缺失、远程和不安全页面配置全部 fail closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-runtime-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.html'), [
    '<meta http-equiv="Content-Security-Policy" ' +
      'content="script-src \'self\' \'unsafe-inline\'; object-src \'self\'">',
    '<script src="https://cdn.example.invalid/runtime.js"></script>',
    '<link href="https://cdnjs.example.invalid/runtime.css" rel="stylesheet">',
    '<script>window.syntheticInline = true;</script>',
    '<button onclick="window.syntheticHandler = true">Fixture</button>'
  ].join('\n'));
  fs.writeFileSync(
    path.join(root, 'src', 'pdf-runtime.js'),
    "const remoteFixture = 'https://example.invalid/pdf-worker.js'; throw new Error('synthetic runtime failure');\n"
  );

  const report = inspectRuntimeAssets(root);
  assert.equal(report.ok, false);
  const errors = report.errors.join('\n');
  assert.match(errors, /缺少运行资产/);
  assert.match(errors, /缺少运行资产目录/);
  assert.match(errors, /缺少运行依赖清单/);
  assert.match(errors, /远程脚本或样式入口/);
  assert.match(errors, /CDN 地址/);
  assert.match(errors, /内联脚本/);
  assert.match(errors, /内联事件处理器/);
  assert.match(errors, /script-src 必须严格/);
  assert.match(errors, /unsafe-inline/);
  assert.match(errors, /object-src 必须严格/);
  assert.match(errors, /pdf-runtime\.js 包含远程 URL/);
  assert.match(errors, /执行校验失败/);
  assert.match(errors, /worker 未指向本地运行资产/);
  assert.match(errors, /未注入本地 cMapUrl/);
  assert.match(errors, /未启用打包 cMap/);
  assert.match(errors, /未禁用动态代码生成/);
  assert.match(errors, /未注入本地 standardFontDataUrl/);
});

test('CSP parser handles single quotes, empty directives and missing policy', t => {
  const parsed = parseCsp("default-src 'none'; script-src 'self'; ; object-src 'none'");
  assert.deepEqual(parsed.get('script-src'), ["'self'"]);
  assert.deepEqual(parsed.get('object-src'), ["'none'"]);
  assert.equal(extractCsp('<html><head></head></html>'), null);
  assert.equal(
    extractCsp("<meta http-equiv='Content-Security-Policy' content='script-src self'>"),
    'script-src self'
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-runtime-no-csp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.html'), '<html><body>synthetic fixture</body></html>');
  fs.writeFileSync(path.join(root, 'src', 'pdf-runtime.js'), 'window.fixture = true;\n');
  const report = inspectRuntimeAssets(root);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /缺少 Content-Security-Policy/);
  assert.deepEqual(report.csp.directives, {});
});
