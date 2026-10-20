#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { prepareWinCodeSignCache } = require('./lib/builder-cache');

function runBuild(options = {}) {
  const args = options.args || process.argv.slice(2);
  const spawnImplementation = options.spawnImplementation || spawnSync;
  const prepareCache = options.prepareCache || prepareWinCodeSignCache;
  const cache = prepareCache(options.cacheOptions);
  const electronBuilderCli = options.electronBuilderCli || require.resolve('electron-builder/out/cli/cli.js');
  const result = spawnImplementation(process.execPath, [electronBuilderCli, ...args], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ELECTRON_BUILDER_CACHE: cache.cacheRoot },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

function main(options = {}) {
  const runBuildImplementation = options.runBuildImplementation || runBuild;
  const stderr = options.stderr || process.stderr;
  try {
    return runBuildImplementation(options.runBuildOptions);
  } catch (error) {
    stderr.write(`${error.stack || error.message || error}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, runBuild };
