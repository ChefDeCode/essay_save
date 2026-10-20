(() => {
  'use strict';

  const state = {
    document: null,
    container: null,
    paper: null,
    locator: '',
    descriptor: null,
    pages: new Map(),
    evidenceItems: [],
    token: 0
  };

  function collapseWhitespace(value) {
    return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function reset() {
    state.token += 1;
    state.document = null;
    state.container = null;
    state.paper = null;
    state.locator = '';
    state.descriptor = null;
    state.pages.clear();
    state.evidenceItems = [];
  }

  function bindDocument(options) {
    reset();
    state.document = options.document;
    state.container = options.container;
    state.paper = options.paper;
    state.locator = options.locator || '';
    state.descriptor = options.descriptor || null;
    state.evidenceItems = Array.isArray(options.evidenceItems) ? options.evidenceItems : [];
  }

  async function getPageText(pageNumber, page) {
    const existing = state.pages.get(pageNumber);
    if (existing?.textContent) return existing;
    const target = existing || { pageNumber, page };
    target.page = page || target.page || await state.document.getPage(pageNumber);
    target.textContent = await target.page.getTextContent({ includeMarkedContent: true });
    target.pageText = collapseWhitespace(target.textContent.items.map(item => item.str || '').join(' '));
    target.pageTextSha256 = await sha256(target.pageText);
    state.pages.set(pageNumber, target);
    return target;
  }

  function canonicalRect(viewport, cropBox, clientRect, shellRect) {
    const left = clientRect.left - shellRect.left;
    const top = clientRect.top - shellRect.top;
    const right = clientRect.right - shellRect.left;
    const bottom = clientRect.bottom - shellRect.top;
    const points = [
      viewport.convertToPdfPoint(left, top),
      viewport.convertToPdfPoint(right, top),
      viewport.convertToPdfPoint(left, bottom),
      viewport.convertToPdfPoint(right, bottom)
    ];
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const minX = Math.max(cropBox[0], Math.min(...xs));
    const maxX = Math.min(cropBox[2], Math.max(...xs));
    const minY = Math.max(cropBox[1], Math.min(...ys));
    const maxY = Math.min(cropBox[3], Math.max(...ys));
    const width = cropBox[2] - cropBox[0];
    const height = cropBox[3] - cropBox[1];
    return {
      x: (minX - cropBox[0]) / width,
      y: (minY - cropBox[1]) / height,
      width: (maxX - minX) / width,
      height: (maxY - minY) / height
    };
  }

  function evidenceOnPage(pageNumber) {
    return state.evidenceItems.filter(item => Number(item?.revision?.locator?.pageIndex) + 1 === pageNumber);
  }

  function renderHighlights(pageState) {
    const layer = pageState.highlightLayer;
    if (!layer) return;
    layer.replaceChildren();
    const cropBox = pageState.page.view;
    const cropWidth = cropBox[2] - cropBox[0];
    const cropHeight = cropBox[3] - cropBox[1];
    for (const item of evidenceOnPage(pageState.pageNumber)) {
      const color = item.card?.color || '#d5a623';
      for (const rect of item.revision?.locator?.rects || []) {
        const pdfRect = [
          cropBox[0] + rect.x * cropWidth,
          cropBox[1] + rect.y * cropHeight,
          cropBox[0] + (rect.x + rect.width) * cropWidth,
          cropBox[1] + (rect.y + rect.height) * cropHeight
        ];
        const converted = pageState.viewport.convertToViewportRectangle(pdfRect);
        const left = Math.min(converted[0], converted[2]);
        const top = Math.min(converted[1], converted[3]);
        const mark = document.createElement('span');
        mark.className = 'pdf-evidence-highlight';
        mark.dataset.evidenceId = item.card.id;
        mark.style.left = `${left}px`;
        mark.style.top = `${top}px`;
        mark.style.width = `${Math.abs(converted[2] - converted[0])}px`;
        mark.style.height = `${Math.abs(converted[3] - converted[1])}px`;
        mark.style.setProperty('--evidence-color', color);
        layer.appendChild(mark);
      }
    }
  }

  async function renderPage(options) {
    const pageState = await getPageText(options.pageNumber, options.page);
    pageState.wrapper = options.wrapper;
    pageState.viewport = options.viewport;
    pageState.highlightLayer = options.highlightLayer;
    const textLayer = options.textLayer;
    textLayer.replaceChildren();
    textLayer.style.width = `${options.viewport.width}px`;
    textLayer.style.height = `${options.viewport.height}px`;
    if (!pageState.textContent.items.some(item => String(item.str || '').trim())) {
      options.wrapper.dataset.noTextLayer = 'true';
      const notice = document.createElement('div');
      notice.className = 'pdf-ocr-notice';
      notice.textContent = '此页没有可选文本，当前版本不支持 OCR';
      options.wrapper.appendChild(notice);
    } else {
      options.wrapper.dataset.noTextLayer = 'false';
      const textDivs = [];
      const task = pdfjsLib.renderTextLayer({
        textContentSource: pageState.textContent,
        container: textLayer,
        viewport: options.viewport,
        textDivs
      });
      await task.promise;
      pageState.textLayer = textLayer;
      pageState.textDivs = textDivs;
    }
    renderHighlights(pageState);
    return pageState;
  }

  async function captureSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) throw new Error('请先在同一页选择 1-2000 个字符');
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
    const startShell = startElement?.closest('.pdf-page-shell');
    const endShell = endElement?.closest('.pdf-page-shell');
    if (!startShell || startShell !== endShell) throw new Error('跨页选文请拆分为两张证据卡');
    const pageNumber = Number(startShell.dataset.pageNumber);
    const pageState = state.pages.get(pageNumber);
    if (!pageState?.textLayer || startShell.dataset.noTextLayer === 'true') throw new Error('此页没有文本层，当前版本不支持 OCR');
    const quoteRaw = selection.toString().normalize('NFC');
    if (Array.from(quoteRaw).length < 1 || Array.from(quoteRaw).length > 2000) throw new Error('单次选文必须为 1-2000 个字符');
    const shellRect = startShell.getBoundingClientRect();
    const rects = [...range.getClientRects()]
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => canonicalRect(pageState.viewport, pageState.page.view, rect, shellRect))
      .filter(rect => rect.width > 0 && rect.height > 0);
    if (!rects.length) throw new Error('无法定位所选文本，请重新选择');
    const quoteDisplay = collapseWhitespace(quoteRaw);
    const exactIndex = pageState.pageText.indexOf(quoteDisplay);
    const before = exactIndex >= 0 ? pageState.pageText.slice(0, exactIndex) : '';
    const occurrenceIndex = exactIndex >= 0 ? before.split(quoteDisplay).length - 1 : 0;
    return {
      pageIndex: pageNumber - 1,
      pageLabel: `PDF 第 ${pageNumber} 页`,
      quoteRaw,
      quoteDisplay,
      pageTextSha256: pageState.pageTextSha256,
      prefix: exactIndex >= 0 ? pageState.pageText.slice(Math.max(0, exactIndex - 256), exactIndex) : '',
      suffix: exactIndex >= 0 ? pageState.pageText.slice(exactIndex + quoteDisplay.length, exactIndex + quoteDisplay.length + 256) : '',
      occurrenceIndex,
      rects,
      pageRotation: ((pageState.page.rotate % 360) + 360) % 360,
      cropBox: {
        x: pageState.page.view[0],
        y: pageState.page.view[1],
        width: pageState.page.view[2] - pageState.page.view[0],
        height: pageState.page.view[3] - pageState.page.view[1]
      },
      extractorName: 'pdfjs',
      extractorVersion: pdfjsLib.version || '3.11.174',
      transformVersion: 'pdfjs-viewport-v1',
      normalization: 'whitespace-collapse'
    };
  }

  async function search(query) {
    const needle = collapseWhitespace(query).toLocaleLowerCase('und');
    if (!needle || !state.document) return [];
    const matches = [];
    for (let pageNumber = 1; pageNumber <= state.document.numPages; pageNumber += 1) {
      const pageState = await getPageText(pageNumber);
      const text = pageState.pageText.toLocaleLowerCase('und');
      let index = text.indexOf(needle);
      let occurrence = 0;
      while (index >= 0 && occurrence < 100) {
        matches.push({ pageNumber, occurrence, preview: pageState.pageText.slice(Math.max(0, index - 32), index + needle.length + 48) });
        occurrence += 1;
        index = text.indexOf(needle, index + needle.length);
      }
    }
    return matches;
  }

  async function jumpToEvidence(item) {
    const pageNumber = Number(item?.revision?.locator?.pageIndex) + 1;
    const shell = state.container?.querySelector(`.pdf-page-shell[data-page-number="${pageNumber}"]`);
    if (!shell || item?.effectiveStatus && item.effectiveStatus !== 'active') return false;
    shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
    requestAnimationFrame(() => {
      shell.querySelectorAll(`[data-evidence-id="${item.card.id}"]`).forEach(mark => {
        mark.classList.add('is-target');
        setTimeout(() => mark.classList.remove('is-target'), 1800);
      });
    });
    return true;
  }

  function setEvidenceItems(items) {
    state.evidenceItems = Array.isArray(items) ? items : [];
    state.pages.forEach(renderHighlights);
  }

  window.essayflowPdfEvidence = {
    bindDocument,
    captureSelection,
    get descriptor() { return state.descriptor; },
    get locator() { return state.locator; },
    jumpToEvidence,
    renderPage,
    reset,
    search,
    setEvidenceItems,
    sha256
  };
})();
