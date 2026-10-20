#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { CitationService } = require('../src/main/citation/citation-service');
const { LibraryStore, libraryItemIdFromLegacySourceId } = require('../src/main/data/library-store');
const { createSourceTreeManifest } = require('./lib/source-tree');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'scale', 'library-5000.jsonl');
const REPORT = path.join(ROOT, 'artifacts', 'perf-baseline.json');
const FIXED_TIME = '2026-07-16T00:00:00.000Z';

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function metrics(values) {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3))
  };
}

function fixtureItem(row) {
  const libraryItemId = libraryItemIdFromLegacySourceId(row.id);
  return {
    schemaVersion: 1,
    libraryItemId,
    type: row.type,
    title: row.title,
    author: row.authors,
    issued: row.issued,
    DOI: row.doi,
    'container-title': row.containerTitle,
    abstract: row.abstract,
    tags: row.tags,
    starred: Number(row.id.slice(-1)) % 3 === 0,
    privateNote: Number(row.id.slice(-2)) % 7 === 0 ? `fixture note ${row.id}` : '',
    metadataProvenance: { source: 'synthetic-fixture', importedAt: FIXED_TIME, originalFormat: 'jsonl' },
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    legacySourceId: row.id
  };
}

async function main() {
  const rows = fs.readFileSync(FIXTURE, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (rows.length !== 5000) throw new Error(`5000 条性能 fixture 数量错误: ${rows.length}`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-m2-perf-'));
  try {
    const store = new LibraryStore(temporaryRoot, { now: () => new Date(FIXED_TIME) });
    const itemsById = Object.fromEntries(rows.map(row => {
      const item = fixtureItem(row);
      return [item.libraryItemId, item];
    }));
    await store.bulkReplace({ itemsById, collections: [] }, { baseRevision: 0 });
    const service = new CitationService({ repository: {}, libraryStore: store, now: () => new Date(FIXED_TIME) });

    const firstStarted = performance.now();
    const first = await service.queryLibrary({ sortBy: 'updatedAt', direction: 'desc', offset: 0, limit: 100 });
    const firstInteractiveMs = performance.now() - firstStarted;
    if (first.items.length > 100) throw new Error(`首屏返回 ${first.items.length} 张卡片，超过 100`);

    const queries = [];
    for (let index = 0; index < 40; index += 1) {
      const row = rows[(index * 127) % rows.length];
      queries.push({ search: index % 2 ? row.title.split(' ').slice(-1)[0] : row.doi, limit: 100 });
      queries.push({
        year: row.issued['date-parts'][0][0],
        source: row.containerTitle,
        type: row.type,
        hasPdf: false,
        starred: Number(row.id.slice(-1)) % 3 === 0,
        tags: [row.tags[0]],
        sortBy: index % 2 ? 'title' : 'year',
        direction: index % 2 ? 'asc' : 'desc',
        limit: 100
      });
    }
    const durations = [];
    let maximumResultItems = first.items.length;
    for (const query of queries) {
      const started = performance.now();
      const result = await service.queryLibrary(query);
      durations.push(performance.now() - started);
      maximumResultItems = Math.max(maximumResultItems, result.items.length);
    }
    const search = metrics(durations);
    const sourceTree = createSourceTreeManifest(ROOT);
    const thresholds = { firstInteractiveMs: 2000, searchP95Ms: 300, maximumDomPaperCards: 200 };
    const passed = firstInteractiveMs <= thresholds.firstInteractiveMs &&
      search.p95Ms <= thresholds.searchP95Ms && maximumResultItems <= thresholds.maximumDomPaperCards;
    const report = {
      schemaVersion: 1,
      milestone: 'm2',
      passed,
      fixture: 'test/fixtures/scale/library-5000.jsonl',
      fixtureItemCount: rows.length,
      sourceTreeSha256: sourceTree.sourceTreeSha256,
      sourceTreeFileCount: sourceTree.fileCount,
      runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, cpuCount: os.cpus().length },
      thresholds,
      firstScreen: {
        interactiveMs: Number(firstInteractiveMs.toFixed(3)),
        itemCount: first.items.length
      },
      localSearchAndCombinedFilters: search,
      maximumRenderedPaperCards: maximumResultItems,
      paginationLimit: 100
    };
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`M2 performance: first=${report.firstScreen.interactiveMs}ms p95=${search.p95Ms}ms maxCards=${maximumResultItems}\n`);
    process.stdout.write(`report=${REPORT}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
