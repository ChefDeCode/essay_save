'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  isPrivateAddress,
  isLoopbackAddress,
  resolveAndValidate,
  secureTransport
} = require('../../src/main/ai/secure-transport');

test('SSRF address policy rejects loopback, private, link-local, documentation and mapped ranges', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '203.0.113.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  assert.equal(isLoopbackAddress('127.0.0.42'), true);
  assert.equal(isLoopbackAddress('192.168.1.1'), false);
});

test('secure transport pins loopback, sends exact bytes and returns a bounded response', async t => {
  let received = '';
  const server = http.createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', chunk => { received += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const result = await secureTransport({
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"fixture":true}',
    providerKind: 'local-ai'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.equal(received, '{"fixture":true}');
});

test('secure transport rejects redirects and oversized responses', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1/private' });
      response.end();
      return;
    }
    response.writeHead(200);
    response.end('too-large');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(secureTransport({
    url: `http://127.0.0.1:${port}/redirect`, providerKind: 'local-ai'
  }), error => error.code === 'NETWORK_REDIRECT_BLOCKED');
  await assert.rejects(secureTransport({
    url: `http://127.0.0.1:${port}/large`, providerKind: 'local-ai'
  }, { maximumBytes: 4 }), error => error.code === 'NETWORK_RESPONSE_TOO_LARGE');
});

test('secure transport times out and rejects malformed URL/provider inputs', async t => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(secureTransport({
    url: `http://127.0.0.1:${port}/hang`, providerKind: 'local-ai'
  }, { timeoutMs: 10 }), error => error.code === 'NETWORK_TIMEOUT');
  await assert.rejects(secureTransport({ url: 'not-a-url', providerKind: 'local-ai' }), error => error.code === 'NETWORK_URL_INVALID');
  await assert.rejects(secureTransport({ url: 'file:///tmp/test', providerKind: 'local-ai' }), error => error.code === 'NETWORK_URL_INVALID');
  await assert.rejects(secureTransport({ url: 'https://example.com', providerKind: 'unknown' }), error => error.code === 'NETWORK_PROVIDER_KIND_INVALID');
});

test('secure transport abort closes the underlying request within one second', async t => {
  let markStarted;
  let markClosed;
  const started = new Promise(resolve => { markStarted = resolve; });
  const closed = new Promise(resolve => { markClosed = resolve; });
  const server = http.createServer(request => {
    markStarted();
    request.once('close', markClosed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise(resolve => server.close(resolve));
  });
  const controller = new AbortController();
  const pending = secureTransport({
    url: `http://127.0.0.1:${server.address().port}/hang`,
    providerKind: 'local-ai',
    signal: controller.signal
  });
  await started;
  const abortStartedAt = Date.now();
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORTED');
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('底层请求未在 1 秒内关闭')), 1000))
  ]);
  assert.ok(Date.now() - abortStartedAt < 1000);
});

test('remote provider fails closed if any DNS answer is private', async () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    resolveAndValidate(new URL('https://provider.example/v1/chat/completions'), 'remote-ai', lookup),
    error => error.code === 'NETWORK_SSRF_BLOCKED'
  );
});

test('local provider accepts loopback and remote provider accepts public-only DNS answers', async () => {
  const local = await resolveAndValidate(new URL('http://127.0.0.1:11434/v1/chat/completions'), 'local-ai');
  assert.equal(local[0].address, '127.0.0.1');
  const publicRecords = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
  assert.deepEqual(await resolveAndValidate(new URL('https://provider.example/v1/chat/completions'), 'remote-ai', async () => publicRecords), publicRecords);
  await assert.rejects(
    resolveAndValidate(new URL('http://local-provider.test'), 'local-ai', async () => [{ address: '192.168.1.10', family: 4 }]),
    error => error.code === 'NETWORK_LOCAL_PROVIDER_NOT_LOOPBACK'
  );
});
