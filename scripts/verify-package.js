'use strict';

const path = require('node:path');
const {
  verifyWinUnpackedPackage,
  writePackageAssetManifest
} = require('./lib/package-verifier');

function readOption(argv, name) {
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let candidate;
    if (argument === name) {
      candidate = argv[index + 1];
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      candidate = argument.slice(name.length + 1);
    } else {
      continue;
    }
    if (!candidate || candidate.startsWith('--')) throw new Error(`${name} requires a value`);
    if (value !== undefined) throw new Error(`${name} cannot be repeated`);
    value = candidate;
  }
  return value;
}

function parseArguments(argv) {
  const sourceRoot = path.resolve(readOption(argv, '--source-root') || path.resolve(__dirname, '..'));
  const application = readOption(argv, '--app');
  if (!application) throw new Error('--app is required');
  return {
    sourceRoot,
    applicationPath: path.resolve(application),
    outputPath: path.resolve(readOption(argv, '--output') || path.join(sourceRoot, 'artifacts', 'package-asset-manifest.json'))
  };
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  let report;
  try {
    report = verifyWinUnpackedPackage(parsed);
  } catch (error) {
    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      target: 'win-unpacked',
      ok: false,
      applicationPath: parsed.applicationPath,
      errors: [error.message]
    };
  }
  const outputPath = writePackageAssetManifest(report, parsed.outputPath);
  console.log(`packageAssetManifest=${outputPath}`);
  if (report.appPayloadSha256) console.log(`appPayloadSha256=${report.appPayloadSha256}`);
  if (report.winUnpackedTreeSha256) console.log(`winUnpackedTreeSha256=${report.winUnpackedTreeSha256}`);
  if (!report.ok) {
    report.errors.forEach(error => console.error(`verify-package: ${error}`));
    process.exitCode = 1;
  }
  return report;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArguments,
  readOption,
  run
};
