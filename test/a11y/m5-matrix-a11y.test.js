'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

test('M5 matrix modal has zero axe critical/serious issues, traps focus and survives 100/125/150% scaling', { timeout: 180_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m5-a11y-'));
  let driver = await launchElectron({
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath: path.join(profileRoot, 'profile-report.json')
  });
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && Boolean(document.getElementById("review-matrix-modal"))', { timeoutMs: 45_000 });
  driver.client.timeoutMs = 120_000;

  const seeded = await driver.client.evaluate(`(async () => {
    await window.essayflowDataReady;
    const library = await window.electronAPI.loadLibraryStore();
    const replaced = await window.electronAPI.replaceLibraryStore({ baseRevision: library.revision, items: [{
      id: 'm5-a11y-paper', type: 'article-journal',
      title: '最长中英文混排标题：A deterministic accessibility fixture with a deliberately long title for focus and overflow verification',
      author: [{ family: '无障碍', given: '测试' }], issued: { 'date-parts': [[2026]] }, DOI: '10.5555/m5.a11y',
      abstract: '用于无障碍测试的合成摘要。', metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } }
    }] });
    const projectId = crypto.randomUUID();
    const created = await window.electronAPI.saveProjectAuto({
      projectId, baseRevision: -1, content: '<h1>M5 无障碍</h1><p>合成正文</p>',
      meta: { title: 'M5 无障碍', referenceStyle: 'APA', privacyMode: 'local-only' }, citations: [], source: 'm5-a11y-create'
    });
    await loadProject(projectId);
    const state = await window.electronAPI.updateProjectPaperState({
      projectId, baseRevision: created.revision, libraryItemId: replaced.items[0].libraryItemId,
      screeningStatus: 'included', readingStatus: 'to-read', projectNotes: ''
    });
    window.applyEssayflowProjectRevision(projectId, state.revision);
    const matrix = await window.electronAPI.createReviewMatrix({
      projectId, baseRevision: state.revision, name: '最长矩阵名称：系统综述证据提取与可访问性验证', citationItemIds: [state.state.citationItemId]
    });
    window.applyEssayflowProjectRevision(projectId, matrix.revision);
    const added = await window.electronAPI.addReviewMatrixColumn({
      projectId, baseRevision: matrix.revision, matrixId: matrix.matrix.id,
      label: '最长自定义列：干预机制、样本异质性、偏倚风险以及与当前研究问题之间的关系'
    });
    window.applyEssayflowProjectRevision(projectId, added.revision);
    document.body.classList.add('dark');
    document.getElementById('btn-library').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    document.getElementById('review-matrix-open').click();
    await new Promise(resolve => setTimeout(resolve, 90));
    const matrixContentStyle = getComputedStyle(document.querySelector('.review-matrix-content'));
    const matrixMotionDuration = Math.max(0, ...matrixContentStyle.transitionDuration.split(',')
      .map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && document.querySelectorAll('#review-matrix-table-shell tbody tr').length !== 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const enhancedSelects = [...document.querySelectorAll('.review-matrix-toolbar .ef-select')];
    const sortControl = document.querySelector('.review-matrix-toolbar .ef-select[data-select-id="review-matrix-sort"]');
    sortControl?.querySelector('.ef-select-trigger')?.click();
    await new Promise(resolve => setTimeout(resolve, 340));
    const menuStyle = getComputedStyle(sortControl?.querySelector('.ef-select-menu'));
    const selectMenuMotionDuration = Math.max(0, ...menuStyle.transitionDuration.split(',')
      .map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)));
    let highlightedOptionBackground = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const highlightedOption = sortControl?.querySelectorAll('.ef-select-option')?.[1]
        || sortControl?.querySelector('.ef-select-option');
      highlightedOption?.dispatchEvent(new PointerEvent('pointerenter'));
      highlightedOption?.focus({ preventScroll: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all((highlightedOption?.getAnimations() || []).map(animation => animation.finished.catch(() => {})));
      if (highlightedOption?.isConnected) {
        highlightedOptionBackground = getComputedStyle(highlightedOption).backgroundColor;
        if (highlightedOptionBackground === 'rgb(230, 180, 34)') break;
      }
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    sortControl?.querySelector('.ef-select-trigger')?.click();
    await new Promise(resolve => setTimeout(resolve, 340));
    return {
      projectId,
      matrixId: matrix.matrix.id,
      rows: document.querySelectorAll('#review-matrix-table-shell tbody tr').length,
      matrixMotionDuration,
      enhancedSelectCount: enhancedSelects.length,
      selectMenuMotionDuration,
      highlightedOptionBackground
    };
  })()`);
  assert.equal(seeded.rows, 1);
  assert.ok(seeded.matrixMotionDuration >= 400, JSON.stringify(seeded));
  assert.equal(seeded.enhancedSelectCount, 2, JSON.stringify(seeded));
  assert.ok(seeded.selectMenuMotionDuration >= 280, JSON.stringify(seeded));
  assert.equal(seeded.highlightedOptionBackground, 'rgb(230, 180, 34)', JSON.stringify(seeded));

  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await driver.client.evaluate(`${axeSource}\n;Boolean(globalThis.axe && globalThis.axe.run)`);
  const screenshotsRoot = path.join(root, 'artifacts', 'a11y');
  fs.mkdirSync(screenshotsRoot, { recursive: true });
  const scaleResults = [];
  for (const scale of [1, 1.25, 1.5]) {
    await driver.client.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(1500 / scale),
      height: Math.round(900 / scale),
      deviceScaleFactor: scale,
      mobile: false
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const result = await driver.client.evaluate(`(async () => {
      const modal = document.getElementById('review-matrix-modal');
      const axeResult = await axe.run(modal, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        resultTypes: ['violations', 'incomplete']
      });
      const serious = axeResult.violations.filter(item => item.impact === 'critical' || item.impact === 'serious');
      const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      const visibleControls = [...modal.querySelectorAll('button, input, select, textarea, [tabindex]')]
        .filter(element => element.getClientRects().length > 0
          && getComputedStyle(element).visibility !== 'hidden'
          && !element.closest('[aria-hidden="true"]'));
      const escaped = visibleControls.filter(element => {
        if (element.closest('.review-matrix-table-shell')) return false;
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.top < -1 || rect.right > viewport.width + 1 || rect.bottom > viewport.height + 1;
      }).map(element => ({ tag: element.tagName, id: element.id, aria: element.getAttribute('aria-label') }));
      const shellStyle = getComputedStyle(document.getElementById('review-matrix-table-shell'));
      const toolbarButtonStyle = getComputedStyle(document.getElementById('review-matrix-create'));
      return {
        viewport,
        darkMode: document.body.classList.contains('dark'),
        tableShellBackground: shellStyle.backgroundColor,
        toolbarButtonRadius: parseFloat(toolbarButtonStyle.borderRadius),
        serious,
        allViolations: axeResult.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target) })),
        incompleteCount: axeResult.incomplete.length,
        escaped
      };
    })()`);
    assert.equal(result.serious.length, 0, JSON.stringify(result.serious, null, 2));
    assert.equal(result.escaped.length, 0, JSON.stringify(result.escaped, null, 2));
    assert.equal(result.darkMode, true);
    assert.notEqual(result.tableShellBackground, 'rgb(255, 255, 255)', JSON.stringify(result));
    assert.ok(result.toolbarButtonRadius >= 8, JSON.stringify(result));
    const screenshot = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
    const bytes = Buffer.from(screenshot.base64, 'base64');
    assert.ok(bytes.length > 1000);
    const screenshotPath = path.join(screenshotsRoot, `m5-matrix-${Math.round(scale * 100)}.png`);
    fs.writeFileSync(screenshotPath, bytes);
    scaleResults.push({ scalePercent: Math.round(scale * 100), ...result, screenshot: path.relative(root, screenshotPath).split(path.sep).join('/') });
  }

  await driver.client.send('Page.bringToFront');
  await driver.client.send('Emulation.clearDeviceMetricsOverride');
  await driver.client.evaluate('window.focus(); true');
  await driver.client.evaluate("document.getElementById('review-matrix-open').click(); true");
  await waitForRenderer(driver, "document.getElementById('review-matrix-modal').getAttribute('aria-hidden') === 'false' && document.getElementById('review-matrix-modal').classList.contains('open') && document.querySelectorAll('#review-matrix-table-shell tbody tr').length === 1", { timeoutMs: 30_000 });
  await new Promise(resolve => setTimeout(resolve, 460));
  const keyboard = await driver.client.evaluate(`(() => {
    const modal = document.getElementById('review-matrix-modal');
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    first.dataset.a11yBoundary = 'first';
    last.dataset.a11yBoundary = 'last';
    last.focus({ preventScroll: true });
    const beforeForward = document.activeElement === last;
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const wrappedForward = document.activeElement === first && modal.dataset.focusTrapDirection === 'forward';
    first.focus({ preventScroll: true });
    const beforeBackward = document.activeElement === first;
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    const wrappedBackward = document.activeElement === last && modal.dataset.focusTrapDirection === 'backward';
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const closeMotionDuration = Math.max(0, ...modal.querySelector('.review-matrix-content').getAnimations()
      .map(animation => Number(animation.effect.getTiming().duration) || 0));
    return {
      count: focusable.length,
      beforeForward,
      beforeBackward,
      wrappedForward,
      wrappedBackward,
      closed: modal.getAttribute('aria-hidden') === 'true',
      closeMotionDuration,
      focusHeldDuringExit: document.activeElement !== document.getElementById('review-matrix-open'),
      namedControls: focusable.every(element => {
        const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.labels?.[0]?.textContent;
        return Boolean(String(label || '').trim());
      })
    };
  })()`);
  assert.ok(keyboard.count > 10);
  assert.equal(keyboard.beforeForward, true, JSON.stringify(keyboard));
  assert.equal(keyboard.beforeBackward, true, JSON.stringify(keyboard));
  assert.ok(keyboard.closeMotionDuration >= 400, JSON.stringify(keyboard));
  await new Promise(resolve => setTimeout(resolve, 460));
  const closeSettled = await driver.client.evaluate(`(() => ({
    hidden: document.getElementById('review-matrix-modal').style.display === 'none',
    returnedFocus: document.activeElement === document.getElementById('review-matrix-open')
  }))()`);
  assert.deepEqual(closeSettled, { hidden: true, returnedFocus: true });
  assert.deepEqual(keyboard, {
    wrappedForward: true,
    wrappedBackward: true,
    closed: true,
    closeMotionDuration: keyboard.closeMotionDuration,
    focusHeldDuringExit: true,
    namedControls: true,
    count: keyboard.count,
    beforeForward: true,
    beforeBackward: true
  });
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    suite: 'a11y',
    scope: 'M5 review matrix modal',
    engine: { name: 'axe-core', version: require('axe-core/package.json').version },
    passed: true,
    axeCriticalSerious: 0,
    overflowOverlapDetectorFailures: 0,
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    keyboard,
    scales: scaleResults
  };
  const reportPath = path.join(screenshotsRoot, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
});
