(() => {
  'use strict';

  const state = { snapshot: null, query: '', groupBy: 'source' };

  function context() { return window.getEssayflowProjectContext?.() || {}; }
  function notify(message, type = '') { window.showToast?.(message, type); }
  function elements() {
    return {
      results: document.getElementById('evidence-results'),
      query: document.getElementById('evidence-query'),
      group: document.getElementById('evidence-group')
    };
  }

  function effectiveStatusLabel(status) {
    return {
      active: '可回链',
      archived: '已归档',
      'source-missing': '来源缺失',
      'source-mismatch': '来源已替换',
      'anchor-missing': '锚点失效'
    }[status] || status;
  }

  function groupKey(item) {
    if (state.groupBy === 'tag') return item.card.tags?.[0] || '无标签';
    if (state.groupBy === 'question') return item.card.researchQuestionIds?.[0] || '未关联研究问题';
    return item.revision?.sourceSnapshot?.title || '未知来源';
  }

  function filteredItems() {
    const terms = state.query.toLocaleLowerCase('und').split(/\s+/).filter(Boolean);
    return (state.snapshot?.items || []).filter(item => {
      const text = [item.revision?.locator?.quoteDisplay, item.card?.note, item.revision?.sourceSnapshot?.title, ...(item.card?.tags || [])]
        .filter(Boolean).join(' ').toLocaleLowerCase('und');
      return terms.every(term => text.includes(term));
    });
  }

  function makeButton(label, action, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', action);
    return button;
  }

  function evidenceRow(item) {
    const row = document.createElement('article');
    row.className = 'evidence-row';
    row.draggable = item.effectiveStatus === 'active' && item.card.status !== 'archived';
    row.dataset.evidenceId = item.card.id;
    row.style.setProperty('--evidence-color', item.card.color || '#d5a623');
    row.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-essayflow-evidence', JSON.stringify(item));
      event.dataTransfer.effectAllowed = 'copy';
      window._draggingEvidence = item;
    });
    row.addEventListener('dragend', () => { window._draggingEvidence = null; });

    const heading = document.createElement('div');
    heading.className = 'evidence-row-heading';
    const source = document.createElement('button');
    source.type = 'button';
    source.className = 'evidence-source-link';
    source.textContent = item.revision.sourceSnapshot.title;
    source.title = '回到 PDF 原文';
    source.addEventListener('click', () => window.openEssayflowEvidenceSource?.(item));
    const status = document.createElement('span');
    status.className = `evidence-status evidence-status-${item.effectiveStatus}`;
    status.textContent = effectiveStatusLabel(item.effectiveStatus);
    heading.append(source, status);

    const meta = document.createElement('div');
    meta.className = 'evidence-row-meta';
    meta.textContent = `${item.revision.locator.pageLabel} · ${item.citationCount} 处正文引用 · ${item.reviewStatus === 'proposed' ? 'AI 候选' : item.reviewStatus === 'rejected' ? '已拒绝' : '用户已确认'}`;
    const quote = document.createElement('blockquote');
    quote.textContent = item.revision.locator.quoteDisplay;

    const edit = document.createElement('div');
    edit.className = 'evidence-row-edit';
    const note = document.createElement('textarea');
    note.value = item.card.note || '';
    note.placeholder = '添加笔记';
    note.setAttribute('aria-label', '证据笔记');
    const tags = document.createElement('input');
    tags.type = 'text';
    tags.value = (item.card.tags || []).join(', ');
    tags.placeholder = '标签，逗号分隔';
    tags.setAttribute('aria-label', '证据标签');
    const color = document.createElement('input');
    color.type = 'color';
    color.value = item.card.color || '#d5a623';
    color.setAttribute('aria-label', '证据颜色');
    edit.append(note, tags, color);

    const actions = document.createElement('div');
    actions.className = 'evidence-row-actions';
    actions.append(
      makeButton('保存', async () => {
        try {
          const project = context();
          const result = await window.electronAPI.updateEvidenceCard({
            projectId: project.projectId,
            baseRevision: project.revision,
            evidenceId: item.card.id,
            note: note.value,
            tags: tags.value.split(/[,，]/).map(value => value.trim()).filter(Boolean),
            color: color.value
          });
          window.applyEssayflowProjectRevision?.(project.projectId, result.revision);
          await load();
          notify('证据卡已保存');
        } catch (error) { notify(`保存失败：${error.message || '请重试'}`, 'error'); }
      }),
      makeButton('插入', () => window.insertEssayflowEvidence?.(item)),
      makeButton('归档', async () => {
        try {
          let project = context();
          const impact = await window.electronAPI.archiveEvidence({ projectId: project.projectId, baseRevision: project.revision, evidenceId: item.card.id });
          if (!window.confirm(`这张证据被 ${impact.citationCount} 个正文引用使用。归档后保留引用快照，但停止自动回跳。继续吗？`)) return;
          project = context();
          const result = await window.electronAPI.archiveEvidence({ projectId: project.projectId, baseRevision: project.revision, evidenceId: item.card.id, confirmed: true });
          window.applyEssayflowProjectRevision?.(project.projectId, result.revision);
          await load();
        } catch (error) { notify(`归档失败：${error.message || '请重试'}`, 'error'); }
      }, 'danger')
    );
    row.append(heading, meta, quote, edit, actions);
    return row;
  }

  function render() {
    const { results } = elements();
    if (!results) return;
    results.replaceChildren();
    const items = filteredItems();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'evidence-empty';
      empty.textContent = state.snapshot ? '没有符合条件的证据' : '打开已收藏文献的 PDF，选择原文后保存为证据';
      results.appendChild(empty);
      return;
    }
    const groups = new Map();
    items.forEach(item => {
      const key = groupKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    groups.forEach((groupItems, label) => {
      const section = document.createElement('section');
      section.className = 'evidence-group';
      const heading = document.createElement('h3');
      heading.textContent = `${label} (${groupItems.length})`;
      section.appendChild(heading);
      groupItems.forEach(item => section.appendChild(evidenceRow(item)));
      results.appendChild(section);
    });
  }

  async function load() {
    const project = context();
    if (!project.projectId || project.revision < 0 || !window.electronAPI?.listEvidence) {
      state.snapshot = { items: [] };
      render();
      return state.snapshot;
    }
    try {
      state.snapshot = await window.electronAPI.listEvidence(project.projectId);
      window.essayflowPdfEvidence?.setEvidenceItems(state.snapshot.items);
      render();
      return state.snapshot;
    } catch (error) {
      state.snapshot = { items: [] };
      render();
      notify(`证据加载失败：${error.message || '请重试'}`, 'error');
      return state.snapshot;
    }
  }

  document.getElementById('evidence-query')?.addEventListener('input', event => {
    state.query = event.target.value.trim();
    render();
  });
  document.getElementById('evidence-group')?.addEventListener('change', event => {
    state.groupBy = event.target.value;
    render();
  });

  window.refreshEssayflowEvidence = load;
  window.renderEssayflowEvidence = render;
  window.getEssayflowEvidenceSnapshot = () => state.snapshot;
})();
