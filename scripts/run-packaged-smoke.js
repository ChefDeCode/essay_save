'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  verifyWinUnpackedPackage,
  writePackageAssetManifest
} = require('./lib/package-verifier');
const { readOption } = require('./verify-package');

function parseArguments(argv) {
  const rootPath = path.resolve(readOption(argv, '--source-root') || path.resolve(__dirname, '..'));
  const application = readOption(argv, '--app');
  if (!application) throw new Error('--app is required');
  return {
    rootPath,
    applicationPath: path.resolve(application),
    manifestPath: path.resolve(readOption(argv, '--manifest') || path.join(rootPath, 'artifacts', 'package-asset-manifest.json'))
  };
}

function buildSmokeInvocation(options) {
  return {
    command: process.execPath,
    args: [
      path.join(options.rootPath, 'scripts', 'run-electron-smoke.js'),
      '--app',
      options.applicationPath,
      '--target',
      'win-unpacked'
    ]
  };
}

async function runPackagedSmoke(options, dependencies = {}) {
  const verify = dependencies.verify || verifyWinUnpackedPackage;
  const writeManifest = dependencies.writeManifest || writePackageAssetManifest;
  const spawnProcess = dependencies.spawn || spawn;
  const report = verify({
    sourceRoot: options.rootPath,
    applicationPath: options.applicationPath
  });
  writeManifest(report, options.manifestPath);
  if (!report.ok) throw new Error(`Package verification failed:\n${report.errors.join('\n')}`);

  const invocation = buildSmokeInvocation(options);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd: options.rootPath,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ code, signal, report });
      else reject(new Error(`Packaged smoke failed (${signal || `exit ${code}`})`));
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await runPackagedSmoke(options);
  console.log(`Packaged smoke passed. appPayloadSha256=${result.report.appPayloadSha256}`);
  console.log(`winUnpackedTreeSha256=${result.report.winUnpackedTreeSha256}`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSmokeInvocation,
  main,
  parseArguments,
  runPackagedSmoke
};
