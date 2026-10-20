// ================== 初始化 Quill 编辑器 ==================
const quill = new Quill('#editor-container', {
  theme: 'snow',
  placeholder: '',
  modules: {
    toolbar: {
      container: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ color: [] }, { background: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        [{ align: '' }, { align: 'center' }, { align: 'right' }],
        ['blockquote', 'code-block']
      ]
    },
    keyboard: {
      bindings: {
        // 接管默认格式快捷键，由自定义快捷键系统统一处理
        bold: null,
        italic: null,
        underline: null
      }
    }
  }
});

// 清理空的 code-block 行
function cleanupEmptyCodeBlocks() {
  const currentRange = quill.getSelection();
  const currentLine = currentRange ? quill.getLine(currentRange.index) : null;
  const currentLineBlot = currentLine ? currentLine[0] : null;

  const lines = quill.getLines(0, quill.getLength());
  // 从后往前遍历，避免删除后索引变化
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    const lineIndex = quill.getIndex(line);
    const lineLength = line.length();
    const text = quill.getText(lineIndex, lineLength);
    const isEmpty = !text || text.replace(/\s/g, '').length === 0;

    // 检查是否是 code-block
    const format = quill.getFormat(lineIndex, 1);
    if (!format['code-block']) continue;

    // 如果行为空且光标不在该行，删除
    if (isEmpty && line !== currentLineBlot) {
      quill.deleteText(lineIndex, lineLength, 'silent');
    }
  }
}

// 光标离开 code-block 时，自动清理空的 code-block
quill.on('selection-change', (range, oldRange) => {
  // 只有从 code-block 内部移出时才处理（且之前不是框选）
  if (!oldRange || oldRange.length > 0) return;

  const oldFormat = quill.getFormat(oldRange.index, 1);
  if (!oldFormat['code-block']) return;

  // 延迟 10ms，确保选区已稳定
  setTimeout(() => {
    cleanupEmptyCodeBlocks();
  }, 10);
});

// 给 Quill toolbar 按钮添加悬浮提示
function setupQuillToolbarTooltips() {
  const toolbar = document.querySelector('.ql-toolbar.ql-snow');
  if (!toolbar) return;

  const tooltips = [
    { sel: '.ql-header', text: '标题样式' },
    { sel: '.ql-bold', text: '加粗' },
    { sel: '.ql-italic', text: '斜体' },
    { sel: '.ql-underline', text: '下划线' },
    { sel: '.ql-strike', text: '删除线' },
    { sel: '.ql-color', text: '文字颜色' },
    { sel: '.ql-background', text: '背景颜色' },
    { sel: '.ql-list[value="ordered"]', text: '有序列表' },
    { sel: '.ql-list[value="bullet"]', text: '无序列表' },
    { sel: '.ql-align', text: '对齐方式' },
    { sel: '.ql-blockquote', text: '引用' },
    { sel: '.ql-code-block', text: '代码块' }
  ];

  tooltips.forEach(({ sel, text }) => {
    const el = toolbar.querySelector(sel);
    if (el && !el.hasAttribute('data-tooltip')) {
      el.setAttribute('data-tooltip', text);
    }
  });
}
setupQuillToolbarTooltips();

// 修复 Quill picker（颜色/背景色/标题/对齐等）点击后丢失选区的问题
function setupColorPickerFix() {
  const toolbar = document.querySelector('.ql-toolbar.ql-snow');
  if (!toolbar) return;

  let savedRange = null;

  // 点击 picker label/item 时：阻止默认焦点转移（防止编辑器失去焦点导致选区闪烁），同时保存选区
  toolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.ql-picker-label') || e.target.closest('.ql-picker-item')) {
      e.preventDefault();
      savedRange = quill.getSelection();
      const item = e.target.closest('.ql-picker-item');
    }
  }, true);

  // 点击 picker item 后恢复选区（让 Quill 先应用格式，再恢复选区）
  toolbar.addEventListener('click', (e) => {
    if (e.target.closest('.ql-picker-item')) {
      const item = e.target.closest('.ql-picker-item');
      const value = item?.getAttribute('data-value') || '';
      setTimeout(() => {
        if (savedRange) {
          quill.setSelection(savedRange.index, savedRange.length, 'silent');
          savedRange = null;
        }
      }, 0);
    }
  }, true);
}
setupColorPickerFix();

// ================== 字数统计 ==================
function countWords(text) {
  // 近似 Word 2019 字数统计
  // 中文：每个汉字算 1 个字
  // 英文/数字：连续的字母/数字序列（含连字符、撇号）算 1 个词
  const chinese = text.match(/[\u4e00-\u9fff]/g) || [];
  const words = text.match(/[a-zA-Z0-9]+(?:[-'][a-zA-Z0-9]+)*/g) || [];
  return chinese.length + words.length;
}

function saveProjectMeta() {
  if (!isLoadingProject) markProjectDataDirty();
  return true;
}

function loadProjectMeta(meta) {
  currentProjectMeta = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? { ...meta }
    : null;
  updateActiveCitationStyleControl();
}

function updateWordCount() {
  const btn = document.getElementById('word-count-btn');
  const currentEl = document.getElementById('word-count-current');
  const goalEl = document.getElementById('word-count-goal');
  if (!btn || !currentEl) return;

  const text = quill.root?.innerText || quill.getText();
  const count = countWords(text);
  currentEl.textContent = count;

  const goal = currentProjectMeta?.wordLimit ? parseInt(currentProjectMeta.wordLimit, 10) : 0;

  if (goal > 0) {
    btn.classList.add('has-goal');
    goalEl.style.display = '';
    goalEl.textContent = ` / ${goal}`;
    if (count >= goal) {
      if (!btn.classList.contains('goal-reached')) {
        btn.classList.add('goal-reached');
      }
    } else {
      btn.classList.remove('goal-reached');
    }
  } else {
    btn.classList.remove('has-goal');
    btn.classList.remove('goal-reached');
    goalEl.style.display = 'none';
    goalEl.textContent = '';
  }
}

// 注册表格 Embed Blot，让 Quill 1.3.6 正式"认识"表格，避免被 update() 吃掉
const BlockEmbed = Quill.import('blots/block/embed');
const Parchment = Quill.import('parchment');
const EssayflowAnchorAttributor = new Parchment.Attributor.Attribute(
  'essayflowAnchor',
  'data-essayflow-anchor',
  { scope: Parchment.Scope.BLOCK }
);
Quill.register(EssayflowAnchorAttributor, true);
class TableBlot extends BlockEmbed {
  static create(value) {
    const node = super.create();
    node.setAttribute('contenteditable', 'false');
    if (typeof value === 'string') {
      node.innerHTML = sanitizeEditorHtml(value);
    } else if (value && value.html) {
      node.innerHTML = sanitizeEditorHtml(value.html);
    }
    return node;
  }
  static value(node) {
    return node.innerHTML;
  }
}
TableBlot.blotName = 'table';
TableBlot.tagName = 'div';
TableBlot.className = 'ql-table-embed';
Quill.register(TableBlot);

// 监听 Quill 工具栏按钮点击，防止点击时页面跳转到文档开头
const toolbar = document.querySelector('.ql-toolbar');
const editorElForToolbar = document.querySelector('#editor-container .ql-editor');
let toolbarClickScrollTop = null;

if (toolbar && editorElForToolbar) {
  toolbar.addEventListener('mousedown', () => {
    toolbarClickScrollTop = workspace.scrollTop;
  });

  editorElForToolbar.addEventListener('focusin', () => {
    if (toolbarClickScrollTop !== null) {
      workspace.scrollTop = toolbarClickScrollTop;
      toolbarClickScrollTop = null;
    }
  });
}

const Highlight = Quill.import('formats/background');
Highlight.whitelist = ['#fff3c9', 'yellow', '#e6b422'];
Quill.register(Highlight, true);

// 注册引用角标自定义 Blot，使 data-paper-id 成为 Quill 格式的一部分
const Inline = Quill.import('blots/inline');
class CiteBlot extends Inline {
  static create(value) {
    const node = super.create();
    if (value && typeof value === 'object') {
      if (value.citationInstanceId) node.setAttribute('data-citation-instance-id', value.citationInstanceId);
      node.setAttribute('data-paper-id', value.paperId || '');
      node.setAttribute('data-citation-num', value.num || '');
    }
    node.style.cursor = 'pointer';
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', '编辑引用');
    return node;
  }
  static formats(node) {
    const citationInstanceId = node.getAttribute('data-citation-instance-id');
    const paperId = node.getAttribute('data-paper-id');
    const num = node.getAttribute('data-citation-num');
    if (citationInstanceId || paperId) {
      return { citationInstanceId, paperId, num };
    }
    return undefined;
  }
}
CiteBlot.blotName = 'cite';
CiteBlot.tagName = 'SUP';
Quill.register(CiteBlot);

// 注册优先关键词自定义 Blot
class PriorityKeywordBlot extends Inline {
  static create(value) {
    const node = super.create();
    node.setAttribute('data-priority-keyword', 'true');
    if (value && value.keyword) node.setAttribute('data-keyword-value', value.keyword);
    if (value && value.extracted) node.setAttribute('data-extracted-keywords', value.extracted);
    node.className = 'priority-keyword';
    return node;
  }
  static formats(node) {
    if (node.hasAttribute('data-priority-keyword')) {
      return {
        keyword: node.getAttribute('data-keyword-value') || '',
        extracted: node.getAttribute('data-extracted-keywords') || ''
      };
    }
    return undefined;
  }
}
PriorityKeywordBlot.blotName = 'priorityKeyword';
PriorityKeywordBlot.tagName = 'SPAN';
Quill.register(PriorityKeywordBlot);

// 查找结果使用独立格式标记，避免覆盖用户原有的文字背景色。
class FindHighlightBlot extends Inline {
  static create(value) {
    const node = super.create();
    node.classList.add('essay-find-highlight');
    node.setAttribute('data-find-highlight', value === 'current' ? 'current' : 'match');
    return node;
  }
  static formats(node) {
    return node.getAttribute('data-find-highlight') || 'match';
  }
  format(name, value) {
    if (name === FindHighlightBlot.blotName && value) {
      this.domNode.setAttribute('data-find-highlight', value === 'current' ? 'current' : 'match');
      return;
    }
    super.format(name, value);
  }
}
FindHighlightBlot.blotName = 'findHighlight';
FindHighlightBlot.tagName = 'SPAN';
FindHighlightBlot.className = 'essay-find-highlight';
Quill.register(FindHighlightBlot);

// ================== 项目管理 ==================
let currentProjectId = null;
let currentProjectRevision = -1;
let autoSaveTimer = null;
let autoSaveInFlight = null;
let autoSaveQueued = false;
let documentRevision = 0;
let savedRevision = 0;
let isLoadingProject = false;
let derivedUpdateTimer = null;
let projectLoadToken = 0;
let appInitializationComplete = false;

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getFirstH1() {
  const h1 = quill.root.querySelector('h1');
  return h1 ? h1.textContent.trim() : '';
}

function getPersistableEditorHtml() {
  const clone = quill.root.cloneNode(true);
  clone.querySelectorAll('[data-find-highlight]').forEach(marker => {
    marker.replaceWith(...Array.from(marker.childNodes));
  });
  clone.querySelectorAll('.ql-cursor').forEach(cursor => cursor.remove());
  return clone.innerHTML;
}

function sanitizeEditorHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ''), 'text/html');
  const blockedTags = new Set([
    'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM',
    'SVG', 'MATH', 'VIDEO', 'AUDIO', 'SOURCE'
  ]);

  doc.body.querySelectorAll('*').forEach(element => {
    if (blockedTags.has(element.tagName)) {
      element.remove();
      return;
    }
    Array.from(element.attributes).forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
        return;
      }
      if ((name === 'href' || name === 'src') && /^\s*(?:javascript|vbscript):/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    });
    if (element.tagName === 'A' && element.hasAttribute('href')) {
      element.setAttribute('rel', 'noopener noreferrer');
    }
  });

  return doc.body.innerHTML;
}

function cancelScheduledAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

function markProjectDataDirty() {
  documentRevision++;
  updateSaveStatus('unsaved');
  cancelScheduledAutoSave();
  autoSaveTimer = setTimeout(autoSaveProject, 1000);
}

async function autoSaveProject() {
  if (!window.electronAPI?.saveProjectAuto) return { success: false, reason: 'desktop-only' };

  if (autoSaveInFlight) {
    autoSaveQueued = true;
    return autoSaveInFlight;
  }

  autoSaveInFlight = (async () => {
    do {
      autoSaveQueued = false;
      const revisionToSave = documentRevision;
      const content = getPersistableEditorHtml();
      // 项目名称是项目级元数据。用户在项目中心明确重命名后，不应被正文
      // 中第一个标题的后续自动保存悄悄覆盖。
      const title = currentProjectMeta?.title || getFirstH1() || '未命名';
      if (!currentProjectId) currentProjectId = generateId();
      const projectIdToSave = currentProjectId;

      updateSaveStatus('saving');
      const result = await window.electronAPI.saveProjectAuto({
        projectId: projectIdToSave,
        title,
        content,
        baseRevision: currentProjectRevision,
        meta: { ...(currentProjectMeta || {}), title },
        citations,
        source: 'renderer-autosave'
      });
      if (!result?.success || result.durable !== true || result.journalState !== 'COMPLETE') {
        throw new Error(result?.message || '项目写入失败');
      }

      // 保存完成时项目可能已切换，旧项目的 revision 不能污染新项目状态。
      if (currentProjectId === projectIdToSave) {
        currentProjectRevision = result.revision;
        const responseWasSuperseded = documentRevision > revisionToSave || autoSaveQueued;
        if (!responseWasSuperseded) {
          currentProjectMeta = { ...(currentProjectMeta || {}), title };
          if (Array.isArray(result.project?.citations)) citations = result.project.citations;
        }
        savedRevision = Math.max(savedRevision, revisionToSave);
        if (!responseWasSuperseded) void renderReferencesFromMain();
      }
    } while (autoSaveQueued || documentRevision > savedRevision);

    updateSaveStatus('saved');
    return { success: true };
  })().catch(err => {
    updateSaveStatus('error');
    console.warn('自动保存失败:', err);
    window.showToast?.(`自动保存失败：${err.message || '请检查磁盘空间'}`);
    return { success: false, message: err.message };
  }).finally(() => {
    autoSaveInFlight = null;
    if (autoSaveQueued) {
      autoSaveQueued = false;
      cancelScheduledAutoSave();
      autoSaveTimer = setTimeout(autoSaveProject, 2000);
    }
  });

  return autoSaveInFlight;
}

function ensureHeadingIds() {
  const headings = quill.root.querySelectorAll('h1, h2, h3');
  headings.forEach(h => {
    if (!h.getAttribute('data-id')) {
      h.setAttribute('data-id', generateId());
    }
  });
}

function setupAutoSave() {
  quill.on('text-change', (delta, oldDelta, source) => {
    if (isLoadingProject) return;
    documentRevision++;

    // 检测是否有纯格式变化（如切换字体/标题），防止 Quill 自动滚动到顶部
    const hasFormatChange = delta.ops && delta.ops.some(op => op.attributes && !op.insert && !op.delete);
    if (hasFormatChange) {
      const savedScrollTop = workspace.scrollTop;
      requestAnimationFrame(() => {
        workspace.scrollTop = savedScrollTop;
      });
    }

    clearTimeout(autoSaveTimer);
    updateSaveStatus('unsaved');
    autoSaveTimer = setTimeout(autoSaveProject, 1000);

    // 全文统计、标题扫描和参考文献重建统一防抖，长文档连续输入时只做一次。
    clearTimeout(derivedUpdateTimer);
    derivedUpdateTimer = setTimeout(() => {
      ensureHeadingIds();
      updateWordCount();
      if (mindmapVisible) renderMindmap();
      if (!isUpdatingReferences) generateReferences();
    }, 250);

    if (findReplacePanel?.classList.contains('visible') && document.getElementById('find-input')?.value) {
      clearTimeout(findInputTimer);
      findInputTimer = setTimeout(performFind, 160);
    }
  });

  // 定时兜底只保存脏数据，避免无修改时持续写盘。
  setInterval(() => {
    if (currentProjectId && documentRevision > savedRevision) autoSaveProject();
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && documentRevision > savedRevision) {
      autoSaveProject();
    }
  });
}

function updateSaveStatus(state) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.dataset.state = state;
  const titles = {
    saved: '已保存',
    saving: '保存中...',
    unsaved: '有未保存的更改',
    error: '保存失败，稍后将重试'
  };
  el.title = titles[state] || '';
  el.setAttribute('aria-label', titles[state] || '保存状态');
}

async function loadProject(id) {
  if (!window.electronAPI?.loadProject) return;
  const loadToken = ++projectLoadToken;
  isLoadingProject = true;
  quill.enable(false);
  quill.root.setAttribute('aria-busy', 'true');
  try {
    if (currentProjectId && documentRevision > savedRevision) {
      cancelScheduledAutoSave();
      const pendingSave = await autoSaveProject();
      if (!pendingSave?.success) throw new Error('当前项目尚未保存，已取消切换');
    }
    const data = await window.electronAPI.loadProject(id);
    if (loadToken !== projectLoadToken) return { success: false, reason: 'superseded' };
    if (!data || typeof data.content !== 'string') {
      throw new Error('项目内容不存在或已损坏');
    }

    isLoadingProject = true;
    currentProjectId = data.projectId || id;
    currentProjectRevision = Number.isSafeInteger(data.revision) ? data.revision : -1;
    window.dispatchEvent(new CustomEvent('essayflow-project-loaded', {
      detail: { projectId: currentProjectId, revision: currentProjectRevision }
    }));
    quill.root.innerHTML = sanitizeEditorHtml(data.content || '<p><br></p>');
    quill.update(Quill.sources.SILENT);
    loadProjectMeta(data.meta);
    const citationUpgradeNeeded = loadCitations(data.citations);
    // 兼容旧数据：为只保留显示编号的 sup 绑定稳定引用实例。
    const editorEl = quill.root;
    const allSups = editorEl.querySelectorAll('sup');
    allSups.forEach((sup, index) => {
      if (!sup.hasAttribute('data-citation-instance-id')) {
        const text = sup.textContent;
        const match = text.match(/\[(\d+)\]/);
        if (match) {
          const num = parseInt(match[1], 10);
          const citation = citations[num - 1] || citations[index];
          if (citation) {
            sup.setAttribute('data-citation-instance-id', citation.citationInstanceId || citation.id);
            sup.setAttribute('data-citation-num', num);
            sup.style.cursor = 'pointer';
            sup.setAttribute('tabindex', '0');
            sup.setAttribute('role', 'button');
            sup.setAttribute('aria-label', '编辑引用');
          }
        }
      }
    });
    generateReferences(true);
    if (mindmapVisible) renderMindmap();
    updateWordCount();
    documentRevision = 0;
    savedRevision = 0;
    updateSaveStatus('saved');
    if (citationUpgradeNeeded) markProjectDataDirty();
    else void renderReferencesFromMain();
    window.showToast(`已加载项目：${data.meta?.title || ''}`);
    return { success: true };
  } catch (err) {
    if (loadToken !== projectLoadToken) return { success: false, reason: 'superseded' };
    console.warn('加载项目失败:', err);
    window.showToast?.(`加载失败：${err.message || '项目不可用'}`);
    return { success: false, message: err.message };
  } finally {
    if (loadToken === projectLoadToken) {
      isLoadingProject = false;
      if (appInitializationComplete) {
        quill.enable(true);
        quill.root.removeAttribute('aria-busy');
      }
    }
  }
}

async function deleteProject(id) {
  if (!window.electronAPI?.deleteProject) return;
  const deletingCurrentProject = currentProjectId === id;

  if (deletingCurrentProject) {
    projectLoadToken++;
    isLoadingProject = true;
    quill.enable(false);
    quill.root.setAttribute('aria-busy', 'true');
    cancelScheduledAutoSave();
    autoSaveQueued = false;
    if (autoSaveInFlight) await autoSaveInFlight;
    cancelScheduledAutoSave();
    autoSaveQueued = false;
  }

  try {
    const result = await window.electronAPI.deleteProject({
      projectId: id,
      baseRevision: deletingCurrentProject ? currentProjectRevision : undefined
    });
    if (!result?.success) throw new Error(result?.message || result?.error || '删除失败');
    localStorage.removeItem(`mindmap_collapsed_${id}`);
    if (deletingCurrentProject && currentProjectId === id) {
      currentProjectId = generateId();
      currentProjectRevision = -1;
      currentProjectMeta = null;
      citations = [];
      mindMapData = {};
      mindMapDataProjectId = null;
      quill.setContents([], Quill.sources.SILENT);
      documentRevision = 0;
      savedRevision = 0;
      updateWordCount();
      if (mindmapVisible) renderMindmap();
      updateSaveStatus('saved');
    }
    await renderProjectsModal();
    window.showToast?.('项目已移至回收站');
  } catch (err) {
    if (deletingCurrentProject && documentRevision > savedRevision) {
      autoSaveTimer = setTimeout(autoSaveProject, 2000);
    }
    window.showToast?.(`删除失败：${err.message || '请重试'}`);
  } finally {
    if (deletingCurrentProject) {
      isLoadingProject = false;
      quill.enable(true);
      quill.root.removeAttribute('aria-busy');
    }
  }
}

async function renderProjectsModal() {
  const listDiv = document.getElementById('projects-list');
  const countEl = document.getElementById('project-count');
  const trashCountEl = document.getElementById('project-trash-count');
  if (!listDiv) return;
  if (!window.electronAPI?.listProjects) return;
  let projects;
  try {
    const [activeProjects, trashItems] = await Promise.all([
      window.electronAPI.listProjects(),
      window.electronAPI.listTrash?.() || Promise.resolve([])
    ]);
    projects = activeProjects;
    if (!Array.isArray(projects)) throw new Error('项目索引格式无效');
    if (trashCountEl) {
      const trashCount = Array.isArray(trashItems) ? trashItems.length : 0;
      trashCountEl.textContent = String(trashCount);
      trashCountEl.setAttribute('aria-label', `回收站中有 ${trashCount} 个项目`);
    }
  } catch (err) {
    listDiv.innerHTML = '<div class="project-empty-state">项目列表读取失败，请稍后重试</div>';
    if (countEl) countEl.textContent = '读取失败';
    window.showToast?.(`项目列表读取失败：${err.message || '未知错误'}`);
    return;
  }
  if (projects.length === 0) {
    listDiv.innerHTML = '<div class="project-empty-state"><strong>还没有项目</strong><span>从左侧工具栏创建第一个写作项目。</span></div>';
    if (countEl) countEl.textContent = '0 个项目';
    return;
  }
  if (countEl) countEl.textContent = `${projects.length} 个项目`;
  listDiv.innerHTML = projects.map(p => {
    const safeId = escapeHtml(p.id);
    const updatedAt = new Date(p.updatedAt);
    const displayDate = Number.isNaN(updatedAt.getTime()) ? '时间未知' : updatedAt.toLocaleString();
    return `
    <div class="project-item${p.id === currentProjectId ? ' is-current' : ''}" data-id="${safeId}" data-revision="${Number.isSafeInteger(p.revision) ? p.revision : 0}">
      <div class="project-info">
        <div class="project-title-line"><div class="project-title">${escapeHtml(p.title || '未命名')}</div>${p.id === currentProjectId ? '<span class="project-current-badge">当前</span>' : ''}</div>
        <div class="project-rename-form" hidden>
          <label class="sr-only" for="project-rename-${safeId}">项目名称</label>
          <input id="project-rename-${safeId}" class="project-rename-input" type="text" maxlength="500" value="${escapeHtml(p.title || '未命名')}" autocomplete="off">
          <button class="project-rename-save" type="button">保存</button>
          <button class="project-rename-cancel" type="button">取消</button>
        </div>
        <div class="project-date">最后编辑于 ${escapeHtml(displayDate)}</div>
      </div>
      <div class="project-actions">
        <button class="btn-back btn-load" data-id="${safeId}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 12h14m-5-5 5 5-5 5"/></svg><span>打开</span></button>
        <button class="btn-back btn-rename" data-id="${safeId}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/></svg><span>改名</span></button>
        <button class="btn-back btn-history" data-id="${safeId}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg><span>版本</span></button>
        <button class="btn-back btn-export-archive" data-id="${safeId}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 15V3m0 0 4 4m-4-4L8 7M5 13v7h14v-7"/></svg><span>导出</span></button>
        <button class="btn-back btn-delete" data-id="${safeId}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/></svg><span>移除</span></button>
      </div>
    </div>
  `;
  }).join('');

  listDiv.querySelectorAll('.btn-load').forEach(btn => {
    btn.addEventListener('click', () => {
      loadProject(btn.dataset.id);
      closeModalEl(document.getElementById('projects-modal'));
    });
  });
  listDiv.querySelectorAll('.btn-rename').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.project-item');
      const form = item?.querySelector('.project-rename-form');
      const input = item?.querySelector('.project-rename-input');
      if (!item || !form || !input) return;
      listDiv.querySelectorAll('.project-item.is-renaming').forEach(other => {
        if (other !== item) {
          other.classList.remove('is-renaming');
          const otherForm = other.querySelector('.project-rename-form');
          if (otherForm) otherForm.hidden = true;
        }
      });
      item.classList.add('is-renaming');
      form.hidden = false;
      input.focus({ preventScroll: true });
      input.select();
    });
  });
  listDiv.querySelectorAll('.project-rename-cancel').forEach(button => {
    button.addEventListener('click', () => {
      const item = button.closest('.project-item');
      if (!item) return;
      item.classList.remove('is-renaming');
      button.closest('.project-rename-form').hidden = true;
      item.querySelector('.btn-rename')?.focus({ preventScroll: true });
    });
  });
  listDiv.querySelectorAll('.project-rename-input').forEach(input => {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.closest('.project-rename-form')?.querySelector('.project-rename-save')?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        input.closest('.project-rename-form')?.querySelector('.project-rename-cancel')?.click();
      }
    });
  });
  listDiv.querySelectorAll('.project-rename-save').forEach(button => {
    button.addEventListener('click', async () => {
      const item = button.closest('.project-item');
      const input = item?.querySelector('.project-rename-input');
      const projectId = item?.dataset.id;
      const title = input?.value.trim() || '';
      if (!item || !input || !projectId) return;
      if (!title) {
        window.showToast?.('项目名称不能为空');
        input.focus({ preventScroll: true });
        return;
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        if (projectId === currentProjectId && documentRevision > savedRevision) {
          const saved = await autoSaveProject();
          if (!saved?.success) throw new Error(saved?.message || '当前项目尚未保存');
        }
        const baseRevision = projectId === currentProjectId
          ? currentProjectRevision
          : Number(item.dataset.revision);
        const result = await window.electronAPI.renameProject({ projectId, baseRevision, title });
        if (!result?.success || result.durable !== true) throw new Error('项目名称未完成持久化');
        if (projectId === currentProjectId) {
          currentProjectRevision = result.revision;
          currentProjectMeta = { ...(currentProjectMeta || {}), title };
        }
        await renderProjectsModal();
        window.showToast?.(`项目已重命名为“${title}”`);
      } catch (error) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        window.showToast?.(`重命名失败：${error.message || '请重试'}`);
      }
    });
  });
  listDiv.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const impact = await window.electronAPI.getProjectTrashImpact(btn.dataset.id);
        const counts = impact.counts || {};
        const accepted = await showEssayflowConfirm({
          eyebrow: '移至回收站',
          title: `移除“${impact.title || '未命名'}”？`,
          message: '项目会进入项目中心的回收站，正文、引用和版本历史都会保留，之后可以恢复。',
          confirmLabel: '移入回收站',
          details: [
            { label: '正文引用', value: counts.citationLinks || 0 },
            { label: '历史版本', value: counts.versions || 0 },
            { label: '受管资源', value: counts.assets || 0 }
          ]
        });
        if (accepted) await deleteProject(btn.dataset.id);
      } catch (error) {
        window.showToast?.(`无法读取删除影响：${error.message || '请重试'}`);
      }
    });
  });
  listDiv.querySelectorAll('.btn-history').forEach(btn => {
    btn.addEventListener('click', () => showProjectHistory(btn.dataset.id));
  });
  listDiv.querySelectorAll('.btn-export-archive').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.exportProjectArchive({ projectId: btn.dataset.id, includeAssets: true });
        if (result?.success) window.showToast?.('项目包已导出');
      } catch (error) {
        window.showToast?.(`项目包导出失败：${error.message || '请重试'}`);
      }
    });
  });
}

function projectDataElements() {
  return {
    modal: document.getElementById('project-data-modal'),
    title: document.getElementById('project-data-title'),
    summary: document.getElementById('project-data-summary'),
    list: document.getElementById('project-data-list')
  };
}

async function showProjectHistory(projectId) {
  const elements = projectDataElements();
  elements.title.textContent = '版本历史';
  elements.summary.textContent = '恢复前会自动创建“恢复前”快照，当前审计记录不会随历史回退。';
  elements.list.innerHTML = '<div class="project-empty-state">正在读取...</div>';
  openModalEl(elements.modal);
  try {
    const versions = await window.electronAPI.listProjectVersions(projectId);
    if (!versions.length) {
      elements.list.innerHTML = '<div class="project-empty-state">尚无检查点</div>';
      return;
    }
    elements.list.innerHTML = versions.map(version => `
      <div class="project-item">
        <div class="project-info">
          <div class="project-title">${escapeHtml(version.summary?.title || '未命名')}</div>
          <div class="project-version-meta">${escapeHtml(new Date(version.createdAt).toLocaleString())} · ${escapeHtml(version.source || 'checkpoint')} · ${version.summary?.wordCount || 0} 字 · ${version.summary?.citationLinkCount || 0} 个引用</div>
        </div>
        <div class="project-actions">
          <button class="btn-back btn-version-restore" data-id="${escapeHtml(version.id)}">预览并恢复</button>
        </div>
      </div>
    `).join('');
    elements.list.querySelectorAll('.btn-version-restore').forEach(button => {
      button.addEventListener('click', async () => {
        try {
          const preview = await window.electronAPI.previewProjectVersion({ projectId, versionId: button.dataset.id });
          const changes = preview.changes || {};
          const message = [
            `目标标题：${preview.target?.title || '未命名'}`,
            `目标字数：${preview.target?.wordCount || 0}`,
            `正文变化：${changes.documentChanged ? '有' : '无'}`,
            `字数变化：${changes.wordCountDelta || 0}`,
            `引用变化：${changes.citationLinkDelta || 0}`,
            `内容 hash：${preview.target?.snapshotHash || ''}`,
            '',
            '确认恢复到此版本？'
          ].join('\n');
          if (!confirm(message)) return;
          const current = await window.electronAPI.loadProject(projectId);
          const restored = await window.electronAPI.restoreProjectVersion({
            projectId,
            versionId: button.dataset.id,
            baseRevision: current.revision
          });
          if (currentProjectId === projectId) await loadProject(projectId);
          await showProjectHistory(projectId);
          window.showToast?.(`已恢复，当前 revision ${restored.revision}`);
        } catch (error) {
          window.showToast?.(`版本恢复失败：${error.message || '请重试'}`);
        }
      });
    });
  } catch (error) {
    elements.list.innerHTML = `<div class="project-empty-state">${escapeHtml(error.message || '历史读取失败')}</div>`;
  }
}

async function showProjectTrash() {
  const elements = projectDataElements();
  elements.title.textContent = '回收站';
  elements.summary.textContent = '恢复会保留正文、引用、历史与资源关系；永久删除不可撤销。';
  elements.list.innerHTML = '<div class="project-empty-state">正在读取...</div>';
  openModalEl(elements.modal);
  try {
    const items = await window.electronAPI.listTrash();
    if (!items.length) {
      elements.list.innerHTML = '<div class="project-empty-state">回收站为空</div>';
      return;
    }
    elements.list.innerHTML = items.map(item => `
      <div class="project-item">
        <div class="project-info">
          <div class="project-title">${escapeHtml(item.title || '未命名')}</div>
          <div class="project-version-meta">revision ${item.revision} · ${item.citationCount || 0} 个引用 · ${item.versionCount || 0} 个历史版本</div>
        </div>
        <div class="project-actions">
          <button class="btn-back btn-trash-restore" data-id="${escapeHtml(item.projectId)}" data-revision="${item.revision}">恢复</button>
          <button class="btn-back btn-trash-delete" data-id="${escapeHtml(item.projectId)}" data-revision="${item.revision}">永久删除</button>
        </div>
      </div>
    `).join('');
    elements.list.querySelectorAll('.btn-trash-restore').forEach(button => {
      button.addEventListener('click', async () => {
        await window.electronAPI.restoreProjectFromTrash({ projectId: button.dataset.id, baseRevision: Number(button.dataset.revision) });
        await showProjectTrash();
        await renderProjectsModal();
        window.showToast?.('项目已恢复');
      });
    });
    elements.list.querySelectorAll('.btn-trash-delete').forEach(button => {
      button.addEventListener('click', async () => {
        const impact = await window.electronAPI.getProjectTrashImpact(button.dataset.id);
        const accepted = await showEssayflowConfirm({
          eyebrow: '不可撤销',
          title: `永久删除“${impact.title || '未命名'}”？`,
          message: '永久删除后无法恢复。共享资源会继续保留，只清理该项目独占且不再被引用的资源。',
          confirmLabel: '永久删除',
          tone: 'destructive',
          requiredPhrase: '永久删除',
          details: [
            { label: '独占资源', value: impact.exclusiveAssetIds?.length || 0 },
            { label: '共享资源', value: impact.sharedAssetIds?.length || 0 }
          ]
        });
        if (!accepted) return;
        await window.electronAPI.permanentlyDeleteProject({
          projectId: button.dataset.id,
          baseRevision: Number(button.dataset.revision),
          confirmation: 'PERMANENTLY_DELETE',
          confirmed: true
        });
        await showProjectTrash();
        await renderProjectsModal();
        window.showToast?.('项目已永久删除');
      });
    });
  } catch (error) {
    elements.list.innerHTML = `<div class="project-empty-state">${escapeHtml(error.message || '回收站读取失败')}</div>`;
  }
}

function setupProjectDataActions() {
  document.getElementById('project-checkpoint-btn')?.addEventListener('click', async () => {
    if (!currentProjectId) return window.showToast?.('当前没有可创建检查点的项目');
    if (documentRevision > savedRevision) {
      const saved = await autoSaveProject();
      if (!saved?.success) return;
    }
    try {
      const result = await window.electronAPI.createProjectCheckpoint({
        projectId: currentProjectId,
        baseRevision: currentProjectRevision,
        source: 'manual-checkpoint',
        manual: true
      });
      currentProjectRevision = result.revision;
      window.showToast?.(result.created ? '检查点已创建' : '内容未变化，已保留现有检查点');
    } catch (error) {
      window.showToast?.(`检查点创建失败：${error.message || '请重试'}`);
    }
  });
  document.getElementById('workspace-backup-btn')?.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.exportWorkspaceArchive({ includeAssets: true });
      if (result?.success) window.showToast?.('完整备份已导出，凭据未包含在备份中');
    } catch (error) {
      window.showToast?.(`备份失败：${error.message || '请重试'}`);
    }
  });
  document.getElementById('workspace-import-btn')?.addEventListener('click', async () => {
    let inspection;
    try {
      inspection = await window.electronAPI.selectArchiveImport();
      if (!inspection || inspection.canceled) return;
      const summary = [
        `包版本：${inspection.packageVersion || '未知'}`,
        `项目：${inspection.projectCount || 0}`,
        `文献：${inspection.libraryCount || 0}`,
        `资源：${inspection.resourceCount || 0}`,
        `文件：${inspection.entryCount || 0}`,
        `展开大小：${inspection.expandedBytes || 0} bytes`,
        `冲突：${inspection.conflicts?.length || 0}`,
        `可选缺失资源：${inspection.optionalMissingAssets?.length || 0}`
      ].join('\n');
      if (inspection.commitAllowed === false || !confirm(`${summary}\n\n继续导入并在冲突时保留两者？`)) {
        await window.electronAPI.cancelArchiveImport({ inspectionId: inspection.inspectionId, reason: 'user' });
        return;
      }
      const result = await window.electronAPI.importArchive({ inspectionId: inspection.inspectionId, strategy: 'keep-both' });
      if (result?.status === 'committed') {
        await renderProjectsModal();
        window.showToast?.('备份导入完成');
      } else {
        throw new Error('导入未提交');
      }
    } catch (error) {
      window.showToast?.(`导入失败：${error.message || '已回滚'}`);
    }
  });
  document.getElementById('project-trash-btn')?.addEventListener('click', showProjectTrash);
}

// ================== 思维导图（实时双向同步） ==================
let mindmapVisible = false;
let mindMapData = {};
let mindMapDataProjectId = null;

function injectMindmapButton() {
  const oldBtn = document.getElementById('btn-mindmap-inline');
  if (oldBtn) oldBtn.remove();
  const oldNewPageBtn = document.getElementById('btn-newpage-inline');
  if (oldNewPageBtn) oldNewPageBtn.remove();

  const toolbar = document.querySelector('.ql-toolbar.ql-snow');
  if (!toolbar) return;

  // 新建页面按钮
  const newPageBtn = document.createElement('button');
  newPageBtn.id = 'btn-newpage-inline';
  newPageBtn.setAttribute('data-tooltip', '新建页面');
  newPageBtn.type = 'button';
  newPageBtn.className = 'mindmap-toolbar-btn';
  newPageBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="12" y1="18" x2="12" y2="12"/>
      <line x1="9" y1="15" x2="15" y2="15"/>
    </svg>
  `;
  newPageBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (newPageBtn.disabled) return;
    newPageBtn.disabled = true;
    newPageBtn.setAttribute('aria-busy', 'true');

    try {
      if (currentProjectId && documentRevision > savedRevision) {
        cancelScheduledAutoSave();
        const pendingSave = await autoSaveProject();
        if (!pendingSave?.success) throw new Error('当前项目尚未保存，已取消新建页面');
      }

      // 先切换项目 ID，再清空引用，避免覆盖原项目的引用数据。
      isLoadingProject = true;
      projectLoadToken++;
      quill.enable(true);
      quill.root.removeAttribute('aria-busy');
      currentProjectId = generateId();
      currentProjectRevision = -1;
      currentProjectMeta = null;
      citations = [];
      quill.setContents([], Quill.sources.SILENT);
      documentRevision = 1;
      savedRevision = 0;
      saveCitations();
      isLoadingProject = false;
      if (typeof hideAIHint === 'function') hideAIHint();

      const initialSave = await autoSaveProject();
      if (!initialSave?.success) throw new Error(initialSave?.message || '新页面创建失败');
      updateWordCount();
      if (mindmapVisible) {
        mindmapVisible = false;
        document.getElementById('mindmap-panel')?.classList.remove('visible');
        const mindmapBtn = document.getElementById('btn-mindmap-inline');
        if (mindmapBtn) mindmapBtn.classList.remove('active');
      }
      showToast('已创建新页面');
    } catch (err) {
      window.showToast?.(err.message || '新页面创建失败');
    } finally {
      isLoadingProject = false;
      newPageBtn.disabled = false;
      newPageBtn.removeAttribute('aria-busy');
    }
  });

  // 文章导图按钮
  const btn = document.createElement('button');
  btn.id = 'btn-mindmap-inline';
  btn.setAttribute('data-tooltip', '文章导图');
  btn.type = 'button';
  btn.className = 'mindmap-toolbar-btn';
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="6" r="3"/><path d="M12 9v6M9 15h6"/><circle cx="9" cy="18" r="2"/><circle cx="15" cy="18" r="2"/>
    </svg>
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    mindmapVisible = !mindmapVisible;
    const panel = document.getElementById('mindmap-panel');
    panel.classList.toggle('visible', mindmapVisible);
    btn.classList.toggle('active', mindmapVisible);

    // 互斥：打开导图时关闭更多功能下拉菜单和搜索替换面板
    if (mindmapVisible) {
      const moreDropdown = document.getElementById('more-dropdown-menu');
      if (moreDropdown) moreDropdown.classList.remove('open');
      if (typeof hideFindReplacePanel === 'function') hideFindReplacePanel();
    }

    if (mindmapVisible) {
      renderMindmap();
      updateMindmapPosition();
    }
  });

  // 使用 float: right 且插在 toolbar 最前面，确保始终在第一行最右侧
  const wrapper = document.createElement('span');
  wrapper.id = 'right-toolbar-group';
  wrapper.className = 'ql-formats';
  wrapper.style.cssFloat = 'right';
  wrapper.appendChild(newPageBtn);
  wrapper.appendChild(btn);
  toolbar.insertBefore(wrapper, toolbar.firstChild);
}

function extractHeadings() {
  const nodes = [];
  const elements = quill.root.querySelectorAll('h1, h2, h3');
  elements.forEach(el => {
    if (el.matches('p[data-ref-section]')) return; // 只跳过参考文献段落，不过滤标题
    const level = parseInt(el.tagName[1]);
    const text = el.textContent.trim();
    if (!text) return; // 跳过空标题
    let id = el.getAttribute('data-id');
    if (!id) {
      id = generateId();
      el.setAttribute('data-id', id);
    }
    nodes.push({ level, text, id });
  });
  return buildTree(nodes);
}

function buildTree(flatNodes) {
  const root = { text: '文章', children: [], id: 'root' };
  const stack = [{ node: root, level: 0 }];
  flatNodes.forEach(n => {
    const newNode = { text: n.text, id: n.id, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= n.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack[stack.length - 1].node.children.push(newNode);
    }
    stack.push({ node: newNode, level: n.level });
  });
  return root;
}

function renderMindmap() {
  const container = document.getElementById('mindmap-container');
  if (!container) return;

  // 若当前正在编辑节点，禁止重绘以免销毁 input 导致编辑中断
  if (container.querySelector('.mindmap-edit-input')) return;

  // 保存当前展开/收缩状态到 localStorage
  const collapsedState = {};
  function collectState(node) {
    if (node.collapsed) collapsedState[node.id] = true;
    if (node.children) node.children.forEach(collectState);
  }
  const projectId = currentProjectId || 'default';
  if (mindMapData && mindMapData.id && mindMapDataProjectId) {
    collectState(mindMapData);
    localStorage.setItem('mindmap_collapsed_' + mindMapDataProjectId, JSON.stringify(collapsedState));
  }

  container.innerHTML = '';
  mindMapData = extractHeadings();
  mindMapDataProjectId = projectId;

  // 恢复展开/收缩状态
  let savedState = {};
  try {
    savedState = JSON.parse(localStorage.getItem('mindmap_collapsed_' + projectId) || '{}');
  } catch(e) {}
  function applyState(node) {
    if (savedState[node.id]) node.collapsed = true;
    if (node.children) node.children.forEach(applyState);
  }
  applyState(mindMapData);

  renderMindmapNode(mindMapData, container, 0);
}

function renderMindmapNode(node, parentEl, depth) {
  const nodeDiv = document.createElement('div');
  nodeDiv.className = 'mindmap-node';
  nodeDiv.style.marginLeft = `${depth * 28}px`;
  nodeDiv.setAttribute('data-id', node.id);

  // 展开/收缩按钮
  if (node.children && node.children.length > 0) {
    const toggleBtn = document.createElement('span');
    toggleBtn.className = 'mindmap-toggle-btn';
    const isCollapsed = node.collapsed === true;
    toggleBtn.innerHTML = isCollapsed
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      node.collapsed = !node.collapsed;
      renderMindmap();
    });
    nodeDiv.appendChild(toggleBtn);
  }

  const textSpan = document.createElement('span');
  textSpan.textContent = node.text;
  nodeDiv.appendChild(textSpan);

  nodeDiv.addEventListener('click', (e) => {
    if (e.detail === 2) return;
    if (e.target.closest('.mindmap-toggle-btn')) return;
    const headingEl = quill.root.querySelector(`[data-id="${node.id}"]`);
    if (headingEl) {
      // 手动滚动到目标段落居中，替代 scrollIntoView（避免相邻段落已在视口内时不滚动）
      const workspace = document.getElementById('workspace');
      if (workspace) {
        const editorEl = quill.root;
        let headingTop = 0;
        let el = headingEl;
        while (el && el !== workspace) {
          headingTop += el.offsetTop;
          const mt = parseFloat(window.getComputedStyle(el).marginTop) || 0;
          headingTop += mt;
          el = el.offsetParent;
        }
        const targetScrollTop = headingTop - workspace.clientHeight / 2 + headingEl.offsetHeight / 2;
        workspace.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
      }
      headingEl.style.transition = 'background 0.3s';
      headingEl.style.backgroundColor = '#fff3c9';
      setTimeout(() => { headingEl.style.backgroundColor = ''; }, 1500);
    }
  });

  nodeDiv.addEventListener('dblclick', (e) => {
    e.preventDefault();
    editNodeText(node, nodeDiv);
  });

  nodeDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showNodeContextMenu(e, node);
  });

  parentEl.appendChild(nodeDiv);
  if (node.children && !node.collapsed) {
    node.children.forEach(child => renderMindmapNode(child, parentEl, depth + 1));
  }
}

function editNodeText(node, nodeDiv) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = node.text;
  input.className = 'mindmap-edit-input';
  input.onblur = () => finishEdit(node, input);
  input.onkeypress = (e) => { if (e.key === 'Enter') finishEdit(node, input); };
  nodeDiv.innerHTML = '';
  nodeDiv.appendChild(input);
  input.focus();
}

function finishEdit(node, input) {
  const newText = input.value.trim();
  if (newText) {
    node.text = newText;
    const headingEl = quill.root.querySelector(`[data-id="${node.id}"]`);
    if (headingEl) {
      headingEl.textContent = newText;
      quill.update();
      autoSaveProject();
    }
  }
  renderMindmap();
}

function showNodeContextMenu(e, node) {
  const existing = document.querySelector('.mindmap-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'mindmap-context-menu';
  menu.innerHTML = `
    <div class="menu-item" data-action="add">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>添加子节点
    </div>
    <div class="menu-item" data-action="delete">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>删除节点
    </div>
  `;
  menu.style.top = `${e.clientY}px`;
  menu.style.left = `${e.clientX}px`;
  document.body.appendChild(menu);

  menu.querySelector('[data-action="add"]').onclick = (ev) => {
    ev.stopPropagation();
    addChildNode(node);
    menu.remove();
  };
  menu.querySelector('[data-action="delete"]').onclick = (ev) => {
    ev.stopPropagation();
    deleteNode(node);
    menu.remove();
  };

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function addChildNode(parentNode) {
  let insertIndex;
  let newLevel;

  if (parentNode.id === 'root') {
    // 根节点：在文档末尾添加顶层标题
    insertIndex = quill.getLength();
    newLevel = 1;
  } else {
    const headingEl = quill.root.querySelector(`[data-id="${parentNode.id}"]`);
    if (!headingEl) return;
    const level = parseInt(headingEl.tagName[1]);
    newLevel = Math.min(level + 1, 3);

    // 获取 heading 所在的 line blot
    const blot = Quill.find(headingEl);
    if (!blot) return;
    const blotIndex = quill.getIndex(blot);
    const [lineBlot] = quill.getLine(blotIndex);
    if (!lineBlot) return;

    // 找到该 heading 下所有内容的结束位置
    const allHeadings = Array.from(quill.root.querySelectorAll('h1, h2, h3'));
    const currentIdx = allHeadings.indexOf(headingEl);
    let endIndex = quill.getLength();

    for (let i = currentIdx + 1; i < allHeadings.length; i++) {
      const nextLevel = parseInt(allHeadings[i].tagName[1]);
      if (nextLevel <= level) {
        const nextBlot = Quill.find(allHeadings[i]);
        if (nextBlot) {
          const [nextLine] = quill.getLine(quill.getIndex(nextBlot));
          if (nextLine) endIndex = quill.getIndex(nextLine);
        }
        break;
      }
    }
    insertIndex = endIndex;
  }

  const newText = '新节点';
  const newId = generateId();

  // 使用 Delta 原子插入：仅插入标题本身，不附加正文占位，避免格式继承污染
  const Delta = Quill.import('delta');
  const delta = new Delta()
    .retain(insertIndex)
    .insert(newText)
    .insert('\n', { header: newLevel });
  quill.updateContents(delta, Quill.sources.API);

  // 正确设置新 heading 的 data-id
  setTimeout(() => {
    const headings = Array.from(quill.root.querySelectorAll('h1, h2, h3'));
    for (let i = headings.length - 1; i >= 0; i--) {
      const h = headings[i];
      if (h.textContent.trim() === newText && !h.getAttribute('data-id')) {
        h.setAttribute('data-id', newId);
        break;
      }
    }
    ensureHeadingIds();
    renderMindmap();
  }, 50);

  autoSaveProject();
}

function deleteNode(node) {
  if (node.id === 'root') return;
  const headingEl = quill.root.querySelector(`[data-id="${node.id}"]`);
  if (!headingEl) return;

  const blot = Quill.find(headingEl);
  if (!blot) return;
  const blotIndex = quill.getIndex(blot);
  const [lineBlot] = quill.getLine(blotIndex);
  if (!lineBlot) return;

  const startIndex = quill.getIndex(lineBlot);
  const level = parseInt(headingEl.tagName[1]);

  let endIndex = quill.getLength();
  const allHeadings = Array.from(quill.root.querySelectorAll('h1,h2,h3'));
  let currentFound = false;
  for (let i = 0; i < allHeadings.length; i++) {
    if (allHeadings[i] === headingEl) {
      currentFound = true;
      continue;
    }
    if (currentFound) {
      const nextLevel = parseInt(allHeadings[i].tagName[1]);
      if (nextLevel <= level) {
        const nextBlot = Quill.find(allHeadings[i]);
        if (nextBlot) {
          const [nextLine] = quill.getLine(quill.getIndex(nextBlot));
          if (nextLine) endIndex = quill.getIndex(nextLine);
        }
        break;
      }
    }
  }

  const deleteLength = endIndex - startIndex;
  if (deleteLength > 0) {
    quill.deleteText(startIndex, deleteLength, Quill.sources.API);
  }
  quill.update();
  autoSaveProject();
  renderMindmap();
}

// ================== DOM 元素 ==================
const btnSettings = document.getElementById('btn-settings');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');
const btnNewProject = document.getElementById('btn-new-project');
const btnProjects = document.getElementById('btn-projects');
const modal = document.getElementById('new-project-modal');
const spanClose = document.getElementsByClassName('close');
const modalCreate = document.getElementById('modal-create');
const projectsModal = document.getElementById('projects-modal');
const modalFocusOrigins = new WeakMap();

function setupAccessibilityDefaults() {
  document.querySelectorAll('button').forEach(button => {
    if (!button.hasAttribute('type')) button.type = 'button';
    const tooltip = button.getAttribute('data-tooltip');
    if (tooltip && !button.getAttribute('aria-label')) button.setAttribute('aria-label', tooltip);
  });
  document.querySelectorAll('.modal').forEach(modalEl => {
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-hidden', modalEl.classList.contains('open') ? 'false' : 'true');
  });
  document.querySelectorAll('.close').forEach(close => {
    close.setAttribute('role', 'button');
    close.setAttribute('tabindex', '0');
    if (!close.getAttribute('aria-label')) close.setAttribute('aria-label', '关闭');
    close.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        close.click();
      }
    });
  });
}

// ================== Modal 通用打开/关闭（淡入淡出动画） ==================
function openModalEl(modalEl) {
  if (!modalEl) return;
  modalFocusOrigins.set(modalEl, document.activeElement);
  modalEl.style.display = 'flex';
  modalEl.setAttribute('aria-hidden', 'false');
  void modalEl.offsetWidth;
  modalEl.classList.add('open');
  document.body.classList.add('dialog-open');
  requestAnimationFrame(() => {
    const firstFocusable = modalEl.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    firstFocusable?.focus({ preventScroll: true });
  });
}
function closeModalEl(modalEl) {
  if (!modalEl) return;
  modalEl.classList.remove('open');
  modalEl.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (!modalEl.classList.contains('open')) {
      modalEl.style.display = 'none';
      const origin = modalFocusOrigins.get(modalEl);
      if (origin?.isConnected && typeof origin.focus === 'function') origin.focus();
    }
    if (!document.querySelector('.modal.open, .settings-panel.open, .source-modal.open')) {
      document.body.classList.remove('dialog-open');
    }
  }, 380);
}

let essayflowConfirmResolver = null;

function settleEssayflowConfirm(accepted) {
  const modalEl = document.getElementById('essayflow-confirm-modal');
  if (!modalEl || !essayflowConfirmResolver) return;
  const resolve = essayflowConfirmResolver;
  essayflowConfirmResolver = null;
  closeModalEl(modalEl);
  resolve(accepted === true);
}

function showEssayflowConfirm(options = {}) {
  const modalEl = document.getElementById('essayflow-confirm-modal');
  if (!modalEl) return Promise.resolve(false);
  if (essayflowConfirmResolver) settleEssayflowConfirm(false);

  const titleEl = document.getElementById('essayflow-confirm-title');
  const eyebrowEl = document.getElementById('essayflow-confirm-eyebrow');
  const messageEl = document.getElementById('essayflow-confirm-message');
  const detailsEl = document.getElementById('essayflow-confirm-details');
  const phraseRow = document.getElementById('essayflow-confirm-phrase-row');
  const phraseLabel = document.getElementById('essayflow-confirm-phrase-label');
  const phraseInput = document.getElementById('essayflow-confirm-phrase');
  const acceptButton = document.getElementById('essayflow-confirm-accept');

  titleEl.textContent = options.title || '确认操作';
  eyebrowEl.textContent = options.eyebrow || '项目管理';
  messageEl.textContent = options.message || '';
  detailsEl.replaceChildren();
  for (const detail of Array.isArray(options.details) ? options.details : []) {
    const item = document.createElement('div');
    item.className = 'ef-confirm-detail';
    const label = document.createElement('span');
    const value = document.createElement('strong');
    label.textContent = detail.label || '';
    value.textContent = String(detail.value ?? '0');
    item.append(label, value);
    detailsEl.appendChild(item);
  }
  detailsEl.hidden = detailsEl.childElementCount === 0;

  const requiredPhrase = typeof options.requiredPhrase === 'string' ? options.requiredPhrase : '';
  phraseRow.hidden = !requiredPhrase;
  phraseInput.value = '';
  phraseLabel.textContent = requiredPhrase ? `输入“${requiredPhrase}”以确认` : '';
  phraseInput.placeholder = requiredPhrase;
  acceptButton.textContent = options.confirmLabel || '确认';
  acceptButton.classList.toggle('is-destructive', options.tone === 'destructive');
  acceptButton.disabled = Boolean(requiredPhrase);
  phraseInput.oninput = () => {
    acceptButton.disabled = phraseInput.value.trim() !== requiredPhrase;
  };

  return new Promise(resolve => {
    essayflowConfirmResolver = resolve;
    openModalEl(modalEl);
    requestAnimationFrame(() => {
      (requiredPhrase ? phraseInput : document.getElementById('essayflow-confirm-cancel'))?.focus({ preventScroll: true });
    });
  });
}

function setupEssayflowConfirm() {
  const modalEl = document.getElementById('essayflow-confirm-modal');
  if (!modalEl) return;
  document.getElementById('essayflow-confirm-close')?.addEventListener('click', () => settleEssayflowConfirm(false));
  document.getElementById('essayflow-confirm-cancel')?.addEventListener('click', () => settleEssayflowConfirm(false));
  document.getElementById('essayflow-confirm-accept')?.addEventListener('click', () => settleEssayflowConfirm(true));
  modalEl.addEventListener('click', event => {
    if (event.target === modalEl) settleEssayflowConfirm(false);
  });
  modalEl.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      settleEssayflowConfirm(false);
    }
  });
}
setupEssayflowConfirm();

// ================== 自定义 Tooltip ==================
const tooltipDiv = document.getElementById('custom-tooltip');
function getClosestTooltipElement(el) {
  while (el && el !== document) {
    if (el.hasAttribute && el.hasAttribute('data-tooltip')) {
      return el;
    }
    el = el.parentNode;
  }
  return null;
}

document.addEventListener('mouseover', (e) => {
  const target = getClosestTooltipElement(e.target);
  if (!target) return;
  const text = target.getAttribute('data-tooltip');
  if (!text) return;
  tooltipDiv.textContent = text;
  tooltipDiv.setAttribute('aria-hidden', 'false');
  tooltipDiv.classList.add('show');
  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltipDiv.getBoundingClientRect();
  let left = rect.right + 8;
  if (left + tooltipRect.width > window.innerWidth - 8) left = rect.left - tooltipRect.width - 8;
  const top = Math.min(
    Math.max(8, rect.top + (rect.height - tooltipRect.height) / 2),
    window.innerHeight - tooltipRect.height - 8
  );
  tooltipDiv.style.left = Math.max(8, left) + 'px';
  tooltipDiv.style.top = top + 'px';
});

document.addEventListener('mouseout', (e) => {
  const target = getClosestTooltipElement(e.target);
  if (!target) return;
  tooltipDiv.classList.remove('show');
  tooltipDiv.setAttribute('aria-hidden', 'true');
});

let toastHideTimer = null;
window.showToast = function(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastHideTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastHideTimer = setTimeout(() => { toast.classList.remove('show'); }, 2600);
};

// ================== 导入 Word ==================
btnImport.addEventListener('click', async () => {
  if (!window.electronAPI) {
    window.showToast('桌面应用才支持导入 Word');
    return;
  }
  if (typeof mammoth === 'undefined') {
    window.showToast('Word 解析组件加载失败，请重启应用');
    return;
  }

  btnImport.disabled = true;
  try {
    const base64 = await window.electronAPI.importWord();
    if (!base64) return;
    const arrayBuffer = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const importedDelta = quill.clipboard.convert(result.value || '<p><br></p>');
    quill.setContents(importedDelta, Quill.sources.USER);
    ensureHeadingIds();
    updateWordCount();
    const saved = await autoSaveProject();
    if (!saved?.success) throw new Error(saved?.message || 'Word 导入内容保存失败');
    const checkpoint = await window.electronAPI.createProjectCheckpoint({
      projectId: currentProjectId,
      baseRevision: currentProjectRevision,
      source: 'word-import',
      manual: false
    });
    currentProjectRevision = checkpoint.revision;
    const warningCount = Array.isArray(result.messages) ? result.messages.length : 0;
    window.showToast(warningCount ? `导入成功，已处理 ${warningCount} 条格式提示` : 'Word 导入成功');
  } catch (err) {
    console.error(err);
    window.showToast('导入失败，请确认文件是有效的 DOCX 文档');
  } finally {
    btnImport.disabled = false;
  }
});

async function htmlToWordXml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 收集所有图片
  const imgs = body.querySelectorAll('img');
  const images = [];
  let imgCounter = 2; // rId1 是文档关系，图片从 rId2 开始

  for (const img of imgs) {
    let src = img.getAttribute('src');
    if (!src) continue;

    let base64 = '';
    let ext = 'png';
    let width = parseInt(img.style.width) || img.width || 400;
    let height = parseInt(img.style.height) || img.height || 300;

    if (src.startsWith('data:')) {
      const match = src.match(/^data:image\/(\w+);base64,(.+)/);
      if (match) {
        ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        base64 = match[2];
      }
    } else if (src.startsWith('blob:')) {
      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = reader.result.split(',')[1];
            resolve(base64data);
          };
          reader.readAsDataURL(blob);
        });
        ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
      } catch (e) {
        continue;
      }
    } else if ((src.startsWith('file:') || /^[a-zA-Z]:[\\/]/.test(src)) && window.electronAPI?.readImageBase64) {
      try {
        const localImage = await window.electronAPI.readImageBase64(src);
        if (localImage?.base64) {
          base64 = localImage.base64;
          const mimeExt = localImage.mimeType?.split('/')[1] || 'png';
          ext = mimeExt === 'jpeg' ? 'jpg' : mimeExt;
        }
      } catch (e) {
        console.warn('读取本地图片失败，已跳过:', e);
      }
    }

    if (base64) {
      const rId = `rId${imgCounter}`;
      images.push({ rId, name: `image${imgCounter - 1}.${ext}`, base64, width, height });
      img.dataset.rid = rId;
      img.dataset.width = width;
      img.dataset.height = height;
      imgCounter++;
    }
  }

  function processChildren(parent) {
    let result = '';
    parent.childNodes.forEach(child => {
      result += processNode(child);
    });
    return result;
  }

  function getWordAlignment(node, fallback = 'left') {
    const className = node.className || '';
    const align = node.style?.textAlign ||
      (className.includes('ql-align-center') ? 'center' : '') ||
      (className.includes('ql-align-right') ? 'right' : '') ||
      (className.includes('ql-align-justify') ? 'both' : '') || fallback;
    return align === 'justify' ? 'both' : align;
  }

  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = escapeXml(node.textContent);
      if (!text) return '';
      return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();

    switch (tag) {
      case 'p': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:p><w:pPr><w:jc w:val="${getWordAlignment(node, 'both')}"/></w:pPr>${inner}</w:p>`;
      }
      case 'h1': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="${getWordAlignment(node)}"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r></w:p>`;
      }
      case 'h2': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:jc w:val="${getWordAlignment(node)}"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r></w:p>`;
      }
      case 'h3': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:p><w:pPr><w:pStyle w:val="Heading3"/><w:jc w:val="${getWordAlignment(node)}"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r></w:p>`;
      }
      case 'b':
      case 'strong': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 'i':
      case 'em': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:r><w:rPr><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 'u': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 's':
      case 'del': {
        return `<w:r><w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 'sup': {
        return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 'sub': {
        return `<w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 'a': {
        return `<w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${extractText(node)}</w:t></w:r>`;
      }
      case 'br':
        return '<w:r><w:br/></w:r>';
      case 'li': {
        const inner = processChildren(node);
        if (!inner) return '';
        const parentTag = node.parentElement?.tagName?.toLowerCase();
        const marker = parentTag === 'ol'
          ? `${Array.from(node.parentElement.children).indexOf(node) + 1}. `
          : '• ';
        return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(marker)}</w:t></w:r>${inner}</w:p>`;
      }
      case 'blockquote': {
        const inner = processChildren(node);
        if (!inner) return '';
        return `<w:p><w:pPr><w:ind w:left="720"/></w:pPr>${inner}</w:p>`;
      }
      case 'img': {
        const rId = node.dataset.rid;
        if (!rId) return '';
        const width = parseInt(node.dataset.width) || 400;
        const height = parseInt(node.dataset.height) || 300;
        // EMU: 1 inch = 914400, 假设 96 DPI
        const wEmu = Math.round((width / 96) * 914400);
        const hEmu = Math.round((height / 96) * 914400);
        return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${wEmu}" cy="${hEmu}"/><wp:docPr id="1" name="Picture"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="Picture"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      }
      case 'table': {
        const rows = Array.from(node.rows || []);
        if (rows.length === 0) return '';
        const tableRows = rows.map(row => {
          const cells = Array.from(row.cells || []).map(cell => {
            const cellXml = processChildren(cell);
            const paragraphXml = /<w:p(?:\s|>)/.test(cellXml)
              ? cellXml
              : `<w:p>${cellXml || '<w:r><w:t></w:t></w:r>'}</w:p>`;
            return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphXml}</w:tc>`;
          }).join('');
          return `<w:tr>${cells}</w:tr>`;
        }).join('');
        return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders></w:tblPr>${tableRows}</w:tbl>`;
      }
      case 'div':
      case 'span':
      case 'ul':
      case 'ol': {
        return processChildren(node);
      }
      default: {
        return processChildren(node);
      }
    }
  }

  function extractText(node) {
    let text = '';
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += escapeXml(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        text += extractText(child);
      }
    });
    return text;
  }

  let xml = '';
  body.childNodes.forEach(child => {
    xml += processNode(child);
  });
  return { xml, images };
}

// ================== 导出 Word ==================
async function prepareCitationExport(format) {
  if (!currentProjectId || !window.electronAPI?.auditProjectCitations) return true;
  if (documentRevision > savedRevision) {
    const saved = await autoSaveProject();
    if (!saved?.success) throw new Error('项目尚未保存，已取消导出');
  }
  const audit = await window.electronAPI.auditProjectCitations(currentProjectId);
  let forced = false;
  if (audit.blockingCount > 0) {
    forced = window.confirm(`引用审计发现 ${audit.blockingCount} 个阻断问题和 ${audit.warningCount} 个警告。仍要强制导出吗？`);
    if (!forced) return false;
  } else if (audit.warningCount > 0) {
    window.showToast?.(`引用审计有 ${audit.warningCount} 个警告，导出报告将保留记录`);
  }
  if (window.electronAPI.recordCitationExportAudit) {
    const recorded = await window.electronAPI.recordCitationExportAudit({
      projectId: currentProjectId,
      baseRevision: currentProjectRevision,
      format,
      forced
    });
    if (!recorded?.durable) throw new Error('引用导出报告未获得 durable 确认');
    currentProjectRevision = recorded.revision;
  }
  return true;
}

const btnExportWord = document.getElementById('btn-export-word');
if (btnExportWord) {
  btnExportWord.addEventListener('click', async () => {
    if (!window.electronAPI) {
      window.showToast('桌面应用才支持导出 Word');
      return;
    }
    btnExportWord.disabled = true;
    btnExportWord.setAttribute('aria-busy', 'true');
    try {
      if (!await prepareCitationExport('docx')) return;
      const editorContent = getPersistableEditorHtml();
      const { xml: wordXml, images } = await htmlToWordXml(editorContent);
      const result = await window.electronAPI.saveDocx({ wordXml, images });
      if (result.success) {
        window.showToast('Word 导出成功');
      } else if (result.reason === 'cancelled') {
        // 用户取消，静默处理
      } else {
        window.showToast('导出失败: ' + result.reason);
      }
    } catch (err) {
      console.error(err);
      window.showToast('导出失败，请重试');
    } finally {
      btnExportWord.disabled = false;
      btnExportWord.removeAttribute('aria-busy');
    }
  });
}

// ================== 导出 PDF ==================
btnExport.addEventListener('click', async () => {
  if (typeof html2pdf === 'undefined') {
    window.showToast('PDF 导出组件加载失败，请重启应用');
    return;
  }
  btnExport.disabled = true;
  btnExport.setAttribute('aria-busy', 'true');
  try {
    if (!await prepareCitationExport('pdf')) {
      btnExport.disabled = false;
      btnExport.removeAttribute('aria-busy');
      return;
    }
  } catch (error) {
    window.showToast?.(`导出失败：${error.message || '引用审计未完成'}`);
    btnExport.disabled = false;
    btnExport.removeAttribute('aria-busy');
    return;
  }
  const editorContent = getPersistableEditorHtml();
  const allStyles = collectAllStyles();
  const exportStyles = `
    img {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      display: block;
      max-width: 100%;
    }
    p[data-ref-section] {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    .ql-editor p { orphans: 3; widows: 3; }
  `;
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Essay</title><style>${allStyles}${exportStyles} body { padding: 40px; } .ql-editor { max-width: 900px; margin: 0 auto; }</style></head><body><div class="ql-editor">${editorContent}</div></body></html>`;
  const opt = {
    margin: [0.5, 0.5, 0.5, 0.5],
    pagebreak: { mode: ['css', 'legacy'], avoid: 'img' },
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, letterRendering: true },
    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
  };
  try {
    if (window.electronAPI) {
      const projectName = (currentProjectMeta?.title || getFirstH1() || '未命名项目').replace(/[\\/:*?"<>|]/g, '_');
      const defaultPath = projectName + '.pdf';
      const savePath = await window.electronAPI.selectSavePath(defaultPath);
      if (!savePath) return;
      const pdfBlob = await html2pdf().set(opt).from(fullHtml).outputPdf('blob');
      const base64data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error || new Error('PDF 读取失败'));
        reader.readAsDataURL(pdfBlob);
      });
      const saved = await window.electronAPI.saveFile(base64data, savePath);
      if (saved === false || saved?.success === false) throw new Error(saved?.message || '文件写入失败');
      window.showToast('PDF 导出成功');
    } else {
      await html2pdf().set(opt).from(fullHtml).save();
    }
  } catch (err) {
    console.error(err);
    window.showToast(`PDF 导出失败：${err.message || '请重试'}`);
  } finally {
    btnExport.disabled = false;
    btnExport.removeAttribute('aria-busy');
  }
});

// ================== 新建项目弹窗 ==================
function clearNewProjectForm() {
  ['project-title','project-author','project-course','project-degree',
   'project-word-limit','project-reference-style','project-abstract'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

btnNewProject.addEventListener('click', () => {
  openModalEl(modal);
  // 预填充默认引用格式
  const refStyleSelect = document.getElementById('project-reference-style');
  if (refStyleSelect) {
    const defaultStyle = (typeof getDefaultReferenceStyle === 'function' && getDefaultReferenceStyle()) || 'MLA';
    refStyleSelect.value = defaultStyle;
  }
  // 打开时聚焦到标题输入框
  setTimeout(() => {
    const titleInput = document.getElementById('project-title');
    if (titleInput) titleInput.focus();
  }, 100);
});
Array.from(spanClose).forEach(span => {
  span.addEventListener('click', function() {
    const m = this.closest('.modal');
    closeModalEl(m);
    // 关闭新建项目弹窗时清空表单
    if (m === modal) clearNewProjectForm();
  });
});
window.addEventListener('click', (event) => {
  if (event.target.classList.contains('modal')) {
    closeModalEl(event.target);
    // 关闭新建项目弹窗时清空表单
    if (event.target === modal) clearNewProjectForm();
  }
});
modalCreate.addEventListener('click', async () => {
  const titleInput = document.getElementById('project-title').value.trim();
  const authorInput = document.getElementById('project-author').value.trim();
  const abstractInput = document.getElementById('project-abstract').value.trim();
  const courseInput = document.getElementById('project-course').value.trim();
  const degreeInput = document.getElementById('project-degree').value;
  const wordLimitInput = document.getElementById('project-word-limit').value.trim();
  const refStyleInput = document.getElementById('project-reference-style').value;

  if (!titleInput && !authorInput) {
    showToast('请至少填写标题或作者');
    setTimeout(() => {
      const titleEl = document.getElementById('project-title');
      if (titleEl) titleEl.focus();
    }, 0);
    return;
  }

  let content = '';
  // 封面信息：标题、作者、课程居中显示，不显示字数/学位/引用格式等元数据
  if (titleInput) {
    content += `<h1 style="text-align:center;margin-bottom:8px;">${escapeHtml(titleInput)}</h1>`;
  }
  if (authorInput) {
    content += `<p style="text-align:center;font-size:15px;color:#555;margin:4px 0;">${escapeHtml(authorInput)}</p>`;
  }
  if (courseInput) {
    content += `<p style="text-align:center;font-size:14px;color:#666;margin:4px 0;">${escapeHtml(courseInput)}</p>`;
  }
  if (titleInput || authorInput || courseInput) {
    content += '<p><br></p>';
  }
  if (abstractInput) {
    content += `<h2>摘要</h2><p>${escapeHtml(abstractInput)}</p>`;
  }
  content += '<h2>正文</h2><p><br></p>';

  const title = titleInput || authorInput || '未命名项目';
  modalCreate.disabled = true;
  modalCreate.setAttribute('aria-busy', 'true');

  // 先完整保存旧项目，再切换项目 ID，避免正文或引用被写入错误项目。
  if (currentProjectId && documentRevision > savedRevision) {
    cancelScheduledAutoSave();
    const previousSave = await autoSaveProject();
    if (!previousSave?.success) {
      modalCreate.disabled = false;
      modalCreate.removeAttribute('aria-busy');
      showToast('当前项目尚未保存，已取消创建新项目');
      return;
    }
  }

  projectLoadToken++;
  quill.enable(true);
  quill.root.removeAttribute('aria-busy');
  currentProjectId = generateId();
  currentProjectRevision = -1;
  currentProjectMeta = {
    title,
    author: authorInput,
    course: courseInput,
    degree: degreeInput,
    wordLimit: wordLimitInput,
    referenceStyle: refStyleInput,
    abstract: abstractInput
  };
  updateActiveCitationStyleControl();
  citations = [];
  saveCitations();

  isLoadingProject = true;
  const initialDelta = quill.clipboard.convert(content);
  quill.setContents(initialDelta, Quill.sources.SILENT);
  isLoadingProject = false;
  documentRevision = 1;
  savedRevision = 0;
  ensureHeadingIds();
  const initialSave = await autoSaveProject();
  modalCreate.disabled = false;
  modalCreate.removeAttribute('aria-busy');
  if (!initialSave?.success) {
    showToast(initialSave?.message || '新项目尚未写入磁盘，请检查存储空间后重试');
    return;
  }
  closeModalEl(modal);

  // 清空表单
  ['project-title','project-author','project-course','project-degree',
   'project-word-limit','project-reference-style','project-abstract'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  if (mindmapVisible) renderMindmap();
  updateWordCount();
  showToast(`已创建新项目：${title}`);
});

// ================== 项目列表弹窗 ==================
btnProjects.addEventListener('click', () => {
  openModalEl(projectsModal);
  renderProjectsModal();
});
projectsModal.querySelector('.close').addEventListener('click', () => {
  closeModalEl(projectsModal);
});

// ================== 思维导图关闭按钮 ==================
document.addEventListener('click', (e) => {
  if (e.target.closest('#mindmap-close')) {
    mindmapVisible = false;
    document.getElementById('mindmap-panel').classList.remove('visible');
    const btn = document.getElementById('btn-mindmap-inline');
    if (btn) btn.classList.remove('active');
    toolbarClickScrollTop = null; // 清除滚动锁，防止关闭后跳回之前位置
  }
});

// ================== 点击空白处关闭文章导图 ==================
document.addEventListener('click', (e) => {
  if (mindmapVisible && !e.target.closest('#mindmap-panel') && !e.target.closest('#btn-mindmap-inline')) {
    mindmapVisible = false;
    document.getElementById('mindmap-panel').classList.remove('visible');
    const btn = document.getElementById('btn-mindmap-inline');
    if (btn) btn.classList.remove('active');
    toolbarClickScrollTop = null; // 清除滚动锁，防止关闭后跳回之前位置
  }
});

// ================== 收集样式（导出用） ==================
function collectAllStyles() {
  let styles = '';
  const seenRules = new Set();
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules || []) {
        if (!seenRules.has(rule.cssText)) {
          seenRules.add(rule.cssText);
          styles += rule.cssText + '\n';
        }
      }
    } catch (e) {}
  }
  if (!styles.trim()) {
    const styleTag = document.querySelector('style');
    if (styleTag) styles = styleTag.innerHTML;
  }
  return styles;
}

// ================== 引用数据管理 ==================
let citations = [];
let currentProjectMeta = null;
let isUpdatingReferences = false;
let pendingReferenceUpdate = false;
let pendingReferenceSkipBidirectionalCheck = false;
let cslRenderToken = 0;

const REFERENCE_STYLE_IDS = Object.freeze({
  APA: 'apa-7',
  MLA: 'mla-9',
  Chicago: 'chicago-17-author-date',
  IEEE: 'ieee',
  Harvard: 'harvard-cite-them-right-12',
  'GB/T': 'gb-t-7714-2015-numeric'
});

function newCitationUuid() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : generateId();
}

function isModernCitation(value) {
  return value && typeof value === 'object' && Array.isArray(value.items) && value.items.length > 0;
}

function legacyCitationsFromAnchors(projectCitations) {
  const byPaperId = new Map(projectCitations.map(citation => [String(citation.paperId), citation]));
  const citationItemIds = new Map();
  const result = [];
  quill.root.querySelectorAll('sup[data-paper-id]').forEach(sup => {
    const paperId = sup.getAttribute('data-paper-id');
    const legacy = byPaperId.get(String(paperId));
    if (!legacy?.paper) return;
    const citationInstanceId = sup.getAttribute('data-citation-instance-id') || newCitationUuid();
    const citationItemId = citationItemIds.get(paperId) || newCitationUuid();
    citationItemIds.set(paperId, citationItemId);
    sup.setAttribute('data-citation-instance-id', citationInstanceId);
    sup.setAttribute('tabindex', '0');
    sup.setAttribute('role', 'button');
    sup.setAttribute('aria-label', '编辑引用');
    result.push({
      citationInstanceId,
      insertionMode: 'citation-only',
      items: [{
        citationItemEntryId: newCitationUuid(),
        citationItemId,
        paperId,
        paper: legacy.paper,
        suppressAuthor: false,
        order: 0
      }]
    });
  });
  if (result.length) quill.update(Quill.sources.SILENT);
  return result;
}

function loadCitations(projectCitations = []) {
  const source = Array.isArray(projectCitations) ? projectCitations.slice(0, 10000) : [];
  const modern = source.length === 0 || source.every(isModernCitation);
  citations = modern
    ? source
    : legacyCitationsFromAnchors(source.filter(item => item && typeof item.paperId === 'string' && item.paper));
  return !modern && citations.length > 0;
}
function saveCitations() {
  if (!isLoadingProject) markProjectDataDirty();
  return true;
}

function createCitationCluster(papers) {
  const citationInstanceId = newCitationUuid();
  const items = papers.map((paper, order) => ({
    citationItemEntryId: newCitationUuid(),
    citationItemId: newCitationUuid(),
    ...(paper.libraryItemId ? { libraryItemId: paper.libraryItemId } : {}),
    paperId: paper.id,
    paper: JSON.parse(JSON.stringify(paper)),
    suppressAuthor: false,
    order
  }));
  const cluster = { citationInstanceId, insertionMode: 'citation-only', items };
  citations.push(cluster);
  saveCitations();
  return cluster;
}

function synchronizeCitationAnchors() {
  const anchors = Array.from(quill.root.querySelectorAll('sup[data-citation-instance-id], sup[data-paper-id]'));
  const byId = new Map(citations.filter(isModernCitation).map(citation => [citation.citationInstanceId || citation.id, citation]));
  const ordered = [];
  const seen = new Set();
  let changed = false;
  anchors.forEach(anchor => {
    let instanceId = anchor.getAttribute('data-citation-instance-id');
    let cluster = instanceId ? byId.get(instanceId) : null;
    if (!cluster) return;
    if (seen.has(instanceId)) {
      cluster = JSON.parse(JSON.stringify(cluster));
      instanceId = newCitationUuid();
      cluster.citationInstanceId = instanceId;
      delete cluster.id;
      cluster.items.forEach(item => { item.citationItemEntryId = newCitationUuid(); });
      anchor.setAttribute('data-citation-instance-id', instanceId);
      changed = true;
    }
    seen.add(instanceId);
    ordered.push(cluster);
    anchor.setAttribute('tabindex', '0');
    anchor.setAttribute('role', 'button');
    anchor.setAttribute('aria-label', '编辑引用');
  });
  if (JSON.stringify(citations) !== JSON.stringify(ordered)) changed = true;
  citations = ordered;
  if (changed && !isLoadingProject) saveCitations();
  return changed;
}

function clearRenderedReferences() {
  quill.root.querySelectorAll('[data-ref-section]').forEach(element => element.remove());
  const externalSection = document.getElementById('references-section');
  if (externalSection) externalSection.style.display = 'none';
}

function cslEntryInnerHtml(body) {
  const doc = new DOMParser().parseFromString(sanitizeEditorHtml(body), 'text/html');
  const entry = doc.body.querySelector('.csl-entry');
  const container = entry || doc.body;
  container.querySelectorAll('div, p').forEach(block => {
    const inline = doc.createElement('span');
    Array.from(block.attributes).forEach(attribute => {
      inline.setAttribute(attribute.name, attribute.value);
    });
    inline.append(...Array.from(block.childNodes));
    block.replaceWith(inline);
  });
  return container.innerHTML;
}

async function renderReferencesFromMain() {
  if (!currentProjectId || currentProjectRevision < 0 || !window.electronAPI?.renderProjectCitations) return;
  const token = ++cslRenderToken;
  const defaultStyle = (typeof getDefaultReferenceStyle === 'function' && getDefaultReferenceStyle()) || 'MLA';
  const styleName = currentProjectMeta?.referenceStyle || defaultStyle;
  const styleId = REFERENCE_STYLE_IDS[styleName] || REFERENCE_STYLE_IDS.APA;
  try {
    const rendered = await window.electronAPI.renderProjectCitations({ projectId: currentProjectId, styleId, format: 'html' });
    if (token !== cslRenderToken || !rendered) return;
    const byInstance = new Map(rendered.citations.map(value => [value.citationInstanceId, value.body]));
    quill.root.querySelectorAll('sup[data-citation-instance-id]').forEach(anchor => {
      const body = byInstance.get(anchor.getAttribute('data-citation-instance-id'));
      if (typeof body === 'string') anchor.innerHTML = sanitizeEditorHtml(body);
    });
    clearRenderedReferences();
    if (!rendered.bibliography.entries.length) {
      quill.update(Quill.sources.SILENT);
      return;
    }
    const spacer = document.createElement('p');
    spacer.setAttribute('data-ref-section', 'true');
    spacer.innerHTML = '<br>';
    spacer.style.marginTop = '80vh';
    quill.root.appendChild(spacer);
    const title = document.createElement('h2');
    title.setAttribute('data-ref-section', 'true');
    title.textContent = '参考文献';
    quill.root.appendChild(title);
    rendered.bibliography.entries.forEach((entry, index) => {
      const paragraph = document.createElement('p');
      paragraph.setAttribute('data-ref-section', 'true');
      paragraph.setAttribute('data-citation-num', String(index + 1));
      paragraph.setAttribute('data-citation-item-id', entry.citationItemIds[0] || '');
      paragraph.setAttribute('data-tooltip', '双击跳转到文中引用位置');
      paragraph.style.cursor = 'pointer';
      paragraph.innerHTML = cslEntryInnerHtml(entry.body);
      quill.root.appendChild(paragraph);
    });
    quill.update(Quill.sources.SILENT);
  } catch (error) {
    console.warn('[citation] CSL 渲染失败:', error);
    window.showToast?.(`引用渲染失败：${error.message || '请检查文献字段'}`);
  }
}

function generateReferences(skipBidirectionalCheck = false) {
  synchronizeCitationAnchors();
  if (!citations.length) clearRenderedReferences();
  return;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

// ================== 拖拽引用支持 ==================
let dragCursorLine = null;

function setupDragAndDrop() {
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return;

  // 创建竖线光标元素
  dragCursorLine = document.createElement('div');
  dragCursorLine.className = 'drag-cursor-line';
  dragCursorLine.style.display = 'none';
  document.body.appendChild(dragCursorLine);

  // 监听来自论文卡片的拖拽（仅保留黄色竖线光标，不显示论文影子）
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.paper-card');
    if (!card) return;
    const paper = window._draggingPaper;
    if (!paper) return;
    // 论文影子已移除，仅由黄色竖线指示插入位置
  });

  editorEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    editorEl.classList.add('drag-over');

    // 使用 document.caretPositionFromPoint 或 caretRangeFromPoint 获取插入点
    let range = null;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos && pos.offsetNode) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    } else if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    }

    if (range) {
      const lineRect = range.getBoundingClientRect();
      const lineHeight = lineRect.height || 20;
      dragCursorLine.style.display = 'block';
      dragCursorLine.style.height = lineHeight + 'px';
      dragCursorLine.style.left = (lineRect.left) + 'px';
      dragCursorLine.style.top = (lineRect.top + window.scrollY) + 'px';
    }
  });

  editorEl.addEventListener('dragleave', (e) => {
    if (!editorEl.contains(e.relatedTarget)) {
      editorEl.classList.remove('drag-over');
      if (dragCursorLine) dragCursorLine.style.display = 'none';
    }
  });

  editorEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    editorEl.classList.remove('drag-over');
    if (dragCursorLine) dragCursorLine.style.display = 'none';

    try {
      let evidence = null;
      const evidenceData = e.dataTransfer.getData('application/x-essayflow-evidence');
      if (evidenceData) evidence = JSON.parse(evidenceData);
      if (!evidence && window._draggingEvidence) evidence = window._draggingEvidence;
      if (evidence?.revision) {
        window.insertEssayflowEvidence?.(evidence, { clientX: e.clientX, clientY: e.clientY });
        return;
      }
      // 优先使用 dataTransfer，回退到全局变量（Electron 中 dataTransfer 有时不可靠）
      let paper = null;
      const paperData = e.dataTransfer.getData('application/json');
      if (paperData) {
        paper = JSON.parse(paperData);
      }
      if (!paper && window._draggingPaper) {
        paper = window._draggingPaper;
      }
      if (!paper || !paper.id) {
        console.warn('拖拽释放时未获取到论文数据');
        return;
      }

      // 计算 drop 位置在 quill 中的索引
      let dropIndex = quill.getLength();
      let caretRange = null;
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
        if (pos && pos.offsetNode) {
          caretRange = document.createRange();
          caretRange.setStart(pos.offsetNode, pos.offset);
        }
      } else if (document.caretRangeFromPoint) {
        caretRange = document.caretRangeFromPoint(e.clientX, e.clientY);
      }

      if (caretRange) {
        const startNode = caretRange.startContainer;
        let blot = null;
        try {
          blot = Quill.find(startNode);
        } catch(e) {}

        if (blot && blot !== quill.scroll) {
          const blotIndex = quill.getIndex(blot);
          if (startNode.nodeType === Node.TEXT_NODE) {
            dropIndex = blotIndex + caretRange.startOffset;
          } else {
            dropIndex = blotIndex;
          }
        }
      }

      // 校验：如果 dropIndex 等于文档末尾但鼠标不在文档末尾附近，提示重新拖拽
      if (dropIndex === quill.getLength()) {
        const editorRect = editorEl.getBoundingClientRect();
        const isNearBottom = e.clientY > editorRect.bottom - 50;
        if (!isNearBottom) {
          window.showToast('请更精确地选择插入位置，或拖放到文档末尾');
          return;
        }
      }

      const cluster = createCitationCluster([paper]);
      const temporaryCitation = `[${citations.length}]`;
      // 先安全地聚焦编辑器，初始化 Selection 模块，避免后续 Cursor 崩溃
      quill.focus();
      quill.insertText(dropIndex, temporaryCitation, {
        cite: {
          citationInstanceId: cluster.citationInstanceId,
          paperId: paper.id,
          num: citations.length
        }
      }, Quill.sources.USER);
      // 延迟设置 selection，避免与 insertText 的 MutationObserver 冲突触发 Cursor 错误
      setTimeout(() => {
        quill.setSelection(dropIndex + temporaryCitation.length, 0);
        quill.format('cite', false);
      }, 0);

      // 延迟生成参考文献，等 Quill 内部状态稳定后再操作 DOM
      // 传入 true 跳过双向检测，避免新引用被误判为"已删除"
      setTimeout(() => {
        generateReferences(true);
        autoSaveProject();
      }, 10);
    } catch(err) {
      console.warn('拖拽引用失败:', err);
    }
  });
}

// ================== 文件内容提取（自动识别标题摘要） ==================
const MAX_LITERATURE_IMPORT_BYTES = 100 * 1024 * 1024;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const separator = result.indexOf(',');
      if (separator < 0) {
        reject(new Error('文件编码失败'));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function normalizeImportedTitleKey(title) {
  const value = String(title || '').normalize('NFKC').toLowerCase();
  try {
    return value.replace(/[^\p{L}\p{N}]+/gu, '');
  } catch (e) {
    return value.replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
  }
}

async function extractTextFromFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'txt') {
    return await file.text();
  }
  if (ext === 'pdf') {
    const arrayBuffer = await file.arrayBuffer();
    try {
      const pdf = await window.essayFlowGetPdfDocument({ data: arrayBuffer }).promise;
      let text = '';
      for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(' ') + '\n';
      }
      return text;
    } catch (e) {
      console.warn('PDF解析失败:', e);
      return '';
    }
  }
  if (ext === 'docx' || ext === 'doc') {
    const arrayBuffer = await file.arrayBuffer();
    try {
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value;
    } catch (e) {
      console.warn('DOCX解析失败:', e);
      return '';
    }
  }
  return '';
}

function extractTitleAndAbstract(text) {
  if (!text) return { title: '', abstract: '' };
  const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // 标题提取：取前1000字符内第一个看起来像标题的非空行
  let title = '';
  const preview = cleanText.slice(0, 1000);
  const previewLines = preview.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  // 跳过 arXiv ID、纯日期、纯数字、过短的行
  const skipPatterns = [
    /^ar[xX]iv\s*:\s*\S+/,      // arXiv:hep-ex/0304026
    /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/, // 17 Apr 2003
    /^\d+$/,                       // 纯数字
    /^\d+\s+\d+$/,                 // 两个数字
    /^\S{1,15}$/,                  // 过短（如页码、编号）
    /^(?:Page|第)\s*\d+/i,         // 页眉页脚
    /^(?:Abstract|摘要|Keywords|关键词|Introduction|引言)/i, // 其他章节标题
  ];
  // 优先检测带有标题前缀的行（不限制长度）
  for (const line of previewLines) {
    const titleMatch = line.match(/^(?:Title|题目|标题|标题:)\s*[:：]?\s*(.+)/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      break;
    }
  }
  // 如果未找到前缀，取第一个符合长度和位置特征的行
  if (!title) {
    for (const line of previewLines) {
      if (line.length < 20 || line.length > 200) continue;
      if (skipPatterns.some(p => p.test(line))) continue;
      // 优先选择首字符大写或中文字符开头的完整句子
      if (/^[一-鿿]/.test(line) || /^[A-Z]/.test(line)) {
        title = line;
        break;
      }
    }
  }
  // 如果未找到，回退到旧逻辑
  if (!title && previewLines.length > 0) {
    title = previewLines[0];
    if (title.length > 200) title = title.slice(0, 100);
    const titleMatch = title.match(/^(?:Title|题目|标题|标题:)\s*[:：]?\s*(.+)/i);
    if (titleMatch) title = titleMatch[1].trim();
  }

  // 摘要提取：查找 Abstract / 摘要 关键词
  let abstract = '';
  const abstractPatterns = [
    /Abstract\s*[\n:：]\s*([\s\S]{50,500}?)(?=\n\s*(?:Keywords|关键词|Introduction|引言|1\s+[\w\u4e00-\u9fff]|\n\n))/i,
    /摘要\s*[\n:：]\s*([\s\S]{50,500}?)(?=\n\s*(?:关键词|Keywords|引言|Introduction|1\s+[\w\u4e00-\u9fff]|\n\n))/i,
    /ABSTRACT\s*[\n:：]?\s*([\s\S]{50,500}?)(?=\n\s*(?:KEYWORDS|关键词|INTRODUCTION|引言))/i
  ];
  for (const pattern of abstractPatterns) {
    const match = cleanText.match(pattern);
    if (match) {
      abstract = match[1].trim().replace(/\s+/g, ' ').slice(0, 500);
      break;
    }
  }

  // 如果未找到摘要，取文档前30%内容，跳过标题行
  if (!abstract) {
    const totalLen = cleanText.length;
    const sampleLen = Math.max(300, Math.floor(totalLen * 0.3));
    let sample = cleanText.slice(0, sampleLen);
    // 尝试跳过第一行（通常是标题）
    const lines = sample.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 1 && lines[0].length < 200) {
      // 第一行可能是标题，从第二行开始
      sample = lines.slice(1).join('\n');
    }
    // 取第一段超过50字符的段落
    const paras = sample.split('\n\n').map(p => p.trim().replace(/\s+/g, ' ')).filter(p => p.length > 50);
    abstract = (paras[0] || sample).slice(0, 300);
  }

  return { title: title || '未命名文献', abstract: abstract || '暂无摘要' };
}

function addImportedPaperToLibrary(paper) {
  if (!window.libraryPapers) window.libraryPapers = [];
  window.libraryPapers.push(paper);
  if (window.saveLibrary) window.saveLibrary();
  if (window.currentMode === 'library' && window.renderLibrary) {
    window.renderLibrary();
  }
}

// ================== 导入文献 ==================
function setupImportLiterature() {
  const btn = document.getElementById('btn-import-literature');
  const modal = document.getElementById('import-literature-modal');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => {
    openModalEl(modal);
  });

  modal.querySelector('.close').addEventListener('click', () => {
    closeModalEl(modal);
  });

  // Tab 切换
  modal.querySelectorAll('.import-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.type;
      document.getElementById('import-paper-form').style.display = type === 'paper' ? 'block' : 'none';
      document.getElementById('import-book-form').style.display = type === 'book' ? 'block' : 'none';
    });
  });

  // 文件拖放和选择（论文）
  const paperDropZone = document.getElementById('import-file-drop');
  const paperFileInput = document.getElementById('import-file-input');
  if (paperDropZone && paperFileInput) {
    paperDropZone.addEventListener('click', () => paperFileInput.click());
    paperDropZone.addEventListener('dragover', (e) => { e.preventDefault(); paperDropZone.classList.add('drag-active'); });
    paperDropZone.addEventListener('dragleave', () => paperDropZone.classList.remove('drag-active'));
    paperDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      paperDropZone.classList.remove('drag-active');
      const file = e.dataTransfer.files[0];
      if (file) handleImportFile(file, 'paper');
    });
    paperFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file, 'paper');
      paperFileInput.value = '';
    });
  }

  // 文件拖放和选择（书籍）
  const bookDropZone = document.getElementById('import-book-drop');
  const bookFileInput = document.getElementById('import-book-file-input');
  if (bookDropZone && bookFileInput) {
    bookDropZone.addEventListener('click', () => bookFileInput.click());
    bookDropZone.addEventListener('dragover', (e) => { e.preventDefault(); bookDropZone.classList.add('drag-active'); });
    bookDropZone.addEventListener('dragleave', () => bookDropZone.classList.remove('drag-active'));
    bookDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      bookDropZone.classList.remove('drag-active');
      const file = e.dataTransfer.files[0];
      if (file) handleImportFile(file, 'book');
    });
    bookFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file, 'book');
      bookFileInput.value = '';
    });
  }

  async function extractLiteratureInfoWithAI(text) {
    const config = getAIConfig ? getAIConfig() : null;
    if (!config || !config.base_url || !config.credential) {
      console.warn('[extractLiteratureInfoWithAI] AI 未配置，跳过');
      return null;
    }

    const truncatedText = text.slice(0, 2000);
    const prompt = `请从以下学术文章正文中提取关键信息，只返回纯 JSON 格式，不要包含任何其他文字（如 markdown 代码块标记、解释说明等）。

需要提取的字段：
- title: 文章的完整标题
- authors: 作者姓名，多个作者用逗号分隔，如果没有作者信息则返回空字符串
- published: 发布日期或年份，格式尽量统一为 YYYY-MM-DD 或 YYYY，如果没有则返回空字符串
- abstract: 文章摘要，如果原文没有明确标注的摘要，请提取文章开头的主要研究内容作为摘要，控制在300字以内

文章内容（前2000字符，通常为标题页和摘要区域）：
${truncatedText}

请严格返回以下格式：
{"title":"...","authors":"...","published":"...","abstract":"..."}`;

    const messages = [
      { role: 'system', content: 'You are a helpful academic document analysis assistant. Always respond with valid JSON only.' },
      { role: 'user', content: prompt }
    ];

    const result = await requestAI(messages, null, (err) => {
      console.error('[extractLiteratureInfoWithAI] AI 请求失败:', err);
    }, null, null, { operation: 'literature-metadata', contextKind: 'literature', promptTemplateVersion: 'literature-metadata-v1' });

    if (!result) return null;

    try {
      let jsonStr = result.trim();
      // 去除可能存在的 markdown 代码块标记
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      const parsed = JSON.parse(jsonStr);
      const info = {
        title: (parsed.title || '').trim(),
        authors: (parsed.authors || '').trim(),
        published: (parsed.published || '').trim(),
        abstract: (parsed.abstract || '').trim()
      };
      return info;
    } catch (e) {
      console.error('[extractLiteratureInfoWithAI] JSON 解析失败:', e, '原始内容:', result);
      return null;
    }
  }

  function updateImportProgress(percent, text) {
    const progressArea = document.getElementById('import-progress-area');
    const progressFill = document.getElementById('import-progress-fill');
    const progressText = document.getElementById('import-progress-text');
    if (!progressArea || !progressFill || !progressText) return;
    progressArea.style.display = 'block';
    progressFill.style.width = percent + '%';
    if (text) progressText.textContent = text;
  }

  function hideImportProgress() {
    const progressArea = document.getElementById('import-progress-area');
    const progressFill = document.getElementById('import-progress-fill');
    if (progressArea) progressArea.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
  }

  async function handleImportFile(file, type) {
    const ext = String(file?.name || '').split('.').pop().toLowerCase();
    if (!['pdf', 'txt', 'docx'].includes(ext)) {
      showToast('仅支持 PDF、TXT 和 DOCX 文件');
      return;
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_LITERATURE_IMPORT_BYTES) {
      showToast('文件为空或超过 100 MB，无法导入');
      return;
    }

    updateImportProgress(5, '正在提取文件内容...');
    let text = '';
    try {
      text = await extractTextFromFile(file);
    } catch (err) {
      hideImportProgress();
      showToast(`文件读取失败：${err.message || '文件不可用'}`);
      return;
    }

    // 判断是否使用 AI 识别文献信息
    const useAI = window.essayflowDataState?.settings?.featureToggles?.aiLiterature === true;
    let extracted = { title: '', authors: '', published: '', abstract: '' };

    if (useAI) {
      updateImportProgress(30, '正在使用 AI 识别文献信息...');
      const aiResult = await extractLiteratureInfoWithAI(text);
      if (aiResult && aiResult.title) {
        extracted = aiResult;
      } else {
        console.warn('[handleImportFile] AI 识别失败或未返回标题，回退到程序自动识别');
        const fallback = extractTitleAndAbstract(text);
        extracted.title = fallback.title;
        extracted.abstract = fallback.abstract;
      }
    } else {
      updateImportProgress(30, '正在识别文献信息...');
      const fallback = extractTitleAndAbstract(text);
      extracted.title = fallback.title;
      extracted.abstract = fallback.abstract;
    }

    const importedTitleKey = normalizeImportedTitleKey(extracted.title);
    const duplicatePaper = importedTitleKey && importedTitleKey !== normalizeImportedTitleKey('未命名文献')
      ? (window.libraryPapers || []).find(existing => normalizeImportedTitleKey(existing.title) === importedTitleKey)
      : null;

    if (duplicatePaper && (ext !== 'pdf' || duplicatePaper.localPdfPath)) {
      hideImportProgress();
      closeModalEl(modal);
      showToast(`《${extracted.title}》已在文库中`);
      return;
    }

    let localPdfPath = null;

    // 如果是 PDF 文件，保存到软件本地目录以便直接查看
    if (ext === 'pdf' && window.electronAPI && window.electronAPI.saveLocalPdf) {
      updateImportProgress(65, '正在保存 PDF 文件...');
      try {
        const base64 = await fileToBase64(file);
        const safeName = file.name.replace(/\.pdf$/i, '');
        localPdfPath = await window.electronAPI.saveLocalPdf(base64, safeName);
      } catch (e) {
        console.error('[handleImportFile] 保存本地 PDF 失败:', e);
      }
    }

    updateImportProgress(90, '正在添加到文库...');

    if (duplicatePaper) {
      if (localPdfPath) {
        duplicatePaper.localPdfPath = localPdfPath;
        duplicatePaper.pdfLink = `file:///${localPdfPath.replace(/\\/g, '/')}`;
        duplicatePaper.pdfUrl = duplicatePaper.pdfLink;
        duplicatePaper.hasPdf = true;
        if (window.saveLibrary) await Promise.resolve(window.saveLibrary());
        if (window.currentMode === 'library' && window.renderLibrary) window.renderLibrary();
        updateImportProgress(100, '本地 PDF 已补充');
        setTimeout(() => {
          hideImportProgress();
          closeModalEl(modal);
        }, 350);
        showToast(`已为《${duplicatePaper.title}》添加本地 PDF`);
      } else {
        hideImportProgress();
        showToast(`《${duplicatePaper.title}》已在文库中，本地 PDF 保存失败`);
      }
      return;
    }

    const paper = {
      id: type === 'paper' ? 'imported_' + generateId() : 'imported_book_' + generateId(),
      title: extracted.title,
      authors: extracted.authors || '佚名',
      published: extracted.published || '',
      abstract: extracted.abstract,
      link: '',
      pdfLink: localPdfPath ? `file:///${localPdfPath.replace(/\\/g, '/')}` : '',
      hasPdf: !!localPdfPath,
      journal: '',
      isImported: true,
      type: type,
      localPdfPath: localPdfPath || undefined
    };

    addImportedPaperToLibrary(paper);

    updateImportProgress(100, '导入完成');
    setTimeout(() => {
      hideImportProgress();
      closeModalEl(modal);
    }, 500);
    showToast(`已导入《${paper.title}》到文库`);
  }

  window.addEventListener('click', (e) => {
    if (e.target === modal) closeModalEl(modal);
  });
}

// ================== 编辑文献模态框 ==================
function setupEditLiterature() {
  const modal = document.getElementById('edit-literature-modal');
  if (!modal) return;

  modal.querySelector('.close').addEventListener('click', () => {
    closeModalEl(modal);
  });

  document.getElementById('btn-do-edit').addEventListener('click', () => {
    const id = document.getElementById('edit-paper-id').value;
    if (!id) return;

    const paper = window.libraryPapers.find(p => p.id === id);
    if (!paper) return;

    paper.title = document.getElementById('edit-paper-title').value.trim() || paper.title;
    paper.authors = document.getElementById('edit-paper-authors').value.trim() || '佚名';
    paper.published = document.getElementById('edit-paper-year').value.trim() || '';
    paper.journal = document.getElementById('edit-paper-source').value.trim() || '';
    paper.abstract = document.getElementById('edit-paper-abstract').value.trim() || '无摘要';
    paper.link = document.getElementById('edit-paper-doi').value.trim() || '';

    if (window.saveLibrary) window.saveLibrary();
    closeModalEl(modal);
    showToast('文献信息已更新');

    // 刷新显示
    if (window.currentMode === 'library' && window.renderLibrary) {
      window.renderLibrary();
    }
    // 同时刷新引用区域（如果该文献被引用过）
    generateReferences();
    autoSaveProject();
  });

  window.addEventListener('click', (e) => {
    if (e.target === modal) closeModalEl(modal);
  });
}

window.openEditModal = function(paper) {
  const modal = document.getElementById('edit-literature-modal');
  if (!modal) return;
  document.getElementById('edit-paper-id').value = paper.id;
  document.getElementById('edit-paper-title').value = paper.title || '';
  document.getElementById('edit-paper-authors').value = paper.authors || '';
  document.getElementById('edit-paper-year').value = paper.published || '';
  document.getElementById('edit-paper-source').value = paper.journal || '';
  document.getElementById('edit-paper-abstract').value = paper.abstract || '';
  document.getElementById('edit-paper-doi').value = paper.link || '';
  openModalEl(modal);
};

// ================== 高亮选区 ==================
function highlightSelection() {
  const range = quill.getSelection();
  if (range && range.length > 0) quill.format('background', '#fff3c9');
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'h') {
    e.preventDefault();
    highlightSelection();
  }
});

// ================== 拖拽分割条 ==================
function makeResizable(resizerId, leftSel, rightSel) {
  const resizer = document.getElementById(resizerId);
  const left = document.getElementById(leftSel);
  const right = document.getElementById(rightSel);
  if (!resizer || !left || !right) return;

  const toggle = document.getElementById('search-panel-toggle');
  const minLeft = 300;
  const minRight = 280;
  let startX;
  let startLeftWidth;
  let startRightWidth;
  let lastExpandedRightWidth = Math.max(minRight, right.getBoundingClientRect().width || 420);
  let collapseCandidate = false;
  let collapsed = false;

  function availablePairWidth() {
    const parent = resizer.parentElement;
    if (!parent) return left.getBoundingClientRect().width + right.getBoundingClientRect().width;
    const reserved = [...parent.children]
      .filter(element => element !== left && element !== right && element !== resizer)
      .reduce((sum, element) => sum + element.getBoundingClientRect().width, 0);
    return Math.max(minLeft + minRight, parent.clientWidth - reserved - resizer.getBoundingClientRect().width);
  }

  function updateToggle() {
    if (!toggle) return;
    const label = collapsed ? '展开资料栏' : '收起资料栏';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.tabIndex = collapsed ? 0 : -1;
  }

  function updateEdgePointer(event) {
    const bounds = resizer.getBoundingClientRect();
    const pointerY = Math.max(18, Math.min(bounds.height - 18, event.clientY - bounds.top));
    resizer.style.setProperty('--rail-pointer-y', `${pointerY}px`);
  }

  function activateEdgePointer(event) {
    resizer.classList.add('is-rail-active');
    updateEdgePointer(event);
  }

  function resetEdgePointer() {
    resizer.classList.remove('is-rail-active');
    const bounds = resizer.getBoundingClientRect();
    // Commit the zero-lag tracking state before enabling the return spring.
    void resizer.offsetWidth;
    resizer.style.setProperty('--rail-pointer-y', `${bounds.height / 2}px`);
  }

  function persistHorizontalFlex() {
    localStorage.setItem('essay_horizontal_flex', JSON.stringify({
      left: left.style.flex,
      right: right.style.flex,
      collapsed,
      expandedRight: lastExpandedRightWidth
    }));
  }

  function setCollapsed(nextCollapsed, { persist = true, immediate = false, expandedWidth } = {}) {
    if (Number.isFinite(expandedWidth)) lastExpandedRightWidth = Math.max(minRight, expandedWidth);
    if (nextCollapsed && !collapsed && !Number.isFinite(expandedWidth)) {
      lastExpandedRightWidth = Math.max(minRight, right.getBoundingClientRect().width);
    }
    if (nextCollapsed === collapsed && right.classList.contains('is-collapsed') === nextCollapsed) {
      updateToggle();
      return;
    }
    if (immediate) document.body.classList.add('is-restoring-horizontal-layout');
    const totalWidth = availablePairWidth();
    collapsed = nextCollapsed;
    if (collapsed) {
      right.classList.add('is-collapsed');
      resizer.classList.add('search-panel-collapsed');
      right.setAttribute('aria-hidden', 'true');
      right.inert = true;
      right.style.flex = '0 0 0px';
      left.style.flex = `0 0 ${totalWidth}px`;
    } else {
      const restoredRightWidth = Math.min(lastExpandedRightWidth, Math.max(minRight, totalWidth - minLeft));
      right.style.flex = `0 0 ${restoredRightWidth}px`;
      left.style.flex = `0 0 ${Math.max(minLeft, totalWidth - restoredRightWidth)}px`;
      right.classList.remove('is-collapsed');
      resizer.classList.remove('search-panel-collapsed');
      right.removeAttribute('aria-hidden');
      right.inert = false;
    }
    updateToggle();
    if (mindmapVisible) updateMindmapPosition();
    if (persist) persistHorizontalFlex();
    if (immediate) requestAnimationFrame(() => document.body.classList.remove('is-restoring-horizontal-layout'));
  }

  resizer.addEventListener('mousedown', (e) => {
    if (collapsed || e.target.closest('.search-panel-edge-toggle')) return;
    e.preventDefault();
    startX = e.clientX;
    startLeftWidth = left.getBoundingClientRect().width;
    startRightWidth = right.getBoundingClientRect().width;
    lastExpandedRightWidth = Math.max(minRight, startRightWidth);
    collapseCandidate = false;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.classList.add('is-resizing-horizontal');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  function onMouseMove(e) {
    const delta = e.clientX - startX;
    let newLeft = startLeftWidth + delta;
    let newRight = startRightWidth - delta;
    const totalWidth = startLeftWidth + startRightWidth;
    collapseCandidate = newRight <= minRight;
    resizer.classList.toggle('is-collapse-ready', collapseCandidate);
    if (newLeft < minLeft) {
      newLeft = minLeft;
      newRight = totalWidth - minLeft;
    } else if (newRight < minRight) {
      newRight = minRight;
      newLeft = totalWidth - minRight;
    }
    left.style.flex = `0 0 ${newLeft}px`;
    right.style.flex = `0 0 ${newRight}px`;
    if (mindmapVisible) updateMindmapPosition();
  }
  function onMouseUp() {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.classList.remove('is-resizing-horizontal');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    resizer.classList.remove('is-collapse-ready');
    if (collapseCandidate) setCollapsed(true, { expandedWidth: startRightWidth });
    else persistHorizontalFlex();
    collapseCandidate = false;
  }

  toggle?.addEventListener('mousedown', event => event.stopPropagation());
  toggle?.addEventListener('click', event => {
    event.stopPropagation();
    setCollapsed(!collapsed);
  });
  resizer.addEventListener('pointerenter', activateEdgePointer);
  resizer.addEventListener('pointermove', activateEdgePointer);
  resizer.addEventListener('pointerleave', resetEdgePointer);

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (mindmapVisible) updateMindmapPosition();
    }).observe(right);
  }

  updateToggle();

  return {
    setCollapsed,
    setExpandedWidth(value) {
      if (Number.isFinite(value)) lastExpandedRightWidth = Math.max(minRight, value);
    }
  };
}
const horizontalResizeController = makeResizable('resizer', 'workspace', 'search-panel');

window.expandEssayflowResearchPane = () => horizontalResizeController?.setCollapsed(false);

// 恢复用户偏好的面板宽度
(function restoreHorizontalFlex() {
  try {
    const saved = JSON.parse(localStorage.getItem('essay_horizontal_flex') || '{}');
    const left = document.getElementById('workspace');
    const right = document.getElementById('search-panel');
    const savedExpandedWidth = Number(saved.expandedRight)
      || Number.parseFloat(String(saved.right || '').match(/[\d.]+px/)?.[0]);
    horizontalResizeController?.setExpandedWidth(savedExpandedWidth);
    if (saved.left && left) left.style.flex = saved.left;
    if (saved.right && right) right.style.flex = saved.right;
    if (saved.collapsed === true) {
      const expandedWidth = savedExpandedWidth || 420;
      horizontalResizeController?.setCollapsed(true, { persist: false, immediate: true, expandedWidth });
    }
  } catch (e) {}
})();

// ================== 水平分割条（搜索区与 AI 聊天面板之间） ==================
function makeVerticalResizable(resizerId, topSel, bottomSel) {
  const resizer = document.getElementById(resizerId);
  const top = document.getElementById(topSel);
  const bottom = document.getElementById(bottomSel);
  if (!resizer || !top || !bottom) return;

  let startY, startTopHeight, startBottomHeight;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startTopHeight = top.getBoundingClientRect().height;
    startBottomHeight = bottom.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    const delta = e.clientY - startY;
    let newTop = Math.max(80, startTopHeight + delta);
    let newBottom = Math.max(120, startBottomHeight - delta);

    // 限制 bottom 不超过父容器高度的 80%，防止面板拖出可视区域
    const parentHeight = resizer.parentElement?.clientHeight || window.innerHeight;
    const maxBottom = Math.floor(parentHeight * 0.8);
    if (newBottom > maxBottom) {
      newBottom = maxBottom;
      newTop = Math.max(80, parentHeight - newBottom - 4); // 4px 是 resizer 高度
    }

    top.style.flex = `0 0 ${newTop}px`;
    bottom.style.flex = `0 0 ${newBottom}px`;
  }

  function onMouseUp() {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    // 保存用户偏好的面板高度到 localStorage
    localStorage.setItem('essay_vertical_flex', JSON.stringify({
      top: top.style.flex,
      bottom: bottom.style.flex
    }));
  }
}
makeVerticalResizable('chat-resizer', 'search-main', 'ai-chat-panel');

// 恢复用户偏好的面板高度
(function restoreVerticalFlex() {
  try {
    const saved = JSON.parse(localStorage.getItem('essay_vertical_flex') || '{}');
    const top = document.getElementById('search-main');
    const bottom = document.getElementById('ai-chat-panel');
    if (saved.top && top) top.style.flex = saved.top;
    if (saved.bottom && bottom) bottom.style.flex = saved.bottom;
  } catch (e) {}
})();

function initTheme() {
  const isDark = localStorage.getItem('essay_theme') === 'dark';
  const body = document.body;
  if (isDark) {
    body.classList.add('dark');
  } else {
    body.classList.remove('dark');
  }
  // 更新工具栏图标
  const moonIcon = document.getElementById('theme-icon-moon');
  const sunIcon = document.getElementById('theme-icon-sun');
  const toggle = document.getElementById('theme-dark-toggle');
  if (moonIcon && sunIcon) {
    if (isDark) {
      moonIcon.style.display = 'block';
      sunIcon.style.display = 'none';
    } else {
      moonIcon.style.display = 'none';
      sunIcon.style.display = 'block';
    }
  }
  if (toggle) {
    toggle.checked = isDark;
  }
}

function toggleTheme() {
  const body = document.body;
  const isDark = body.classList.toggle('dark');
  localStorage.setItem('essay_theme', isDark ? 'dark' : 'light');
  initTheme();
  window.showToast(isDark ? '已切换至深色模式' : '已切换至浅色模式');
}

// ================== 启动时自动加载最近项目 ==================
async function initProject() {
  const initToken = projectLoadToken;
  try {
    await window.essayflowDataReady;
    if (window.electronAPI?.listProjects) {
      const projects = await window.electronAPI.listProjects();
      if (projectLoadToken !== initToken) return { success: false, reason: 'superseded' };
      if (Array.isArray(projects) && projects.length > 0) {
        const last = [...projects].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
        await loadProject(last.id);
        return;
      }
    }
    currentProjectId = generateId();
    currentProjectRevision = -1;
    currentProjectMeta = null;
    citations = [];
  } catch (err) {
    if (projectLoadToken !== initToken) return { success: false, reason: 'superseded' };
    currentProjectId = generateId();
    currentProjectRevision = -1;
    currentProjectMeta = null;
    citations = [];
    updateSaveStatus('error');
    console.warn('初始化项目失败:', err);
    window.showToast?.('项目列表读取失败，可新建项目后继续使用');
  }
}
function initApp() {
  window.scrollTo(0, 0);
  cleanupLegacyShortcuts();
  isLoadingProject = true;
  quill.enable(false);
  quill.root.setAttribute('aria-busy', 'true');
  setupAutoSave();
  initTheme();
  setupAccessibilityDefaults();

  // 修复 Quill 1.3.6 Cursor.restore 在 selection 为 undefined 时崩溃的问题
  try {
    const CursorBlot = Quill.import('blots/cursor');
    if (CursorBlot && CursorBlot.prototype && CursorBlot.prototype.restore) {
      const originalRestore = CursorBlot.prototype.restore;
      CursorBlot.prototype.restore = function() {
        if (!this.selection) return null;
        return originalRestore.call(this);
      };
    }
  } catch(e) {}

  setTimeout(async () => {
    try {
      await initProject();
      setupProjectDataActions();
      injectMindmapButton();
      injectAIButton();
      injectMoreDropdown();
      setupDragAndDrop();
      setupImportLiterature();
      setupEditLiterature();
      setupMindmapScrollFix();
    // 搜索替换面板 resize 时更新 fixed 位置
    window.addEventListener('resize', () => {
      if (findReplacePanel && findReplacePanel.classList.contains('visible')) {
        updateFindReplacePosition();
      }
    });
      setupCitationNavigation();
      setupCitationMarkerClear();
      setupCitationEditor();
      setupRefSectionObserver();
      setupBlockToolbar();
      setupPriorityKeywordTooltip();
      setupTableDialog();
      setupTableContextMenu();
      setupFindReplacePanel();
      setupAutocloseElements();
      bindGlobalShortcuts();
      setupSpecialKeys();
      setupParagraphActions();
      setupAccessibilityDefaults();
      // 主题切换按钮
      const themeBtn = document.getElementById('btn-theme');
      if (themeBtn) {
        themeBtn.addEventListener('click', toggleTheme);
      }
      // 设置面板中的主题切换
      const themeToggle = document.getElementById('theme-dark-toggle');
      if (themeToggle) {
        themeToggle.addEventListener('change', (e) => {
          if (e.target.checked !== document.body.classList.contains('dark')) {
            toggleTheme();
          }
        });
      }
    } catch (err) {
      console.error('[initApp] 初始化失败:', err);
      window.showToast?.('部分功能初始化失败，请重新启动应用');
    } finally {
      isLoadingProject = false;
      appInitializationComplete = true;
      quill.enable(true);
      quill.root.removeAttribute('aria-busy');
    }
  }, 0);
}

// ================== 监听参考文献段落删除 ==================
function setupRefSectionObserver() {
  const editorEl = quill.root;
  if (!editorEl) return;

  let debounceTimer = null;

  const observer = new MutationObserver((mutations) => {
    if (isUpdatingReferences) return;
    let hasRemoved = false;
    mutations.forEach((mutation) => {
      if (mutation.type === 'childList') {
        mutation.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && node.matches && node.matches('[data-ref-section]')) {
            hasRemoved = true;
          }
        });
      }
    });
    if (hasRemoved) {
      clearTimeout(debounceTimer);
      const runUpdate = () => generateReferences();
      if (typeof requestIdleCallback !== 'undefined') {
        debounceTimer = setTimeout(() => requestIdleCallback(runUpdate), 300);
      } else {
        debounceTimer = setTimeout(runUpdate, 300);
      }
    }
  });
  observer.observe(editorEl, { childList: true, subtree: true });
}

// ================== 思维导图位置动态计算 ==================
function updateMindmapPosition() {
  const panel = document.getElementById('mindmap-panel');
  const toolbar = document.querySelector('.ql-toolbar');
  const searchPanel = document.getElementById('search-panel');
  if (!panel || !toolbar || !searchPanel) return;

  const toolbarRect = toolbar.getBoundingClientRect();
  const searchRect = searchPanel.getBoundingClientRect();

  // 上边缘贴着 toolbar 下边缘 + 4px 间距
  panel.style.top = `${toolbarRect.bottom + 4}px`;
  // 右边缘 = 搜索区宽度 + 间距，使思维导图位于编辑区右侧
  panel.style.right = `${searchRect.width + 12}px`;
}

function setupMindmapScrollFix() {
  // 监听窗口 resize 和思维导图显示时更新位置
  window.addEventListener('resize', () => {
    if (mindmapVisible) updateMindmapPosition();
  });
}

// ================== AI 工具栏按钮注入 ==================
function injectAIButton() {
  const oldBtn = document.getElementById('btn-ai-chat-inline');
  if (oldBtn) oldBtn.remove();

  const toolbar = document.querySelector('.ql-toolbar.ql-snow');
  if (!toolbar) return;

  const btn = document.createElement('button');
  btn.id = 'btn-ai-chat-inline';
  btn.setAttribute('data-tooltip', 'AI 助手');
  btn.type = 'button';
  btn.className = 'ai-toolbar-btn';
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="11" width="18" height="10" rx="2"/>
      <circle cx="12" cy="5" r="2"/>
      <path d="M12 7v4"/>
      <path d="M8 15h8"/>
    </svg>
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof toggleChatPanel === 'function') {
      const researchPaneCollapsed = document.getElementById('search-panel')?.classList.contains('is-collapsed');
      // 资料栏收起时，一次工具栏点击应恢复资料栏并显示 AI 助手。
      toggleChatPanel(researchPaneCollapsed ? true : undefined);
    } else {
      window.showToast('AI 助手加载中，请稍后');
    }
  });

  // 插入到文章导图按钮同一组（靠右排列）
  const rightGroup = document.getElementById('right-toolbar-group');
  if (rightGroup) {
    rightGroup.appendChild(btn);
  } else {
    const wrapper = document.createElement('span');
    wrapper.id = 'right-toolbar-group';
    wrapper.className = 'ql-formats';
    wrapper.style.cssFloat = 'right';
    wrapper.appendChild(btn);
    toolbar.insertBefore(wrapper, toolbar.firstChild);
  }
}

// ================== 块级浮窗工具栏 ==================
let blockToolbar = null;
let blockToolbarCurrentRange = null;

function setupBlockToolbar() {
  blockToolbar = document.getElementById('block-action-toolbar');
  if (!blockToolbar) return;

  // 将 blockToolbar 移动到 #workspace 中，使其相对于 workspace 定位
  const workspace = document.getElementById('workspace');
  if (workspace && blockToolbar.parentElement !== workspace) {
    workspace.appendChild(blockToolbar);
  }

  blockToolbar.querySelectorAll('.block-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = btn.dataset.action;
      handleBlockAction(action);
    });
  });

  // 格式按钮：阻止焦点转移 + toggle 格式
  blockToolbar.querySelectorAll('.block-action-format-btn[data-format]').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const format = btn.dataset.format;
      if (!blockToolbarCurrentRange) return;
      const range = blockToolbarCurrentRange;
      const currentFormat = quill.getFormat(range.index, range.length);
      const isActive = !!currentFormat[format];
      quill.formatText(range.index, range.length, format, !isActive);
      btn.classList.toggle('active', !isActive);
      // 恢复选区，保持浮窗显示
      setTimeout(() => {
        quill.setSelection(range.index, range.length, 'silent');
      }, 0);
    });
  });

  // 下拉按钮：展开/关闭下拉面板
  blockToolbar.querySelectorAll('.block-action-dropdown-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdownType = btn.dataset.dropdown;
      toggleBlockDropdown(dropdownType, btn);
    });
  });

  // 下拉面板 - header 选项
  blockToolbar.querySelectorAll('[data-dropdown-panel="header"] .dropdown-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!blockToolbarCurrentRange) {
        return;
      }
      const range = blockToolbarCurrentRange;
      const headerVal = item.dataset.header;
      const val = headerVal === 'false' ? false : parseInt(headerVal, 10);
      // block 格式需要先恢复选区，再用 quill.format()
      quill.setSelection(range.index, range.length, 'silent');
      quill.format('header', val);
      setTimeout(() => {
        quill.setSelection(range.index, range.length, 'silent');
      }, 0);
      closeAllBlockDropdowns();
    });
  });

  // 下拉面板 - color 选项
  blockToolbar.querySelectorAll('[data-dropdown-panel="color"] .color-swatch').forEach(swatch => {
    swatch.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!blockToolbarCurrentRange) {
        return;
      }
      const range = blockToolbarCurrentRange;
      const color = swatch.dataset.color;
      quill.setSelection(range.index, range.length, 'silent');
      const colorDelta = quill.formatText(range.index, range.length, 'color', color || false);
      setTimeout(() => {
        quill.setSelection(range.index, range.length, 'silent');
      }, 0);
      closeAllBlockDropdowns();
    });
  });

  // 下拉面板 - background 选项
  blockToolbar.querySelectorAll('[data-dropdown-panel="background"] .color-swatch').forEach(swatch => {
    swatch.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!blockToolbarCurrentRange) {
        return;
      }
      const range = blockToolbarCurrentRange;
      const bg = swatch.dataset.color;
      quill.setSelection(range.index, range.length, 'silent');
      const bgDelta = quill.formatText(range.index, range.length, 'background', bg || false);
      setTimeout(() => {
        quill.setSelection(range.index, range.length, 'silent');
      }, 0);
      closeAllBlockDropdowns();
    });
  });

  // 监听 mouseup 显示工具栏
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (editorEl) {
    editorEl.addEventListener('mouseup', (e) => {
      setTimeout(() => {
        const range = quill.getSelection(true);
        if (range && range.length > 0) {
          const selectedText = quill.getText(range.index, range.length);
          // 只有选中真正的文字内容（不只是空格/换行/空白）时才显示浮窗
          if (selectedText.replace(/\s/g, '').length > 0) {
            showBlockToolbar(range);
          } else {
            hideBlockToolbar();
          }
        } else {
          hideBlockToolbar();
        }
      }, 100);
    });
  }

  // 监听 selection-change 隐藏工具栏
  quill.on('selection-change', (range, oldRange, source) => {
    if (!range || range.length === 0) {
      hideBlockToolbar();
    }
  });

  // 编辑器滚动时隐藏浮窗（不清除选区）
  if (editorEl) {
    editorEl.addEventListener('scroll', () => hideBlockToolbar(), { passive: true });
  }

  // 点击外部或空白区域：隐藏浮窗 + 清除选区
  document.addEventListener('mousedown', (e) => {
    if (!blockToolbar) return;
    if (blockToolbar.contains(e.target)) {
      // 点击浮窗内：如果不是下拉按钮或下拉面板，关闭所有下拉面板
      if (!e.target.closest('.block-action-dropdown-btn') && !e.target.closest('.block-action-dropdown')) {
        closeAllBlockDropdowns();
      }
      return;
    }

    const editorEl = document.querySelector('#editor-container .ql-editor');
    if (!editorEl || !editorEl.contains(e.target)) {
      // 点击编辑器外部：隐藏浮窗
      hideBlockToolbar();
      return;
    }

    // 点击编辑器内部：检查是否在选区范围内
    const range = quill.getSelection();
    if (range && range.length > 0) {
      const bounds = quill.getBounds(range.index, range.length);
      const editorRect = editorEl.getBoundingClientRect();
      const clickY = e.clientY;
      const clickX = e.clientX;
      const boundsTop = editorRect.top + bounds.top;
      const boundsBottom = editorRect.top + bounds.bottom;
      const boundsLeft = editorRect.left + bounds.left;
      const boundsRight = editorRect.left + bounds.right;

      if (clickX < boundsLeft || clickX > boundsRight || clickY < boundsTop || clickY > boundsBottom) {
        hideBlockToolbar();
        quill.setSelection(null);
      }
    }
  });
  // workspace 滚动时隐藏浮窗（不清除选区），同时收起 Quill 下拉菜单
  if (workspace) {
    workspace.addEventListener('scroll', () => {
      hideBlockToolbar();
      document.querySelectorAll('.ql-picker.ql-expanded').forEach(picker => {
        picker.classList.remove('ql-expanded');
      });
    }, { passive: true });
  }

}

function setupAutocloseElements() {
  const shouldAutoclose = () => localStorage.getItem('essay_toolbar_autoclose') === 'true';

  // 1. 框选浮窗
  if (blockToolbar) {
    blockToolbar.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) hideBlockToolbar();
    });
  }

  // 2. Quill picker（字体大小、颜色、背景色、对齐、列表等）
  document.querySelectorAll('.ql-picker').forEach(picker => {
    picker.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) picker.classList.remove('ql-expanded');
    });
  });

  // 3. 更多功能下拉菜单
  const moreDropdown = document.getElementById('more-dropdown-menu');
  if (moreDropdown) {
    moreDropdown.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) moreDropdown.classList.remove('open');
    });
  }

  // 4. 文章导图面板
  const mindmapPanel = document.getElementById('mindmap-panel');
  if (mindmapPanel) {
    mindmapPanel.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) {
        mindmapPanel.classList.remove('visible');
        mindmapVisible = false;
        const mindmapBtn = document.getElementById('btn-mindmap-inline');
        if (mindmapBtn) mindmapBtn.classList.remove('active');
      }
    });
  }

  // 5. 表格插入对话框
  const tableDialog = document.getElementById('table-insert-dialog');
  if (tableDialog) {
    tableDialog.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) tableDialog.style.display = 'none';
    });
  }

  // 6. 表格右键菜单
  const tableContextMenu = document.getElementById('table-context-menu');
  if (tableContextMenu) {
    tableContextMenu.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) tableContextMenu.style.display = 'none';
    });
  }

  // 7. 搜索替换面板
  const findReplacePanelEl = document.getElementById('find-replace-panel');
  if (findReplacePanelEl) {
    findReplacePanelEl.addEventListener('mouseleave', () => {
      if (shouldAutoclose()) hideFindReplacePanel();
    });
  }
}

function showBlockToolbar(range) {
  if (!blockToolbar) return;

  const bounds = quill.getBounds(range.index, range.length);
  const workspace = document.getElementById('workspace');
  const editorEl = document.querySelector('#editor-container .ql-editor');
  const qlToolbar = document.querySelector('.ql-toolbar.ql-snow');
  if (!workspace || !editorEl || !bounds) return;

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = editorEl.getBoundingClientRect();

  // 临时显示以获取真实尺寸（避免默认值不准导致遮挡文本）
  let toolbarWidth = blockToolbar.offsetWidth;
  let toolbarHeight = blockToolbar.offsetHeight;
  if (toolbarHeight === 0) {
    const prevDisplay = blockToolbar.style.display;
    const prevVisibility = blockToolbar.style.visibility;
    blockToolbar.style.display = 'flex';
    blockToolbar.style.visibility = 'hidden';
    toolbarWidth = blockToolbar.offsetWidth;
    toolbarHeight = blockToolbar.offsetHeight;
    blockToolbar.style.display = prevDisplay;
    blockToolbar.style.visibility = prevVisibility;
  }

  const padding = 8;

  // 将 editor 边界转换为 workspace-relative
  const editorTopRel = editorRect.top - workspaceRect.top + workspace.scrollTop;
  const editorBottomRel = editorRect.bottom - workspaceRect.top + workspace.scrollTop;
  const editorLeftRel = editorRect.left - workspaceRect.left + workspace.scrollLeft;
  const editorRightRel = editorRect.right - workspaceRect.left + workspace.scrollLeft;

  // 工具栏底部（workspace-relative），确保浮窗不遮挡 Quill 工具栏
  let toolbarBottomRel = editorTopRel;
  if (qlToolbar) {
    const qlToolbarRect = qlToolbar.getBoundingClientRect();
    toolbarBottomRel = qlToolbarRect.bottom - workspaceRect.top + workspace.scrollTop;
  }

  const minTop = toolbarBottomRel + padding;
  const maxTop = editorBottomRel - toolbarHeight - padding;
  const minLeft = editorLeftRel + padding;
  const maxLeft = editorRightRel - toolbarWidth - padding;

  // 计算 workspace-relative 坐标（加入 editor 在 workspace 中的偏移）
  let top = bounds.top + editorTopRel - toolbarHeight - padding;
  let left = bounds.left + editorLeftRel + bounds.width / 2 - toolbarWidth / 2;

  // 默认在选区上方；如果会遮挡工具栏或选区，则切换到选区下方
  if (top < minTop) {
    top = bounds.bottom + editorTopRel + padding;
  }
  // 如果下方空间也不足，显示在选区右侧（避让模式）
  if (top > maxTop) {
    top = bounds.top + editorTopRel + padding;
    left = bounds.right + editorLeftRel + padding;
  }

  // 上下边界保护：不超出 workspace 可视区
  const workspaceMinTop = workspace.scrollTop + padding;
  const workspaceMaxTop = workspace.scrollTop + workspace.clientHeight - toolbarHeight - padding;
  if (top < workspaceMinTop) top = workspaceMinTop;
  if (top > workspaceMaxTop) top = workspaceMaxTop;
  if (top < minTop) top = minTop;

  // 左右边界保护
  if (left < minLeft) left = minLeft;
  if (left > maxLeft) left = maxLeft;

  clearTimeout(_blockToolbarHideTimer);
  blockToolbar.style.top = top + 'px';
  blockToolbar.style.left = left + 'px';
  blockToolbar.style.display = 'flex';
  requestAnimationFrame(() => {
    // 重新计算位置，确保动画开始时位置是最新的
    const freshBounds = quill.getBounds(range.index, range.length);
    if (freshBounds) {
      const freshTop = freshBounds.top + editorTopRel - toolbarHeight - padding;
      const freshLeft = freshBounds.left + editorLeftRel + freshBounds.width / 2 - toolbarWidth / 2;
      blockToolbar.style.top = freshTop + 'px';
      blockToolbar.style.left = freshLeft + 'px';
    }
    blockToolbar.classList.add('visible');
  });

  // 显示块级工具栏时隐藏 AI 操作面板，避免两个面板重叠
  if (typeof hideSlashActionPanel === 'function') {
    hideSlashActionPanel();
  }

  blockToolbarCurrentRange = range;

  // 更新优先关键词按钮状态
  updatePriorityKeywordButtonState(range);

  // 更新格式按钮 active 状态
  try {
    const currentFormat = quill.getFormat(range.index, range.length);
    blockToolbar.querySelectorAll('.block-action-format-btn[data-format]').forEach(btn => {
      const format = btn.dataset.format;
      btn.classList.toggle('active', !!(currentFormat && currentFormat[format]));
    });
    // 下拉按钮 active 状态
    const headerBtn = blockToolbar.querySelector('[data-dropdown="header"]');
    if (headerBtn) headerBtn.classList.toggle('active', !!(currentFormat && currentFormat.header));
    const colorBtn = blockToolbar.querySelector('[data-dropdown="color"]');
    if (colorBtn) colorBtn.classList.toggle('active', !!(currentFormat && currentFormat.color));
    const bgBtn = blockToolbar.querySelector('[data-dropdown="background"]');
    if (bgBtn) bgBtn.classList.toggle('active', !!(currentFormat && currentFormat.background));
  } catch (err) {
    console.error('[showBlockToolbar] format error:', err);
  }

  // 大块浮窗出现时，强制关闭小块提示并阻止其触发
  hidePriorityKeywordTooltip();
  if (priorityKeywordTooltip) priorityKeywordTooltip.style.display = 'none';
  clearTimeout(priorityTooltipTimer);
}

function toggleBlockDropdown(type, btn) {
  if (!blockToolbar) return;
  const panel = blockToolbar.querySelector(`[data-dropdown-panel="${type}"]`);
  if (!panel) return;
  const isOpen = panel.classList.contains('show');
  closeAllBlockDropdowns();
  if (!isOpen) {
    panel.classList.add('show');
    btn.classList.add('active');
  }
}

function closeAllBlockDropdowns() {
  if (!blockToolbar) return;
  blockToolbar.querySelectorAll('.block-action-dropdown').forEach(p => p.classList.remove('show'));
  blockToolbar.querySelectorAll('.block-action-dropdown-btn').forEach(b => b.classList.remove('active'));
}

let _blockToolbarHideTimer = null;

function hideBlockToolbar() {
  if (!blockToolbar) return;
  if (blockToolbar.style.display === 'none') return;
  blockToolbar.classList.remove('visible');
  clearTimeout(_blockToolbarHideTimer);
  _blockToolbarHideTimer = setTimeout(() => {
    if (!blockToolbar.classList.contains('visible')) {
      blockToolbar.style.display = 'none';
    }
  }, 150);
  blockToolbarCurrentRange = null;
  closeAllBlockDropdowns();
}

function updatePriorityKeywordButtonState(range) {
  const btn = document.getElementById('block-priority-btn');
  if (!btn) return;

  // 检查选区是否已经有 priorityKeyword 格式
  const formats = quill.getFormat(range.index, range.length);
  const hasPriority = formats && formats.priorityKeyword;

  btn.classList.remove('active'); // 确保没有黄色高亮
  if (hasPriority) {
    btn.classList.add('inactive');  // 恢复灰色背景提示
    btn.querySelector('span').textContent = '已设为优先关键词';
  } else {
    btn.classList.remove('inactive');
    btn.querySelector('span').textContent = '设为优先关键词';
  }
}

function handleBlockAction(action) {
  if (!blockToolbarCurrentRange) return;
  const range = blockToolbarCurrentRange;

  if (action === 'ask-ai') {
    const text = quill.getText(range.index, range.length);
    // 打开右下角 AI 对话窗
    if (typeof toggleChatPanel === 'function') {
      toggleChatPanel(true);
    }
    // 将选中文本粘贴进输入框，由用户自己写提示词
    const input = document.getElementById('ai-chat-input');
    if (input) {
      input.value = text.trim();
      input.focus();
      // 手动触发自动增高（程序赋值不会触发 input 事件）
      if (typeof adjustChatInput === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(adjustChatInput));
      }
    }
    hideBlockToolbar();
  } else if (action === 'priority-keyword') {
    const formats = quill.getFormat(range.index, range.length);
    const hasPriority = formats && formats.priorityKeyword;

    if (hasPriority) {
      quill.formatText(range.index, range.length, 'priorityKeyword', false);
    } else {
      const text = quill.getText(range.index, range.length);
      if (!text.includes(' ') && text.length < 20) {
        quill.formatText(range.index, range.length, 'priorityKeyword', { keyword: text.trim() });
      } else {
        if (typeof extractKeywords === 'function') {
          const keywords = extractKeywords(text, 8);
          quill.formatText(range.index, range.length, 'priorityKeyword', { extracted: JSON.stringify(keywords.split(' ')) });
        }
      }
    }
    hideBlockToolbar();
    autoSaveProject();
  }
}

// ================== 优先关键词悬浮提示 ==================
let priorityKeywordTooltip = null;
let priorityTooltipTimer = null;

function setupPriorityKeywordTooltip() {
  priorityKeywordTooltip = document.getElementById('priority-keyword-tooltip');
  if (!priorityKeywordTooltip) return;

  // 将 priorityKeywordTooltip 移动到 #workspace 中
  const workspace = document.getElementById('workspace');
  if (workspace && priorityKeywordTooltip.parentElement !== workspace) {
    workspace.appendChild(priorityKeywordTooltip);
  }

  const removeBtn = priorityKeywordTooltip.querySelector('.priority-keyword-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = priorityKeywordTooltip._currentTarget;
      if (target) {
        try {
          const blot = Quill.find(target);
          if (blot && blot.offset) {
            const index = blot.offset(quill.scroll);
            const length = blot.length();
            quill.formatText(index, length, 'priorityKeyword', false);
            autoSaveProject();
          }
        } catch (err) {
          console.warn('移除优先关键词失败:', err);
        }
      }
      hidePriorityKeywordTooltip();
    });
  }

  // 鼠标离开 tooltip 时隐藏
  priorityKeywordTooltip.addEventListener('mouseleave', () => {
    clearTimeout(priorityTooltipTimer);
    priorityTooltipTimer = setTimeout(() => hidePriorityKeywordTooltip(), 600);
  });

  // workspace 滚动时重新计算位置
  if (workspace) {
    workspace.addEventListener('scroll', () => {
      if (priorityKeywordTooltip && priorityKeywordTooltip.style.display !== 'none' && priorityKeywordTooltip._currentTarget) {
        showPriorityKeywordTooltip(priorityKeywordTooltip._currentTarget);
      }
    }, { passive: true });
  }

  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return;

  editorEl.addEventListener('mouseover', (e) => {
    // 大块浮窗显示期间，小块提示完全不出现（互斥）
    const range = quill.getSelection();
    if (blockToolbar && blockToolbar.style.display !== 'none') return;
    if (range && range.length > 0) return;

    const target = e.target.closest('.priority-keyword');
    if (!target) {
      clearTimeout(priorityTooltipTimer);
      priorityTooltipTimer = setTimeout(() => hidePriorityKeywordTooltip(), 600);
      return;
    }

    // 如果已经悬停在当前正在显示 tooltip 的同一个 target 上，先 clearTimeout 防止重复触发，并保持现有显示
    if (priorityKeywordTooltip && priorityKeywordTooltip._currentTarget === target && priorityKeywordTooltip.style.display !== 'none') {
      clearTimeout(priorityTooltipTimer);
      return;
    }

    clearTimeout(priorityTooltipTimer);
    priorityTooltipTimer = setTimeout(() => showPriorityKeywordTooltip(target), 1500);
  });

  editorEl.addEventListener('mouseout', (e) => {
    const related = e.relatedTarget;
    if (priorityKeywordTooltip && priorityKeywordTooltip.contains(related)) return;
    clearTimeout(priorityTooltipTimer);
    priorityTooltipTimer = setTimeout(() => hidePriorityKeywordTooltip(), 600);
  });
}

function showPriorityKeywordTooltip(target) {
  if (!priorityKeywordTooltip) return;
  priorityKeywordTooltip._currentTarget = target;

  const rect = target.getBoundingClientRect();
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  const workspaceRect = workspace.getBoundingClientRect();
  const tooltipWidth = 160;
  let left = rect.left - workspaceRect.left + rect.width / 2 - tooltipWidth / 2;
  let top = rect.bottom - workspaceRect.top + 12;

  if (left < 10) left = 10;
  if (left + tooltipWidth > workspace.clientWidth - 10) left = workspace.clientWidth - tooltipWidth - 10;
  if (top + 40 > workspace.clientHeight - 10) top = rect.top - workspaceRect.top - 40;

  priorityKeywordTooltip.style.left = left + 'px';
  priorityKeywordTooltip.style.top = top + 'px';
  priorityKeywordTooltip.style.display = 'flex';

  // 高亮目标文本
  target.style.backgroundColor = '#fff3c9';
  target.style.transition = 'background 0.2s';
}

function hidePriorityKeywordTooltip() {
  if (priorityKeywordTooltip) {
    const target = priorityKeywordTooltip._currentTarget;
    if (target) {
      target.style.backgroundColor = '';
      target.style.transition = '';
    }
    priorityKeywordTooltip.style.display = 'none';
    priorityKeywordTooltip._currentTarget = null;
  }
}

// ================== 引用编辑器 ==================
let citationEditorModal = null;
let citationEditorDraft = null;
let citationEditorPreviousFocus = null;
let lastCitationEditUndo = null;

function citationTitle(item) {
  return item.paper?.title || item.citationItem?.title ||
    libraryPapers.find(paper => paper.libraryItemId === item.libraryItemId || paper.id === item.paperId)?.title ||
    '未命名文献';
}

function citationEditorRow(item, index, count) {
  const row = document.createElement('div');
  row.className = 'citation-editor-row';
  row.dataset.entryId = item.citationItemEntryId;
  row.innerHTML = `
    <div class="citation-editor-row-head">
      <strong class="citation-editor-paper-title"></strong>
      <div class="citation-editor-row-actions">
        <button type="button" data-citation-action="up" aria-label="上移文献" title="上移">↑</button>
        <button type="button" data-citation-action="down" aria-label="下移文献" title="下移">↓</button>
        <button type="button" data-citation-action="remove" aria-label="移除文献" title="移除">×</button>
      </div>
    </div>
    <div class="citation-editor-fields">
      <label>定位值<input data-field="locator" type="text" maxlength="2048"></label>
      <label>定位类型<select data-field="label">
        <option value="">无</option><option value="page">页</option><option value="chapter">章</option>
        <option value="section">节</option><option value="paragraph">段</option>
        <option value="figure">图</option><option value="table">表</option>
      </select></label>
      <label>前缀<input data-field="prefix" type="text" maxlength="2048"></label>
      <label>后缀<input data-field="suffix" type="text" maxlength="2048"></label>
      <label class="citation-editor-check"><input data-field="suppressAuthor" type="checkbox">省略作者</label>
    </div>`;
  row.querySelector('.citation-editor-paper-title').textContent = citationTitle(item);
  row.querySelector('[data-field="locator"]').value = item.locator || '';
  row.querySelector('[data-field="label"]').value = item.label || '';
  row.querySelector('[data-field="prefix"]').value = item.prefix || '';
  row.querySelector('[data-field="suffix"]').value = item.suffix || '';
  row.querySelector('[data-field="suppressAuthor"]').checked = item.suppressAuthor === true;
  row.querySelector('[data-citation-action="up"]').disabled = index === 0;
  row.querySelector('[data-citation-action="down"]').disabled = index === count - 1;
  row.querySelector('[data-citation-action="remove"]').disabled = count === 1;
  if (item.evidenceRevisionIds?.length) {
    const sources = document.createElement('div');
    sources.className = 'citation-evidence-sources';
    item.evidenceRevisionIds.forEach((revisionId, sourceIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.citationAction = 'source';
      button.dataset.evidenceRevisionId = revisionId;
      button.textContent = `查看来源 ${sourceIndex + 1}`;
      sources.appendChild(button);
    });
    row.appendChild(sources);
  }
  return row;
}

function readCitationEditorRows() {
  const byEntry = new Map(citationEditorDraft.items.map(item => [item.citationItemEntryId, item]));
  const items = [];
  citationEditorModal.querySelectorAll('.citation-editor-row').forEach((row, order) => {
    const original = byEntry.get(row.dataset.entryId);
    const locator = row.querySelector('[data-field="locator"]').value.trim();
    const label = row.querySelector('[data-field="label"]').value;
    if (Boolean(locator) !== Boolean(label)) throw new Error('定位值与定位类型必须同时填写');
    items.push({
      ...original,
      order,
      ...(locator ? { locator, label } : {}),
      prefix: row.querySelector('[data-field="prefix"]').value,
      suffix: row.querySelector('[data-field="suffix"]').value,
      suppressAuthor: row.querySelector('[data-field="suppressAuthor"]').checked
    });
    if (!locator) {
      delete items[items.length - 1].locator;
      delete items[items.length - 1].label;
    }
  });
  citationEditorDraft.items = items;
}

function renderCitationEditor() {
  const body = citationEditorModal.querySelector('.citation-editor-items');
  body.innerHTML = '';
  citationEditorDraft.items.forEach((item, index) => body.appendChild(citationEditorRow(item, index, citationEditorDraft.items.length)));
  const picker = citationEditorModal.querySelector('#citation-editor-add-paper');
  picker.innerHTML = '<option value="">添加文献...</option>';
  const used = new Set(citationEditorDraft.items.map(item => item.libraryItemId || item.paperId));
  libraryPapers.filter(paper => !used.has(paper.libraryItemId || paper.id)).forEach(paper => {
    const option = document.createElement('option');
    option.value = paper.libraryItemId || paper.id;
    option.textContent = paper.title || '未命名文献';
    picker.appendChild(option);
  });
  citationEditorModal.querySelector('[data-citation-action="undo"]').disabled =
    !lastCitationEditUndo || lastCitationEditUndo.citationInstanceId !== citationEditorDraft.citationInstanceId;
}

function closeCitationEditor() {
  if (!citationEditorModal) return;
  citationEditorModal.hidden = true;
  citationEditorDraft = null;
  citationEditorPreviousFocus?.focus?.();
  citationEditorPreviousFocus = null;
}

function openCitationEditor(citationInstanceId, trigger) {
  const cluster = citations.find(value => (value.citationInstanceId || value.id) === citationInstanceId);
  if (!cluster) return;
  citationEditorDraft = JSON.parse(JSON.stringify(cluster));
  citationEditorDraft.citationInstanceId = citationInstanceId;
  citationEditorPreviousFocus = trigger || document.activeElement;
  renderCitationEditor();
  citationEditorModal.hidden = false;
  requestAnimationFrame(() => citationEditorModal.querySelector('[data-citation-action="close"]')?.focus());
}

async function persistCitationEditorCluster(nextCluster, previousCluster) {
  const index = citations.findIndex(value => (value.citationInstanceId || value.id) === nextCluster.citationInstanceId);
  if (index < 0) return;
  citations[index] = JSON.parse(JSON.stringify(nextCluster));
  lastCitationEditUndo = previousCluster ? {
    citationInstanceId: nextCluster.citationInstanceId,
    cluster: JSON.parse(JSON.stringify(previousCluster))
  } : null;
  saveCitations();
  const saved = await autoSaveProject();
  if (!saved?.success) throw new Error('引用修改未保存');
  await renderReferencesFromMain();
}

function setupCitationEditor() {
  citationEditorModal = document.createElement('div');
  citationEditorModal.className = 'citation-editor-overlay';
  citationEditorModal.hidden = true;
  citationEditorModal.innerHTML = `
    <section class="citation-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="citation-editor-title">
      <header><h2 id="citation-editor-title">编辑引用</h2><button type="button" data-citation-action="close" aria-label="关闭引用编辑器" title="关闭">×</button></header>
      <div class="citation-editor-items"></div>
      <div class="citation-editor-add"><label for="citation-editor-add-paper">添加文献</label><select id="citation-editor-add-paper"></select></div>
      <footer>
        <button type="button" data-citation-action="undo">撤销上次编辑</button>
        <span class="citation-editor-spacer"></span>
        <button type="button" data-citation-action="cancel">取消</button>
        <button type="button" class="primary" data-citation-action="save">保存</button>
      </footer>
    </section>`;
  document.body.appendChild(citationEditorModal);

  citationEditorModal.addEventListener('click', async event => {
    const action = event.target.closest('[data-citation-action]')?.dataset.citationAction;
    if (!action || !citationEditorDraft) return;
    if (action === 'close' || action === 'cancel') {
      closeCitationEditor();
      return;
    }
    try {
      if (action === 'source') {
        const revisionId = event.target.dataset.evidenceRevisionId;
        const snapshot = await window.electronAPI.listEvidence(currentProjectId);
        const item = snapshot.items.find(value => value.revision.id === revisionId);
        if (!item) throw new Error('来源证据已不存在');
        closeCitationEditor();
        await window.openEssayflowEvidenceSource?.(item);
      } else if (['up', 'down', 'remove'].includes(action)) {
        readCitationEditorRows();
        const entryId = event.target.closest('.citation-editor-row').dataset.entryId;
        const index = citationEditorDraft.items.findIndex(item => item.citationItemEntryId === entryId);
        if (action === 'remove' && citationEditorDraft.items.length > 1) citationEditorDraft.items.splice(index, 1);
        if (action === 'up' && index > 0) [citationEditorDraft.items[index - 1], citationEditorDraft.items[index]] = [citationEditorDraft.items[index], citationEditorDraft.items[index - 1]];
        if (action === 'down' && index < citationEditorDraft.items.length - 1) [citationEditorDraft.items[index + 1], citationEditorDraft.items[index]] = [citationEditorDraft.items[index], citationEditorDraft.items[index + 1]];
        citationEditorDraft.items.forEach((item, order) => { item.order = order; });
        renderCitationEditor();
      } else if (action === 'save') {
        readCitationEditorRows();
        const previous = citations.find(value => (value.citationInstanceId || value.id) === citationEditorDraft.citationInstanceId);
        const next = JSON.parse(JSON.stringify(citationEditorDraft));
        closeCitationEditor();
        await persistCitationEditorCluster(next, previous);
      } else if (action === 'undo' && lastCitationEditUndo) {
        const previous = JSON.parse(JSON.stringify(lastCitationEditUndo.cluster));
        closeCitationEditor();
        await persistCitationEditorCluster(previous, null);
      }
    } catch (error) {
      window.showToast?.(error.message || '引用编辑失败');
    }
  });

  citationEditorModal.querySelector('#citation-editor-add-paper').addEventListener('change', event => {
    if (!event.target.value || !citationEditorDraft) return;
    try { readCitationEditorRows(); } catch (error) { window.showToast?.(error.message); return; }
    const paper = libraryPapers.find(value => (value.libraryItemId || value.id) === event.target.value);
    if (!paper) return;
    citationEditorDraft.items.push({
      citationItemEntryId: newCitationUuid(),
      citationItemId: newCitationUuid(),
      ...(paper.libraryItemId ? { libraryItemId: paper.libraryItemId } : {}),
      paperId: paper.id,
      paper: JSON.parse(JSON.stringify(paper)),
      suppressAuthor: false,
      order: citationEditorDraft.items.length
    });
    renderCitationEditor();
  });

  quill.root.addEventListener('click', event => {
    const anchor = event.target.closest('sup[data-citation-instance-id]');
    if (anchor) openCitationEditor(anchor.getAttribute('data-citation-instance-id'), anchor);
  });
  quill.root.addEventListener('keydown', event => {
    const anchor = event.target.closest('sup[data-citation-instance-id]');
    if (anchor && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openCitationEditor(anchor.getAttribute('data-citation-instance-id'), anchor);
    }
  });
  citationEditorModal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCitationEditor();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(citationEditorModal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

// ================== 引用导航（双向跳转 + 滚动条标记） ==================
function setupCitationNavigation() {
  const editorEl = quill.root;
  if (!editorEl) return;

  // 双击文内引用 → 跳转到其首篇参考文献。
  editorEl.addEventListener('dblclick', (e) => {
    const sup = e.target.closest('sup[data-citation-instance-id]');
    if (!sup) return;
    const cluster = citations.find(value => (value.citationInstanceId || value.id) === sup.getAttribute('data-citation-instance-id'));
    const citationItemId = cluster?.items?.[0]?.citationItemId;
    if (!citationItemId) return;
    const refP = Array.from(editorEl.querySelectorAll('p[data-ref-section][data-citation-item-id]'))
      .find(value => value.getAttribute('data-citation-item-id') === citationItemId);
    if (refP) {
      refP.scrollIntoView({ behavior: 'smooth', block: 'center' });
      refP.style.transition = 'background 0.3s';
      refP.style.backgroundColor = '#fff3c9';
      setTimeout(() => { refP.style.backgroundColor = ''; }, 1500);
    }
  });

  // 双击参考文献段落 → 跳转到引用该稳定文献快照的首个实例。
  editorEl.addEventListener('dblclick', (e) => {
    const refP = e.target.closest('p[data-ref-section][data-citation-item-id]');
    if (!refP) return;
    const citationItemId = refP.getAttribute('data-citation-item-id');
    const instanceIds = new Set(citations
      .filter(value => value.items?.some(item => item.citationItemId === citationItemId))
      .map(value => value.citationInstanceId || value.id));
    const firstSup = Array.from(editorEl.querySelectorAll('sup[data-citation-instance-id]'))
      .find(value => instanceIds.has(value.getAttribute('data-citation-instance-id')));
    if (firstSup) {
      firstSup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstSup.style.transition = 'background 0.3s';
      firstSup.style.backgroundColor = '#fff3c9';
      setTimeout(() => { firstSup.style.backgroundColor = ''; }, 1500);
    }
    // 高亮该文献在滚动条上的标记
    highlightCitationMarkers(citationItemId);
  });
}

// 高亮指定引用编号的滚动条标记（点击参考文献时触发）
function highlightCitationMarkers(citationItemId) {
  const container = document.getElementById('citation-scroll-markers');
  const workspace = document.getElementById('workspace');
  if (!container || !workspace) return;

  container.innerHTML = '';

  const totalScrollHeight = workspace.scrollHeight;
  const editorEl = quill.root;
  const instanceIds = new Set(citations
    .filter(value => value.items?.some(item => item.citationItemId === citationItemId))
    .map(value => value.citationInstanceId || value.id));
  const sups = Array.from(editorEl.querySelectorAll('sup[data-citation-instance-id]'))
    .filter(value => instanceIds.has(value.getAttribute('data-citation-instance-id')));

  sups.forEach(sup => {
    let offsetTop = 0;
    let node = sup;
    while (node && node !== workspace) {
      offsetTop += node.offsetTop;
      node = node.offsetParent;
    }

    if (totalScrollHeight > 0) {
      const percent = (offsetTop / totalScrollHeight) * 100;
      const marker = document.createElement('div');
      marker.className = 'citation-marker';
      marker.style.top = `${percent}%`;
      container.appendChild(marker);
    }
  });
}

// 全局点击监听：点击非参考文献区域时清除滚动条标记
function setupCitationMarkerClear() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  workspace.addEventListener('click', (e) => {
    const refP = e.target.closest('p[data-ref-section][data-citation-item-id]');
    if (!refP) {
      const container = document.getElementById('citation-scroll-markers');
      if (container) container.innerHTML = '';
    }
  });
}

// ================== 更多功能下拉菜单 ==================
function injectMoreDropdown() {
  const toolbar = document.querySelector('.ql-toolbar.ql-snow');
  if (!toolbar || document.getElementById('btn-more-dropdown')) return;

  const btn = document.createElement('button');
  btn.id = 'btn-more-dropdown';
  btn.type = 'button';
  btn.className = 'ql-more';
  btn.setAttribute('data-tooltip', '更多功能');
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
    </svg>
  `;

  const dropdown = document.createElement('div');
  dropdown.id = 'more-dropdown-menu';
  dropdown.className = 'more-dropdown';
  dropdown.innerHTML = `
    <button class="more-dropdown-item" data-action="insert-table">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
      <span>插入表格</span>
    </button>
    <button class="more-dropdown-item" data-action="insert-image">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <span>插入图片</span>
    </button>
    <button class="more-dropdown-item" data-action="find-replace">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      <span>搜索替换</span>
    </button>
    <label class="more-dropdown-select" for="active-citation-style">
      <span>引用格式</span>
      <select id="active-citation-style" aria-label="当前项目引用格式">
        <option value="APA">APA 7th</option>
        <option value="MLA">MLA 9th</option>
        <option value="Chicago">Chicago 17th</option>
        <option value="IEEE">IEEE</option>
        <option value="Harvard">Harvard 12th</option>
        <option value="GB/T">GB/T 7714-2015</option>
      </select>
    </label>
  `;
  document.body.appendChild(dropdown);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.classList.toggle('open');

    // 互斥：打开更多功能时关闭文章导图和搜索替换面板
    if (dropdown.classList.contains('open')) {
      mindmapVisible = false;
      const mindmapPanel = document.getElementById('mindmap-panel');
      if (mindmapPanel) mindmapPanel.classList.remove('visible');
      if (typeof hideFindReplacePanel === 'function') hideFindReplacePanel();
    }
  });

  dropdown.querySelectorAll('.more-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      const action = item.dataset.action;
      if (action === 'insert-table') showTableDialog();
      else if (action === 'insert-image') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) {
            window.showToast('仅支持 PNG、JPEG、GIF 或 WebP 图片');
            return;
          }
          if (file.size > 20 * 1024 * 1024) {
            window.showToast('图片不能超过 20 MB');
            return;
          }
          if (!window.electronAPI?.saveImage) {
            window.showToast('桌面应用才支持插入本地图片');
            return;
          }
          const range = quill.getSelection(true);
          const index = range ? range.index : quill.getLength();

          // 将图片保存到本地磁盘，使用 file:// URL 避免 blob URL 内存泄漏和 webSecurity 限制
          const reader = new FileReader();
          reader.onload = async (e) => {
            const dataUrl = e.target.result;
            const base64Data = dataUrl.split(',')[1];
            const ext = file.name.split('.').pop().toLowerCase() || 'png';
            const safeName = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
            try {
              const savedImage = await window.electronAPI.saveImage(base64Data, safeName);
              const filePath = typeof savedImage === 'string' ? savedImage : savedImage?.path;
              if (!filePath) throw new Error('图片保存路径无效');
              const normalizedPath = filePath.replace(/\\/g, '/');
              const fileUrl = encodeURI(normalizedPath.startsWith('/')
                ? `file://${normalizedPath}`
                : `file:///${normalizedPath}`);
              quill.insertEmbed(index, 'image', fileUrl, Quill.sources.USER);
              quill.setSelection(index + 1, 0, Quill.sources.SILENT);
              autoSaveProject();
            } catch (err) {
              console.error('[insertImage] 保存图片失败:', err);
              window.showToast('图片保存失败，请重试');
            }
          };
          reader.onerror = () => {
            console.error('[insertImage] FileReader 读取失败');
            window.showToast('图片读取失败');
          };
          reader.readAsDataURL(file);
        });
        input.click();
      }
      else if (action === 'find-replace') showFindReplacePanel();
    });
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== btn) {
      dropdown.classList.remove('open');
    }
  });

  const citationStyleSelect = dropdown.querySelector('#active-citation-style');
  updateActiveCitationStyleControl();
  citationStyleSelect?.addEventListener('change', async event => {
    event.stopPropagation();
    currentProjectMeta = { ...(currentProjectMeta || {}), referenceStyle: event.target.value };
    saveProjectMeta();
    dropdown.classList.remove('open');
    const saved = await autoSaveProject();
    if (saved?.success) await renderReferencesFromMain();
  });
  window.enhanceEssayflowSelect?.(citationStyleSelect);

  const wrapper = document.createElement('span');
  wrapper.className = 'ql-formats';
  wrapper.appendChild(btn);
  toolbar.appendChild(wrapper);
}

// ================== 表格插入对话框 ==================
function setupTableDialog() {
  const dialog = document.getElementById('table-insert-dialog');
  const cancelBtn = document.getElementById('table-insert-cancel');
  const confirmBtn = document.getElementById('table-insert-confirm');
  if (!dialog || !cancelBtn || !confirmBtn) return;

  cancelBtn.addEventListener('click', hideTableDialog);
  confirmBtn.addEventListener('click', insertTableFromDialog);

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) hideTableDialog();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.classList.contains('open')) {
      hideTableDialog();
    }
  });

  const rowsInput = document.getElementById('table-rows');
  const colsInput = document.getElementById('table-cols');
  if (rowsInput) {
    rowsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') insertTableFromDialog(); });
  }
  if (colsInput) {
    colsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') insertTableFromDialog(); });
  }

  const cellEditDialog = document.getElementById('table-cell-edit-dialog');
  const cellEditCancel = document.getElementById('table-cell-edit-cancel');
  const cellEditSave = document.getElementById('table-cell-edit-save');
  const cellEditInput = document.getElementById('table-cell-edit-input');
  cellEditCancel?.addEventListener('click', hideTableCellEditor);
  cellEditSave?.addEventListener('click', saveTableCellEdit);
  cellEditDialog?.addEventListener('click', e => {
    if (e.target === cellEditDialog) hideTableCellEditor();
  });

  cellEditInput?.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveTableCellEdit();
    }
  });
}

function updateActiveCitationStyleControl() {
  const select = document.getElementById('active-citation-style');
  if (!select) return;
  const fallback = (typeof getDefaultReferenceStyle === 'function' && getDefaultReferenceStyle()) || 'MLA';
  select.value = currentProjectMeta?.referenceStyle || fallback;
  window.syncEssayflowSelect?.(select);
}

function showTableDialog() {
  const dialog = document.getElementById('table-insert-dialog');
  if (!dialog) return;
  dialog.classList.add('open');
  dialog.style.display = 'flex';
  dialog.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('table-rows')?.focus(), 100);
}

function hideTableDialog() {
  const dialog = document.getElementById('table-insert-dialog');
  if (!dialog) return;
  dialog.classList.remove('open');
  dialog.style.display = 'none';
  dialog.setAttribute('aria-hidden', 'true');
}

function insertTableFromDialog() {
  const rowsInput = document.getElementById('table-rows');
  const colsInput = document.getElementById('table-cols');
  const rows = parseInt(rowsInput?.value, 10) || 3;
  const cols = parseInt(colsInput?.value, 10) || 3;
  if (rows < 1 || rows > 50 || cols < 1 || cols > 50) {
    window.showToast('行数和列数应在 1-50 之间');
    return;
  }

  const workspace = document.getElementById('workspace');

  const range = quill.getSelection(true);
  const insertIndex = range ? range.index : quill.getLength();

  try {
    // 使用 Quill 注册的 TableBlot (BlockEmbed) 插入表格
    // 把 insertEmbed + insertText 合并为单次 updateContents，避免中间状态触发 Quill 自动滚动
    let tableHtml = '<table style="width:100%;border-collapse:collapse;margin:8px 0;"><tbody>';
    for (let r = 0; r < rows; r++) {
      tableHtml += '<tr>';
      for (let c = 0; c < cols; c++) {
        tableHtml += '<td style="border:1px solid #ccc;padding:8px;min-height:24px;"><br></td>';
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table>';

    const savedScrollTop = workspace?.scrollTop || 0;
    const Delta = Quill.import('delta');
    const tableDelta = new Delta()
      .retain(insertIndex)
      .insert({ table: tableHtml })
      .insert('\n');
    quill.updateContents(tableDelta, Quill.sources.USER);
    // updateContents 内部可能触发自动滚动，如果被带到顶部则恢复
    if (workspace && workspace.scrollTop !== savedScrollTop) {
      workspace.scrollTop = savedScrollTop;
    }
    quill.setSelection(insertIndex + 2, 0);
  } catch (e) {
    console.error('[insertTableFromDialog] 插入表格失败:', e);
    window.showToast('表格插入失败，请重试');
  } finally {
    hideTableDialog();
    autoSaveProject();
  }
}

let currentEditingTableCell = null;

function showTableCellEditor(cell) {
  const dialog = document.getElementById('table-cell-edit-dialog');
  const input = document.getElementById('table-cell-edit-input');
  if (!dialog || !input || !cell) return;
  currentEditingTableCell = cell;
  input.value = cell.innerText.replace(/\u00a0/g, ' ').trim();
  dialog.style.display = 'flex';
  dialog.classList.add('open');
  dialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => input.focus());
}

function hideTableCellEditor() {
  const dialog = document.getElementById('table-cell-edit-dialog');
  if (dialog) {
    dialog.classList.remove('open');
    dialog.style.display = 'none';
    dialog.setAttribute('aria-hidden', 'true');
  }
  currentEditingTableCell = null;
}

function saveTableCellEdit() {
  const input = document.getElementById('table-cell-edit-input');
  if (!currentEditingTableCell || !input) return;
  const value = input.value.replace(/\r\n?/g, '\n').slice(0, 5000);
  if (value) {
    currentEditingTableCell.textContent = value;
    currentEditingTableCell.style.whiteSpace = 'pre-wrap';
  } else {
    currentEditingTableCell.innerHTML = '<br>';
  }
  quill.update(Quill.sources.USER);
  hideTableCellEditor();
  autoSaveProject();
}

// ================== 表格右键菜单 ==================
let tableContextMenuEl = null;
let currentTableCell = null;

function setupTableContextMenu() {
  tableContextMenuEl = document.getElementById('table-context-menu');
  if (!tableContextMenuEl) return;

  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return;

  editorEl.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('td, th');
    if (!cell) {
      hideTableContextMenu();
      return;
    }
    e.preventDefault();
    currentTableCell = cell;
    showTableContextMenu(e.clientX, e.clientY);
  });
  editorEl.addEventListener('dblclick', e => {
    const cell = e.target.closest('td, th');
    if (!cell) return;
    e.preventDefault();
    showTableCellEditor(cell);
  });

  tableContextMenuEl.querySelectorAll('.table-ctx-item').forEach(item => {
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      handleTableContextAction(action);
      hideTableContextMenu();
    });
  });

  document.addEventListener('click', (e) => {
    if (tableContextMenuEl && !tableContextMenuEl.contains(e.target)) {
      hideTableContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideTableContextMenu();
      hideTableCellEditor();
    }
  });
}

function showTableContextMenu(x, y) {
  if (!tableContextMenuEl) return;
  tableContextMenuEl.style.display = 'flex';
  tableContextMenuEl.classList.add('open');
  tableContextMenuEl.setAttribute('aria-hidden', 'false');
  const rect = tableContextMenuEl.getBoundingClientRect();
  tableContextMenuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  tableContextMenuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

function hideTableContextMenu() {
  if (!tableContextMenuEl) return;
  tableContextMenuEl.style.display = 'none';
  tableContextMenuEl.classList.remove('open');
  tableContextMenuEl.setAttribute('aria-hidden', 'true');
  currentTableCell = null;
}

function handleTableContextAction(action) {
  if (!currentTableCell) return;
  const cell = currentTableCell;
  const row = cell.closest('tr');
  const table = cell.closest('table');
  const tbody = table?.querySelector('tbody') || table;
  if (!row || !table || !tbody) return;

  const rowIndex = Array.from(tbody.rows).indexOf(row);
  const cellIndex = Array.from(row.cells).indexOf(cell);

  switch (action) {
    case 'edit-cell': {
      showTableCellEditor(cell);
      return;
    }
    case 'insert-row-above': {
      const newRow = document.createElement('tr');
      const colCount = row.cells.length;
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.style.cssText = 'border:1px solid #ccc;padding:8px;';
        td.textContent = ' ';
        newRow.appendChild(td);
      }
      tbody.insertBefore(newRow, row);
      break;
    }
    case 'insert-row-below': {
      const newRow = document.createElement('tr');
      const colCount = row.cells.length;
      for (let i = 0; i < colCount; i++) {
        const td = document.createElement('td');
        td.style.cssText = 'border:1px solid #ccc;padding:8px;';
        td.textContent = ' ';
        newRow.appendChild(td);
      }
      row.after(newRow);
      break;
    }
    case 'delete-row': {
      if (tbody.rows.length <= 1) {
        if (confirm('删除最后一行将删除整个表格，是否继续？')) {
          table.remove();
        }
      } else {
        row.remove();
      }
      break;
    }
    case 'insert-col-left': {
      Array.from(tbody.rows).forEach(tr => {
        const td = document.createElement('td');
        td.style.cssText = 'border:1px solid #ccc;padding:8px;';
        td.textContent = ' ';
        tr.insertBefore(td, tr.cells[cellIndex]);
      });
      break;
    }
    case 'insert-col-right': {
      Array.from(tbody.rows).forEach(tr => {
        const td = document.createElement('td');
        td.style.cssText = 'border:1px solid #ccc;padding:8px;';
        td.textContent = ' ';
        tr.cells[cellIndex].after(td);
      });
      break;
    }
    case 'delete-col': {
      const colCount = row.cells.length;
      if (colCount <= 1) {
        if (confirm('删除最后一列将删除整个表格，是否继续？')) {
          table.remove();
        }
      } else {
        Array.from(tbody.rows).forEach(tr => {
          if (tr.cells[cellIndex]) tr.cells[cellIndex].remove();
        });
      }
      break;
    }
    case 'delete-table': {
      if (confirm('确定要删除整个表格吗？')) {
        table.remove();
      }
      break;
    }
  }

  quill.update();
  autoSaveProject();
}

// ================== 搜索替换面板（VS Code 式） ==================
let findReplacePanel = null;
let findMatches = [];
let currentMatchIdx = -1;
let activeFindMatchIdx = -1;
let findReplaceFormats = {};
let findInputTimer = null;
const MAX_FIND_MATCHES = 5000;

function setupFindReplacePanel() {
  findReplacePanel = document.getElementById('find-replace-panel');
  if (!findReplacePanel) return;

  const findInput = document.getElementById('find-input');
  const replaceInput = document.getElementById('replace-input');
  const selectBtn = document.getElementById('fr-select');
  const replaceAllBtn = document.getElementById('fr-replace-all');
  const closeBtn = document.getElementById('fr-close');
  const toggleAdvancedBtn = document.getElementById('fr-toggle-advanced');
  const advancedPanel = findReplacePanel.querySelector('.find-replace-advanced');
  const regexCheck = document.getElementById('fr-regex');
  const caseCheck = document.getElementById('fr-case-sensitive');
  const formatCheck = document.getElementById('fr-format-replace');
  const formatBar = document.getElementById('fr-format-bar');

  if (findInput) {
    findInput.addEventListener('input', () => {
      clearTimeout(findInputTimer);
      findInputTimer = setTimeout(performFind, 120);
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(findInputTimer);
        performFind();
        findNextMatch(e.shiftKey ? -1 : 1);
      }
    });
  }

  if (replaceInput) {
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceCurrentMatch();
      }
    });
  }

  if (replaceAllBtn) replaceAllBtn.addEventListener('click', replaceAllMatches);
  if (closeBtn) closeBtn.addEventListener('click', hideFindReplacePanel);

  // 匹配列表中的替换按钮
  const matchReplaceBtn = document.getElementById('fr-match-replace-btn');
  if (matchReplaceBtn) {
    matchReplaceBtn.addEventListener('click', () => {
      if (currentMatchIdx >= 0 && currentMatchIdx < findMatches.length) {
        replaceCurrentMatch();
      }
    });
  }

  // 选择按钮：展开/收起匹配列表
  const matchList = document.getElementById('fr-match-list');
  if (selectBtn && matchList) {
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      matchList.classList.toggle('open');
      if (matchList.classList.contains('open')) {
        renderMatchList();
      }
    });
  }
  // 点击空白处关闭匹配列表（面板内元素不关闭）
  document.addEventListener('click', (e) => {
    if (matchList && matchList.classList.contains('open') &&
        !matchList.contains(e.target) &&
        !e.target.closest('#fr-select') &&
        !e.target.closest('#find-replace-panel')) {
      matchList.classList.remove('open');
    }
  });

  if (toggleAdvancedBtn && advancedPanel) {
    toggleAdvancedBtn.addEventListener('click', () => {
      const isOpen = advancedPanel.style.display !== 'none';
      advancedPanel.style.display = isOpen ? 'none' : 'block';
    });
  }

  if (formatCheck && formatBar) {
    formatCheck.addEventListener('change', () => {
      formatBar.style.display = formatCheck.checked ? 'flex' : 'none';
    });
  }

  // 格式按钮
  findReplacePanel.querySelectorAll('.fr-format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.dataset.format;
      btn.classList.toggle('active');
      if (btn.classList.contains('active')) {
        findReplaceFormats[format] = true;
      } else {
        delete findReplaceFormats[format];
      }
    });
  });

  const colorInput = document.getElementById('fr-format-color');
  if (colorInput) {
    colorInput.addEventListener('input', () => {
      findReplaceFormats.color = colorInput.value;
    });
  }

}

// 点击空白处关闭搜索替换面板
document.addEventListener('click', (e) => {
  if (!findReplacePanel) return;
  if (findReplacePanel.classList.contains('visible') &&
      !e.target.closest('#find-replace-panel') &&
      !e.target.closest('#btn-more-dropdown') &&
      !e.target.closest('#more-dropdown-menu') &&
      !e.target.closest('#btn-mindmap-inline') &&
      !e.target.closest('#mindmap-panel')) {
    hideFindReplacePanel();
  }
});

function updateFindReplacePosition() {
  const workspace = document.getElementById('workspace');
  const panel = document.getElementById('find-replace-panel');
  if (!workspace || !panel) return;
  const rect = workspace.getBoundingClientRect();
  const padding = 60; // workspace padding-left/right
  panel.style.left = (rect.left + padding) + 'px';
  panel.style.width = (rect.width - padding * 2) + 'px';
}

function showFindReplacePanel() {
  if (!findReplacePanel) return;

  // 互斥：关闭其他两个浮窗
  const mindmapPanel = document.getElementById('mindmap-panel');
  if (mindmapPanel) {
    mindmapPanel.classList.remove('visible');
    mindmapVisible = false;
    const mindmapBtn = document.getElementById('btn-mindmap-inline');
    if (mindmapBtn) mindmapBtn.classList.remove('active');
  }
  const moreDropdown = document.getElementById('more-dropdown-menu');
  if (moreDropdown) moreDropdown.classList.remove('open');

  updateFindReplacePosition();
  findReplacePanel.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    findReplacePanel.classList.add('visible');
    // 给编辑器留出空间，避免遮挡
    const editorContainer = document.getElementById('editor-container');
    if (editorContainer) {
      const panelHeight = findReplacePanel.offsetHeight;
      editorContainer.style.marginTop = (52 + panelHeight + 8) + 'px';
    }
  }));

  const findInput = document.getElementById('find-input');
  if (findInput) {
    // 如果有选区，自动填入查找框
    const sel = quill.getSelection();
    if (sel && sel.length > 0) {
      findInput.value = quill.getText(sel.index, sel.length);
    }
    setTimeout(() => {
      findInput.focus();
      performFind();
    }, 50);
  }
}

function hideFindReplacePanel() {
  if (!findReplacePanel) return;
  clearFindHighlights();
  findReplacePanel.classList.remove('visible');
  // 关闭匹配列表
  const matchList = document.getElementById('fr-match-list');
  if (matchList) matchList.classList.remove('open');
  // 先隐藏 AI 提示，避免 margin-top 恢复过程中错位
  if (typeof hideAIHint === 'function') hideAIHint();
  // 恢复编辑器 margin
  const editorContainer = document.getElementById('editor-container');
  if (editorContainer) editorContainer.style.marginTop = '';
  setTimeout(() => {
    if (!findReplacePanel.classList.contains('visible')) {
      findReplacePanel.style.display = 'none';
    }
    // margin-top 恢复后，重新定位 AI 提示
    if (typeof updateAIHintPosition === 'function') {
      updateAIHintPosition();
    }
    // 如果当前光标仍在空白行，重新显示 AI hint
    if (typeof showAIHint === 'function' && typeof quill !== 'undefined') {
      const range = quill.getSelection();
      if (range && range.length === 0) {
        const [line] = quill.getLine(range.index);
        if (line && line.domNode) {
          const text = line.domNode.textContent || '';
          const html = line.domNode.innerHTML || '';
          if (text.trim().length === 0 || html.includes('<br>') || text.length < 2) {
            showAIHint(line, range);
          }
        }
      }
    }
  }, 200);
}

function performFind() {
  clearFindHighlights();
  const findInput = document.getElementById('find-input');
  const text = findInput?.value || '';
  if (!text) {
    updateMatchCount(0, 0);
    return;
  }

  const regexCheck = document.getElementById('fr-regex');
  const caseCheck = document.getElementById('fr-case-sensitive');
  const isRegex = regexCheck?.checked || false;
  const isCaseSensitive = caseCheck?.checked || false;

  const editorText = quill.getText();
  findMatches = [];

  try {
    if (isRegex) {
      const flags = isCaseSensitive ? 'g' : 'gi';
      const regex = new RegExp(text, flags);
      let match;
      while ((match = regex.exec(editorText)) !== null) {
        findMatches.push({ index: match.index, length: match[0].length });
        if (findMatches.length >= MAX_FIND_MATCHES) break;
        if (match.index === regex.lastIndex) regex.lastIndex++;
      }
    } else {
      let searchText = text;
      let sourceText = editorText;
      if (!isCaseSensitive) {
        searchText = text.toLowerCase();
        sourceText = editorText.toLowerCase();
      }
      let idx = 0;
      while ((idx = sourceText.indexOf(searchText, idx)) !== -1) {
        findMatches.push({ index: idx, length: text.length });
        if (findMatches.length >= MAX_FIND_MATCHES) break;
        idx += text.length;
      }
    }
  } catch (e) {
    window.showToast('正则表达式无效');
    updateMatchCount(0, 0);
    return;
  }

  // 使用临时自定义格式，不触碰用户原本的 background 格式。
  findMatches.forEach(m => {
    quill.formatText(m.index, m.length, 'findHighlight', 'match', Quill.sources.SILENT);
  });

  currentMatchIdx = findMatches.length > 0 ? 0 : -1;
  activeFindMatchIdx = -1;
  updateMatchCount(currentMatchIdx + 1, findMatches.length);
  updateActiveMatch();
  if (findMatches.length >= MAX_FIND_MATCHES) {
    window.showToast(`匹配过多，仅显示前 ${MAX_FIND_MATCHES} 处`);
  }
  // 如果匹配列表是打开状态，刷新列表
  const matchList = document.getElementById('fr-match-list');
  if (matchList && matchList.classList.contains('open')) {
    renderMatchList();
  }
}

function updateMatchCount(current, total) {
  const countEl = document.getElementById('find-match-count');
  if (!countEl) return;
  if (total === 0) {
    countEl.textContent = '';
  } else {
    countEl.textContent = current + '/' + total;
  }
}

function updateActiveMatch() {
  if (currentMatchIdx < 0 || currentMatchIdx >= findMatches.length) return;
  const match = findMatches[currentMatchIdx];
  // 滚动到当前匹配并设置选区
  quill.setSelection(match.index, match.length, 'silent');
  const workspace = document.getElementById('workspace');
  const editorContainer = document.getElementById('editor-container');
  if (workspace && editorContainer) {
    const bounds = quill.getBounds(match.index, match.length);
    if (bounds) {
      // editorContainer.offsetTop 已包含 margin-top，加上 bounds.top 即为相对于 workspace 的位置
      workspace.scrollTo({ top: editorContainer.offsetTop + bounds.top - 100, behavior: 'smooth' });
    }
  }
  if (activeFindMatchIdx >= 0 && activeFindMatchIdx < findMatches.length && activeFindMatchIdx !== currentMatchIdx) {
    const previous = findMatches[activeFindMatchIdx];
    quill.formatText(previous.index, previous.length, 'findHighlight', 'match', Quill.sources.SILENT);
  }
  quill.formatText(match.index, match.length, 'findHighlight', 'current', Quill.sources.SILENT);
  activeFindMatchIdx = currentMatchIdx;
}

function findNextMatch(dir) {
  if (findMatches.length === 0) return;
  currentMatchIdx += dir;
  if (currentMatchIdx >= findMatches.length) currentMatchIdx = 0;
  if (currentMatchIdx < 0) currentMatchIdx = findMatches.length - 1;
  updateMatchCount(currentMatchIdx + 1, findMatches.length);
  updateActiveMatch();
}

function replaceCurrentMatch() {
  if (currentMatchIdx < 0 || currentMatchIdx >= findMatches.length) return;
  const match = { ...findMatches[currentMatchIdx] };
  const replaceInput = document.getElementById('replace-input');
  const replaceText = replaceInput ? replaceInput.value : '';

  clearFindHighlights();
  const Delta = Quill.import('delta');
  quill.updateContents(
    new Delta().retain(match.index).delete(match.length).insert(replaceText),
    Quill.sources.USER
  );

  if (Object.keys(findReplaceFormats).length > 0) {
    quill.formatText(match.index, replaceText.length, { ...findReplaceFormats }, Quill.sources.USER);
  }

  // 重新搜索
  performFind();
  // 跳到下一个（或保持在当前位置）
  if (currentMatchIdx >= findMatches.length) {
    currentMatchIdx = findMatches.length > 0 ? 0 : -1;
  }
  updateMatchCount(currentMatchIdx + 1, findMatches.length);
  updateActiveMatch();
  autoSaveProject();
}

function replaceAllMatches() {
  if (findMatches.length === 0) return;
  const matches = findMatches.map(match => ({ ...match }));
  const totalCount = matches.length;
  const replaceInput = document.getElementById('replace-input');
  const replaceText = replaceInput ? replaceInput.value : '';

  clearFindHighlights();
  const Delta = Quill.import('delta');
  const delta = new Delta();
  const replacementRanges = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  matches.forEach(match => {
    const unchangedLength = match.index - sourceCursor;
    if (unchangedLength > 0) delta.retain(unchangedLength);
    delta.delete(match.length).insert(replaceText);
    outputCursor += unchangedLength;
    replacementRanges.push({ index: outputCursor, length: replaceText.length });
    outputCursor += replaceText.length;
    sourceCursor = match.index + match.length;
  });
  quill.updateContents(delta, Quill.sources.USER);

  if (Object.keys(findReplaceFormats).length > 0 && replaceText.length > 0) {
    replacementRanges.forEach(range => {
      quill.formatText(range.index, range.length, { ...findReplaceFormats }, Quill.sources.SILENT);
    });
  }

  currentMatchIdx = -1;
  updateMatchCount(0, 0);
  // 关闭匹配列表
  const matchList = document.getElementById('fr-match-list');
  if (matchList) matchList.classList.remove('open');
  window.showToast('已替换全部 ' + totalCount + ' 处');
  autoSaveProject();
}

function renderMatchList() {
  const list = document.getElementById('fr-match-list');
  if (!list) return;
  const scrollEl = list.querySelector('.fr-match-list-scroll');
  if (!scrollEl) return;
  scrollEl.innerHTML = '';
  if (findMatches.length === 0) {
    list.classList.remove('open');
    return;
  }
  const text = quill.getText();
  findMatches.forEach((m, i) => {
    const before = text.substring(Math.max(0, m.index - 5), m.index).replace(/\n/g, ' ');
    const word = text.substring(m.index, m.index + m.length);
    const after = text.substring(m.index + m.length, m.index + m.length + 5).replace(/\n/g, ' ');

    const item = document.createElement('div');
    item.className = 'fr-match-item';
    item.dataset.idx = i;
    item.innerHTML = `
      <span class="fr-match-context">
        <span class="fr-match-before">${escapeHtml(before)}</span>
        <span class="fr-match-word">${escapeHtml(word)}</span>
        <span class="fr-match-after">${escapeHtml(after)}</span>
      </span>
      <button class="fr-match-skip" title="不替换此处">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.fr-match-skip')) return;
      currentMatchIdx = i;
      updateActiveMatch();
    });

    const skipBtn = item.querySelector('.fr-match-skip');
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      skipMatchAt(i);
    });

    scrollEl.appendChild(item);
  });
}

function skipMatchAt(idx) {
  if (idx < 0 || idx >= findMatches.length) return;
  const skipped = findMatches[idx];
  quill.formatText(skipped.index, skipped.length, 'findHighlight', false, Quill.sources.SILENT);
  findMatches.splice(idx, 1);
  if (currentMatchIdx === idx) {
    currentMatchIdx = findMatches.length > 0 ? (idx < findMatches.length ? idx : 0) : -1;
  } else if (currentMatchIdx > idx) {
    currentMatchIdx--;
  }
  updateMatchCount(currentMatchIdx + 1, findMatches.length);
  renderMatchList();
  activeFindMatchIdx = -1;
  findMatches.forEach(match => {
    quill.formatText(match.index, match.length, 'findHighlight', 'match', Quill.sources.SILENT);
  });
  if (currentMatchIdx >= 0) updateActiveMatch();
}

function clearFindHighlights() {
  // 清除所有搜索匹配高亮（通过 findMatches 记录的精确位置）
  findMatches.forEach(m => {
    quill.formatText(m.index, m.length, 'findHighlight', false, Quill.sources.SILENT);
  });
  findMatches = [];
  currentMatchIdx = -1;
  activeFindMatchIdx = -1;
  // 关闭匹配列表
  const matchList = document.getElementById('fr-match-list');
  if (matchList) matchList.classList.remove('open');
}

initApp();


// ================== 自定义快捷键系统 ==================
const APP_DEFAULT_SHORTCUTS = [
  { id: 'bold', name: '加粗', defaultKey: 'Ctrl+B', key: 'Ctrl+B', enabled: true, type: 'format' },
  { id: 'italic', name: '斜体', defaultKey: 'Ctrl+I', key: 'Ctrl+I', enabled: true, type: 'format' },
  { id: 'underline', name: '下划线', defaultKey: 'Ctrl+U', key: 'Ctrl+U', enabled: true, type: 'format' },
  { id: 'strike', name: '删除线', defaultKey: 'Ctrl+Shift+X', key: 'Ctrl+Shift+X', enabled: true, type: 'format' },
  { id: 'header1', name: '标题 1', defaultKey: 'Ctrl+Alt+1', key: 'Ctrl+Alt+1', enabled: true, type: 'format' },
  { id: 'header2', name: '标题 2', defaultKey: 'Ctrl+Alt+2', key: 'Ctrl+Alt+2', enabled: true, type: 'format' },
  { id: 'header3', name: '标题 3', defaultKey: 'Ctrl+Alt+3', key: 'Ctrl+Alt+3', enabled: true, type: 'format' },
  { id: 'listOrdered', name: '有序列表', defaultKey: 'Ctrl+Shift+7', key: 'Ctrl+Shift+7', enabled: true, type: 'format' },
  { id: 'listBullet', name: '无序列表', defaultKey: 'Ctrl+Shift+8', key: 'Ctrl+Shift+8', enabled: true, type: 'format' },
  { id: 'blockquote', name: '引用块', defaultKey: 'Ctrl+Shift+9', key: 'Ctrl+Shift+9', enabled: true, type: 'format' },
  { id: 'codeBlock', name: '代码块', defaultKey: 'Ctrl+Shift+C', key: 'Ctrl+Shift+C', enabled: true, type: 'format' },
  { id: 'link', name: '插入链接', defaultKey: 'Ctrl+K', key: 'Ctrl+K', enabled: true, type: 'format' },
  { id: 'clearFormat', name: '清除格式', defaultKey: 'Ctrl+Shift+L', key: 'Ctrl+Shift+L', enabled: true, type: 'format' },
  { id: 'save', name: '保存', defaultKey: 'Ctrl+S', key: 'Ctrl+S', enabled: true, type: 'global' },
  { id: 'findReplace', name: '查找替换', defaultKey: 'Ctrl+F', key: 'Ctrl+F', enabled: true, type: 'global' }
];

function getActiveShortcuts() {
  let shortcuts = null;
  const stored = localStorage.getItem('essay_shortcuts');
  if (stored) {
    try {
      shortcuts = JSON.parse(stored);
    } catch (e) {
      console.error('[Shortcuts] 解析配置失败:', e);
    }
  }
  if (!Array.isArray(shortcuts) || shortcuts.length === 0) {
    shortcuts = APP_DEFAULT_SHORTCUTS.map(s => ({ ...s }));
  }
  // 合并默认值，保证新功能存在
  const map = new Map(shortcuts.map(s => [s.id, s]));
  const merged = APP_DEFAULT_SHORTCUTS.map(def => {
    const saved = map.get(def.id);
    return saved
      ? { ...def, key: saved.key ?? def.defaultKey, enabled: saved.enabled ?? true }
      : { ...def };
  });

  // 计算冲突
  const conflicts = new Set();
  const enabled = merged.filter(s => s.enabled && s.key);
  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      if (enabled[i].key === enabled[j].key) {
        conflicts.add(enabled[i].id);
        conflicts.add(enabled[j].id);
      }
    }
  }
  return { shortcuts: merged, conflicts };
}

function matchShortcut(e, shortcutKey) {
  if (!shortcutKey) return false;
  const parts = shortcutKey.split('+');
  const key = parts.pop();
  const ctrl = parts.includes('Ctrl');
  const alt = parts.includes('Alt');
  const shift = parts.includes('Shift');

  const ctrlMatch = ctrl === (e.ctrlKey || e.metaKey);
  const altMatch = alt === e.altKey;
  const shiftMatch = shift === e.shiftKey;

  let keyMatch = false;
  if (key === 'Plus') keyMatch = e.key === '+';
  else if (key === 'Minus') keyMatch = e.key === '-';
  else if (key === 'Equal') keyMatch = e.key === '=';
  else if (/^[0-9]$/.test(key)) keyMatch = e.key === key;
  else keyMatch = e.key.toLowerCase() === key.toLowerCase() || e.code === `Key${key.toUpperCase()}`;

  return keyMatch && ctrlMatch && altMatch && shiftMatch;
}

function applyFormatShortcut(id) {
  const range = quill.getSelection();
  if (!range) return;
  const format = quill.getFormat(range);
  switch (id) {
    case 'bold':
      quill.format('bold', !format.bold);
      break;
    case 'italic':
      quill.format('italic', !format.italic);
      break;
    case 'underline':
      quill.format('underline', !format.underline);
      break;
    case 'strike':
      quill.format('strike', !format.strike);
      break;
    case 'header1':
      quill.format('header', format.header === 1 ? false : 1);
      break;
    case 'header2':
      quill.format('header', format.header === 2 ? false : 2);
      break;
    case 'header3':
      quill.format('header', format.header === 3 ? false : 3);
      break;
    case 'listOrdered':
      quill.format('list', format.list === 'ordered' ? false : 'ordered');
      break;
    case 'listBullet':
      quill.format('list', format.list === 'bullet' ? false : 'bullet');
      break;
    case 'blockquote':
      quill.format('blockquote', !format.blockquote);
      break;
    case 'codeBlock':
      quill.format('code-block', !format['code-block']);
      break;
    case 'link': {
      const existing = format.link;
      if (existing) {
        quill.format('link', false);
      } else {
        const url = window.prompt('请输入链接地址:', 'https://');
        if (url) quill.format('link', url);
      }
      break;
    }
    case 'clearFormat':
      quill.removeFormat(range.index, range.length);
      break;
  }
}

function applyGlobalShortcut(id) {
  switch (id) {
    case 'save': {
      if (typeof autoSaveProject === 'function') autoSaveProject();
      break;
    }
    case 'findReplace': {
      if (!findReplacePanel) {
        setupFindReplacePanel();
      }
      if (findReplacePanel && findReplacePanel.classList.contains('visible')) {
        hideFindReplacePanel();
      } else {
        showFindReplacePanel();
      }
      break;
    }
  }
}

function bindGlobalShortcuts() {
  if (window._globalShortcutHandler) {
    document.removeEventListener('keydown', window._globalShortcutHandler, true);
    window._globalShortcutHandler = null;
  }

  const { shortcuts, conflicts } = getActiveShortcuts();
  const enabled = shortcuts.filter(s => s.enabled && !conflicts.has(s.id));
  const formatShortcuts = enabled.filter(s => s.type === 'format');
  const globalShortcuts = enabled.filter(s => s.type === 'global');


  window._globalShortcutHandler = function(e) {
    if (window._recordingShortcut) return;
    if (e.isComposing) return;

    // 格式类快捷键：仅在编辑器聚焦时生效
    if (quill.hasFocus()) {
      for (const s of formatShortcuts) {
        if (matchShortcut(e, s.key)) {
          e.preventDefault();
          e.stopPropagation();
          applyFormatShortcut(s.id);
          return;
        }
      }
    }

    // 全局快捷键：在应用任意位置生效
    for (const s of globalShortcuts) {
      if (matchShortcut(e, s.key)) {
        e.preventDefault();
        e.stopPropagation();
        applyGlobalShortcut(s.id);
        return;
      }
    }
  };

  document.addEventListener('keydown', window._globalShortcutHandler, true);
}

window.rebindShortcuts = bindGlobalShortcuts;

// 清理旧版缩放快捷键配置
function cleanupLegacyShortcuts() {
  try {
    const stored = localStorage.getItem('essay_shortcuts');
    if (!stored) return;
    const shortcuts = JSON.parse(stored);
    if (!Array.isArray(shortcuts)) return;
    const legacyIds = ['fontIncrease', 'fontDecrease', 'fontReset'];
    const cleaned = shortcuts.filter(s => !legacyIds.includes(s.id));
    if (cleaned.length !== shortcuts.length) {
      localStorage.setItem('essay_shortcuts', JSON.stringify(cleaned));
    }
  } catch (e) {
    console.error('[Shortcuts] 清理旧配置失败:', e);
  }
}


// ================== 特殊按键功能（滚轮加速） ==================
const HELD_KEYS = new Set();
const APP_VALID_SPECIAL_KEYS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

function getAppWheelScrollKey() {
  const stored = localStorage.getItem('essay_wheel_scroll_key');
  return APP_VALID_SPECIAL_KEYS.includes(stored) ? stored : 'Ctrl';
}

function isSpecialKeyHeld(keyName) {
  if (keyName === 'Ctrl') return HELD_KEYS.has('Control') || HELD_KEYS.has('Meta');
  if (keyName === 'Alt') return HELD_KEYS.has('Alt');
  if (keyName === 'Shift') return HELD_KEYS.has('Shift');
  if (keyName === 'Meta') return HELD_KEYS.has('Meta') || HELD_KEYS.has('Control');
  return false;
}

function setupSpecialKeys() {
  if (window._specialKeysBound) return;
  window._specialKeysBound = true;
  document.addEventListener('keydown', (e) => {
    HELD_KEYS.add(e.key);
  }, true);
  document.addEventListener('keyup', (e) => {
    HELD_KEYS.delete(e.key);
  }, true);
  window.addEventListener('blur', () => {
    HELD_KEYS.clear();
  });

  setupWheelScroll();
}

function setupWheelScroll() {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  workspace.addEventListener('wheel', (e) => {
    if (window._recordingShortcut) return;
    const key = getAppWheelScrollKey();
    if (!isSpecialKeyHeld(key)) return;
    e.preventDefault();
    const speed = 3.5;
    workspace.scrollTop += e.deltaY * speed;
  }, { passive: false });
}

window.rebindSpecialKeys = setupSpecialKeys;


// ================== 段落左侧操作按钮 ==================
let paragraphActions = null;
let paragraphFormatPanel = null;
let currentParagraphLine = null;
let paragraphActionsHideTimer = null;
let paragraphDragState = null;
let lastParagraphDragWasDrag = false;

function setupParagraphActions() {
  paragraphActions = document.getElementById('paragraph-actions');
  paragraphFormatPanel = document.getElementById('paragraph-format-panel');
  const editorEl = document.querySelector('#editor-container .ql-editor');
  const workspace = document.getElementById('workspace');
  if (!paragraphActions || !paragraphFormatPanel || !editorEl || !workspace) return;

  // 鼠标移动时更新按钮位置
  workspace.addEventListener('mousemove', (e) => {
    // 拖拽段落时不更新按钮位置，避免干扰
    if (paragraphDragState) return;

    // 鼠标在按钮本身上时保持显示，不隐藏
    if (paragraphActions.contains(e.target)) {
      clearTimeout(paragraphActionsHideTimer);
      return;
    }

    // 如果当前有目标段落，鼠标在段落左侧扩展区域内也保持显示
    // 这样从段落滑向左侧按钮时不会因为经过 workspace 间隙而消失
    if (currentParagraphLine && currentParagraphLine.domNode) {
      const lineRect = currentParagraphLine.domNode.getBoundingClientRect();
      const margin = 72; // 左侧按钮区域的扩展宽度，覆盖水平排列的按钮
      if (
        e.clientX >= lineRect.left - margin &&
        e.clientX <= lineRect.right &&
        e.clientY >= lineRect.top &&
        e.clientY <= lineRect.bottom
      ) {
        clearTimeout(paragraphActionsHideTimer);
        // 如果鼠标仍在段落内，更新到当前行；否则保持当前按钮位置
        if (editorEl.contains(e.target)) {
          const lineBlot = getLineBlotFromEvent(e, editorEl);
          if (lineBlot && lineBlot.domNode) showParagraphActions(lineBlot);
        }
        return;
      }
    }

    if (!editorEl.contains(e.target)) {
      scheduleHideParagraphActions();
      return;
    }
    // 选中文本时不显示段落按钮
    const sel = quill.getSelection();
    if (sel && sel.length > 0) {
      scheduleHideParagraphActions();
      return;
    }
    const lineBlot = getLineBlotFromEvent(e, editorEl);
    if (lineBlot && lineBlot.domNode) {
      showParagraphActions(lineBlot);
      clearTimeout(paragraphActionsHideTimer);
    } else {
      scheduleHideParagraphActions();
    }
  });

  // 鼠标离开 workspace 时隐藏
  workspace.addEventListener('mouseleave', () => {
    scheduleHideParagraphActions();
  });

  // 段落操作按钮本身不触发隐藏
  paragraphActions.addEventListener('mouseenter', () => {
    clearTimeout(paragraphActionsHideTimer);
  });
  paragraphActions.addEventListener('mouseleave', () => {
    scheduleHideParagraphActions();
  });

  // 加号按钮：插入空白行
  const addBtn = paragraphActions.querySelector('.pa-add-btn');
  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentParagraphLine) return;
    // 隐藏 AI 行提示并让编辑器失焦，避免提示浮在段落浮窗之上
    if (typeof hideAIHint === 'function') hideAIHint();
    if (quill && typeof quill.blur === 'function') quill.blur();
    const insertAbove = e.altKey;
    insertParagraphLine(currentParagraphLine, insertAbove);
  });

  // 菜单按钮：修改本段格式 / 拖拽段落
  const menuBtn = paragraphActions.querySelector('.pa-menu-btn');
  menuBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 只响应左键
    if (!currentParagraphLine) return;
    e.preventDefault();
    e.stopPropagation();
    startParagraphDrag(currentParagraphLine, e);
  });
  menuBtn.addEventListener('click', (e) => {
    // 如果发生了拖拽，不触发点击打开浮窗
    if (lastParagraphDragWasDrag) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!currentParagraphLine) return;
    // 隐藏 AI 行提示并让编辑器失焦，避免提示浮在段落浮窗之上
    if (typeof hideAIHint === 'function') hideAIHint();
    if (quill && typeof quill.blur === 'function') quill.blur();
    const lineIndex = quill.getIndex(currentParagraphLine);
    const lineLength = currentParagraphLine.length();
    const textLength = Math.max(0, lineLength - 1);
    quill.setSelection(lineIndex, textLength, 'silent');
    showParagraphFormatPanel({ index: lineIndex, length: textLength }, currentParagraphLine.domNode);
  });

  setupParagraphFormatPanel();
  setupParagraphAutoclose();
}

// ================== 段落拖拽 ==================
function startParagraphDrag(lineBlot, e) {
  if (!lineBlot || !lineBlot.domNode) return;

  const lineNode = lineBlot.domNode;
  const rect = lineNode.getBoundingClientRect();
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return;

  // 隐藏 AI 提示并让编辑器失焦，避免干扰
  if (typeof hideAIHint === 'function') hideAIHint();
  if (quill && typeof quill.blur === 'function') quill.blur();

  // 创建拖拽幻影
  const ghost = lineNode.cloneNode(true);
  ghost.classList.add('pa-drag-ghost');
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  // 保留原节点的计算样式（如 heading 的 font-size、font-weight），避免脱离编辑器后样式丢失
  const computedStyle = window.getComputedStyle(lineNode);
  ['fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'color', 'fontFamily', 'textAlign'].forEach(prop => {
    ghost.style[prop] = computedStyle[prop];
  });
  document.body.appendChild(ghost);

  // 创建黄线指示器
  const workspace = document.getElementById('workspace');
  const indicator = document.createElement('div');
  indicator.className = 'pa-drag-indicator-line';
  indicator.style.display = 'none';
  if (workspace) workspace.appendChild(indicator);

  // 缓存所有段落的原始位置（基于 editor 内 offsetTop）
  // 保留源段落在缓存中，避免 gap 检测时跨越源段落导致黄线定位到段落内部
  const allLineNodes = Array.from(editorEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre.ql-syntax, .ql-table-embed'));
  const allPositions = allLineNodes.map(node => ({
    node,
    top: getOffsetTopInEditor(node, editorEl),
    height: node.offsetHeight
  })).sort((a, b) => a.top - b.top);
  const sourcePosition = allPositions.find(p => p.node === lineNode);
  const originalLinePositions = allPositions;

  // 原段落半透明
  lineNode.classList.add('pa-dragging-source');

  paragraphDragState = {
    sourceLine: lineBlot,
    sourceNode: lineNode,
    sourceHeight: rect.height,
    ghost: ghost,
    indicator: indicator,
    sourcePosition: sourcePosition,
    originalLinePositions: originalLinePositions,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    startX: e.clientX,
    startY: e.clientY,
    didDrag: false,
    shiftedNode: null,
    targetLine: null,
    insertAfter: undefined,
    lastUpdateTime: 0
  };
  lastParagraphDragWasDrag = false;

  document.addEventListener('mousemove', onParagraphDragMove);
  document.addEventListener('mouseup', onParagraphDragEnd);

  // 拖拽时禁用文本选择，避免误选文字
  document.body.classList.add('pa-dragging');
}

function autoScrollWorkspace(e) {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  const rect = workspace.getBoundingClientRect();
  const threshold = 100; // 距离边缘 100px 开始滚动
  const speed = 16;      // 每次滚动 16px

  if (e.clientY < rect.top + threshold) {
    workspace.scrollTop -= speed;
  } else if (e.clientY > rect.bottom - threshold) {
    workspace.scrollTop += speed;
  }
}

function onParagraphDragMove(e) {
  if (!paragraphDragState) return;

  const state = paragraphDragState;
  const moveThreshold = 10;
  if (Math.abs(e.clientX - state.startX) > moveThreshold || Math.abs(e.clientY - state.startY) > moveThreshold) {
    state.didDrag = true;
    lastParagraphDragWasDrag = true;
    // 真正开始拖动后再隐藏段落操作按钮
    hideParagraphActions();
  }

  // 节流：每 16ms 最多更新一次，避免频繁重绘
  const now = Date.now();
  if (now - state.lastUpdateTime < 16) return;
  state.lastUpdateTime = now;

  // 移动幻影
  state.ghost.style.left = (e.clientX - state.offsetX) + 'px';
  state.ghost.style.top = (e.clientY - state.offsetY) + 'px';

  // 鼠标靠近编辑器边缘时自动滚动
  autoScrollWorkspace(e);

  // 找到目标段落：根据鼠标 Y 坐标找同一水平线上的段落
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return;

  const result = findTargetLineFromY(e.clientY, editorEl);
  if (!result || !result.blot || !result.blot.domNode || result.blot === state.sourceLine) {
    clearDragTarget();
    return;
  }

  updateDragTarget(result.blot, result.insertAfter, result.gapTop, result.gapBottom);
}

function getOffsetTopInEditor(node, editorEl) {
  let top = 0;
  let n = node;
  while (n && n !== editorEl) {
    top += n.offsetTop;
    n = n.offsetParent;
  }
  return top;
}

function findTargetLineFromY(y, editorEl) {
  const state = paragraphDragState;
  if (!state) return null;

  const editorRect = editorEl.getBoundingClientRect();
  const relativeY = y - editorRect.top;

  // 拖拽开始时已缓存布局；滚动只改变 editorRect，不会改变段落内部偏移。
  // 避免每个 mousemove 都扫描全文并触发布局计算，长文档拖拽会更稳定。
  const positions = state.originalLinePositions;

  if (positions.length === 0) return null;

  // 日志：原始位置与鼠标位置

  const getBlot = (node) => {
    try {
      const blot = Quill.find(node, true);
      if (blot && blot.length) return blot;
    } catch (e) {}
    return null;
  };

  const sourceNode = state.sourceNode;

  // 如果鼠标在源段落当前位置范围内，表示放回原位
  const sourcePos = positions.find(p => p.node === sourceNode);
  if (sourcePos) {
    const inSource = relativeY >= sourcePos.top && relativeY <= sourcePos.top + sourcePos.height;
    if (inSource) {
      return null;
    }
  }

  let result = null;
  let reason = '';

  // 在第一个段落上方：放到最前面
  if (relativeY <= positions[0].top) {
    const blot = getBlot(positions[0].node);
    if (blot) {
      result = {
        blot,
        insertAfter: false,
        gapTop: 0,
        gapBottom: positions[0].top
      };
      reason = 'before first';
    }
  }

  // 在最后一个段落下方：放到最后面
  if (!result) {
    const last = positions[positions.length - 1];
    if (relativeY >= last.top + last.height) {
      const blot = getBlot(last.node);
      if (blot) {
        result = {
          blot,
          insertAfter: true,
          gapTop: last.top + last.height,
          gapBottom: editorEl.scrollHeight
        };
        reason = 'after last';
      }
    }
  }

  // 基于实时段落间隙（gap）检测
  // 鼠标落在哪两个相邻段落之间的空白里，黄线就显示在该空白的正中间
  if (!result) {
    for (let i = 0; i < positions.length - 1; i++) {
      const current = positions[i];
      const next = positions[i + 1];
      const gapTop = current.top + current.height;
      const gapBottom = next.top;
      const gapHeight = gapBottom - gapTop;

      // 正常情况下 gapHeight >= 0；若出现负值说明布局异常，跳过
      if (gapHeight < 0) continue;

      // 感应区固定 8px，既能命中窄间隙，又避免侵入段落内部
      const extend = 8;

      const hitTop = gapTop - extend;
      const hitBottom = gapBottom + extend;

      const match = relativeY >= hitTop && relativeY <= hitBottom;
      if (match) {
        let blot, insertAfter;
        if (next.node === sourceNode) {
          // gap 在 current 和源段落之间 → 语义上插入 current 之后
          blot = getBlot(current.node);
          insertAfter = true;
        } else if (current.node === sourceNode) {
          // gap 在源段落和 next 之间 → 语义上插入 next 之前
          blot = getBlot(next.node);
          insertAfter = false;
        } else {
          // 普通 gap
          blot = getBlot(next.node);
          insertAfter = false;
        }
        if (blot) {
          result = {
            blot,
            insertAfter,
            gapTop,
            gapBottom
          };
          reason = `gap #${i}-${i + 1}, gapHeight=${Math.round(gapHeight)}px`;
        }
        break;
      }
    }
  }

  if (!result) {
    reason = 'no gap hit (paragraph middle)';
  }

  return result;
}

function updateDragTarget(targetLine, insertAfter, gapTop, gapBottom) {
  if (!paragraphDragState) return;
  const state = paragraphDragState;
  const targetNode = targetLine.domNode;
  const workspace = document.getElementById('workspace');
  if (!workspace) return;

  // 如果目标位置没变，不做任何更新
  if (state.targetLine === targetLine && state.insertAfter === insertAfter) {
    return;
  }

  // 保存新的目标位置，并定位黄线
  state.targetLine = targetLine;
  state.insertAfter = insertAfter;
  state.gapTop = gapTop;
  state.gapBottom = gapBottom;
  updateDragIndicatorPosition(state, targetNode, insertAfter, gapTop, gapBottom);

}

function updateDragIndicatorPosition(state, targetNode, insertAfter, gapTop, gapBottom) {
  const workspace = document.getElementById('workspace');
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!workspace || !state.indicator || !editorEl) return;

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = editorEl.getBoundingClientRect();

  // 直接用 getBoundingClientRect 获取 gap 两端在视口中的真实视觉位置
  // 避免 editor padding、margin、offsetParent 等导致的坐标偏差
  let prevNode, nextNode;
  if (insertAfter) {
    prevNode = targetNode;
    nextNode = targetNode.nextElementSibling;
  } else {
    prevNode = targetNode.previousElementSibling;
    nextNode = targetNode;
  }

  let gapMiddleInViewport;
  if (prevNode && nextNode) {
    const prevRect = prevNode.getBoundingClientRect();
    const nextRect = nextNode.getBoundingClientRect();
    gapMiddleInViewport = (prevRect.bottom + nextRect.top) / 2;
  } else if (prevNode) {
    // 最后一段之后
    const prevRect = prevNode.getBoundingClientRect();
    gapMiddleInViewport = prevRect.bottom;
  } else if (nextNode) {
    // 第一段之前
    const nextRect = nextNode.getBoundingClientRect();
    gapMiddleInViewport = nextRect.top;
  } else {
    return;
  }

  // 黄线相对于 workspace 内容的位置
  const indicatorTop = gapMiddleInViewport - workspaceRect.top + workspace.scrollTop;


  state.indicator.style.display = 'block';
  state.indicator.style.top = indicatorTop + 'px';
  state.indicator.style.left = (editorRect.left - workspaceRect.left + workspace.scrollLeft) + 'px';
  state.indicator.style.width = editorRect.width + 'px';
}

function clearDragTarget() {
  if (!paragraphDragState) return;
  const state = paragraphDragState;
  if (state.indicator) {
    state.indicator.style.display = 'none';
  }
  state.targetLine = null;
  state.insertAfter = undefined;
}

function executeParagraphMove(state, targetNode) {
  const workspace = document.getElementById('workspace');
  const savedScrollTop = typeof state.savedScrollTop === 'number' ? state.savedScrollTop : (workspace ? workspace.scrollTop : 0);
  const originalOverflowY = workspace ? workspace.style.overflowY : '';

  const sourceIndex = quill.getIndex(state.sourceLine);
  const sourceLength = state.sourceLine.length();

  // 计算目标 index
  let targetIndex = 0;
  if (targetNode && targetNode.parentNode) {
    const targetBlot = Quill.find(targetNode, true);
    targetIndex = targetBlot ? quill.getIndex(targetBlot) : quill.getLength();
  } else {
    targetIndex = quill.getLength();
  }

  // 临时冻结 workspace 滚动，防止 updateContents 期间视图闪烁到顶部
  if (workspace) workspace.style.overflowY = 'hidden';

  try {
    if (sourceIndex !== targetIndex) {
      // Delta 能原子保留图片、引用和自定义 TableBlot；避免先删后贴失败导致内容丢失。
      const sourceDelta = quill.getContents(sourceIndex, sourceLength);
      const Delta = Quill.import('delta');
      let deltaOps;
      if (sourceIndex < targetIndex) {
        const adjustedTargetIndex = targetIndex - sourceLength;
        deltaOps = new Delta()
          .retain(sourceIndex)
          .delete(sourceLength)
          .retain(adjustedTargetIndex - sourceIndex)
          .concat(sourceDelta);
      } else {
        deltaOps = new Delta()
          .retain(targetIndex)
          .concat(sourceDelta)
          .retain(sourceIndex - targetIndex)
          .delete(sourceLength);
      }
      quill.updateContents(deltaOps, Quill.sources.USER);
      ensureHeadingIds();
    }
  } catch (e) {
    console.warn('[executeParagraphMove] 段落移动失败:', e);
    window.showToast?.('段落移动失败，内容未更改');
  } finally {
    if (workspace) {
      workspace.scrollTop = savedScrollTop;
      workspace.style.overflowY = originalOverflowY || 'auto';
      requestAnimationFrame(() => { workspace.scrollTop = savedScrollTop; });
      setTimeout(() => { workspace.scrollTop = savedScrollTop; }, 50);
    }
  }
}

function cleanupParagraphDrag(state) {
  // 清理：移除黄线、恢复推移段落的 margin-top、恢复源段落样式、恢复文本选择
  if (state.indicator) {
    state.indicator.remove();
  }
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (editorEl) {
    editorEl.querySelectorAll('.pa-drag-shifted').forEach(node => {
      node.classList.remove('pa-drag-shifted');
      node.style.marginTop = '';
    });
  }
  if (state.sourceNode) {
    state.sourceNode.classList.remove('pa-dragging-source');
  }
  if (state.ghost) {
    state.ghost.remove();
  }
  document.body.classList.remove('pa-dragging');

  // 恢复滚动位置，防止 cleanup 阶段（如 margin-top 复位、源段落样式恢复）把视图带到顶部
  const workspace = document.getElementById('workspace');
  const savedScrollTop = typeof state.savedScrollTop === 'number' ? state.savedScrollTop : null;
  if (workspace && savedScrollTop !== null) {
    workspace.scrollTop = savedScrollTop;
  }

  // 如果没有真正拖拽，立即允许 click 事件触发
  if (!state.didDrag) {
    lastParagraphDragWasDrag = false;
  }

  paragraphDragState = null;
  setTimeout(() => {
    lastParagraphDragWasDrag = false;
  }, 50);
}

function onParagraphDragEnd(e) {
  if (!paragraphDragState) return;
  const state = paragraphDragState;

  document.removeEventListener('mousemove', onParagraphDragMove);
  document.removeEventListener('mouseup', onParagraphDragEnd);

  // 在 margin-top 动画开始前保存滚动位置，避免动画过程中滚动到顶部后无法恢复
  const workspace = document.getElementById('workspace');
  state.savedScrollTop = workspace ? workspace.scrollTop : 0;

  // 鼠标松开时根据最终位置重新计算目标
  let finalTargetLine = state.targetLine;
  let finalInsertAfter = state.insertAfter;
  let finalGapTop = state.gapTop;
  let finalGapBottom = state.gapBottom;
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (state.didDrag && editorEl) {
    const result = findTargetLineFromY(e.clientY, editorEl);
    if (result && result.blot && result.blot.domNode && result.blot !== state.sourceLine) {
      finalTargetLine = result.blot;
      finalInsertAfter = result.insertAfter;
      finalGapTop = result.gapTop;
      finalGapBottom = result.gapBottom;
      state.targetLine = finalTargetLine;
      state.insertAfter = finalInsertAfter;
      state.gapTop = finalGapTop;
      state.gapBottom = finalGapBottom;
      updateDragIndicatorPosition(state, finalTargetLine.domNode, finalInsertAfter, finalGapTop, finalGapBottom);
    } else {
      finalTargetLine = null;
    }
  }


  if (state.didDrag && finalTargetLine && finalTargetLine.domNode) {
    const targetNode = finalInsertAfter
      ? finalTargetLine.domNode.nextElementSibling
      : finalTargetLine.domNode;

    // 需要让开的段落：insertAfter=false 时 targetNode 本身下移；insertAfter=true 时 targetNode 就是下一段
    const shiftNode = targetNode;

    if (shiftNode) {
      // 播放 margin-top 展开动画，让出 sourceHeight 空间
      shiftNode.classList.add('pa-drag-shifted');
      const currentMargin = parseFloat(window.getComputedStyle(shiftNode).marginTop) || 0;
      shiftNode.style.marginTop = currentMargin + 'px';
      shiftNode.offsetHeight; // force reflow
      shiftNode.style.marginTop = (currentMargin + state.sourceHeight) + 'px';

      // 动画完成后才真正移动段落
      let moved = false;
      const onTransitionEnd = (evt) => {
        if (evt && evt.propertyName !== 'margin-top') return;
        shiftNode.removeEventListener('transitionend', onTransitionEnd);
        if (moved) return;
        moved = true;
        executeParagraphMove(state, targetNode);
        cleanupParagraphDrag(state);
      };
      shiftNode.addEventListener('transitionend', onTransitionEnd);
      setTimeout(() => {
        if (moved) return;
        moved = true;
        shiftNode.removeEventListener('transitionend', onTransitionEnd);
        executeParagraphMove(state, targetNode);
        cleanupParagraphDrag(state);
      }, 300);
    } else {
      // insertAfter=true 且 targetNode 为 null（最后一段之后），直接移动
      executeParagraphMove(state, targetNode);
      cleanupParagraphDrag(state);
    }
  } else {
    cleanupParagraphDrag(state);
  }
}

function scheduleHideParagraphActions() {
  clearTimeout(paragraphActionsHideTimer);
  paragraphActionsHideTimer = setTimeout(() => {
    hideParagraphActions();
  }, 150);
}

function getLineBlotFromEvent(e, editorEl) {
  let node = e.target;
  while (node && node !== editorEl) {
    if (['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE'].includes(node.tagName)) {
      break;
    }
    if (node.classList && node.classList.contains('ql-syntax')) {
      break;
    }
    node = node.parentElement;
  }
  if (!node || node === editorEl) return null;
  try {
    const blot = Quill.find(node, true);
    if (blot && blot.length) return blot;
  } catch (e) {}
  return null;
}

function showParagraphActions(lineBlot) {
  if (!paragraphActions || !lineBlot || !lineBlot.domNode) return;
  currentParagraphLine = lineBlot;

  const workspace = document.getElementById('workspace');
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!workspace || !editorEl) return;

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = editorEl.getBoundingClientRect();
  const lineRect = lineBlot.domNode.getBoundingClientRect();

  // 计算相对于 workspace 的位置
  const top = lineRect.top - workspaceRect.top + workspace.scrollTop;
  // 按钮为水平排列（加号+菜单），整体宽约 52px，预留 56px 边距
  const left = lineRect.left - workspaceRect.left + workspace.scrollLeft - 56;

  paragraphActions.style.top = top + 'px';
  paragraphActions.style.left = left + 'px';
  paragraphActions.style.display = 'flex';
  requestAnimationFrame(() => {
    paragraphActions.classList.add('visible');
  });
}

function hideParagraphActions() {
  if (!paragraphActions) return;
  paragraphActions.classList.remove('visible');
  setTimeout(() => {
    if (!paragraphActions.classList.contains('visible')) {
      paragraphActions.style.display = 'none';
    }
  }, 120);
  currentParagraphLine = null;
}

function insertParagraphLine(lineBlot, insertAbove) {
  if (!lineBlot) return;
  const lineIndex = quill.getIndex(lineBlot);
  const lineLength = lineBlot.length();
  const insertIndex = insertAbove ? lineIndex : lineIndex + lineLength;

  // 插入空白行
  quill.insertText(insertIndex, '\n', 'user');

  // 获取新插入行的 DOM 节点并添加动画和追踪标记
  setTimeout(() => {
    const [newLine] = quill.getLine(insertIndex);
    if (newLine && newLine.domNode) {
      const node = newLine.domNode;
      // 添加追踪标记，后续定位不依赖时间延迟
      const insertedAt = Date.now();
      node.dataset.insertedAt = insertedAt;
      // 先强制设为折叠状态，避免添加动画类时从正常高度瞬间压回 0 造成闪现
      node.style.maxHeight = '0';
      node.style.marginBottom = '0';
      node.style.opacity = '0';
      node.style.overflow = 'hidden';
      node.offsetHeight; // force reflow
      node.classList.add('pa-inserting-line');
      setTimeout(() => {
        node.classList.remove('pa-inserting-line');
        node.style.maxHeight = '';
        node.style.marginBottom = '';
        node.style.opacity = '';
        node.style.overflow = '';
        // 动画结束后移除追踪标记
        delete node.dataset.insertedAt;
      }, 350);
    }
  }, 0);

  // 选中新空白行
  quill.setSelection(insertIndex, 0, 'silent');

  // 隐藏段落操作按钮和框选浮窗
  hideParagraphActions();
  hideBlockToolbar();

  // 显示格式选择浮窗（通过 data-inserted-at 精确追踪）
  setTimeout(() => {
    const editorEl = document.querySelector('#editor-container .ql-editor');
    const targetNode = editorEl?.querySelector('[data-inserted-at]');
    if (targetNode) {
      showParagraphFormatPanel({ index: insertIndex, length: 0 }, targetNode);
    }
  }, 50);
}

function setupParagraphFormatPanel() {
  if (!paragraphFormatPanel) return;

  // 格式项点击
  paragraphFormatPanel.querySelectorAll('.pf-item[data-format]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const format = item.dataset.format;
      const value = item.dataset.value;
      applyParagraphFormat(format, value);
    });
  });

  // 颜色面板
  paragraphFormatPanel.querySelectorAll('[data-dropdown-panel="color"] .color-swatch').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      const color = swatch.dataset.color;
      applyParagraphFormat('color', color);
      closeParagraphFormatDropdowns();
    });
  });

  paragraphFormatPanel.querySelectorAll('[data-dropdown-panel="background"] .color-swatch').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      const bg = swatch.dataset.color;
      applyParagraphFormat('background', bg);
      closeParagraphFormatDropdowns();
    });
  });

  // 下拉按钮
  paragraphFormatPanel.querySelectorAll('.pf-dropdown-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.dataset.dropdown;
      toggleParagraphFormatDropdown(type, btn);
    });
  });

  // 点击空白处关闭
  document.addEventListener('mousedown', (e) => {
    if (!paragraphFormatPanel) return;
    if (paragraphFormatPanel.contains(e.target)) return;
    hideParagraphFormatPanel();
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideParagraphFormatPanel();
  });
}

let _paragraphFormatHideTimer = null;

function showParagraphFormatPanel(range, anchorNode) {
  if (!paragraphFormatPanel || !anchorNode) return;

  const workspace = document.getElementById('workspace');
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!workspace || !editorEl) return;

  const workspaceRect = workspace.getBoundingClientRect();
  const editorRect = editorEl.getBoundingClientRect();
  const anchorRect = anchorNode.getBoundingClientRect();

  // 先隐藏框选浮窗，避免重叠
  hideBlockToolbar();

  // 定位：放在编辑区左侧，可以遮挡文字，但不能遮挡段落操作按钮
  let top = anchorRect.top - workspaceRect.top + workspace.scrollTop;
  const panelWidth = 160;
  const panelHeight = paragraphFormatPanel.offsetHeight || 320;

  const workspaceStyle = window.getComputedStyle(workspace);
  const paddingLeft = parseFloat(workspaceStyle.paddingLeft) || 0;
  const paddingRight = parseFloat(workspaceStyle.paddingRight) || 0;

  // workspace 可视区内可用水平范围（考虑 padding）
  const minLeft = workspace.scrollLeft + paddingLeft + 8;
  const maxLeft = workspace.scrollLeft + paddingLeft + workspace.clientWidth - panelWidth - 8;
  const maxTop = workspace.scrollTop + workspace.clientHeight - panelHeight - 8;

  // 默认放在编辑区内部左侧：编辑区左边缘 + 小间距
  // 可以遮挡文字，但不能遮挡段落操作按钮（按钮在 editor 外左侧）
  let left = editorRect.left - workspaceRect.left + workspace.scrollLeft + 8;
  let positionSide = 'editor-inner-left';

  // 编辑区内部左侧放不下时（窗口很窄），放到编辑区右侧
  if (left < minLeft) {
    left = editorRect.right - workspaceRect.left + workspace.scrollLeft + 8;
    positionSide = 'editor-right';
  }
  // 右侧也放不下时，贴到 workspace 右内边界
  if (left > maxLeft) {
    left = maxLeft;
    positionSide = 'editor-right-clamped';
  }

  if (top < workspace.scrollTop + 8) {
    top = workspace.scrollTop + 8;
  }
  if (top > maxTop) {
    top = maxTop;
  }

  clearTimeout(_paragraphFormatHideTimer);
  paragraphFormatPanel.style.top = top + 'px';
  paragraphFormatPanel.style.left = left + 'px';
  paragraphFormatPanel.style.display = 'flex';

  updateParagraphFormatPanelActiveState(range);

  requestAnimationFrame(() => {
    paragraphFormatPanel.classList.add('visible');
  });
}

function rectToObj(rect) {
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function hideParagraphFormatPanel() {
  if (!paragraphFormatPanel) return;
  paragraphFormatPanel.classList.remove('visible');
  closeParagraphFormatDropdowns();
  clearTimeout(_paragraphFormatHideTimer);
  _paragraphFormatHideTimer = setTimeout(() => {
    if (!paragraphFormatPanel.classList.contains('visible')) {
      paragraphFormatPanel.style.display = 'none';
    }
  }, 150);
}

function applyParagraphFormat(format, value) {
  const range = quill.getSelection();
  if (!range) return;

  let val = value;
  if (value === 'false') val = false;
  else if (value === '' && format !== 'align') val = false;

  if (format === 'header') {
    quill.format('header', val);
  } else if (format === 'list') {
    quill.format('list', val);
  } else if (format === 'align') {
    quill.format('align', val);
  } else if (format === 'color' || format === 'background') {
    // 颜色类直接设置，不 toggle
    quill.format(format, val === false || val === '' ? false : val);
  } else {
    // bold / italic / underline / strike / blockquote / code-block
    const currentFormat = quill.getFormat(range.index, range.length);
    const isActive = !!currentFormat[format];
    quill.format(format, val === false ? false : !isActive);
  }

  // 更新浮窗 active 状态
  updateParagraphFormatPanelActiveState(quill.getSelection());

  // 应用格式后自动关闭浮窗（颜色和背景色除外，它们在选色时关闭）
  if (!['color', 'background'].includes(format)) {
    setTimeout(() => hideParagraphFormatPanel(), 80);
  }
}

function updateParagraphFormatPanelActiveState(range) {
  if (!range || !paragraphFormatPanel) return;
  const format = quill.getFormat(range.index, range.length);

  paragraphFormatPanel.querySelectorAll('.pf-item[data-format]').forEach(item => {
    const f = item.dataset.format;
    const v = item.dataset.value;
    let active = false;
    if (f === 'header') {
      const headerVal = v === 'false' ? false : parseInt(v, 10);
      active = format.header === headerVal || (headerVal === false && !format.header);
    } else if (f === 'list') {
      active = format.list === v;
    } else if (f === 'align') {
      const alignVal = v || false;
      active = (format.align || false) === alignVal;
    } else {
      active = !!format[f];
    }
    item.classList.toggle('active', active);
  });
}

function toggleParagraphFormatDropdown(type, btn) {
  const panel = paragraphFormatPanel.querySelector(`[data-dropdown-panel="${type}"]`);
  if (!panel) return;
  const isOpen = panel.classList.contains('show');
  closeParagraphFormatDropdowns();
  if (!isOpen) {
    panel.classList.add('show');
    btn.classList.add('active');
  }
}

function closeParagraphFormatDropdowns() {
  if (!paragraphFormatPanel) return;
  paragraphFormatPanel.querySelectorAll('.pf-dropdown-panel').forEach(p => p.classList.remove('show'));
  paragraphFormatPanel.querySelectorAll('.pf-dropdown-btn').forEach(b => b.classList.remove('active'));
}

function setupParagraphAutoclose() {
  if (!paragraphFormatPanel) return;
  paragraphFormatPanel.addEventListener('mouseleave', () => {
    const shouldAutoclose = localStorage.getItem('essay_toolbar_autoclose') === 'true';
    if (shouldAutoclose) hideParagraphFormatPanel();
  });
}

function defaultEvidenceInsertionIndex(preferredIndex = null) {
  const referenceSection = quill.root.querySelector('[data-ref-section="true"]');
  const precedingBlot = referenceSection?.previousElementSibling
    ? Quill.find(referenceSection.previousElementSibling)
    : null;
  const bodyEndIndex = precedingBlot && typeof precedingBlot.length === 'function'
    ? quill.getIndex(precedingBlot) + Math.max(0, precedingBlot.length() - 1)
    : null;
  if (Number.isSafeInteger(preferredIndex) && (!Number.isSafeInteger(bodyEndIndex) || preferredIndex <= bodyEndIndex)) {
    return preferredIndex;
  }
  if (Number.isSafeInteger(bodyEndIndex)) return bodyEndIndex;
  if (referenceSection) return 0;
  return Math.max(0, quill.getLength() - 1);
}

function evidenceDropIndex(point, preferredIndex = null) {
  if (!point) return defaultEvidenceInsertionIndex(preferredIndex);
  let range = null;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(point.clientX, point.clientY);
    if (position?.offsetNode) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  } else if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(point.clientX, point.clientY);
  }
  if (!range) return defaultEvidenceInsertionIndex();
  try {
    const node = range.startContainer;
    const blot = Quill.find(node);
    if (!blot || blot === quill.scroll) return defaultEvidenceInsertionIndex();
    return quill.getIndex(blot) + (node.nodeType === Node.TEXT_NODE ? range.startOffset : 0);
  } catch {
    return defaultEvidenceInsertionIndex();
  }
}

function chooseEvidenceInsertion(item) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'evidence-insert-dialog';
    dialog.setAttribute('aria-labelledby', 'evidence-insert-title');
    const title = document.createElement('h2');
    title.id = 'evidence-insert-title';
    title.textContent = '插入证据';
    const quote = document.createElement('blockquote');
    quote.textContent = item.revision.locator.quoteDisplay;
    const modes = document.createElement('div');
    modes.className = 'evidence-insert-modes';
    const paraphrase = document.createElement('textarea');
    paraphrase.placeholder = '输入你的转述文本';
    paraphrase.setAttribute('aria-label', '手工转述文本');
    paraphrase.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'evidence-insert-actions';
    const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
    const modeButton = (label, mode) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        if (mode !== 'paraphrase') return finish({ mode, text: '' });
        paraphrase.hidden = false;
        actions.hidden = false;
        paraphrase.focus();
      });
      return button;
    };
    modes.append(
      modeButton('原文引用', 'quote'),
      modeButton('手工转述', 'paraphrase'),
      modeButton('仅插入引用', 'citation-only')
    );
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish(null));
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.textContent = '插入转述';
    insert.addEventListener('click', () => {
      const text = paraphrase.value.trim();
      if (!text) return paraphrase.focus();
      finish({ mode: 'paraphrase', text });
    });
    actions.hidden = true;
    actions.append(cancel, insert);
    dialog.append(title, quote, modes, paraphrase, actions);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

window.registerEssayflowCitationLink = link => {
  const cluster = { ...JSON.parse(JSON.stringify(link)), citationInstanceId: link.id };
  citations.push(cluster);
  saveCitations();
  return cluster;
};

window.insertEssayflowEvidence = async (item, point = null) => {
  if (!item?.revision || item.effectiveStatus !== 'active' || item.card?.status === 'archived') {
    showToast('这张证据当前不能插入正文');
    return false;
  }
  const preferredIndex = point ? null : quill.getSelection()?.index;
  const choice = await chooseEvidenceInsertion(item);
  if (!choice) return false;
  const projectId = currentProjectId;
  const baseRevision = currentProjectRevision;
  if (!projectId || baseRevision < 0) {
    showToast('请先保存当前项目');
    return false;
  }
  const beforeHtml = quill.root.innerHTML;
  const beforeCitations = JSON.parse(JSON.stringify(citations));
  try {
    const prepared = await window.electronAPI.prepareEvidenceCitation({
      projectId,
      baseRevision,
      insertionMode: choice.mode,
      evidenceRevisionIds: [item.revision.id]
    });
    const index = evidenceDropIndex(point, preferredIndex);
    const bodyText = choice.mode === 'quote' ? `“${item.revision.locator.quoteDisplay}” ` : (choice.mode === 'paraphrase' ? `${choice.text} ` : '');
    if (bodyText) quill.insertText(index, bodyText, { cite: false }, Quill.sources.USER);
    const citationIndex = index + bodyText.length;
    const citationText = `[${citations.length + 1}]`;
    quill.insertText(citationIndex, citationText, {
      cite: {
        citationInstanceId: prepared.citationInstanceId,
        paperId: item.revision.libraryItemId || item.revision.citationItemId,
        num: citations.length + 1
      }
    }, Quill.sources.USER);
    const committed = await window.electronAPI.commitEvidenceCitation({
      projectId,
      sessionId: prepared.sessionId,
      documentHtml: getPersistableEditorHtml()
    });
    window.registerEssayflowCitationLink({ ...committed.link, items: committed.link.items.map(entry => ({
      ...entry,
      paperId: item.revision.libraryItemId || item.revision.citationItemId,
      ...(item.revision.libraryItemId ? { libraryItemId: item.revision.libraryItemId } : {})
    })) });
    currentProjectRevision = committed.revision;
    documentRevision += 1;
    savedRevision = documentRevision;
    updateSaveStatus('saved');
    await renderReferencesFromMain();
    await window.refreshEssayflowEvidence?.();
    showToast('证据与引用已插入正文');
    return true;
  } catch (error) {
    isLoadingProject = true;
    quill.root.innerHTML = beforeHtml;
    quill.update(Quill.sources.SILENT);
    citations = beforeCitations;
    isLoadingProject = false;
    showToast(`插入失败：${error.message || '正文未更改'}`);
    return false;
  }
};

window.getEssayflowProjectContext = () => ({
  projectId: currentProjectId,
  revision: currentProjectRevision,
  title: currentProjectMeta?.title || '',
  privacyMode: currentProjectMeta?.privacyMode || 'normal'
});
window.applyEssayflowProjectRevision = (projectId, revision) => {
  if (projectId === currentProjectId && Number.isSafeInteger(revision) && revision >= currentProjectRevision) {
    currentProjectRevision = revision;
  }
};
window.getEssayflowDocumentRevision = () => documentRevision;
window.setEssayflowPrivacyMode = async mode => {
  if (!['normal', 'sensitive', 'local-only'].includes(mode)) throw new Error('隐私模式无效');
  if (!currentProjectId) throw new Error('请先保存当前项目');
  currentProjectMeta = { ...(currentProjectMeta || {}), privacyMode: mode };
  markProjectDataDirty();
  cancelScheduledAutoSave();
  const saveResult = await autoSaveProject();
  if (!saveResult?.success) throw new Error(saveResult?.message || '隐私模式尚未完成持久化，请重试');
  return window.getEssayflowProjectContext();
};
window.prepareEssayflowReviewSelection = async () => {
  const range = quill.getSelection(true);
  if (!range || range.length < 1) throw new Error('请先选择同一段落内需要审阅的文字');
  const [line, offset] = quill.getLine(range.index);
  if (!line || offset + range.length > Math.max(0, line.length() - 1)) {
    throw new Error('M4 Diff 当前只支持单个稳定段落内的选区');
  }
  const selectedText = quill.getText(range.index, range.length);
  if (!selectedText.trim()) throw new Error('选区不能为空');
  const node = line.domNode;
  let documentAnchorId = node.getAttribute('data-essayflow-anchor');
  if (!documentAnchorId) {
    documentAnchorId = crypto.randomUUID();
    quill.formatLine(range.index, Math.max(1, range.length), 'essayflowAnchor', documentAnchorId, Quill.sources.SILENT);
    markProjectDataDirty();
    cancelScheduledAutoSave();
    const saveResult = await autoSaveProject();
    if (!saveResult?.success) {
      throw new Error(saveResult?.message || '审阅锚点尚未完成持久化，请重试');
    }
  }
  return {
    projectId: currentProjectId,
    baseRevision: currentProjectRevision,
    documentRevision,
    documentAnchorId,
    selectedText
  };
};

function replaceReviewTextInClone(element, originalText, suggestedText) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let combined = '';
  while (walker.nextNode()) {
    nodes.push({ node: walker.currentNode, start: combined.length });
    combined += walker.currentNode.nodeValue || '';
  }
  const start = combined.indexOf(originalText);
  if (start < 0 || combined.indexOf(originalText, start + 1) >= 0) throw new Error('建议原文已变化或无法唯一定位');
  const end = start + originalText.length;
  const startEntry = [...nodes].reverse().find(entry => entry.start <= start);
  const endEntry = [...nodes].reverse().find(entry => entry.start < end) || startEntry;
  if (!startEntry || !endEntry) throw new Error('建议原文锚点已失效');
  const range = document.createRange();
  range.setStart(startEntry.node, start - startEntry.start);
  range.setEnd(endEntry.node, end - endEntry.start);
  range.deleteContents();
  range.insertNode(document.createTextNode(suggestedText));
}

window.prepareEssayflowReviewAcceptance = issue => {
  if (documentRevision !== issue.baseDocumentRevision) throw new Error('正文在建议生成后已变化，请重新生成');
  const clone = quill.root.cloneNode(true);
  const anchor = [...clone.querySelectorAll('[data-essayflow-anchor]')]
    .find(node => node.getAttribute('data-essayflow-anchor') === issue.documentAnchorId);
  if (!anchor) throw new Error('建议对应的正文锚点已失效');
  replaceReviewTextInClone(anchor, issue.originalText, issue.suggestedText);
  return {
    documentRevision,
    documentAnchorId: issue.documentAnchorId,
    beforeHash: issue.beforeHash,
    newDocumentHtml: sanitizeEditorHtml(clone.innerHTML),
    diff: JSON.stringify({ originalText: issue.originalText, suggestedText: issue.suggestedText })
  };
};

window.prepareEssayflowReviewBatchAcceptance = async issues => {
  if (!Array.isArray(issues) || !issues.length) throw new Error('没有可批量接受的建议');
  if (issues.some(issue => issue.baseDocumentRevision !== documentRevision)) throw new Error('正文在建议生成后已变化，请重新生成');
  const anchorIds = [...new Set(issues.map(issue => issue.documentAnchorId))];
  if (anchorIds.length !== 1) throw new Error('批量接受只支持同一稳定段落内的建议');
  const clone = quill.root.cloneNode(true);
  const anchor = [...clone.querySelectorAll('[data-essayflow-anchor]')]
    .find(node => node.getAttribute('data-essayflow-anchor') === anchorIds[0]);
  if (!anchor) throw new Error('建议对应的正文锚点已失效');
  const ordered = [...issues].map(issue => ({ issue, offset: anchor.textContent.indexOf(issue.originalText) }))
    .sort((left, right) => right.offset - left.offset);
  if (ordered.some(item => item.offset < 0)) throw new Error('建议原文已变化，请重新生成');
  ordered.forEach(item => replaceReviewTextInClone(anchor, item.issue.originalText, item.issue.suggestedText));
  return {
    documentRevision,
    documentAnchorId: anchorIds[0],
    newDocumentHtml: sanitizeEditorHtml(clone.innerHTML),
    diffs: await Promise.all(issues.map(async issue => ({
      issueId: issue.id,
      beforeHash: issue.beforeHash,
      afterHash: await sha256Text(issue.suggestedText),
      diff: JSON.stringify({ originalText: issue.originalText, suggestedText: issue.suggestedText })
    })))
  };
};

window.applyEssayflowAcceptedReview = (issue, revision) => {
  const anchor = [...quill.root.querySelectorAll('[data-essayflow-anchor]')]
    .find(node => node.getAttribute('data-essayflow-anchor') === issue.documentAnchorId);
  if (!anchor) throw new Error('正文锚点已失效，请重新加载项目');
  const blot = Quill.find(anchor);
  const localOffset = anchor.textContent.indexOf(issue.originalText);
  if (!blot || localOffset < 0 || anchor.textContent.indexOf(issue.originalText, localOffset + 1) >= 0) {
    throw new Error('建议原文已变化，请重新加载项目');
  }
  const index = quill.getIndex(blot) + localOffset;
  const formats = quill.getFormat(index, Math.max(1, issue.originalText.length));
  cancelScheduledAutoSave();
  isLoadingProject = true;
  try {
    quill.updateContents({ ops: [
      { retain: index },
      { delete: issue.originalText.length },
      { insert: issue.suggestedText, ...(Object.keys(formats).length ? { attributes: formats } : {}) }
    ] }, Quill.sources.API);
  } finally {
    isLoadingProject = false;
  }
  currentProjectRevision = revision;
  documentRevision += 1;
  savedRevision = documentRevision;
  updateSaveStatus('saved');
};

window.applyEssayflowAcceptedReviewBatch = (issues, revision) => {
  const ordered = [...issues].map(issue => {
    const anchor = [...quill.root.querySelectorAll('[data-essayflow-anchor]')]
      .find(node => node.getAttribute('data-essayflow-anchor') === issue.documentAnchorId);
    if (!anchor) throw new Error('正文锚点已失效，请重新加载项目');
    const blot = Quill.find(anchor);
    const localOffset = anchor.textContent.indexOf(issue.originalText);
    if (!blot || localOffset < 0 || anchor.textContent.indexOf(issue.originalText, localOffset + 1) >= 0) {
      throw new Error('建议原文已变化，请重新加载项目');
    }
    return { issue, index: quill.getIndex(blot) + localOffset };
  }).sort((left, right) => right.index - left.index);
  cancelScheduledAutoSave();
  isLoadingProject = true;
  try {
    ordered.forEach(({ issue, index }) => {
      const formats = quill.getFormat(index, Math.max(1, issue.originalText.length));
      quill.updateContents({ ops: [
        { retain: index },
        { delete: issue.originalText.length },
        { insert: issue.suggestedText, ...(Object.keys(formats).length ? { attributes: formats } : {}) }
      ] }, Quill.sources.API);
    });
  } finally {
    isLoadingProject = false;
  }
  currentProjectRevision = revision;
  documentRevision += 1;
  savedRevision = documentRevision;
  updateSaveStatus('saved');
};
