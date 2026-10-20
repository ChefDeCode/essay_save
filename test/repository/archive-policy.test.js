'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ARCHIVE_ERROR_CODES,
  ARCHIVE_LIMITS,
  ArchivePolicyError,
  DEFAULT_CRITICAL_ENTRIES,
  cancelImportPreflight,
  createImportPreflight,
  estimateImportDiskBytes,
  normalizeArchivePath,
  summarizeManifest,
  validateArchiveEntries,
  validateAvailableDiskBytes
} = require('../../src/main/data/archive-policy');

function entry(fileName, uncompressedSize = 0, compressedSize = uncompressedSize, extra = {}) {
  return { fileName, uncompressedSize, compressedSize, ...extra };
}

function entriesWithManifest(...entries) {
  return [entry('manifest.json'), ...entries];
}

function expectCode(code, action) {
  assert.throws(action, error => {
    assert.equal(error instanceof ArchivePolicyError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('archive safety limits are exact, frozen and use binary byte units', () => {
  assert.deepEqual(ARCHIVE_LIMITS, {
    MAX_FILE_COUNT: 20_000,
    MAX_FILE_UNCOMPRESSED_BYTES: 500 * 1024 * 1024,
    MAX_EXPANDED_BYTES: 5 * 1024 * 1024 * 1024,
    MAX_COMPRESSION_RATIO: 200,
    MAX_RELATIVE_PATH_LENGTH: 240,
    MAX_PATH_DEPTH: 20,
    IMPORT_DISK_MULTIPLIER: 2
  });
  assert.equal(Object.isFrozen(ARCHIVE_LIMITS), true);
  assert.deepEqual(DEFAULT_CRITICAL_ENTRIES, ['manifest.json']);
  assert.equal(Object.isFrozen(ARCHIVE_ERROR_CODES), true);
});

test('path normalization accepts relative NFC paths and removes benign separators', () => {
  assert.equal(normalizeArchivePath('./projects\\draft//body.json'), 'projects/draft/body.json');
  assert.equal(normalizeArchivePath('assets/e\u0301vidence.pdf'), 'assets/\u00e9vidence.pdf');
  assert.equal(normalizeArchivePath('a'.repeat(240)), 'a'.repeat(240));
  assert.equal(normalizeArchivePath(`${Array.from({ length: 19 }, (_, i) => `d${i}`).join('/')}/file`)
    .split('/').length, 20);
});

test('path normalization rejects empty names, NUL, absolute, drive, UNC and traversal paths', () => {
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, () => normalizeArchivePath(''));
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, () => normalizeArchivePath('./'));
  expectCode(ARCHIVE_ERROR_CODES.PATH_NUL, () => normalizeArchivePath('safe\0name'));
  for (const path of ['/etc/passwd', 'C:/Windows/file', 'c:relative', '\\\\server\\share\\file']) {
    expectCode(ARCHIVE_ERROR_CODES.PATH_ABSOLUTE, () => normalizeArchivePath(path));
  }
  for (const path of ['../outside', 'safe/../outside', 'safe\\..\\outside']) {
    expectCode(ARCHIVE_ERROR_CODES.PATH_TRAVERSAL, () => normalizeArchivePath(path));
  }
});

test('path normalization rejects unsafe Windows segments, excessive length and excessive depth', () => {
  for (const path of ['NUL', 'folder/con.txt', 'folder/trailing.', 'folder/trailing ', 'folder/a:b']) {
    expectCode(ARCHIVE_ERROR_CODES.PATH_INVALID_SEGMENT, () => normalizeArchivePath(path));
  }
  expectCode(ARCHIVE_ERROR_CODES.PATH_TOO_LONG, () => normalizeArchivePath('a'.repeat(241)));
  const tooDeep = Array.from({ length: 21 }, (_, index) => `d${index}`).join('/');
  expectCode(ARCHIVE_ERROR_CODES.PATH_TOO_DEEP, () => normalizeArchivePath(tooDeep));
});

test('entry validation returns a deterministic summary suitable for yauzl metadata', () => {
  const first = validateArchiveEntries([
    entry('projects/', 0, 0),
    entry('projects/body.json', 400, 4),
    entry('manifest.json', 20, 10)
  ]);
  const second = validateArchiveEntries([
    entry('manifest.json', 20, 10),
    entry('projects/body.json', 400, 4),
    entry('projects/', 0, 0)
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    entryCount: 3,
    fileCount: 2,
    directoryCount: 1,
    expandedBytes: 420,
    compressedBytes: 14,
    maximumObservedCompressionRatio: 100,
    normalizedPaths: ['manifest.json', 'projects', 'projects/body.json']
  });
  assert.equal(Object.isFrozen(first), true);
});

test('entry validation accepts path and name aliases but rejects missing or ambiguous names', () => {
  const result = validateArchiveEntries([
    { path: 'manifest.json', uncompressedSize: 0, compressedSize: 0 },
    { name: 'body.json', uncompressedSize: 1, compressedSize: 1 }
  ]);
  assert.equal(result.fileCount, 2);
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, () => validateArchiveEntries([
    { uncompressedSize: 0, compressedSize: 0 }
  ]));
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_NAME_INVALID, () => validateArchiveEntries([
    { fileName: 'manifest.json', path: 'other.json', uncompressedSize: 0, compressedSize: 0 }
  ]));
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => validateArchiveEntries([null]));
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => validateArchiveEntries('not-an-array'));
});

test('duplicate normalized paths include slash, dot, case and Unicode normalization collisions', () => {
  const collisions = [
    ['Folder/A.json', 'folder/a.json'],
    ['folder/./a.json', 'folder/a.json'],
    ['folder\\a.json', 'folder/a.json'],
    ['folder/e\u0301.json', 'folder/\u00e9.json'],
    ['folder/', 'folder']
  ];
  for (const [left, right] of collisions) {
    expectCode(ARCHIVE_ERROR_CODES.DUPLICATE_PATH, () => validateArchiveEntries([
      entry('manifest.json'),
      entry(left, 0, 0, left.endsWith('/') ? { type: 'directory' } : {}),
      entry(right)
    ]));
  }
  expectCode(ARCHIVE_ERROR_CODES.DUPLICATE_PATH, () => validateArchiveEntries(entriesWithManifest(
    entry('data', 1, 1),
    entry('data/body.json', 1, 1)
  )));
});

test('explicit symbolic links, junctions and reparse points are rejected', () => {
  const variants = [
    { isSymlink: true },
    { isSymbolicLink: true },
    { isJunction: true },
    { isReparsePoint: true },
    { type: 'symbolic link' },
    { entryType: 'junction' },
    { dosAttributes: 0x400 }
  ];
  for (const metadata of variants) {
    expectCode(ARCHIVE_ERROR_CODES.LINK_ENTRY, () => validateArchiveEntries(entriesWithManifest(
      entry('unsafe', 0, 0, metadata)
    )));
  }
});

test('yauzl external attributes reject Unix symlinks and Windows junction metadata', () => {
  expectCode(ARCHIVE_ERROR_CODES.LINK_ENTRY, () => validateArchiveEntries(entriesWithManifest(
    entry('unix-link', 0, 0, {
      versionMadeBy: 3 << 8,
      externalFileAttributes: (0xa000 | 0o777) << 16
    })
  )));
  expectCode(ARCHIVE_ERROR_CODES.LINK_ENTRY, () => validateArchiveEntries(entriesWithManifest(
    entry('win-junction', 0, 0, {
      versionMadeBy: 10 << 8,
      externalFileAttributes: 0x400
    })
  )));
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_TYPE_UNSUPPORTED, () => validateArchiveEntries(entriesWithManifest(
    entry('fifo', 0, 0, { mode: 0x1000 | 0o644 })
  )));
});

test('malformed entry metadata fails closed before extraction', () => {
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_TYPE_UNSUPPORTED, () => validateArchiveEntries(entriesWithManifest(
    entry('typed.bin', 0, 0, { type: 7 })
  )));
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => validateArchiveEntries([], null));
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_SIZE_INVALID, () => validateArchiveEntries(entriesWithManifest(
    entry('huge-compressed-a.bin', 0, Number.MAX_SAFE_INTEGER),
    entry('huge-compressed-b.bin', 0, 1)
  )));
});

test('directory metadata is recognized and directories must not carry file bytes', () => {
  const result = validateArchiveEntries(entriesWithManifest(
    entry('unix-dir', 0, 0, { mode: 0x4000 | 0o755 })
  ));
  assert.equal(result.directoryCount, 1);
  expectCode(ARCHIVE_ERROR_CODES.DIRECTORY_SIZE_INVALID, () => validateArchiveEntries(entriesWithManifest(
    entry('directory/', 1, 1)
  )));
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_TYPE_UNSUPPORTED, () => validateArchiveEntries(entriesWithManifest(
    entry('unknown', 0, 0, { type: 'socket' })
  )));
});

test('negative, fractional, missing and unsafe integer sizes are rejected', () => {
  for (const [uncompressedSize, compressedSize] of [
    [-1, 0],
    [1.5, 1],
    [0, -1],
    [0, 0.5],
    [Number.MAX_SAFE_INTEGER + 1, 1]
  ]) {
    expectCode(ARCHIVE_ERROR_CODES.ENTRY_SIZE_INVALID, () => validateArchiveEntries(entriesWithManifest(
      entry('data.bin', uncompressedSize, compressedSize)
    )));
  }
  expectCode(ARCHIVE_ERROR_CODES.ENTRY_SIZE_INVALID, () => validateArchiveEntries(entriesWithManifest({
    fileName: 'missing-size.bin',
    compressedSize: 0
  })));
});

test('single-file uncompressed size accepts the limit and rejects one byte over', () => {
  const maximum = ARCHIVE_LIMITS.MAX_FILE_UNCOMPRESSED_BYTES;
  const valid = validateArchiveEntries(entriesWithManifest(entry('large.bin', maximum, maximum)));
  assert.equal(valid.expandedBytes, maximum);
  expectCode(ARCHIVE_ERROR_CODES.FILE_SIZE_EXCEEDED, () => validateArchiveEntries(entriesWithManifest(
    entry('too-large.bin', maximum + 1, maximum + 1)
  )));
});

test('expanded total accepts exactly 5 GiB and rejects one byte over', () => {
  const chunk = ARCHIVE_LIMITS.MAX_FILE_UNCOMPRESSED_BYTES;
  const exactEntries = Array.from({ length: 10 }, (_, index) => entry(`chunks/${index}.bin`, chunk, chunk));
  exactEntries.push(entry('chunks/tail.bin', 120 * 1024 * 1024, 120 * 1024 * 1024));
  const valid = validateArchiveEntries(entriesWithManifest(...exactEntries));
  assert.equal(valid.expandedBytes, ARCHIVE_LIMITS.MAX_EXPANDED_BYTES);
  exactEntries[exactEntries.length - 1] = entry('chunks/tail.bin', 120 * 1024 * 1024 + 1, 120 * 1024 * 1024 + 1);
  expectCode(ARCHIVE_ERROR_CODES.EXPANDED_SIZE_EXCEEDED, () =>
    validateArchiveEntries(entriesWithManifest(...exactEntries)));
});

test('compression ratio accepts 200 and rejects larger or zero compressed representations', () => {
  const valid = validateArchiveEntries(entriesWithManifest(entry('ratio.bin', 200, 1)));
  assert.equal(valid.maximumObservedCompressionRatio, 200);
  expectCode(ARCHIVE_ERROR_CODES.COMPRESSION_RATIO_EXCEEDED, () => validateArchiveEntries(entriesWithManifest(
    entry('bomb.bin', 201, 1)
  )));
  expectCode(ARCHIVE_ERROR_CODES.COMPRESSION_RATIO_EXCEEDED, () => validateArchiveEntries(entriesWithManifest(
    entry('zero-compressed.bin', 1, 0)
  )));
  assert.equal(validateArchiveEntries(entriesWithManifest(entry('empty.bin', 0, 0))).expandedBytes, 0);
});

test('entry count accepts 20,000 entries and rejects 20,001', () => {
  const maximumEntries = [entry('manifest.json')];
  for (let index = 1; index < ARCHIVE_LIMITS.MAX_FILE_COUNT; index += 1) {
    maximumEntries.push(entry(`files/${index}.json`));
  }
  assert.equal(validateArchiveEntries(maximumEntries).entryCount, ARCHIVE_LIMITS.MAX_FILE_COUNT);
  maximumEntries.push(entry('one-too-many.json'));
  expectCode(ARCHIVE_ERROR_CODES.FILE_COUNT_EXCEEDED, () => validateArchiveEntries(maximumEntries));
});

test('critical entries must be present as regular files and custom critical sets are supported', () => {
  expectCode(ARCHIVE_ERROR_CODES.CRITICAL_ENTRY_MISSING, () => validateArchiveEntries([
    entry('data/body.json')
  ]));
  expectCode(ARCHIVE_ERROR_CODES.CRITICAL_ENTRY_MISSING, () => validateArchiveEntries([
    entry('manifest.json/', 0, 0, { type: 'directory' })
  ]));
  const result = validateArchiveEntries([
    entry('manifest.json'),
    entry('data/body.json')
  ], { criticalEntries: ['manifest.json', 'DATA\\BODY.JSON'] });
  assert.equal(result.fileCount, 2);
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => validateArchiveEntries([], { criticalEntries: [] }));
});

test('manifest summary derives and cross-checks package, project, library and resource counts', () => {
  assert.deepEqual(summarizeManifest({
    packageVersion: ' 2.1.0 ',
    productVersion: '2.1.0',
    counts: { projects: 2, libraryItems: 3, assets: 1 },
    projects: [{}, {}],
    library: { items: [{}, {}, {}] },
    assets: [{}]
  }), {
    packageVersion: '2.1.0',
    projectCount: 2,
    libraryCount: 3,
    resourceCount: 1
  });
  assert.deepEqual(summarizeManifest({ productVersion: '1.0.0' }), {
    packageVersion: '1.0.0',
    projectCount: 0,
    libraryCount: 0,
    resourceCount: 0
  });
});

test('manifest summary rejects missing versions, malformed counts and count disagreements', () => {
  for (const manifest of [
    null,
    {},
    { packageVersion: '' },
    { packageVersion: '1', productVersion: '2' },
    { packageVersion: '1', counts: [] },
    { packageVersion: '1', projectCount: -1 },
    { packageVersion: '1', projects: {} },
    { packageVersion: '1', projectCount: 2, projects: [{}] }
  ]) {
    expectCode(ARCHIVE_ERROR_CODES.MANIFEST_INVALID, () => summarizeManifest(manifest));
  }
});

test('disk estimation is deterministic and disk availability rejects invalid or insufficient input', () => {
  assert.equal(estimateImportDiskBytes(123), 246);
  assert.equal(validateAvailableDiskBytes(246, 246), 246);
  for (const value of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expectCode(ARCHIVE_ERROR_CODES.DISK_SPACE_INVALID, () => validateAvailableDiskBytes(value, 10));
  }
  expectCode(ARCHIVE_ERROR_CODES.DISK_SPACE_INVALID, () => estimateImportDiskBytes(-1));
  expectCode(ARCHIVE_ERROR_CODES.DISK_SPACE_INVALID, () =>
    estimateImportDiskBytes(ARCHIVE_LIMITS.MAX_EXPANDED_BYTES + 1));
  expectCode(ARCHIVE_ERROR_CODES.DISK_SPACE_INSUFFICIENT, () => validateAvailableDiskBytes(245, 246));
});

test('preflight reports all required user-facing facts in deterministic order', () => {
  const base = {
    entries: entriesWithManifest(entry('data/body.json', 50, 25), entry('assets/', 0, 0)),
    manifest: {
      packageVersion: '3.0.0',
      counts: { projects: 2, library: 4, resources: 1 }
    },
    availableDiskBytes: 1000
  };
  const first = createImportPreflight({
    ...base,
    optionalMissingAssets: [{ assetId: 'z' }, { assetId: 'a' }, { assetId: 'a' }],
    conflicts: [{ id: 'p2', type: 'project' }, { type: 'project', id: 'p1' }]
  });
  const second = createImportPreflight({
    ...base,
    optionalMissingAssets: [{ assetId: 'a' }, { assetId: 'z' }],
    conflicts: [{ id: 'p1', type: 'project' }, { id: 'p2', type: 'project' }]
  });
  assert.deepEqual(first, second);
  assert.deepEqual({
    packageVersion: first.packageVersion,
    projectCount: first.projectCount,
    libraryCount: first.libraryCount,
    resourceCount: first.resourceCount,
    expandedBytes: first.expandedBytes,
    estimatedDiskBytes: first.estimatedDiskBytes
  }, {
    packageVersion: '3.0.0',
    projectCount: 2,
    libraryCount: 4,
    resourceCount: 1,
    expandedBytes: 50,
    estimatedDiskBytes: 100
  });
  assert.deepEqual(first.optionalMissingAssets, [{ assetId: 'a' }, { assetId: 'z' }]);
  assert.deepEqual(first.conflicts, [{ id: 'p1', type: 'project' }, { id: 'p2', type: 'project' }]);
  assert.equal(first.status, 'ready');
  assert.equal(first.commitAllowed, true);
  assert.equal(first.businessWritesPerformed, false);
});

test('preflight can source optional missing assets from the manifest', () => {
  const summary = createImportPreflight({
    entries: entriesWithManifest(),
    manifest: { packageVersion: '1.0.0', optionalMissingAssets: ['pdf-b', 'pdf-a'] },
    availableDiskBytes: 0
  });
  assert.deepEqual(summary.optionalMissingAssets, ['pdf-a', 'pdf-b']);
  assert.equal(summary.estimatedDiskBytes, 0);
});

test('preflight fails closed when disk input or JSON summary lists are invalid', () => {
  const base = {
    entries: entriesWithManifest(entry('body.json', 10, 10)),
    manifest: { packageVersion: '1.0.0' }
  };
  expectCode(ARCHIVE_ERROR_CODES.DISK_SPACE_INVALID, () => createImportPreflight(base));
  expectCode(ARCHIVE_ERROR_CODES.DISK_SPACE_INSUFFICIENT, () => createImportPreflight({
    ...base,
    availableDiskBytes: 19
  }));
  const cyclic = {};
  cyclic.self = cyclic;
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => createImportPreflight({
    ...base,
    availableDiskBytes: 20,
    conflicts: [cyclic]
  }));
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => createImportPreflight({
    ...base,
    availableDiskBytes: 20,
    optionalMissingAssets: 'not-an-array'
  }));
  for (const conflict of [NaN, undefined, new Date(0), [1, 2]]) {
    expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => createImportPreflight({
      ...base,
      availableDiskBytes: 20,
      conflicts: [conflict]
    }));
  }
  expectCode(ARCHIVE_ERROR_CODES.INPUT_INVALID, () => createImportPreflight(null));
});

test('pre-commit cancellation is immutable, deterministic, idempotent and records zero writes', () => {
  const ready = createImportPreflight({
    entries: entriesWithManifest(),
    manifest: { packageVersion: '1.0.0' },
    availableDiskBytes: 0
  });
  const canceled = cancelImportPreflight(ready, 'user-requested');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.commitAllowed, true);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.commitAllowed, false);
  assert.equal(canceled.businessWritesPerformed, false);
  assert.deepEqual(canceled.cancellation, {
    requested: true,
    beforeCommit: true,
    reason: 'user-requested'
  });
  assert.equal(cancelImportPreflight(canceled, 'ignored-on-idempotent-repeat'), canceled);

  const direct = createImportPreflight({
    entries: entriesWithManifest(),
    manifest: { packageVersion: '1.0.0' },
    availableDiskBytes: 0,
    cancellationRequested: true,
    cancellationReason: 'user-requested'
  });
  assert.deepEqual(direct, canceled);
});

test('cancellation rejects invalid states, reasons and non-boolean requests', () => {
  expectCode(ARCHIVE_ERROR_CODES.CANCELLATION_INVALID, () => cancelImportPreflight({}, 'user'));
  const ready = createImportPreflight({
    entries: entriesWithManifest(),
    manifest: { packageVersion: '1.0.0' },
    availableDiskBytes: 0
  });
  expectCode(ARCHIVE_ERROR_CODES.CANCELLATION_INVALID, () => cancelImportPreflight(ready, ''));
  expectCode(ARCHIVE_ERROR_CODES.CANCELLATION_INVALID, () => createImportPreflight({
    entries: entriesWithManifest(),
    manifest: { packageVersion: '1.0.0' },
    availableDiskBytes: 0,
    cancellationRequested: 'yes'
  }));
});
