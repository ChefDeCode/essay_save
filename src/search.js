// ================== 搜索区状态 ==================
let currentMode = 'discover';
let libraryPapers = [];
window.getEssayflowLibraryPapers = () => {
  const projectItems = Array.isArray(libraryViewState?.items) ? libraryViewState.items : [];
  const projectById = new Map(projectItems.map(paper => [paper.libraryItemId || paper.id, paper]));
  return libraryPapers.map(paper => ({ ...paper, ...(projectById.get(paper.libraryItemId || paper.id) || {}) }));
};
let cachedPapers = [];
let cachedText = '';
let showingDetail = false;
let showingPdf = false;
let currentDetailPaper = null;
let currentPdfPaper = null;
let autoSearchTimer = null;
let pdfDoc = null;
let pdfLoadingTask = null;
let pdfRenderObserver = null;
let pdfResizeObserver = null;
let pdfRenderToken = 0;
let pdfCleanupPromise = Promise.resolve();
let pdfZoom = 1;
let activeSearchController = null;

const SEARCH_TIMEOUT_MS = 12000;

function asText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return value.map(item => asText(item)).filter(Boolean).join(', ');
  return String(value).trim() || fallback;
}

function cleanSearchText(value, fallback = '') {
  const text = asText(value, fallback);
  if (!/<\/?[a-z][\s\S]*>/i.test(text)) return text;
  try {
    return asText(new DOMParser().parseFromString(text, 'text/html').body.textContent, fallback);
  } catch (e) {
    return asText(text.replace(/<[^>]*>/g, ' '), fallback);
  }
}

function stableHash(value) {
  let hash = 2166136261;
  const text = asText(value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeTitleKey(title) {
  const normalized = asText(title).normalize('NFKC').toLowerCase();
  try {
    return normalized.replace(/[^\p{L}\p{N}]+/gu, '');
  } catch (e) {
    return normalized.replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
  }
}

function normalizeDoi(value) {
  const match = asText(value).match(/(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s?#]+)/i);
  return match ? match[1].replace(/[).,;]+$/, '').toLowerCase() : '';
}

function normalizePaper(paper = {}) {
  const title = cleanSearchText(paper.title, '无标题');
  const authorValue = paper.authors || paper.author;
  const authors = Array.isArray(authorValue)
    ? authorValue.map(author => asText(author?.literal || author?.name || author?.display_name || [author?.family, author?.given].filter(Boolean).join(' ') || author)).filter(Boolean).join(', ')
    : asText(authorValue, '未知');
  const issuedYear = paper.issued?.['date-parts']?.[0]?.[0];
  const published = asText(paper.published || paper.year || paper.publicationDate || issuedYear);
  const link = asText(paper.link || paper.url || paper.URL || paper.landingPageUrl);
  const pdfLink = asText(paper.pdfLink || paper.pdfUrl || paper.pdf_url);
  const doi = normalizeDoi(paper.doi || paper.DOI || link || paper.id);
  const rawId = asText(paper.id || paper.libraryItemId || doi || link || pdfLink);
  const id = rawId || `paper_${stableHash(`${title}|${authors}|${published}`)}`;
  const abstract = cleanSearchText(paper.abstract || paper.summary, '无摘要');

  return {
    ...paper,
    id,
    title,
    authors,
    published,
    year: published,
    abstract,
    link,
    url: link,
    pdfLink,
    pdfUrl: pdfLink,
    doi: doi || asText(paper.doi),
    hasPdf: Boolean(paper.hasPdf || paper.localPdfPath || paper.localPdf || pdfLink || (paper.assetRefs || []).some(ref => ref?.kind === 'pdf'))
  };
}

function getPaperIdentityKeys(paper) {
  const normalized = normalizePaper(paper);
  const keys = new Set();
  const doi = normalizeDoi(normalized.doi || normalized.link || normalized.id);
  if (doi) keys.add(`doi:${doi}`);
  if (normalized.id) keys.add(`id:${normalized.id.toLowerCase()}`);
  const titleKey = normalizeTitleKey(normalized.title);
  if (titleKey && titleKey !== normalizeTitleKey('无标题')) keys.add(`title:${titleKey}`);
  return keys;
}

function isSamePaper(left, right) {
  const leftKeys = getPaperIdentityKeys(left);
  return Array.from(getPaperIdentityKeys(right)).some(key => leftKeys.has(key));
}

function normalizePaperList(papers) {
  const result = [];
  const seenKeys = new Set();
  (Array.isArray(papers) ? papers : []).forEach(rawPaper => {
    if (!rawPaper || typeof rawPaper !== 'object') return;
    const paper = Object.assign(rawPaper, normalizePaper(rawPaper));
    const keys = Array.from(getPaperIdentityKeys(paper));
    if (keys.some(key => seenKeys.has(key))) return;
    keys.forEach(key => seenKeys.add(key));
    result.push(paper);
  });
  return result;
}

function getSafeExternalUrl(value, allowFile = false) {
  let raw = asText(value);
  if (!raw) return '';
  if (/^10\.\d{4,9}\//i.test(raw)) raw = `https://doi.org/${raw}`;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || (allowFile && parsed.protocol === 'file:')) {
      return parsed.href;
    }
  } catch (e) {}
  return '';
}

function openExternalLink(value, allowFile = false) {
  const safeUrl = getSafeExternalUrl(value, allowFile);
  if (!safeUrl) {
    notify('链接无效或不受支持', 'warning');
    return;
  }
  const opened = window.open(safeUrl, '_blank', 'noopener');
  if (opened) opened.opener = null;
}

function localPathToFileUrl(filePath) {
  const path = asText(filePath).replace(/\\/g, '/');
  return path ? encodeURI(`file:///${path}`) : '';
}

function cancelActiveSearch() {
  if (activeSearchController) activeSearchController.abort();
  activeSearchController = null;
}

function createSearchController() {
  cancelActiveSearch();
  activeSearchController = new AbortController();
  return activeSearchController;
}

function releaseSearchController(controller) {
  if (activeSearchController === controller) activeSearchController = null;
}

// 当前搜索ID，用于防止并行搜索冲突
let currentSearchId = 0;

// 发现模式搜索状态（流式展示 + 扩大搜索）
const discoverSearchState = {
  query: '',
  isSearching: false,
  isExpanding: false,
  sourceOffsets: {}
};
const displayedTitleKeys = new Set();

function resetDiscoverSearch() {
  discoverSearchState.query = '';
  discoverSearchState.isSearching = false;
  discoverSearchState.isExpanding = false;
  discoverSearchState.sourceOffsets = {};
  displayedTitleKeys.clear();
}

function getSourceStateKey(sourceId, query) {
  return `${sourceId}::${asText(query).normalize('NFKC').toLowerCase()}`;
}

function getSourceOffset(sourceId, query) {
  return discoverSearchState.sourceOffsets[getSourceStateKey(sourceId, query)] || 0;
}

function setSourceOffset(sourceId, query, offset) {
  discoverSearchState.sourceOffsets[getSourceStateKey(sourceId, query)] = offset;
}

function filterNewPapers(papers) {
  const result = [];
  normalizePaperList(papers).forEach(p => {
    const titleKey = normalizeTitleKey(p.title);
    const key = titleKey ? `title:${titleKey}` : Array.from(getPaperIdentityKeys(p))[0];
    if (!key || displayedTitleKeys.has(key)) return;
    displayedTitleKeys.add(key);
    result.push(p);
  });
  return result;
}

// 手动搜索状态跟踪（用于回到自动搜索功能）
let isManualSearchActive = false;
let manualSearchPapers = [];
let manualSearchQuery = '';

const btnDiscover = document.getElementById('btn-discover');
const btnLibrary = document.getElementById('btn-library');
const btnEvidence = document.getElementById('btn-evidence');
const libraryHeaderActions = document.getElementById('library-header-actions');
const libraryControls = document.getElementById('library-controls');
const evidenceControls = document.getElementById('evidence-controls');
let discoverResults = document.getElementById('discover-results');
let libraryResults = document.getElementById('library-results');
let evidenceResults = document.getElementById('evidence-results');

// 如果 HTML 未更新，动态创建子容器（兼容旧版本 HTML）
if (!discoverResults || !libraryResults) {
  const searchResults = document.getElementById('search-results');
  if (searchResults) {
    discoverResults = document.createElement('div');
    discoverResults.id = 'discover-results';
    libraryResults = document.createElement('div');
    libraryResults.id = 'library-results';
    libraryResults.style.display = 'none';
    // 将现有内容迁移到 discoverResults
    while (searchResults.firstChild) {
      discoverResults.appendChild(searchResults.firstChild);
    }
    searchResults.appendChild(discoverResults);
    searchResults.appendChild(libraryResults);
  }
}

function getActiveResults() {
  if (currentMode === 'discover') return discoverResults;
  if (currentMode === 'library') return libraryResults;
  return evidenceResults;
}
function restoreActiveResults() {
  if (currentMode === 'discover') restoreDiscoverResults();
  else if (currentMode === 'library') renderLibrary();
  else window.renderEssayflowEvidence?.();
}
const searchToggleBtn = document.getElementById('search-toggle-btn');
const searchExpandArea = document.getElementById('search-expand-area');
const searchInput = document.getElementById('search-input');

const notify = (msg, type = '') => {
  if (window.showToast) window.showToast(msg);
  else alert(msg);
  const toast = document.getElementById('toast');
  if (toast && type) {
    toast.classList.add(type);
    setTimeout(() => toast.classList.remove(type), 5000);
  }
};

// ================== 优先关键词获取 ==================
function getPriorityKeywords() {
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return '';
  const keywords = new Set();
  editorEl.querySelectorAll('.priority-keyword').forEach(el => {
    const single = el.getAttribute('data-keyword-value');
    if (single && single.trim()) keywords.add(single.trim());
    const extracted = el.getAttribute('data-extracted-keywords');
    if (extracted) {
      try {
        const arr = JSON.parse(extracted);
        if (Array.isArray(arr)) arr.forEach(k => { if (k && k.trim()) keywords.add(k.trim()); });
      } catch(e) {}
    }
  });
  return Array.from(keywords).join(' ');
}

function getEditorText() {
  const editorEl = document.querySelector('#editor-container .ql-editor');
  if (!editorEl) return '';
  return editorEl.innerText.trim();
}

function extractKeywords(text, maxWords = 12) {
  const stopWords = new Set([
    'the','is','at','which','on','a','an','and','or','but','in','with','to','for',
    'of','that','this','was','are','be','it','as','by','from','its','can','not',
    'have','has','had','we','you','they','he','she','his','her','their','our',
    '的','了','在','是','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','这个','那个','可以','我们','来','都','把','被','让','向','从','为','与','及','等','对','关于','对于','为了','由于','根据','按照','通过','经过','随着','作为','关于','即','使','因为','所以','因此','因而','于是','从而','但是','可是','然而','不过','只是','而','而且','并且','或者','还是','要么','与其','不但','不仅','不只','不光','不单','不独','而且','并且','况且','何况','再说','再者','否则','不然','要不','要不然','虽然','虽说','尽管','固然','固然','纵然','即使','哪怕','尽管','不管','不论','无论','不要','不能','不会','不可','不得','不必','不用','应该','应当','应','该','须','必须','必要','需要','得','需','须得','别','不要','毋','勿','莫','不','没','没有','未','无','非','勿','别','甭','不必','未必','也许','或许','大概','大约','约','差不多','几乎','简直','根本','决','绝对','完全','都','全','总','统统','通统','一律','一概','一味','总是','老是','一直','一向','从来','始终','毕竟','究竟','到底','终归','终究','结果','后果','成果','然后','而后','之后','后来','随即','随手','随后','立刻','立即','马上','赶紧','赶快','连忙','急忙','匆忙','仓促','临时','暂且','暂时','暂','权且','姑且','且','慢说','别说','不但','不仅','不只','不光','不单','不独','而且','并且','况且','何况','再说','再者','否则','不然','要不','要不然'
  ]);
  // 分别提取英文词和中文词（CJK 字符范围）
  const enWords = text.replace(/[^a-zA-Z0-9\s\-]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));
  const cjkWords = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/g) || [];
  const allWords = [...enWords, ...cjkWords];
  return allWords.slice(0, maxWords).join(' ');
}

let libraryRevision = 0;
let librarySaveQueue = Promise.resolve();
let libraryCollections = [];
let libraryRenderToken = 0;
let libraryQueryTimer = null;
const librarySelectedIds = new Set();
const libraryViewState = {
  offset: 0,
  limit: 100,
  total: 0,
  items: [],
  undoToken: '',
  undoRevision: null,
  projectRevision: null
};

async function loadLibrary() {
  const dataState = await window.essayflowDataReady;
  const snapshot = window.electronAPI?.loadLibraryStore
    ? await window.electronAPI.loadLibraryStore()
    : dataState?.library;
  libraryRevision = Number.isSafeInteger(snapshot?.revision) ? snapshot.revision : 0;
  libraryCollections = Array.isArray(snapshot?.collections) ? snapshot.collections : [];
  libraryPapers = normalizePaperList(snapshot?.items || []);
  window.libraryPapers = libraryPapers;
  if (window.essayflowDataState) window.essayflowDataState.library = snapshot;
  if (currentMode === 'library') renderLibrary();
  return libraryPapers;
}

function saveLibrary() {
  const publicLibrary = Array.isArray(window.libraryPapers) ? window.libraryPapers : libraryPapers;
  libraryPapers = normalizePaperList(publicLibrary);
  window.libraryPapers = libraryPapers;
  const snapshot = JSON.parse(JSON.stringify(libraryPapers));
  librarySaveQueue = librarySaveQueue
    .catch(() => {})
    .then(async () => {
      if (!window.electronAPI?.replaceLibraryStore) return;
      const result = await window.electronAPI.replaceLibraryStore({
        baseRevision: libraryRevision,
        items: snapshot
      });
      if (!result?.success || result.durable !== true) throw new Error('文库提交未获得 durable 确认');
      libraryRevision = result.revision;
      if (window.essayflowDataState) window.essayflowDataState.library = result;
    })
    .catch(error => {
      console.error('[saveLibrary] 文库保存失败:', error);
      notify(`文库保存失败：${error.message || '请重试'}`, 'error');
      throw error;
    });
  return librarySaveQueue;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function createRequestError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function delayWithSignal(ms, signal) {
  if (!signal) return delay(ms);
  if (signal.aborted) return Promise.reject(createRequestError('AbortError', '请求已取消'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createRequestError('AbortError', '请求已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function raceRequest(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, createRequestError('AbortError', '请求已取消'));
    const timer = setTimeout(
      () => finish(reject, createRequestError('TimeoutError', `请求超过 ${timeoutMs}ms`)),
      timeoutMs
    );
    if (signal) {
      if (signal.aborted) {
        finish(reject, createRequestError('AbortError', '请求已取消'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

function createProxyResponse(result) {
  if (!result || !Number.isFinite(Number(result.status))) {
    throw new Error('代理请求返回无效响应');
  }
  const headers = new Headers();
  Object.entries(result.headers || {}).forEach(([name, value]) => {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value !== undefined && value !== null) headers.set(name, String(value));
  });
  const body = typeof result.body === 'string' ? result.body : '';
  return {
    ok: result.status >= 200 && result.status < 300,
    status: Number(result.status),
    statusText: asText(result.statusText),
    headers,
    json: async () => JSON.parse(body),
    text: async () => body
  };
}

async function performRequest(url, options, timeoutMs, signal) {
  if (signal?.aborted) throw createRequestError('AbortError', '请求已取消');
  if (window.electronAPI?.scholarlyRequest) {
    const project = window.getEssayflowProjectContext?.();
    if (!project?.projectId) throw new Error('请先保存当前项目，再检索远程文献');
    const confirmed = project.privacyMode !== 'sensitive' || window.confirm(`敏感项目将访问远程学术 API：\n${url}`);
    if (!confirmed) throw createRequestError('AbortError', '用户取消了远程学术请求');
    const requestId = crypto.randomUUID();
    const request = window.electronAPI.scholarlyRequest({
      projectId: project.projectId,
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null,
      requestId,
      operation: options.operation || 'literature-metadata',
      confirmed,
      ...(options.sourceId ? { sourceId: options.sourceId } : {})
    });
    try {
      const result = await raceRequest(request, signal, timeoutMs);
      if (Number.isSafeInteger(result?.revision)) {
        window.applyEssayflowProjectRevision?.(project.projectId, result.revision);
      }
      if (result?.blocked) throw createRequestError('PrivacyError', result.reason || '当前项目隐私模式已阻止学术请求');
      return createProxyResponse(result);
    } catch (err) {
      if (Number.isSafeInteger(err?.revision)) {
        window.applyEssayflowProjectRevision?.(project.projectId, err.revision);
      }
      if ((signal?.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') &&
          window.electronAPI?.cancelScholarlyRequest) {
        window.electronAPI.cancelScholarlyRequest(requestId);
      }
      throw err;
    }
  }
  throw new Error('学术网络 gateway 不可用');
}

function isTransientStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function getRetryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const delayMs = Number.isFinite(seconds) ? seconds * 1000 : retryAt - Date.now();
    if (Number.isFinite(delayMs) && delayMs > 0) return Math.min(delayMs, 10000);
  }
  return Math.min(800 * (2 ** attempt), 5000);
}

// 支持 Electron 代理、超时、取消和瞬时错误重试。
async function fetchWithRetry(url, options = {}, retries = 2) {
  const { timeoutMs = SEARCH_TIMEOUT_MS, signal, ...requestOptions } = options;
  let lastError = null;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) return { error: true, reason: 'ABORTED' };
    try {
      const response = await performRequest(url, requestOptions, timeoutMs, signal);
      if (response.ok) return response;
      if (isTransientStatus(response.status) && i < retries) {
        await delayWithSignal(getRetryDelay(response, i), signal);
        continue;
      }
      return { error: true, reason: 'HTTP_' + response.status, status: response.status };
    } catch (err) {
      lastError = err;
      if (signal?.aborted || err.name === 'AbortError') return { error: true, reason: 'ABORTED' };
      if (i < retries && (err.name === 'TimeoutError' || err.name === 'TypeError' || /network|fetch/i.test(err.message))) {
        await delayWithSignal(getRetryDelay(null, i), signal);
        continue;
      }
      return {
        error: true,
        reason: err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
        message: err.message
      };
    }
  }
  return { error: true, reason: 'MAX_RETRIES', message: lastError?.message || '' };
}

function assertSearchResponse(response, sourceName) {
  if (!response?.error) return;
  const error = new Error(`${sourceName} 请求失败：${response.reason || 'UNKNOWN'}`);
  error.name = response.reason === 'ABORTED' ? 'AbortError' : 'SearchSourceError';
  error.reason = response.reason;
  error.status = response.status;
  throw error;
}

// ================== 数据源1: arXiv ==================
async function searchArxiv(query, maxResults = 10, offset = 0, signal) {
  if (!query || query.length < 2) return [];
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${offset}&max_results=${maxResults}`;
  try {
    const response = await fetchWithRetry(url, { signal });
    assertSearchResponse(response, 'arXiv');
    const text = await response.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, 'text/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('arXiv 返回了无效 XML');
    const entries = xmlDoc.querySelectorAll('entry');
    const papers = [];
    entries.forEach(entry => {
      const title = entry.querySelector('title')?.textContent?.trim() || '无标题';
      const summary = entry.querySelector('summary')?.textContent?.trim() || '无摘要';
      const link = entry.querySelector('id')?.textContent?.trim() || '';
      const pdfElem = entry.querySelector('link[title="pdf"]');
      const pdfLink = pdfElem ? pdfElem.getAttribute('href') : null;
      const authors = Array.from(entry.querySelectorAll('author name')).map(a => a.textContent.trim()).join(', ');
      const published = entry.querySelector('published')?.textContent?.split('T')[0] || '';
      papers.push({
        id: link,
        title,
        abstract: summary,
        link,
        pdfLink: pdfLink || link,
        authors,
        published,
        hasPdf: !!pdfElem
      });
    });
    return papers;
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('arXiv 搜索失败:', err);
    throw err;
  }
}

// ================== 数据源2: Semantic Scholar ==================
async function searchSemanticScholar(query, maxResults = 10, offset = 0, signal) {
  if (!query || query.length < 2) return [];
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&offset=${offset}&limit=${maxResults}&fields=title,abstract,url,externalIds,openAccessPdf,authors,year`;
  try {
    const response = await fetchWithRetry(url, { signal });
    assertSearchResponse(response, 'Semantic Scholar');
    const data = await response.json();
    if (!data || !Array.isArray(data.data)) throw new Error('Semantic Scholar 返回格式异常');
    const papers = [];
    for (const item of data.data || []) {
      const pdfLink = item.openAccessPdf?.url || null;
      papers.push({
        id: item.paperId || item.url,
        title: item.title || '无标题',
        abstract: item.abstract || '无摘要',
        link: item.url || '',
        pdfLink: pdfLink || '',
        authors: (item.authors || []).map(a => a?.name).filter(Boolean).join(', '),
        published: item.year ? String(item.year) : '',
        hasPdf: !!pdfLink,
        doi: item.externalIds?.DOI || ''
      });
    }
    return papers;
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Semantic Scholar 搜索失败:', err);
    throw err;
  }
}

// ================== 数据源 Crossref ==================
async function searchCrossref(query, maxResults = 5, offset = 0, signal) {
  if (!query || query.length < 2) return [];
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}&offset=${offset}`;
  try {
    const response = await fetchWithRetry(url, { signal });
    assertSearchResponse(response, 'Crossref');
    const data = await response.json();
    if (!Array.isArray(data?.message?.items)) throw new Error('Crossref 返回格式异常');
    const papers = [];
    for (const item of (data.message?.items || [])) {
      const authors = (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()).join(', ');
      const published = item['published-print']?.['date-parts']?.[0]?.[0]
        || item['published-online']?.['date-parts']?.[0]?.[0]
        || item['published']?.['date-parts']?.[0]?.[0]
        || '';
      const doi = item.DOI || '';
      papers.push({
        id: doi || item.URL || item.title,
        title: item.title?.[0] || '无标题',
        abstract: item.abstract || '无摘要',
        link: item.URL || (doi ? `https://doi.org/${doi}` : ''),
        pdfLink: item.link?.find(l => l['content-type'] === 'application/pdf')?.URL || null,
        authors: authors,
        published: String(published),
        hasPdf: !!item.link?.some(l => l['content-type'] === 'application/pdf'),
        doi: doi,
        source: 'Crossref'
      });
    }
    return papers;
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Crossref 搜索失败:', err);
    throw err;
  }
}

// ================== 数据源3: CORE ==================
async function searchCORE(query, maxResults = 5, offset = 0, signal) {
  if (!query || query.length < 2) return [];
  const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&offset=${offset}&limit=${maxResults}`;
  try {
    const response = await fetchWithRetry(url, { signal });
    assertSearchResponse(response, 'CORE');
    const data = await response.json();
    if (!Array.isArray(data?.results)) throw new Error('CORE 返回格式异常');
    const papers = [];
    for (const item of data.results || []) {
      let authors = '';
      if (Array.isArray(item.authors)) {
        authors = item.authors.map(a => {
          if (typeof a === 'string') return a;
          if (a && a.name) return a.name;
          return '';
        }).filter(Boolean).join(', ');
      }
      papers.push({
        id: item.id || item.doi || '',
        title: item.title || '无标题',
        abstract: item.abstract || '无摘要',
        link: item.downloadUrl || item.sourceUrl || '',
        pdfLink: item.downloadUrl || null,
        authors,
        published: item.datePublished || '',
        hasPdf: !!item.downloadUrl,
        doi: item.doi || ''
      });
    }
    return papers;
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('CORE 搜索失败:', err);
    throw err;
  }
}

// ================== 数据源4: OpenAlex ==================
async function searchOpenAlex(query, maxResults = 5, page = 1, signal) {
  if (!query || query.length < 2) return [];
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${maxResults}&page=${page}`;
  try {
    const response = await fetchWithRetry(url, { signal });
    assertSearchResponse(response, 'OpenAlex');
    const data = await response.json();
    if (!Array.isArray(data?.results)) throw new Error('OpenAlex 返回格式异常');
    const papers = [];
    for (const item of data.results || []) {
      let abstract = '无摘要';
      if (item.abstract_inverted_index) {
        const entries = Object.entries(item.abstract_inverted_index);
        const words = new Array(entries.length);
        entries.forEach(([word, positions]) => {
          positions.forEach(pos => { words[pos] = word; });
        });
        abstract = words.filter(Boolean).join(' ');
      }
      const pdfLink = item.best_oa_location?.pdf_url || item.primary_location?.pdf_url || '';
      papers.push({
        id: item.id || '',
        title: item.title || '无标题',
        abstract,
        link: item.primary_location?.landing_page_url || item.doi || item.id || '',
        pdfLink,
        authors: (item.authorships || []).map(a => a.author?.display_name).filter(Boolean).join(', '),
        published: item.publication_date || '',
        hasPdf: !!pdfLink,
        doi: item.doi || ''
      });
    }
    return papers;
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('OpenAlex 搜索失败:', err);
    throw err;
  }
}

function getSearchSources() {
  const builtins = [
    { id: 'arxiv', name: 'arXiv', type: 'builtin', enabled: true },
    { id: 'semantic_scholar', name: 'Semantic Scholar', type: 'builtin', enabled: true },
    { id: 'crossref', name: 'Crossref', type: 'builtin', enabled: true },
    { id: 'core', name: 'CORE', type: 'builtin', enabled: true },
    { id: 'openalex', name: 'OpenAlex', type: 'builtin', enabled: true }
  ];
  const settings = window.essayflowDataState?.settings || {};
  const enabledIds = new Set(Array.isArray(settings.enabledSearchSourceIds)
    ? settings.enabledSearchSourceIds
    : builtins.map(source => source.id));
  const mergedBuiltins = builtins.map(source => ({ ...source, enabled: enabledIds.has(source.id) }));
  const customSources = Array.isArray(settings.customSearchSources)
    ? settings.customSearchSources.map(source => ({ ...source, type: 'custom', enabled: source.enabled !== false }))
    : [];
  return [...mergedBuiltins, ...customSources];
}

async function searchCustomAPI(source, query, limit = 5, offset = 0, signal) {
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('自定义来源仅支持 HTTP/HTTPS');
    }
    url.searchParams.set('q', query);
    url.searchParams.set('limit', limit);
    url.searchParams.set('offset', offset);

    const response = await fetchWithRetry(url.toString(), { headers: {}, signal, sourceId: source.id }, 1);
    assertSearchResponse(response, source.name || '自定义来源');
    const data = await response.json();

    // 尝试从常见 JSON 路径提取结果
    const items = data.results || data.data || data.items || data.papers || data.works || [];
    if (!Array.isArray(items)) return [];

    function extractField(obj, keys) {
      for (const key of keys) {
        if (key.includes('.')) {
          const parts = key.split('.');
          let val = obj;
          for (const p of parts) { val = val?.[p]; }
          if (val !== undefined && val !== null) return val;
        } else if (obj[key] !== undefined && obj[key] !== null) {
          return obj[key];
        }
      }
      return '';
    }

    function extractAuthors(item) {
      const raw = item.authors;
      if (!raw) return '';
      if (typeof raw === 'string') return raw;
      if (Array.isArray(raw)) {
        return raw.map(a => {
          if (typeof a === 'string') return a;
          return a.name || a.display_name || a.authorName || '';
        }).filter(Boolean).join(', ');
      }
      return '';
    }

    return items.slice(0, limit).map(item => {
      const title = extractField(item, ['title', 'title_display', 'display_name', 'name']);
      const pdfUrl = extractField(item, ['pdfUrl', 'pdf_url', 'downloadUrl', 'openAccessPdf.url', 'openAccessPdf', 'primary_location.pdf_url']);
      const link = extractField(item, ['url', 'landing_page_url', 'link', 'doi', 'primary_location.landing_page_url']) || '';
      const published = extractField(item, ['year', 'publicationYear', 'publishedDate', 'date', 'publication_date']) || '';
      const doi = extractField(item, ['doi', 'DOI', 'externalIds.DOI']) || '';
      const rawId = extractField(item, ['id', 'paperId', 'doi', 'DOI', 'url']);
      const stableId = rawId || `${source.id}|${title}|${extractAuthors(item)}|${published}`;
      return {
        id: `custom_${source.id}_${stableHash(stableId)}`,
        title: title || '无标题',
        authors: extractAuthors(item) || '未知',
        published: asText(published),
        year: asText(published),
        abstract: extractField(item, ['abstract', 'summary', 'description']) || '',
        link: asText(link),
        url: asText(link),
        pdfLink: typeof pdfUrl === 'string' ? pdfUrl : '',
        pdfUrl: typeof pdfUrl === 'string' ? pdfUrl : '',
        source: source.name,
        hasPdf: typeof pdfUrl === 'string' && !!pdfUrl,
        doi: asText(doi)
      };
    }).filter(p => p.title && p.title !== '无标题');
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('自定义来源搜索失败:', source.name, err);
    throw err;
  }
}

async function searchPapers(query, options = {}) {
  const { onBatch, limit = 5, signal } = options;
  const sources = getSearchSources().filter(s => s.enabled);
  const allPapers = [];
  const sourceErrors = [];
  let successfulSources = 0;
  let batchQueue = Promise.resolve();

  if (!asText(query) || asText(query).length < 2) return [];
  if (sources.length === 0) {
    const error = new Error('未启用任何论文来源');
    error.code = 'NO_SEARCH_SOURCES';
    throw error;
  }

  // 并发请求所有数据源；超时和取消由统一请求层处理。
  const promises = sources.map(async (source) => {
    const sourceController = new AbortController();
    const onParentAbort = () => sourceController.abort();
    if (signal) {
      if (signal.aborted) sourceController.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const sourceTimer = setTimeout(() => sourceController.abort(), SEARCH_TIMEOUT_MS);
    const sourceSignal = sourceController.signal;
    try {
      let results = [];
      const offset = getSourceOffset(source.id, query);

      if (source.id === 'arxiv') {
        results = await searchArxiv(query, limit, offset, sourceSignal);
      } else if (source.id === 'semantic_scholar') {
        results = await searchSemanticScholar(query, limit, offset, sourceSignal);
      } else if (source.id === 'crossref') {
        results = await searchCrossref(query, limit, offset, sourceSignal);
      } else if (source.id === 'core') {
        results = await searchCORE(query, 3, offset, sourceSignal);
      } else if (source.id === 'openalex') {
        const page = Math.floor(offset / 3) + 1;
        results = await searchOpenAlex(query, 3, page, sourceSignal);
      } else if (source.type === 'custom') {
        results = await searchCustomAPI(source, query, limit, offset, sourceSignal);
      }

      if (sourceSignal.aborted) throw createRequestError('AbortError', '请求已取消');
      successfulSources++;
      const step = source.id === 'core' || source.id === 'openalex' ? 3 : limit;
      setSourceOffset(source.id, query, offset + step);

      const newPapers = filterNewPapers(results);
      console.log(`[Search] 来源=${source.name}, 原始=${results.length}, 去重后=${newPapers.length}, offset=${offset}`);
      if (newPapers.length > 0) {
        allPapers.push(...newPapers);
        if (onBatch) {
          batchQueue = batchQueue.catch(() => {}).then(() => onBatch(source.name, newPapers));
          await batchQueue;
        }
      }
    } catch (e) {
      sourceErrors.push({ source: source.name, error: e });
      if (e.name !== 'AbortError') console.warn(`[Search] 来源=${source.name} 失败:`, e.message || e);
    } finally {
      clearTimeout(sourceTimer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }
  });

  await Promise.allSettled(promises);
  await batchQueue.catch(() => {});

  if (signal?.aborted) throw createRequestError('AbortError', '请求已取消');
  searchPapers.lastStats = { total: sources.length, successful: successfulSources, failed: sourceErrors.length };
  if (successfulSources === 0) {
    const error = new Error('所有论文来源均暂时不可用');
    error.name = 'SearchUnavailableError';
    error.sources = sourceErrors;
    throw error;
  }

  // 排序：有 PDF 的优先（非流式模式才排序）
  if (!onBatch) {
    allPapers.sort((a, b) => (b.hasPdf ? 1 : 0) - (a.hasPdf ? 1 : 0));
  }

  return allPapers;
}

// ================== 卡片创建（标签增强） ==================
function createPaperCard(paper, showRemove = false, animate = true) {
  Object.assign(paper, normalizePaper(paper));
  const card = document.createElement('div');
  card.className = 'paper-card';
  card.draggable = true;
  card.dataset.paperId = paper.id;
  
  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer.setData('application/json', JSON.stringify(paper));
    e.dataTransfer.effectAllowed = 'copy';
    window._draggingPaper = paper;
    window._preDragMode = currentMode;
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    window._draggingPaper = null;
    // 恢复原模式并重新渲染，避免 innerHTML 快照导致事件监听器丢失
    if (window._preDragMode && window._preDragMode !== currentMode) {
      switchMode(window._preDragMode);
    } else {
      if (currentMode === 'discover') restoreDiscoverResults();
      else if (currentMode === 'library') renderLibrary();
    }
    window._preDragMode = null;
  });
  if (!animate) card.style.animation = 'none';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'paper-title';
  let titleHtml = escapeSearchHtml(paper.title);
  if (paper.isImported) {
    titleHtml += `<span class="imported-tag">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      本地
    </span>`;
  }
  titleDiv.innerHTML = titleHtml;
  titleDiv.addEventListener('click', async (e) => {
    e.stopPropagation();
    showingPdf = false;
    await showPaperDetail(paper);
  });

  const abstractDiv = document.createElement('div');
  abstractDiv.className = 'paper-abstract';
  const shortAbstract = paper.abstract.length > 180 ? paper.abstract.slice(0, 180) + '…' : paper.abstract;
  abstractDiv.textContent = shortAbstract;
  abstractDiv.addEventListener('mouseenter', (e) => {
    const tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) return;
    clearTimeout(abstractDiv._hoverTimer);
    abstractDiv._hoverTimer = setTimeout(() => {
      tooltip.textContent = paper.abstract;
      tooltip.classList.add('show');
      const rect = abstractDiv.getBoundingClientRect();
      let left = rect.left, top = rect.top - tooltip.offsetHeight - 8;
      const maxLeft = window.innerWidth - tooltip.offsetWidth - 10, minLeft = 10;
      if (left > maxLeft) left = maxLeft;
      if (left < minLeft) left = minLeft;
      if (top < 10) top = rect.bottom + 8;
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.style.maxWidth = Math.min(400, window.innerWidth - 40) + 'px';
      tooltip.style.whiteSpace = 'normal';
      tooltip.style.wordBreak = 'break-word';
    }, 300);
  });
  abstractDiv.addEventListener('mouseleave', () => {
    clearTimeout(abstractDiv._hoverTimer);
    const tooltip = document.getElementById('custom-tooltip');
    if (tooltip) tooltip.classList.remove('show');
  });

  // PDF 标签：优先级 - 加载失败 > 无 PDF
  if (paper.downloadFailed) {
    const failTag = document.createElement('span');
    failTag.className = 'no-pdf-tag';
    failTag.style.background = '#ffd6d6';
    failTag.style.color = '#b52e2e';
    failTag.textContent = 'PDF 下载失败';
    abstractDiv.appendChild(failTag);
  } else if (paper.pdfLoadFailed) {
    const failTag = document.createElement('span');
    failTag.className = 'no-pdf-tag';
    failTag.style.background = '#ffd6d6';
    failTag.style.color = '#b52e2e';
    failTag.textContent = '无法加载 PDF';
    abstractDiv.appendChild(failTag);
  } else if (!paper.hasPdf) {
    const noPdfTag = document.createElement('span');
    noPdfTag.className = 'no-pdf-tag';
    noPdfTag.textContent = '无 PDF';
    abstractDiv.appendChild(noPdfTag);
  }

  const footer = document.createElement('div');
  footer.className = 'paper-footer';
  
  if (showRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-from-library';
    removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> 移除`;
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromLibrary(paper);
    });
    footer.appendChild(removeBtn);

    // 自己导入的论文显示编辑按钮
    if (paper.isImported) {
      const editBtn = document.createElement('button');
      editBtn.className = 'edit-paper-btn';
      editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> 编辑`;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.openEditModal) window.openEditModal(paper);
      });
      footer.appendChild(editBtn);
    }
  } else {
    const collectedPaper = libraryPapers.find(p => isSamePaper(p, paper));
    const isCollected = Boolean(collectedPaper);
    const actionBtn = document.createElement('button');
    actionBtn.className = isCollected ? 'remove-from-library' : 'add-to-library';
    if (isCollected) {
      actionBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> 已收藏`;
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromLibrary(collectedPaper || paper);
        if (collectedPaper && String(collectedPaper.id) !== String(paper.id)) {
          updateCardButtons(paper.id, false);
        }
      });
    } else {
      actionBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M4 4v16h16V4H4z M9 9h6M12 6v6"/><rect x="9" y="12" width="6" height="6"/></svg> 加入库`;
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addToLibrary(paper);
      });
    }
    footer.appendChild(actionBtn);

    if (!paper.hasPdf || paper.pdfLoadFailed) {
      const infoBtn = document.createElement('button');
      infoBtn.className = 'add-to-library';
      infoBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;vertical-align:middle;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>摘要页`;
      infoBtn.title = '查看摘要页';
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openExternalLink(paper.link);
      });
      footer.appendChild(infoBtn);
    }
  }

  card.appendChild(titleDiv);
  card.appendChild(abstractDiv);
  card.appendChild(footer);
  return card;
}

// ================== 论文详情 ==================
async function showPaperDetail(paper) {
  Object.assign(paper, normalizePaper(paper));
  currentSearchId++;
  cancelActiveSearch();
  discoverSearchState.isSearching = false;
  showingDetail = true;
  showingPdf = false;
  currentDetailPaper = paper;
  const container = getActiveResults();
  container.innerHTML = '';
  
  const detailDiv = document.createElement('div');
  detailDiv.className = 'paper-detail-view';
  const hasPdf = paper.hasPdf;
  const localPdfPath = paper.localPdfPath || paper.localPdf;
  const detailUrl = hasPdf ? (localPdfPath ? localPathToFileUrl(localPdfPath) : paper.pdfLink) : paper.link;
  const hasDetailUrl = Boolean(getSafeExternalUrl(detailUrl, hasPdf && Boolean(localPdfPath || paper.isImported)));
  detailDiv.innerHTML = `
    <div class="paper-detail-title">${escapeSearchHtml(paper.title)}</div>
    <div class="paper-detail-meta">作者：${escapeSearchHtml(paper.authors || '未知')} | 发布日期：${escapeSearchHtml(paper.published || '未知')}</div>
    <div class="paper-detail-abstract">${escapeSearchHtml(paper.abstract)}</div>
    <div class="paper-detail-actions">
      <button class="btn-back">← 返回列表</button>
      <button class="btn-pdf" ${hasDetailUrl ? '' : 'disabled'}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;vertical-align:middle;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0-2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${hasPdf ? '查看 PDF' : (hasDetailUrl ? '查看详情页' : '无可用链接')}</button>
    </div>
  `;
  
  const backBtn = detailDiv.querySelector('.btn-back');
  backBtn.addEventListener('click', () => {
    showingDetail = false;
    restoreActiveResults();
  });
  
  const pdfBtn = detailDiv.querySelector('.btn-pdf');
  if (pdfBtn && hasDetailUrl) {
    pdfBtn.addEventListener('click', () => {
      if (hasPdf) showPdfView(paper);
      else openExternalLink(paper.link);
    });
  }
  
  container.appendChild(detailDiv);
}

// ================== PDF 视图（主进程下载 → file://） ==================
function cleanupPdfPreview() {
  pdfRenderToken++;
  if (pdfRenderObserver) pdfRenderObserver.disconnect();
  pdfRenderObserver = null;
  if (pdfResizeObserver) pdfResizeObserver.disconnect();
  pdfResizeObserver = null;
  document.querySelectorAll('.pdf-render-container canvas').forEach(canvas => {
    try { canvas._renderTask?.cancel(); } catch (e) {}
  });
  const loadingTask = pdfLoadingTask;
  const documentProxy = pdfDoc;
  pdfLoadingTask = null;
  pdfDoc = null;
  window.essayflowPdfEvidence?.reset();
  pdfCleanupPromise = pdfCleanupPromise.catch(() => {}).then(async () => {
    try {
      if (loadingTask?.destroy) {
        await loadingTask.destroy();
      } else if (documentProxy?.destroy) {
        await documentProxy.destroy();
      }
    } catch (error) {
      console.warn('PDF 预览资源清理失败:', error);
    }
  });
  return pdfCleanupPromise;
}

function flattenPdfOutline(items, depth = 0, result = []) {
  (Array.isArray(items) ? items : []).forEach(item => {
    result.push({ title: asText(item?.title, '未命名章节'), dest: item?.dest, depth });
    if (item?.items?.length) flattenPdfOutline(item.items, depth + 1, result);
  });
  return result;
}

async function showPdfView(paper) {
  Object.assign(paper, normalizePaper(paper));
  await cleanupPdfPreview();
  const previewToken = pdfRenderToken;
  showingDetail = false;
  showingPdf = true;
  currentPdfPaper = paper;
  pdfZoom = 1;
  const container = getActiveResults();
  container.innerHTML = '';

  const view = document.createElement('div');
  view.className = 'pdf-full-view';
  view.dataset.pdfStage = 'initializing';

  const nav = document.createElement('div');
  nav.className = 'pdf-nav-bar';
  nav.innerHTML = `
    <button class="btn-back btn-back-pdf">← 返回列表</button>
    <div class="pdf-nav-center">
      <div class="pdf-outline-wrapper" id="pdf-outline-wrapper">
        <span class="pdf-no-outline">加载大纲中…</span>
      </div>
      <div class="pdf-page-control">
        <input type="number" id="pdf-page-input" class="pdf-page-input" value="1" min="1" placeholder="1">
        <span class="pdf-page-total">/ <span id="pdf-total-pages">?</span></span>
        <button id="pdf-go-page" class="btn-back btn-back-sm">跳转</button>
      </div>
      <div class="pdf-page-control" aria-label="PDF 缩放">
        <button id="pdf-zoom-out" class="btn-back btn-back-sm" aria-label="缩小 PDF">−</button>
        <span id="pdf-zoom-value" class="pdf-page-total">100%</span>
        <button id="pdf-zoom-in" class="btn-back btn-back-sm" aria-label="放大 PDF">+</button>
      </div>
    </div>
    <div class="pdf-evidence-tools">
      <input id="pdf-text-search" class="pdf-search-input" type="search" placeholder="搜索 PDF 全文" aria-label="搜索 PDF 全文">
      <button id="pdf-search-prev" class="btn-back btn-back-sm" aria-label="上一个搜索结果">‹</button>
      <span id="pdf-search-count" class="pdf-search-count">0/0</span>
      <button id="pdf-search-next" class="btn-back btn-back-sm" aria-label="下一个搜索结果">›</button>
      <button id="pdf-save-evidence" class="pdf-evidence-save">保存为证据</button>
    </div>
    <button id="pdf-open-new" class="btn-back btn-back-sm"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;vertical-align:middle;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>外部打开</button>
  `;
  view.appendChild(nav);

  const renderContainer = document.createElement('div');
  renderContainer.className = 'pdf-render-container';
  renderContainer.id = 'pdf-render-container';
  renderContainer.innerHTML = '<div class="pdf-loading">正在加载 PDF…</div>';
  view.appendChild(renderContainer);

  container.appendChild(view);

  const backBtn = nav.querySelector('.btn-back-pdf');
  backBtn.addEventListener('click', () => {
    showingPdf = false;
    cleanupPdfPreview();
    restoreActiveResults();
  });

  const pageInput = nav.querySelector('#pdf-page-input');
  const totalPagesSpan = nav.querySelector('#pdf-total-pages');
  const goPageBtn = nav.querySelector('#pdf-go-page');
  const outlineWrapper = nav.querySelector('#pdf-outline-wrapper');
  const openNewBtn = nav.querySelector('#pdf-open-new');
  const searchPdfInput = nav.querySelector('#pdf-text-search');
  const searchPdfPrevious = nav.querySelector('#pdf-search-prev');
  const searchPdfNext = nav.querySelector('#pdf-search-next');
  const searchPdfCount = nav.querySelector('#pdf-search-count');
  const saveEvidenceButton = nav.querySelector('#pdf-save-evidence');
  const zoomOut = nav.querySelector('#pdf-zoom-out');
  const zoomIn = nav.querySelector('#pdf-zoom-in');
  const zoomValue = nav.querySelector('#pdf-zoom-value');
  const localPath = paper.localPdfPath || paper.localPdf;
  const externalPdfUrl = localPath ? localPathToFileUrl(localPath) : paper.pdfLink;
  const canOpenExternal = Boolean(getSafeExternalUrl(externalPdfUrl, !!localPath));
  openNewBtn.disabled = !canOpenExternal;
  openNewBtn.addEventListener('click', () => openExternalLink(externalPdfUrl, !!localPath));

  let searchMatches = [];
  let searchMatchIndex = -1;
  let evidencePdfLocator = '';
  let evidenceDescriptor = null;
  const showSearchMatch = () => {
    if (!searchMatches.length) {
      searchPdfCount.textContent = '0/0';
      return;
    }
    searchMatchIndex = (searchMatchIndex + searchMatches.length) % searchMatches.length;
    const match = searchMatches[searchMatchIndex];
    searchPdfCount.textContent = `${searchMatchIndex + 1}/${searchMatches.length} · 第${match.pageNumber}页`;
    pageInput.value = String(match.pageNumber);
    scrollToPage(match.pageNumber, renderContainer);
  };
  const runPdfSearch = async () => {
    searchPdfCount.textContent = '搜索中';
    searchMatches = await window.essayflowPdfEvidence.search(searchPdfInput.value);
    searchMatchIndex = searchMatches.length ? 0 : -1;
    showSearchMatch();
  };
  searchPdfInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runPdfSearch().catch(error => notify(`PDF 搜索失败：${error.message}`, 'error'));
    }
  });
  searchPdfPrevious.addEventListener('click', () => { searchMatchIndex -= 1; showSearchMatch(); });
  searchPdfNext.addEventListener('click', () => { searchMatchIndex += 1; showSearchMatch(); });

  try {
    view.dataset.pdfStage = 'resolving-source';
    let pdfUrl = paper.pdfLink;
    let pdfSource = null;

    if (paper.managedAssetId && window.electronAPI?.readEvidencePdfAsset) {
      const managed = await window.electronAPI.readEvidencePdfAsset(paper.managedAssetId);
      evidenceDescriptor = managed.descriptor;
      pdfSource = { data: managed.data };
    } else if (localPath) {
      pdfUrl = localPathToFileUrl(localPath);
      evidencePdfLocator = pdfUrl;
    } else {
      const safeRemoteUrl = getSafeExternalUrl(pdfUrl);
      if (!safeRemoteUrl) throw new Error('PDF 链接无效');
      pdfUrl = safeRemoteUrl;
      if (window.electronAPI?.downloadPdfTemp) {
        const safeTitle = (paper.title || 'paper').replace(/[\\/:*?"<>|]/g, '_').substring(0, 48);
        const filename = `${safeTitle}_${stableHash(`${paper.id}|${safeRemoteUrl}`)}`;
        try {
          const project = window.getEssayflowProjectContext?.();
          if (!project?.projectId) throw new Error('请先保存项目');
          const confirmed = project.privacyMode !== 'sensitive' || window.confirm(`敏感项目将下载远程 PDF：\n${safeRemoteUrl}`);
          if (!confirmed) throw new Error('已取消远程 PDF 下载');
          if (project.privacyMode === 'normal') notify(`远程 PDF 外发范围：${new URL(safeRemoteUrl).origin} · 仅下载所选文献 PDF`);
          const tempPath = await window.electronAPI.downloadPdfTemp(safeRemoteUrl, filename, project.projectId, confirmed);
          if (previewToken !== pdfRenderToken) return;
          pdfUrl = localPathToFileUrl(tempPath);
          evidencePdfLocator = pdfUrl;
        } catch (e) {
          throw new Error(`受控 PDF 下载失败：${e.message || '远程来源不可用'}`);
        }
      }
    }

    if (!pdfSource && !pdfUrl) throw new Error('没有可用的 PDF 链接');
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF 组件未加载');
    pdfLoadingTask = window.essayFlowGetPdfDocument(pdfSource || pdfUrl);
    pdfDoc = await pdfLoadingTask.promise;
    view.dataset.pdfStage = 'document-loaded';
    if (previewToken !== pdfRenderToken) return;
    paper.pdfLoadFailed = false;
    const totalPages = pdfDoc.numPages;
    totalPagesSpan.textContent = totalPages;
    pageInput.max = totalPages;

    const evidenceSnapshot = await window.refreshEssayflowEvidence?.();
    view.dataset.pdfStage = 'evidence-loaded';
    window.essayflowPdfEvidence.bindDocument({
      document: pdfDoc,
      container: renderContainer,
      paper,
      locator: evidencePdfLocator,
      descriptor: evidenceDescriptor,
      evidenceItems: evidenceSnapshot?.items || []
    });

    view.dataset.pdfStage = 'rendering-pages';
    await renderAllPages(pdfDoc, renderContainer, previewToken);
    if (previewToken !== pdfRenderToken) return;
    view.dataset.pdfStage = 'ready';

    let zoomRenderGeneration = 0;
    let zoomRenderQueue = Promise.resolve();
    const rerenderAtZoom = nextZoom => {
      pdfZoom = Math.max(0.8, Math.min(1.5, nextZoom));
      zoomValue.textContent = `${Math.round(pdfZoom * 100)}%`;
      const generation = ++zoomRenderGeneration;
      zoomRenderQueue = zoomRenderQueue.catch(() => {}).then(async () => {
        if (generation !== zoomRenderGeneration || previewToken !== pdfRenderToken) return;
        await renderAllPages(pdfDoc, renderContainer, previewToken);
      });
      return zoomRenderQueue;
    };
    zoomOut.addEventListener('click', () => rerenderAtZoom(pdfZoom - 0.1));
    zoomIn.addEventListener('click', () => rerenderAtZoom(pdfZoom + 0.1));
    let resizeTimer = null;
    if ('ResizeObserver' in window) {
      let lastWidth = renderContainer.clientWidth;
      pdfResizeObserver = new ResizeObserver(entries => {
        const width = Math.round(entries[0]?.contentRect?.width || renderContainer.clientWidth);
        if (Math.abs(width - lastWidth) < 8) return;
        lastWidth = width;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => rerenderAtZoom(pdfZoom).catch(() => {}), 120);
      });
      pdfResizeObserver.observe(renderContainer);
    }

    saveEvidenceButton.addEventListener('click', async () => {
      saveEvidenceButton.disabled = true;
      try {
        const project = window.getEssayflowProjectContext?.() || {};
        if (!project.projectId || project.revision < 0) throw new Error('请先保存当前项目');
        const libraryPaper = paper.libraryItemId ? paper : libraryPapers.find(candidate => isSamePaper(candidate, paper));
        if (!libraryPaper?.libraryItemId) throw new Error('请先将这篇文献收藏到文库');
        const selection = await window.essayflowPdfEvidence.captureSelection();
        if (!evidenceDescriptor) {
          if (!evidencePdfLocator) throw new Error('临时预览必须先保存为受管 PDF 才能创建证据');
          evidenceDescriptor = await window.electronAPI.importManagedPdfForEvidence(evidencePdfLocator);
        }
        const result = await window.electronAPI.createEvidenceFromUserSelection({
          projectId: project.projectId,
          baseRevision: project.revision,
          libraryItemId: libraryPaper.libraryItemId,
          assetId: evidenceDescriptor.assetId,
          fileSha256: evidenceDescriptor.sha256,
          title: libraryPaper.title,
          ...(libraryPaper.doi || libraryPaper.DOI ? { doi: libraryPaper.doi || libraryPaper.DOI } : {}),
          metadataSource: ['api', 'imported', 'manual'].includes(libraryPaper.metadataProvenance?.source)
            ? libraryPaper.metadataProvenance.source
            : 'manual',
          pageIndex: selection.pageIndex,
          pageLabel: selection.pageLabel,
          quoteRaw: selection.quoteRaw,
          pageTextSha256: selection.pageTextSha256,
          prefix: selection.prefix,
          suffix: selection.suffix,
          occurrenceIndex: selection.occurrenceIndex,
          rects: selection.rects,
          pageRotation: selection.pageRotation,
          cropBox: selection.cropBox,
          extractorName: selection.extractorName,
          extractorVersion: selection.extractorVersion,
          transformVersion: selection.transformVersion,
          normalization: selection.normalization,
          note: '',
          tags: [],
          color: '#d5a623',
          researchQuestionIds: []
        });
        window.applyEssayflowProjectRevision?.(project.projectId, result.revision);
        window.getSelection()?.removeAllRanges();
        const snapshot = await window.refreshEssayflowEvidence?.();
        window.essayflowPdfEvidence.setEvidenceItems(snapshot?.items || []);
        notify('证据已保存，可在右栏“证据”中查看');
      } catch (error) {
        notify(`保存证据失败：${error.message || '请重试'}`, 'error');
      } finally {
        saveEvidenceButton.disabled = false;
      }
    });

    try {
      const outline = await pdfDoc.getOutline();
      outlineWrapper.innerHTML = '';
      if (outline && outline.length > 0) {
        const select = document.createElement('select');
        select.className = 'pdf-outline-select';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '文档大纲';
        select.appendChild(placeholder);
        const outlineItems = flattenPdfOutline(outline);
        outlineItems.forEach((item, index) => {
          const option = document.createElement('option');
          option.value = String(index);
          option.textContent = `${'　'.repeat(Math.min(item.depth, 4))}${item.title}`;
          select.appendChild(option);
        });
        select.addEventListener('change', async (e) => {
          if (e.target.value === '') return;
          try {
            let dest = outlineItems[Number(e.target.value)]?.dest;
            if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
            if (!Array.isArray(dest) || !dest[0]) throw new Error('大纲目标无效');
            const pageIndex = await pdfDoc.getPageIndex(dest[0]);
            const pageNum = pageIndex + 1;
            scrollToPage(pageNum, renderContainer);
            pageInput.value = pageNum;
          } catch (e) {
            console.warn('无法跳转到 PDF 大纲位置:', e);
            notify('无法跳转到该章节', 'warning');
          }
        });
        outlineWrapper.appendChild(select);
      } else {
        outlineWrapper.innerHTML = '<span class="pdf-no-outline">无大纲</span>';
      }
    } catch (outlineErr) {
      console.warn('大纲获取失败:', outlineErr);
      outlineWrapper.innerHTML = '<span class="pdf-no-outline">无大纲</span>';
    }

    goPageBtn.addEventListener('click', () => {
      let page = parseInt(pageInput.value, 10);
      if (isNaN(page) || page < 1) page = 1;
      if (page > totalPages) page = totalPages;
      pageInput.value = page;
      scrollToPage(page, renderContainer);
    });
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goPageBtn.click();
    });

  } catch (err) {
    if (previewToken !== pdfRenderToken) return;
    console.error('PDF 加载失败:', err);
    if (!paper.pdfLoadFailed) {
      paper.pdfLoadFailed = true;
    }
    container.innerHTML = '';
    const infoDiv = document.createElement('div');
    infoDiv.className = 'paper-detail-view';
    infoDiv.innerHTML = `
      <div class="paper-detail-title">${escapeSearchHtml(paper.title)}</div>
      <div class="paper-detail-meta">作者：${escapeSearchHtml(paper.authors || '未知')} | 发布日期：${escapeSearchHtml(paper.published || '未知')}</div>
      <div class="paper-detail-abstract">${escapeSearchHtml(paper.abstract)}</div>
      <div style="color:#b55252; margin-bottom:16px;">无法加载 PDF（${escapeSearchHtml(err.name || '链接失效')}），您可以在新窗口打开或查看以下摘要。</div>
      <div class="paper-detail-actions">
        <button class="btn-back">← 返回列表</button>
        <button class="btn-pdf" ${canOpenExternal ? '' : 'disabled'}>在新窗口打开</button>
      </div>
    `;
    const newBackBtn = infoDiv.querySelector('.btn-back');
    newBackBtn.addEventListener('click', () => {
      showingPdf = false;
      cleanupPdfPreview();
      restoreActiveResults();
    });
    const fallbackOpenBtn = infoDiv.querySelector('.btn-pdf');
    if (fallbackOpenBtn && canOpenExternal) {
      fallbackOpenBtn.addEventListener('click', () => openExternalLink(externalPdfUrl, !!localPath));
    }
    container.appendChild(infoDiv);
  }
}

async function renderAllPages(pdfDocument, container, previewToken) {
  if (pdfRenderObserver) pdfRenderObserver.disconnect();
  pdfRenderObserver = null;
  container.querySelectorAll('canvas').forEach(canvas => {
    try { canvas._renderTask?.cancel(); } catch (_) {}
  });
  container.innerHTML = '';
  const availableWidth = Math.max(280, container.clientWidth - 40);
  const pageScales = new Map();

  for (let i = 1; i <= pdfDocument.numPages; i++) {
    if (previewToken !== pdfRenderToken) return;
    const page = await pdfDocument.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const cssScale = Math.min(2.25, (availableWidth / baseViewport.width) * pdfZoom);
    const cssViewport = page.getViewport({ scale: cssScale });
    pageScales.set(i, cssScale);
    const shell = document.createElement('div');
    shell.className = 'pdf-page-shell';
    shell.id = `pdf-page-${i}`;
    shell.dataset.pageNumber = String(i);
    shell.style.width = `${Math.floor(cssViewport.width)}px`;
    shell.style.height = `${Math.floor(cssViewport.height)}px`;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.id = `pdf-canvas-${i}`;
    canvas.dataset.pageNumber = String(i);
    canvas.style.display = 'block';
    canvas.style.background = '#ffffff';
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;
    canvas.style.maxWidth = '100%';
    canvas.style.boxShadow = 'none';
    canvas.style.border = 'none';
    canvas.style.borderRadius = '0';
    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'pdf-highlight-layer';
    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    shell.append(canvas, highlightLayer, textLayer);
    container.appendChild(shell);
  }

  const renderPage = async (shell) => {
    if (!shell || shell.dataset.rendered || shell.dataset.rendering || previewToken !== pdfRenderToken) return shell?.dataset.rendered === 'true';
    shell.dataset.rendering = 'true';
    try {
      const pageNumber = Number(shell.dataset.pageNumber);
      const page = await pdfDocument.getPage(pageNumber);
      if (previewToken !== pdfRenderToken) return;
      const cssScale = pageScales.get(pageNumber) || 1;
      const cssViewport = page.getViewport({ scale: cssScale });
      const canvas = shell.querySelector('canvas');
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      shell.style.width = `${Math.floor(cssViewport.width)}px`;
      shell.style.height = `${Math.floor(cssViewport.height)}px`;
      const renderCanvas = async (pixelRatio, timeoutMs) => {
        const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });
        canvas.width = Math.max(1, Math.floor(renderViewport.width));
        canvas.height = Math.max(1, Math.floor(renderViewport.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('PDF 画布上下文不可用');
        const task = page.render({ canvasContext: ctx, viewport: renderViewport });
        canvas._renderTask = task;
        let timer = null;
        try {
          await Promise.race([
            task.promise,
            new Promise((_, reject) => {
              timer = window.setTimeout(() => {
                const error = new Error(`PDF 页面 ${pageNumber} 画布渲染超过 ${timeoutMs}ms`);
                error.code = 'PDF_CANVAS_RENDER_TIMEOUT';
                reject(error);
              }, timeoutMs);
            })
          ]);
        } catch (error) {
          if (error?.code === 'PDF_CANVAS_RENDER_TIMEOUT') {
            try { task.cancel(); } catch (_) {}
          }
          throw error;
        } finally {
          if (timer !== null) window.clearTimeout(timer);
          if (canvas._renderTask === task) canvas._renderTask = null;
        }
      };
      try {
        await renderCanvas(Math.min(window.devicePixelRatio || 1, 2), 10000);
      } catch (error) {
        if (error?.code !== 'PDF_CANVAS_RENDER_TIMEOUT') throw error;
        console.warn(`PDF 页面 ${pageNumber} 首次画布渲染超时，正在以 1x 像素比重试`);
        await renderCanvas(1, 20000);
      }
      if (previewToken !== pdfRenderToken) return;
      await window.essayflowPdfEvidence.renderPage({
        page,
        pageNumber,
        wrapper: shell,
        viewport: cssViewport,
        textLayer: shell.querySelector('.pdf-text-layer'),
        highlightLayer: shell.querySelector('.pdf-highlight-layer')
      });
      if (previewToken === pdfRenderToken) {
        shell.dataset.rendered = 'true';
        delete shell.dataset.renderError;
        return true;
      }
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('PDF 页面渲染失败:', e);
      shell.dataset.renderError = e?.code || e?.name || 'PDF_RENDER_FAILED';
      return false;
    } finally {
      delete shell.dataset.rendering;
      const canvas = shell.querySelector('canvas');
      if (canvas) canvas._renderTask = null;
    }
  };

  const firstPage = container.querySelector('.pdf-page-shell');
  if (firstPage && !await renderPage(firstPage)) {
    throw new Error(`PDF 首页渲染失败：${firstPage.dataset.renderError || '未知错误'}`);
  }

  if ('IntersectionObserver' in window) {
    pdfRenderObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        pdfRenderObserver?.unobserve(entry.target);
        void renderPage(entry.target);
      });
    }, { root: container, rootMargin: '1000px 0px' });
    container.querySelectorAll('.pdf-page-shell:not([data-rendered="true"])').forEach(shell => pdfRenderObserver.observe(shell));
  } else {
    for (const shell of container.querySelectorAll('.pdf-page-shell:not([data-rendered="true"])')) {
      await renderPage(shell);
      if (previewToken !== pdfRenderToken) return;
    }
  }
}

function scrollToPage(pageNum, container) {
  const target = container.querySelector(`#pdf-page-${pageNum}`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeSearchHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

window.openEssayflowEvidenceSource = async item => {
  if (!item?.revision || item.effectiveStatus !== 'active') {
    notify('来源文件缺失或已替换，已停止自动回跳', 'warning');
    return false;
  }
  const revision = item.revision;
  const libraryPaper = libraryPapers.find(paper => paper.libraryItemId === revision.libraryItemId);
  const paper = normalizePaper({
    ...(libraryPaper || {}),
    id: revision.libraryItemId || revision.citationItemId,
    libraryItemId: revision.libraryItemId,
    title: revision.sourceSnapshot.title,
    doi: revision.sourceSnapshot.doi,
    managedAssetId: revision.sourceSnapshot.assetId,
    hasPdf: true
  });
  await showPdfView(paper);
  const pageNumber = revision.locator.pageIndex + 1;
  scrollToPage(pageNumber, document.getElementById('pdf-render-container'));
  setTimeout(() => window.essayflowPdfEvidence?.jumpToEvidence(item), 250);
  return true;
};

// ================== 收藏 / 取消收藏 ==================
function addToLibrary(paper) {
  const normalizedPaper = normalizePaper(paper);
  if (libraryPapers.some(p => isSamePaper(p, normalizedPaper))) {
    notify('该论文已在文库中');
    return;
  }
  const newPaper = { ...normalizedPaper };
  libraryPapers.push(newPaper);
  window.libraryPapers = libraryPapers;
  saveLibrary();
  notify(`已收藏《${normalizedPaper.title.substring(0, 30)}》`);
  updateCardButtons(normalizedPaper.id, true);

  // 自动下载 PDF 到本地
  const remotePdfUrl = getSafeExternalUrl(normalizedPaper.pdfLink);
  if (normalizedPaper.hasPdf && remotePdfUrl && window.electronAPI?.downloadPdf) {
    const idSuffix = stableHash(`${normalizedPaper.id}|${remotePdfUrl}`);
    const filename = normalizedPaper.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 80) + '_' + idSuffix;
    const project = window.getEssayflowProjectContext?.();
    if (!project?.projectId) {
      notify('请先保存项目，再下载 PDF', 'warning');
      return;
    }
    const confirmed = project.privacyMode !== 'sensitive' || window.confirm(`敏感项目将下载远程 PDF：\n${remotePdfUrl}`);
    if (!confirmed) return;
    if (project.privacyMode === 'normal') notify(`远程 PDF 外发范围：${new URL(remotePdfUrl).origin} · 仅下载所选文献 PDF`);
    window.electronAPI.downloadPdf(remotePdfUrl, filename, project.projectId, confirmed)
      .then(localPath => {
        if (!asText(localPath)) throw new Error('下载未返回本地路径');
        const savedPaper = libraryPapers.find(item => isSamePaper(item, newPaper));
        if (!savedPaper) {
          window.electronAPI?.deleteLocalPdf?.(localPath).catch(() => {});
          return;
        }
        savedPaper.localPdfPath = localPath;
        savedPaper.downloadFailed = false;
        saveLibrary();
      })
      .catch(err => {
        const savedPaper = libraryPapers.find(item => isSamePaper(item, newPaper));
        if (!savedPaper) return;
        savedPaper.downloadFailed = true;
        saveLibrary();
        notify('PDF 下载失败，请稍后手动下载', 'warning');
        console.warn('[addToLibrary] 自动下载 PDF 失败:', err);
      });
  }
}

function removeFromLibrary(paper) {
  const normalizedPaper = normalizePaper(paper);
  if (normalizedPaper.libraryItemId && window.electronAPI?.applyCitationLibraryBatch) {
    deleteLibraryItems([normalizedPaper.libraryItemId]);
    return;
  }
  // 删除本地 PDF 文件（如果有）
  const localPath = normalizedPaper.localPdfPath || normalizedPaper.localPdf;
  if (localPath && window.electronAPI && window.electronAPI.deleteLocalPdf) {
    window.electronAPI.deleteLocalPdf(localPath)
      .then(result => {
        if (result && result.success === false) {
          console.warn('[removeFromLibrary] 删除本地 PDF 失败:', result.error);
        }
      })
      .catch(err => console.warn('[removeFromLibrary] 删除本地 PDF 异常:', err));
  }

  libraryPapers = libraryPapers.filter(p => !isSamePaper(p, normalizedPaper));
  // 保持 window.libraryPapers 引用同步，避免后续导入操作添加到旧数组
  window.libraryPapers = libraryPapers;
  saveLibrary();
  notify(`已取消收藏《${normalizedPaper.title.substring(0, 30)}》`);
  if (currentMode === 'library') {
    renderLibrary();
  } else {
    updateCardButtons(normalizedPaper.id, false);
  }
}

function updateCardButtons(paperId, isCollected) {
  const cards = document.querySelectorAll('.paper-card');
  cards.forEach(card => {
    if (card.dataset.paperId !== String(paperId)) return;
    const displayedPaper = [...cachedPapers, ...manualSearchPapers, ...libraryPapers].find(p => String(p.id) === String(paperId));
    if (!displayedPaper) return;
    const targetPaper = isCollected
      ? (libraryPapers.find(p => isSamePaper(p, displayedPaper)) || displayedPaper)
      : displayedPaper;
    const footer = card.querySelector('.paper-footer');
    if (!footer) return;
    footer.innerHTML = '';

    if (isCollected) {
      const collectedBtn = document.createElement('button');
      collectedBtn.className = 'remove-from-library';
      collectedBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> 已收藏`;
      collectedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromLibrary(targetPaper);
      });
      footer.appendChild(collectedBtn);
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'add-to-library';
      addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M4 4v16h16V4H4z M9 9h6M12 6v6"/><rect x="9" y="12" width="6" height="6"/></svg> 加入库`;
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addToLibrary(targetPaper);
      });
      footer.appendChild(addBtn);

      if (!targetPaper.hasPdf || targetPaper.pdfLoadFailed) {
        const infoBtn = document.createElement('button');
        infoBtn.className = 'add-to-library';
        infoBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;vertical-align:middle;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>摘要页`;
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openExternalLink(targetPaper.link);
        });
        footer.appendChild(infoBtn);
      }
    }
  });
}

// ================== 渲染缓存 ==================
function renderCachedResults() {
  if (cachedPapers.length > 0) {
    discoverResults.innerHTML = '';
    cachedPapers.forEach(p => discoverResults.appendChild(createPaperCard(p, false, false)));
  } else {
    discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">暂无相关论文</div>';
  }
  if (discoverSearchState.query && !discoverSearchState.isSearching) appendExpandButton();
}

function restoreDiscoverResults() {
  if (!isManualSearchActive) {
    renderCachedResults();
    return;
  }
  discoverResults.innerHTML = '';
  if (manualSearchPapers.length > 0) {
    manualSearchPapers.forEach(p => discoverResults.appendChild(createPaperCard(p, false, false)));
  } else {
    discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">未找到相关论文</div>';
  }
  showBackToAutoSearchButton();
  if (discoverSearchState.query && !discoverSearchState.isSearching) appendExpandButton();
}

// ================== 回到自动搜索按钮 ==================
let backToAutoSearchBtn = null;

function createBackToAutoSearchButton() {
  if (backToAutoSearchBtn) return backToAutoSearchBtn;
  const btn = document.createElement('button');
  btn.id = 'btn-back-to-auto';
  btn.className = 'back-to-auto-btn';
  btn.setAttribute('data-tooltip', '点击回到自动搜索');
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M10 9l-6 6 6 6"/>
      <path d="M4 15h10a4 4 0 0 0 4-4V4"/>
    </svg>
  `;
  btn.addEventListener('click', () => {
    isManualSearchActive = false;
    manualSearchPapers = [];
    manualSearchQuery = '';
    showingDetail = false;
    showingPdf = false;
    hideBackToAutoSearchButton();
    if (cachedPapers.length > 0) {
      renderCachedResults();
    } else {
      autoDiscover();
    }
  });
  backToAutoSearchBtn = btn;
  return btn;
}

function showBackToAutoSearchButton() {
  if (!backToAutoSearchBtn) createBackToAutoSearchButton();
  const header = document.getElementById('search-header');
  if (header && backToAutoSearchBtn && !backToAutoSearchBtn.parentElement) {
    // 插入到 mode-buttons 和 search-toggle-wrapper 之间
    const toggleWrapper = header.querySelector('.search-toggle-wrapper');
    if (toggleWrapper) {
      header.insertBefore(backToAutoSearchBtn, toggleWrapper);
    } else {
      header.appendChild(backToAutoSearchBtn);
    }
  }
  if (backToAutoSearchBtn) backToAutoSearchBtn.style.display = 'flex';
}

function hideBackToAutoSearchButton() {
  if (backToAutoSearchBtn) backToAutoSearchBtn.style.display = 'none';
}

// ================== AI 全文理解 + 增量更新 ==================
const aiSearchState = {
  hasFullContext: false,
  fullContextSummary: '',
  lastSentSnapshot: '',
  currentKeywords: '',
  isWaitingForAI: false,
  requestVersion: 0
};

function computeDiff(oldText, newText) {
  if (oldText === newText) return { changed: false, diff: '', changeCount: 0 };

  const oldParas = oldText.split('\n');
  const newParas = newText.split('\n');
  let diffParts = [];
  let changeCount = 0;

  const maxLen = Math.max(oldParas.length, newParas.length);
  for (let i = 0; i < maxLen; i++) {
    const oldP = oldParas[i] || '';
    const newP = newParas[i] || '';
    if (oldP !== newP) {
      diffParts.push(`[段落${i+1}变化] 原：${oldP.substring(0,100)} → 新：${newP.substring(0,100)}`);
      changeCount += Math.abs(newP.length - oldP.length);
    }
  }

  if (changeCount === 0 && oldText !== newText) {
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
    let endOld = oldText.length - 1, endNew = newText.length - 1;
    while (endOld >= start && endNew >= start && oldText[endOld] === newText[endNew]) {
      endOld--; endNew--;
    }
    const removed = oldText.substring(start, endOld + 1);
    const added = newText.substring(start, endNew + 1);
    diffParts.push(`[文本变化] 删除：${removed.substring(0,150)} 添加：${added.substring(0,150)}`);
    changeCount = removed.length + added.length;
  }

  return { changed: true, diff: diffParts.join('\n'), changeCount };
}

async function buildSmartQueryWithAI(baseQuery) {
  const requestVersion = ++aiSearchState.requestVersion;
  aiSearchState.isWaitingForAI = false;
  const priorityKeywords = getPriorityKeywords();
  const aiEnabled = window.essayflowDataState?.settings?.featureToggles?.aiSearch === true;
  const config = (typeof getAIConfig === 'function') ? getAIConfig() : null;
  let aiQuery = '';

  if (!aiEnabled || !config || !config.base_url || !config.credential || !config.model) {
    // AI 未开启或未配置，直接返回普通 query
    const parts = [];
    if (priorityKeywords) parts.push(priorityKeywords);
    if (baseQuery) parts.push(baseQuery);
    return { finalQuery: parts.join(' '), aiQuery: '', baseQuery, priorityKeywords };
  }

  const text = getEditorText();

  if (!aiSearchState.hasFullContext) {
    // ========== 首次触发：建立全文理解 ==========
    const snapshotText = text.length > 3000 ? text.substring(0, 3000) : text;
    const messages = [
      { role: 'system', content: 'You are an academic research assistant.' },
      { role: 'user', content: '请仔细阅读以下学术论文全文，理解其核心研究主题、方法论和关键概念。\n请返回两个部分，用 "---" 分隔：\n1. 全文核心摘要（200字以内，用于后续理解上下文）\n2. 5个最适合搜索相关论文的英文关键词（逗号分隔）\n\n不要解释其他内容。全文：\n' + snapshotText }
    ];

    aiSearchState.isWaitingForAI = true;
    let result;
    try {
      result = await requestAI(messages, null, (err) => {
        console.error('[AI Search] 全文理解失败:', err);
      }, null, null, { operation: 'search-keywords', contextKind: 'selection', promptTemplateVersion: 'search-keywords-full-v1' });
    } finally {
      if (requestVersion === aiSearchState.requestVersion) aiSearchState.isWaitingForAI = false;
    }

    if (requestVersion !== aiSearchState.requestVersion) {
      return { finalQuery: [priorityKeywords, baseQuery].filter(Boolean).join(' '), aiQuery: '', baseQuery, priorityKeywords };
    }

    if (result) {
      const sections = result.split('---').map(s => s.trim());
      if (sections.length >= 2) {
        aiSearchState.fullContextSummary = sections[0];
        aiSearchState.currentKeywords = sections[1].split(',').map(s => s.trim()).filter(Boolean).join(' ');
      } else {
        //  fallback：如果没按格式返回，整段当作关键词
        aiSearchState.currentKeywords = result.split(',').map(s => s.trim()).filter(Boolean).join(' ');
      }
      aiSearchState.hasFullContext = true;
      aiSearchState.lastSentSnapshot = text;
      aiQuery = aiSearchState.currentKeywords;
    } else {
      notify('AI 总结关键词失败，已回退到自动提取');
    }
  } else {
    // ========== 后续触发：增量更新 ==========
    const diffResult = computeDiff(aiSearchState.lastSentSnapshot, text);

    if (!diffResult.changed || diffResult.changeCount <= 8) {
      // 变化太小，不触发 AI，使用现有关键词
      aiQuery = aiSearchState.currentKeywords;
    } else if (diffResult.changeCount > text.length * 0.3) {
      // 变化超过 30%，视为大幅重写，重新走首次逻辑
      aiSearchState.hasFullContext = false;
      aiSearchState.fullContextSummary = '';
      aiSearchState.currentKeywords = '';
      return buildSmartQueryWithAI(baseQuery);
    } else {
      // 增量更新
      const messages = [
        { role: 'system', content: 'You are an academic research assistant.' },
        { role: 'user', content: '你之前理解了这篇论文的核心内容：\n' + aiSearchState.fullContextSummary + '\n\n现在论文内容发生了以下变化：\n' + diffResult.diff + '\n\n请基于原有理解和这些新变化，判断是否需要更新搜索关键词。\n如果不需要更新，请严格返回 NO_CHANGE；\n如果需要更新，请返回新的5个英文搜索关键词（逗号分隔）。\n不要解释。' }
      ];

      aiSearchState.isWaitingForAI = true;
      let result;
      try {
        result = await requestAI(messages, null, (err) => {
          console.error('[AI Search] 增量更新失败:', err);
        }, null, null, { operation: 'search-keywords', contextKind: 'selection', promptTemplateVersion: 'search-keywords-diff-v1' });
      } finally {
        if (requestVersion === aiSearchState.requestVersion) aiSearchState.isWaitingForAI = false;
      }

      if (requestVersion !== aiSearchState.requestVersion) {
        return { finalQuery: [priorityKeywords, baseQuery].filter(Boolean).join(' '), aiQuery: '', baseQuery, priorityKeywords };
      }

      if (result) {
        const trimmed = result.trim();
        if (trimmed === 'NO_CHANGE' || trimmed.includes('NO_CHANGE')) {
          aiQuery = aiSearchState.currentKeywords;
        } else {
          aiSearchState.currentKeywords = trimmed.split(',').map(s => s.trim()).filter(Boolean).join(' ');
          aiQuery = aiSearchState.currentKeywords;
        }
        aiSearchState.lastSentSnapshot = text;
      } else {
        aiQuery = aiSearchState.currentKeywords;
      }
    }
  }

  const parts = [];
  if (priorityKeywords) parts.push(priorityKeywords);
  if (aiQuery) parts.push(aiQuery);
  if (baseQuery) parts.push(baseQuery);

  const seen = new Set();
  const unique = [];
  parts.join(' ').split(/\s+/).filter(Boolean).forEach(w => {
    const lower = w.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(w);
    }
  });

  return { finalQuery: unique.join(' '), aiQuery, baseQuery, priorityKeywords };
}

async function searchWithBlend(queryInfo, options = {}) {
  const { onBatch, limit = 20, signal } = options;

  if (!queryInfo.aiQuery) {
    return await searchPapers(queryInfo.finalQuery, { onBatch, limit, signal });
  }

  if (onBatch) {
    // 流式模式：先搜 AI 关键词（结果置顶展示），再搜基础关键词
    await searchPapers(queryInfo.aiQuery, { onBatch, limit, signal });
    return await searchPapers(queryInfo.baseQuery || queryInfo.finalQuery, { onBatch, limit, signal });
  }

  // 非流式模式：并发搜索（backward compatibility）
  const [aiPapers, basePapers] = await Promise.all([
    searchPapers(queryInfo.aiQuery, { limit, signal }),
    searchPapers(queryInfo.baseQuery || queryInfo.finalQuery, { limit, signal })
  ]);

  const normalizeTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const seen = new Set();
  const result = [];

  // AI 结果置顶
  aiPapers.forEach(p => {
    const key = normalizeTitle(p.title);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  });

  // 基础结果补齐
  basePapers.forEach(p => {
    const key = normalizeTitle(p.title);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  });

  return result.slice(0, limit);
}

// ================== 自动搜索 ==================
async function autoDiscover() {
  if (currentMode !== 'discover' || showingDetail || showingPdf) return;
  // 自动搜索运行时清除手动搜索状态
  if (isManualSearchActive) {
    isManualSearchActive = false;
    manualSearchPapers = [];
    manualSearchQuery = '';
    hideBackToAutoSearchButton();
  }
  const text = getEditorText();
  if (!text || text.length < 8) {
    currentSearchId++;
    cancelActiveSearch();
    discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">在编辑器中输入至少8个字符，将自动搜索相关论文</div>';
    cachedPapers = [];
    cachedText = '';
    resetDiscoverSearch();
    return;
  }
  if (text === cachedText && cachedPapers.length > 0) return;

  // AI 搜索状态提示
  const aiEnabled = window.essayflowDataState?.settings?.featureToggles?.aiSearch === true;
  const config = (typeof getAIConfig === 'function') ? getAIConfig() : null;
  const hasAI = aiEnabled && config && config.base_url && config.credential && config.model;

  if (!hasAI && cachedPapers.length === 0) {
    discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">正在根据内容搜索论文...</div>';
  }
  if (hasAI) {
    if (!aiSearchState.hasFullContext) {
      discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">AI正在理解全文...</div>';
    } else if (aiSearchState.isWaitingForAI) {
      discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">AI正在分析内容变化...</div>';
    }
  }

  const autoQuery = extractKeywords(text, 12);

  const searchId = ++currentSearchId;
  const searchController = createSearchController();
  let queryInfo;
  try {
    queryInfo = await buildSmartQueryWithAI(autoQuery);
  } catch (err) {
    if (searchId === currentSearchId) {
      console.error('AI 搜索词生成失败:', err);
      notify('AI 关键词生成失败，已改用自动关键词', 'warning');
      queryInfo = { finalQuery: autoQuery, aiQuery: '', baseQuery: autoQuery, priorityKeywords: getPriorityKeywords() };
    } else {
      releaseSearchController(searchController);
      return;
    }
  }

  if (searchId !== currentSearchId) {
    releaseSearchController(searchController);
    return;
  }

  // 开始流式搜索
  resetDiscoverSearch();
  discoverSearchState.query = queryInfo.finalQuery;
  discoverSearchState.isSearching = true;

  const allPapers = [];
  let hasShownFirstBatch = false;

  // 创建"正在搜索..."提示
  const searchHint = document.createElement('div');
  searchHint.className = 'search-status-hint';
  searchHint.style.cssText = 'color:#888; text-align:center; padding:16px; font-size:13px;';
  searchHint.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e6b422;margin-right:6px;animation:pulse 1.2s infinite;"></span>正在搜索...';

  try {
    await searchWithBlend(queryInfo, {
      limit: 20,
      signal: searchController.signal,
      onBatch: async (sourceName, papers) => {
        if (searchId !== currentSearchId || searchController.signal.aborted) return;
        if (!hasShownFirstBatch && papers.length > 0) {
          hasShownFirstBatch = true;
          cachedPapers = [];
          cachedText = text;
          if (currentMode === 'discover' && !showingDetail && !showingPdf) discoverResults.innerHTML = '';
        }
        allPapers.push(...papers);
        cachedPapers = allPapers.slice();
        if (currentMode !== 'discover' || showingDetail || showingPdf) return;
        const existingHint = discoverResults.querySelector('.search-status-hint');
        if (existingHint) existingHint.remove();
        for (let i = 0; i < papers.length; i++) {
          const p = papers[i];
          discoverResults.appendChild(createPaperCard(p, false, true));
          const btn = discoverResults.querySelector('.expand-search-btn');
          if (btn) discoverResults.appendChild(btn);
          if (i < papers.length - 1) await delayWithSignal(120, searchController.signal);
        }
        if (discoverSearchState.isSearching) {
          const currentHint = discoverResults.querySelector('.search-status-hint');
          if (!currentHint) discoverResults.appendChild(searchHint);
        }
      }
    });

    if (searchId !== currentSearchId) {
      return;
    }
    if (currentMode !== 'discover' || showingDetail || showingPdf) return;

    const finalHint = discoverResults.querySelector('.search-status-hint');
    if (finalHint) finalHint.remove();

    if (allPapers.length === 0) {
      if (cachedPapers.length === 0) {
        discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">未找到相关论文</div>';
      } else {
        renderCachedResults();
        notify('搜索服务繁忙，正在显示上次结果');
      }
      return;
    }
    cachedText = text;
    cachedPapers = allPapers.slice();
    appendExpandButton();
  } catch (err) {
    if (err.name === 'AbortError' || searchId !== currentSearchId) return;
    console.error('搜索出错:', err);
    const finalHint = discoverResults.querySelector('.search-status-hint');
    if (finalHint) finalHint.remove();
    if (allPapers.length > 0 || cachedPapers.length > 0) {
      cachedPapers = allPapers.length > 0 ? allPapers.slice() : cachedPapers;
      renderCachedResults();
      notify(allPapers.length > 0 ? '部分论文来源暂时不可用' : '搜索服务繁忙，正在显示上次结果', 'warning');
    } else {
      const message = err.code === 'NO_SEARCH_SOURCES' ? '请先在设置中启用至少一个论文来源' : '搜索服务暂时不可用';
      discoverResults.innerHTML = `<div style="color:#888; text-align:center; padding:20px;">${message}</div>`;
    }
  } finally {
    releaseSearchController(searchController);
    if (searchId === currentSearchId) {
      discoverSearchState.isSearching = false;
      const finalHint = discoverResults.querySelector('.search-status-hint');
      if (finalHint) finalHint.remove();
    }
  }
}

// ================== 手动搜索 ==================
async function manualSearch(query) {
  query = asText(query);
  if (!query) return;
  const needsModeSwitch = currentMode !== 'discover';
  if (showingPdf) cleanupPdfPreview();
  showingDetail = false;
  showingPdf = false;
  isManualSearchActive = true;
  manualSearchQuery = query;
  manualSearchPapers = [];
  if (needsModeSwitch) switchMode('discover');

  resetDiscoverSearch();
  discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">手动搜索中...</div>';

  const searchId = ++currentSearchId;
  const searchController = createSearchController();
  let queryInfo;
  try {
    queryInfo = await buildSmartQueryWithAI(query);
  } catch (err) {
    if (searchId !== currentSearchId) {
      releaseSearchController(searchController);
      return;
    }
    console.error('AI 搜索词生成失败:', err);
    notify('AI 关键词生成失败，已改用输入关键词', 'warning');
    queryInfo = { finalQuery: query, aiQuery: '', baseQuery: query, priorityKeywords: '' };
  }

  if (searchId !== currentSearchId) {
    releaseSearchController(searchController);
    return;
  }

  discoverSearchState.query = queryInfo.finalQuery;
  discoverSearchState.isSearching = true;

  const allPapers = [];
  let hasShownFirstBatch = false;

  const searchHint = document.createElement('div');
  searchHint.className = 'search-status-hint';
  searchHint.style.cssText = 'color:#888; text-align:center; padding:16px; font-size:13px;';
  searchHint.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e6b422;margin-right:6px;animation:pulse 1.2s infinite;"></span>正在搜索...';

  try {
    await searchWithBlend(queryInfo, {
      limit: 25,
      signal: searchController.signal,
      onBatch: async (sourceName, papers) => {
        if (searchId !== currentSearchId || searchController.signal.aborted) return;
        if (!hasShownFirstBatch && papers.length > 0) {
          hasShownFirstBatch = true;
          manualSearchPapers = [];
          if (currentMode === 'discover' && !showingDetail && !showingPdf) discoverResults.innerHTML = '';
        }
        allPapers.push(...papers);
        manualSearchPapers = allPapers.slice();
        if (currentMode !== 'discover' || showingDetail || showingPdf) return;
        const existingHint = discoverResults.querySelector('.search-status-hint');
        if (existingHint) existingHint.remove();
        for (let i = 0; i < papers.length; i++) {
          const p = papers[i];
          discoverResults.appendChild(createPaperCard(p, false, true));
          const btn = discoverResults.querySelector('.expand-search-btn');
          if (btn) discoverResults.appendChild(btn);
          if (i < papers.length - 1) await delayWithSignal(120, searchController.signal);
        }
        if (discoverSearchState.isSearching) {
          const currentHint = discoverResults.querySelector('.search-status-hint');
          if (!currentHint) discoverResults.appendChild(searchHint);
        }
      }
    });

    if (searchId !== currentSearchId) return;
    if (currentMode !== 'discover' || showingDetail || showingPdf) return;
    manualSearchPapers = allPapers.slice();

    const finalHint = discoverResults.querySelector('.search-status-hint');
    if (finalHint) finalHint.remove();

    if (allPapers.length === 0) {
      discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">未找到相关论文</div>';
      showBackToAutoSearchButton();
      return;
    }
    showBackToAutoSearchButton();
    appendExpandButton();
  } catch (err) {
    if (err.name === 'AbortError' || searchId !== currentSearchId) return;
    manualSearchPapers = allPapers.slice();
    const finalHint = discoverResults.querySelector('.search-status-hint');
    if (finalHint) finalHint.remove();
    if (manualSearchPapers.length > 0) {
      restoreDiscoverResults();
      notify('部分论文来源暂时不可用', 'warning');
    } else {
      const message = err.code === 'NO_SEARCH_SOURCES' ? '请先在设置中启用至少一个论文来源' : '搜索服务暂时不可用';
      discoverResults.innerHTML = `<div style="color:#888; text-align:center; padding:20px;">${message}</div>`;
    }
    showBackToAutoSearchButton();
  } finally {
    releaseSearchController(searchController);
    if (searchId === currentSearchId) {
      discoverSearchState.isSearching = false;
      const finalHint = discoverResults.querySelector('.search-status-hint');
      if (finalHint) finalHint.remove();
    }
  }
}

// ================== 文库渲染 ==================
function libraryElement(id) {
  return document.getElementById(id);
}

function setSelectOptions(select, values, firstLabel, labelFactory = value => value) {
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = firstLabel;
  select.appendChild(first);
  values.forEach(value => {
    const option = document.createElement('option');
    option.value = typeof value === 'object' ? value.value : value;
    option.textContent = typeof value === 'object' ? value.label : labelFactory(value);
    select.appendChild(option);
  });
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function libraryPaperYear(paper) {
  return paper.issued?.['date-parts']?.[0]?.[0] || String(paper.year || paper.published || '').match(/\d{4}/)?.[0] || '';
}

function libraryPaperSource(paper) {
  return asText(paper['container-title'] || paper.journal || paper.source || paper.publisher);
}

function refreshLibraryFilterOptions() {
  const years = [...new Set(libraryPapers.map(libraryPaperYear).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
  const sources = [...new Set(libraryPapers.map(libraryPaperSource).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const types = [...new Set(libraryPapers.map(paper => asText(paper.type)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
  const collections = libraryCollections.map(collection => ({ value: collection.collectionId, label: collection.name }));
  setSelectOptions(libraryElement('library-year-filter'), years, '全部年份');
  setSelectOptions(libraryElement('library-source-filter'), sources, '全部来源');
  setSelectOptions(libraryElement('library-type-filter'), types, '全部类型');
  setSelectOptions(libraryElement('library-collection-filter'), collections, '全部集合');
  setSelectOptions(libraryElement('library-batch-collection'), collections, '选择集合');
  renderLibraryFilterState();
}

const LIBRARY_FILTER_DEFINITIONS = Object.freeze([
  ['library-year-filter', '年份'], ['library-source-filter', '来源'], ['library-type-filter', '类型'],
  ['library-pdf-filter', 'PDF'], ['library-starred-filter', '星标'], ['library-collection-filter', '集合'],
  ['library-screening-filter', '筛选'], ['library-reading-filter', '阅读']
]);

function renderLibraryFilterState() {
  const host = libraryElement('library-active-filters');
  if (!host) return;
  host.replaceChildren();
  const active = LIBRARY_FILTER_DEFINITIONS.flatMap(([id, label]) => {
    const select = libraryElement(id);
    const value = select?.value || '';
    const option = value ? select.selectedOptions?.[0] : null;
    return value && option ? [{ id, label, value, text: option.textContent }] : [];
  });
  active.forEach(filter => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'library-filter-chip';
    chip.setAttribute('role', 'listitem');
    chip.setAttribute('aria-label', `移除筛选：${filter.label} ${filter.text}`);
    const text = document.createElement('span');
    text.textContent = `${filter.label} · ${filter.text}`;
    const remove = document.createElement('span');
    remove.className = 'library-chip-remove';
    remove.setAttribute('aria-hidden', 'true');
    remove.textContent = '×';
    chip.append(text, remove);
    chip.addEventListener('click', () => {
      const select = libraryElement(filter.id);
      if (select) select.value = '';
      scheduleLibraryRender();
    });
    host.appendChild(chip);
  });
  const count = libraryElement('library-filter-count');
  if (count) {
    count.textContent = String(active.length);
    count.hidden = active.length === 0;
  }
  const clear = libraryElement('library-clear-filters');
  if (clear) clear.hidden = active.length === 0 && !(libraryElement('library-query')?.value || '').trim();
}

function currentLibraryQuery() {
  const [sortBy, direction] = (libraryElement('library-sort')?.value || 'updatedAt:desc').split(':');
  const project = window.getEssayflowProjectContext?.() || {};
  const hasSavedProject = Boolean(project.projectId) && Number.isSafeInteger(project.revision) && project.revision >= 0;
  const pdf = libraryElement('library-pdf-filter')?.value;
  const starred = libraryElement('library-starred-filter')?.value;
  const query = {
    search: libraryElement('library-query')?.value.trim() || '',
    year: libraryElement('library-year-filter')?.value || undefined,
    source: libraryElement('library-source-filter')?.value || undefined,
    type: libraryElement('library-type-filter')?.value || undefined,
    collectionId: libraryElement('library-collection-filter')?.value || undefined,
    screeningStatus: hasSavedProject ? (libraryElement('library-screening-filter')?.value || undefined) : undefined,
    readingStatus: hasSavedProject ? (libraryElement('library-reading-filter')?.value || undefined) : undefined,
    projectId: hasSavedProject ? project.projectId : undefined,
    hasPdf: pdf ? pdf === 'yes' : undefined,
    starred: starred ? starred === 'yes' : undefined,
    sortBy,
    direction,
    offset: libraryViewState.offset,
    limit: libraryViewState.limit
  };
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''));
}

function fallbackLibraryQuery(query) {
  const terms = asText(query.search).toLocaleLowerCase('und').split(/\s+/).filter(Boolean);
  const collection = query.collectionId ? libraryCollections.find(value => value.collectionId === query.collectionId) : null;
  const collectionIds = collection ? new Set(collection.itemIds) : null;
  let items = libraryPapers.filter(paper => {
    const id = paper.libraryItemId || paper.id;
    if (collectionIds && !collectionIds.has(id)) return false;
    if (query.year && String(libraryPaperYear(paper)) !== String(query.year)) return false;
    if (query.source && libraryPaperSource(paper) !== query.source) return false;
    if (query.type && paper.type !== query.type) return false;
    if (query.hasPdf !== undefined && paper.hasPdf !== query.hasPdf) return false;
    if (query.starred !== undefined && (paper.starred === true) !== query.starred) return false;
    const haystack = [paper.title, paper.authors, paper.author, paper.doi, paper.DOI, (paper.tags || []).join(' '), paper.privateNote, paper.note]
      .map(value => asText(value)).join(' ').toLocaleLowerCase('und');
    return terms.every(term => haystack.includes(term));
  });
  const total = items.length;
  items = items.slice(query.offset || 0, (query.offset || 0) + (query.limit || 100));
  return { revision: libraryRevision, total, offset: query.offset || 0, limit: query.limit || 100, items };
}

function updateLibrarySelectionUi() {
  const count = libraryElement('library-selection-count');
  if (count) count.textContent = `已选 ${librarySelectedIds.size} 篇`;
  const pageIds = libraryViewState.items.map(item => item.libraryItemId).filter(Boolean);
  const selectPage = libraryElement('library-select-page');
  if (selectPage) {
    selectPage.checked = pageIds.length > 0 && pageIds.every(id => librarySelectedIds.has(id));
    selectPage.indeterminate = pageIds.some(id => librarySelectedIds.has(id)) && !selectPage.checked;
  }
  const undo = libraryElement('library-batch-undo');
  if (undo) undo.disabled = !libraryViewState.undoToken;
  const batchToggle = libraryElement('library-batch-toggle');
  if (batchToggle) batchToggle.textContent = librarySelectedIds.size ? `批量操作 · ${librarySelectedIds.size}` : '批量操作';
}

function createLibraryPager() {
  const pager = document.createElement('nav');
  pager.className = 'library-pager';
  pager.setAttribute('aria-label', '文库分页');
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.textContent = '‹';
  previous.setAttribute('aria-label', '上一页');
  previous.disabled = libraryViewState.offset === 0;
  previous.addEventListener('click', () => {
    libraryViewState.offset = Math.max(0, libraryViewState.offset - libraryViewState.limit);
    renderLibrary();
  });
  const info = document.createElement('span');
  const page = Math.floor(libraryViewState.offset / libraryViewState.limit) + 1;
  const pages = Math.max(1, Math.ceil(libraryViewState.total / libraryViewState.limit));
  info.textContent = `第 ${page}/${pages} 页，共 ${libraryViewState.total} 篇`;
  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = '›';
  next.setAttribute('aria-label', '下一页');
  next.disabled = libraryViewState.offset + libraryViewState.limit >= libraryViewState.total;
  next.addEventListener('click', () => {
    libraryViewState.offset += libraryViewState.limit;
    renderLibrary();
  });
  pager.append(previous, info, next);
  return pager;
}

function createLibraryCard(paper) {
  const card = createPaperCard(paper, true, false);
  const id = paper.libraryItemId;
  if (id) {
    const selection = document.createElement('label');
    selection.className = 'library-card-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = librarySelectedIds.has(id);
    checkbox.setAttribute('aria-label', `选择《${paper.title}》`);
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', () => {
      checkbox.checked ? librarySelectedIds.add(id) : librarySelectedIds.delete(id);
      updateLibrarySelectionUi();
    });
    const label = document.createElement('span');
    label.textContent = paper.starred ? '★ 已星标' : '选择';
    selection.append(checkbox, label);
    card.prepend(selection);
  }
  if (paper.projectPaperState || paper.isCited) {
    const status = document.createElement('div');
    status.className = 'library-card-status';
    if (paper.isCited) {
      const cited = document.createElement('span');
      cited.textContent = '正文已引用';
      status.appendChild(cited);
    }
    if (paper.projectPaperState) {
      const screening = document.createElement('span');
      screening.textContent = { pending: '待筛选', included: '已纳入', excluded: '已排除' }[paper.projectPaperState.screeningStatus] || paper.projectPaperState.screeningStatus;
      const reading = document.createElement('span');
      reading.textContent = { unread: '未读', 'to-read': '待读', reading: '阅读中', read: '已读' }[paper.projectPaperState.readingStatus] || paper.projectPaperState.readingStatus;
      status.append(screening, reading);
    }
    card.insertBefore(status, card.querySelector('.paper-footer'));
  }
  return card;
}

async function renderLibrary() {
  if (currentMode !== 'library' || showingDetail || showingPdf) return;
  const token = ++libraryRenderToken;
  refreshLibraryFilterOptions();
  libraryResults.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'search-status-hint';
  loading.textContent = '正在加载文库...';
  libraryResults.appendChild(loading);
  try {
    const query = currentLibraryQuery();
    const result = window.electronAPI?.queryCitationLibrary
      ? await window.electronAPI.queryCitationLibrary(query)
      : fallbackLibraryQuery(query);
    if (token !== libraryRenderToken || currentMode !== 'library') return;
    libraryRevision = result.revision;
    libraryViewState.total = result.total;
    libraryViewState.items = (result.items || []).map(item => normalizePaper(item));
    libraryViewState.projectRevision = Number.isSafeInteger(result.projectRevision) ? result.projectRevision : null;
    if (libraryViewState.offset > 0 && !libraryViewState.items.length && result.total > 0) {
      libraryViewState.offset = Math.max(0, Math.floor((result.total - 1) / libraryViewState.limit) * libraryViewState.limit);
      return renderLibrary();
    }
    libraryResults.replaceChildren();
    if (!result.total) {
      const empty = document.createElement('div');
      empty.className = 'search-status-hint';
      empty.textContent = libraryPapers.length ? '没有符合当前条件的文献' : '暂无论文，请从“发现”或标准引用文件导入';
      libraryResults.appendChild(empty);
    } else {
      libraryViewState.items.forEach(paper => libraryResults.appendChild(createLibraryCard(paper)));
      libraryResults.appendChild(createLibraryPager());
    }
    updateLibrarySelectionUi();
  } catch (error) {
    if (token !== libraryRenderToken) return;
    libraryResults.replaceChildren();
    const failure = document.createElement('div');
    failure.className = 'search-status-hint';
    failure.textContent = `文库加载失败：${error.message || '请重试'}`;
    libraryResults.appendChild(failure);
  }
}

function createCitationDialog(title) {
  const backdrop = document.createElement('div');
  backdrop.className = 'citation-dialog-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'citation-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);
  const heading = document.createElement('h2');
  heading.textContent = title;
  const body = document.createElement('div');
  const actions = document.createElement('div');
  actions.className = 'citation-dialog-actions';
  dialog.append(heading, body, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  const onKeydown = event => {
    if (event.key !== 'Escape') return;
    document.removeEventListener('keydown', onKeydown);
    close();
  };
  document.addEventListener('keydown', onKeydown);
  return { backdrop, dialog, body, actions, close };
}

function prettyCitationValue(value) {
  if (value === undefined) return '未提供';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

async function importStandardCitations() {
  if (!window.electronAPI?.selectCitationImport) return;
  try {
    const plan = await window.electronAPI.selectCitationImport();
    if (plan?.canceled) return;
    const modal = createCitationDialog(`导入 ${plan.fileName || '引用文件'}`);
    const summary = document.createElement('p');
    summary.textContent = `识别 ${plan.parsedCount} 条；新增 ${plan.additions.length} 条；待合并 ${plan.matches.length} 条；拒绝 ${plan.rejectedCount} 条。`;
    modal.body.appendChild(summary);
    if (plan.errors?.length) {
      const errors = document.createElement('ul');
      errors.className = 'citation-loss-list';
      plan.errors.slice(0, 20).forEach(error => {
        const item = document.createElement('li');
        item.textContent = `第 ${Number(error.index) + 1} 条：${error.message || error.code}`;
        errors.appendChild(item);
      });
      modal.body.appendChild(errors);
    }
    plan.matches.forEach(match => {
      const section = document.createElement('section');
      section.className = 'citation-conflict';
      section.dataset.incomingId = match.incomingItemId;
      const heading = document.createElement('strong');
      heading.textContent = `重复文献（${match.reason === 'doi' ? 'DOI' : '标题/作者/年份'} 匹配）`;
      section.appendChild(heading);
      if (match.ambiguousExistingIds?.length) {
        const target = document.createElement('select');
        target.className = 'citation-conflict-target';
        target.setAttribute('aria-label', '选择本地合并目标');
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '选择合并目标';
        target.appendChild(placeholder);
        [match.existingItemId, ...match.ambiguousExistingIds].forEach(id => {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = id;
          target.appendChild(option);
        });
        section.appendChild(target);
      }
      match.conflicts.forEach(conflict => {
        const row = document.createElement('div');
        row.className = 'citation-conflict';
        row.dataset.field = conflict.field;
        const name = document.createElement('div');
        name.textContent = `字段：${conflict.field}${conflict.requiresUserChoice ? '（必须选择）' : ''}`;
        const values = document.createElement('div');
        values.className = 'citation-conflict-values';
        const existing = document.createElement('pre');
        existing.textContent = `本地 [${conflict.existingSource}]\n${prettyCitationValue(conflict.existing)}`;
        const incoming = document.createElement('pre');
        incoming.textContent = `导入 [${conflict.incomingSource}]\n${prettyCitationValue(conflict.incoming)}`;
        values.append(existing, incoming);
        const choice = document.createElement('select');
        choice.className = 'citation-field-choice';
        choice.setAttribute('aria-label', `${conflict.field} 字段选择`);
        if (conflict.requiresUserChoice) {
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = '请选择保留值';
          choice.appendChild(placeholder);
        }
        [['existing', '保留本地'], ['incoming', '使用导入值']].forEach(([value, label]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          choice.appendChild(option);
        });
        if (!conflict.requiresUserChoice) choice.value = 'existing';
        row.append(name, values, choice);
        section.appendChild(row);
      });
      modal.body.appendChild(section);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', modal.close);
    const commit = document.createElement('button');
    commit.type = 'button';
    commit.textContent = '确认导入';
    commit.addEventListener('click', async () => {
      const decisions = {};
      for (const section of modal.body.querySelectorAll('section[data-incoming-id]')) {
        const fields = {};
        for (const row of section.querySelectorAll('[data-field]')) {
          const choice = row.querySelector('.citation-field-choice').value;
          if (!choice) {
            notify(`字段 ${row.dataset.field} 尚未选择`, 'warning');
            row.querySelector('.citation-field-choice').focus();
            return;
          }
          fields[row.dataset.field] = choice;
        }
        const target = section.querySelector('.citation-conflict-target');
        if (target && !target.value) {
          notify('请选择重复文献的合并目标', 'warning');
          target.focus();
          return;
        }
        decisions[section.dataset.incomingId] = { fields, ...(target ? { existingItemId: target.value } : {}) };
      }
      commit.disabled = true;
      try {
        const result = await window.electronAPI.commitCitationImport({ sessionId: plan.sessionId, baseRevision: libraryRevision, decisions });
        if (!result?.durable) throw new Error('导入提交未获得 durable 确认');
        modal.close();
        await loadLibrary();
        notify(`已导入 ${result.importedCount} 条，合并 ${result.mergedCount} 条`);
      } catch (error) {
        notify(`引用导入失败：${error.message || '请重试'}`, 'error');
      } finally {
        commit.disabled = false;
      }
    });
    modal.actions.append(cancel, commit);
    commit.focus();
  } catch (error) {
    notify(`无法导入引用：${error.message || '文件格式错误'}`, 'error');
  }
}

function showCitationLossReport(result, format) {
  const report = result.lossReport || {};
  const modal = createCitationDialog('文库导出报告');
  const summary = document.createElement('p');
  summary.textContent = report.lossless
    ? `${format.toUpperCase()} 已导出 ${result.itemCount} 条，支持字段无损。`
    : `${format.toUpperCase()} 已导出 ${result.itemCount} 条；${report.affectedItemCount || 0} 条存在格式无法表达的字段。`;
  modal.body.appendChild(summary);
  if (result.filePath) {
    const file = document.createElement('p');
    file.textContent = `保存位置：${result.filePath}`;
    modal.body.appendChild(file);
  }
  if (report.entries?.length) {
    const list = document.createElement('ul');
    list.className = 'citation-loss-list';
    report.entries.slice(0, 100).forEach(entry => {
      const row = document.createElement('li');
      row.textContent = `${entry.libraryItemId}：未表达 ${entry.lostFields?.join('、') || '无'}${entry.warnings?.length ? `；${entry.warnings.join('；')}` : ''}`;
      list.appendChild(row);
    });
    modal.body.appendChild(list);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.addEventListener('click', modal.close);
  modal.actions.appendChild(close);
  close.focus();
}

async function exportStandardCitations(itemIds) {
  const format = libraryElement('library-export-format')?.value || 'csl-json';
  try {
    const result = await window.electronAPI.exportLibraryCitations({ format, ...(itemIds?.length ? { itemIds } : {}) });
    if (!result?.success) return;
    showCitationLossReport(result, format);
  } catch (error) {
    notify(`文库导出失败：${error.message || '请重试'}`, 'error');
  }
}

function selectedLibraryIds() {
  const ids = [...librarySelectedIds];
  if (!ids.length) notify('请先选择至少一篇文献', 'warning');
  return ids;
}

async function runLibraryBatch(operation, message) {
  const itemIds = selectedLibraryIds();
  if (!itemIds.length) return null;
  const project = window.getEssayflowProjectContext?.() || {};
  const projectOperation = operation.type === 'set-project-state';
  const baseRevision = projectOperation ? libraryViewState.projectRevision : libraryRevision;
  if (!Number.isSafeInteger(baseRevision)) {
    notify(projectOperation ? '当前项目尚未保存，不能设置项目状态' : '文库 revision 无效', 'warning');
    return null;
  }
  const result = await window.electronAPI.applyCitationLibraryBatch({
    baseRevision,
    itemIds,
    operation: { ...operation, ...(projectOperation ? { projectId: project.projectId } : {}) }
  });
  if (!result?.durable) throw new Error('批量操作未获得 durable 确认');
  libraryViewState.undoToken = result.undoToken || '';
  libraryViewState.undoRevision = result.revision;
  if (projectOperation) {
    libraryViewState.projectRevision = result.revision;
    window.applyEssayflowProjectRevision?.(project.projectId, result.revision);
  } else {
    libraryRevision = result.revision;
  }
  librarySelectedIds.clear();
  await loadLibrary();
  notify(`${message}：${result.affectedCount} 篇`);
  return result;
}

async function deleteLibraryItems(itemIds = selectedLibraryIds()) {
  if (!itemIds.length) return;
  try {
    const impact = await window.electronAPI.getCitationLibraryImpact(itemIds);
    const projectText = impact.projects?.length
      ? `\n涉及项目：${impact.projects.map(project => `${project.title}（${project.citationCount} 处）`).join('、')}`
      : '';
    const accepted = window.confirm(`将从文库列表移除 ${itemIds.length} 篇文献。正文中的 ${impact.citationCount || 0} 处引用快照会保留，受管 PDF 不会删除。${projectText}\n\n是否继续？`);
    if (!accepted) return;
    librarySelectedIds.clear();
    itemIds.forEach(id => librarySelectedIds.add(id));
    await runLibraryBatch({ type: 'delete', retainManagedAssets: true }, '已从文库移除');
  } catch (error) {
    notify(`移除失败：${error.message || '请重试'}`, 'error');
  }
}

async function undoLibraryBatch() {
  if (!libraryViewState.undoToken || !Number.isSafeInteger(libraryViewState.undoRevision)) return;
  try {
    const result = await window.electronAPI.undoCitationLibraryBatch({
      undoToken: libraryViewState.undoToken,
      baseRevision: libraryViewState.undoRevision
    });
    libraryViewState.undoToken = '';
    libraryViewState.undoRevision = null;
    if (result.scope === 'project') {
      const project = window.getEssayflowProjectContext?.() || {};
      window.applyEssayflowProjectRevision?.(project.projectId, result.revision);
      libraryViewState.projectRevision = result.revision;
    } else {
      libraryRevision = result.revision;
    }
    await loadLibrary();
    notify('已撤销上一次批量操作');
  } catch (error) {
    notify(`撤销失败：${error.message || '数据已变化'}`, 'error');
  }
}

function scheduleLibraryRender() {
  clearTimeout(libraryQueryTimer);
  syncEnhancedSearchSelects();
  renderLibraryFilterState();
  libraryQueryTimer = setTimeout(() => {
    libraryViewState.offset = 0;
    renderLibrary();
  }, 180);
}

const enhancedSearchSelects = new Map();

function closeEnhancedSearchSelect(control, { restoreFocus = false } = {}) {
  if (!control?.wrapper.classList.contains('is-open')) return;
  control.wrapper.classList.remove('is-open');
  control.trigger.setAttribute('aria-expanded', 'false');
  control.menu.setAttribute('aria-hidden', 'true');
  if (restoreFocus) control.trigger.focus({ preventScroll: true });
}

function closeAllEnhancedSearchSelects(except) {
  enhancedSearchSelects.forEach(control => {
    if (control !== except) closeEnhancedSearchSelect(control);
  });
}

function syncEnhancedSearchSelect(select) {
  const control = enhancedSearchSelects.get(select);
  if (!control) return;
  const selected = select.options[select.selectedIndex] || select.options[0];
  control.value.textContent = selected?.textContent || '请选择';
  control.trigger.disabled = select.disabled;
  control.menu.querySelectorAll('.ef-select-option').forEach(option => {
    const isSelected = option.dataset.value === String(select.value);
    option.classList.toggle('is-selected', isSelected);
    option.setAttribute('aria-selected', String(isSelected));
  });
}

function rebuildEnhancedSearchSelect(select) {
  const control = enhancedSearchSelects.get(select);
  if (!control) return;
  control.menu.replaceChildren();
  [...select.options].forEach(option => {
    const item = document.createElement('div');
    item.className = 'ef-select-option';
    item.setAttribute('role', 'option');
    item.tabIndex = -1;
    item.dataset.value = option.value;
    item.textContent = option.textContent;
    item.setAttribute('aria-disabled', String(option.disabled));
    if (option.disabled) item.classList.add('is-disabled');
    const highlight = () => {
      control.menu.querySelectorAll('.ef-select-option.is-highlighted').forEach(other => other.classList.remove('is-highlighted'));
      item.classList.add('is-highlighted');
    };
    item.addEventListener('focus', highlight);
    item.addEventListener('pointerenter', highlight);
    item.addEventListener('blur', () => item.classList.remove('is-highlighted'));
    item.addEventListener('pointerleave', () => {
      if (document.activeElement !== item) item.classList.remove('is-highlighted');
    });
    item.addEventListener('pointerdown', event => event.preventDefault());
    item.addEventListener('click', event => {
      event.stopPropagation();
      if (option.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncEnhancedSearchSelect(select);
      closeEnhancedSearchSelect(control, { restoreFocus: true });
    });
    control.menu.appendChild(item);
  });
  syncEnhancedSearchSelect(select);
}

function focusEnhancedSelectOption(control, direction = 0) {
  const options = [...control.menu.querySelectorAll('.ef-select-option:not(.is-disabled)')];
  if (!options.length) return;
  const active = document.activeElement;
  let index = options.indexOf(active);
  if (index < 0) index = Math.max(0, options.findIndex(option => option.classList.contains('is-selected')));
  index = Math.max(0, Math.min(options.length - 1, index + direction));
  options.forEach(option => option.classList.remove('is-highlighted'));
  options[index].classList.add('is-highlighted');
  options[index].focus({ preventScroll: true });
}

function openEnhancedSearchSelect(control, direction = 0) {
  closeAllEnhancedSearchSelects(control);
  const pendingMutations = control.observer?.takeRecords() || [];
  if (pendingMutations.length) rebuildEnhancedSearchSelect(control.select);
  else syncEnhancedSearchSelect(control.select);
  control.wrapper.classList.add('is-open');
  control.trigger.setAttribute('aria-expanded', 'true');
  control.menu.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => focusEnhancedSelectOption(control, direction));
}

function enhanceSearchSelect(select) {
  if (!select || enhancedSearchSelects.has(select)) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'ef-select';
  wrapper.dataset.selectId = select.id || '';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ef-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '选择选项');
  const value = document.createElement('span');
  value.className = 'ef-select-value';
  const chevron = document.createElement('span');
  chevron.className = 'ef-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron);
  const menu = document.createElement('div');
  menu.id = `ef-select-menu-${select.id || enhancedSearchSelects.size + 1}`;
  menu.className = 'ef-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-hidden', 'true');
  menu.setAttribute('aria-label', select.getAttribute('aria-label') || '可选项');
  trigger.setAttribute('aria-controls', menu.id);
  wrapper.append(trigger, menu);
  select.classList.add('ef-native-select');
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;
  select.insertAdjacentElement('afterend', wrapper);
  const control = { select, wrapper, trigger, value, menu, observer: null };
  enhancedSearchSelects.set(select, control);
  trigger.addEventListener('click', event => {
    event.stopPropagation();
    if (wrapper.classList.contains('is-open')) closeEnhancedSearchSelect(control);
    else openEnhancedSearchSelect(control);
  });
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openEnhancedSearchSelect(control, event.key === 'ArrowUp' ? Number.MAX_SAFE_INTEGER : 0);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEnhancedSearchSelect(control, { restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusEnhancedSelectOption(control, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = [...menu.querySelectorAll('.ef-select-option:not(.is-disabled)')];
      options[event.key === 'Home' ? 0 : options.length - 1]?.focus({ preventScroll: true });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      document.activeElement?.classList.contains('ef-select-option') && document.activeElement.click();
    } else if (event.key === 'Tab') {
      closeEnhancedSearchSelect(control);
    }
  });
  select.addEventListener('change', () => syncEnhancedSearchSelect(select));
  control.observer = new MutationObserver(records => {
    // openEnhancedSearchSelect may already consume pending records with
    // takeRecords(). Ignore the subsequently queued empty callback so the
    // option under the pointer is never replaced a second time.
    if (records.length) rebuildEnhancedSearchSelect(select);
  });
  control.observer.observe(select, { childList: true, subtree: true, attributes: true });
  rebuildEnhancedSearchSelect(select);
}

function enhanceSearchPanelSelects() {
  document.querySelectorAll('#search-header select, #library-controls select, #evidence-controls select').forEach(enhanceSearchSelect);
}

function syncEnhancedSearchSelects() {
  enhancedSearchSelects.forEach(control => syncEnhancedSearchSelect(control.select));
}

// Review tools load after the search workspace and reuse the exact same select
// treatment. The native select remains the source of truth for existing change
// handlers while this helper supplies EssayFlow's visible, keyboard-safe UI.
window.enhanceEssayflowSelect = enhanceSearchSelect;
window.syncEssayflowSelect = syncEnhancedSearchSelect;

document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.ef-select')) closeAllEnhancedSearchSelects();
});

function animateLibrarySubpanel(panel, expanded, focusSelector) {
  if (!panel) return;
  panel.dataset.motionState = expanded ? 'open' : 'closed';
  panel.getAnimations?.().forEach(animation => animation.cancel());
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const focusFirstControl = () => {
    if (panel.dataset.motionState === 'open') panel.querySelector(focusSelector)?.focus({ preventScroll: true });
  };
  if (expanded) {
    panel.hidden = false;
    if (reducedMotion || typeof panel.animate !== 'function') {
      focusFirstControl();
      return;
    }
    const style = getComputedStyle(panel);
    const expandedHeight = panel.getBoundingClientRect().height;
    panel.style.overflow = 'hidden';
    const animation = panel.animate([
      { height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0, transform: 'translateY(-5px)' },
      { height: `${expandedHeight}px`, marginTop: style.marginTop, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth, opacity: 1, transform: 'translateY(0)' }
    ], { duration: 320, easing: 'cubic-bezier(0.22, 0.78, 0.22, 1)' });
    animation.finished.then(() => {
      panel.style.overflow = '';
      focusFirstControl();
    }).catch(() => {});
    return;
  }
  const finishClose = () => {
    if (panel.dataset.motionState === 'closed') panel.hidden = true;
  };
  if (reducedMotion || typeof panel.animate !== 'function') {
    finishClose();
    return;
  }
  const style = getComputedStyle(panel);
  panel.style.overflow = 'hidden';
  const animation = panel.animate([
    { height: `${panel.getBoundingClientRect().height}px`, marginTop: style.marginTop, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth, opacity: 1, transform: 'translateY(0)' },
    { height: '0px', marginTop: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0, transform: 'translateY(-5px)' }
  ], { duration: 320, easing: 'cubic-bezier(0.22, 0.78, 0.22, 1)' });
  animation.finished.then(() => {
    panel.style.overflow = '';
    finishClose();
  }).catch(() => {});
}

function setupLibraryControls() {
  const filterIds = ['library-query', 'library-year-filter', 'library-source-filter', 'library-type-filter', 'library-pdf-filter', 'library-starred-filter', 'library-collection-filter', 'library-screening-filter', 'library-reading-filter', 'library-sort'];
  filterIds.forEach(id => {
    const element = libraryElement(id);
    if (!element) return;
    element.addEventListener(element.tagName === 'INPUT' ? 'input' : 'change', scheduleLibraryRender);
  });
  const libraryQuery = libraryElement('library-query');
  const librarySearchField = libraryQuery?.closest('.library-search-field');
  libraryQuery?.addEventListener('focus', () => librarySearchField?.classList.add('is-focused'));
  libraryQuery?.addEventListener('blur', () => librarySearchField?.classList.remove('is-focused'));
  const filterToggle = libraryElement('library-filter-toggle');
  const filterPanel = libraryElement('library-filter-panel');
  filterToggle?.addEventListener('click', () => {
    const expanded = filterToggle.getAttribute('aria-expanded') === 'true';
    filterToggle.setAttribute('aria-expanded', String(!expanded));
    animateLibrarySubpanel(filterPanel, !expanded, '.ef-select-trigger');
  });
  const batchToggle = libraryElement('library-batch-toggle');
  const batchPanel = libraryElement('library-batch-panel');
  batchToggle?.addEventListener('click', () => {
    const expanded = batchToggle.getAttribute('aria-expanded') === 'true';
    batchToggle.setAttribute('aria-expanded', String(!expanded));
    animateLibrarySubpanel(batchPanel, !expanded, '.ef-select-trigger, input, button');
  });
  libraryElement('library-clear-filters')?.addEventListener('click', () => {
    const query = libraryElement('library-query');
    if (query) query.value = '';
    LIBRARY_FILTER_DEFINITIONS.forEach(([id]) => {
      const select = libraryElement(id);
      if (select) select.value = '';
    });
    scheduleLibraryRender();
    query?.focus();
  });
  libraryElement('library-select-page')?.addEventListener('change', event => {
    libraryViewState.items.forEach(item => {
      if (!item.libraryItemId) return;
      event.target.checked ? librarySelectedIds.add(item.libraryItemId) : librarySelectedIds.delete(item.libraryItemId);
    });
    renderLibrary();
  });
  libraryElement('library-import-standard')?.addEventListener('click', importStandardCitations);
  libraryElement('library-export-standard')?.addEventListener('click', () => exportStandardCitations());
  libraryElement('library-batch-export')?.addEventListener('click', () => {
    const ids = selectedLibraryIds();
    if (ids.length) exportStandardCitations(ids);
  });
  libraryElement('library-batch-star')?.addEventListener('click', () => runLibraryBatch({ type: 'set-starred', value: true }, '已加星').catch(error => notify(error.message, 'error')));
  libraryElement('library-batch-add-tags')?.addEventListener('click', () => {
    const tags = asText(libraryElement('library-batch-tags')?.value).split(/[,，]/).map(value => value.trim()).filter(Boolean);
    if (!tags.length) return notify('请输入至少一个标签', 'warning');
    runLibraryBatch({ type: 'tags-add', tags }, '已添加标签').catch(error => notify(error.message, 'error'));
  });
  libraryElement('library-batch-add-collection')?.addEventListener('click', async () => {
    let collectionId = libraryElement('library-batch-collection')?.value;
    if (!collectionId) {
      const name = window.prompt('新集合名称');
      if (!name?.trim()) return;
      try {
        const created = await window.electronAPI.upsertCitationLibraryCollection({ baseRevision: libraryRevision, name: name.trim() });
        libraryRevision = created.revision;
        libraryCollections = created.collections;
        collectionId = created.collection.collectionId;
        refreshLibraryFilterOptions();
      } catch (error) {
        return notify(`创建集合失败：${error.message || '请重试'}`, 'error');
      }
    }
    runLibraryBatch({ type: 'collection-add', collectionId }, '已加入集合').catch(error => notify(error.message, 'error'));
  });
  libraryElement('library-batch-state')?.addEventListener('click', () => {
    const screeningStatus = libraryElement('library-batch-screening')?.value;
    const readingStatus = libraryElement('library-batch-reading')?.value;
    if (!screeningStatus || !readingStatus) return notify('请同时选择筛选状态和阅读状态', 'warning');
    const exclusionReason = screeningStatus === 'excluded' ? window.prompt('请输入排除原因') : '';
    if (screeningStatus === 'excluded' && !exclusionReason?.trim()) return;
    runLibraryBatch({ type: 'set-project-state', screeningStatus, readingStatus, exclusionReason: exclusionReason || '' }, '已更新项目状态').catch(error => notify(error.message, 'error'));
  });
  libraryElement('library-batch-delete')?.addEventListener('click', () => deleteLibraryItems());
  libraryElement('library-batch-undo')?.addEventListener('click', undoLibraryBatch);
}

// ================== 模式切换 ==================
const searchToggleWrapper = searchToggleBtn?.closest('.search-toggle-wrapper');
const detailedSearchState = { library: false, evidence: false };
let compactSearchPinned = false;
let compactSearchCloseTimer = null;

function detailedControlsForMode(mode = currentMode) {
  if (mode === 'library') return libraryControls;
  if (mode === 'evidence') return evidenceControls;
  return null;
}

function updateSearchToggleState() {
  if (!searchToggleBtn || !searchInput || !searchExpandArea) return;
  const compactOpen = searchExpandArea.classList.contains('open');
  const detailOpen = Boolean(detailedSearchState[currentMode]);
  const modeLabels = {
    discover: { button: '搜索发现', input: '快速搜索发现', controls: 'search-expand-area' },
    library: { button: detailOpen ? '收起文库详细检索' : '展开文库详细检索', input: '快速搜索文库', controls: 'search-expand-area library-controls' },
    evidence: { button: detailOpen ? '收起证据详细检索' : '展开证据详细检索', input: '快速搜索证据', controls: 'search-expand-area evidence-controls' }
  };
  const labels = modeLabels[currentMode] || modeLabels.discover;
  searchToggleBtn.setAttribute('aria-label', labels.button);
  searchToggleBtn.setAttribute('aria-controls', labels.controls);
  searchToggleBtn.setAttribute('aria-expanded', String(compactOpen || detailOpen));
  searchToggleBtn.classList.toggle('detail-active', detailOpen);
  searchInput.placeholder = labels.input;
  searchInput.setAttribute('aria-label', labels.input);
  searchExpandArea.setAttribute('aria-hidden', String(!compactOpen));
}

function openCompactSearch({ focus = false, pin = false } = {}) {
  if (!searchExpandArea || (currentMode !== 'discover' && detailedSearchState[currentMode])) return;
  clearTimeout(compactSearchCloseTimer);
  if (pin) compactSearchPinned = true;
  searchExpandArea.classList.add('open');
  searchToggleWrapper?.classList.add('compact-open');
  updateSearchToggleState();
  if (focus) requestAnimationFrame(() => searchInput?.focus({ preventScroll: true }));
}

function closeCompactSearch({ force = false } = {}) {
  if (!searchExpandArea || (!force && compactSearchPinned)) return;
  clearTimeout(compactSearchCloseTimer);
  if (force) compactSearchPinned = false;
  searchExpandArea.classList.remove('open');
  searchToggleWrapper?.classList.remove('compact-open');
  updateSearchToggleState();
}

function hideDetailedControlsImmediately() {
  [libraryControls, evidenceControls].forEach(controls => {
    if (!controls) return;
    clearTimeout(controls._essayflowDetailHideTimer);
    controls.classList.remove('detail-search-open');
    controls.hidden = true;
  });
}

function setDetailedSearchOpen(mode, open, { focus = false } = {}) {
  const controls = detailedControlsForMode(mode);
  if (!controls) return;
  clearTimeout(controls._essayflowDetailHideTimer);
  detailedSearchState[mode] = Boolean(open);
  if (open) {
    closeCompactSearch({ force: true });
    controls.hidden = false;
    requestAnimationFrame(() => controls.classList.add('detail-search-open'));
    if (focus) {
      const target = mode === 'library' ? document.getElementById('library-query') : document.getElementById('evidence-query');
      setTimeout(() => target?.focus({ preventScroll: true }), 120);
    }
  } else {
    controls.classList.remove('detail-search-open');
    controls._essayflowDetailHideTimer = setTimeout(() => {
      if (!detailedSearchState[mode]) controls.hidden = true;
    }, 190);
  }
  updateSearchToggleState();
}

function switchMode(mode) {
  if (!['discover', 'library', 'evidence'].includes(mode)) return;
  const shouldCancelView = mode !== currentMode || showingDetail || showingPdf;
  if (shouldCancelView) {
    currentSearchId++;
    cancelActiveSearch();
    discoverSearchState.isSearching = false;
    discoverSearchState.isExpanding = false;
  }
  if (showingPdf) cleanupPdfPreview();
  closeCompactSearch({ force: true });
  detailedSearchState.library = false;
  detailedSearchState.evidence = false;
  hideDetailedControlsImmediately();
  currentMode = mode;
  showingDetail = false;
  showingPdf = false;
  [btnDiscover, btnLibrary, btnEvidence].forEach(button => button?.classList.remove('active'));
  discoverResults.style.display = 'none';
  libraryResults.style.display = 'none';
  evidenceResults.style.display = 'none';
  if (libraryHeaderActions) libraryHeaderActions.hidden = true;
  if (searchToggleWrapper) searchToggleWrapper.hidden = false;
  updateSearchToggleState();
  if (mode === 'discover') {
    btnDiscover.classList.add('active');
    discoverResults.style.display = 'block';
    hideBackToAutoSearchButton();

    // 如果处于手动搜索状态，恢复手动搜索结果（即使为空结果也保持手动搜索状态）
    if (isManualSearchActive) {
      restoreDiscoverResults();
      return;
    }

    const currentText = getEditorText();
    if (currentText === cachedText && cachedPapers.length > 0) {
      renderCachedResults();
    } else if (currentText.length >= 8) {
      autoDiscover();
    } else {
      discoverResults.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">在编辑器中输入至少8个字符，将自动搜索相关论文</div>';
    }
  } else if (mode === 'library') {
    btnLibrary.classList.add('active');
    libraryResults.style.display = 'block';
    if (libraryHeaderActions) libraryHeaderActions.hidden = false;
    hideBackToAutoSearchButton();
    renderLibrary();
  } else {
    btnEvidence?.classList.add('active');
    evidenceResults.style.display = 'block';
    hideBackToAutoSearchButton();
    window.refreshEssayflowEvidence?.();
  }
}

// ================== 搜索图标交互 ==================
searchToggleBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentMode === 'library' || currentMode === 'evidence') {
    setDetailedSearchOpen(currentMode, !detailedSearchState[currentMode], { focus: true });
    return;
  }
  if (searchExpandArea.classList.contains('open') && compactSearchPinned) closeCompactSearch({ force: true });
  else openCompactSearch({ focus: true, pin: true });
});

searchToggleWrapper?.addEventListener('pointerenter', () => {
  if (!detailedSearchState[currentMode]) openCompactSearch();
});
searchToggleWrapper?.addEventListener('pointerleave', () => {
  clearTimeout(compactSearchCloseTimer);
  compactSearchCloseTimer = setTimeout(() => {
    if (!searchToggleWrapper.matches(':focus-within')) closeCompactSearch();
  }, 160);
});
searchToggleWrapper?.addEventListener('focusin', () => {
  if (!detailedSearchState[currentMode]) openCompactSearch();
});
searchToggleWrapper?.addEventListener('focusout', () => {
  clearTimeout(compactSearchCloseTimer);
  compactSearchCloseTimer = setTimeout(() => {
    if (!searchToggleWrapper.matches(':hover') && !searchToggleWrapper.matches(':focus-within')) closeCompactSearch();
  }, 160);
});

document.addEventListener('click', (e) => {
  if (!searchToggleWrapper?.contains(e.target)) closeCompactSearch({ force: true });
});

searchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCompactSearch({ force: true });
    searchToggleBtn?.focus({ preventScroll: true });
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (currentMode === 'discover') {
      if (query) manualSearch(query);
    } else {
      const target = document.getElementById(currentMode === 'library' ? 'library-query' : 'evidence-query');
      if (target) {
        target.value = query;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    closeCompactSearch({ force: true });
    searchInput.value = '';
  }
});

// ================== 编辑器内容监听 ==================
function setupAutoSearchObserver() {
  const editorContent = document.querySelector('#editor-container .ql-editor');
  if (!editorContent) return;
  const observer = new MutationObserver(() => {
    if (currentMode !== 'discover' || showingDetail || showingPdf || isManualSearchActive) return;
    clearTimeout(autoSearchTimer);
    const aiEnabled = window.essayflowDataState?.settings?.featureToggles?.aiSearch === true;
    const debounceMs = aiEnabled ? 3000 : 1500;
    autoSearchTimer = setTimeout(async () => {
      const newText = getEditorText();
      if (newText !== cachedText) await autoDiscover();
    }, debounceMs);
  });
  observer.observe(editorContent, { childList: true, subtree: true, characterData: true });
  setTimeout(() => { if (currentMode === 'discover' && !isManualSearchActive) autoDiscover(); }, 1500);
}

// ================== 扩大搜索 ==================
async function expandSearch() {
  if (discoverSearchState.isSearching || discoverSearchState.isExpanding) return;
  if (!discoverSearchState.query) return;

  discoverSearchState.isExpanding = true;
  const searchId = currentSearchId;
  const searchController = createSearchController();

  // 创建"正在扩大搜索"提示
  const hint = document.createElement('div');
  hint.className = 'search-expanding-hint';
  hint.style.cssText = 'color:#888; text-align:center; padding:16px; font-size:13px;';
  hint.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#e6b422;margin-right:6px;animation:pulse 1.2s infinite;"></span>正在扩大搜索...';
  discoverResults.appendChild(hint);

  try {
    await searchPapers(discoverSearchState.query, {
      limit: 5,
      signal: searchController.signal,
      onBatch: async (sourceName, papers) => {
        if (searchId !== currentSearchId || searchController.signal.aborted) return;
        if (isManualSearchActive) manualSearchPapers.push(...papers);
        else cachedPapers.push(...papers);
        if (currentMode !== 'discover' || showingDetail || showingPdf) return;
        const existingHint = discoverResults.querySelector('.search-expanding-hint');
        if (existingHint) existingHint.remove();
        for (let i = 0; i < papers.length; i++) {
          discoverResults.appendChild(createPaperCard(papers[i], false, true));
          const btn = discoverResults.querySelector('.expand-search-btn');
          if (btn) discoverResults.appendChild(btn);
          if (i < papers.length - 1) await delayWithSignal(120, searchController.signal);
        }
        if (discoverSearchState.isExpanding) {
          const currentHint = discoverResults.querySelector('.search-expanding-hint');
          if (!currentHint) discoverResults.appendChild(hint);
        }
      }
    });
  } catch (err) {
    if (err.name !== 'AbortError' && searchId === currentSearchId) {
      console.error('扩大搜索出错:', err);
      notify('暂时无法扩大搜索，请稍后重试', 'warning');
    }
  } finally {
    releaseSearchController(searchController);
    if (searchId === currentSearchId) {
      const finalHint = discoverResults.querySelector('.search-expanding-hint');
      if (finalHint) finalHint.remove();
      discoverSearchState.isExpanding = false;
    }
  }
}

// ================== 扩大搜索按钮 ==================
function appendExpandButton() {
  if (discoverResults.querySelector('.expand-search-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'expand-search-btn';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;vertical-align:middle;">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    扩大搜索
  `;
  btn.addEventListener('click', () => {
    const query = discoverSearchState.query;
    btn.remove();
    expandSearch().then(() => {
      if (currentMode === 'discover' && discoverSearchState.query === query && !discoverSearchState.isSearching && !discoverSearchState.isExpanding) {
        appendExpandButton();
      }
    });
  });
  discoverResults.appendChild(btn);
}

function setupInfiniteScroll() {
  // 已改为按钮触发，此函数保留为空以避免其他地方调用报错
}

// ================== 初始化 ==================
window.essayflowLibraryReady = loadLibrary().catch(error => {
  console.error('[init] 文库加载失败:', error);
  notify(`文库加载失败：${error.message || '请重新启动应用'}`, 'error');
  return [];
});
btnDiscover.addEventListener('click', () => switchMode('discover'));
btnLibrary.addEventListener('click', () => switchMode('library'));
btnEvidence?.addEventListener('click', () => switchMode('evidence'));
setupLibraryControls();
enhanceSearchPanelSelects();
setupAutoSearchObserver();
setupInfiniteScroll();
if (currentMode === 'discover') autoDiscover();

// 导出到全局供 app.js 使用
window.libraryPapers = libraryPapers;
Object.defineProperty(window, 'currentMode', {
  get: () => currentMode,
  set: (val) => { currentMode = val; }
});
window.saveLibrary = saveLibrary;
window.renderLibrary = renderLibrary;
