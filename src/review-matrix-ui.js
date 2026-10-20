(() => {
  'use strict';

  const modal = document.getElementById('review-matrix-modal');
  const shell = document.getElementById('review-matrix-table-shell');
  const status = document.getElementById('review-matrix-status');
  const matrixSelect = document.getElementById('review-matrix-select');
  const filterInput = document.getElementById('review-matrix-filter');
  const sortSelect = document.getElementById('review-matrix-sort');
  if (!modal || !shell || !matrixSelect) return;

  window.enhanceEssayflowSelect?.(matrixSelect);
  window.enhanceEssayflowSelect?.(sortSelect);

  const state = {
    projectId: '',
    revision: -1,
    matrices: [],
    activeMatrixId: '',
    citationItems: [],
    projectPaperStates: [],
    selectedRows: new Set(),
    activePreviewId: '',
    renderToken: 0
  };
  let modalHideTimer = null;

  function projectContext() {
    const project = window.getEssayflowProjectContext?.() || {};
    if (!project.projectId || !Number.isSafeInteger(project.revision) || project.revision < 0) {
      throw new Error('请先保存当前项目，再打开综述矩阵');
    }
    return project;
  }

  function paperMap() {
    const libraryById = new Map((window.getEssayflowLibraryPapers?.() || []).map(paper => [paper.libraryItemId, paper]));
    return new Map(state.citationItems.map(citation => {
      const author = (citation.author || []).map(person => person.literal || [person.family, person.given].filter(Boolean).join(', ')).join('; ');
      const base = {
        ...citation,
        authors: author,
        published: citation.issued?.['date-parts']?.[0]?.[0] || '',
        doi: citation.DOI || citation.doi || ''
      };
      return [citation.citationItemId || citation.id, { ...base, ...(libraryById.get(citation.libraryItemId) || {}) }];
    }));
  }

  function activeMatrix() {
    return state.matrices.find(matrix => matrix.id === state.activeMatrixId) || state.matrices[0] || null;
  }

  function setStatus(message, kind = '') {
    status.textContent = message || '';
    status.dataset.kind = kind;
  }

  function applyRevision(revision) {
    if (!Number.isSafeInteger(revision)) return;
    state.revision = revision;
    window.applyEssayflowProjectRevision?.(state.projectId, revision);
  }

  async function reload(preferredMatrixId = state.activeMatrixId) {
    const project = projectContext();
    state.projectId = project.projectId;
    const snapshot = await window.electronAPI.listReviewMatrices(project.projectId);
    state.revision = snapshot.revision;
    state.matrices = snapshot.matrices || [];
    state.citationItems = snapshot.citationItems || [];
    state.projectPaperStates = snapshot.projectPaperStates || [];
    state.activeMatrixId = state.matrices.some(matrix => matrix.id === preferredMatrixId)
      ? preferredMatrixId : state.matrices[0]?.id || '';
    matrixSelect.replaceChildren();
    if (!state.matrices.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '尚未创建矩阵';
      matrixSelect.appendChild(option);
    } else {
      state.matrices.forEach(matrix => {
        const option = document.createElement('option');
        option.value = matrix.id;
        option.textContent = `${matrix.name}（${matrix.rows.length} 篇）`;
        matrixSelect.appendChild(option);
      });
      matrixSelect.value = state.activeMatrixId;
    }
    refreshSortOptions();
    render();
    return snapshot;
  }

  function includedCitationIds() {
    return state.projectPaperStates
      .filter(paperState => paperState.screeningStatus === 'included')
      .map(paperState => paperState.citationItemId);
  }

  async function createMatrix() {
    const project = projectContext();
    const ids = includedCitationIds();
    if (!ids.length) throw new Error('请先在文库把候选文献标为“已纳入”');
    const name = window.prompt('矩阵名称', '综述矩阵');
    if (name === null) return;
    const result = await window.electronAPI.createReviewMatrix({
      projectId: project.projectId,
      baseRevision: project.revision,
      name: name.trim() || '综述矩阵',
      citationItemIds: ids
    });
    applyRevision(result.revision);
    await reload(result.matrix.id);
    setStatus(`已创建矩阵，共 ${result.matrix.rows.length} 篇纳入文献`);
  }

  async function syncRows() {
    const matrix = activeMatrix();
    if (!matrix) throw new Error('请先创建矩阵');
    const ids = includedCitationIds();
    const result = await window.electronAPI.setReviewMatrixRows({
      projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id, citationItemIds: ids
    });
    applyRevision(result.revision);
    state.selectedRows.clear();
    await reload(matrix.id);
    setStatus(`已同步 ${ids.length} 篇纳入文献；被排除的行已移出矩阵`);
  }

  function refreshSortOptions() {
    const previous = sortSelect.value;
    sortSelect.replaceChildren();
    const original = document.createElement('option');
    original.value = '';
    original.textContent = '原顺序';
    sortSelect.appendChild(original);
    const matrix = activeMatrix();
    (matrix?.columns || []).forEach(column => {
      for (const direction of ['asc', 'desc']) {
        const option = document.createElement('option');
        option.value = `${column.id}:${direction}`;
        option.textContent = `${column.label} ${direction === 'asc' ? '升序' : '降序'}`;
        sortSelect.appendChild(option);
      }
    });
    if ([...sortSelect.options].some(option => option.value === previous)) sortSelect.value = previous;
  }

  function visibleRows(matrix) {
    const papers = paperMap();
    const query = filterInput.value.normalize('NFKC').toLocaleLowerCase('und').trim();
    let rows = matrix.rows.filter(row => {
      if (!query) return true;
      const paper = papers.get(row.citationItemId);
      const haystack = [paper?.title, paper?.authors, ...Object.values(row.cells).map(cell => cell.value)]
        .filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase('und');
      return haystack.includes(query);
    });
    const [columnId, direction] = sortSelect.value.split(':');
    if (columnId) {
      rows = [...rows].sort((left, right) => String(left.cells[columnId]?.value || '')
        .localeCompare(String(right.cells[columnId]?.value || ''), 'zh-CN', { numeric: true }) * (direction === 'desc' ? -1 : 1));
    }
    return rows;
  }

  function taskLabel(row) {
    return {
      queued: '待预填', running: '正在预填', completed: '已完成', failed: '失败', canceled: '已取消'
    }[row.taskStatus] || row.taskStatus;
  }

  function sourceButton(sourceRef) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `页 ${sourceRef.pageLabel}`;
    button.title = sourceRef.quote;
    button.addEventListener('click', async () => {
      try {
        const snapshot = await window.electronAPI.listEvidence(state.projectId);
        const item = snapshot.items.find(candidate => candidate.revision?.id === sourceRef.evidenceRevisionId);
        if (!item) throw new Error('证据版本已归档或不可用');
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        await window.openEssayflowEvidenceSource?.(item);
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    return button;
  }

  function cellNode(matrix, row, column) {
    const cell = row.cells[column.id] || null;
    const wrapper = document.createElement('div');
    wrapper.className = 'review-matrix-cell';
    const editor = document.createElement('textarea');
    editor.value = cell?.value || '';
    editor.setAttribute('aria-label', `${column.label}：${paperMap().get(row.citationItemId)?.title || row.citationItemId}`);
    editor.addEventListener('change', async () => {
      editor.disabled = true;
      try {
        const result = await window.electronAPI.updateReviewMatrixCell({
          projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id,
          rowId: row.id, columnId: column.id, value: editor.value
        });
        applyRevision(result.revision);
        await reload(matrix.id);
        setStatus('手工编辑已持久化；后续 AI 再生成默认不会覆盖');
      } catch (error) {
        setStatus(`保存失败：${error.message}`, 'error');
        await reload(matrix.id).catch(() => {});
      } finally {
        editor.disabled = false;
      }
    });
    wrapper.appendChild(editor);
    if (cell) {
      const meta = document.createElement('div');
      meta.className = 'review-matrix-cell-meta';
      const badge = document.createElement('span');
      badge.className = 'review-matrix-badge';
      badge.dataset.state = cell.reviewStatus;
      badge.textContent = `${cell.basis} · ${cell.reviewStatus}${cell.userEdited ? ' · 用户编辑' : ''}`;
      meta.appendChild(badge);
      cell.sourceRefs.forEach(ref => meta.appendChild(sourceButton(ref)));
      if (cell.origin === 'ai' && cell.basis === 'pdf-evidence' && ['draft', 'proposed'].includes(cell.reviewStatus)) {
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.textContent = '确认单元格';
        confirm.addEventListener('click', () => reviewCell(matrix, row, column, 'confirmed'));
        meta.appendChild(confirm);
      }
      wrapper.appendChild(meta);
    }
    return wrapper;
  }

  async function reviewCell(matrix, row, column, decision) {
    try {
      const result = await window.electronAPI.reviewMatrixAICell({
        projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id,
        rowId: row.id, columnId: column.id, decision
      });
      applyRevision(result.revision);
      await reload(matrix.id);
      setStatus('单元格已由用户确认；EvidenceRevision 的审阅状态仍保持独立');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function columnHeader(matrix, column, index) {
    const fragment = document.createDocumentFragment();
    const label = document.createElement('div');
    label.textContent = column.label;
    fragment.appendChild(label);
    const actions = document.createElement('div');
    actions.className = 'review-matrix-column-actions';
    const move = async offset => {
      const ids = [...matrix.columns].sort((a, b) => a.order - b.order).map(item => item.id);
      const target = index + offset;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      const result = await window.electronAPI.reorderReviewMatrixColumns({
        projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id, columnIds: ids
      });
      applyRevision(result.revision);
      await reload(matrix.id);
    };
    for (const [text, offset] of [['←', -1], ['→', 1]]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = text; button.disabled = index + offset < 0 || index + offset >= matrix.columns.length;
      button.setAttribute('aria-label', `${column.label}${offset < 0 ? '左移' : '右移'}`);
      button.addEventListener('click', () => move(offset).catch(error => setStatus(error.message, 'error')));
      actions.appendChild(button);
    }
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '删'; remove.setAttribute('aria-label', `删除${column.label}列`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`删除“${column.label}”列及其所有单元格？`)) return;
      try {
        const result = await window.electronAPI.deleteReviewMatrixColumn({
          projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id, columnId: column.id
        });
        applyRevision(result.revision); await reload(matrix.id);
      } catch (error) { setStatus(error.message, 'error'); }
    });
    actions.appendChild(remove);
    fragment.appendChild(actions);
    return fragment;
  }

  function render() {
    const token = ++state.renderToken;
    shell.replaceChildren();
    const matrix = activeMatrix();
    if (!matrix) {
      const empty = document.createElement('p');
      empty.textContent = '尚未创建矩阵。先在文库标记“已纳入”，再从纳入文献新建。';
      shell.appendChild(empty);
      return;
    }
    const papers = paperMap();
    const columns = [...matrix.columns].sort((a, b) => a.order - b.order);
    const rows = visibleRows(matrix);
    const table = document.createElement('table');
    table.className = 'review-matrix-table';
    table.setAttribute('aria-rowcount', String(rows.length + 1));
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const selectHeader = document.createElement('th');
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox'; selectAll.setAttribute('aria-label', '选择当前筛选的全部矩阵行');
    selectAll.checked = rows.length > 0 && rows.every(row => state.selectedRows.has(row.id));
    selectAll.indeterminate = rows.some(row => state.selectedRows.has(row.id)) && !selectAll.checked;
    selectAll.addEventListener('change', () => {
      rows.forEach(row => selectAll.checked ? state.selectedRows.add(row.id) : state.selectedRows.delete(row.id));
      render();
    });
    selectHeader.appendChild(selectAll); headerRow.appendChild(selectHeader);
    const paperHeader = document.createElement('th'); paperHeader.textContent = '文献 / 任务'; headerRow.appendChild(paperHeader);
    columns.forEach((column, index) => {
      const th = document.createElement('th'); th.appendChild(columnHeader(matrix, column, index)); headerRow.appendChild(th);
    });
    head.appendChild(headerRow); table.appendChild(head);
    const body = document.createElement('tbody');
    rows.forEach(row => {
      const tr = document.createElement('tr'); tr.dataset.rowId = row.id;
      const selectCell = document.createElement('td');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selectedRows.has(row.id);
      checkbox.setAttribute('aria-label', `选择${papers.get(row.citationItemId)?.title || row.citationItemId}`);
      checkbox.addEventListener('change', () => { checkbox.checked ? state.selectedRows.add(row.id) : state.selectedRows.delete(row.id); });
      selectCell.appendChild(checkbox); tr.appendChild(selectCell);
      const paperCell = document.createElement('td');
      const title = document.createElement('div'); title.className = 'review-matrix-paper-title'; title.textContent = papers.get(row.citationItemId)?.title || row.citationItemId;
      const task = document.createElement('div'); task.className = 'review-matrix-task'; task.textContent = `${taskLabel(row)} · 第 ${row.attempt} 次${row.failureReason ? ` · ${row.failureReason}` : ''}`;
      paperCell.append(title, task);
      if (['failed', 'canceled'].includes(row.taskStatus)) {
        const retry = document.createElement('button');
        retry.type = 'button'; retry.textContent = '重试此篇';
        retry.setAttribute('aria-label', `重试${title.textContent}`);
        retry.addEventListener('click', () => prefill([row]).catch(error => setStatus(error.message, 'error')));
        paperCell.appendChild(retry);
      }
      tr.appendChild(paperCell);
      columns.forEach(column => {
        const td = document.createElement('td');
        td.dataset.columnId = column.id;
        td.appendChild(cellNode(matrix, row, column));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    if (token === state.renderToken) shell.appendChild(table);
    setStatus(`显示 ${rows.length}/${matrix.rows.length} 篇；已选 ${state.selectedRows.size} 篇`);
  }

  async function addColumn() {
    const matrix = activeMatrix();
    if (!matrix) throw new Error('请先创建矩阵');
    const label = window.prompt('新列名称');
    if (label === null) return;
    const result = await window.electronAPI.addReviewMatrixColumn({
      projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id, label: label.trim()
    });
    applyRevision(result.revision); await reload(matrix.id);
  }

  async function pdfSource(paper, assetId) {
    const managed = await window.electronAPI.readEvidencePdfAsset(assetId);
    const task = window.essayFlowGetPdfDocument({ data: managed.data });
    const documentHandle = await task.promise;
    const pages = [];
    try {
      for (let pageNumber = 1; pageNumber <= documentHandle.numPages; pageNumber += 1) {
        const page = await documentHandle.getPage(pageNumber);
        const textContent = await page.getTextContent({ includeMarkedContent: true });
        const text = textContent.items.map(item => item.str || '').join(' ').replace(/\s+/gu, ' ').trim();
        if (Array.from(text).length > 500000) throw new Error(`第 ${pageNumber} 页文本超过单页上限，未进行静默截断`);
        if (!text) continue;
        const view = page.view || [0, 0, 612, 792];
        pages.push({
          pageIndex: pageNumber - 1, pageLabel: String(pageNumber), text,
          rects: [{ x: 0, y: 0, width: 1, height: 1 }],
          pageRotation: Number(page.rotate || 0),
          cropBox: { x: Number(view[0] || 0), y: Number(view[1] || 0), width: Math.max(1, Number(view[2] - view[0]) || 612), height: Math.max(1, Number(view[3] - view[1]) || 792) }
        });
      }
    } finally {
      await documentHandle.destroy?.();
    }
    if (!pages.length) throw new Error('PDF 没有可用文本层');
    return { type: 'pdf', assetId: managed.descriptor.assetId, fileSha256: managed.descriptor.sha256, pages };
  }

  async function sourceForRow(row, paper, cache) {
    const assetId = paper?.managedAssetId || (paper?.assetRefs || []).find(ref => ref?.kind === 'pdf')?.assetId;
    if (assetId) {
      try {
        if (!cache.has(assetId)) cache.set(assetId, pdfSource(paper, assetId));
        return await cache.get(assetId);
      }
      catch (error) { return { type: 'corrupt', reason: `PDF 解析失败：${error.message}` }; }
    }
    const abstract = String(paper?.abstract || '').trim();
    if (abstract && abstract !== '无摘要') return { type: 'abstract', abstract };
    return { type: 'corrupt', reason: '没有受管全文或可用摘要' };
  }

  async function prefill(explicitRows = null) {
    let matrix = activeMatrix();
    const project = projectContext();
    if (project.revision !== state.revision) {
      await reload(matrix?.id || '');
      matrix = activeMatrix();
    }
    if (!matrix) throw new Error('请先创建矩阵');
    const visible = visibleRows(matrix);
    const rows = Array.isArray(explicitRows)
      ? explicitRows
      : state.selectedRows.size ? matrix.rows.filter(row => state.selectedRows.has(row.id)) : visible;
    if (!rows.length) throw new Error('没有可预填的矩阵行');
    if (rows.length > 50) throw new Error('单批最多 50 篇，请筛选或勾选后分批运行');
    const papers = paperMap();
    const sourcesByCitationId = {};
    const overwriteCellIds = [];
    const sourceCache = new Map();
    setStatus(`正在准备 ${rows.length} 篇文献的外发范围…`);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      for (const cell of Object.values(row.cells).filter(candidate => candidate.userEdited)) {
        const column = matrix.columns.find(candidate => candidate.id === cell.columnId);
        if (window.confirm(`覆盖手工内容？\n\n文献：${papers.get(row.citationItemId)?.title || row.citationItemId}\n字段：${column?.label || cell.columnId}\n当前值：${cell.value}`)) {
          overwriteCellIds.push(cell.id);
        }
      }
      setStatus(`正在读取来源 ${index + 1}/${rows.length}：${papers.get(row.citationItemId)?.title || row.citationItemId}`);
      sourcesByCitationId[row.citationItemId] = await sourceForRow(row, papers.get(row.citationItemId), sourceCache);
    }
    const outboundBytes = new TextEncoder().encode(JSON.stringify(sourcesByCitationId)).byteLength;
    if (outboundBytes > 18 * 1024 * 1024) throw new Error(`本批来源范围为 ${(outboundBytes / 1024 / 1024).toFixed(1)} MB，超过 18 MB UI 安全预算；请分批运行，内容未被静默截断`);
    const preview = await window.electronAPI.previewReviewMatrixPrefill({
      projectId: state.projectId, baseRevision: state.revision, matrixId: matrix.id,
      rowIds: rows.map(row => row.id), sourcesByCitationId, overwriteColumnIds: [], overwriteCellIds
    });
    const scope = preview.papers.map(paper => `${paper.title}｜${paper.sourceType}｜${paper.pageCount} 页｜${paper.outboundCodePointCount} 字符`).join('\n');
    const batchBudget = `合计：${preview.papers.length} 篇｜${preview.pageCount} 页｜预计发送 ${preview.totalOutboundCodePointCount} 字符`;
    if (preview.blocked) {
      setStatus('local-only 已阻止远程矩阵预填；将写入 blocked 审计，手工编辑和导出仍可用', 'warning');
    } else if (preview.confirmationRequired) {
      const provider = preview.provider ? `${preview.provider.origin} / ${preview.provider.model}` : '远程 provider';
      if (!window.confirm(`确认向 ${provider} 发送本批矩阵范围？\n\n${batchBudget}\n\n${scope}`)) {
        setStatus('已取消，未发送任何矩阵来源');
        return;
      }
    }
    state.activePreviewId = preview.previewId;
    document.getElementById('review-matrix-cancel').disabled = false;
    setStatus(`正在预填 ${rows.length} 篇；每篇独立提交，失败不会回滚其他行…`);
    let polling = false;
    const poll = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try { await reload(matrix.id); } catch (_) {} finally { polling = false; }
    }, 500);
    try {
      const result = await window.electronAPI.executeReviewMatrixPrefill({ previewId: preview.previewId, confirmed: true });
      applyRevision(result.revision);
      const counts = result.outcomes.reduce((map, item) => ({ ...map, [item.status]: (map[item.status] || 0) + 1 }), {});
      await reload(matrix.id);
      setStatus(`预填结束：完成 ${counts.completed || 0}，失败 ${counts.failed || 0}，取消 ${counts.canceled || 0}`);
    } finally {
      window.clearInterval(poll);
      state.activePreviewId = '';
      document.getElementById('review-matrix-cancel').disabled = true;
    }
  }

  async function cancelPrefill() {
    if (!state.activePreviewId) return;
    const result = await window.electronAPI.cancelReviewMatrixPrefill({ batchId: state.activePreviewId });
    setStatus(result.cancelled ? '正在取消当前请求；尚未开始的行将标为 canceled' : '批次已结束');
  }

  async function exportMatrix(format) {
    const matrix = activeMatrix();
    if (!matrix) throw new Error('请先创建矩阵');
    const result = await window.electronAPI.exportReviewMatrix({ projectId: state.projectId, matrixId: matrix.id, format });
    if (result.success) setStatus(`已导出 ${format.toUpperCase()}：${result.byteCount} 字节`);
  }

  async function open() {
    clearTimeout(modalHideTimer);
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('dialog-open');
    modal.classList.remove('open');
    void modal.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      modal.classList.add('open');
    }));
    setStatus('正在读取矩阵…');
    try { await reload(); }
    catch (error) { setStatus(error.message, 'error'); }
    document.getElementById('review-matrix-close').focus();
  }

  function close() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    clearTimeout(modalHideTimer);
    modalHideTimer = setTimeout(() => {
      if (!modal.classList.contains('open')) modal.style.display = 'none';
      if (!document.querySelector('.modal.open, .settings-panel.open, .source-modal.open')) {
        document.body.classList.remove('dialog-open');
      }
      document.getElementById('review-matrix-open')?.focus({ preventScroll: true });
    }, reducedMotion ? 0 : 430);
  }

  document.getElementById('review-matrix-open')?.addEventListener('click', open);
  document.getElementById('review-matrix-close')?.addEventListener('click', close);
  document.getElementById('review-matrix-create')?.addEventListener('click', () => createMatrix().catch(error => setStatus(error.message, 'error')));
  document.getElementById('review-matrix-sync-rows')?.addEventListener('click', () => syncRows().catch(error => setStatus(error.message, 'error')));
  document.getElementById('review-matrix-add-column')?.addEventListener('click', () => addColumn().catch(error => setStatus(error.message, 'error')));
  document.getElementById('review-matrix-prefill')?.addEventListener('click', () => prefill().catch(error => setStatus(error.message, 'error')));
  document.getElementById('review-matrix-cancel')?.addEventListener('click', () => cancelPrefill().catch(error => setStatus(error.message, 'error')));
  document.getElementById('review-matrix-export-csv')?.addEventListener('click', () => exportMatrix('csv').catch(error => setStatus(error.message, 'error')));
  document.getElementById('review-matrix-export-xlsx')?.addEventListener('click', () => exportMatrix('xlsx').catch(error => setStatus(error.message, 'error')));
  matrixSelect.addEventListener('change', () => { state.activeMatrixId = matrixSelect.value; state.selectedRows.clear(); refreshSortOptions(); render(); });
  filterInput.addEventListener('input', render);
  sortSelect.addEventListener('change', render);
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !state.activePreviewId) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      modal.dataset.focusTrapDirection = 'backward';
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      modal.dataset.focusTrapDirection = 'forward';
      first.focus({ preventScroll: true });
    }
  });
  window.essayflowReviewMatrixReady = true;
})();
