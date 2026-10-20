'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AssetStore } = require('../../src/main/data/asset-store');
const { ProjectRepository } = require('../../src/main/data/repository');
const { createEmptyProjectAggregate } = require('../../src/main/data/schema');
const {
  TrustedAiService,
  canonicalProviderOrigin,
  isLoopbackHostname,
  normalizeContextManifest,
  normalizeMessages,
  providerSnapshot
} = require('../../src/main/ai/trusted-ai-service');

const PROJECT_ID = 'a4000000-0000-4000-8000-000000000001';
const CITATION_ID = 'a4000000-0000-4000-8000-000000000002';
const ASSET_ID = 'a4000000-0000-4000-8000-000000000003';
const EVIDENCE_ID = 'a4000000-0000-4000-8000-000000000004';
const REVISION_ID = 'a4000000-0000-4000-8000-000000000005';
const REVIEW_EVENT_ID = 'a4000000-0000-4000-8000-000000000006';
const SESSION_ID = 'a4000000-0000-4000-8000-000000000007';
const REQUEST_ID = 'a4000000-0000-4000-8000-000000000008';

function sha(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 17, 8, 0, tick++));
}

async function seed(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'essayflow-m4-ai-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const now = fixedClock();
  const assetStore = new AssetStore(path.join(root, 'assets'), { now });
  const repository = new ProjectRepository({ rootPath: root, assetStore, now });
  await repository.initialize();
  const createdAt = now().toISOString();
  const aggregate = createEmptyProjectAggregate({
    projectId: PROJECT_ID,
    title: 'M4 fixture',
    createdAt,
    updatedAt: createdAt,
    privacyMode: options.privacyMode || 'normal',
    html: '<p data-essayflow-anchor="anchor-1">Fixture</p>'
  });
  aggregate.citationItems.push({
    schemaVersion: 1,
    id: CITATION_ID,
    citationItemId: CITATION_ID,
    projectId: PROJECT_ID,
    type: 'article-journal',
    title: 'Deterministic evidence',
    author: [{ family: 'Li', given: 'Ming' }],
    issued: { 'date-parts': [[2026]] }
  });
  const quoteRaw = 'The intervention improved the primary outcome.';
  aggregate.evidenceCards.push({
    schemaVersion: 1,
    id: EVIDENCE_ID,
    projectId: PROJECT_ID,
    currentRevisionId: REVISION_ID,
    tags: [],
    note: '',
    color: '#4f6f8f',
    researchQuestionIds: [],
    status: 'active',
    createdAt,
    updatedAt: createdAt
  });
  aggregate.evidenceRevisions.push({
    schemaVersion: 1,
    id: REVISION_ID,
    evidenceId: EVIDENCE_ID,
    revisionNumber: 1,
    citationItemId: CITATION_ID,
    sourceSnapshot: {
      assetId: ASSET_ID,
      fileSha256: '1'.repeat(64),
      title: 'Deterministic evidence',
      metadataSource: 'manual'
    },
    locator: {
      pageIndex: 2,
      pageLabel: '3',
      quoteRaw,
      quoteDisplay: quoteRaw,
      rawQuoteSha256: sha(quoteRaw),
      displayQuoteSha256: sha(quoteRaw),
      pageTextSha256: '2'.repeat(64),
      prefix: '',
      suffix: '',
      occurrenceIndex: 0,
      rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
      pageRotation: 0,
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      extractorName: 'pdfjs',
      extractorVersion: '3.11.174',
      transformVersion: 'essayflow-m3-v1',
      normalization: 'whitespace-collapse',
      extraction: 'pdf-text'
    },
    createdBy: 'user',
    createdAt
  });
  aggregate.evidenceReviewEvents.push({
    schemaVersion: 1,
    id: REVIEW_EVENT_ID,
    projectId: PROJECT_ID,
    evidenceId: EVIDENCE_ID,
    evidenceRevisionId: REVISION_ID,
    sequence: 1,
    actor: 'user',
    status: 'confirmed',
    previousReviewEventId: null,
    reason: 'fixture selection',
    createdAt
  });
  const created = await repository.createProject({ projectId: PROJECT_ID, aggregate });
  const settings = {
    providerId: 'fixture-provider',
    providerOrigin: options.providerOrigin || 'https://provider.example',
    model: 'fixture-model'
  };
  const captured = [];
  const responses = [...(options.responses || ['fixture response'])];
  let transportCalls = 0;
  const service = new TrustedAiService({
    repository,
    settingsStore: { readSync: () => settings },
    secretStore: { getCredential: () => 'sk-m4-canary-secret' },
    transport: async request => {
      transportCalls += 1;
      captured.push(request);
      if (options.transport) return options.transport(request, transportCalls);
      const content = responses.shift() ?? 'fixture response';
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content } }] })
      };
    },
    now,
    sessionId: SESSION_ID
  });
  return { repository, service, captured, created, calls: () => transportCalls };
}

function requestInput(revision) {
  return {
    projectId: PROJECT_ID,
    baseRevision: revision,
    operation: 'chat',
    messages: [{ role: 'user', content: 'Only send this question.' }],
    contextManifest: [{ kind: 'question', id: 'q1', label: 'Question', unicodeCodePointCount: 24 }],
    promptTemplateVersion: 'chat-v1'
  };
}

test('preview and transport payload are identical while credentials stay in the main-process boundary', async t => {
  const { repository, service, captured, created } = await seed(t);
  const preview = await service.previewRequest(requestInput(created.revision));
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.provider.origin, 'https://provider.example');
  await assert.rejects(service.executePrepared({ previewId: preview.previewId }), error => error.code === 'AI_CONFIRMATION_REQUIRED');

  const secondPreview = await service.previewRequest(requestInput(created.revision));
  const result = await service.executePrepared({ previewId: secondPreview.previewId, confirmed: true });
  assert.equal(result.content, 'fixture response');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.authorization, 'Bearer sk-m4-canary-secret');
  const sent = JSON.parse(captured[0].body);
  assert.deepEqual(sent, secondPreview.payload);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.deepEqual(aggregate.auditEvents.sort((a, b) => a.sequence - b.sequence).map(event => event.eventType), ['ai-request', 'ai-result']);
  assert.equal(aggregate.auditContentBlobs.length, 2);
  assert.equal(JSON.stringify(aggregate).includes('sk-m4-canary-secret'), false);
  assert.equal(aggregate.auditEvents[0].outbound.payloadSha256, sha(captured[0].body));
});

test('public request helpers reject malformed providers, messages and semantic context', () => {
  assert.equal(canonicalProviderOrigin('https://provider.example'), 'https://provider.example');
  assert.equal(isLoopbackHostname('LOCALHOST.'), true);
  assert.equal(isLoopbackHostname('127.0.0.9'), true);
  assert.equal(isLoopbackHostname('provider.example'), false);
  assert.equal(providerSnapshot({ providerId: 'p', providerOrigin: 'http://[::1]:11434', model: 'm' }).providerKind, 'local-ai');
  for (const value of ['bad', 'file:///tmp/x', 'https://u:p@host.test', 'https://host.test/path']) {
    assert.throws(() => canonicalProviderOrigin(value), error => error.code === 'AI_PROVIDER_ORIGIN_INVALID');
  }
  assert.throws(() => providerSnapshot(null), error => error.code === 'AI_PROVIDER_NOT_CONFIGURED');
  assert.throws(() => normalizeMessages([]), error => error.code === 'AI_MESSAGES_INVALID');
  assert.throws(() => normalizeMessages([{ role: 'tool', content: 'x' }]), error => error.code === 'AI_MESSAGES_INVALID');
  assert.throws(() => normalizeMessages([{ role: 'user', content: 'x'.repeat(200_001) }]), error => error.code === 'AI_INPUT_INVALID');
  assert.deepEqual(normalizeMessages([{ role: 'assistant', content: '' }]), [{ role: 'assistant', content: '' }]);
  assert.throws(() => normalizeContextManifest(null), error => error.code === 'AI_CONTEXT_INVALID');
  assert.throws(() => normalizeContextManifest([{}]), error => error.code === 'AI_INPUT_INVALID');
  assert.throws(() => normalizeContextManifest([{ kind: 'unknown', id: 'x', label: 'x', unicodeCodePointCount: 1 }]), error => error.code === 'AI_CONTEXT_INVALID');
  assert.throws(() => normalizeContextManifest([{ kind: 'evidence', id: 'E1', label: 'x', unicodeCodePointCount: 1, rawQuoteSha256: 'bad' }]), error => error.code === 'AI_CONTEXT_INVALID');
});

test('local-only blocks remote AI before transport and records outbound=null', async t => {
  const { repository, service, created, calls } = await seed(t, { privacyMode: 'local-only' });
  const preview = await service.previewRequest(requestInput(created.revision));
  assert.equal(preview.blocked, true);
  const result = await service.executePrepared({ previewId: preview.previewId });
  assert.equal(result.blocked, true);
  assert.equal(calls(), 0);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.auditEvents.length, 1);
  assert.equal(aggregate.auditEvents[0].eventType, 'ai-blocked');
  assert.equal(aggregate.auditEvents[0].outbound, null);
  assert.equal(aggregate.auditEvents[0].networkContext.networkDecision, 'blocked');
});

test('cancelRequest aborts transport, records ai-aborted and releases active request state', async t => {
  let markTransportStarted;
  const transportStarted = new Promise(resolve => { markTransportStarted = resolve; });
  const { repository, service, created } = await seed(t, {
    transport: request => new Promise((resolve, reject) => {
      markTransportStarted();
      request.signal.addEventListener('abort', () => {
        const error = new Error('fixture transport aborted');
        error.code = 'ABORTED';
        reject(error);
      }, { once: true });
    })
  });
  const preview = await service.previewRequest(requestInput(created.revision));
  const pending = service.executePrepared({ previewId: preview.previewId, requestId: REQUEST_ID, confirmed: true });
  await transportStarted;
  assert.equal(service.activeRequestCount, 1);
  assert.deepEqual(service.cancelRequest({ requestId: REQUEST_ID }), { cancelled: true, activeRequestCount: 1 });
  await assert.rejects(pending, error => error.code === 'AI_ABORTED');
  assert.equal(service.activeRequestCount, 0);
  assert.deepEqual(service.cancelRequest({ requestId: REQUEST_ID }), { cancelled: false, activeRequestCount: 0 });
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.deepEqual(aggregate.auditEvents.sort((left, right) => left.sequence - right.sequence).map(event => event.eventType), ['ai-request', 'ai-aborted']);
});

test('scholarly gateway records exact outbound/result hashes without persisting credentials', async t => {
  const { repository, service, captured, created } = await seed(t, {
    responses: ['unused'],
    transport: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[]}' })
  });
  const result = await service.requestScholarly({
    projectId: PROJECT_ID,
    requestId: REQUEST_ID,
    operation: 'citation-verify',
    sourceId: 'crossref',
    url: 'https://api.crossref.org/works?query=fixture',
    method: 'GET',
    headers: { accept: 'application/json', authorization: 'Bearer scholarly-canary' },
    body: null,
    confirmed: true
  });
  assert.equal(result.status, 200);
  assert.equal(result.revision, created.revision + 2);
  assert.equal(captured.length, 1);
  const aggregate = await repository.loadProject(PROJECT_ID);
  const events = aggregate.auditEvents.sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(events.map(event => event.eventType), ['ai-request', 'ai-result']);
  assert.equal(events[0].networkContext.operation, 'citation-verify');
  assert.equal(events[0].networkContext.provider.providerKind, 'scholarly-api');
  assert.equal(JSON.stringify(aggregate).includes('scholarly-canary'), false);
  assert.equal(events[1].outputSha256, sha('{"items":[]}'));
});

test('scholarly gateway local-only block creates no transport request', async t => {
  const { repository, service, created, calls } = await seed(t, { privacyMode: 'local-only' });
  const result = await service.requestScholarly({
    projectId: PROJECT_ID,
    requestId: REQUEST_ID,
    operation: 'literature-metadata',
    sourceId: 'openalex',
    url: 'https://api.openalex.org/works?search=fixture',
    method: 'GET', headers: {}, body: null
  });
  assert.equal(result.blocked, true);
  assert.equal(result.revision, created.revision + 1);
  assert.equal(calls(), 0);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.auditEvents[0].eventType, 'ai-blocked');
  assert.equal(aggregate.auditEvents[0].outbound, null);
});

test('scholarly gateway rejects malformed authority before transport', async t => {
  const { service, calls } = await seed(t);
  const base = {
    projectId: PROJECT_ID,
    requestId: REQUEST_ID,
    operation: 'literature-metadata',
    sourceId: 'fixture',
    url: 'https://api.example.test/search',
    method: 'GET', headers: {}, body: null
  };
  for (const patch of [
    { operation: 'matrix-extraction' },
    { url: 'file:///C:/secret.txt' },
    { method: 'TRACE' },
    { headers: null }
  ]) {
    await assert.rejects(service.requestScholarly({ ...base, ...patch }));
  }
  assert.equal(calls(), 0);
});

test('scholarly gateway persists transport and HTTP failures as terminal audit events', async t => {
  const failed = await seed(t, {
    transport: async () => {
      const error = new Error('fixture network failure');
      error.code = 'NETWORK_FAILED';
      throw error;
    }
  });
  await assert.rejects(failed.service.requestScholarly({
    projectId: PROJECT_ID, requestId: REQUEST_ID, operation: 'literature-metadata',
    sourceId: 'fixture', url: 'https://api.example.test/search', method: 'GET', headers: {}, body: null
  }), error => error.code === 'AI_TRANSPORT_ERROR');
  let aggregate = await failed.repository.loadProject(PROJECT_ID);
  assert.deepEqual(aggregate.auditEvents.sort((left, right) => left.sequence - right.sequence).map(event => event.eventType), ['ai-request', 'ai-error']);

  const httpFailure = await seed(t, { transport: async () => ({ status: 503, body: 'unavailable' }) });
  await assert.rejects(httpFailure.service.requestScholarly({
    projectId: PROJECT_ID, requestId: REQUEST_ID, operation: 'literature-metadata',
    sourceId: 'fixture', url: 'https://api.example.test/search', method: 'GET', headers: {}, body: null
  }), error => error.code === 'AI_PROVIDER_ERROR');
  aggregate = await httpFailure.repository.loadProject(PROJECT_ID);
  assert.deepEqual(aggregate.auditEvents.sort((left, right) => left.sequence - right.sequence).map(event => event.eventType), ['ai-request', 'ai-error']);
});

test('remote PDF execution is transparently audited and privacy blocking occurs before the downloader', async t => {
  const normal = await seed(t);
  let downloads = 0;
  const completed = await normal.service.executeAuditedExternal({
    projectId: PROJECT_ID,
    operation: 'pdf-download',
    url: 'https://papers.example/article.pdf',
    label: 'Fixture PDF',
    confirmed: false
  }, async () => {
    downloads += 1;
    return { value: 'managed-result', auditSummary: { contentType: 'application/pdf', byteCount: 42 } };
  });
  assert.equal(completed.value, 'managed-result');
  assert.equal(downloads, 1);
  let aggregate = await normal.repository.loadProject(PROJECT_ID);
  const request = aggregate.auditEvents.find(event => event.eventType === 'ai-request');
  const result = aggregate.auditEvents.find(event => event.eventType === 'ai-result');
  assert.equal(request.networkContext.operation, 'pdf-download');
  assert.equal(request.networkContext.provider.origin, 'https://papers.example');
  assert.equal(request.contentRetention, 'metadata-only');
  assert.equal(result.requestEventId, request.eventId);

  const blocked = await seed(t, { privacyMode: 'local-only' });
  let blockedDownloads = 0;
  await assert.rejects(blocked.service.executeAuditedExternal({
    projectId: PROJECT_ID,
    operation: 'pdf-download',
    url: 'https://papers.example/article.pdf',
    label: 'Blocked fixture'
  }, async () => {
    blockedDownloads += 1;
    return { value: 'should-not-run' };
  }), error => error.code === 'PRIVACY_LOCAL_ONLY_BLOCKED');
  assert.equal(blockedDownloads, 0);
  aggregate = await blocked.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.auditEvents.length, 1);
  assert.equal(aggregate.auditEvents[0].eventType, 'ai-blocked');
  assert.equal(aggregate.auditEvents[0].outbound, null);
});

test('remote PDF failures append an error event without manufacturing a result', async t => {
  const { repository, service } = await seed(t);
  await assert.rejects(service.executeAuditedExternal({
    projectId: PROJECT_ID,
    operation: 'pdf-download',
    url: 'https://papers.example/failure.pdf',
    label: 'Failure fixture'
  }, async () => { throw new Error('synthetic download failure'); }), error => error.code === 'PDF_DOWNLOAD_FAILED');
  const aggregate = await repository.loadProject(PROJECT_ID);
  const events = [...aggregate.auditEvents].sort((left, right) => left.sequence - right.sequence);
  assert.deepEqual(events.map(event => event.eventType), ['ai-request', 'ai-error']);
  assert.equal(events[1].requestEventId, events[0].eventId);
});

test('remote PDF audit validates authority, requires sensitive confirmation and records aborts', async t => {
  const invalid = await seed(t);
  await assert.rejects(invalid.service.executeAuditedExternal({
    projectId: PROJECT_ID, operation: 'chat', url: 'https://papers.example/a.pdf'
  }, async () => ({})), error => error.code === 'AI_OPERATION_INVALID');
  await assert.rejects(invalid.service.executeAuditedExternal({
    projectId: PROJECT_ID, operation: 'pdf-download', url: 'https://user:secret@papers.example/a.pdf'
  }, async () => ({})), error => error.code === 'AI_PROVIDER_ORIGIN_INVALID');
  await assert.rejects(invalid.service.executeAuditedExternal({
    projectId: PROJECT_ID, operation: 'pdf-download', url: 'https://papers.example/a.pdf'
  }, null), error => error.code === 'AI_INPUT_INVALID');

  const sensitive = await seed(t, { privacyMode: 'sensitive' });
  let calls = 0;
  const input = { projectId: PROJECT_ID, operation: 'pdf-download', url: 'https://papers.example/sensitive.pdf', label: 'Sensitive PDF' };
  await assert.rejects(sensitive.service.executeAuditedExternal(input, async () => {
    calls += 1;
    return undefined;
  }), error => error.code === 'PRIVACY_CONFIRMATION_REQUIRED');
  assert.equal(calls, 0);
  const result = await sensitive.service.executeAuditedExternal({ ...input, confirmed: true }, async () => {
    calls += 1;
    return undefined;
  });
  assert.equal(calls, 1);
  assert.equal(result.value, undefined);

  const aborted = await seed(t);
  await assert.rejects(aborted.service.executeAuditedExternal({
    projectId: PROJECT_ID, operation: 'pdf-download', url: 'https://papers.example/aborted.pdf'
  }, async () => {
    const error = new Error('cancelled');
    error.code = 'ABORTED';
    throw error;
  }), error => error.code === 'PDF_DOWNLOAD_FAILED');
  const abortedAggregate = await aborted.repository.loadProject(PROJECT_ID);
  assert.ok(abortedAggregate.auditEvents.some(event => event.eventType === 'ai-aborted'));
});

test('transport abort, network failure and HTTP failure append immutable terminal events', async t => {
  const scenarios = [
    { code: 'ABORTED', expectedCode: 'AI_ABORTED', expectedEvent: 'ai-aborted' },
    { code: 'ECONNRESET', expectedCode: 'AI_TRANSPORT_ERROR', expectedEvent: 'ai-error' },
    { status: 503, expectedCode: 'AI_PROVIDER_ERROR', expectedEvent: 'ai-error' }
  ];
  for (const scenario of scenarios) {
    const fixture = await seed(t, {
      transport: async () => {
        if (scenario.status) return { status: scenario.status, body: '{"error":"down"}' };
        const error = new Error(scenario.code === 'ABORTED' ? 'cancelled' : 'connection reset');
        error.code = scenario.code;
        throw error;
      }
    });
    await assert.rejects(fixture.service.request({ ...requestInput(fixture.created.revision), confirmed: true }), error => error.code === scenario.expectedCode);
    const aggregate = await fixture.repository.loadProject(PROJECT_ID);
    const ordered = aggregate.auditEvents.sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(ordered.map(event => event.eventType), ['ai-request', scenario.expectedEvent]);
    assert.equal(ordered[1].requestEventId, ordered[0].eventId);
  }
});

test('empty provider responses fail without manufacturing a result event', async t => {
  for (const body of ['', '{}']) {
    const fixture = await seed(t, { transport: async () => ({ status: 200, body }) });
    await assert.rejects(fixture.service.request({ ...requestInput(fixture.created.revision), confirmed: true }), error => error.code === 'AI_RESPONSE_EMPTY');
    const aggregate = await fixture.repository.loadProject(PROJECT_ID);
    assert.equal(aggregate.auditEvents.filter(event => event.eventType === 'ai-result').length, 0);
  }
});

test('preview expiry and revision drift are rejected before external transport', async t => {
  const fixture = await seed(t);
  const preview = await fixture.service.previewRequest(requestInput(fixture.created.revision));
  fixture.service.previews.get(preview.previewId).expiresAt = 0;
  await assert.rejects(fixture.service.executePrepared({ previewId: preview.previewId, confirmed: true }), error => error.code === 'AI_PREVIEW_EXPIRED');
  const second = await fixture.service.previewRequest(requestInput(fixture.created.revision));
  const aggregate = await fixture.repository.loadProject(PROJECT_ID);
  await fixture.repository.saveProject({ projectId: PROJECT_ID, baseRevision: aggregate.manifest.revision, aggregate, source: 'concurrent-edit' });
  await assert.rejects(fixture.service.executePrepared({ previewId: second.previewId, confirmed: true }), error => error.code === 'AI_REVISION_CONFLICT');
  assert.equal(fixture.calls(), 0);
});

test('grounded answer accepts only sent evidence tokens and forces model review status to unreviewed', async t => {
  const response = JSON.stringify({
    status: 'complete',
    segments: [{ kind: 'sourced', text: 'The primary outcome improved.', sourceTokens: ['E1'], userReviewStatus: 'confirmed' }]
  });
  const { repository, service, created, captured } = await seed(t, { responses: [response] });
  const result = await service.askGrounded({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    question: 'What changed?',
    evidenceRevisionIds: [REVISION_ID],
    confirmed: true
  });
  assert.equal(result.answer.status, 'complete');
  assert.equal(result.answer.segments[0].userReviewStatus, 'unreviewed');
  assert.equal(result.answer.segments[0].sourceRefs[0].evidenceRevisionId, REVISION_ID);
  assert.deepEqual(result.answer.sanitizations, [{
    code: 'model-review-authority-dropped',
    path: 'segments[0].userReviewStatus',
    reason: '模型无权把用户审阅状态设为 confirmed，已强制改为 unreviewed'
  }]);
  const outbound = JSON.parse(captured[0].body);
  assert.match(outbound.messages[1].content, /"token":"E1"/);
  assert.doesNotMatch(outbound.messages[1].content, /provider\.example/);
  const reloaded = await repository.loadProject(PROJECT_ID);
  assert.equal(reloaded.groundedAnswers.length, 1);
  assert.equal(reloaded.aiThreads[0].messages.length, 2);
  const audit = await service.exportAudit(PROJECT_ID);
  assert.match(audit.humanReportMarkdown, /Deterministic evidence/);
  assert.match(audit.humanReportMarkdown, /页码 3/);
  assert.match(audit.humanReportMarkdown, new RegExp(`Evidence ID ${EVIDENCE_ID}`));
  assert.match(audit.humanReportMarkdown, new RegExp(`EvidenceRevision ${REVISION_ID}`));
  assert.doesNotMatch(audit.humanReportMarkdown, /The primary outcome improved\./);
});

test('commitChat accepts only paired chat audit events and preserves an existing thread', async t => {
  const { repository, service, created } = await seed(t, { responses: ['first answer', 'second answer'] });
  const first = await service.request({ ...requestInput(created.revision), confirmed: true });
  const committed = await service.commitChat({
    projectId: PROJECT_ID,
    baseRevision: first.revision,
    requestEventId: first.requestEventId,
    resultEventId: first.resultEventId,
    userContent: 'First question',
    assistantContent: first.content,
    attachments: []
  });
  assert.equal(committed.thread.messages.length, 2);
  const second = await service.request({ ...requestInput(committed.revision), confirmed: true });
  const appended = await service.commitChat({
    projectId: PROJECT_ID,
    baseRevision: second.revision,
    threadId: committed.thread.id,
    requestEventId: second.requestEventId,
    resultEventId: second.resultEventId,
    userContent: 'Second question',
    assistantContent: second.content
  });
  assert.equal(appended.thread.id, committed.thread.id);
  assert.equal(appended.thread.messages.length, 4);
  await assert.rejects(service.commitChat({
    projectId: PROJECT_ID,
    baseRevision: appended.revision - 1,
    requestEventId: first.requestEventId,
    resultEventId: first.resultEventId,
    userContent: '', assistantContent: ''
  }), error => error.code === 'AI_REVISION_CONFLICT');
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.aiThreads.length, 1);
});

test('project chat persists by thread and audit exports are redacted unless content is explicitly selected', async t => {
  const { service, created } = await seed(t, { responses: ['Chat answer'] });
  const attachment = {
    id: 'a4000000-0000-4000-8000-000000000010',
    schemaVersion: 1,
    projectId: PROJECT_ID,
    assetId: ASSET_ID,
    extractedSnapshotHash: '4'.repeat(64),
    retentionMode: 'reference-only',
    confirmedAt: '2026-07-17T08:00:00.000Z'
  };
  const chat = await service.sendChat({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Question' }],
    attachments: [attachment],
    confirmed: true
  });
  assert.equal(chat.content, 'Chat answer');
  assert.equal(chat.thread.messages[0].attachments[0].retentionMode, 'reference-only');
  const state = await service.listProjectAi(PROJECT_ID);
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].projectId, PROJECT_ID);
  const redacted = await service.exportAudit(PROJECT_ID);
  assert.equal(redacted.contentIncluded, false);
  assert.ok(redacted.blobs.every(blob => blob.content === '[默认脱敏]' && !Object.hasOwn(blob, 'utf8Content')));
  const full = await service.exportAudit(PROJECT_ID, { includeContent: true });
  assert.equal(full.contentIncluded, true);
  assert.ok(full.blobs.some(blob => blob.utf8Content === 'Question'));
});

test('unknown model token retries once then persists invalid without a valid source label', async t => {
  const malicious = JSON.stringify({ status: 'complete', segments: [{ kind: 'sourced', text: 'Invented.', sourceTokens: ['E99'] }] });
  const { repository, service, created, calls } = await seed(t, { responses: [malicious, malicious] });
  const result = await service.askGrounded({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    question: 'Can E99 answer this?',
    evidenceRevisionIds: [REVISION_ID],
    confirmed: true
  });
  assert.equal(calls(), 2);
  assert.equal(result.answer.status, 'invalid');
  assert.equal(result.answer.segments[0].sourceRefs.length, 0);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.deepEqual(aggregate.auditEvents.sort((a, b) => a.sequence - b.sequence).map(event => event.eventType), ['ai-request', 'ai-result', 'ai-request', 'ai-result']);
});

test('grounded parser and evidence budget fail closed on malformed, missing, rejected and oversized inputs', async t => {
  const { repository, service } = await seed(t);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.throws(() => service._groundedInput(aggregate, []), error => error.code === 'AI_GROUNDED_EVIDENCE_LIMIT');
  assert.throws(() => service._groundedInput(aggregate, Array(21).fill(REVISION_ID)), error => error.code === 'AI_GROUNDED_EVIDENCE_LIMIT');
  assert.throws(() => service._groundedInput(aggregate, ['a4000000-0000-4000-8000-000000000099']), error => error.code === 'AI_EVIDENCE_MISSING');
  const rejected = JSON.parse(JSON.stringify(aggregate));
  rejected.evidenceReviewEvents[0].status = 'rejected';
  assert.throws(() => service._groundedInput(rejected, [REVISION_ID]), error => error.code === 'AI_EVIDENCE_REJECTED');
  const oversized = JSON.parse(JSON.stringify(aggregate));
  oversized.evidenceRevisions[0].locator.quoteRaw = 'x'.repeat(24_001);
  assert.throws(() => service._groundedInput(oversized, [REVISION_ID]), error => error.code === 'AI_GROUNDED_CONTEXT_TOO_LARGE');

  const tokenMap = new Map([['E1', {
    evidenceId: EVIDENCE_ID, evidenceRevisionId: REVISION_ID,
    rawQuoteSha256: '5'.repeat(64), sourceCitationSnapshot: {}
  }]]);
  for (const content of [
    'not-json',
    '{}',
    JSON.stringify({ status: 'complete', segments: [{ kind: 'bad', text: 'x', sourceTokens: [] }] }),
    JSON.stringify({ status: 'complete', segments: [{ kind: 'sourced', text: 'x', sourceTokens: [] }] }),
    JSON.stringify({ status: 'complete', segments: [{ kind: 'inference', text: 'x', sourceTokens: ['E1'] }] })
  ]) {
    assert.throws(() => service._parseGrounded(content, tokenMap), error => error.code.startsWith('AI_GROUNDED_'));
  }
});

test('chat clearing does not silently delete audit content and redaction appends a tombstone', async t => {
  const response = JSON.stringify({ status: 'complete', segments: [{ kind: 'insufficient', text: 'Insufficient.', sourceTokens: [] }] });
  const { repository, service, created } = await seed(t, { responses: [response] });
  const grounded = await service.askGrounded({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    question: 'Unknown?',
    evidenceRevisionIds: [REVISION_ID],
    confirmed: true
  });
  const cleared = await service.clearChat({ projectId: PROJECT_ID, baseRevision: grounded.revision });
  assert.equal(cleared.auditContentRemains, true);
  let aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.aiThreads.length, 0);
  assert.equal(aggregate.auditContentBlobs.length, 2);
  const target = aggregate.auditContentBlobs[0];
  const redacted = await service.redactAudit({ projectId: PROJECT_ID, baseRevision: cleared.revision, blobIds: [target.blobId] });
  assert.equal(redacted.removedBlobCount, 1);
  assert.deepEqual(redacted.managedBackupsRewritten, []);
  aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.auditContentBlobs.some(blob => blob.blobId === target.blobId), false);
  const tombstone = aggregate.auditEvents.find(event => event.eventType === 'audit-redacted');
  assert.ok(tombstone);
  assert.equal(tombstone.redactedBlobs[0].sha256, target.sha256);
  const futureExport = await service.exportAudit(PROJECT_ID, { includeContent: true });
  assert.equal(futureExport.blobs.some(blob => blob.blobId === target.blobId), false);
  assert.equal(futureExport.events.find(event => event.eventType === 'audit-redacted').redactedBlobs[0].blobId, target.blobId);
  const state = await service.listProjectAi(PROJECT_ID);
  assert.deepEqual(state.managedBackups, []);
});

test('repository rejects incomplete, cross-project and mismatched GroundedAnswer chains with zero writes', async t => {
  const response = JSON.stringify({ status: 'complete', segments: [{ kind: 'sourced', text: 'Supported.', sourceTokens: ['E1'] }] });
  const { repository, service, created } = await seed(t, { responses: [response] });
  await service.askGrounded({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    question: 'Supported?',
    evidenceRevisionIds: [REVISION_ID],
    confirmed: true
  });
  const before = await repository.loadProject(PROJECT_ID);
  const cases = [
    aggregate => { delete aggregate.groundedAnswers[0].auditResultId; },
    aggregate => {
      const result = aggregate.auditEvents.find(event => event.eventType === 'ai-result');
      result.projectId = 'b4000000-0000-4000-8000-000000000001';
    },
    aggregate => {
      const request = aggregate.auditEvents.find(event => event.eventType === 'ai-request');
      request.networkContext.operation = 'chat';
    },
    aggregate => {
      const result = aggregate.auditEvents.find(event => event.eventType === 'ai-result');
      result.requestEventId = 'b4000000-0000-4000-8000-000000000002';
    }
  ];
  for (const mutate of cases) {
    const aggregate = await repository.loadProject(PROJECT_ID);
    mutate(aggregate);
    await assert.rejects(repository.saveProject({
      projectId: PROJECT_ID,
      baseRevision: before.manifest.revision,
      aggregate,
      source: 'invalid-grounded-fixture'
    }), error => error.code === 'ERR_REPOSITORY_INVALID_AGGREGATE');
    const after = await repository.loadProject(PROJECT_ID);
    assert.equal(after.manifest.revision, before.manifest.revision);
    assert.deepEqual(after.groundedAnswers, before.groundedAnswers);
  }
});

test('review suggestions persist without changing the document and rejection appends a decision event', async t => {
  const response = JSON.stringify({ issues: [{
    originalText: 'Fixture', suggestedText: 'Improved fixture', category: 'language', reason: 'More precise wording.'
  }] });
  const { repository, service, created } = await seed(t, { responses: [response] });
  const before = await repository.loadProject(PROJECT_ID);
  const proposed = await service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    documentRevision: created.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: 'Fixture',
    confirmed: true
  });
  let aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, before.document.html);
  assert.equal(proposed.issues[0].status, 'proposed');
  const rejected = await service.decideReviewIssue({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueId: proposed.issues[0].id,
    decision: 'rejected',
    reason: 'Keep original wording'
  });
  assert.equal(rejected.issue.status, 'rejected');
  aggregate = await repository.loadProject(PROJECT_ID);
  assert.ok(aggregate.auditEvents.some(event => event.eventType === 'ai-rejected'));
  assert.equal(aggregate.document.html, before.document.html);
});

test('review request rejects an unpersisted anchor before transport or audit mutation', async t => {
  const response = JSON.stringify({ issues: [{
    originalText: 'Fixture', suggestedText: 'Changed', category: 'language', reason: 'More precise.'
  }] });
  const { repository, service, created, calls } = await seed(t, { responses: [response] });
  await assert.rejects(service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    documentRevision: created.revision,
    operationMode: 'language',
    documentAnchorId: 'missing-anchor',
    selectedText: 'Fixture',
    confirmed: true
  }), error => error.code === 'AI_REVIEW_ANCHOR_MISSING');
  assert.equal(calls(), 0);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.manifest.revision, created.revision);
  assert.deepEqual(aggregate.auditEvents, []);
  assert.deepEqual(aggregate.reviewIssues, []);
});

test('evidence paraphrase keeps source and suggestion separate, changes nothing before acceptance and audits the accepted Diff', async t => {
  const quote = 'The intervention improved the primary outcome.';
  const paraphrase = 'The primary outcome improved following the intervention.';
  const response = JSON.stringify({ issues: [{
    originalText: quote,
    suggestedText: paraphrase,
    category: 'paraphrase',
    reason: 'Restates the evidence without direct quotation.'
  }] });
  const { repository, service, created } = await seed(t, { responses: [response] });
  let aggregate = await repository.loadProject(PROJECT_ID);
  aggregate.document.html = `<p data-essayflow-anchor="anchor-1">${quote}</p>`;
  const prepared = await repository.saveProject({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    aggregate,
    source: 'paraphrase-fixture'
  });
  const proposed = await service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: prepared.revision,
    documentRevision: prepared.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: quote,
    paraphrase: true,
    evidenceRevisionId: REVISION_ID,
    confirmed: true
  });
  aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, `<p data-essayflow-anchor="anchor-1">${quote}</p>`);
  assert.equal(proposed.issues[0].originalText, quote);
  assert.equal(proposed.issues[0].suggestedText, paraphrase);
  assert.equal(proposed.issues[0].category, 'paraphrase');
  assert.match(proposed.issues[0].reason, new RegExp(REVISION_ID));
  const resultEvent = aggregate.auditEvents.find(event => event.eventId === proposed.resultEventId);
  const requestEvent = aggregate.auditEvents.find(event => event.eventId === resultEvent.requestEventId);
  assert.ok(requestEvent.contextManifest.some(entry => entry.kind === 'evidence' && entry.evidenceRevisionId === REVISION_ID && entry.rawQuoteSha256 === sha(quote)));

  const accepted = await service.decideReviewIssue({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueId: proposed.issues[0].id,
    decision: 'accepted',
    documentRevision: prepared.revision,
    documentAnchorId: 'anchor-1',
    beforeHash: sha(quote),
    afterHash: sha(paraphrase),
    newDocumentHtml: `<p data-essayflow-anchor="anchor-1">${paraphrase}</p>`,
    diff: JSON.stringify({ sourceQuote: quote, paraphrase })
  });
  assert.ok(accepted.checkpointId);
  aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, `<p data-essayflow-anchor="anchor-1">${paraphrase}</p>`);
  assert.ok(aggregate.auditEvents.some(event => event.eventType === 'ai-accepted' && event.resultEventId === proposed.resultEventId));
});

test('evidence paraphrase rejects mismatched selections and quoted model output', async t => {
  const quoted = JSON.stringify({ issues: [{
    originalText: 'The intervention improved the primary outcome.',
    suggestedText: '“A quoted restatement.”',
    category: 'paraphrase',
    reason: 'Invalid direct quote.'
  }] });
  const fixture = await seed(t, { responses: [quoted] });
  await assert.rejects(fixture.service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: fixture.created.revision,
    documentRevision: fixture.created.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: 'Fixture',
    paraphrase: true,
    evidenceRevisionId: REVISION_ID,
    confirmed: true
  }), error => error.code === 'AI_PARAPHRASE_SELECTION_MISMATCH');
  assert.equal(fixture.calls(), 0);
  await assert.rejects(fixture.service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: fixture.created.revision,
    documentRevision: fixture.created.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: 'The intervention improved the primary outcome.',
    paraphrase: true,
    evidenceRevisionId: REVISION_ID,
    confirmed: true
  }), error => error.code === 'AI_PARAPHRASE_RESPONSE_INVALID');
  assert.equal(fixture.calls(), 1);
  const aggregate = await fixture.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, '<p data-essayflow-anchor="anchor-1">Fixture</p>');
  assert.equal(aggregate.reviewIssues.length, 0);
});

test('review regeneration links the abandoned result to the replacement request and preserves old history', async t => {
  const firstResponse = JSON.stringify({ issues: [{
    originalText: 'Fixture', suggestedText: 'First revision', category: 'language', reason: 'First reason.'
  }] });
  const secondResponse = JSON.stringify({ issues: [{
    originalText: 'Fixture', suggestedText: 'Second revision', category: 'language', reason: 'Second reason.'
  }] });
  const { repository, service, created } = await seed(t, { responses: [firstResponse, secondResponse] });
  const first = await service.requestReview({
    projectId: PROJECT_ID, baseRevision: created.revision, documentRevision: created.revision,
    operationMode: 'language', documentAnchorId: 'anchor-1', selectedText: 'Fixture', confirmed: true
  });
  const second = await service.requestReview({
    projectId: PROJECT_ID, baseRevision: first.revision, documentRevision: created.revision,
    operationMode: 'language', documentAnchorId: 'anchor-1', selectedText: 'Fixture', confirmed: true,
    regeneratedFromResultEventId: first.resultEventId
  });
  assert.equal(second.regeneratedEvent.resultEventId, first.resultEventId);
  assert.equal(second.regeneratedEvent.replacementRequestEventId, second.requestEventId);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.reviewIssues.find(issue => issue.auditResultId === first.resultEventId).status, 'stale');
  assert.equal(aggregate.reviewIssues.find(issue => issue.auditResultId === second.resultEventId).status, 'proposed');
  assert.equal(aggregate.auditEvents.filter(event => event.eventType === 'ai-regenerated').length, 1);
});

test('accepting a fresh review issue creates a checkpoint and atomically stores document, Diff and decision', async t => {
  const response = JSON.stringify({ issues: [{
    originalText: 'Fixture', suggestedText: 'Revised fixture', category: 'structure', reason: 'Clearer structure.'
  }] });
  const { repository, service, created } = await seed(t, { responses: [response] });
  const proposed = await service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: created.revision,
    documentRevision: created.revision,
    operationMode: 'structure',
    documentAnchorId: 'anchor-1',
    selectedText: 'Fixture',
    confirmed: true
  });
  const issue = proposed.issues[0];
  const newHtml = '<p data-essayflow-anchor="anchor-1">Revised fixture</p>';
  await assert.rejects(service.decideReviewIssue({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueId: issue.id,
    decision: 'accepted',
    documentRevision: created.revision,
    documentAnchorId: issue.documentAnchorId,
    beforeHash: issue.beforeHash,
    afterHash: sha(issue.suggestedText),
    newDocumentHtml: `<h1>Unrelated overwrite</h1>${newHtml}`,
    diff: '- Fixture\n+ Revised fixture'
  }), error => error.code === 'AI_REVIEW_PATCH_SCOPE_INVALID');
  const accepted = await service.decideReviewIssue({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueId: issue.id,
    decision: 'accepted',
    documentRevision: created.revision,
    documentAnchorId: issue.documentAnchorId,
    beforeHash: issue.beforeHash,
    afterHash: sha(issue.suggestedText),
    newDocumentHtml: newHtml,
    diff: '- Fixture\n+ Revised fixture'
  });
  assert.ok(accepted.checkpointId);
  const aggregate = await repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, newHtml);
  assert.equal(aggregate.reviewIssues.find(item => item.id === issue.id).status, 'accepted');
  assert.equal(aggregate.versions.length, 1);
  const event = aggregate.auditEvents.find(item => item.eventType === 'ai-accepted');
  assert.ok(event);
  assert.ok(aggregate.auditContentBlobs.some(blob => blob.blobId === event.diffContentBlobId && blob.kind === 'diff'));
  const redactedReport = await service.exportAudit(PROJECT_ID);
  assert.match(redactedReport.humanReportMarkdown, /## Diff 摘要/);
  assert.match(redactedReport.humanReportMarkdown, /structure · accepted/);
  assert.match(redactedReport.humanReportMarkdown, new RegExp(issue.beforeHash));
  assert.doesNotMatch(redactedReport.humanReportMarkdown, /Revised fixture/);
  const selectedContentReport = await service.exportAudit(PROJECT_ID, { includeContent: true });
  assert.match(selectedContentReport.humanReportMarkdown, /原文: Fixture/);
  assert.match(selectedContentReport.humanReportMarkdown, /建议: Revised fixture/);
});

test('batch review accepts non-overlapping suggestions in one checkpoint and rejects a batch without document mutation', async t => {
  const response = JSON.stringify({ issues: [
    { originalText: 'Fix', suggestedText: 'Clear', category: 'language', reason: 'Clearer opening.' },
    { originalText: 'ture', suggestedText: ' wording', category: 'terminology', reason: 'Clearer ending.' }
  ] });
  const acceptedSeed = await seed(t, { responses: [response] });
  const proposed = await acceptedSeed.service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: acceptedSeed.created.revision,
    documentRevision: acceptedSeed.created.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: 'Fixture',
    confirmed: true
  });
  const diffs = proposed.issues.map(issue => ({
    issueId: issue.id,
    beforeHash: issue.beforeHash,
    afterHash: sha(issue.suggestedText),
    diff: JSON.stringify({ originalText: issue.originalText, suggestedText: issue.suggestedText })
  }));
  const accepted = await acceptedSeed.service.decideReviewIssues({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueIds: proposed.issues.map(issue => issue.id),
    decision: 'accepted',
    documentRevision: acceptedSeed.created.revision,
    documentAnchorId: 'anchor-1',
    newDocumentHtml: '<p data-essayflow-anchor="anchor-1">Clear wording</p>',
    diffs,
    contentRetention: 'full'
  });
  assert.ok(accepted.checkpointId);
  let aggregate = await acceptedSeed.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, '<p data-essayflow-anchor="anchor-1">Clear wording</p>');
  assert.equal(aggregate.versions.length, 1);
  assert.equal(aggregate.reviewIssues.filter(issue => issue.status === 'accepted').length, 2);
  assert.equal(aggregate.auditEvents.filter(event => event.eventType === 'ai-accepted').length, 2);

  const rejectedSeed = await seed(t, { responses: [response] });
  const rejectedProposal = await rejectedSeed.service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: rejectedSeed.created.revision,
    documentRevision: rejectedSeed.created.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: 'Fixture',
    confirmed: true
  });
  const rejected = await rejectedSeed.service.decideReviewIssues({
    projectId: PROJECT_ID,
    baseRevision: rejectedProposal.revision,
    issueIds: rejectedProposal.issues.map(issue => issue.id),
    decision: 'rejected',
    reason: 'Keep fixture'
  });
  assert.equal(rejected.issues.every(issue => issue.status === 'rejected'), true);
  aggregate = await rejectedSeed.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, '<p data-essayflow-anchor="anchor-1">Fixture</p>');
  assert.equal(aggregate.auditEvents.filter(event => event.eventType === 'ai-rejected').length, 2);
});

test('batch review rejects duplicate authority and mismatched Diff sets without document writes', async t => {
  const response = JSON.stringify({ issues: [
    { originalText: 'Fix', suggestedText: 'Clear', category: 'language', reason: 'A' },
    { originalText: 'ture', suggestedText: ' wording', category: 'language', reason: 'B' }
  ] });
  const seeded = await seed(t, { responses: [response] });
  const proposed = await seeded.service.requestReview({
    projectId: PROJECT_ID,
    baseRevision: seeded.created.revision,
    documentRevision: seeded.created.revision,
    operationMode: 'language',
    documentAnchorId: 'anchor-1',
    selectedText: 'Fixture',
    confirmed: true
  });
  await assert.rejects(seeded.service.decideReviewIssues({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueIds: [proposed.issues[0].id, proposed.issues[0].id],
    decision: 'rejected'
  }), error => error.code === 'AI_REVIEW_BATCH_INVALID');
  await assert.rejects(seeded.service.decideReviewIssues({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueIds: proposed.issues.map(issue => issue.id),
    decision: 'accepted',
    documentRevision: seeded.created.revision,
    documentAnchorId: 'anchor-1',
    newDocumentHtml: '<p data-essayflow-anchor="anchor-1">Clear wording</p>',
    diffs: []
  }), error => error.code === 'AI_REVIEW_BATCH_INVALID');
  const aggregate = await seeded.repository.loadProject(PROJECT_ID);
  assert.equal(aggregate.document.html, '<p data-essayflow-anchor="anchor-1">Fixture</p>');
  assert.equal(aggregate.reviewIssues.every(issue => issue.status === 'proposed'), true);
});

test('stale and overlapping review suggestions fail closed', async t => {
  const valid = JSON.stringify({ issues: [{ originalText: 'Fixture', suggestedText: 'Changed', category: 'logic', reason: 'Reason' }] });
  const { repository, service, created } = await seed(t, { responses: [valid] });
  const proposed = await service.requestReview({
    projectId: PROJECT_ID, baseRevision: created.revision, documentRevision: created.revision,
    operationMode: 'logic', documentAnchorId: 'anchor-1', selectedText: 'Fixture', confirmed: true
  });
  await assert.rejects(service.decideReviewIssue({
    projectId: PROJECT_ID,
    baseRevision: proposed.revision,
    issueId: proposed.issues[0].id,
    decision: 'accepted',
    documentRevision: created.revision + 1,
    documentAnchorId: 'anchor-1',
    beforeHash: proposed.issues[0].beforeHash,
    afterHash: sha('Changed'),
    newDocumentHtml: '<p data-essayflow-anchor="anchor-1">Changed</p>',
    diff: '- Fixture\n+ Changed'
  }), error => error.code === 'AI_REVIEW_ISSUE_STALE');
  const stale = await repository.loadProject(PROJECT_ID);
  assert.equal(stale.reviewIssues[0].status, 'stale');

  const overlapping = JSON.stringify({ issues: [
    { originalText: 'Fixture', suggestedText: 'A', category: 'logic', reason: 'A' },
    { originalText: 'ture', suggestedText: 'B', category: 'logic', reason: 'B' }
  ] });
  const second = await seed(t, { responses: [overlapping] });
  await assert.rejects(second.service.requestReview({
    projectId: PROJECT_ID, baseRevision: second.created.revision, documentRevision: second.created.revision,
    operationMode: 'logic', documentAnchorId: 'anchor-1', selectedText: 'Fixture', confirmed: true
  }), error => error.code === 'AI_REVIEW_OVERLAP');
  const unchanged = await second.repository.loadProject(PROJECT_ID);
  assert.equal(unchanged.reviewIssues.length, 0);
  assert.equal(unchanged.document.html, '<p data-essayflow-anchor="anchor-1">Fixture</p>');

  const parseInput = { projectId: PROJECT_ID, operationMode: 'logic', documentAnchorId: 'anchor-1', documentRevision: 0 };
  for (const content of [
    'bad-json',
    '{}',
    JSON.stringify({ issues: [null] }),
    JSON.stringify({ issues: [{ originalText: 'missing', suggestedText: 'x', reason: 'x' }] }),
    JSON.stringify({ issues: [{ originalText: 'same', suggestedText: 'x', reason: 'x' }] })
  ]) {
    const selected = content.includes('"same"') ? 'same and same' : 'Fixture';
    assert.throws(() => service._parseReviewIssues(content, selected, parseInput, 'a4000000-0000-4000-8000-000000000020'), error => error.code.startsWith('AI_'));
  }
});
