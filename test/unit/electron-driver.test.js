const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  reserveTcpPort,
  resolveElectronExecutable,
  waitForFile,
  waitForProcessExit,
  waitForRenderer
} = require('../../scripts/lib/electron-driver');

test('driver reserves a usable loopback port', async () => {
  const port = await reserveTcpPort();
  assert.equal(Number.isInteger(port), true);
  assert.ok(port > 0 && port <= 65535);
});

test('driver resolves explicit packaged executable and rejects missing files', () => {
  const executable = process.execPath;
  assert.deepEqual(resolveElectronExecutable(process.cwd(), executable), {
    executable: path.resolve(executable),
    packaged: true
  });
  assert.throws(() => resolveElectronExecutable(process.cwd(), path.join(os.tmpdir(), 'missing-essayflow.exe')), /does not exist/);
});

test('waitForFile waits for valid JSON instead of accepting partial output', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'essayflow-wait-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'report.json');
  fs.writeFileSync(filePath, '{');
  setTimeout(() => fs.writeFileSync(filePath, JSON.stringify({ ok: true })), 10);
  assert.deepEqual(await waitForFile(filePath, 500), { ok: true });
  await assert.rejects(waitForFile(path.join(root, 'missing.json'), 10), /Timed out/);
});

test('waitForProcessExit handles completed and delayed child processes', async () => {
  assert.equal(await waitForProcessExit({ exitCode: 7 }), 7);
  const listeners = new Map();
  const fakeChild = {
    exitCode: null,
    once(name, listener) { listeners.set(name, listener); }
  };
  const pending = waitForProcessExit(fakeChild, 500);
  listeners.get('exit')(0);
  assert.equal(await pending, 0);
});

test('waitForRenderer polls until the renderer condition becomes true', async () => {
  let calls = 0;
  const driver = {
    client: {
      async evaluate() {
        calls += 1;
        return calls >= 3;
      }
    }
  };
  await waitForRenderer(driver, 'window.ready', { intervalMs: 1, timeoutMs: 100 });
  assert.equal(calls, 3);
  await assert.rejects(
    waitForRenderer({ client: { evaluate: async () => false } }, 'never', { intervalMs: 1, timeoutMs: 5 }),
    /Timed out/
  );
});
