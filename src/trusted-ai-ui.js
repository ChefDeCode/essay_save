(() => {
  'use strict';

  const state = {
    view: 'chat',
    evidence: [],
    selectedEvidenceIds: new Set(),
    ai: null,
    reviewIssues: [],
    activeRequest: null
  };

  const byId = id => document.getElementById(id);
  const project = () => window.getEssayflowProjectContext?.() || {};
  const notify = message => window.showToast?.(message);

  function button(label, className = '') {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (className) element.className = className;
    return element;
  }

  function empty(label) {
    const element = document.createElement('div');
    element.className = 'trusted-ai-empty';
    element.textContent = label;
    return element;
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.trusted-ai-tab').forEach(tab => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-trusted-ai-view]').forEach(panel => {
      panel.hidden = panel.dataset.trustedAiView !== view;
    });
    const chat = view === 'chat';
    byId('ai-chat-messages').hidden = !chat;
    document.querySelector('.ai-chat-input-area').hidden = !chat;
    const attachmentPreview = byId('chat-attachment-preview');
    if (attachmentPreview) attachmentPreview.hidden = !chat;
    if (view === 'grounded') void Promise.all([loadEvidence(), loadGroundedHistory()]);
    if (view === 'review' || view === 'audit') void loadAiState();
  }

  function installShell() {
    const panel = byId('ai-chat-panel');
    const header = panel?.querySelector('.ai-chat-header');
    const messages = byId('ai-chat-messages');
    if (!panel || !header || !messages || byId('trusted-ai-tabs')) return;

    const privacy = document.createElement('select');
    privacy.id = 'trusted-ai-privacy';
    privacy.className = 'trusted-ai-privacy';
    privacy.setAttribute('aria-label', '项目隐私模式');
    privacy.innerHTML = '<option value="normal">普通</option><option value="sensitive">敏感</option><option value="local-only">仅本地</option>';
    privacy.addEventListener('change', async () => {
      const previous = project().privacyMode || 'normal';
      const description = privacy.value === 'local-only'
        ? '仅本地模式会阻止 AI、学术搜索、citation-verify 和远程 PDF 下载；项目正文不会因此自动加密。'
        : privacy.value === 'sensitive'
          ? '敏感模式下每次远程 AI、自动查询和远程 PDF 下载都需要确认。'
          : '普通模式按已确认的 provider 和发送范围允许远程请求。';
      if (!window.confirm(`${description}\n\n确认切换吗？`)) {
        privacy.value = previous;
        window.syncEssayflowSelect?.(privacy);
        return;
      }
      try {
        await window.setEssayflowPrivacyMode(privacy.value);
        window.syncEssayflowSelect?.(privacy);
        notify('隐私模式已保存');
      } catch (error) {
        privacy.value = previous;
        window.syncEssayflowSelect?.(privacy);
        notify(`隐私模式保存失败：${error.message || '请重试'}`);
      }
    });
    header.insertBefore(privacy, byId('ai-chat-close'));
    window.enhanceEssayflowSelect?.(privacy);

    const tabs = document.createElement('div');
    tabs.id = 'trusted-ai-tabs';
    tabs.className = 'trusted-ai-tabs';
    tabs.setAttribute('role', 'tablist');
    [['chat', '聊天'], ['grounded', '证据问答'], ['review', '正文审阅'], ['audit', '审计']].forEach(([view, label]) => {
      const tab = button(label, 'trusted-ai-tab');
      tab.dataset.view = view;
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => setView(view));
      tabs.appendChild(tab);
    });
    header.after(tabs);

    ['grounded', 'review', 'audit'].forEach(view => {
      const section = document.createElement('section');
      section.className = `trusted-ai-view trusted-ai-${view}`;
      section.dataset.trustedAiView = view;
      section.hidden = true;
      messages.before(section);
    });
    buildGroundedView();
    buildReviewView();
    buildAuditView();
    setView('chat');
    syncProject();
  }

  function syncProject() {
    const privacy = byId('trusted-ai-privacy');
    if (privacy) {
      privacy.value = project().privacyMode || 'normal';
      window.syncEssayflowSelect?.(privacy);
    }
  }

  function buildGroundedView() {
    const panel = document.querySelector('[data-trusted-ai-view="grounded"]');
    panel.innerHTML = `
      <div class="trusted-ai-view-head"><strong>选择证据</strong><button id="grounded-refresh" type="button">刷新</button></div>
      <div id="grounded-evidence-list" class="grounded-evidence-list"></div>
      <textarea id="grounded-question" maxlength="24000" rows="3" placeholder="基于所选证据提问"></textarea>
      <div class="trusted-ai-actions"><span id="grounded-budget"></span><button id="grounded-stop" type="button" hidden>停止</button><button id="grounded-paraphrase" type="button">AI 转述选中引文</button><button id="grounded-ask" type="button" class="primary">提问</button></div>
      <div id="grounded-results" class="grounded-results"></div>
      <div class="trusted-ai-view-head"><strong>历史回答</strong></div>
      <div id="grounded-history" class="grounded-results grounded-history"></div>`;
    byId('grounded-refresh').addEventListener('click', () => void loadEvidence());
    byId('grounded-ask').addEventListener('click', () => void askGrounded());
    byId('grounded-paraphrase').addEventListener('click', () => void requestEvidenceParaphrase());
    byId('grounded-stop').addEventListener('click', () => cancelActive());
  }

  async function loadGroundedHistory() {
    const context = project();
    const history = byId('grounded-history');
    if (!context.projectId || !history) return;
    try {
      state.ai = await window.electronAPI.loadProjectAIState(context.projectId);
      renderGroundedHistory();
    } catch (error) {
      history.replaceChildren(empty(`历史回答加载失败：${error.message || '请重试'}`));
    }
  }

  async function loadEvidence() {
    const context = project();
    const list = byId('grounded-evidence-list');
    if (!context.projectId || !list) return;
    try {
      const snapshot = await window.electronAPI.listEvidence(context.projectId);
      state.evidence = snapshot.items || [];
      const available = new Set(state.evidence.map(item => item.revision.id));
      state.selectedEvidenceIds.forEach(id => { if (!available.has(id)) state.selectedEvidenceIds.delete(id); });
      renderEvidenceChoices();
      if (state.ai) renderGroundedHistory();
    } catch (error) {
      list.replaceChildren(empty(`证据加载失败：${error.message || '请重试'}`));
    }
  }

  function selectedEvidence() {
    return state.evidence.filter(item => state.selectedEvidenceIds.has(item.revision.id));
  }

  function renderEvidenceChoices() {
    const list = byId('grounded-evidence-list');
    list.replaceChildren();
    const usable = state.evidence.filter(item => ['confirmed', 'proposed'].includes(item.reviewStatus));
    if (!usable.length) {
      list.appendChild(empty('证据箱中没有可用于问答的已确认或 AI 候选证据'));
      updateBudget();
      return;
    }
    usable.forEach(item => {
      const label = document.createElement('label');
      label.className = 'grounded-evidence-choice';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = item.revision.id;
      input.checked = state.selectedEvidenceIds.has(item.revision.id);
      input.addEventListener('change', () => {
        if (input.checked && state.selectedEvidenceIds.size >= 20) {
          input.checked = false;
          notify('一次最多选择 20 张证据');
          return;
        }
        if (input.checked) state.selectedEvidenceIds.add(item.revision.id);
        else state.selectedEvidenceIds.delete(item.revision.id);
        updateBudget();
      });
      const text = document.createElement('span');
      text.innerHTML = `<strong></strong><small></small><em></em>`;
      text.querySelector('strong').textContent = item.revision.sourceSnapshot.title;
      text.querySelector('small').textContent = `${item.revision.locator.pageLabel} · ${item.reviewStatus === 'proposed' ? 'AI 候选/未确认' : '用户已确认'}`;
      text.querySelector('em').textContent = item.revision.locator.quoteDisplay;
      label.append(input, text);
      list.appendChild(label);
    });
    updateBudget();
  }

  function updateBudget() {
    const selected = selectedEvidence();
    const characters = selected.reduce((sum, item) => sum + Array.from(item.revision.locator.quoteRaw).length, 0);
    byId('grounded-budget').textContent = `${selected.length}/20 张 · ${characters}/24000 字符`;
    byId('grounded-ask').disabled = !selected.length || characters > 24000;
  }

  function cancelActive() {
    if (!state.activeRequest) return;
    state.activeRequest.controller.abort();
    void window.electronAPI.cancelAIRequest({ requestId: state.activeRequest.requestId });
  }

  async function requestEvidenceParaphrase() {
    const evidence = selectedEvidence();
    if (evidence.length !== 1) return notify('AI 转述必须只选择一张证据');
    let selection;
    try { selection = await window.prepareEssayflowReviewSelection(); } catch (error) { return notify(error.message); }
    const source = evidence[0];
    if (selection.selectedText !== source.revision.locator.quoteRaw && selection.selectedText !== source.revision.locator.quoteDisplay) {
      return notify('请在正文中选中与该证据完全一致的引文文本');
    }
    const context = project();
    if (context.privacyMode !== 'local-only' && !window.confirm(`将发送一张证据用于转述：\n${source.revision.sourceSnapshot.title} · ${source.revision.locator.pageLabel}\n\n原文：\n${source.revision.locator.quoteDisplay}`)) return;
    try {
      const result = await window.electronAPI.requestAIReview({
        ...selection,
        operationMode: 'language',
        paraphrase: true,
        evidenceRevisionId: source.revision.id,
        requestId: crypto.randomUUID(),
        confirmed: true,
        contentRetention: context.privacyMode === 'normal' ? 'full' : 'metadata-only'
      });
      if (result.blocked) {
        window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
        throw new Error(result.reason);
      }
      window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      state.lastReviewResultEventId = result.resultEventId;
      setView('review');
      renderReviewIssues(result.issues);
      notify('AI 转述已生成 Diff；接受前正文未修改');
    } catch (error) {
      notify(`AI 转述失败：${error.message || '请重试'}`);
    }
  }

  async function askGrounded() {
    const context = project();
    const evidence = selectedEvidence();
    const question = byId('grounded-question').value.trim();
    if (!question || !evidence.length) return notify('请选择证据并输入问题');
    const characters = evidence.reduce((sum, item) => sum + Array.from(item.revision.locator.quoteRaw).length, 0);
    if (evidence.length > 20 || characters > 24000) return notify('证据范围超过上限，请手工缩减');
    const preview = {
      question,
      evidence: evidence.map((item, index) => ({
        token: `E${index + 1}`,
        title: item.revision.sourceSnapshot.title,
        pageLabel: item.revision.locator.pageLabel,
        quoteRaw: item.revision.locator.quoteRaw
      }))
    };
    if (context.privacyMode !== 'local-only' && !window.confirm(`将发送 ${evidence.length} 张证据、${characters} 个证据字符。\n\n实际证据 payload：\n${JSON.stringify(preview, null, 2)}`)) return;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    state.activeRequest = { requestId, controller };
    byId('grounded-stop').hidden = false;
    byId('grounded-ask').disabled = true;
    try {
      const result = await window.electronAPI.askGroundedAI({
        projectId: context.projectId,
        baseRevision: context.revision,
        question,
        evidenceRevisionIds: evidence.map(item => item.revision.id),
        requestId,
        confirmed: true,
        retryOnInvalid: true,
        contentRetention: context.privacyMode === 'normal' ? 'full' : 'metadata-only'
      });
      if (result.blocked) {
        window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
        throw new Error(result.reason);
      }
      window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      renderGroundedAnswer(result.answer);
      await loadGroundedHistory();
    } catch (error) {
      if (!controller.signal.aborted) notify(`有出处回答失败：${error.message || '请重试'}`);
    } finally {
      state.activeRequest = null;
      byId('grounded-stop').hidden = true;
      updateBudget();
    }
  }

  function renderGroundedAnswer(answer) {
    const results = byId('grounded-results');
    results.replaceChildren();
    const status = document.createElement('div');
    status.className = `grounded-answer-status status-${answer.status}`;
    status.textContent = answer.status === 'invalid' ? '响应格式无效，以下内容没有有效来源标签' : answer.status === 'partial' ? '部分回答' : '回答完成';
    results.appendChild(status);
    answer.segments.forEach(segment => {
      const article = document.createElement('article');
      article.className = `grounded-segment segment-${segment.kind}`;
      const badge = document.createElement('span');
      badge.className = 'grounded-kind';
      badge.textContent = segment.kind === 'sourced' ? '已关联来源' : segment.kind === 'inference' ? 'AI 推断' : '证据不足';
      const text = document.createElement('p');
      text.textContent = segment.text;
      article.append(badge, text);
      segment.sourceRefs.forEach(ref => {
        const snapshot = ref.sourceCitationSnapshot;
        const item = state.evidence.find(candidate => candidate.revision.id === ref.evidenceRevisionId);
        const card = state.evidence.find(candidate => candidate.card.id === ref.evidenceId);
        let laterState = '';
        if (!card) laterState = '来源后来已删除';
        else if (card.card.status === 'archived') laterState = '来源后来已归档';
        else if (card.revision.id !== ref.evidenceRevisionId || card.revision.locator.rawQuoteSha256 !== ref.rawQuoteSha256) laterState = '来源后来已变更';
        const review = item?.reviewStatus === 'proposed' ? 'AI 候选/未确认' : '';
        const source = button(`${snapshot.title} · ${snapshot.pageLabel}${review ? ` · ${review}` : ''}${laterState ? ` · ${laterState}` : ''}`, 'grounded-source');
        source.title = snapshot.quoteText || `原文 hash：${snapshot.rawQuoteSha256}`;
        source.dataset.historicalSourceState = laterState || 'active';
        if (item && !laterState) source.addEventListener('click', () => window.openEssayflowEvidenceSource?.(item));
        else source.disabled = true;
        article.appendChild(source);
      });
      results.appendChild(article);
    });
  }

  function renderGroundedHistory() {
    const history = byId('grounded-history');
    if (!history) return;
    history.replaceChildren();
    const answers = [...(state.ai?.groundedAnswers || [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (!answers.length) return history.appendChild(empty('当前项目还没有历史有出处回答'));
    answers.slice(0, 20).forEach(answer => {
      const section = document.createElement('section');
      section.className = 'grounded-history-entry';
      const heading = document.createElement('h4');
      heading.textContent = `${answer.question} · ${new Date(answer.createdAt).toLocaleString()}`;
      const content = document.createElement('div');
      content.className = 'grounded-results';
      section.append(heading, content);
      answer.segments.forEach(segment => {
        const article = document.createElement('article');
        article.className = `grounded-segment segment-${segment.kind}`;
        const badge = document.createElement('span');
        badge.className = 'grounded-kind';
        badge.textContent = segment.kind === 'sourced' ? '已关联来源' : segment.kind === 'inference' ? 'AI 推断' : '证据不足';
        const text = document.createElement('p');
        text.textContent = segment.text;
        article.append(badge, text);
        segment.sourceRefs.forEach(ref => {
          const snapshot = ref.sourceCitationSnapshot;
          const item = state.evidence.find(candidate => candidate.revision.id === ref.evidenceRevisionId);
          const card = state.evidence.find(candidate => candidate.card.id === ref.evidenceId);
          const laterState = !card ? '来源后来已删除'
            : card.card.status === 'archived' ? '来源后来已归档'
              : card.revision.id !== ref.evidenceRevisionId || card.revision.locator.rawQuoteSha256 !== ref.rawQuoteSha256 ? '来源后来已变更' : '';
          const source = button(`${snapshot.title} · ${snapshot.pageLabel}${laterState ? ` · ${laterState}` : ''}`, 'grounded-source');
          source.title = snapshot.quoteText || `原文 hash：${snapshot.rawQuoteSha256}`;
          source.dataset.historicalSourceState = laterState || 'active';
          if (item && !laterState) source.addEventListener('click', () => window.openEssayflowEvidenceSource?.(item));
          else source.disabled = true;
          article.appendChild(source);
        });
        content.appendChild(article);
      });
      history.appendChild(section);
    });
  }

  function buildReviewView() {
    const panel = document.querySelector('[data-trusted-ai-view="review"]');
    panel.innerHTML = `
      <div class="trusted-ai-view-head"><strong>选区审阅</strong><select id="review-mode" aria-label="审阅类型"><option value="language">语言</option><option value="structure">结构</option><option value="logic">逻辑</option><option value="terminology">术语</option><option value="citation-gap">引用缺口</option></select></div>
      <div class="trusted-ai-actions"><button id="review-stop" type="button" hidden>停止</button><button id="review-regenerate" type="button" hidden>重新生成</button><button id="review-reject-all" type="button" hidden>全部拒绝</button><button id="review-accept-all" type="button" class="primary" hidden>全部接受</button><button id="review-generate" type="button" class="primary">审阅当前选区</button></div>
      <div id="review-issues" class="review-issues"></div>`;
    byId('review-generate').addEventListener('click', () => void requestReview());
    byId('review-regenerate').addEventListener('click', () => void requestReview(state.lastReviewResultEventId));
    byId('review-stop').addEventListener('click', () => cancelActive());
    byId('review-reject-all').addEventListener('click', () => void decideReviewBatch('rejected'));
    byId('review-accept-all').addEventListener('click', () => void decideReviewBatch('accepted'));
  }

  async function requestReview(regeneratedFromResultEventId, options = {}) {
    let selection;
    try { selection = await window.prepareEssayflowReviewSelection(); } catch (error) { return notify(error.message); }
    const context = project();
    const mode = options.mode || byId('review-mode').value;
    const instruction = String(options.instruction || '').trim();
    if (context.privacyMode !== 'local-only' && !window.confirm(`将向 AI 发送当前选区（${Array.from(selection.selectedText).length} 字符），模式：${mode}。${instruction ? `\n指令：${instruction}` : ''}\n\n实际选区：\n${selection.selectedText}`)) return;
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    state.activeRequest = { requestId, controller };
    byId('review-stop').hidden = false;
    byId('review-generate').disabled = true;
    try {
      const result = await window.electronAPI.requestAIReview({
        ...selection,
        operationMode: mode,
        requestId,
        confirmed: true,
        contentRetention: context.privacyMode === 'normal' ? 'full' : 'metadata-only',
        ...(instruction ? { instruction } : {}),
        ...(regeneratedFromResultEventId ? { regeneratedFromResultEventId } : {})
      });
      if (result.blocked) {
        window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
        throw new Error(result.reason);
      }
      window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      state.lastReviewResultEventId = result.resultEventId;
      byId('review-regenerate').hidden = false;
      renderReviewIssues(result.issues);
    } catch (error) {
      if (!controller.signal.aborted) notify(`AI 审阅失败：${error.message || '请重试'}`);
    } finally {
      state.activeRequest = null;
      byId('review-stop').hidden = true;
      byId('review-generate').disabled = false;
    }
  }

  function diffNodes(original, suggested) {
    let prefix = 0;
    while (prefix < original.length && prefix < suggested.length && original[prefix] === suggested[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < original.length - prefix && suffix < suggested.length - prefix && original[original.length - 1 - suffix] === suggested[suggested.length - 1 - suffix]) suffix += 1;
    const fragment = document.createDocumentFragment();
    fragment.append(document.createTextNode(original.slice(0, prefix)));
    const removed = document.createElement('del');
    removed.textContent = original.slice(prefix, original.length - suffix);
    const inserted = document.createElement('ins');
    inserted.textContent = suggested.slice(prefix, suggested.length - suffix);
    fragment.append(removed, inserted, document.createTextNode(suffix ? original.slice(-suffix) : ''));
    return fragment;
  }

  function renderReviewIssues(issues) {
    const container = byId('review-issues');
    container.replaceChildren();
    state.reviewIssues = (issues || []).filter(issue => issue.status === 'proposed');
    if (byId('review-reject-all')) byId('review-reject-all').hidden = state.reviewIssues.length < 2;
    if (byId('review-accept-all')) byId('review-accept-all').hidden = state.reviewIssues.length < 2;
    if (!issues?.length) return container.appendChild(empty('没有修改建议'));
    issues.forEach(issue => {
      const article = document.createElement('article');
      article.className = `review-issue status-${issue.status}`;
      article.dataset.issueId = issue.id;
      const heading = document.createElement('div');
      heading.className = 'review-issue-heading';
      heading.textContent = `${issue.category} · ${issue.reason}`;
      const diff = document.createElement('div');
      diff.className = 'review-character-diff';
      diff.appendChild(diffNodes(issue.originalText, issue.suggestedText));
      const actions = document.createElement('div');
      actions.className = 'trusted-ai-actions';
      const reject = button('拒绝');
      const accept = button('接受', 'primary');
      reject.addEventListener('click', () => void decideReview(issue, 'rejected', article));
      accept.addEventListener('click', () => void decideReview(issue, 'accepted', article));
      actions.append(reject, accept);
      article.append(heading, diff, actions);
      container.appendChild(article);
    });
  }

  async function decideReviewBatch(decision) {
    const issues = [...state.reviewIssues];
    if (issues.length < 2) return notify('至少需要两条待处理建议');
    if (!window.confirm(`${decision === 'accepted' ? '批量接受' : '批量拒绝'} ${issues.length} 条建议？${decision === 'accepted' ? '接受前会创建一个版本检查点。' : ''}`)) return;
    const context = project();
    try {
      let payload = {
        projectId: context.projectId,
        baseRevision: context.revision,
        issueIds: issues.map(issue => issue.id),
        decision,
        contentRetention: context.privacyMode === 'normal' ? 'full' : 'metadata-only'
      };
      if (decision === 'accepted') {
        payload = { ...payload, ...(await window.prepareEssayflowReviewBatchAcceptance(issues)) };
      } else {
        payload.reason = 'user-batch-rejected';
      }
      const result = await window.electronAPI.decideAIReviewBatch(payload);
      if (decision === 'accepted') window.applyEssayflowAcceptedReviewBatch(issues, result.revision);
      else window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      await loadAiState();
      notify(decision === 'accepted' ? `已接受 ${issues.length} 条建议并创建检查点` : `已拒绝 ${issues.length} 条建议`);
    } catch (error) {
      notify(`批量审阅失败：${error.message || '请重新生成'}`);
      void loadAiState();
    }
  }

  async function decideReview(issue, decision, article) {
    const context = project();
    try {
      let payload = { projectId: context.projectId, baseRevision: context.revision, issueId: issue.id, decision };
      if (decision === 'accepted') {
        const prepared = window.prepareEssayflowReviewAcceptance(issue);
        payload = {
          ...payload,
          ...prepared,
          afterHash: await sha256Text(issue.suggestedText),
          contentRetention: context.privacyMode === 'normal' ? 'full' : 'metadata-only'
        };
      } else {
        payload.reason = 'user-rejected';
      }
      const result = await window.electronAPI.decideAIReview(payload);
      if (decision === 'accepted') window.applyEssayflowAcceptedReview(issue, result.revision);
      else window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      article.className = `review-issue status-${decision}`;
      article.querySelector('.trusted-ai-actions').replaceChildren(document.createTextNode(decision === 'accepted' ? '已接受并创建检查点' : '已拒绝'));
    } catch (error) {
      notify(`审阅决定失败：${error.message || '请重新生成'}`);
      void loadAiState();
    }
  }

  function buildAuditView() {
    const panel = document.querySelector('[data-trusted-ai-view="audit"]');
    panel.innerHTML = `
      <div class="trusted-ai-view-head"><strong>项目 AI 审计</strong><button id="audit-refresh" type="button">刷新</button></div>
      <div class="trusted-ai-actions audit-actions"><button id="audit-export-report" type="button">导出报告</button><button id="audit-export-json" type="button">导出 JSON</button><button id="audit-clear-chat" type="button">清除聊天视图</button><button id="audit-redact" type="button" class="danger">脱敏所选正文</button></div>
      <div id="audit-events" class="audit-events"></div>`;
    byId('audit-refresh').addEventListener('click', () => void loadAiState());
    byId('audit-export-json').addEventListener('click', () => void exportAudit('json'));
    byId('audit-export-report').addEventListener('click', () => void exportAudit('report'));
    byId('audit-clear-chat').addEventListener('click', () => void clearChat());
    byId('audit-redact').addEventListener('click', () => void redactAudit());
  }

  async function loadAiState() {
    const context = project();
    if (!context.projectId) return;
    try {
      state.ai = await window.electronAPI.loadProjectAIState(context.projectId);
      const latestProposed = [...(state.ai.reviewIssues || [])].reverse().find(issue => issue.status === 'proposed');
      state.lastReviewResultEventId = latestProposed?.auditResultId || null;
      if (byId('review-regenerate')) byId('review-regenerate').hidden = !state.lastReviewResultEventId;
      renderAudit();
      if (state.view === 'review') renderReviewIssues((state.ai.reviewIssues || []).filter(issue => issue.status === 'proposed'));
    } catch (error) {
      byId('audit-events')?.replaceChildren(empty(`审计加载失败：${error.message || '请重试'}`));
    }
  }

  function renderAudit() {
    const container = byId('audit-events');
    if (!container || !state.ai) return;
    container.replaceChildren();
    const blobs = new Map((state.ai.auditContentBlobs || []).map(blob => [blob.ownerEventId, blob]));
    const events = [...(state.ai.auditEvents || [])].sort((left, right) => right.sequence - left.sequence);
    if (!events.length) return container.appendChild(empty('当前项目还没有 AI 或远程学术操作'));
    events.forEach(event => {
      const row = document.createElement('article');
      row.className = `audit-event event-${event.eventType}`;
      const top = document.createElement('div');
      top.className = 'audit-event-top';
      const title = document.createElement('strong');
      title.textContent = `${event.sequence}. ${event.networkContext?.operation || event.eventType}`;
      const time = document.createElement('time');
      time.textContent = new Date(event.occurredAt).toLocaleString();
      top.append(title, time);
      const meta = document.createElement('div');
      meta.className = 'audit-event-meta';
      meta.textContent = [event.eventType, event.networkContext?.provider?.origin, event.networkContext?.provider?.model, event.networkContext?.networkDecision].filter(Boolean).join(' · ');
      row.append(top, meta);
      const blob = blobs.get(event.eventId);
      if (blob) {
        const label = document.createElement('label');
        label.className = 'audit-blob-choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = blob.blobId;
        const summary = document.createElement('span');
        summary.textContent = `${blob.kind} · ${blob.byteCount} bytes · ${blob.sha256.slice(0, 12)}`;
        label.append(input, summary);
        row.appendChild(label);
      }
      container.appendChild(row);
    });
  }

  function downloadText(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportAudit(format) {
    const context = project();
    try {
      const audit = await window.electronAPI.exportProjectAudit({ projectId: context.projectId, includeContent: false });
      if (format === 'json') {
        downloadText(`EssayFlow-audit-${context.projectId}.json`, 'application/json', JSON.stringify(audit, null, 2));
        return;
      }
      downloadText(`EssayFlow-audit-${context.projectId}.md`, 'text/markdown', audit.humanReportMarkdown);
    } catch (error) { notify(`审计导出失败：${error.message || '请重试'}`); }
  }

  async function clearChat() {
    const context = project();
    if (!window.confirm('清除聊天视图会删除项目 thread/message 和 GroundedAnswer；AuditEvent 及其中仍保留的 prompt/output 不会一并删除。继续吗？')) return;
    try {
      const result = await window.electronAPI.clearProjectChat({ projectId: context.projectId, baseRevision: context.revision });
      window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      await window.restoreProjectChatState?.(context.projectId);
      await loadAiState();
      notify(result.auditContentRemains ? '聊天视图已清除，审计正文仍保留' : '聊天视图已清除');
    } catch (error) { notify(`清除失败：${error.message || '请重试'}`); }
  }

  async function redactAudit() {
    const context = project();
    const blobIds = [...document.querySelectorAll('#audit-events .audit-blob-choice input:checked')].map(input => input.value);
    if (!blobIds.length) return notify('请选择需要脱敏的审计正文');
    const managedBackups = state.ai?.managedBackups || [];
    if (!window.confirm(`将删除 ${blobIds.length} 个受管审计正文 blob，并追加不可变 redaction tombstone。\n\n处理范围：当前 active profile；已知应用受管备份 ${managedBackups.length} 个。以后新导出的包不会包含目标 blob。用户自行保存、复制或发送到应用管理范围外的旧 .essayflow/备份无法撤回或擦除。\n\n确认继续吗？`)) return;
    try {
      const result = await window.electronAPI.redactProjectAudit({
        projectId: context.projectId,
        baseRevision: context.revision,
        blobIds,
        scope: 'all',
        reason: 'user-request'
      });
      window.applyEssayflowProjectRevision?.(context.projectId, result.revision);
      await loadAiState();
      notify(`已脱敏 ${result.removedBlobCount} 个审计正文`);
    } catch (error) { notify(`脱敏失败：${error.message || '请重试'}`); }
  }

  window.addEventListener('essayflow-project-loaded', () => {
    state.selectedEvidenceIds.clear();
    state.evidence = [];
    state.ai = null;
    syncProject();
    if (state.view !== 'chat') setView(state.view);
  });
  window.requestEssayflowReviewForSelection = async options => {
    const panel = byId('ai-chat-panel');
    if (panel) panel.style.display = 'flex';
    setView('review');
    return requestReview(null, options || {});
  };
  window.addEventListener('DOMContentLoaded', installShell);
})();
