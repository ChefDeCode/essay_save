#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { MatrixService } = require('../src/main/matrix/matrix-service');
const { exportCsvZip, exportXlsx } = require('../src/main/matrix/matrix-export');
const { createSourceTreeManifest } = require('./lib/source-tree');

const root = path.resolve(__dirname, '..');
const projectId = 'd5000000-0000-4000-8000-000000000001';

function uuid(namespace, value) {
  const hash = crypto.createHash('sha256').update(`${namespace}\0${value}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summary(samples) {
  return {
    sampleCount: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
    rawMs: samples.map(value => Number(value.toFixed(3)))
  };
}

function fixture() {
  const columns = ['author', 'year', 'research-question', 'method', 'sample', 'variables', 'conclusions', 'limitations', 'relation', 'evidence']
    .map((key, order) => ({ id: uuid('column', key), key, label: key, order, userDefined: false }));
  const citationItems = [];
  const rows = [];
  for (let index = 0; index < 50; index += 1) {
    const citationItemId = uuid('citation', index);
    citationItems.push({
      id: citationItemId, citationItemId, title: `合成性能文献 ${index + 1}`,
      author: [{ family: `Author${index + 1}`, given: 'Perf' }], issued: { 'date-parts': [[2000 + index]] }, DOI: `10.5555/perf.${index}`
    });
    const cells = {};
    columns.forEach(column => {
      const cellId = uuid(`cell-${index}`, column.key);
      const evidenceId = uuid(`evidence-${index}`, column.key);
      const revisionId = uuid(`revision-${index}`, column.key);
      const value = `${column.label}：中文 Unicode fixture\n第二行 ${index}`;
      cells[column.id] = {
        schemaVersion: 1, id: cellId, columnId: column.id, citationItemId, value,
        origin: 'ai', reviewStatus: 'proposed', userEdited: false, basis: 'pdf-evidence',
        sourceRefs: [{
          evidenceId, evidenceRevisionId: revisionId, citationItemId, pageLabel: String(index + 1),
          quote: `Synthetic quote ${index}`, rawQuoteSha256: crypto.createHash('sha256').update(`Synthetic quote ${index}`).digest('hex'),
          basis: 'pdf-evidence', reviewStatus: 'proposed'
        }],
        auditResultEventId: uuid('audit', index), createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z'
      };
    });
    rows.push({ id: uuid('row', index), citationItemId, taskStatus: 'completed', attempt: 1, cells, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' });
  }
  return {
    matrix: { schemaVersion: 1, id: uuid('matrix', 1), projectId, name: '50 篇性能矩阵', columns, rows, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z' },
    citationItems
  };
}

async function main() {
  const data = fixture();
  const csvSamples = [];
  const xlsxSamples = [];
  for (let index = 0; index < 20; index += 1) {
    let started = performance.now();
    const csv = await exportCsvZip(data.matrix, data.citationItems);
    csvSamples.push(performance.now() - started);
    if (csv.length < 1000) throw new Error('CSV ZIP 性能 fixture 导出不完整');
    started = performance.now();
    const xlsx = await exportXlsx(data.matrix, data.citationItems);
    xlsxSamples.push(performance.now() - started);
    if (xlsx.length < 1000) throw new Error('XLSX 性能 fixture 导出不完整');
  }
  let cancelCalls = 0;
  const service = new MatrixService({
    repository: {}, assetStore: {},
    trustedAiService: { previewRequest() {}, request() {}, cancelRequest() { cancelCalls += 1; } }
  });
  const cancelSamples = [];
  for (let index = 0; index < 100; index += 1) {
    const batchId = uuid('batch', index);
    service.activeBatches.set(batchId, { cancelled: false, activeRequestId: uuid('request', index) });
    const started = performance.now();
    const result = service.cancelBatch({ batchId });
    cancelSamples.push(performance.now() - started);
    if (!result.cancelled) throw new Error('矩阵取消性能 fixture 未取消');
  }
  if (cancelCalls !== 100) throw new Error('底层 AI 取消没有逐批传播');
  const csv = summary(csvSamples);
  const xlsx = summary(xlsxSamples);
  const cancel = summary(cancelSamples);
  const thresholds = { exportP95Ms: 2000, cancelP95Ms: 1000 };
  const failures = [];
  if (csv.p95Ms > thresholds.exportP95Ms) failures.push(`CSV p95 ${csv.p95Ms}ms > ${thresholds.exportP95Ms}ms`);
  if (xlsx.p95Ms > thresholds.exportP95Ms) failures.push(`XLSX p95 ${xlsx.p95Ms}ms > ${thresholds.exportP95Ms}ms`);
  if (cancel.p95Ms > thresholds.cancelP95Ms) failures.push(`cancel p95 ${cancel.p95Ms}ms > ${thresholds.cancelP95Ms}ms`);
  const sourceTree = createSourceTreeManifest(root);
  const report = {
    schemaVersion: 1,
    suite: 'm5-matrix-performance',
    generatedAt: new Date().toISOString(),
    sourceTreeSha256: sourceTree.sourceTreeSha256,
    sourceTreeFileCount: sourceTree.fileCount,
    fixture: { paperCount: 50, columnCount: 10, cellCount: 500, exportSamples: 20, cancelSamples: 100 },
    machine: {
      platform: `${process.platform}-${process.arch}`,
      release: os.release(),
      node: process.version,
      cpuModel: os.cpus()[0]?.model || 'unknown',
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    },
    thresholds,
    measurements: { csvZip: csv, xlsx, cancel },
    failures,
    passed: failures.length === 0
  };
  const outputPath = path.join(root, 'artifacts', 'm5-performance.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
