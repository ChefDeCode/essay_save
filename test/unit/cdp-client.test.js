const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const test = require('node:test');
const { CdpClient, waitForCdpTarget } = require('../../scripts/lib/cdp-client');

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatch('open', {}));
  }

  addEventListener(name, listener, options = {}) {
    if (options.once) this.once(name, listener);
    else this.on(name, listener);
  }

  dispatch(name, value) {
    this.emit(name, value);
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.closed = true;
    this.dispatch('close', {});
  }
}
FakeWebSocket.instances = [];

class ManualWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.throwOnSend = null;
    this.throwOnClose = null;
    ManualWebSocket.instances.push(this);
  }

  addEventListener(name, listener, options = {}) {
    if (options.once) this.once(name, listener);
    else this.on(name, listener);
  }

  dispatch(name, value) {
    this.emit(name, value);
  }

  send(value) {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push(JSON.parse(value));
  }

  close() {
    if (this.throwOnClose) throw this.throwOnClose;
    this.closed = true;
    this.dispatch('close', {});
  }
}
ManualWebSocket.instances = [];

test('CDP client connects, sends commands and resolves responses', async () => {
  const client = await CdpClient.connect('ws://fixture', {
    WebSocketConstructor: FakeWebSocket,
    timeoutMs: 500
  });
  const socket = FakeWebSocket.instances.at(-1);
  const pending = client.send('Runtime.enable', { fixture: true });
  assert.deepEqual(socket.sent[0], { id: 1, method: 'Runtime.enable', params: { fixture: true } });
  socket.dispatch('message', { data: JSON.stringify({ id: 1, result: { enabled: true } }) });
  assert.deepEqual(await pending, { enabled: true });
  client.close();
});

test('CDP client emits events and rejects protocol errors', async () => {
  const client = await CdpClient.connect('ws://fixture-events', {
    WebSocketConstructor: FakeWebSocket,
    timeoutMs: 500
  });
  const socket = FakeWebSocket.instances.at(-1);
  const eventPromise = new Promise(resolve => client.once('Log.entryAdded', resolve));
  socket.dispatch('message', { data: JSON.stringify({ method: 'Log.entryAdded', params: { value: 1 } }) });
  assert.deepEqual(await eventPromise, { value: 1 });

  const pending = client.send('Broken.command');
  socket.dispatch('message', { data: JSON.stringify({ id: 1, error: { code: -1, message: 'broken' } }) });
  await assert.rejects(pending, error => error.code === -1 && error.message === 'broken');
  client.close();
});

test('evaluate surfaces renderer exceptions and returns plain values', async () => {
  const client = await CdpClient.connect('ws://fixture-evaluate', {
    WebSocketConstructor: FakeWebSocket,
    timeoutMs: 500
  });
  const socket = FakeWebSocket.instances.at(-1);
  const success = client.evaluate('1 + 1');
  socket.dispatch('message', { data: JSON.stringify({ id: 1, result: { result: { value: 2 } } }) });
  assert.equal(await success, 2);

  const failure = client.evaluate('bad()');
  socket.dispatch('message', { data: JSON.stringify({
    id: 2,
    result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: bad' } } }
  }) });
  await assert.rejects(failure, /ReferenceError: bad/);
  client.close();
});

test('waitForCdpTarget retries deterministic fixture responses', async () => {
  let calls = 0;
  const target = await waitForCdpTarget(9222, {
    intervalMs: 1,
    timeoutMs: 100,
    fetchImplementation: async () => {
      calls += 1;
      if (calls === 1) throw new Error('not ready');
      return {
        ok: true,
        json: async () => calls === 2 ? [] : [{ type: 'page', webSocketDebuggerUrl: 'ws://ready' }]
      };
    }
  });
  assert.equal(target.webSocketDebuggerUrl, 'ws://ready');
  assert.equal(calls, 3);
});

test('CDP connection rejects missing transports, socket errors and timeouts', async () => {
  const nativeWebSocket = globalThis.WebSocket;
  try {
    globalThis.WebSocket = undefined;
    assert.throws(() => CdpClient.connect('ws://missing'), /WebSocket is not available/);
  } finally {
    globalThis.WebSocket = nativeWebSocket;
  }

  const errored = CdpClient.connect('ws://error', {
    WebSocketConstructor: ManualWebSocket,
    timeoutMs: 50
  });
  ManualWebSocket.instances.at(-1).dispatch('error', {});
  await assert.rejects(errored, /Unable to connect/);

  const timedOut = CdpClient.connect('ws://timeout', {
    WebSocketConstructor: ManualWebSocket,
    timeoutMs: 2
  });
  const timeoutSocket = ManualWebSocket.instances.at(-1);
  await assert.rejects(timedOut, /Timed out connecting/);
  assert.equal(timeoutSocket.closed, true);
});

test('CDP protocol handling is fail-closed for malformed and unmatched messages', async () => {
  const socket = new ManualWebSocket('ws://protocol');
  const client = new CdpClient(socket, { timeoutMs: 20 });
  const protocolError = new Promise(resolve => client.once('protocol-error', resolve));
  socket.dispatch('message', { data: '{' });
  assert.match((await protocolError).message, /invalid JSON/);

  client.handleMessage(JSON.stringify({ id: 999, result: { ignored: true } }));
  assert.equal(client.pending.size, 0);

  const event = new Promise(resolve => client.once('Fixture.event', resolve));
  client.handleMessage(JSON.stringify({ method: 'Fixture.event' }));
  assert.deepEqual(await event, {});

  const emptyResult = client.send('Fixture.empty');
  client.handleMessage(JSON.stringify({ id: 1 }));
  assert.deepEqual(await emptyResult, {});
  client.close();
});

test('CDP send handles synchronous transport failure, timeout and connection close', async () => {
  const socket = new ManualWebSocket('ws://send-errors');
  const client = new CdpClient(socket, { timeoutMs: 2 });

  socket.throwOnSend = new Error('synthetic send failure');
  await assert.rejects(client.send('Fixture.throw'), /synthetic send failure/);
  assert.equal(client.pending.size, 0);

  socket.throwOnSend = null;
  await assert.rejects(client.send('Fixture.timeout'), /command timed out/);
  assert.equal(client.pending.size, 0);

  const pending = client.send('Fixture.pending');
  const closeError = new Error('synthetic close');
  client.handleClose(closeError);
  await assert.rejects(pending, /synthetic close/);
  assert.equal(client.pending.size, 0);
  client.handleClose(new Error('ignored duplicate close'));
  await assert.rejects(client.send('Fixture.closed'), /connection is closed/);
});

test('CDP evaluate honors explicit false options and fallback exception text', async () => {
  const socket = new ManualWebSocket('ws://evaluate-options');
  const client = new CdpClient(socket, { timeoutMs: 50 });
  const empty = client.evaluate('fixture()', {
    awaitPromise: false,
    returnByValue: false,
    userGesture: false
  });
  assert.deepEqual(socket.sent[0].params, {
    expression: 'fixture()',
    awaitPromise: false,
    returnByValue: false,
    userGesture: false
  });
  client.handleMessage(JSON.stringify({ id: 1, result: {} }));
  assert.equal(await empty, undefined);

  const fallback = client.evaluate('brokenFixture()');
  client.handleMessage(JSON.stringify({
    id: 2,
    result: { exceptionDetails: { text: 'Synthetic renderer failure' } }
  }));
  await assert.rejects(fallback, /Synthetic renderer failure/);
  client.close();
});

test('CDP close tolerates transport close errors after rejecting pending work', async () => {
  const socket = new ManualWebSocket('ws://close-throws');
  const client = new CdpClient(socket, { timeoutMs: 50 });
  const pending = client.send('Fixture.pending-before-close');
  socket.throwOnClose = new Error('synthetic close transport failure');
  client.close();
  await assert.rejects(pending, /closed by test runner/);
  assert.equal(client.closed, true);
  client.close();
});

test('waitForCdpTarget reports both quiet timeout and last fetch error', async () => {
  await assert.rejects(
    waitForCdpTarget(9333, {
      intervalMs: 1,
      timeoutMs: 3,
      fetchImplementation: async () => ({ ok: false })
    }),
    error => /Timed out waiting/.test(error.message) && !/synthetic fetch/.test(error.message)
  );
  await assert.rejects(
    waitForCdpTarget(9444, {
      intervalMs: 1,
      timeoutMs: 3,
      fetchImplementation: async () => { throw new Error('synthetic fetch'); }
    }),
    /synthetic fetch/
  );
});
