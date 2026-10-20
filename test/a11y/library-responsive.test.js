'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

test('library search stays usable as the resizable panel narrows and exposes filters as removable tags', { timeout: 180_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-library-responsive-'));
  let driver = await launchElectron({
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath: path.join(profileRoot, 'profile-report.json')
  });
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });
  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled() && typeof loadLibrary === "function"', { timeoutMs: 45_000 });
  driver.client.timeoutMs = 120_000;
  const seeded = await driver.client.evaluate(`(async () => {
    await window.essayflowDataReady;
    const library = await window.electronAPI.loadLibraryStore();
    await window.electronAPI.replaceLibraryStore({ baseRevision: library.revision, items: [
      { id: 'responsive-1', type: 'article-journal', title: '窄窗口中的系统综述检索', author: [{ family: '林', given: '舟' }], issued: { 'date-parts': [[2026]] }, DOI: '10.5555/responsive.1', tags: ['方法学'], starred: true, metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } } },
      { id: 'responsive-2', type: 'book', title: 'Responsive library controls', author: [{ family: 'Stone', given: 'Mira' }], issued: { 'date-parts': [[2024]] }, DOI: '10.5555/responsive.2', tags: ['design'], metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } } },
      { id: 'responsive-3', type: 'paper-conference', title: '可调整面板与筛选标签', author: [{ family: '周', given: '临' }], issued: { 'date-parts': [[2023]] }, DOI: '10.5555/responsive.3', metadataProvenance: { source: 'manual', originalFormat: 'manual', fields: { title: 'manual' } } }
    ] });
    await loadLibrary();
    document.getElementById('btn-library').click();
    const controlsInitiallyHidden = document.getElementById('library-controls').hidden;
    const searchWrapper = document.querySelector('.search-toggle-wrapper');
    searchWrapper.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    const compactOpenedOnHover = document.getElementById('search-expand-area').classList.contains('open');
    document.getElementById('search-toggle-btn').click();
    const detailDeadline = Date.now() + 3000;
    while (Date.now() < detailDeadline && document.getElementById('library-controls').hidden) await new Promise(resolve => setTimeout(resolve, 20));
    const detailedOpenedOnClick = !document.getElementById('library-controls').hidden;
    const compactClosedOnClick = !document.getElementById('search-expand-area').classList.contains('open');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && document.querySelectorAll('#library-results .paper-card').length !== 3) await new Promise(resolve => setTimeout(resolve, 50));
    document.body.classList.add('dark');
    return {
      paperCount: document.querySelectorAll('#library-results .paper-card').length,
      controlsInitiallyHidden,
      compactOpenedOnHover,
      detailedOpenedOnClick,
      compactClosedOnClick
    };
  })()`);
  assert.deepEqual(seeded, {
    paperCount: 3,
    controlsInitiallyHidden: true,
    compactOpenedOnHover: true,
    detailedOpenedOnClick: true,
    compactClosedOnClick: true
  });

  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await driver.client.evaluate(`${axeSource}\n;Boolean(globalThis.axe && globalThis.axe.run)`);
  const screenshotsRoot = path.join(root, 'artifacts', 'a11y');
  fs.mkdirSync(screenshotsRoot, { recursive: true });
  const widths = [];
  for (const panelWidth of [480, 360, 280]) {
    const result = await driver.client.evaluate(`(async () => {
      const panel = document.getElementById('search-panel');
      panel.style.flex = '0 0 ${panelWidth}px';
      await new Promise(resolve => setTimeout(resolve, 460));
      const filterToggle = document.getElementById('library-filter-toggle');
      let filterAnimationDuration = 0;
      let actionMotion = null;
      if (filterToggle.getAttribute('aria-expanded') !== 'true') {
        const actionBar = document.querySelector('.library-action-bar');
        const start = actionBar.getBoundingClientRect().top;
        filterToggle.click();
        const filterAnimations = document.getElementById('library-filter-panel').getAnimations();
        const filterAnimation = filterAnimations.at(-1);
        filterAnimationDuration = Math.max(0, ...filterAnimations.map(animation => Number(animation.effect.getTiming().duration) || 0));
        let middle;
        let end;
        if (filterAnimation && filterAnimationDuration > 0) {
          filterAnimation.pause();
          filterAnimation.currentTime = filterAnimationDuration / 2;
          await new Promise(resolve => requestAnimationFrame(resolve));
          middle = actionBar.getBoundingClientRect().top;
          filterAnimation.finish();
          await filterAnimation.finished.catch(() => {});
          await new Promise(resolve => requestAnimationFrame(resolve));
          end = actionBar.getBoundingClientRect().top;
        } else {
          await new Promise(resolve => setTimeout(resolve, 140));
          middle = actionBar.getBoundingClientRect().top;
          await new Promise(resolve => setTimeout(resolve, 220));
          end = actionBar.getBoundingClientRect().top;
        }
        actionMotion = { start: Math.round(start), middle: Math.round(middle), end: Math.round(end) };
      }
      const year = document.getElementById('library-year-filter');
      year.value = '2026'; year.dispatchEvent(new Event('change', { bubbles: true }));
      const starred = document.getElementById('library-starred-filter');
      starred.value = 'yes'; starred.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 340));
      const controls = document.getElementById('library-controls');
      const bounds = controls.getBoundingClientRect();
      const visible = [...controls.querySelectorAll('button, input, select')].filter(element => element.getClientRects().length > 0);
      const escaped = visible.filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      }).map(element => element.id || element.getAttribute('aria-label') || element.textContent.trim());
      const header = document.getElementById('search-header');
      const headerBounds = header.getBoundingClientRect();
      const headerActionsBounds = document.getElementById('library-header-actions').getBoundingClientRect();
      const headerEscaped = [...header.querySelectorAll('button, select')].filter(element => element.getClientRects().length > 0).filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left < headerBounds.left - 1 || rect.right > headerBounds.right + 1;
      }).map(element => element.id || element.getAttribute('aria-label') || element.textContent.trim());
      const axeResult = await axe.run(controls, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      const query = document.getElementById('library-query');
      query.blur();
      await new Promise(resolve => setTimeout(resolve, 220));
      const field = query.closest('.library-search-field');
      const idleFieldBackground = getComputedStyle(field).backgroundColor;
      let customSelect = null;
      if (${panelWidth} === 480) {
        const exportControl = document.querySelector('.ef-select[data-select-id="library-export-format"]');
        exportControl.querySelector('.ef-select-trigger').click();
        await new Promise(resolve => setTimeout(resolve, 60));
        const focusedOption = exportControl.querySelectorAll('.ef-select-option')[1];
        focusedOption.dispatchEvent(new PointerEvent('pointerenter'));
        focusedOption.focus({ preventScroll: true });
        await new Promise(resolve => setTimeout(resolve, 260));
        const menuStyle = getComputedStyle(exportControl.querySelector('.ef-select-menu'));
        customSelect = {
          open: exportControl.classList.contains('is-open'),
          focusedBackground: getComputedStyle(focusedOption).backgroundColor,
          menuTransitionMs: Math.max(...menuStyle.transitionDuration.split(',').map(value => parseFloat(value) * 1000)),
          controlCount: document.querySelectorAll('#library-controls .ef-select').length
        };
        focusedOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
      query.focus({ preventScroll: true });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const queryStyle = getComputedStyle(query);
      const fieldStyle = getComputedStyle(field);
      return {
        requestedWidth: ${panelWidth}, actualWidth: Math.round(panel.getBoundingClientRect().width),
        headerLayout: {
          height: Math.round(headerBounds.height),
          flexDirection: getComputedStyle(header).flexDirection,
          actionsBottom: Math.round(headerActionsBounds.bottom),
          controlsTop: Math.round(bounds.top),
          overlapsControls: headerActionsBounds.bottom > bounds.top + 1
        },
        horizontalOverflow: controls.scrollWidth - controls.clientWidth,
        escaped, headerEscaped, chipCount: document.querySelectorAll('#library-active-filters .library-filter-chip').length,
        filterExpanded: filterToggle.getAttribute('aria-expanded'), darkMode: document.body.classList.contains('dark'),
        filterAnimationDuration, actionMotion, idleFieldBackground, customSelect,
        queryFocused: document.activeElement === query,
        fieldClassName: field.className,
        fieldMatchesFocusWithin: field.matches(':focus-within'),
        queryOutlineStyle: queryStyle.outlineStyle, queryBoxShadow: queryStyle.boxShadow,
        fieldFocusShadow: fieldStyle.boxShadow, fieldFocusBorderColor: fieldStyle.borderColor,
        serious: axeResult.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({
          id: item.id, nodes: item.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary }))
        }))
      };
    })()`);
    assert.ok(result.actualWidth >= 279, JSON.stringify(result));
    assert.ok(result.horizontalOverflow <= 1, JSON.stringify(result));
    assert.deepEqual(result.escaped, [], JSON.stringify(result));
    assert.deepEqual(result.headerEscaped, [], JSON.stringify(result));
    assert.equal(result.headerLayout.overlapsControls, false, JSON.stringify(result));
    assert.equal(result.chipCount, 2, JSON.stringify(result));
    assert.equal(result.filterExpanded, 'true');
    if (panelWidth === 480) {
      assert.ok(result.filterAnimationDuration >= 300, JSON.stringify(result));
      assert.ok(result.actionMotion.start < result.actionMotion.middle && result.actionMotion.middle < result.actionMotion.end, JSON.stringify(result));
      assert.equal(result.customSelect.open, true, JSON.stringify(result));
      assert.equal(result.customSelect.focusedBackground, 'rgb(230, 180, 34)', JSON.stringify(result));
      assert.ok(result.customSelect.menuTransitionMs >= 280, JSON.stringify(result));
      assert.equal(result.customSelect.controlCount, 12, JSON.stringify(result));
    }
    assert.equal(result.idleFieldBackground, 'rgba(0, 0, 0, 0)', JSON.stringify(result));
    assert.equal(result.darkMode, true);
    assert.equal(result.queryFocused, true, JSON.stringify(result));
    assert.equal(result.queryOutlineStyle, 'none', JSON.stringify(result));
    assert.equal(result.queryBoxShadow, 'none', JSON.stringify(result));
    assert.equal(result.fieldFocusShadow, 'none', JSON.stringify(result));
    assert.equal(result.fieldFocusBorderColor, 'rgba(0, 0, 0, 0)', JSON.stringify(result));
    assert.deepEqual(result.serious, [], JSON.stringify(result));
    const screenshot = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
    const screenshotPath = path.join(screenshotsRoot, `library-panel-${panelWidth}.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.base64, 'base64'));
    widths.push({ ...result, screenshot: path.relative(root, screenshotPath).split(path.sep).join('/') });
  }

  const customSelectPreview = await driver.client.evaluate(`(async () => {
    const panel = document.getElementById('search-panel');
    panel.style.flex = '0 0 480px';
    document.body.classList.remove('dark');
    await new Promise(resolve => setTimeout(resolve, 180));
    const control = document.querySelector('.ef-select[data-select-id="library-export-format"]');
    control.querySelector('.ef-select-trigger').click();
    await new Promise(resolve => setTimeout(resolve, 340));
    const option = control.querySelectorAll('.ef-select-option')[1];
    option.dispatchEvent(new PointerEvent('pointerenter'));
    option.focus({ preventScroll: true });
    await new Promise(resolve => setTimeout(resolve, 140));
    return {
      open: control.classList.contains('is-open'),
      activeLabel: option.textContent,
      activeBackground: getComputedStyle(option).backgroundColor
    };
  })()`);
  assert.deepEqual(customSelectPreview, { open: true, activeLabel: 'BibTeX', activeBackground: 'rgb(230, 180, 34)' });
  const customSelectCapture = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
  const customSelectScreenshotPath = path.join(screenshotsRoot, 'library-custom-select-gold.png');
  fs.writeFileSync(customSelectScreenshotPath, Buffer.from(customSelectCapture.base64, 'base64'));
  customSelectPreview.screenshot = path.relative(root, customSelectScreenshotPath).split(path.sep).join('/');
  await driver.client.evaluate(`(async () => {
    const active = document.activeElement;
    active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.body.classList.add('dark');
    document.getElementById('search-panel').style.flex = '0 0 280px';
    await new Promise(resolve => setTimeout(resolve, 180));
  })()`);

  const interaction = await driver.client.evaluate(`(async () => {
    const firstChip = document.querySelector('#library-active-filters .library-filter-chip');
    firstChip.click();
    await new Promise(resolve => setTimeout(resolve, 250));
    const batchToggle = document.getElementById('library-batch-toggle');
    batchToggle.click();
    const batchPanel = document.getElementById('library-batch-panel');
    const batchAnimationDuration = Math.max(0, ...batchPanel.getAnimations().map(animation => Number(animation.effect.getTiming().duration) || 0));
    await new Promise(resolve => setTimeout(resolve, 340));
    const bounds = document.getElementById('library-controls').getBoundingClientRect();
    const escaped = [...batchPanel.querySelectorAll('button, input, select')].filter(element => element.getClientRects().length > 0).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
    }).map(element => {
      const rect = element.getBoundingClientRect();
      return { id: element.id || element.getAttribute('aria-label') || element.textContent.trim(), left: Math.round(rect.left), right: Math.round(rect.right), boundsLeft: Math.round(bounds.left), boundsRight: Math.round(bounds.right) };
    });
    return { chips: document.querySelectorAll('#library-active-filters .library-filter-chip').length, batchHidden: batchPanel.hidden, escaped, batchAnimationDuration };
  })()`);
  assert.deepEqual(interaction, { chips: 1, batchHidden: false, escaped: [], batchAnimationDuration: 320 });
  const emptyLibrary = await driver.client.evaluate(`(async () => {
    const current = await window.electronAPI.loadLibraryStore();
    await window.electronAPI.replaceLibraryStore({ baseRevision: current.revision, items: [] });
    await loadLibrary();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && document.querySelector('#library-results .search-status-hint')?.textContent !== '暂无论文，请从“发现”或标准引用文件导入') await new Promise(resolve => setTimeout(resolve, 30));
    const hint = document.querySelector('#library-results .search-status-hint');
    return { text: hint?.textContent || '', color: hint ? getComputedStyle(hint).color : '', bodyColor: getComputedStyle(document.body).color };
  })()`);
  assert.equal(emptyLibrary.text, '暂无论文，请从“发现”或标准引用文件导入');
  assert.notEqual(emptyLibrary.color, emptyLibrary.bodyColor, JSON.stringify(emptyLibrary));
  assert.match(emptyLibrary.color, /^rgb\(13[0-9], 13[0-9], 14[0-9]\)$/, JSON.stringify(emptyLibrary));
  const evidenceSearch = await driver.client.evaluate(`(async () => {
    document.getElementById('btn-evidence').click();
    const controls = document.getElementById('evidence-controls');
    const initiallyHidden = controls.hidden;
    const wrapper = document.querySelector('.search-toggle-wrapper');
    wrapper.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    const compactOpenedOnHover = document.getElementById('search-expand-area').classList.contains('open');
    document.getElementById('search-toggle-btn').click();
    await new Promise(resolve => setTimeout(resolve, 240));
    return {
      initiallyHidden,
      compactOpenedOnHover,
      detailedOpenedOnClick: !controls.hidden && controls.classList.contains('detail-search-open'),
      compactClosedOnClick: !document.getElementById('search-expand-area').classList.contains('open'),
      activeElement: document.activeElement.id,
      ariaExpanded: document.getElementById('search-toggle-btn').getAttribute('aria-expanded')
    };
  })()`);
  assert.deepEqual(evidenceSearch, {
    initiallyHidden: true,
    compactOpenedOnHover: true,
    detailedOpenedOnClick: true,
    compactClosedOnClick: true,
    activeElement: 'evidence-query',
    ariaExpanded: 'true'
  });
  const collapsePreview = await driver.client.evaluate(`(async () => {
    const panel = document.getElementById('search-panel');
    const workspace = document.getElementById('workspace');
    const resizer = document.getElementById('resizer');
    const toggle = document.getElementById('search-panel-toggle');
    const pairWidth = workspace.getBoundingClientRect().width + panel.getBoundingClientRect().width;
    panel.style.flex = '0 0 360px';
    workspace.style.flex = '0 0 ' + Math.max(300, pairWidth - 360) + 'px';
    await new Promise(resolve => setTimeout(resolve, 460));
    const dragBy = async delta => {
      const dragX = resizer.getBoundingClientRect().left + 1;
      resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: dragX, buttons: 1 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: dragX + delta, buttons: 1 }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const duringDragWidth = panel.getBoundingClientRect().width;
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: dragX + delta }));
      await new Promise(resolve => setTimeout(resolve, 460));
      return { duringDragWidth, settledWidth: panel.getBoundingClientRect().width };
    };
    const partiallyDragged = await dragBy(30);
    const restoredDrag = await dragBy(-30);
    const before = {
      panelWidth: panel.getBoundingClientRect().width,
      workspaceWidth: workspace.getBoundingClientRect().width
    };
    const edgeX = resizer.getBoundingClientRect().left + 1;
    resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: edgeX, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: edgeX + 100, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: edgeX + 100 }));
    await new Promise(resolve => setTimeout(resolve, 460));
    const railBounds = resizer.getBoundingClientRect();
    const targetPointerY = railBounds.top + railBounds.height * 0.68;
    resizer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: edgeX, clientY: targetPointerY }));
    toggle.focus({ preventScroll: true });
    await new Promise(resolve => setTimeout(resolve, 220));
    const saved = JSON.parse(localStorage.getItem('essay_horizontal_flex') || '{}');
    const toggleBounds = toggle.getBoundingClientRect();
    return {
      before,
      partiallyDraggedWidth: partiallyDragged.duringDragWidth,
      partiallyDraggedSettledWidth: partiallyDragged.settledWidth,
      restoredDragWidth: restoredDrag.settledWidth,
      collapsed: panel.classList.contains('is-collapsed'),
      panelWidth: panel.getBoundingClientRect().width,
      workspaceWidth: workspace.getBoundingClientRect().width,
      panelAriaHidden: panel.getAttribute('aria-hidden'),
      panelInert: panel.inert,
      railClass: resizer.classList.contains('search-panel-collapsed'),
      toggleLabel: toggle.getAttribute('aria-label'),
      toggleExpanded: toggle.getAttribute('aria-expanded'),
      toggleOpacity: getComputedStyle(toggle).opacity,
      toggleVisibleText: toggle.textContent.trim(),
      railPointerY: Number.parseFloat(getComputedStyle(resizer).getPropertyValue('--rail-pointer-y')),
      expectedPointerY: targetPointerY - railBounds.top,
      toggleCenterY: toggleBounds.top + toggleBounds.height / 2 - railBounds.top,
      toggleBorderStyle: getComputedStyle(toggle).borderStyle,
      toggleBackground: getComputedStyle(toggle).backgroundColor,
      highlightOpacity: getComputedStyle(resizer, '::after').opacity,
      railActive: resizer.classList.contains('is-rail-active'),
      persistedCollapsed: saved.collapsed,
      persistedExpandedRight: saved.expandedRight
    };
  })()`);
  assert.ok(collapsePreview.before.panelWidth >= 350, JSON.stringify(collapsePreview));
  assert.ok(collapsePreview.partiallyDraggedWidth >= 325 && collapsePreview.partiallyDraggedWidth <= 335, JSON.stringify(collapsePreview));
  assert.ok(collapsePreview.partiallyDraggedSettledWidth >= 325 && collapsePreview.partiallyDraggedSettledWidth <= 335, JSON.stringify(collapsePreview));
  assert.ok(collapsePreview.restoredDragWidth >= 350, JSON.stringify(collapsePreview));
  assert.equal(collapsePreview.collapsed, true, JSON.stringify(collapsePreview));
  assert.ok(collapsePreview.panelWidth <= 1, JSON.stringify(collapsePreview));
  assert.ok(collapsePreview.workspaceWidth > collapsePreview.before.workspaceWidth, JSON.stringify(collapsePreview));
  assert.equal(collapsePreview.panelAriaHidden, 'true');
  assert.equal(collapsePreview.panelInert, true);
  assert.equal(collapsePreview.railClass, true);
  assert.equal(collapsePreview.toggleLabel, '展开资料栏');
  assert.equal(collapsePreview.toggleExpanded, 'false');
  assert.equal(collapsePreview.toggleOpacity, '1');
  assert.equal(collapsePreview.toggleVisibleText, '');
  assert.ok(Math.abs(collapsePreview.railPointerY - collapsePreview.expectedPointerY) <= 1, JSON.stringify(collapsePreview));
  assert.ok(Math.abs(collapsePreview.toggleCenterY - collapsePreview.expectedPointerY) <= 1, JSON.stringify(collapsePreview));
  assert.equal(collapsePreview.toggleBorderStyle, 'none');
  assert.equal(collapsePreview.toggleBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(collapsePreview.highlightOpacity, '1');
  assert.equal(collapsePreview.railActive, true);
  assert.equal(collapsePreview.persistedCollapsed, true);
  assert.ok(collapsePreview.persistedExpandedRight >= 350, JSON.stringify(collapsePreview));
  await driver.client.evaluate("document.getElementById('search-panel-toggle').blur(); true");
  const railHoverPoint = await driver.client.evaluate(`(() => {
    const rect = document.getElementById('resizer').getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height * 0.68 };
  })()`);
  await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: railHoverPoint.x, y: railHoverPoint.y });
  await new Promise(resolve => setTimeout(resolve, 220));
  const collapseCapture = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
  const collapseScreenshotPath = path.join(screenshotsRoot, 'research-pane-collapsed.png');
  fs.writeFileSync(collapseScreenshotPath, Buffer.from(collapseCapture.base64, 'base64'));
  collapsePreview.screenshot = path.relative(root, collapseScreenshotPath).split(path.sep).join('/');
  await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 240, y: 180 });
  await new Promise(resolve => setTimeout(resolve, 520));
  const railReset = await driver.client.evaluate(`(() => {
    const resizer = document.getElementById('resizer');
    const toggle = document.getElementById('search-panel-toggle');
    const bounds = resizer.getBoundingClientRect();
    return {
      pointerY: Number.parseFloat(getComputedStyle(resizer).getPropertyValue('--rail-pointer-y')),
      centerY: bounds.height / 2,
      highlightOpacity: Number.parseFloat(getComputedStyle(resizer, '::after').opacity),
      toggleOpacity: Number.parseFloat(getComputedStyle(toggle).opacity),
      railActive: resizer.classList.contains('is-rail-active')
    };
  })()`);
  assert.ok(Math.abs(railReset.pointerY - railReset.centerY) <= 1, JSON.stringify(railReset));
  assert.ok(railReset.highlightOpacity <= 0.3, JSON.stringify(railReset));
  assert.equal(railReset.toggleOpacity, 0, JSON.stringify(railReset));
  assert.equal(railReset.railActive, false);
  const aiAutoExpandedPane = await driver.client.evaluate(`(async () => {
    const panel = document.getElementById('search-panel');
    const toggle = document.getElementById('search-panel-toggle');
    const aiButton = document.getElementById('btn-ai-chat-inline');
    aiButton.click();
    await new Promise(resolve => setTimeout(resolve, 460));
    const saved = JSON.parse(localStorage.getItem('essay_horizontal_flex') || '{}');
    const aiPanel = document.getElementById('ai-chat-panel');
    const chatResizer = document.getElementById('chat-resizer');
    const inputWrapper = document.querySelector('.ai-chat-input-wrapper');
    const moreButton = document.getElementById('btn-more-dropdown');
    const privacySelect = document.getElementById('trusted-ai-privacy');
    const privacyControl = document.querySelector('.ef-select[data-select-id="trusted-ai-privacy"]');
    privacyControl?.querySelector('.ef-select-trigger')?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const sensitiveOption = privacyControl?.querySelector('.ef-select-option[data-value="sensitive"]');
    sensitiveOption?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    sensitiveOption?.focus({ preventScroll: true });
    await new Promise(resolve => setTimeout(resolve, 260));
    const resolveColor = name => {
      const probe = document.createElement('i');
      probe.style.color = 'var(' + name + ')';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      collapsed: panel.classList.contains('is-collapsed'),
      panelWidth: panel.getBoundingClientRect().width,
      panelAriaHidden: panel.getAttribute('aria-hidden'),
      panelInert: panel.inert,
      toggleLabel: toggle.getAttribute('aria-label'),
      toggleExpanded: toggle.getAttribute('aria-expanded'),
      persistedCollapsed: saved.collapsed,
      aiVisible: aiPanel.classList.contains('visible'),
      aiDisplay: getComputedStyle(aiPanel).display,
      dividerColor: getComputedStyle(chatResizer).backgroundColor,
      expectedDividerColor: resolveColor('--border-color'),
      inputBackground: getComputedStyle(inputWrapper).backgroundColor,
      expectedInputBackground: resolveColor('--bg-input'),
      moreButtonColor: getComputedStyle(moreButton).color,
      expectedMoreButtonColor: resolveColor('--text-secondary'),
      moreIconStroke: getComputedStyle(moreButton.querySelector('svg')).stroke,
      privacyEnhanced: Boolean(privacyControl),
      privacyNativeDisplay: getComputedStyle(privacySelect).display,
      privacyMenuOpen: privacyControl?.classList.contains('is-open'),
      privacyTriggerBackground: getComputedStyle(privacyControl.querySelector('.ef-select-trigger')).backgroundColor,
      privacyMenuBackground: getComputedStyle(privacyControl.querySelector('.ef-select-menu')).backgroundColor,
      privacyHighlightBackground: getComputedStyle(sensitiveOption).backgroundColor,
      privacyHighlightColor: getComputedStyle(sensitiveOption).color
    };
  })()`);
  assert.equal(aiAutoExpandedPane.collapsed, false, JSON.stringify(aiAutoExpandedPane));
  assert.ok(aiAutoExpandedPane.panelWidth >= 350, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.panelAriaHidden, null);
  assert.equal(aiAutoExpandedPane.panelInert, false);
  assert.equal(aiAutoExpandedPane.toggleLabel, '收起资料栏');
  assert.equal(aiAutoExpandedPane.toggleExpanded, 'true');
  assert.equal(aiAutoExpandedPane.persistedCollapsed, false);
  assert.equal(aiAutoExpandedPane.aiVisible, true, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.aiDisplay, 'flex', JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.dividerColor, aiAutoExpandedPane.expectedDividerColor, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.inputBackground, aiAutoExpandedPane.expectedInputBackground, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.moreButtonColor, aiAutoExpandedPane.expectedMoreButtonColor, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.moreIconStroke, aiAutoExpandedPane.expectedMoreButtonColor, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.privacyEnhanced, true, JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.privacyNativeDisplay, 'none', JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.privacyMenuOpen, true, JSON.stringify(aiAutoExpandedPane));
  assert.notEqual(aiAutoExpandedPane.privacyTriggerBackground, 'rgb(255, 255, 255)', JSON.stringify(aiAutoExpandedPane));
  assert.notEqual(aiAutoExpandedPane.privacyMenuBackground, 'rgb(255, 255, 255)', JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.privacyHighlightBackground, 'rgb(230, 180, 34)', JSON.stringify(aiAutoExpandedPane));
  assert.equal(aiAutoExpandedPane.privacyHighlightColor, 'rgb(43, 33, 0)', JSON.stringify(aiAutoExpandedPane));
  const darkAiCapture = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
  const darkAiScreenshotPath = path.join(screenshotsRoot, 'dark-ai-assistant.png');
  fs.writeFileSync(darkAiScreenshotPath, Buffer.from(darkAiCapture.base64, 'base64'));
  aiAutoExpandedPane.screenshot = path.relative(root, darkAiScreenshotPath).split(path.sep).join('/');
  await driver.client.evaluate(`(async () => {
    toggleChatPanel(false);
    await new Promise(resolve => setTimeout(resolve, 280));
    return true;
  })()`);
  const aiHintAnchoring = await driver.client.evaluate(`(async () => {
    const editor = document.querySelector('#editor-container .ql-editor');
    const toggle = document.getElementById('search-panel-toggle');
    const hint = document.getElementById('ai-line-hint');
    editor.focus({ preventScroll: true });
    quill.setText('\\n', Quill.sources.SILENT);
    quill.setSelection(0, 0, Quill.sources.SILENT);
    const [line] = quill.getLine(0);
    const measure = () => {
      const workspace = document.getElementById('workspace');
      const lineRect = line.domNode.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const expectedLeft = lineRect.left - workspaceRect.left + workspace.scrollLeft;
      return {
        workspaceWidth: workspaceRect.width,
        lineViewportLeft: lineRect.left,
        hintViewportLeft: hint.getBoundingClientRect().left,
        inlineLeft: Number.parseFloat(hint.style.left),
        expectedLeft,
        delta: Number.parseFloat(hint.style.left) - expectedLeft,
        visible: hint.style.display !== 'none'
      };
    };
    showAIHint(line, { index: 0 });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const expandedBefore = measure();
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 480));
    const collapsed = measure();
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 480));
    const expandedAfter = measure();
    return { expandedBefore, collapsed, expandedAfter };
  })()`);
  for (const state of Object.values(aiHintAnchoring)) {
    assert.equal(state.visible, true, JSON.stringify(aiHintAnchoring));
    assert.ok(Math.abs(state.delta) <= 1, JSON.stringify(aiHintAnchoring));
  }
  assert.ok(aiHintAnchoring.collapsed.workspaceWidth > aiHintAnchoring.expandedBefore.workspaceWidth + 300, JSON.stringify(aiHintAnchoring));
  assert.ok(Math.abs(aiHintAnchoring.collapsed.hintViewportLeft - aiHintAnchoring.expandedBefore.hintViewportLeft) > 100, JSON.stringify(aiHintAnchoring));
  assert.ok(Math.abs(aiHintAnchoring.expandedAfter.hintViewportLeft - aiHintAnchoring.expandedBefore.hintViewportLeft) <= 2, JSON.stringify(aiHintAnchoring));
  const aiHintCapture = await driver.client.evaluate('window.electronAPI.captureAutomationScreenshot()');
  const aiHintScreenshotPath = path.join(screenshotsRoot, 'ai-hint-anchored.png');
  fs.writeFileSync(aiHintScreenshotPath, Buffer.from(aiHintCapture.base64, 'base64'));
  aiHintAnchoring.screenshot = path.relative(root, aiHintScreenshotPath).split(path.sep).join('/');
  await driver.client.evaluate('hideAIHint(); true');
  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));

  const source = createSourceTreeManifest(root);
  fs.writeFileSync(path.join(screenshotsRoot, 'library-responsive-report.json'), `${JSON.stringify({
    schemaVersion: 1, suite: 'library-responsive', passed: true, sourceTreeSha256: source.sourceTreeSha256,
    sourceTreeFileCount: source.fileCount, widths, customSelectPreview, interaction, emptyLibrary, evidenceSearch,
    collapsePreview, railReset, aiAutoExpandedPane, aiHintAnchoring
  }, null, 2)}\n`);
});
