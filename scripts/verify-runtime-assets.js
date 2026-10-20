'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  INDEX_REFERENCES,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_PACKAGES
} = require('./lib/runtime-assets');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function listFiles(directoryPath, basePath = directoryPath) {
  const result = [];
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`运行资产目录不允许符号链接：${absolutePath}`);
    }
    if (entry.isDirectory()) {
      result.push(...listFiles(absolutePath, basePath));
    } else if (entry.isFile()) {
      result.push({
        absolutePath,
        relativePath: toPortablePath(path.relative(basePath, absolutePath))
      });
    }
  }
  return result;
}

function parseCsp(content) {
  const directives = new Map();
  content.split(';').forEach((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) directives.set(tokens[0].toLowerCase(), tokens.slice(1));
  });
  return directives;
}

function extractCsp(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const cspTag = metaTags.find((tag) => /http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag));
  if (!cspTag) return null;
  const contentMatch = cspTag.match(/content\s*=\s*"([^"]*)"/i)
    || cspTag.match(/content\s*=\s*'([^']*)'/i);
  return contentMatch ? contentMatch[1] : null;
}

function validateIndexPolicy(rootPath, errors) {
  const indexPath = path.join(rootPath, 'src', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  for (const reference of INDEX_REFERENCES) {
    if (!html.includes(reference)) errors.push(`index.html 未引用本地运行资产：${reference}`);
  }

  const remoteElements = html.match(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:\/\/[^>]*>/gi) || [];
  if (remoteElements.length) errors.push(`index.html 包含 ${remoteElements.length} 个远程脚本或样式入口`);
  if (/\b(?:cdn|cdnjs|unpkg|jsdelivr)\b/i.test(html)) errors.push('index.html 仍包含 CDN 地址');

  const inlineScripts = html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  if (inlineScripts.length) errors.push(`index.html 包含 ${inlineScripts.length} 个内联脚本`);
  const inlineHandlers = html.match(/\son[a-z]+\s*=/gi) || [];
  if (inlineHandlers.length) errors.push(`index.html 包含 ${inlineHandlers.length} 个内联事件处理器`);

  const cspContent = extractCsp(html);
  if (!cspContent) {
    errors.push('index.html 缺少 Content-Security-Policy');
    return { content: null, directives: {} };
  }

  const csp = parseCsp(cspContent);
  const scriptSrc = csp.get('script-src') || [];
  const objectSrc = csp.get('object-src') || [];
  if (scriptSrc.length !== 1 || scriptSrc[0] !== "'self'") {
    errors.push("CSP script-src 必须严格为 'self'");
  }
  if (scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'")) {
    errors.push('CSP script-src 不允许 unsafe-inline 或 unsafe-eval');
  }
  if (objectSrc.length !== 1 || objectSrc[0] !== "'none'") {
    errors.push("CSP object-src 必须严格为 'none'");
  }

  return { content: cspContent, directives: Object.fromEntries(csp) };
}

function validatePdfRuntime(rootPath, errors) {
  const runtimePath = path.join(rootPath, 'src', 'pdf-runtime.js');
  const source = fs.readFileSync(runtimePath, 'utf8');
  if (/https?:\/\//i.test(source)) errors.push('pdf-runtime.js 包含远程 URL');

  let receivedOptions = null;
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument(options) {
      receivedOptions = options;
      return options;
    }
  };
  const context = vm.createContext({
    URL,
    window: {
      location: { href: 'file:///C:/EssayFlow/resources/app.asar/src/index.html' },
      pdfjsLib
    }
  });

  try {
    vm.runInContext(source, context, { filename: 'pdf-runtime.js' });
    vm.runInContext("window.essayFlowGetPdfDocument('file:///C:/papers/example.pdf')", context);
  } catch (error) {
    errors.push(`pdf-runtime.js 执行校验失败：${error.message}`);
  }

  const workerSrc = pdfjsLib.GlobalWorkerOptions.workerSrc || '';
  if (!/\/node_modules\/pdfjs-dist\/build\/pdf\.worker\.min\.js$/i.test(workerSrc)) {
    errors.push('PDF.js worker 未指向本地运行资产');
  }
  if (!receivedOptions || !/\/node_modules\/pdfjs-dist\/cmaps\/$/i.test(receivedOptions.cMapUrl || '')) {
    errors.push('PDF.js getDocument 未注入本地 cMapUrl');
  }
  if (!receivedOptions || receivedOptions.cMapPacked !== true) {
    errors.push('PDF.js getDocument 未启用打包 cMap');
  }
  if (!receivedOptions || receivedOptions.isEvalSupported !== false) {
    errors.push('PDF.js getDocument 未禁用动态代码生成');
  }
  if (!receivedOptions || !/\/node_modules\/pdfjs-dist\/standard_fonts\/$/i.test(receivedOptions.standardFontDataUrl || '')) {
    errors.push('PDF.js getDocument 未注入本地 standardFontDataUrl');
  }

  return {
    cMapUrl: receivedOptions && receivedOptions.cMapUrl,
    cMapPacked: receivedOptions && receivedOptions.cMapPacked,
    isEvalSupported: receivedOptions && receivedOptions.isEvalSupported,
    standardFontDataUrl: receivedOptions && receivedOptions.standardFontDataUrl,
    workerSrc
  };
}

function inspectRuntimeAssets(rootPath = path.resolve(__dirname, '..')) {
  const resolvedRoot = path.resolve(rootPath);
  const errors = [];
  const files = [];
  const directories = [];
  const packages = [];

  for (const asset of RUNTIME_FILES) {
    const absolutePath = path.join(resolvedRoot, asset.relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      errors.push(`缺少运行资产：${asset.relativePath}`);
      continue;
    }
    const contents = fs.readFileSync(absolutePath);
    if (!contents.length) errors.push(`运行资产为空：${asset.relativePath}`);
    files.push({ ...asset, bytes: contents.length, sha256: sha256(contents) });
  }

  for (const asset of RUNTIME_DIRECTORIES) {
    const absolutePath = path.join(resolvedRoot, asset.relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
      errors.push(`缺少运行资产目录：${asset.relativePath}`);
      continue;
    }
    try {
      const entries = listFiles(absolutePath);
      if (entries.length !== asset.expectedFileCount) {
        errors.push(`${asset.relativePath} 文件数应为 ${asset.expectedFileCount}，实际为 ${entries.length}`);
      }
      const treeInput = entries.map((entry) => {
        const contents = fs.readFileSync(entry.absolutePath);
        return `${entry.relativePath}\0${contents.length}\0${sha256(contents)}\n`;
      }).join('');
      directories.push({
        ...asset,
        fileCount: entries.length,
        sha256: sha256(treeInput)
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const expected of RUNTIME_PACKAGES) {
    const packagePath = path.join(resolvedRoot, 'node_modules', expected.name, 'package.json');
    if (!fs.existsSync(packagePath)) {
      errors.push(`缺少运行依赖清单：${expected.name}`);
      continue;
    }
    try {
      const actual = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
      packages.push({ ...expected, actualVersion: actual });
      if (actual !== expected.version) {
        errors.push(`${expected.name} 版本应为 ${expected.version}，实际为 ${actual || 'unknown'}`);
      }
    } catch (error) {
      errors.push(`${expected.name} package.json 无法解析：${error.message}`);
    }
  }

  const csp = validateIndexPolicy(resolvedRoot, errors);
  const pdfRuntime = validatePdfRuntime(resolvedRoot, errors);
  return {
    ok: errors.length === 0,
    root: resolvedRoot,
    files,
    directories,
    packages,
    csp,
    pdfRuntime,
    errors
  };
}

if (require.main === module) {
  const rootFlagIndex = process.argv.indexOf('--root');
  const rootPath = rootFlagIndex >= 0 && process.argv[rootFlagIndex + 1]
    ? process.argv[rootFlagIndex + 1]
    : path.resolve(__dirname, '..');
  const report = inspectRuntimeAssets(rootPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

module.exports = {
  extractCsp,
  inspectRuntimeAssets,
  parseCsp
};
