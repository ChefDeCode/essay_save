const { app, BrowserWindow, Menu, MenuItem, dialog, ipcMain, net, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');
const { fileURLToPath, pathToFileURL } = require('url');
const { WorkspaceService } = require('./src/main/data/workspace-service');
const citationContracts = require('./src/main/ipc/citation-contracts');
const evidenceContracts = require('./src/main/ipc/evidence-contracts');
const aiContracts = require('./src/main/ipc/ai-contracts');
const matrixContracts = require('./src/main/ipc/matrix-contracts');
const { resolveAndValidate, secureTransport } = require('./src/main/ai/secure-transport');

let mainWindow;
let workspaceService = null;

const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TEXT = 8000;
const MAX_DOCX_XML_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const NETWORK_IDLE_TIMEOUT_MS = 45_000;
const authorizedSavePaths = new Map();
const activeDownloads = new Map();
const rendererEntryPath = path.resolve(__dirname, 'src', 'index.html');
const automationBlockedSessions = new WeakSet();
let automationCitationImportIndex = 0;

function getErrorMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return String(err || '未知错误');
}

function assertPlainObject(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}格式错误`);
  }
  return value;
}

function assertString(value, label, { maxLength = Infinity, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label}必须是字符串`);
  }
  if (value.length > maxLength) {
    throw new RangeError(`${label}过长`);
  }
  return value;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function decodeBase64(value, label, maxBytes) {
  assertString(value, label, { maxLength: Math.ceil(maxBytes / 3) * 4 + 8 });
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError(`${label}不是有效的 Base64 数据`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > maxBytes) {
    throw new RangeError(`${label}超过大小限制`);
  }
  return buffer;
}

function normalizePathForComparison(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertExistingFileInside(filePath, roots, extension) {
  assertString(filePath, '文件路径', { maxLength: 4096 });
  const resolved = path.resolve(filePath);
  if (!roots.some(root => isPathInside(root, resolved))) {
    throw new Error('拒绝访问应用管理目录之外的文件');
  }
  if (extension && path.extname(resolved).toLowerCase() !== extension) {
    throw new Error(`仅允许操作 ${extension} 文件`);
  }
  if (!fs.existsSync(resolved)) return resolved;
  const realFilePath = fs.realpathSync(resolved);
  const isInsideRealRoot = roots.some(root => {
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    return isPathInside(realRoot, realFilePath);
  });
  if (!isInsideRealRoot || !fs.statSync(realFilePath).isFile()) {
    throw new Error('文件路径不安全');
  }
  return realFilePath;
}

function sanitizeFileName(value, fallback, extension = '') {
  let name = typeof value === 'string' ? path.basename(value) : fallback;
  name = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = '_' + name;
  if (extension) {
    const extensionPattern = new RegExp(`\\${extension}$`, 'i');
    name = name.replace(extensionPattern, '') + extension;
  }
  if (name.length > 180) {
    const ext = path.extname(name);
    name = name.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  return name;
}

function atomicWriteFileSync(filePath, data, encoding) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, data, encoding);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
}

const AUTOMATION_FLAG = '--essayflow-automation';
const AUTOMATION_USER_DATA_OPTION = '--essayflow-user-data';
const AUTOMATION_PROFILE_REPORT_OPTION = '--essayflow-profile-report';
const AUTOMATION_EXPORT_FILE_NAMES = Object.freeze({
  pdf: 'EssayFlow.pdf',
  docx: 'EssayFlow.docx',
  essay: 'EssayFlow.essay',
  bib: 'EssayFlow-Library.bib',
  ris: 'EssayFlow-Library.ris',
  json: 'EssayFlow-Library.json',
  zip: 'EssayFlow-Matrix-CSV.zip',
  xlsx: 'EssayFlow-Matrix.xlsx'
});

function getCommandLineOption(argv, optionName) {
  let result;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value;
    if (argument === optionName) {
      value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${optionName} 必须提供路径`);
      }
      index += 1;
    } else if (argument.startsWith(`${optionName}=`)) {
      value = argument.slice(optionName.length + 1);
      if (!value) throw new Error(`${optionName} 必须提供路径`);
    } else {
      continue;
    }
    if (result !== undefined) throw new Error(`${optionName} 不能重复指定`);
    result = value;
  }
  return result;
}

function resolvePathThroughExistingAncestor(candidatePath) {
  const resolved = path.resolve(candidatePath);
  const missingSegments = [];
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`无法解析路径：${resolved}`);
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const stat = fs.statSync(ancestor);
  if (!stat.isDirectory()) throw new Error(`路径父级不是目录：${ancestor}`);
  return path.resolve(fs.realpathSync(ancestor), ...missingSegments);
}

function pathsOverlap(firstPath, secondPath) {
  return isPathInside(firstPath, secondPath) || isPathInside(secondPath, firstPath);
}

function assertAbsoluteOptionPath(value, optionName) {
  assertString(value, optionName, { maxLength: 4096 });
  if (value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${optionName} 必须是绝对路径`);
  }
  return path.resolve(value);
}

function resolveAutomationReportPath(requestedPath, activeUserData, defaultUserData) {
  const candidate = requestedPath
    ? assertAbsoluteOptionPath(requestedPath, AUTOMATION_PROFILE_REPORT_OPTION)
    : path.join(activeUserData, 'automation-profile-report.json');
  if (path.extname(candidate).toLowerCase() !== '.json') {
    throw new Error(`${AUTOMATION_PROFILE_REPORT_OPTION} 必须指向 .json 文件`);
  }

  const effectiveCandidate = resolvePathThroughExistingAncestor(candidate);
  const effectiveDefaultUserData = resolvePathThroughExistingAncestor(defaultUserData);
  const allowedRoots = [activeUserData, os.tmpdir()].map(resolvePathThroughExistingAncestor);
  if (!allowedRoots.some(root => isPathInside(root, effectiveCandidate)) ||
      isPathInside(effectiveDefaultUserData, effectiveCandidate)) {
    throw new Error('自动化 profile report 只能写入隔离 userData 或系统临时目录');
  }

  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  const realParent = fs.realpathSync(path.dirname(candidate));
  if (!allowedRoots.some(root => isPathInside(root, realParent))) {
    throw new Error('自动化 profile report 路径包含不安全的链接');
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('自动化 profile report 目标必须是普通文件');
    }
  }
  return candidate;
}

function configureAutomationProfile(argv, defaultUserData) {
  const enabled = argv.includes(AUTOMATION_FLAG);
  if (!enabled) {
    return Object.freeze({ enabled: false, defaultUserData, networkBlocked: false });
  }

  const requestedUserData = getCommandLineOption(argv, AUTOMATION_USER_DATA_OPTION);
  if (!requestedUserData) {
    throw new Error(`${AUTOMATION_FLAG} 必须同时指定 ${AUTOMATION_USER_DATA_OPTION}=<绝对路径>`);
  }

  const isolatedCandidate = assertAbsoluteOptionPath(requestedUserData, AUTOMATION_USER_DATA_OPTION);
  const effectiveDefaultUserData = resolvePathThroughExistingAncestor(defaultUserData);
  const effectiveIsolatedCandidate = resolvePathThroughExistingAncestor(isolatedCandidate);
  if (pathsOverlap(effectiveDefaultUserData, effectiveIsolatedCandidate)) {
    throw new Error('自动化 userData 不得与真实 userData 相同、包含或相互嵌套');
  }

  fs.mkdirSync(isolatedCandidate, { recursive: true });
  if (!fs.statSync(isolatedCandidate).isDirectory()) throw new Error('自动化 userData 不是目录');
  const activeUserData = fs.realpathSync(isolatedCandidate);
  if (pathsOverlap(effectiveDefaultUserData, activeUserData)) {
    throw new Error('自动化 userData 解析后与真实 userData 重叠');
  }

  const createManagedDirectory = name => {
    const directory = path.join(activeUserData, name);
    fs.mkdirSync(directory, { recursive: true });
    const realDirectory = fs.realpathSync(directory);
    if (!isPathInside(activeUserData, realDirectory)) {
      throw new Error(`自动化目录包含不安全的链接：${name}`);
    }
    return realDirectory;
  };
  const sessionData = createManagedDirectory('SessionData');
  const logs = createManagedDirectory('Logs');
  const crashDumps = createManagedDirectory('CrashDumps');
  const testExports = createManagedDirectory('TestExports');

  app.setPath('userData', activeUserData);
  app.setPath('sessionData', sessionData);
  app.setPath('crashDumps', crashDumps);
  app.setAppLogsPath(logs);

  const requestedReport = getCommandLineOption(argv, AUTOMATION_PROFILE_REPORT_OPTION);
  const reportPath = resolveAutomationReportPath(requestedReport, activeUserData, defaultUserData);
  const report = {
    schemaVersion: 1,
    automation: true,
    profileIsolated: true,
    networkBlocked: true,
    networkPolicy: {
      httpHttps: 'blocked',
      sessionResources: 'blocked',
      mainProcessNet: 'blocked',
      externalBrowserOpen: 'blocked',
      localFileAssets: 'allowed'
    },
    defaultUserData,
    activeUserData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    logs,
    crashDumps: app.getPath('crashDumps'),
    testExports,
    deterministicExports: Object.fromEntries(
      Object.entries(AUTOMATION_EXPORT_FILE_NAMES)
        .map(([type, fileName]) => [type, path.join(testExports, fileName)])
    ),
    reportPath,
    pid: process.pid,
    packaged: app.isPackaged,
    appVersion: app.getVersion()
  };
  atomicWriteFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`ESSAYFLOW_PROFILE_REPORT ${JSON.stringify(report)}`);

  return Object.freeze({
    enabled: true,
    defaultUserData,
    activeUserData,
    sessionData,
    logs,
    crashDumps,
    testExports,
    reportPath,
    networkBlocked: true
  });
}

const defaultUserDataPath = path.resolve(app.getPath('userData'));
const automationConfig = configureAutomationProfile(process.argv, defaultUserDataPath);

function createAutomationNetworkBlockedError(target) {
  const error = new Error(`自动化模式已阻止外部网络请求${target ? `：${target}` : ''}`);
  error.code = 'AUTOMATION_NETWORK_BLOCKED';
  return error;
}

function assertAutomationNetworkAllowed(target) {
  if (!automationConfig.enabled) return;
  const allowed = process.env.ESSAYFLOW_AUTOMATION_LOCAL_AI_ORIGIN;
  if (allowed && target) {
    try {
      const allowedUrl = new URL(allowed);
      const targetUrl = new URL(target);
      const hostname = allowedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
      if (loopback && allowedUrl.origin === allowed && targetUrl.origin === allowedUrl.origin) return;
    } catch (_) {}
  }
  throw createAutomationNetworkBlockedError(target);
}

function createExternalRequest(options) {
  const target = options && typeof options === 'object' ? options.url : options;
  assertAutomationNetworkAllowed(typeof target === 'string' ? target : undefined);
  return net.request(options);
}

function installAutomationNetworkBlock(electronSession) {
  if (!automationConfig.enabled || automationBlockedSessions.has(electronSession)) return;
  automationBlockedSessions.add(electronSession);
  electronSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      try {
        assertAutomationNetworkAllowed(details.url);
        callback({ cancel: false });
      } catch (_) {
        callback({ cancel: true });
      }
    }
  );
}

function getAutomationExportPath(extension) {
  const fileName = AUTOMATION_EXPORT_FILE_NAMES[extension];
  if (!automationConfig.enabled || !fileName) {
    throw new Error(`自动化模式不支持此保存类型：${extension || '未知'}`);
  }
  fs.mkdirSync(automationConfig.testExports, { recursive: true });
  const realExportRoot = fs.realpathSync(automationConfig.testExports);
  if (!isPathInside(automationConfig.activeUserData, realExportRoot)) {
    throw new Error('自动化导出目录已离开隔离 userData');
  }
  const filePath = path.join(realExportRoot, fileName);
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error('自动化导出目标不能是符号链接');
  }
  return filePath;
}

function getAutomationSaveDialogResult(options = {}) {
  const supportedExtensions = new Set(Object.keys(AUTOMATION_EXPORT_FILE_NAMES));
  const extension = (options.filters || [])
    .flatMap(filter => Array.isArray(filter.extensions) ? filter.extensions : [])
    .map(value => String(value).toLowerCase())
    .find(value => supportedExtensions.has(value));
  return { canceled: false, filePath: getAutomationExportPath(extension) };
}

function getAutomationOpenDialogResult(options = {}) {
  const allowedExtensions = new Set((options.filters || [])
    .flatMap(filter => Array.isArray(filter.extensions) ? filter.extensions : [])
    .map(value => String(value).toLowerCase()));
  if (![...allowedExtensions].some(extension => ['bib', 'bibtex', 'ris', 'json'].includes(extension))) return null;
  const configuredValues = String(process.env.ESSAYFLOW_AUTOMATION_CITATION_IMPORT || '').split(path.delimiter).filter(Boolean);
  const configured = configuredValues[automationCitationImportIndex++];
  if (!configured || !path.isAbsolute(configured)) throw new Error('自动化引用导入必须提供绝对 fixture 路径队列');
  const resolved = path.resolve(configured);
  if (!isPathInside(automationConfig.activeUserData, resolved)) throw new Error('自动化引用 fixture 必须位于隔离 userData 内');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('自动化引用 fixture 不存在');
  const extension = path.extname(resolved).slice(1).toLowerCase();
  if (!allowedExtensions.has(extension)) throw new Error('自动化引用 fixture 扩展名不受支持');
  return { canceled: false, filePaths: [resolved] };
}

function parseHttpUrl(value) {
  assertAutomationNetworkAllowed(typeof value === 'string' ? value : undefined);
  assertString(value, 'URL', { maxLength: 8192 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new TypeError('URL 格式错误');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅允许 http:// 或 https:// 协议');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL 不允许包含账号或密码');
  }
  return parsed.toString();
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame && event.senderFrame.url
    ? event.senderFrame.url
    : event.sender && event.sender.getURL();
  try {
    const parsed = new URL(senderUrl);
    if (parsed.protocol !== 'file:') throw new Error('protocol');
    parsed.hash = '';
    parsed.search = '';
    const senderPath = normalizePathForComparison(fileURLToPath(parsed));
    if (senderPath !== normalizePathForComparison(rendererEntryPath)) throw new Error('path');
  } catch (_) {
    throw new Error('拒绝来自非应用页面的 IPC 请求');
  }
}

function registerIpcHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    try {
      return await handler(event, ...args);
    } catch (err) {
      if (!err || err.code !== 'ABORTED') console.error(`[${channel}]`, err);
      throw err;
    }
  });
}

function requireWorkspaceService() {
  if (!workspaceService) throw new Error('工作区数据服务尚未初始化');
  return workspaceService;
}

function getDialogParent() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function showOpenDialog(options) {
  if (automationConfig.enabled) {
    const result = getAutomationOpenDialogResult(options);
    if (result) return Promise.resolve(result);
  }
  const parent = getDialogParent();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

function showSaveDialog(options) {
  if (automationConfig.enabled) return Promise.resolve(getAutomationSaveDialogResult(options));
  const parent = getDialogParent();
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}

async function openExternalTarget(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (['http:', 'https:'].includes(parsed.protocol)) {
      assertAutomationNetworkAllowed(parsed.toString());
      await shell.openExternal(parsed.toString());
      return;
    }
    if (parsed.protocol === 'file:') {
      initPaths();
      const filePath = assertExistingFileInside(fileURLToPath(parsed), [localPdfDir, downloadPdfDir, tempPdfDir], '.pdf');
      const error = await shell.openPath(filePath);
      if (error) console.warn('[openExternalTarget] 打开本地文件失败:', error);
    }
  } catch (err) {
    console.warn('[openExternalTarget] 已阻止不安全的链接:', getErrorMessage(err));
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webSecurity: true,
      spellcheck: true,
      navigateOnDragDrop: false,
      backgroundThrottling: !automationConfig.enabled,
    },
    titleBarStyle: 'default',
    title: 'EssayFlow',
    icon: path.join(__dirname, 'build/icon.png'),
  });
  mainWindow = window;

  window.once('ready-to-show', () => {
    if (!automationConfig.enabled) window.maximize();
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalTarget(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(rendererEntryPath).toString()) {
      event.preventDefault();
      void openExternalTarget(url);
    }
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  installAutomationNetworkBlock(window.webContents.session);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.loadFile(rendererEntryPath).catch(err => {
    console.error('[createWindow] 页面加载失败:', err);
  });

  // 拼写检查自定义词汇持久化
  const spellDictPath = path.join(app.getPath('userData'), 'dictionary.json');
  let customSpellDict = [];
  try {
    if (fs.existsSync(spellDictPath)) {
      customSpellDict = JSON.parse(fs.readFileSync(spellDictPath, 'utf-8'));
    }
  } catch (e) {
    console.warn('[spellDict] 加载失败:', e);
  }
  if (!Array.isArray(customSpellDict)) customSpellDict = [];
  customSpellDict = [...new Set(customSpellDict.filter(word => typeof word === 'string' && word.length > 0 && word.length <= 100))];
  customSpellDict.forEach(word => {
    window.webContents.session.addWordToSpellCheckerDictionary(word);
  });

  // 拼写检查右键菜单
  window.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    // 添加拼写建议
    if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
      params.dictionarySuggestions.forEach(suggestion => {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => {
            if (!window.isDestroyed()) window.webContents.replaceMisspelling(suggestion);
          }
        }));
      });
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // 忽略拼写 / 添加到词典
    if (params.misspelledWord) {
      menu.append(new MenuItem({
        label: `忽略 "${params.misspelledWord}"`,
        click: () => {
          if (window.isDestroyed()) return;
          window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
          // 持久化保存到 userData
          try {
            if (!customSpellDict.includes(params.misspelledWord) && params.misspelledWord.length <= 100) {
              customSpellDict.push(params.misspelledWord);
              atomicWriteFileSync(spellDictPath, JSON.stringify(customSpellDict, null, 2), 'utf-8');
            }
          } catch (e) {
            console.warn('[spellDict] 保存失败:', e);
          }
        }
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // 标准编辑菜单
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut' }));
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    menu.append(new MenuItem({ role: 'selectAll' }));

    menu.popup({ window });
  });

  const isMac = process.platform === 'darwin';

  const menuTemplate = [
    // macOS: 应用菜单
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 ' + app.name },
        { type: 'separator' },
        { role: 'quit', label: '退出 ' + app.name }
      ]
    }] : []),
    // 文件菜单
    {
      label: '文件',
      submenu: [
        ...(isMac ? [] : [{ role: 'quit', label: '退出' }])
      ],
    },
    // 编辑菜单（macOS 必须有，否则快捷键失效）
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    // 视图菜单
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [])
      ],
    },
    // macOS: 窗口菜单
    ...(isMac ? [{
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
        { type: 'separator' },
        { role: 'front', label: '全部前置' }
      ]
    }] : [])
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

// ================== 通用工具 ==================
let projectsDir = null;
let projectsIndexFile = null;
let localPdfDir = null;
let downloadPdfDir = null;
let tempPdfDir = null;
let imageDir = null;

function initPaths() {
  if (!projectsDir) {
    projectsDir = path.join(app.getPath('userData'), 'projects');
    projectsIndexFile = path.join(projectsDir, 'index.json');
    localPdfDir = path.join(app.getPath('userData'), 'localPdfs');
    downloadPdfDir = path.join(app.getPath('downloads'), 'EssayFlowPapers');
    tempPdfDir = path.join(app.getPath('temp'), 'EssayFlowPDFs');
    imageDir = path.join(app.getPath('userData'), 'images');
  }
}

function initProjectsDir() {
  initPaths();
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  if (!fs.existsSync(projectsIndexFile)) {
    atomicWriteFileSync(projectsIndexFile, '[]', 'utf-8');
  }
}

function assertProjectId(id) {
  assertString(id, '项目 ID', { maxLength: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error('项目 ID 格式错误');
  }
  return id;
}

function normalizeProjectEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  try { assertProjectId(entry.id); } catch (_) { return null; }
  const now = new Date().toISOString();
  const createdAt = Number.isNaN(Date.parse(entry.createdAt)) ? now : new Date(entry.createdAt).toISOString();
  const updatedAt = Number.isNaN(Date.parse(entry.updatedAt)) ? createdAt : new Date(entry.updatedAt).toISOString();
  return {
    id: entry.id,
    title: typeof entry.title === 'string' ? entry.title.slice(0, 500) : '未命名',
    createdAt,
    updatedAt
  };
}

function recoverProjectIndex(err) {
  console.error('[projects] 项目索引损坏，正在从正文文件恢复:', err);
  const backupPath = path.join(projectsDir, `index.corrupt-${Date.now()}.json`);
  try { fs.copyFileSync(projectsIndexFile, backupPath); } catch (_) {}
  const projects = [];
  for (const name of fs.readdirSync(projectsDir)) {
    if (!name.toLowerCase().endsWith('.html')) continue;
    const id = name.slice(0, -5);
    try { assertProjectId(id); } catch (_) { continue; }
    const stat = fs.statSync(path.join(projectsDir, name));
    projects.push({
      id,
      title: '未命名（已恢复）',
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString()
    });
  }
  projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  writeProjectIndex(projects);
  return projects;
}

function readProjectIndex() {
  initProjectsDir();
  try {
    const raw = JSON.parse(fs.readFileSync(projectsIndexFile, 'utf-8'));
    if (!Array.isArray(raw)) throw new Error('项目索引不是数组');
    const seen = new Set();
    return raw.map(normalizeProjectEntry).filter(entry => entry && !seen.has(entry.id) && seen.add(entry.id));
  } catch (err) {
    return recoverProjectIndex(err);
  }
}

function writeProjectIndex(data) {
  initProjectsDir();
  atomicWriteFileSync(projectsIndexFile, JSON.stringify(data, null, 2), 'utf-8');
}

function getContentFileName(id) {
  initPaths();
  assertProjectId(id);
  return path.join(projectsDir, `${id}.html`);
}

// ================== IPC: 项目列表 ==================
registerIpcHandler('list-projects', async () => {
  return requireWorkspaceService().listProjects();
});

registerIpcHandler('automation-capture-page', async event => {
  if (!automationConfig.enabled) throw new Error('截图取证只允许在隔离自动化模式使用');
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) throw new Error('自动化窗口不可用');
  if (owner.isMinimized()) owner.restore();
  owner.show();
  owner.focus();
  owner.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 250));
  const bounds = owner.getContentBounds();
  const image = await owner.webContents.capturePage({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  const png = image.toPNG();
  if (png.length < 1000 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`自动化截图没有有效的渲染像素（${bounds.width}x${bounds.height}, ${png.length} bytes）`);
  }
  return { base64: png.toString('base64'), byteCount: png.length };
});

// ================== IPC: 自动保存项目 ==================
registerIpcHandler('save-project-auto', async (event, payload) => {
  try {
    assertPlainObject(payload);
    const { id, projectId, title, content, baseRevision, meta, citations, source } = payload;
    const normalizedProjectId = projectId || id;
    assertString(normalizedProjectId, '项目 ID', { maxLength: 128 });
    assertString(content, '项目正文', { maxLength: MAX_PROJECT_BYTES, allowEmpty: true });
    if (byteLength(content) > MAX_PROJECT_BYTES) throw new RangeError('项目正文超过 50 MB 限制');
    if (title !== undefined && typeof title !== 'string') throw new TypeError('项目标题格式错误');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < -1) throw new TypeError('项目 baseRevision 格式错误');
    if (meta !== undefined) assertPlainObject(meta, '项目元数据');
    if (!Array.isArray(citations)) throw new TypeError('项目引用列表格式错误');
    const result = await requireWorkspaceService().saveProject({
      id: normalizedProjectId,
      title,
      content,
      baseRevision,
      meta,
      citations,
      source
    });
    if (!result.durable || result.journalState !== 'COMPLETE') {
      throw new Error('项目提交未获得 durable COMPLETE 确认');
    }
    return result;
  } catch (err) {
    console.error('[save-project-auto] 保存失败:', err);
    if (err.code === 'ENOSPC') throw new Error('磁盘空间不足，项目未保存');
    throw err;
  }
});

// ================== IPC: 加载项目内容 ==================
registerIpcHandler('load-project', async (event, id) => {
  assertString(id, '项目 ID', { maxLength: 128 });
  return requireWorkspaceService().loadProject(id);
});

// ================== IPC: 工作区、历史与回收站 ==================
registerIpcHandler('workspace-bootstrap', async (event, rendererSnapshot) => {
  assertPlainObject(rendererSnapshot || {}, '旧版数据快照');
  return requireWorkspaceService().bootstrapLegacy(rendererSnapshot || {});
});

registerIpcHandler('delete-project', async (event, payload) => {
  const options = typeof payload === 'string' ? { projectId: payload } : assertPlainObject(payload);
  assertString(options.projectId, '项目 ID', { maxLength: 128 });
  let baseRevision = options.baseRevision;
  if (!Number.isSafeInteger(baseRevision)) {
    baseRevision = (await requireWorkspaceService().loadProject(options.projectId)).revision;
  }
  const result = await requireWorkspaceService().moveToTrash({ projectId: options.projectId, baseRevision });
  return { success: true, ...result };
});

registerIpcHandler('rename-project', async (event, payload) => {
  assertPlainObject(payload);
  assertString(payload.projectId, '项目 ID', { maxLength: 128 });
  assertString(payload.title, '项目名称', { maxLength: 500 });
  if (!payload.title.trim()) throw new Error('项目名称不能为空');
  return requireWorkspaceService().renameProject(payload);
});

registerIpcHandler('project-trash-impact', async (event, projectId) => {
  assertString(projectId, '项目 ID', { maxLength: 128 });
  return requireWorkspaceService().trashImpact(projectId);
});

registerIpcHandler('list-trash', async () => requireWorkspaceService().listTrash());

registerIpcHandler('restore-project-trash', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().restoreFromTrash(payload);
});

registerIpcHandler('permanently-delete-project', async (event, payload) => {
  assertPlainObject(payload);
  if (payload.confirmation !== 'PERMANENTLY_DELETE') throw new Error('永久删除需要二次确认');
  return requireWorkspaceService().permanentlyDelete(payload);
});

registerIpcHandler('project-create-checkpoint', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().createCheckpoint(payload);
});

registerIpcHandler('project-list-versions', async (event, projectId) => {
  assertString(projectId, '项目 ID', { maxLength: 128 });
  return requireWorkspaceService().listVersions(projectId);
});

registerIpcHandler('project-preview-version', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().previewVersion(payload.projectId, payload.versionId);
});

registerIpcHandler('project-restore-version', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().restoreVersion(payload);
});

registerIpcHandler('library-load', async () => requireWorkspaceService().librarySnapshot());

registerIpcHandler('library-replace', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().replaceLibrary(payload);
});

registerIpcHandler('citation-styles', async () => requireWorkspaceService().citationService().listStyles());

registerIpcHandler('citation-render-project', async (event, payload) => {
  citationContracts.citationRender(payload);
  return requireWorkspaceService().citationService().renderProject(payload.projectId, {
    styleId: payload.styleId,
    locale: payload.locale,
    format: payload.format || 'html'
  });
});

registerIpcHandler('citation-audit-project', async (event, projectId) => {
  citationContracts.uuid(projectId, '项目 ID');
  return requireWorkspaceService().citationService().auditProject(projectId);
});

registerIpcHandler('citation-record-export-audit', async (event, payload) => {
  citationContracts.citationExportAudit(payload);
  return requireWorkspaceService().citationService().recordExportAudit(payload);
});

registerIpcHandler('citation-import-select', async () => {
  const { canceled, filePaths } = await showOpenDialog({
    filters: [{ name: '引用数据', extensions: ['bib', 'bibtex', 'ris', 'json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const filePath = filePaths[0];
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('引用文件无效或超过 64 MB 限制');
  const extension = path.extname(filePath).toLowerCase();
  const format = extension === '.ris' ? 'ris' : (extension === '.json' ? 'csl-json' : 'bibtex');
  const plan = requireWorkspaceService().citationService().planImport(fs.readFileSync(filePath, 'utf8'), format);
  return { canceled: false, fileName: path.basename(filePath), ...plan };
});

registerIpcHandler('citation-import-commit', async (event, payload) => {
  citationContracts.citationImportCommit(payload);
  return requireWorkspaceService().citationService().commitImport(payload);
});

registerIpcHandler('citation-export-library', async (event, payload) => {
  citationContracts.citationLibraryExport(payload);
  const format = payload.format;
  const exported = requireWorkspaceService().citationService().exportLibrary(format, payload.itemIds);
  const extension = exported.format === 'bibtex' ? 'bib' : (exported.format === 'ris' ? 'ris' : 'json');
  const { canceled, filePath } = await showSaveDialog({
    filters: [{ name: exported.format.toUpperCase(), extensions: [extension] }],
    defaultPath: path.join(app.getPath('documents'), `EssayFlow-Library.${extension}`)
  });
  if (canceled || !filePath) return { success: false, reason: 'cancelled', lossReport: exported.lossReport };
  atomicWriteFileSync(filePath, exported.text, 'utf8');
  return { success: true, filePath, itemCount: exported.itemCount, bytes: exported.bytes, lossReport: exported.lossReport };
});

registerIpcHandler('citation-library-query', async (event, payload = {}) => {
  citationContracts.citationLibraryQuery(payload);
  return requireWorkspaceService().citationService().queryLibrary(payload);
});

registerIpcHandler('citation-library-batch', async (event, payload) => {
  citationContracts.citationLibraryBatch(payload);
  return requireWorkspaceService().citationService().applyLibraryBatch(payload);
});

registerIpcHandler('citation-library-collection-upsert', async (event, payload) => {
  citationContracts.citationLibraryCollection(payload);
  return requireWorkspaceService().citationService().upsertLibraryCollection(payload);
});

registerIpcHandler('citation-library-undo', async (event, payload) => {
  citationContracts.citationUndo(payload);
  return requireWorkspaceService().citationService().undoLibraryBatch(payload);
});

registerIpcHandler('citation-library-impact', async (event, itemIds) => {
  citationContracts.uuidArray(itemIds, '文献 ID');
  return requireWorkspaceService().citationService().citationImpact(itemIds);
});

registerIpcHandler('citation-project-paper-state', async (event, payload) => {
  citationContracts.citationProjectPaperState(payload);
  return requireWorkspaceService().citationService().updateProjectPaperState(payload);
});

registerIpcHandler('settings-read', async () => requireWorkspaceService().readSettings());

registerIpcHandler('settings-update', async (event, payload) => {
  assertPlainObject(payload);
  const result = await requireWorkspaceService().updateSettings(payload);
  return { success: true, settings: result.settings };
});

registerIpcHandler('credential-set', async (event, payload) => {
  assertPlainObject(payload);
  assertString(payload.providerId, 'providerId', { maxLength: 128 });
  assertString(payload.value, '凭据', { maxLength: 64 * 1024 });
  return requireWorkspaceService().setCredential(payload.providerId, payload.value);
});

registerIpcHandler('credential-status', async (event, providerId) => {
  assertString(providerId, 'providerId', { maxLength: 128 });
  return { credentialStatus: requireWorkspaceService().credentialStatus(providerId) };
});

registerIpcHandler('credential-remove', async (event, providerId) => {
  assertString(providerId, 'providerId', { maxLength: 128 });
  return requireWorkspaceService().removeCredential(providerId);
});

registerIpcHandler('ai-preview-request', async (event, payload) => {
  aiContracts.preview(payload);
  return requireWorkspaceService().trustedAiService().previewRequest(payload);
});

registerIpcHandler('ai-execute-request', async (event, payload) => {
  aiContracts.execute(payload);
  return requireWorkspaceService().trustedAiService().executePrepared(payload);
});

registerIpcHandler('ai-cancel-request', async (event, payload) => {
  aiContracts.cancel(payload);
  return requireWorkspaceService().trustedAiService().cancelRequest(payload);
});

registerIpcHandler('ai-grounded-ask', async (event, payload) => {
  aiContracts.grounded(payload);
  return requireWorkspaceService().trustedAiService().askGrounded(payload);
});

registerIpcHandler('ai-chat-send', async (event, payload) => {
  aiContracts.chat(payload);
  return requireWorkspaceService().trustedAiService().sendChat(payload);
});

registerIpcHandler('ai-chat-commit', async (event, payload) => {
  aiContracts.commitChat(payload);
  return requireWorkspaceService().trustedAiService().commitChat(payload);
});

registerIpcHandler('ai-review-request', async (event, payload) => {
  aiContracts.reviewRequest(payload);
  return requireWorkspaceService().trustedAiService().requestReview(payload);
});

registerIpcHandler('ai-review-decide', async (event, payload) => {
  aiContracts.reviewDecision(payload);
  return requireWorkspaceService().trustedAiService().decideReviewIssue(payload);
});

registerIpcHandler('ai-review-decide-batch', async (event, payload) => {
  aiContracts.reviewBatchDecision(payload);
  return requireWorkspaceService().trustedAiService().decideReviewIssues(payload);
});

registerIpcHandler('ai-project-state', async (event, projectId) => {
  aiContracts.projectId(projectId);
  return requireWorkspaceService().trustedAiService().listProjectAi(projectId);
});

registerIpcHandler('ai-clear-chat', async (event, payload) => {
  aiContracts.clearChat(payload);
  return requireWorkspaceService().trustedAiService().clearChat(payload);
});

registerIpcHandler('ai-redact-audit', async (event, payload) => {
  aiContracts.redact(payload);
  return requireWorkspaceService().trustedAiService().redactAudit(payload);
});

registerIpcHandler('ai-export-audit', async (event, payload) => {
  aiContracts.exportAudit(payload);
  return requireWorkspaceService().trustedAiService().exportAudit(payload.projectId, {
    includeContent: payload.includeContent === true
  });
});

registerIpcHandler('asset-save', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().putAsset(payload);
});

registerIpcHandler('asset-read', async (event, assetId) => {
  assertString(assetId, 'assetId', { maxLength: 64 });
  const asset = requireWorkspaceService().readAsset(assetId);
  return { descriptor: asset.descriptor, base64: asset.buffer.toString('base64') };
});

registerIpcHandler('evidence-import-managed-pdf', async (event, locator) => {
  evidenceContracts.managedPdfLocator(locator);
  initPaths();
  const filePath = assertExistingFileInside(pathFromFileUrlOrPath(locator), [localPdfDir, downloadPdfDir, tempPdfDir], '.pdf');
  if (!hasPdfHeader(filePath)) throw new Error('受管文件不是有效 PDF');
  return requireWorkspaceService().assetStore.importFile(filePath, {
    kind: 'pdf',
    mimeType: 'application/pdf',
    originalName: path.basename(filePath)
  });
});

registerIpcHandler('evidence-list', async (event, projectId) => {
  evidenceContracts.list(projectId);
  return requireWorkspaceService().evidenceService().listEvidence(projectId);
});

registerIpcHandler('evidence-read-pdf', async (event, assetId) => {
  citationContracts.uuid(assetId, '资产 ID');
  const asset = requireWorkspaceService().readAsset(assetId);
  if (asset.descriptor.kind !== 'pdf' && asset.descriptor.mimeType !== 'application/pdf') throw new Error('资产不是 PDF');
  if (asset.buffer.length > MAX_PDF_BYTES) throw new Error('PDF 超过大小限制');
  if (asset.buffer.length < 5 || asset.buffer.toString('ascii', 0, 5) !== '%PDF-') throw new Error('PDF 文件格式错误');
  return { descriptor: asset.descriptor, data: new Uint8Array(asset.buffer) };
});

registerIpcHandler('evidence-create-user', async (event, payload) => {
  evidenceContracts.userSelection(payload);
  return requireWorkspaceService().evidenceService().createEvidenceFromUserSelection(payload);
});

registerIpcHandler('evidence-create-ai-proposal', async (event, payload) => {
  evidenceContracts.aiSelection(payload);
  return requireWorkspaceService().evidenceService().createProposedEvidenceFromAI(payload);
});

registerIpcHandler('evidence-review-user', async (event, payload) => {
  evidenceContracts.review(payload);
  return requireWorkspaceService().evidenceService().reviewProposedEvidenceByUser(payload);
});

registerIpcHandler('evidence-update-card', async (event, payload) => {
  evidenceContracts.update(payload);
  return requireWorkspaceService().evidenceService().updateEvidenceCard(payload);
});

registerIpcHandler('evidence-archive', async (event, payload) => {
  evidenceContracts.archive(payload);
  return requireWorkspaceService().evidenceService().archiveEvidence(payload);
});

registerIpcHandler('evidence-prepare-citation', async (event, payload) => {
  evidenceContracts.prepareCitation(payload);
  return requireWorkspaceService().evidenceService().prepareEvidenceCitation(payload);
});

registerIpcHandler('evidence-commit-citation', async (event, payload) => {
  evidenceContracts.commitCitation(payload);
  return requireWorkspaceService().evidenceService().commitEvidenceCitation(payload);
});

registerIpcHandler('matrix-list', async (event, projectId) => {
  matrixContracts.projectId(projectId);
  return requireWorkspaceService().matrixService().list(projectId);
});

registerIpcHandler('matrix-create', async (event, payload) => {
  matrixContracts.create(payload);
  return requireWorkspaceService().matrixService().create(payload);
});

registerIpcHandler('matrix-column-add', async (event, payload) => {
  matrixContracts.addColumn(payload);
  return requireWorkspaceService().matrixService().addColumn(payload);
});

registerIpcHandler('matrix-column-delete', async (event, payload) => {
  matrixContracts.deleteColumn(payload);
  return requireWorkspaceService().matrixService().deleteColumn(payload);
});

registerIpcHandler('matrix-column-reorder', async (event, payload) => {
  matrixContracts.reorder(payload);
  return requireWorkspaceService().matrixService().reorderColumns(payload);
});

registerIpcHandler('matrix-rows-set', async (event, payload) => {
  matrixContracts.setRows(payload);
  return requireWorkspaceService().matrixService().setRows(payload);
});

registerIpcHandler('matrix-cell-update', async (event, payload) => {
  matrixContracts.updateCell(payload);
  return requireWorkspaceService().matrixService().updateCell(payload);
});

registerIpcHandler('matrix-cell-review', async (event, payload) => {
  matrixContracts.reviewCell(payload);
  return requireWorkspaceService().matrixService().reviewCell(payload);
});

registerIpcHandler('matrix-prefill-preview', async (event, payload) => {
  matrixContracts.prefillPreview(payload);
  return requireWorkspaceService().matrixService().previewPrefillBatch(payload);
});

registerIpcHandler('matrix-prefill-execute', async (event, payload) => {
  matrixContracts.prefillExecute(payload);
  return requireWorkspaceService().matrixService().executePrefillBatch(payload);
});

registerIpcHandler('matrix-prefill-cancel', async (event, payload) => {
  matrixContracts.cancel(payload);
  return requireWorkspaceService().matrixService().cancelBatch(payload);
});

registerIpcHandler('matrix-export', async (event, payload) => {
  matrixContracts.exportMatrix(payload);
  const exported = await requireWorkspaceService().matrixService().export(payload);
  const project = await requireWorkspaceService().loadProject(payload.projectId);
  const defaultName = `${sanitizeFileName(project.meta.title, 'EssayFlow')}-综述矩阵.${exported.extension}`;
  const { canceled, filePath } = await showSaveDialog({
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: payload.format === 'xlsx' ? 'Excel 工作簿' : 'CSV ZIP', extensions: [exported.extension] }]
  });
  if (canceled || !filePath) return { success: false, reason: 'cancelled' };
  atomicWriteFileSync(path.resolve(filePath), exported.buffer);
  return { success: true, filePath, format: exported.format, byteCount: exported.byteCount };
});

registerIpcHandler('archive-export-project', async (event, payload) => {
  assertPlainObject(payload);
  const project = await requireWorkspaceService().loadProject(payload.projectId);
  const { canceled, filePath } = await showSaveDialog({
    filters: [{ name: 'EssayFlow 项目包', extensions: ['essayflow'] }],
    defaultPath: path.join(app.getPath('documents'), `${sanitizeFileName(project.meta.title, 'EssayFlow')}.essayflow`)
  });
  if (canceled || !filePath) return { success: false, reason: 'cancelled' };
  const result = await requireWorkspaceService().archiveService().exportProject(payload.projectId, {
    includeAssets: payload.includeAssets !== false,
    targetPath: filePath
  });
  return { success: true, filePath, manifest: result.manifest, sha256: result.sha256 };
});

registerIpcHandler('archive-export-workspace', async (event, payload = {}) => {
  assertPlainObject(payload);
  const { canceled, filePath } = await showSaveDialog({
    filters: [{ name: 'EssayFlow 完整备份', extensions: ['essayflow'] }],
    defaultPath: path.join(app.getPath('documents'), 'EssayFlow-Backup.essayflow')
  });
  if (canceled || !filePath) return { success: false, reason: 'cancelled' };
  const result = await requireWorkspaceService().archiveService().exportWorkspace({
    includeAssets: payload.includeAssets !== false,
    targetPath: filePath
  });
  return { success: true, filePath, manifest: result.manifest, sha256: result.sha256 };
});

registerIpcHandler('archive-select-import', async () => {
  const { canceled, filePaths } = await showOpenDialog({
    filters: [{ name: 'EssayFlow 项目包或备份', extensions: ['essayflow'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { canceled: true };
  return requireWorkspaceService().archiveService().inspectArchive(filePaths[0]);
});

registerIpcHandler('archive-import', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().archiveService().importArchive(payload.inspectionId, {
    strategy: payload.strategy || 'keep-both'
  });
});

registerIpcHandler('archive-cancel-import', async (event, payload) => {
  assertPlainObject(payload);
  return requireWorkspaceService().archiveService().cancelImport(payload.inspectionId, payload.reason || 'user');
});

registerIpcHandler('import-word', async () => {
  const { canceled, filePaths } = await showOpenDialog({
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    properties: ['openFile']
  });
  if (!canceled && filePaths.length > 0) {
    if (path.extname(filePaths[0]).toLowerCase() !== '.docx') throw new Error('仅支持 .docx 文件');
    const stat = fs.statSync(filePaths[0]);
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error('Word 文件无效或超过 100 MB 限制');
    const buffer = fs.readFileSync(filePaths[0]);
    return buffer.toString('base64');
  }
  return null;
});

// AI 聊天附件上传：返回文件内容和元数据
async function extractChatAttachmentText(buffer, ext) {
  if (ext === 'txt') return buffer.toString('utf8').replace(/\0/g, '').slice(0, MAX_CHAT_ATTACHMENT_TEXT);
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return String(result.value || '').replace(/\0/g, '').slice(0, MAX_CHAT_ATTACHMENT_TEXT);
  }
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  if (document.numPages > 500) throw new Error('PDF 超过聊天附件 500 页限制');
  let text = '';
  for (let pageNumber = 1; pageNumber <= document.numPages && text.length < MAX_CHAT_ATTACHMENT_TEXT; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    text += `${content.items.map(item => item.str || '').join(' ')}\n`;
    page.cleanup();
  }
  await document.destroy();
  return text.replace(/\0/g, '').slice(0, MAX_CHAT_ATTACHMENT_TEXT);
}

registerIpcHandler('select-chat-attachment', async () => {
  try {
    const opts = {
      filters: [
        { name: '支持的文件', extensions: ['txt', 'pdf', 'docx'] }
      ],
      properties: ['openFile']
    };
    // 优先使用主窗口作为父窗口，若窗口已销毁则不传
    const result = await showOpenDialog(opts);
    const { canceled, filePaths } = result;
    if (!canceled && filePaths.length > 0) {
      const filePath = filePaths[0];
      const ext = path.extname(filePath).toLowerCase().slice(1);
      if (!['txt', 'pdf', 'docx'].includes(ext)) throw new Error('不支持的附件类型');
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_CHAT_ATTACHMENT_BYTES) throw new Error('附件无效或超过 20 MB 限制');
      const buffer = fs.readFileSync(filePath);
      const mimeType = ext === 'pdf' ? 'application/pdf' : ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain';
      const descriptor = await requireWorkspaceService().assetStore.importFile(filePath, {
        kind: 'chat-attachment-full',
        mimeType,
        originalName: path.basename(filePath)
      });
      const content = await extractChatAttachmentText(buffer, ext);

      return {
        name: path.basename(filePath),
        size: buffer.length,
        ext,
        content,
        assetId: descriptor.assetId,
        assetSha256: descriptor.sha256
      };
    }
    return null;
  } catch (err) {
    console.error('select-chat-attachment error:', err);
    throw err;
  }
});

registerIpcHandler('select-save-path', async (event, defaultPath) => {
  const opts = {
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  };
  if (defaultPath) {
    opts.defaultPath = path.join(app.getPath('documents'), sanitizeFileName(defaultPath, 'EssayFlow.pdf', '.pdf'));
  }
  const { canceled, filePath } = await showSaveDialog(opts);
  if (!canceled && filePath) {
    authorizedSavePaths.set(normalizePathForComparison(filePath), Date.now() + 10 * 60_000);
    return filePath;
  }
  return null;
});

registerIpcHandler('save-file', async (event, base64Data, filePath) => {
  try {
    assertString(filePath, '保存路径', { maxLength: 4096 });
    const normalizedPath = normalizePathForComparison(filePath);
    const expiresAt = authorizedSavePaths.get(normalizedPath);
    if (!expiresAt || expiresAt < Date.now()) {
      authorizedSavePaths.delete(normalizedPath);
      throw new Error('保存路径未经过用户授权，请重新选择');
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('仅允许保存 PDF 文件');
    const buffer = decodeBase64(base64Data, 'PDF 数据', MAX_PDF_BYTES);
    if (buffer.length < 5 || buffer.toString('ascii', 0, 5) !== '%PDF-') throw new Error('PDF 数据格式错误');
    atomicWriteFileSync(path.resolve(filePath), buffer);
    authorizedSavePaths.delete(normalizedPath);
    return true;
  } catch (err) {
    console.error('保存文件失败:', err);
    throw err;
  }
});

registerIpcHandler('save-project', async (event, projectData) => {
  const serialized = JSON.stringify(projectData, null, 2);
  if (typeof serialized !== 'string') throw new Error('项目数据格式错误');
  if (byteLength(serialized) > MAX_PROJECT_BYTES) throw new Error('项目文件超过 50 MB 限制');
  const { canceled, filePath } = await showSaveDialog({
    filters: [{ name: 'Essay 项目', extensions: ['essay'] }]
  });
  if (!canceled && filePath) {
    atomicWriteFileSync(filePath, serialized, 'utf-8');
    return true;
  }
  return false;
});

function hasPdfHeader(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(1024);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    return header.subarray(0, count).includes(Buffer.from('%PDF-'));
  } catch (_) {
    return false;
  }
}

function downloadPdfToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.part`;
    let request;
    let timeout;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
    };
    const fail = (err) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(err);
    };
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (request) request.abort();
        fail(new Error('PDF 下载超时'));
      }, NETWORK_IDLE_TIMEOUT_MS);
    };

    try {
      request = createExternalRequest({ url, method: 'GET', redirect: 'error' });
      request.setHeader('Accept', 'application/pdf,*/*;q=0.8');
      resetTimeout();
      request.on('response', response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`PDF 下载失败，状态码：${response.statusCode}`));
          return;
        }
        const declaredLength = Number(Array.isArray(response.headers['content-length'])
          ? response.headers['content-length'][0]
          : response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
          response.destroy();
          fail(new Error('PDF 超过 200 MB 限制'));
          return;
        }
        let received = 0;
        let prefix = Buffer.alloc(0);
        const limiter = new Transform({
          transform(chunk, _encoding, callback) {
            resetTimeout();
            received += chunk.length;
            if (received > MAX_PDF_BYTES) return callback(new Error('PDF 超过 200 MB 限制'));
            if (prefix.length < 1024) prefix = Buffer.concat([prefix, chunk]).subarray(0, 1024);
            callback(null, chunk);
          }
        });
        pipeline(response, limiter, fs.createWriteStream(tempPath, { flags: 'wx' }), err => {
          if (err) return fail(err);
          if (!prefix.includes(Buffer.from('%PDF-'))) return fail(new Error('下载内容不是有效的 PDF'));
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(tempPath, filePath);
            settled = true;
            clearTimeout(timeout);
            resolve(filePath);
          } catch (renameErr) {
            fail(renameErr);
          }
        });
      });
      request.on('error', fail);
      request.end();
    } catch (err) {
      fail(err);
    }
  });
}

async function downloadPdf(payload, targetDir, addUrlHash) {
  assertPlainObject(payload);
  citationContracts.uuid(payload.projectId, '项目 ID');
  const url = parseHttpUrl(payload.url);
  fs.mkdirSync(targetDir, { recursive: true });
  let safeName = sanitizeFileName(payload.filename, 'paper.pdf', '.pdf');
  if (addUrlHash) {
    const ext = path.extname(safeName);
    safeName = safeName.slice(0, -ext.length) + '_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 10) + ext;
  }
  const filePath = path.join(targetDir, safeName);
  const audited = await requireWorkspaceService().trustedAiService().executeAuditedExternal({
    projectId: payload.projectId,
    operation: 'pdf-download',
    url,
    label: `远程 PDF：${safeName}`,
    confirmed: payload.confirmed === true
  }, async () => {
    await resolveAndValidate(new URL(url), 'scholarly-api');
    if (!fs.existsSync(filePath) || !hasPdfHeader(filePath)) {
      const key = normalizePathForComparison(filePath);
      if (!activeDownloads.has(key)) {
        const promise = downloadPdfToFile(url, filePath).finally(() => activeDownloads.delete(key));
        activeDownloads.set(key, promise);
      }
      await activeDownloads.get(key);
    }
    const stat = fs.statSync(filePath);
    return { value: filePath, auditSummary: { contentType: 'application/pdf', byteCount: stat.size } };
  });
  return audited.value;
}

registerIpcHandler('download-pdf-temp', async (event, payload) => {
  initPaths();
  return downloadPdf(payload, tempPdfDir, true);
});

registerIpcHandler('download-pdf', async (event, payload) => {
  initPaths();
  return downloadPdf(payload, downloadPdfDir, false);
});

// 保存用户上传的本地 PDF 到 userData/localPdfs/
registerIpcHandler('save-local-pdf', async (event, payload) => {
  assertPlainObject(payload);
  const { base64Data, filename } = payload;
  initPaths();
  fs.mkdirSync(localPdfDir, { recursive: true });
  const safeName = sanitizeFileName(filename, 'paper.pdf', '.pdf');
  const filePath = path.join(localPdfDir, safeName);
  // 如果同名文件已存在，追加时间戳避免覆盖
  let finalPath = filePath;
  if (fs.existsSync(filePath)) {
    const timestamp = Date.now();
    const nameWithoutExt = safeName.replace(/\.pdf$/i, '');
    finalPath = path.join(localPdfDir, `${nameWithoutExt}_${timestamp}.pdf`);
  }
  const buffer = decodeBase64(base64Data, 'PDF 数据', MAX_PDF_BYTES);
  // 验证 PDF 文件头
  if (buffer.length < 5 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
    throw new Error('文件格式错误：不是有效的 PDF 文件');
  }
  atomicWriteFileSync(finalPath, buffer);
  return finalPath;
});

// 删除本地 PDF 文件（取消收藏时清理磁盘）
registerIpcHandler('delete-local-pdf', async (event, filePath) => {
  try {
    initPaths();
    const safePath = assertExistingFileInside(filePath, [localPdfDir, downloadPdfDir], '.pdf');
    if (fs.existsSync(safePath)) {
      fs.unlinkSync(safePath);
      return { success: true };
    }
    return { success: false, error: '文件不存在' };
  } catch (err) {
    console.error('[delete-local-pdf] 删除失败:', err);
    return { success: false, error: err.message };
  }
});

function pathFromFileUrlOrPath(value) {
  assertString(value, '文件路径', { maxLength: 4096 });
  return value.toLowerCase().startsWith('file:') ? fileURLToPath(new URL(value)) : value;
}

registerIpcHandler('read-local-pdf', async (event, fileUrlOrPath) => {
  try {
    initPaths();
    const filePath = assertExistingFileInside(pathFromFileUrlOrPath(fileUrlOrPath), [localPdfDir, downloadPdfDir], '.pdf');
    const stat = fs.statSync(filePath);
    const maxAiPdfBytes = 20 * 1024 * 1024;
    if (stat.size > maxAiPdfBytes) return { success: false, reason: 'PDF 超过 20 MB 限制' };
    const data = fs.readFileSync(filePath);
    if (data.length < 5 || data.toString('ascii', 0, 5) !== '%PDF-') return { success: false, reason: 'PDF 文件格式错误' };
    return { success: true, data: new Uint8Array(data), size: data.length };
  } catch (err) {
    return { success: false, reason: getErrorMessage(err) };
  }
});

const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

registerIpcHandler('save-image', async (event, payload) => {
  assertPlainObject(payload);
  const { base64Data, filename } = payload;
  initPaths();
  fs.mkdirSync(imageDir, { recursive: true });
  const safeName = sanitizeFileName(filename, 'image.png');
  if (!IMAGE_MIME_TYPES[path.extname(safeName).toLowerCase()]) throw new Error('不支持的图片格式');
  const filePath = path.join(imageDir, safeName);
  const buffer = decodeBase64(base64Data, '图片数据', MAX_IMAGE_BYTES);
  atomicWriteFileSync(filePath, buffer);
  return filePath;
});

registerIpcHandler('read-image-base64', async (event, fileUrlOrPath) => {
  initPaths();
  const filePath = assertExistingFileInside(pathFromFileUrlOrPath(fileUrlOrPath), [imageDir]);
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error('不支持的图片格式');
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 25 MB 限制');
  return { base64: fs.readFileSync(filePath).toString('base64'), mimeType };
});

registerIpcHandler('save-docx', async (event, payload) => {
  assertPlainObject(payload);
  const { wordXml, images = [] } = payload;
  // XML 注入防护：拒绝包含 DTD 或外部实体声明的输入
  if (typeof wordXml !== 'string' || byteLength(wordXml) > MAX_DOCX_XML_BYTES ||
      /<!DOCTYPE|<!ENTITY|<\?xml|<\/?w:(?:document|body)\b/i.test(wordXml)) {
    return { success: false, reason: 'XML 内容包含非法声明或超过 25 MB 限制，已拒绝保存' };
  }
  if (!Array.isArray(images) || images.length > 100) {
    return { success: false, reason: '图片列表格式错误或数量超过 100 张' };
  }
  const JSZip = require('jszip');
  const contentTypeByExtension = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
  };
  const seenRelationshipIds = new Set();
  let totalImageBytes = 0;
  let normalizedImages;
  try {
    normalizedImages = images.map((img, index) => {
      assertPlainObject(img, '图片');
      assertString(img.rId, '图片关系 ID', { maxLength: 64 });
      if (!/^rId[1-9][0-9]*$/.test(img.rId) || seenRelationshipIds.has(img.rId)) {
        throw new Error('图片关系 ID 无效或重复');
      }
      seenRelationshipIds.add(img.rId);
      const extension = path.extname(assertString(img.name, '图片名称', { maxLength: 255 })).slice(1).toLowerCase();
      if (!contentTypeByExtension[extension]) throw new Error(`不支持的 Word 图片格式：${extension || '未知'}`);
      const buffer = decodeBase64(img.base64, 'Word 图片数据', MAX_IMAGE_BYTES);
      totalImageBytes += buffer.length;
      if (totalImageBytes > MAX_IMPORT_BYTES) throw new Error('Word 图片总大小超过 100 MB 限制');
      return { rId: img.rId, name: `image${index + 1}.${extension}`, extension, buffer };
    });
  } catch (err) {
    return { success: false, reason: getErrorMessage(err) };
  }

  const opts = {
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    defaultPath: path.join(app.getPath('documents'), 'EssayFlow.docx')
  };

  const { canceled, filePath } = await showSaveDialog(opts);
  if (canceled || !filePath) return { success: false, reason: 'cancelled' };

  try {
    const zip = new JSZip();

    // [Content_Types].xml
    const contentTypes = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`];
    const addedExtensions = new Set();
    normalizedImages.forEach(img => {
      if (addedExtensions.has(img.extension)) return;
      addedExtensions.add(img.extension);
      contentTypes.push(`  <Default Extension="${img.extension}" ContentType="${contentTypeByExtension[img.extension]}"/>`);
    });
    contentTypes.push('</Types>');
    zip.file('[Content_Types].xml', contentTypes.join('\n'));

    // _rels/.rels
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    // word/_rels/document.xml.rels
    const docRels = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`];
    normalizedImages.forEach(img => {
      docRels.push(`  <Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.name}"/>`);
    });
    docRels.push('</Relationships>');
    zip.file('word/_rels/document.xml.rels', docRels.join('\n'));

    // word/document.xml
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${wordXml}
  </w:body>
</w:document>`);

    // 图片文件
    normalizedImages.forEach(img => {
      zip.file(`word/media/${img.name}`, img.buffer);
    });

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    atomicWriteFileSync(filePath, buffer);
    return { success: true, path: filePath };
  } catch (err) {
    console.error('[save-docx] 生成 docx 失败:', err);
    return { success: false, reason: err.message };
  }
});

function normalizeRequestHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  assertPlainObject(headers, '请求头');
  const entries = Object.entries(headers);
  if (entries.length > 64) throw new Error('请求头数量过多');
  const normalized = {};
  let totalLength = 0;
  for (const [name, rawValue] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('请求头名称无效');
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (values.length > 16) throw new Error('请求头值数量过多');
    const normalizedValues = values.map(value => {
      const text = String(value);
      if (/\r|\n/.test(text)) throw new Error('请求头包含非法换行');
      totalLength += name.length + text.length;
      return text;
    });
    normalized[name] = Array.isArray(rawValue) ? normalizedValues : normalizedValues[0];
  }
  if (totalLength > 64 * 1024) throw new Error('请求头过大');
  return normalized;
}

function normalizeNetOptions(payload, defaultMethod) {
  assertPlainObject(payload);
  const url = parseHttpUrl(payload.url);
  const method = String(payload.method || defaultMethod).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new Error('不支持的 HTTP 方法');
  }
  const headers = normalizeRequestHeaders(payload.headers);
  const body = payload.body === undefined || payload.body === null ? null : payload.body;
  if (body !== null && typeof body !== 'string') throw new TypeError('请求体必须是字符串');
  if (body !== null && byteLength(body) > MAX_REQUEST_BODY_BYTES) throw new Error('请求体超过 10 MB 限制');
  return { url, method, headers, body };
}

function normalizeRequestId(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('请求 ID 不能为空');
    return null;
  }
  assertString(value, '请求 ID', { maxLength: 100 });
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('请求 ID 格式错误');
  return value;
}

const SCHOLARLY_API_HOSTS = new Set([
  'export.arxiv.org',
  'api.semanticscholar.org',
  'api.crossref.org',
  'api.core.ac.uk',
  'api.openalex.org'
]);

function assertScholarlyApiUrl(value, sourceId) {
  const url = new URL(parseHttpUrl(value));
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!SCHOLARLY_API_HOSTS.has(hostname)) {
    const source = requireWorkspaceService().readSettings().customSearchSources
      ?.find(item => item.id === sourceId && item.enabled !== false);
    let configured;
    try { configured = source && new URL(source.url); } catch (_) {}
    if (!configured || configured.origin !== url.origin || !url.pathname.startsWith(configured.pathname)) {
      const error = new Error('学术请求目标不在允许的 API 清单中');
      error.code = 'SCHOLARLY_HOST_BLOCKED';
      throw error;
    }
  }
  if (url.protocol !== 'https:' && hostname !== 'export.arxiv.org') {
    throw new Error('学术 API 必须使用 HTTPS');
  }
  return url.toString();
}

registerIpcHandler('scholarly-request', async (event, payload) => {
  aiContracts.scholarly(payload);
  const privacyProject = await requireWorkspaceService().loadProject(payload.projectId);
  if (privacyProject.meta.privacyMode === 'local-only') {
    return requireWorkspaceService().trustedAiService().requestScholarly({
      projectId: payload.projectId,
      requestId: payload.requestId,
      operation: payload.operation || 'literature-metadata',
      sourceId: payload.sourceId || 'blocked-scholarly-source',
      url: payload.url,
      method: payload.method || 'GET',
      headers: {},
      body: payload.body === undefined ? null : payload.body,
      confirmed: payload.confirmed === true
    });
  }
  const allowedUrl = assertScholarlyApiUrl(payload.url, payload.sourceId);
  const { url, method, headers, body } = normalizeNetOptions({ ...payload, url: allowedUrl }, 'GET');
  for (const name of Object.keys(headers)) {
    if (/^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(name)) {
      throw new Error('renderer 不得向学术 gateway 注入凭据请求头');
    }
  }
  if (typeof payload.sourceId === 'string' && payload.sourceId.startsWith('custom_')) {
    const credentialId = `search-source:${payload.sourceId}`;
    if (requireWorkspaceService().credentialStatus(credentialId) === 'configured') {
      headers.Authorization = `Bearer ${requireWorkspaceService().getCredential(credentialId)}`;
    }
  }
  const requestId = normalizeRequestId(payload.requestId, true);
  const result = await requireWorkspaceService().trustedAiService().requestScholarly({
    projectId: payload.projectId,
    requestId,
    operation: payload.operation || 'literature-metadata',
    sourceId: payload.sourceId || new URL(url).hostname,
    url,
    method,
    headers,
    body,
    confirmed: payload.confirmed === true
  });
  return result;
});

registerIpcHandler('scholarly-request-cancel', async (event, requestId) => {
  const normalizedId = normalizeRequestId(requestId, true);
  aiContracts.cancel({ requestId: normalizedId });
  return requireWorkspaceService().trustedAiService().cancelRequest({ requestId: normalizedId });
});

app.whenReady().then(async () => {
  installAutomationNetworkBlock(session.defaultSession);
  workspaceService = new WorkspaceService({
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion(),
    safeStorage,
    aiTransport: input => {
      assertAutomationNetworkAllowed(input.url);
      return secureTransport(input);
    }
  });
  await workspaceService.initialize();
  createWindow();
}).catch(error => {
  console.error('[workspace] 初始化失败，应用拒绝以空白数据启动:', error);
  dialog.showErrorBox('EssayFlow 无法启动', `工作区初始化失败，未修改原有数据。\n\n${getErrorMessage(error)}`);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
