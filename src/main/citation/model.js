'use strict';

const crypto = require('node:crypto');

const MODEL_SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOI_PATTERN = /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i;
const CSL_TYPES = new Set([
  'article', 'article-journal', 'article-magazine', 'article-newspaper', 'bill', 'book',
  'broadcast', 'chapter', 'classic', 'collection', 'dataset', 'document', 'entry',
  'entry-dictionary', 'entry-encyclopedia', 'event', 'figure', 'graphic', 'hearing',
  'interview', 'legal_case', 'legislation', 'manuscript', 'map', 'motion_picture',
  'musical_score', 'pamphlet', 'paper-conference', 'patent', 'performance', 'periodical',
  'personal_communication', 'post', 'post-weblog', 'regulation', 'report', 'review',
  'review-book', 'software', 'song', 'speech', 'standard', 'thesis', 'treaty', 'webpage'
]);
const TEXT_FIELDS = Object.freeze([
  'title', 'title-short', 'container-title', 'container-title-short', 'collection-title',
  'publisher', 'publisher-place', 'volume', 'issue', 'page', 'number', 'edition', 'version',
  'DOI', 'URL', 'ISBN', 'ISSN', 'abstract', 'language', 'genre', 'medium', 'event',
  'event-place', 'archive', 'archive-place', 'archive_location', 'call-number', 'citation-key',
  'original-title', 'status', 'keyword', 'source'
]);
const NAME_FIELDS = Object.freeze([
  'author', 'editor', 'translator', 'container-author', 'collection-editor', 'composer',
  'director', 'editorial-director', 'illustrator', 'interviewer', 'original-author',
  'recipient', 'reviewed-author'
]);
const DATE_FIELDS = Object.freeze(['issued', 'accessed', 'available-date', 'event-date', 'original-date', 'submitted']);
const OPERATIONAL_FIELDS = new Set([
  'schemaVersion', 'libraryItemId', 'createdAt', 'updatedAt', 'legacySourceId', 'tags',
  'starred', 'privateNote', 'assetRefs', 'metadataProvenance', 'verifiedAt', 'fieldConfidence'
]);

class CitationModelError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CitationModelError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeText(value, field, options = {}) {
  if (typeof value !== 'string') {
    throw new CitationModelError('CITATION_TEXT_INVALID', `${field} 必须是字符串`, { field });
  }
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (!normalized && options.allowEmpty !== true) {
    throw new CitationModelError('CITATION_TEXT_INVALID', `${field} 不能为空`, { field });
  }
  const maximum = options.maximum || 100000;
  if (normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new CitationModelError('CITATION_TEXT_INVALID', `${field} 包含无效字符或超过长度限制`, { field });
  }
  return normalized;
}

function normalizeUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CitationModelError('CITATION_UUID_INVALID', `${field} 必须是 UUID`, { field, value });
  }
  return value.toLowerCase();
}

function normalizeDoi(value) {
  if (value === undefined || value === null || value === '') return undefined;
  let doi = normalizeText(String(value), 'DOI', { maximum: 2048 })
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .toLowerCase();
  try { doi = decodeURIComponent(doi); } catch {}
  if (!DOI_PATTERN.test(doi)) {
    throw new CitationModelError('CITATION_DOI_INVALID', `DOI 格式无效: ${doi}`, { doi });
  }
  return doi;
}

function normalizeUrl(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = normalizeText(String(value), 'URL', { maximum: 8192 });
  let parsed;
  try { parsed = new URL(raw); } catch (error) {
    throw new CitationModelError('CITATION_URL_INVALID', `URL 格式无效: ${raw}`, { value: raw }, error);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new CitationModelError('CITATION_URL_INVALID', 'URL 只允许无凭据的 HTTP(S) 地址', { value: raw });
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeName(value, field) {
  if (!isPlainObject(value)) {
    throw new CitationModelError('CITATION_NAME_INVALID', `${field} 必须是 CSL 姓名对象`, { field });
  }
  const allowed = ['family', 'given', 'literal', 'suffix', 'dropping-particle', 'non-dropping-particle', 'comma-suffix', 'static-ordering', 'parse-names'];
  const result = {};
  for (const key of allowed) {
    if (!hasOwn(value, key)) continue;
    if (typeof value[key] === 'boolean' && ['comma-suffix', 'static-ordering', 'parse-names'].includes(key)) {
      result[key] = value[key];
    } else {
      result[key] = normalizeText(String(value[key]), `${field}.${key}`, { maximum: 2048 });
    }
  }
  if (result.literal && (result.family || result.given)) {
    throw new CitationModelError('CITATION_NAME_AMBIGUOUS', `${field} 不能同时使用 literal 与 family/given`, { field });
  }
  if (!result.literal && !result.family && !result.given) {
    throw new CitationModelError('CITATION_NAME_INVALID', `${field} 缺少 literal 或 family/given`, { field });
  }
  return result;
}

function normalizeDate(value, field) {
  if (!isPlainObject(value)) {
    throw new CitationModelError('CITATION_DATE_INVALID', `${field} 必须是 CSL 日期对象`, { field });
  }
  const result = {};
  if (hasOwn(value, 'date-parts')) {
    if (!Array.isArray(value['date-parts']) || value['date-parts'].length < 1 || value['date-parts'].length > 2) {
      throw new CitationModelError('CITATION_DATE_INVALID', `${field}.date-parts 格式无效`, { field });
    }
    result['date-parts'] = value['date-parts'].map((part, index) => {
      if (!Array.isArray(part) || part.length < 1 || part.length > 3) {
        throw new CitationModelError('CITATION_DATE_INVALID', `${field}.date-parts[${index}] 格式无效`, { field });
      }
      const numbers = part.map(number => Number(number));
      if (!numbers.every(Number.isInteger) || numbers[0] < -9999 || numbers[0] > 9999 ||
          (numbers[1] !== undefined && (numbers[1] < 1 || numbers[1] > 12)) ||
          (numbers[2] !== undefined && (numbers[2] < 1 || numbers[2] > 31))) {
        throw new CitationModelError('CITATION_DATE_INVALID', `${field}.date-parts 包含无效日期`, { field });
      }
      return numbers;
    });
  }
  for (const key of ['literal', 'raw', 'season']) {
    if (hasOwn(value, key)) result[key] = normalizeText(String(value[key]), `${field}.${key}`, { maximum: 2048 });
  }
  if (hasOwn(value, 'circa')) result.circa = Boolean(value.circa);
  if (!Object.keys(result).length) {
    throw new CitationModelError('CITATION_DATE_INVALID', `${field} 没有可识别的日期字段`, { field });
  }
  return result;
}

function normalizeStringArray(value, field, maximum = 1000) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new CitationModelError('CITATION_ARRAY_INVALID', `${field} 必须是有限数组`, { field });
  }
  return [...new Set(value.map((entry, index) => normalizeText(String(entry), `${field}[${index}]`, { maximum: 2048 })))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeTimestamp(value, field) {
  const text = normalizeText(String(value), field, { maximum: 64 });
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new CitationModelError('CITATION_TIMESTAMP_INVALID', `${field} 必须是规范 UTC ISO-8601 时间`, { field });
  }
  return text;
}

function normalizeProvenance(value, now, sourceFormat) {
  const input = isPlainObject(value) ? value : {};
  const source = normalizeText(String(input.source || 'imported'), 'metadataProvenance.source', { maximum: 128 });
  const importedAt = input.importedAt ? normalizeTimestamp(input.importedAt, 'metadataProvenance.importedAt') : now;
  const result = { source, importedAt, originalFormat: normalizeText(String(input.originalFormat || sourceFormat || 'csl-json'), 'metadataProvenance.originalFormat', { maximum: 64 }) };
  if (isPlainObject(input.fields)) {
    result.fields = {};
    for (const [key, fieldSource] of Object.entries(input.fields)) {
      result.fields[normalizeText(key, 'metadataProvenance.fields key', { maximum: 128 })] =
        normalizeText(String(fieldSource), `metadataProvenance.fields.${key}`, { maximum: 128 });
    }
  }
  return result;
}

function normalizeCitationItem(value, options = {}) {
  if (!isPlainObject(value)) throw new CitationModelError('CITATION_ITEM_INVALID', '文献项必须是对象');
  const nowValue = options.now ? options.now() : new Date();
  const now = normalizeTimestamp(nowValue instanceof Date ? nowValue.toISOString() : nowValue, 'now');
  const idFactory = options.idFactory || crypto.randomUUID;
  const externalId = typeof value.id === 'string' && value.id.trim() ? value.id.trim().normalize('NFC') : null;
  const libraryItemId = normalizeUuid(value.libraryItemId || (externalId && UUID_PATTERN.test(externalId) ? externalId : idFactory()), 'libraryItemId');
  const type = normalizeText(String(value.type || 'article'), 'type', { maximum: 128 });
  if (!CSL_TYPES.has(type)) throw new CitationModelError('CITATION_TYPE_INVALID', `不支持的 CSL 类型: ${type}`, { type });
  const result = {
    schemaVersion: MODEL_SCHEMA_VERSION,
    libraryItemId,
    type,
    title: normalizeText(String(value.title || ''), 'title', { maximum: 100000 })
  };
  for (const field of TEXT_FIELDS) {
    if (!hasOwn(value, field) || field === 'title') continue;
    let normalized;
    if (field === 'DOI') normalized = normalizeDoi(value[field]);
    else if (field === 'URL') normalized = normalizeUrl(value[field]);
    else normalized = normalizeText(String(value[field]), field, { maximum: field === 'abstract' ? 500000 : 100000 });
    if (normalized !== undefined) result[field] = normalized;
  }
  for (const field of NAME_FIELDS) {
    if (!hasOwn(value, field)) continue;
    if (!Array.isArray(value[field]) || value[field].length > 1000) {
      throw new CitationModelError('CITATION_NAME_INVALID', `${field} 必须是有限姓名数组`, { field });
    }
    result[field] = value[field].map((name, index) => normalizeName(name, `${field}[${index}]`));
  }
  for (const field of DATE_FIELDS) {
    if (hasOwn(value, field)) result[field] = normalizeDate(value[field], field);
  }
  result.createdAt = value.createdAt ? normalizeTimestamp(value.createdAt, 'createdAt') : now;
  result.updatedAt = value.updatedAt ? normalizeTimestamp(value.updatedAt, 'updatedAt') : now;
  if (result.updatedAt < result.createdAt) {
    throw new CitationModelError('CITATION_TIMESTAMP_INVALID', 'updatedAt 不能早于 createdAt');
  }
  result.metadataProvenance = normalizeProvenance(value.metadataProvenance, now, options.sourceFormat);
  if (value.verifiedAt !== undefined && value.verifiedAt !== null && value.verifiedAt !== '') {
    result.verifiedAt = normalizeTimestamp(value.verifiedAt, 'verifiedAt');
  }
  if (isPlainObject(value.fieldConfidence)) {
    result.fieldConfidence = {};
    for (const [field, confidence] of Object.entries(value.fieldConfidence)) {
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new CitationModelError('CITATION_CONFIDENCE_INVALID', `fieldConfidence.${field} 必须在 0..1`, { field });
      }
      result.fieldConfidence[normalizeText(field, 'fieldConfidence key', { maximum: 128 })] = confidence;
    }
  }
  if (value.tags !== undefined) result.tags = normalizeStringArray(value.tags, 'tags');
  result.starred = value.starred === true;
  if (value.privateNote !== undefined) result.privateNote = normalizeText(String(value.privateNote), 'privateNote', { allowEmpty: true, maximum: 500000 });
  if (value.assetRefs !== undefined) {
    if (!Array.isArray(value.assetRefs)) throw new CitationModelError('CITATION_ARRAY_INVALID', 'assetRefs 必须是数组');
    result.assetRefs = JSON.parse(JSON.stringify(value.assetRefs));
  }
  if (value.legacySourceId !== undefined || (externalId && !UUID_PATTERN.test(externalId))) {
    result.legacySourceId = normalizeText(String(value.legacySourceId || externalId), 'legacySourceId', { maximum: 2048 });
  }
  return result;
}

function toCslJson(value, options = {}) {
  const item = options.normalized ? value : normalizeCitationItem(value, options);
  const result = { id: item.libraryItemId, type: item.type, title: item.title };
  for (const [field, fieldValue] of Object.entries(item)) {
    if (OPERATIONAL_FIELDS.has(field) || ['type', 'title'].includes(field)) continue;
    result[field] = JSON.parse(JSON.stringify(fieldValue));
  }
  return result;
}

function canonicalSemanticValue(value) {
  if (Array.isArray(value)) return value.map(canonicalSemanticValue);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'))) {
    result[key] = canonicalSemanticValue(value[key]);
  }
  return result;
}

function semanticProjection(value) {
  const csl = toCslJson(value);
  delete csl.id;
  delete csl['citation-key'];
  return canonicalSemanticValue(csl);
}

function semanticDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(semanticProjection(value)), 'utf8').digest('hex');
}

function normalizedTitle(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function issuedYear(item) {
  return item?.issued?.['date-parts']?.[0]?.[0] ?? '';
}

function firstAuthorKey(item) {
  const author = item?.author?.[0];
  return normalizedTitle(author?.literal || author?.family || author?.given || '');
}

function semanticKey(value) {
  const item = normalizeCitationItem(value);
  if (item.DOI) return `doi:${item.DOI}`;
  return `semantic:${normalizedTitle(item.title)}|${firstAuthorKey(item)}|${issuedYear(item)}`;
}

function legacyPaperToCsl(value, options = {}) {
  if (!isPlainObject(value)) throw new CitationModelError('CITATION_ITEM_INVALID', '旧版文献必须是对象');
  const citationItemId = options.citationItemId || options.libraryItemId || crypto.randomUUID();
  const authors = value.author || value.authors;
  let author;
  if (Array.isArray(authors)) {
    author = authors.map((entry, index) => isPlainObject(entry)
      ? entry
      : { literal: normalizeText(String(entry), `authors[${index}]`, { maximum: 2048 }) });
  } else if (typeof authors === 'string' && authors.trim()) {
    author = [{ literal: authors.trim().normalize('NFC') }];
  }
  const rawYear = value.year ?? value.published ?? value.publicationDate;
  const match = String(rawYear || '').match(/-?\d{4}/);
  const typeAliases = {
    article: 'article-journal', journal: 'article-journal', conference: 'paper-conference',
    proceedings: 'paper-conference', thesis: 'thesis', report: 'report', book: 'book',
    chapter: 'chapter', webpage: 'webpage', web: 'webpage'
  };
  const rawType = String(value.type || 'article-journal').toLowerCase();
  const input = {
    libraryItemId: citationItemId,
    type: CSL_TYPES.has(rawType) ? rawType : (typeAliases[rawType] || 'article-journal'),
    title: value.title || '未命名文献',
    ...(author ? { author } : {}),
    ...(match ? { issued: { 'date-parts': [[Number(match[0])]] } } : {}),
    ...(value['container-title'] || value.journal || value.source
      ? { 'container-title': value['container-title'] || value.journal || value.source }
      : {}),
    ...(value.publisher ? { publisher: value.publisher } : {}),
    ...(value.volume ? { volume: value.volume } : {}),
    ...(value.issue ? { issue: value.issue } : {}),
    ...(value.page || value.pages ? { page: value.page || value.pages } : {}),
    ...(value.doi || value.DOI ? { DOI: value.doi || value.DOI } : {}),
    ...(value.url || value.URL || value.link ? { URL: value.url || value.URL || value.link } : {}),
    ...(value.abstract ? { abstract: value.abstract } : {}),
    ...(value.language ? { language: value.language } : {}),
    metadataProvenance: value.metadataProvenance || { source: options.source || 'legacy-renderer' },
    ...(value.verifiedAt ? { verifiedAt: value.verifiedAt } : {})
  };
  return toCslJson(normalizeCitationItem(input, {
    idFactory: () => citationItemId,
    now: options.now,
    sourceFormat: options.sourceFormat || 'legacy'
  }), { normalized: true });
}

module.exports = {
  CSL_TYPES,
  DATE_FIELDS,
  MODEL_SCHEMA_VERSION,
  NAME_FIELDS,
  OPERATIONAL_FIELDS,
  TEXT_FIELDS,
  CitationModelError,
  canonicalSemanticValue,
  firstAuthorKey,
  issuedYear,
  legacyPaperToCsl,
  normalizeCitationItem,
  normalizeDate,
  normalizeDoi,
  normalizeName,
  normalizedTitle,
  semanticDigest,
  semanticKey,
  toCslJson
};
