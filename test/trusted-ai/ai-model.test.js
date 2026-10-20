'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validateAuditEvent, validateContextManifest } = require('../../src/main/ai/model');

const PROJECT_ID = 'c4000000-0000-4000-8000-000000000001';
const SESSION_ID = 'c4000000-0000-4000-8000-000000000002';
const EVENT_ID = 'c4000000-0000-4000-8000-000000000003';
const REF_ID = 'c4000000-0000-4000-8000-000000000004';
const OTHER_ID = 'c4000000-0000-4000-8000-000000000005';
const BLOB_ID = 'c4000000-0000-4000-8000-000000000006';
const HASH = 'a'.repeat(64);
const TIME = '2026-07-17T08:00:00.000Z';

function envelope(eventType, fields = {}) {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    sequence: 1,
    eventType,
    occurredAt: TIME,
    ...fields
  };
}

function networkContext(decision = 'sent', operation = 'chat') {
  return {
    operation,
    provider: { origin: 'https://provider.example', providerKind: 'remote-ai', model: 'fixture' },
    privacyMode: 'normal',
    networkDecision: decision
  };
}

test('every immutable audit event branch accepts its exact declared shape', () => {
  const events = [
    envelope('ai-request', {
      networkContext: networkContext(), contentRetention: 'full', promptContentBlobId: BLOB_ID,
      promptTemplateVersion: 'v1', userPromptSha256: HASH, userPromptByteCount: 1,
      contextManifest: [{ kind: 'question', id: 'q', label: 'Q', unicodeCodePointCount: 1 }],
      outbound: { payloadSha256: HASH, byteCount: 2, unicodeCodePointCount: 2, sentAt: TIME }
    }),
    envelope('ai-blocked', {
      networkContext: networkContext('blocked'), contentRetention: 'metadata-only',
      userPromptSha256: HASH, userPromptByteCount: 1, reason: 'blocked', outbound: null
    }),
    envelope('ai-result', {
      requestEventId: REF_ID, contentRetention: 'metadata-only', outputSha256: HASH,
      byteCount: 3, partial: false, responseStatus: 200
    }),
    envelope('ai-accepted', {
      resultEventId: REF_ID, contentRetention: 'full', diffContentBlobId: BLOB_ID,
      diffSha256: HASH, baseDocumentRevision: 1, beforeHash: HASH, afterHash: HASH
    }),
    envelope('ai-rejected', { resultEventId: REF_ID, reason: 'user rejected' }),
    envelope('ai-regenerated', { resultEventId: REF_ID, replacementRequestEventId: OTHER_ID, reason: 'retry' }),
    envelope('ai-aborted', { requestEventId: REF_ID, reason: 'cancelled' }),
    envelope('ai-error', { requestEventId: REF_ID, reason: 'provider error' }),
    envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }),
    envelope('audit-redacted', {
      targetEventIds: [REF_ID], scope: 'all',
      redactedBlobs: [{ blobId: BLOB_ID, kind: 'prompt', sha256: HASH, byteCount: 4 }],
      reason: 'user-request'
    })
  ];
  events.forEach((event, index) => assert.equal(validateAuditEvent(event, PROJECT_ID, `$.events[${index}]`), undefined));
});

test('audit validators reject branch confusion, retention mismatch and invalid network metadata', () => {
  const cases = [
    envelope('unknown'),
    envelope('ai-request', {
      networkContext: { ...networkContext(), networkDecision: 'blocked' }, contentRetention: 'metadata-only',
      promptTemplateVersion: 'v1', userPromptSha256: HASH, userPromptByteCount: 1,
      contextManifest: [], outbound: { payloadSha256: HASH, byteCount: 1, unicodeCodePointCount: 1, sentAt: TIME }
    }),
    envelope('ai-request', {
      networkContext: networkContext(), contentRetention: 'full', promptTemplateVersion: 'v1',
      userPromptSha256: HASH, userPromptByteCount: 1, contextManifest: [],
      outbound: { payloadSha256: HASH, byteCount: 1, unicodeCodePointCount: 1, sentAt: TIME }
    }),
    envelope('ai-blocked', {
      networkContext: networkContext('blocked'), contentRetention: 'metadata-only', userPromptSha256: HASH,
      userPromptByteCount: 1, reason: 'blocked', outbound: {}
    }),
    envelope('ai-result', {
      requestEventId: REF_ID, contentRetention: 'metadata-only', outputSha256: HASH,
      byteCount: 1, partial: 'false', responseStatus: 200
    }),
    envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2, networkContext: networkContext() }),
    envelope('audit-redacted', { targetEventIds: [], scope: 'all', redactedBlobs: [], reason: 'user-request' })
  ];
  cases.forEach(event => assert.throws(() => validateAuditEvent(event, PROJECT_ID, '$.event'), error => error.code.startsWith('SCHEMA_')));

  const badOrigin = envelope('ai-request', {
    networkContext: {
      ...networkContext(),
      provider: { origin: 'https://user:pass@provider.example/path', providerKind: 'remote-ai', model: 'fixture' }
    },
    contentRetention: 'metadata-only', promptTemplateVersion: 'v1', userPromptSha256: HASH,
    userPromptByteCount: 1, contextManifest: [],
    outbound: { payloadSha256: HASH, byteCount: 1, unicodeCodePointCount: 1, sentAt: TIME }
  });
  assert.throws(() => validateAuditEvent(badOrigin, PROJECT_ID, '$.event'), error => error.code === 'SCHEMA_INVALID_PROVIDER_ORIGIN');

  const commonInvalid = [
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), schemaVersion: 2 },
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), eventId: 'bad' },
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), projectId: OTHER_ID },
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), sessionId: 'bad' },
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), sequence: 0 },
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), occurredAt: 'yesterday' },
    { ...envelope('restore', { restoredSnapshotId: REF_ID, resultingRevision: 2 }), extra: true }
  ];
  commonInvalid.forEach(event => assert.throws(() => validateAuditEvent(event, PROJECT_ID, '$.event'), error => error.code.startsWith('SCHEMA_')));
});

test('context manifest validates bounded semantic entries and rejects malformed fields', () => {
  const valid = [
    { kind: 'selection', id: 's1', label: 'Selection', unicodeCodePointCount: 2 },
    { kind: 'evidence', id: 'E1', label: 'Evidence', unicodeCodePointCount: 3, evidenceRevisionId: REF_ID, rawQuoteSha256: HASH, pageLabel: '2', included: true },
    { kind: 'attachment', id: 'a1', label: 'Attachment', unicodeCodePointCount: 0, included: false }
  ];
  assert.equal(validateContextManifest(valid, '$.context'), undefined);
  for (const invalid of [
    null,
    [{ kind: 'unknown', id: 'x', label: 'X', unicodeCodePointCount: 1 }],
    [{ kind: 'question', id: 'x', label: 'X', unicodeCodePointCount: -1 }],
    [{ kind: 'evidence', id: 'E1', label: 'X', unicodeCodePointCount: 1, evidenceRevisionId: 'bad' }],
    [{ kind: 'evidence', id: 'E1', label: 'X', unicodeCodePointCount: 1, rawQuoteSha256: 'BAD' }],
    [{ kind: 'question', id: 'x', label: 'X', unicodeCodePointCount: 1, extra: true }]
  ]) {
    assert.throws(() => validateContextManifest(invalid, '$.context'), error => error.code.startsWith('SCHEMA_'));
  }
});
