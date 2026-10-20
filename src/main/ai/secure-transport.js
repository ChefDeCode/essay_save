'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

class SecureTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SecureTransportError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new SecureTransportError(code, message, details);
}

function parseIpv4(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split('.').map(Number);
}

function isPrivateIpv4(value) {
  const parts = parseIpv4(value);
  if (!parts) return false;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function isPrivateIpv6(value) {
  if (net.isIP(value) !== 6) return false;
  const normalized = value.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('2001:db8:')) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isPrivateAddress(address) {
  return isPrivateIpv4(address) || isPrivateIpv6(address);
}

function isLoopbackAddress(address) {
  const ipv4 = parseIpv4(address);
  if (ipv4) return ipv4[0] === 127;
  if (net.isIP(address) !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::1') return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? parseIpv4(mapped[1])?.[0] === 127 : false;
}

async function resolveAndValidate(parsed, providerKind, lookup = dns.promises.lookup) {
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  const records = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || !records.length) fail('NETWORK_DNS_EMPTY', 'provider 主机没有可用 DNS 记录');
  const local = providerKind === 'local-ai';
  for (const record of records) {
    const privateAddress = isPrivateAddress(record.address);
    if (local && !isLoopbackAddress(record.address)) fail('NETWORK_LOCAL_PROVIDER_NOT_LOOPBACK', '本机 provider 解析到了非 loopback 地址', { address: record.address });
    if (!local && privateAddress) fail('NETWORK_SSRF_BLOCKED', '远程 provider 解析到了私有、保留或本机地址', { address: record.address });
  }
  return records;
}

async function secureTransport(input, options = {}) {
  let parsed;
  try { parsed = new URL(input.url); } catch (_) { fail('NETWORK_URL_INVALID', '请求 URL 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('NETWORK_URL_INVALID', '只允许不含凭据的 HTTP(S) URL');
  const providerKind = input.providerKind;
  if (!['remote-ai', 'local-ai', 'scholarly-api'].includes(providerKind)) fail('NETWORK_PROVIDER_KIND_INVALID', '网络 providerKind 无效');
  if (input.signal?.aborted) fail('ABORTED', '请求已取消');
  const records = await resolveAndValidate(parsed, providerKind, options.lookup);
  if (input.signal?.aborted) fail('ABORTED', '请求已取消');
  const selected = records[0];
  const client = parsed.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maximumBytes = options.maximumBytes || MAX_RESPONSE_BYTES;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const signal = input.signal;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = new SecureTransportError('ABORTED', '请求已取消');
      try { request?.destroy(error); } catch (_) {}
      finish(error);
    };
    request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: input.method || 'POST',
      headers: input.headers || {},
      servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
      lookup(_hostname, _lookupOptions, callback) {
        callback(null, selected.address, selected.family);
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        finish(new SecureTransportError('NETWORK_REDIRECT_BLOCKED', 'AI gateway 拒绝 provider 重定向', {
          status: response.statusCode
        }));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > maximumBytes) {
          response.destroy();
          finish(new SecureTransportError('NETWORK_RESPONSE_TOO_LARGE', 'provider 响应超过大小限制'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, {
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        partial: false
      }));
      response.on('error', error => finish(error));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new SecureTransportError('NETWORK_TIMEOUT', 'provider 请求超时'));
    });
    request.on('error', error => finish(error));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (input.body !== undefined && input.body !== null) request.write(input.body, 'utf8');
    request.end();
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  SecureTransportError,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  isLoopbackAddress,
  resolveAndValidate,
  secureTransport
};
