const { EventEmitter } = require('events');

class CdpClient extends EventEmitter {
  constructor(webSocket, options = {}) {
    super();
    this.webSocket = webSocket;
    this.timeoutMs = options.timeoutMs || 15_000;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    webSocket.addEventListener('message', event => this.handleMessage(event.data));
    webSocket.addEventListener('close', () => this.handleClose(new Error('CDP connection closed')));
    webSocket.addEventListener('error', () => this.handleClose(new Error('CDP connection failed')));
  }

  static connect(url, options = {}) {
    const WebSocketConstructor = options.WebSocketConstructor || globalThis.WebSocket;
    if (!WebSocketConstructor) throw new Error('WebSocket is not available in this Node runtime');
    const timeoutMs = options.timeoutMs || 15_000;
    return new Promise((resolve, reject) => {
      const webSocket = new WebSocketConstructor(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { webSocket.close(); } catch (_) {}
        reject(new Error(`Timed out connecting to CDP: ${url}`));
      }, timeoutMs);
      webSocket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(webSocket, { timeoutMs }));
      }, { once: true });
      webSocket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Unable to connect to CDP: ${url}`));
      }, { once: true });
    });
  }

  handleMessage(rawMessage) {
    let message;
    try {
      message = JSON.parse(String(rawMessage));
    } catch (_) {
      this.emit('protocol-error', new Error('CDP returned invalid JSON'));
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'CDP command failed');
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (message.method) this.emit(message.method, message.params || {});
  }

  handleClose(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.webSocket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, options = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
      userGesture: options.userGesture !== false
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || 'Renderer evaluation failed';
      throw new Error(description);
    }
    return response.result ? response.result.value : undefined;
  }

  close() {
    if (this.closed) return;
    this.handleClose(new Error('CDP connection closed by test runner'));
    try { this.webSocket.close(); } catch (_) {}
  }
}

async function waitForCdpTarget(port, options = {}) {
  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 30_000;
  const intervalMs = options.intervalMs || 100;
  const predicate = options.predicate || (target => target.type === 'page');
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImplementation(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(predicate);
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for Electron CDP target on port ${port}${lastError ? `: ${lastError.message}` : ''}`);
}

module.exports = {
  CdpClient,
  waitForCdpTarget
};
