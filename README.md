# EssayFlow

EssayFlow 是一款基于 Electron 的本地桌面学术写作工具。当前应用提供 Quill 富文本编辑、项目自动保存、文献检索与文库、引用和参考文献、AI 对话与行内编辑、Word 导入，以及 Word/PDF 导出。

> 当前源码已接通到 **M5（文献筛选与综述矩阵）** 的实现和累计门禁；某次 M0-M5 是否通过，只看对应 gate 的退出码，以及该次生成并绑定当前 `sourceTreeSha256` 的 `artifacts/quality-summary.json`。旧报告不能证明当前源码通过。`gate:release` 仍需独立完成，不得把已有安装包当作成功证据。

## 当前功能

- 富文本编辑：标题、列表、引用块、代码块、链接、表格、图片、段落拖拽、查找替换和可配置快捷键。
- 项目管理：主进程 repository 原子保存 ProjectAggregate，支持版本检查点、恢复、回收站和完整项目/工作区归档。
- 文献检索：arXiv、Semantic Scholar、Crossref、CORE、OpenAlex 和自定义 HTTP API 来源。
- 文献库：主进程单一持久化，支持 BibTeX/RIS/CSL-JSON 导入导出、冲突合并、集合、标签、星标、笔记、项目筛选/阅读状态、组合筛选、分页、批量操作和一次撤销。检索区在窄面板中保留常驻搜索框，把高级条件收纳为可折叠面板并显示为可移除标签，批量操作也可独立展开。
- 引用管理：Citation.js + citeproc-js 离线 CSL 引擎统一生成文内引用和书目；支持六套锁定样式、多文献簇、locator、prefix、suffix、suppress-author、引用编辑和导出前审计。
- 可追溯证据：PDF 单页选文、不可变 EvidenceRevision、证据审阅、证据箱、CitationLink 与历史来源状态。
- 可信 AI：统一主进程 gateway、按项目聊天和附件保留、证据限定回答、ReviewIssue 字符级 Diff、逐条/批量接受拒绝、AI 转述、审计导出以及 normal/sensitive/local-only 模式。斜杠和行内入口只创建待审阅 Diff，接受前不改正文。
- 综述矩阵：按项目筛选候选文献，创建可增删、重排、筛选和排序的矩阵；AI 逐篇预填只生成带审计和证据来源的草稿，支持 50 篇取消、逐篇重试、手工覆盖保护，以及安全 CSV ZIP/XLSX 导出。
- 导入导出：Mammoth 导入 `.docx`，生成 `.docx`，以及通过 html2pdf.js 导出 PDF。
- PDF 阅读：PDF.js 本地 worker、cMap 和标准字体支持。

文献检索和 `//verify` 只是在第三方数据库中查询并对比返回的元数据。命中、双源一致或引用次数都不是论文真实性、内容正确性或学术质量的权威证明；正式引用前仍应核对 DOI 注册记录、出版者页面和原文。

## 技术栈

| 层级 | 当前实现 |
|------|----------|
| 桌面运行时 | Electron `^28.0.0` |
| 渲染层 | 原生 HTML、CSS、JavaScript，无前端框架和 ES Module |
| 编辑器 | Quill `1.3.6` |
| PDF | `pdfjs-dist` `3.11.174` |
| 文档处理 | `mammoth` `1.6.0`、`html2pdf.js` `0.10.1`、`jszip` `3.10.1` |
| 引用 | Citation.js `0.7.18`、citeproc-js、锁定本地 CSL/locale 资源 |
| 打包 | electron-builder `^24.0.0` |
| 持久化 | 主进程 workspace repository、LibraryStore、AssetStore、SettingsStore；localStorage 仅保留兼容/UI 偏好 |

Quill、PDF.js、html2pdf.js 和 Mammoth 均由锁文件安装并从应用本地 `node_modules` 加载。核心启动和本地编辑不依赖 CDN。PDF.js 的 worker、169 个 cMap 文件和 16 个标准字体文件也随应用打包并由 `src/pdf-runtime.js` 显式配置。

## 安装与运行

建议在 Windows x64 和受支持的 Node.js/npm 环境中开发。当前 M0 证据记录的环境为 Node.js `v24.18.0`；依赖安装以 `package-lock.json` 为准。

```powershell
npm ci
npm start
```

`npm ci` 是可复现安装和验收的标准入口。日常开发若确需更新依赖，才使用 `npm install` 并审查锁文件变化。

构建未压缩目录：

```powershell
npm run build -- --dir
```

构建 Windows portable 与 NSIS 目标：

```powershell
npm run build
```

`npm run build` 会先校验仓库内固定的 `vendor/electron-builder/winCodeSign-2.6.0.7z`，再把构建工具解压到已排除出源码清单的 `tmp/electron-builder-cache/`。归档中的两个 macOS 符号链接会物化为普通文件，因此没有“创建符号链接”特权的 Windows 账户也能构建；Windows EXE 的图标和版本资源编辑仍保持启用。归档与解压树的固定哈希见 `vendor/electron-builder/README.md`。

典型输出位于：

```text
dist/win-unpacked/EssayFlow.exe
dist/EssayFlow 1.0.0.exe
dist/EssayFlow Setup 1.0.0.exe
```

这些文件存在不等于发布验收通过；发布状态必须由后续完整 `gate:release` 证明。

## M0-M5 测试与门禁

常用命令：

```powershell
npm run check:architecture
npm run test:unit
npm run test:e2e
npm run test:repository
npm run test:migration
npm run test:citation
npm run test:paper-normalize
npm run test:ipc
npm run test:perf
npm run test:m2-e2e
npm run test:evidence
npm run test:m3-e2e
npm run test:trusted-ai
npm run test:security
npm run test:m4-e2e
npm run test:matrix
npm run test:m5-perf
npm run test:a11y
npm run test:m5-e2e
npm run verify:package -- --app "dist/win-unpacked/EssayFlow.exe"
npm run gate:m0
npm run gate:m1
npm run gate:m2
npm run gate:m3
npm run gate:m4
npm run gate:m5
```

- `check:architecture` 以 `test/baseline/architecture.json` 为 ratchet：M0 接受已记录的技术债，但禁止新增，并对远程可执行代码、内联脚本、内联事件处理器和不安全脚本 CSP 保持零容忍。
- `test:unit` 使用 Node 原生测试与 coverage，硬门槛为 lines/functions `>=85%`、branches `>=80%`，并限制相对已接受 baseline 的回退。
- `test:e2e` 启动真实开发版 Electron，完成新建项目、中英文和标题、表格、图片、优先关键词、收藏并拖拽引用、自动保存、重启恢复，以及 Word/PDF 导出。
- `gate:m0` 依次检查合成 fixture、本地运行资产、架构、单元测试、开发版 smoke、开发版 E2E、`win-unpacked` 构建、包内容和打包版 smoke；任一步失败都会返回非零。
- `gate:m1` 在 M0 上累计 repository、migration、upgrade、crash、integrity、深度数据校验和 M1 Electron E2E。
- `gate:m2` 在 M1 上累计 CSL/交换与规范化覆盖率、IPC fuzz、5000 条性能和 M2 Electron E2E；CSL 与 paper-normalize 的硬门槛为 lines/functions `>=90%`、branches `>=85%`。
- `gate:m3` 在 M2 上累计 EvidenceRevision/证据链测试和 M3 Electron E2E。
- `gate:m4` 在 M3 上累计 trusted-ai、安全覆盖率和 M4 Electron E2E；所有远程 AI、学术查询与 PDF 下载均经过统一审计/隐私边界。
- `gate:m5` 在 M4 上累计矩阵 coverage、50 篇批处理/导出性能、真实 Electron 可访问性检查和 M5 E2E。
- 构建缓存准备器会拒绝归档篡改、缓存路径越界或解压树不一致；不依赖用户级 electron-builder 缓存，也不要求管理员/开发者模式。

M0 使用的 fixture 位于 `test/fixtures/`，由固定 seed `20260716` 生成，覆盖空/legacy/损坏 profile、富文本项目、localStorage/IndexedDB、PDF、BibTeX/RIS/CSL-JSON 和 5000/10000 条合成文献。fixture 清单声明仅含合成数据：

```powershell
node scripts/generate-fixtures.js --check
```

### M0 机器证据

| 证据 | 路径 |
|------|------|
| 聚合门禁报告 | `artifacts/quality-summary.json` |
| LCOV 与覆盖率摘要 | `artifacts/coverage/lcov.info`、`artifacts/coverage/coverage-summary.json` |
| 架构 ratchet 报告 | `artifacts/m0/architecture-report.json` |
| 开发版/打包版 smoke | `artifacts/m0/smoke-development.json`、`artifacts/m0/smoke-win-unpacked.json` |
| M0 E2E 报告与导出物 | `artifacts/e2e/m0/report.json`、`artifacts/e2e/m0/EssayFlow.docx`、`artifacts/e2e/m0/EssayFlow.pdf` |
| M1 数据证据 | `artifacts/migration-matrix.json`、`artifacts/crash-matrix.json`、`artifacts/integrity-report.json`、`artifacts/e2e/m1/report.json` |
| M2 引用/性能证据 | `artifacts/coverage/citation/`、`artifacts/coverage/paper-normalize/`、`artifacts/ipc-fuzz.json`、`artifacts/perf-baseline.json`、`artifacts/e2e/m2/report.json` |
| M3 证据链证据 | `artifacts/coverage/evidence/`、`artifacts/e2e/m3/report.json` |
| M4 可信 AI 证据 | `artifacts/coverage/trusted-ai/`、`artifacts/coverage/security/`、`artifacts/e2e/m4/report.json` |
| M5 综述矩阵证据 | `artifacts/coverage/matrix/`、`artifacts/m5-performance.json`、`artifacts/a11y/report.json`、`artifacts/a11y/library-responsive-report.json`、`artifacts/e2e/m5/report.json` |
| 包资产清单 | `artifacts/package-asset-manifest.json` |
| fixture 清单 | `test/fixtures/fixture-manifest.json` |

报告只有在 `passed`/`ok` 为 `true`、命令退出码为 0，并且报告中的 `sourceTreeSha256` 与当前源码一致时才是有效证据。源码或文档变化后，旧报告可能过期，应重新运行门禁。没有可靠 Git base 时，本项目不声称 changed-lines coverage。

## 本地运行资产加载顺序

`src/index.html` 的实际顺序是：

1. `node_modules/quill/dist/quill.snow.css`
2. `src/style.css`
3. `node_modules/pdfjs-dist/build/pdf.min.js`
4. `src/pdf-runtime.js`
5. `src/runtime-bootstrap.js`
6. 页面 DOM
7. `node_modules/quill/dist/quill.js`
8. `node_modules/html2pdf.js/dist/html2pdf.bundle.min.js`
9. `node_modules/mammoth/mammoth.browser.min.js`
10. `src/app.js`
11. `src/ai-assistant.js`
12. `src/settings.js`
13. `src/search.js`

Quill 运行时与依赖声明均为 1.3.6，不再存在“package.json 为 Quill 2、运行时为 Quill 1”的版本分叉。

## Electron 安全边界

主窗口当前启用：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- `navigateOnDragDrop: false`
- `devTools: !app.isPackaged`，即打包版关闭 DevTools
- 全部权限请求/检查默认拒绝
- 新窗口创建一律拒绝；导航离开本地入口时由主进程按协议处理

渲染页 CSP 的 `script-src` 仅允许 `'self'`，`object-src` 和 `base-uri` 为 `'none'`，没有 `unsafe-inline` 或 `unsafe-eval` 脚本许可。样式仍允许 `'unsafe-inline'`；图片和网络连接按现有功能允许 HTTP(S)，因此不能把 CSP 描述为完全离线或零网络权限。

所有 `ipcMain.handle` 调用经过统一 sender 校验；文件保存、读取、导入、下载和请求参数有类型、大小、扩展名或授权路径检查。renderer 不再暴露通用 `netRequest/netStream` 或凭据读取接口；AI、学术查询和远程 PDF 使用语义化主进程 gateway，执行前校验 operation、隐私模式、目标 authority、DNS/SSRF 边界和审计上下文。

### API Key 现状

AI provider 和自定义来源凭据由主进程 SecretStore 保存：仅接受 Electron `safeStorage` 密文 envelope；系统加密不可用时拒绝持久化并标为需要重新输入，不做明文回退。renderer 只能写入凭据或查询“是否已配置”，不能读取明文；Authorization 仅由主进程在执行 gateway 请求时构造。导出设置和项目审计不得包含可复用凭据。

## 自动化隔离模式

Electron 测试由驱动器使用以下内部参数启动：

```text
--essayflow-automation
--essayflow-user-data=<绝对隔离目录>
--essayflow-profile-report=<绝对 JSON 路径>
```

自动化模式要求隔离目录不得与真实 `userData` 相同、包含或重叠，并把 `userData`、session、日志、crash dump 和测试导出放入该目录。它同时在 renderer session、主进程 `net` broker 和外部浏览器入口阻断 HTTP/HTTPS。smoke/E2E 会比较真实 profile 前后快照；若真实 profile 变化，测试失败。

这些参数仅供自动化驱动使用。不要把真实用户目录传给 `--essayflow-user-data`，也不要用自动化模式进行日常写作。

## 数据位置

| 数据 | 当前位置 |
|------|----------|
| 项目聚合 HEAD/提交 | Electron `userData/workspace/projects/{projectId}/HEAD.json`、`commits/` |
| 项目版本 | Electron `userData/workspace/projects/{projectId}/versions/` |
| 全局文库 | Electron `userData/workspace/library/library.json` |
| 受管资产 | Electron `userData/workspace/assets/` |
| 可导出设置/凭据 envelope | Electron `userData/workspace/settings/`、`credentials/` |
| 本地 PDF | Electron `userData/localPdfs/` |
| 编辑器图片 | Electron `userData/images/` |
| 自定义拼写词典 | Electron `userData/dictionary.json` |
| 下载的论文 | 系统下载目录下 `EssayFlowPapers/` |
| UI 偏好与 legacy 兼容键 | renderer `localStorage` |

正文、项目元数据、CitationItem、CitationLink 和 ProjectPaperState 不写 localStorage；它们通过 `save-project-auto` 或专用引用 IPC 进入主进程 repository。旧 localStorage/IndexedDB 文库只作为一次性迁移来源。

## 项目结构与规模

以下行数用于帮助定位当前代码，随修改会变化：

| 文件 | 当前行数 | 作用 |
|------|---------:|------|
| `main.js` | 1467 | Electron 主进程、窗口、IPC、文件与网络能力 |
| `preload.js` | 101 | `window.electronAPI` 安全桥 |
| `src/index.html` | 961 | 主界面与本地运行资产入口 |
| `src/app.js` | 5864 | 编辑器、项目、引用、导入导出等核心逻辑 |
| `src/ai-assistant.js` | 2670 | AI 聊天、行内编辑、附件与查询核对 |
| `src/search.js` | 2350 | 学术搜索、文库和 PDF 视图 |
| `src/settings.js` | 1199 | AI、来源、引用格式与快捷键设置 |
| `src/style.css` | 4604 | 全局界面样式 |
| `src/pdf-runtime.js` | 34 | PDF.js 本地 worker/cMap/font 配置 |
| `src/runtime-bootstrap.js` | 37 | Quill 1.3.6 旧 DOM 事件兼容层 |

测试与工程脚本位于 `test/` 和 `scripts/`；验收合同位于 `ESSAYFLOW_NEXT_STAGE_ACCEPTANCE.md`。

## 里程碑边界

当前仓库实现 `gate:m0` 到 `gate:m5`。`gate:release` 是独立的最终发布边界；portable/NSIS 文件存在或单个测试通过均不能替代它。任何里程碑是否通过仍必须以当前源码同源的门禁报告为准。

## License

MIT
