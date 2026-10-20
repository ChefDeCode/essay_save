'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

function sha(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function startMock(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method,
        url: request.url,
        body,
        authorizationPresent: typeof request.headers.authorization === 'string'
      });
      if (request.url === '/paper.pdf') {
        response.writeHead(200, { 'content-type': 'application/pdf' });
        response.end('%PDF-1.4\n%%EOF');
        return;
      }
      if (request.url.startsWith('/scholarly')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"items":[]}');
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = String(messages.find(message => message.role === 'system')?.content || '');
      const user = String([...messages].reverse().find(message => message.role === 'user')?.content || '');
      let content = 'Chat persisted from the deterministic local provider.';
      if (system.includes('不加引号的学术转述')) {
        content = JSON.stringify({ issues: [{
          originalText: 'The intervention improved the primary outcome.',
          suggestedText: 'The primary outcome improved following the intervention.',
          category: 'paraphrase',
          reason: 'Restates the selected evidence without direct quotation.'
        }] });
      } else if (system.includes('返回严格 JSON') && system.includes('issues')) {
        content = JSON.stringify({ issues: [
          { originalText: 'Fixture', suggestedText: 'Revised fixture', category: 'language', reason: 'Use a more precise term.' },
          { originalText: 'review', suggestedText: 'assessment', category: 'terminology', reason: 'Use consistent terminology.' }
        ] });
      } else if (system.includes('untrusted_evidence')) {
        if (user.includes('unavailable')) {
          content = JSON.stringify({ status: 'partial', segments: [{ kind: 'insufficient', text: 'The selected evidence does not answer this question.', sourceTokens: [] }] });
        } else if (user.includes('E99')) {
          content = JSON.stringify({ status: 'complete', segments: [{ kind: 'sourced', text: 'Fabricated source token.', sourceTokens: ['E99'], userReviewStatus: 'confirmed' }] });
        } else {
          content = JSON.stringify({ status: 'complete', segments: [
            { kind: 'sourced', text: 'Evidence one reports an improvement.', sourceTokens: ['E1'], userReviewStatus: 'confirmed' },
            { kind: 'sourced', text: 'Evidence two reports no improvement.', sourceTokens: ['E2'] },
            { kind: 'inference', text: 'The selected evidence is in conflict.', sourceTokens: [] }
          ] });
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` };
}

test('M4 trusted AI is grounded, reviewable, auditable, persistent and local-only safe', { timeout: 300_000 }, async t => {
  const mock = await startMock(t);
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m4-e2e-'));
  const localPdfRoot = path.join(profileRoot, 'localPdfs');
  fs.mkdirSync(localPdfRoot, { recursive: true });
  const pdfPath = path.join(localPdfRoot, 'm4-evidence.pdf');
  fs.copyFileSync(path.join(root, 'test', 'fixtures', 'pdf', 'text-layer-en.pdf'), pdfPath);
  const profileReportPath = path.join(profileRoot, 'profile-report.json');
  const launchOptions = {
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath,
    env: { ESSAYFLOW_AUTOMATION_LOCAL_AI_ORIGIN: mock.origin }
  };
  let driver = await launchElectron(launchOptions);
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && Boolean(document.getElementById("trusted-ai-tabs"))', { timeoutMs: 45_000 });
  driver.client.timeoutMs = 120_000;

  let first;
  try {
    first = await driver.client.evaluate(String.raw`(async () => {
    window.confirm = () => true;
    const waitUntil = async (predicate, label, timeout = 45000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('M4 timeout: ' + label);
    };
    const sha = async value => {
      const bytes = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    };
    await window.essayflowDataReady;
    let settingsResult = await window.electronAPI.updateExportableSettings({
      providerId: 'm4-local-fixture',
      providerOrigin: ${JSON.stringify(mock.origin)},
      model: 'm4-deterministic-model'
    });
    window.essayflowDataState.settings = settingsResult.settings;
    await window.electronAPI.setProviderCredential({ providerId: 'm4-local-fixture', value: 'm4-e2e-secret-canary' });
    window._aiCredentialConfigured = true;

    const descriptor = await window.electronAPI.importManagedPdfForEvidence(${JSON.stringify(pdfPath)});
    let library = await window.electronAPI.loadLibraryStore();
    await window.electronAPI.replaceLibraryStore({ baseRevision: library.revision, items: [{
      id: 'm4-evidence-paper', type: 'article-journal', title: 'M4 Evidence Fixture',
      author: [{ family: 'Fixture', given: 'M4' }], issued: { 'date-parts': [[2026]] }, DOI: '10.5555/m4.fixture',
      assetRefs: [{ assetId: descriptor.assetId, sha256: descriptor.sha256, kind: 'pdf', role: 'full-text' }], hasPdf: true,
      metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
    }] });
    library = await window.electronAPI.loadLibraryStore();
    const item = library.items[0];
    const projectId = crypto.randomUUID();
    await window.electronAPI.saveProjectAuto({
      projectId, baseRevision: -1,
      content: '<h1>M4 可信 AI 验收</h1><p>Fixture sentence for review.</p><p>The intervention improved the primary outcome.</p>',
      meta: { title: 'M4 可信 AI 验收', referenceStyle: 'APA', privacyMode: 'normal' },
      citations: [], source: 'm4-e2e-create'
    });
    await loadProject(projectId);

    const createEvidence = async (quoteRaw, pageIndex, pageLabel, x, evidenceId) => {
      const context = window.getEssayflowProjectContext();
      const result = await window.electronAPI.createEvidenceFromUserSelection({
        projectId,
        baseRevision: context.revision,
        libraryItemId: item.libraryItemId,
        assetId: descriptor.assetId,
        fileSha256: descriptor.sha256,
        title: item.title,
        doi: item.DOI,
        metadataSource: 'manual',
        pageIndex,
        pageLabel,
        quoteRaw,
        pageTextSha256: await sha('page:' + quoteRaw),
        prefix: '', suffix: '', occurrenceIndex: 0,
        rects: [{ x, y: 0.15, width: 0.35, height: 0.05 }],
        pageRotation: 0,
        cropBox: { x: 0, y: 0, width: 612, height: 792 },
        extractorName: 'pdfjs', extractorVersion: '3.11.174', transformVersion: 'essayflow-m4-e2e-v1',
        normalization: 'whitespace-collapse',
        ...(evidenceId ? { evidenceId } : {})
      });
      window.applyEssayflowProjectRevision(projectId, result.revision);
      return result;
    };
    const firstEvidence = await createEvidence('The intervention improved the primary outcome.', 0, 'PDF 第 1 页', 0.1);
    const secondEvidence = await createEvidence('The comparison group showed no measurable improvement.', 0, 'PDF 第 1 页', 0.5);
    await window.refreshEssayflowEvidence();

    const panel = document.getElementById('ai-chat-panel');
    panel.style.display = 'flex';
    document.querySelector('.trusted-ai-tab[data-view="grounded"]').click();
    await waitUntil(() => document.querySelectorAll('#grounded-evidence-list input').length === 2, 'evidence choices');
    document.querySelectorAll('#grounded-evidence-list input').forEach(input => input.click());
    document.getElementById('grounded-question').value = 'Compare the two reported outcomes.';
    document.getElementById('grounded-ask').click();
    await waitUntil(() => {
      const toast = document.getElementById('toast')?.textContent || '';
      if (/有出处回答失败/.test(toast)) throw new Error(toast);
      return document.querySelectorAll('#grounded-results .grounded-segment').length === 3;
    }, 'grounded answer');
    const sourcedButtons = [...document.querySelectorAll('#grounded-results .grounded-source')].map(button => ({ text: button.textContent, quote: button.title }));
    const groundedKinds = [...document.querySelectorAll('#grounded-results .grounded-kind')].map(node => node.textContent);
    const firstGroundedState = await window.electronAPI.loadProjectAIState(projectId);
    const groundedSanitizations = firstGroundedState.groundedAnswers.at(-1)?.sanitizations || [];

    [...document.querySelectorAll('#grounded-evidence-list input')]
      .find(input => input.value === secondEvidence.evidenceRevision.id).click();
    const paraphraseIndex = quill.getText().indexOf('The intervention improved the primary outcome.');
    quill.setSelection(paraphraseIndex, 'The intervention improved the primary outcome.'.length, Quill.sources.SILENT);
    const beforeParaphrase = quill.getText();
    document.getElementById('grounded-paraphrase').click();
    await waitUntil(() => document.querySelector('#review-issues .review-issue'), 'paraphrase Diff');
    const paraphraseIssue = document.querySelector('#review-issues .review-issue');
    const paraphraseUnchanged = quill.getText() === beforeParaphrase;
    const paraphraseSourceVisible = paraphraseIssue.textContent.includes('M4 Evidence Fixture') && paraphraseIssue.textContent.includes('PDF 第 1 页');
    paraphraseIssue.querySelector('button.primary').click();
    await waitUntil(() => quill.getText().includes('The primary outcome improved following the intervention.'), 'paraphrase acceptance');
    const paraphraseAccepted = !quill.getText().includes('The intervention improved the primary outcome.');
    document.querySelector('.trusted-ai-tab[data-view="grounded"]').click();
    await waitUntil(() => document.querySelectorAll('#grounded-evidence-list input').length === 2, 'evidence choices after paraphrase');

    await createEvidence('The intervention improved the primary outcome after re-anchoring.', 0, 'PDF 第 1 页', 0.12, firstEvidence.card.id);
    document.querySelector('.trusted-ai-tab[data-view="grounded"]').click();
    await waitUntil(() => document.querySelectorAll('#grounded-evidence-list input').length === 2, 'evidence choices after re-anchor');
    document.querySelectorAll('#grounded-evidence-list input').forEach(input => { if (!input.checked) input.click(); });

    document.getElementById('grounded-question').value = 'Ask about an unavailable population.';
    document.getElementById('grounded-ask').click();
    await waitUntil(() => document.querySelector('#grounded-results .segment-insufficient'), 'insufficient answer');
    const insufficientSourceCount = document.querySelectorAll('#grounded-results .grounded-source').length;

    document.getElementById('grounded-question').value = 'Return malicious E99.';
    await waitUntil(() => !document.getElementById('grounded-ask').disabled, 'grounded ask re-enabled');
    document.getElementById('grounded-ask').click();
    await waitUntil(() => {
      const toast = document.getElementById('toast')?.textContent || '';
      if (/有出处回答失败/.test(toast)) throw new Error(toast);
      return document.querySelector('#grounded-results .status-invalid');
    }, 'invalid E99 answer');
    const e99SourceCount = document.querySelectorAll('#grounded-results .grounded-source').length;

    document.querySelector('.trusted-ai-tab[data-view="review"]').click();
    const reviewIndex = quill.getText().indexOf('Fixture sentence for review.');
    quill.setSelection(reviewIndex, 'Fixture sentence for review.'.length, Quill.sources.SILENT);
    const reviewSelection = await window.prepareEssayflowReviewSelection();
    const reviewAggregate = await window.electronAPI.loadProject(projectId);
    const anchorMarkup = 'data-essayflow-anchor="' + reviewSelection.documentAnchorId + '"';
    if (!quill.root.innerHTML.includes(anchorMarkup) || !reviewAggregate.content.includes(anchorMarkup)) {
      throw new Error('review anchor persistence failed: editor=' + quill.root.innerHTML + '; repository=' + reviewAggregate.content);
    }
    const beforeReviewHtml = quill.root.innerHTML;
    document.getElementById('review-generate').click();
    await waitUntil(() => {
      const toast = document.getElementById('toast')?.textContent || '';
      if (/AI 审阅失败/.test(toast)) throw new Error(toast);
      return document.querySelectorAll('#review-issues .review-issue').length === 2;
    }, 'review issues');
    const unchangedBeforeDecision = quill.root.innerHTML === beforeReviewHtml || quill.root.textContent.includes('Fixture sentence for review.');
    const initialIssueIds = [...document.querySelectorAll('#review-issues .review-issue')].map(card => card.dataset.issueId);
    const initialIssueCards = [...document.querySelectorAll('#review-issues .review-issue')];
    initialIssueCards[1].querySelector('button:first-child').click();
    await waitUntil(() => initialIssueCards[1].textContent.includes('已拒绝'), 'review rejection');
    document.getElementById('review-regenerate').click();
    await waitUntil(async () => {
      const ai = await window.electronAPI.loadProjectAIState(projectId);
      const renderedIds = [...document.querySelectorAll('#review-issues .review-issue')].map(card => card.dataset.issueId);
      return ai.auditEvents.some(event => event.eventType === 'ai-regenerated') && renderedIds.length === 2 &&
        renderedIds.every(id => id && !initialIssueIds.includes(id));
    }, 'review regeneration audit');
    document.getElementById('review-accept-all').click();
    await waitUntil(() => quill.getText().includes('Revised fixture sentence for assessment.'), 'batch review acceptance');
    const acceptedText = quill.getText();
    const versions = await window.electronAPI.listProjectVersions(projectId);
    if (!versions.length) throw new Error('AI acceptance did not create a checkpoint');
    const current = await window.electronAPI.loadProject(projectId);
    const restored = await window.electronAPI.restoreProjectVersion({ projectId, versionId: versions[0].id, baseRevision: current.revision });
    await loadProject(projectId);
    const restoredText = quill.getText();

    document.querySelector('.trusted-ai-tab[data-view="chat"]').click();
    queueChatAttachment({ type: 'file', name: 'fixture-note.txt', size: '42 B', content: 'Synthetic attachment excerpt for M4.' });
    const retention = document.querySelector('.chat-attachment-retention');
    retention.value = 'retain-excerpt';
    retention.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('ai-chat-input').value = 'Remember this project attachment.';
    document.getElementById('ai-chat-send').click();
    await waitUntil(async () => {
      const ai = await window.electronAPI.loadProjectAIState(projectId);
      return ai.threads.some(thread => thread.messages.some(message => message.content.includes('Chat persisted')));
    }, 'chat persistence');
    await waitUntil(async () => {
      const context = window.getEssayflowProjectContext();
      const durable = await window.electronAPI.loadProject(projectId);
      return !document.getElementById('ai-chat-send').disabled && context.revision === durable.revision;
    }, 'chat durable renderer acknowledgment');
    const chatState = await window.electronAPI.loadProjectAIState(projectId);
    const retainedMode = chatState.threads.flatMap(thread => thread.messages).flatMap(message => message.attachments || [])[0]?.retentionMode;

    document.querySelector('.trusted-ai-tab[data-view="audit"]').click();
    await waitUntil(() => document.querySelectorAll('#audit-events .audit-event').length > 5, 'audit view');
    const auditRows = document.querySelectorAll('#audit-events .audit-event').length;

    const privacyContext = window.getEssayflowProjectContext();
    const privacyAggregate = await window.electronAPI.loadProject(projectId);
    if (privacyContext.revision !== privacyAggregate.revision) {
      throw new Error('privacy revision drift before mode change: renderer=' + privacyContext.revision + '; repository=' + privacyAggregate.revision);
    }
    await window.setEssayflowPrivacyMode('local-only');
    settingsResult = await window.electronAPI.updateExportableSettings({ providerId: 'm4-remote-fixture', providerOrigin: 'https://provider.example', model: 'remote-model' });
    window.essayflowDataState.settings = settingsResult.settings;
    await window.electronAPI.setProviderCredential({ providerId: 'm4-remote-fixture', value: 'm4-remote-secret-canary' });
    const localOnlyBefore = ${mock.requests.length};
    const evidence = await window.electronAPI.listEvidence(projectId);
    let aggregate = await window.electronAPI.loadProject(projectId);
    const blocked = await window.electronAPI.askGroundedAI({
      projectId, baseRevision: aggregate.revision, question: 'Blocked grounded question',
      evidenceRevisionIds: evidence.items.map(value => value.revision.id), requestId: crypto.randomUUID(), confirmed: true
    });
    if (!blocked.blocked) throw new Error('local-only did not block remote AI');
    aggregate = await window.electronAPI.loadProject(projectId);
    const scholarly = await window.electronAPI.scholarlyRequest({
      projectId, requestId: crypto.randomUUID(), url: 'https://api.crossref.org/works?query=blocked',
      method: 'GET', headers: {}, body: null, sourceId: 'crossref', operation: 'literature-metadata', confirmed: true
    });
    if (!scholarly.blocked) throw new Error('local-only did not block scholarly request');
    let pdfBlocked = false;
    try { await window.electronAPI.downloadPdf(${JSON.stringify(`${mock.origin}/paper.pdf`)}, 'blocked.pdf', projectId, true); }
    catch (error) { pdfBlocked = /local-only/.test(error.message); }
    aggregate = await window.electronAPI.loadProject(projectId);
    const archived = await window.electronAPI.archiveEvidence({
      projectId,
      baseRevision: aggregate.revision,
      evidenceId: secondEvidence.card.id,
      confirmed: true
    });
    window.applyEssayflowProjectRevision(projectId, archived.revision);
    document.querySelector('.trusted-ai-tab[data-view="grounded"]').click();
    await waitUntil(() => {
      const states = [...document.querySelectorAll('#grounded-history [data-historical-source-state]')].map(node => node.dataset.historicalSourceState);
      return states.includes('来源后来已变更') && states.includes('来源后来已归档');
    }, 'historical evidence states');
    const historyStates = [...document.querySelectorAll('#grounded-history [data-historical-source-state]')].map(node => node.dataset.historicalSourceState);
    const finalProject = await window.electronAPI.loadProject(projectId);
    const audit = await window.electronAPI.exportProjectAudit({ projectId, includeContent: false });
    const serialized = JSON.stringify({ finalProject, audit, localStorage: { ...localStorage } });
    return {
      projectId,
      sourcedButtons,
      groundedKinds,
      groundedSanitizations,
      paraphraseUnchanged,
      paraphraseSourceVisible,
      paraphraseAccepted,
      insufficientSourceCount,
      e99SourceCount,
      unchangedBeforeDecision,
      acceptedText,
      restoredText,
      restoredRevision: restored.revision,
      retainedMode,
      auditRows,
      localOnlyBefore,
      blockedAuditType: finalProject.aggregate.auditEvents.find(event => event.eventId === blocked.requestEventId)?.eventType,
      scholarlyBlocked: scholarly.blocked,
      pdfBlocked,
      pdfBlockedAudit: finalProject.aggregate.auditEvents.some(event => event.eventType === 'ai-blocked' && event.networkContext?.operation === 'pdf-download'),
      historyStates,
      secretLeakCount: ['m4-e2e-secret-canary', 'm4-remote-secret-canary', 'Bearer '].filter(value => serialized.includes(value)).length
    };
  })()`);
  } catch (error) {
    throw new Error(`${error.message}; mockRequests=${JSON.stringify(mock.requests.map(request => ({ url: request.url, bodySha256: sha(request.body) })))}; rendererExceptions=${JSON.stringify(driver.exceptions)}`, { cause: error });
  }

  assert.equal(first.sourcedButtons.length, 2);
  assert.ok(first.sourcedButtons.every(source => source.text.includes('M4 Evidence Fixture') && source.text.includes('PDF 第 1 页')));
  assert.ok(first.groundedKinds.includes('已关联来源'));
  assert.ok(first.groundedKinds.includes('AI 推断'));
  assert.ok(first.groundedSanitizations.some(entry => entry.code === 'model-review-authority-dropped'));
  assert.equal(first.paraphraseUnchanged, true);
  assert.equal(first.paraphraseSourceVisible, true);
  assert.equal(first.paraphraseAccepted, true);
  assert.equal(first.insufficientSourceCount, 0);
  assert.equal(first.e99SourceCount, 0);
  assert.equal(first.unchangedBeforeDecision, true);
  assert.match(first.acceptedText, /Revised fixture sentence for assessment\./);
  assert.match(first.restoredText, /Fixture sentence for review\./);
  assert.equal(first.retainedMode, 'retain-excerpt');
  assert.ok(first.auditRows > 5);
  assert.equal(first.blockedAuditType, 'ai-blocked');
  assert.equal(first.scholarlyBlocked, true);
  assert.equal(first.pdfBlocked, true);
  assert.equal(first.pdfBlockedAudit, true);
  assert.ok(first.historyStates.includes('来源后来已变更'));
  assert.ok(first.historyStates.includes('来源后来已归档'));
  assert.equal(first.secretLeakCount, 0);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  const screenshotsRoot = path.join(root, 'artifacts', 'screenshots');
  fs.mkdirSync(screenshotsRoot, { recursive: true });
  const screenshotPath = path.join(screenshotsRoot, 'm4-trusted-ai.png');

  const requestCountBeforeRestart = mock.requests.length;
  assert.equal(await driver.close(), 0);
  driver = null;
  driver = await launchElectron(launchOptions);
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && Boolean(document.getElementById("trusted-ai-tabs"))', { timeoutMs: 45_000 });
  const restart = await driver.client.evaluate(String.raw`(async () => {
    await window.essayflowDataReady;
    await loadProject(${JSON.stringify(first.projectId)});
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !aiChatMessages.some(message => message.content.includes('Chat persisted'))) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const ai = await window.electronAPI.loadProjectAIState(${JSON.stringify(first.projectId)});
    return {
      privacyMode: window.getEssayflowProjectContext().privacyMode,
      chatRestored: aiChatMessages.some(message => message.content.includes('Chat persisted')),
      retainedModes: ai.threads.flatMap(thread => thread.messages).flatMap(message => message.attachments || []).map(value => value.retentionMode),
      auditSequences: ai.auditEvents.map(event => event.sequence).sort((a, b) => a - b)
    };
  })()`);
  assert.equal(restart.privacyMode, 'local-only');
  assert.equal(restart.chatRestored, true);
  assert.ok(restart.retainedModes.includes('retain-excerpt'));
  assert.deepEqual(restart.auditSequences, Array.from({ length: restart.auditSequences.length }, (_, index) => index + 1));
  assert.equal(mock.requests.length, requestCountBeforeRestart);
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  await driver.client.evaluate(`(() => {
    const panel = document.getElementById('ai-chat-panel');
    if (panel) panel.style.display = 'flex';
    document.querySelector('.trusted-ai-tab[data-view="audit"]')?.click();
    return true;
  })()`);
  const screenshot = await driver.client.evaluate(`window.electronAPI.captureAutomationScreenshot()`);
  const screenshotBytes = Buffer.from(screenshot.base64, 'base64');
  assert.equal(screenshot.byteCount, screenshotBytes.length);
  assert.ok(screenshotBytes.length > 1000, 'M4 screenshot must contain rendered UI pixels');
  assert.equal(screenshotBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fs.writeFileSync(screenshotPath, screenshotBytes);

  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    milestone: 'm4',
    scenario: 'grounded answer, invalid token, review Diff, audit, attachment retention and local-only',
    fixtureData: 'synthetic',
    passed: true,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    mockTransport: {
      requestCount: mock.requests.length,
      authorizationPresentCount: mock.requests.filter(request => request.authorizationPresent).length,
      payloadSha256: mock.requests.map(request => sha(request.body))
    },
    first,
    restart,
    screenshot: path.relative(root, screenshotPath).split(path.sep).join('/')
  };
  const reportPath = path.join(root, 'artifacts', 'e2e', 'm4', 'report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});
