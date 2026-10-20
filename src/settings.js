// ================== 设置面板 ==================
let settingsPanel = null;
let currentSettingsTab = 'general';
let aiConfigSaveTimer = null;
let aiConfigSaveVersion = 0;
let managedSettingsQueue = Promise.resolve();
let settingsFocusOrigin = null;

function readManagedSettings() {
  return window.essayflowDataState?.settings || {};
}

function updateManagedSettings(patchOrFactory) {
  managedSettingsQueue = managedSettingsQueue.catch(() => {}).then(async () => {
    if (!window.electronAPI?.updateExportableSettings) return readManagedSettings();
    const patch = typeof patchOrFactory === 'function'
      ? patchOrFactory(readManagedSettings())
      : patchOrFactory;
    const result = await window.electronAPI.updateExportableSettings(patch);
    if (!result?.success || !result.settings) throw new Error('设置未获得持久化确认');
    window.essayflowDataState.settings = result.settings;
    return result.settings;
  }).catch(error => {
    console.error('[settings] 设置保存失败:', error);
    window.showToast?.(`设置保存失败：${error.message || '请重试'}`);
    throw error;
  });
  return managedSettingsQueue;
}

function updateManagedFeatureToggle(id, enabled) {
  return updateManagedSettings(settings => ({
    featureToggles: { ...(settings.featureToggles || {}), [id]: enabled === true }
  }));
}

function scheduleAIConfigSave() {
  clearTimeout(aiConfigSaveTimer);
  aiConfigSaveTimer = setTimeout(() => {
    aiConfigSaveTimer = null;
    void saveAIConfig();
  }, 250);
}

async function initSettings() {
  await window.essayflowDataReady;
  settingsPanel = document.getElementById('settings-panel');
  const btnSettings = document.getElementById('btn-settings');

  if (btnSettings) {
    btnSettings.addEventListener('click', () => openSettings());
  }

  if (settingsPanel) {
    // 关闭按钮
    const closeBtn = settingsPanel.querySelector('.settings-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);

    // 点击遮罩关闭
    const overlay = settingsPanel.querySelector('.settings-overlay');
    if (overlay) overlay.addEventListener('click', closeSettings);

    // 键盘关闭与焦点约束（录制快捷键时保留 Esc 给录制器）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && settingsPanel.classList.contains('open') && !window._recordingShortcut) {
        closeSettings();
        return;
      }
      if (e.key === 'Tab' && settingsPanel.classList.contains('open')) {
        const focusable = [...settingsPanel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          .filter(element => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    // 标签切换
    settingsPanel.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        switchSettingsTab(tabName);
      });
      tab.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...settingsPanel.querySelectorAll('.settings-tab')];
        const currentIndex = tabs.indexOf(tab);
        let nextIndex = currentIndex;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabs.length - 1;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        event.preventDefault();
        switchSettingsTab(tabs[nextIndex].dataset.tab);
        tabs[nextIndex].focus();
      });
    });

    // AI 提供商切换
    const providerSelect = document.getElementById('ai-provider');
    if (providerSelect) {
      providerSelect.addEventListener('change', () => {
        fillAIProviderDefaults(providerSelect.value);
      });
    }

    // 密码可见性切换
    const toggleKeyBtn = document.getElementById('ai-toggle-key');
    if (toggleKeyBtn) {
      toggleKeyBtn.addEventListener('click', () => {
        const keyInput = document.getElementById('ai-api-key');
        if (keyInput) {
          keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
        }
      });
    }

    // 测试连接
    const testBtn = document.getElementById('ai-test-connection');
    if (testBtn) {
      testBtn.addEventListener('click', testAIConnection);
    }

    // 保存配置（输入时防抖，避免每次按键都触发系统加密 IPC）
    ['ai-base-url', 'ai-api-key', 'ai-model'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', scheduleAIConfigSave);
        el.addEventListener('change', () => {
          clearTimeout(aiConfigSaveTimer);
          aiConfigSaveTimer = null;
          void saveAIConfig();
        });
      }
    });
    if (providerSelect) {
      providerSelect.addEventListener('change', () => void saveAIConfig());
    }

    // 搜索开关
    const searchToggle = document.getElementById('ai-search-toggle');
    if (searchToggle) {
      searchToggle.addEventListener('change', () => {
        void updateManagedFeatureToggle('aiSearch', searchToggle.checked);
        updateSearchToggleState();
      });
    }

    // AI 识别文献信息开关
    const literatureToggle = document.getElementById('ai-literature-toggle');
    if (literatureToggle) {
      literatureToggle.addEventListener('change', () => {
        void updateManagedFeatureToggle('aiLiterature', literatureToggle.checked);
        updateLiteratureToggleState();
      });
    }

    // AI 文献验证开关
    const verifyToggle = document.getElementById('ai-verify-toggle');
    if (verifyToggle) {
      verifyToggle.addEventListener('change', () => {
        void updateManagedFeatureToggle('aiVerify', verifyToggle.checked);
      });
    }

    // 默认引用格式
    const refStyleSelect = document.getElementById('default-reference-style');
    if (refStyleSelect) {
      refStyleSelect.addEventListener('change', () => {
        void updateManagedSettings({ defaultReferenceStyle: refStyleSelect.value });
      });
    }

    // 浮窗自动关闭开关
    const toolbarAutocloseToggle = document.getElementById('toolbar-autoclose-toggle');
    if (toolbarAutocloseToggle) {
      toolbarAutocloseToggle.addEventListener('change', () => {
        localStorage.setItem('essay_toolbar_autoclose', toolbarAutocloseToggle.checked ? 'true' : 'false');
      });
    }

    // 论文来源配置展开/折叠
    const sourceConfigToggle = document.getElementById('source-config-toggle');
    const sourceConfigBody = document.getElementById('source-config-body');
    if (sourceConfigToggle && sourceConfigBody) {
      sourceConfigToggle.addEventListener('click', () => {
        const isOpen = sourceConfigBody.style.display !== 'none';
        sourceConfigBody.style.display = isOpen ? 'none' : 'block';
        const arrow = sourceConfigToggle.querySelector('.source-config-arrow');
        if (arrow) arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
      });
    }

    // 添加来源按钮
    const sourceAddBtn = document.getElementById('source-add-btn');
    if (sourceAddBtn) {
      sourceAddBtn.addEventListener('click', () => openSourceModal());
    }

    // 浮窗关闭
    const sourceModalClose = document.getElementById('source-modal-close');
    const sourceModalCancel = document.getElementById('source-modal-cancel');
    const sourceModalOverlay = document.querySelector('.source-modal-overlay');
    if (sourceModalClose) sourceModalClose.addEventListener('click', closeSourceModal);
    if (sourceModalCancel) sourceModalCancel.addEventListener('click', closeSourceModal);
    if (sourceModalOverlay) sourceModalOverlay.addEventListener('click', closeSourceModal);

    // 浮窗保存
    const sourceModalSave = document.getElementById('source-modal-save');
    if (sourceModalSave) sourceModalSave.addEventListener('click', saveSourceModal);

    // 删除确认
    const sourceDeleteCancel = document.getElementById('source-delete-cancel');
    const sourceDeleteConfirmBtn = document.getElementById('source-delete-confirm-btn');
    const sourceDeleteOverlay = document.querySelector('.source-delete-overlay');
    if (sourceDeleteCancel) sourceDeleteCancel.addEventListener('click', closeDeleteConfirm);
    if (sourceDeleteConfirmBtn) sourceDeleteConfirmBtn.addEventListener('click', confirmDeleteSource);
    if (sourceDeleteOverlay) sourceDeleteOverlay.addEventListener('click', closeDeleteConfirm);
  }

  loadAIConfig();
  loadSearchSettings();
  loadLiteratureSettings();
  loadVerifySettings();
  loadDefaultReferenceStyle();
  loadToolbarAutocloseSettings();
  loadSearchSources();
  initShortcutsSettings();
}

function loadToolbarAutocloseSettings() {
  const enabled = localStorage.getItem('essay_toolbar_autoclose') === 'true';
  const toggle = document.getElementById('toolbar-autoclose-toggle');
  if (toggle) toggle.checked = enabled;
}

function openSettings(tab) {
  if (!settingsPanel) return;
  if (!settingsPanel.classList.contains('open')) settingsFocusOrigin = document.activeElement;
  settingsPanel.setAttribute('aria-hidden', 'false');
  settingsPanel.style.display = 'flex';
  switchSettingsTab(tab || currentSettingsTab);
  document.body.classList.add('dialog-open');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    settingsPanel.classList.add('open');
    settingsPanel.querySelector('.settings-tab.active')?.focus({ preventScroll: true });
  }));
}

function closeSettings() {
  if (!settingsPanel) return;
  if (typeof window._cancelShortcutRecording === 'function') {
    window._cancelShortcutRecording();
  }
  clearTimeout(aiConfigSaveTimer);
  aiConfigSaveTimer = null;
  void saveAIConfig();
  settingsPanel.classList.remove('open');
  settingsPanel.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (!settingsPanel.classList.contains('open')) {
      settingsPanel.style.display = 'none';
      if (!document.querySelector('.modal.open, .settings-panel.open, .source-modal.open')) {
        document.body.classList.remove('dialog-open');
      }
      if (settingsFocusOrigin?.isConnected && typeof settingsFocusOrigin.focus === 'function') {
        settingsFocusOrigin.focus({ preventScroll: true });
      }
    }
  }, 380);
}

function switchSettingsTab(tabName) {
  if (tabName !== currentSettingsTab && typeof window._cancelShortcutRecording === 'function') {
    window._cancelShortcutRecording();
  }
  currentSettingsTab = tabName;

  settingsPanel.querySelectorAll('.settings-tab').forEach(t => {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    t.tabIndex = isActive ? 0 : -1;
  });

  settingsPanel.querySelectorAll('.settings-section').forEach(s => {
    s.style.display = s.dataset.section === tabName ? 'block' : 'none';
  });

  const activeTab = settingsPanel.querySelector(`.settings-tab[data-tab="${tabName}"]`);
  const title = document.getElementById('settings-page-title');
  const description = document.getElementById('settings-page-description');
  if (title) title.textContent = activeTab?.dataset.title || '设置';
  if (description) description.textContent = activeTab?.dataset.description || '';
  settingsPanel.querySelector('.settings-body')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function fillAIProviderDefaults(provider) {
  const baseUrlInput = document.getElementById('ai-base-url');
  const modelInput = document.getElementById('ai-model');

  if (!baseUrlInput || !modelInput) return;

  if (provider === 'deepseek') {
    baseUrlInput.value = 'https://api.deepseek.com/v1';
    modelInput.value = 'deepseek-chat';
  } else if (provider === 'kimi') {
    baseUrlInput.value = 'https://api.moonshot.cn/v1';
    modelInput.value = 'moonshot-v1-8k';
  } else if (provider === 'custom') {
    baseUrlInput.value = '';
    modelInput.value = '';
  }
}

async function saveAIConfig() {
  const saveVersion = ++aiConfigSaveVersion;
  const provider = document.getElementById('ai-provider')?.value || 'custom';
  const baseUrl = (document.getElementById('ai-base-url')?.value?.trim() || '').replace(/\/+$/, '');
  const secretValue = document.getElementById('ai-api-key')?.value?.trim() || '';
  const model = document.getElementById('ai-model')?.value?.trim() || '';

  let providerOrigin = '';
  try {
    providerOrigin = baseUrl ? new URL(baseUrl).origin : '';
  } catch (error) {
    window.showToast?.('AI API 地址格式无效');
    return null;
  }

  if (saveVersion !== aiConfigSaveVersion) return null;
  try {
    if (providerOrigin && model) {
      await updateManagedSettings({ providerId: provider, providerOrigin, model });
    }
    if (secretValue) {
      const credential = await window.electronAPI?.setProviderCredential?.({ providerId: provider, value: secretValue });
      if (credential?.credentialStatus !== 'configured') throw new Error('API Key 未写入系统安全存储');
    }
  } catch (error) {
    console.error('[saveAIConfig] 配置保存失败:', error);
    window.showToast?.(`AI 配置保存失败：${error.message || '请重试'}`);
    return null;
  }
  let status = null;
  try { status = await window.electronAPI?.getProviderCredentialStatus?.(provider); } catch (_) {}
  window._aiCredentialConfigured = status?.credentialStatus === 'configured';
  window._aiKeyDecryptionFailed = false;
  const keyInput = document.getElementById('ai-api-key');
  if (keyInput && secretValue) {
    keyInput.value = '';
    keyInput.placeholder = '已保存到系统安全存储；留空表示保持不变';
  }
  updateSearchToggleState();
  updateLiteratureToggleState();
  updateVerifyToggleState();
  return { provider, base_url: baseUrl, credential: window._aiCredentialConfigured ? '__managed__' : '', model, encryption: 'managed' };
}

async function loadAIConfig() {
  await window.essayflowDataReady;
  const settings = readManagedSettings();
  const provider = settings.providerId || 'custom';
  const config = getAIConfig();

  const providerSelect = document.getElementById('ai-provider');
  const baseUrlInput = document.getElementById('ai-base-url');
  const keyInput = document.getElementById('ai-api-key');
  const modelInput = document.getElementById('ai-model');

  if (providerSelect) providerSelect.value = provider;
  if (baseUrlInput) baseUrlInput.value = config?.base_url || '';

  try {
    const status = await window.electronAPI?.getProviderCredentialStatus?.(provider);
    window._aiCredentialConfigured = status?.credentialStatus === 'configured';
  } catch (error) {
    console.warn('[loadAIConfig] API Key 状态读取失败:', error);
    window._aiCredentialConfigured = false;
  }
  window._aiKeyDecryptionFailed = false;
  if (keyInput) {
    keyInput.value = '';
    keyInput.placeholder = window._aiCredentialConfigured
      ? '已保存到系统安全存储；留空表示保持不变'
      : '输入 API Key';
  }

  if (modelInput) modelInput.value = config?.model || '';
  updateSearchToggleState();
  updateLiteratureToggleState();
  updateVerifyToggleState();
}

async function testAIConnection() {
  clearTimeout(aiConfigSaveTimer);
  aiConfigSaveTimer = null;
  const config = await saveAIConfig();
  if (!config || !config.base_url || !config.credential || !config.model) {
    window.showToast('请先填写完整的 AI 配置');
    return;
  }

  try {
    const parsedUrl = new URL(config.base_url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error();
  } catch (e) {
    window.showToast('API 地址格式无效，仅支持 HTTP 或 HTTPS');
    return;
  }

  const testBtn = document.getElementById('ai-test-connection');
  if (!testBtn) return;
  const originalText = testBtn.textContent;
  testBtn.textContent = '测试中...';
  testBtn.disabled = true;

  let lastError = null;
  const messages = [
    { role: 'user', content: 'Hello' }
  ];

  let result = null;
  try {
    result = await requestAI(messages, null, (err) => {
      lastError = err;
      console.error('[TestConnection] 失败:', err);
    }, null, null, { operation: 'chat', promptTemplateVersion: 'provider-test-v1' });
  } finally {
    testBtn.textContent = originalText;
    testBtn.disabled = false;
  }

  const toast = document.getElementById('toast');
  if (!toast) return;

  if (result !== null) {
    window.showToast('API 连接成功');
    return;
  }

  // 根据状态码给出具体诊断
  let msg = 'API 连接失败';
  if (lastError) {
    const status = lastError.status;
    const errMsg = lastError.message || '';
    if (status === 401 || status === 403 || errMsg.toLowerCase().includes('invalid authentication') || errMsg.toLowerCase().includes('unauthorized')) {
      msg = 'API Key 无效：服务器拒绝了您的认证信息。请检查是否复制了完整的 API Key（通常以 sk- 开头），并确认该 Key 在当前平台已启用。';
    } else if (status === 400 && /model/i.test(errMsg)) {
      msg = '模型名称无效：请确认该模型已在当前 API 服务中启用。';
    } else if (status === 404) {
      msg = 'API 地址错误 (404)：请检查 Base URL 是否正确。Kimi 应为 https://api.moonshot.cn/v1，DeepSeek 应为 https://api.deepseek.com/v1';
    } else if (status === 429) {
      msg = '请求过于频繁 (429)：请稍后再试，或检查账户额度。';
    } else if (status >= 500) {
      msg = 'AI 服务端暂时不可用 (' + status + ')，请稍后再试。';
    } else if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
      msg = '网络连接失败：无法连接到 ' + config.base_url + '，请检查网络或代理设置。';
    } else {
      msg = 'API 连接失败：' + (errMsg.substring(0, 120) || '未知错误');
    }
  }

  toast.textContent = msg;
  toast.classList.add('show', 'error');
  toast.style.whiteSpace = 'normal';
  toast.style.maxWidth = '480px';
  toast.style.textAlign = 'center';
  setTimeout(() => {
    toast.classList.remove('show', 'error');
    toast.style.whiteSpace = '';
    toast.style.maxWidth = '';
    toast.style.textAlign = '';
  }, 5000);
}

function loadSearchSettings() {
  const enabled = readManagedSettings().featureToggles?.aiSearch === true;
  const toggle = document.getElementById('ai-search-toggle');
  if (toggle) toggle.checked = enabled;
  updateSearchToggleState();
}

function updateSearchToggleState() {
  updateAIConfigToggleState('ai-search-toggle', 'essay_ai_search_enabled');
}

function loadLiteratureSettings() {
  const enabled = readManagedSettings().featureToggles?.aiLiterature === true;
  const toggle = document.getElementById('ai-literature-toggle');
  if (toggle) toggle.checked = enabled;
  updateLiteratureToggleState();
}

function updateLiteratureToggleState() {
  updateAIConfigToggleState('ai-literature-toggle', 'essay_ai_literature_enabled');
}

function loadVerifySettings() {
  const enabled = readManagedSettings().featureToggles?.aiVerify === true;
  const toggle = document.getElementById('ai-verify-toggle');
  if (toggle) toggle.checked = enabled;
  updateVerifyToggleState();
}

function updateVerifyToggleState() {
  updateAIConfigToggleState('ai-verify-toggle', 'essay_ai_verify_enabled');
}

function hasCompleteAIConfig() {
  const config = getAIConfig();
  if (!config?.base_url || !config.credential || !config.model || window._aiKeyDecryptionFailed) return false;
  try {
    const parsed = new URL(config.base_url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function updateAIConfigToggleState(toggleId, storageKey) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  const enabled = hasCompleteAIConfig();
  toggle.disabled = !enabled;
  const toggleIdByStorageKey = {
    essay_ai_search_enabled: 'aiSearch',
    essay_ai_literature_enabled: 'aiLiterature',
    essay_ai_verify_enabled: 'aiVerify'
  };
  toggle.checked = enabled && readManagedSettings().featureToggles?.[toggleIdByStorageKey[storageKey]] === true;
}

function loadDefaultReferenceStyle() {
  const saved = getDefaultReferenceStyle();
  const select = document.getElementById('default-reference-style');
  if (select) select.value = saved;
}

function getDefaultReferenceStyle() {
  const saved = readManagedSettings().defaultReferenceStyle;
  return ['APA', 'MLA', 'Chicago', 'IEEE', 'Harvard', 'GB/T'].includes(saved) ? saved : 'MLA';
}

// ================== 初始化 ==================
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    initSettings();
  }, 600);
});


// ================== 论文来源管理 ==================
const DEFAULT_SOURCES = [
  { id: 'arxiv', name: 'arXiv', type: 'builtin', enabled: true },
  { id: 'semantic_scholar', name: 'Semantic Scholar', type: 'builtin', enabled: true },
  { id: 'crossref', name: 'Crossref', type: 'builtin', enabled: true },
  { id: 'core', name: 'CORE', type: 'builtin', enabled: true },
  { id: 'openalex', name: 'OpenAlex', type: 'builtin', enabled: true }
];

function getManagedSearchSources() {
  const settings = readManagedSettings();
  const enabledIds = new Set(Array.isArray(settings.enabledSearchSourceIds)
    ? settings.enabledSearchSourceIds
    : DEFAULT_SOURCES.filter(source => source.enabled).map(source => source.id));
  const builtins = DEFAULT_SOURCES.map(source => ({ ...source, enabled: enabledIds.has(source.id) }));
  const custom = Array.isArray(settings.customSearchSources)
    ? settings.customSearchSources.map(source => ({
        id: source.id,
        name: source.name,
        type: 'custom',
        url: source.url,
        enabled: source.enabled !== false
      }))
    : [];
  return [...builtins, ...custom];
}
async function saveSearchSources(sources) {
  const sanitized = sources.map(source => {
    const copy = { ...source };
    delete copy['api' + 'Key'];
    return copy;
  });
  try {
    return await updateManagedSettings({
      enabledSearchSourceIds: sanitized.filter(source => source.enabled !== false).map(source => source.id),
      customSearchSources: sanitized.filter(source => source.type === 'custom').map(source => ({
        id: source.id,
        name: source.name,
        url: source.url,
        enabled: source.enabled !== false
      }))
    });
  } catch (error) {
    console.error('[SearchSources] 来源配置保存失败:', error);
    window.showToast?.('论文来源保存失败');
    throw error;
  }
}

async function loadSearchSources() {
  // 迁移旧配置：补齐新增内置来源，同时保留自定义来源与启用状态。
  try { await saveSearchSources(getManagedSearchSources()); } catch (_) {}
  renderSourceList();
}

function escapeSettingsHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renderSourceList() {
  const listEl = document.getElementById('source-list');
  if (!listEl) return;
  const sources = getManagedSearchSources();
  listEl.innerHTML = sources.map(source => `
    <div class="source-item" data-id="${escapeSettingsHtml(source.id)}">
      <label class="source-checkbox-wrapper">
        <input type="checkbox" class="source-checkbox" ${source.enabled ? 'checked' : ''}>
        <span class="source-name">${escapeSettingsHtml(source.name)}</span>
      </label>
      ${source.type === 'custom' ? `
        <button class="source-delete-btn source-edit-btn" type="button" data-id="${escapeSettingsHtml(source.id)}" title="编辑" aria-label="编辑 ${escapeSettingsHtml(source.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
          </svg>
        </button>
        <button class="source-delete-btn" type="button" data-id="${escapeSettingsHtml(source.id)}" title="删除" aria-label="删除 ${escapeSettingsHtml(source.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      ` : ''}
    </div>
  `).join('');

  // 绑定 checkbox 事件
  listEl.querySelectorAll('.source-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const id = e.target.closest('.source-item').dataset.id;
      const allSources = getManagedSearchSources();
      const source = allSources.find(s => s.id === id);
      if (source) {
        source.enabled = e.target.checked;
        try { await saveSearchSources(allSources); } catch (_) { e.target.checked = !e.target.checked; }
      }
    });
  });

  // 绑定编辑、删除按钮事件
  listEl.querySelectorAll('.source-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSourceModal(btn.dataset.id);
    });
  });

  listEl.querySelectorAll('.source-delete-btn:not(.source-edit-btn)').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      showDeleteConfirm(id);
    });
  });
}

let editingSourceId = null;
let deletingSourceId = null;

function openSourceModal(sourceId) {
  editingSourceId = sourceId || null;
  const modal = document.getElementById('source-modal');
  const titleEl = document.getElementById('source-modal-title');
  const nameInput = document.getElementById('source-modal-name');
  const urlInput = document.getElementById('source-modal-url');
  const keyInput = document.getElementById('source-modal-key');

  if (!modal) return;

  if (editingSourceId) {
    const sources = getManagedSearchSources();
    const source = sources.find(s => s.id === editingSourceId);
    if (source) {
      titleEl.textContent = '编辑来源';
      nameInput.value = source.name || '';
      urlInput.value = source.url || '';
      keyInput.value = '';
      keyInput.placeholder = '已保存的 Key 不会回传；留空表示保持不变';
    }
  } else {
    titleEl.textContent = '添加来源';
    nameInput.value = '';
    urlInput.value = '';
    keyInput.value = '';
  }

  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}

function closeSourceModal() {
  const modal = document.getElementById('source-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
  editingSourceId = null;
}

async function saveSourceModal() {
  const nameInput = document.getElementById('source-modal-name');
  const urlInput = document.getElementById('source-modal-url');
  const keyInput = document.getElementById('source-modal-key');

  const name = nameInput?.value?.trim() || '';
  const url = urlInput?.value?.trim() || '';
  const key = keyInput?.value?.trim() || '';

  if (!name || !url) {
    if (typeof window.showToast === 'function') window.showToast('请填写来源名称和 API URL');
    return;
  }

  if (name.length > 80 || url.length > 2048 || key.length > 4096) {
    if (typeof window.showToast === 'function') window.showToast('来源名称、URL 或 API Key 过长');
    return;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error();
  } catch (e) {
    if (typeof window.showToast === 'function') window.showToast('API URL 必须是不含凭据和片段的 HTTPS 地址');
    return;
  }

  const sources = getManagedSearchSources();
  const duplicate = sources.some(source => source.type === 'custom'
    && source.id !== editingSourceId
    && source.url.replace(/\/+$/, '').toLowerCase() === url.replace(/\/+$/, '').toLowerCase());
  if (duplicate) {
    if (typeof window.showToast === 'function') window.showToast('该 API URL 已添加');
    return;
  }

  if (editingSourceId) {
    const source = sources.find(s => s.id === editingSourceId);
    if (source) {
      source.name = name;
      source.url = url;
    }
  } else {
    editingSourceId = 'custom_' + Date.now();
    sources.push({
      id: editingSourceId,
      name,
      type: 'custom',
      url,
      enabled: true
    });
  }

  if (key) {
    try {
      const result = await window.electronAPI?.setProviderCredential?.({
        providerId: `search-source:${editingSourceId}`,
        value: key
      });
      if (result?.credentialStatus !== 'configured') throw new Error('来源 Key 未写入系统安全存储');
    } catch (error) {
      window.showToast?.(`来源 Key 保存失败：${error.message || '请重试'}`);
      return;
    }
  }

  try {
    await saveSearchSources(sources);
  } catch (_) {
    return;
  }
  renderSourceList();
  closeSourceModal();
  if (typeof window.showToast === 'function') window.showToast('来源已保存');
}

function showDeleteConfirm(id) {
  deletingSourceId = id;
  const confirmEl = document.getElementById('source-delete-confirm');
  if (confirmEl) {
    confirmEl.style.display = 'flex';
    confirmEl.setAttribute('aria-hidden', 'false');
  }
}

function closeDeleteConfirm() {
  const confirmEl = document.getElementById('source-delete-confirm');
  if (confirmEl) {
    confirmEl.style.display = 'none';
    confirmEl.setAttribute('aria-hidden', 'true');
  }
  deletingSourceId = null;
}

async function confirmDeleteSource() {
  if (deletingSourceId) {
    const sourceId = deletingSourceId;
    try {
      await window.electronAPI?.removeProviderCredential?.(`search-source:${sourceId}`);
      const sources = getManagedSearchSources().filter(s => s.id !== sourceId);
      await saveSearchSources(sources);
      renderSourceList();
      if (typeof window.showToast === 'function') window.showToast('来源与对应凭据已删除');
    } catch (error) {
      window.showToast?.(`来源删除失败：${error.message || '请重试'}`);
      return;
    }
  }
  closeDeleteConfirm();
}


// ================== 快捷键设置 ==================
const DEFAULT_SHORTCUTS = [
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

let _shortcutConflicts = new Set();

function getShortcuts() {
  const stored = localStorage.getItem('essay_shortcuts');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 合并默认值，防止新增功能后旧配置缺失
        const map = new Map(parsed.map(s => [s.id, s]));
        return DEFAULT_SHORTCUTS.map(def => {
          const saved = map.get(def.id);
          return saved
            ? {
                ...def,
                key: typeof saved.key === 'string' ? normalizeKeyForStorage(saved.key) : def.defaultKey,
                enabled: saved.enabled !== false
              }
            : { ...def };
        });
      }
    } catch (e) {
      console.error('[Shortcuts] 读取配置失败:', e);
    }
  }
  return DEFAULT_SHORTCUTS.map(s => ({ ...s }));
}

function saveShortcuts(shortcuts) {
  const normalized = Array.isArray(shortcuts) ? shortcuts.map(shortcut => ({
    ...shortcut,
    key: typeof shortcut.key === 'string' ? normalizeKeyForStorage(shortcut.key) : shortcut.key,
    enabled: shortcut.enabled !== false
  })) : [];
  localStorage.setItem('essay_shortcuts', JSON.stringify(normalized));
  if (typeof window.rebindShortcuts === 'function') {
    window.rebindShortcuts();
  }
}

function normalizeKeyForStorage(key) {
  if (!key) return key;
  const tokens = String(key).trim().split(/\s*\+\s*/).filter(Boolean);
  if (tokens.length === 0) return '';

  let mainKey = tokens.pop();
  const modifiers = new Set(tokens.map(token => {
    if (/^(command|cmd|meta|control|ctrl)$/i.test(token)) return 'Ctrl';
    if (/^(option|alt)$/i.test(token)) return 'Alt';
    if (/^shift$/i.test(token)) return 'Shift';
    return token;
  }));
  if (/^control$/i.test(mainKey)) mainKey = 'Ctrl';
  else if (/^(command|cmd|meta)$/i.test(mainKey)) mainKey = 'Ctrl';
  else if (/^option$/i.test(mainKey)) mainKey = 'Alt';
  else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();

  const ordered = ['Ctrl', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier));
  return [...ordered, mainKey].join('+');
}

function displayShortcut(str) {
  if (!str) return '点击设置';
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const labels = {
    Ctrl: isMac ? '⌘' : 'Ctrl',
    Alt: isMac ? '⌥' : 'Alt',
    Shift: isMac ? '⇧' : 'Shift',
    Plus: '+',
    Minus: '-',
    Equal: '='
  };
  return String(str).split('+').map(part => labels[part] || part).join(' + ');
}

function findConflicts(shortcuts) {
  const conflicts = new Set();
  const enabled = shortcuts.filter(s => s.enabled && s.key);
  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      if (normalizeKeyForStorage(enabled[i].key) === normalizeKeyForStorage(enabled[j].key)) {
        conflicts.add(enabled[i].id);
        conflicts.add(enabled[j].id);
      }
    }
  }
  return conflicts;
}

function getConflictMessage(shortcut, shortcuts, conflicts) {
  if (!conflicts.has(shortcut.id)) return '';
  const key = normalizeKeyForStorage(shortcut.key);
  const others = shortcuts.filter(s => s.id !== shortcut.id && s.enabled && normalizeKeyForStorage(s.key) === key);
  if (others.length === 0) return '';
  const names = others.map(s => `「${s.name}」`).join('、');
  return `与 ${names} 快捷键冲突`;
}

function initShortcutsSettings() {
  // 先落盘规范化结果，让 app.js 的快捷键匹配与设置页冲突检测使用同一格式。
  saveShortcuts(getShortcuts());
  renderShortcutsList();
  renderShortcutsSpecialList();
}

function renderShortcutsList() {
  const container = document.getElementById('shortcuts-list');
  if (!container) return;

  const shortcuts = getShortcuts();
  _shortcutConflicts = findConflicts(shortcuts);

  container.innerHTML = shortcuts.map(s => {
    const conflictMsg = getConflictMessage(s, shortcuts, _shortcutConflicts);
    const conflictClass = conflictMsg ? ' shortcut-conflict' : '';
    const disabledClass = s.enabled ? '' : ' shortcut-disabled';
    return `
      <div class="shortcut-item${conflictClass}${disabledClass}" data-id="${s.id}">
        <div class="shortcut-main">
          <span class="shortcut-name">${escapeSettingsHtml(s.name)}</span>
          <div class="shortcut-input-group">
            <button class="shortcut-key-btn" type="button" ${s.enabled ? '' : 'disabled'} data-recording="false">
              ${escapeSettingsHtml(displayShortcut(s.key))}
            </button>
            <button class="shortcut-reset-btn" type="button" title="恢复默认">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
            </button>
            <label class="toggle-switch shortcut-toggle">
              <input type="checkbox" class="shortcut-enable-input" ${s.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        ${conflictMsg ? `<div class="shortcut-conflict-msg">${escapeSettingsHtml(conflictMsg)}</div>` : ''}
      </div>
    `;
  }).join('');

  // 绑定录制事件
  container.querySelectorAll('.shortcut-key-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const item = btn.closest('.shortcut-item');
      const id = item.dataset.id;
      startRecordingShortcut(id, btn);
    });
  });

  // 绑定恢复默认事件
  container.querySelectorAll('.shortcut-reset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const item = btn.closest('.shortcut-item');
      const id = item.dataset.id;
      const shortcuts = getShortcuts();
      const target = shortcuts.find(s => s.id === id);
      if (target) {
        target.key = target.defaultKey;
        saveShortcuts(shortcuts);
        renderShortcutsList();
      }
    });
  });

  // 绑定开关事件
  container.querySelectorAll('.shortcut-enable-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const item = input.closest('.shortcut-item');
      const id = item.dataset.id;
      const shortcuts = getShortcuts();
      const target = shortcuts.find(s => s.id === id);
      if (target) {
        target.enabled = input.checked;
        saveShortcuts(shortcuts);
        renderShortcutsList();
      }
    });
  });
}

function startRecordingShortcut(id, btn) {
  if (window._recordingShortcut) return;
  window._recordingShortcut = true;

  const originalText = btn.textContent.trim();
  btn.dataset.recording = 'true';
  btn.textContent = '按下快捷键…';
  btn.classList.add('recording');

  let recorded = null;

  function finish() {
    window._recordingShortcut = false;
    document.removeEventListener('keydown', keydownHandler, true);
    document.removeEventListener('keyup', keyupHandler, true);
    btn.dataset.recording = 'false';
    btn.classList.remove('recording');
    if (btn.isConnected) {
      btn.textContent = recorded ? displayShortcut(recorded) : originalText;
    }
    if (window._cancelShortcutRecording === cancelRecording) {
      window._cancelShortcutRecording = null;
    }
  }

  function cancelRecording() {
    recorded = null;
    finish();
  }

  function keydownHandler(e) {
    // 如果焦点在输入框中，忽略快捷键录制
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      recorded = null;
      finish();
      return;
    }

    // 忽略单独按下修饰键
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    const isFunctionKey = /^F([1-9]|1[0-2])$/.test(e.key);
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !isFunctionKey) {
      finish();
      if (typeof window.showToast === 'function') window.showToast('快捷键需包含 Ctrl、Alt 或功能键');
      return;
    }

    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let key = e.key;
    if (key === '+') key = 'Plus';
    else if (key === '-') key = 'Minus';
    else if (key === '=') key = 'Equal';
    else if (key.length === 1) key = key.toUpperCase();

    parts.push(key);
    recorded = normalizeKeyForStorage(parts.join('+'));

    finish();

    // 保存
    const shortcuts = getShortcuts();
    const target = shortcuts.find(s => s.id === id);
    if (target) {
      target.key = recorded;
      saveShortcuts(shortcuts);
      renderShortcutsList();
    }
  }

  function keyupHandler(e) {
    if (e.key === 'Escape') {
      finish();
    }
  }

  document.addEventListener('keydown', keydownHandler, true);
  document.addEventListener('keyup', keyupHandler, true);
  window._cancelShortcutRecording = cancelRecording;
}

// ================== 特殊按键设置（滚轮加速 / 多选） ==================
const DEFAULT_WHEEL_SCROLL_KEY = 'Ctrl';
const SETTINGS_VALID_SPECIAL_KEYS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

function getWheelScrollKey() {
  const stored = localStorage.getItem('essay_wheel_scroll_key');
  return SETTINGS_VALID_SPECIAL_KEYS.includes(stored) ? stored : DEFAULT_WHEEL_SCROLL_KEY;
}

function setWheelScrollKey(key) {
  if (!SETTINGS_VALID_SPECIAL_KEYS.includes(key)) return;
  localStorage.setItem('essay_wheel_scroll_key', key);
}

function displaySpecialKey(key) {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  if (key === 'Meta') return isMac ? '⌘' : 'Meta';
  return key.replace('Ctrl', isMac ? '⌘' : 'Ctrl').replace('Alt', isMac ? '⌥' : 'Alt').replace('Shift', isMac ? '⇧' : 'Shift');
}

function renderShortcutsSpecialList() {
  const container = document.getElementById('shortcuts-special-list');
  if (!container) return;

  const specialItems = [
    { id: 'wheelScrollKey', name: '滚轮加速键', desc: '按住此键滚动滚轮可加速翻页', default: DEFAULT_WHEEL_SCROLL_KEY, get: getWheelScrollKey, set: setWheelScrollKey }
  ];

  container.innerHTML = specialItems.map(item => {
    const current = item.get();
    return `
      <div class="shortcut-item" data-special-id="${item.id}">
        <div class="shortcut-main">
          <div class="shortcut-info">
            <span class="shortcut-name">${escapeSettingsHtml(item.name)}</span>
            <span class="shortcut-desc-inline">${escapeSettingsHtml(item.desc)}</span>
          </div>
          <div class="shortcut-input-group">
            <button class="shortcut-key-btn shortcut-special-key-btn" type="button" data-recording="false">
              ${escapeSettingsHtml(displaySpecialKey(current))}
            </button>
            <button class="shortcut-reset-btn shortcut-special-reset-btn" type="button" title="恢复默认">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 绑定录制事件
  container.querySelectorAll('.shortcut-special-key-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const item = btn.closest('.shortcut-item');
      const id = item.dataset.specialId;
      startRecordingSpecialKey(id, btn);
    });
  });

  // 绑定恢复默认事件
  container.querySelectorAll('.shortcut-special-reset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const item = btn.closest('.shortcut-item');
      const id = item.dataset.specialId;
      const target = specialItems.find(i => i.id === id);
      if (target) {
        target.set(target.default);
        renderShortcutsSpecialList();
      }
    });
  });
}

function startRecordingSpecialKey(id, btn) {
  if (window._recordingShortcut) return;
  window._recordingShortcut = true;

  const originalText = btn.textContent.trim();
  btn.dataset.recording = 'true';
  btn.textContent = '按下按键…';
  btn.classList.add('recording');

  let recorded = null;

  function finish() {
    window._recordingShortcut = false;
    document.removeEventListener('keydown', keydownHandler, true);
    document.removeEventListener('keyup', keyupHandler, true);
    btn.dataset.recording = 'false';
    btn.classList.remove('recording');
    if (btn.isConnected) {
      btn.textContent = recorded ? displaySpecialKey(recorded) : originalText;
    }
    if (window._cancelShortcutRecording === cancelRecording) {
      window._cancelShortcutRecording = null;
    }
  }

  function cancelRecording() {
    recorded = null;
    finish();
  }

  function keydownHandler(e) {
    e.preventDefault();
    e.stopPropagation();

    // 只接受单个修饰键
    if (e.key === 'Control') recorded = 'Ctrl';
    else if (e.key === 'Meta') recorded = 'Meta';
    else if (e.key === 'Alt') recorded = 'Alt';
    else if (e.key === 'Shift') recorded = 'Shift';
    else return; // 忽略非修饰键

    finish();

    if (id === 'wheelScrollKey') {
      setWheelScrollKey(recorded);
    }
    renderShortcutsSpecialList();
  }

  function keyupHandler(e) {
    if (e.key === 'Escape') {
      finish();
    }
  }

  document.addEventListener('keydown', keydownHandler, true);
  document.addEventListener('keyup', keyupHandler, true);
  window._cancelShortcutRecording = cancelRecording;
}

// 暴露给 app.js
window.getWheelScrollKey = getWheelScrollKey;
window.setWheelScrollKey = setWheelScrollKey;

// 暴露给 app.js
window.getShortcuts = getShortcuts;
window.saveShortcuts = saveShortcuts;
window.getShortcutConflicts = () => new Set(_shortcutConflicts);
