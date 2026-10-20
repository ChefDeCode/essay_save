'use strict';

const RUNTIME_FILES = Object.freeze([
  { id: 'renderer-entry', relativePath: 'src/index.html' },
  { id: 'renderer-style', relativePath: 'src/style.css' },
  { id: 'runtime-bootstrap', relativePath: 'src/runtime-bootstrap.js' },
  { id: 'pdf-runtime', relativePath: 'src/pdf-runtime.js' },
  { id: 'renderer-data-client', relativePath: 'src/data-client.js' },
  { id: 'renderer-app', relativePath: 'src/app.js' },
  { id: 'renderer-ai', relativePath: 'src/ai-assistant.js' },
  { id: 'renderer-settings', relativePath: 'src/settings.js' },
  { id: 'renderer-search', relativePath: 'src/search.js' },
  { id: 'quill-script', relativePath: 'node_modules/quill/dist/quill.js' },
  { id: 'quill-style', relativePath: 'node_modules/quill/dist/quill.snow.css' },
  { id: 'html2pdf-script', relativePath: 'node_modules/html2pdf.js/dist/html2pdf.bundle.min.js' },
  { id: 'mammoth-script', relativePath: 'node_modules/mammoth/mammoth.browser.min.js' },
  { id: 'pdfjs-script', relativePath: 'node_modules/pdfjs-dist/build/pdf.min.js' },
  { id: 'pdfjs-worker', relativePath: 'node_modules/pdfjs-dist/build/pdf.worker.min.js' },
  { id: 'application-icon', relativePath: 'build/icon.png' }
]);

const RUNTIME_DIRECTORIES = Object.freeze([
  { id: 'pdfjs-cmaps', relativePath: 'node_modules/pdfjs-dist/cmaps', expectedFileCount: 169 },
  { id: 'pdfjs-standard-fonts', relativePath: 'node_modules/pdfjs-dist/standard_fonts', expectedFileCount: 16 }
]);

const RUNTIME_PACKAGES = Object.freeze([
  { name: 'quill', version: '1.3.6' },
  { name: 'html2pdf.js', version: '0.10.1' },
  { name: 'mammoth', version: '1.6.0' },
  { name: 'pdfjs-dist', version: '3.11.174' }
]);

const INDEX_REFERENCES = Object.freeze([
  '../node_modules/quill/dist/quill.snow.css',
  '../node_modules/pdfjs-dist/build/pdf.min.js',
  'pdf-runtime.js',
  'runtime-bootstrap.js',
  '../node_modules/quill/dist/quill.js',
  '../node_modules/html2pdf.js/dist/html2pdf.bundle.min.js',
  '../node_modules/mammoth/mammoth.browser.min.js',
  'style.css',
  'data-client.js',
  'app.js',
  'ai-assistant.js',
  'settings.js',
  'search.js'
]);

module.exports = {
  INDEX_REFERENCES,
  RUNTIME_DIRECTORIES,
  RUNTIME_FILES,
  RUNTIME_PACKAGES
};
