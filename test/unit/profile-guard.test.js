const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  compareProfileSnapshots,
  snapshotProfile
} = require('../../scripts/lib/profile-guard');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-profile-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('missing profile has a stable empty snapshot', t => {
  const root = temporaryDirectory(t);
  const missing = path.join(root, 'missing');
  const first = snapshotProfile(missing);
  const second = snapshotProfile(missing);
  assert.equal(first.exists, false);
  assert.equal(first.fileCount, 0);
  assert.deepEqual(compareProfileSnapshots(first, second), { unchanged: true, differences: [] });
});

test('profile guard records count, mtime and content hashes', t => {
  const root = temporaryDirectory(t);
  fs.mkdirSync(path.join(root, 'nested'));
  const projectPath = path.join(root, 'nested', 'project.html');
  fs.writeFileSync(projectPath, '<h1>fixture</h1>');
  const before = snapshotProfile(root);
  assert.equal(before.fileCount, 1);
  assert.equal(before.files[0].path, 'nested/project.html');
  assert.match(before.files[0].sha256, /^[0-9a-f]{64}$/);

  fs.writeFileSync(projectPath, '<h1>changed</h1>');
  const changedTime = new Date(before.files[0].mtimeMs + 10_000);
  fs.utimesSync(projectPath, changedTime, changedTime);
  const after = snapshotProfile(root);
  const comparison = compareProfileSnapshots(before, after);
  assert.equal(comparison.unchanged, false);
  assert.ok(comparison.differences.includes('content changed: nested/project.html'));
  assert.ok(comparison.differences.includes('mtime changed: nested/project.html'));
});

test('profile guard detects additions and removals without hiding them', t => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, 'old.txt'), 'old');
  const before = snapshotProfile(root);
  fs.unlinkSync(path.join(root, 'old.txt'));
  fs.writeFileSync(path.join(root, 'new.txt'), 'new');
  const comparison = compareProfileSnapshots(before, snapshotProfile(root));
  assert.equal(comparison.unchanged, false);
  assert.ok(comparison.differences.includes('removed: old.txt'));
  assert.ok(comparison.differences.includes('added: new.txt'));
  assert.ok(comparison.differences.includes('content hash changed'));
});

test('profile guard retries transient Windows file locks but fails persistent locks', t => {
  const root = temporaryDirectory(t);
  const lockedPath = path.join(root, 'locked.txt');
  fs.writeFileSync(lockedPath, 'stable');
  const originalRead = fs.readFileSync;
  let transientAttempts = 0;
  fs.readFileSync = filePath => {
    if (path.resolve(filePath) === lockedPath && transientAttempts++ < 2) {
      const error = new Error('transient lock');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRead(filePath);
  };
  try {
    const snapshot = snapshotProfile(root);
    assert.equal(snapshot.fileCount, 1);
    assert.equal(transientAttempts, 3);
  } finally {
    fs.readFileSync = originalRead;
  }

  fs.readFileSync = filePath => {
    if (path.resolve(filePath) === lockedPath) {
      const error = new Error('persistent lock');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRead(filePath);
  };
  try {
    assert.throws(() => snapshotProfile(root), error => error?.code === 'EBUSY');
  } finally {
    fs.readFileSync = originalRead;
  }
});
