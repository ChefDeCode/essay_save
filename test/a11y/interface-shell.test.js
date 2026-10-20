'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { launchElectron, waitForRenderer } = require('../../scripts/lib/electron-driver');
const { createSourceTreeManifest } = require('../../scripts/lib/source-tree');

const root = path.resolve(__dirname, '..', '..');

test('project center, full-screen settings and toolbar drawers remain polished and usable across window sizes', { timeout: 180_000 }, async t => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-interface-shell-'));
  let driver = await launchElectron({
    rootPath: root,
    userDataPath: profileRoot,
    profileReportPath: path.join(profileRoot, 'profile-report.json')
  });
  t.after(async () => {
    if (driver) await driver.close();
    fs.rmSync(profileRoot, { recursive: true, force: true });
  });

  await waitForRenderer(driver, 'appInitializationComplete === true && quill.isEnabled()', { timeoutMs: 45_000 });
  driver.client.timeoutMs = 120_000;

  const setWindowSize = async (width, height) => {
    await driver.client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height
    });
    await new Promise(resolve => setTimeout(resolve, 450));
  };

  const screenshotsRoot = path.join(root, 'artifacts', 'a11y');
  fs.mkdirSync(screenshotsRoot, { recursive: true });
  const screenshots = [];
  const capture = async name => {
    const screenshot = await driver.client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });
    const screenshotPath = path.join(screenshotsRoot, `${name}.png`);
    const bytes = Buffer.from(screenshot.data, 'base64');
    assert.ok(bytes.length > 1000, `${name} screenshot should contain rendered pixels`);
    fs.writeFileSync(screenshotPath, bytes);
    screenshots.push(path.relative(root, screenshotPath).split(path.sep).join('/'));
  };

  await driver.client.evaluate(`(async () => {
    await window.essayflowDataReady;
    for (const [index, title] of ['城市韧性研究综述', 'Digital scholarship notes'].entries()) {
      await window.electronAPI.saveProjectAuto({
        projectId: crypto.randomUUID(),
        baseRevision: -1,
        content: '<h1>' + title + '</h1><p>界面验收项目</p>',
        meta: { title, referenceStyle: 'APA' },
        citations: [],
        source: 'interface-shell-a11y'
      });
    }
  })()`);

  await setWindowSize(1180, 780);
  const projectCenter = await driver.client.evaluate(`(async () => {
    document.getElementById('btn-projects').click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && document.querySelectorAll('#projects-list .project-item').length < 2) await new Promise(resolve => setTimeout(resolve, 50));
    const modal = document.getElementById('projects-modal');
    const content = modal.querySelector('.project-list-content');
    const bounds = content.getBoundingClientRect();
    const action = modal.querySelector('.project-actions button');
    const actionBounds = action.getBoundingClientRect();
    const actionStyle = getComputedStyle(action);
    return {
      tooltip: document.getElementById('btn-projects').dataset.tooltip,
      heading: modal.querySelector('h3').textContent.trim(),
      projectCount: modal.querySelectorAll('.project-item').length,
      fitsViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      actionIsCompactRectangle: actionBounds.width > actionBounds.height && parseFloat(actionStyle.borderRadius) <= 12,
      transitionDuration: getComputedStyle(content).transitionDuration
    };
  })()`);
  assert.equal(projectCenter.tooltip, '项目中心');
  assert.equal(projectCenter.heading, '项目中心');
  assert.equal(projectCenter.projectCount, 2);
  assert.equal(projectCenter.fitsViewport, true, JSON.stringify(projectCenter));
  assert.equal(projectCenter.actionIsCompactRectangle, true, JSON.stringify(projectCenter));
  assert.notEqual(projectCenter.transitionDuration, '0s');
  await capture('interface-project-center');

  const projectManagement = await driver.client.evaluate(`(async () => {
    const firstItem = document.querySelector('#projects-list .project-item');
    firstItem.querySelector('.btn-rename').click();
    const renameForm = firstItem.querySelector('.project-rename-form');
    const renameInput = firstItem.querySelector('.project-rename-input');
    const inputBounds = renameInput.getBoundingClientRect();
    const itemBounds = firstItem.getBoundingClientRect();
    const renameResult = {
      visible: !renameForm.hidden && getComputedStyle(renameForm).display !== 'none',
      fitsItem: inputBounds.left >= itemBounds.left && inputBounds.right <= itemBounds.right,
      radius: parseFloat(getComputedStyle(renameInput).borderRadius)
    };
    renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    firstItem.querySelector('.btn-delete').click();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !document.getElementById('essayflow-confirm-modal').classList.contains('open')) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const dialog = document.getElementById('essayflow-confirm-modal');
    const content = dialog.querySelector('.ef-confirm-content');
    return {
      rename: renameResult,
      renameClosedWithEscape: renameForm.hidden,
      trashCount: document.getElementById('project-trash-count').textContent,
      dialogOpen: dialog.classList.contains('open'),
      dialogTitle: document.getElementById('essayflow-confirm-title').textContent,
      dialogRadius: parseFloat(getComputedStyle(content).borderRadius),
      detailCount: dialog.querySelectorAll('.ef-confirm-detail').length,
      confirmLabel: document.getElementById('essayflow-confirm-accept').textContent
    };
  })()`);
  assert.equal(projectManagement.rename.visible, true, JSON.stringify(projectManagement));
  assert.equal(projectManagement.rename.fitsItem, true, JSON.stringify(projectManagement));
  assert.ok(projectManagement.rename.radius >= 8, JSON.stringify(projectManagement));
  assert.equal(projectManagement.renameClosedWithEscape, true, JSON.stringify(projectManagement));
  assert.equal(projectManagement.trashCount, '0', JSON.stringify(projectManagement));
  assert.equal(projectManagement.dialogOpen, true, JSON.stringify(projectManagement));
  assert.match(projectManagement.dialogTitle, /移除/);
  assert.ok(projectManagement.dialogRadius >= 20, JSON.stringify(projectManagement));
  assert.equal(projectManagement.detailCount, 3, JSON.stringify(projectManagement));
  assert.equal(projectManagement.confirmLabel, '移入回收站', JSON.stringify(projectManagement));
  await new Promise(resolve => setTimeout(resolve, 460));
  await capture('interface-project-delete-confirm');
  await driver.client.evaluate(`document.getElementById('essayflow-confirm-cancel').click()`);
  await new Promise(resolve => setTimeout(resolve, 420));

  await driver.client.evaluate(`closeModalEl(document.getElementById('projects-modal'))`);
  await new Promise(resolve => setTimeout(resolve, 450));
  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await driver.client.evaluate(`${axeSource}\n;Boolean(globalThis.axe && globalThis.axe.run)`);
  const settingsWide = await driver.client.evaluate(`(async () => {
    document.getElementById('btn-settings').click();
    await new Promise(resolve => setTimeout(resolve, 500));
    const panel = document.getElementById('settings-panel');
    const content = panel.querySelector('.settings-content');
    const bounds = content.getBoundingClientRect();
    const axeResult = await axe.run(content, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    const surfaces = [];
    for (const tab of panel.querySelectorAll('.settings-tab')) {
      tab.click();
      await new Promise(resolve => setTimeout(resolve, 40));
      const header = panel.querySelector('.settings-page-header');
      const body = panel.querySelector('.settings-body');
      surfaces.push({
        title: document.getElementById('settings-page-title').textContent.trim(),
        headerBackground: getComputedStyle(header).backgroundColor,
        bodyBackground: getComputedStyle(body).backgroundColor
      });
    }
    panel.querySelector('.settings-tab[data-tab="general"]').click();
    return {
      open: panel.classList.contains('open'),
      fitsViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      selectedTabs: panel.querySelectorAll('.settings-tab[aria-selected="true"]').length,
      pageTitle: document.getElementById('settings-page-title').textContent.trim(),
      surfaces,
      serious: axeResult.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({
        id: item.id,
        nodes: item.nodes.map(node => ({ target: node.target, html: node.html }))
      }))
    };
  })()`);
  assert.equal(settingsWide.open, true, JSON.stringify(settingsWide));
  assert.equal(settingsWide.fitsViewport, true, JSON.stringify(settingsWide));
  assert.equal(settingsWide.selectedTabs, 1, JSON.stringify(settingsWide));
  assert.equal(settingsWide.pageTitle, '通用', JSON.stringify(settingsWide));
  assert.deepEqual(settingsWide.surfaces.map(surface => surface.title), ['通用', 'AI 功能', 'AI 服务', '快捷键']);
  assert.equal(settingsWide.surfaces.every(surface => surface.headerBackground === surface.bodyBackground), true, JSON.stringify(settingsWide.surfaces));
  assert.deepEqual(settingsWide.serious, [], JSON.stringify(settingsWide));
  await capture('interface-settings-wide');

  await setWindowSize(760, 680);
  const settingsCompact = await driver.client.evaluate(`(() => {
    const content = document.querySelector('#settings-panel .settings-content');
    const bounds = content.getBoundingClientRect();
    const body = document.querySelector('#settings-panel .settings-body');
    return {
      fitsViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      bodyHasHorizontalOverflow: body.scrollWidth > body.clientWidth + 1,
      tabCount: document.querySelectorAll('#settings-panel .settings-tab').length
    };
  })()`);
  assert.deepEqual(settingsCompact, { fitsViewport: true, bodyHasHorizontalOverflow: false, tabCount: 4 });
  await capture('interface-settings-compact');

  await driver.client.evaluate(`closeSettings()`);
  await new Promise(resolve => setTimeout(resolve, 450));
  const moreTools = await driver.client.evaluate(`(async () => {
    document.body.classList.add('dark');
    document.getElementById('btn-more-dropdown').click();
    await new Promise(resolve => setTimeout(resolve, 350));
    const menu = document.getElementById('more-dropdown-menu');
    const select = document.getElementById('active-citation-style');
    const control = document.querySelector('.ef-select[data-select-id="active-citation-style"]');
    const trigger = control?.querySelector('.ef-select-trigger');
    trigger?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const hoveredOption = control?.querySelector('.ef-select-option[data-value="IEEE"]');
    hoveredOption?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    hoveredOption?.focus({ preventScroll: true });
    await new Promise(resolve => setTimeout(resolve, 260));
    const menuStyle = getComputedStyle(menu);
    const triggerStyle = getComputedStyle(trigger);
    const optionStyle = getComputedStyle(hoveredOption);
    return {
      open: menu.classList.contains('open'),
      menuRadius: parseFloat(menuStyle.borderRadius),
      menuColorScheme: menuStyle.colorScheme,
      enhanced: Boolean(control),
      nativeDisplay: getComputedStyle(select).display,
      selectOpen: control?.classList.contains('is-open'),
      selectRadius: parseFloat(triggerStyle.borderRadius),
      selectBackground: triggerStyle.backgroundColor,
      menuBackground: getComputedStyle(control.querySelector('.ef-select-menu')).backgroundColor,
      hoveredBackground: optionStyle.backgroundColor,
      hoveredColor: optionStyle.color
    };
  })()`);
  assert.equal(moreTools.open, true, JSON.stringify(moreTools));
  assert.ok(moreTools.menuRadius >= 15, JSON.stringify(moreTools));
  assert.equal(moreTools.menuColorScheme, 'dark', JSON.stringify(moreTools));
  assert.equal(moreTools.enhanced, true, JSON.stringify(moreTools));
  assert.equal(moreTools.nativeDisplay, 'none', JSON.stringify(moreTools));
  assert.equal(moreTools.selectOpen, true, JSON.stringify(moreTools));
  assert.ok(moreTools.selectRadius >= 9, JSON.stringify(moreTools));
  assert.notEqual(moreTools.selectBackground, 'rgb(255, 255, 255)', JSON.stringify(moreTools));
  assert.notEqual(moreTools.menuBackground, 'rgb(255, 255, 255)', JSON.stringify(moreTools));
  assert.equal(moreTools.hoveredBackground, 'rgb(230, 180, 34)', JSON.stringify(moreTools));
  assert.equal(moreTools.hoveredColor, 'rgb(43, 33, 0)', JSON.stringify(moreTools));
  await capture('interface-more-tools-dark');
  const citationChoice = await driver.client.evaluate(`(async () => {
    const control = document.querySelector('.ef-select[data-select-id="active-citation-style"]');
    control.querySelector('.ef-select-option[data-value="IEEE"]').click();
    await new Promise(resolve => setTimeout(resolve, 500));
    return {
      value: document.getElementById('active-citation-style').value,
      visibleValue: control.querySelector('.ef-select-value').textContent,
      selectOpen: control.classList.contains('is-open'),
      toolsOpen: document.getElementById('more-dropdown-menu').classList.contains('open'),
      projectReferenceStyle: currentProjectMeta?.referenceStyle
    };
  })()`);
  assert.deepEqual(citationChoice, {
    value: 'IEEE', visibleValue: 'IEEE', selectOpen: false, toolsOpen: false, projectReferenceStyle: 'IEEE'
  });
  await driver.client.evaluate(`(() => {
    document.getElementById('more-dropdown-menu').classList.remove('open');
    document.body.classList.remove('dark');
  })()`);

  const paragraphFormatDark = await driver.client.evaluate(`(async () => {
    document.body.classList.add('dark');
    quill.setText('暗色段落快捷表', Quill.sources.SILENT);
    quill.setSelection(0, 0, Quill.sources.SILENT);
    const [line] = quill.getLine(0);
    showParagraphFormatPanel({ index: 0, length: 0 }, line.domNode);
    await new Promise(resolve => setTimeout(resolve, 220));
    const panel = document.getElementById('paragraph-format-panel');
    const active = panel.querySelector('.pf-item.active');
    const inactive = panel.querySelector('.pf-item[data-value="1"]');
    const activeStyle = getComputedStyle(active);
    return {
      visible: panel.classList.contains('visible'),
      activeText: active.textContent.trim(),
      activeColor: activeStyle.color,
      activeBackgroundImage: activeStyle.backgroundImage,
      inactiveColor: getComputedStyle(inactive).color,
      panelBackground: getComputedStyle(panel).backgroundColor,
      dividerColor: getComputedStyle(panel.querySelector('.pf-divider')).backgroundColor
    };
  })()`);
  assert.equal(paragraphFormatDark.visible, true, JSON.stringify(paragraphFormatDark));
  assert.equal(paragraphFormatDark.activeText, '正文', JSON.stringify(paragraphFormatDark));
  assert.equal(paragraphFormatDark.activeColor, 'rgb(43, 33, 0)', JSON.stringify(paragraphFormatDark));
  assert.notEqual(paragraphFormatDark.activeBackgroundImage, 'none', JSON.stringify(paragraphFormatDark));
  assert.notEqual(paragraphFormatDark.inactiveColor, 'rgb(51, 51, 51)', JSON.stringify(paragraphFormatDark));
  assert.notEqual(paragraphFormatDark.panelBackground, 'rgb(255, 255, 255)', JSON.stringify(paragraphFormatDark));
  assert.notEqual(paragraphFormatDark.dividerColor, 'rgb(240, 240, 240)', JSON.stringify(paragraphFormatDark));
  await capture('interface-paragraph-format-dark');
  await driver.client.evaluate(`(() => {
    hideParagraphFormatPanel();
    document.body.classList.remove('dark');
  })()`);

  const drawer = await driver.client.evaluate(`(async () => {
    document.getElementById('btn-new-project').click();
    await new Promise(resolve => setTimeout(resolve, 500));
    const modal = document.getElementById('new-project-modal');
    const content = modal.querySelector('.modal-content');
    const bounds = content.getBoundingClientRect();
    return {
      open: modal.classList.contains('open'),
      drawerClass: modal.classList.contains('drawer-modal-left'),
      fitsViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      heading: modal.querySelector('h3').textContent.trim()
    };
  })()`);
  assert.deepEqual(drawer, { open: true, drawerClass: true, fitsViewport: true, heading: '创建新项目' });
  await capture('interface-new-project-drawer');

  assert.equal(driver.exceptions.length, 0, JSON.stringify(driver.exceptions, null, 2));
  assert.equal(driver.securityErrors.length, 0, JSON.stringify(driver.securityErrors, null, 2));
  assert.equal(driver.consoleErrors.length, 0, JSON.stringify(driver.consoleErrors, null, 2));

  const source = createSourceTreeManifest(root);
  fs.writeFileSync(path.join(screenshotsRoot, 'interface-shell-report.json'), `${JSON.stringify({
    schemaVersion: 1,
    suite: 'interface-shell',
    passed: true,
    sourceTreeSha256: source.sourceTreeSha256,
    sourceTreeFileCount: source.fileCount,
    projectCenter,
    settingsWide,
    settingsCompact,
    moreTools,
    drawer,
    screenshots
  }, null, 2)}\n`);
});
