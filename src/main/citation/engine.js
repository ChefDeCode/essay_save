'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { plugins } = require('@citation-js/core');
require('@citation-js/plugin-csl');

const { normalizeCitationItem, toCslJson } = require('./model');

const LOCK_PATH = path.join(__dirname, 'citation-style-lock.json');
const LOCATOR_LABELS = new Set(['page', 'chapter', 'section', 'paragraph', 'figure', 'table']);
let registered = false;
let cachedLock = null;

class CitationEngineError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CitationEngineError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function loadLockedFile(relativePath, expectedSha256) {
  const absolutePath = path.resolve(__dirname, relativePath);
  const relative = path.relative(__dirname, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CitationEngineError('CITATION_STYLE_PATH_INVALID', `样式锁文件路径越界: ${relativePath}`);
  }
  const content = fs.readFileSync(absolutePath);
  const actual = sha256(content);
  if (actual !== expectedSha256) {
    throw new CitationEngineError('CITATION_STYLE_HASH_MISMATCH', `引用资源哈希不匹配: ${relativePath}`, {
      expectedSha256,
      actualSha256: actual
    });
  }
  return content.toString('utf8');
}

function loadStyleLock() {
  if (cachedLock) return cachedLock;
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  if (lock.schemaVersion !== 1 || !lock.styles || !lock.locales) {
    throw new CitationEngineError('CITATION_STYLE_LOCK_INVALID', 'citation-style-lock.json 格式无效');
  }
  cachedLock = lock;
  return lock;
}

function registerLockedResources() {
  if (registered) return loadStyleLock();
  const lock = loadStyleLock();
  const config = plugins.config.get('@csl');
  for (const [localeId, locale] of Object.entries(lock.locales)) {
    config.locales.add(localeId, loadLockedFile(locale.file, locale.sha256));
  }
  for (const [styleId, style] of Object.entries(lock.styles)) {
    const xml = loadLockedFile(style.file, style.sha256);
    if (!xml.includes(`<id>${style.officialStyleId}</id>`)) {
      throw new CitationEngineError('CITATION_STYLE_ID_MISMATCH', `样式 ID 与锁文件不一致: ${styleId}`);
    }
    config.templates.add(styleId, xml);
  }
  registered = true;
  return lock;
}

function engineItem(value) {
  const id = value.citationItemId || value.id;
  if (!id && value.libraryItemId) return toCslJson(normalizeCitationItem(value), { normalized: true });
  if (typeof id !== 'string' || !id) throw new CitationEngineError('CITATION_ITEM_ID_INVALID', 'CitationItem 缺少稳定 ID');
  const item = { ...value, id };
  for (const field of [
    'schemaVersion', 'citationItemId', 'projectId', 'libraryItemId', 'capturedAt', 'createdAt',
    'updatedAt', 'metadataProvenance', 'verifiedAt', 'fieldConfidence', 'migration', 'legacySourceId'
  ]) delete item[field];
  return JSON.parse(JSON.stringify(item));
}

function normalizeCluster(cluster, index, itemIds) {
  if (!cluster || typeof cluster !== 'object' || !Array.isArray(cluster.items) || !cluster.items.length) {
    throw new CitationEngineError('CITATION_CLUSTER_INVALID', `第 ${index + 1} 个引用簇格式无效`, { index });
  }
  const id = String(cluster.id || cluster.citationInstanceId || '').trim();
  if (!id) throw new CitationEngineError('CITATION_CLUSTER_ID_INVALID', `第 ${index + 1} 个引用簇缺少稳定 ID`, { index });
  const ordered = cluster.items.map((entry, itemIndex) => {
    const citationItemId = String(entry.citationItemId || entry.id || '').trim();
    if (!itemIds.has(citationItemId)) {
      throw new CitationEngineError('CITATION_ITEM_MISSING', `引用簇 ${id} 指向不存在的文献项`, {
        citationInstanceId: id,
        citationItemId
      });
    }
    const locator = entry.locator === undefined || entry.locator === null ? '' : String(entry.locator).trim();
    const label = entry.label === undefined || entry.label === null ? '' : String(entry.label).trim();
    if ((locator && !label) || (!locator && label) || (label && !LOCATOR_LABELS.has(label))) {
      throw new CitationEngineError('CITATION_LOCATOR_INVALID', `引用簇 ${id} 的 locator/label 组合无效`, {
        citationInstanceId: id,
        citationItemId,
        locator,
        label
      });
    }
    return {
      citationItemEntryId: String(entry.citationItemEntryId || `${id}:${itemIndex}`),
      citationItemId,
      order: Number.isInteger(entry.order) && entry.order >= 0 ? entry.order : itemIndex,
      locator,
      label,
      prefix: entry.prefix === undefined || entry.prefix === null ? '' : String(entry.prefix),
      suffix: entry.suffix === undefined || entry.suffix === null ? '' : String(entry.suffix),
      suppressAuthor: entry.suppressAuthor === true
    };
  }).sort((left, right) => left.order - right.order);
  if (new Set(ordered.map(entry => entry.citationItemEntryId)).size !== ordered.length ||
      new Set(ordered.map(entry => entry.order)).size !== ordered.length) {
    throw new CitationEngineError('CITATION_CLUSTER_DUPLICATE_ENTRY', `引用簇 ${id} 包含重复 entry ID 或 order`);
  }
  return {
    id,
    items: ordered,
    citeproc: {
      citationID: id,
      citationItems: ordered.map(entry => {
        const citeItem = { id: entry.citationItemId };
        if (entry.locator) {
          citeItem.locator = entry.locator;
          citeItem.label = entry.label;
        }
        if (entry.prefix) citeItem.prefix = entry.prefix;
        if (entry.suffix) citeItem.suffix = entry.suffix;
        if (entry.suppressAuthor) citeItem['suppress-author'] = true;
        return citeItem;
      }),
      properties: { noteIndex: Number.isInteger(cluster.noteIndex) ? cluster.noteIndex : 0 }
    }
  };
}

function renderCitationDocument(options) {
  const lock = registerLockedResources();
  const styleId = String(options?.styleId || 'apa-7');
  const style = lock.styles[styleId];
  if (!style) throw new CitationEngineError('CITATION_STYLE_UNKNOWN', `未知引用样式: ${styleId}`, { styleId });
  const locale = String(options?.locale || style.locale);
  if (!lock.locales[locale]) throw new CitationEngineError('CITATION_LOCALE_UNKNOWN', `未知引用 locale: ${locale}`, { locale });
  const format = options?.format || 'html';
  if (!['html', 'text'].includes(format)) throw new CitationEngineError('CITATION_OUTPUT_FORMAT_INVALID', `不支持的输出格式: ${format}`);
  if (!Array.isArray(options?.items) || !Array.isArray(options?.clusters)) {
    throw new CitationEngineError('CITATION_RENDER_INPUT_INVALID', 'items 和 clusters 必须是数组');
  }
  const items = options.items.map(engineItem);
  const itemIds = new Set(items.map(item => String(item.id)));
  if (itemIds.size !== items.length) throw new CitationEngineError('CITATION_ITEM_DUPLICATE_ID', '文献项包含重复 ID');
  const clusters = options.clusters.map((cluster, index) => normalizeCluster(cluster, index, itemIds));
  if (new Set(clusters.map(cluster => cluster.id)).size !== clusters.length) {
    throw new CitationEngineError('CITATION_CLUSTER_DUPLICATE_ID', '引用簇包含重复 citationInstanceId');
  }
  if (!clusters.length) {
    return { schemaVersion: 1, styleId, locale, citationFormat: style.citationFormat, citations: [], bibliography: { entries: [], body: '' } };
  }
  let processor;
  try {
    processor = plugins.config.get('@csl').engine(items, styleId, locale, format);
    const rendered = processor.rebuildProcessorState(clusters.map(cluster => cluster.citeproc), format, []);
    const citationById = new Map(rendered.map(value => [String(value[0]), value[2]]));
    const bibliography = processor.makeBibliography();
    const metadata = bibliography?.[0] || { bibstart: '', bibend: '', entry_ids: [] };
    const bodies = bibliography?.[1] || [];
    const entries = bodies.map((body, index) => ({
      citationItemIds: (metadata.entry_ids?.[index] || []).map(String),
      body
    }));
    return {
      schemaVersion: 1,
      styleId,
      locale,
      citationFormat: style.citationFormat,
      citations: clusters.map(cluster => ({ citationInstanceId: cluster.id, body: citationById.get(cluster.id) || '' })),
      bibliography: { entries, body: `${metadata.bibstart || ''}${bodies.join('')}${metadata.bibend || ''}` }
    };
  } catch (error) {
    if (error instanceof CitationEngineError) throw error;
    throw new CitationEngineError('CITATION_RENDER_FAILED', `CSL 渲染失败: ${error.message}`, { styleId, locale }, error);
  }
}

function listLockedStyles() {
  const lock = registerLockedResources();
  return Object.entries(lock.styles).map(([styleId, style]) => ({ styleId, ...style }));
}

module.exports = {
  CitationEngineError,
  listLockedStyles,
  loadStyleLock,
  normalizeCluster,
  registerLockedResources,
  renderCitationDocument
};
