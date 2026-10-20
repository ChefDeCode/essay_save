'use strict';

const crypto = require('node:crypto');

const DEFAULT_UNORDERED_ARRAY_FIELDS = Object.freeze([
  'projects',
  'libraryItems',
  'collections',
  'assets',
  'citationItems',
  'citationLinks',
  'researchQuestions',
  'evidenceCards',
  'evidenceRevisions',
  'evidenceReviewEvents',
  'aiThreads',
  'groundedAnswers',
  'reviewIssues',
  'auditEvents',
  'auditContentBlobs',
  'projectPaperStates',
  'reviewMatrices',
  'assetRefs',
  'versions'
]);

const STABLE_ID_KEYS_BY_FIELD = Object.freeze({
  projects: ['id', 'projectId'],
  libraryItems: ['id', 'libraryItemId'],
  collections: ['id', 'collectionId'],
  assets: ['id', 'assetId'],
  citationItems: ['id', 'citationItemId'],
  citationLinks: ['id'],
  researchQuestions: ['id'],
  evidenceCards: ['id'],
  evidenceRevisions: ['id'],
  evidenceReviewEvents: ['id'],
  aiThreads: ['id', 'threadId'],
  groundedAnswers: ['id'],
  reviewIssues: ['id'],
  auditEvents: ['eventId', 'id'],
  auditContentBlobs: ['blobId', 'id'],
  projectPaperStates: ['id'],
  reviewMatrices: ['id'],
  assetRefs: ['id', 'assetId'],
  versions: ['id', 'versionId', 'snapshotId']
});

// Only these explicitly declared operational fields are omitted from a semantic hash.
const DEFAULT_SEMANTIC_EXCLUDED_KEYS = Object.freeze([
  'absolutePath',
  'generatedAt',
  'machinePath',
  'profilePath',
  'runtimeLog',
  'runtimeLogs'
]);

class CanonicalizationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanonicalizationError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function normalizeString(value) {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function formatPath(segments) {
  if (!segments.length) return '$';
  return '$.' + segments.map(segment => String(segment)).join('.');
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizePathDeclaration(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CanonicalizationError(
      'CANONICAL_INVALID_PATH_DECLARATION',
      'Canonical path declarations must be non-empty strings',
      { value }
    );
  }
  let normalized = value.trim();
  if (normalized === '$') return [];
  if (normalized.startsWith('$.')) normalized = normalized.slice(2);
  return normalized.split('.');
}

function pathMatches(declaration, pathSegments) {
  if (declaration.length === 1 && declaration[0] !== '*') {
    return pathSegments[pathSegments.length - 1] === declaration[0];
  }
  if (declaration.length !== pathSegments.length) return false;
  return declaration.every((part, index) => part === '*' || part === String(pathSegments[index]));
}

function optionCollection(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new CanonicalizationError(
      'CANONICAL_INVALID_OPTIONS',
      `${name} must be an array or Set`
    );
  }
  return [...value];
}

function normalizeOptions(options = {}) {
  const unorderedDeclarations = [];
  if (options.useDefaultUnorderedArrays !== false) {
    unorderedDeclarations.push(...DEFAULT_UNORDERED_ARRAY_FIELDS);
  }
  if (options.unorderedArrayPaths) {
    unorderedDeclarations.push(...optionCollection(options.unorderedArrayPaths, 'unorderedArrayPaths'));
  }

  const excludedKeys = new Set(optionCollection(options.excludedKeys, 'excludedKeys').map(value => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new CanonicalizationError('CANONICAL_INVALID_OPTIONS', 'excludedKeys entries must be non-empty strings');
    }
    return normalizeString(value);
  }));
  const excludedPaths = optionCollection(options.excludedPaths, 'excludedPaths').map(normalizePathDeclaration);
  return {
    unorderedPaths: unorderedDeclarations.map(normalizePathDeclaration),
    excludedKeys,
    excludedPaths,
    stableIdKeysByField: { ...STABLE_ID_KEYS_BY_FIELD, ...(options.stableIdKeysByField || {}) },
    stableId: typeof options.stableId === 'function' ? options.stableId : null
  };
}

function isExcluded(key, pathSegments, state) {
  if (state.options.excludedKeys.has(key)) return true;
  return state.options.excludedPaths.some(declaration => pathMatches(declaration, pathSegments));
}

function isUnorderedArray(pathSegments, state) {
  return state.options.unorderedPaths.some(declaration => pathMatches(declaration, pathSegments));
}

function findStableId(value, pathSegments, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (state.options.stableId) {
    const customId = state.options.stableId(value, Object.freeze([...pathSegments]));
    if (customId !== undefined && customId !== null) return normalizeString(String(customId));
  }
  const field = String(pathSegments[pathSegments.length - 1] || '');
  const keys = state.options.stableIdKeysByField[field] || ['id'];
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].length > 0) return normalizeString(value[key]);
  }
  return null;
}

function canonicalizeInternal(value, pathSegments, state) {
  if (value === null) return null;
  if (typeof value === 'string') return normalizeString(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        'CANONICAL_NON_FINITE_NUMBER',
        `Non-finite numbers are not valid canonical JSON at ${formatPath(pathSegments)}`,
        { path: formatPath(pathSegments) }
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new CanonicalizationError(
      'CANONICAL_UNSUPPORTED_VALUE',
      `Unsupported canonical value at ${formatPath(pathSegments)}`,
      { path: formatPath(pathSegments), valueType: typeof value }
    );
  }
  if (state.ancestors.has(value)) {
    throw new CanonicalizationError(
      'CANONICAL_CYCLE',
      `Circular value at ${formatPath(pathSegments)}`,
      { path: formatPath(pathSegments) }
    );
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const unordered = isUnorderedArray(pathSegments, state);
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new CanonicalizationError(
            'CANONICAL_SPARSE_ARRAY',
            `Sparse arrays are not valid canonical JSON at ${formatPath(pathSegments)}`,
            { path: formatPath(pathSegments), index }
          );
        }
        const item = value[index];
        const stableId = unordered ? findStableId(item, pathSegments, state) : null;
        if (unordered && !stableId) {
          throw new CanonicalizationError(
            'CANONICAL_STABLE_ID_REQUIRED',
            `Unordered item is missing a stable ID at ${formatPath([...pathSegments, index])}`,
            { path: formatPath([...pathSegments, index]) }
          );
        }
        entries.push({
          stableId,
          value: canonicalizeInternal(item, [...pathSegments, index], state)
        });
      }
      if (unordered) {
        entries.sort((left, right) => compareStrings(left.stableId, right.stableId));
        for (let index = 1; index < entries.length; index += 1) {
          if (entries[index - 1].stableId === entries[index].stableId) {
            throw new CanonicalizationError(
              'CANONICAL_DUPLICATE_STABLE_ID',
              `Duplicate stable ID in unordered collection at ${formatPath(pathSegments)}`,
              { path: formatPath(pathSegments), stableId: entries[index].stableId }
            );
          }
        }
      }
      return entries.map(entry => entry.value);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(
        'CANONICAL_NON_PLAIN_OBJECT',
        `Only plain objects are valid canonical JSON at ${formatPath(pathSegments)}`,
        { path: formatPath(pathSegments) }
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalizationError(
        'CANONICAL_SYMBOL_KEY',
        `Symbol keys are not valid canonical JSON at ${formatPath(pathSegments)}`,
        { path: formatPath(pathSegments) }
      );
    }

    const normalizedKeys = new Map();
    for (const key of Object.keys(value)) {
      const normalizedKey = normalizeString(key);
      if (normalizedKeys.has(normalizedKey)) {
        throw new CanonicalizationError(
          'CANONICAL_NORMALIZED_KEY_COLLISION',
          `Object keys collide after NFC normalization at ${formatPath(pathSegments)}`,
          { path: formatPath(pathSegments), key, normalizedKey }
        );
      }
      normalizedKeys.set(normalizedKey, key);
    }

    const result = {};
    const keys = [...normalizedKeys.keys()].sort(compareStrings);
    for (const normalizedKey of keys) {
      const sourceKey = normalizedKeys.get(normalizedKey);
      const childPath = [...pathSegments, normalizedKey];
      if (isExcluded(normalizedKey, childPath, state)) continue;
      result[normalizedKey] = canonicalizeInternal(value[sourceKey], childPath, state);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalize(value, options = {}) {
  const state = {
    options: normalizeOptions(options),
    ancestors: new Set()
  };
  return canonicalizeInternal(value, [], state);
}

function canonicalStringify(value, options = {}) {
  return JSON.stringify(canonicalize(value, options)) + '\n';
}

function canonicalBytes(value, options = {}) {
  return Buffer.from(canonicalStringify(value, options), 'utf8');
}

function cloneCanonical(value, options = {}) {
  return JSON.parse(canonicalStringify(value, options));
}

function semanticOptions(options = {}) {
  const includeDefaultExclusions = options.useDefaultSemanticExclusions !== false;
  const excludedKeys = [
    ...(includeDefaultExclusions ? DEFAULT_SEMANTIC_EXCLUDED_KEYS : []),
    ...optionCollection(options.excludedKeys, 'excludedKeys'),
    ...optionCollection(options.volatileFields, 'volatileFields'),
    ...optionCollection(options.machineFields, 'machineFields')
  ];
  return { ...options, excludedKeys };
}

function semanticDigest(value, options = {}) {
  const canonical = canonicalStringify(value, semanticOptions(options));
  const bytes = Buffer.from(canonical, 'utf8');
  return Object.freeze({
    canonical,
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function semanticHash(value, options = {}) {
  return semanticDigest(value, options).sha256;
}

module.exports = {
  CanonicalizationError,
  DEFAULT_SEMANTIC_EXCLUDED_KEYS,
  DEFAULT_UNORDERED_ARRAY_FIELDS,
  STABLE_ID_KEYS_BY_FIELD,
  canonicalBytes,
  canonicalStringify,
  canonicalize,
  cloneCanonical,
  normalizeString,
  semanticDigest,
  semanticHash
};
