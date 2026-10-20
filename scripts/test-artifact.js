#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function find(directory, predicate, results = []) {
  if (!fs.existsSync(directory)) return results;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) find(absolute, predicate, results);
    else if (entry.isFile() && predicate(absolute)) results.push(absolute);
  }
  return results;
}
function signature(file) {
  const escaped = file.replace(/'/g, "''");
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Signer=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''};TimeStamper=if($s.TimeStamperCertificate){$s.TimeStamperCertificate.Subject}else{''}} | ConvertTo-Json -Compress`], { encoding: 'utf8', shell: false });
  try { return JSON.parse(run.stdout.trim()); } catch (_) { return { Status: 'UnknownError', raw: run.stderr }; }
}
function extractPayload(executable) {
  const seven = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-artifact-extract-'));
  const runs = [];
  try {
    let run = spawnSync(seven, ['x', executable, `-o${temp}`, '-y'], { encoding: 'utf8', shell: false, timeout: 120_000 });
    runs.push({ input: path.basename(executable), exitCode: run.status ?? 1 });
    for (const archive of find(temp, file => /\.7z$/i.test(file)).slice(0, 10)) {
      const out = `${archive}.contents`;
      run = spawnSync(seven, ['x', archive, `-o${out}`, '-y'], { encoding: 'utf8', shell: false, timeout: 120_000 });
      runs.push({ input: path.relative(temp, archive), exitCode: run.status ?? 1 });
    }
    const asars = find(temp, file => /[\\/]resources[\\/]app\.asar$/i.test(file));
    return { runs, appPayloadSha256: asars.length ? shaFile(asars[0]) : null, appAsarCount: asars.length };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
function main() {
  const target = option('--target');
  if (!['win-unpacked', 'portable', 'nsis'].includes(target)) throw new Error('target must be win-unpacked, portable or nsis');
  const winRoot = path.join(dist, 'win-unpacked');
  const winExe = path.join(winRoot, 'EssayFlow.exe');
  const winAsar = path.join(winRoot, 'resources', 'app.asar');
  if (!fs.existsSync(winExe) || !fs.existsSync(winAsar)) throw new Error('win-unpacked payload is missing');
  const commonPayload = shaFile(winAsar);
  let artifact = winExe;
  if (target === 'portable') artifact = find(dist, file => /EssayFlow 1\.0\.0\.exe$/i.test(file) && !/Setup/i.test(file))[0];
  if (target === 'nsis') artifact = find(dist, file => /EssayFlow Setup 1\.0\.0\.exe$/i.test(file))[0];
  if (!artifact) throw new Error(`${target} artifact is missing`);
  const targetSha256 = shaFile(artifact);
  const sig = signature(artifact);
  const payload = target === 'win-unpacked' ? { appPayloadSha256: commonPayload, appAsarCount: 1, runs: [] } : extractPayload(artifact);
  const smoke = target === 'nsis' ? { attempted: false, exitCode: null, reason: '当前 runner 不是声明的干净 Windows VM，未执行安装/升级/卸载破坏性流程' } : (() => {
    const run = spawnSync(process.execPath, ['scripts/run-electron-smoke.js', '--app', artifact, '--target', `artifact-${target}`], {
      cwd: root, encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 10 * 1024 * 1024
    });
    return { attempted: true, exitCode: run.status ?? 1 };
  })();
  const source = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1, buildRunId: process.env.ESSAYFLOW_BUILD_RUN_ID || null,
    sourceTreeSha256: source.sourceTreeSha256, target, artifact: path.relative(root, artifact).replace(/\\/g, '/'),
    targetArtifactSha256: target === 'win-unpacked' ? null : targetSha256,
    executableSha256: targetSha256, appPayloadSha256: commonPayload,
    extractedAppPayloadSha256: payload.appPayloadSha256,
    winUnpackedTreeSha256: createSourceTreeManifest(winRoot, { excludedDirectories: [] }).sourceTreeSha256,
    signature: sig, internalTestOnly: sig.Status !== 'Valid' || !sig.TimeStamper,
    smoke, extraction: payload.runs,
    failures: [
      ...(payload.appPayloadSha256 === commonPayload ? [] : ['目标包中的 app.asar 无法提取或与公共 payload 不一致']),
      ...(smoke.attempted && smoke.exitCode === 0 ? [] : [smoke.reason || `${target} smoke 失败`]),
      ...((sig.Status === 'Valid' && sig.TimeStamper) ? [] : ['产物缺少可验证的 Authenticode 签名和时间戳，只能作为内部测试包'])
    ]
  };
  report.passed = report.failures.length === 0;
  const output = path.join(root, 'artifacts', `artifact-${target}.json`);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
main();
