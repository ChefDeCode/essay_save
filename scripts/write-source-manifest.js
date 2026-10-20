const path = require('path');
const { writeSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'artifacts', 'm0', 'source-tree-manifest.json');
const manifest = writeSourceTreeManifest(root, outputPath);
console.log(`sourceTreeSha256=${manifest.sourceTreeSha256}`);
console.log(`fileCount=${manifest.fileCount}`);
console.log(`manifest=${outputPath}`);
