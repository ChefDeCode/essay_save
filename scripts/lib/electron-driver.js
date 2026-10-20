const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { CdpClient, waitForCdpTarget } = require('./cdp-client');

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function resolveElectronExecutable(rootPath, applicationPath) {
  if (applicationPath) {
    const resolved = path.resolve(applicationPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Electron application does not exist: ${resolved}`);
    }
    return { executable: resolved, packaged: true };
  }
  const electronPackage = require.resolve('electron', { paths: [rootPath] });
  const executable = require(electronPackage);
  if (typeof executable !== 'string' || !fs.existsSync(executable)) {
    throw new Error('Unable to resolve the development Electron executable');
  }
  return { executable, packaged: false };
}

function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(filePath)) {
        try {
          resolve(JSON.parse(fs.readFileSync(filePath, 'utf8')));
          return;
        } catch (_) {}
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for file: ${filePath}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function waitForProcessExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function launchElectron(options) {
  const root = path.resolve(options.rootPath);
  const userDataPath = path.resolve(options.userDataPath);
  const reportPath = path.resolve(options.profileReportPath || path.join(userDataPath, 'automation-profile-report.json'));
  fs.mkdirSync(userDataPath, { recursive: true });
  if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  const launch = resolveElectronExecutable(root, options.applicationPath);
  const port = await reserveTcpPort();
  const automationArguments = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--essayflow-automation',
    `--essayflow-user-data=${userDataPath}`,
    `--essayflow-profile-report=${reportPath}`
  ];
  const args = launch.packaged
    ? automationArguments
    : [...automationArguments, root];
  const environment = { ...process.env, ...(options.env || {}) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const stdout = [];
  const stderr = [];
  const child = spawn(launch.executable, args, {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));

  const earlyExit = new Promise((_, reject) => {
    child.once('exit', code => {
      reject(new Error(
        `Electron exited before CDP was ready (code ${code}).\nstdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`
      ));
    });
  });

  let target;
  try {
    target = await Promise.race([
      waitForCdpTarget(port, {
        timeoutMs: options.timeoutMs || 45_000,
        predicate: candidate => candidate.type === 'page' && /src[\\/]index\.html|src%2Findex\.html/i.test(candidate.url || '')
      }),
      earlyExit
    ]);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw new Error(`${error.message}\nstdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`);
  }
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, {
    timeoutMs: options.commandTimeoutMs || 120_000
  });
  const exceptions = [];
  const securityErrors = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => exceptions.push(event));
  client.on('Log.entryAdded', event => {
    const entry = event.entry || {};
    if (entry.source === 'security' || /content security policy|refused to (?:load|execute)/i.test(entry.text || '')) {
      securityErrors.push(entry);
    }
  });
  client.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push(event);
  });
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Page.enable');
  const profileReport = await waitForFile(reportPath, options.timeoutMs || 45_000);

  async function close() {
    try {
      await client.send('Browser.close');
    } catch (_) {}
    let exitCode = await waitForProcessExit(child, 10_000);
    if (exitCode === null && child.exitCode === null) {
      child.kill();
      exitCode = await waitForProcessExit(child, 5_000);
    }
    client.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    return exitCode;
  }

  return {
    child,
    client,
    close,
    consoleErrors,
    exceptions,
    packaged: launch.packaged,
    port,
    profileReport,
    reportPath,
    securityErrors,
    stderr,
    stdout,
    target,
    userDataPath
  };
}

async function waitForRenderer(driver, expression, options = {}) {
  const timeoutMs = options.timeoutMs || 30_000;
  const intervalMs = options.intervalMs || 100;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await driver.client.evaluate(`Boolean(${expression})`)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for renderer condition: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
}

module.exports = {
  launchElectron,
  reserveTcpPort,
  resolveElectronExecutable,
  waitForFile,
  waitForProcessExit,
  waitForRenderer
};
