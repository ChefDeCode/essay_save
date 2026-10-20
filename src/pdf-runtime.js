(function configureLocalPdfRuntime() {
  'use strict';

  if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== 'function') {
    throw new Error('PDF.js 本地运行资产加载失败');
  }

  const baseUrl = new URL('../node_modules/pdfjs-dist/', window.location.href);
  const localOptions = Object.freeze({
    cMapUrl: new URL('cmaps/', baseUrl).href,
    cMapPacked: true,
    isEvalSupported: false,
    standardFontDataUrl: new URL('standard_fonts/', baseUrl).href
  });
  const originalGetDocument = window.pdfjsLib.getDocument.bind(window.pdfjsLib);

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.min.js', baseUrl).href;
  window.essayFlowGetPdfDocument = function getDocumentWithLocalAssets(source) {
    if (typeof source === 'string' || source instanceof URL) {
      return originalGetDocument({ url: String(source), ...localOptions });
    }

    if (source && Object.getPrototypeOf(source) === Object.prototype) {
      return originalGetDocument({ ...source, ...localOptions });
    }

    return originalGetDocument(source);
  };

  window.essayFlowPdfRuntime = Object.freeze({
    workerSrc: window.pdfjsLib.GlobalWorkerOptions.workerSrc,
    ...localOptions
  });
})();
