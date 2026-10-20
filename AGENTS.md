# EssayFlow 项目指南

> 本文件面向 AI 编程助手。先阅读 `ESSAYFLOW_NEXT_STAGE_ACCEPTANCE.md`，再以当前源码、`package.json` 和 `package-lock.json` 为事实来源。不要根据旧文档或已有 artifact 推断某个门禁已经通过。

## 1. 当前阶段与验收边界

EssayFlow 是一款基于 Electron 的桌面学术写作工具。现有能力包括 Quill 富文本编辑、项目自动保存、文献检索与文库、引用和参考文献、AI 辅助、Word 导入/导出、PDF 导出与阅读。

当前源码已实现到 **M5：文献筛选与综述矩阵** 的功能与门禁框架：

- `gate:m0` 已实现，覆盖 fixture、本地运行资产、架构 ratchet、单元测试、开发版 smoke/E2E、`win-unpacked` 构建与打包版 smoke。
- `gate:m1` 在 M0 上增加 repository、migration、版本历史/恢复、回收站、归档、crash/integrity 和真实 Electron M1 E2E。
- `gate:m2` 在 M1 上增加 Citation.js/citeproc-js、标准格式交换、文库组织、IPC fuzz、5000 条性能和真实 Electron M2 E2E。
- `gate:m3` 在 M2 上增加 EvidenceRevision、证据审阅、CitationLink、M3 coverage 与真实 Electron E2E。
- `gate:m4` 在 M3 上增加统一 TrustedAiService gateway、安全传输、GroundedAnswer、ReviewIssue/Diff、审计、隐私模式与真实 Electron M4 E2E。
- `gate:m5` 在 M4 上增加候选筛选、可配置综述矩阵、证据绑定 AI 预填、50 篇取消、安全 CSV/XLSX 导出、a11y/性能和真实 Electron M5 E2E。
- 某次 M0-M5 是否通过，只看对应 `npm run gate:m?` 的退出码，以及同源 `artifacts/quality-summary.json`；单个旧报告不能证明整体通过。
- `gate:release` 尚未实现，portable/NSIS 文件存在也不能声称 release 已通过。
- 当前环境没有可用的可靠 Git base，因此不得声称 changed-lines coverage。

每次修改源码或文档后，之前报告中的 `sourceTreeSha256` 可能过期。最终判断前必须重新运行对应 gate，并核对 `passed`/`ok`、退出码和 source hash。

## 2. 项目结构

```text
essay_save/
├── main.js                         # Electron 主进程、窗口、IPC、文件与网络能力
├── preload.js                      # contextBridge 白名单 API
├── package.json                    # 命令与 electron-builder 配置
├── package-lock.json               # npm lockfile v3
├── build.ps1                       # 使用固定本地代理的旧式 Windows 打包入口
├── build/icon.png                  # 应用图标
├── src/
│   ├── index.html                  # 主界面与本地运行资产入口
│   ├── style.css                   # 全局样式
│   ├── pdf-runtime.js              # PDF.js 本地 worker/cMap/font 配置
│   ├── runtime-bootstrap.js        # Quill 1.3.6 DOMNodeInserted 兼容层
│   ├── app.js                      # 编辑器、项目、引用、导入导出
│   ├── ai-assistant.js             # AI 聊天、行内编辑、附件、查询核对
│   ├── settings.js                 # 设置、来源、引用格式、快捷键
│   └── search.js                   # 学术搜索、文库、PDF 视图
├── scripts/                        # M0-M2 gate、测试驱动、资产/架构/包/性能校验
├── test/
│   ├── baseline/                   # M0 开工、架构和 coverage baseline
│   ├── fixtures/                   # 确定性合成 fixture
│   ├── unit/                       # Node 单元测试
│   ├── e2e/                        # 真实 Electron M0 E2E
│   ├── m1-e2e/、m2-e2e/            # 数据核心与引用/文库 E2E
│   ├── citation/、paper-normalize/ # CSL、交换与规范化测试
│   └── ipc/                        # M2 IPC 边界与 fuzz
├── artifacts/                      # 可再生的机器报告和 E2E 导出物
├── vendor/electron-builder/        # 固定哈希的 winCodeSign 构建归档
└── dist/                           # electron-builder 输出
```

当前运行时代码规模（2026-07-16 快照，后续修改时应重新统计）：

| 文件 | 行数 | 字节数 |
|------|-----:|-------:|
| `main.js` | 1467 | 54768 |
| `preload.js` | 101 | 4733 |
| `src/index.html` | 961 | 55394 |
| `src/app.js` | 5864 | 215090 |
| `src/ai-assistant.js` | 2670 | 97503 |
| `src/search.js` | 2350 | 96381 |
| `src/settings.js` | 1199 | 43254 |
| `src/style.css` | 4604 | 99192 |
| `src/pdf-runtime.js` | 34 | 1230 |
| `src/runtime-bootstrap.js` | 37 | 1260 |

不要把这些行数当作验收指标；它们只用于快速定位。

## 3. 技术栈与固定依赖

| 层级 | 当前事实 |
|------|----------|
| Electron | `^28.0.0` |
| electron-builder | `^24.0.0` |
| Quill | 精确版本 `1.3.6` |
| PDF.js | `pdfjs-dist` 精确版本 `3.11.174` |
| Word/PDF | `mammoth` `1.6.0`、`html2pdf.js` `0.10.1`、`jszip` `3.10.1` |
| UI | 原生 HTML/CSS/JavaScript，无 React/Vue/TypeScript/ES Module |
| 网络 | renderer 经 `window.electronAPI.netRequest/netStream` 调用主进程 Electron `net` |
| 数据 | 主进程文件、renderer localStorage 与 IndexedDB |

Quill 依赖声明和运行时均为 1.3.6，旧文档所述“package 为 2.x、CDN 为 1.3.6”的分叉已经不存在。

### 3.1 本地运行资产

以下核心资产全部从安装包本地加载，不依赖 CDN：

- `node_modules/quill/dist/quill.js` 与 `quill.snow.css`
- `node_modules/pdfjs-dist/build/pdf.min.js` 与 `pdf.worker.min.js`
- `node_modules/pdfjs-dist/cmaps/`，预期 169 个文件
- `node_modules/pdfjs-dist/standard_fonts/`，预期 16 个文件
- `node_modules/html2pdf.js/dist/html2pdf.bundle.min.js`
- `node_modules/mammoth/mammoth.browser.min.js`

`scripts/verify-runtime-assets.js` 校验版本、文件 hash、引用顺序、CSP、远程脚本、内联脚本/事件以及 PDF.js 配置。不要重新引入 CDN 或远程执行 fallback。

### 3.2 index.html 实际加载顺序

`<head>`：

1. Quill Snow CSS
2. `src/style.css`
3. PDF.js
4. `src/pdf-runtime.js`
5. `src/runtime-bootstrap.js`

DOM 完整声明后，`<body>` 末尾：

1. Quill 1.3.6
2. html2pdf.js
3. Mammoth browser bundle
4. `src/app.js`
5. `src/ai-assistant.js`
6. `src/settings.js`
7. `src/search.js`

模块间仍通过全局变量和 `window.xxx` 通信。调整顺序前必须搜索跨文件调用并运行真实 Electron E2E。

## 4. 安装、运行、构建

验收安装必须使用锁文件：

```powershell
npm ci
```

开发启动：

```powershell
npm start
# 等价于 electron .
```

构建 `win-unpacked`：

```powershell
npm run build -- --dir
```

构建 package.json 配置的 Windows portable 与 NSIS：

```powershell
npm run build
```

必须通过 `npm run build` 调用 `scripts/build.js`，不要直接绕过为 `npx electron-builder`。包装器会校验 `vendor/electron-builder/winCodeSign-2.6.0.7z`，在 `tmp/electron-builder-cache/` 生成 canonical tree 已固定的缓存，并解决普通 Windows 账户无法创建归档内 macOS symlink 的问题；`win.signAndEditExecutable` 仍保持启用。

当前典型输出：

```text
dist/win-unpacked/EssayFlow.exe
dist/EssayFlow 1.0.0.exe
dist/EssayFlow Setup 1.0.0.exe
```

`build.ps1` 会硬编码 `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:10809` 并执行 `npm.cmd run build`。它不是 CI 或验收入口；没有对应代理时不要使用。

## 5. M0-M5 测试命令

当前真实可用的主要命令：

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
npm run build -- --dir
npm run verify:package -- --app "dist/win-unpacked/EssayFlow.exe"
npm run gate:m0
npm run gate:m1
npm run gate:m2
npm run gate:m3
npm run gate:m4
npm run gate:m5
```

### 5.1 test:unit

`scripts/run-tests.js --suite unit` 递归枚举 `test/unit/**/*.test.js`，使用 Node 原生测试和原生 coverage，生成：

```text
artifacts/coverage/lcov.info
artifacts/coverage/coverage-summary.json
```

硬门槛：

- lines `>=85%`
- functions `>=85%`
- branches `>=80%`
- 任一指标相对 `test/baseline/coverage.json` 的下降不得超过 2 个百分点

coverage 当前覆盖 M0 新增的工程脚本，不代表 5000 多行 renderer 业务代码已经达到同样覆盖率。不得扩大解释范围。

### 5.2 test:e2e

`test/e2e/m0-baseline.test.js` 驱动真实开发版 Electron，覆盖：

```text
新建项目
→ 输入中英文与标题
→ 插入表格、图片、优先关键词
→ 收藏文献并拖拽引用
→ 自动保存
→ 关闭并重新启动
→ 加载同一项目
→ 验证正文、格式、引用和参考文献
→ 导出 DOCX/PDF 并解析验证文件
```

报告与导出物：

```text
artifacts/e2e/m0/report.json
artifacts/e2e/m0/EssayFlow.docx
artifacts/e2e/m0/EssayFlow.pdf
```

### 5.3 累计 gate

`scripts/run-gate.js --milestone m0` 按顺序执行：

1. `scripts/generate-fixtures.js --check`
2. `scripts/verify-runtime-assets.js`
3. `scripts/check-architecture.js`
4. unit suite
5. development Electron smoke
6. development Electron E2E
7. electron-builder `--dir`
8. `dist/win-unpacked/EssayFlow.exe` 包内容校验
9. `win-unpacked` Electron smoke
10. 证据完整性与 `sourceTreeSha256` 绑定校验

最终聚合报告是 `artifacts/quality-summary.json`。任何一步退出非零、证据缺失或 JSON 报告绑定旧源码，gate 都必须失败。

各 gate 累计包含前序全部步骤。M2 额外要求 citation/paper-normalize、IPC fuzz、性能和 M2 E2E；M3 增加 evidence coverage/M3 E2E；M4 增加 trusted-ai/security coverage 与 M4 E2E；M5 增加 matrix coverage、50 篇性能、a11y 与 M5 E2E。5000 条 fixture 的首屏阈值为 2 秒，组合筛选 p95 为 300ms，页面最多返回 100 条且 DOM paper card 不得超过 200。

### 5.4 发布边界

M0-M5 的累计 gate 已实现。artifact/offline/dependency/final release 只有在对应脚本具备真实验证并退出 0 时才可报告成功；不得添加空测试、skip 或固定成功输出来“补绿”。`gate:pr` 当前仅指向 M0，不能代表 release。

## 6. M0 fixture 与证据

`scripts/generate-fixtures.js` 使用固定 seed `20260716` 生成 `test/fixtures/fixture-manifest.json`。当前 manifest 含 34 个文件和一个声明的空目录，数据约 6 MB，全部为确定性合成内容，不得替换成真实用户 profile、API Key 或未发表正文。

覆盖类别：

- 空首次启动、legacy 与损坏 index profile
- 截断 JSON、重复项目 ID/DOI、未来 schemaVersion
- 中英文富文本、表格、图片、CiteBlot、PriorityKeyword、TableBlot
- localStorage/IndexedDB 文库
- 中文/英文/旋转 text PDF、扫描件、损坏和被替换 PDF
- BibTeX、RIS、CSL-JSON
- 5000/10000 条合成文献

检查 fixture：

```powershell
node scripts/generate-fixtures.js --check
```

证据路径：

| 证据 | 路径 |
|------|------|
| M0 聚合报告 | `artifacts/quality-summary.json` |
| coverage | `artifacts/coverage/lcov.info`、`artifacts/coverage/coverage-summary.json` |
| 架构 | `artifacts/m0/architecture-report.json` |
| smoke | `artifacts/m0/smoke-development.json`、`artifacts/m0/smoke-win-unpacked.json` |
| E2E | `artifacts/e2e/m0/report.json` |
| 包资产 | `artifacts/package-asset-manifest.json` |
| fixture | `test/fixtures/fixture-manifest.json` |

不要在文档中固化会因任何源码修改而变化的 hash。引用报告时，应读取其当前值并确认 `passed`/`ok` 为 true。

## 7. Electron 主进程

`main.js` 创建 1500x900 的 `BrowserWindow` 并加载本地 `src/index.html`。当前 `webPreferences`：

```js
{
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  devTools: !app.isPackaged,
  webSecurity: true,
  spellcheck: true,
  navigateOnDragDrop: false
}
```

另外：

- 打包版关闭 DevTools，开发版保留。
- `setWindowOpenHandler` 始终返回 `deny`；HTTP(S) 外链交给系统浏览器，本地文件只允许受管 PDF 根目录。
- `will-navigate` 阻止离开本地入口。
- permission request/check 默认全部拒绝。
- 拼写检查右键菜单和自定义词典保留。
- CSP 的 `script-src` 为 `'self'`，`object-src`/`base-uri` 为 `'none'`，无脚本 `unsafe-inline`/`unsafe-eval`。
- `style-src` 仍含 `'unsafe-inline'`；`img-src`/`connect-src` 仍允许 HTTP(S)，不要称为零网络权限。

## 8. preload 与真实 IPC

`preload.js` 只暴露当前主进程已有的能力；旧文档所列 `openProject`、`readFolder`、`readFile`、`onFolderOpened`、`saveMmd` 已不在桥中。

invoke 通道：

| preload 方法 | 主进程通道 | 功能 |
|---------------|------------|------|
| `listProjects` | `list-projects` | 读取项目索引 |
| `saveProjectAuto` | `save-project-auto` | 分别写正文并更新索引（尚非跨文件事务） |
| `loadProject` | `load-project` | 读取正文和索引 meta |
| `deleteProject` | `delete-project` | 删除正文和索引项 |
| `importWord` | `import-word` | 选择并读取 `.docx` |
| `selectChatAttachment` | `select-chat-attachment` | 选择 txt/pdf/docx 附件 |
| `selectSavePath` | `select-save-path` | 授权 PDF 保存路径 10 分钟 |
| `saveFile` | `save-file` | 向已授权路径写合法 PDF |
| `saveProject` | `save-project` | 选择路径并保存 `.essay` JSON |
| `saveDocx` | `save-docx` | 生成并保存 Word 文档 |
| `downloadPdfTemp` | `download-pdf-temp` | 下载到临时 PDF 目录 |
| `downloadPdf` | `download-pdf` | 下载到 `EssayFlowPapers` |
| `saveLocalPdf` | `save-local-pdf` | 保存上传 PDF 到 userData |
| `deleteLocalPdf` | `delete-local-pdf` | 删除受管 PDF |
| `readLocalPdf` | `read-local-pdf` | 读取受管 PDF，AI 路径上限 20 MB |
| `saveImage` | `save-image` | 保存支持格式的编辑器图片 |
| `readImageBase64` | `read-image-base64` | 读取受管图片 |
| `encryptApiKey` | `encrypt-api-key` | 尝试 safeStorage 加密 |
| `decryptApiKey` | `decrypt-api-key` | 尝试 safeStorage 解密 |
| `netRequest` | `net-request` | 非流式 HTTP(S) 请求代理 |

renderer 不再暴露通用 `netRequest/netStream` 或凭据读取接口。AI、学术查询和远程 PDF 通过语义化主进程 gateway；所有 invoke handler 经 `registerIpcHandler` 和 `assertTrustedSender`。新增或修改 IPC 时必须同步检查 `main.js`、`preload.js` 和 renderer 调用方，并补 schema/大小/路径/错误测试。

### 8.1 当前安全技术债

M0 架构 baseline 接受但禁止新增的风险包括：

- renderer 仍可经部分 bridge 发起保存操作；尚未达到 M4 的无绝对路径写能力目标。
- 自动化截图 IPC 只在 `--essayflow-automation` 隔离模式工作，不接受路径或目标窗口参数。
- 项目、文库、引用、证据、AI 审计和项目文献状态已进入主进程 repository/store；部分 UI 兼容键仍有 renderer/localStorage 技术债。

不要把“通过 architecture ratchet”解释为这些技术债已清零；它只证明未新增且 M0 hard-zero 规则满足。

## 9. API Key 存储事实

AI provider 与自定义搜索来源凭据由主进程 SecretStore 写入 `workspace/credentials/provider-credentials.json`，只允许 safeStorage 密文 envelope；系统加密不可用时拒绝持久化并返回 `needs-reentry`。renderer 只能提交新凭据或查询配置状态，不能取回明文；Authorization 由主进程 gateway 构造。导出设置、项目包和审计不得包含 API Key、Authorization 或可复用凭据。

## 10. 自动化隔离模式

M0 Electron driver 使用：

```text
--essayflow-automation
--essayflow-user-data=<绝对隔离路径>
--essayflow-profile-report=<绝对 JSON 路径>
```

规则：

- automation flag 必须配绝对 `--essayflow-user-data`。
- 隔离路径不得与默认 userData 相同、包含、被包含或经真实路径解析后重叠。
- `userData`、`sessionData`、logs、crashDumps、TestExports 都重定向到隔离根。
- PDF、DOCX、`.essay` 导出使用隔离目录中的确定性文件名。
- renderer session webRequest、主进程 `net` 和外部浏览器打开三层阻断 HTTP/HTTPS。
- profile report 只能写到隔离 userData 或系统临时目录，不能落入真实 profile。
- smoke/E2E 比较真实 profile 的文件数、mtime 和内容 hash；发生变化即失败。

不要手工把真实 profile 作为自动化路径，也不要绕开 driver 直接跑会写用户目录的 Electron 测试。

## 11. 数据持久化

主进程路径：

| 数据 | 路径 |
|------|------|
| 项目 HEAD/提交 | `app.getPath('userData')/workspace/projects/{id}/HEAD.json`、`commits/` |
| 项目版本 | `app.getPath('userData')/workspace/projects/{id}/versions/` |
| 文库 | `app.getPath('userData')/workspace/library/library.json` |
| 受管资产 | `app.getPath('userData')/workspace/assets/` |
| 本地 PDF | `app.getPath('userData')/localPdfs/` |
| 编辑器图片 | `app.getPath('userData')/images/` |
| 自定义拼写词典 | `app.getPath('userData')/dictionary.json` |
| 下载 PDF | `app.getPath('downloads')/EssayFlowPapers/` |
| 临时 PDF | `app.getPath('temp')/EssayFlowPDFs/` |

关键 localStorage 键：

| 键 | 用途 |
|----|------|
| `essay_ai_config` | provider、base URL、模型、加密或明文 API Key |
| `essay_ai_search_enabled` | AI 关键词辅助开关 |
| `essay_ai_literature_enabled` | AI 文献信息提取开关 |
| `essay_ai_verify_enabled` | `//verify` 数据库查询开关 |
| `essay_default_reference_style` | 默认参考文献格式 |
| `essay_search_sources` | 内置/自定义来源与可能的明文来源 Key |
| `essay_shortcuts` | 快捷键配置 |
| `essay_toolbar_autoclose` | 浮窗自动关闭 |
| `essay_wheel_scroll_key` | 滚轮加速修饰键 |
| `essay_citations_v2` | 按项目分组的引用数据 |
| `essay_library` | 文献库 JSON |
| `essay_library_updated_at` | 文献库更新时间（由常量定义） |
| `essay_project_meta_{id}` | 项目标题、作者、课程等 meta |
| `mindmap_collapsed_{id}` | 思维导图折叠状态 |
| `essay_theme` | 深浅主题 |
| `essay_horizontal_flex` / `essay_vertical_flex` | 面板布局 |

正文、项目 meta、CitationItem、CitationLink、ProjectPaperState 和全局文库不得写 localStorage；分别使用 `saveProjectAuto`、引用 IPC 和 LibraryStore。旧 localStorage/IndexedDB 文库只作为幂等迁移输入；UI 偏好仍可保留在 localStorage。

## 12. renderer 模块

### 12.1 src/app.js

主要负责：

- Quill 初始化、工具栏与兼容补丁
- `TableBlot`、`CiteBlot`、`PriorityKeywordBlot`
- 项目新建/保存/加载/删除
- 字数统计、主题、布局和思维导图
- Word 导入、DOCX/PDF/项目导出
- 引用编号、六种参考文献格式与双向清理
- 表格、图片、搜索替换、段落动作与格式浮窗
- 全局快捷键和滚轮加速

旧版重复的段落操作函数已收敛为文件末尾一套定义。修改前仍应使用 `rg` 确认唯一性，不要根据旧行号修改不存在的副本。

### 12.2 src/ai-assistant.js

负责 AI 配置读取/解密、OpenAI 兼容请求、SSE、聊天、附件、斜杠命令、行内编辑和 `//verify` 查询。

`//verify` 只是 Crossref/Semantic Scholar 元数据查询和字符串层面的对比。代码当前可能显示“真实存在”等强结论，但工程文档和新增 UI 不得把 API 命中称为权威真实性证明；正式引用仍需用户核对原始出版来源。

### 12.3 src/search.js

负责 arXiv、Semantic Scholar、Crossref、CORE、OpenAlex、自定义来源、搜索取消/合并、文献卡片、文库、PDF 详情和 IndexedDB 镜像。文库检索采用常驻搜索框、可折叠高级筛选、可移除活动标签和可折叠批量操作，并以右侧面板容器宽度在单列/双列间响应；修改时必须保留 280/360/480px 无横向溢出与键盘可访问性测试。

第三方 API 结果可能缺失、延迟、重复或错误。不要把来源数量、结果命中或 cited count 当作学术验证。

### 12.4 src/settings.js

负责 AI provider、连接测试、AI 开关、默认引用格式、论文来源 CRUD、快捷键录制和特殊滚轮键。

`APP_DEFAULT_SHORTCUTS`（app.js）和 `DEFAULT_SHORTCUTS`（settings.js）仍各维护一份默认值；修改时必须同步并测试冲突处理。

## 13. Quill 1.3.6 注意事项

自定义 Blot：

| blotName | DOM | 说明 |
|----------|-----|------|
| `table` | `DIV.ql-table-embed` | 原始 HTML 表格容器 |
| `cite` | `SUP` | `data-paper-id`、`data-citation-num` |
| `priorityKeyword` | `SPAN.priority-keyword` | 关键词值与提取结果 |

规则：

- `src/runtime-bootstrap.js` 在 Quill 加载前把其 `DOMNodeInserted` 监听转为 MutationObserver 兼容行为。
- 直接修改编辑器 DOM 后调用 `quill.update()`，或优先使用 Delta/API，防止 DOM 与 Delta 不同步。
- 修改表格、引用、图片、优先关键词或加载顺序后，至少运行 `test:e2e`。
- 不得把 Quill 升级到 2.x 当作小版本更新；需要单独迁移并全面回归自定义 Blot 和键盘行为。

## 14. 默认快捷键

| 功能 | 默认键 |
|------|--------|
| 加粗/斜体/下划线 | `Ctrl+B` / `Ctrl+I` / `Ctrl+U` |
| 删除线 | `Ctrl+Shift+X` |
| 标题 1/2/3 | `Ctrl+Alt+1/2/3` |
| 有序/无序列表 | `Ctrl+Shift+7/8` |
| 引用块 | `Ctrl+Shift+9` |
| 代码块 | `Ctrl+Shift+C` |
| 链接 | `Ctrl+K` |
| 清除格式 | `Ctrl+Shift+L` |
| 保存 | `Ctrl+S` |
| 查找替换 | `Ctrl+F` |

滚轮加速键默认 `Ctrl`，倍率为 3.5。

## 15. 开发约定

1. 先阅读验收合同对应里程碑，按 M0 → M1 → M2 → M3 → M4 → M5 顺序推进。
2. 保持原生 JavaScript 与现有全局通信风格，除非当前里程碑明确要求迁移边界。
3. 新增 IPC 同步修改主进程、preload、renderer 和测试；默认拒绝任意路径、任意 URL 和未校验 payload。
4. 文件写入优先使用现有原子写 helper；不要新增无边界 `fs` 业务写入。
5. 不要新增业务 localStorage 双写；M1 应向 repository 单一真相迁移。
6. 不把用户 profile、真实 API Key、真实论文或未发表正文放入 fixture/artifacts。
7. 不引入 CDN、远程脚本、动态执行 fallback、内联脚本或内联事件处理器。
8. UI 与注释以中文为主；错误信息应具体，不吞掉失败或制造假成功。
9. 保留已有用户改动；工作树可能没有可用 Git 元数据，以 canonical source tree manifest 追踪输入。
10. 修改后按风险运行单测、真实 Electron E2E 和对应里程碑 gate。

## 16. 文档与交付纪律

- README 面向使用者与贡献者；AGENTS 面向后续编程代理；两者都必须陈述当前事实而非目标态。
- 不得宣称 safeStorage 始终可用；明文回退和 renderer 持钥必须如实记录。
- 不得称学术 API 查询为“权威验证”。
- 不得用已有 portable/NSIS、单个 E2E 或旧 hash 声称 release 通过。
- 不得把 M0 architecture baseline 当成最终架构清零。
- 每次 gate 后检查报告绑定的 `sourceTreeSha256`，不复用旧报告。
- 只有 M0-M5、`gate:release`、最终 E2E、完整性、依赖、离线、性能和所有一票否决项都通过后，才能给出总体“通过”。

本文件应随代码与验收阶段同步更新。
