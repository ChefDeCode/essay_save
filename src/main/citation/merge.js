'use strict';

const { normalizeCitationItem, semanticKey } = require('./model');

const IDENTITY_FIELDS = new Set(['schemaVersion', 'libraryItemId', 'createdAt', 'updatedAt', 'legacySourceId']);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldSource(item, field) {
  return item.metadataProvenance?.fields?.[field] || item.metadataProvenance?.source || 'unknown';
}

function unionStrings(left = [], right = []) {
  return [...new Set([...left, ...right])].sort((a, b) => String(a).localeCompare(String(b), 'en'));
}

function unionObjects(left = [], right = []) {
  const values = new Map();
  for (const value of [...left, ...right]) values.set(JSON.stringify(value), value);
  return [...values.values()];
}

function conflictFields(existing, incoming) {
  const fields = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
  const conflicts = [];
  for (const field of [...fields].sort((a, b) => a.localeCompare(b, 'en'))) {
    if (IDENTITY_FIELDS.has(field) || ['metadataProvenance', 'tags', 'starred', 'privateNote', 'assetRefs'].includes(field)) continue;
    if (!hasOwn(existing, field) || !hasOwn(incoming, field) || equalValue(existing[field], incoming[field])) continue;
    conflicts.push({
      field,
      existing: existing[field],
      incoming: incoming[field],
      existingSource: fieldSource(existing, field),
      incomingSource: fieldSource(incoming, field),
      requiresUserChoice: fieldSource(existing, field) === 'manual' || fieldSource(incoming, field) === 'manual'
    });
  }
  return conflicts;
}

function planImportMerge(existingValues, incomingValues, options = {}) {
  const existing = existingValues.map(value => normalizeCitationItem(value, options));
  const incoming = incomingValues.map(value => normalizeCitationItem(value, options));
  const byKey = new Map();
  for (const item of existing) {
    const key = semanticKey(item);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const additions = [];
  const matches = [];
  const duplicateIncoming = [];
  const incomingKeys = new Map();
  for (const item of incoming) {
    const key = semanticKey(item);
    if (incomingKeys.has(key)) {
      duplicateIncoming.push({ semanticKey: key, firstIncomingId: incomingKeys.get(key), duplicateIncomingId: item.libraryItemId });
      continue;
    }
    incomingKeys.set(key, item.libraryItemId);
    const candidates = byKey.get(key) || [];
    if (!candidates.length) {
      additions.push(item);
      continue;
    }
    const target = candidates[0];
    matches.push({
      semanticKey: key,
      reason: key.startsWith('doi:') ? 'doi' : 'title-author-year',
      existingItemId: target.libraryItemId,
      incomingItemId: item.libraryItemId,
      ambiguousExistingIds: candidates.slice(1).map(candidate => candidate.libraryItemId),
      conflicts: conflictFields(target, item),
      existing: target,
      incoming: item
    });
  }
  return { schemaVersion: 1, additions, matches, duplicateIncoming };
}

function mergeItems(existingValue, incomingValue, choices = {}, options = {}) {
  const existing = normalizeCitationItem(existingValue, options);
  const incoming = normalizeCitationItem(incomingValue, options);
  if (semanticKey(existing) !== semanticKey(incoming)) {
    throw new Error('不能合并身份键不同的文献');
  }
  const result = JSON.parse(JSON.stringify(existing));
  for (const [field, value] of Object.entries(incoming)) {
    if (IDENTITY_FIELDS.has(field) || field === 'metadataProvenance') continue;
    if (!hasOwn(existing, field)) {
      result[field] = value;
      continue;
    }
    if (equalValue(existing[field], value)) continue;
    if (field === 'tags') result.tags = unionStrings(existing.tags, incoming.tags);
    else if (field === 'starred') result.starred = existing.starred === true || incoming.starred === true;
    else if (field === 'privateNote') result.privateNote = unionStrings([existing.privateNote].filter(Boolean), [incoming.privateNote].filter(Boolean)).join('\n\n');
    else if (field === 'assetRefs') result.assetRefs = unionObjects(existing.assetRefs, incoming.assetRefs);
    else if (choices[field] === 'incoming') result[field] = value;
    else if (choices[field] !== undefined && choices[field] !== 'existing') throw new Error(`字段 ${field} 的合并选择无效`);
  }
  const currentTime = options.now ? options.now() : new Date();
  result.updatedAt = currentTime instanceof Date ? currentTime.toISOString() : currentTime;
  result.metadataProvenance = {
    ...existing.metadataProvenance,
    source: 'merged',
    fields: { ...(existing.metadataProvenance?.fields || {}) }
  };
  for (const [field, choice] of Object.entries(choices)) {
    if (choice === 'incoming') result.metadataProvenance.fields[field] = fieldSource(incoming, field);
  }
  return normalizeCitationItem(result, options);
}

module.exports = {
  conflictFields,
  mergeItems,
  planImportMerge
};
