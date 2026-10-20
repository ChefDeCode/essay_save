'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Cite, plugins } = require('@citation-js/core');
require('@citation-js/plugin-bibtex');
require('@citation-js/plugin-ris');

const {
  CitationModelError,
  normalizeCitationItem,
  semanticDigest,
  toCslJson
} = require('./model');

const LOSS_MATRIX = Object.freeze(JSON.parse(fs.readFileSync(path.join(__dirname, 'field-loss-matrix.json'), 'utf8')));
const SUPPORTED_FORMATS = new Set(['bibtex', 'ris', 'csl-json']);
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_ITEMS = 100000;

class CitationExchangeError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CitationExchangeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function normalizeFormat(format) {
  const normalized = String(format || '').trim().toLowerCase().replace(/^\./, '');
  const aliases = { bib: 'bibtex', json: 'csl-json', csl: 'csl-json', 'csljson': 'csl-json' };
  const result = aliases[normalized] || normalized;
  if (!SUPPORTED_FORMATS.has(result)) {
    throw new CitationExchangeError('CITATION_FORMAT_UNSUPPORTED', `不支持的引用交换格式: ${format}`, { format });
  }
  return result;
}

function parseCslJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new CitationExchangeError('CITATION_IMPORT_PARSE_FAILED', 'CSL-JSON 不是有效 JSON', {}, error);
  }
  const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : [parsed]);
  if (!items.length || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new CitationExchangeError('CITATION_IMPORT_PARSE_FAILED', 'CSL-JSON 必须包含一个或多个文献对象');
  }
  return items;
}

function restoreEssayFlowExtension(value) {
  const item = { ...value };
  delete item._graph;
  const extension = item._essayflow;
  delete item._essayflow;
  if (extension && typeof extension === 'object' && !Array.isArray(extension)) {
    for (const field of [
      'libraryItemId', 'createdAt', 'updatedAt', 'legacySourceId', 'tags', 'starred',
      'privateNote', 'assetRefs', 'metadataProvenance', 'verifiedAt', 'fieldConfidence'
    ]) {
      if (Object.prototype.hasOwnProperty.call(extension, field)) item[field] = extension[field];
    }
  }
  return item;
}

function parseExternal(text, format) {
  try {
    const cite = new Cite(text);
    if (!Array.isArray(cite.data) || !cite.data.length) {
      throw new Error('未解析到文献记录');
    }
    return cite.data.map(value => {
      const item = { ...value };
      delete item._graph;
      return item;
    });
  } catch (error) {
    throw new CitationExchangeError('CITATION_IMPORT_PARSE_FAILED', `${format.toUpperCase()} 解析失败: ${error.message}`, {
      format
    }, error);
  }
}

function importCitationText(text, format, options = {}) {
  const normalizedFormat = normalizeFormat(format);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > (options.maximumBytes || MAX_IMPORT_BYTES)) {
    throw new CitationExchangeError('CITATION_IMPORT_TOO_LARGE', `导入内容必须是字符串且不超过 ${options.maximumBytes || MAX_IMPORT_BYTES} 字节`);
  }
  const rawItems = normalizedFormat === 'csl-json' ? parseCslJson(text) : parseExternal(text, normalizedFormat);
  if (rawItems.length > (options.maximumItems || MAX_IMPORT_ITEMS)) {
    throw new CitationExchangeError('CITATION_IMPORT_TOO_MANY_ITEMS', `导入记录超过 ${options.maximumItems || MAX_IMPORT_ITEMS} 条`);
  }
  const items = [];
  const errors = [];
  rawItems.forEach((raw, index) => {
    try {
      const restored = normalizedFormat === 'csl-json' ? restoreEssayFlowExtension(raw) : raw;
      items.push(normalizeCitationItem(restored, {
        idFactory: options.idFactory,
        now: options.now,
        sourceFormat: normalizedFormat
      }));
    } catch (error) {
      if (options.collectErrors === true && error instanceof CitationModelError) {
        errors.push({ index, code: error.code, message: error.message, details: error.details });
      } else {
        throw new CitationExchangeError('CITATION_IMPORT_ITEM_INVALID', `第 ${index + 1} 条文献无效: ${error.message}`, {
          index,
          causeCode: error.code
        }, error);
      }
    }
  });
  return {
    schemaVersion: 1,
    format: normalizedFormat,
    itemCount: items.length,
    rejectedCount: errors.length,
    items,
    errors
  };
}

function essayFlowExtension(item) {
  const result = {};
  for (const field of [
    'libraryItemId', 'createdAt', 'updatedAt', 'legacySourceId', 'tags', 'starred',
    'privateNote', 'assetRefs', 'metadataProvenance', 'verifiedAt', 'fieldConfidence'
  ]) {
    if (Object.prototype.hasOwnProperty.call(item, field)) result[field] = JSON.parse(JSON.stringify(item[field]));
  }
  return result;
}

function buildLossReport(items, format) {
  const definition = LOSS_MATRIX.formats[format];
  const entries = items.map(item => {
    const lostFields = definition.unsupportedFields.filter(field => Object.prototype.hasOwnProperty.call(item, field));
    const warnings = [];
    for (const [field, message] of Object.entries(definition.conditionalLoss || {})) {
      if (field === 'literal-author') {
        if ((item.author || []).some(author => author.literal)) warnings.push({ field: 'author', message });
      } else if (field === 'date-precision') {
        if (item.issued?.['date-parts']?.some(part => part.length > 1)) warnings.push({ field: 'issued', message });
      } else if (Object.prototype.hasOwnProperty.call(item, field)) {
        warnings.push({ field, message });
      }
    }
    return { libraryItemId: item.libraryItemId, lostFields, warnings };
  }).filter(entry => entry.lostFields.length || entry.warnings.length);
  return {
    schemaVersion: 1,
    format,
    lossless: definition.lossless === true,
    itemCount: items.length,
    affectedItemCount: entries.length,
    entries
  };
}

function configureBibtexOutput() {
  const config = plugins.config.get('@bibtex');
  config.format.asciiOnly = false;
  config.format.useIdAsLabel = true;
  config.format.checkLabel = true;
}

function exportCitationItems(values, format, options = {}) {
  const normalizedFormat = normalizeFormat(format);
  const items = values.map(value => normalizeCitationItem(value, { now: options.now, idFactory: options.idFactory }));
  let text;
  if (normalizedFormat === 'csl-json') {
    const payload = items.map(item => ({
      ...toCslJson(item, { normalized: true }),
      _essayflow: essayFlowExtension(item)
    }));
    text = `${JSON.stringify(payload, null, 2)}\n`;
  } else {
    configureBibtexOutput();
    const cite = new Cite(items.map(item => toCslJson(item, { normalized: true })));
    try {
      text = cite.format(normalizedFormat, { format: 'text' });
    } catch (error) {
      throw new CitationExchangeError('CITATION_EXPORT_FAILED', `${normalizedFormat.toUpperCase()} 导出失败: ${error.message}`, {
        format: normalizedFormat
      }, error);
    }
  }
  return {
    schemaVersion: 1,
    format: normalizedFormat,
    itemCount: items.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    text,
    lossReport: buildLossReport(items, normalizedFormat),
    semanticDigests: items.map(item => ({ libraryItemId: item.libraryItemId, sha256: semanticDigest(item) }))
  };
}

module.exports = {
  CitationExchangeError,
  LOSS_MATRIX,
  SUPPORTED_FORMATS,
  buildLossReport,
  exportCitationItems,
  importCitationText,
  normalizeFormat,
  parseCslJson
};
