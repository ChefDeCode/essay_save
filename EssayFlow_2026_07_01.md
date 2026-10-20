# EssayFlow 踩坑记录文档

> **生成日期**：2026-07-01
> **生成者**：AI 开发助手
> **项目名**：EssayFlow
> **文档版本**：v1.0.0

---

## 简要总结

本文档记录了 EssayFlow（学术智能写作助手）从 0 到 1 的开发全过程踩坑记录。项目基于 Electron + 原生 JavaScript 构建，核心功能包括富文本编辑器、多源学术数据库搜索、AI 辅助写作、引用与文献管理。文档按 12 个章节系统梳理了技术选型、核心功能实现、第三方库集成、数据存储、UI 设计、跨平台兼容等维度的实际踩坑经验，包含具体现象、根因分析、解决代码和预防措施。

---

## 一、项目介绍

### 一句话定义

EssayFlow 是一款面向学术研究者的桌面端智能写作助手，基于 Electron 构建，将富文本编辑器、多源学术数据库、AI 对话助手和文献管理系统整合为单一应用。

### 应用场景

- **学术研究者**：查找文献、撰写论文、管理引用、生成参考文献
- **高校师生**：课程论文、毕业论文、期刊投稿
- **知识工作者**：需要大量引用和结构化排版的文档写作

解决的问题：传统写作工具（Word/WPS）缺少内置学术搜索和 AI 辅助；在线学术工具（Google Scholar/Zotero）缺少集成写作环境；用户需要在多个应用间反复切换。

### 技术架构（分层结构图）

```text
┌────────────────────────────────────────────────────────────┐
│                        用户界面层                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ 编辑器   │  │ 搜索面板 │  │ AI 面板  │  │ 设置面板 │   │
│  │ Quill   │  │ 论文卡片 │  │ 聊天窗口 │  │ 快捷键   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
├────────────────────────────────────────────────────────────┤
│                      渲染进程逻辑层                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ app.js   │  │ search.js│  │ ai-      │  │settings.js│  │
│  │ (编辑器) │  │(论文搜索)│  │assistant │  │(配置管理)│  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
├────────────────────────────────────────────────────────────┤
│                     IPC 通信层（preload.js）                  │
│         contextBridge.exposeInMainWorld('electronAPI')     │
├────────────────────────────────────────────────────────────┤
│                      主进程层（main.js）                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Browser  │  │ ipcMain  │  │ 文件系统 │                  │
│  │ Window  │  │ handlers │  │ fs API  │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
├────────────────────────────────────────────────────────────┤
│                     外部服务层                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  arXiv   │  │Semantic  │  │ Crossref │  │  AI API  │   │
│  │  API    │  │ Scholar  │  │  API    │  │ DeepSeek │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└────────────────────────────────────────────────────────────┘
```

### 当前状态（功能清单）

| 功能 | 状态 | 说明 |
|------|------|------|
| 富文本编辑器 | ✅ 完成 | Quill 1.3.6，支持标题/列表/引用/表格/图片 |
| 深色/浅色主题 | ✅ 完成 | CSS 变量 + body.dark 切换，207 条覆盖规则 |
| 学术搜索（5源） | ✅ 完成 | arXiv + Semantic Scholar + Crossref + CORE + OpenAlex |
| 文献库管理 | ✅ 完成 | 收藏、删除、PDF 下载、元数据提取 |
| 拖拽引用 | ✅ 完成 | 从搜索面板拖拽到编辑器，自动插入上角标 |
| 参考文献生成 | ✅ 完成 | 6 种格式：APA/MLA/Chicago/IEEE/Harvard/GB/T 7714 |
| 引用双向检测 | ✅ 完成 | 删除角标自动清理参考文献，反之亦然 |
| AI 对话助手 | ✅ 完成 | 流式输出，支持附件上传 |
| 行内 AI 编辑 | ✅ 完成 | 空格唤起，5 种操作模式 |
| 文献验证（//verify） | ✅ 完成 | Crossref + Semantic Scholar 双源验证 |
| 思维导图 | ✅ 完成 | 基于标题层级自动生成，折叠状态持久化 |
| 段落拖拽 | ✅ 完成 | 支持 heading/paragraph/table，Delta 批量操作 |
| 块级工具栏 | ✅ 完成 | 文本选中时显示，支持 10+ 操作 |
| 优先关键词 | ✅ 完成 | 鼠标悬停显示提取的关键词 |
| 搜索替换 | ✅ 完成 | VS Code 风格，支持正则 |
| Word 导入 | ✅ 完成 | mammoth 解析，保留基本格式 |
| PDF 导出 | ✅ 完成 | html2pdf.js，含完整样式 |
| Word 导出 | ✅ 完成 | 自定义 OpenXML + 图片嵌入 |
| 项目自动保存 | ✅ 完成 | 30 秒间隔 + 状态指示器 |
| 快捷键系统 | ✅ 完成 | 13 个快捷键，可自定义 |
| 拼写检查 | ✅ 完成 | Electron 内置，自定义词汇持久化 |

### 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | ^28.0.0 |
| 运行时 | Node.js | 18+ |
| 编辑器 | Quill | 1.3.6 (CDN) |
| 打包工具 | electron-builder | ^24.0.0 |
| Word 导入 | mammoth | ^1.6.0 |
| PDF 导出 | html2pdf.js | ^0.10.1 |
| Word 导出 | JSZip | ^3.10.1 (已内置) |
| PDF 预览 | pdf.js | 3.11.174 (CDN) |

### 项目目录结构

```text
essay_save/
├── main.js              # Electron 主进程入口
├── preload.js           # 安全桥接脚本
├── package.json         # 项目配置与打包
├── build.ps1            # Windows 打包脚本
├── build/icon.png       # 应用图标
├── src/
│   ├── index.html       # 应用主界面（~964行）
│   ├── style.css        # 全局样式（~4478行）
│   ├── app.js           # 核心逻辑（~5189行）
│   ├── ai-assistant.js  # AI 助手（~2025行）
│   ├── search.js        # 论文搜索（~1570行）
│   └── settings.js      # 设置面板（~1000行）
├── AGENTS.md            # 项目开发指南（面向AI助手）
├── README.md            # 项目介绍文档
└── dist/                # 打包输出目录
```

---

## 二、项目架构决策

### 为什么选 Electron + 原生 JavaScript（对比方案）

**对比过的方案：**

| 方案 | 优势 | 劣势 | 结论 |
|------|------|------|------|
| Tauri + Rust + React | 体积小、安全、现代 | 学习曲线陡、Rust 生态不成熟 | ❌ 放弃 |
| Electron + Vue/React | 组件化、生态丰富 | 引入构建工具、包体积大、状态管理复杂 | ❌ 放弃 |
| Electron + 原生 JS | 零构建、零依赖、直接操作 DOM、调试直观 | 代码组织松散、全局变量污染 | ✅ 选择 |

**选择理由：**
1. **零构建工具**：不需要 Webpack/Vite，开发时直接修改文件，Ctrl+Shift+R 刷新即可验证
2. **直接操作 Quill**：原生 JS 可以直接调用 `quill.getContents()`、`quill.updateContents()`，无需框架封装层
3. **快速迭代**：5 个文件共约 10,000 行，全部在单一目录，搜索和修改效率极高
4. **Electron 原生能力**：文件系统访问、本地存储、右键菜单、拼写检查，无需额外桥接

**付出的代价：**
- 全局变量通信（`window.libraryPapers`、`window.showToast` 等），维护成本随规模增长
- 无 TypeScript 类型检查，运行时错误只能通过 `node -c` 语法检查和手动测试发现

### 目录结构为什么这么设计

```text
src/
├── index.html    # 单页应用，所有面板通过 CSS display 切换
├── style.css     # 所有样式集中管理，方便深色模式统一覆盖
├── app.js        # 核心渲染逻辑（最大文件，约 5000 行）
├── ai-assistant.js  # AI 相关独立出来，避免 app.js 过于庞大
├── search.js     # 搜索面板独立，因为生命周期与编辑器不同
└── settings.js   # 配置面板独立，只在用户点击时初始化
```

**设计原则：按功能生命周期划分，而非按技术层划分。**
- `app.js` 贯穿整个应用生命周期（编辑器、项目管理、引用、导出）
- `search.js` 只在右侧搜索面板激活时工作（搜索、收藏、PDF 预览）
- `ai-assistant.js` 和 `settings.js` 都是按需加载的面板逻辑

### 模块之间如何解耦

实际上**没有完全解耦**，这是原生 JS 项目的固有限制。模块间通过以下方式通信：

```javascript
// 全局变量通信（最常用）
window.libraryPapers = [];        // search.js 写入，app.js 读取
window.showToast = showToast;      // app.js 定义，search.js 调用
window.openEditModal = openEditModal;  // app.js 定义，search.js 调用

// DOM 事件冒泡（跨模块通信）
// 例如：拖拽论文卡片 → document.dispatchEvent('dragover') → app.js 监听

// localStorage 共享状态（持久化解耦）
localStorage.setItem('essay_citations_v2', JSON.stringify(citations));
localStorage.getItem('essay_library');
```

**改进措施：** 后来添加了 `AGENTS.md` 文档，明确列出所有全局接口，防止修改时遗漏引用位置。

---

## 三、硬件/外部接口踩坑记录

### 3.1 学术 API 通信协议

**涉及接口：** arXiv、Semantic Scholar、Crossref、CORE、OpenAlex

#### 坑 1：Semantic Scholar 429 限流导致搜索失败

**🔴 现象**：搜索时 Semantic Scholar 返回 429 Too Many Requests，后续搜索结果全部丢失，面板显示空白。

**根因**：`fetchWithRetry` 遇到非 429 错误时直接返回 `null`，调用方检查 `if (!response)` 后返回空数组，导致该来源的结果完全丢失。同时，各来源按顺序执行，Semantic Scholar 失败后等待 1.5 秒才继续下一个来源，浪费时间。

**解决代码：**

```javascript
// 改进的 fetchWithRetry：返回错误原因码而非 null
async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      let response;
      if (window.electronAPI?.netRequest) {
        // 使用主进程代理（webSecurity=true 时）
        const result = await window.electronAPI.netRequest({...});
        response = { ok: result.status >= 200 && result.status < 300, ... };
      } else {
        response = await fetch(url, options);
      }
      if (response.ok) return response;
      if (response.status === 429 && i < retries) {
        await delay((i + 1) * 5000);  // 5s, 10s 渐进重试
        continue;
      }
      return { error: true, reason: 'HTTP_' + response.status };
    } catch (err) {
      return { error: true, reason: 'NETWORK' };
    }
  }
  return { error: true, reason: 'MAX_RETRIES' };
}
```

**预防措施**：将顺序 for 循环改为 `Promise.allSettled` 并发请求，每个来源独立 10 秒超时：

```javascript
const promises = sources.map(async (source) => {
  const sourceTimeout = new AbortController();
  const timeoutId = setTimeout(() => sourceTimeout.abort(), 10000);
  try {
    // ... 搜索逻辑
  } catch (e) { console.warn(...); }
  finally { clearTimeout(timeoutId); }
});
await Promise.allSettled(promises);
```

---

#### 坑 2：Crossref API 作者姓名字段不统一

**🔴 现象**：Crossref 返回的论文作者显示为 `[object Object]` 或空字符串。

**根因**：Crossref 的 `author` 数组中每个元素是对象 `{ given: 'John', family: 'Doe' }`，但代码假设为字符串数组或带 `name` 属性的对象。其他来源（Semantic Scholar、CORE）的作者格式各不相同。

**解决代码：**

```javascript
// Crossref 作者解析
const authors = (item.author || []).map(a => 
  `${a.given || ''} ${a.family || ''}`.trim()
).join(', ');

// CORE 作者解析（三种格式）
if (Array.isArray(item.authors)) {
  authors = item.authors.map(a => {
    if (typeof a === 'string') return a;
    if (a && a.name) return a.name;
    return '';
  }).filter(Boolean).join(', ');
}
```

**预防措施**：每个来源独立一个 `searchXxx` 函数，内部处理各自的数据格式差异，对外统一返回 `{ id, title, abstract, authors, published, link, pdfLink, hasPdf }` 标准格式。

---

#### 坑 3：webSecurity=false 导致 CORS 问题 + 安全隐患

**🟡 现象**：`webSecurity: false` 允许跨域请求，但生产环境不安全。同时，PDF 导出时 blob URL 图片无法渲染（被安全策略阻止）。

**根因**：开发时为了调用学术 API 和加载外部图片，设置了 `webSecurity: false`。但这是全局关闭，不仅影响 API 调用，还影响所有外部资源加载。

**解决代码：**

```javascript
// main.js: 改为 webSecurity: true，通过主进程代理外部请求
webPreferences: {
  webSecurity: true,  // 生产环境安全
  // ...
}

// 新增主进程代理 IPC
ipcMain.handle('net-request', async (event, { url, method, headers, body }) => {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method, headers });
    request.on('response', (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.end();
  });
});

// 渲染进程调用
const result = await window.electronAPI.netRequest({ url, method: 'GET' });
```

**预防措施**：
- 渲染进程不再直接 `fetch` 外部 URL，统一走 `electronAPI.netRequest`
- 对于 AI 流式输出（SSE），新增 `net-stream` IPC 通道，通过 `net.request` 代理后逐 chunk 回传

---

## 四、核心功能实现踩坑记录

### 4.1 引用系统状态机

**引用系统的状态转移：**

```text
                    ┌─────────────┐
                    │   无引用    │
                    └──────┬──────┘
                           │ 拖拽论文
                           ▼
                    ┌─────────────┐
     ┌─────────────│   已插入    │──────────────┐
     │ 删除引用角标 │  (有角标)   │  生成参考文献 │
     │             └──────┬──────┘               │
     ▼                  │ 双向检测              ▼
┌─────────────┐         │               ┌─────────────┐
│ 引用已删除   │◄────────┘               │ 参考文献已  │
│  (清理)     │                         │  生成       │
└─────────────┘                         └──────┬──────┘
                                               │
                                               │ 删除参考文献段落
                                               ▼
                                        ┌─────────────┐
                                        │  引用已移除 │
                                        │  (清理角标) │
                                        └─────────────┘
```

**关键状态：双向检测。** 删除引用角标时自动清理参考文献列表；删除参考文献段落时自动清理对应的引用角标。

#### 坑 4：引用双向检测逐个删除导致索引偏移

**🔴 现象**：删除参考文献段落时，编辑器内的引用角标没有被正确删除，或者删错了位置。

**根因**：代码使用 `quill.deleteText(index, length)` 逐个删除每个角标。Quill 的 `deleteText` 会改变后续内容的索引，导致从后往前删除时（`sort((a,b) => b.index - a.index)`）仍然出错，因为 `b.index` 是基于删除前的快照，实际 DOM 可能已经变化。

**解决代码：**

```javascript
// 使用 Delta 一次性批量删除所有角标，避免索引偏移
if (toRemove.length > 0) {
  const Delta = Quill.import('delta');
  const delta = new Delta();
  let currentIndex = 0;
  toRemove.sort((a, b) => a.index - b.index).forEach(({ index, length }) => {
    if (index > currentIndex) {
      delta.retain(index - currentIndex);  // 保留前面的内容
    }
    delta.delete(length);  // 删除角标
    currentIndex = index + length;  // 更新当前位置
  });
  quill.updateContents(delta, Quill.sources.SILENT);
}
```

**预防措施**：所有涉及多处删除/插入的操作，统一使用 Quill Delta 的 `retain + delete` 链，而不是逐个 `deleteText`。

---

#### 坑 5：段落拖拽 Delta 序列化丢失嵌套内容

**🔴 现象**：拖拽包含图片或表格的段落时，图片消失或表格损坏。

**根因**：`quill.getContents()` 获取 Delta 时，图片和表格等复杂 blot 的序列化可能不完整。Quill 1.3.6 的 `getContents` 对嵌套 blot 支持有限。

**解决代码：**

```javascript
// 检测复杂格式，使用 HTML 复制粘贴方式
const sourceHtml = quill.getHTML ? quill.getHTML(sourceIndex, sourceLength) : '';
const hasComplexFormat = sourceHtml.includes('<img') || 
                          sourceHtml.includes('<table') || 
                          sourceHtml.includes('<sup data-paper-id');

if (hasComplexFormat) {
  try {
    const domNode = state.sourceLine.domNode;
    const html = domNode.outerHTML;
    quill.deleteText(sourceIndex, sourceLength, Quill.sources.USER);
    const adjustedTargetIndex = (sourceIndex < targetIndex) ? 
      (targetIndex - sourceLength) : targetIndex;
    quill.clipboard.dangerouslyPasteHTML(adjustedTargetIndex, html);
  } catch (e) {
    // 回退到 Delta 方式
    hasComplexFormat = false;
  }
}

if (!hasComplexFormat) {
  // 简单格式：使用 Delta 操作
  const sourceDelta = quill.getContents(sourceIndex, sourceLength);
  const Delta = Quill.import('delta');
  let deltaOps;
  if (sourceIndex < targetIndex) {
    deltaOps = new Delta()
      .retain(sourceIndex)
      .delete(sourceLength)
      .retain(targetIndex - sourceLength - sourceIndex)
      .concat(sourceDelta);
  } else {
    deltaOps = new Delta()
      .retain(targetIndex)
      .concat(sourceDelta)
      .retain(sourceIndex - targetIndex)
      .delete(sourceLength);
  }
  quill.updateContents(deltaOps, Quill.sources.USER);
}
```

**预防措施**：
- 拖拽前先检测段落内容类型
- 复杂格式使用 `dangerouslyPasteHTML`，简单格式使用 Delta
- 所有方式都添加 `try/catch` 回退机制

---

#### 坑 6：AI 请求无超时导致 UI 永久 loading

**🔴 现象**：用户发送 AI 请求后，如果网络断开或服务器无响应，loading 动画永远转圈，无法取消。

**根因**：`fetch` 默认没有超时，且没有绑定 `AbortController`。

**解决代码：**

```javascript
async function requestAI(messages, onSuccess, onError, signal, onStream) {
  // 创建 AbortController，支持外部 signal 和 30 秒超时
  const controller = new AbortController();
  const effectiveSignal = controller.signal;
  let onExternalAbort = null;

  if (signal) {
    onExternalAbort = () => controller.abort();
    signal.addEventListener('abort', onExternalAbort);
  }

  let isTimeout = false;
  const timeoutId = setTimeout(() => {
    isTimeout = true;
    console.warn('[requestAI] 请求超时 (30s)，已取消');
    controller.abort();
  }, 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ... },
      body: JSON.stringify(body),
      signal: effectiveSignal
    });
    // ...
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      if (isTimeout && onError) {
        onError(new Error('AI 请求超时，请检查网络或稍后重试'));
      }
      return null;
    }
    if (onError) onError(err);
    return null;
  }
}
```

**预防措施**：
- 所有外部网络请求（AI、学术搜索）统一设置超时
- 超时后清理所有资源（timer、event listener）
- 返回明确的错误信息，而非静默失败

---

## 五、第三方库集成踩坑记录

### 5.1 Quill 版本兼容性（最大坑）

**🔴 现象**：`package.json` 中 `quill` 依赖为 `^2.0.2`，但 `index.html` 通过 CDN 加载的是 `1.3.6`，导致两者 API 不兼容。

**根因**：开发初期安装 npm 包时选了最新版（2.0.2），但运行时为了简化加载方式改用 CDN 引入 1.3.6。后来针对 1.3.6 做了大量兼容代码，但 `package.json` 一直未同步。

**影响：**
- Quill 2.x 的 `find()` 方法签名改变
- 2.x 的 Delta 操作行为不同
- 2.x 移除了部分 1.x 的 blot 注册方式
- 如果使用 npm 包而非 CDN，应用会直接崩溃

**解决代码：**

```json
// package.json - 将 quill 版本同步为 1.3.6
"dependencies": {
  "quill": "^1.3.6",
  "mammoth": "^1.6.0",
  "html2pdf.js": "^0.10.1"
}
```

**预防措施**：
- 所有运行时依赖（通过 CDN 加载的）必须在 `package.json` 中同步版本
- 在 `AGENTS.md` 中明确标注版本差异警告
- 升级 Quill 前需全面回归测试编辑器、表格、引用、优先关键词等核心功能

---

### 5.2 html2pdf.js 导出 blob URL 图片失败

**🔴 现象**：PDF 导出时，编辑器中通过 `URL.createObjectURL` 插入的图片无法渲染，显示为空白。

**根因**：`html2pdf.js` 使用 `html2canvas` 将 HTML 转换为 Canvas 再生成 PDF，但 `html2canvas` 无法处理跨域的 blob URL（即使 `webSecurity: false` 也不行）。

**解决代码：**

```javascript
// 不再使用 blob URL，改为保存到本地磁盘
// 插入图片时：FileReader → base64 → IPC → 保存到 userData/images/ → 使用 file:// URL

const reader = new FileReader();
reader.onload = async (e) => {
  const dataUrl = e.target.result;
  const base64Data = dataUrl.split(',')[1];
  const filePath = await window.electronAPI.saveImage(base64Data, safeName);
  const fileUrl = 'file://' + filePath.replace(/\\/g, '/');
  quill.insertEmbed(index, 'image', fileUrl);
};
reader.readAsDataURL(file);
```

**预防措施**：
- 插入图片时同步保存到磁盘，避免 blob URL 生命周期问题
- 图片删除/替换时调用 `URL.revokeObjectURL()` 释放内存

---

### 5.3 JSZip 生成 Word 时图片关系缺失

**🔴 现象**：Word 导出时图片丢失，只显示文字。

**根因**：OpenXML (docx) 中图片需要在三个地方注册：
1. `[Content_Types].xml` 中声明图片 MIME 类型
2. `word/_rels/document.xml.rels` 中定义图片关系 ID
3. `word/document.xml` 中通过 `<w:drawing>` 引用关系 ID

最初的代码只处理了第 3 步（HTML 转 OpenXML 时嵌入图片标签），但缺少 1 和 2。

**解决代码（主进程）：**

```javascript
ipcMain.handle('save-docx', async (event, { wordXml, images = [] }) => {
  const zip = new JSZip();
  
  // 1. [Content_Types].xml
  const contentTypes = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${images.map(img => `<Default Extension="${img.ext}" ContentType="image/${img.ext === 'jpg' ? 'jpeg' : img.ext}"/>`).join('\n  ')}
</Types>`;
  zip.file('[Content_Types].xml', contentTypes);
  
  // 2. word/_rels/document.xml.rels
  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  ${images.map((img, i) => `<Relationship Id="${img.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.filename}"/>`).join('\n  ')}
</Relationships>`;
  zip.file('_rels/.rels', rels);
  
  // ...
});
```

**预防措施**：
- docx 是 ZIP 格式的 OpenXML，任何资源（图片、样式、字体）都需要在 `[Content_Types].xml` 和 `.rels` 文件中声明
- 使用预定义的 `relId` 生成规则（如 `rIdImage1`、`rIdImage2`），确保 HTML 中的引用和 rels 文件中的定义一致

---

## 六、数据存储设计

### 6.1 格式选择

| 数据类型 | 存储方式 | 选择理由 |
|----------|----------|----------|
| 项目正文 | 文件系统 (`fs.writeFile`) | 内容可能超过 10MB，不适合 localStorage |
| 项目索引 | JSON 文件 (`index.json`) | 结构简单，无需数据库 |
| 用户配置 | `localStorage` | 快速读取，无需 IPC |
| 文献库 | `localStorage` + `IndexedDB` | 突破 5MB 限制，IndexedDB 作为回退 |
| 引用数据 | `localStorage` | 按项目分组，key 为 `essay_citations_v2` |
| 自定义拼写词汇 | JSON 文件 (`dictionary.json`) | 需要持久化，跨会话共享 |
| 图片缓存 | 文件系统 (`userData/images/`) | 大文件，需要 file:// URL 访问 |

### 6.2 文献库 IndexedDB 迁移

**🔴 现象**：用户收藏了 500+ 篇论文后，localStorage 报 `QuotaExceededError`，文献库数据丢失。

**根因**：localStorage 容量约 5MB，文献库每篇论文约 2-5KB，500 篇约 2.5MB，加上其他配置很容易超限。

**解决代码：**

```javascript
// IndexedDB 封装
const LIB_DB_NAME = 'EssayFlowDB';
const LIB_DB_VERSION = 1;
const LIB_STORE_NAME = 'library';

function openLibraryDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LIB_DB_NAME, LIB_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(LIB_STORE_NAME)) {
        db.createObjectStore(LIB_STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

async function saveLibraryToDB() {
  const db = await openLibraryDB();
  const tx = db.transaction(LIB_STORE_NAME, 'readwrite');
  const store = tx.objectStore(LIB_STORE_NAME);
  await new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
  for (const paper of libraryPapers) {
    store.put(paper);
  }
}

function saveLibrary() {
  const data = JSON.stringify(libraryPapers);
  const sizeBytes = new Blob([data]).size;
  if (sizeBytes > 4.5 * 1024 * 1024) {
    window.showToast('文献库数据较大，建议导出备份');
  }
  try {
    localStorage.setItem('essay_library', data);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.error('[saveLibrary] localStorage 已满，已回退到 IndexedDB');
    }
  }
  // 异步写入 IndexedDB 作为主要持久化
  saveLibraryToDB().catch(e => console.warn('[saveLibrary] IndexedDB 异步写入失败:', e));
}
```

**预防措施**：
- 初始化时先加载 localStorage，再异步从 IndexedDB 加载覆盖（确保数据不丢失）
- 保存时双写：同步写 localStorage（兼容），异步写 IndexedDB（可靠）
- 超过 4.5MB 时提示用户导出备份

---

## 七、模型/算法相关

### 7.1 AI 流式输出（SSE）解析

**算法**：使用 `fetch` 的 `ReadableStream` + `TextDecoder` 逐行解析 SSE 格式。

**SSE 格式示例：**

```
data: {"choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[{"delta":{"content":" world"}}]}

data: [DONE]
```

**坑：SSE 数据可能被分割在多个 chunk 中**

**🔴 现象**：AI 输出出现乱码或 JSON 解析错误，如 `{"choices":` 被截断，下一 chunk 才是 `[{"delta":...}]`。`

**根因**：网络传输将数据分割为任意大小的 chunk，一个 SSE 行可能跨多个 chunk，或多个 SSE 行在一个 chunk 中。

**解决代码：**

```javascript
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let fullContent = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  
  // 按行分割，保留未完成的行在 buffer 中
  const lines = buffer.split('\n');
  buffer = lines.pop();  // 最后一行可能不完整
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const data = trimmed.slice(6);  // 去掉 'data: '
    if (data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        onStream(delta, fullContent);  // 实时回调
      }
    } catch (e) { /* 解析失败，跳过 */ }
  }
}

// 处理剩余缓冲区
if (buffer.trim()) {
  const trimmed = buffer.trim();
  if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
    try {
      const json = JSON.parse(trimmed.slice(6));
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onStream(delta, fullContent + delta);
    } catch (e) {}
  }
}
```

**预防措施**：
- 始终使用 `buffer` 机制，不假设每个 chunk 包含完整的 SSE 行
- `decoder.decode(value, { stream: true })` 保持文本流状态，处理多字节字符截断
- 解析失败时静默跳过，不中断整个流

---

### 7.2 文献验证双源交叉算法

**算法**：当用户在 AI 聊天中输入 `//verify DOI/标题` 时，同时查询 Crossref 和 Semantic Scholar，对比两个数据库返回的结果。

**匹配逻辑：**

```javascript
const titleMatch = cr.title && ss.title && 
  (cr.title.toLowerCase().includes(ss.title.toLowerCase().substring(0, 20)) ||
   ss.title.toLowerCase().includes(cr.title.toLowerCase().substring(0, 20)));
const doiMatch = cr.doi && ss.doi && 
  cr.doi.toLowerCase() === ss.doi.toLowerCase();

if (titleMatch || doiMatch) {
  return '✅ 双源交叉验证一致，该文献真实存在';
} else {
  return '⚠️ 两个数据库均有结果，但信息不完全一致，建议进一步核实';
}
```

**关键参数：**
- `substring(0, 20)`：标题匹配使用前缀 20 字符，因为不同数据库的标题可能有细微差异（如副标题、大小写）
- 查询 `rows=3`：返回 3 个结果，取第一个最佳匹配，避免单一结果误匹配

---

## 八、UI设计规范

### 8.1 配色方案

**浅色模式：**

| 变量 | 色值 | 用途 |
|------|------|------|
| `--bg-body` | `#f0f0f0` | 页面背景 |
| `--bg-main` | `#ffffff` | 主内容区背景 |
| `--bg-sidebar` | `#1e2a4a` | 左侧工具栏 |
| `--text-primary` | `#1a1a2a` | 主要文字 |
| `--text-secondary` | `#666666` | 次要文字 |
| `--border-color` | `#e0e0e0` | 边框 |

**深色模式：**

| 变量 | 色值 | 用途 |
|------|------|------|
| `--bg-body` | `#1a1a2e` | 页面背景 |
| `--bg-main` | `#16213e` | 主内容区背景 |
| `--bg-sidebar` | `#0f3460` | 左侧工具栏 |
| `--text-primary` | `#e0e0e0` | 主要文字 |
| `--text-secondary` | `#a0a0b0` | 次要文字 |
| `--border-color` | `#2a3a5a` | 边框 |

**坑：深色模式下编辑器底板色差**

**🔴 现象**：编辑区中间有一块颜色更深（`#1a1a2e`）的矩形底板，与周围（`#16213e`）不一致，且随文章增长而扩大。

**根因**：`#editor-container` 设置了 `background: var(--bg-body)`（`#1a1a2e`），而父容器 `#workspace` 使用 `var(--bg-main)`（`#16213e`）。

**解决：**

```css
#editor-container {
  /* 移除独立背景，改为透明 */
  /* background: var(--bg-body);  ← 删除 */
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
}

body.dark .ql-editor,
body.dark .ql-container.ql-snow {
  background: transparent;  /* 继承父容器背景 */
}
```

---

### 8.2 图标系统

**要求：纯 SVG，禁止 emoji。**

每个图标使用 `<svg>` 内联，尺寸统一为 20×20 viewBox：

```html
<!-- 保存图标 -->
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
  <polyline points="17 21 17 13 7 13 7 21"/>
  <polyline points="7 3 7 8 15 8"/>
</svg>
```

**坑：SVG 颜色在不同主题下显示异常**

**解决**：使用 `currentColor` 作为 stroke，让 SVG 继承父元素的 CSS `color` 属性。深色模式父元素 `color: #e0e0e0`，浅色模式 `color: #1a1a2a`，SVG 自动适应。

---

### 8.3 布局结构

**固定三栏布局**，非响应式（桌面应用不需要响应式）：

```css
#app-container {
  display: flex;
  height: 100vh;
}

#left-sidebar {
  width: 60px;           /* 固定宽度 */
  flex-shrink: 0;
}

#workspace {
  flex: 1;               /* 占据剩余空间 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

#editor-container {
  max-width: 900px;      /* 编辑器最大宽度，类似 A4 纸 */
  margin: 0 auto;
}

#search-panel {
  width: 450px;          /* 固定宽度，可拖拽调整 */
  flex-shrink: 0;
}
```

**可拖拽调整的面板：**
- 左侧工作区 vs 右侧搜索面板：水平拖拽（`makeResizable`）
- 搜索主区 vs AI 聊天面板：垂直拖拽（`makeVerticalResizable`）
- 拖拽后大小保存到 `localStorage`，下次启动恢复

---

### 8.4 实时更新机制

**引用区域检测**：使用 `MutationObserver` 监听编辑器 DOM 变化，当参考文献段落被删除时，自动清理对应的引用角标。

```javascript
function setupRefSectionObserver() {
  const observer = new MutationObserver((mutations) => {
    if (isUpdatingReferences) return;
    let hasRemoved = false;
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.removedNodes.forEach((node) => {
          if (node.matches && node.matches('[data-ref-section]')) {
            hasRemoved = true;
          }
        });
      }
    });
    if (hasRemoved) {
      clearTimeout(debounceTimer);
      // 300ms debounce + requestIdleCallback 延迟执行
      debounceTimer = setTimeout(() => {
        requestIdleCallback(() => generateReferences());
      }, 300);
    }
  });
  observer.observe(editorEl, { childList: true, subtree: true });
}
```

**坑：MutationObserver 频繁触发导致卡顿**

**根因**：每次打字、粘贴、格式化都会触发 MutationObserver，如果直接调用 `generateReferences()`（涉及遍历全文 DOM），大文档（10万字）会严重卡顿。

**解决**：添加 300ms debounce + `requestIdleCallback`，在浏览器空闲时执行。

---

## 九、操作系统/环境特有坑

### 9.1 编码问题

**🟡 现象**：Windows 用户打开软件后，中文显示为乱码（如 `????`）。

**根因**：HTML 文件未显式声明 charset，Windows 默认使用 GBK 编码解析 UTF-8 文件。

**解决**：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>EssayFlow</title>
</head>
```

---

### 9.2 路径分隔符（Windows 反斜杠）

**🔴 现象**：图片保存到磁盘后，使用 `file://` URL 在编辑器中无法显示。控制台报错 `Not allowed to load local resource`。

**根因**：
1. Windows 路径使用反斜杠 `C:\Users\...\image.png`，但 `file://` URL 需要正斜杠 `file:///C:/Users/.../image.png`
2. 即使路径正确，Electron `webSecurity: true` 下 `file://` 协议对本地文件访问有限制

**解决代码：**

```javascript
// 保存图片后，转换为 file:// URL
const filePath = await window.electronAPI.saveImage(base64Data, safeName);
// Windows 路径：C:\Users\... → file:///C:/Users/...
const fileUrl = 'file://' + filePath.replace(/\\/g, '/');
quill.insertEmbed(index, 'image', fileUrl);
```

**预防措施**：
- 所有涉及文件路径的字符串操作，统一使用 `path.replace(/\\/g, '/')`
- 通过主进程代理 `file://` 请求（`net.request` 支持本地文件协议）

---

### 9.3 CRLF 换行导致 Git 冲突和工具报错

**🟡 现象**：在 Windows 上编辑的 `index.html` 和 `style.css` 文件包含 CRLF (`\r\n`) 换行，Linux/Mac 工具处理时会出现 `\r` 残留，导致字符串匹配失败。

**根因**：Windows 默认使用 CRLF，Git 未配置 `core.autocrlf`，导致跨平台协作时换行不一致。

**解决**：

```bash
# 配置 Git 自动处理换行
git config --global core.autocrlf true

# 在 .gitattributes 中显式声明
*.js text eol=lf
*.css text eol=lf
*.html text eol=lf
```

**在代码中处理**：Node.js 的 `readFileSync` 返回字符串时，`\r\n` 会被保留。使用 `String.prototype.trim()` 或正则替换：

```javascript
const content = fs.readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
```

---

### 9.4 环境管理

**项目使用 npm 管理依赖，不使用 conda/venv。**

**坑：npm 全局安装 electron 后，项目本地 electron 版本冲突**

**解决**：使用 `npx electron .` 运行，确保使用 `node_modules` 中的本地版本，而非全局版本。

```json
// package.json
"scripts": {
  "start": "electron .",
  "build": "electron-builder"
}
```

---

## 十、Debug技巧

### 10.1 日志系统配置

项目中没有使用 Winston/Pino 等专业日志库，直接使用 `console.log` + `console.error` + `console.warn`。

**日志规范（手动约定）：**

```javascript
// 统一日志前缀，便于过滤
console.log('[Search] 搜索关键词:', query);
console.warn('[Search] Semantic Scholar 限流，等待重试...');
console.error('[requestAI] 错误:', err);
console.warn('[Verify] Crossref 验证失败:', e);

// 在生产环境中，Electron 主进程的日志输出到控制台
// 渲染进程日志在 DevTools Console 中查看
```

**坑：生产环境没有 DevTools 时无法查看日志**

**解决**：在 `main.js` 中启用日志文件写入：

```javascript
const logPath = path.join(app.getPath('userData'), 'app.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logStream.write(line);
  process.stdout.write(line);
};
```

---

### 10.2 语法检查方法

由于项目使用原生 JS（无 TypeScript），使用 `node -c` 进行语法检查：

```bash
# 检查单个文件
node -c src/app.js
node -c src/ai-assistant.js
node -c src/search.js
node -c src/settings.js
node -c main.js
node -c preload.js

# 批量检查
for f in src/*.js main.js preload.js; do echo "Checking $f..."; node -c "$f" || break; done
```

**注意**：`node -c` 只检查语法，不检查运行时错误（如未定义变量、类型错误）。

---

### 10.3 内存泄漏检查

**常见泄漏源：**

1. **blob URL 未释放**：`URL.createObjectURL` 创建的 blob URL 需要在图片删除/替换时调用 `URL.revokeObjectURL()`
2. **Event Listener 未移除**：拖拽、MutationObserver、IntersectionObserver 等需要在组件销毁时移除
3. **setInterval/setTimeout 未清理**：自动保存、debounce 等需要在页面卸载时清理

**解决措施**：
- 图片改为保存到磁盘（`file://` URL），不再使用 blob URL
- `MutationObserver` 使用全局变量引用，在需要时调用 `observer.disconnect()`
- 自动保存使用 `setInterval`，在 `beforeunload` 事件中清理

---

### 10.4 性能分析工具

**Chrome DevTools Performance 面板：**
- 记录页面交互，分析长任务（Long Tasks）
- 发现 `generateReferences()` 是大文档卡顿的主因，优化后通过 debounce 解决

**Node.js 内置 profiler：**
```bash
node --prof main.js
node --prof-process isolate-0x...-v8.log > profile.txt
```

**Electron 内存分析：**
- 主进程：`process.memoryUsage()`
- 渲染进程：DevTools Memory 面板

---

## 十一、后续优化方向

### 1. 自动保存改为增量保存（而非全量覆盖）
**现状**：每次自动保存都写入整个 HTML 内容（`quill.root.innerHTML`），大文档时 IO 开销大。
**改进**：使用 Quill Delta 的 `diff` 算法，只保存变更部分，减少磁盘写入量和耗时。

### 2. 引用格式支持更多国标和期刊自定义格式
**现状**：支持 6 种常用格式。
**改进**：支持 CSL（Citation Style Language）格式，用户可导入 `.csl` 文件，覆盖数千种期刊格式。

### 3. AI 助手支持多轮对话上下文压缩
**现状**：`trimChatHistory` 按轮数和字符数截断，可能丢失重要上下文。
**改进**：使用 AI 自动总结对话历史，保留关键信息的同时减少 token 消耗。

### 4. 项目支持多标签页编辑
**现状**：单项目编辑，切换项目需要关闭当前项目。
**改进**：支持多项目同时打开，类似 VS Code 的 workspace 机制，每个项目一个标签页。

### 5. 引入自动化测试
**现状**：完全依赖手动测试，回归成本高。
**改进**：使用 Playwright 或 Spectron（Electron 测试框架）编写核心功能 E2E 测试：新建项目 → 编辑 → 搜索 → 引用 → 导出。

---

## 十二、附录：提示词模板

以下提示词用于让后续 AI 助手继续按本文档格式记录项目演进：

```
你是一名专业的技术文档工程师。请根据提供的项目代码变更和讨论记录，按照以下格式生成一份踩坑记录文档的增量更新。

【文档格式要求】
- 文件命名：[项目名]_[年]_[月]_[日].md
- 必须包含 12 个章节：项目介绍、架构决策、硬件/接口、核心功能、第三方库、数据存储、模型/算法、UI设计、操作系统、Debug技巧、后续优化、附录提示词
- 每个坑包含：现象（🔴/🟡/🟢）→ 根因 → 解决代码 → 预防措施
- 代码块用 ```javascript 或 ```python 标注
- 章节开头有简要总结
- 文档末尾标注：生成者、日期、项目名

【增量更新规则】
- 如果已有前序文档，先读取前序文档，在此基础上追加新增内容
- 不删除已有内容，只追加或修改已变更的部分
- 版本号递增（v1.0.0 → v1.1.0）
- 在"后续优化方向"中，已完成的优化标记为 ✅，新增优化方向

【输入材料】
- 项目代码变更（git diff 或文件修改记录）
- 开发者讨论记录（问题描述、解决方案、验证结果）
- 新功能设计文档

【输出要求】
直接输出完整的 markdown 内容，保存到项目根目录，覆盖旧文档或创建新文档。
```

---

## 文档信息

- **生成者**：AI 开发助手
- **生成日期**：2026-07-01
- **项目名**：EssayFlow
- **文档版本**：v1.0.0
- **总字数**：约 15,000 字
- **涵盖范围**：从项目启动到 v1.0.0 的全部开发历程

---

*本文档基于实际项目代码和开发经验编写，所有代码片段均来自项目源码。随着项目演进，请使用第十二章的提示词模板继续增量更新。*
