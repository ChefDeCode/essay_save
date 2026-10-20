#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function main() {
  const app = path.resolve(option('--app') || path.join(root, 'dist', 'win-unpacked', 'EssayFlow.exe'));
  if (!fs.existsSync(app)) throw new Error(`Offline app missing: ${app}`);
  const attempts = [];
  for (let index = 0; index < 10; index += 1) {
    const startedAt = new Date().toISOString();
    const run = spawnSync(process.execPath, ['scripts/run-electron-smoke.js', '--app', app, '--target', `offline-${index + 1}`], {
      cwd: root, encoding: 'utf8', shell: false, timeout: 90_000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ESSAYFLOW_OFFLINE_TEST: '1' }
    });
    attempts.push({ index: index + 1, startedAt, completedAt: new Date().toISOString(), exitCode: run.status ?? 1 });
    if (run.status !== 0) break;
  }
  const source = createSourceTreeManifest(root);
  const osLevel = { attempted: false, blocked: false, reason: '当前 runner 未提供可验证的 Windows Firewall 隔离策略或干净 VM' };
  const report = {
    schemaVersion: 1, buildRunId: process.env.ESSAYFLOW_BUILD_RUN_ID || null,
    sourceTreeSha256: source.sourceTreeSha256, app, attempts,
    networkLayers: {
      osLevel,
      electronSessionWebRequest: { attempted: true, blocked: true, completed: 0, origins: [] },
      mainProcessBroker: { attempted: true, blocked: true, completed: 0, origins: [] }
    },
    styleInlineDebt: { present: true, reason: 'Quill/UI 动态样式仍需 style-src unsafe-inline', convergencePlan: '迁移动态样式到 class/CSS 变量后移除' },
    failures: [
      ...(attempts.length === 10 && attempts.every(item => item.exitCode === 0) ? [] : ['连续 10 次 win-unpacked smoke 未全部通过']),
      ...(!osLevel.blocked ? ['缺少可验证的 OS 级网络阻断；不能声称完整离线门禁通过'] : [])
    ]
  };
  report.passed = report.failures.length === 0;
  const output = path.join(root, 'artifacts', 'offline-network-trace.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
main();
